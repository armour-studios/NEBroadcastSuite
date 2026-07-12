require('dotenv').config({ path: (() => { const p = require('path'), f = require('fs'); const dev = p.join(__dirname, '.env.local'); return f.existsSync(dev) ? dev : p.join(__dirname, '.env.production'); })() });
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const FormData = require('form-data');
const fsp = require('fs/promises');
const os = require('os');
const AdmZip = require('adm-zip');
const { dialog, app: _electronApp, safeStorage } = require('electron');
const { EventEmitter } = require('events');
const IS_DEV = () => _electronApp && !_electronApp.isPackaged;
const { createStartGgClient } = require('./backend/integrations/startgg-client');
const { createChallongeClient } = require('./backend/integrations/challonge-client');
const { getNxgenEvents, getNxgenEventLive, getNxgenLeaderboard } = require('./backend/nxgen');
const { createDirectorEngine } = require('./backend/director');
const cloud = require('./backend/cloud/cloud-client');   // Nameless cloud (dormant until BROADCAST_REMOTE_URL set)
const { createClipSystem } = require('./backend/clips');
const { createTelemetryRecorder } = require('./backend/telemetry/recorder');   // AI training-data capture (Phase 0, local JSONL)
const autoSwitch = require('./backend/director/auto-switch');
const rlSpectatorUi = require('./backend/integrations/rl-spectator-ui');
const { createOverlayEditor } = require('./backend/scenes/overlay-editor');
const vetoData = require('./backend/veto');
const draftData = require('./backend/draft');
const vmix = require('./backend/vmix');   // vMix HTTP control — the full alternative to OBS (docs/vmix-integration.md)
const lolChampSelect = require('./backend/lol-champselect');
const lolLive = require('./backend/lol-live');
const lolOcr = require('./backend/lol-ocr');
const stats = require('./backend/db/stats');
const analytics = require('./backend/analytics');
const startggImport = require('./backend/startgg-import');
const twitchStats = require('./backend/twitch-stats');
const rl6mans   = require('./backend/rl6mans');
const playerDb   = require('./backend/player-db');

const { generateSceneCollection } = require('./obs/build-scene-collection');

// OBS integration is optional — never let a missing/broken package crash the app.
let createObsClient = null;
try {
  ({ createObsClient } = require('./backend/integrations/obs-client'));
} catch (e) {
  console.warn('[OBS] Integration unavailable:', e.message);
}
let obsClient = null;
let obsPassword = '';

// Twitch integration
const { registerTwitchWebhooks } = require('./backend/integrations/twitch-webhooks');
const { TwitchClient } = require('./backend/integrations/twitch-client');
const { SocialPublisher } = require('./backend/social-publisher');
const { PredictionManager } = require('./backend/integrations/twitch-predictions');
const { WheelManager } = require('./backend/integrations/twitch-wheel');
const { MiniGameManager } = require('./backend/integrations/twitch-minigames');
const { ChatParser } = require('./backend/integrations/twitch-chat-parser');
let twitchDataFile = '';
let discordDataFile = '';
let twitchClient = null;
let socialPublisher = null;
let predictionManager = null;
let wheelManager = null;
let _predPollTimer = null;
let miniGameManager = null;
let chatParser = null;
let gameTimers = new Map(); // gameId -> timeout

const HTTP_PORT = 3000;
const WS_PORT = 3001;
const RL_STATS_PORT = 49123;
const RL_RECONNECT_INTERVAL = 3000;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || 't4vpvwcxaxk4vil453fmf3kuahbs5e';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_REDIRECT_URI = 'http://localhost:3000/api/oauth/discord/callback';
const BROADCAST_REMOTE_URL = process.env.BROADCAST_REMOTE_URL || 'https://www.namelessesports.com';
const BROADCAST_API_KEY    = process.env.BROADCAST_API_KEY    || '';

let httpServer = null;
let bridgeWss = null;
let _bridgeHeartbeat = null;

// Stats tracking — match/game IDs for the current broadcast session
let statsCurrentMatchId = null;
let statsCurrentGameId  = null;  // RL
let statsCs2GameId      = null;  // CS2
let statsValGameId      = null;  // Valorant

let appDir = __dirname;
let dataDir;
let teamsFile;
let stateFile;
let facecamsFile;
let presetsFile;
let brandsFile;
let wsTokenFile;
let wsAuthToken = '';   // shared secret required on every WS bridge connection — see getOrCreateWsToken()
let startggApiToken = '';
let challongeApiKey = '';
let nxgenApiKey = '';
let _startggImportRunning = false;   // guards the historical start.gg importer
let _twitchStatsCache = null;        // { at, data } — short cache for GET /api/twitch/stats
let _twitchTokenInvalid = false;     // true once Twitch returns 401 → stop retry storms until reconnect

let appVersion = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  appVersion = pkg.version;
} catch (e) { console.error('Error reading package.json version:', e); }

// ─── Games & overlay designs (themes) ────────────────────────────────────────
// Each game has its own overlay route and a set of selectable designs (themes).
// format: match shape so UI/overlays stop hard-assuming blue/orange (see PRODUCTION.md).
//   'duo' = 2 teams + score (RL), 'team5' = 2 teams of 5 + rounds (CS2/LoL/Val),
//   'ffa'/'bracket' = entrants (Smash), '1v1' = head-to-head.
// teamLabels: what the two sides are called in this game.
// logo = path under /assets (served to overlays as `/assets/<logo>`, to the control
// panel as `../assets/<logo>`). rosterSize doubles as the per-team camera count.
// features = capability flags a game-specific UI can branch on. overlay '' = uses the
// generic production scenes (countdown/winner/veto/intro/casters) — no dedicated HUD yet.
// Per-game overlay layouts (browser source URLs) — not colour themes.
const OVERLAY_LAYOUTS = {
  'rocket-league': [
    { id: 'classic',   name: 'Classic HUD',   path: '/' },
    { id: 'lexogrine', name: 'React HUD', path: '/rl-hud.html' }
  ],
  'csgo': [
    { id: 'cs2-hud', name: 'CS2 HUD', path: '/csgo.html' }
  ],
  'overwatch': [
    { id: 'ow-scoreboard', name: 'Overwatch Overlay', path: '/overwatch.html' }
  ],
  'valorant': [
    { id: 'valorant-hud', name: 'Valorant HUD', path: '/valorant.html' }
  ],
  'league': [
    { id: 'lol-hud', name: 'LoL In-Game HUD', path: '/lol-hud.html' }
  ]
};
const GENERIC_OVERLAY_LAYOUTS = [
  { id: 'production', name: 'Production browser sources', path: '' }
];

const GAMES = {
  'rocket-league': { id: 'rocket-league', name: 'Rocket League', overlay: '/',          format: 'duo',   teamLabels: { a: 'Blue', b: 'Orange' },           rosterSize: 3, logo: 'games/rocketleague.svg',  features: ['boost', 'stats-api', 'director'],   themes: [], statLabel: 'Goals',  statAbbr: 'G' },
  'csgo':          { id: 'csgo',          name: 'CS2 / CS:GO',   overlay: '/csgo.html', format: 'team5', teamLabels: { a: 'CT', b: 'T' },                  rosterSize: 5, logo: 'games/cs2.svg',           features: ['gsi', 'radar', 'vetoes', 'director'], themes: [], statLabel: 'Rounds', statAbbr: 'R' },
  'valorant':      { id: 'valorant',      name: 'Valorant',      overlay: '',           format: 'team5', teamLabels: { a: 'Attackers', b: 'Defenders' },   rosterSize: 5, logo: 'games/valorant.svg',      features: ['vetoes', 'agents', 'director'],     themes: [], statLabel: 'Rounds', statAbbr: 'R' },
  'league':        { id: 'league',        name: 'League of Legends', overlay: '/lol-hud.html', format: 'team5', teamLabels: { a: 'Blue', b: 'Red' },         rosterSize: 5, logo: 'games/lol.svg',           features: ['draft', 'live-data', 'director'],    themes: [] },
  'dota2':         { id: 'dota2',         name: 'Dota 2',        overlay: '',           format: 'team5', teamLabels: { a: 'Radiant', b: 'Dire' },          rosterSize: 5, logo: 'games/dota2.svg',         features: ['draft'],                themes: [] },
  'overwatch':     { id: 'overwatch',     name: 'Overwatch 2',   overlay: '/overwatch.html', format: 'team5', teamLabels: { a: 'Defenders', b: 'Attackers' }, rosterSize: 5, logo: 'games/overwatch2.png',    features: ['heroes', 'vetoes', 'draft'], themes: [] },
  'rainbow6':      { id: 'rainbow6',      name: 'Rainbow Six Siege', overlay: '',       format: 'team5', teamLabels: { a: 'Attack', b: 'Defense' },        rosterSize: 5, logo: 'games/rainbow6.svg',      features: ['vetoes', 'operators'],  themes: [] },
  'cod':           { id: 'cod',           name: 'Call of Duty',  overlay: '',           format: 'team4', teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 4, logo: 'games/cod.png',           features: ['vetoes'],               themes: [] },
  'apex':          { id: 'apex',          name: 'Apex Legends',  overlay: '',           format: 'ffa',   teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 3, logo: 'games/apex.svg',          features: ['battle-royale', 'legends'], themes: [] },
  'fortnite':      { id: 'fortnite',      name: 'Fortnite',      overlay: '',           format: 'ffa',   teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 4, logo: 'games/fortnite.png',      features: ['battle-royale'],        themes: [] },
  'marvel-rivals': { id: 'marvel-rivals', name: 'Marvel Rivals', overlay: '/marvel-rivals.html', format: 'team6', teamLabels: { a: 'Team A', b: 'Team B' }, rosterSize: 6, logo: 'games/rivals.png',        features: ['heroes', 'draft'],       themes: [] },
  'smash':         { id: 'smash',         name: 'Super Smash Bros.', overlay: '',       format: '1v1',   teamLabels: { a: 'Player 1', b: 'Player 2' },     rosterSize: 1, logo: 'games/ssb.png',           features: ['bracket', 'stocks'],    themes: [] },
  'eafc':          { id: 'eafc',          name: 'EA Sports FC',  overlay: '',           format: '1v1',   teamLabels: { a: 'Home', b: 'Away' },             rosterSize: 1, logo: 'games/eafc.svg',          features: [],                       themes: [] },
  'mobile-legends':{ id: 'mobile-legends',name: 'Mobile Legends', overlay: '',          format: 'team5', teamLabels: { a: 'Blue', b: 'Red' },              rosterSize: 5, logo: 'games/mobilelegends.svg', features: ['draft'],                themes: [] },
  'honor-of-kings':{ id: 'honor-of-kings',name: 'Honor of Kings', overlay: '',          format: 'team5', teamLabels: { a: 'Blue', b: 'Red' },              rosterSize: 5, logo: 'games/honorofkings.svg',  features: ['draft'],                themes: [] }
};

Object.keys(GAMES).forEach((id) => {
  GAMES[id].themes = OVERLAY_LAYOUTS[id] || GENERIC_OVERLAY_LAYOUTS;
});

const THEME_ALIASES = {
  'rocket-league': { default: 'classic', midnight: 'classic', neon: 'classic' },
  'csgo': { default: 'cs2-hud', midnight: 'cs2-hud', neon: 'cs2-hud' },
  'valorant': { default: 'valorant-hud', midnight: 'valorant-hud', neon: 'valorant-hud' },
  'league': { default: 'lol-hud', midnight: 'lol-hud', neon: 'lol-hud' }
};

// Returns built-in + user-added custom overlay layouts for a game.
function gameThemes(gameId) {
  const builtin = OVERLAY_LAYOUTS[gameId] || GENERIC_OVERLAY_LAYOUTS;
  const custom = ((state.customOverlayLayouts || {})[gameId]) || [];
  return builtin.concat(custom);
}

function migrateThemeId(gameId, themeId) {
  if (isValidTheme(gameId, themeId)) return themeId;
  const aliases = THEME_ALIASES[gameId] || {};
  if (aliases[themeId]) return aliases[themeId];
  const themes = gameThemes(gameId);
  return (themes[0] && themes[0].id) || themeId;
}

function isValidTheme(gameId, themeId) {
  return gameThemes(gameId).some((t) => t.id === themeId);
}

function resolveOverlayLayout(gameId, themeId) {
  const g = GAMES[gameId];
  if (!g) return { id: '', name: '', path: '/' };
  const themes = gameThemes(gameId);
  const id = migrateThemeId(gameId, themeId || state.themesByGame[gameId]);
  const layout = themes.find((t) => t.id === id) || themes[0];
  return layout || { id: '', name: '', path: g.overlay || '/' };
}

function activeOverlayPath(gameId) {
  return resolveOverlayLayout(gameId, state.themesByGame[gameId]).path;
}

function gameHasFeature(gameId, feat) {
  const g = GAMES[gameId];
  return !!(g && g.features && g.features.includes(feat));
}

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  version: appVersion,
  view: 'hud',              // 'hud' | 'scoreboard' | 'goal'
  rlHudHidden: false,       // manual "hide UI" — blanks the live RL HUD overlay for a clean feed (not persisted)
  // Game performance mode: while an RL match is LIVE the app sheds load so borderless
  // gameplay stays smooth — panel previews/animations pause, the app's process priority
  // drops below the game's, and full-state broadcasts coalesce wider. Broadcast overlays
  // are untouched. enabled = producer setting (persisted); active = engaged right now.
  // enabled = auto game mode; always = permanent lean mode; reduceAnimations /
  // pausePreviews = independent panel knobs; broadcastRate = smooth|balanced|light
  // (full_state coalesce width). active = a match is live right now.
  perfMode: { enabled: true, active: false, always: false, reduceAnimations: false, pausePreviews: false, broadcastRate: 'smooth' },
  activeGame: 'rocket-league',
  // Pulse multiview: when publish is on (and the cloud is linked), this app heartbeats its live game to
  // the org so it appears on other producers' Pulse scenes. feedViewUrl = this observer's own VDO view
  // URL others pull for the featured video (optional — without it the tile is scores-only).
  pulse: { publish: false, feedViewUrl: '' },
  themesByGame: { 'rocket-league': 'classic', 'csgo': 'cs2-hud' },
  eventName: '',   // fresh installs start with no preset title — the producer sets their own
  gameLabel: '',   // custom "GAME x | BEST OF x" override (e.g. "UPCOMING MATCH"); '' = auto
  roundLabel: '',  // optional bracket round/stage shown on the overlay (e.g. "WINNERS FINALS"); '' = hidden
  dateFormat: 'us', // schedule date/time display: 'us' (Jul 12, 8:00 PM) | 'intl' (12 Jul, 20:00)
  speedUnit: 'mph', // shot-speed display unit: 'mph' | 'kmh'. RL's Stats API reports km/h and does NOT
                    // expose the player's UI unit setting, so this is a manual toggle. Overlay converts.
  fontFamily: 'Industry',
  clock24h: false,
  showSeries: true,
  defaultBestOf: 3,
  facecamsEnabled: true,
  replayCams: true,         // show all player cams + cards during replays (RL React HUD)
  activeBrandKitId: null,   // selected client brand kit (recolors overlays + drives sponsor rail)
  useBrandColors: false,    // legacy mirror of (colorMode === 'brand') — kept for back-compat
  // Which colours overlays use for the two sides. Non-destructive: each source is kept separately
  // (team = teams.x.color, brand = active kit, default = per-game) and the effective colour is
  // computed at broadcast time, so toggling never overwrites a team's own colour.
  colorMode: 'team',        // 'team' | 'brand' | 'default'
  sceneBg: {},              // live bg fill per overlay path, keyed by pathname
  banner: { visible: false, images: [], captions: [], interval: 10, slant: 'right', header: '' },
  // Stream Credits scrolling roll (overlay/stream-credits.html) — a gfx.html Push Live scene like any
  // other; the overlay has no visibility gate of its own, so `visible` is the only thing that decides
  // whether it's showing. Extras: producer-added "credit sponsors" — a dedicated big call-out section
  // in the roll, separate from the brand-kit sponsor bar [{name,logo,tier}]; talent = manual
  // {name,role} credits (other-shift crew). (Single source of truth — must not be redefined below.)
  credits: { visible: false, sponsors: [], talent: [], endText: '' },   // endText: big end-card text after the roll ('' → "Thanks For Watching")
  casters: { visible: true, showCountry: false, nameMode: 'gamertag', showRoles: { host: '', observer: '' }, shifts: [], activeShiftId: '', support: [], list: [], lowerThird: '', library: [], vdo: { room: '', password: '' }, guestsVdo: { room: '', password: '' }, observersVdo: { room: '', password: '' }, rooms: [], lineup: [], activeLayout: '', interview: { room: '', password: '' }, apiKey: '', interviewee: null, playerCam: null, deskRoomId: '', slotLabels: { 1: 'Caster 1', 2: 'Caster 2', 3: 'Caster 3', 4: 'Caster 4', 5: 'Player' } },   // list = on-air slots; showCountry = render each caster's country on the desk; library = saved casters/guests/observers (by kind); vdo/guestsVdo/observersVdo = the three shared group rooms; rooms = named VDO rooms; lineup = this-show active assignments; apiKey = director IFrame-API key; interviewee = spotlight-desk right cam; playerCam = slot-5 player feed ({camUrl,name,playerId}); deskRoomId = which named room is the interview/desk room
  // VDO.Ninja talent workflow. Global config (server-side, replaces the old localStorage settings);
  // per-team rooms/passwords live on teams.x.vdo, per-player IDs on the player objects.
  vdo: {
    base: 'https://vdo.ninja',
    lang: 'en-US',          // &transcribe language for live captions
    listenCaptions: true,   // LISTEN IN: show/hide the transcription strip (Talent Rooms toggle)
    cleanOutput: true,      // strip VDO UI on view/OBS links
    transparent: false,
    cover: true,            // fill the frame
    volume: 100,
    bitrate: '',            // kbps (blank = auto)
    codec: '',              // '' | h264 | vp8 | vp9 | av1
    buffer: '',             // jitter buffer ms
    viewParams: '',         // extra params appended to OBS/view links
    pushParams: '',         // extra params appended to talent join links
    audioMono: false,       // down-mix every feed to mono (&mono)
    audioBitrate: '',       // audio bitrate kbps (&ab — blank = auto)
    audioParams: ''         // free-text extra VDO audio params (e.g. &compressor&limiter)
  },
  // LISTEN IN — the player whose audio + live captions are currently on-air (listen-in.html).
  listenIn: { active: false, side: '', name: '', url: '' },
  // Break / "starting soon" standby. endsAt = epoch ms target for the countdown scene; null = no timer.
  breakScreen: { visible: false, title: 'STARTING SOON', message: '', endsAt: null, frozenSeconds: null, finalMessage: "WE'RE LIVE!", thenScene: '', thenPlayout: '' },
  ticker: { visible: false, messages: [], speed: 40, source: 'manual', feed: [], sponsor: '' },   // scrolling lower-third; speed = loop seconds
  // Sponsor proof-of-play: archived per-broadcast impression reports (estimated on-screen seconds
  // per sponsor logo, by placement). The live session is tracked in-memory (adProof); completed
  // sessions land here and persist. Tiny — names + counts only, no logos.
  adProofSessions: [],
  spotlight: { visible: false, playerName: '' },          // featured-player lower-third (live stats)
  // Post-match WINNER screen (game-agnostic). side resolves a team from `teams`; or set name/logo/color directly.
  winner: { visible: false, side: '', name: '', logo: null, color: '', subtitle: '' },
  // Map veto / map-pool overview board (CS2/Valorant/etc.). Each map: name, mode, image, action, by, score, winner.
  // action: 'ban'|'pick'|'decider'|''  by: 'a'|'b'|''  winner: 'a'|'b'|''  score: { a, b }
  veto: { visible: false, title: '', maps: [] },
  // Overwatch 2 series scoreboard — hero bans per map + format display.
  // bansByMap: [{ a: { hero, role }, b: { hero, role } }] indexed by map order.
  owMatch: { visible: true, format: 'FT3', currentMapIdx: 0, bansByMap: [], gameMode: 'escort', showMapLabels: true, mapWinners: [], mapModes: [] },
  // Marvel Rivals series scoreboard — 4 bans per team (match-global), map results, Overwolf GEP data.
  // bansByMap: [{ a: [{hero,role}×4], b: [{hero,role}×4] }] — uses index 0 (bans are series-wide).
  mrMatch: { visible: true, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null },
  // User-defined overlay URLs shown alongside the built-in ones in the layout dropdown.
  // Keyed by gameId → [{ id, name, path }]
  customOverlayLayouts: {},
  // One active Game Config per game (maps/roles/characters extending an EXISTING built-in game —
  // see gameConfigMapsFor/gameConfigCharactersFor in backend/veto.js and backend/draft.js, and
  // rolesForActiveGame() client-side). Keyed by gameId → the imported bundle, or absent = pure
  // built-in. Importing REPLACES a game's slot; the bundle's own maps/characters/roles still merge
  // by id onto the built-in tables at read time, so an import doesn't need to re-list everything.
  gameConfigs: {},
  // Champion/hero draft board (LoL etc.). sequence/ops drive the live pick-ban.
  draft: { visible: false, title: '', subtitle: '', game: '', teamStart: 'a', owBanCount: 4, sequence: [], ops: [], turn: null, complete: false,
    // owBanCount: Overwatch total hero bans (2 = one per team, 4 = two per team). Producer-set.
    // LoL champ-select automation — fills the board live from the League Client (LCU).
    auto: { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' } },
  // Team-lineup / player-intro card scene. side = which team to feature ('blue'|'orange'); style = card variant.
  intro: { visible: false, side: 'blue', title: '', style: 1, showFooter: false, showRealName: true },
  // (state.credits defined once near the top of this state object — sponsors/talent/visible together.)
  // Overtime ad slot — sellable sponsor slot shown on the overlay during OT.
  overtime: { label: 'OVERTIME', logo: null, bg: '#e0202a', color: '#ffffff' },
  // Replay ad slot. logo = sponsor on the goal swipe; outroLogo = logo on the after-replay swipe
  // (e.g. tournament-organizer logo); colorMode: 'team' | 'mono' (B&W).
  // skin = a full-frame TRANSPARENT PNG shown over the whole replay (a branded frame/border to
  // "skin" replays); null = none.
  replay: { label: 'REPLAY', logo: null, outroLogo: null, colorMode: 'team', skin: null },
  // Scoreboard ad slot — sponsor logo + uploadable scene background on the scorecard.
  scoreboardAd: { label: 'PRESENTED BY', logo: null, background: null },
  // Post-game stats screen skin (RL scoreboard). showStats=false shows a clean FINAL-only board;
  // design picks the look of the per-team stat table: default | glass | block | radar.
  rlStatsScreen: { showStats: true, design: 'default' },
  // OBS background browser source (background.html). type: 'solid'|'gradient'|'image'.
  background: { type: 'gradient', color1: '#07090f', color2: '#0c1220', angle: 135, imageUrl: '' },
  // Desk footer logos — manual Dashboard override. When non-empty these replace the active
  // brand's desk-tagged sponsors on the caster-desk scenes; when empty the brand's logos show.
  deskFooter: { logos: [] },
  // Desk Show (preshow.html) — 2-cam standalone OBS scene; cams/team-matchup/kickoff
  // timer/brand logo all reuse existing state (casters/upcoming/breakScreen/teams/brand). Only
  // the discussion-topics rail + headline need their own settings.
  // Each topic: { text, sceneName } — sceneName is an optional OBS scene to cut to when that
  // topic goes active (e.g. cut to the Bracket while discussing "who's going to Worlds").
  // homeScene is the OBS scene "Return" switches back to (typically the Desk Show scene).
  // headline/topics mirror the active brand package's own topicsHeadline/topics fields
  // (syncActivePreshowTopics()) — not independently persisted here.
  // predictions[i] = caster in desk slot i+1's pick for the upcoming match: '' | 'blue' | 'orange'.
  preshow: { headline: '', topics: [], activeTopicIndex: 0, homeScene: '', predictions: ['', ''] },
  csgo: {                                                 // CS2 Game State Integration
    connected: false,
    lastUpdate: 0,
    cfgPath: '',
    map: { name: '', phase: '', mode: '' },
    round: { number: 0, phase: '', bomb: '', winTeam: '' },
    ct: { name: 'CT', score: 0, lossBonus: 0, timeouts: 0, seriesWins: 0 },
    t:  { name: 'T',  score: 0, lossBonus: 0, timeouts: 0, seriesWins: 0 },
    provider: { version: null, timestamp: null },
    roundHistory: [],  // [{ round, winner: 'CT'|'T', method }]
    observed: null,    // currently spectated player (bottom focus panel)
    players: [],   // [{ steamid, name, team, health, armor, money, kills, assists, deaths, mvps, score, roundKills, roundHs, roundDmg, alive, equip, flashed, burning, smoked, weapon, nades, hasKit, hasBomb, pos }]
    grenades: [],  // active grenades for the radar: [{ type, x, y, effecttime }]
    bomb: { state: '', countdown: null, pos: null, player: '' },
    phase: '',
    phaseEndsIn: null,
    showHistory: false,    // round-history overlay visibility (control-panel toggle)
    builtinRadar: true,    // true = built-in auto-zoom radar (default); false = external (boltobserv)
    killfeed: []           // recent kills: [{ killer, killerTeam, victim, victimTeam, weapon, hs, ts }]
  },
  valorant: {                                              // Valorant Local Client API (port 2999)
    connected: false,
    lastUpdate: 0,
    map: { name: '', displayName: '' },
    round: { number: 1, phase: 'warmup' },
    // ORDER = attacker first half; CHAOS = defender first half (sides swap at round 13)
    order: { score: 0 },
    chaos: { score: 0 },
    spikeState: '',   // '' | 'carried' | 'planted' | 'defusing' | 'defused' | 'detonated'
    players: [],      // [{ name, agent, agentName, team, health, maxHealth, armor, alive, kills, assists, deaths }]
    observed: null,   // activePlayer from the API (spectated player)
    roundHistory: [], // [{ round, winner: 'ORDER'|'CHAOS' }]
  },
  lol: {                                                   // League Live Client Data API (port 2999, spectator)
    connected: false,
    lastUpdate: 0,
    gameTime: 0,
    mapNumber: 1,
    gameMode: '',
    // ORDER = blue side, CHAOS = red side. gold is ESTIMATED net worth (see backend/lol-live.js).
    blue: { kills: 0, gold: 0, towers: 0, inhibs: 0, dragons: [], barons: 0, heralds: 0, grubs: 0, dragonSoul: '', firstBlood: false },
    red:  { kills: 0, gold: 0, towers: 0, inhibs: 0, dragons: [], barons: 0, heralds: 0, grubs: 0, dragonSoul: '', firstBlood: false },
    goldDiff: 0,      // blue.gold - red.gold (+ = blue ahead)
    players: [],      // [{ name, champion, team, position, level, dead, respawn, kills, deaths, assists, cs, vision, items, itemValue, spells, gold }]
    events: [],       // recent notable events for the kill feed/ticker
    hudMode: 'auto',  // 'full' | 'minimal' | 'auto' — producer control for the teamfight transition
    // Optional OCR override for REAL team gold (estimate is the default). Producer
    // calibrates the two capture regions over the spectator scoreboard gold numbers.
    ocr: {
      enabled: false, available: false, status: 'off', statusDetail: '',
      source: 'est',          // 'est' | 'ocr' — which feed is currently driving team gold
      lastBlue: null, lastRed: null,   // last raw OCR'd values (for calibration feedback)
      regions: { blue: { x: 800, y: 16, w: 78, h: 26 }, red: { x: 1042, y: 16, w: 78, h: 26 } }  // 1080p defaults
    },
  },
  bestOf: 5,
  teams: {
    blue:   { name: 'BLUE TEAM',   logo: null, color: '#055fdb', players: [] },
    orange: { name: 'ORANGE TEAM', logo: null, color: '#e97139', players: [] }
  },
  teamPlayers: {}, // keyed by side, contains player data
  series:  { blue: 0, orange: 0 },
  // Series/match editor: format + division + per-map results (feeds the HUDs).
  // maps: [{ name, scoreA, scoreB, played }]
  match:   { format: '', division: '', maps: [], seriesVisible: true },
  // Manually-managed leagues (NOT start.gg). Each league:
  // { id, name, game, type:'team'|'freeagent'|'salary', season, salaryCap,
  //   teams:[{id,name,logo,players:[{id,name,role,salary,stats}]}],
  //   freeAgents:[{id,name,role,salary,stats}], standings:[{teamId,w,l,pts}], schedule:[{a,b,scoreA,scoreB,date,played}] }
  leagues: [],
  // Events the producer has "added to the app" (the MY EVENTS page). Each:
  // { id, tournamentSlug, eventSlug, name, tournamentName, game, numEntrants, startAt, addedAt,
  //   seeding: { entrants:[{entrantId,name,seedNum,players:[{gamerTag,rankField,rankValue}]}], fieldMap:{} } }
  myEvents: [],
  // Event Ops (ESPORTS ▸ Event Ops) — the start.gg → Challonge mirroring workbench.
  // headers/rows: the FULL imported spreadsheet (every column, rows as string arrays);
  // roleMap: which column index means team/team2/player/email/challonge/flags (-1 = none);
  // seeds: TRUE start.gg bracket seeds (initialSeedNum) [{ seed, name }] — the order to
  // recreate in Challonge so byes land identically.
  eventOps: { headers: [], rows: [], roleMap: {}, seeds: [], eventSlug: '', importedAt: 0, seededAt: 0 },
  // Per-player profile registry keyed by lowercased gamertag. Auto-linked: start.gg
  // (slug/playerId) on every roster pull, 6mans (rl6mans name/elo/rank/region) on rank
  // verify. Read by the seeding page, team editor and Match-Teams panel to show links.
  //   { <gamertag>: { gamerTag, startggSlug, startggPlayerId, sixmans:{name,elo,rank,region,platform}, updatedAt } }
  playerProfiles: {},
  game:    { blueScore: 0, orangeScore: 0, time: 300, isOT: false, number: 1 },
  gameTeams: { blue: '', orange: '', blueColor: '', orangeColor: '' },   // *Color = live in-game paint colours (RL Stats API ColorPrimary)
  players: [],          // active players (from last UpdateState)
  playerCache: {},      // all players seen (keyed by name) — for scoreboard
  currentGoal: null,    // { scorer, assister, speed, team }
  spectatedPlayer: null,
  rlConnected: false,
  rlSpectatorUi: { ...rlSpectatorUi.DEFAULTS },
  startgg: {
    enabled: false,
    tournamentSlug: '',
    eventSlug: '',
    setId: '',
    connected: false,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    // Stream-queue auto-population: matches marked for a stream, optionally auto-pushed live.
    streams: [],           // [streamName] available on the tournament
    streamName: '',        // selected stream to follow ('' = first/any)
    queue: [],             // [{ setId, stream, round, state, teamA, teamB, live }]
    teamQueue: [],         // team-search results (non-admin path)
    focusTeam: '',         // team name to highlight in bracket overlay
    matchFeed: [],         // [{ setId, round, teamA, teamB, scoreA, scoreB, status, stream }] for desk tickers
    autoFollow: false,     // auto-push the in-progress set when queue polls
    queueEnabled: false,   // dashboard toggle — poll stream queue from Settings API config
    lastPushedSetId: null,
    queueFetchedAt: null,
    // New: selected tournament/event for pulling teams/stats (separate from savedTeams)
    selectedEvent: null,   // { tournamentSlug, eventSlug, name, tournamentName }
    eventTeams: [],        // [{ name, logo, players: [{id,name,platform,platformId,assignedCamera}], startggId }]
    logoMap: {},           // lowercased entrant name -> logo URL (so queue/upcoming/bracket can show logos)
    pendingEvents: []      // [{ slug, name, numEntrants }] when a tournament has >1 event (panel shows a picker)
  },
  challonge: {
    enabled: false,
    tournamentSlug: '',    // e.g. "my-tournament" or "subdomain-tournament"
    connected: false,
    lastError: null,
    lastSyncAt: null,
    selectedTournament: null, // { id, slug, name, url, type, state, participantsCount, gameName }
    eventTeams: [],        // [{ name, logo, seed, challongeId, finalRank }]
    logoMap: {},
    queue: [],             // [{ matchId, round, identifier, state, teamA, teamB, logoA, logoB, scoreA, scoreB, live }]
    matchFeed: [],
    queueFetchedAt: null,
    autoFollow: false,
    lastAutoFollowMatchId: null
  },
  nxgen: {
    enabled: false,
    eventSlug: '',         // nxgen.pro event slug
    connected: false,
    lastError: null,
    selectedEvent: null,   // { name, slug, activity, format, status, url }
    eventTeams: [],        // [{ name, logo, nxgenId }]
    logoMap: {},           // name.toLowerCase() → logo URL
    queue: [],             // [{ matchId, round, teamA, teamB, logoA, logoB, scoreA, scoreB, status, live }]
    queueFetchedAt: null,
    autoFollow: false,
    lastAutoFollowMatchId: null
  },
  activeEvent: {
    platform: null,      // 'startgg' | 'challonge' | 'nxgen' | null
    slug: '',
    name: '',
    gameName: '',
    numEntrants: 0,
    format: '',
    url: '',
    loadedAt: null
  },
  obs: {
    enabled: false,
    connected: false,
    url: 'ws://127.0.0.1:4455',
    autoSwitch: true,
    autoReplayOnGoal: false,   // save an OBS replay-buffer clip on every goal
    lastError: null,
    postGameToCastersSec: 0,  // auto-switch post-game → casters after N seconds (0 = off)
    kickoff: { enabled: false, scene: '', transition: '' },  // smart trigger: auto-cut to this scene at the 3-2-1 kickoff countdown
    postGame: { enabled: false, scene: '', delaySec: 20, transition: '' },  // RL: after the post-game scoreboard shows for delaySec, cut to this scene
    availableScenes: [],
    availableTransitions: [],
    currentScene: '',    // live OBS PROGRAM scene = what viewers see (authoritative "on air")
    currentPreviewScene: '',  // Studio Mode preview scene (the Switcher page's "next")
    studioMode: false,        // OBS Studio Mode on/off (needed for preview/program + TAKE)
    scenes: {            // OBS scene name to switch to for each broadcast moment
      inGame: '',
      replay: '',
      postGame: '',
      break: '',
      commercial: '',    // dedicated ad-break scene that plays commercial videos
      casters: '',
      bracket: ''
    },
    commercialAutoReturn: true,  // auto-cut back to program when the commercial video ends
    replayBufferActive: false    // live status from OBS ReplayBufferStateChanged
  },
  // vMix — the FULL ALTERNATIVE production backend to OBS (either/or, never both). HTTP Web API
  // (default :8088) polled for live state; functions fired by flows + the switcher. See
  // docs/vmix-integration.md. state.switcher.target picks which backend is live.
  vmix: {
    enabled: false,
    connected: false,
    host: '127.0.0.1',
    port: 8088,
    lastError: null,
    version: '',
    edition: '',
    active: null,        // program input number
    preview: null,       // preview input number
    streaming: false,
    recording: false,
    inputs: [],          // [{ number, key, type, title, state }]
    overlays: []         // [{ number, input }] — overlay channels 1-4
  },
  // Which production switcher is live. Mutually exclusive — vMix is a full alternative to OBS.
  switcher: { target: 'obs' },   // 'obs' | 'vmix'
  // Runtime (not persisted): are we currently in a commercial, and where to return.
  commercial: { active: false, returnScene: '' },
  bracket: {
    visible: false,
    eventSlug: '',
    followActive: true,   // auto-point at the ACTIVE event (Dashboard ▸ Event); false = producer typed an explicit slug
    title: '',
    subtitle: '',         // small header line under the title — mainly used by the League source
    showRecord: true,     // show/hide W-L columns on the standings table (League source toggle)
    // How the current phases were populated. 'imported' = a platform feed owns the data and the
    // live-refresh tick may overwrite it; 'manual' = the in-app builder owns it and NOTHING external
    // should clobber it. Prevents the old silent collision where a manual edit wiped an import (and
    // vice-versa). source names the platform for 'imported'. Default '' = empty/no bracket yet.
    mode: '',            // '' | 'imported' | 'manual'
    source: '',          // '' | 'startgg' | 'challonge' | 'nxgen'
    type: '',            // SINGLE_ELIMINATION | DOUBLE_ELIMINATION | ROUND_ROBIN | SWISS (mirrors active phase)
    winners: [],         // [{ name, round, sets: [{ a:{name,score,winner}, b:{...} }] }] (mirrors active phase)
    losers: [],
    finals: [],
    standings: [],       // [{ placement, name, wins, losses }] for round-robin / swiss (mirrors active phase)
    schedule: [],        // [{ name, round, sets: [{a,b}] }] round-by-round pairings, round-robin/swiss only
    roster: [],          // round-robin/swiss entrant names (mirrors active phase)
    matches: [],         // [{ id, round, a, b, state }] flat picker list
    // Multi-phase events (e.g. Day 1 double-elim → Day 2 single-elim/swiss).
    // Each phase: { id, name, type, winners, losers, finals, standings, schedule, roster, pools }.
    // Each phase also has pools: [{ id, name, type, roster, schedule, standings, matrix }] — one
    // entry per Start.gg phaseGroup (Pool 1, Pool 2, ...); single-pool phases still get one entry
    // so winners/losers/finals/standings/schedule/roster below always mirror pools[0].
    // Top-level winners/losers/finals/standings/type/schedule/roster mirror the ACTIVE phase's
    // ACTIVE POOL so the existing overlay keeps working unchanged.
    phases: [],
    activePhaseId: '',
    pools: [],           // [{ id, name }] lightweight list of the active phase's pools, for the pool selector
    activePoolId: '',
    matrix: null,        // { teams:[{id,name}], cells:{ "idA_idB": {aScore,bScore,winner} } } — Round Robin pools only
    view: 'both',        // overlay view: both | winners | losers | finals | schedule | standings | matrix
    rounds: 4,           // for view='finals' — how many last round-columns of each bracket to show
    lastFetchAt: null,
    lastError: null
  },
  upcoming: {
    visible: false,
    title: 'SCHEDULE',
    eyebrow: 'On Deck',    // small label above the title (board layout uses title as e.g. "WEEK 11")
    layout: 'cards',       // 'cards' = duorow card row | 'board' = weekly matchup board (team-colored bars)
    // 'event' = follow the stream queue (marked-as-stream matches + a couple non-stream upcoming);
    // 'team' = the searched team's own matches. Set by which Stream Queue tab / fetch is used.
    source: 'event',
    showResults: false,   // keep FINISHED matches on the board with their final series score (else hidden)
    matches: []   // manual entries/overrides: [{id,round,teamA,teamB,teamALogo,teamBLogo,date,time,stream,scoreA,scoreB,week,note}]
  },
  standings: {
    visible: false,
    title: '',    // '' = inherit bracket.title; auto-populated from bracket.standings if rows is empty
    subtitle: '', // optional line under the title (e.g. "Week 4 · Group A" or a season label)
    showRecord: true, // false = hide the W/L columns (clean points-only leaderboard)
    source: 'auto',   // 'auto' (bracket/start.gg) | 'league' | 'startgg-league' | 'manual' — informational; rows always win
    rows: []      // manual override: [{placement,name,logo,wins,losses,points}]
  },
  // Season / league record shown under each team name on the top scorebar overlay.
  // Source priority: per-team manual league standings (W/L/PTS) for season + points +
  // placement; live start.gg event standings for "this week" W/L. Resolved per-broadcast
  // in buildLiveState() into a tiny teamRecords:{blue,orange} blob — see resolveTeamRecords().
  //   metric: 'season' | 'week' | 'pts' | 'place' | 'record-pts'
  //   source: 'stats' (in-app leagues) | 'startgg' (tournament platform) | 'manual' (per-team below)
  //   manualByName: per-TEAM W/L (+ optional pts/place) keyed by lowercased team name, so a hand-set
  //     record is tied to the team PROFILE — it follows the team across side swaps and reassignments.
  //     (Legacy `manual: {blue,orange}` is migrated into this on load.)
  teamRecord: {
    enabled: false, metric: 'season', source: 'stats', leagueId: '',   // leagueId = chosen in-app league for the 'stats' source ('' = auto-pick)
    week: '',   // 'stats' source only — which lg.schedule week feeds weekW/weekL ('' = auto: latest fully-completed week)
    manual: { blue: { w: 0, l: 0, pts: null, place: null }, orange: { w: 0, l: 0, pts: null, place: null } },
    manualByName: {}
  },
  // When on, team names reported by the live game (CS2 GSI / RL Stats API) are matched to the
  // saved-teams library and applied to Blue/Orange (name + logo + colour). Generic names ignored.
  autoTeamsFromGame: false,
  // Season-long standings pulled from a start.gg LEAGUE (e.g. "3v3 Rocket Rush x Trophi.ai
  // Season 2") — DISTINCT from in-app manual leagues and from per-tournament standings. A
  // start.gg League aggregates many tournaments into one season with league points; we read
  // Standing.totalPoints + placement per entrant. This is the authoritative source for the
  // overlay's season points/placement (teamRecord); W/L still comes from in-app leagues.
  startggLeagueStandings: {
    slug: '',          // start.gg league slug or full URL (normalized on fetch)
    name: '',          // resolved league name
    fetchedAt: null,
    lastError: null,
    teams: []          // [{ name, place, points }] (sorted by placement)
  },
  // Which production graphic is currently showing in the unified gfx.html overlay.
  // null = nothing showing. Values match SCENE_META keys: 'break','winner','intro','ticker', etc.
  gfxActive: null,
  scenePresets: {},   // { [sceneKey]: { active: string, presets: { [name]: { label, config: { accent, accent2, font } } } } }
  // "Teams to Watch" spotlight graphic — a small set of teams the producer marks on an event,
  // each with custom fields (CURRENT RANK / POINTS / …). Team logos are resolved by name in the
  // overlay (savedTeams / start.gg logo map) so this stays tiny in the broadcast.
  watchlist: {
    visible: false,
    title: 'TEAMS TO WATCH',
    subtitle: '',                          // smaller line under the title (auto = the start.gg event name)
    logo: '',                              // optional header/event logo (URL or small image)
    fields: [{ id: 'rank', label: 'CURRENT RANK' }],   // custom columns shown per team
    teams: []                              // [{ id, name, players:[gamerTag], values:{ fieldId }, pos:0 }] (pos 1 = podium centre)
  },
  // Single-team deep-dive spotlight. Team-level data (seed/placement/record/recent+next sets) is
  // auto-pulled from start.gg for the entrant; per-player shows the seeding rank by default and
  // live GSI stats (RL/CS2/Valorant) when this team is the one on-air.
  teamSpotlight: {
    visible: false,
    name: '', eventSlug: '', entrantId: '',
    players: [],   // [{ gamerTag, name, seedRank }]
    sg: { seed: null, placement: null, record: { w: 0, l: 0 }, recent: [], next: null },
    lastSync: 0, syncError: ''
  },
  director: {
    enabled: true,
    sensitivity: 0.5,
    lockTarget: null,
    autoSwitch: false,
    primary: null,
    alternates: [],
    feed: [],
    confidence: 0,
    learning: null,
    lastAutoSwitch: null
  },
  // AI master controls. `shield` = panic kill-switch: when true, ALL AI automations are
  // blocked (director auto-switch, auto-clipping, OBS auto-switch, auto-replay, smart triggers).
  // Recommendations still display; nothing acts on its own. Reversible — your toggles are kept.
  ai: {
    shield: false,
    telemetry: { enabled: true }   // local decision logging for training (Phase 0)
  },
  clips: {
    library: [],
    montages: [],
    // How highlight events are clipped: 'auto' (clip silently), 'prompt' (ask the
    // producer with a pop-up), or 'manual' (only the Capture button). autoCapture
    // mirrors mode==='auto' for back-compat with the manager.
    captureMode: 'auto',
    autoCapture: true,
    autoMontage: false,       // auto-add captured clips to the live montage
    autoMontageId: null,
    replayFolder: '',
    captureRules: {
      goal: true, ace: true, clutch: true, save: true, multi_kill: true, defuse: true,
      kickoff: false, demo: false, shot: false
    }
  },
  encode: { queue: [], active: null },
  // Replay-to-screen: what each replay-player browser source bus is showing.
  // program = live to air; preview = the staging monitor (multiview).
  replay: {
    program: { url: '', name: '', loop: false, playing: false },
    preview: { url: '', name: '', loop: false, playing: false }
  },
  twitch: {
    connected: false,
    adsEnabled: true,   // producer gate for running Twitch ads (persisted, enforced in /ad/run)
    channelId: '',
    userId: '',
    displayName: '',
    apiToken: '',
    refreshToken: '',
    webhookSecret: process.env.TWITCH_WEBHOOK_SECRET || (() => {
      if (!IS_DEV()) console.warn('[Twitch] TWITCH_WEBHOOK_SECRET not set — using insecure fallback. Set it in .env');
      return 'dev-secret';
    })(),
    webhookUrl: process.env.TWITCH_WEBHOOK_URL || 'http://localhost:3000/api/twitch/webhooks',

    predictions: {
      enabled: true,
      current: null,
      history: [],
      lastAuto: null,   // { kind:'created'|'resolved'|'skip'|'error', message, ts } — last auto-prediction attempt (diagnostics surfaced in the panel)
      settings: {
        autoCreate: false,
        template: 'generic',
        cooldown: 300000,
        overlayLoop: 30,      // seconds the looped overlay stays SHOWN per cycle
        overlayHide: 8,       // seconds the looped overlay stays HIDDEN between cycles
        overlayHidden: false, // producer force-hide — show/hide the card on stream during a game
        hideInReplay: false   // auto-hide while a Rocket League goal replay is playing (state.inReplay)
      }
    },

    wheel: {
      current: null,
      prizes: [
        { id: 'prize-1', name: 'Sub Gift', color: '#FF6B6B', weight: 1 },
        { id: 'prize-2', name: '$25 Amazon', color: '#4ECDC4', weight: 1 },
        { id: 'prize-3', name: 'Game Copy', color: '#FFE66D', weight: 2 }
      ],
      participants: [],
      history: [],
      settings: {
        duration: 8000,
        requireLiveView: false,
        entryMethod: 'follow'
      }
    },

    minigame: {
      current: null,
      games: [],
      history: [],
      settings: {
        enabled: true,
        defaultDuration: 30000,
        breakScreenGameType: 'trivia',
        pointReward: 500
      }
    },

    chat: {
      recentMessages: [],
      activeParticipants: []
    },

    chatSettings: {},
    chatConnected: false,
    chatChannel: '',

    automations: {
      announceOnMatchStart: '',
      announceOnMatchEnd: ''
    },

    poll: {
      current: null,
      history: []
    },

    adBreak: {
      active: false,
      duration: 0,
      startedAt: null,
      endsAt: null,
      isAutomatic: false
    },
    activityLog: []
  },

  discord: {
    connected: false,
    userId: '',
    username: '',
    discriminator: '',
    globalName: '',
    avatarUrl: '',
    accessToken: '',
    refreshToken: '',
    lastError: ''   // why the last OAuth attempt failed (surfaced in the panel + login poll)
  },

  // ─── Flows (production automation) ─────────────────────────────────────────
  // Each flow: { id, name, enabled, triggerMode: 'any'|'sequence', triggers: [...], actions: [...], cooldown }
  // Triggers: { id, type, params, timeout (sequence mode only) }
  // Actions:  { id, type, params }
  flows: [],
  // Named key/value pairs set by set_variable/increment_variable actions; used in {{token}} substitution
  flowVars: {}
};

let directorEngine = null;
let clipSystem = null;
let telemetry = null;            // AI decision recorder (Phase 0)
let _directorRecShownAt = 0;     // when the current primary rec was first emitted (for decision latency)
let _lastRecTargetId = null;     // de-dupe the shadow recommendation stream
let overlayEditor = null;
let onEncodeProgressCallback = null;
let _launcherLaunchCb = null;   // main.js: swap the launcher window for the studio window
let _launcherResizeCb = null;   // main.js: resize the launcher window (license view needs room)
// First sign-in after approval: the backend refused login pending the license signature.
// Holds { token, license: {version,title,preamble,sections} } until accepted or logout.
let _pendingContract = null;
let onRlSpectatorUiHotkeyChange = null;
let lastGenericDirectorFeed = 0;

let savedTeams = [];   // [{ name, logo }]
let savedFacecams = []; // [{ name, platformId, link }]
let savedPresets = [];  // [{ id, name, game, config }] — broadcast config presets
// Client/production identities. Selecting one recolors overlays + loads its sellable sponsor set.
let savedBrandKits = []; // [{ id, name, logo, color, accent, font, sponsorLabel, sponsorInterval,
                         //    sponsors: [{ id, name, logo, tier }], themes: { [gameId]: themeId } }]
// Monotonic version bumped on EVERY brand-kit mutation (via saveBrandKits). librarySig() and the
// client's renderBrands signature key off it so the brand library re-broadcasts + the editor's
// closures refresh on ANY change — the old length/count hash missed reorders, tier changes,
// same-length renames and edits to non-active packages, which made sponsor edits silently revert.
let brandKitsVer = 0;
let savedTeamsVer = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Atomic write: write to .tmp then rename so a crash mid-write never corrupts the live file.
// The server runs INSIDE the Electron main process, so the default path is ASYNC — a
// synchronous writeFileSync here stalls the window (clicks drop, UI freezes). Overlapping
// writes to the same file are coalesced to the latest data so the single .tmp never races.
// Pass sync=true only for the shutdown flush, where the write must finish before exit.
const _writingFiles = new Set();
const _pendingWrites = new Map();
function safeWriteJson(filePath, data, sync = false) {
  if (sync) {
    const tmp = filePath + '.tmp';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
    return;
  }
  if (_writingFiles.has(filePath)) { _pendingWrites.set(filePath, data); return; }
  _writingFiles.add(filePath);
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  const done = () => {
    _writingFiles.delete(filePath);
    if (_pendingWrites.has(filePath)) {
      const next = _pendingWrites.get(filePath);
      _pendingWrites.delete(filePath);
      safeWriteJson(filePath, next, false);
    }
  };
  fs.mkdir(path.dirname(filePath), { recursive: true }, (mkErr) => {
    if (mkErr) { console.error('[save] mkdir', filePath, mkErr.message); return done(); }
    fs.writeFile(tmp, json, (wErr) => {
      if (wErr) { console.error('[save] write', filePath, wErr.message); return done(); }
      fs.rename(tmp, filePath, (rErr) => { if (rErr) console.error('[save] rename', filePath, rErr.message); done(); });
    });
  });
}

// Safe load: if the primary file is corrupt, fall back to the .bak written on last successful load.
function safeReadJson(filePath, fallback) {
  for (const candidate of [filePath, filePath + '.bak']) {
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        // On first successful parse of the primary, write a backup.
        if (candidate === filePath) {
          try { fs.copyFileSync(filePath, filePath + '.bak'); } catch (_) {}
        }
        return parsed;
      }
    } catch (_) {}
  }
  return fallback;
}

// ── Secret-at-rest encryption (OBS password, start.gg/Challonge/NXGEN keys, Twitch/Discord
// OAuth tokens) — these previously landed in state.json / twitch-data.json / discord-user.json
// as plaintext. safeStorage encrypts with the OS keychain (DPAPI/Keychain/libsecret), so the
// files are unreadable outside this machine+user even if copied. The 'enc:' prefix marks the
// new format; unprefixed strings are legacy plaintext from a pre-migration state.json and are
// read as-is, then re-saved encrypted on the next write. Falls back to plaintext (with a
// warning) only if the OS has no keychain available (e.g. a headless/no-keyring Linux box) —
// better to keep working than to lose saved credentials.
function encryptSecret(plain) {
  if (!plain) return '';
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(String(plain)).toString('base64');
    }
  } catch (e) { console.warn('[secrets] encryption unavailable, storing plaintext:', e.message); }
  return plain;
}
function decryptSecret(stored) {
  if (!stored || typeof stored !== 'string') return '';
  if (!stored.startsWith('enc:')) return stored;   // legacy plaintext, or plaintext fallback above
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
  } catch (e) { console.warn('[secrets] failed to decrypt a stored secret (OS keychain changed?):', e.message); }
  return '';   // can't decrypt without the OS keychain that encrypted it — treat as unset, not garbage
}

// ── WS bridge auth token ─────────────────────────────────────────────────────
// The :3001 bridge accepts a `?token=` query param on every connection (control panel,
// overlay browser sources, anything else). Loopback-only by default, so this mainly
// guards the opt-in WS_HOST=0.0.0.0 (multi-PC) case — without it, anyone who can reach
// the port gets full unauthenticated read+control of the broadcast. Generated once and
// persisted (not part of state.json / Producer Profile exports) so it survives restarts
// but doesn't leak into a shared/exported profile.
function getOrCreateWsToken() {
  try {
    const existing = safeReadJson(wsTokenFile, null);
    if (existing && typeof existing.token === 'string' && existing.token.length >= 32) return existing.token;
  } catch (e) {}
  const token = require('crypto').randomBytes(24).toString('hex');
  try { safeWriteJson(wsTokenFile, { token }, true); } catch (e) { console.error('[bridge] failed to persist WS token:', e.message); }
  return token;
}

function loadTeams() {
  savedTeams = safeReadJson(teamsFile, []);
}

function saveTeams() {
  savedTeamsVer++;
  try { safeWriteJson(teamsFile, savedTeams); } catch (e) { console.error('Error saving teams:', e); }
}

function loadFacecams() {
  savedFacecams = safeReadJson(facecamsFile, []);
}

function saveFacecams() {
  try { safeWriteJson(facecamsFile, savedFacecams); } catch (e) { console.error('Error saving facecams:', e); }
}

function loadPresets() {
  savedPresets = safeReadJson(presetsFile, []);
}

function savePresets() {
  try { safeWriteJson(presetsFile, savedPresets); } catch (e) { console.error('Error saving presets:', e); }
}

function loadBrandKits() {
  savedBrandKits = safeReadJson(brandsFile, []);
  savedBrandKits.forEach(ensureKitPackages);   // wrap legacy top-level sponsor/banner config into a package
}

function saveBrandKits() {
  brandKitsVer++;   // any persisted brand-kit change forces a library re-broadcast (see brandKitsVer)
  try { safeWriteJson(brandsFile, savedBrandKits); } catch (e) { console.error('Error saving brand kits:', e); }
}

// Mirror a match team's roster into the saved-team library so roster edits made in the Match — Teams
// panel actually persist. Matches the library entry by NORMALIZED name (trim + case-insensitive) —
// the panel uppercases the match name (applyTeam), so an exact match against the saved "Team Alpha"
// used to silently fail. CREATES the library entry when missing, so a team typed/imported into the
// match (never saved before) still saves. Field-preserving: keeps saved-only per-player data (country,
// links, etc.) and layers the live edits on top. Skips placeholder/unnamed sides.
function persistRosterToLibrary(side) {
  const t = state.teams[side];
  if (!t) return;
  const name = (t.name || '').trim();
  const low = name.toLowerCase();
  if (!name || low === 'blue' || low === 'orange') return;
  let saved = savedTeams.find((s) => (s.name || '').trim().toLowerCase() === low);
  if (!saved) { saved = { name, logo: t.logo || null, players: [] }; savedTeams.push(saved); }
  const prev = Array.isArray(saved.players) ? saved.players : [];
  saved.players = (t.players || []).map((p) => {
    const old = (p.id && prev.find((o) => o.id === p.id))
             || (p.name && prev.find((o) => (o.name || '').trim().toLowerCase() === (p.name || '').trim().toLowerCase()));
    return old ? { ...old, ...p } : { ...p };
  });
  if (t.logo && !saved.logo) saved.logo = t.logo;
  saveTeams();
}

// ─── Shared zip-bundle asset helpers ────────────────────────────────────────
// Generic, schema-agnostic: any exported bundle (Producer Profile, Game Config, ...) can be
// packaged as a zip without hand-listing which fields are images. Every base64 image data-URI
// found anywhere in the object tree becomes a real file inside the zip; the in-memory/JS shape
// (base64 data URIs) never changes for any existing consumer — the zip is purely a transport format.
const ZIP_ASSET_DATA_URI_RE = /^data:image\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/;
const ZIP_ASSET_PREFIX = 'zipasset:';
const ZIP_ASSET_MIME_EXT = { jpeg: 'jpg', 'svg+xml': 'svg' };

// Deep-clones obj; every base64 image data-URI string found anywhere in the tree is decoded to a
// Buffer, added to the zip at assets/img-<n>.<ext>, and replaced in the clone with a
// 'zipasset:assets/img-<n>.<ext>' sentinel string. Returns the clone (safe to JSON.stringify as
// manifest.json) — never mutates obj or the zip's caller-visible state beyond the added entries.
function extractAssetsToZip(obj, zip) {
  let counter = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = v.match(ZIP_ASSET_DATA_URI_RE);
      if (!m) return v;
      const mime = m[1].toLowerCase();
      const ext = ZIP_ASSET_MIME_EXT[mime] || mime.replace(/[^a-z0-9]/g, '') || 'bin';
      const rel = `assets/img-${++counter}.${ext}`;
      zip.addFile(rel, Buffer.from(m[2], 'base64'));
      return ZIP_ASSET_PREFIX + rel;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(obj);
}

// Inverse of extractAssetsToZip: deep-clones obj (a parsed manifest.json), replaces every
// 'zipasset:...' sentinel with the re-encoded data: URI read from that path in the zip.
function inflateAssetsFromZip(obj, zip) {
  const walk = (v) => {
    if (typeof v === 'string' && v.startsWith(ZIP_ASSET_PREFIX)) {
      const rel = v.slice(ZIP_ASSET_PREFIX.length);
      const entry = zip.getEntry(rel);
      if (!entry) return v;   // missing asset — leave the sentinel rather than fabricate an image
      const ext = (rel.split('.').pop() || '').toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : (ext === 'svg' ? 'svg+xml' : ext) || 'png';
      return `data:image/${mime};base64,${entry.getData().toString('base64')}`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(obj);
}

// ─── Producer profile export / import ──────────────────────────────────────
// A single portable file holding a producer's whole SETUP — teams, brand kits,
// facecams, presets, leagues, caster library, and overlay/look settings — so it
// can be shared with staff before cloud sync exists. Deliberately EXCLUDES secrets
// and machine-specific state: no Twitch/Discord/OBS tokens or passwords, no live
// scores, no local file paths. Sharing a profile never leaks credentials.
function buildProfileBundle() {
  const s = state;
  return {
    format: 'ne-broadcast-profile',
    version: 1,
    app: 'NE Broadcast Suite',
    exportedAt: Date.now(),
    data: {
      teams:          savedTeams,
      brandKits:      savedBrandKits,
      facecams:       savedFacecams,
      presets:        savedPresets,
      leagues:        s.leagues || [],
      castersLibrary: (s.casters && s.casters.library) || [],
      settings: {
        fontFamily:           s.fontFamily,
        themesByGame:         s.themesByGame,
        colorMode:            s.colorMode,
        activeBrandKitId:     s.activeBrandKitId,
        bestOf:               s.bestOf,
        banner:               s.banner,
        ticker:               s.ticker,
        overtime:             s.overtime,
        replay:               s.replay,
        scoreboardAd:         s.scoreboardAd,
        rlStatsScreen:        s.rlStatsScreen,
        deskFooter:           s.deskFooter,
        vdo:                  s.vdo,
        preshow:              s.preshow,   // Desk Show headline/topics + saved topic presets
        customOverlayLayouts: s.customOverlayLayouts
      }
    }
  };
}
// Merge an imported profile into the current data. Libraries MERGE (additive, de-duped);
// settings OVERWRITE (and are opt-out via options.settings === false). Returns a summary.
function applyProfileBundle(bundle, options) {
  if (!bundle || bundle.format !== 'ne-broadcast-profile' || !bundle.data) {
    throw new Error('Not a valid NE Broadcast profile file.');
  }
  const d = bundle.data, opts = options || {};
  const want = (k) => opts[k] !== false;     // default: import everything present
  const parts = [];
  if (want('teams') && Array.isArray(d.teams)) {
    savedTeams = mergeAtTop(savedTeams, d.teams, (a, b) => a.name === b.name);
    saveTeams(); parts.push(`${d.teams.length} teams`);
  }
  if (want('brandKits') && Array.isArray(d.brandKits)) {
    savedBrandKits = mergeAtTop(savedBrandKits, d.brandKits, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    savedBrandKits.forEach(ensureKitPackages);   // migrate any legacy-format imported kits
    saveBrandKits(); parts.push(`${d.brandKits.length} brand kits`);
  }
  if (want('facecams') && Array.isArray(d.facecams)) {
    savedFacecams = mergeAtTop(savedFacecams, d.facecams, (a, b) => a.platform === b.platform && a.platformId === b.platformId);
    saveFacecams(); parts.push(`${d.facecams.length} facecams`);
  }
  if (want('presets') && Array.isArray(d.presets)) {
    savedPresets = mergeAtTop(savedPresets, d.presets, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    savePresets(); parts.push(`${d.presets.length} presets`);
  }
  if (want('leagues') && Array.isArray(d.leagues)) {
    const migrated = d.leagues.map(migrateLeague);
    state.leagues = mergeAtTop(state.leagues || [], migrated, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    leaguesVer++;
    parts.push(`${d.leagues.length} leagues`);
  }
  if (want('castersLibrary') && Array.isArray(d.castersLibrary)) {
    if (!Array.isArray(state.casters.library)) state.casters.library = [];
    state.casters.library = mergeAtTop(state.casters.library, d.castersLibrary, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    parts.push(`${d.castersLibrary.length} casters`);
  }
  if (want('settings') && d.settings && typeof d.settings === 'object') {
    const v = d.settings;
    ['fontFamily', 'colorMode', 'activeBrandKitId', 'bestOf', 'banner', 'ticker', 'overtime', 'replay', 'scoreboardAd', 'rlStatsScreen', 'deskFooter', 'preshow', 'vdo', 'customOverlayLayouts']
      .forEach((k) => { if (v[k] !== undefined) state[k] = v[k]; });
    if (v.themesByGame && typeof v.themesByGame === 'object') state.themesByGame = { ...state.themesByGame, ...v.themesByGame };
    state.useBrandColors = (state.colorMode === 'brand');
    parts.push('look & settings');
  }
  saveAppState();
  return 'Imported ' + (parts.join(', ') || 'nothing');
}

function saveTwitchData(sync = false) {
  if (!state.twitch) return;

  try {
    const data = {
      apiToken:       encryptSecret(state.twitch.apiToken       || ''),
      refreshToken:   encryptSecret(state.twitch.refreshToken   || ''),
      displayName:    state.twitch.displayName    || '',
      channelId:      state.twitch.channelId      || '',
      profilePicture: state.twitch.profilePicture || '',
      webhookSecret:  encryptSecret(state.twitch.webhookSecret),
      predictions:    state.twitch.predictions,
      wheel:          state.twitch.wheel,
      minigame:       state.twitch.minigame,
      chatSettings:   state.twitch.chatSettings,
      automations:    state.twitch.automations,
      adsEnabled:     state.twitch.adsEnabled !== false
    };
    safeWriteJson(twitchDataFile, data, sync);
  } catch (err) {
    console.error('[Twitch] Error saving data:', err.message);
  }
}

async function refreshTwitchToken() {
  if (!state.twitch.refreshToken) throw new Error('No refresh token stored — please reconnect');
  const params = {
    client_id: TWITCH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: state.twitch.refreshToken
  };
  // Client secret is optional for public clients; include it when available
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (secret) params.client_secret = secret;

  const r = await axios.post('https://id.twitch.tv/oauth2/token', null, { params });
  const { access_token, refresh_token } = r.data;
  state.twitch.apiToken = access_token;
  if (refresh_token) state.twitch.refreshToken = refresh_token;
  if (twitchClient) twitchClient.updateToken(access_token);
  // A mid-session 401 flips these off and, before this, ONLY a manual reconnect ever flipped
  // them back — so one stray 401 (wake-from-sleep race, transient revoke check) permanently
  // disabled Twitch features even though this refresh just succeeded. The refresh heals them.
  _twitchTokenInvalid = false;
  state.twitch.connected = true;
  saveTwitchData();
  broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
  console.log('[Twitch] Access token refreshed');
  scheduleTokenRefresh();
  return access_token;
}

// Proactive refresh — fires 30 minutes before expiry so mid-session use is never interrupted
let _tokenRefreshTimer = null;
function scheduleTokenRefresh() {
  if (_tokenRefreshTimer) { clearTimeout(_tokenRefreshTimer); _tokenRefreshTimer = null; }
  if (!state.twitch.refreshToken) return;
  // Validate to learn the current expiry, then schedule a refresh 30 min before it
  axios.get('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': `OAuth ${state.twitch.apiToken}` }
  }).then(r => {
    const expiresIn = r.data.expires_in; // seconds
    if (!expiresIn) return;
    const refreshIn = Math.max((expiresIn - 1800) * 1000, 60000); // 30 min early, min 1 min
    console.log(`[Twitch] Token valid for ${Math.round(expiresIn / 3600)}h — auto-refresh in ${Math.round(refreshIn / 60000)} min`);
    _tokenRefreshTimer = setTimeout(async () => {
      try { await refreshTwitchToken(); } catch (e) { console.error('[Twitch] Scheduled refresh failed:', e.message); }
    }, refreshIn);
  }).catch(() => {
    // Token already expired — try refresh immediately
    if (state.twitch.refreshToken) {
      refreshTwitchToken().catch(e => console.error('[Twitch] Immediate refresh failed:', e.message));
    }
  });
}

function loadTwitchData() {
  try {
    if (fs.existsSync(twitchDataFile)) {
      const data = safeReadJson(twitchDataFile, {});
      // Restore auth credentials so the app reconnects without re-OAuth
      if (data.apiToken)       state.twitch.apiToken       = decryptSecret(data.apiToken);
      if (data.refreshToken)   state.twitch.refreshToken   = decryptSecret(data.refreshToken);
      if (data.displayName)    state.twitch.displayName    = data.displayName;
      if (data.channelId)      state.twitch.channelId      = data.channelId;
      if (data.profilePicture) state.twitch.profilePicture = data.profilePicture;
      if (data.webhookSecret)  state.twitch.webhookSecret  = decryptSecret(data.webhookSecret);
      if (data.predictions) {
        Object.assign(state.twitch.predictions, data.predictions);
        // Don't resume an in-progress prediction across restarts — it can't be
        // voted on and the overlay would show a frozen card indefinitely.
        const cur = state.twitch.predictions.current;
        if (cur) {
          const expired = cur.endsAt && new Date(cur.endsAt) < new Date();
          const done    = cur.state === 'RESOLVED' || cur.state === 'CANCELLED';
          if (expired || done) state.twitch.predictions.current = null;
        }
      }
      if (data.wheel)         Object.assign(state.twitch.wheel,         data.wheel);
      if (data.minigame)      Object.assign(state.twitch.minigame,      data.minigame);
      if (data.chatSettings)  Object.assign(state.twitch.chatSettings,  data.chatSettings);
      if (data.automations)   Object.assign(state.twitch.automations,   data.automations);
      if (typeof data.adsEnabled === 'boolean') state.twitch.adsEnabled = data.adsEnabled;
      console.log('[Twitch] Data loaded', data.displayName ? `(connected as ${data.displayName})` : '');
    }
  } catch (err) {
    console.error('[Twitch] Failed to load data:', err.message);
  }
}

function saveDiscordUser(sync = false) {
  if (!discordDataFile) return;
  try {
    const data = {
      userId:       state.discord.userId       || '',
      username:     state.discord.username     || '',
      discriminator: state.discord.discriminator || '',
      globalName:   state.discord.globalName   || '',
      avatarUrl:    state.discord.avatarUrl    || '',
      accessToken:  encryptSecret(state.discord.accessToken  || ''),
      refreshToken: encryptSecret(state.discord.refreshToken || '')
    };
    safeWriteJson(discordDataFile, data, sync);
  } catch (err) {
    console.error('[Discord] Error saving user:', err.message);
  }
}

// ── Cloud access enforcement — force sign-out for THIS user only when the backend
// definitively refuses them (access revoked / rejected / session invalid). ──────────
function forceCloudSignOut(message) {
  try { cloud.clearSession(); } catch (_) {}
  state.discord.connected     = false;
  state.discord.userId        = '';
  state.discord.username      = '';
  state.discord.discriminator = '';
  state.discord.globalName    = '';
  state.discord.avatarUrl     = '';
  state.discord.accessToken   = '';
  state.discord.refreshToken  = '';
  state.discord.lastError     = message || 'Your Broadcast Studio access was revoked — contact an admin.';
  _pendingContract = null;
  saveDiscordUser();
  try { broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (_) {}
  console.log('[Cloud] Forced sign-out:', state.discord.lastError);
}

// The Nameless backend re-checks the studio access gate on every token refresh:
//   403 → access revoked/rejected/unsigned (the response says exactly why)
//   401 → refresh token invalid or expired
// Anything else (network down, server 5xx, no cloud session at all) is IGNORED —
// an active user must never get signed out because of a wifi blip or an outage.
async function validateCloudSession(trigger) {
  if (!cloud.configured() || !state.discord.connected) return;
  try {
    await cloud.refreshSession();
  } catch (e) {
    if (e && (e.status === 403 || e.status === 401)) {
      const backendMsg = (e.data && e.data.error && e.data.error.message) || e.message || '';
      forceCloudSignOut(
        e.status === 403 ? backendMsg : 'Your session expired — sign in again.'
      );
    } else if (e && /No refresh token/i.test(e.message || '')) {
      // Local-dev Discord login (no cloud session) — nothing to enforce.
    } else {
      console.warn(`[Cloud] Session check (${trigger}) inconclusive — keeping the user signed in:`, (e && e.message) || e);
    }
  }
}

function loadDiscordUser() {
  try {
    if (fs.existsSync(discordDataFile)) {
      const data = safeReadJson(discordDataFile, {});
      if (data.userId)       state.discord.userId       = data.userId;
      if (data.username)     state.discord.username     = data.username;
      if (data.discriminator) state.discord.discriminator = data.discriminator;
      if (data.globalName)   state.discord.globalName   = data.globalName;
      if (data.avatarUrl)    state.discord.avatarUrl    = data.avatarUrl;
      if (data.accessToken)  state.discord.accessToken  = decryptSecret(data.accessToken);
      if (data.refreshToken) state.discord.refreshToken = decryptSecret(data.refreshToken);
      // Backend-mode logins never hold a local Discord accessToken (the Nameless backend
      // keeps it), so a saved user IS a signed-in user. If the cloud session is actually
      // dead/revoked, validateCloudSession('boot') force-signs-out with the real reason.
      if (data.userId) state.discord.connected = true;
      console.log('[Discord] User loaded', data.username ? `(${data.username})` : '');
    }
  } catch (err) {
    console.error('[Discord] Failed to load user:', err.message);
  }
}

// Where a sponsor logo can be displayed. Each brand sponsor carries a `placements`
// map of these flags, set with checkmarks in the brand editor.
const SPONSOR_SPOTS = ['title', 'rail', 'desk', 'overtime', 'replayGoal', 'replayOutro', 'scoreboard', 'banner', 'ticker'];
function sanitizePlacements(p) {
  // No placements (legacy sponsor saved before this feature) → show on rail + caster desk,
  // matching the old "every sponsor shows on the rail/desk" behaviour.
  if (!p || typeof p !== 'object') {
    return { title: false, rail: true, desk: true, overtime: false, replayGoal: false, replayOutro: false, scoreboard: false, banner: false, ticker: false };
  }
  const o = {};
  SPONSOR_SPOTS.forEach((k) => { o[k] = !!p[k]; });
  return o;
}

// ── Brand packages ─────────────────────────────────────────────────────────
// A profile's sellable config (sponsor set + placements + banner) lives in named "packages"
// (e.g. one per sponsorship deal / event type). Package-scoped fields are below; identity
// (name/logo/colours/font/themes) stays on the kit. Legacy kits stored these fields at the top
// level — they're wrapped into a single "Main" package on load so every read path resolves
// through activePackage().
function brandId() { return Math.random().toString(36).slice(2, 11); }
const PACKAGE_FIELDS = ['sponsorLabel', 'sponsorInterval', 'sponsorMode', 'sponsors', 'bannerImages', 'bannerCaptions', 'bannerSlant', 'bannerHeader', 'bannerInterval', 'replaySkin'];

function sanitizePackage(p, fallbackName) {
  p = p || {};
  return {
    id: p.id || brandId(),
    name: (p.name || fallbackName || 'Main').toString().slice(0, 40),
    sponsorLabel: (p.sponsorLabel || 'PARTNERS').toString(),
    sponsorInterval: Number(p.sponsorInterval) > 0 ? Number(p.sponsorInterval) : 6,
    sponsorMode: p.sponsorMode === 'static' ? 'static' : 'cycle',   // rail: cycle one at a time, or show all at once
    sponsors: Array.isArray(p.sponsors) ? p.sponsors.map((s) => ({
      id: s.id || brandId(), name: (s.name || '').toString(), logo: s.logo || null,
      tier: s.tier || 'partner', placements: sanitizePlacements(s.placements),
      // Deal $/ROI: what this sponsor paid, and/or their agreed market rate — both optional,
      // feed the Sponsor Proof of Play $ metrics (realized CPM / value delivered).
      dealValue: (typeof s.dealValue === 'number' && s.dealValue >= 0) ? s.dealValue : null,
      targetCpm: (typeof s.targetCpm === 'number' && s.targetCpm >= 0) ? s.targetCpm : null
    })) : [],
    bannerImages: Array.isArray(p.bannerImages) ? p.bannerImages : [],
    bannerCaptions: Array.isArray(p.bannerCaptions) ? p.bannerCaptions.map((t) => (typeof t === 'string' ? t : '')) : [],
    bannerSlant: ['right', 'left', 'box'].includes(p.bannerSlant) ? p.bannerSlant : 'right',
    bannerHeader: typeof p.bannerHeader === 'string' ? p.bannerHeader.slice(0, 40) : '',
    // Desk Show (preshow.html) headline + discussion topics — package-scoped like sponsors/banner,
    // so switching the active package automatically switches what Desk Show shows.
    topicsHeadline: typeof p.topicsHeadline === 'string' ? p.topicsHeadline.slice(0, 140) : '',
    topics: Array.isArray(p.topics) ? p.topics.filter((t) => t && typeof t === 'object').map((t) => ({
      text: typeof t.text === 'string' ? t.text.slice(0, 60) : '',
      sceneName: typeof t.sceneName === 'string' ? t.sceneName.slice(0, 100) : ''
    })).slice(0, 12) : [],
    bannerInterval: Number(p.bannerInterval) > 0 ? Number(p.bannerInterval) : 10,
    replaySkin: p.replaySkin || null,   // per-profile replay transition background image
    // Captured show setup ("Capture current show setup" in the profile editor): scene presets,
    // ticker, event name, board titles, caster lineup + slot labels, OBS moment mappings.
    // Applied on kit/package activation — only the fields the snapshot actually carries.
    // Deliberately EXCLUDES production-dependent toggles (facecams enabled, replay cams).
    showSnapshot: (p.showSnapshot && typeof p.showSnapshot === 'object') ? p.showSnapshot : null,
  };
}

// Snapshot the CURRENT live show setup into a package (see sanitizePackage.showSnapshot).
function capturePackageSnapshot() {
  return {
    capturedAt: Date.now(),
    scenePresets: JSON.parse(JSON.stringify(state.scenePresets || {})),
    ticker: {
      messages: (state.ticker.messages || []).slice(0, 50),
      speed: state.ticker.speed, source: state.ticker.source, sponsor: state.ticker.sponsor || ''
    },
    eventName: state.eventName || '',
    standingsTitle: (state.standings && state.standings.title) || '',
    standingsSubtitle: (state.standings && state.standings.subtitle) || '',
    upcomingTitle: (state.upcoming && state.upcoming.title) || '',
    lowerThird: (state.casters && state.casters.lowerThird) || '',
    lineup: JSON.parse(JSON.stringify((state.casters && state.casters.lineup) || [])),
    slotLabels: { ...((state.casters && state.casters.slotLabels) || {}) },
    obsScenes: { ...((state.obs && state.obs.scenes) || {}) }
  };
}

// Activate a profile (brand kit) — the ONE path for every activation side effect: topics,
// show snapshot, theme snap, ad slots, OBS collection/profile switch. Used by the
// activate_brand_kit WS case and by save_brand_kit's "Save & Activate".
function activateBrandKitById(id) {
  state.activeBrandKitId = id || null;
  const kit = savedBrandKits.find((b) => b.id === id);
  if (kit) ensureKitPackages(kit);
  syncActivePreshowTopics();   // Desk Show headline/topics follow the newly-active kit's active package
  if (kit) applyPackageSnapshot(activePackage(kit));   // captured show setup travels with the package
  // Automation: snap this game's theme to the kit's preferred design, if set.
  if (kit && kit.themes && isValidTheme(state.activeGame, kit.themes[state.activeGame])) {
    state.themesByGame[state.activeGame] = kit.themes[state.activeGame];
  }
  applyBrandSlots();           // fill the ad slots from this brand's sponsor placements
  saveAppState();
  broadcastFullState();        // brand colours apply automatically when colorMode === 'brand'
  // OBS auto-switch: if the kit has a preferred scene collection or profile, load it now.
  if (kit && kit.obsSceneCollection && obsClient && obsClient.isConnected()) {
    obsClient.call('SetCurrentSceneCollection', { sceneCollectionName: kit.obsSceneCollection }).catch(() => {});
  }
  if (kit && kit.obsProfile && obsClient && obsClient.isConnected()) {
    obsClient.call('SetCurrentProfile', { profileName: kit.obsProfile }).catch(() => {});
  }
}

// Apply a package's captured show setup. Only fields the snapshot carries are touched, so a
// package captured before a feature existed can't blank newer state.
function applyPackageSnapshot(pkg) {
  const s = pkg && pkg.showSnapshot;
  if (!s || typeof s !== 'object') return false;
  if (s.scenePresets && typeof s.scenePresets === 'object') state.scenePresets = JSON.parse(JSON.stringify(s.scenePresets));
  if (s.ticker && typeof s.ticker === 'object') {
    if (Array.isArray(s.ticker.messages)) state.ticker.messages = s.ticker.messages.slice(0, 50);
    if (Number(s.ticker.speed) > 0) state.ticker.speed = Number(s.ticker.speed);
    if (s.ticker.source === 'startgg' || s.ticker.source === 'manual') state.ticker.source = s.ticker.source;
    if (typeof s.ticker.sponsor === 'string') state.ticker.sponsor = s.ticker.sponsor;
  }
  if (s.eventName) state.eventName = String(s.eventName);
  if (s.standingsTitle) state.standings.title = String(s.standingsTitle);
  if (s.standingsSubtitle) state.standings.subtitle = String(s.standingsSubtitle);
  if (s.upcomingTitle) state.upcoming.title = String(s.upcomingTitle);
  if (typeof s.lowerThird === 'string' && s.lowerThird) state.casters.lowerThird = s.lowerThird;
  if (Array.isArray(s.lineup) && s.lineup.length) {
    state.casters.lineup = JSON.parse(JSON.stringify(s.lineup));
    resolveLineupToList();
  }
  if (s.slotLabels && typeof s.slotLabels === 'object' && Object.keys(s.slotLabels).length) {
    state.casters.slotLabels = { ...state.casters.slotLabels, ...s.slotLabels };
  }
  if (s.obsScenes && typeof s.obsScenes === 'object' && Object.values(s.obsScenes).some(Boolean)) {
    state.obs.scenes = { ...state.obs.scenes, ...s.obsScenes };
  }
  return true;
}

// Migrate a kit in place: guarantee a packages[] array + a valid activePackageId.
function ensureKitPackages(kit) {
  if (!kit) return kit;
  if (!Array.isArray(kit.packages) || !kit.packages.length) {
    kit.packages = [sanitizePackage({
      id: kit.activePackageId, name: 'Main',
      sponsorLabel: kit.sponsorLabel, sponsorInterval: kit.sponsorInterval, sponsors: kit.sponsors,
      bannerImages: kit.bannerImages, bannerCaptions: kit.bannerCaptions, bannerSlant: kit.bannerSlant,
      bannerHeader: kit.bannerHeader, bannerInterval: kit.bannerInterval,
    })];
    kit.activePackageId = kit.packages[0].id;
    PACKAGE_FIELDS.forEach((f) => delete kit[f]);   // drop the legacy top-level duplicates
  }
  if (!kit.activePackageId || !kit.packages.some((p) => p.id === kit.activePackageId)) {
    kit.activePackageId = kit.packages[0].id;
  }
  return kit;
}

// The package currently selected for broadcast on a kit (falls back to legacy top-level fields).
function activePackage(kit) {
  if (!kit) return null;
  const pkgs = Array.isArray(kit.packages) ? kit.packages : [];
  if (pkgs.length) return pkgs.find((p) => p.id === kit.activePackageId) || pkgs[0];
  return sanitizePackage({   // legacy kit with no packages yet
    sponsorLabel: kit.sponsorLabel, sponsorInterval: kit.sponsorInterval, sponsors: kit.sponsors,
    bannerImages: kit.bannerImages, bannerCaptions: kit.bannerCaptions, bannerSlant: kit.bannerSlant,
    bannerHeader: kit.bannerHeader, bannerInterval: kit.bannerInterval,
  });
}

// The active client brand kit, resolved for overlays (or null → overlays fall back to event branding).
// Identity comes from the kit; sponsors/banner come from the kit's active package.
function activeBrand() {
  const kit = savedBrandKits.find((b) => b.id === state.activeBrandKitId);
  if (!kit) return null;
  const pkg = activePackage(kit);
  const sponsors = (Array.isArray(pkg.sponsors) ? pkg.sponsors : []).map((s) => ({
    id: s.id, name: s.name || '', logo: s.logo || null, tier: s.tier || 'partner',
    placements: sanitizePlacements(s.placements),
    dealValue: (typeof s.dealValue === 'number') ? s.dealValue : null,
    targetCpm: (typeof s.targetCpm === 'number') ? s.targetCpm : null
  }));
  const tagged = (key) => sponsors.filter((s) => s.logo && s.placements[key]);
  return {
    id: kit.id,
    name: kit.name || '',
    logo: kit.logo || null,
    color: kit.color || null,
    accent: kit.accent || null,
    font: kit.font || null,
    sponsorLabel: pkg.sponsorLabel || 'PARTNERS',
    sponsorInterval: Number(pkg.sponsorInterval) > 0 ? Number(pkg.sponsorInterval) : 6,
    sponsorMode: pkg.sponsorMode === 'static' ? 'static' : 'cycle',
    bannerImages: Array.isArray(pkg.bannerImages) ? pkg.bannerImages : [],
    bannerInterval: Number(pkg.bannerInterval) > 0 ? Number(pkg.bannerInterval) : 10,
    replaySkin: pkg.replaySkin || null,        // per-profile replay transition background
    sponsors,                                  // all (for the editor + back-compat consumers)
    railSponsors: tagged('rail'),              // rotating corner bug
    deskSponsors: tagged('desk'),              // caster-desk footer logos
    bannerSponsors: tagged('banner'),          // sponsor-banner rotation
    spots: {                                   // single-logo ad slots → first tagged sponsor's logo
      title: (tagged('title')[0] || {}).logo || null,   // prominent always-on title-sponsor bug
      overtime: (tagged('overtime')[0] || {}).logo || null,
      replayGoal: (tagged('replayGoal')[0] || {}).logo || null,
      replayOutro: (tagged('replayOutro')[0] || {}).logo || null,
      scoreboard: (tagged('scoreboard')[0] || {}).logo || null,
      ticker: (tagged('ticker')[0] || {}).logo || null
    },
    // Package metadata for the editor + Dashboard quick-switch (names only — no base64).
    packages: (Array.isArray(kit.packages) ? kit.packages : []).map((p) => ({ id: p.id, name: p.name })),
    activePackageId: kit.activePackageId || null,
    // Social card preset (bg image + feature toggles) — stored per brand kit
    socialPreset: kit.socialPreset || { bgImageUrl: '', bgStyle: 'auto', presentedByEnabled: true },
  };
}

// Mirror the active brand package's Desk Show headline/topics into state.preshow — the fields
// the control panel + overlay/preshow.html actually read/edit live. Content is persisted on the
// PACKAGE (sanitizePackage, above); this just keeps the live mirror in sync whenever the active
// kit/package changes, the same "persist on the real record, mirror to the top-level fields the
// UI reads" pattern used for bracket phases/pools.
function syncActivePreshowTopics() {
  const kit = savedBrandKits.find((b) => b.id === state.activeBrandKitId);
  const pkg = kit ? activePackage(kit) : null;
  state.preshow.headline = (pkg && pkg.topicsHeadline) || '';
  state.preshow.topics = (pkg && Array.isArray(pkg.topics)) ? pkg.topics : [];
  state.preshow.activeTopicIndex = 0;   // the old index may be out of range for the new topic list
}

// ── Sponsor proof-of-play (impression tracking) ──────────────────────────────
// While a session is active, sample once a second and credit every on-air sponsor logo by
// placement, producing a defensible "estimated on-screen seconds per sponsor" report — a
// sellable proof-of-play deliverable. Exposure is inferred from the overlay STATE the server
// already knows (which placements are visible), so it's an estimate, labelled as such.
const adProof = {
  active: false, startedAt: 0, label: '', ticks: 0,
  sponsors: {}   // id -> { id, name, seconds, byPlacement:{spot:sec}, impressions, _onPrev }
};
let _adProofTimer = null;

// Current combined concurrent viewers (Twitch + YouTube when available) — used for sponsor
// viewer-seconds and the recorder's viewer samples.
function currentViewers() {
  let v = 0;
  try { if (typeof streamStateManager !== 'undefined' && streamStateManager && streamStateManager.streamState.isLive) v += streamStateManager.streamState.viewerCount || 0; } catch (e) {}
  try { if (state.youtube && (state.youtube.live || state.youtube.isLive)) v += state.youtube.viewers || state.youtube.concurrentViewers || 0; } catch (e) {}
  return v;
}

// ── OBS stream-health poll: dropped frames / bitrate / fps / cpu / congestion (~5s) ──
let _obsHealthPrev = { bytes: 0, at: 0 };
async function pollObsHealth() {
  if (!obsClient || !obsClient.isConnected()) { if (state.obs) state.obs.health = null; _obsHealthPrev = { bytes: 0, at: 0 }; return; }
  try {
    const stats = await obsClient.call('GetStats');
    if (!stats) return;
    let ss = null; try { ss = await obsClient.call('GetStreamStatus'); } catch (e) {}
    const outTot = (ss && ss.outputTotalFrames) || 0, outSkip = (ss && ss.outputSkippedFrames) || 0;
    const rndTot = stats.renderTotalFrames || 0, rndSkip = stats.renderSkippedFrames || 0;
    let bitrateKbps = 0;
    if (ss && ss.outputActive) {
      const nowMs = Date.now(), bytes = ss.outputBytes || 0;
      if (_obsHealthPrev.at && bytes >= _obsHealthPrev.bytes) { const dt = (nowMs - _obsHealthPrev.at) / 1000; if (dt > 0) bitrateKbps = Math.round(((bytes - _obsHealthPrev.bytes) * 8) / dt / 1000); }
      _obsHealthPrev = { bytes, at: nowMs };
    } else { _obsHealthPrev = { bytes: 0, at: 0 }; }
    const health = {
      cpu: +(stats.cpuUsage || 0).toFixed(1), fps: Math.round(stats.activeFps || 0),
      renderLagMs: +(stats.averageFrameRenderTime || 0).toFixed(2),
      renderDropPct: rndTot ? +((rndSkip / rndTot) * 100).toFixed(2) : 0,
      outputDropPct: outTot ? +((outSkip / outTot) * 100).toFixed(2) : 0,
      congestion: ss ? +(ss.outputCongestion || 0).toFixed(2) : 0,
      bitrateKbps, streaming: !!(ss && ss.outputActive), reconnecting: !!(ss && ss.outputReconnecting), at: Date.now()
    };
    if (state.obs) state.obs.health = health;
    try { analytics.recordHealth(health); } catch (e) {}
  } catch (e) {}
}
setInterval(pollObsHealth, 5000);

// Which sponsor logos are on-air this second, given the live state. Returns [{ sponsor, placement }].
function adProofOnAir(brand, elapsed) {
  const out = [];
  const live = !(state.breakScreen && state.breakScreen.visible);   // the main overlay is composited
  // Rail bug: 'static' shows ALL sponsors at once; 'cycle' rotates through them one at a time.
  const rail = brand.railSponsors || [];
  if (live && rail.length) {
    if (brand.sponsorMode === 'static') {
      rail.forEach((s) => out.push({ sponsor: s, placement: 'rail' }));
    } else {
      const interval = Number(brand.sponsorInterval) > 0 ? Number(brand.sponsorInterval) : 6;
      const idx = Math.floor((elapsed - 1) / interval) % rail.length;
      if (rail[idx]) out.push({ sponsor: rail[idx], placement: 'rail' });
    }
  }
  // Desk + banner show every tagged sponsor at once while their surface is up.
  if (state.casters && state.casters.visible) (brand.deskSponsors || []).forEach((s) => out.push({ sponsor: s, placement: 'desk' }));
  if (state.banner && state.banner.visible) (brand.bannerSponsors || []).forEach((s) => out.push({ sponsor: s, placement: 'banner' }));
  // Single-logo ad slots — on-air when their moment/scene is live.
  const cond = {
    overtime:   !!(state.game && state.game.isOT),
    scoreboard: state.view === 'scoreboard',
    replayGoal: state.view === 'goal',
    ticker:     live   // the ticker bar persists on the live overlay
  };
  ['overtime', 'scoreboard', 'replayGoal', 'ticker'].forEach((spot) => {
    if (!cond[spot]) return;
    const sp = (brand.sponsors || []).find((s) => s.logo && s.placements && s.placements[spot]);
    if (sp) out.push({ sponsor: sp, placement: spot });
  });
  return out;
}

function adProofTick() {
  if (!adProof.active) return;
  const brand = activeBrand();
  adProof.ticks++;
  const v = currentViewers();
  const onAir = brand ? adProofOnAir(brand, adProof.ticks) : [];
  const creditedNow = new Set();
  onAir.forEach(({ sponsor, placement }) => {
    if (!sponsor || !sponsor.id) return;
    const rec = adProof.sponsors[sponsor.id] ||
      (adProof.sponsors[sponsor.id] = { id: sponsor.id, name: sponsor.name || '', seconds: 0, byPlacement: {}, impressions: 0, viewerSeconds: 0, peakViewers: 0, dealValue: null, targetCpm: null, _onPrev: false });
    if (sponsor.name) rec.name = sponsor.name;
    // Refresh $ terms every tick (like name) so a mid-broadcast edit to the sponsor's deal
    // value/target CPM in the brand kit editor is reflected in this session's numbers.
    rec.dealValue = sponsor.dealValue;
    rec.targetCpm = sponsor.targetCpm;
    rec.byPlacement[placement] = (rec.byPlacement[placement] || 0) + 1;   // placement-seconds
    if (!creditedNow.has(sponsor.id)) { rec.seconds++; rec.viewerSeconds += v; if (v > rec.peakViewers) rec.peakViewers = v; creditedNow.add(sponsor.id); }   // on-air seconds + viewer-seconds (de-duped)
  });
  // impressions = number of distinct on-air appearances (off→on transitions)
  Object.values(adProof.sponsors).forEach((rec) => {
    const nowOn = creditedNow.has(rec.id);
    if (nowOn && !rec._onPrev) rec.impressions++;
    rec._onPrev = nowOn;
  });
  if (adProof.ticks % 2 === 0) broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
}

// $/ROI metrics derived from viewer-seconds (treated as impression-seconds, matching this
// report's existing "viewer-seconds = estimated impressions" convention):
//   realizedCpm    — what the sponsor effectively paid per 1000 impression-seconds (needs dealValue)
//   valueDelivered — $ value of the exposure delivered at the sponsor's agreed/market rate (needs targetCpm)
//   deliveryPct    — valueDelivered vs. what they paid (needs both)
function adProofValueMetrics(r) {
  const units = (r.viewerSeconds || 0) / 1000;   // thousands of impression-seconds
  const dealValue = typeof r.dealValue === 'number' ? r.dealValue : null;
  const targetCpm = typeof r.targetCpm === 'number' ? r.targetCpm : null;
  const realizedCpm = (dealValue != null && units > 0) ? +(dealValue / units).toFixed(2) : null;
  const valueDelivered = (targetCpm != null) ? +(units * targetCpm).toFixed(2) : null;
  const deliveryPct = (dealValue != null && dealValue > 0 && valueDelivered != null) ? Math.round((valueDelivered / dealValue) * 100) : null;
  return { dealValue, targetCpm, realizedCpm, valueDelivered, deliveryPct };
}

function adProofReport() {
  const sponsors = Object.values(adProof.sponsors).map((r) => ({
    id: r.id, name: r.name, seconds: r.seconds, impressions: r.impressions, byPlacement: { ...r.byPlacement },
    viewerSeconds: r.viewerSeconds || 0, peakViewers: r.peakViewers || 0, avgViewers: r.seconds ? Math.round((r.viewerSeconds || 0) / r.seconds) : 0,
    ...adProofValueMetrics(r)
  })).sort((a, b) => b.seconds - a.seconds);
  const totalDealValue = sponsors.reduce((sum, s) => sum + (s.dealValue || 0), 0);
  const totalValueDelivered = sponsors.reduce((sum, s) => sum + (s.valueDelivered || 0), 0);
  return {
    active: adProof.active, startedAt: adProof.startedAt, label: adProof.label,
    durationSec: adProof.ticks, sponsors,
    totalDealValue: totalDealValue || null, totalValueDelivered: totalValueDelivered || null,
    sessions: (state.adProofSessions || []).map((s) => ({
      id: s.id, label: s.label, startedAt: s.startedAt, endedAt: s.endedAt,
      durationSec: s.durationSec, sponsorCount: (s.sponsors || []).length,
      totalDealValue: (s.sponsors || []).reduce((sum, x) => sum + (x.dealValue || 0), 0) || null,
      totalValueDelivered: (s.sponsors || []).reduce((sum, x) => sum + (x.valueDelivered || 0), 0) || null
    }))
  };
}

function adProofStart(label) {
  adProof.active = true;
  adProof.startedAt = Date.now();
  adProof.label = ((label || '').toString().slice(0, 80)) || (state.eventName || 'Broadcast');
  adProof.ticks = 0;
  adProof.sponsors = {};
  if (_adProofTimer) clearInterval(_adProofTimer);
  _adProofTimer = setInterval(adProofTick, 1000);
  broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
}

function adProofStop() {
  if (!adProof.active) return null;
  adProof.active = false;
  if (_adProofTimer) { clearInterval(_adProofTimer); _adProofTimer = null; }
  const session = {
    id: Math.random().toString(36).slice(2, 11),
    label: adProof.label, startedAt: adProof.startedAt, endedAt: Date.now(), durationSec: adProof.ticks,
    sponsors: Object.values(adProof.sponsors).map((r) => ({
      name: r.name, seconds: r.seconds, impressions: r.impressions, byPlacement: { ...r.byPlacement },
      viewerSeconds: r.viewerSeconds || 0, peakViewers: r.peakViewers || 0, avgViewers: r.seconds ? Math.round((r.viewerSeconds || 0) / r.seconds) : 0,
      ...adProofValueMetrics(r)
    })).sort((a, b) => b.seconds - a.seconds)
  };
  if (!Array.isArray(state.adProofSessions)) state.adProofSessions = [];
  state.adProofSessions.unshift(session);
  if (state.adProofSessions.length > 50) state.adProofSessions.length = 50;   // cap history
  saveAppState();
  broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
  return session;
}

// Build a CSV report for one session (or the live tracker).
function adProofCsv(sess) {
  const spots = SPONSOR_SPOTS;
  const mmss = (s) => { const m = Math.floor(s / 60), x = s % 60; return m + ':' + String(x).padStart(2, '0'); };
  const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['Sponsor', 'Total seconds', 'Total (mm:ss)', 'Impressions', 'Deal value ($)', 'Target CPM ($)', 'Realized CPM ($)', 'Value delivered ($)', 'Delivery %', ...spots.map((s) => s + ' sec')];
  const lines = [head.join(',')];
  (sess.sponsors || []).forEach((s) => {
    const m = adProofValueMetrics(s);
    lines.push([cell(s.name), s.seconds, mmss(s.seconds), s.impressions,
      m.dealValue ?? '', m.targetCpm ?? '', m.realizedCpm ?? '', m.valueDelivered ?? '', m.deliveryPct ?? '',
      ...spots.map((sp) => (s.byPlacement && s.byPlacement[sp]) || 0)].join(','));
  });
  return lines.join('\r\n');
}

// Push the active brand's single-logo spot assignments into the live ad-slot state so the
// existing overlays (which read state.overtime.logo / state.replay.* / state.scoreboardAd.logo)
// reflect brand placements with no overlay changes. Only writes when a sponsor is tagged, so a
// manual Dashboard upload is preserved when no sponsor claims that spot.
function applyBrandSlots() {
  const b = activeBrand();
  if (!b) return;
  // Ownership check must span EVERY kit's sponsors (all packages), not just the active kit's —
  // otherwise a slot filled by the PREVIOUS kit's sponsor (e.g. trophi.ai on the scoreboard)
  // looks like a manual upload after switching kits and sticks forever. Mirrors the
  // all-kits replaySkin ownership set below.
  const sponsorLogos = new Set(savedBrandKits.flatMap((k) =>
    (k.packages || []).flatMap((p) => (p.sponsors || []).map((s) => s && s.logo))
      .concat((k.sponsors || []).map((s) => s && s.logo))
  ).filter(Boolean));
  // tagged → use it; no tag but the slot currently holds ANY brand sponsor → clear (the tick
  // was removed / the kit changed); otherwise keep (a manual Dashboard upload, not brand-owned).
  const resolve = (cur, tagged) => (tagged != null ? tagged : (sponsorLogos.has(cur) ? null : cur));
  state.overtime.logo = resolve(state.overtime.logo, b.spots.overtime);
  state.replay.logo = resolve(state.replay.logo, b.spots.replayGoal);
  state.replay.outroLogo = resolve(state.replay.outroLogo, b.spots.replayOutro);
  state.scoreboardAd.logo = resolve(state.scoreboardAd.logo, b.spots.scoreboard);
  // Replay transition BACKGROUND (skin): the active profile's image wins; a manual (non-brand) upload
  // is kept when the active profile has none, and a previous profile's skin is cleared when you switch.
  const allBrandSkins = new Set(savedBrandKits.flatMap((k) => (k.packages || []).map((p) => p.replaySkin).filter(Boolean)));
  state.replay.skin = (b.replaySkin != null) ? b.replaySkin : (allBrandSkins.has(state.replay.skin) ? null : state.replay.skin);
}

// Banner images for broadcast.
// When a brand kit is active: uses the kit's own banner images + sponsors tagged "banner".
// When no kit is active: falls back to the global main banner (state.banner).
function bannerForBroadcast() {
  const b = activeBrand();
  if (b) {
    const sponsorImages = b.bannerSponsors.map((s) => s.logo).filter(Boolean);
    const kitImages = b.bannerImages || [];
    return {
      visible: state.banner.visible,
      interval: b.bannerInterval,
      images: kitImages.concat(sponsorImages),
      ownImages: kitImages,
      sponsorCount: sponsorImages.length,
      kitId: b.id
    };
  }
  const own = state.banner.images || [];
  return { ...state.banner, images: own, ownImages: own, sponsorCount: 0, kitId: null };
}

// Per-game default side colours (used when colorMode === 'default'). Mirrors the client map.
const GAME_DEFAULT_COLORS = {
  'rocket-league': { a: '#055fdb', b: '#e97139' },
  'csgo':          { a: '#5b8def', b: '#d6a44a' },   // CT blue / T tan
  'valorant':      { a: '#ff4655', b: '#23c08a' },   // Attackers / Defenders
  'league':        { a: '#2a7fff', b: '#e0383e' },   // Blue / Red
  'dota2':         { a: '#5aae4a', b: '#d34c3e' },   // Radiant / Dire
  'overwatch':     { a: '#055fdb', b: '#e0383e' },   // Defenders blue / Attackers red
  'rainbow6':      { a: '#2e7dd1', b: '#e08a2a' },
  'cod':           { a: '#055fdb', b: '#e97139' },
  'marvel-rivals': { a: '#055fdb', b: '#e97139' },
  'mobile-legends':{ a: '#2a7fff', b: '#e0383e' },
  'honor-of-kings':{ a: '#2a7fff', b: '#e0383e' }
};
const gameDefaultColors = (id) => GAME_DEFAULT_COLORS[id] || { a: '#055fdb', b: '#e97139' };
// Every colour that's a per-game default → lets us tell an un-customised placeholder team
// (still on a default colour) apart from a saved team carrying its own brand colour.
const DEFAULT_SIDE_COLOR_SET = new Set(
  Object.values(GAME_DEFAULT_COLORS).flatMap((c) => [c.a.toLowerCase(), c.b.toLowerCase()])
);

// The colours overlays should actually render for each side, per the active colour mode.
// NON-DESTRUCTIVE: never mutates state.teams — the team's own colour is preserved so the
// 'team' mode (and the saved team library) always keep their real values.
function effectiveTeamColors() {
  const mode = state.colorMode || 'team';
  if (mode === 'brand') {
    const b = activeBrand();
    return { blue: (b && b.color) || state.teams.blue.color, orange: (b && b.accent) || state.teams.orange.color };
  }
  if (mode === 'default') {
    const c = gameDefaultColors(state.activeGame);
    return { blue: c.a, orange: c.b };
  }
  if (mode === 'game') {
    // In-game (RL private-match paint) colours reported live by the Stats API — fall back to the
    // team's own colour for a side the feed hasn't sent a colour for yet.
    const g = state.gameTeams || {};
    return { blue: g.blueColor || state.teams.blue.color, orange: g.orangeColor || state.teams.orange.color };
  }
  return { blue: state.teams.blue.color, orange: state.teams.orange.color };
}

// Snapshot of the event-level broadcast configuration (not live match scores).
function capturePreset() {
  return {
    activeGame: state.activeGame,
    theme: state.themesByGame[state.activeGame] || 'default',
    eventName: state.eventName,
    gameLabel: state.gameLabel,
    roundLabel: state.roundLabel,
    teamRecord: state.teamRecord,
    startggLeagueStandings: state.startggLeagueStandings,
    speedUnit: state.speedUnit,
    fontFamily: state.fontFamily,
    bestOf: state.bestOf,
    facecamsEnabled: state.facecamsEnabled,
    banner: state.banner,
    ticker: state.ticker,
    casters: state.casters
  };
}

function applyPreset(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  if (cfg.activeGame && GAMES[cfg.activeGame]) state.activeGame = cfg.activeGame;
  if (cfg.theme && isValidTheme(state.activeGame, cfg.theme)) {
    state.themesByGame[state.activeGame] = cfg.theme;
  }
  if (typeof cfg.eventName === 'string') state.eventName = cfg.eventName;
  if (typeof cfg.gameLabel === 'string') state.gameLabel = cfg.gameLabel;
  if (typeof cfg.roundLabel === 'string') state.roundLabel = cfg.roundLabel;
  if (cfg.speedUnit === 'mph' || cfg.speedUnit === 'kmh') state.speedUnit = cfg.speedUnit;
  if (cfg.teamRecord && typeof cfg.teamRecord === 'object') state.teamRecord = { ...state.teamRecord, ...cfg.teamRecord };
  if (cfg.startggLeagueStandings && typeof cfg.startggLeagueStandings === 'object') state.startggLeagueStandings = { ...state.startggLeagueStandings, ...cfg.startggLeagueStandings };
  if (typeof cfg.fontFamily === 'string') state.fontFamily = cfg.fontFamily;
  if (cfg.bestOf) state.bestOf = cfg.bestOf;
  if (typeof cfg.facecamsEnabled === 'boolean') state.facecamsEnabled = cfg.facecamsEnabled;
  if (cfg.banner && typeof cfg.banner === 'object') state.banner = cfg.banner;
  if (cfg.ticker && typeof cfg.ticker === 'object') state.ticker = cfg.ticker;
  if (cfg.casters && typeof cfg.casters === 'object') state.casters = cfg.casters;
}

// Show Deck support / tournament-ops roles. Kept in sync with control-panel TD_SUPPORT_LABEL +
// the #td-support-role-sel options — used only to migrate the legacy group-based support column
// into the event-scoped state.casters.support list.
const TD_SUPPORT_LABELS = { producer: 'Producer', admin: 'Tournament Admin', coordinator: 'Coordinator', replay: 'Replay Op', stats: 'Statistician', moderator: 'Moderator', graphics: 'Graphics', flex: 'Flex', socials: 'Social' };
const TD_SUPPORT_GROUPS = Object.keys(TD_SUPPORT_LABELS);

function loadState() {
  try {
    const saved = safeReadJson(stateFile, null);
    if (saved) {
      if (saved.activeGame && GAMES[saved.activeGame]) state.activeGame = saved.activeGame;
      if (saved.themesByGame && typeof saved.themesByGame === 'object') {
        Object.keys(GAMES).forEach((g) => {
          if (saved.themesByGame[g] != null) {
            state.themesByGame[g] = migrateThemeId(g, saved.themesByGame[g]);
          }
        });
      }
      if (typeof saved.activeBrandKitId === 'string') state.activeBrandKitId = saved.activeBrandKitId;
      if (typeof saved.useBrandColors === 'boolean') state.useBrandColors = saved.useBrandColors;
      // Colour mode: prefer the explicit field; migrate from the old useBrandColors flag otherwise.
      if (saved.colorMode === 'team' || saved.colorMode === 'brand' || saved.colorMode === 'default' || saved.colorMode === 'game') {
        state.colorMode = saved.colorMode;
      } else if (typeof saved.useBrandColors === 'boolean') {
        state.colorMode = saved.useBrandColors ? 'brand' : 'team';
      }
      state.useBrandColors = (state.colorMode === 'brand');
      // Use the saved value whenever it's a string (including '' — a deliberately cleared
      // title must NOT snap back to the factory default on reload).
      if (typeof saved.eventName === 'string') state.eventName = saved.eventName;
      if (typeof saved.gameLabel === 'string') state.gameLabel = saved.gameLabel;
      if (typeof saved.roundLabel === 'string') state.roundLabel = saved.roundLabel;
      if (saved.speedUnit === 'mph' || saved.speedUnit === 'kmh') state.speedUnit = saved.speedUnit;
      if (saved.dateFormat === 'us' || saved.dateFormat === 'intl') state.dateFormat = saved.dateFormat;
      if (saved.teamRecord && typeof saved.teamRecord === 'object') state.teamRecord = { ...state.teamRecord, ...saved.teamRecord };
      // (Legacy manual-record migration runs AFTER state.teams is restored below — see migrateTeamRecordManual.)
      if (typeof saved.autoTeamsFromGame === 'boolean') state.autoTeamsFromGame = saved.autoTeamsFromGame;
      if (saved.startggLeagueStandings && typeof saved.startggLeagueStandings === 'object') {
        state.startggLeagueStandings = { ...state.startggLeagueStandings, ...saved.startggLeagueStandings };
      } else if (saved.leagueStandings && typeof saved.leagueStandings === 'object') {
        // Migration shim: older state.json files still use the pre-rename key.
        state.startggLeagueStandings = { ...state.startggLeagueStandings, ...saved.leagueStandings };
      }
      if (saved.fontFamily) state.fontFamily = saved.fontFamily;
      // One-time migration: if saved font is still the old generic default, promote to brand font.
      if (state.fontFamily === 'Bourgeois') state.fontFamily = 'Industry';
      if (typeof saved.clock24h === 'boolean') state.clock24h = saved.clock24h;
      if (typeof saved.showSeries === 'boolean') state.showSeries = saved.showSeries;
      if (typeof saved.defaultBestOf === 'number') state.defaultBestOf = saved.defaultBestOf;
      if (saved.facecamsEnabled !== undefined) state.facecamsEnabled = saved.facecamsEnabled;
      if (saved.replayCams !== undefined) state.replayCams = saved.replayCams;
      if (saved.sceneBg && typeof saved.sceneBg === 'object') state.sceneBg = { ...saved.sceneBg };
      if (saved.scenePresets && typeof saved.scenePresets === 'object') {
        state.scenePresets = saved.scenePresets;
        // A '__preview__' preset is an unsaved live-preview scratchpad — if the app closed while
        // one was active it would silently override brand colours on air forever. Reset to Default.
        Object.values(state.scenePresets).forEach((sp) => {
          if (sp && sp.active === '__preview__') sp.active = 'Default';
        });
      }
      if (saved.brand && typeof saved.brand === 'object') state.brand = saved.brand;
      if (Array.isArray(saved.preshowPresets)) state.preshowPresets = saved.preshowPresets;
      if (saved.banner) state.banner = saved.banner;
      if (saved.credits && Array.isArray(saved.credits.sponsors)) state.credits = { sponsors: saved.credits.sponsors, talent: Array.isArray(saved.credits.talent) ? saved.credits.talent : [] };
      if (saved.casters && typeof saved.casters === 'object') {
        state.casters = {
          visible: !!saved.casters.visible,
          showCountry: !!saved.casters.showCountry,
          nameMode: saved.casters.nameMode === 'name' ? 'name' : 'gamertag',   // desks default to the gamertag/handle
          showRoles: (saved.casters.showRoles && typeof saved.casters.showRoles === 'object')
            ? { host: saved.casters.showRoles.host || '', observer: saved.casters.showRoles.observer || '' }
            : { host: '', observer: '' },
          shifts: Array.isArray(saved.casters.shifts) ? saved.casters.shifts : [],
          activeShiftId: typeof saved.casters.activeShiftId === 'string' ? saved.casters.activeShiftId : '',
          // Show Deck support crew — EVENT-scoped [{crewId, role}] so deck add/remove never
          // rewrites the crew record's durable group. Non-array → migrated from crew groups below.
          support: Array.isArray(saved.casters.support) ? saved.casters.support : null,
          lowerThird: typeof saved.casters.lowerThird === 'string' ? saved.casters.lowerThird : '',
          list: Array.isArray(saved.casters.list) ? saved.casters.list : [],
          library: Array.isArray(saved.casters.library) ? saved.casters.library : [],
          vdo: (saved.casters.vdo && saved.casters.vdo.room) ? saved.casters.vdo : { room: '', password: '' },
          guestsVdo: (saved.casters.guestsVdo && saved.casters.guestsVdo.room) ? saved.casters.guestsVdo : { room: '', password: '' },
          observersVdo: (saved.casters.observersVdo && saved.casters.observersVdo.room) ? saved.casters.observersVdo : { room: '', password: '' },
          rooms: Array.isArray(saved.casters.rooms) ? saved.casters.rooms : [],
          lineup: Array.isArray(saved.casters.lineup) ? saved.casters.lineup : [],
          activeLayout: typeof saved.casters.activeLayout === 'string' ? saved.casters.activeLayout : '',
          interview: (saved.casters.interview && saved.casters.interview.room) ? saved.casters.interview : { room: '', password: '' },
          apiKey: typeof saved.casters.apiKey === 'string' ? saved.casters.apiKey : '',
          interviewee: (saved.casters.interviewee && typeof saved.casters.interviewee === 'object') ? saved.casters.interviewee : null,
          playerCam: (saved.casters.playerCam && typeof saved.casters.playerCam === 'object') ? saved.casters.playerCam : null,
          deskRoomId: typeof saved.casters.deskRoomId === 'string' ? saved.casters.deskRoomId : '',
          slotLabels: (function() {
            const sl = saved.casters.slotLabels;
            if (!sl || typeof sl !== 'object') return { 1: 'Caster 1', 2: 'Caster 2', 3: 'Caster 3', 4: 'Caster 4', 5: 'Player' };
            return { 1: String(sl[1] || 'Caster 1').slice(0, 30), 2: String(sl[2] || 'Caster 2').slice(0, 30), 3: String(sl[3] || 'Caster 3').slice(0, 30), 4: String(sl[4] || 'Caster 4').slice(0, 30), 5: String(sl[5] || 'Player').slice(0, 30) };
          })()
        };
      }
      if (saved.ticker && typeof saved.ticker === 'object') {
        state.ticker = {
          visible: !!saved.ticker.visible,
          messages: Array.isArray(saved.ticker.messages) ? saved.ticker.messages : [],
          speed: Number(saved.ticker.speed) > 0 ? Number(saved.ticker.speed) : 40,
          source: saved.ticker.source === 'startgg' ? 'startgg' : 'manual',
          sponsor: typeof saved.ticker.sponsor === 'string' ? saved.ticker.sponsor : '',
          feed: []
        };
      }
      if (saved.overtime && typeof saved.overtime === 'object') {
        state.overtime = {
          label: typeof saved.overtime.label === 'string' ? saved.overtime.label : 'OVERTIME',
          logo: saved.overtime.logo || null,
          bg: saved.overtime.bg || '#e0202a',
          color: saved.overtime.color || '#ffffff'
        };
      }
      if (saved.replay && typeof saved.replay === 'object') {
        state.replay = {
          label: typeof saved.replay.label === 'string' ? saved.replay.label : 'REPLAY',
          logo: saved.replay.logo || null,
          outroLogo: saved.replay.outroLogo || null,
          colorMode: ['mono', 'brand'].includes(saved.replay.colorMode) ? saved.replay.colorMode : 'team',
          skin: saved.replay.skin || null
        };
      }
      if (saved.scoreboardAd && typeof saved.scoreboardAd === 'object') {
        state.scoreboardAd = {
          label: typeof saved.scoreboardAd.label === 'string' ? saved.scoreboardAd.label : 'PRESENTED BY',
          logo: saved.scoreboardAd.logo || null,
          background: saved.scoreboardAd.background || null
        };
      }
      if (saved.rlStatsScreen && typeof saved.rlStatsScreen === 'object') {
        const RL_STATS_DESIGNS = ['default', 'glass', 'block', 'radar'];
        state.rlStatsScreen = {
          showStats: saved.rlStatsScreen.showStats !== false,
          design: RL_STATS_DESIGNS.includes(saved.rlStatsScreen.design) ? saved.rlStatsScreen.design : 'default'
        };
      }
      if (saved.deskFooter && Array.isArray(saved.deskFooter.logos)) {
        state.deskFooter = { logos: saved.deskFooter.logos.filter((l) => typeof l === 'string' && l) };
      }
      if (saved.preshow && typeof saved.preshow === 'object') {
        state.preshow = {
          headline: typeof saved.preshow.headline === 'string' ? saved.preshow.headline : '',
          topics: Array.isArray(saved.preshow.topics)
            ? saved.preshow.topics.filter((t) => t && typeof t === 'object').map((t) => ({
                text: typeof t.text === 'string' ? t.text : '',
                sceneName: typeof t.sceneName === 'string' ? t.sceneName : ''
              }))
            : [],
          activeTopicIndex: Math.max(0, parseInt(saved.preshow.activeTopicIndex, 10) || 0),
          homeScene: typeof saved.preshow.homeScene === 'string' ? saved.preshow.homeScene : '',
          predictions: Array.isArray(saved.preshow.predictions)
            ? [0, 1].map((i) => (['blue', 'orange'].includes(saved.preshow.predictions[i]) ? saved.preshow.predictions[i] : ''))
            : ['', '']
          // headline/topics restored above are transient — syncActivePreshowTopics() (called once
          // brand kits finish loading) overwrites them from the active package right after boot.
        };
      }
      if (saved.vdo && typeof saved.vdo === 'object') {
        state.vdo = { ...state.vdo, ...saved.vdo };
      }
      if (saved.breakScreen && typeof saved.breakScreen === 'object') {
        state.breakScreen = {
          visible: !!saved.breakScreen.visible,
          title: saved.breakScreen.title || 'STARTING SOON',
          message: saved.breakScreen.message || '',
          finalMessage: saved.breakScreen.finalMessage || "WE'RE LIVE!",
          // Don't restore a stale countdown (or its pending auto-switch) across restarts
          endsAt: null,
          frozenSeconds: null,
          thenScene: '',
          thenPlayout: ''
        };
      }
      // Momentary production graphics: restore content, but never auto-show on restart.
      if (saved.winner && typeof saved.winner === 'object') {
        state.winner = {
          visible: false,
          side: saved.winner.side || '',
          name: saved.winner.name || '',
          logo: saved.winner.logo || null,
          color: saved.winner.color || '',
          subtitle: saved.winner.subtitle || ''
        };
      }
      if (saved.veto && typeof saved.veto === 'object') {
        state.veto = {
          visible: false,
          title: saved.veto.title || '',
          maps: Array.isArray(saved.veto.maps) ? saved.veto.maps : []
        };
      }
      if (saved.intro && typeof saved.intro === 'object') {
        state.intro = {
          visible: false,
          side: (saved.intro.side === 'orange' || saved.intro.side === 'blue') ? saved.intro.side : 'blue',
          title: saved.intro.title || '',
          style: [1, 2].includes(Number(saved.intro.style)) ? Number(saved.intro.style) : 1,
          showFooter: false   // always reset — was auto-true before; opt-in via checkbox now
        };
      }
      if (saved.owMatch && typeof saved.owMatch === 'object') {
        state.owMatch = {
          visible: typeof saved.owMatch.visible === 'boolean' ? saved.owMatch.visible : true,
          format: ['FT2','FT3','FT4'].includes(saved.owMatch.format) ? saved.owMatch.format : 'FT3',
          currentMapIdx: typeof saved.owMatch.currentMapIdx === 'number' ? saved.owMatch.currentMapIdx : 0,
          bansByMap: Array.isArray(saved.owMatch.bansByMap) ? saved.owMatch.bansByMap : [],
          gameMode: typeof saved.owMatch.gameMode === 'string' ? saved.owMatch.gameMode : 'escort',
          showMapLabels: typeof saved.owMatch.showMapLabels === 'boolean' ? saved.owMatch.showMapLabels : true,
          mapWinners: Array.isArray(saved.owMatch.mapWinners) ? saved.owMatch.mapWinners : [],
          mapModes:   Array.isArray(saved.owMatch.mapModes)   ? saved.owMatch.mapModes   : [],
          attackSide: saved.owMatch.attackSide || null,
          showAttack: !!saved.owMatch.showAttack
        };
      }
      if (saved.mrMatch && typeof saved.mrMatch === 'object') {
        state.mrMatch = {
          visible: typeof saved.mrMatch.visible === 'boolean' ? saved.mrMatch.visible : true,
          format: typeof saved.mrMatch.format === 'string' ? saved.mrMatch.format : 'BO5',
          bansByMap: Array.isArray(saved.mrMatch.bansByMap) ? saved.mrMatch.bansByMap : [],
          gameMode: typeof saved.mrMatch.gameMode === 'string' ? saved.mrMatch.gameMode : 'convergence',
          showMapLabels: typeof saved.mrMatch.showMapLabels === 'boolean' ? saved.mrMatch.showMapLabels : true,
          mapWinners: Array.isArray(saved.mrMatch.mapWinners) ? saved.mrMatch.mapWinners : [],
          mapModes:   Array.isArray(saved.mrMatch.mapModes)   ? saved.mrMatch.mapModes   : [],
          gepData: null
        };
      }
      if (saved.customOverlayLayouts && typeof saved.customOverlayLayouts === 'object') {
        state.customOverlayLayouts = saved.customOverlayLayouts;
      }
      if (saved.gameConfigs && typeof saved.gameConfigs === 'object') {
        state.gameConfigs = saved.gameConfigs;
      }
      if (saved.bestOf) state.bestOf = saved.bestOf;
      if (saved.teams) {
        state.teams = saved.teams;
        // Ensure team colors exist for older saves
        if (state.teams.blue && !state.teams.blue.color) state.teams.blue.color = '#055fdb';
        if (state.teams.orange && !state.teams.orange.color) state.teams.orange.color = '#e97139';
      }
      // Migrate legacy side-keyed manual team records → keyed by team name, using the NOW-restored
      // teams (must run after state.teams is set above, or it copies nothing and records orphan).
      // Idempotent + self-healing: only fills a team's key when unset, so real edits are never lost.
      if (state.teamRecord) {
        if (!state.teamRecord.manualByName) state.teamRecord.manualByName = {};
        const legacy = state.teamRecord.manual || {};
        ['blue', 'orange'].forEach((side) => {
          const nm = ((state.teams[side] && state.teams[side].name) || '').trim().toLowerCase();
          const rec = legacy[side];
          if (nm && !state.teamRecord.manualByName[nm] && rec && (rec.w || rec.l || rec.pts != null || rec.place != null)) {
            state.teamRecord.manualByName[nm] = { ...rec };
          }
        });
      }
      if (saved.series) state.series = saved.series;
      if (saved.pulse && typeof saved.pulse === 'object') state.pulse = { publish: !!saved.pulse.publish, feedViewUrl: String(saved.pulse.feedViewUrl || '') };
      if (saved.match && typeof saved.match === 'object') {
        state.match = {
          format: saved.match.format || '',
          division: saved.match.division || '',
          maps: Array.isArray(saved.match.maps) ? saved.match.maps : [],
          seriesVisible: typeof saved.match.seriesVisible === 'boolean' ? saved.match.seriesVisible : true
        };
      }
      if (Array.isArray(saved.leagues)) state.leagues = saved.leagues.map(migrateLeague);
      if (Array.isArray(saved.myEvents)) state.myEvents = saved.myEvents;
      if (saved.perfMode && typeof saved.perfMode === 'object') {
        const sp = saved.perfMode;
        state.perfMode.enabled = sp.enabled !== false;
        state.perfMode.always = !!sp.always;
        state.perfMode.reduceAnimations = !!sp.reduceAnimations;
        state.perfMode.pausePreviews = !!sp.pausePreviews;
        if (['smooth', 'balanced', 'light'].includes(sp.broadcastRate)) state.perfMode.broadcastRate = sp.broadcastRate;
      }
      if (saved.eventOps && typeof saved.eventOps === 'object') {
        // Rows saved by the first release were objects ({team,player,…}); the store is
        // now the full spreadsheet (headers + string-array rows). Drop the legacy shape.
        const legacy = Array.isArray(saved.eventOps.rows) && saved.eventOps.rows.some((r) => r && !Array.isArray(r));
        state.eventOps = {
          headers: Array.isArray(saved.eventOps.headers) ? saved.eventOps.headers : [],
          rows: (!legacy && Array.isArray(saved.eventOps.rows)) ? saved.eventOps.rows : [],
          roleMap: (saved.eventOps.roleMap && typeof saved.eventOps.roleMap === 'object') ? saved.eventOps.roleMap : {},
          seeds: Array.isArray(saved.eventOps.seeds) ? saved.eventOps.seeds : [],
          eventSlug: saved.eventOps.eventSlug || '',
          importedAt: saved.eventOps.importedAt || 0,
          seededAt: saved.eventOps.seededAt || 0
        };
      }
      if (saved.game && typeof saved.game.number === 'number') {
        state.game.number = saved.game.number;
      }
      if (saved.startgg && typeof saved.startgg === 'object') {
        state.startgg = {
          ...state.startgg,
          ...saved.startgg,
          // transient queue data — refetch on poll; keep selected event + teams + user toggles
          queue: [],
          streams: [],
          lastPushedSetId: null,
          connected: false,
          queueFetchedAt: null,
          autoFollow: !!saved.startgg.autoFollow,
          queueEnabled: !!saved.startgg.queueEnabled,
          // keep selectedEvent and eventTeams from disk if present (lightweight)
          selectedEvent: saved.startgg.selectedEvent || null,
          eventTeams: Array.isArray(saved.startgg.eventTeams) ? saved.startgg.eventTeams : [],
          // name→logo map persists (so logos survive a restart); pending picker is transient
          logoMap: (saved.startgg.logoMap && typeof saved.startgg.logoMap === 'object') ? saved.startgg.logoMap : {},
          pendingEvents: []
        };
      }
      if (typeof saved.startggApiToken === 'string') {
        startggApiToken = decryptSecret(saved.startggApiToken);
      }
      if (saved.challonge && typeof saved.challonge === 'object') {
        state.challonge = {
          ...state.challonge,
          enabled: !!saved.challonge.enabled,
          tournamentSlug: saved.challonge.tournamentSlug || '',
          selectedTournament: saved.challonge.selectedTournament || null,
          logoMap: (saved.challonge.logoMap && typeof saved.challonge.logoMap === 'object') ? saved.challonge.logoMap : {},
          autoFollow: !!saved.challonge.autoFollow,
          connected: false, lastError: null, queue: [], matchFeed: [], queueFetchedAt: null, eventTeams: [], lastAutoFollowMatchId: null
        };
      }
      if (typeof saved.challongeApiKey === 'string') {
        challongeApiKey = decryptSecret(saved.challongeApiKey);
      }
      if (saved.nxgen && typeof saved.nxgen === 'object') {
        state.nxgen = {
          ...state.nxgen,
          enabled: !!saved.nxgen.enabled,
          eventSlug: saved.nxgen.eventSlug || '',
          selectedEvent: saved.nxgen.selectedEvent || null,
          logoMap: (saved.nxgen.logoMap && typeof saved.nxgen.logoMap === 'object') ? saved.nxgen.logoMap : {},
          autoFollow: !!saved.nxgen.autoFollow,
          connected: false, lastError: null, queue: [], eventTeams: [], queueFetchedAt: null, lastAutoFollowMatchId: null
        };
      }
      if (typeof saved.nxgenApiKey === 'string') {
        nxgenApiKey = decryptSecret(saved.nxgenApiKey);
      }
      if (saved.activeEvent && typeof saved.activeEvent === 'object') {
        state.activeEvent = { ...state.activeEvent, ...saved.activeEvent };
      }
      // Overlay header rename: existing installs carry the old default title.
      if (state.upcoming && state.upcoming.title === 'UPCOMING MATCHES') state.upcoming.title = 'SCHEDULE';
      if (saved.obs && typeof saved.obs === 'object') {
        state.obs = {
          ...state.obs,
          enabled: !!saved.obs.enabled,
          url: saved.obs.url || state.obs.url,
          autoSwitch: saved.obs.autoSwitch !== false,
          autoReplayOnGoal: !!saved.obs.autoReplayOnGoal,
          postGameToCastersSec: Number(saved.obs.postGameToCastersSec) || 0,
          kickoff: {
            enabled: !!(saved.obs.kickoff && saved.obs.kickoff.enabled),
            scene: (saved.obs.kickoff && saved.obs.kickoff.scene) || '',
            transition: (saved.obs.kickoff && saved.obs.kickoff.transition) || ''
          },
          postGame: {
            enabled: !!(saved.obs.postGame && saved.obs.postGame.enabled),
            scene: (saved.obs.postGame && saved.obs.postGame.scene) || '',
            delaySec: Number(saved.obs.postGame && saved.obs.postGame.delaySec) || 20,
            transition: (saved.obs.postGame && saved.obs.postGame.transition) || ''
          },
          commercialAutoReturn: saved.obs.commercialAutoReturn !== false,
          scenes: { ...state.obs.scenes, ...(saved.obs.scenes || {}) },
          // runtime fields are not restored
          connected: false,
          lastError: null,
          availableScenes: [],
          availableTransitions: []
        };
      }
      if (typeof saved.obsPassword === 'string') {
        obsPassword = decryptSecret(saved.obsPassword);
      }
      if (saved.vmix && typeof saved.vmix === 'object') {
        state.vmix.enabled = !!saved.vmix.enabled;
        if (typeof saved.vmix.host === 'string' && saved.vmix.host.trim()) state.vmix.host = saved.vmix.host.trim();
        if (Number(saved.vmix.port) > 0) state.vmix.port = Number(saved.vmix.port);
      }
      if (saved.switcher && (saved.switcher.target === 'vmix' || saved.switcher.target === 'obs')) {
        state.switcher.target = saved.switcher.target;
      }
      if (typeof saved.csgoCfgPath === 'string') {
        state.csgo.cfgPath = saved.csgoCfgPath;
      }
      if (saved.bracket && typeof saved.bracket === 'object') {
        state.bracket = {
          ...state.bracket,
          ...saved.bracket,
          // arrays default safely if an older save lacks them
          winners: Array.isArray(saved.bracket.winners) ? saved.bracket.winners : [],
          losers: Array.isArray(saved.bracket.losers) ? saved.bracket.losers : [],
          finals: Array.isArray(saved.bracket.finals) ? saved.bracket.finals : [],
          standings: Array.isArray(saved.bracket.standings) ? saved.bracket.standings : [],
          schedule: Array.isArray(saved.bracket.schedule) ? saved.bracket.schedule : [],
          roster: Array.isArray(saved.bracket.roster) ? saved.bracket.roster : [],
          matches: Array.isArray(saved.bracket.matches) ? saved.bracket.matches : [],
          phases: Array.isArray(saved.bracket.phases) ? saved.bracket.phases : [],
          activePhaseId: saved.bracket.activePhaseId || '',
          pools: Array.isArray(saved.bracket.pools) ? saved.bracket.pools : [],
          activePoolId: saved.bracket.activePoolId || '',
          matrix: saved.bracket.matrix || null,
          lastError: null
        };
      }
      if (saved.upcoming && typeof saved.upcoming === 'object') {
        state.upcoming = { ...state.upcoming, ...saved.upcoming, visible: false, matches: Array.isArray(saved.upcoming.matches) ? saved.upcoming.matches : [] };
      }
      if (saved.standings && typeof saved.standings === 'object') {
        state.standings = { ...state.standings, ...saved.standings, visible: false, rows: Array.isArray(saved.standings.rows) ? saved.standings.rows : [] };
      }
      if (saved.socialPreset && typeof saved.socialPreset === 'object') {
        state.socialPreset = { ...saved.socialPreset };
      }
      if (saved.watchlist && typeof saved.watchlist === 'object') {
        state.watchlist = {
          ...state.watchlist, ...saved.watchlist, visible: false,
          fields: Array.isArray(saved.watchlist.fields) && saved.watchlist.fields.length ? saved.watchlist.fields : state.watchlist.fields,
          teams: Array.isArray(saved.watchlist.teams) ? saved.watchlist.teams : []
        };
      }
      if (saved.teamSpotlight && typeof saved.teamSpotlight === 'object') {
        state.teamSpotlight = { ...state.teamSpotlight, ...saved.teamSpotlight, visible: false,
          players: Array.isArray(saved.teamSpotlight.players) ? saved.teamSpotlight.players : [] };
      }
      if (saved.director && typeof saved.director === 'object') {
        state.director = {
          ...state.director,
          enabled: saved.director.enabled !== false,
          sensitivity: typeof saved.director.sensitivity === 'number' ? saved.director.sensitivity : 0.5,
          autoSwitch: !!saved.director.autoSwitch,
          lockTarget: null,
          primary: null,
          alternates: [],
          feed: []
        };
      }
      if (saved.ai && typeof saved.ai === 'object') {
        state.ai = {
          shield: !!saved.ai.shield,
          telemetry: { enabled: saved.ai.telemetry?.enabled !== false }
        };
      }
      if (saved.clips && typeof saved.clips === 'object') {
        const mode = ['auto', 'prompt', 'manual'].includes(saved.clips.captureMode) ? saved.clips.captureMode : 'auto';
        state.clips = {
          ...state.clips,
          captureMode: mode,
          autoCapture: mode === 'auto',
          autoMontage: !!saved.clips.autoMontage,
          replayFolder: saved.clips.replayFolder || '',
          captureRules: { ...state.clips.captureRules, ...(saved.clips.captureRules || {}) }
        };
      }
      if (saved.rlSpectatorUi && typeof saved.rlSpectatorUi === 'object') {
        state.rlSpectatorUi = { ...rlSpectatorUi.DEFAULTS, ...saved.rlSpectatorUi };
      }
      if (Array.isArray(saved.flows)) {
        state.flows = saved.flows;
      }
      if (Array.isArray(saved.crew)) {
        // workedEvent is new — backfill from active so anyone already on shift stays creditable
        // instead of silently vanishing from credits the moment this field starts being read.
        state.crew = saved.crew.map((c) => (c && typeof c.workedEvent !== 'boolean') ? { ...c, workedEvent: !!c.active } : c);
      }
      // One-time migration: the Show Deck support column used to be "crew whose group is a support
      // role" — seed the new event-scoped list from that so nobody's chip disappears on update.
      if (!Array.isArray(state.casters.support)) {
        state.casters.support = (state.crew || [])
          .filter((c) => c && TD_SUPPORT_GROUPS.includes(c.group))
          .map((c) => ({ crewId: c.id, role: c.role || TD_SUPPORT_LABELS[c.group] || '' }));
      }
      if (Array.isArray(saved.adProofSessions)) {
        state.adProofSessions = saved.adProofSessions;
      }
      if (saved.playerProfiles && typeof saved.playerProfiles === 'object') {
        state.playerProfiles = saved.playerProfiles;
        // Back-fill countryCode from the stored country name for profiles saved before the country
        // map was expanded — so overlays (credits/intro flags) get a code without re-syncing the event.
        try {
          Object.values(state.playerProfiles).forEach((p) => {
            if (p && !p.countryCode && p.country) { const cc = _countryCode(p.country); if (cc) p.countryCode = cc; }
          });
          // Stamp the resolved country onto EXISTING start.gg event-team + saved-team player objects
          // (older syncs didn't carry it) so the credits/lineup overlays read it straight off the
          // player — no live playerProfiles match needed.
          const prof = (nm) => state.playerProfiles[(nm || '').trim().toLowerCase()] || null;
          const stamp = (pl) => { if (pl && pl.name && !pl.countryCode) { const pr = prof(pl.name); if (pr && (pr.countryCode || pr.country)) { pl.countryCode = pr.countryCode || _countryCode(pr.country) || ''; pl.country = pl.country || pr.country || ''; } } };
          ((state.startgg && state.startgg.eventTeams) || []).forEach((t) => (t.players || []).forEach(stamp));
          (savedTeams || []).forEach((t) => (t.players || []).forEach(stamp));
        } catch (e) {}
      }
      if (saved.draftAuto && typeof saved.draftAuto === 'object') {
        if (!state.draft.auto) state.draft.auto = { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' };
        state.draft.auto.enabled = !!saved.draftAuto.enabled;
        state.draft.auto.lockfilePath = (saved.draftAuto.lockfilePath || '').toString();
      }
      if (saved.lolHudMode && ['full', 'minimal', 'auto'].includes(saved.lolHudMode)) {
        state.lol.hudMode = saved.lolHudMode;
      }
      if (saved.lolOcr && typeof saved.lolOcr === 'object') {
        state.lol.ocr.enabled = !!saved.lolOcr.enabled;
        if (saved.lolOcr.regions) ['blue', 'red'].forEach((s) => {
          if (saved.lolOcr.regions[s]) ['x', 'y', 'w', 'h'].forEach((k) => {
            const v = Number(saved.lolOcr.regions[s][k]);
            if (!isNaN(v)) state.lol.ocr.regions[s][k] = Math.max(0, Math.round(v));
          });
        });
      }
    }
  } catch (e) { console.error('Error loading state:', e); }
}

function _saveAppStateNow(sync = false) {
  try {
    const toSave = {
      activeGame: state.activeGame,
      themesByGame: state.themesByGame,
      activeBrandKitId: state.activeBrandKitId,
      useBrandColors: state.useBrandColors,
      colorMode: state.colorMode,
      clock24h: state.clock24h,
      showSeries: state.showSeries,
      defaultBestOf: state.defaultBestOf,
      eventName: state.eventName,
      gameLabel: state.gameLabel,
      roundLabel: state.roundLabel,
      speedUnit: state.speedUnit,
      teamRecord: state.teamRecord,
      perfMode: (function () { const pm = state.perfMode || {}; return {
        enabled: pm.enabled !== false, always: !!pm.always,
        reduceAnimations: !!pm.reduceAnimations, pausePreviews: !!pm.pausePreviews,
        broadcastRate: pm.broadcastRate || 'smooth' }; })(),
      autoTeamsFromGame: state.autoTeamsFromGame,
      startggLeagueStandings: state.startggLeagueStandings,
      fontFamily: state.fontFamily,
      facecamsEnabled: state.facecamsEnabled,
      replayCams: state.replayCams,
      deskFooter: state.deskFooter,
      preshow: state.preshow,
      banner: state.banner,
      casters: state.casters,
      credits: state.credits,
      ticker: state.ticker,
      draftAuto: { enabled: !!(state.draft && state.draft.auto && state.draft.auto.enabled), lockfilePath: (state.draft && state.draft.auto && state.draft.auto.lockfilePath) || '' },
      lolHudMode: (state.lol && state.lol.hudMode) || 'auto',
      lolOcr: { enabled: !!(state.lol && state.lol.ocr && state.lol.ocr.enabled), regions: (state.lol && state.lol.ocr && state.lol.ocr.regions) || undefined },
      adProofSessions: state.adProofSessions || [],
      playerProfiles: state.playerProfiles || {},
      overtime: state.overtime,
      replay: state.replay,
      scoreboardAd: state.scoreboardAd,
      watchlist: state.watchlist,
      teamSpotlight: state.teamSpotlight,
      breakScreen: {
        visible: state.breakScreen.visible,
        title: state.breakScreen.title,
        message: state.breakScreen.message,
        finalMessage: state.breakScreen.finalMessage
      },
      // Persist content for the momentary production graphics; visibility is reset on restart.
      winner: { side: state.winner.side, name: state.winner.name, logo: state.winner.logo, color: state.winner.color, subtitle: state.winner.subtitle },
      veto: { title: state.veto.title, maps: state.veto.maps },
      intro: { side: state.intro.side, title: state.intro.title, style: state.intro.style, showFooter: state.intro.showFooter, showRealName: state.intro.showRealName !== false },
      owMatch: { visible: !!state.owMatch.visible, format: state.owMatch.format, currentMapIdx: state.owMatch.currentMapIdx, bansByMap: state.owMatch.bansByMap, attackSide: state.owMatch.attackSide || null, showAttack: !!state.owMatch.showAttack, gameMode: state.owMatch.gameMode || 'escort', showMapLabels: state.owMatch.showMapLabels !== false, mapWinners: Array.isArray(state.owMatch.mapWinners) ? state.owMatch.mapWinners : [], mapModes: Array.isArray(state.owMatch.mapModes) ? state.owMatch.mapModes : [] },
      mrMatch: (function(){ const m=state.mrMatch||{}; return { visible: m.visible !== false, format: m.format || 'BO5', bansByMap: m.bansByMap || [], gameMode: m.gameMode || 'convergence', showMapLabels: m.showMapLabels !== false, mapWinners: Array.isArray(m.mapWinners)?m.mapWinners:[], mapModes: Array.isArray(m.mapModes)?m.mapModes:[], gepData: m.gepData||null }; })(),
      customOverlayLayouts: state.customOverlayLayouts || {},
      gameConfigs: state.gameConfigs || {},
      bestOf: state.bestOf,
      teams: state.teams,
      series: state.series,
      pulse: state.pulse,
      match: state.match,
      leagues: state.leagues,
      myEvents: state.myEvents,
      eventOps: state.eventOps,
      game: { number: state.game.number },
      startgg: state.startgg,
      startggApiToken: encryptSecret(startggApiToken),
      challonge: { enabled: state.challonge.enabled, tournamentSlug: state.challonge.tournamentSlug, selectedTournament: state.challonge.selectedTournament, logoMap: state.challonge.logoMap, autoFollow: state.challonge.autoFollow },
      challongeApiKey: encryptSecret(challongeApiKey),
      nxgen: { enabled: state.nxgen.enabled, eventSlug: state.nxgen.eventSlug, selectedEvent: state.nxgen.selectedEvent, logoMap: state.nxgen.logoMap, autoFollow: state.nxgen.autoFollow },
      nxgenApiKey: encryptSecret(nxgenApiKey),
      activeEvent: state.activeEvent,
      obs: {
        enabled: state.obs.enabled,
        url: state.obs.url,
        autoSwitch: state.obs.autoSwitch,
        autoReplayOnGoal: state.obs.autoReplayOnGoal,
        postGameToCastersSec: state.obs.postGameToCastersSec,
        kickoff: state.obs.kickoff,
        postGame: state.obs.postGame,
        commercialAutoReturn: state.obs.commercialAutoReturn,
        scenes: state.obs.scenes
      },
      obsPassword: encryptSecret(obsPassword),
      vmix: { enabled: state.vmix.enabled, host: state.vmix.host, port: state.vmix.port },
      switcher: { target: state.switcher.target },
      // Persist the full bracket so it renders instantly on restart (then refreshes)
      bracket: state.bracket,
      upcoming: state.upcoming,
      standings: state.standings,
      socialPreset: state.socialPreset || null,   // Social Export background/presented-by fallback (no brand kit active)
      brand: state.brand || null,                 // global accent fallback (Settings ▸ Appearance) when no kit is active
      preshowPresets: state.preshowPresets || [], // Desk Show named topic rundowns
      csgoCfgPath: state.csgo.cfgPath,
      director: {
        enabled: state.director?.enabled !== false,
        sensitivity: state.director?.sensitivity ?? 0.5,
        autoSwitch: !!state.director?.autoSwitch
      },
      ai: {
        shield: !!state.ai?.shield,
        telemetry: { enabled: state.ai?.telemetry?.enabled !== false }
      },
      clips: {
        captureMode: state.clips?.captureMode || 'auto',
        autoCapture: state.clips?.autoCapture !== false,
        autoMontage: !!state.clips?.autoMontage,
        replayFolder: state.clips?.replayFolder || '',
        captureRules: state.clips?.captureRules || {}
      },
      rlSpectatorUi: state.rlSpectatorUi || rlSpectatorUi.DEFAULTS,
      vdo: state.vdo,
      flows: state.flows || [],
      sceneBg: state.sceneBg || {},
      scenePresets: state.scenePresets || {},
      crew: state.crew || []
    };
    safeWriteJson(stateFile, toSave, sync);
    saveTwitchData(sync);
  } catch (e) { console.error('Error saving state:', e); }
}

// Debounced public wrapper — collapses rapid successive saves (e.g. during RL match events)
// into one disk write after 500ms of quiet. Use _saveAppStateNow() for immediate flush.
let _saveTimer = null;
function saveAppState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveAppStateNow, 500);
}

// ─── VDO.Ninja talent workflow ─────────────────────────────────────────────
// Deterministic identity is the whole trick: each team gets a private room
// (opaque name + random password) and each player a stream ID derived from their
// gamertag, so join links, OBS feeds, and the listen-in audio all resolve from
// (team, player) with nothing to paste. Privacy rests on per-team passwords +
// private per-player distribution; opponents never receive another team's link.

function vdoRandom(len) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';   // no ambiguous 0/o/1/l
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function vdoSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}
// Ensure a team has a room + password. Returns the team's vdo block.
function ensureTeamVdo(team, regenerate = false) {
  if (!team) return null;
  if (regenerate || !team.vdo || !team.vdo.room || !team.vdo.password) {
    team.vdo = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
  }
  return team.vdo;
}
// Provision a shared private room for all casters. Returns the casters.vdo block.
function ensureCasterVdo(regenerate = false) {
  if (regenerate || !state.casters.vdo || !state.casters.vdo.room || !state.casters.vdo.password) {
    state.casters.vdo = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
  }
  return state.casters.vdo;
}
// Shared rooms for the two other talent groups — guests (desk hosts/analysts/special guests)
// and observers. One room per group; every member of that group pushes into it and the
// Director monitors it (same model as the casters room above).
function ensureGuestsVdo(regenerate = false) {
  if (!state.casters.guestsVdo) state.casters.guestsVdo = { room: '', password: '' };
  const v = state.casters.guestsVdo;
  if (regenerate || !v.room || !v.password) { v.room = 'ne' + vdoRandom(9); v.password = vdoRandom(12); }
  return v;
}
function ensureObserversVdo(regenerate = false) {
  if (!state.casters.observersVdo) state.casters.observersVdo = { room: '', password: '' };
  const v = state.casters.observersVdo;
  if (regenerate || !v.room || !v.password) { v.room = 'ne' + vdoRandom(9); v.password = vdoRandom(12); }
  return v;
}
// Build a team-shaped group (Casters / Guests / Observers) from the caster library, filtered by
// kind. Members push to the group's single shared room; the Director monitors that room. Shaped
// like a team (name/color/room/members) so ONE renderer + the Director can consume all of them.
function buildTalentGroup(name, color, vdo, members) {
  const ready = !!(vdo && vdo.room && vdo.password);
  const list = (members || []).map((p) => {
    const fake = { streamId: p.streamId || p.handle || p.name, handle: p.handle, name: p.name, camUrl: p.camUrl };
    return {
      libraryId: p.id, name: p.name || '', handle: p.handle || '', role: p.role || '', social: p.social || 'none',
      streamId: vdoSlug(p.streamId || p.handle || p.name || 'talent'),
      joinUrl: ready ? buildCasterJoinUrlFromVdo(fake, vdo) : '',
      // A custom view link (camUrl) overrides the auto-generated room feed when set.
      obsUrl:  p.camUrl ? p.camUrl : (ready ? buildCasterObsUrlFromVdo(fake, vdo) : ''),
      camUrl:  p.camUrl || '',
      audio: p.audio || null
    };
  });
  return { name, color, room: ready ? vdo.room : '', directorUrl: ready ? buildDirectorUrl(vdo) : '', members: list };
}
// Provision VDO credentials for a named caster room.
function ensureRoomVdo(room, regenerate = false) {
  if (regenerate || !room.vdo || !room.vdo.room || !room.vdo.password) {
    room.vdo = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
  }
  return room.vdo;
}
// The interview / desk room = the named caster room designated in the VDO Rooms panel
// (state.casters.deskRoomId). Players are transferred into THIS room for on-desk interviews and
// the spotlight-desk right cam reads their solo feed from it. Falls back to the first named room
// with VDO creds, then the legacy shared caster room.
function deskRoomVdo() {
  const rooms = state.casters.rooms || [];
  const id = state.casters.deskRoomId;
  if (id) { const r = rooms.find((x) => x.id === id); if (r && r.vdo && r.vdo.room && r.vdo.password) return r.vdo; }
  const firstReady = rooms.find((r) => r.vdo && r.vdo.room && r.vdo.password);
  if (firstReady) return firstReady.vdo;
  return state.casters.vdo;
}
// Dedicated INTERVIEW room — a separate VDO room players get transferred into for on-desk
// interviews (kept distinct from the caster desk room so the desk audio stays clean).
function ensureInterviewVdo(regenerate = false) {
  if (!state.casters.interview) state.casters.interview = { room: '', password: '' };
  const v = state.casters.interview;
  if (regenerate || !v.room || !v.password) { v.room = 'ne' + vdoRandom(9); v.password = vdoRandom(12); }
  return v;
}
// One stable key shared by every embedded director console — enables the VDO IFrame API so the
// control panel can drive director-side actions (forward/transfer, mute, hangup) programmatically.
function ensureDirectorApiKey() {
  if (!state.casters.apiKey) state.casters.apiKey = 'ne' + vdoRandom(16);
  return state.casters.apiKey;
}
// Director console URL for a room's VDO creds. &api enables IFrame-API control; &rooms pre-arms a
// one-click transfer button to the interview room in the native director UI; #p carries the room
// password (same room+password as the players, so the director owns the exact same room).
function buildDirectorUrl(vdo, { armInterview = true } = {}) {
  if (!vdo || !vdo.room || !vdo.password) return '';
  const api = ensureDirectorApiKey();
  const iv = state.casters.interview;
  const roomsParam = (armInterview && iv && iv.room && iv.room !== vdo.room) ? `&rooms=${iv.room}` : '';
  // &novideo&noaudio: the director joins purely to monitor presence + issue transfers — it does NOT
  // capture the producer's camera/mic, so it can auto-run in the background with no device light.
  return `${vdoBase()}/?director=${vdo.room}&cleanoutput&novideo&noaudio&api=${api}${roomsParam}#p=${vdo.password}`;
}
// Build join/OBS URLs against a specific VDO block (room-aware).
function buildCasterJoinUrlFromVdo(caster, vdo) {
  if (!vdo || !vdo.room || !vdo.password) return '';
  const sid = vdoSlug(caster.streamId || caster.handle || caster.name || 'caster');
  const lang = state.vdo?.lang || 'en-US';
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  return `${vdoBase()}/?room=${vdo.room}&push=${sid}&transcribe=${lang}&webcam&autostart${extra}#p=${vdo.password}`;
}
function buildCasterObsUrlFromVdo(caster, vdo) {
  if (!vdo || !vdo.room || !vdo.password) return caster.camUrl || '';
  const sid = vdoSlug(caster.streamId || caster.handle || caster.name || 'caster');
  const params = vdoViewParams(casterAudioOverride(caster));
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&solo${params ? '&' + params : ''}#p=${vdo.password}`;
}
// A caster's per-feed audio override (volume on the row + an optional richer audio block).
function casterAudioOverride(caster) {
  const a = Object.assign({}, (caster && caster.audio) || {});
  if (caster && caster.volume != null && a.volume == null) a.volume = caster.volume;
  return a;
}
// Convert lineup + library + rooms → state.casters.list for overlay consumption.
// The crew profile is the canonical person record: its Handle/Gamertag field is the DISPLAY
// name for desks. The caster-library `handle` field can't be trusted for that — the caster
// card editors historically treat it as the @social username, so the two UIs disagree about
// what it means. Cross-reference at resolve time instead of trying to sync fields.
// Matching is deliberately generous (library name/handle vs crew name/handle/socialHandle,
// case-insensitive): producers rename the library card (e.g. to the gamertag itself) and a
// strict name==name join silently loses the person.
function crewGamertagFor(profOrName) {
  if (!Array.isArray(state.crew) || !state.crew.length) return '';
  const prof = (profOrName && typeof profOrName === 'object') ? profOrName : { name: profOrName };
  const keys = [prof.name, prof.handle, prof.socialHandle]
    .map((v) => (v || '').toString().trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return '';
  const hit = state.crew.find((c) => {
    if (!c) return false;
    const own = [c.name, c.handle, c.socialHandle]
      .map((v) => (v || '').toString().trim().toLowerCase()).filter(Boolean);
    return own.some((o) => keys.includes(o));
  });
  return ((hit && hit.handle) || '').toString().trim();
}

function resolveLineupToList() {
  const lib = state.casters.library || [];
  const rooms = state.casters.rooms || [];
  const lineup = state.casters.lineup || [];
  if (!lineup.length) return;
  state.casters.list = lineup.filter(e => e.libraryId).map((entry, i) => {
    const prof = lib.find(p => p.id === entry.libraryId) || {};
    const room = rooms.find(r => r.id === entry.roomId) || null;
    const vdo = (room && room.vdo && room.vdo.room) ? room.vdo
              : ((state.casters.vdo && state.casters.vdo.room) ? state.casters.vdo : null);
    const sid = entry.streamId || ('caster_' + (entry.slot || (i + 1)));
    const fakeCaster = { streamId: sid, handle: prof.handle, name: prof.name, camUrl: prof.camUrl, audio: entry.audio };
    // camUrl precedence: per-slot lineup override → the caster's explicit custom view link
    // (prof.camUrl / vdoOverride, pasted in the DCC) → the auto-generated room feed. A pasted link
    // must WIN over the generated room so producers can point a caster at any third-party feed.
    const customLink = (entry.customCamUrl || prof.vdoOverride || prof.camUrl || '').toString().trim();
    return {
      id: prof.id || ('lineup_' + (entry.slot || (i + 1))),
      name: prof.name || '',
      handle: prof.handle || '',
      gamertag: crewGamertagFor(prof),         // desk display name (crew Handle/Gamertag field)
      socialHandle: prof.socialHandle || prof.handle || '',   // @-line username
      social: prof.social || 'none',
      country: prof.country || '',
      slot: Number(entry.slot) || (i + 1),
      streamId: sid,
      room: vdo ? vdo.room : '',
      camUrl: customLink || (vdo ? buildCasterObsUrlFromVdo(fakeCaster, vdo) : ''),
    };
  });
}
// Stream ID for a player — derived from gamertag/name, with an explicit override.
function playerStreamId(player) {
  if (!player) return '';
  if (player.vdoStreamId) return vdoSlug(player.vdoStreamId);
  return vdoSlug(player.name || player.primaryid || 'player') || ('p' + vdoRandom(5));
}
// Turn a normalized audio object into a VDO.ninja URL param string (no leading '&').
// volume 0–200, pan −100..+100 (0 = centre → &panning 0–180), mono, noaudio, ab (kbps), params (free text).
function vdoAudioParamString(a) {
  a = a || {};
  const out = [];
  const vol = a.volume;
  if (vol != null && vol !== '' && Number(vol) !== 100) out.push('volume=' + Math.max(0, Math.min(200, Math.round(Number(vol)) || 0)));
  if (a.mono) out.push('mono');
  if (a.noaudio) out.push('noaudio');
  if (a.ab !== undefined && a.ab !== null && a.ab !== '') out.push('ab=' + (parseInt(a.ab) || 0));
  if (a.pan != null && a.pan !== '' && Number(a.pan) !== 0) {
    const deg = Math.round((Math.max(-100, Math.min(100, Number(a.pan))) + 100) / 200 * 180);   // −100→0(L) … 0→90(C) … 100→180(R)
    out.push('panning=' + deg);
  }
  if (a.params) out.push(String(a.params).replace(/^&+/, '').trim());
  return out.filter(Boolean).join('&');
}
// Normalize an incoming per-feed audio override (from the control panel) into a safe stored object.
function sanitizeVdoAudio(a) {
  if (!a || typeof a !== 'object') return undefined;
  const out = {};
  if (a.volume !== undefined && a.volume !== '' && a.volume !== null) out.volume = Math.max(0, Math.min(200, Math.round(Number(a.volume)) || 0));
  if (a.pan !== undefined && a.pan !== '' && a.pan !== null) out.pan = Math.max(-100, Math.min(100, Math.round(Number(a.pan)) || 0));
  if (a.mono) out.mono = true;
  if (a.noaudio) out.noaudio = true;
  if (a.ab !== undefined && a.ab !== '' && a.ab !== null) out.ab = Math.max(0, parseInt(a.ab) || 0);
  if (typeof a.params === 'string' && a.params.trim()) out.params = a.params.slice(0, 200);
  return Object.keys(out).length ? out : undefined;
}
// Global audio defaults from the VDO config.
function vdoGlobalAudio() {
  const v = state.vdo || {};
  return { volume: v.volume, mono: !!v.audioMono, ab: v.audioBitrate || '', pan: 0, params: v.audioParams || '' };
}
// Shared "&clean view" param string from the global VDO config. Pass a per-feed audio override
// (e.g. a player's vdoAudio) to layer it on top of the global audio defaults.
function vdoViewParams(audioOverride) {
  const v = state.vdo || {};
  const p = [];
  if (v.cleanOutput !== false) p.push('cleanoutput');
  if (v.cover !== false) p.push('cover');
  if (v.transparent) p.push('transparent');
  const aStr = vdoAudioParamString(Object.assign(vdoGlobalAudio(), audioOverride || {}));
  if (aStr) p.push(aStr);
  if (v.codec) p.push('codec=' + v.codec);
  if (v.bitrate) p.push('bitrate=' + parseInt(v.bitrate));
  if (v.buffer) p.push('buffer=' + parseInt(v.buffer));
  if (v.viewParams) p.push(String(v.viewParams).replace(/^&+/, ''));
  return p.filter(Boolean).join('&');
}
function vdoBase() { return (state.vdo?.base || 'https://vdo.ninja').replace(/\/+$/, ''); }

// Talent join link: pushes as <streamId> into the team room, with live transcription.
// Password rides in the URL fragment (#p=) so it's never sent to / logged by the server.
function buildTalentJoinUrl(team, player) {
  const vdo = ensureTeamVdo(team);
  const sid = playerStreamId(player);
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  const lang = state.vdo?.lang || 'en-US';
  return `${vdoBase()}/?room=${vdo.room}&push=${sid}&transcribe=${lang}&webcam&autostart${extra}#p=${vdo.password}`;
}
// OBS feed (solo view of one player) — for a dedicated browser source per gamertag.
function buildObsViewUrl(team, player) {
  const vdo = ensureTeamVdo(team);
  const sid = playerStreamId(player);
  const params = vdoViewParams(player && player.vdoAudio);   // per-player audio override
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&solo${params ? '&' + params : ''}#p=${vdo.password}`;
}
// ── Interview / production workflow ─────────────────────────────────────────
// The interview room IS the production room (where the casters are) — i.e. the shared CASTER room.
// Move a player into it for an on-desk interview, then back to their team room afterwards. The
// JOIN link pushes the player in as their own stream id; the VIEW link is the solo desk feed to
// drop into a caster slot's Custom View URL (or "Set as CAM") / the interview overlay frame.
function buildPlayerInterviewJoinUrl(player) {
  const vdo = deskRoomVdo();
  if (!vdo || !vdo.room || !vdo.password) return '';
  const sid = playerStreamId(player);
  const lang = state.vdo?.lang || 'en-US';
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  return `${vdoBase()}/?room=${vdo.room}&push=${sid}&transcribe=${lang}&webcam&autostart${extra}#p=${vdo.password}`;
}
function buildPlayerInterviewViewUrl(player) {
  const vdo = deskRoomVdo();
  if (!vdo || !vdo.room || !vdo.password) return '';
  const sid = playerStreamId(player);
  const params = vdoViewParams(player && player.vdoAudio);
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&solo${params ? '&' + params : ''}#p=${vdo.password}`;
}
// CSS injected into the VDO view (via &base64css) so VDO renders the captions itself —
// guaranteed transcription — but styled to match the listen-in card: cam hidden, transparent
// background, our font, last 2 lines only. #overlayMsgs is VDO's caption container.
// Transparent bg, no cam, and a forced readable caption size. VDO sizes captions tiny relative
// to the small iframe, so we override font-size on #overlayMsgs AND its children (the spans),
// and lay them out bottom-aligned (newest last) clipped to the iframe.
const LISTEN_IN_CAPTION_CSS =
  "html,body{height:100%!important}" +
  "body{background-color:rgba(0,0,0,0)!important;margin:0!important;overflow:hidden!important}" +
  "video{display:none!important}" +
  // Fill the strip, newest enters at the top, older scrolls off the bottom (top-anchored).
  "#overlayMsgs{position:fixed!important;left:0!important;right:0!important;bottom:0!important;top:0!important;" +
  "display:flex!important;flex-direction:column!important;align-items:flex-start!important;justify-content:flex-start!important;" +
  "overflow:hidden!important;padding:0!important;margin:0!important;box-sizing:border-box!important}" +
  "#overlayMsgs,#overlayMsgs *{font-family:Rajdhani,'Segoe UI',sans-serif!important;font-weight:700!important;" +
  "font-size:36px!important;line-height:1.25!important;color:#e9ecf3!important;text-align:left!important;text-transform:uppercase!important;" +
  "white-space:normal!important;word-break:break-word!important;overflow-wrap:anywhere!important;" +
  "background:transparent!important;text-shadow:0 2px 6px rgba(0,0,0,.75)!important}";

// LISTEN IN feed — audio + VDO-native captions for one player (consumed by listen-in.html).
// The player's push carries &transcribe; this view shows the captions (&closedcaptions) styled
// via &base64css. Audio plays from the same iframe.
// &cc renders incoming captions; &novideo drops the video (no "white box") while keeping audio.
function buildListenInUrl(team, player) {
  const vdo = ensureTeamVdo(team);
  const sid = playerStreamId(player);
  const css = encodeURIComponent(Buffer.from(LISTEN_IN_CAPTION_CSS, 'utf8').toString('base64'));
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&cleanoutput&autostart&novideo&cc&base64css=${css}#p=${vdo.password}`;
}
// LISTEN IN on the WHOLE team room — a scene that pulls every connected player's audio +
// captions (VDO labels whoever speaks). &cc = the documented room-captions browser source.
function buildRoomListenInUrl(team) {
  const vdo = ensureTeamVdo(team);
  const css = encodeURIComponent(Buffer.from(LISTEN_IN_CAPTION_CSS, 'utf8').toString('base64'));
  return `${vdoBase()}/?room=${vdo.room}&scene=0&cleanoutput&autostart&novideo&cc&base64css=${css}#p=${vdo.password}`;
}
// General room join link — anyone can enter the team's private VDO room without claiming a named slot.
function buildRoomJoinUrl(team) {
  const vdo = ensureTeamVdo(team);
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  return `${vdoBase()}/?room=${vdo.room}${extra}#p=${vdo.password}`;
}
// Caster join link — pushes as <streamId> into the shared caster room with transcription.
function buildCasterJoinUrl(caster) {
  const vdo = state.casters?.vdo;
  if (!vdo || !vdo.room || !vdo.password) return '';
  const sid = vdoSlug(caster.streamId || caster.handle || caster.name || 'caster');
  const lang = state.vdo?.lang || 'en-US';
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  return `${vdoBase()}/?room=${vdo.room}&push=${sid}&transcribe=${lang}&webcam&autostart${extra}#p=${vdo.password}`;
}
// Caster OBS feed — solo view of one caster from the shared caster room.
function buildCasterObsUrl(caster) {
  const vdo = state.casters?.vdo;
  if (!vdo || !vdo.room || !vdo.password) return caster.camUrl || '';
  const sid = vdoSlug(caster.streamId || caster.handle || caster.name || 'caster');
  const params = vdoViewParams(casterAudioOverride(caster));
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&solo${params ? '&' + params : ''}#p=${vdo.password}`;
}

function broadcast(clients, msg) {
  broadcastRaw(clients, JSON.stringify(msg));
}
// Send an already-serialized message string (lets callers stringify once and reuse it, e.g. the
// live-payload dedup in _flushFullState).
function broadcastRaw(clients, str) {
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  });
}

function formatTime(seconds) {
  if (seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// The live, frequently-changing payload sent on EVERY broadcast. Deliberately excludes the
// big control-panel-only libraries (savedTeams, brandKits) and the static champion list —
// those are sent separately so live broadcasts stay tiny and fluid during production.
// Live overlay browser sources connected to the WS bridge, by page — drives the pre-flight
// "overlays reachable" check (0 ⇒ no graphics will reach the stream). Cheap: a Set walk.
function overlayClientInfo() {
  let count = 0; const pages = {};
  for (const ws of bridgeClients) {
    if (ws._role === 'overlay') { count++; const p = ws._page || 'overlay'; pages[p] = (pages[p] || 0) + 1; }
  }
  return { count, pages };
}
let _lastOverlayCount = -1;
function maybeBroadcastOverlayCount() {
  const n = overlayClientInfo().count;
  if (n === _lastOverlayCount) return;       // only push when the count actually changes (avoid reconnect churn)
  _lastOverlayCount = n;
  broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
}

// Resolve the season/league record for one team name. Season W/L + points + placement
// come from the manually-managed league standings (state.leagues); "this week" W/L comes
// from the live start.gg event standings (state.bracket.standings). Returns null when the
// team isn't found in any league AND has no start.gg standing — overlay then shows nothing.
// source: 'stats' (in-app leagues) | 'startgg' (tournament platform league + live event).
function resolveOneTeamRecord(name, source) {
  const key = String(name == null ? '' : name).trim().toLowerCase();
  if (!key) return null;
  const out = { seasonW: null, seasonL: null, pts: null, place: null, weekW: null, weekL: null };
  const src = source || 'stats';

  // In-app manual league standings → season W/L, points, placement. Prefer a league for the
  // active game; fall back to the first league that contains a team with this name.
  if (src === 'stats') {
    const leagues = Array.isArray(state.leagues) ? state.leagues : [];
    const chosenId = (state.teamRecord && state.teamRecord.leagueId) || '';
    // Use the producer-selected league when set; otherwise auto-pick (active game first).
    const ordered = chosenId
      ? leagues.filter((l) => String(l.id) === String(chosenId))
      : leagues.slice().sort((a, b) => (b.game === state.activeGame ? 1 : 0) - (a.game === state.activeGame ? 1 : 0));
    for (const lg of ordered) {
      // League teams may be references ({id, teamName}) or copies ({id, name}) — match either.
      const team = (lg.teams || []).find((t) => String(t.teamName || t.name || '').trim().toLowerCase() === key);
      if (!team) continue;
      const st = (lg.standings || []).find((s) => s.teamId === team.id);
      if (st) {
        out.seasonW = st.w || 0;
        out.seasonL = st.l || 0;
        out.pts = st.pts || 0;
        const ranked = (lg.standings || []).slice().sort((a, b) =>
          (b.pts || 0) - (a.pts || 0) || ((b.w || 0) - (b.l || 0)) - ((a.w || 0) - (a.l || 0)));
        const idx = ranked.findIndex((s) => s.teamId === team.id);
        if (idx >= 0) out.place = idx + 1;
      } else { out.seasonW = 0; out.seasonL = 0; out.pts = 0; }
      // "This week" W/L, from the same in-app league's schedule — mirrors what the 'startgg'
      // source already provides via the live event standings, just sourced from lg.schedule instead.
      const weekSel = (state.teamRecord && state.teamRecord.week) || '';
      const targetWeek = weekSel || autoPickLatestCompletedWeek(lg);
      if (targetWeek) {
        const wkMatches = (lg.schedule || []).filter((m) =>
          String(m.week || '') === String(targetWeek) &&
          (m.teamA === team.id || m.teamB === team.id) &&
          m.result && m.result.scoreA != null && m.result.scoreB != null);
        let ww = 0, wl = 0;
        for (const m of wkMatches) {
          const isA = m.teamA === team.id;
          const mine = isA ? m.result.scoreA : m.result.scoreB;
          const theirs = isA ? m.result.scoreB : m.result.scoreA;
          if (mine > theirs) ww++; else if (theirs > mine) wl++;
        }
        out.weekW = ww; out.weekL = wl;
      }
      break;
    }
  }

  // Tournament platform (start.gg): LEAGUE standings → season points + placement, and the
  // live start.gg event standings → "this week" W/L (computed from played sets).
  if (src === 'startgg') {
    const lt = ((state.startggLeagueStandings && state.startggLeagueStandings.teams) || [])
      .find((t) => String(t.name || '').trim().toLowerCase() === key);
    if (lt) { if (lt.points != null) out.pts = lt.points; if (lt.place != null) out.place = lt.place; }
    const wk = (state.bracket && Array.isArray(state.bracket.standings) ? state.bracket.standings : [])
      .find((s) => String(s.name || '').trim().toLowerCase() === key);
    if (wk) { out.weekW = wk.wins || 0; out.weekL = wk.losses || 0; out.seasonW = out.seasonW ?? (wk.wins || 0); out.seasonL = out.seasonL ?? (wk.losses || 0); }
  }

  const hasAny = ['seasonW', 'pts', 'place', 'weekW'].some((k) => out[k] != null);
  return hasAny ? out : null;
}

// Format a resolved record into the single line the overlay shows, per the chosen metric.
function formatTeamRecord(rec, metric) {
  if (!rec) return '';
  const dot = ' ' + String.fromCharCode(0xB7) + ' ';
  const season = (rec.seasonW != null) ? `${rec.seasonW}-${rec.seasonL}` : '';
  const week = (rec.weekW != null) ? `${rec.weekW}-${rec.weekL}` : '';
  const pts = (rec.pts != null) ? `${rec.pts} PTS` : '';
  const place = (rec.place != null) ? `#${rec.place}` : '';
  switch (metric) {
    case 'week':  return week;
    case 'pts':   return pts;
    case 'place': return place;
    case 'record-pts': return [season, pts].filter(Boolean).join(dot);
    case 'season':
    default:      return season;
  }
}

// Tiny per-broadcast blob of the resolved records for the two live teams (no logos/blobs).
function resolveTeamRecords() {
  const tr = state.teamRecord || {};
  const source = tr.source || 'stats';
  if (!tr.enabled) return { enabled: false, source, metric: tr.metric || 'season', leagueId: tr.leagueId || '', blue: '', orange: '', rawBlue: {}, rawOrange: {} };
  const metric = tr.metric || 'season';
  const numOrNull = (v) => (v == null || v === '' || isNaN(v)) ? null : Number(v);
  const recFor = (side, name) => {
    if (source === 'manual') {
      // Keyed by team NAME ONLY, so the record is tied to the team profile and follows it across side
      // swaps/reassignments. (NO side-keyed fallback — that pinned records to Blue/Orange and was
      // exactly why they didn't switch. Legacy records are migrated to manualByName once on load.)
      const m = (tr.manualByName && tr.manualByName[(name || '').trim().toLowerCase()]) || {};
      const w = numOrNull(m.w), l = numOrNull(m.l);
      return { seasonW: w, seasonL: l, weekW: w, weekL: l, pts: numOrNull(m.pts), place: numOrNull(m.place) };
    }
    return resolveOneTeamRecord(name, source) || {};
  };
  const fmt = (rec) => (['seasonW', 'pts', 'place'].some((k) => rec[k] != null)) ? formatTeamRecord(rec, metric) : '';
  const raw = (rec) => ({ w: rec.seasonW ?? null, l: rec.seasonL ?? null, pts: rec.pts ?? null, place: rec.place ?? null });
  const bRec = recFor('blue', state.teams.blue && state.teams.blue.name);
  const oRec = recFor('orange', state.teams.orange && state.teams.orange.name);
  return {
    enabled: true, source, metric, leagueId: tr.leagueId || '',
    blue: fmt(bRec), orange: fmt(oRec),
    rawBlue: raw(bRec), rawOrange: raw(oRec)   // per-side numbers so the team boxes can prefill/edit
  };
}

// Derive the active preset's config for each scene — small flat object broadcast to overlays.
function buildSceneConfig() {
  const out = {};
  for (const [key, sp] of Object.entries(state.scenePresets || {})) {
    const cfg = ((sp.presets || {})[sp.active || 'Default'] || {}).config || {};
    if (Object.keys(cfg).some((k) => cfg[k])) out[key] = cfg;
  }
  return out;
}

// ── Broadcast tier schema ────────────────────────────────────────────────────
// Every top-level key of the broadcast payload must be declared here:
//   'live'    — rides EVERY broadcast. Keep it small: no base64, no libraries.
//   'library' — heavy / rarely-changing; travels via libraryData() (on connect + on
//               change, gated by librarySig — a new library key MUST also be signed).
//   'local'   — server-only; never broadcast.
// An undeclared key still broadcasts (so nothing breaks) but warns loudly once per key.
// That warning is the tripwire: payload bloat used to creep in silently because the old
// spread-then-denylist defaulted every new state key straight onto the wire (~600KB/broadcast
// at its worst — leagues alone carried 368KB of base64 logos into every goal update).
const BROADCAST_TIERS = {
  // heavy libraries → libraryData()
  bracket: 'library', replay: 'library', playerProfiles: 'library',
  leagues: 'library', clips: 'library', brand: 'library', eventOps: 'library',
  // server-only (overlays get the derived sceneConfig instead)
  scenePresets: 'local',
  // live production/scoreboard state (from the state literal)
  version: 'live', view: 'live', rlHudHidden: 'live', perfMode: 'live', cloudRole: 'live', activeGame: 'live', themesByGame: 'live',
  eventName: 'live', gameLabel: 'live', roundLabel: 'live', speedUnit: 'live', fontFamily: 'live',
  clock24h: 'live', showSeries: 'live', defaultBestOf: 'live', facecamsEnabled: 'live',
  replayCams: 'live', activeBrandKitId: 'live', useBrandColors: 'live', colorMode: 'live',
  sceneBg: 'live', banner: 'live', casters: 'live', vdo: 'live', listenIn: 'live', credits: 'live',
  breakScreen: 'live', ticker: 'live', adProofSessions: 'live', spotlight: 'live', winner: 'live',
  veto: 'live', owMatch: 'live', mrMatch: 'live', customOverlayLayouts: 'live', gameConfigs: 'live', draft: 'live',
  intro: 'live', overtime: 'live', scoreboardAd: 'live', rlStatsScreen: 'live', background: 'live', deskFooter: 'live',
  preshow: 'live', csgo: 'live', valorant: 'live', lol: 'live', bestOf: 'live', teams: 'live',
  teamPlayers: 'live', series: 'live', match: 'live', myEvents: 'live', game: 'live',
  gameTeams: 'live', players: 'live', playerCache: 'live', currentGoal: 'live',
  spectatedPlayer: 'live', rlConnected: 'live', rlSpectatorUi: 'live', startgg: 'live',
  challonge: 'live', nxgen: 'live', activeEvent: 'live', obs: 'live', vmix: 'live',
  switcher: 'live', commercial: 'live', upcoming: 'live', standings: 'live', teamRecord: 'live',
  autoTeamsFromGame: 'live', startggLeagueStandings: 'live', gfxActive: 'live', watchlist: 'live',
  teamSpotlight: 'live', director: 'live', ai: 'live', encode: 'live', twitch: 'live',
  discord: 'live', flows: 'live', flowVars: 'live',
  // runtime-added state keys (mirrored in libraryData where noted)
  crew: 'live',            // also in libraryData — overlays read it live, panel backfills it
  socialPreset: 'live',    // also in libraryData
  awaitingKickoff: 'live', inReplay: 'live', otTriggered: 'live', rlBall: 'live',
  scoreboard: 'live', showRoster: 'live', sponsorBanner: 'live', preshowPresets: 'live',
  playerProfilesVer: 'live',
  // derived keys buildLiveState() adds on top of state
  games: 'live', vetoPools: 'live', vetoMeta: 'live', draftGames: 'live', theme: 'live',
  activeOverlay: 'live', overlayLayout: 'live', presets: 'live', facecams: 'live',
  formattedTime: 'live', teamRecords: 'live', flowFireLog: 'live', autoLog: 'live',
  overlays: 'live', sceneConfig: 'live'
};
const _untieredWarned = new Set();
function stripByTier(payload) {
  for (const k of Object.keys(payload)) {
    const tier = BROADCAST_TIERS[k];
    if (tier === 'library' || tier === 'local') { payload[k] = undefined; continue; }
    if (!tier && !_untieredWarned.has(k)) {
      _untieredWarned.add(k);
      console.warn(`[broadcast] state.${k} has NO BROADCAST_TIERS entry — it is riding every live broadcast. Declare it 'live', 'library' or 'local' in server.js BROADCAST_TIERS.`);
    }
  }
  return payload;
}

function buildLiveState() {
  const publicStartgg = { ...state.startgg, hasToken: !!startggApiToken };
  const publicChallonge = { ...state.challonge, hasKey: !!challongeApiKey };
  const publicNxgen = { ...state.nxgen, hasKey: !!nxgenApiKey };
  const publicObs = { ...state.obs, hasPassword: !!obsPassword };
  const publicDiscord = {
    connected: state.discord.connected,
    userId: state.discord.userId,
    username: state.discord.username,
    discriminator: state.discord.discriminator,
    globalName: state.discord.globalName,
    avatarUrl: state.discord.avatarUrl,
    lastError: state.discord.lastError || ''
  };
  // Effective side colours for the active mode — overlays read teams.x.color; the control
  // panel can still see each team's own colour via teams.x.ownColor.
  const eff = effectiveTeamColors();
  // Heavy / rarely-changing keys (bracket ≈ 0.9MB logos, replay ≈ 0.4MB thumbnails, leagues,
  // clips, the raw brand fallback…) are stripped by stripByTier() per BROADCAST_TIERS above and
  // re-sent only on change via libraryData(). Clients backfill from the last library snapshot.
  return stripByTier({
    ...state,
    teams: {
      blue:   { ...state.teams.blue,   color: eff.blue,   ownColor: state.teams.blue.color },
      orange: { ...state.teams.orange, color: eff.orange, ownColor: state.teams.orange.color }
    },
    colorMode: state.colorMode || 'team',
    cloudRole: currentCloudRole(),   // org-seat role (null = local/full access) — drives view-only UX
    startgg: publicStartgg,
    challonge: publicChallonge,
    nxgen: publicNxgen,
    activeEvent: state.activeEvent,
    obs: publicObs,
    discord: publicDiscord,
    games: (function() {
      const out = {};
      const custom = state.customOverlayLayouts || {};
      Object.keys(GAMES).forEach((id) => {
        const extra = custom[id] || [];
        out[id] = extra.length ? { ...GAMES[id], themes: GAMES[id].themes.concat(extra) } : GAMES[id];
      });
      return out;
    })(),
    customOverlayLayouts: state.customOverlayLayouts || {},
    gameConfigs: state.gameConfigs || {},
    vetoPools: vetoData.mergedMapPools(state.gameConfigs),   // per-game map pools, built-in + active Game Config merged by id
    vetoMeta: vetoData.VETO_META,    // per-game terminology (map/stage, Ban/Strike)
    draftGames: draftData.draftGames(),   // games with a champion-draft format
    theme: state.themesByGame[state.activeGame] || migrateThemeId(state.activeGame, 'default'),
    activeOverlay: activeOverlayPath(state.activeGame),
    overlayLayout: resolveOverlayLayout(state.activeGame, state.themesByGame[state.activeGame]),
    presets: savedPresets.map((p) => ({ id: p.id, name: p.name, game: p.game })),
    facecams: savedFacecams,
    formattedTime: formatTime(state.game.time),
    teamRecords: resolveTeamRecords(),   // resolved season/league record line per side (tiny)
    flows: state.flows || [],
    flowVars: state.flowVars || {},
    flowFireLog: _flowFireLog,
    autoLog: _autoLog,   // unified automation timeline (What's Armed panel)
    showRoster: state.showRoster || [],
    background: state.background,
    overlays: overlayClientInfo(),   // live overlay browser-source count for the pre-flight checklist
    sceneConfig: buildSceneConfig()  // active preset config per scene, applied by SceneBase.applySceneConfig
  });
}

// Heavy blobs that change rarely → sent on connect, then re-sent only when they change.
//   savedTeams / brandKits: control-panel libraries (base64 logos, tens-to-hundreds of KB).
//   brand / banner / mainBanner: derived from the active brand kit (base64 sponsor + banner
//     images, ~1MB) and read by overlays too — both sides backfill these when a light broadcast
//     omits them. This keeps live broadcasts at a few hundred bytes instead of ~2.6MB.
// Merge profile data for one player into the registry (ignores empty fields).
let playerProfilesVer = 0;
// Bumped on every leagues/clips mutation so librarySig re-sends them without stringifying
// their base64 payloads per broadcast.
let leaguesVer = 0;
let clipsVer = 0;
let eventOpsVer = 0;   // bumped on Event Ops roster/seed mutations (library-tier re-send)
function upsertPlayerProfile(gamerTag, patch) {
  const key = (gamerTag || '').trim().toLowerCase();
  if (!key || !patch) return;
  if (!state.playerProfiles) state.playerProfiles = {};
  const cur = state.playerProfiles[key] || { gamerTag };
  const next = { ...cur, gamerTag: cur.gamerTag || gamerTag };
  if (patch.startggSlug) next.startggSlug = String(patch.startggSlug).slice(0, 160);
  if (patch.startggPlayerId) next.startggPlayerId = String(patch.startggPlayerId).slice(0, 40);
  if (patch.twitch) next.twitch = String(patch.twitch).slice(0, 80);
  if (patch.twitter) next.twitter = String(patch.twitter).slice(0, 80);
  if (patch.country) next.country = String(patch.country).slice(0, 80);
  if (patch.countryCode) next.countryCode = String(patch.countryCode).slice(0, 4).toLowerCase();
  if (patch.image) next.image = String(patch.image).slice(0, 400);   // start.gg profile image URL
  if (patch.realName) next.realName = String(patch.realName).slice(0, 160); // start.gg display/legal name
  // Producer-verified tracker.gg account (platform + username) — start.gg rarely gives us the connected
  // account, so once someone corrects/confirms the handle we remember it here keyed on gamerTag and
  // prefill it on future events instead of falling back to the tournament gamerTag.
  if (patch.tracker && patch.tracker.username) {
    next.tracker = {
      platform: String(patch.tracker.platform || 'epic').slice(0, 20).toLowerCase(),
      username: String(patch.tracker.username).slice(0, 80)
    };
  }
  if (patch.sixmans) {
    const s = patch.sixmans;
    next.sixmans = {
      ...(cur.sixmans || {}),
      name: String(s.name || (cur.sixmans && cur.sixmans.name) || '').slice(0, 80),
      elo: (s.elo != null && !isNaN(s.elo)) ? Number(s.elo) : (cur.sixmans && cur.sixmans.elo) || null,
      rank: String(s.rank || (cur.sixmans && cur.sixmans.rank) || '').slice(0, 10),
      region: String(s.region || (cur.sixmans && cur.sixmans.region) || '').slice(0, 6),
      platform: String(s.platform || (cur.sixmans && cur.sixmans.platform) || '').slice(0, 10),
    };
  }
  next.updatedAt = Date.now();
  state.playerProfiles[key] = next;
  playerProfilesVer++;
  // Write-through to the persistent player DB so data survives state resets
  playerDb.upsert(gamerTag, { displayName: next.gamerTag, realName: next.realName || null, startggSlug: next.startggSlug || null, startggId: next.startggPlayerId || null, sixmans: next.sixmans || null, twitch: next.twitch || null, twitter: next.twitter || null, country: next.country || null, countryCode: next.countryCode || null, image: next.image || null });
}

function libraryData() {
  return {
    savedTeams,
    playerProfiles: state.playerProfiles || {},   // per-player start.gg + 6mans links
    brandKits: savedBrandKits,
    brandKitsVer,                                 // lets the client detect ANY brand-kit change cheaply
    // Active kit wins; with no kit, fall back to the producer's global accent colour
    // (Settings ▸ Appearance, set_global_accent) so that control actually reaches overlays.
    brand: activeBrand() || ((state.brand && state.brand.color) ? { color: state.brand.color, accent: state.brand.accent || null } : null),
    socialPreset: state.socialPreset || null,      // Social Export background/presented-by, when no brand kit is active
    banner: bannerForBroadcast(),
    mainBanner: state.banner,
    bracket: state.bracket,   // manual bracket (embedded team logos) — backfilled by bracket overlay + panel
    replay: state.replay,     // replay-monitor thumbnails — backfilled by the replays page
    crew: state.crew || [],   // unified crew profiles (hosts/guests/casters/observers)
    leagues: state.leagues || [],   // league rosters/standings (base64 team logos) — control panel only
    clips: state.clips || null,     // clip/playlist library metadata — control panel only (live pushes go via clips_update)
    eventOps: state.eventOps || { rows: [], seeds: [] }   // Event Ops CSV roster + true seeds — control panel only
  };
}
// Static config that never changes after startup → sent on connect only.
function staticData() {
  return { draftRosters: draftData.mergedRosters(state.gameConfigs) };   // per-game champion/hero rosters (id/name/portrait), built-in + active Game Config merged by id
}
// Cheap signature (no base64 stringify — only lengths/counts) to detect library changes between
// broadcasts. Captures team name/colour/logo/roster and brand name/colours/logo/sponsors/banners.
function librarySig() {
  const t = savedTeams.map((t) => {
    const logoFp = t.logo ? (t.logo.slice(20, 44) + ':' + t.logo.length) : '0';
    const pSig = (t.players || []).map(p => (p.name || '') + ':' + ((p.photo || p.image || '').slice(20, 44))).join(';');
    return t.name + ':' + (t.color || '') + ':' + logoFp + ':' + pSig;
  }).join(',');
  const b = savedBrandKits.map((k) => {
    const pkg = activePackage(k) || {};
    const sp = (pkg.sponsors || []).reduce((a, s) => a + ((s && s.logo || '').length) + ((s && s.name || '').length), 0);
    const bn = (pkg.bannerImages || []).reduce((a, img) => a + ((img || '').length), 0);
    const pl = (pkg.sponsors || []).map((s) => SPONSOR_SPOTS.filter((spot) => s.placements && s.placements[spot]).join('+')).join(',');
    return k.id + ':' + (k.name || '') + ':' + (k.color || '') + ':' + (k.accent || '') + ':' + (k.logo ? k.logo.length : 0)
      + ':' + (k.activePackageId || '') + ':' + ((k.packages || []).length)
      + ':' + (pkg.sponsors || []).length + ':' + sp + ':' + bn + ':' + pl;
  }).join(',');
  // …plus active-kit selection + banner toggle/images so brand/banner/mainBanner re-send when they change.
  const bn = (state.banner.images || []).reduce((a, i) => a + ((i || '').length), 0);
  // bracket + replay carry big base64 logos/thumbnails — sign their STRUCTURE + scalar fields but
  // collapse any long string to its length so we never stringify the base64 (this runs per-broadcast).
  const lite = (o) => { try { return JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 200) ? ('len' + v.length) : v) || ''; } catch { return ''; } };
  const sp = state.socialPreset || {};
  const extra = '|ab:' + (state.activeBrandKitId || '') + '|bv:' + (state.banner.visible ? 1 : 0) + '|bi:' + bn
    + '|brk:' + lite(state.bracket) + '|rpl:' + lite(state.replay) + '|crew:' + (state.crew || []).length
    + '|pp:' + playerProfilesVer + '|bk:' + brandKitsVer + '|st:' + savedTeamsVer
    + '|lgv:' + leaguesVer + '|clv:' + clipsVer + '|eov:' + eventOpsVer
    // Global accent fallback lives in library brand now (stripped from live) — re-send on change.
    + '|gac:' + ((state.brand && state.brand.color) || '') + ':' + ((state.brand && state.brand.accent) || '')
    + '|sp:' + (sp.bgImageUrl ? sp.bgImageUrl.length : 0) + ':' + (sp.presentedByEnabled ? 1 : 0) + ':' + (sp.bgStyle || '');
  return savedTeams.length + '#' + t + '||' + savedBrandKits.length + '#' + b + extra;
}

// Full payload (live + static + library) — sent on connect and on request_state so a client
// starts with everything; later broadcasts stay light and the client backfills the rest.
function getFullState() {
  return { type: 'full_state', data: { ...buildLiveState(), ...staticData(), ...libraryData() } };
}

function extractEntrantPlayers(name) {
  if (!name) return [];
  return name
    .split(/\s*\/\s*|\s*&\s*|\s*,\s*/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

// Normalize a pasted start.gg league reference into the bare slug the API wants.
// Accepts a full URL (https://www.start.gg/league/<slug>) or a "league/<slug>" / "<slug>" form.
function normalizeLeagueSlug(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/start\.gg\/league\/([^/?#]+)/i);
  if (m) return m[1];
  s = s.replace(/^https?:\/\/[^/]+\//i, '');   // strip any host
  s = s.replace(/^league\//i, '');             // strip a leading league/
  return s.split(/[/?#]/)[0];
}

// Fetch season standings (placement + league points) for a start.gg LEAGUE. Tries the bare
// slug first, then the "league/<slug>" form (start.gg accepts the latter for some leagues).
async function fetchLeagueStandings(rawSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token');
  const slug = normalizeLeagueSlug(rawSlug);
  if (!slug) throw new Error('Missing league slug');
  const client = createStartGgClient(startggApiToken);
  const query = `query LeagueStandings($slug:String!){
    league(slug:$slug){ id name
      standings(query:{page:1,perPage:200}){ nodes{ placement totalPoints entrant{ id name } } } } }`;
  let league = null;
  for (const candidate of [slug, 'league/' + slug]) {
    const res = await client.request(query, { slug: candidate });
    if (res && res.league) { league = res.league; break; }
  }
  if (!league) throw new Error('League not found (check the slug/URL)');
  const teams = ((league.standings && league.standings.nodes) || [])
    .filter((n) => n && n.entrant && n.entrant.name)
    .map((n) => ({ name: n.entrant.name, place: n.placement || null, points: (typeof n.totalPoints === 'number') ? n.totalPoints : null }))
    .sort((a, b) => (a.place || 9999) - (b.place || 9999));
  return { name: league.name || '', teams };
}

// ── start.gg league search + sync helpers ─────────────────────────────────

async function searchStartggLeagues(name) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token');
  const client = createStartGgClient(startggApiToken);
  const data = await client.request(
    `query SearchLeagues($name:String){leagues(query:{filter:{name:$name},perPage:10}){nodes{id name slug}}}`,
    { name }
  );
  return ((data && data.leagues && data.leagues.nodes) || []).filter(Boolean);
}

// Lightweight league info: name + tournament list (no sets).
async function fetchLeagueInfo(rawSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token');
  const slug = normalizeLeagueSlug(rawSlug);
  if (!slug) throw new Error('Missing league slug');
  const client = createStartGgClient(startggApiToken);
  const query = `query LeagueInfo($slug:String!){
    league(slug:$slug){
      id name slug
      tournaments(query:{perPage:50,sortBy:"startAt asc"}){
        nodes{id name slug startAt numAttendees}
      }
    }
  }`;
  let league = null;
  for (const candidate of [slug, 'league/' + slug]) {
    try {
      const data = await client.request(query, { slug: candidate });
      if (data && data.league) { league = data.league; break; }
    } catch (_) {}
  }
  if (!league) throw new Error('League not found (check the slug/URL)');
  return {
    id: league.id,
    name: league.name || '',
    slug,
    tournaments: ((league.tournaments && league.tournaments.nodes) || []).filter(Boolean)
  };
}

// Fetch completed sets for a single tournament, used during league sync.
async function fetchTournamentSets(tournamentSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token');
  const client = createStartGgClient(startggApiToken);
  const data = await client.request(
    `query TournamentSets($slug:String!){
      tournament(slug:$slug){
        id name startAt
        events{
          id name
          sets(filters:{state:3},perPage:100){
            nodes{id displayScore winnerId fullRoundText slots{entrant{id name}}}
          }
        }
      }
    }`,
    { slug: tournamentSlug }
  );
  const t = data && data.tournament;
  if (!t) throw new Error('Tournament not found: ' + tournamentSlug);
  return { id: t.id, name: t.name || '', startAt: t.startAt || null, events: (t.events || []).filter(Boolean) };
}

// Highest schedule week where every match has a recorded result — used as the default "this week"
// for team-record weekW/weekL when the producer hasn't picked an explicit week.
function autoPickLatestCompletedWeek(lg) {
  const sched = (lg && lg.schedule) || [];
  const weeks = [...new Set(sched.map((m) => String(m.week || '')).filter(Boolean))];
  const completed = weeks.filter((wk) =>
    sched.filter((m) => String(m.week || '') === wk).every((m) => m.result && m.result.scoreA != null && m.result.scoreB != null));
  if (!completed.length) return '';
  completed.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  return completed[completed.length - 1];
}

// Resolve a schedule match's series score (games won per side) + real per-side totals — mirrors
// client-side lgMatchTally. When a per-game breakdown (m.games) is provided, the series score is
// derived by counting games won and totals are summed from the individual game scores; otherwise
// both come directly from the single result.scoreA/scoreB entry (the breakdown is optional).
function srvLgMatchTally(m) {
  const r = m.result || {};
  const hasGames = Array.isArray(m.games) && m.games.length > 0;
  if (hasGames) {
    let sa = 0, sb = 0, totA = 0, totB = 0;
    for (const g of m.games) {
      const ga = Number(g.scoreA) || 0, gb = Number(g.scoreB) || 0;
      totA += ga; totB += gb;
      if (ga > gb) sa++; else if (gb > ga) sb++;
    }
    return { sa, sb, totA, totB };
  }
  const sa = Number(r.scoreA) || 0, sb = Number(r.scoreB) || 0;
  return { sa, sb, totA: sa, totB: sb };
}

// Server-side standings recalc — mirrors client-side lgComputeStandingsFromSchedule/lgAggregateFromSchedule.
function lgRecalcServer(lg) {
  const sc = lg.scoring || {};
  const ptWin = sc.win ?? 3, ptLoss = sc.loss ?? 0, ptDraw = sc.draw ?? 1, ptOtw = sc.otw ?? ptWin;
  const map = {};
  (lg.teams || []).forEach(tm => { map[tm.id] = { teamId: tm.id, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0 }; });
  for (const m of (lg.schedule || [])) {
    const r = m.result;
    const hasGames = Array.isArray(m.games) && m.games.length > 0;
    if (!hasGames && (!r || r.scoreA == null || r.scoreB == null)) continue;
    const a = map[m.teamA], b = map[m.teamB]; if (!a || !b) continue;
    const { sa, sb, totA, totB } = srvLgMatchTally(m);
    a.gf += totA; a.ga += totB; b.gf += totB; b.ga += totA;
    const winPts = (r && r.ot) ? ptOtw : ptWin;
    if (sa > sb) { a.w++; a.pts += winPts; b.l++; b.pts += ptLoss; }
    else if (sb > sa) { b.w++; b.pts += winPts; a.l++; a.pts += ptLoss; }
    else { a.t++; a.pts += ptDraw; b.t++; b.pts += ptDraw; }
  }
  lg.standings = Object.values(map);
}

let _srvLgUidC = Date.now();
function srvLgUid(prefix) { return prefix + '-' + (++_srvLgUidC).toString(36); }

// Reject oversized base64 logos (league or per-team) rather than silently persisting/broadcasting
// them — leagues is a 'library' broadcast tier item re-sent on every leaguesVer bump, and giant
// embedded images here previously cost hundreds of KB per broadcast before tiering existed.
const LEAGUE_LOGO_MAX_BYTES = 500 * 1024;
function _capLogoField(obj, key) {
  const v = obj && obj[key];
  if (typeof v !== 'string' || !v.startsWith('data:')) return;
  const approxBytes = Math.floor(v.length * 0.75); // base64 payload is ~4/3 the decoded byte size
  if (approxBytes > LEAGUE_LOGO_MAX_BYTES) {
    obj[key] = null;
    obj._logoWarning = 'Logo removed — file was too large (' + Math.round(approxBytes / 1024) + 'KB, max ' + Math.round(LEAGUE_LOGO_MAX_BYTES / 1024) + 'KB).';
  }
}
function capLeagueLogo(lg) {
  _capLogoField(lg, 'logo');
  (lg.teams || []).forEach((tm) => _capLogoField(tm, 'logo'));
  return lg;
}

// Backfill defaults for fields added to the league shape over time, so every league object is
// fully-formed regardless of when/how it entered state (disk load, profile import, set_leagues).
// Idempotent — safe to call repeatedly on an already-migrated league.
function migrateLeague(lg) {
  if (!lg || typeof lg !== 'object') return lg;
  if (!lg.id) lg.id = srvLgUid('lg');
  if (!lg.status) lg.status = 'active';
  if (!lg.type) lg.type = 'team';
  lg.scoring = { win: 3, loss: 0, draw: 1, otw: 2, ...(lg.scoring && typeof lg.scoring === 'object' ? lg.scoring : {}) };
  if (!lg.tiebreak) lg.tiebreak = 'gd';
  if (typeof lg.starterCount !== 'number') lg.starterCount = 3;
  if (typeof lg.playoffN !== 'number') lg.playoffN = 4;
  if (typeof lg.abbr !== 'string') lg.abbr = '';
  if (!Array.isArray(lg.teams)) lg.teams = [];
  if (!Array.isArray(lg.freeAgents)) lg.freeAgents = [];
  if (!Array.isArray(lg.standings)) lg.standings = [];
  if (!Array.isArray(lg.schedule)) lg.schedule = [];
  if (!Array.isArray(lg.seasonHistory)) lg.seasonHistory = [];
  lg.teams.forEach((tm) => { if (tm && !tm.id) tm.id = srvLgUid('tm'); });
  lg.schedule.forEach((m) => { if (m && !Array.isArray(m.games)) m.games = []; });
  return capLeagueLogo(lg);
}

async function testStartGgConnection() {
  if (!startggApiToken) {
    throw new Error('Missing Start.gg API token');
  }

  const client = createStartGgClient(startggApiToken);
  const query = `
    query TestStartggConnection {
      currentUser {
        id
        slug
      }
    }
  `;

  const res = await client.request(query);
  const user = res?.currentUser;
  if (!user) {
    throw new Error('Invalid Start.gg token or API response');
  }

  return user;
}

// Close out the current series (stats match + scores + game number) — shared by the
// reset_series WS case and the start.gg push/auto-follow paths, so advancing to the
// next set never carries the previous match's score or game number onto the overlay.
function finalizeAndResetSeries() {
  if (statsCurrentMatchId) {
    stats.endMatch(statsCurrentMatchId, {
      scoreA: state.series.blue,
      scoreB: state.series.orange,
      winner: state.series.blue > state.series.orange ? 'a'
            : state.series.orange > state.series.blue ? 'b' : null
    });
    try { analytics.event('match_complete'); } catch (e) {}
  }
  statsCurrentMatchId = null;
  statsCurrentGameId  = null;
  statsCs2GameId      = null;
  statsValGameId      = null;
  state.game.number = 1;
  state.series.blue = 0;
  state.series.orange = 0;
  // Clear OW map winners so the next match recounts from a clean slate.
  if (state.owMatch) state.owMatch.mapWinners = [];
}

async function syncStartGgSet(setId) {
  if (!startggApiToken) {
    throw new Error('Missing Start.gg API token');
  }
  if (!setId) {
    throw new Error('Missing Start.gg set ID');
  }

  const client = createStartGgClient(startggApiToken);
  const query = `
    query SyncStartggSet($setId: ID!) {
      set(id: $setId) {
        id
        fullRoundText
        slots {
          entrant {
            id
            name
            team { images { url type } }
          }
        }
      }
    }
  `;

  const res = await client.request(query, { setId });
  const set = res?.set;
  if (!set) {
    throw new Error('Set not found');
  }

  // Advancing to a DIFFERENT set: close out and reset the previous series first
  // (same as the bracket builder's Go Live). Re-pushing the same set keeps the
  // in-progress score untouched.
  if (String(state.startgg.lastPushedSetId || '') !== String(setId)) {
    finalizeAndResetSeries();
  }

  const entrants = (set.slots || [])
    .map(slot => slot?.entrant)
    .filter(Boolean);
  indexEntrantLogos(entrants);

  const blueEntrant = entrants[0];
  const orangeEntrant = entrants[1];

  if (blueEntrant) {
    state.teams.blue.name = (blueEntrant.name || 'BLUE TEAM').toUpperCase();
  }
  if (orangeEntrant) {
    state.teams.orange.name = (orangeEntrant.name || 'ORANGE TEAM').toUpperCase();
  }

  // Auto-update the overlay round/stage label from this set's bracket round (e.g. "Winners Finals"),
  // so it tracks the teams whenever a set is pushed onto the overlay (auto-follow or manual). Only
  // overwrite when the set actually carries a round, so a set without one doesn't blank a manual label.
  if (set.fullRoundText) state.roundLabel = String(set.fullRoundText).toUpperCase();

  // Auto-apply logos/rosters — the activated event's REAL rosters (eventTeams) first, then
  // the local team library, matching the autofill_stream_teams precedence so Push and
  // Auto-fill produce the same result. Always reset both first so a stale logo OR roster
  // from the previous push never silently carries over onto the new team.
  let gotRealRoster = false;
  [['blue', blueEntrant], ['orange', orangeEntrant]].forEach(([side, ent]) => {
    const tn = (state.teams[side].name || '').toUpperCase();
    state.teams[side].logo = '';
    state.teams[side].players = [];
    const et = (state.startgg.eventTeams || []).find((t) => (t.name || '').toUpperCase() === tn);
    const saved = savedTeams.find((t) => (t.name || '').toUpperCase() === tn);
    const src = (et && Array.isArray(et.players) && et.players.length) ? et
              : (saved && Array.isArray(saved.players) && saved.players.length) ? saved
              : (et || saved || null);
    if (src) {
      if (src.logo) state.teams[side].logo = src.logo;
      if (Array.isArray(src.players) && src.players.length) {
        state.teams[side].players = src.players;
        gotRealRoster = true;
      }
    }
    if (!state.teams[side].logo) {
      const logo = pickEntrantLogo(ent) || logoForTeamName(state.teams[side].name);
      if (logo) state.teams[side].logo = logo;
    }
  });

  if (gotRealRoster) {
    // Real rosters landed on the team cards — mirror them into the flat overlay list.
    rebuildCombinedPlayers();
  } else {
    // No roster found anywhere: fall back to splitting the entrant NAME. This is only
    // meaningful for doubles-style entrants ("A / B"); a plain team-name entrant would
    // produce a bogus one-player roster named after the team, so skip that case.
    const bluePlayers = extractEntrantPlayers(blueEntrant?.name).map((name) => ({
      name, primaryid: null, team: 0, score: 0, goals: 0, assists: 0, saves: 0,
      shots: 0, demos: 0, boost: 0, isPrimary: false, isDemolished: false
    }));
    const orangePlayers = extractEntrantPlayers(orangeEntrant?.name).map((name) => ({
      name, primaryid: null, team: 1, score: 0, goals: 0, assists: 0, saves: 0,
      shots: 0, demos: 0, boost: 0, isPrimary: false, isDemolished: false
    }));
    const looksLikeNameList = bluePlayers.length > 1 || orangePlayers.length > 1;
    const combinedPlayers = [...bluePlayers, ...orangePlayers];
    if (looksLikeNameList && combinedPlayers.length > 0) {
      state.players = combinedPlayers;
      state.playerCache = {};
      combinedPlayers.forEach((p) => {
        state.playerCache[p.name] = { ...p };
      });
    }
  }

  state.startgg.lastSyncAt = new Date().toISOString();
  state.startgg.lastSyncStatus = 'ok';
  state.startgg.lastError = null;
  saveAppState();
  broadcastFullState();

  return {
    setId: set.id,
    fullRoundText: set.fullRoundText || '',
    entrants: entrants.map(e => e.name).filter(Boolean)
  };
}

// Rebuild the overlay's flat `state.players` list from the two team rosters
// (used after assigning rosters out of band, e.g. autofill from the stream queue).
function rebuildCombinedPlayers() {
  const toP = (p, team) => ({
    name: (p.name || '').toString(),
    primaryid: p.primaryid || null,
    team, score: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, boost: 0,
    isPrimary: false, isDemolished: false
  });
  const blue = (state.teams.blue.players || []).map((p) => toP(p, 0));
  const orange = (state.teams.orange.players || []).map((p) => toP(p, 1));
  const combined = [...blue, ...orange];
  if (combined.length) {
    state.players = combined;
    state.playerCache = {};
    combined.forEach((p) => { state.playerCache[p.name] = { ...p }; });
  }
}

function mapStartggSetToFeedItem(set, extra) {
  const slots = (set && set.slots) || [];
  const vA = slots[0]?.standing?.stats?.score?.value;
  const vB = slots[1]?.standing?.stats?.score?.value;
  let scoreA = typeof vA === 'number' && vA >= 0 ? vA : (typeof set.scoreA === 'number' && set.scoreA >= 0 ? set.scoreA : null);
  let scoreB = typeof vB === 'number' && vB >= 0 ? vB : (typeof set.scoreB === 'number' && set.scoreB >= 0 ? set.scoreB : null);
  const st = Number(set.state);
  let status = 'upcoming';
  if (extra?.live || st === 2) status = 'live';
  else if (st === 3) status = 'done';
  const teamA = (set.teamA || slots[0]?.entrant?.name || 'TBD').toString();
  const teamB = (set.teamB || slots[1]?.entrant?.name || 'TBD').toString();
  // start.gg quirks the standing scores can't express on their own:
  //   -1 = DQ/forfeit; null + a winnerId = reported winner-only. displayScore
  //   ("Team A 2 - Team B 1" or "DQ") is the reliable human-entered fallback.
  const ds = (set.displayScore || '').toString().trim();
  const dq = vA === -1 || vB === -1 || /^dq$/i.test(ds);
  let winSide = null;
  const winnerId = set.winnerId != null ? String(set.winnerId) : '';
  if (winnerId) {
    if (String(slots[0]?.entrant?.id || '') === winnerId) winSide = 'a';
    else if (String(slots[1]?.entrant?.id || '') === winnerId) winSide = 'b';
  }
  if (status === 'done' && !dq && (scoreA == null || scoreB == null) && ds && ds !== 'DQ') {
    // Parse "Name A 2 - Name B 1" (names may contain anything; scores are the
    // final digit runs on each side of the last " - ").
    const m = ds.match(/(\d+)\s+-\s+.*?(\d+)$/) || ds.match(/(\d+)\s*-\s*(?:.*\s)?(\d+)$/);
    if (m) { scoreA = Number(m[1]); scoreB = Number(m[2]); }
  }
  return {
    setId: String(set.id || set.setId || ''),
    round: (set.fullRoundText || set.round || '').toString(),
    teamA, teamB,
    scoreA, scoreB,
    dq,
    winSide,
    status,
    stream: (extra?.stream || set.stream || '').toString(),
    // Logo URLs (from the start.gg name->logo map — kept tiny, no base64 in the broadcast).
    logoA: state.startgg.logoMap[teamA.trim().toLowerCase()] || '',
    logoB: state.startgg.logoMap[teamB.trim().toLowerCase()] || ''
  };
}

// Format the start.gg match feed into ticker scorelines: "LIVE   Team A  2-1  Team B".
// start.gg has no mid-set scores until games are reported, so a scoreless live set reads
// "A vs B" instead of a fake 0-0; DQ/forfeit finals read W-DQ instead of 0-0.
function formatTickerFeed(feed) {
  return (feed || []).filter((m) => m && (m.status === 'live' || m.status === 'done')).map((m) => {
    const a = (typeof m.scoreA === 'number') ? m.scoreA : null;
    const b = (typeof m.scoreB === 'number') ? m.scoreB : null;
    if (m.status === 'live') {
      const mid = (a || b) ? `  ${a || 0}-${b || 0}  ` : '  vs  ';
      return 'LIVE   ' + m.teamA + mid + m.teamB;
    }
    if (m.dq) {
      const mid = m.winSide === 'b' ? '  DQ-W  ' : m.winSide === 'a' ? '  W-DQ  ' : '  DQ  ';
      return 'FINAL   ' + m.teamA + mid + m.teamB;
    }
    if (a == null && b == null && m.winSide) {
      const mid = m.winSide === 'a' ? '  W-L  ' : '  L-W  ';   // winner-only report, no game scores
      return 'FINAL   ' + m.teamA + mid + m.teamB;
    }
    return 'FINAL   ' + m.teamA + '  ' + (a || 0) + '-' + (b || 0) + '  ' + m.teamB;
  });
}
// The start.gg set currently being streamed (manual selection or auto-follow), resolved to its
// id + real team names + tournament. Used to link live RL player stats to the official set record
// so a streamed series becomes one row (official result + player stats) instead of two.
function currentStreamedSetLink() {
  const sg = state.startgg || {};
  const setId = sg.setId || sg.lastPushedSetId || null;
  if (!setId) return null;
  const item = (sg.queue || []).find((x) => String(x.setId) === String(setId))
            || (sg.matchFeed || []).find((x) => String(x.setId) === String(setId));
  const real = (s) => (s && s !== 'TBD' && s !== 'Unknown') ? s : null;
  return {
    setId: String(setId),
    teamA: item ? real(item.teamA) : null,
    teamB: item ? real(item.teamB) : null,
    tournament: (sg.selectedEvent && (sg.selectedEvent.tournamentName || sg.selectedEvent.name)) || null
  };
}
function buildStartggMatchFeed(queue, recentSets) {
  const seen = new Set();
  const live = [];
  const done = [];
  const consider = (item) => {
    if (!item || !item.teamA || !item.teamB || item.teamA === 'TBD' || item.teamB === 'TBD') return;
    const key = item.setId || `${item.teamA}|${item.teamB}|${item.round}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (item.status === 'live') live.push(item);
    else if (item.status === 'done') done.push(item);
  };
  // Live = sets on a stream (queue idx-0) + every in-progress (state 2) set in the event.
  (queue || []).forEach((q) => consider(mapStartggSetToFeedItem(q, { live: q.live, stream: q.stream })));
  (recentSets || []).forEach((s) => {
    const st = Number(s.state);
    if (st === 2 || st === 3) consider(mapStartggSetToFeedItem(s));   // 2 → live, 3 → done
  });
  // Compose: LIVE matches lead. Fill the rest with the most-recent FINALS up to a target size — so a
  // freshly-finished match shows as FINAL for a few loops then rotates out as newer results arrive,
  // and when there are few live matches (late in the bracket) the ticker fills with final scores.
  const TARGET = 10;
  const finalsToShow = Math.max(3, TARGET - live.length);
  return live.concat(done.slice(0, finalsToShow)).slice(0, 14);   // done is RECENT-ordered (newest first)
}

// A couple of NON-stream upcoming (state 1) matches to supplement the schedule/upcoming board in
// event-queue mode — the overlay already renders the stream-queue rows (state.startgg.queue), so this
// only adds not-yet-started sets that aren't queued on a stream. Returned WITHOUT a setId so the
// schedule overlay appends them as extra rows (setId items there only override existing queue rows).
function buildEventUpcomingExtras(queue, allSets) {
  const queued = new Set((queue || []).map((q) => String(q.setId)));
  const bad = (n) => !n || n === 'TBD';
  const out = [];
  for (const s of (allSets || [])) {
    if (out.length >= 3) break;
    if (Number(s.state) !== 1) continue;
    const m = mapStartggSetToFeedItem(s);
    if (queued.has(String(m.setId))) continue;
    if (bad(m.teamA) && bad(m.teamB)) continue;
    out.push({
      round: m.round || '', teamA: m.teamA, teamB: m.teamB,
      teamALogo: m.logoA || '', teamBLogo: m.logoB || '',
      date: '', time: '', stream: false, scoreA: m.scoreA ?? null, scoreB: m.scoreB ?? null,
      week: '', note: ''
    });
  }
  return out;
}

// Safety net + enrichment for the on-air match. The event feed already pulls in-progress (state 2)
// sets, but this guarantees the set the producer PUSHED (state.startgg.setId) is present as LIVE even
// if start.gg hasn't flipped it to state 2 yet, and overrides its score with the producer's live
// series score (more current than start.gg's standing). Idempotent.
function ensureOnAirLiveInFeed() {
  const sg = state.startgg;
  if (!sg) return;
  const setId = (sg.setId || sg.lastPushedSetId || '').toString().trim();
  if (!setId) return;                       // only force-live an explicitly pushed set
  const feed = sg.matchFeed || (sg.matchFeed = []);
  const link = currentStreamedSetLink();
  const teamA = (link && link.teamA) || (state.teams.blue && state.teams.blue.name) || '';
  const teamB = (link && link.teamB) || (state.teams.orange && state.teams.orange.name) || '';
  if (!teamA || !teamB) return;             // nothing meaningful on air
  const idx = feed.findIndex((m) => String(m.setId) === setId);
  const numOr = (v, fb) => (typeof v === 'number' ? v : fb);
  const item = {
    setId,
    round: idx >= 0 ? feed[idx].round : '',
    teamA, teamB,
    // Prefer the live series score the producer is tracking; fall back to start.gg's standing score.
    scoreA: numOr(state.series && state.series.blue,   idx >= 0 ? feed[idx].scoreA : null),
    scoreB: numOr(state.series && state.series.orange, idx >= 0 ? feed[idx].scoreB : null),
    status: 'live',
    stream: idx >= 0 ? feed[idx].stream : '',
    logoA: sg.logoMap[teamA.trim().toLowerCase()] || (idx >= 0 ? feed[idx].logoA : '') || '',
    logoB: sg.logoMap[teamB.trim().toLowerCase()] || (idx >= 0 ? feed[idx].logoB : '') || ''
  };
  if (idx >= 0) feed[idx] = item; else feed.unshift(item);
  const rank = (st) => (st === 'live' ? 0 : st === 'done' ? 1 : 2);
  sg.matchFeed = feed.sort((a, b) => rank(a.status) - rank(b.status)).slice(0, 10);
}

// Pull the event's IN-PROGRESS sets (start.gg state 2) and its most-recently-COMPLETED sets
// (state 3) explicitly via the state filter — RECENT sort alone can bury live sets behind a flood
// of just-reported finals. Returns a combined node list (each carries its own `state`).
async function fetchRecentEventSets(client, eventSlug) {
  const slug = parseEventSlug(eventSlug);
  if (!slug) return [];
  const setFields = `
    nodes {
      id
      fullRoundText
      state
      winnerId
      displayScore
      slots {
        entrant { id name }
        standing { stats { score { value } } }
      }
    }`;
  const query = `
    query FeedSets($slug: String!) {
      event(slug: $slug) {
        live:   sets(perPage: 24, page: 1, filters: { state: [2] }) { ${setFields} }
        recent: sets(perPage: 20, page: 1, sortType: RECENT, filters: { state: [3] }) { ${setFields} }
        soon:   sets(perPage: 16, page: 1, sortType: CALL_ORDER, filters: { state: [1] }) { ${setFields} }
      }
    }`;
  try {
    const res = await client.request(query, { slug });
    const ev = (res && res.event) || {};
    const liveNodes = (ev.live && ev.live.nodes) || [];
    const doneNodes = (ev.recent && ev.recent.nodes) || [];
    const soonNodes = (ev.soon && ev.soon.nodes) || [];
    return [...liveNodes, ...doneNodes, ...soonNodes];
  } catch (e) {
    // Fallback for any event/permission that rejects the state filter: RECENT sweep, split by state.
    const q2 = `query RecentSets($slug: String!) { event(slug: $slug) { sets(perPage: 40, page: 1, sortType: RECENT) { ${setFields} } } }`;
    const res = await client.request(q2, { slug });
    return (res && res.event && res.event.sets && res.event.sets.nodes) || [];
  }
}

// Fetch the tournament's STREAM QUEUE — the sets a TO has marked for each stream.
// The first set in a stream's queue is the one currently on that stream.
async function fetchStreamQueue(tournamentSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token (set it in Settings)');
  const slug = (tournamentSlug || state.startgg.tournamentSlug || '').trim()
    .replace(/^https?:\/\/(www\.)?start\.gg\//i, '')
    .replace(/^tournament\//i, '').split('/')[0];
  if (!slug) throw new Error('Enter a tournament slug first');

  const client = createStartGgClient(startggApiToken);
  const query = `
    query StreamQueue($slug: String!) {
      tournament(slug: $slug) {
        id
        streamQueue {
          stream { streamName }
          sets {
            id
            fullRoundText
            state
            winnerId
            displayScore
            slots {
              entrant { id name team { images { url type } } }
              standing { stats { score { value } } }
            }
          }
        }
      }
    }`;
  const res = await client.request(query, { slug: `tournament/${slug}` });
  const sq = res?.tournament?.streamQueue || [];

  // Double-elim play order: Losers Finals must happen before Grand Finals.
  // start.gg sometimes returns Grand Finals first in the stream queue even when
  // Losers Finals hasn't been played, so we enforce the correct sequence here.
  const _deRoundKey = (r) => {
    const t = (r || '').toLowerCase();
    if (/grand\s*(final|finals)/.test(t)) return 2;
    if (/losers?\s*(final|finals)/.test(t) && !/semi/.test(t)) return 1;
    return 0;
  };

  const streams = [];
  const queue = [];
  sq.forEach((q) => {
    const streamName = q?.stream?.streamName || 'Stream';
    if (!streams.includes(streamName)) streams.push(streamName);
    const sets = q?.sets || [];
    // Capture any team logos start.gg returns directly on the queue entrants.
    indexEntrantLogos(sets.flatMap((set) => (set.slots || []).map((s) => s?.entrant).filter(Boolean)));
    // Sort within this stream's queue: Losers Finals before Grand Finals;
    // everything else stays in start.gg's original order (stable sort).
    const sorted = sets.slice().sort((a, b) => _deRoundKey(a.fullRoundText) - _deRoundKey(b.fullRoundText));
    sorted.forEach((set, idx) => {
      const ents = (set.slots || []).map((s) => s?.entrant).filter(Boolean);
      const scoreA = set.slots?.[0]?.standing?.stats?.score?.value;
      const scoreB = set.slots?.[1]?.standing?.stats?.score?.value;
      const teamA = ents[0]?.name || 'TBD';
      const teamB = ents[1]?.name || 'TBD';
      queue.push({
        setId: String(set.id),
        stream: streamName,
        round: set.fullRoundText || '',
        state: set.state,                 // 1 not started, 2 in progress, 3 done
        teamA,
        teamB,
        logoA: logoForTeamName(teamA),
        logoB: logoForTeamName(teamB),
        scoreA: typeof scoreA === 'number' && scoreA >= 0 ? scoreA : null,
        scoreB: typeof scoreB === 'number' && scoreB >= 0 ? scoreB : null,
        winnerId: set.winnerId != null ? set.winnerId : null,
        displayScore: set.displayScore || null,
        slots: set.slots,
        live: idx === 0                   // first in a stream's queue = currently on stream
      });
    });
  });

  let recentSets = [];
  const evSlug = (state.startgg.eventSlug || '').trim();
  if (evSlug) {
    try { recentSets = await fetchRecentEventSets(client, evSlug); } catch (e) { /* optional */ }
  }

  state.startgg.streams = streams;
  state.startgg.queue = queue;
  // Include the on-air set in the feed too — it's the LIVE match, and the ticker should show it
  // (previously excluding state.startgg.setId meant a single-stream event's only live match was
  // filtered out, leaving the ticker showing FINAL results only).
  state.startgg.matchFeed = buildStartggMatchFeed(queue, recentSets);
  ensureOnAirLiveInFeed();   // force the pushed on-air match to appear as LIVE
  if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);
  // Event-queue mode: keep the upcoming/schedule board following the stream queue, adding a couple of
  // non-stream upcoming matches. (Team mode leaves upcoming.matches to the last team search.)
  if (state.upcoming.source === 'event') state.upcoming.matches = buildEventUpcomingExtras(queue, recentSets);
  state.startgg.queueFetchedAt = new Date().toISOString();
  state.startgg.connected = true;
  state.startgg.lastError = null;
  broadcastFullState();
  return { streams, count: queue.length };
}

// Fetch a team's upcoming sets from start.gg without needing tournament-admin access.
async function fetchTeamQueue(teamName, tournamentSlug) {
  if (!startggApiToken) throw new Error('No Start.gg API token set in Integrations.');
  const slug = (tournamentSlug || state.startgg.tournamentSlug || '').trim()
    .replace(/^https?:\/\/(www\.)?start\.gg\//i, '')
    .replace(/^tournament\//i, '').split('/')[0];
  if (!slug) throw new Error('Enter a tournament URL or slug.');
  if (!teamName) throw new Error('Enter a team name.');
  const client = createStartGgClient(startggApiToken);
  // Entrant has no direct `sets` field in start.gg's schema — sets live on Event and must be
  // filtered by entrantIds, which we only know after resolving the matching entrants. Two-step:
  // 1) find entrants matching the team name per event, 2) fetch that event's sets filtered to them.
  const entrantsQuery = `query TeamEntrants($slug: String!, $name: String!) {
    tournament(slug: $slug) {
      events {
        id
        name
        entrants(query: { filter: { name: $name }, perPage: 8 }) { nodes {
          id name
        }}
      }
    }
  }`;
  const eRes = await client.request(entrantsQuery, { slug: `tournament/${slug}`, name: teamName });
  const events = eRes?.tournament?.events || [];
  const raw = [];
  const allEntrants = [];
  for (const ev of events) {
    const entrantIds = (ev.entrants?.nodes || []).map(e => e.id).filter((id) => id != null);
    if (!entrantIds.length) continue;
    // Pull full participant data (gamerTag, country, images, socials) per entrant — not just
    // name/logo — so both teams in every queued match get merged into the team/player library
    // the same way a full event import would, and overlay scenes have what they need to render.
    const setsQuery = `query TeamSets($eventId: ID!, $entrantIds: [ID]) {
      event(id: $eventId) {
        sets(filters: { entrantIds: $entrantIds }, perPage: 20) { nodes {
          id fullRoundText state
          slots {
            entrant {
              id name
              participants { gamerTag player { id user { slug name images { url type } authorizations { type externalUsername } location { country } } } }
              team { images { url type } }
            }
            standing { stats { score { value } } }
          }
        }}
      }
    }`;
    const sRes = await client.request(setsQuery, { eventId: ev.id, entrantIds });
    const sets = sRes?.event?.sets?.nodes || [];
    for (const set of sets) {
      if (set.state === 3) continue;
      const slots = set.slots || [];
      const ents = slots.map(s => s?.entrant).filter(Boolean);
      allEntrants.push(...ents);
      raw.push({
        setId: String(set.id),
        stream: ev.name || '',
        round: set.fullRoundText || '',
        state: set.state,
        teamA: ents[0]?.name || 'TBD',
        teamB: ents[1]?.name || 'TBD',
        scoreA: slots[0]?.standing?.stats?.score?.value ?? null,
        scoreB: slots[1]?.standing?.stats?.score?.value ?? null,
        slots,
        live: set.state === 2
      });
    }
  }
  const seen = new Set();
  const deduped = raw.filter(q => !seen.has(q.setId) && seen.add(q.setId));
  deduped.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0));
  // mergeEntrantsIntoLibrary populates savedTeams rosters + playerProfiles (country/twitch/image)
  // and also overwrites state.startgg.eventTeams — but here we've only seen the queued team's
  // opponents, not the full event, so union it back with whatever picker list already existed
  // instead of shrinking it.
  const prevEventTeams = state.startgg.eventTeams || [];
  mergeEntrantsIntoLibrary(allEntrants);
  if (prevEventTeams.length) {
    const byName = new Map(prevEventTeams.map(t => [t.name, t]));
    (state.startgg.eventTeams || []).forEach(t => byName.set(t.name, t));
    state.startgg.eventTeams = [...byName.values()];
  }
  deduped.forEach(q => { q.logoA = logoForTeamName(q.teamA); q.logoB = logoForTeamName(q.teamB); });
  state.startgg.teamQueue = deduped;
  state.startgg.focusTeam = teamName;
  state.upcoming.source = 'team';   // upcoming/schedule board now follows this team's matches
  state.upcoming.matches = deduped.map(q => ({
    id: q.setId, setId: q.setId, round: q.round || '',
    teamA: q.teamA || 'TBD', teamB: q.teamB || 'TBD',
    teamALogo: q.logoA || '', teamBLogo: q.logoB || '',
    date: '', time: '', stream: !!q.live, state: q.state, live: !!q.live,
    scoreA: q.scoreA ?? null, scoreB: q.scoreB ?? null,
    week: '', note: ''
  }));
  saveAppState();
  broadcastFullState();
  return { count: deduped.length };
}

// Stream queue polling — driven by Settings API token + tournament slug + queueEnabled toggle.
let _startggPollTimer = null;
async function startggPollTick() {
  if (!state.startgg.queueEnabled) return;
  if (!startggApiToken) {
    state.startgg.connected = false;
    state.startgg.lastError = 'Missing Start.gg API token (Settings → start.gg)';
    broadcastFullState();
    return;
  }
  const slug = (state.startgg.tournamentSlug || '').trim();
  if (!slug) {
    state.startgg.connected = false;
    state.startgg.lastError = 'Set a tournament slug in Settings → start.gg';
    broadcastFullState();
    return;
  }
  try {
    await fetchStreamQueue(slug);
    if (state.startgg.autoFollow) {
      const wantStream = state.startgg.streamName;
      const live = state.startgg.queue.find((s) => s.live && (!wantStream || s.stream === wantStream))
                || state.startgg.queue.find((s) => s.live);
      if (live && live.setId && live.setId !== state.startgg.lastPushedSetId) {
        await syncStartGgSet(live.setId);
        state.startgg.lastPushedSetId = live.setId;
        ensureOnAirLiveInFeed();   // reflect the newly auto-followed match as LIVE in the ticker
        if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);
        console.log(`[Start.gg] Auto-followed live set ${live.setId}: ${live.teamA} vs ${live.teamB}`);
        // Tell the producer their scoreboard just changed by itself (auto-follow is silently
        // enabled on event activation — without this it looks like a haunted scoreboard).
        broadcast(bridgeClients, { type: 'autofollow-pushed', data: {
          message: `Auto-follow: now showing ${live.teamA || 'TBD'} vs ${live.teamB || 'TBD'} (live on stream). Series score reset.`
        } });
      }
    }
    await syncBracketToActiveEvent();
  } catch (e) {
    state.startgg.connected = false;
    state.startgg.lastError = e.message;
    broadcastFullState();
  }
}
let _standingsMirrorSig = '';
let _startggBracketTick = 0;
let _lastBracketFetchSlug = '';

// The Bracket scene's "Tournament Organizer" source FOLLOWS the active event (Dashboard ▸ Event
// panel) unless the producer typed a different slug into the bracket panel (followActive=false)
// or built a manual bracket — a stale eventSlug here used to re-import the wrong event (e.g. a
// 400-team LCQ) forever. Called on the regular ~20s poll tick AND immediately whenever the active
// start.gg event changes (activateStartggEvent), so switching events in the Dashboard reflects on
// the Bracket scene right away instead of waiting up to 20s for the next tick.
async function syncBracketToActiveEvent() {
  if (state.bracket.mode !== 'manual' && state.bracket.followActive !== false) {
    const activeSlug = (state.startgg.eventSlug || '').trim();
    if (activeSlug && (state.bracket.eventSlug || '').trim() !== activeSlug) {
      console.log(`[Bracket] Following active event: ${activeSlug} (was ${state.bracket.eventSlug || 'none'})`);
      state.bracket.eventSlug = activeSlug;
    }
  }
  if ((state.bracket.eventSlug || '').trim() && state.bracket.mode !== 'manual') {
    // Scale-aware cadence: small events refresh every tick (~20s); major-scale ones
    // (hundreds of sets) every 3rd tick (~60s) so a 1500-set fetch isn't back-to-back.
    // A slug change always fetches immediately regardless of the throttle.
    const slugChanged = state.bracket.eventSlug !== _lastBracketFetchSlug;
    const bigEvent = (state.bracket.matches || []).length > 400;
    _startggBracketTick++;
    if (!slugChanged && bigEvent && _startggBracketTick % 3 !== 0) return;
    _lastBracketFetchSlug = state.bracket.eventSlug;
    try { await fetchBracket(state.bracket.eventSlug); } catch (e) { /* non-fatal */ }
    // start.gg-sourced standings mirror the live event standings each refresh, so the
    // standings overlay updates as scores come in (manual/league rows are never touched).
    if ((state.standings?.source || '') === 'startgg' && (state.bracket.standings || []).length) {
      const mirrorSig = JSON.stringify(state.bracket.standings.map((r) => [r.placement, r.name, r.wins, r.losses]));
      if (mirrorSig !== _standingsMirrorSig) {
        _standingsMirrorSig = mirrorSig;
        state.standings.rows = state.bracket.standings.map((r) => ({ ...r }));
        broadcastFullState();
      }
    }
  }
}

function setStartggQueuePolling(enabled) {
  state.startgg.queueEnabled = !!enabled;
  if (_startggPollTimer) { clearInterval(_startggPollTimer); _startggPollTimer = null; }
  if (state.startgg.queueEnabled && startggApiToken && (state.startgg.tournamentSlug || '').trim()) {
    startggPollTick();
    _startggPollTimer = setInterval(startggPollTick, 20000);
  }
  saveAppState();
  broadcastFullState();
}

function applyStartggAutomation() {
  const ready = state.startgg.enabled && startggApiToken && (state.startgg.tournamentSlug || '').trim();
  if (ready && state.startgg.queueEnabled) {
    setStartggQueuePolling(true);
  } else if (!state.startgg.queueEnabled) {
    setStartggQueuePolling(false);
  }
}

function setStartggAutoFollow(enabled) {
  state.startgg.autoFollow = !!enabled;
  saveAppState();
  broadcastFullState();
}

// ─── Challonge integration ───────────────────────────────────────────────────

function challongePartMap(participants) {
  const map = {};
  participants.forEach((p) => {
    const d = p.participant;
    map[d.id] = {
      name: d.display_name || d.name || `Participant ${d.id}`,
      logo: d.attached_participatable_portrait_url || null,
      seed: d.seed || 0,
      challongeId: d.id,
      finalRank: d.final_rank || null
    };
  });
  return map;
}

function challongeBracketType(type) {
  if (!type) return 'SINGLE_ELIMINATION';
  const t = type.toLowerCase();
  if (t.includes('double')) return 'DOUBLE_ELIMINATION';
  if (t.includes('round robin')) return 'ROUND_ROBIN';
  if (t.includes('swiss')) return 'SWISS';
  return 'SINGLE_ELIMINATION';
}

function buildChalongeBracket(tournament, participants, matches) {
  const partMap = challongePartMap(participants);
  const getName = (id) => (id ? (partMap[id]?.name || `#${id}`) : 'TBD');
  const type = challongeBracketType(tournament.tournament_type);

  function parseScore(match) {
    const csv = match.scores_csv || '';
    const parts = csv.split('-').map((s) => parseInt(s) || 0);
    return { aScore: parts[0] || 0, bScore: parts[1] || 0 };
  }

  if (type === 'ROUND_ROBIN' || type === 'SWISS') {
    const roundMap = {};
    matches.forEach((m) => {
      const d = m.match;
      const r = Math.abs(d.round);
      if (!roundMap[r]) roundMap[r] = [];
      const { aScore, bScore } = parseScore(d);
      roundMap[r].push({ a: { name: getName(d.player1_id), score: aScore, winner: d.winner_id === d.player1_id }, b: { name: getName(d.player2_id), score: bScore, winner: d.winner_id === d.player2_id } });
    });
    const schedule = Object.keys(roundMap).map(Number).sort((a, b) => a - b).map((r) => ({ name: 'Round ' + r, sets: roundMap[r] }));
    const roster = Object.values(partMap).sort((a, b) => (a.seed || 99) - (b.seed || 99)).map((p) => p.name);
    return { type, winners: [], losers: [], finals: [], standings: [], schedule, roster };
  }

  // Elimination: positive round = winners side, negative = losers side.
  const winnersMap = {}, losersMap = {};
  let maxWR = -Infinity;
  matches.forEach((m) => {
    const d = m.match;
    const r = d.round;
    const { aScore, bScore } = parseScore(d);
    const set = { a: { name: getName(d.player1_id), score: aScore, winner: d.winner_id === d.player1_id }, b: { name: getName(d.player2_id), score: bScore, winner: d.winner_id === d.player2_id } };
    if (r >= 0) { if (!winnersMap[r]) winnersMap[r] = []; winnersMap[r].push(set); if (r > maxWR) maxWR = r; }
    else { if (!losersMap[r]) losersMap[r] = []; losersMap[r].push(set); }
  });

  let finals = [];
  if (type === 'DOUBLE_ELIMINATION' && maxWR > 0 && winnersMap[maxWR]) {
    finals = [{ name: 'Grand Final', sets: winnersMap[maxWR] }];
    delete winnersMap[maxWR];
  }

  const wKeys = Object.keys(winnersMap).map(Number).sort((a, b) => a - b);
  const totalW = wKeys.length;
  const winners = wKeys.map((r, idx) => {
    let name;
    if (type === 'DOUBLE_ELIMINATION') {
      name = idx === totalW - 1 ? "Winners Final" : idx === totalW - 2 ? "Winners Semifinal" : "Winners Round " + r;
    } else {
      name = idx === totalW - 1 ? "Grand Final" : idx === totalW - 2 ? "Semifinal" : "Round " + r;
    }
    return { name, sets: winnersMap[r] };
  });

  const lKeys = Object.keys(losersMap).map(Number).sort((a, b) => b - a);
  const losers = lKeys.map((r) => ({ name: 'Losers Round ' + Math.abs(r), sets: losersMap[r] }));

  return { type, winners, losers, finals, standings: [], schedule: [], roster: [] };
}

function buildChallongeQueue(partMap, matches) {
  return matches
    .filter((m) => ['open', 'pending'].includes(m.match.state))
    .sort((a, b) => (a.match.suggested_play_order || 0) - (b.match.suggested_play_order || 0))
    .map((m) => {
      const d = m.match;
      const csv = (d.scores_csv || '').split('-').map((s) => parseInt(s) || 0);
      return {
        matchId: d.id, round: d.round, identifier: d.identifier,
        state: d.state, live: d.state === 'open',
        teamA: partMap[d.player1_id]?.name || 'TBD',
        teamB: partMap[d.player2_id]?.name || 'TBD',
        logoA: partMap[d.player1_id]?.logo || null,
        logoB: partMap[d.player2_id]?.logo || null,
        scoreA: csv[0] || 0, scoreB: csv[1] || 0,
        player1ChallongeId: d.player1_id,
        player2ChallongeId: d.player2_id
      };
    });
}

async function fetchChallongeTournamentData(slug) {
  const client = createChallongeClient(challongeApiKey);
  const [tData, pData, mData] = await Promise.all([
    client.get(`/tournaments/${slug}.json`),
    client.get(`/tournaments/${slug}/participants.json`),
    client.get(`/tournaments/${slug}/matches.json`)
  ]);
  return { tournament: tData.tournament, participants: pData, matches: mData };
}

async function loadChalongeTournament(slug) {
  const { tournament, participants, matches } = await fetchChallongeTournamentData(slug);
  const partMap = challongePartMap(participants);

  // Auto-import participants into the saved team library
  Object.values(partMap).forEach(p => {
    if (!savedTeams.find(t => t.name.toLowerCase() === p.name.toLowerCase())) {
      savedTeams.push({ name: p.name, logo: p.logo || null, players: [] });
    }
  });
  saveTeams();

  const eventTeams = Object.values(partMap).sort((a, b) => (a.seed || 99) - (b.seed || 99)).map((p) => ({
    name: p.name, logo: p.logo, seed: p.seed, challongeId: p.challongeId, finalRank: p.finalRank
  }));
  const logoMap = {};
  eventTeams.forEach((t) => { if (t.logo) logoMap[t.name.toLowerCase()] = t.logo; });

  state.challonge.eventTeams = eventTeams;
  state.challonge.logoMap = logoMap;
  state.challonge.selectedTournament = {
    id: tournament.id, slug: tournament.url, name: tournament.name,
    url: tournament.full_challonge_url, type: tournament.tournament_type,
    state: tournament.state, participantsCount: tournament.participants_count,
    gameName: tournament.game_name || ''
  };
  state.challonge.tournamentSlug = slug;
  state.challonge.connected = true;
  state.challonge.lastError = null;
  state.challonge.lastSyncAt = new Date().toISOString();
  state.challonge.queue = buildChallongeQueue(partMap, matches);
  state.activeEvent = {
    platform: 'challonge',
    slug,
    name: tournament.name,
    gameName: tournament.game_name || '',
    numEntrants: participants.length,
    format: tournament.tournament_type || '',
    url: tournament.full_challonge_url || `https://challonge.com/${slug}`,
    loadedAt: new Date().toISOString()
  };
  setActivePlatform('challonge');   // this is now the active platform — silence start.gg / NXGEN follow
  state.challonge.queueFetchedAt = Date.now();

  // Apply bracket to state.bracket
  const bd = buildChalongeBracket(tournament, participants, matches);
  const teams = eventTeams.filter((t) => t.logo).map((t) => ({ name: t.name, logo: t.logo }));
  state.bracket.phases = [{ id: 'challonge-main', name: tournament.name || 'Bracket', type: bd.type, winners: bd.winners, losers: bd.losers, finals: bd.finals, standings: bd.standings, schedule: bd.schedule, roster: bd.roster }];
  state.bracket.activePhaseId = 'challonge-main';
  state.bracket.title = tournament.name || 'Bracket';
  state.bracket.teams = teams;
  state.bracket.matches = [];
  state.bracket.eventSlug = 'challonge:' + slug;
  state.bracket.mode = 'imported';
  state.bracket.source = 'challonge';
  state.bracket.lastFetchAt = Date.now();
  syncActiveBracketPhase();
  broadcastFullState();
  return { name: tournament.name, teamsCount: eventTeams.length, matchesCount: matches.length };
}

async function refreshChallongeLive() {
  const slug = (state.challonge.tournamentSlug || '').trim();
  if (!slug || !challongeApiKey) return;
  try {
    const { tournament, participants, matches } = await fetchChallongeTournamentData(slug);
    const partMap = challongePartMap(participants);
    state.challonge.queue = buildChallongeQueue(partMap, matches);
    state.challonge.queueFetchedAt = Date.now();
    state.challonge.connected = true;
    state.challonge.lastError = null;
    // Auto-follow: push teams to scoreboard when a match goes live
    if (state.challonge.autoFollow) {
      const live = state.challonge.queue.find(m => m.live);
      if (live && live.matchId !== state.challonge.lastAutoFollowMatchId) {
        state.challonge.lastAutoFollowMatchId = live.matchId;
        if (live.teamA && live.teamA !== 'TBD') {
          state.teams.blue = { ...state.teams.blue, name: live.teamA, logo: live.logoA || state.challonge.logoMap[(live.teamA || '').toLowerCase()] || null };
          state.teams.orange = { ...state.teams.orange, name: live.teamB || '', logo: live.logoB || state.challonge.logoMap[(live.teamB || '').toLowerCase()] || null };
          saveAppState();
        }
      }
    }
    // Refresh bracket scores
    const bd = buildChalongeBracket(tournament, participants, matches);
    const existingPhase = state.bracket.phases.find((p) => p.id === 'challonge-main');
    if (existingPhase) {
      existingPhase.winners = bd.winners;
      existingPhase.losers = bd.losers;
      existingPhase.finals = bd.finals;
      state.bracket.lastFetchAt = Date.now();
      syncActiveBracketPhase();
    }
    broadcastFullState();
  } catch (e) {
    state.challonge.connected = false;
    state.challonge.lastError = e.message;
    broadcastFullState();
    throw e;
  }
}

let _challongePollTimer = null;
function setChallongePolling(enabled) {
  if (_challongePollTimer) { clearInterval(_challongePollTimer); _challongePollTimer = null; }
  if (enabled && challongeApiKey && (state.challonge.tournamentSlug || '').trim()) {
    refreshChallongeLive();
    _challongePollTimer = setInterval(refreshChallongeLive, 30000);
  }
}

// ─── Challonge real-time match sync ──────────────────────────────────────────

async function buildChallongeParticipantMap(slug) {
  const client = createChallongeClient(challongeApiKey);
  const pData = await client.get(`/tournaments/${slug}/participants.json`);
  const map = {};
  (pData || []).forEach(p => {
    const d = p.participant || p;
    [d.name, d.display_name].filter(Boolean).forEach(n => {
      map[n.toLowerCase()] = { id: d.id, name: n };
    });
  });
  return map;
}

// Normalize a team/entrant name for matching across start.gg ↔ Challonge (case, spacing and
// punctuation differ constantly). Deliberately keeps alphanumerics only — no substring/"contains"
// matching, so "Tarn C" never collapses into "Tarn B".
function _normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Resolve a start.gg entrant name to a Challonge participant {id,name}. Tries exact (lowercased)
// then a normalized-equality pass. Returns null if nothing matches — caller should surface that
// rather than silently dropping the result (a dropped prerequisite stalls the whole cascade).
function resolveChallongeParticipant(pm, name) {
  if (!name) return null;
  const lc = String(name).toLowerCase();
  if (pm[lc]) return pm[lc];
  const n = _normName(name);
  if (!n) return null;
  for (const k in pm) { if (_normName(k) === n) return pm[k]; }
  return null;
}

async function syncLinkedChallongeTournament(ev) {
  const link = ev.challongeSync;
  if (!link || !link.enabled || !link.slug || !challongeApiKey) return;
  try {
    const client = createChallongeClient(challongeApiKey);
    if (!link.participantMap || Object.keys(link.participantMap).length === 0) {
      link.participantMap = await buildChallongeParticipantMap(link.slug);
    }
    const pm = link.participantMap;
    if (!link.pushedMatches) link.pushedMatches = {};

    // Gather completed bracket matches from all phases, in bracket order
    // (winners early→late, then losers early→late, then finals).
    // Bracket order matters so we push prerequisites before downstream matches.
    const completedMatches = [];
    (state.bracket.phases || []).forEach(phase => {
      ['winners', 'losers', 'finals'].forEach(side => {
        (phase[side] || []).forEach(round => {
          // Each round is { name, sets: [{a,b}] } — iterate round.sets, not round itself
          (round.sets || []).forEach(match => {
            const { a, b } = match || {};
            if (!a || !b || (!a.winner && !b.winner)) return;
            if (!a.name || !b.name || a.name === 'TBD' || b.name === 'TBD') return;
            completedMatches.push({ a, b });
          });
        });
      });
    });
    if (!completedMatches.length) return;

    // Resolve entrant names to Challonge participants once (tolerant of case/spacing/punctuation).
    completedMatches.forEach((cm) => {
      cm.pA = resolveChallongeParticipant(pm, cm.a.name);
      cm.pB = resolveChallongeParticipant(pm, cm.b.name);
      cm.consumed = false;
    });

    // Multi-pass: re-fetch Challonge's open matches after each push so that matches which become
    // open as a result (e.g. Grand Finals after Losers Finals) are picked up in the same cycle.
    // Dedup is keyed by the CHALLONGE match id (stable, and distinguishes a Grand-Finals rematch
    // of two teams from their earlier meeting — the old name-pair key blocked the rematch).
    let totalPushed = 0;
    for (let pass = 0; pass < 20; pass++) {
      const mData = await client.get(`/tournaments/${link.slug}/matches.json`);
      const openMatches = (mData || []).filter(m => (m.match || m).state === 'open');
      if (!openMatches.length) break;

      let pushedThisPass = 0;
      for (const m of openMatches) {
        const d = m.match || m;
        if (!d.player1_id || !d.player2_id) continue;
        if (link.pushedMatches[String(d.id)]) continue;
        const cm = completedMatches.find(c => !c.consumed && c.pA && c.pB &&
          ((d.player1_id === c.pA.id && d.player2_id === c.pB.id) ||
           (d.player1_id === c.pB.id && d.player2_id === c.pA.id)));
        if (!cm) continue;
        const winnerId = cm.a.winner ? cm.pA.id : cm.pB.id;
        const isAp1 = d.player1_id === cm.pA.id;
        const sA = cm.a.score != null ? cm.a.score : 0;
        const sB = cm.b.score != null ? cm.b.score : 0;
        const scoresCSV = isAp1 ? `${sA}-${sB}` : `${sB}-${sA}`;
        try {
          await client.put(`/tournaments/${link.slug}/matches/${d.id}.json`, {
            match: { winner_id: winnerId, scores_csv: scoresCSV }
          });
          link.pushedMatches[String(d.id)] = true;
          cm.consumed = true;
          pushedThisPass++;
          totalPushed++;
        } catch (err) {
          cm.consumed = true;   // skip a rejected set instead of spinning the cascade
          console.error(`[challonge-sync] Match ${cm.a.name} vs ${cm.b.name}:`, err.message);
        }
      }
      if (pushedThisPass === 0) break; // no progress this pass, stop
    }
    if (totalPushed > 0) {
      link.lastSyncAt = new Date().toISOString();
      link.lastError = null;
      saveAppState();
      broadcastFullState();
      console.log(`[challonge-sync] Pushed ${totalPushed} result(s) to ${link.slug}`);
    }
  } catch (e) {
    if (ev.challongeSync) { ev.challongeSync.lastError = e.message; broadcastFullState(); }
    console.error('[challonge-sync]', e.message);
  }
}

async function syncAllLinkedChallongeTournaments() {
  if (!challongeApiKey) return;
  for (const ev of (Array.isArray(state.myEvents) ? state.myEvents : [])) {
    if (ev.challongeSync && ev.challongeSync.enabled && ev.challongeSync.slug) {
      await syncLinkedChallongeTournament(ev).catch(() => {});
    }
  }
}

// ─── NXGEN integration ────────────────────────────────────────────────────────

function buildNxgenQueue(participants, matches) {
  const pm = {};
  participants.forEach(p => { pm[p.id] = p; });
  return (matches || [])
    .filter(m => m.status !== 'completed')
    .map(m => {
      const p1 = pm[m.participant1] || {};
      const p2 = pm[m.participant2] || {};
      return {
        matchId: m._id,
        round: m.round,
        matchNumber: m.matchNumber,
        teamA: p1.name || 'TBD',
        teamB: p2.name || 'TBD',
        logoA: p1.logoUrl || null,
        logoB: p2.logoUrl || null,
        scoreA: m.scores ? (m.scores.participant1 ?? null) : null,
        scoreB: m.scores ? (m.scores.participant2 ?? null) : null,
        status: m.status,
        live: m.status === 'in-progress',
        winnerId: m.winnerId || null
      };
    });
}

function buildNxgenBracketData(eventFormat, participants, matches) {
  const pm = {};
  participants.forEach(p => { pm[p.id] = p; });

  const byRound = {};
  (matches || []).forEach(m => {
    if (!byRound[m.round]) byRound[m.round] = [];
    byRound[m.round].push(m);
  });

  const winners = Object.keys(byRound)
    .map(Number).sort((a, b) => a - b)
    .map(r => byRound[r].sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0)).map(m => {
      const p1 = pm[m.participant1] || {};
      const p2 = pm[m.participant2] || {};
      return {
        id: m._id,
        teamA: p1.name || 'TBD',
        teamB: p2.name || 'TBD',
        logoA: p1.logoUrl || null,
        logoB: p2.logoUrl || null,
        scoreA: m.scores ? (m.scores.participant1 ?? null) : null,
        scoreB: m.scores ? (m.scores.participant2 ?? null) : null,
        winner: m.winnerId ? (m.winnerId === m.participant1 ? 'teamA' : 'teamB') : null,
        state: m.status
      };
    }));

  const standings = participants
    .filter(p => p.finalRank)
    .sort((a, b) => (a.finalRank || 99) - (b.finalRank || 99))
    .map(p => ({ placement: p.finalRank, name: p.name, logo: p.logoUrl || null }));

  const roster = participants.map(p => ({ seed: p.seed || 0, name: p.name, logo: p.logoUrl || null }));

  return {
    type: (eventFormat || '').includes('double') ? 'double' : 'single',
    winners,
    losers: [],
    finals: [],
    standings,
    schedule: [],
    roster
  };
}

async function loadNxgenEvent(slug) {
  const { event, participants, matches } = await getNxgenEventLive(nxgenApiKey, slug);

  const logoMap = {};
  participants.forEach(p => { if (p.name && p.logoUrl) logoMap[p.name.toLowerCase()] = p.logoUrl; });

  const eventTeams = participants.map(p => ({ name: p.name, logo: p.logoUrl || null, nxgenId: p.id }));
  const queue = buildNxgenQueue(participants, matches);
  const bd = buildNxgenBracketData(event.format || event.bracketFormat, participants, matches);

  state.nxgen.eventSlug = slug;
  state.nxgen.selectedEvent = {
    name: event.name,
    slug: event.slug,
    activity: event.activity || '',
    format: event.format || event.bracketFormat || '',
    status: event.status || '',
    url: event.streamUrl || `https://www.nxgen.pro/events/${slug}`
  };
  state.nxgen.eventTeams = eventTeams;
  state.nxgen.logoMap = logoMap;
  state.nxgen.queue = queue;
  state.nxgen.queueFetchedAt = Date.now();
  state.nxgen.connected = true;
  state.nxgen.lastError = null;

  state.activeEvent = {
    platform: 'nxgen',
    slug,
    name: event.name,
    gameName: event.activity || '',
    numEntrants: participants.length,
    format: event.format || event.bracketFormat || '',
    url: event.streamUrl || `https://www.nxgen.pro/events/${slug}`,
    loadedAt: new Date().toISOString()
  };
  setActivePlatform('nxgen');   // this is now the active platform — silence start.gg / Challonge follow

  const phase = {
    id: 'nxgen-main',
    name: event.name,
    type: bd.type,
    winners: bd.winners,
    losers: bd.losers,
    finals: bd.finals,
    standings: bd.standings,
    schedule: bd.schedule,
    roster: bd.roster
  };
  const existingIdx = state.bracket.phases.findIndex(p => p.id === 'nxgen-main');
  if (existingIdx >= 0) {
    state.bracket.phases[existingIdx] = phase;
  } else {
    state.bracket.phases.push(phase);
  }
  state.bracket.activePhaseId = 'nxgen-main';
  state.bracket.eventSlug = 'nxgen:' + slug;
  state.bracket.mode = 'imported';
  state.bracket.source = 'nxgen';

  return { name: event.name, teamsCount: participants.length, matchesCount: matches.length };
}

async function refreshNxgenLive() {
  const slug = (state.nxgen.eventSlug || '').trim();
  if (!slug || !nxgenApiKey) return;
  try {
    const { event, participants, matches } = await getNxgenEventLive(nxgenApiKey, slug);
    state.nxgen.queue = buildNxgenQueue(participants, matches);
    state.nxgen.queueFetchedAt = Date.now();
    state.nxgen.connected = true;
    state.nxgen.lastError = null;

    if (state.nxgen.autoFollow) {
      const live = state.nxgen.queue.find(m => m.live);
      if (live && live.matchId !== state.nxgen.lastAutoFollowMatchId) {
        state.nxgen.lastAutoFollowMatchId = live.matchId;
        if (live.teamA && live.teamA !== 'TBD') {
          state.teams.blue   = { ...state.teams.blue,   name: live.teamA, logo: live.logoA || state.nxgen.logoMap[(live.teamA || '').toLowerCase()] || null };
          state.teams.orange = { ...state.teams.orange, name: live.teamB || '', logo: live.logoB || state.nxgen.logoMap[(live.teamB || '').toLowerCase()] || null };
          saveAppState();
        }
      }
    }

    const bd = buildNxgenBracketData(event.format || event.bracketFormat, participants, matches);
    const existingPhase = state.bracket.phases.find(p => p.id === 'nxgen-main');
    if (existingPhase) {
      Object.assign(existingPhase, { winners: bd.winners, losers: bd.losers, standings: bd.standings });
    }

    broadcastFullState();
  } catch (e) {
    state.nxgen.connected = false;
    state.nxgen.lastError = e.message;
    broadcastFullState();
  }
}

let _nxgenPollTimer = null;
function setNxgenPolling(enabled) {
  if (_nxgenPollTimer) { clearInterval(_nxgenPollTimer); _nxgenPollTimer = null; }
  if (enabled && nxgenApiKey && (state.nxgen.eventSlug || '').trim()) {
    refreshNxgenLive();
    _nxgenPollTimer = setInterval(refreshNxgenLive, 30000);
  }
}

// Only ONE tournament platform (start.gg / Challonge / NXGEN) may drive the broadcast at a time —
// two live auto-follows fighting over the scoreboard is exactly the "trouble" to prevent. Making a
// platform active turns the OTHERS' auto-follow + live polling OFF. (Result push-back via each
// event's challongeSync link is a separate one-directional path and is deliberately left running.)
function setActivePlatform(platform) {
  state.activeEvent.platform = platform || null;
  if (platform !== 'startgg')   { state.startgg.autoFollow  = false; if (state.startgg.queueEnabled) setStartggQueuePolling(false); }
  if (platform !== 'challonge') { state.challonge.autoFollow = false; setChallongePolling(false); }
  if (platform !== 'nxgen')     { state.nxgen.autoFollow    = false; setNxgenPolling(false); }
}

// ─── My Events live-refresh ───────────────────────────────────────────────────
// Keep every saved My Event current: poll start.gg for its entrants (team names + player
// gamertags + current seed) so the seeding studio and the event page always reflect the latest
// registration. Stored as a lightweight `ev.roster`; rank/MMR is NOT on start.gg (it's entered in
// the seeding studio). Auto every ~3 min + on add + on demand (refresh_my_event WS command).
let _myEventsTimer = null;
let _myEventsSyncing = false;
async function refreshMyEvent(ev) {
  if (!ev || !ev.eventSlug || !startggApiToken) return false;
  try {
    const data = await fetchEventSeeding(startggApiToken, ev.eventSlug);
    const entrants = data.entrants || [];
    ev.roster = entrants.map((e) => ({
      entrantId: e.entrantId, name: e.name, seedNum: e.seedNum || null,
      players: (e.players || []).map((p) => ({ gamerTag: p.gamerTag, epic: p.epic || '', alts: p.alts || [] })).filter((p) => p.gamerTag)
    }));
    ev.numEntrants = entrants.length;
    if (data.eventName && !ev.name) ev.name = data.eventName;
    if (data.image) ev.image = data.image;   // logo for My Events / seeding cards
    ev.lastSync = Date.now();
    ev.syncError = '';
    return true;
  } catch (e) {
    ev.syncError = (e && e.message) || 'sync failed';
    return false;
  }
}
async function refreshAllMyEvents(opts) {
  opts = opts || {};
  if (_myEventsSyncing) return;
  if (!startggApiToken || !Array.isArray(state.myEvents) || !state.myEvents.length) return;
  _myEventsSyncing = true;
  let changed = false;
  try {
    for (const ev of state.myEvents.slice()) {
      if (!opts.force && ev.lastSync && (Date.now() - ev.lastSync) < 90 * 1000) continue;  // recently synced
      if (await refreshMyEvent(ev)) changed = true;
      await new Promise((r) => setTimeout(r, 350));   // stagger for start.gg rate limits
    }
  } finally {
    _myEventsSyncing = false;
    if (changed || opts.force) { saveAppState(); broadcastFullState(); }
  }
}
function startMyEventsAutoSync() {
  if (_myEventsTimer) return;
  _myEventsTimer = setInterval(() => { refreshAllMyEvents().catch(() => {}); }, 3 * 60 * 1000);
  setTimeout(() => { refreshAllMyEvents().catch(() => {}); }, 8000);   // initial kick after boot
}

// ─── Start.gg bracket ────────────────────────────────────────────────────────
function parseEventSlug(input) {
  const s = (input || '').trim();
  if (!s) return '';
  // Accept a full start.gg URL or a bare slug
  const m = s.match(/tournament\/[^/\s]+\/event\/[^/?#\s]+/i);
  return m ? m[0] : s;
}

// Parse any start.gg input — a tournament URL (e.g. .../tournament/100-genesis-cup-38/details),
// a full event URL (.../tournament/x/event/y), a bare "tournament/x" slug, or a plain slug.
// Returns { tournamentSlug, eventSlug } (eventSlug = full "tournament/x/event/y" path or '').
function parseStartggInput(input) {
  const s = (input || '').trim().replace(/^https?:\/\/(www\.)?start\.gg\//i, '');
  if (!s) return { tournamentSlug: '', eventSlug: '' };
  const ev = s.match(/tournament\/([^/\s?#]+)\/event\/([^/?#\s]+)/i);
  if (ev) return { tournamentSlug: ev[1], eventSlug: `tournament/${ev[1]}/event/${ev[2]}` };
  const t = s.match(/tournament\/([^/\s?#]+)/i);
  if (t) return { tournamentSlug: t[1], eventSlug: '' };
  // Bare token — assume it's a tournament slug.
  return { tournamentSlug: s.split(/[/?#\s]/)[0], eventSlug: '' };
}

// Maintain the lowercased name→logo map from a list of Start.gg entrants so the
// stream queue, upcoming overlay and bracket can all show team logos.
function indexEntrantLogos(entrants) {
  (entrants || []).forEach((ent) => {
    const name = (ent && ent.name || '').trim().toLowerCase();
    const logo = pickEntrantLogo(ent);
    if (name && logo) state.startgg.logoMap[name] = logo;
  });
}

// Best known logo for a team name: prefer a saved-team custom logo, then the
// start.gg logoMap captured at load time.
function logoForTeamName(name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  const saved = savedTeams.find((t) => (t.name || '').trim().toLowerCase() === key);
  if (saved && saved.logo) return saved.logo;
  return state.startgg.logoMap[key] || null;
}

// Auto team names from the live game: when enabled, apply a game-reported team name to a
// side, matching the saved-teams library to pull the correct logo/colour. Generic in-game
// names (CT/T/Blue/Orange/etc.) are ignored. Returns true if anything changed.
const GENERIC_TEAM_RE = /^(counter-?terrorists?|terrorists?|team\s*(ct|t)|ct|t|blue(\s*team)?|orange(\s*team)?|red(\s*team)?|home|away|team\s*[ab12]|dire|radiant|spectator|unknown)$/i;
function applyGameTeamName(side, rawName) {
  if (!state.autoTeamsFromGame) return false;
  const name = String(rawName == null ? '' : rawName).trim();
  if (!name || GENERIC_TEAM_RE.test(name)) return false;
  const t = state.teams[side];
  if (!t) return false;
  const key = name.toLowerCase();
  const saved = savedTeams.find((s) => String(s.name || '').trim().toLowerCase() === key);
  const nm = saved ? saved.name : name;
  let changed = false;
  if (t.name !== nm) { t.name = nm; changed = true; }
  if (saved && saved.logo && t.logo !== saved.logo) { t.logo = saved.logo; changed = true; }
  if (saved && saved.color && t.color !== saved.color) { t.color = saved.color; changed = true; }
  return changed;
}

// Turn a flat list of Start.gg sets — all from ONE pool/phaseGroup — into a
// structured, type-aware bracket. Round Robin pools also get a head-to-head
// matrix and enriched standings (Sets Played/Set Count/Game Count) to match
// how Start.gg itself presents Pool Play; elimination standings stay plain.
function buildBracket(sets, advancesTo) {
  const list = Array.isArray(sets) ? sets : [];

  // Dominant bracket type across the sets (a pool's sets are normally all one
  // type; we pick the most common just in case of stray mixed data).
  const typeCounts = {};
  list.forEach((s) => {
    const t = s.phaseGroup && s.phaseGroup.bracketType;
    if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
  });
  const type = Object.keys(typeCounts).sort((a, b) => typeCounts[b] - typeCounts[a])[0] || '';
  const isElim = !type || type === 'SINGLE_ELIMINATION' || type === 'DOUBLE_ELIMINATION';

  const mapSlot = (slot, set) => {
    const ent = slot && slot.entrant;
    const scoreVal = slot && slot.standing && slot.standing.stats && slot.standing.stats.score
      ? slot.standing.stats.score.value : null;
    return {
      name: (ent && ent.name) || 'TBD',
      score: (typeof scoreVal === 'number' && scoreVal >= 0) ? scoreVal : null,
      winner: !!(ent && set.winnerId && ent.id === set.winnerId)
    };
  };

  // Live standings (used for round-robin / swiss, computed from results). For
  // non-elimination pools this also tallies Sets Played/Total, Set Wins-Losses
  // and Game Wins-Losses — the exact stat columns Start.gg's own Pool/Swiss
  // standings tables show, derived entirely from data already fetched (no
  // extra API round-trip).
  const standingsMap = new Map();
  list.forEach((s) => {
    const slots = s.slots || [];
    const e0 = slots[0] && slots[0].entrant;
    const e1 = slots[1] && slots[1].entrant;
    const sc0 = slots[0] && slots[0].standing && slots[0].standing.stats && slots[0].standing.stats.score
      ? slots[0].standing.stats.score.value : null;
    const sc1 = slots[1] && slots[1].standing && slots[1].standing.stats && slots[1].standing.stats.score
      ? slots[1].standing.stats.score.value : null;
    [e0, e1].forEach((e) => {
      if (e && e.id && !standingsMap.has(e.id)) {
        standingsMap.set(e.id, { id: e.id, name: e.name, wins: 0, losses: 0, setsPlayed: 0, setsTotal: 0, gameWins: 0, gameLosses: 0 });
      }
    });
    if (e0 && e0.id) standingsMap.get(e0.id).setsTotal++;
    if (e1 && e1.id) standingsMap.get(e1.id).setsTotal++;
    if (s.winnerId && e0 && e1) {
      const winId = s.winnerId;
      const win = winId === e0.id ? e0 : (winId === e1.id ? e1 : null);
      const lose = winId === e0.id ? e1 : (winId === e1.id ? e0 : null);
      if (win && standingsMap.has(win.id)) { standingsMap.get(win.id).wins++; standingsMap.get(win.id).setsPlayed++; }
      if (lose && standingsMap.has(lose.id)) { standingsMap.get(lose.id).losses++; standingsMap.get(lose.id).setsPlayed++; }
      const gw0 = (typeof sc0 === 'number' && sc0 >= 0) ? sc0 : 0;
      const gw1 = (typeof sc1 === 'number' && sc1 >= 0) ? sc1 : 0;
      if (e0 && e0.id) { standingsMap.get(e0.id).gameWins += gw0; standingsMap.get(e0.id).gameLosses += gw1; }
      if (e1 && e1.id) { standingsMap.get(e1.id).gameWins += gw1; standingsMap.get(e1.id).gameLosses += gw0; }
    }
  });
  const standingsRaw = [...standingsMap.values()]
    .sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || a.name.localeCompare(b.name));
  const standings = standingsRaw.map((s, i) => {
    // played=false → the overlay shows '–' instead of a rank so an unstarted event never
    // implies alphabetical seeding is a real placement.
    const row = { placement: i + 1, name: s.name, wins: s.wins, losses: s.losses, played: s.setsPlayed > 0 };
    if (!isElim) {
      row.setsPlayed = s.setsPlayed;
      row.setsTotal = s.setsTotal;
      row.setWins = s.wins;
      row.setLosses = s.losses;
      row.gameWins = s.gameWins;
      row.gameLosses = s.gameLosses;
    }
    return row;
  });
  const roster = standingsRaw.map((s) => s.name);

  // Origin pill ("Day 1 A25: Winners") — only for slots seeded from a PREVIOUS phase
  // (prereqType 'seed' + a progressionSource). Within-bracket slots (prereqType 'set')
  // are covered by the connectors; first-phase seeds have no progression to show.
  const originName = (slot) => {
    if (!slot || slot.prereqType !== 'seed') return undefined;
    const sd = slot.seed;
    return (sd && sd.progressionSource && sd.placeholderName) ? sd.placeholderName : undefined;
  };

  // Group sets into rounds — shared by the elimination split below AND the Swiss/Round-Robin
  // schedule (each round's pairings), so both read the exact same {name,round,sets} shape.
  const isGrandFinal = (s) => /grand\s*final/i.test(s.fullRoundText || '');
  const groupRounds = (filterFn, sortFn) => {
    const m = new Map();
    list.filter(filterFn).forEach((s) => {
      const key = s.fullRoundText || `Round ${s.round}`;
      if (!m.has(key)) m.set(key, { name: key, round: s.round, sets: [] });
      const slots = s.slots || [];
      // state: start.gg set state (1=upcoming, 2=live, 3=done) — lets the overlay dim
      // unstarted sets so a pre-event bracket doesn't read as if matches already happened.
      m.get(key).sets.push({ id: s.id, a: mapSlot(slots[0], s), b: mapSlot(slots[1], s), state: s.state || 0, fromA: originName(slots[0]), fromB: originName(slots[1]) });
    });
    return [...m.values()].sort(sortFn);
  };

  // Head-to-head matrix — Round Robin pools only (Swiss pairings aren't all-play-all,
  // a matrix would be mostly empty gaps, so we don't build one for Swiss).
  let matrix = null;
  if (type === 'ROUND_ROBIN') {
    const teams = standingsRaw.map((s) => ({ id: String(s.id), name: s.name }));
    const cells = {};
    list.forEach((s) => {
      const slots = s.slots || [];
      const e0 = slots[0] && slots[0].entrant;
      const e1 = slots[1] && slots[1].entrant;
      if (!e0 || !e1 || e0.id == null || e1.id == null) return;
      const a = mapSlot(slots[0], s);
      const b = mapSlot(slots[1], s);
      const played = s.winnerId != null;
      cells[`${e0.id}_${e1.id}`] = { aScore: a.score, bScore: b.score, winner: played ? (a.winner ? 'a' : (b.winner ? 'b' : null)) : null, played };
      cells[`${e1.id}_${e0.id}`] = { aScore: b.score, bScore: a.score, winner: played ? (b.winner ? 'a' : (a.winner ? 'b' : null)) : null, played };
    });
    matrix = { teams, cells };
  }

  if (!isElim) {
    // Swiss / Round-Robin: no winners/losers split, just the round-by-round pairing schedule.
    const schedule = groupRounds(() => true, (a, b) => a.round - b.round);
    return { type, winners: [], losers: [], finals: [], standings, schedule, roster, matrix, advancesTo: advancesTo || '' };
  }

  // Elimination: group sets into rounds, split winners / losers / grand finals.
  const winners = groupRounds(
    (s) => s.round > 0 && !isGrandFinal(s),
    (a, b) => a.round - b.round
  );
  const losers = groupRounds(
    (s) => s.round < 0 && !isGrandFinal(s),
    (a, b) => Math.abs(a.round) - Math.abs(b.round)
  );
  const finals = groupRounds(isGrandFinal, (a, b) => a.round - b.round);

  // Exit pill: a set whose WINNER has no next set inside this pool is a bracket exit —
  // when we know where this pool's qualifiers go, tag it ("-> Day 3: Swiss Stage").
  if (advancesTo) {
    const winnerFeedsForward = (sid) => list.some((s) =>
      (s.slots || []).some((sl) => sl && String(sl.prereqId) === String(sid) && sl.prereqPlacement === 1));
    [winners, losers, finals].forEach((band) => band.forEach((r) => (r.sets || []).forEach((st) => {
      if (st.id != null && !winnerFeedsForward(st.id)) st.toNext = advancesTo;
    })));
  }
  return { type, winners, losers, finals, standings, schedule: [], roster, matrix: null, advancesTo: advancesTo || '' };
}

// Split a flat Start.gg set list into one bracket PHASE per Start.gg phase
// (so a Day-1 double-elim and a Day-2 single-elim/swiss stay separate), then
// further split each phase into POOLS — one per Start.gg phaseGroup, e.g. a
// Round Robin phase running 8 parallel pools at once. A phase with a single
// phaseGroup still gets one pool entry, and the phase-level winners/losers/
// finals/standings/schedule/roster fields mirror that one pool directly —
// this is what keeps existing single-pool/elimination events rendering
// exactly as before.
function buildPhases(sets, phaseList) {
  // Display order comes from the event's phases[] array — start.gg's own listing order.
  // Neither phase id NOR phaseOrder is reliable: a rebuilt phase gets a high id and a
  // high phaseOrder (RLCS NA Open 6: "Day 2" has phaseOrder 7, "Day 3" has 3).
  const orderMap = new Map();
  (Array.isArray(phaseList) ? phaseList : []).forEach((p, i) => { if (p && p.id != null) orderMap.set('p' + p.id, i); });
  let firstSeen = 0;
  // Cross-phase progression: originPhaseGroupId -> destination phase names. A slot whose
  // seed progressed OUT of pool X tells us where X's qualifiers went ("Day 3: Swiss Stage").
  const destByGroup = new Map();
  (sets || []).forEach((s) => {
    const dphase = s.phaseGroup && s.phaseGroup.phase && s.phaseGroup.phase.name;
    (s.slots || []).forEach((sl) => {
      const og = sl && sl.seed && sl.seed.progressionSource && sl.seed.progressionSource.originPhaseGroup;
      if (og && og.id != null && dphase) {
        const k = String(og.id);
        if (!destByGroup.has(k)) destByGroup.set(k, new Set());
        destByGroup.get(k).add(dphase);
      }
    });
  });
  const groups = new Map();
  (sets || []).forEach((s) => {
    const ph = (s.phaseGroup && s.phaseGroup.phase) || null;
    const id = ph && ph.id != null ? 'p' + ph.id : 'default';
    const name = (ph && ph.name) || 'Bracket';
    if (!groups.has(id)) groups.set(id, { id, name, order: orderMap.has(id) ? orderMap.get(id) : 1000 + (firstSeen++), sets: [] });
    groups.get(id).sets.push(s);
  });
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map((g) => {
      const poolGroups = new Map();
      g.sets.forEach((s) => {
        const pg = s.phaseGroup || null;
        const pid = pg && pg.id != null ? String(pg.id) : 'default';
        const pname = (pg && pg.displayIdentifier) || g.name;
        if (!poolGroups.has(pid)) poolGroups.set(pid, { id: pid, name: pname, sets: [] });
        poolGroups.get(pid).sets.push(s);
      });
      const pools = [...poolGroups.values()]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((pg) => {
          const b = buildBracket(pg.sets, [...(destByGroup.get(pg.id) || [])].join(' / '));
          // Pools carry their OWN elimination arrays: major-scale events (RLCS Opens) run MANY
          // double-elim pools per phase — merging at phase level produced one unreadable
          // mega-bracket with every pool's Round 1 stacked into a single column.
          return { id: pg.id, name: pg.name, type: b.type, roster: b.roster, schedule: b.schedule,
            standings: b.standings, matrix: b.matrix, advancesTo: b.advancesTo || '',
            winners: b.winners, losers: b.losers, finals: b.finals };
        });
      const p0 = pools[0] || { id: '', type: '', roster: [], schedule: [], standings: [], matrix: null };
      // Winners/losers/finals always come from the WHOLE phase's sets (not per-pool) —
      // elimination phases are effectively always a single pool in practice, and this
      // preserves exact prior behavior for them regardless of the pools split above.
      const phaseDest = new Set();
      g.sets.forEach((s) => {
        const k = s.phaseGroup && s.phaseGroup.id != null ? String(s.phaseGroup.id) : '';
        if (k && destByGroup.has(k)) destByGroup.get(k).forEach((d) => phaseDest.add(d));
      });
      const bAll = buildBracket(g.sets, [...phaseDest].join(' / '));
      return {
        id: g.id, name: g.name, type: bAll.type, advancesTo: bAll.advancesTo || '',
        winners: bAll.winners, losers: bAll.losers, finals: bAll.finals,
        standings: p0.standings, schedule: p0.schedule, roster: p0.roster,
        pools, activePoolId: p0.id || ''
      };
    });
}

// Copy the active phase's bracket data — and that phase's ACTIVE POOL — up to
// the top-level fields the overlay reads.
function syncActiveBracketPhase() {
  const phases = state.bracket.phases || [];
  if (!phases.length) return;
  let ph = phases.find((x) => x.id === state.bracket.activePhaseId);
  if (!ph) { ph = phases[0]; state.bracket.activePhaseId = ph.id; }
  state.bracket.type = ph.type || '';
  state.bracket.winners = ph.winners || [];
  state.bracket.losers = ph.losers || [];
  state.bracket.finals = ph.finals || [];

  const pools = Array.isArray(ph.pools) ? ph.pools : [];
  state.bracket.pools = pools.map((pl) => ({ id: pl.id, name: pl.name }));
  let pool = pools.find((pl) => pl.id === state.bracket.activePoolId);
  if (!pool) { pool = pools[0] || null; state.bracket.activePoolId = pool ? pool.id : ''; }

  // Multi-pool elimination phase: show the ACTIVE POOL's bracket, not the phase-wide merge.
  const poolElim = pool && ((pool.winners || []).length || (pool.losers || []).length || (pool.finals || []).length);
  if (poolElim && pools.length > 1) {
    state.bracket.winners = pool.winners || [];
    state.bracket.losers = pool.losers || [];
    state.bracket.finals = pool.finals || [];
  }
  state.bracket.standings = (pool ? pool.standings : ph.standings) || [];
  state.bracket.schedule = (pool ? pool.schedule : ph.schedule) || [];   // Swiss/Round-Robin round-by-round pairings
  state.bracket.roster = (pool ? pool.roster : ph.roster) || [];
  state.bracket.advancesTo = (pool && pool.advancesTo) || ph.advancesTo || '';
  state.bracket.matrix = (pool ? pool.matrix : (ph.matrix || null)) || null;   // ph.matrix: single-group manual Round Robin (no pools split)

  // Never leave the saved view pointing at data this bracket doesn't have — a stale "matrix"
  // on an elim bracket rendered the overlay as a blank page with no clue why.
  const hasElim = state.bracket.winners.length || state.bracket.losers.length || state.bracket.finals.length;
  const fallback = hasElim ? 'both' : (state.bracket.standings.length ? 'standings' : 'both');
  if (state.bracket.view === 'matrix' && !state.bracket.matrix) state.bracket.view = fallback;
  if (state.bracket.view === 'schedule' && !state.bracket.schedule.length) state.bracket.view = fallback;
  if (state.bracket.view === 'losers' && !state.bracket.losers.length) state.bracket.view = fallback;
  if (state.bracket.view === 'standings' && hasElim) state.bracket.view = 'both';
  // And the mirror case: an elim-only view ('both'/'winners'/'losers'/'finals') on a
  // round-robin/Swiss phase — pick the format's real default so a linked platform import
  // renders correctly without the producer touching the view chips.
  if (!hasElim && ['winners', 'losers', 'finals', 'standings'].includes(state.bracket.view)) {
    // 'both' on pool play = the records LADDER (the overlay's default view for swiss/RR).
    state.bracket.view = 'both';
  }
}

// Pull every page of an event's sets (capped so a misconfigured event can't loop).
// 40 pages × 50 = 2000 sets — enough for major-scale events (e.g. RLCS Opens: hundreds of
// teams across swiss pools + top cut). Big events get a slower bracket-refresh cadence
// in startggPollTick so this doesn't hammer the API every 20s.
async function fetchAllSets(client, slug, perPage = 32, maxPages = 63) {
  const query = `
    query BracketSets($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        id
        name
        tournament { name }
        phases { id name }
        sets(perPage: $perPage, page: $page, sortType: ROUND) {
          pageInfo { totalPages }
          nodes {
            id
            fullRoundText
            round
            state
            winnerId
            phaseGroup { id displayIdentifier bracketType phase { id name } }
            slots {
              prereqType
              prereqId
              prereqPlacement
              seed { placeholderName progressionSource { originPlacement originPhaseGroup { id } originPhase { id name } } }
              entrant { id name }
              standing { stats { score { value } } }
            }
          }
        }
      }
    }
  `;
  let page = 1;
  let totalPages = 1;
  let event = null;
  const all = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, 500));   // stagger for start.gg rate limits
    const res = await startggRequestWithBackoff(client, query, { slug, perPage, page });
    event = res && res.event;
    if (!event) throw new Error('Event not found — check the slug/URL and your token');
    all.push(...((event.sets && event.sets.nodes) || []));
    totalPages = (event.sets && event.sets.pageInfo && event.sets.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= maxPages);
  return { event, sets: all };
}

// True bracket seed per entrant, straight from start.gg (`initialSeedNum` — the seed that actually
// produced the real bracket's bye placement). Locally-cached roster/seeding-studio order is NOT a
// reliable substitute: it can drift from what start.gg really used (manual reseeds, edits after the
// seeding studio snapshot, etc.), which silently produces a DIFFERENT bye/bracket shape when used to
// seed a mirrored bracket elsewhere (e.g. Challonge). Returns { name.toLowerCase() -> seedNum }.
async function fetchEntrantSeedList(eventSlug) {
  if (!startggApiToken) throw new Error('start.gg API token required (set it in Settings)');
  const client = createStartGgClient(startggApiToken);
  const query = `
    query TrueSeeds($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        entrants(query: { perPage: $perPage, page: $page }) {
          pageInfo { totalPages }
          nodes { id name initialSeedNum }
        }
      }
    }`;
  let page = 1, totalPages = 1;
  const list = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, 350));   // stagger for start.gg rate limits
    const res = await startggRequestWithBackoff(client, query, { slug: eventSlug, perPage: 75, page });
    const ev = res && res.event;
    if (!ev) throw new Error('Event not found — check the slug/URL and your token');
    ((ev.entrants && ev.entrants.nodes) || []).forEach((n) => {
      if (n.name && n.initialSeedNum != null) list.push({ seed: n.initialSeedNum, name: n.name });
    });
    totalPages = (ev.entrants && ev.entrants.pageInfo && ev.entrants.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= 16);
  return list.sort((a, b) => a.seed - b.seed);
}
async function fetchEntrantTrueSeeds(eventSlug) {
  const list = await fetchEntrantSeedList(eventSlug);
  const map = {};
  list.forEach((e) => { map[e.name.toLowerCase()] = e.seed; });
  return map;
}

// Pull every page of an event's entrants (teams + their players).
// Tries to include social handles and country; falls back silently if the API rejects those fields.
async function fetchAllEntrants(client, slug, perPage = 50, maxPages = 24) {   // 24 pages = 1200 entrants (RLCS Opens exceed the old 800 cap)
  const buildQuery = (withExt) => `
    query EventEntrants($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        entrants(query: { perPage: $perPage, page: $page }) {
          pageInfo { totalPages }
          nodes {
            id name
            participants { id gamerTag player { id user { slug name images { url type }${withExt ? ' authorizations { type externalUsername } location { country }' : ''} } } }
            team { images { url type } }
          }
        }
      }
    }
  `;
  let page = 1, totalPages = 1, withExt = true;
  const all = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, 500));   // stagger for start.gg rate limits
    let res;
    try {
      // Rate limits back off and retry the page (same policy as the bracket import);
      // schema errors (authorizations/location not queryable) still fall back to the
      // slimmer selection instead of failing the whole team import.
      res = await startggRequestWithBackoff(client, buildQuery(withExt), { slug, perPage, page });
    } catch (e) {
      if (withExt && !/429|rate ?limit|too many/i.test(String(e && e.message || ''))) {
        withExt = false;
        res = await startggRequestWithBackoff(client, buildQuery(false), { slug, perPage, page });
      } else throw e;
    }
    const ev = res && res.event;
    if (!ev) break;
    all.push(...((ev.entrants && ev.entrants.nodes) || []));
    totalPages = (ev.entrants && ev.entrants.pageInfo && ev.entrants.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= maxPages);
  return all;
}

// Fetch an event's entrants with their CURRENT start.gg seed (for the seeding studio).
async function fetchEventSeeding(apiToken, eventSlugRaw) {
  if (!apiToken) throw new Error('start.gg API token required');
  const slug = parseEventSlug(eventSlugRaw);
  if (!slug || !/\/event\//i.test(slug)) throw new Error('Paste a specific start.gg EVENT URL (…/event/…).');
  const client = createStartGgClient(apiToken);
  // Connected accounts (Epic etc.) are a far stronger match key for 6mans rank
  // lookup than the event gamertag. Query them, but fall back gracefully if start.gg
  // rejects/omits the `authorizations` field so the seeding pull never breaks.
  const buildQuery = (withAuth) => `
    query EventSeeding($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        id name images { type url }
        tournament { images { type url } }
        entrants(query: { perPage: $perPage, page: $page }) {
          pageInfo { totalPages }
          nodes { id name initialSeedNum participants { gamerTag player { id user { slug name images { url type } ${withAuth ? 'authorizations { type externalUsername }' : ''} } } } }
        }
      }
    }`;
  let page = 1, totalPages = 1, evName = '', evImage = '', withAuth = true;
  const all = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, 350));   // stagger for start.gg rate limits
    let res;
    try {
      res = await client.request(buildQuery(withAuth), { slug, perPage: 75, page });
    } catch (e) {
      if (withAuth) { withAuth = false; res = await client.request(buildQuery(false), { slug, perPage: 75, page }); }
      else throw e;
    }
    const ev = res && res.event;
    if (!ev) break;
    evName = ev.name || evName;
    if (!evImage) {
      const pick = (imgs) => (imgs || []).find((i) => i.type === 'profile')?.url || (imgs || []).find((i) => i.type === 'banner')?.url || (imgs && imgs[0] && imgs[0].url) || '';
      evImage = pick(ev.images) || pick(ev.tournament && ev.tournament.images) || '';
    }
    ((ev.entrants && ev.entrants.nodes) || []).forEach((n) => all.push({
      entrantId: String(n.id),
      name: n.name || '',
      seedNum: n.initialSeedNum || null,
      players: (n.participants || []).map((p) => {
        const u = (p.player && p.player.user) || {};
        const auths = u.authorizations || [];
        const epic = (auths.find((a) => a && (a.type === 'EPIC' || a.type === 'EPICGAMES')) || {}).externalUsername || '';
        const steam = (auths.find((a) => a && a.type === 'STEAM') || {}).externalUsername || '';
        // Build alts as {platform, username} objects so the UI can display and look up each account.
        const _altSeen = new Set();
        const alts = auths
          .filter((a) => a && a.externalUsername)
          .map((a) => ({ platform: (a.type || '').toLowerCase().replace('epicgames', 'epic'), username: a.externalUsername }))
          .filter((a) => { const k = a.platform + ':' + a.username; if (_altSeen.has(k)) return false; _altSeen.add(k); return true; });
        const gamerTag = p.gamerTag || u.name || '';
        const startggPlayerId = p.player && p.player.id ? String(p.player.id) : null;
        const image = ((u.images || []).find((i) => /profile/i.test(i.type || '')) || (u.images || [])[0] || {}).url || '';
        // Auto-link the start.gg profile into the registry for every entrant we see.
        if (gamerTag && u.slug) upsertPlayerProfile(gamerTag, { startggSlug: u.slug, startggPlayerId, image });
        return { gamerTag, epic, steam, alts, startggSlug: u.slug || null, startggPlayerId, image };
      }).filter((p) => p.gamerTag)
    }));
    totalPages = (ev.entrants && ev.entrants.pageInfo && ev.entrants.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= 16);
  all.sort((a, b) => (a.seedNum || 99999) - (b.seedNum || 99999));
  // Diagnostic: how often did start.gg actually hand us a connected Epic/Steam account vs. leaving us
  // to fall back to the tournament gamerTag for tracker.gg? Connected accounts are privacy-gated on
  // start.gg (typically only the token owner's own are returned), so this is usually near-zero — which
  // is exactly why tracker.gg-by-gamertag misses (the gamerTag often isn't the Epic username).
  const _players = all.flatMap((e) => e.players || []);
  const _epic = _players.filter((p) => p.epic).length;
  const _steam = _players.filter((p) => p.steam).length;
  const _anyAuth = _players.filter((p) => p.epic || p.steam || (p.alts && p.alts.length)).length;
  console.log(`[start.gg seeding] ${_players.length} players — connected accounts from start.gg: epic=${_epic}, steam=${_steam}, any=${_anyAuth} (withAuth=${withAuth}). The rest fall back to gamerTag for tracker.gg.`);
  return { eventName: evName, eventSlug: slug, image: evImage, entrants: all };
}

// Weighted normalized placement score across recent standings (0–100).
// Higher = better. Recent events count more (6-month exponential decay).
function computeSggPerformanceScore(standings) {
  const nowSec = Math.floor(Date.now() / 1000);
  let wSum = 0, wTotal = 0;
  for (const s of (standings || [])) {
    const n = s.entrant?.event?.numEntrants;
    const t = s.entrant?.event?.startAt;
    if (!n || n < 4 || !t || !s.placement) continue;
    const daysSince = (nowSec - t) / 86400;
    const weight = Math.exp(-daysSince / 180);
    const norm = 1 - (s.placement - 1) / Math.max(n - 1, 1); // 1.0 = 1st, 0.0 = last
    wSum   += weight * norm;
    wTotal += weight;
  }
  return wTotal > 0 ? Math.round((wSum / wTotal) * 1000) / 10 : null; // 0.0–100.0
}

// ─── Single-team spotlight: deep-dive on one entrant (placement / seed / record / sets) ───
async function fetchTeamSpotlight(apiToken, entrantId) {
  if (!apiToken) throw new Error('start.gg API token required');
  if (!entrantId) throw new Error('No start.gg entrant for this team — re-mark it from the event.');
  const client = createStartGgClient(apiToken);
  const query = `
    query EntrantSpotlight($id: ID!) {
      entrant(id: $id) {
        id name
        seeds { seedNum }
        standing { placement }
        participants { gamerTag user { name } }
        paginatedSets(page: 1, perPage: 16, sortType: RECENT) {
          nodes { id fullRoundText displayScore state winnerId startAt slots { entrant { id name } } }
        }
      }
    }`;
  const res = await client.request(query, { id: String(entrantId) });
  const e = res && res.entrant;
  if (!e) throw new Error('Entrant not found on start.gg');
  const myId = String(e.id);
  const seed = (e.seeds && e.seeds[0] && e.seeds[0].seedNum) || null;
  const placement = (e.standing && e.standing.placement) || null;
  const players = (e.participants || []).map((p) => ({ gamerTag: p.gamerTag || (p.user && p.user.name) || '', name: (p.user && p.user.name) || '' })).filter((p) => p.gamerTag);
  const sets = (e.paginatedSets && e.paginatedSets.nodes) || [];
  const oppOf = (s) => { const o = (s.slots || []).map((x) => x.entrant).filter(Boolean).find((x) => String(x.id) !== myId); return o ? o.name : 'TBD'; };
  let w = 0, l = 0; const recent = [];
  sets.forEach((s) => {
    if (s.state === 3) {            // completed
      const won = String(s.winnerId) === myId;
      if (won) w++; else l++;
      if (recent.length < 4) recent.push({ round: s.fullRoundText || '', opponent: oppOf(s), score: s.displayScore || '', won });
    }
  });
  const upcoming = sets.filter((s) => s.state === 1 || s.state === 2).sort((a, b) => (a.startAt || 9e15) - (b.startAt || 9e15));
  const next = upcoming.length ? { round: upcoming[0].fullRoundText || '', opponent: oppOf(upcoming[0]), live: upcoming[0].state === 2 } : null;
  return { name: e.name || '', seed, placement, record: { w, l }, recent, next, players };
}
// Fill each spotlight player's seedRank from the matching My Event's saved seeding (by gamertag).
function enrichSpotlightSeeding() {
  const ts = state.teamSpotlight;
  const ev = (state.myEvents || []).find((e) => e.eventSlug === ts.eventSlug);
  const team = ev && ev.seeding && Array.isArray(ev.seeding.entrants)
    ? ev.seeding.entrants.find((t) => (t.name || '').toLowerCase() === (ts.name || '').toLowerCase()) : null;
  if (!team) return;
  (ts.players || []).forEach((p) => {
    const sp = (team.players || []).find((x) => (x.gamerTag || '').toLowerCase() === (p.gamerTag || '').toLowerCase());
    if (sp && sp.rank) p.seedRank = sp.rank;
  });
}
let _tsSyncing = false;
async function refreshTeamSpotlight() {
  const ts = state.teamSpotlight;
  if (_tsSyncing || !ts.entrantId || !startggApiToken) return;
  _tsSyncing = true;
  try {
    const d = await fetchTeamSpotlight(startggApiToken, ts.entrantId);
    ts.sg = { seed: d.seed, placement: d.placement, record: d.record, recent: d.recent, next: d.next };
    if (d.name && !ts.name) ts.name = d.name;
    if (!ts.players.length && d.players.length) ts.players = d.players.map((p) => ({ gamerTag: p.gamerTag, name: p.name, seedRank: '' }));
    else (d.players || []).forEach((dp) => { const tp = ts.players.find((x) => (x.gamerTag || '').toLowerCase() === (dp.gamerTag || '').toLowerCase()); if (tp && dp.name) tp.name = dp.name; });
    enrichSpotlightSeeding();
    ts.lastSync = Date.now(); ts.syncError = '';
  } catch (e) { ts.syncError = (e && e.message) || 'fetch failed'; }
  finally { _tsSyncing = false; saveAppState(); broadcastFullState(); }
}
let _tsTimer = null;
function startTeamSpotlightAutoSync() {
  if (_tsTimer) return;
  _tsTimer = setInterval(() => { if (state.teamSpotlight.visible && state.teamSpotlight.entrantId) refreshTeamSpotlight().catch(() => {}); }, 45000);
}

// Push a new seed order to start.gg (requires a TO/admin token with write access).
// orderedEntrantIds = entrant ids in desired seed order (seed 1 first). Only seeds that
// already exist in the event's phase are reordered; CSV-only rows (no entrantId) are skipped.
async function pushEventSeeding(apiToken, eventSlugRaw, orderedEntrantIds) {
  if (!apiToken) throw new Error('start.gg API token required');
  const slug = parseEventSlug(eventSlugRaw);
  if (!slug || !/\/event\//i.test(slug)) throw new Error('Paste a specific start.gg EVENT URL (…/event/…).');
  const order = (orderedEntrantIds || []).map((x) => String(x)).filter(Boolean);
  if (!order.length) throw new Error('No start.gg entrants to push (CSV-only seeds can’t be exported to start.gg).');
  const client = createStartGgClient(apiToken);

  // 1) Read the event's phases and their existing seeds (seedId ↔ entrantId).
  const pq = `
    query EventPhaseSeeds($slug: String!) {
      event(slug: $slug) {
        id name
        phases {
          id name
          seeds(query: { perPage: 256, page: 1 }) {
            nodes { id seedNum entrant { id } }
          }
        }
      }
    }`;
  const pr = await client.request(pq, { slug });
  const ev = pr && pr.event;
  if (!ev) throw new Error('Event not found on start.gg.');
  const phases = (ev.phases || []).filter((p) => p && p.seeds && (p.seeds.nodes || []).length);
  if (!phases.length) throw new Error('No phase seeds on start.gg yet — publish/seed the bracket there first.');
  // Use the phase that contains the most of our entrants (usually the first/main phase).
  let phase = null, best = -1;
  phases.forEach((p) => {
    const ids = new Set((p.seeds.nodes || []).map((s) => s.entrant && String(s.entrant.id)).filter(Boolean));
    const hit = order.filter((id) => ids.has(id)).length;
    if (hit > best) { best = hit; phase = p; }
  });
  const seeds = (phase.seeds.nodes || []);
  const seedByEntrant = {};
  seeds.forEach((s) => { if (s.entrant && s.entrant.id) seedByEntrant[String(s.entrant.id)] = s.id; });

  // 2) Build the seed mapping in our order; entrants we didn't list keep their relative order after.
  const seedMapping = [];
  const used = new Set();
  let n = 1;
  order.forEach((eid) => {
    const sid = seedByEntrant[eid];
    if (sid && !used.has(sid)) { seedMapping.push({ seedId: sid, seedNum: n++ }); used.add(sid); }
  });
  seeds.slice().sort((a, b) => (a.seedNum || 0) - (b.seedNum || 0)).forEach((s) => {
    if (!used.has(s.id)) { seedMapping.push({ seedId: s.id, seedNum: n++ }); used.add(s.id); }
  });
  if (!seedMapping.length) throw new Error('Could not match any seeds — pull entrants from start.gg before pushing.');

  // 3) Apply.
  const mutation = `
    mutation UpdatePhaseSeeding($phaseId: ID!, $seedMapping: [UpdatePhaseSeedInfo]!) {
      updatePhaseSeeding(phaseId: $phaseId, seedMapping: $seedMapping) { id }
    }`;
  await client.request(mutation, { phaseId: phase.id, seedMapping });
  return { phase: phase.name || 'Phase', pushed: best, total: seeds.length };
}

// Fetch tournaments the current token user ADMINS/staffs (organizer view), with the
// extra fields the Events tab needs (attendees, events, location). Falls back to the
// unfiltered "tournaments I'm associated with" list if the admin filter is rejected.
async function fetchMyTournaments(apiToken) {
  if (!apiToken) throw new Error('API token required');
  const client = createStartGgClient(apiToken);
  const buildQuery = (withFilter) => `
    query MyTournaments($perPage: Int) {
      currentUser {
        id
        slug
        tournaments(query: { perPage: $perPage${withFilter ? ', filter: { tournamentView: "admin" }' : ''} }) {
          nodes {
            id
            name
            slug
            startAt
            endAt
            numAttendees
            city
            countryCode
            images { type url }
            events { id name numEntrants videogame { id name } }
          }
        }
      }
    }
  `;
  let res;
  try {
    res = await client.request(buildQuery(true), { perPage: 50 });
  } catch (e) {
    // Some tokens / API states reject the admin filter — retry without it.
    res = await client.request(buildQuery(false), { perPage: 50 });
  }
  const nodes = (res && res.currentUser && res.currentUser.tournaments && res.currentUser.tournaments.nodes) || [];
  return nodes.map(mapTournamentSummary);
}

function mapTournamentSummary(t) {
  const imageUrl = (t.images || []).find(i => i.type === 'profile')?.url ||
                   (t.images || []).find(i => i.type === 'banner')?.url ||
                   (t.images && t.images[0] && t.images[0].url) || null;
  const events = (t.events || []).map(e => ({
    id: e.id, name: e.name, numEntrants: e.numEntrants || 0,
    game: (e.videogame && e.videogame.name) || ''
  }));
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    startAt: t.startAt,
    endAt: t.endAt,
    numAttendees: t.numAttendees || 0,
    city: t.city || '',
    countryCode: t.countryCode || '',
    image: imageUrl,
    events,
    eventCount: events.length,
    tournamentName: t.name
  };
}

// Full detail for one tournament: events + participant (player) roster + sponsorship aggregates.
async function fetchTournamentDetail(apiToken, tournamentSlug, maxPlayerPages = 6) {
  if (!apiToken) throw new Error('API token required');
  const slug = (tournamentSlug || '').trim().replace(/^tournament\//i, '');   // accept bare OR prefixed
  if (!slug) throw new Error('tournamentSlug required');
  const client = createStartGgClient(apiToken);
  const query = `
    query TournamentDetail($slug: String!, $page: Int!) {
      tournament(slug: $slug) {
        id name slug startAt endAt numAttendees
        city addrState countryCode venueName venueAddress
        images { type url }
        events { id name slug numEntrants state startAt videogame { id name } }
        participants(query: { perPage: 100, page: $page }) {
          pageInfo { total totalPages page }
          nodes { id gamerTag user { id slug name } }
        }
      }
    }
  `;

  let page = 1, totalPages = 1;
  let head = null;
  const players = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, 350));   // stagger for start.gg rate limits
    const res = await client.request(query, { slug: `tournament/${slug}`, page });
    const t = res && res.tournament;
    if (!t) break;
    if (!head) head = t;
    const part = (t.participants && t.participants.nodes) || [];
    part.forEach(p => players.push({
      id: p.id,
      tag: p.gamerTag || (p.user && p.user.name) || '',
      userSlug: (p.user && p.user.slug) || '',
      name: (p.user && p.user.name) || ''
    }));
    totalPages = (t.participants && t.participants.pageInfo && t.participants.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= maxPlayerPages);

  if (!head) throw new Error('Tournament not found');

  const events = (head.events || []).map(e => ({
    id: e.id, name: e.name, slug: e.slug, numEntrants: e.numEntrants || 0,
    state: e.state, startAt: e.startAt, game: (e.videogame && e.videogame.name) || ''
  }));
  const games = [...new Set(events.map(e => e.game).filter(Boolean))];
  const totalEntrants = events.reduce((s, e) => s + (e.numEntrants || 0), 0);
  const imageUrl = (head.images || []).find(i => i.type === 'profile')?.url ||
                   (head.images || []).find(i => i.type === 'banner')?.url ||
                   (head.images && head.images[0] && head.images[0].url) || null;

  return {
    id: head.id,
    name: head.name,
    slug: head.slug,
    startAt: head.startAt,
    endAt: head.endAt,
    numAttendees: head.numAttendees || 0,
    location: [head.venueName, head.city, head.addrState, head.countryCode].filter(Boolean).join(', '),
    city: head.city || '',
    countryCode: head.countryCode || '',
    image: imageUrl,
    events,
    games,
    players,
    // Aggregates for sponsorship decks.
    summary: {
      attendees: head.numAttendees || 0,
      eventCount: events.length,
      totalEntrants,
      uniquePlayers: players.length,
      games,
      gameCount: games.length,
      startAt: head.startAt,
      endAt: head.endAt
    }
  };
}

// Fetch sub-events (phases) for a tournament so user can pick the right one for entrants/stats.
async function fetchTournamentEvents(apiToken, tournamentSlug) {
  if (!apiToken) throw new Error('API token required');
  const slug = (tournamentSlug || '').trim().replace(/^tournament\//i, '');   // accept bare OR prefixed
  if (!slug) return [];
  const client = createStartGgClient(apiToken);
  const query = `
    query TournamentEvents($slug: String!) {
      tournament(slug: $slug) {
        id
        name
        slug
        events {
          id
          slug
          name
          startAt
          numEntrants
          videogame { name }
        }
      }
    }
  `;
  const res = await client.request(query, { slug: `tournament/${slug}` });
  if (!res || !res.tournament) throw new Error(`Tournament not found on start.gg — check the slug (tried: tournament/${slug})`);
  return (Array.isArray(res.tournament.events) ? res.tournament.events : []).map(e => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    startAt: e.startAt,
    numEntrants: e.numEntrants || 0,
    game: (e.videogame && e.videogame.name) || '',
    tournamentSlug: slug,
    tournamentName: res.tournament.name || ''
  }));
}

// Map entrants (from fetchAllEntrants) into our eventTeams shape.
function mapEntrantsToTeams(entrants) {
  return (entrants || []).map((ent) => {
    const name = (ent.name || '').trim();
    if (!name) return null;
    const players = (ent.participants || [])
      .map((p) => {
        const tag = (p.gamerTag || '').trim();
        const u = (p.player && p.player.user) || {};
        const auths = u.authorizations || [];
        const twitch = (auths.find((a) => a && a.type === 'TWITCH') || {}).externalUsername || null;
        const twitter = (auths.find((a) => a && (a.type === 'TWITTER' || a.type === 'TWITTER_V2')) || {}).externalUsername || null;
        const country = (u.location && u.location.country) || null;
        const countryCode = _countryCode(country);
        const image = ((u.images || []).find((i) => /profile/i.test(i.type || '')) || (u.images || [])[0] || {}).url || null;
        // u.name is the user's display/legal name on start.gg (different from gamerTag)
        const realName = (u.name && u.name.trim() && u.name.trim() !== tag) ? u.name.trim() : null;
        const startggPlayerId = p.player && p.player.id ? String(p.player.id) : null;
        if (tag) {
          const patch = {};
          if (u.slug) { patch.startggSlug = u.slug; patch.startggPlayerId = startggPlayerId; }
          if (twitch) patch.twitch = twitch;
          if (twitter) patch.twitter = twitter;
          if (country) patch.country = country;
          if (countryCode) patch.countryCode = countryCode;
          if (image) patch.image = image;
          if (realName) patch.realName = realName;
          if (Object.keys(patch).length) upsertPlayerProfile(tag, patch);
        }
        return { id: Math.random().toString(36).slice(2, 11), name: tag, platform: 'startgg', platformId: startggPlayerId || '', assignedCamera: null, country: country || '', countryCode: countryCode || '' };
      })
      .filter((p) => p.name);
    const logo = pickEntrantLogo(ent);
    return {
      name,
      logo: logo || null,
      players,
      startggId: ent.id || null
    };
  }).filter(Boolean);
}

// Flat picker list of playable matches (both entrants known), ready first.
function buildMatches(sets) {
  return (Array.isArray(sets) ? sets : [])
    .map((s) => {
      const slots = s.slots || [];
      const a = slots[0] && slots[0].entrant && slots[0].entrant.name;
      const b = slots[1] && slots[1].entrant && slots[1].entrant.name;
      return {
        id: String(s.id),
        round: s.fullRoundText || `Round ${s.round}`,
        a: a || null,
        b: b || null,
        state: s.state || 0   // 1 = not started, 2 = in progress, 3 = completed
      };
    })
    .filter((m) => m.a && m.b)
    // In-progress first, then not-started, then completed last
    .sort((x, y) => {
      const rank = (st) => (st === 2 ? 0 : st === 1 ? 1 : 2);
      return rank(x.state) - rank(y.state);
    });
}

function applyBracketResult(slug, event, sets) {
  const phases = buildPhases(sets, event && event.phases);
  // Keep the active phase across a refresh if it still exists; else first phase.
  const keepId = phases.some((p) => p.id === state.bracket.activePhaseId) ? state.bracket.activePhaseId : (phases[0] && phases[0].id) || '';
  state.bracket = {
    ...state.bracket,
    eventSlug: slug,
    title: (event && event.name) || '',
    phases,
    activePhaseId: keepId,
    matches: buildMatches(sets),
    mode: 'imported',
    source: 'startgg',
    lastFetchAt: new Date().toISOString(),
    lastError: null
  };
  syncActiveBracketPhase();   // mirror active phase → top-level fields the overlay reads
}

// Refresh just the bracket (scores/progression) without re-importing teams.
// ── Phased bracket import ────────────────────────────────────────────────────
// Big events (RLCS: 1600+ sets / 50+ pages) used to import as ONE monolithic sweep:
// the panel's request timed out ("No response from the server") and two sweeps in
// the same minute tripped start.gg's 80 req/min budget. Now:
//   1. one cheap query gets the phase list,
//   2. sets are fetched PER PHASE — live phases first — and the bracket re-assembles
//      and broadcasts after each phase, so the UI fills in progressively,
//   3. COMPLETED phases cache for the app session (their results can't change), so a
//      steady-state refresh only spends requests on the phase that's actually moving,
//   4. rate-limit responses back off and resume instead of failing request #43 of 50.
const _bracketPhaseCache = new Map();   // slug|phaseId -> { sets, phaseState }
let _bracketFetchInFlight = '';         // slug mid-import — never stack a second sweep

// start.gg rate limiting surfaces as a 429/error (sometimes an empty body) — back off
// and retry the ONE page instead of failing the whole import.
async function startggRequestWithBackoff(client, query, vars, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await client.request(query, vars);
    } catch (e) {
      const msg = String((e && e.message) || '');
      const limited = /429|rate ?limit|too many/i.test(msg);
      if (!limited || i >= tries - 1) throw e;
      const wait = 15000 * (i + 1);
      console.log('[Bracket] start.gg rate limit - backing off ' + (wait / 1000) + 's (page retry ' + (i + 1) + ')');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const BRACKET_SET_FIELDS = `
            id
            fullRoundText
            round
            state
            winnerId
            phaseGroup { id displayIdentifier bracketType phase { id name } }
            slots {
              prereqType
              prereqId
              prereqPlacement
              seed { placeholderName progressionSource { originPlacement originPhaseGroup { id } originPhase { id name } } }
              entrant { id name }
              standing { stats { score { value } } }
            }`;

async function fetchEventPhaseMeta(client, slug) {
  const query = `
    query BracketPhases($slug: String!) {
      event(slug: $slug) {
        id
        name
        tournament { name }
        phases { id name state phaseGroups(query: { perPage: 64 }) { nodes { id } } }
      }
    }`;
  const res = await startggRequestWithBackoff(client, query, { slug });
  const event = res && res.event;
  if (!event) throw new Error('Event not found — check the slug/URL and your token');
  return event;
}

async function fetchPhaseSets(client, slug, phase) {
  const ids = ((phase.phaseGroups && phase.phaseGroups.nodes) || []).map((g) => g.id).filter((x) => x != null);
  if (!ids.length) return [];
  // ids inlined (server-provided integers): the literal-array form is the one verified
  // against the live API; a typed $ids variable is the only shape we could not test.
  const query = `
    query BracketPhaseSets($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        sets(perPage: $perPage, page: $page, sortType: ROUND, filters: { phaseGroupIds: [${ids.join(', ')}] }) {
          pageInfo { totalPages }
          nodes {${BRACKET_SET_FIELDS}
          }
        }
      }
    }`;
  const all = [];
  let page = 1, totalPages = 1;
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, 500));   // 80 req/min budget
    const res = await startggRequestWithBackoff(client, query, { slug, perPage: 32, page });
    const sets = res && res.event && res.event.sets;
    if (!sets) break;
    all.push(...(sets.nodes || []));
    totalPages = (sets.pageInfo && sets.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= 63);
  return all;
}

async function fetchBracket(rawSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token (set it in Settings)');
  const slug = parseEventSlug(rawSlug);
  if (!slug) throw new Error('Missing event slug or URL');
  if (_bracketFetchInFlight === slug) {
    // An import for this event is already running — report it instead of stacking
    // another 50-request sweep on the same rate budget.
    return { title: state.bracket.title || '', type: state.bracket.type,
      rounds: state.bracket.winners.length + state.bracket.losers.length + state.bracket.finals.length,
      sets: (state.bracket.matches || []).length, inProgress: true };
  }
  _bracketFetchInFlight = slug;
  try {
    const client = createStartGgClient(startggApiToken);
    const event = await fetchEventPhaseMeta(client, slug);
    const phases = event.phases || [];
    // Fetch order: live phases first, then upcoming, COMPLETED last (usually cache
    // hits) — the part of the bracket people are watching lands on the overlay first.
    const rank = (p) => (p.state === 'ACTIVE' ? 0 : p.state !== 'COMPLETED' ? 1 : 2);
    const order = [...phases].sort((a, b) => rank(a) - rank(b));
    const combined = () => phases.flatMap((p) => ((_bracketPhaseCache.get(slug + '|' + p.id) || {}).sets) || []);
    let done = 0;
    for (const ph of order) {
      const key = slug + '|' + ph.id;
      const cached = _bracketPhaseCache.get(key);
      const settled = ph.state === 'COMPLETED' && cached && cached.phaseState === 'COMPLETED';
      if (!settled) {
        const sets = await fetchPhaseSets(client, slug, ph);
        _bracketPhaseCache.set(key, { sets, phaseState: ph.state });
        await new Promise((r) => setTimeout(r, 600));   // breathe between phases
      }
      done++;
      state.bracket.progress = done < order.length ? { done, total: order.length, phase: ph.name || '' } : null;
      applyBracketResult(slug, event, combined());
      broadcastFullState();   // the bracket fills in phase by phase
    }
    state.bracket.progress = null;
    saveAppState();
    syncAllLinkedChallongeTournaments().catch(() => {});
    const rounds = state.bracket.winners.length + state.bracket.losers.length + state.bracket.finals.length;
    return { title: event.name || '', tournamentName: (event.tournament && event.tournament.name) || '', type: state.bracket.type, rounds, sets: combined().length };
  } finally {
    _bracketFetchInFlight = '';
  }
}

// ISO 3166-1 alpha-2 lookup for the most common esports countries.
const _COUNTRY_CODES = {
  'united states': 'us', 'usa': 'us', 'united states of america': 'us', 'america': 'us',
  'united states minor outlying islands': 'um', 'u.s. minor outlying islands': 'um',
  'puerto rico': 'pr', 'guam': 'gu', 'u.s. virgin islands': 'vi', 'united states virgin islands': 'vi', 'american samoa': 'as',
  'canada': 'ca', 'united kingdom': 'gb', 'uk': 'gb', 'great britain': 'gb',
  'england': 'gb', 'scotland': 'gb', 'wales': 'gb', 'northern ireland': 'gb',
  'ireland': 'ie', 'republic of ireland': 'ie',
  'australia': 'au', 'new zealand': 'nz', 'germany': 'de', 'france': 'fr',
  'sweden': 'se', 'norway': 'no', 'denmark': 'dk', 'finland': 'fi', 'iceland': 'is',
  'netherlands': 'nl', 'the netherlands': 'nl', 'holland': 'nl', 'belgium': 'be',
  'switzerland': 'ch', 'austria': 'at', 'luxembourg': 'lu',
  'spain': 'es', 'portugal': 'pt', 'italy': 'it', 'greece': 'gr', 'cyprus': 'cy', 'malta': 'mt',
  'poland': 'pl', 'czechia': 'cz', 'czech republic': 'cz', 'slovakia': 'sk', 'hungary': 'hu',
  'romania': 'ro', 'bulgaria': 'bg', 'moldova': 'md', 'ukraine': 'ua', 'belarus': 'by',
  'russia': 'ru', 'russian federation': 'ru', 'turkey': 'tr', 'türkiye': 'tr',
  'croatia': 'hr', 'serbia': 'rs', 'slovenia': 'si', 'bosnia and herzegovina': 'ba', 'bosnia': 'ba',
  'north macedonia': 'mk', 'macedonia': 'mk', 'montenegro': 'me', 'albania': 'al', 'kosovo': 'xk',
  'estonia': 'ee', 'latvia': 'lv', 'lithuania': 'lt',
  'georgia': 'ge', 'armenia': 'am', 'azerbaijan': 'az', 'kazakhstan': 'kz',
  'israel': 'il', 'south africa': 'za', 'nigeria': 'ng', 'egypt': 'eg', 'morocco': 'ma',
  'tunisia': 'tn', 'algeria': 'dz', 'kenya': 'ke', 'ghana': 'gh',
  'saudi arabia': 'sa', 'united arab emirates': 'ae', 'uae': 'ae', 'qatar': 'qa', 'kuwait': 'kw',
  'bahrain': 'bh', 'oman': 'om', 'jordan': 'jo', 'lebanon': 'lb', 'iraq': 'iq', 'iran': 'ir',
  'brazil': 'br', 'mexico': 'mx', 'argentina': 'ar', 'chile': 'cl',
  'colombia': 'co', 'peru': 'pe', 'venezuela': 've', 'ecuador': 'ec', 'bolivia': 'bo',
  'uruguay': 'uy', 'paraguay': 'py', 'costa rica': 'cr', 'panama': 'pa', 'guatemala': 'gt',
  'dominican republic': 'do', 'puerto rico': 'pr', 'jamaica': 'jm', 'trinidad and tobago': 'tt',
  'japan': 'jp', 'south korea': 'kr', 'korea': 'kr', 'north korea': 'kp', 'china': 'cn',
  'taiwan': 'tw', 'hong kong': 'hk', 'macau': 'mo', 'singapore': 'sg', 'indonesia': 'id',
  'malaysia': 'my', 'philippines': 'ph', 'thailand': 'th', 'vietnam': 'vn', 'myanmar': 'mm',
  'cambodia': 'kh', 'laos': 'la', 'mongolia': 'mn',
  'india': 'in', 'pakistan': 'pk', 'bangladesh': 'bd', 'sri lanka': 'lk', 'nepal': 'np',
};
function _countryCode(name) {
  if (!name) return null;
  const s = name.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(s)) return s;
  return _COUNTRY_CODES[s] || null;
}

// Merge a list of Start.gg entrants into the saved team library (update by name,
// don't clobber custom logos) and refresh the transient eventTeams list.
function mergeEntrantsIntoLibrary(entrants) {
  let teamsAdded = 0, playersTotal = 0, logosFound = 0;
  (entrants || []).forEach((ent) => {
    const name = (ent.name || '').trim();
    if (!name) return;
    const players = (ent.participants || [])
      .map((p) => {
        const tag = (p.gamerTag || '').trim();
        const u = (p.player && p.player.user) || {};
        const auths = u.authorizations || [];
        const twitch = (auths.find((a) => a && a.type === 'TWITCH') || {}).externalUsername || null;
        const twitter = (auths.find((a) => a && (a.type === 'TWITTER' || a.type === 'TWITTER_V2')) || {}).externalUsername || null;
        const country = (u.location && u.location.country) || null;
        const countryCode = _countryCode(country);
        const image = ((u.images || []).find((i) => /profile/i.test(i.type || '')) || (u.images || [])[0] || {}).url || null;
        const realName = (u.name && u.name.trim() && u.name.trim() !== tag) ? u.name.trim() : null;
        const startggPlayerId = p.player && p.player.id ? String(p.player.id) : null;
        if (tag) {
          const patch = {};
          if (u.slug) { patch.startggSlug = u.slug; patch.startggPlayerId = startggPlayerId; }
          if (twitch) patch.twitch = twitch;
          if (twitter) patch.twitter = twitter;
          if (country) patch.country = country;
          if (countryCode) patch.countryCode = countryCode;
          if (image) patch.image = image;
          if (realName) patch.realName = realName;
          if (Object.keys(patch).length) upsertPlayerProfile(tag, patch);
        }
        return { id: Math.random().toString(36).slice(2, 11), name: tag, platform: 'startgg', platformId: startggPlayerId || '', assignedCamera: null, country: country || '', countryCode: countryCode || '' };
      })
      .filter((p) => p.name);
    playersTotal += players.length;

    const logo = pickEntrantLogo(ent);
    if (logo) logosFound++;

    const existing = savedTeams.find((t) => (t.name || '').toLowerCase() === name.toLowerCase());
    if (existing) {
      if (players.length) existing.players = players;            // refresh roster
      if (logo && !existing.logo) existing.logo = logo;          // don't clobber a custom logo
    } else {
      savedTeams.push({ name, logo: logo || null, players });
      teamsAdded++;
    }
  });
  // Keep the transient picker list + name→logo map in sync too.
  state.startgg.eventTeams = mapEntrantsToTeams(entrants);
  indexEntrantLogos(entrants);
  return { teamsAdded, playersTotal, logosFound };
}

// Teams-only import (for the Teams page "Pull from start.gg") — no bracket touch.
async function importStartggTeams(rawSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token (set it in Settings)');
  const { tournamentSlug, eventSlug: parsedSlug } = parseStartggInput(rawSlug);
  const client = createStartGgClient(startggApiToken);
  let slug = parsedSlug;

  if (!slug && tournamentSlug) {
    // Tournament-only URL — auto-pick the event with the most entrants.
    const res = await client.request(`
      query TEvents($slug: String!) {
        tournament(slug: $slug) { events { slug numEntrants } }
      }`, { slug: 'tournament/' + tournamentSlug });
    const events = (res?.tournament?.events || []).sort((a, b) => (b.numEntrants || 0) - (a.numEntrants || 0));
    if (!events.length) throw new Error('No events found in that tournament');
    slug = events[0].slug;
  }

  if (!slug) throw new Error('Paste a start.gg event or tournament URL');
  const entrants = await fetchAllEntrants(client, slug);
  const r = mergeEntrantsIntoLibrary(entrants);
  saveTeams();
  saveAppState();
  broadcastFullState();
  return { teams: entrants.length, teamsAdded: r.teamsAdded, players: r.playersTotal, logos: r.logosFound };
}

// One-shot: load EVERYTHING for an event — teams, players, and the bracket.
async function loadEvent(rawSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token (set it in Settings)');
  const slug = parseEventSlug(rawSlug);
  if (!slug) throw new Error('Missing event slug or URL');

  const client = createStartGgClient(startggApiToken);
  // TEAMS FIRST: entrants are ~10-20 requests and they're what the user is waiting
  // to see — apply and broadcast them before starting the long phased bracket import.
  const entrants = await fetchAllEntrants(client, slug);
  // Only populate the transient event roster — don't touch savedTeams (user saves manually)
  const eventTeams = mapEntrantsToTeams(entrants);
  state.startgg.eventTeams = eventTeams;
  indexEntrantLogos(entrants);
  broadcastFullState();
  // Bracket via the phased import (live phase first, completed phases cached,
  // progressive broadcasts) — the old single fetchAllSets sweep timed out on
  // RLCS-scale events and tripped start.gg rate limits.
  const bk = await fetchBracket(slug);
  const event = { name: state.bracket.title || bk.title || '', tournament: { name: bk.tournamentName || '' } };

  const players = eventTeams.reduce((sum, t) => sum + (t.players ? t.players.length : 0), 0);
  const logos = eventTeams.filter(t => t.logo).length;

  saveAppState();
  broadcastFullState();

  return {
    title: event.name || '',
    tournamentName: (event.tournament && event.tournament.name) || '',
    type: state.bracket.type,
    teams: entrants.length,
    players,
    logos,
    sets: bk.sets
  };
}

// Load teams (with players) for the selected event WITHOUT merging into savedTeams.
// Used for the transient "start.gg teams" list. Also updates selectedEvent + tournamentSlug.
async function loadStartggEventTeams(tournamentSlug, eventSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token (set it in Settings)');
  const slug = parseEventSlug(eventSlug || tournamentSlug || '');
  if (!slug) throw new Error('Missing tournament or event slug');

  const client = createStartGgClient(startggApiToken);
  const entrantsRaw = await fetchAllEntrants(client, slug);
  const teams = mapEntrantsToTeams(entrantsRaw);

  // Update state
  state.startgg.tournamentSlug = (tournamentSlug || state.startgg.tournamentSlug || '').trim();
  if (eventSlug) state.startgg.eventSlug = eventSlug.trim();

  state.startgg.selectedEvent = {
    tournamentSlug: (tournamentSlug || '').trim() || state.startgg.tournamentSlug,
    eventSlug: (eventSlug || '').trim(),
    name: '', // can be enriched if we fetch event name
    tournamentName: ''
  };

  state.startgg.eventTeams = teams;

  saveAppState();
  broadcastFullState();

  return { teams: teams.length, players: teams.reduce((n, t) => n + (t.players ? t.players.length : 0), 0) };
}

// Best team logo from a Start.gg entrant's linked team (null for ad-hoc entrants).
function pickEntrantLogo(ent) {
  const imgs = (ent && ent.team && ent.team.images) || [];
  if (!imgs.length) return null;
  const profile = imgs.find((i) => i.type === 'profile' && i.url);
  if (profile) return profile.url;
  const any = imgs.find((i) => i.url);
  return any ? any.url : null;
}

// One-shot "make this event the broadcast event": full team import (→ library with
// logos) + bracket (all phases) + stream queue, and start polling for live updates.
async function activateStartggEvent(tournamentSlug, eventSlug, meta) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token (set it in Settings)');
  const evSlug = parseEventSlug(eventSlug || '');
  if (!evSlug || !/\/event\//i.test(evSlug)) throw new Error('Missing event slug');
  const tSlug = (tournamentSlug || (evSlug.match(/tournament\/([^/]+)/i) || [])[1] || '').trim();

  // Teams (→ library, with logos) + bracket (phases).
  const loaded = await loadEvent(evSlug);

  state.startgg.tournamentSlug = tSlug;
  state.startgg.eventSlug = evSlug;
  // Activating an event is the explicit "this is my event" — the bracket follows it again
  // even if a different slug was typed into the bracket panel earlier.
  state.bracket.followActive = true;
  state.startgg.enabled = true;
  state.startgg.selectedEvent = {
    tournamentSlug: tSlug,
    eventSlug: evSlug,
    name: (meta && meta.name) || loaded.title || '',
    tournamentName: (meta && meta.tournamentName) || loaded.tournamentName || ''
  };
  state.startgg.pendingEvents = [];
  state.activeEvent = {
    platform: 'startgg',
    slug: evSlug,
    name: state.startgg.selectedEvent.name || state.startgg.selectedEvent.tournamentName || '',
    gameName: '',
    numEntrants: (state.startgg.eventTeams || []).length,
    format: '',
    url: `https://www.start.gg/${evSlug}`,
    loadedAt: new Date().toISOString()
  };

  // Auto-fill the event name from the start.gg tournament name if the producer hasn't set one.
  if (!state.eventName) {
    state.eventName = state.startgg.selectedEvent.tournamentName || state.startgg.selectedEvent.name || '';
  }

  // Stream queue (non-fatal if the tournament has no queued streams yet).
  let queued = 0;
  if (tSlug) {
    try { const q = await fetchStreamQueue(tSlug); queued = q.count || 0; } catch (e) { /* optional */ }
  }
  // One-click setup: turn on the queue + auto-follow so the live match auto-pushes to the scoreboard,
  // and begin live polling (queue + bracket + standings refresh) now that we have a slug.
  setActivePlatform('startgg');   // active platform — silence Challonge / NXGEN follow before we start ours
  state.startgg.queueEnabled = true;
  state.startgg.autoFollow = true;
  setStartggQueuePolling(true);

  // Standings follow the newly-activated event too — unless the producer built manual rows.
  // Without this, rows frozen from a PREVIOUS event/league pull shadow the live event forever
  // (standings.html prefers rows over bracket.standings).
  if ((state.standings?.source || '') !== 'manual') {
    state.standings.rows = (state.bracket.standings || []).map((r) => ({ ...r }));
    state.standings.source = 'startgg';
  }

  saveAppState();
  broadcastFullState();
  return { ...loaded, tournamentSlug: tSlug, eventSlug: evSlug, queued, eventName: state.startgg.selectedEvent.name };
}

// Resolve any pasted start.gg input (tournament URL, event URL, or bare slug) and
// activate it. If a tournament has multiple events, return them for the panel to pick.
async function resolveStartggUrl(input) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token (set it in Settings)');
  const { tournamentSlug, eventSlug } = parseStartggInput(input);
  if (!tournamentSlug && !eventSlug) throw new Error('Could not read a start.gg tournament from that link');

  if (eventSlug) {
    const r = await activateStartggEvent(tournamentSlug, eventSlug, {});
    return { activated: true, ...r };
  }

  // Tournament-only — resolve its events.
  const events = await fetchTournamentEvents(startggApiToken, tournamentSlug);
  if (!events.length) throw new Error('Tournament found but has no events — it may not be published yet, or your token may lack access. Try pasting the full event URL instead.');
  if (events.length === 1) {
    const r = await activateStartggEvent(tournamentSlug, events[0].slug, { name: events[0].name, tournamentName: events[0].tournamentName });
    return { activated: true, ...r };
  }
  // Multiple events → let the producer pick (largest first).
  const sorted = [...events].sort((a, b) => (b.numEntrants || 0) - (a.numEntrants || 0));
  state.startgg.pendingEvents = sorted.map((e) => ({ slug: e.slug, name: e.name, numEntrants: e.numEntrants, game: e.game }));
  state.startgg.selectedEvent = { tournamentSlug, eventSlug: '', name: '', tournamentName: events[0].tournamentName || '' };
  saveAppState();
  broadcastFullState();
  return { activated: false, needsEventPick: true, tournamentSlug, tournamentName: events[0].tournamentName || '', events: state.startgg.pendingEvents };
}

// ─── CS2 Game State Integration ──────────────────────────────────────────────
const GSI_TOKEN = 'ne-broadcast-suite';
const GSI_CFG = `"NE Broadcast Suite GSI"
{
  "uri"       "http://localhost:${HTTP_PORT}/gsi"
  "timeout"   "5.0"
  "buffer"    "0.1"
  "throttle"  "0.1"
  "heartbeat" "10.0"
  "auth"
  {
    "token" "${GSI_TOKEN}"
  }
  "data"
  {
    "provider"                "1"
    "map"                     "1"
    "round"                   "1"
    "player_id"               "1"
    "player_state"            "1"
    "player_weapons"          "1"
    "player_match_stats"      "1"
    "player_position"         "1"
    "allplayers_id"           "1"
    "allplayers_state"        "1"
    "allplayers_match_stats"  "1"
    "allplayers_weapons"      "1"
    "allplayers_position"     "1"
    "bomb"                    "1"
    "phase_countdowns"        "1"
    "allgrenades"             "1"
  }
  "output"
  {
    "precision_time"      "3"
    "precision_position"  "2"
    "precision_vel"       "2"
  }
}
`;

// Parse a GSI "x, y, z" position string into {x, y} world coords (for the radar).
function parseVec(str) {
  if (typeof str !== 'string') return null;
  const a = str.split(',').map((s) => parseFloat(s));
  if (a.length < 2 || isNaN(a[0]) || isNaN(a[1])) return null;
  return { x: a[0], y: a[1] };
}

// Normalise the GSI 'grenades' block into radar markers. Smokes/infernos persist;
// frag/flash/decoy are mostly in-flight. Inferno (fire) reports a 'flames' set
// rather than a single position, so we use the centroid of the flames.
function parseGrenades(grenades) {
  const out = [];
  Object.keys(grenades || {}).forEach((id) => {
    const g = grenades[id] || {};
    const type = g.type || '';
    if ((type === 'inferno' || type === 'firebomb') && g.flames) {
      const pts = Object.values(g.flames).map(parseVec).filter(Boolean);
      if (pts.length) {
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        out.push({ type: 'inferno', x: cx, y: cy });
      }
    } else {
      const p = parseVec(g.position);
      if (p) out.push({ type, x: p.x, y: p.y, effecttime: g.effecttime !== undefined ? Number(g.effecttime) : null });
    }
  });
  return out;
}

// Pull active weapon (+ ammo), grenades, bomb flag from a GSI weapons object.
function parseWeapons(weapons) {
  const out = { weapon: '', clip: null, reserve: null, nades: [], hasBomb: false };
  Object.keys(weapons || {}).forEach((slot) => {
    const w = weapons[slot] || {};
    const name = (w.name || '').replace('weapon_', '');
    if (!name) return;
    if (w.type === 'C4') out.hasBomb = true;
    if (w.type === 'Grenade') out.nades.push(name);   // raw base name → overlay renders the SVG
    if (w.state === 'active') {
      out.weapon = name;   // raw GSI base name (lowercase), e.g. "ak47", "m4a1_silencer"
      if (w.ammo_clip !== undefined) out.clip = w.ammo_clip;
      if (w.ammo_reserve !== undefined) out.reserve = w.ammo_reserve;
    }
  });
  return out;
}

let csgoStaleTimer = null;

function markCsgoActivity() {
  state.csgo.connected = true;
  state.csgo.lastUpdate = Date.now();
  if (csgoStaleTimer) clearTimeout(csgoStaleTimer);
  csgoStaleTimer = setTimeout(() => {
    if (state.csgo.connected) try { analytics.event('disconnect', { what: 'CS2 GSI' }); } catch (e) {}
    state.csgo.connected = false;
    broadcastCsgo();
  }, 15000);
}

function broadcastCsgo() {
  broadcast(bridgeClients, { type: 'csgo_update', data: state.csgo });
}

// ── Valorant Local Client API (port 2999) ────────────────────────────────────
// Valorant runs an HTTPS server on 127.0.0.1:2999 with a self-signed cert while
// a game is active. We poll it every 500 ms when Valorant is the active game.

const VAL_MAP_NAMES = {
  '/game/maps/ascent/ascent':   'Ascent',
  '/game/maps/port/port':       'Icebox',
  '/game/maps/triad/triad':     'Haven',
  '/game/maps/duality/duality': 'Bind',
  '/game/maps/bonsai/bonsai':   'Split',
  '/game/maps/foxtrot/foxtrot': 'Breeze',
  '/game/maps/canyon/canyon':   'Fracture',
  '/game/maps/pitt/pitt':       'Pearl',
  '/game/maps/jam/jam':         'Lotus',
  '/game/maps/juliett/juliett': 'Sunset',
  '/game/maps/infinity/infinity': 'Abyss',
  'ascent': 'Ascent', 'icebox': 'Icebox', 'haven': 'Haven', 'bind': 'Bind',
  'split': 'Split', 'breeze': 'Breeze', 'fracture': 'Fracture', 'pearl': 'Pearl',
  'lotus': 'Lotus', 'sunset': 'Sunset', 'abyss': 'Abyss',
};

const _valHttpsAgent = new https.Agent({ rejectUnauthorized: false });

function _valorantFetch(apiPath) {
  return axios.get(`https://127.0.0.1:2999${apiPath}`, {
    httpsAgent: _valHttpsAgent,
    timeout: 1500,
  }).then(r => r.data);
}

function _parseValorantAgent(rawName) {
  // "game_character_default_reyna" → "reyna"
  return (rawName || '').replace(/^game_character_default_/i, '').toLowerCase();
}

function _resolveMapName(raw) {
  if (!raw) return '';
  const key = raw.toLowerCase();
  return VAL_MAP_NAMES[key] || VAL_MAP_NAMES[key.split('/').pop()] || raw;
}

function handleValorantData(data) {
  const v = state.valorant;
  v.connected = true;
  v.lastUpdate = Date.now();

  // Map
  const gd = data.gameData || {};
  const mapRaw = gd.mapName || '';
  v.map.name = mapRaw;
  v.map.displayName = _resolveMapName(mapRaw);

  // Round history from events → derive scores
  const events = (data.events && data.events.Events) || [];
  const ended = events.filter(e => e.EventName === 'Round_Ended');
  const started = events.filter(e => e.EventName === 'Round_Start');

  let orderScore = 0, chaosScore = 0;
  const history = [];
  for (const ev of ended) {
    const winner = (ev.Result && ev.Result.WinningTeam) || '';
    if (winner === 'ORDER') orderScore++;
    else if (winner === 'CHAOS') chaosScore++;
    history.push({ round: history.length + 1, winner });
  }
  v.order.score = orderScore;
  v.chaos.score = chaosScore;
  v.roundHistory = history;
  v.round.number    = Math.max(1, started.length > 0 ? started.length : ended.length + 1);
  v.round.gameTime  = gd.gameTime || 0;
  const _lastStart  = started.length > 0 ? started[started.length - 1] : null;
  v.round.startTime = _lastStart ? (_lastStart.EventTime || 0) : 0;

  // Spike state from events
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  if (lastEvent) {
    if (lastEvent.EventName === 'Spike_Start')      v.spikeState = 'planted';
    else if (lastEvent.EventName === 'Spike_Defused')   v.spikeState = 'defused';
    else if (lastEvent.EventName === 'Spike_Detonated') v.spikeState = 'detonated';
    else if (lastEvent.EventName === 'Round_Start')     v.spikeState = '';
    else if (lastEvent.EventName === 'Round_Ended')     v.spikeState = '';
  }

  // Round phase
  v.round.phase = gd.paused ? 'paused' : (v.spikeState === 'planted' ? 'bomb' : 'live');

  // Players
  const allPlayers = data.allPlayers || [];
  v.players = allPlayers.map(p => {
    const mh = p.maxHealth || 100;
    return {
      name:      p.summonerName || '',
      agent:     _parseValorantAgent(p.rawChampionName),
      agentName: p.championName || '',
      team:      p.team || 'ORDER',
      health:    p.currentHealth != null ? p.currentHealth : 100,
      maxHealth: mh,
      armor:     mh > 125 ? 2 : mh > 100 ? 1 : 0, // 0=none 1=light(25) 2=heavy(50)
      alive:     !(p.isDead) && (p.currentHealth || 0) > 0,
      kills:     (p.scores && p.scores.kills)   || 0,
      assists:   (p.scores && p.scores.assists) || 0,
      deaths:    (p.scores && p.scores.deaths)  || 0,
    };
  });

  // Active (spectated) player
  const active = data.activePlayer;
  if (active && active.summonerName) {
    v.observed = v.players.find(p => p.name === active.summonerName) || null;
  }

  // Stats: detect game start/finish from the live scores and persist player stats.
  try { _valorantStats(v); } catch (e) {}

  broadcastValorant();
}

// Valorant has no map.phase signal like CS2's GSI, so we derive the game
// lifecycle from the live scoreline: a fresh live game with players present
// opens a stats game; reaching 13 with a 2-round lead closes it (once).
function _valorantStats(v) {
  const o = v.order.score || 0, c = v.chaos.score || 0;
  const gameOver = (o >= 13 || c >= 13) && Math.abs(o - c) >= 2;
  const live = v.connected && v.map && v.map.name && (v.players || []).length > 0;
  const mapName = v.map.displayName || v.map.name || '';

  // New game: a live game in progress with no stats game already open.
  if (live && !statsValGameId && !gameOver) {
    if (!statsCurrentMatchId) {
      statsCurrentMatchId = stats.startMatch({
        gameType: 'valorant',
        teamA: state.teams?.blue?.name || 'Team A',
        teamB: state.teams?.orange?.name || 'Team B',
        bestOf: state.bestOf,
        startggSetId: state.startgg?.setId || null,
        tournament: state.startgg?.selectedEvent?.tournamentName || null
      });
    }
    statsValGameId = stats.startGame({
      matchId: statsCurrentMatchId,
      gameNumber: state.game?.number || 1,
      gameType: 'valorant',
      map: mapName
    });
  }

  // Game over: finalize once, then wait for the next map to reset the scoreline.
  if (statsValGameId && gameOver) {
    stats.endGame(statsValGameId, {
      scoreA: o, scoreB: c,
      winner: o > c ? 'a' : c > o ? 'b' : null,
      map: mapName
    });
    try { analytics.event('game_complete'); } catch (e) {}
    const players = (v.players || []).map(p => ({
      name: p.name,
      team: p.team === 'CHAOS' ? 'b' : 'a',   // ORDER=a, CHAOS=b (fixed team identities)
      agent: p.agentName || p.agent || '',
      kills: p.kills || 0, deaths: p.deaths || 0, assists: p.assists || 0
    }));
    stats.saveValorantPlayerStats(statsValGameId, players);
    statsValGameId = null;
  }
}

function broadcastValorant() {
  broadcast(bridgeClients, { type: 'valorant_update', data: state.valorant });
}

let _valPollTimer = null;

function startValorantPolling() {
  if (_valPollTimer) return;
  _valPollTimer = setInterval(async () => {
    try {
      const data = await _valorantFetch('/liveclientdata/allgamedata');
      handleValorantData(data);
    } catch {
      if (state.valorant.connected) {
        try { analytics.event('disconnect', { what: 'Valorant' }); } catch (e) {}
        state.valorant.connected = false;
        broadcastValorant();
      }
    }
  }, 500);
}
function stopValorantPolling() {
  if (_valPollTimer) { clearInterval(_valPollTimer); _valPollTimer = null; }
  if (state.valorant.connected) { state.valorant.connected = false; broadcastValorant(); }
}

// ── League of Legends Live Client Data (port 2999, spectator) ────────────────
// Drives the automated in-game LoL HUD. Polls /liveclientdata/allgamedata once a
// second when League is the active game (the scoreboard changes far slower than a
// shooter, so 1s is plenty and keeps broadcast churn low). See backend/lol-live.js.
function broadcastLol() {
  broadcast(bridgeClients, { type: 'lol_update', data: state.lol });
}

// Last fresh OCR read of team gold; overrides the estimate while recent.
let _lolOcrGold = null;   // { blue, red, ts }

function handleLolData(data) {
  const norm = lolLive.normalizeGameData(data);
  const wasConnected = state.lol.connected;
  Object.assign(state.lol, norm, { lastUpdate: Date.now() });  // preserves ocr / hudMode (not in norm)
  // Real gold from OCR overrides the estimate when enabled and fresh (<8s old).
  const o = state.lol.ocr;
  if (o.enabled && _lolOcrGold && (Date.now() - _lolOcrGold.ts) < 8000 && _lolOcrGold.blue != null && _lolOcrGold.red != null) {
    state.lol.blue.gold = _lolOcrGold.blue;
    state.lol.red.gold  = _lolOcrGold.red;
    state.lol.goldDiff  = _lolOcrGold.blue - _lolOcrGold.red;
    o.source = 'ocr';
  } else {
    o.source = 'est';
  }
  if (!wasConnected) { try { analytics.event('connect', { what: 'League' }); } catch (e) {} }
  broadcastLol();
}

// ── League gold OCR (optional override of the estimate) ──────────────────────
let _lolOcrStop = null;
function startLolOcr() {
  if (_lolOcrStop) return;
  state.lol.ocr.available = lolOcr.tessAvailable();
  _lolOcrStop = lolOcr.startOcr({
    intervalMs: 2000,
    getRegions: () => state.lol.ocr.regions,
    onResult: (res) => {
      state.lol.ocr.lastBlue = res.blue;
      state.lol.ocr.lastRed = res.red;
      if (res.blue != null && res.red != null) _lolOcrGold = { blue: res.blue, red: res.red, ts: Date.now() };
    },
    onStatus: (status, detail) => {
      state.lol.ocr.status = status;
      state.lol.ocr.statusDetail = detail;
      broadcast(bridgeClients, { type: 'lol_ocr_status', status, detail, lastBlue: state.lol.ocr.lastBlue, lastRed: state.lol.ocr.lastRed });
    }
  });
}
function stopLolOcr() {
  if (_lolOcrStop) { _lolOcrStop(); _lolOcrStop = null; }
  _lolOcrGold = null;
  state.lol.ocr.status = 'off';
  state.lol.ocr.source = 'est';
}

let _lolPollTimer = null;
function startLolPolling() {
  if (_lolPollTimer) return;
  if (state.lol.ocr.enabled) startLolOcr();
  _lolPollTimer = setInterval(async () => {
    try {
      const data = await lolLive.fetchAllGameData();
      handleLolData(data);
    } catch {
      if (state.lol.connected) {
        try { analytics.event('disconnect', { what: 'League' }); } catch (e) {}
        state.lol.connected = false;
        broadcastLol();
      }
    }
  }, 1000);
}
function stopLolPolling() {
  if (_lolPollTimer) { clearInterval(_lolPollTimer); _lolPollTimer = null; }
  stopLolOcr();
  if (state.lol.connected) { state.lol.connected = false; broadcastLol(); }
}

function mergeDirectorRuntime(out) {
  return {
    ...out,
    lastAutoSwitch: state.director?.lastAutoSwitch || null
  };
}

function broadcastDirectorUpdate() {
  if (!state.director) return;
  broadcast(bridgeClients, { type: 'director_update', data: state.director });
}

function broadcastClipsUpdate() {
  if (!state.clips) return;
  broadcast(bridgeClients, { type: 'clips_update', data: { ...state.clips, encode: state.encode } });
}

function feedDirectorCsgo() {
  if (!directorEngine || !gameHasFeature('csgo', 'director')) return;
  if (state.activeGame !== 'csgo') return;
  directorEngine.onGameUpdate('csgo', {
    ...state.csgo,
    series: state.series,
    bestOf: state.bestOf,
    teams: state.teams,
    spotlight: state.spotlight
  });
}

function feedDirectorRL() {
  if (!directorEngine || !gameHasFeature('rocket-league', 'director')) return;
  if (state.activeGame !== 'rocket-league') return;
  directorEngine.onGameUpdate('rocket-league', {
    players: state.players,
    game: state.game,
    ball: state.rlBall || null,
    spectatedPlayer: state.spectatedPlayer,
    series: state.series,
    bestOf: state.bestOf,
    teams: state.teams,
    spotlight: state.spotlight
  });
}

function feedDirectorBroadcast() {
  if (!directorEngine || !gameHasFeature(state.activeGame, 'director')) return;
  if (state.activeGame === 'csgo' || state.activeGame === 'rocket-league') return;
  if (Date.now() - lastGenericDirectorFeed < 500) return;
  lastGenericDirectorFeed = Date.now();
  directorEngine.onGameUpdate(state.activeGame, {
    game: state.game,
    series: state.series,
    bestOf: state.bestOf,
    teams: state.teams,
    spotlight: state.spotlight,
    breakScreen: state.breakScreen,
    spectatedPlayer: state.spectatedPlayer,
    players: state.players
  });
}

function getDirectorGameState() {
  if (state.activeGame === 'csgo') return state.csgo;
  if (state.activeGame === 'rocket-league') {
    return { players: state.players, game: state.game, spectatedPlayer: state.spectatedPlayer };
  }
  return {
    game: state.game,
    series: state.series,
    teams: state.teams,
    spotlight: state.spotlight
  };
}

// AI Shield — the master kill-switch. When true, every automated AI action is blocked.
// Gate every auto-action site with this so a misbehaving automation can be killed instantly.
function aiShielded() { return !!(state.ai && state.ai.shield); }

// Lightweight "tick context" for telemetry — score/clock/scene/spectated at this instant.
// Deliberately small (NO base64 logos/blobs) so the decision log stays cheap to write.
function buildTelemetryContext() {
  const g = state.activeGame;
  let score = null, clock = null, spectated = null;
  if (g === 'csgo' && state.csgo) {
    score = { a: state.csgo.ct?.score ?? null, b: state.csgo.t?.score ?? null };
    clock = { phase: state.csgo.round?.phase || state.csgo.phase || null, round: state.csgo.round?.number ?? null };
    spectated = state.csgo.observed?.steamid || null;
  } else if (g === 'valorant' && state.valorant) {
    score = { a: state.valorant.order?.score ?? null, b: state.valorant.chaos?.score ?? null };
    clock = { phase: state.valorant.round?.phase || null, round: state.valorant.round?.number ?? null };
    spectated = state.valorant.observed?.name || null;
  } else if (g === 'league' && state.lol) {
    score = { a: state.lol.blue?.kills ?? null, b: state.lol.red?.kills ?? null };
    clock = { seconds: state.lol.gameTime ?? null, goldDiff: state.lol.goldDiff ?? null };
    spectated = state.lol.observed?.name || null;
  } else {
    score = { a: state.game?.blueScore ?? null, b: state.game?.orangeScore ?? null };
    clock = { seconds: state.game?.time ?? null, isOT: !!state.game?.isOT };
    spectated = state.spectatedPlayer || null;
  }
  const p = state.director?.primary || null;
  return {
    game: g || null,
    matchId: statsCurrentMatchId,
    gameId: statsCurrentGameId || statsCs2GameId || statsValGameId || null,
    context: {
      score, clock, spectated,
      scene: state.obs?.currentScene || null,
      recording: !!state.obs?.recording,
      streaming: !!state.obs?.streaming,
      director: p ? { type: p.type || null, targetId: p.target?.id || null, confidence: state.director?.confidence ?? null } : null,
    },
  };
}

// Snapshot the director's current recommendation for a decision record.
function currentDirectorRec() {
  const p = state.director?.primary;
  if (!p) return null;
  return {
    target: p.target || null,
    type: p.type || null,
    confidence: state.director?.confidence ?? null,
    reason: p.reason || null,
    alternates: (state.director?.alternates || []).slice(0, 3).map((a) => ({
      targetId: a.target?.id || null, type: a.type || null, confidence: a.confidence ?? null,
    })),
  };
}

// Log a producer decision on the current director recommendation.
function recordDirectorDecision(decision, opts = {}) {
  if (!telemetry) return;
  telemetry.directorDecision({
    recommendation: currentDirectorRec(),
    decision,
    chosen: opts.chosen || null,
    note: opts.note || null,
    latencyMs: _directorRecShownAt ? (Date.now() - _directorRecShownAt) : null,
  });
}

const DIRECTOR_CAPTURE_TYPES = new Set([
  'goal', 'save', 'ace', 'clutch', 'demo', 'shot', 'kickoff', 'multi_kill', 'defuse', 'match_point'
]);

function buildCaptureMetaFromEvent(event, gameId) {
  const tctx = buildTelemetryContext().context || {};
  return {
    type: event.type,
    game: gameId,
    player: event.target?.name || '',
    reason: event.reason || '',
    label: `${event.type} — ${event.target?.name || 'highlight'}`,
    captureKey: `${event.type}:${event.target?.id || event.target?.name}:${event.ts}`,
    feedTs: event.ts,
    // AI training alignment — tie this clip to the exact game moment that triggered it.
    eventTargetId: event.target?.id || null,
    gameClock: event.gameTime || (tctx.clock || null),
    scoreAtEvent: tctx.score || null
  };
}

// Merge the clip-manager's state into state.clips while preserving the
// server-only fields (captureMode / autoMontage / autoMontageId).
function syncClipsState() {
  if (!clipSystem) return;
  const cur = state.clips || {};
  state.clips = {
    ...clipSystem.getState(),
    encode: state.encode,
    captureMode: cur.captureMode || 'auto',
    autoMontage: !!cur.autoMontage,
    autoMontageId: cur.autoMontageId || null
  };
  clipsVer++;
}

async function triggerClipCapture(meta) {
  if (!clipSystem) return null;
  const clip = await clipSystem.onHighlightEvent(meta);
  if (clip) try { analytics.event('clip'); } catch (e) {}
  syncClipsState();
  broadcastClipsUpdate();
  return clip;
}

// Append a captured clip to the rolling "Live Montage" (auto-montage mode).
function maybeAutoMontage(clip) {
  if (!clip || !clip.path || !state.clips?.autoMontage || !clipSystem) return;
  let m = state.clips.autoMontageId
    ? clipSystem.getState().montages.find((x) => x.id === state.clips.autoMontageId)
    : null;
  if (!m) {
    m = clipSystem.manager.createMontage({ name: 'Live Montage', clipIds: [], template: 'highlights' });
    state.clips.autoMontageId = m.id;
  }
  clipSystem.manager.reorderMontage(m.id, (m.clipIds || []).concat(clip.id));
  syncClipsState();
  broadcastClipsUpdate();
}

function onDirectorEvents(gameId, events) {
  if (!events.length) return;
  if (aiShielded()) return;   // shield blocks all auto-clipping
  const mode = state.clips?.captureMode || 'auto';

  events.forEach((event) => {
    if (mode === 'manual') return;
    if (!DIRECTOR_CAPTURE_TYPES.has(event.type)) return;
    if (state.clips.captureRules[event.type] === false) return;
    const meta = buildCaptureMetaFromEvent(event, gameId);

    if (mode === 'prompt') {
      // Ask the producer before clipping (replay buffer still holds the moment).
      broadcast(bridgeClients, {
        type: 'clip_prompt',
        data: { id: `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, meta,
          label: meta.label, type: meta.type, player: meta.player || '', game: gameId, ts: Date.now() }
      });
    } else {
      // 'auto' — clip silently, optionally appending to the live montage.
      triggerClipCapture(meta).then((clip) => {
        maybeAutoMontage(clip);
        // Telemetry: an auto-clip was produced from this event (ground truth for the clip model).
        if (clip && telemetry) telemetry.clipDecision({
          clipId: clip.id, decision: 'auto',
          trigger: { type: event.type, targetId: event.target?.id || null, confidence: event.priority ?? null, ts: event.ts },
        });
      }).catch((e) => console.error('[Clips] Capture error:', e.message));
    }
  });
}

// ── Kill feed ─────────────────────────────────────────────────────────────
// GSI has no per-kill event, so we infer kills by diffing cumulative counters:
// a player whose `deaths` ticked up died; a player whose `roundKills` ticked up
// got the frag (weapon = their active weapon; headshot if `roundHs` ticked up).
// Firing detection: GSI has no "shooting" flag, so we infer it — a player's active-weapon
// ammo clip dropping (same weapon, no reload) means they just fired. Set per tick; the
// overlay latches the effect for a short window so sustained fire reads as a steady pulse.
let prevFire = {};               // steamid -> { clip, weapon }
function detectFiring(players) {
  const cur = {};
  (players || []).forEach((p) => {
    const prev = prevFire[p.steamid];
    const clip = (typeof p.clip === 'number') ? p.clip : null;
    p.firing = !!(prev && p.alive && clip !== null && typeof prev.clip === 'number'
      && p.weapon === prev.weapon && clip < prev.clip && (prev.clip - clip) <= 40);
    cur[p.steamid] = { clip, weapon: p.weapon };
  });
  prevFire = cur;
}

let killPrev = null;             // steamid -> { deaths, roundKills, roundHs }
const KILL_TTL = 7000;           // ms a kill stays on the feed
const KILL_MAX = 6;              // most rows kept

function updateKillfeed(players) {
  const now = Date.now();
  const cur = {};
  players.forEach(p => { cur[p.steamid] = p; });

  if (killPrev) {
    const victims = [];          // players who just died
    const kills = [];            // { p, hs } per frag credited this tick
    players.forEach(p => {
      const pp = killPrev[p.steamid];
      if (!pp) return;
      if ((p.deaths || 0) > (pp.deaths || 0)) victims.push(p);
      const dk = (p.roundKills || 0) - (pp.roundKills || 0);
      const dhs = (p.roundHs || 0) - (pp.roundHs || 0);
      for (let i = 0; i < dk; i++) kills.push({ p, hs: i < dhs });   // mark the headshot frags first
    });

    if (victims.length || kills.length) {
      const used = new Set();
      const pickVictim = (killerTeam) => {
        let i = victims.findIndex((v, idx) => !used.has(idx) && v.team !== killerTeam);   // prefer an enemy
        if (i === -1) i = victims.findIndex((v, idx) => !used.has(idx));                   // else any unclaimed
        if (i === -1) return null; used.add(i); return victims[i];
      };
      kills.forEach(k => {
        const v = pickVictim(k.p.team);
        state.csgo.killfeed.push({
          killer: k.p.name, killerTeam: k.p.team, weapon: k.p.weapon || '',
          hs: !!k.hs, victim: v ? v.name : '', victimTeam: v ? v.team : '', ts: now
        });
      });
      // Deaths with no matching frag → world / suicide (fall damage, bomb, leaving)
      victims.forEach((v, idx) => {
        if (used.has(idx)) return;
        state.csgo.killfeed.push({ killer: '', killerTeam: '', weapon: '', hs: false, victim: v.name, victimTeam: v.team, ts: now });
      });
    }
  }

  // Expire + cap
  state.csgo.killfeed = state.csgo.killfeed.filter(k => now - k.ts < KILL_TTL).slice(-KILL_MAX);
  killPrev = {};
  players.forEach(p => { killPrev[p.steamid] = { deaths: p.deaths || 0, roundKills: p.roundKills || 0, roundHs: p.roundHs || 0 }; });
}

// Normalise a CS2 GSI payload into our csgo state.
function handleGsi(payload) {
  if (!payload || typeof payload !== 'object') return;

  const map = payload.map || {};
  const round = payload.round || {};
  const ctInfo = map.team_ct || {};
  const tInfo = map.team_t || {};

  state.csgo.map = { name: map.name || '', phase: map.phase || '', mode: map.mode || '' };
  const sideInfo = (info) => ({
    name: info.name || '',
    score: info.score ?? 0,
    lossBonus: info.consecutive_round_losses ?? 0,   // loss-streak (drives buy economy)
    timeouts: info.timeouts_remaining ?? 0,
    seriesWins: info.matches_won_this_series ?? 0
  });
  state.csgo.ct = { ...sideInfo(ctInfo), name: ctInfo.name || 'COUNTER-TERRORISTS' };
  state.csgo.t  = { ...sideInfo(tInfo),  name: tInfo.name  || 'TERRORISTS' };
  // Auto team names → match saved library for logos/colours (CT=Blue side, T=Orange side).
  if (state.autoTeamsFromGame) { applyGameTeamName('blue', ctInfo.name); applyGameTeamName('orange', tInfo.name); }
  state.csgo.round = {
    number: (typeof map.round === 'number') ? map.round + 1 : (state.csgo.round.number || 0),
    phase: round.phase || map.phase || '',
    bomb: round.bomb || '',
    winTeam: round.win_team || ''                     // 'CT' | 'T' at round end
  };
  const prov = payload.provider || {};
  state.csgo.provider = { version: prov.version ?? null, timestamp: prov.timestamp ?? null };

  // Players (allplayers is keyed by steamid; only present when observing)
  const all = payload.allplayers || {};
  const players = Object.keys(all).map((steamid) => {
    const p = all[steamid] || {};
    const st = p.state || {};
    const ms = p.match_stats || {};

    const wp = parseWeapons(p.weapons);
    return {
      steamid,
      name: p.name || '?',
      team: p.team || '',          // 'CT' | 'T'
      slot: p.observer_slot ?? 99,
      health: st.health ?? 0,
      armor: st.armor ?? 0,
      helmet: !!st.helmet,
      money: st.money ?? 0,
      kills: ms.kills ?? 0,
      assists: ms.assists ?? 0,
      deaths: ms.deaths ?? 0,
      mvps: ms.mvps ?? 0,
      score: ms.score ?? 0,          // scoreboard points — sidebar sorts by this
      roundKills: st.round_kills ?? 0,
      roundHs: st.round_killhs ?? 0,  // headshot kills this round
      roundDmg: st.round_totaldmg ?? 0,
      alive: (st.health ?? 0) > 0,
      equip: st.equip_value ?? 0,     // current loadout value (gun+armor+nades)
      flashed: st.flashed ?? 0,       // 0–255 blind intensity
      burning: st.burning ?? 0,       // 0–255 on fire
      smoked: st.smoked ?? 0,         // 0–255 obscured by smoke
      pos: parseVec(p.position),      // world {x,y} for the radar (observer GSI only)
      fwd: parseVec(p.forward),       // view/forward {x,y} → facing arrow on the radar
      weapon: wp.weapon,
      clip: wp.clip,                  // active-weapon ammo → firing detection (clip drop)
      nades: wp.nades,
      hasKit: !!st.defusekit,
      hasBomb: wp.hasBomb,
      firing: false                   // set by detectFiring() below
    };
  }).sort((a, b) => a.slot - b.slot);
  detectFiring(players);
  if (players.length) state.csgo.players = players;

  if (players.length) updateKillfeed(players);

  // Observed/spectated player (bottom focus panel) — GSI 'player' block
  const obs = payload.player;
  if (obs && obs.state) {
    const ost = obs.state;
    const oms = obs.match_stats || {};
    const owp = parseWeapons(obs.weapons);
    state.csgo.observed = {
      steamid: obs.steamid || '',
      name: obs.name || '',
      team: obs.team || '',
      health: ost.health ?? 0,
      armor: ost.armor ?? 0,
      helmet: !!ost.helmet,
      money: ost.money ?? 0,
      kills: oms.kills ?? 0,
      assists: oms.assists ?? 0,
      deaths: oms.deaths ?? 0,
      mvps: oms.mvps ?? 0,
      score: oms.score ?? 0,
      roundKills: ost.round_kills ?? 0,
      roundHs: ost.round_killhs ?? 0,
      roundDmg: ost.round_totaldmg ?? 0,
      armorHelmet: !!ost.helmet,
      flashed: ost.flashed ?? 0,
      smoked: ost.smoked ?? 0,
      burning: ost.burning ?? 0,
      alive: (ost.health ?? 0) > 0,
      weapon: owp.weapon,
      clip: owp.clip,
      reserve: owp.reserve,
      nades: owp.nades,
      hasKit: !!ost.defusekit,
      hasBomb: owp.hasBomb
    };
  } else {
    state.csgo.observed = null;
  }

  // Round-win history (map.round_wins: { "1": "ct_win_elimination", ... })
  const rw = map.round_wins || {};
  state.csgo.roundHistory = Object.keys(rw)
    .map((k) => ({ round: parseInt(k, 10), result: rw[k] || '' }))
    .filter((r) => !isNaN(r.round))
    .sort((a, b) => a.round - b.round)
    .map((r) => ({
      round: r.round,
      winner: r.result.startsWith('ct') ? 'CT' : 'T',
      method: r.result.split('_').slice(2).join('_') || r.result.replace(/^(ct|t)_win_?/, '')
    }));

  // Bomb + phase countdown
  if (payload.bomb) {
    state.csgo.bomb = {
      state: payload.bomb.state || '',
      countdown: payload.bomb.countdown ?? null,
      pos: parseVec(payload.bomb.position),
      player: payload.bomb.player || ''   // steamid planting/defusing (→ kit-aware defuse time)
    };
  } else if (round.bomb) {
    state.csgo.bomb = { state: round.bomb, countdown: null, pos: null, player: '' };
  } else {
    state.csgo.bomb = { state: '', countdown: null, pos: null, player: '' };
  }
  const pc = payload.phase_countdowns || {};
  state.csgo.phase = pc.phase || '';
  state.csgo.phaseEndsIn = (pc.phase_ends_in !== undefined) ? Number(pc.phase_ends_in) : null;

  state.csgo.grenades = parseGrenades(payload.grenades);

  markCsgoActivity();
  broadcastCsgo();
  feedDirectorCsgo();

  // CS2 OBS scene cuts on map phase changes (when auto-switch is on)
  const mapPhase = (state.csgo.map && state.csgo.map.phase) || '';
  if (state.activeGame === 'csgo' && mapPhase && mapPhase !== _csgoLastMapPhase) {
    const prev = _csgoLastMapPhase;
    _csgoLastMapPhase = mapPhase;

    if (mapPhase === 'live' && prev && prev !== 'live') {
      obsSwitch('inGame');
      // Stats: start CS2 match + game
      if (!statsCurrentMatchId) {
        statsCurrentMatchId = stats.startMatch({
          gameType: 'cs2',
          teamA: state.csgo.ct?.name || 'CT',
          teamB: state.csgo.t?.name  || 'T',
          bestOf: state.bestOf,
          startggSetId: state.startgg?.setId || null,
          tournament: state.startgg?.selectedEvent?.tournamentName || null
        });
      }
      statsCs2GameId = stats.startGame({
        matchId: statsCurrentMatchId,
        gameNumber: state.game?.number || 1,
        gameType: 'cs2',
        map: state.csgo.map?.name || ''
      });
    } else if (mapPhase === 'gameover') {
      obsSwitch('postGame');
      // Stats: finalize CS2 game
      if (statsCs2GameId) {
        const ctScore = state.csgo.ct?.score || 0;
        const tScore  = state.csgo.t?.score  || 0;
        stats.endGame(statsCs2GameId, {
          scoreA: ctScore, scoreB: tScore,
          winner: ctScore > tScore ? 'a' : tScore > ctScore ? 'b' : null,
          map: state.csgo.map?.name || ''
        });
        try { analytics.event('game_complete'); } catch (e) {}
        (state.csgo.roundHistory || []).forEach(r => {
          stats.logCs2Round(statsCs2GameId, {
            roundNumber: r.round,
            winner: r.winner,
            winCondition: r.method,
            bombPlanted:  ['bomb', 'defuse'].includes(r.method),
            bombDefused:  r.method === 'defuse'
          });
        });
        const cs2Players = (state.csgo.players || []).map(p => ({
          steamId: p.steamid,
          name:    p.name,
          team:    p.team === 'CT' ? 'a' : 'b',
          kills:   p.kills   || 0,
          deaths:  p.deaths  || 0,
          assists: p.assists  || 0,
          mvps:    p.mvps    || 0,
          score:   p.score   || 0
        }));
        stats.saveCs2PlayerStats(statsCs2GameId, cs2Players);
        statsCs2GameId = null;
      }
    } else if (mapPhase === 'intermission') {
      flowBus.emit('cs2_half_time', {});
    } else if (mapPhase === 'warmup' && prev !== 'warmup') {
      obsSwitch('break');
    }
    if (mapPhase === 'gameover') flowBus.emit('cs2_match_ended', { ctScore: state.csgo.ct && state.csgo.ct.score || 0, tScore: state.csgo.t && state.csgo.t.score || 0 });
  }

  // CS2 per-round and bomb flow triggers
  if (state.activeGame === 'csgo') {
    const _cs2Rp = (state.csgo.round && state.csgo.round.phase) || '';
    if (_cs2Rp !== _csgoLastRoundPhase) {
      if (_cs2Rp === 'live' && (_csgoLastRoundPhase === 'freezetime' || _csgoLastRoundPhase === ''))
        flowBus.emit('cs2_round_start', { round: state.csgo.round && state.csgo.round.number });
      if (_cs2Rp === 'over')
        flowBus.emit('cs2_round_end', { winner: state.csgo.round && state.csgo.round.winTeam, round: state.csgo.round && state.csgo.round.number });
      _csgoLastRoundPhase = _cs2Rp;
    }
    const _cs2Bomb = (state.csgo.bomb && state.csgo.bomb.state) || '';
    if (_cs2Bomb === 'planted' && _csgoLastBombState !== 'planted')
      flowBus.emit('cs2_bomb_planted', { round: state.csgo.round && state.csgo.round.number });
    _csgoLastBombState = _cs2Bomb;
  }
}

// ── Map-veto engine ─────────────────────────────────────────────────────────
// Builds state.veto from a game's map pool + competitive format, then guides the
// ban/pick step-by-step. The overlay (mapscreen.html) already renders state.veto.maps,
// so the engine's job is to keep that board (+ a `turn` prompt) in sync.

// Rebuild the overlay board (maps[]) + turn prompt from the working pool/sequence/ops.
function rebuildVetoBoard() {
  const v = state.veto;
  if (!v || !Array.isArray(v.pool)) return;
  const opByMap = {};
  (v.ops || []).forEach(o => { opByMap[o.mapId] = o; });
  const complete = (v.ops || []).length >= (v.sequence || []).length;
  // Preserve any entered result (winner/score) across rebuilds, keyed by map id.
  const prevById = {};
  (v.maps || []).forEach(m => { if (m._id) prevById[m._id] = m; });

  v.maps = v.pool.map(m => {
    const op = opByMap[m.id];
    const prev = prevById[m.id] || {};
    let action = '', by = '';
    if (op) { action = op.action; by = op.by; }
    else if (complete) { action = 'decider'; by = ''; }       // leftover map(s) = decider
    return {
      _id: m.id, name: m.name, mode: m.type || '', image: m.image || '',
      action, by,
      winner: prev.winner || '', score: { a: Number(prev.score?.a) || 0, b: Number(prev.score?.b) || 0 }
    };
  });

  // Whose turn / what action next (null once the veto is complete).
  const next = (v.sequence || [])[(v.ops || []).length] || null;
  v.turn = next ? { team: next.by, action: next.action } : null;
  v.complete = complete;
}

function vetoStart({ game, bestOf, teamStart, title }) {
  const pools = vetoData.mergedMapPools(state.gameConfigs);   // built-in + active Game Config maps
  const hasPool = (id) => (pools[id] || []).length > 0;
  const g = hasPool(game) ? game : (hasPool(state.activeGame) ? state.activeGame : 'csgo');
  const pool = pools[g] || [];
  if (!pool.length) throw new Error('No map pool defined for ' + g);
  const bo = [1, 3, 5, 7].includes(Number(bestOf)) ? Number(bestOf) : 1;
  const ts = teamStart === 'b' ? 'b' : 'a';
  const seq = vetoData.buildSequence(g, bo, pool.length)
    .map(s => ({ action: s.action, by: vetoData.resolveSide(s.teamIdx, ts) }));
  const meta = vetoData.getMeta(g);
  state.veto = {
    visible: !!(state.veto && state.veto.visible),
    title: typeof title === 'string' ? title : (state.veto && state.veto.title) || '',
    game: g, bestOf: bo, teamStart: ts,
    kind: meta.kind, banWord: meta.banWord, unit: meta.unit,
    pool, sequence: seq, ops: [], maps: [], turn: null, complete: false
  };
  rebuildVetoBoard();
}

function vetoApply(mapId) {
  const v = state.veto;
  if (!v || !Array.isArray(v.sequence)) return;
  if (v.ops.length >= v.sequence.length) return;             // veto already done
  if (!v.pool.some(m => m.id === mapId)) return;             // not a pool map
  if (v.ops.some(o => o.mapId === mapId)) return;            // already acted on
  const step = v.sequence[v.ops.length];
  v.ops.push({ mapId, action: step.action, by: step.by });
  rebuildVetoBoard();
}

function vetoUndo() {
  const v = state.veto;
  if (!v || !Array.isArray(v.ops) || !v.ops.length) return;
  v.ops.pop();
  rebuildVetoBoard();
}

function vetoReset() {
  const v = state.veto;
  if (!v) return;
  v.ops = [];
  rebuildVetoBoard();
}

// Record a played-map result (winner side + score) on a decided map.
function vetoResult(mapId, winner, score) {
  const v = state.veto;
  if (!v || !Array.isArray(v.maps)) return;
  const m = v.maps.find(x => x._id === mapId);
  if (!m) return;
  m.winner = ['a', 'b'].includes(winner) ? winner : '';
  if (score) m.score = { a: Number(score.a) || 0, b: Number(score.b) || 0 };
}

// ── Champion/hero draft engine ───────────────────────────────────────────────
// Same step model as the veto, but ops carry the typed champion name. The overlay
// (draft.html) renders state.draft into a blue/red pick-ban board.
function rebuildDraftTurn() {
  const d = state.draft;
  if (!d || !Array.isArray(d.sequence)) return;
  const next = d.sequence[(d.ops || []).length] || null;
  d.turn = next ? { team: next.by, action: next.action } : null;
  d.complete = (d.ops || []).length >= d.sequence.length;
}
function draftStart({ game, teamStart, title, subtitle, owBanCount }) {
  const g = draftData.hasDraft(game) ? game : (draftData.hasDraft(state.activeGame) ? state.activeGame : 'league');
  if (!draftData.hasDraft(g)) throw new Error('No draft format defined for ' + g);
  const ts = teamStart === 'b' ? 'b' : (teamStart === 'a' ? 'a' : ((state.draft && state.draft.teamStart) || 'a'));
  // Overwatch ban count is configurable: 2 (one per team) or 4 (two per team, snake A-B-B-A).
  let owCount = Number(owBanCount) || (state.draft && state.draft.owBanCount) || 4;
  owCount = owCount <= 2 ? 2 : 4;
  const steps = g === 'overwatch'
    ? (owCount === 2 ? [{ action: 'ban', teamIdx: 0 }, { action: 'ban', teamIdx: 1 }]
                     : [{ action: 'ban', teamIdx: 0 }, { action: 'ban', teamIdx: 1 }, { action: 'ban', teamIdx: 1 }, { action: 'ban', teamIdx: 0 }])
    : draftData.buildDraft(g);
  const seq = steps.map(s => ({ action: s.action, by: draftData.resolveSide(s.teamIdx, ts) }));
  state.draft = {
    visible: !!(state.draft && state.draft.visible),
    title:    typeof title === 'string'    ? title    : (state.draft && state.draft.title)    || '',
    subtitle: typeof subtitle === 'string' ? subtitle : (state.draft && state.draft.subtitle) || '',
    game: g, teamStart: ts, owBanCount: owCount, sequence: seq, ops: [], turn: null, complete: false,
    auto: (state.draft && state.draft.auto) || { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' }
  };
  rebuildDraftTurn();
}
// The in-game HUD overlay (overlay/overwatch.html) shows hero bans from state.owMatch.bansByMap,
// NOT from state.draft — a separate, older per-map ban tracker. Mirror every Overwatch draft ban
// into it (keyed to the current map, side, and ban slot) so bans made from the Draft panel actually
// show up on the broadcast HUD, matching which team banned which hero.
function setOwBanSlot(side, slot, hero, role) {
  if (slot > 1) return; // OW_HERO_BANS caps each side at 2 bans — nothing to mirror past that
  const mapIdx = Math.max(0, ((state.game && state.game.number) || 1) - 1);
  const bansByMap = [...(state.owMatch.bansByMap || [])];
  while (bansByMap.length <= mapIdx) bansByMap.push({});
  const entry = { ...(bansByMap[mapIdx] || {}) };
  const prevArr = Array.isArray(entry[side]) ? entry[side] : [];
  const arr = [prevArr[0] || { hero: '', role: '' }, prevArr[1] || { hero: '', role: '' }];
  arr[slot] = { hero: hero || '', role: role || '' };
  entry[side] = arr;
  bansByMap[mapIdx] = entry;
  state.owMatch = { ...state.owMatch, bansByMap };
}
function draftAction(name) {
  const d = state.draft;
  if (!d || !Array.isArray(d.sequence)) return;
  if (d.ops.length >= d.sequence.length) return;
  const champ = (name || '').toString().slice(0, 40).trim();
  if (!champ) return;
  const step = d.sequence[d.ops.length];
  if (step.action === 'ban' && !draftData.roleLimitOk(d.game, d.ops, champ, state.gameConfigs)) {
    const role = draftData.roleFor(d.game, champ, state.gameConfigs);
    throw new Error(`Role limit reached — 2 ${role} heroes are already banned`);
  }
  const role = draftData.roleFor(d.game, champ, state.gameConfigs);
  const priorBans = d.ops.filter((o) => o.by === step.by && o.action === 'ban').length;
  d.ops.push({ name: champ, action: step.action, by: step.by, image: draftData.imageFor(d.game, champ, state.gameConfigs), role });
  rebuildDraftTurn();
  if (d.game === 'overwatch' && step.action === 'ban') setOwBanSlot(step.by, priorBans, champ, role);
}
function draftUndo() {
  const d = state.draft;
  if (d && d.ops && d.ops.length) {
    const removed = d.ops.pop();
    if (d.game === 'overwatch' && removed.action === 'ban') {
      const priorBans = d.ops.filter((o) => o.by === removed.by && o.action === 'ban').length;
      setOwBanSlot(removed.by, priorBans, '', '');
    }
    rebuildDraftTurn();
  }
}
function draftReset() {
  const d = state.draft;
  if (d) {
    if (d.game === 'overwatch') {
      const mapIdx = Math.max(0, ((state.game && state.game.number) || 1) - 1);
      const bansByMap = [...(state.owMatch.bansByMap || [])];
      if (bansByMap[mapIdx]) { bansByMap[mapIdx] = {}; state.owMatch = { ...state.owMatch, bansByMap }; }
    }
    d.ops = [];
    rebuildDraftTurn();
  }
}

// ── LoL champ-select automation: poll the League Client and mirror the live draft ──────────
let _lolDraftStop = null;
function _draftSig() { const d = state.draft || {}; return (d.game || '') + '#' + (d.ops || []).map((o) => o.name).join('|'); }
function syncDraftFromLcu(norm) {
  if (!norm) return;                                  // no champ select active → leave the board as-is
  const done = norm.done || [];
  let d = state.draft;
  // Ensure a LoL draft is initialised (don't clobber an in-progress one of the right shape).
  if (!d || d.game !== 'league' || !Array.isArray(d.sequence) || !d.sequence.length) {
    draftStart({ game: 'league', teamStart: (d && d.teamStart) || 'a', title: (d && d.title) || '' });
    d = state.draft;
  }
  if (done.length < d.ops.length) draftReset();       // champ select restarted → rebuild
  for (let i = d.ops.length; i < done.length && i < d.sequence.length; i++) draftAction(done[i].name);
}
function startLolDraftAuto() {
  if (_lolDraftStop) return;
  _lolDraftStop = lolChampSelect.startPoller({
    getLockfilePath: () => (state.draft && state.draft.auto && state.draft.auto.lockfilePath) || '',
    onUpdate: (norm) => {
      try {
        const before = _draftSig();
        syncDraftFromLcu(norm);
        if (_draftSig() !== before) { saveAppState(); broadcastFullState(); }
      } catch (e) {}
    },
    onStatus: (status, detail) => {
      if (!state.draft.auto) state.draft.auto = {};
      state.draft.auto.status = status; state.draft.auto.statusDetail = detail;
      broadcast(bridgeClients, { type: 'lol_draft_status', data: { status, detail } });
    }
  });
  console.log('[LoL Draft] Auto champ-select polling started');
}
function stopLolDraftAuto() {
  if (_lolDraftStop) { try { _lolDraftStop(); } catch (e) {} _lolDraftStop = null; }
  if (state.draft && state.draft.auto) { state.draft.auto.status = 'off'; state.draft.auto.statusDetail = ''; }
  broadcast(bridgeClients, { type: 'lol_draft_status', data: { status: 'off', detail: '' } });
}

// Clean-observer config — hides the native CS2 HUD so only our overlay shows.
// All commands here are either harmless client render toggles (cl_drawhud / crosshair)
// or sv_cheats-gated (inert online), so it's effectively private-match-only and VAC-safe.
const SPECTATOR_CFG = [
  '// cs2-spectator.cfg — clean observer view for JotaOverlay (installed by the control panel).',
  '// USE: run  exec cs2-spectator  in console when you start spectating a PRIVATE match.',
  '//      Press F9 to flip back to normal play (restores HUD + crosshair).',
  '',
  'cl_drawhud 0            // hide the entire native HUD (we draw our own)',
  'crosshair 0             // hide the observed crosshair',
  '// sv_cheats-gated extras (only apply in a private match where the host set sv_cheats 1):',
  'cl_draw_only_deathnotices 0',
  'spec_show_xray 0',
  'cl_drawhud_force_radar 0',
  '',
  '// F9 toggles CLEAN (spectating) <-> NORMAL (playing) — HUD + crosshair together:',
  'alias _hud_clean  "cl_drawhud 0; crosshair 0; alias _hud_toggle _hud_normal"',
  'alias _hud_normal "cl_drawhud 1; crosshair 1; alias _hud_toggle _hud_clean"',
  'alias _hud_toggle _hud_normal',
  'bind "F9" "_hud_toggle"',
  '',
  'echo "[JotaOverlay] spectator HUD config loaded -- F9 toggles clean observer view"',
  ''
].join('\n');

// Write cs2-spectator.cfg into the CS2 cfg folder (reuses the GSI folder path).
function installSpectatorCfg(rawPath) {
  let dir = (rawPath || state.csgo.cfgPath || '').trim();
  if (!dir) throw new Error('Enter your CS2 install or cfg folder path (or install the GSI config first)');
  if (!/[\\/]cfg[\\/]?$/i.test(dir)) dir = path.join(dir, 'game', 'csgo', 'cfg');
  if (!fs.existsSync(dir)) throw new Error('cfg folder not found: ' + dir);
  const file = path.join(dir, 'cs2-spectator.cfg');
  fs.writeFileSync(file, SPECTATOR_CFG);
  return file;
}

function installGsiConfig(rawPath) {
  let dir = (rawPath || '').trim();
  if (!dir) throw new Error('Enter your CS2 install or cfg folder path');
  // Accept either the cfg folder directly or the game install root
  if (!/[\\/]cfg[\\/]?$/i.test(dir)) {
    dir = path.join(dir, 'game', 'csgo', 'cfg');
  }
  if (!fs.existsSync(dir)) {
    throw new Error('cfg folder not found: ' + dir);
  }
  const file = path.join(dir, 'gamestate_integration_ne_broadcast_suite.cfg');
  fs.writeFileSync(file, GSI_CFG);
  state.csgo.cfgPath = rawPath.trim();
  saveAppState();
  broadcastFullState();
  return file;
}

// ─── Flow Automation Engine ────────────────────────────────────────────────
// Named automation rules: one or more triggers → ordered action list.
//
// triggerMode:
//   'any'      — any trigger in the list fires the flow (OR logic)
//   'sequence' — triggers must fire in order; each trigger after the first has an
//                optional `timeout` (ms) — if the next trigger doesn't arrive in time,
//                the sequence resets to step 0.
//
// Triggers: RL (goal/round/match/OT/replay), CS2 (round/bomb/halftime/match),
//   match (score_reached/series_ended/game_started), OBS (scene/stream/record/replay),
//   Twitch (online/offline/raid/sub/bits/follow/channel_points/hype_train),
//   in-app (countdown/break_shown/break_hidden), manual
//
// Actions: OBS (scene/stream/record/replay), Twitch (prediction/poll/announce/clip/title/shoutout),
//   overlays (lower_third/ticker/break/casters/winner/sponsor/reload),
//   match (advance_game/set_series_score/reset_series), generic (wait/http_webhook)

const flowBus = new EventEmitter();
flowBus.setMaxListeners(100);

const _flowSeqState  = {};  // { [flowId]: { step: number, timeoutHandle: Timeout|null } }
const _flowLastFired = {};  // { [flowId]: ms timestamp } — for cooldown enforcement
const _flowIntervals = new Map(); // { flowId → intervalHandle } — for timer_interval triggers
const _flowFireLog   = {};  // { [flowId]: number[] } — last 20 fire timestamps per flow

const FLOW_TRIGGER_TYPES = [
  // Rocket League
  'rl_goal', 'rl_round_started', 'rl_match_ended', 'rl_overtime', 'rl_replay_start', 'rl_replay_end',
  // CS2
  'cs2_round_start', 'cs2_round_end', 'cs2_bomb_planted', 'cs2_half_time', 'cs2_match_ended',
  // Overwatch (Overwolf GEP relay)
  'ow_match_start', 'ow_round_start', 'ow_round_end', 'ow_match_end',
  // Marvel Rivals (Overwolf GEP relay)
  'mr_match_start', 'mr_round_start', 'mr_round_end', 'mr_match_end',
  // Universal game / production
  'score_reached', 'series_ended', 'game_started',
  // OBS
  'obs_scene_changed', 'obs_stream_started', 'obs_stream_stopped', 'obs_recording_started', 'obs_recording_stopped', 'obs_replay_saved',
  'obs_source_shown', 'obs_source_hidden', 'obs_input_muted', 'obs_input_unmuted', 'obs_media_started', 'obs_media_ended',
  // Twitch
  'twitch_stream_online', 'twitch_stream_offline', 'twitch_raid', 'twitch_sub', 'twitch_bits', 'twitch_follow', 'twitch_channel_points', 'twitch_hype_train', 'twitch_poll_end', 'twitch_ad_break', 'twitch_chat_command',
  // In-app / Timer
  'timer_countdown_end', 'break_shown', 'break_hidden',
  // Scheduled
  'time_of_day',
  // Manual
  'manual'
];

// Simple 5-field cron matcher: "minute hour day month weekday" — supports * and comma lists.
function _matchesCron(expr, date) {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mo, dow] = parts;
  const match = (part, val) => part === '*' || part.split(',').some(p => Number(p.trim()) === val);
  return match(m, date.getMinutes()) && match(h, date.getHours()) &&
         match(dom, date.getDate()) && match(mo, date.getMonth() + 1) &&
         match(dow, date.getDay());
}

// ── Scene-dwell triggers — Advanced-Scene-Switcher-style "after N seconds on scene X" ──
// Re-armed on every OBS program-scene change: every enabled flow with an obs_scene_dwell
// trigger matching the NEW scene gets a timer; a scene change before it lands cancels all.
let _dwellTimers = [];
function armSceneDwellFlows(sceneName) {
  _dwellTimers.forEach(clearTimeout);
  _dwellTimers = [];
  if (!sceneName) return;
  for (const flow of (state.flows || [])) {
    if (!flow.enabled) continue;
    (flow.triggers || []).forEach((t) => {
      if (t.type !== 'obs_scene_dwell') return;
      const p = t.params || {};
      if (p.scene && p.scene.toLowerCase() !== sceneName.toLowerCase()) return;
      const secs = Math.max(1, Number(p.seconds) || 30);
      _dwellTimers.push(setTimeout(() => {
        if ((state.obs.currentScene || '') !== sceneName) return;   // scene moved on — stale timer
        _fireFlow(flow, { scene: sceneName, dwellSec: secs });
      }, secs * 1000));
    });
  }
}

function initFlowEngine() {
  FLOW_TRIGGER_TYPES.forEach(type => {
    flowBus.on(type, data => _onFlowTrigger(type, data || {}));
  });
  // Minute tick: time_of_day events + cron_schedule evaluation.
  setInterval(() => {
    const now = new Date();
    const hhmm = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    flowBus.emit('time_of_day', { time: hhmm });
    // Cron triggers fire directly — not via flowBus — to avoid wiring a bus listener.
    for (const flow of (state.flows || [])) {
      if (!flow.enabled) continue;
      for (const trig of (flow.triggers || [])) {
        if (trig.type === 'cron_schedule' && (trig.params || {}).expr) {
          if (_matchesCron(trig.params.expr, now)) _fireFlow(flow, { type: 'cron_schedule', time: hhmm });
        }
      }
    }
  }, 60000);
  _syncFlowIntervals();
}

// Start/stop per-flow setIntervals for timer_interval triggers.
function _syncFlowIntervals() {
  // Stop intervals for flows that were deleted, disabled, or no longer have a timer trigger.
  for (const [flowId, handle] of _flowIntervals) {
    const flow = (state.flows || []).find(f => f.id === flowId);
    const hasTimer = flow && flow.enabled && (flow.triggers || []).some(t => t.type === 'timer_interval');
    if (!hasTimer) { clearInterval(handle); _flowIntervals.delete(flowId); }
  }
  // Start intervals for eligible flows that aren't running yet.
  for (const flow of (state.flows || [])) {
    if (!flow.enabled || _flowIntervals.has(flow.id)) continue;
    const trig = (flow.triggers || []).find(t => t.type === 'timer_interval');
    if (!trig) continue;
    const ms = Math.max(1000, (Number((trig.params || {}).seconds) || 60) * 1000);
    _flowIntervals.set(flow.id, setInterval(() => {
      const live = (state.flows || []).find(f => f.id === flow.id);
      if (live && live.enabled) _fireFlow(live, { type: 'timer_interval' });
    }, ms));
  }
  // Re-arm scene-dwell timers against the current program scene (flow edits change eligibility).
  if (typeof armSceneDwellFlows === 'function') armSceneDwellFlows(state.obs.currentScene || '');
}

function _onFlowTrigger(type, data) {
  const flows = state.flows || [];
  for (const flow of flows) {
    if (!flow.enabled) continue;
    const triggers = flow.triggers || [];
    if (!triggers.length) continue;
    if (flow.triggerMode === 'sequence') {
      _handleSequenceTrigger(flow, type, data);
    } else {
      if (triggers.some(t => _triggerMatches(t, type, data))) _fireFlow(flow, data);
    }
  }
}

function _triggerMatches(trigger, type, data) {
  if (trigger.type !== type) return false;
  const p = trigger.params || {};
  switch (type) {
    case 'rl_goal': {
      const team = p.team || 'any';
      if (team === 'any') return true;
      return (team === 'blue' && data.team === 0) || (team === 'orange' && data.team === 1);
    }
    case 'cs2_round_end':
      return !p.winner || p.winner === 'any' || data.winner === p.winner;
    case 'twitch_channel_points':
      return !p.rewardTitle || (data.reward || '').toLowerCase().includes(p.rewardTitle.toLowerCase());
    case 'twitch_raid':
      return !p.minViewers || (data.viewers || 0) >= Number(p.minViewers);
    case 'twitch_bits':
      return !p.minBits || (data.bits || 0) >= Number(p.minBits);
    case 'twitch_sub':
      return !p.tier || p.tier === 'any' || data.tier === p.tier;
    case 'obs_scene_changed':
      return !p.scene || (data.scene || '').toLowerCase() === p.scene.toLowerCase();
    case 'obs_source_shown':
    case 'obs_source_hidden':
      return !p.sourceName || (data.sourceName || '').toLowerCase() === p.sourceName.toLowerCase();
    case 'obs_input_muted':
    case 'obs_input_unmuted':
    case 'obs_media_started':
    case 'obs_media_ended':
      return !p.inputName || (data.inputName || '').toLowerCase() === p.inputName.toLowerCase();
    case 'score_reached': {
      if (!p.team || p.value == null) return true;
      const score = p.team === 'blue' ? state.game.blueScore : state.game.orangeScore;
      return score >= Number(p.value);
    }
    case 'series_ended':
      return !p.winner || p.winner === 'any' || data.winner === p.winner;
    case 'time_of_day':
      return !!p.time && p.time === data.time;
    case 'twitch_chat_command':
      return !p.command || data.command === p.command.toLowerCase().replace(/^!/, '');
    case 'manual':
      return !p.flowId || p.flowId === data.flowId;
    default:
      return true;
  }
}

// ── Conditions (AND guards checked at fire time) ─────────────────────────────
function _checkFlowConditions(conditions) {
  for (const cond of conditions) {
    if (!_evalCondition(cond)) return false;
  }
  return true;
}
function _evalCondition(cond) {
  const p = cond.params || {};
  switch (cond.type) {
    case 'if_obs_scene':
      return !p.scene || ((state.obs || {}).currentScene || '') === p.scene;
    case 'if_streaming':
      return !!((state.obs || {}).streaming);
    case 'if_not_streaming':
      return !((state.obs || {}).streaming);
    case 'if_recording':
      return !!((state.obs || {}).recording);
    case 'if_not_recording':
      return !((state.obs || {}).recording);
    case 'if_game_number': {
      const n = Number(p.value);
      return isNaN(n) || state.game.number === n;
    }
    case 'if_series_state': {
      const b = state.series.blue || 0, o = state.series.orange || 0;
      if (p.compare === 'blue_leads')   return b > o;
      if (p.compare === 'orange_leads') return o > b;
      if (p.compare === 'tied')         return b === o;
      return true;
    }
    case 'if_score_diff': {
      const diff = Math.abs((state.game.blueScore || 0) - (state.game.orangeScore || 0));
      const val = Number(p.value) || 0;
      if (p.op === 'gte') return diff >= val;
      if (p.op === 'lte') return diff <= val;
      if (p.op === 'eq')  return diff === val;
      return true;
    }
    case 'if_time_range': {
      const now = new Date();
      const cur = now.getHours() * 60 + now.getMinutes();
      const [sh, sm] = (p.start || '00:00').split(':').map(Number);
      const [eh, em] = (p.end   || '23:59').split(':').map(Number);
      const start = sh * 60 + sm, end = eh * 60 + em;
      return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
    }
    case 'if_variable': {
      const val = String((state.flowVars || {})[p.name] ?? '');
      const cmp = String(p.value ?? '');
      const nv = Number(val), nc = Number(cmp);
      if (p.op === 'eq')       return val === cmp;
      if (p.op === 'neq')      return val !== cmp;
      if (p.op === 'gt')       return !isNaN(nv) && !isNaN(nc) && nv > nc;
      if (p.op === 'lt')       return !isNaN(nv) && !isNaN(nc) && nv < nc;
      if (p.op === 'gte')      return !isNaN(nv) && !isNaN(nc) && nv >= nc;
      if (p.op === 'lte')      return !isNaN(nv) && !isNaN(nc) && nv <= nc;
      if (p.op === 'contains') return val.toLowerCase().includes(cmp.toLowerCase());
      return !!val; // no op = just check if var is set and non-empty
    }
    case 'if_flow_last_fired': {
      if (!p.flowId || !p.maxAgoMs) return true;
      const last = _flowLastFired[p.flowId];
      if (!last) return false;
      return (Date.now() - last) <= Number(p.maxAgoMs);
    }
    case 'if_match_point': {
      const half = Math.ceil((state.bestOf || 5) / 2);
      const b = state.series?.blue || 0, o = state.series?.orange || 0;
      const blueMP   = b === half - 1;
      const orangeMP = o === half - 1;
      if (p.team === 'blue')   return blueMP;
      if (p.team === 'orange') return orangeMP;
      return blueMP || orangeMP; // 'any' — either team
    }
    default:
      return true;
  }
}

function _handleSequenceTrigger(flow, type, data) {
  const seq = _flowSeqState[flow.id] || { step: 0, timeoutHandle: null };
  const triggers = flow.triggers || [];
  const current = triggers[seq.step];
  if (!current || !_triggerMatches(current, type, data)) return;

  if (seq.timeoutHandle) { clearTimeout(seq.timeoutHandle); seq.timeoutHandle = null; }

  const nextStep = seq.step + 1;
  if (nextStep >= triggers.length) {
    _flowSeqState[flow.id] = { step: 0, timeoutHandle: null };
    _fireFlow(flow, data);
  } else {
    const nextTrigger = triggers[nextStep];
    const timeout = nextTrigger && Number(nextTrigger.timeout);
    const handle = (timeout > 0)
      ? setTimeout(() => { _flowSeqState[flow.id] = { step: 0, timeoutHandle: null }; }, timeout)
      : null;
    _flowSeqState[flow.id] = { step: nextStep, timeoutHandle: handle };
  }
}

// Thrown by the stop_flow action to exit the current flow cleanly.
class _StopFlow extends Error {
  constructor() { super('stop_flow'); this.name = '_StopFlow'; }
}

// Replace {{token}} placeholders in a string with live game-state and flow-var values.
function _substituteTokens(text, ctx) {
  if (!text || typeof text !== 'string') return text;
  const g = state.game || {};
  const blue   = state.teams?.blue   || {};
  const orange = state.teams?.orange || {};
  let out = text
    .replaceAll('{{blue_score}}',    String(g.blueScore   ?? 0))
    .replaceAll('{{orange_score}}',  String(g.orangeScore ?? 0))
    .replaceAll('{{blue_team}}',     blue.name   || 'Blue')
    .replaceAll('{{orange_team}}',   orange.name || 'Orange')
    .replaceAll('{{series_blue}}',   String(state.series?.blue   || 0))
    .replaceAll('{{series_orange}}', String(state.series?.orange || 0))
    .replaceAll('{{game_number}}',   String(g.number || 1))
    .replaceAll('{{map_name}}',      g.map || '')
    .replaceAll('{{event_title}}',   state.eventTitle || '')
    .replaceAll('{{best_of}}',       String(state.bestOf || 5));
  for (const [k, v] of Object.entries(state.flowVars || {}))
    out = out.replaceAll(`{{${k}}}`, String(v ?? ''));
  if (ctx && typeof ctx === 'object')
    for (const [k, v] of Object.entries(ctx))
      if (typeof v === 'string' || typeof v === 'number')
        out = out.replaceAll(`{{trigger.${k}}}`, String(v));
  return out;
}

async function _fireFlow(flow, triggerData) {
  const now = Date.now();
  const cooldown = Number(flow.cooldown) || 0;
  if (cooldown > 0 && _flowLastFired[flow.id] && now - _flowLastFired[flow.id] < cooldown) return;
  // Conditions: all must pass (AND logic)
  if ((flow.conditions || []).length && !_checkFlowConditions(flow.conditions)) return;
  _flowLastFired[flow.id] = now;
  // Track fire history (last 20 per flow)
  if (!_flowFireLog[flow.id]) _flowFireLog[flow.id] = [];
  _flowFireLog[flow.id].unshift(now);
  if (_flowFireLog[flow.id].length > 20) _flowFireLog[flow.id].length = 20;
  logAuto('flow', `Flow fired: ${flow.name || flow.id}${triggerData && triggerData.dwellSec ? ` (after ${triggerData.dwellSec}s on "${triggerData.scene}")` : ''}`);

  const repeatCount = Math.max(1, Number(flow.repeatCount) || 1);
  const repeatDelay = Math.max(0, Number(flow.repeatDelay) || 0);
  for (let rep = 0; rep < repeatCount; rep++) {
    if (rep > 0 && repeatDelay > 0) await new Promise(r => setTimeout(r, repeatDelay));
    for (const action of (flow.actions || [])) {
      if (Number(action.delay) > 0) await new Promise(r => setTimeout(r, Number(action.delay)));
      try { await _executeFlowAction(action, triggerData); }
      catch (e) {
        if (e instanceof _StopFlow) return; // stop_flow action — exit cleanly
        console.error('[Flow]', flow.name, '→', action.type, e.message);
      }
    }
  }
}

async function _executeFlowAction(action, ctx) {
  const rawP = action.params || {};
  // Substitute {{tokens}} in all string param values before executing
  const p = Object.fromEntries(
    Object.entries(rawP).map(([k, v]) => [k, typeof v === 'string' ? _substituteTokens(v, ctx) : v])
  );
  switch (action.type) {
    case 'wait':
      await new Promise(r => setTimeout(r, Math.max(0, Number(p.ms) || 0)));
      break;
    case 'obs_scene':
      // AI Shield promises to pause ALL scene automation — flows included.
      if (aiShielded()) { logAuto('flow', `Flow scene cut to "${p.scene}" BLOCKED — AI shield engaged`); break; }
      if (obsClient && obsClient.isConnected() && p.scene) {
        logAuto('flow', `Flow cut to "${p.scene.trim()}"`);
        obsClient.switchScene(p.scene.trim());
      }
      break;
    // Switch back to whatever scene was on program before the last cut (ASS-style "previous scene").
    case 'obs_scene_previous':
      if (aiShielded()) { logAuto('flow', 'Flow previous-scene cut BLOCKED — AI shield engaged'); break; }
      if (obsClient && obsClient.isConnected() && state.obs.previousScene) {
        logAuto('flow', `Flow cut back to previous scene "${state.obs.previousScene}"`);
        obsClient.switchScene(state.obs.previousScene);
      }
      break;
    case 'obs_save_replay':
      if (obsClient && obsClient.isConnected())
        try { await obsClient.call('SaveReplayBuffer'); } catch(e){}
      break;

    // ── vMix flow actions (fire vMix HTTP functions) ──────────────────────────
    case 'vmix_cut': {
      // Cut / transition PROGRAM to an input. Input = number | name | GUID.
      if (aiShielded()) { console.log('[Flow] vmix_cut skipped — AI shield engaged'); break; }
      const fn = (p.transition && p.transition !== 'Cut') ? p.transition : 'Cut';
      const params = { Input: p.input };
      const dur = Number(p.duration); if (dur > 0) params.Duration = Math.round(dur);
      await vmixDo(fn, params);
      break;
    }
    case 'vmix_overlay': {
      // Overlay channel 1-4 In / Out / Off (or toggle). Input optional (sets what the channel shows).
      if (aiShielded()) { console.log('[Flow] vmix_overlay skipped — AI shield engaged'); break; }
      const ch = Math.max(1, Math.min(4, Number(p.channel) || 1));
      const act = (p.action || 'In');                       // In | Out | Off | toggle
      const fn = 'OverlayInput' + ch + (act === 'toggle' ? '' : act);
      const params = {}; if (p.input) params.Input = p.input;
      await vmixDo(fn, params);
      break;
    }
    case 'vmix_start_stream': await vmixDo('StartStreaming', p.value !== undefined && p.value !== '' ? { Value: p.value } : {}); break;
    case 'vmix_stop_stream':  await vmixDo('StopStreaming',  p.value !== undefined && p.value !== '' ? { Value: p.value } : {}); break;
    case 'vmix_start_record': await vmixDo('StartRecording'); break;
    case 'vmix_stop_record':  await vmixDo('StopRecording');  break;
    case 'vmix_replay_last':  await vmixDo('ReplayPlayLastEvent'); break;
    case 'vmix_fade_to_black': await vmixDo('FadeToBlack'); break;
    case 'vmix_set_text': {
      // Update a Title/GT text field: SelectedName like "Headline.Text"; Input = the title input.
      const params = { Input: p.input, SelectedName: p.selectedName, Value: p.value !== undefined ? String(p.value) : '' };
      await vmixDo('SetText', params);
      break;
    }
    case 'vmix_function': {
      // Power-user escape hatch: any vMix function + optional Input/Value/Duration.
      if (!p.function) break;
      const params = {};
      if (p.input) params.Input = p.input;
      if (p.value !== undefined && p.value !== '') params.Value = p.value;
      const dur = Number(p.duration); if (dur > 0) params.Duration = Math.round(dur);
      await vmixDo(p.function, params);
      break;
    }

    case 'overlay_ticker':
      state.ticker = { ...state.ticker, messages: [p.text || ''].filter(Boolean), visible: true };
      broadcastFullState();
      break;
    case 'overlay_ticker_hide':
      state.ticker = { ...state.ticker, visible: false };
      broadcastFullState();
      break;
    case 'overlay_lower_third': {
      state.ticker = { ...state.ticker, messages: [p.text || ''].filter(Boolean), visible: true };
      broadcastFullState();
      const dur = Number(p.duration) || 0;
      if (dur > 0) {
        await new Promise(r => setTimeout(r, dur));
        state.ticker = { ...state.ticker, visible: false };
        broadcastFullState();
      }
      break;
    }
    case 'overlay_break_show':
      state.breakScreen = { ...state.breakScreen, visible: true };
      broadcastFullState();
      break;
    case 'overlay_break_hide':
      state.breakScreen = { ...state.breakScreen, visible: false };
      clearBreakAutoSwitch();
      broadcastFullState();
      break;
    case 'overlay_countdown_start': {
      // Start the "starting soon" break-screen countdown. Optional thenScene auto-cuts to that OBS
      // scene when it reaches 0 (same engine as the manual break countdown).
      const secs = Math.max(0, Number(p.seconds) || 0);
      state.breakScreen = {
        ...state.breakScreen,
        visible: true,
        title: (typeof p.title === 'string' && p.title.trim()) ? p.title : (state.breakScreen.title || 'STARTING SOON'),
        endsAt: secs > 0 ? Date.now() + secs * 1000 : null,
        frozenSeconds: null,
        thenScene: typeof p.thenScene === 'string' ? p.thenScene : (state.breakScreen.thenScene || ''),
        thenPlayout: ''
      };
      scheduleBreakAutoSwitch();
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'set_event_title':
      state.eventName = (p.title || '').toString();
      saveAppState();
      broadcastFullState();
      break;
    case 'set_round_label':
      state.roundLabel = (p.text || '').toString();
      saveAppState();
      broadcastFullState();
      break;
    case 'set_match_label':
      state.gameLabel = (p.text || '').toString();
      saveAppState();
      broadcastFullState();
      break;
    case 'overlay_casters_show':
      state.casters = { ...state.casters, visible: true };
      broadcastFullState();
      break;
    case 'overlay_casters_hide':
      state.casters = { ...state.casters, visible: false };
      broadcastFullState();
      break;
    case 'overlay_winner': {
      // Resolve the winning side. An explicit side param wins; otherwise ('auto' or unset) use the
      // trigger's winner — series_ended passes { winner } and only fires once the SERIES is clinched
      // (ceil(bestOf/2) game wins; Bo1 = the single game) — falling back to whoever leads the series.
      // This is what makes a "series_ended → show winner" flow display the real champion, not a preset.
      const side = (p.side && p.side !== 'auto') ? p.side
                 : (ctx && (ctx.winner === 'blue' || ctx.winner === 'orange')) ? ctx.winner
                 : (state.series.blue > state.series.orange ? 'blue'
                    : state.series.orange > state.series.blue ? 'orange' : 'blue');
      const team = (state.teams && state.teams[side]) || {};
      state.winner = {
        ...state.winner, visible: true, side,
        name:  p.name || team.name || state.winner.name || '',
        logo:  p.name ? state.winner.logo : (team.logo || state.winner.logo || null),
        color: team.color || state.winner.color || '',
      };
      broadcastFullState();
      break;
    }
    case 'overlay_winner_hide':
      state.winner = { ...state.winner, visible: false };
      broadcastFullState();
      break;
    case 'overlay_reload':
      broadcast(bridgeClients, { type: 'reload' });
      break;
    case 'match_advance_game':
      state.game.number = Math.min(state.bestOf, state.game.number + 1);
      broadcastFullState();
      break;
    case 'match_reset_series':
      state.series = { blue: 0, orange: 0 };
      state.game.number = 1;
      broadcastFullState();
      break;
    case 'twitch_prediction_create':
      if (predictionManager) try {
        const title = p.title || 'Who will win?';
        const outcomes = [p.outcome1 || 'Team Blue', p.outcome2 || 'Team Orange'];
        await predictionManager.createPrediction(title, outcomes, Number(p.duration) || 120);
      } catch(e){ console.warn('[Flow] prediction create:', e.message); }
      break;
    case 'twitch_prediction_lock':
      if (predictionManager) try { await predictionManager.lockPrediction(); } catch(e){}
      break;
    case 'twitch_prediction_resolve':
      if (predictionManager) try {
        const _cur = predictionManager.currentPrediction || state.twitch.predictions.current;
        const _outcomes = _cur?.outcomes || [];
        const idx = Number(p.outcomeIndex) || 0;
        const _outcomeId = _outcomes[idx]?.id;
        const _predId = _cur?.id;
        if (_outcomeId && _predId) await predictionManager.resolvePrediction(_outcomeId, _predId);
      } catch(e){ console.warn('[Flow] prediction resolve:', e.message); }
      break;
    case 'twitch_prediction_cancel':
      if (predictionManager) try { await predictionManager.cancelPrediction(); } catch(e){}
      break;
    case 'twitch_announcement': {
      const _cid = state.twitch.channelId;
      if (twitchClient && _cid && p.message) try {
        await twitchClient.postAnnouncement(_cid, _cid, p.message, p.color || 'PRIMARY');
      } catch(e){ console.warn('[Flow] announcement:', e.message); }
      break;
    }
    case 'twitch_clip': {
      const _cid = state.twitch.channelId;
      if (twitchClient && _cid) try {
        await twitchClient.createClip(_cid);
      } catch(e){ console.warn('[Flow] clip:', e.message); }
      break;
    }
    case 'twitch_channel_title': {
      const _cid = state.twitch.channelId;
      if (twitchClient && _cid && p.title) try {
        await twitchClient.updateChannel(_cid, { title: p.title });
      } catch(e){ console.warn('[Flow] channel title:', e.message); }
      break;
    }
    case 'twitch_create_poll': {
      const _cid = state.twitch.channelId;
      if (twitchClient && _cid && p.title) try {
        const choices = [p.choice1 || 'Yes', p.choice2 || 'No'];
        await twitchClient.createPoll(_cid, p.title, choices, Number(p.duration) || 60);
      } catch(e){ console.warn('[Flow] poll create:', e.message); }
      break;
    }
    case 'twitch_shoutout': {
      const _cid = state.twitch.channelId;
      if (twitchClient && _cid && p.toLogin) try {
        const toUser = await twitchClient.getUserByLogin(p.toLogin);
        if (toUser) await twitchClient.sendShoutout(_cid, toUser.id, _cid);
      } catch(e){ console.warn('[Flow] shoutout:', e.message); }
      break;
    }
    case 'obs_start_stream':
      if (obsClient && obsClient.isConnected()) try { await obsClient.call('StartStream'); } catch(e){}
      break;
    case 'obs_stop_stream':
      if (obsClient && obsClient.isConnected()) try { await obsClient.call('StopStream'); } catch(e){}
      break;
    case 'obs_start_record':
      if (obsClient && obsClient.isConnected()) try { await obsClient.call('StartRecord'); } catch(e){}
      break;
    case 'obs_stop_record':
      if (obsClient && obsClient.isConnected()) try { await obsClient.call('StopRecord'); } catch(e){}
      break;
    case 'obs_start_replay_buf':
      if (obsClient) try { await obsClient.startReplayBuffer(); } catch(e){}
      break;
    case 'obs_stop_replay_buf':
      if (obsClient) try { await obsClient.stopReplayBuffer(); } catch(e){}
      break;
    case 'obs_stream_marker': {
      const _cid = state.twitch.channelId;
      if (twitchClient && _cid) try {
        await twitchClient.createStreamMarker(_cid, p.description || '');
      } catch(e){ console.warn('[Flow] stream marker:', e.message); }
      break;
    }
    case 'overlay_sponsor_show':
      state.sponsorBanner = { ...(state.sponsorBanner||{}), visible: true };
      broadcastFullState();
      break;
    case 'overlay_sponsor_hide':
      state.sponsorBanner = { ...(state.sponsorBanner||{}), visible: false };
      broadcastFullState();
      break;
    case 'match_set_series_score':
      if (p.blue != null) state.series.blue = Number(p.blue) || 0;
      if (p.orange != null) state.series.orange = Number(p.orange) || 0;
      broadcastFullState();
      break;
    case 'http_webhook': {
      if (!p.url) break;
      // Ads must NEVER auto-play: refuse to let a flow loop back into our own ad endpoint,
      // and tag every flow-originated request so the ad route can reject it server-side too.
      if (/\/api\/twitch\/ad\//i.test(p.url)) {
        console.warn('[Flow] webhook blocked — flows may not trigger ad breaks:', p.url);
        break;
      }
      let body = {};
      try { body = p.body ? JSON.parse(p.body) : {}; } catch(e){}
      try { await axios.post(p.url, body, { timeout: 5000, headers: { 'X-NE-Flow': '1' } }); }
      catch(e) { console.warn('[Flow] webhook failed:', e.message); }
      break;
    }
    case 'obs_source_show':
      if (obsClient && obsClient.isConnected() && p.scene && p.source)
        await obsClient.setSceneItemEnabled(p.scene.trim(), p.source.trim(), true).catch(() => {});
      break;
    case 'obs_source_hide':
      if (obsClient && obsClient.isConnected() && p.scene && p.source)
        await obsClient.setSceneItemEnabled(p.scene.trim(), p.source.trim(), false).catch(() => {});
      break;
    case 'obs_input_mute':
      if (obsClient && obsClient.isConnected() && p.inputName)
        await obsClient.setInputMute(p.inputName.trim(), true).catch(() => {});
      break;
    case 'obs_input_unmute':
      if (obsClient && obsClient.isConnected() && p.inputName)
        await obsClient.setInputMute(p.inputName.trim(), false).catch(() => {});
      break;
    case 'obs_set_volume': {
      if (obsClient && obsClient.isConnected() && p.inputName) {
        const db = parseFloat(p.volumeDb);
        if (!isNaN(db)) await obsClient.setInputVolume(p.inputName.trim(), Math.max(-100, Math.min(26, db))).catch(() => {});
      }
      break;
    }
    case 'obs_filter_enable':
      if (obsClient && obsClient.isConnected() && p.sourceName && p.filterName)
        await obsClient.setSourceFilterEnabled(p.sourceName.trim(), p.filterName.trim(), true).catch(() => {});
      break;
    case 'obs_filter_disable':
      if (obsClient && obsClient.isConnected() && p.sourceName && p.filterName)
        await obsClient.setSourceFilterEnabled(p.sourceName.trim(), p.filterName.trim(), false).catch(() => {});
      break;
    case 'obs_set_transition':
      if (obsClient && obsClient.isConnected()) {
        try {
          if (p.transitionName) await obsClient.call('SetCurrentSceneTransition', { transitionName: p.transitionName });
          if (p.durationMs != null) await obsClient.call('SetCurrentSceneTransitionDuration', { transitionDuration: Number(p.durationMs) || 300 });
        } catch(e) { console.warn('[Flow] set transition:', e.message); }
      }
      break;
    case 'match_set_score':
      if (p.team === 'blue')   { state.game.blueScore   = Math.max(0, Number(p.value) || 0); broadcastFullState(); }
      if (p.team === 'orange') { state.game.orangeScore = Math.max(0, Number(p.value) || 0); broadcastFullState(); }
      break;
    case 'run_flow': {
      const target = p.flowId && (state.flows || []).find(f => f.id === p.flowId && f.enabled);
      if (target) {
        for (const a of (target.actions || [])) {
          if (Number(a.delay) > 0) await new Promise(r => setTimeout(r, Number(a.delay)));
          try { await _executeFlowAction(a, ctx); } catch(e) { console.error('[Flow] run_flow sub-action:', e.message); }
        }
      }
      break;
    }
    case 'stop_flow':
      throw new _StopFlow();
    case 'set_variable': {
      if (p.name) {
        if (!state.flowVars) state.flowVars = {};
        state.flowVars[p.name] = p.value ?? '';
        broadcastFullState();
      }
      break;
    }
    case 'increment_variable': {
      if (p.name) {
        if (!state.flowVars) state.flowVars = {};
        const cur = Number(state.flowVars[p.name]) || 0;
        state.flowVars[p.name] = String(cur + (Number(rawP.amount) || 1));
        broadcastFullState();
      }
      break;
    }
    case 'reset_variable': {
      if (!state.flowVars) state.flowVars = {};
      if (p.name) delete state.flowVars[p.name];
      else state.flowVars = {};
      broadcastFullState();
      break;
    }
    case 'twitch_send_chat': {
      if (p.message && chatManager && chatManager.isConnected) {
        chatManager.sendMessage(p.message);
      }
      break;
    }
    case 'send_discord_webhook': {
      if (!rawP.url) break;
      const embed = {};
      if (p.title)   embed.title       = p.title;
      if (p.message) embed.description = p.message;
      if (p.color)   embed.color       = parseInt(p.color.replace('#', ''), 16) || 0;
      const body = { embeds: [embed] };
      if (p.content) body.content = p.content;
      try { await axios.post(rawP.url, body, { timeout: 5000 }); }
      catch(e) { console.warn('[Flow] discord webhook:', e.message); }
      break;
    }
    case 'cycle_variable': {
      if (p.name && p.list) {
        if (!state.flowVars) state.flowVars = {};
        const items = rawP.list.split(',').map(s => s.trim()).filter(Boolean);
        if (!items.length) break;
        const cur = state.flowVars[p.name];
        const idx = items.indexOf(String(cur));
        state.flowVars[p.name] = items[(idx + 1) % items.length];
        broadcastFullState();
      }
      break;
    }
    case 'random_choice': {
      const ids = (rawP.flowIds || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.length) break;
      const picked = ids[Math.floor(Math.random() * ids.length)];
      const target = (state.flows || []).find(f => f.id === picked && f.enabled);
      if (target) {
        for (const a of (target.actions || [])) {
          if (Number(a.delay) > 0) await new Promise(r => setTimeout(r, Number(a.delay)));
          try { await _executeFlowAction(a, ctx); } catch(e) { console.error('[Flow] random_choice:', e.message); }
        }
      }
      break;
    }
    case 'obs_playback_start':
      if (obsClient && obsClient.isConnected() && p.inputName) {
        try { await obsClient.call('TriggerMediaInputAction', { inputName: p.inputName.trim(), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }); } catch(e){}
      }
      break;
    case 'obs_playback_stop':
      if (obsClient && obsClient.isConnected() && p.inputName) {
        try { await obsClient.call('TriggerMediaInputAction', { inputName: p.inputName.trim(), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch(e){}
      }
      break;
    case 'obs_playback_pause':
      if (obsClient && obsClient.isConnected() && p.inputName) {
        try { await obsClient.call('TriggerMediaInputAction', { inputName: p.inputName.trim(), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' }); } catch(e){}
      }
      break;
  }
}

// ─── OBS WebSocket integration ──────────────────────────────────────────────
function setupObsClient() {
  if (!createObsClient || obsClient) return;
  obsClient = createObsClient({
    onStatus: ({ connected, lastError }) => {
      const wasConnected = state.obs.connected;
      state.obs.connected = connected;
      state.obs.lastError = lastError || null;
      if (!connected) { state.obs.currentScene = ''; state.obs.replayBufferActive = false; }
      if (wasConnected && !connected) try { analytics.event('disconnect', { what: 'OBS' }); } catch (e) {}
      broadcastFullState();
    },
    // The OBS program scene = the authoritative "what's on air" signal.
    onSceneChange: (sceneName) => {
      const prev = state.obs.currentScene || '';
      state.obs.currentScene = sceneName || '';
      if ((sceneName || '') !== prev) state.obs.previousScene = prev;   // for the obs_scene_previous flow action
      if (telemetry && (sceneName || '') !== prev) telemetry.sceneChange({ scene: sceneName || '', prevScene: prev, source: 'unknown' });
      if ((sceneName || '') !== prev) try { analytics.event('scene_change', { scene: sceneName || '' }); } catch (e) {}
      flowBus.emit('obs_scene_changed', { scene: sceneName || '' });
      armSceneDwellFlows(sceneName || '');
      broadcastFullState();
    },
    // Live mirror of the connected OBS profile's scene collection.
    onSceneListChange: (scenes) => {
      state.obs.availableScenes = filterSwitchableScenes(scenes);
      broadcastFullState();
    },
    // A media (commercial video) finished — auto-cut back to program if enabled.
    onMediaEnded: (inputName) => {
      if (state.commercial.active && state.obs.commercialAutoReturn) endCommercial();
      flowBus.emit('obs_media_ended', { inputName: inputName || '' });
    },
    onMediaStarted: (inputName) => {
      flowBus.emit('obs_media_started', { inputName: inputName || '' });
    },
    onInputMuteChanged: ({ inputName, muted }) => {
      flowBus.emit(muted ? 'obs_input_muted' : 'obs_input_unmuted', { inputName });
    },
    onSourceVisibilityChanged: ({ sceneName, sourceName, enabled }) => {
      flowBus.emit(enabled ? 'obs_source_shown' : 'obs_source_hidden', { sceneName, sourceName });
    },
    onStreamStateChanged: ({ active, state: s }) => {
      state.obs.streaming = active;
      if (s === 'OBS_WEBSOCKET_OUTPUT_STARTED') flowBus.emit('obs_stream_started', {});
      if (s === 'OBS_WEBSOCKET_OUTPUT_STOPPED') flowBus.emit('obs_stream_stopped', {});
      broadcastFullState();
    },
    onRecordStateChanged: ({ active, state: s }) => {
      state.obs.recording = active;
      if (s === 'OBS_WEBSOCKET_OUTPUT_STARTED') flowBus.emit('obs_recording_started', {});
      if (s === 'OBS_WEBSOCKET_OUTPUT_STOPPED') flowBus.emit('obs_recording_stopped', {});
      broadcastFullState();
    },
    onReplayBufferSaved: ({ path }) => {
      try { analytics.event('replay_saved'); } catch (e) {}
      flowBus.emit('obs_replay_saved', { path });
    },
    onReplayBufferStateChanged: ({ active }) => {
      state.obs.replayBufferActive = active;
      broadcastFullState();
    }
  });
}

// ── Commercial break: cut to the Commercial scene, then return to program ────
function startCommercial() {
  const scenes = state.obs.scenes || {};
  const target = (scenes.commercial || scenes.break || '').trim();
  if (!obsClient || !obsClient.isConnected() || !target) {
    return { ok: false, message: !target ? 'Map a Commercial scene in Integrations → OBS first.' : 'Not connected to OBS.' };
  }
  state.commercial = { active: true, returnScene: (state.obs.currentScene || scenes.inGame || '').trim() };
  // Clear any stuck break overlay so it can't sit over the HUD.
  state.breakScreen.visible = false;
  obsClient.switchScene(target);
  broadcastFullState();
  return { ok: true, message: `Commercial — cut to "${target}".` };
}
function endCommercial() {
  const scenes = state.obs.scenes || {};
  const back = (state.commercial.returnScene || scenes.inGame || '').trim();
  state.commercial = { active: false, returnScene: '' };
  if (obsClient && obsClient.isConnected() && back) obsClient.switchScene(back);
  broadcastFullState();
  return { ok: true, message: back ? `Back to "${back}".` : 'Commercial ended.' };
}

// Serialize concurrent connect attempts: if a connect is already in flight,
// callers share its promise rather than starting a second overlapping connect.
let _obsConnectQueue = null;
async function connectObs() {
  if (_obsConnectQueue) return _obsConnectQueue;
  _obsConnectQueue = _doConnectObs().finally(() => { _obsConnectQueue = null; });
  return _obsConnectQueue;
}
async function _doConnectObs() {
  if (!createObsClient) return false;
  setupObsClient();
  if (!obsClient) return false;
  try {
    await obsClient.connect({ url: state.obs.url, password: obsPassword });
    state.obs.availableScenes = filterSwitchableScenes(await obsClient.getScenes());
    state.obs.availableTransitions = await obsClient.getTransitions();
    state.obs.lastError = null;
    try {
      state.obs.replayBufferActive = await obsClient.isReplayBufferActive();
    } catch (e) { state.obs.replayBufferActive = false; }
    if (state.clips?.autoCapture) {
      try {
        if (!state.obs.replayBufferActive) await obsClient.startReplayBuffer();
      } catch (e) { /* replay buffer optional until producer enables it in OBS */ }
    }
    broadcastFullState();
    return true;
  } catch (e) {
    console.warn('[OBS] Connect failed:', e && e.message ? e.message : e);
    return false;
  }
}

// Scenes a producer can actually cut to — drops the generated collection's blank
// "═══ DIVIDER ═══" separators and the "=> Cam" utility scenes (cutting to either
// puts a black frame / a lone cam on program).
function filterSwitchableScenes(scenes) {
  return (Array.isArray(scenes) ? scenes : []).filter((s) => !/^═/.test(s) && !/^=>/.test(s));
}

// ── Unified automation activity log ─────────────────────────────────────────
// One timeline of every action AUTOMATION took (RL cuts, countdown handoffs, flow fires,
// flow scene switches) so producers can always answer "why did the scene just change?".
// Session-only ring buffer, broadcast in live state, rendered by the What's Armed panel.
const _autoLog = [];
function logAuto(kind, message) {
  _autoLog.unshift({ ts: Date.now(), kind, message: String(message).slice(0, 200) });
  if (_autoLog.length > 50) _autoLog.length = 50;
}

async function disconnectObs() {
  if (!obsClient) return;
  try { await obsClient.disconnect(); } catch (e) { /* ignore */ }
  state.obs.connected = false;
  state.obs.availableScenes = [];
  state.obs.availableTransitions = [];
  broadcastFullState();
}

let _csgoLastMapPhase = '';
let _csgoLastRoundPhase = '';
let _csgoLastBombState = '';

// Switch OBS to the scene mapped to a broadcast moment, if auto-switch is on.
// TEMPORARY: all automatic OBS scene switching is disabled (per request). The app performs NO
// game-event-driven scene cuts (kickoff / in-game / post-game / replay / break / casters / bracket /
// Smart Triggers). Manual switching via the 'obs_switch_scene' message is unaffected. Set this back
// to false to restore auto scene switching.
const OBS_AUTO_SWITCH_DISABLED = true;
function obsSwitch(sceneKey) {
  if (OBS_AUTO_SWITCH_DISABLED || aiShielded()) return;
  if (!obsClient || !state.obs.enabled || !state.obs.autoSwitch) return;
  if (!obsClient.isConnected()) return;
  const sceneName = (state.obs.scenes && state.obs.scenes[sceneKey] || '').trim();
  if (!sceneName) {
    console.log(`[OBS] Auto-switch skipped — no scene mapped for "${sceneKey}"`);
    return;
  }
  console.log(`[OBS] Auto-switch → ${sceneName} (${sceneKey})`);
  obsClient.switchScene(sceneName);
}

// Switch OBS to a literal scene name (not one of the mapped keys). Used by the countdown
// auto-switch, where the producer explicitly picked BOTH the trigger and the destination
// scene for THIS break — that's a producer-armed cut like rlSwitchScene, so it is exempt
// from the blanket OBS_AUTO_SWITCH_DISABLED kill switch (which guards game-event automation),
// while still respecting the OBS connection/enabled state and the AI shield.
function obsSwitchSceneName(name) {
  if (aiShielded()) return;
  if (!obsClient || !state.obs.enabled) return;
  if (!obsClient.isConnected()) return;
  const sceneName = (name || '').trim();
  if (!sceneName) return;
  console.log(`[OBS] Countdown auto-switch → ${sceneName}`);
  logAuto('countdown', `Countdown ended — cut to "${sceneName}"`);
  obsClient.switchScene(sceneName);
}

// ── vMix control (full alternative backend) ────────────────────────────────────────────────
// Fire a vMix function via the HTTP API using the configured host/port. No-op unless enabled.
async function vmixDo(fn, params) {
  if (!state.vmix.enabled) return { ok: false, reason: 'vmix_disabled' };
  try {
    await vmix.vmixCall(state.vmix.host, state.vmix.port, fn, params || {});
    return { ok: true };
  } catch (e) {
    state.vmix.lastError = e.message;
    return { ok: false, reason: e.message };
  }
}

// Poll vMix state (~1.5s) while enabled; broadcast only when something meaningful changes so we
// don't spam full_state. Marks connected/disconnected + lastError.
let _vmixSig = '';
async function pollVmix() {
  if (!state.vmix.enabled) {
    if (state.vmix.connected) { state.vmix.connected = false; broadcastFullState(); }
    return;
  }
  try {
    const s = await vmix.vmixState(state.vmix.host, state.vmix.port);
    Object.assign(state.vmix, {
      connected: true, lastError: null,
      version: s.version, edition: s.edition, active: s.active, preview: s.preview,
      streaming: s.streaming, recording: s.recording, inputs: s.inputs, overlays: s.overlays
    });
  } catch (e) {
    state.vmix.connected = false;
    state.vmix.lastError = e.code === 'ECONNREFUSED' ? 'vMix not reachable (is it running with the Web API on?)' : e.message;
  }
  const sig = JSON.stringify({
    c: state.vmix.connected, a: state.vmix.active, p: state.vmix.preview,
    st: state.vmix.streaming, rec: state.vmix.recording, e: state.vmix.lastError,
    n: state.vmix.inputs.map((i) => i.number + ':' + i.title + ':' + (i.volume == null ? '' : Math.round(i.volume)) + ':' + (i.muted ? 1 : 0)).join(','),
    ov: state.vmix.overlays.map((o) => o.input).join(','),
    ver: state.vmix.version
  });
  if (sig !== _vmixSig) { _vmixSig = sig; broadcastFullState(); }
}
setInterval(() => { pollVmix().catch(() => {}); }, 1500);

// Lightweight vMix VU-meter push — only while the Switcher page is open + vMix is the backend.
// Sends a tiny 'vmix-meters' message (~2fps) so the mixer shows live level movement without
// broadcasting full state. OBS exposes no meters over its WS API, so this is vMix-only.
setInterval(async () => {
  if (!_switcherWatching || state.switcher.target !== 'vmix' || !state.vmix.enabled) return;
  try {
    const s = await vmix.vmixState(state.vmix.host, state.vmix.port);
    const levels = s.inputs.filter((i) => i.audio).map((i) => ({ n: i.number, m: Math.max(i.meterF1 || 0, i.meterF2 || 0), vol: i.volume, muted: i.muted }));
    broadcast(bridgeClients, { type: 'vmix-meters', data: { levels } });
  } catch (e) { /* non-fatal */ }
}, 500);

// ── Production switcher routing (OBS or vMix — mutually exclusive) ────────────
// Cut PROGRAM to a target on the ACTIVE backend. OBS: scene NAME. vMix: input (matched by
// number / name / GUID). vMix matches inputs by title, so as long as vMix input titles mirror
// the OBS scene names, every existing obs_switch_scene caller in the app works on BOTH backends
// with no per-caller changes. No-op when the active backend isn't ready.
function switcherCut(target, opts) {
  target = (target == null ? '' : String(target)).trim();
  if (!target) return;
  if (state.switcher.target === 'vmix') {
    if (!state.vmix.enabled) return;
    const fn = (opts && opts.transition) || 'Cut';
    const params = { Input: target };
    if (opts && opts.duration) params.Duration = opts.duration;
    vmixDo(fn, params);
    return;
  }
  if (obsClient && obsClient.isConnected()) obsClient.switchScene(target);
}

// Set the PREVIEW (next) source on the active backend. OBS needs Studio Mode on.
// Studio Mode auto-enable is intentionally disabled (Switcher page — the only caller — is hidden
// from nav): this now silently no-ops on OBS unless Studio Mode was already turned on some other,
// deliberate way, so it can never flip a live show into Studio Mode by accident.
async function switcherSetPreview(target) {
  target = (target == null ? '' : String(target)).trim(); if (!target) return;
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo('PreviewInput', { Input: target }); return; }
  if (!obsClient || !obsClient.isConnected()) return;
  if (!state.obs.studioMode) return;
  try {
    await obsClient.call('SetCurrentPreviewScene', { sceneName: target });
    state.obs.currentPreviewScene = target;
    broadcastFullState();
  } catch (e) { /* non-fatal */ }
}

// TAKE preview → program. mode 'cut' | 'fade'. OBS uses Studio Mode transition; vMix Cut/Fade.
// TAKE preview → program. transition: 'Cut' | 'Fade' | 'Stinger1..4' | 'Wipe' | 'Slide' | ...
// Studio Mode auto-enable disabled — see switcherSetPreview above; no-ops on OBS unless already on.
async function switcherTake(transition, durationMs) {
  transition = transition || 'Cut';
  const isCut = transition === 'Cut';
  if (state.switcher.target === 'vmix') {
    if (!state.vmix.enabled) return;
    vmixDo(transition, (!isCut && durationMs) ? { Duration: durationMs } : {});
    return;
  }
  if (!obsClient || !obsClient.isConnected()) return;
  if (!state.obs.studioMode) return;
  try {
    // Map the requested transition onto OBS's configured transitions (Cut/Fade are always present;
    // Stinger/Wipe only if the OBS profile has one — fall back to Fade, else Cut).
    const avail = state.obs.availableTransitions || [];
    let trans = 'Cut';
    if (!isCut) {
      const want = /stinger/i.test(transition) ? avail.find((t) => /stinger/i.test(t)) : avail.find((t) => t.toLowerCase() === transition.toLowerCase());
      trans = want || avail.find((t) => /fade|dissolve/i.test(t)) || 'Fade';
    }
    try { await obsClient.call('SetCurrentSceneTransition', { transitionName: trans }); } catch (e) {}
    if (!isCut && durationMs) try { await obsClient.call('SetCurrentSceneTransitionDuration', { transitionDuration: durationMs }); } catch (e) {}
    await obsClient.call('TriggerStudioModeTransition');
  } catch (e) { /* non-fatal */ }
}

// Stream / record / fade-to-black / replay — routed to the active backend.
function switcherStream(on) {
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo(on ? 'StartStreaming' : 'StopStreaming'); return; }
  if (obsClient && obsClient.isConnected()) obsClient.call(on ? 'StartStream' : 'StopStream').catch(() => {});
}
function switcherRecord(on) {
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo(on ? 'StartRecording' : 'StopRecording'); return; }
  if (obsClient && obsClient.isConnected()) obsClient.call(on ? 'StartRecord' : 'StopRecord').catch(() => {});
}
function switcherFtb() {
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo('FadeToBlack'); return; }
  // OBS has no native FTB — cut to a scene named Black/FTB if one exists.
  const black = (state.obs.availableScenes || []).find((s) => /^(black|ftb|fade to black)$/i.test(s.trim()));
  if (black && obsClient && obsClient.isConnected()) obsClient.switchScene(black);
}
async function switcherReplay() {
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo('ReplayPlayLastEvent'); return; }
  if (obsClient && obsClient.isConnected()) try { await obsClient.call('SaveReplayBuffer'); } catch (e) {}
}

// Adjust audio on a source. OBS: SetInputVolume(dB) / SetInputMute. vMix: SetVolume(0-100) / Audio.
async function switcherAudioSet(id, opts) {
  opts = opts || {};
  if (state.switcher.target === 'vmix') {
    if (!state.vmix.enabled) return;
    if (opts.volume != null) vmixDo('SetVolume', { Input: id, Value: Math.max(0, Math.min(100, Math.round(opts.volume))) });
    if (opts.muted != null) vmixDo(opts.muted ? 'AudioOff' : 'AudioOn', { Input: id });
    return;
  }
  if (!obsClient || !obsClient.isConnected()) return;
  try {
    if (opts.volume != null) await obsClient.call('SetInputVolume', { inputName: id, inputVolumeDb: Math.max(-60, Math.min(0, opts.volume)) });
    if (opts.muted != null) await obsClient.call('SetInputMute', { inputName: id, inputMuted: !!opts.muted });
  } catch (e) { /* non-fatal */ }
}

// Poll OBS program/preview/studio-mode while the Switcher page is open (client toggles _switcherWatching).
let _switcherWatching = false;
let _obsPreviewSig = '';
async function pollObsPreview() {
  if (!_switcherWatching || state.switcher.target !== 'obs') return;
  if (!obsClient || !obsClient.isConnected()) return;
  try {
    const sm = await obsClient.call('GetStudioModeEnabled');
    state.obs.studioMode = !!(sm && sm.studioModeEnabled);
    if (state.obs.studioMode) {
      const pv = await obsClient.call('GetCurrentPreviewScene');
      state.obs.currentPreviewScene = (pv && (pv.sceneName || pv.currentPreviewSceneName)) || '';
    }
    const sig = state.obs.studioMode + '|' + state.obs.currentPreviewScene;
    if (sig !== _obsPreviewSig) { _obsPreviewSig = sig; broadcastFullState(); }
  } catch (e) { /* non-fatal */ }
}
setInterval(() => { pollObsPreview().catch(() => {}); }, 1500);

// Opt-in RL scene automation (kickoff / post-game). These are per-trigger, producer-enabled cuts, so
// they fire regardless of the blanket OBS_AUTO_SWITCH_DISABLED — but still respect the OBS connection,
// obs.enabled, and AI-director shielding. The caller already checked the trigger's own enable flag.
// Returns { ok, reason } instead of failing silently — callers broadcast this so a producer can see
// exactly why an expected cut didn't happen, instead of just "nothing happened."
function rlSwitchScene(name, reason, transitionName) {
  const sceneName = (name || '').trim();
  if (!sceneName) return { ok: false, reason: 'no_scene' };
  if (!obsClient) return { ok: false, reason: 'obs_not_connected' };
  if (!state.obs.enabled) return { ok: false, reason: 'obs_disabled' };
  if (!obsClient.isConnected()) return { ok: false, reason: 'obs_not_connected' };
  if (aiShielded()) return { ok: false, reason: 'ai_shielded' };
  // The scene must still exist in OBS. Renaming/deleting/reorganizing the scene in OBS is the most
  // common reason these RL auto-cuts "silently stop working" — the old code fired the switch and
  // reported success even when OBS had no such scene. Only validate when we actually have a scene
  // list (empty = not fetched yet → don't block, let OBS decide).
  const scenes = state.obs.availableScenes || [];
  if (scenes.length && !scenes.includes(sceneName)) return { ok: false, reason: 'scene_missing' };
  const tn = (transitionName || '').trim();
  console.log(`[OBS] RL auto-switch → ${sceneName} (${reason || 'rl'}${tn ? ', transition: ' + tn : ''})`);
  if (tn) {
    obsClient.switchSceneWithTransition(sceneName, tn);
  } else {
    obsClient.switchScene(sceneName);
  }
  return { ok: true };
}
const RL_SCENE_FAIL_MESSAGES = {
  no_scene: 'no scene selected',
  obs_not_connected: 'OBS is not connected',
  obs_disabled: 'OBS integration is disabled (Settings → OBS)',
  ai_shielded: 'AI director shield is active',
  scene_missing: 'that scene no longer exists in OBS (renamed/deleted) — re-pick it in Match ▸ Teams gear'
};
function broadcastRlSceneResult(phase, sceneName, result) {
  const message = result.ok
    ? `Cut to "${sceneName}" (${phase})`
    : `${phase === 'kickoff' ? 'Kickoff' : 'Post-game'} cut to "${sceneName}" skipped — ${RL_SCENE_FAIL_MESSAGES[result.reason] || result.reason}`;
  logAuto('rl-scene', message);
  // A failed cut here is a real problem the producer should fix (wrong scene name, OBS off, shield) —
  // flag it for the notification bell so it isn't missed with the gear panel closed.
  broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: !!result.ok, phase, message, notify: !result.ok } });
}

// Reset the held post-game scoreboard back to the live HUD (drop the frozen board). Used by the manual
// "Clear Scoreboard" button and by the post-game auto-switch (once we've cut away, the board resets so
// cutting back shows the live HUD, not the stale board).
function clearPostGameBoard() {
  if (_postGameTimer) { clearTimeout(_postGameTimer); _postGameTimer = null; }
  if (_boardLingerTimer) { clearTimeout(_boardLingerTimer); _boardLingerTimer = null; }
  state.view = 'hud';
  state.scoreboard = null;
  broadcast(bridgeClients, { type: 'clear_scoreboard', data: {} });
  broadcastFullState();
}

// When the break countdown has both a target time AND a "then" scene, schedule the cut.
// Only the thenScene case auto-hides the break — without one, the overlay keeps showing its
// "WE'RE LIVE!" final message and the producer hides it manually (unchanged behaviour).
let _breakAutoTimer = null;
function clearBreakAutoSwitch() {
  if (_breakAutoTimer) { clearTimeout(_breakAutoTimer); _breakAutoTimer = null; }
}
function scheduleBreakAutoSwitch() {
  clearBreakAutoSwitch();
  const b = state.breakScreen;
  if (!b || !b.visible || !b.endsAt || !b.thenScene) return;
  if (b.thenPlayout) return;   // a playout playlist handles the handoff client-side (plays, then cuts)
  const thenScene = b.thenScene;
  const delay = Math.max(0, b.endsAt - Date.now());
  _breakAutoTimer = setTimeout(() => {
    _breakAutoTimer = null;
    if (!state.breakScreen.visible) return;          // producer already took it down
    flowBus.emit('timer_countdown_end', {});
    state.breakScreen.visible = false;
    state.breakScreen.endsAt = null;
    state.breakScreen.thenScene = '';
    saveAppState();
    broadcastFullState();
    obsSwitchSceneName(thenScene);
  }, delay);
}

// Fire-and-forget: save an OBS replay clip when a goal is scored (if enabled).
function obsAutoReplay() {
  if (aiShielded()) return;
  if (!obsClient || !state.obs.enabled || !state.obs.autoReplayOnGoal) return;
  if (!obsClient.isConnected()) return;
  obsClient.saveReplayBuffer().catch(() => { /* harmless if buffer is off */ });
}

// ─── RL TCP Client ─────────────────────────────────────────────────────────────
const net = require('net');
let rlSocket = null;
let bridgeClients = new Set();
// Auto-update bridge: main.js owns electron-updater (same process) and registers handlers here;
// the control panel drives it over the WS and shows status pushed via broadcastUpdateStatus.
let _updateHandlers = null;
let _lastUpdateStatus = null;
let rlBuffer = '';
let rlReconnectTimer = null;
let rlEventSeen = {};      // diagnostic: tally of RL event types seen since connect
let rlLoggedFirstData = false;

function disconnectRL() {
  if (rlReconnectTimer) { clearTimeout(rlReconnectTimer); rlReconnectTimer = null; }
  if (rlSocket) { try { rlSocket.destroy(); } catch (e) {} rlSocket = null; }
  if (state.rlConnected) { state.rlConnected = false; broadcast(bridgeClients, { type: 'rl_status', data: { connected: false } }); }
  setPerfActive(false);
}

// ── Game performance mode (see state.perfMode) ──────────────────────────────
// Engaged at the RL kickoff, released at match end / RL disconnect. main.js registers
// the priority callback (drops every app process below-normal while the game is live).
let _perfPriorityCb = null, _lastShed = null;
// Load is shed while a match is live (auto mode) OR permanently (always-on lean mode).
function perfShedActive() { const pm = state.perfMode || {}; return !!((pm.active && pm.enabled !== false) || pm.always); }
function perfCoalesceMs() {
  const pm = state.perfMode || {};
  if (perfShedActive()) return 250;
  return pm.broadcastRate === 'light' ? 250 : pm.broadcastRate === 'balanced' ? 120 : 40;
}
function applyPerfSideEffects() {
  const shed = perfShedActive();
  if (shed === _lastShed) return;
  _lastShed = shed;
  try { if (typeof _perfPriorityCb === 'function') _perfPriorityCb(shed); } catch (e) { console.warn('[Perf] priority change failed:', e.message); }
  console.log('[Perf] load shedding', shed ? 'ON' : 'off');
}
function setPerfActive(on) {
  const pm = state.perfMode || (state.perfMode = { enabled: true, active: false });
  const want = !!on && pm.enabled !== false;
  if (!!pm.active === want) return;
  pm.active = want;
  applyPerfSideEffects();
  broadcastFullState();
}

function connectToRL() {
  if (state.activeGame !== 'rocket-league') return;
  if (rlSocket) return;
  if (rlReconnectTimer) {
    clearTimeout(rlReconnectTimer);
    rlReconnectTimer = null;
  }
  
  rlSocket = new net.Socket();
  let wasConnected = false;
  
  rlSocket.connect(RL_STATS_PORT, '127.0.0.1', () => {
    console.log('[RL] Connected to Stats API (TCP) on port ' + RL_STATS_PORT);
    wasConnected = true;
    state.rlConnected = true;
    rlEventSeen = {}; rlLoggedFirstData = false;   // reset diagnostics per connection
    broadcast(bridgeClients, { type: 'rl_status', data: { connected: true } });
  });

  rlSocket.on('data', (data) => {
    if (!rlLoggedFirstData) { rlLoggedFirstData = true;
      if (IS_DEV()) console.log('[RL] first data after connect (' + data.length + ' bytes):', JSON.stringify(data.toString().slice(0, 400))); }
    rlBuffer += data.toString();
    
    // Split by contiguous JSON objects
    const chunks = rlBuffer.replace(/\}\s*\{/g, '}\n{').split('\n');
    rlBuffer = chunks.pop(); // keep the last incomplete chunk
    
    chunks.forEach(chunk => {
      chunk = chunk.trim();
      if (!chunk) return;
      try {
        const msg = JSON.parse(chunk);
        handleRLEvent(msg);
      } catch (e) {
        // If it fails to parse, it might be incomplete. We should prepend it back.
        // But since we split by }\n{, it should be complete unless the split failed.
        // For simplicity, we just ignore broken packets.
      }
    });
  });

  rlSocket.on('close', () => {
    if (wasConnected || state.rlConnected) {
      console.log('[RL] Disconnected from Stats API');
    }
    if (state.rlConnected) {
      try { analytics.event('disconnect', { what: 'RL API' }); } catch (e) {}
      state.rlConnected = false;
      broadcast(bridgeClients, { type: 'rl_status', data: { connected: false } });
    }
    rlSocket = null;
    scheduleRLReconnect();
  });

  rlSocket.on('error', () => {
    rlSocket = null;
    scheduleRLReconnect();
  });
}

function scheduleRLReconnect() {
  if (state.activeGame !== 'rocket-league') return;
  if (rlReconnectTimer) return;
  rlReconnectTimer = setTimeout(() => {
    rlReconnectTimer = null;
    connectToRL();
  }, RL_RECONNECT_INTERVAL);
}

/** Tracks RL clock/scores between packets for kickoff + goal inference. */
const rlGameTrack = { gameTime: null, blueScore: 0, orangeScore: 0 };

// True once the observer is spectating a lobby (live players present). Drives the "hide RL's native
// UI the moment spectating begins" behaviour — see handleUpdateState. Re-armed each match.
let _rlSpectatingActive = false;

function resetRlGameTrack() {
  rlGameTrack.gameTime = state.game?.time ?? 300;
  rlGameTrack.blueScore = state.game?.blueScore ?? 0;
  rlGameTrack.orangeScore = state.game?.orangeScore ?? 0;
}


function inferGoalFromScoreDiff(prevPlayers, players) {
  const bs = state.game.blueScore ?? 0;
  const os = state.game.orangeScore ?? 0;
  const prevBs = rlGameTrack.blueScore;
  const prevOs = rlGameTrack.orangeScore;
  if (bs <= prevBs && os <= prevOs) return null;

  const team = bs > prevBs ? 0 : 1;
  let scorer = '';
  let assisterName = null;
  for (const p of players) {
    const prevP = (prevPlayers || []).find((x) => x.name === p.name);
    if (prevP && (p.goals || 0) > (prevP.goals || 0)) {
      scorer = p.name;
      break;
    }
  }
  if (!scorer) {
    const side = team === 0 ? 0 : 1;
    const candidate = [...players]
      .filter((p) => Number(p.team) === side)
      .sort((a, b) => (b.goals || 0) - (a.goals || 0))[0];
    scorer = candidate?.name || '';
  }
  return { scorer, assisterName, speed: 0, team };
}

function handleRLEvent(msg) {
  const event = msg.Event || msg.event || '';
  let data  = msg.Data  || msg.data  || {};

  // DefaultStatsAPI sometimes stringifies the Data field
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { }
  }

  // diagnostic: log each event type the first time it's seen + periodic player count
  if (!(event in rlEventSeen)) { rlEventSeen[event] = 0;
    console.log('[RL] event type:', event || '(none)', '— keys:', Object.keys(data).slice(0, 8).join(',')); }
  rlEventSeen[event]++;
  if ((event === 'UpdateState' || event === 'game:update_state') && rlEventSeen[event] % 120 === 1) {
    console.log('[RL] UpdateState players=' + (data.Players || data.players || []).length +
      ' target=' + ((data.Game || data.game || {}).Target?.Name || (data.Game || data.game || {}).Target?.name || '-')); }

  switch (event) {
    case 'UpdateState':
    case 'game:update_state':
      handleUpdateState(data);
      break;
    case 'GoalScored':
    case 'game:goal_scored':
      handleGoalScored(data);
      break;
    case 'ClockUpdatedSeconds':
    case 'game:clock_updated_seconds':
      handleClock(data);
      break;
    case 'RoundStarted':        // official RL Stats API — active gameplay begins (the real kickoff)
    case 'ClockStarted':        // legacy / SOS aliases (kept for compatibility)
    case 'game:clock_started':
      // Play has begun → return from the post-game scoreboard to the in-game overlay. Gated on
      // awaitingKickoff, so it's a no-op mid-game; fires at the real kickoff, not the "choose teams" timer.
      returnToInGameForKickoff();
      break;
    case 'GoalReplayStart':
    case 'ReplayStart':
    case 'game:replay_start':
      handleGoalReplayStart();
      break;
    case 'GoalReplayEnd':
    case 'ReplayEnd':
    case 'game:replay_end':
      handleGoalReplayEnd();
      break;
    case 'CountdownBegin':      // official RL Stats API — kickoff countdown begins
    case 'PreCountdownBegin':   // legacy / SOS aliases (kept for compatibility)
    case 'game:pre_countdown_begin':
    case 'PostCountdownBegin':
    case 'game:post_countdown_begin':
      handleCountdownBegin();   // a kickoff countdown — the OVERTIME kickoff is our event-driven OT cue
      break;
    case 'MatchEnded':
    case 'game:match_ended':
      handleMatchEnded(data);
      break;
    case 'MatchCreated':
    case 'game:match_created':
      handleMatchCreated(data);
      break;
    default:
      break;
  }
}

// ── Overtime trigger ─────────────────────────────────────────────────────────
// Rocket League only flips its own bOverTime / IsOT flag at the OT KICKOFF (after the countdown),
// which is too late for broadcast graphics. The OVERTIME animation should land the moment OT is
// actually triggered: regulation expired (clock at 0:00), score tied, and the ball settling to the
// ground. We detect that here and push isOT to the overlays early.
const OT_BALL_GROUND_Z = 140;    // ball radius ≈ 93uu; z ≤ 140 ≈ on / about to touch the floor (SOS/BakkesMod variants only)
function resetOvertimeTrigger() {
  state.otTriggered = false;
}
function fireOvertime() {
  if (state.otTriggered) return;
  state.otTriggered = true;
  state.game.isOT = true;
  flowBus.emit('rl_overtime', {});
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: state.players,
      spectatedPlayer: state.spectatedPlayer,
      facecams: savedFacecams
    }
  });
}
// PRIMARY (event-driven) OT cue: a kickoff countdown is starting. Countdowns fire before EVERY
// kickoff, so we only treat it as overtime when regulation has expired with the score tied (or RL
// has already flagged OT). The OT countdown begins right after the ground-touch / OVERTIME banner
// and before the ball is touched — exactly when the graphic should land. fireOvertime is latched,
// so this is a no-op if the state-derived fallback already fired.
// Bring up the in-game (RL overlay) OBS scene now that gameplay is starting — but only if we were
// parked in post-game waiting for it. Called from the kickoff countdown (primary) and the first
// live clock tick (fallback, in case the API build doesn't emit countdown events).
function returnToInGameForKickoff() {
  setPerfActive(true);   // a match is live — shed app load until it ends (no-op if disabled)
  if (!state.awaitingKickoff) return;
  flowBus.emit('rl_round_started', {});
  state.awaitingKickoff = false;
  state.scoreboard = null;          // new game kicking off → drop the frozen post-game scoreboard
  const wasBoard = (state.view === 'scoreboard');
  // If the next kickoff arrives before the post-game→casters timer fired, that timer's own
  // `state.view === 'scoreboard'` guard (below, in handleMatchEnded) would silently no-op once we
  // flip state.view to 'hud' here — so cancel it explicitly and say why, instead of letting it
  // expire later doing nothing with no explanation.
  if (_postGameTimer) {
    clearTimeout(_postGameTimer);
    _postGameTimer = null;
    broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', message: 'Post-game cut to casters cancelled — the next kickoff started first.' } });
  }
  if (_boardLingerTimer) { clearTimeout(_boardLingerTimer); _boardLingerTimer = null; }
  // Same idea, one step earlier: the winning-goal replay's end (or the fallback timer) never got a
  // chance to even arm the post-game timer before this kickoff arrived — cancel the wait outright.
  if (_pendingPostGameFinalize) {
    _pendingPostGameFinalize = false;
    if (_pendingFinalizeFallbackTimer) { clearTimeout(_pendingFinalizeFallbackTimer); _pendingFinalizeFallbackTimer = null; }
    broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', message: 'Post-game cut to casters cancelled — the next kickoff started before the post-game board was even shown.' } });
  }
  // _pendingFinalizeDirectTimer (the 800ms "no replay" timer) is intentionally NOT cancelled here:
  // if it fires after this kickoff, finalizePostGameBoard checks awaitingKickoff and bails out early.
  // Cancelling it would also cancel it for cases like RoundStarted firing quickly after MatchEnded.
  state.view = 'hud';
  state.inReplay = false;
  broadcastFullState();
  // Always send game_reset at between-game kickoffs so overlays reset their HUD state.
  // wasBoard check was removed: after a caster switch clearPostGameBoard already set view='hud',
  // so wasBoard would be false even though a new game IS starting and the overlay needs resetting.
  broadcast(bridgeClients, { type: 'game_reset', data: { gameNumber: state.game.number } });
  // Smart Trigger: at the kickoff countdown, cut to the producer-chosen scene if set; otherwise the
  // mapped In-Game scene. (Both respect the master autoSwitch + OBS connection state.)
  const kt = state.obs.kickoff;
  if (kt && kt.enabled && kt.scene) broadcastRlSceneResult('kickoff', kt.scene, rlSwitchScene(kt.scene, 'kickoff', kt.transition));   // opt-in RL kickoff cut (bypasses the disabled global auto-switch)
  else obsSwitch('inGame');   // the RL overlay scene comes up at kickoff, not during "choose teams"
  // Hide RL's native UI NOW that gameplay is starting (this is the consistent moment). Reset first so
  // every game re-hides — RL re-shows its UI at each kickoff; the per-packet path then retries if the
  // press fails. matchDelayMs still applies so RL has settled into play before the key is sent.
  rlSpectatorUi.resetAutoTracking();
  scheduleRlHideNativeUi(state.game.number);
}
// Kickoff fallback for stats APIs that don't emit clock_started / countdown events: when we're
// awaiting kickoff and the MATCH clock is running DOWN near 5:00 (>= 150s — so the separate ~60s
// "choose teams" timer can never trigger it), the game has begun → return to the in-game overlay.
// Called from BOTH handleClock and handleUpdateState, since some APIs send the clock via UpdateState
// (game.SecondsRemaining) rather than ClockUpdatedSeconds.
function maybeReturnForKickoff(prevTime) {
  if (!state.awaitingKickoff) return;
  // Don't trigger while the post-game board is pending or visible: RL fires match_created almost
  // immediately after game end and the lobby clock starts ticking (300→299) before finalizePostGameBoard
  // has had a chance to run. Without this guard, maybeReturnForKickoff fires prematurely, clears
  // _pendingPostGameFinalize, and the caster-cut timer is never armed for subsequent games.
  // CountdownBegin / RoundStarted bypass all of these guards (they call returnToInGameForKickoff directly).
  if (state.view === 'scoreboard' || _pendingPostGameFinalize || _pendingFinalizeDirectTimer) return;
  const t = state.game.time;
  if (typeof t === 'number' && typeof prevTime === 'number' && t < prevTime && t >= 150) {
    console.log('[RL] Kickoff inferred from the running match clock (' + t + 's) — returning to the in-game overlay.');
    returnToInGameForKickoff();
  }
}
function handleCountdownBegin() {
  // A kickoff countdown means gameplay is about to start.
  returnToInGameForKickoff();   // post-game → bring the RL overlay scene back at the kickoff
  // mid-game OT kickoff: fire the OVERTIME graphic if regulation expired tied (latched / no-op otherwise)
  const tied    = (state.game.blueScore ?? 0) === (state.game.orangeScore ?? 0);
  const regOver = (state.game.time ?? 999) <= 0;
  if (state.game.isOT || (regOver && tied)) fireOvertime();
}
function maybeTriggerOvertime() {
  if (state.view === 'scoreboard') return;             // match already over
  if (state.game.isOT) { fireOvertime(); return; }     // RL confirmed OT itself → make sure it's broadcast
  if (state.otTriggered) return;
  const tied    = (state.game.blueScore ?? 0) === (state.game.orangeScore ?? 0);
  const regOver = (state.game.time ?? 999) <= 0;
  if (!regOver || !tied) return;                       // outside the OT-pending window
  // Regulation expired with the score tied → OT is PENDING but NOT yet confirmed. Fire ONLY once the
  // ball actually TOUCHES THE GROUND (its height, exposed only by SOS/BakkesMod variants). We must
  // NOT fire on a timer: after 0:00 the ball can stay airborne for several seconds and a last-second
  // buzzer-beater unties the score → NO overtime. When ball height isn't exposed (the official Stats
  // API doesn't provide it), we wait for a reliable OT signal instead — RL's own bOvertime flag or the
  // OT-kickoff countdown (handleCountdownBegin), both of which only occur once OT has actually started.
  const z = (state.rlBall && typeof state.rlBall.z === 'number') ? state.rlBall.z : null;
  if (z !== null && z <= OT_BALL_GROUND_Z) fireOvertime();
}

function handleClock(data) {
  const prevTime = (typeof state.game.time === 'number') ? state.game.time : null;
  if ('TimeSeconds' in data) state.game.time = data.TimeSeconds;
  else if ('time_seconds' in data) state.game.time = data.time_seconds;

  if ('bOvertime' in data) state.game.isOT = data.bOvertime;
  maybeTriggerOvertime();   // detect the 0:00 ground-touch OT trigger (before RL's own late flag)

  rlGameTrack.gameTime = state.game.time;

  // Post-game scoreboard → in-game overlay: PRIMARY path is the 'clock_started' / countdown events
  // (handleRLEvent + handleCountdownBegin); this is the running-clock fallback for APIs without them.
  maybeReturnForKickoff(prevTime);

  // Clock ticks during live play mean replay is over; don't cut short while bReplay is active.
  if (state.view === 'goal' && !state.inReplay) {
    handleGoalReplayEnd();
  }

  feedDirectorRL();

  // Broadcast the new time to clients
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: state.players,
      spectatedPlayer: state.spectatedPlayer,
      facecams: savedFacecams
    }
  });
}

// Normalise an RL Stats API team colour to a #rrggbb hex. Handles "0000FF", "#0000FF", "0x0000FF",
// 8-digit ARGB/RGBA (drops alpha), 3-digit shorthand, and a raw 24-bit number. Returns '' if unknown.
function normRlColor(v) {
  if (v == null) return '';
  if (typeof v === 'number' && isFinite(v)) { const h = (v >>> 0).toString(16).padStart(6, '0'); return '#' + h.slice(-6); }
  let s = String(v).trim(); if (!s) return '';
  s = s.replace(/^0x/i, '').replace(/^#/, '');
  if (/^[0-9a-f]{8}$/i.test(s)) s = s.slice(-6);            // ARGB/RGBA → drop alpha
  if (/^[0-9a-f]{6}$/i.test(s)) return '#' + s.toLowerCase();
  if (/^[0-9a-f]{3}$/i.test(s)) return '#' + s.split('').map((c) => c + c).join('').toLowerCase();
  return '';
}
let _rlTeamColorLogged = false;   // one-shot diagnostic so we can confirm the live feed's colour field/format
let _rlPacketShapeLogged = false; // one-shot diagnostic: dump the FULL key set the RL Stats API sends
function handleUpdateState(data) {
  const game = data.Game || data.game || {};
  const players = data.Players || data.players || [];

  // One-shot: dump the complete shape of a live RL Stats API packet so we know EXACTLY which
  // per-player + game fields are available (drives which stats the stats screen can show — no
  // guessing). Logs top-level keys and one level of nesting (Location/Stats/etc.).
  if (!_rlPacketShapeLogged && players[0]) {
    _rlPacketShapeLogged = true;
    const p0 = players[0];
    console.log('[RL] Packet shape — PLAYER keys:', Object.keys(p0).join(','));
    Object.keys(p0).forEach((k) => {
      const v = p0[k];
      if (v && typeof v === 'object') console.log('[RL]   player.' + k + ' →', Object.keys(v).join(',') || '(empty obj)');
    });
    console.log('[RL] Packet shape — GAME keys:', Object.keys(game).join(','));
    console.log('[RL] Packet shape — sample PLAYER JSON:', JSON.stringify(p0).slice(0, 900));
  }
  const prevTime = (typeof state.game.time === 'number') ? state.game.time : null;

  // Update game clock — official RL Stats API field is Game.TimeSeconds (legacy aliases kept).
  if ('TimeSeconds' in game) state.game.time = game.TimeSeconds;
  else if ('SecondsRemaining' in game) state.game.time = game.SecondsRemaining;
  else if ('time_seconds' in game) state.game.time = game.time_seconds;

  // Secondary kickoff fallback (RoundStarted / CountdownBegin events are the primary path): if those
  // events are ever missed, detect the running match clock here. No-op mid-game; gated on
  // awaitingKickoff + clock ticking down near 5:00 (so the ~60s "choose teams" timer can't trigger it).
  maybeReturnForKickoff(prevTime);

  if ('bOvertime' in game) state.game.isOT = game.bOvertime;   // official RL Stats API OT flag
  else if ('IsOT' in game) state.game.isOT = game.IsOT;
  else if ('isOT' in game) state.game.isOT = game.isOT;

  // Scores from teams array or direct fields
  const teams = game.Teams || game.teams || [];
  if (teams.length >= 2) {
    teams.forEach(t => {
      // Private-match paint colours reported by the RL Stats API (ColorPrimary; other field
      // names/formats tolerated). Kept in gameTeams.*Color for the "Game colours" mode.
      const col = normRlColor(t.ColorPrimary ?? t.colorPrimary ?? t.color_primary ?? t.Color ?? t.color);
      if ((t.TeamNum === 0 || t.teamNum === 0)) {
        state.game.blueScore   = t.Score ?? t.score ?? 0;
        state.gameTeams.blue   = t.Name || t.name || 'BLUE';
        if (col) state.gameTeams.blueColor = col;
        if (state.autoTeamsFromGame) applyGameTeamName('blue', t.Name || t.name);
      }
      if ((t.TeamNum === 1 || t.teamNum === 1)) {
        state.game.orangeScore = t.Score ?? t.score ?? 0;
        state.gameTeams.orange = t.Name || t.name || 'ORANGE';
        if (col) state.gameTeams.orangeColor = col;
        if (state.autoTeamsFromGame) applyGameTeamName('orange', t.Name || t.name);
      }
    });
    // One-shot diagnostic: confirm the live feed's colour field name + format so "Game colours" mode
    // can be verified. Shows the team object's keys + the raw ColorPrimary + what we parsed.
    if (!_rlTeamColorLogged && teams[0]) {
      _rlTeamColorLogged = true;
      console.log('[RL] Team colours — keys:', Object.keys(teams[0]).join(','),
        '| raw ColorPrimary=', JSON.stringify(teams[0].ColorPrimary ?? teams[0].colorPrimary ?? teams[0].color_primary ?? null),
        '| parsed blue=', state.gameTeams.blueColor || '(none)', 'orange=', state.gameTeams.orangeColor || '(none)');
    }
  } else {
    if ('BlueScore'   in game) state.game.blueScore   = game.BlueScore;
    if ('OrangeScore' in game) state.game.orangeScore = game.OrangeScore;
  }

  // Ball state — the official Stats API nests this under Game.Ball and only exposes Speed (it does
  // NOT provide continuous ball/player positions). x/y/z are kept for SOS/other variants but are null
  // on the official API, so the OT "ball on the ground" cue falls back to the bOvertime flag + settle
  // timer (see maybeTriggerOvertime).
  const ballRaw = game.Ball || game.ball || data.Ball || data.ball || null;
  if (ballRaw && typeof ballRaw === 'object') {
    state.rlBall = {
      x: ballRaw.X ?? ballRaw.x ?? null,
      y: ballRaw.Y ?? ballRaw.y ?? null,
      z: ballRaw.Z ?? ballRaw.z ?? null,
      speed: ballRaw.Speed ?? ballRaw.speed ?? null
    };
  }

  // Players — normalise field names (Stats API PascalCase + legacy snake_case)
  const normalised = players.map(p => ({
    name:    p.Name    || p.name    || '?',
    primaryid: p.PrimaryId ?? p.primaryId ?? null,
    team:    p.TeamNum ?? p.teamNum ?? 0,
    score:   p.Score   ?? p.score   ?? 0,
    goals:   p.Goals   ?? p.goals   ?? 0,
    assists: p.Assists ?? p.assists ?? 0,
    saves:   p.Saves   ?? p.saves   ?? 0,
    shots:   p.Shots   ?? p.shots   ?? 0,
    demos:   p.Demos   ?? p.demos   ?? 0,
    boost:   p.Boost   ?? p.boost   ?? null,
    isPrimary: p.IsPrimary ?? p.isPrimary ?? false,
    isDemolished: p.bDemolished ?? p.isDemolished ?? false,
    pos: (p.Location || p.location || p.Position || p.position) ? {
      x: (p.Location || p.location || p.Position || p.position).X ?? (p.Location || p.location || p.Position || p.position).x ?? 0,
      y: (p.Location || p.location || p.Position || p.position).Y ?? (p.Location || p.location || p.Position || p.position).y ?? 0,
      z: (p.Location || p.location || p.Position || p.position).Z ?? (p.Location || p.location || p.Position || p.position).z ?? 0
    } : null
  }));

  state.players = normalised;

  // Update playerCache (persist players across game/disconnect)
  normalised.forEach(p => {
    state.playerCache[p.name] = { ...p };
  });

  // Spectating just began — the observer joined the lobby and players are now present. Hide RL's
  // native spectator UI NOW (before kickoff), not only at the kickoff, so the pre-kickoff "choose
  // teams" wait isn't broadcast with RL's own UI on screen. Latched so the toggle isn't spammed;
  // re-armed each match (handleMatchCreated) and when players clear. The kickoff still re-hides —
  // RL re-shows its UI when gameplay actually starts (see returnToInGameForKickoff).
  const nowSpectating = normalised.length > 0;
  if (nowSpectating && !_rlSpectatingActive) {
    _rlSpectatingActive = true;
    rlSpectatorUi.resetAutoTracking();   // clear any prior press-window so this early hide can fire
    scheduleRlHideNativeUi(state.game.number);
  } else if (!nowSpectating && _rlSpectatingActive) {
    _rlSpectatingActive = false;
  }

  // Detect the spectated/observed player. The official RL Stats API does NOT expose a reliable target
  // name; instead, SPECTATOR-only fields (e.g. Boost) are present ONLY for the player the observer
  // camera is currently on — so "Boost is present" identifies the spectated player. Game.Target /
  // IsPrimary are kept as fallbacks for SOS and other API variants.
  let spec = null;
  if (game.bHasTarget !== false && game.Target && typeof game.Target === 'object') {
    spec = game.Target.Name || game.Target.name || null;
  }
  if (!spec) {
    const observed = normalised.find(p => p.boost != null);   // Boost present → the camera's current player
    if (observed) spec = observed.name;
  }
  if (!spec) {
    const primary = normalised.find(p => p.isPrimary);
    if (primary) spec = primary.name;
  }
  state.spectatedPlayer = spec;

  // Infer goal from score diff when GoalScored event was missed or arrived late.
  const prevPlayers = state.players;
  if (!state.currentGoal) {
    const inferred = inferGoalFromScoreDiff(prevPlayers, normalised);
    if (inferred) state.currentGoal = inferred;
  }

  rlGameTrack.gameTime = state.game.time;
  rlGameTrack.blueScore = state.game.blueScore ?? 0;
  rlGameTrack.orangeScore = state.game.orangeScore ?? 0;

  // Detect transition to replay to trigger goal banner if not already shown
  if (game.bReplay === true && !state.inReplay && state.view !== 'goal') {
    handleGoalReplayStart();
  }

  // Track replay state so we don't prematurely close the goal banner
  if (game.bReplay === true) {
    state.inReplay = true;
  } else if (game.bReplay === false && state.inReplay) {
    state.inReplay = false;
    if (state.view === 'goal') {
      handleGoalReplayEnd();
    }
  }

  // Broadcast state to all clients
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: normalised,
      spectatedPlayer: state.spectatedPlayer,
      facecams: savedFacecams
    }
  });
  // Native-UI auto-hide is fired once at the kickoff (returnToInGameForKickoff) — no per-packet
  // retries: the key is a toggle, so repeated blind presses risk flipping the UI the wrong way.

  maybeTriggerOvertime();   // fire the OVERTIME graphic at the 0:00 ground-touch, not RL's late kickoff flag
  feedDirectorRL();
}

// Best-effort "last man back": the deepest defender on the CONCEDING team at the moment of the goal.
// Needs player positions (and ideally the ball) from the Stats API — returns null if unavailable.
function computeLastManBack(scoringTeam) {
  const conceding = scoringTeam === 0 ? 1 : 0;
  const defenders = (state.players || []).filter(p => p && p.team === conceding && p.pos && typeof p.pos.y === 'number');
  if (!defenders.length) return null;
  // Which net does the conceding team defend? Prefer the ball's long-axis position at the goal;
  // otherwise infer from where the defenders are sitting (they camp near their own goal on defense).
  const ball = state.rlBall || {};
  let netSign;
  if (typeof ball.y === 'number' && Math.abs(ball.y) > 1500) netSign = ball.y > 0 ? 1 : -1;
  else {
    const avgY = defenders.reduce((s, p) => s + p.pos.y, 0) / defenders.length;
    netSign = avgY >= 0 ? 1 : -1;
  }
  let best = null;
  for (const p of defenders) {
    if (!best || (netSign > 0 ? p.pos.y > best.pos.y : p.pos.y < best.pos.y)) best = p;
  }
  return best ? best.name : null;
}

function handleGoalScored(data) {
  // Safety: a goal can only happen in live play. If we're still holding the post-game scoreboard
  // (the kickoff countdown event never arrived), a goal means the game is clearly underway → return.
  if (state.awaitingKickoff) returnToInGameForKickoff();

  const scorer   = data.Scorer   || data.scorer   || {};
  const assister = data.Assister || data.assister || null;
  const speed    = data.GoalSpeedKPH ?? data.goalSpeedKPH ?? data.GoalSpeed ?? data.goalSpeed ?? 0;
  const team     = scorer.TeamNum ?? scorer.teamNum ?? scorer.team ?? data.teamnum ?? 0;

  state.currentGoal = {
    scorer:   scorer.Name   || scorer.name   || '',
    assisterName: assister ? (assister.Name || assister.name || '') : null,
    speed:    Math.round(speed),
    team:     team,
    lastManBack: computeLastManBack(team)
  };

  // Tell overlays the instant the ball hits the net (BEFORE the replay starts), so
  // goal-triggered animations fire at the goal, not when the replay kicks in.
  try { analytics.event('goal'); } catch (e) {}
  broadcast(bridgeClients, { type: 'goal_scored', data: { team: state.currentGoal.team, goal: state.currentGoal } });
  flowBus.emit('rl_goal', { team: state.currentGoal.team, scorer: state.currentGoal.scorer });

  if (directorEngine) {
    directorEngine.onDiscreteEvent('rocket-league', {
      type: 'goal',
      scorer: state.currentGoal.scorer,
      assister: state.currentGoal.assisterName,
      gameTime: formatTime(state.game.time)
    });
  }
  // Clip capture also fires via director discrete event (deduped in clip-manager).
}

function handleGoalReplayStart() {
  flowBus.emit('rl_replay_start', {});
  if (state.view === 'goal' && state.inReplay) return;

  if (!state.currentGoal) {
    const inferred = inferGoalFromScoreDiff(state.players, state.players);
    if (inferred) state.currentGoal = inferred;
  }
  if (!state.currentGoal) {
    state.currentGoal = { scorer: '', assisterName: null, speed: 0, team: 0 };
  }

  state.view = 'goal';
  state.inReplay = true;
  broadcast(bridgeClients, { type: 'view_change', data: { view: 'goal', goal: state.currentGoal } });
  obsSwitch('replay');
}

function handleGoalReplayEnd() {
  flowBus.emit('rl_replay_end', {});
  if (state.view !== 'goal' && !state.inReplay && !_pendingPostGameFinalize) return;
  // If the winning-goal replay ends while the post-game scoreboard is already showing (the finalize
  // already ran, e.g. via the fallback timer), don't reset the view — it should keep holding.
  if (state.view === 'scoreboard') { state.inReplay = false; state.currentGoal = null; return; }

  state.inReplay = false;
  state.currentGoal = null;
  // MatchEnded fired while this replay was still playing — THIS is the actual end of the winning
  // goal's replay, so finalize the post-game board + arm the caster-cut timer now (see handleMatchEnded).
  if (_pendingPostGameFinalize) {
    finalizePostGameBoard();
    return;
  }

  state.view = 'hud';
  broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } });
  obsSwitch('inGame');
}

let _postGameTimer = null;
let _boardLingerTimer = null;           // 2s delay after OBS cut so the overlay holds through the transition
let _pendingPostGameFinalize = false;   // MatchEnded fired but the winning-goal replay is still playing
let _pendingFinalizeFallbackTimer = null;
let _pendingFinalizeDirectTimer = null; // tracks the 800ms "no replay" setTimeout so it can be cancelled at kickoff
let _pendingFinalizeRoster = null;      // roster snapshot taken at MatchEnded, consumed by finalizePostGameBoard

// Post-game roster for the scoreboard. playerCache accumulates EVERY name seen this game — reconnects,
// name-variant strings (e.g. "PHYNR" vs "PHYNR †"), coaches, and brief transients — which pile up as
// extra 0-stat rows and inflate the board. Cap each team to its actual roster size (top by score) so
// only the players who really played show. rosterSize is the upper bound; the live packet's per-team
// count refines it (2v2 vs 3v3), with a fallback to rosterSize when the packet is momentarily empty.
function scoreboardRoster() {
  const teamNum = (p) => (Number(p.team) === 1 ? 1 : 0);
  const live = Array.isArray(state.players) ? state.players : [];
  const rs = (GAMES[state.activeGame] && GAMES[state.activeGame].rosterSize) || 3;
  const capFor = (t) => { const n = live.filter((p) => teamNum(p) === t).length; return n > 0 ? Math.min(n, rs) : rs; };
  const all = Object.values(state.playerCache || {}).map((p) => ({ ...p }));
  const pick = (t) => all
    .filter((p) => teamNum(p) === t)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, capFor(t));
  const out = {};
  [...pick(0), ...pick(1)].forEach((p) => { out[p.name] = p; });
  return out;
}

// Freeze the final scoreboard and arm the post-game→casters cut. Called either almost immediately
// (no replay was in progress when MatchEnded fired) or from handleGoalReplayEnd() once the winning
// goal's replay actually finishes — NOT a fixed guess at how long that replay takes. Real RL replay
// durations vary widely (~5-20s+ depending on the play and highlight settings); anchoring to the
// actual replay-end event is both what was asked for and the only way the delay the producer
// configured means what they think it means (measured from when they can actually see the board).
function finalizePostGameBoard() {
  if (_pendingFinalizeFallbackTimer) { clearTimeout(_pendingFinalizeFallbackTimer); _pendingFinalizeFallbackTimer = null; }
  _pendingPostGameFinalize = false;
  _pendingFinalizeDirectTimer = null;   // clear in case called from the replay path while the direct timer still refs
  // If the kickoff already fired (RoundStarted / CountdownBegin arrived before this ran), skip:
  // we'd set view='scoreboard' mid-game and arm a stale caster-cut timer.
  if (!state.awaitingKickoff) {
    logAuto('rl-scene', 'Post-game board skipped — the next kickoff started before it could finalize.');
    return;
  }

  state.view = 'scoreboard';
  // Snapshot the final scoreboard so it survives the next match_created (which clears the live cache)
  // and so the overlay can re-render it from a full_state on reload/reconnect (not just the view_change).
  const roster = _pendingFinalizeRoster || scoreboardRoster();
  _pendingFinalizeRoster = null;
  state.scoreboard = {
    players: Object.values(roster).map(p => ({ ...p })),
    blueScore: state.game.blueScore ?? 0,
    orangeScore: state.game.orangeScore ?? 0,
    series: { ...state.series }
  };
  broadcast(bridgeClients, {
    type: 'view_change',
    data: { view: 'scoreboard', series: state.series, playerCache: roster }
  });
  obsSwitch('postGame');

  // Cancel any stray timer left over from a previous cycle before setting the new one.
  if (_postGameTimer) { clearTimeout(_postGameTimer); _postGameTimer = null; }
  // Opt-in RL post-game scene cut: after the board has been up for delaySec, cut OBS to the chosen
  // scene (e.g. caster desk). Only switches the OBS scene — the overlay scoreboard keeps holding
  // until returnToInGameForKickoff() fires at the next kickoff (which broadcasts game_reset and
  // clears the board). Cutting back to the RL overlay scene then shows the live HUD, not stale data.
  const pg = state.obs.postGame;
  if (pg && pg.enabled && pg.scene && pg.delaySec > 0) {
    broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: true, phase: 'postgame', message: `Post-game cut to "${pg.scene}" armed for ${pg.delaySec}s.` } });
    _postGameTimer = setTimeout(() => {
      _postGameTimer = null;
      // Fire only while we're genuinely in the POST-GAME window — i.e. still awaiting the next
      // kickoff. This is robust to the winning-goal REPLAY briefly flipping state.view to 'goal'
      // after the board shows (the old `view === 'scoreboard'` guard rejected that, so the cut
      // never fired — this is the "view was goal not scoreboard" skip). It still can't fire
      // mid-game: the timer is only armed post-game (finalize guards on awaitingKickoff) and
      // returnToInGameForKickoff() cancels it the instant the next game kicks off.
      if (state.awaitingKickoff) {
        const result = rlSwitchScene(pg.scene, 'post-game', pg.transition);
        broadcastRlSceneResult('postgame', pg.scene, result);
        if (result.ok) {
          // Set server state immediately so all guards (maybeReturnForKickoff, finalizePostGameBoard)
          // work correctly for the next game. Delay only the overlay broadcasts so the scoreboard
          // content stays visible on the overlay through the OBS transition (stinger/fade).
          state.view = 'hud';
          state.scoreboard = null;
          _boardLingerTimer = setTimeout(() => {
            _boardLingerTimer = null;
            broadcast(bridgeClients, { type: 'clear_scoreboard', data: {} });
            broadcastFullState();
          }, 2000);
        }
      } else {
        // The next game kicked off before the delay elapsed — returnToInGameForKickoff() normally
        // cancels this timer outright, so this is just a belt-and-suspenders report.
        broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', message: `Post-game cut to "${pg.scene}" skipped — the next game already kicked off.` } });
      }
    }, pg.delaySec * 1000);
  } else if (pg && pg.enabled && !pg.scene) {
    // Toggle is on but no scene chosen — that's silent misconfiguration; say so.
    broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', notify: true, message: 'Post-game cut is ON but no scene is selected — pick one in Match ▸ Teams gear.' } });
  }
}

// Why is an auto-prediction not firing right now? Returns a human reason, or null if all gates pass.
// Every gate here fails SILENTLY in the create/resolve paths, so this is the single source of truth
// producers can see (surfaced in the panel via state.twitch.predictions.lastAuto).
function autoPredSkipReason() {
  if (!state.twitch.predictions.settings.autoCreate) return 'Auto-create is OFF — enable it in Twitch → Predictions';
  if (!state.twitch.connected || _twitchTokenInvalid)  return 'Twitch not connected — reconnect on the Twitch tab (token may have expired)';
  if (!predictionManager)                              return 'Twitch prediction manager not ready — reconnect Twitch';
  return null;
}
// Record + broadcast the last auto-prediction outcome so the panel can show it (and it hits the log).
function setAutoPredStatus(kind, message) {
  console.log(`[AutoPred] ${kind}: ${message}`);
  try {
    state.twitch.predictions.lastAuto = { kind, message, ts: new Date().toISOString() };
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
  } catch (_) {}
}
// Classify a Twitch API error so the producer gets an actionable message (and we flip `connected`
// off on a 401 so the UI stops claiming a dead token is live).
function explainTwitchApiError(e) {
  const status = e && (e.status || e.statusCode || (e.response && e.response.status));
  if (status === 401) {
    _twitchTokenInvalid = true;
    state.twitch.connected = false;
    // Self-heal: with a refresh token stored this is recoverable with no reconnect at all —
    // kick a refresh now (it clears the flags on success) and tell the producer to just retry.
    if (state.twitch.refreshToken) {
      refreshTwitchToken().catch((err) => console.warn('[Twitch] auto-refresh after 401 failed:', err.message));
      return 'Twitch token expired (401) — auto-refreshing now, try again in a few seconds.';
    }
    return 'Twitch token expired (401) — reconnect Twitch. Implicit-grant tokens cannot auto-refresh.';
  }
  if (status === 403) return 'Twitch rejected it (403) — Channel Points Predictions require an Affiliate or Partner channel.';
  if (status === 429) return 'Twitch rate-limited it (429) — try again shortly.';
  return (e && e.message) || 'Unknown Twitch API error';
}

function handleMatchEnded(data) {
  setPerfActive(false);     // match over — restore previews/animations/priority
  resetOvertimeTrigger();   // game over — clear the OT latch so the next game can trigger its own
  state.awaitingKickoff = true;   // we're in post-game — return to the in-game overlay on the next kickoff (clock_started)
  // Stats: finalize this game before series scores are updated
  if (statsCurrentGameId) {
    const winner = state.game.blueScore > state.game.orangeScore ? 'a'
                 : state.game.orangeScore > state.game.blueScore ? 'b' : null;
    stats.endGame(statsCurrentGameId, {
      scoreA: state.game.blueScore,
      scoreB: state.game.orangeScore,
      winner,
      overtime: state.game.isOT
    });
    try { analytics.event('game_complete'); } catch (e) {}
    const rlPlayers = Object.values(state.playerCache).map(p => ({
      ...p, team: p.team === 'blue' ? 'a' : 'b'
    }));
    stats.saveRlPlayerStats(statsCurrentGameId, rlPlayers);
    statsCurrentGameId = null;
  }

  // Determine winner by score (more reliable than relying on potentially missing fields)
  const _scoreWinnerSide = state.game.blueScore > state.game.orangeScore ? 'blue'
                         : state.game.orangeScore > state.game.blueScore ? 'orange' : null;
  if (_scoreWinnerSide === 'blue') {
    state.series.blue++;
  } else if (_scoreWinnerSide === 'orange') {
    state.series.orange++;
  }
  // Auto-advance the current game to (games played + 1).
  state.game.number = Math.max(1, Math.min(state.bestOf, (state.series.blue || 0) + (state.series.orange || 0) + 1));

  // Auto-prediction: resolve by score immediately at game end
  if (_scoreWinnerSide && state.twitch.connected && predictionManager && state.twitch.predictions.settings.autoCreate) {
    const current = state.twitch.predictions.current;
    if (current && current.state !== 'RESOLVED' && current.state !== 'CANCELLED') {
      const winnerName = state.teams[_scoreWinnerSide]?.name || _scoreWinnerSide;
      const outcome = current.outcomes?.find(o =>
        o.title.toLowerCase().includes(winnerName.toLowerCase()) ||
        winnerName.toLowerCase().includes(o.title.toLowerCase())
      );
      if (outcome) {
        stopPredictionPolling();
        predictionManager.resolvePrediction(outcome.id, current.id)
          .then(result => {
            const resolvedId = current.id;
            const resolved = result
              ? normalizePrediction(result, 0)
              : { ...current, state: 'RESOLVED', winningOutcomeId: outcome.id };
            state.twitch.predictions.current = resolved;
            broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
            saveTwitchData();
            setAutoPredStatus('resolved', `Match end — resolved to winner "${winnerName}"`);
            setTimeout(() => {
              if (state.twitch.predictions.current?.id === resolvedId) {
                state.twitch.predictions.history.unshift(state.twitch.predictions.current);
                if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
                state.twitch.predictions.current = null;
                broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
                saveTwitchData();
              }
            }, 18000);
          })
          .catch(e => setAutoPredStatus('error', `Resolve failed — ${explainTwitchApiError(e)}`));
      } else {
        setAutoPredStatus('error', `Couldn't auto-resolve — no prediction outcome matched winner "${winnerName}". Use the panel to resolve manually.`);
      }
    }
  }

  // Emit flow triggers after series is updated
  flowBus.emit('rl_match_ended', { winner: _scoreWinnerSide });
  const _winsNeeded = Math.ceil(state.bestOf / 2);
  if (_scoreWinnerSide && state.series[_scoreWinnerSide] >= _winsNeeded) {
    flowBus.emit('series_ended', { winner: _scoreWinnerSide });
  }

  saveAppState();
  broadcastFullState();

  // Snapshot the roster NOW before handleMatchCreated can clear state.playerCache. The finalize
  // timer below fires 800ms later, by which time playerCache may already be empty.
  _pendingFinalizeRoster = scoreboardRoster();

  // Finalize once the winning-goal replay actually ends — not a fixed guess. If no replay is in
  // progress right now (MatchEnded arrived after ReplayEnd already fired, or there's no replay to
  // show), there's nothing to wait for, so finalize almost immediately (a short buffer for any
  // trailing stat updates to land, same as the old delay's intent — just far shorter, since we're
  // no longer trying to also outlast an in-progress replay with it).
  if (state.inReplay || state.view === 'goal') {
    _pendingPostGameFinalize = true;
    // Safety net: if the API never sends a clean replay-end for this particular replay, finalize
    // anyway after a generous ceiling so post-game→casters automation can't be stuck waiting forever.
    _pendingFinalizeFallbackTimer = setTimeout(() => {
      if (_pendingPostGameFinalize) {
        console.log('[RL] Winning-goal replay-end never arrived — finalizing post-game board via fallback timer.');
        finalizePostGameBoard();
      }
    }, 20000);
  } else {
    _pendingFinalizeDirectTimer = setTimeout(() => {
      _pendingFinalizeDirectTimer = null;
      finalizePostGameBoard();
    }, 800);
  }
}

// Normalize a raw Twitch API prediction result into our internal shape.
// The API uses 'status' (not 'state'), 'locks_at' (not 'endsAt'),
// and 'channel_points' / 'users' on outcomes (not 'votes').
function normalizePrediction(result, durationSeconds, fallbackOutcomes = []) {
  const rawStatus = result.status || result.state || 'ACTIVE';
  // EventSub uses "CANCELED"/"ARCHIVED"; internal/overlay code uses "CANCELLED"
  const statusMap = { ACTIVE: 'ACTIVE', LOCKED: 'LOCKED', RESOLVED: 'RESOLVED', CANCELED: 'CANCELLED', ARCHIVED: 'CANCELLED' };
  return {
    id:    result.id,
    title: result.title,
    state: statusMap[rawStatus] || rawStatus,
    outcomes: (result.outcomes || fallbackOutcomes.map((o, i) => ({
      id:    `fallback-${i}`,
      title: typeof o === 'string' ? o : o.title,
      votes: 0,
      users: 0
    }))).map(o => ({
      id:    o.id,
      title: o.title,
      votes: o.channel_points ?? o.votes ?? 0,
      users: o.users ?? 0
    })),
    endsAt:    result.locks_at || result.endsAt || new Date(Date.now() + (durationSeconds || 300) * 1000).toISOString(),
    createdAt: result.created_at || new Date().toISOString(),
    winningOutcomeId: result.winning_outcome_id || result.winningOutcomeId || null
  };
}

function normalizePoll(data) {
  const total = (data.choices || []).reduce((s, c) =>
    s + (c.votes || 0) + (c.bits_votes || 0) + (c.channel_points_votes || 0), 0);
  return {
    id:        data.id,
    title:     data.title,
    choices:   (data.choices || []).map(c => ({
      id:    c.id,
      title: c.title,
      votes: (c.votes || 0) + (c.bits_votes || 0) + (c.channel_points_votes || 0)
    })),
    total,
    status:    data.status || 'ACTIVE',
    startedAt: data.started_at,
    endsAt:    data.ends_at,
    endedAt:   data.ended_at || null
  };
}

function buildGameAnnouncement(game) {
  if (!game) return null;
  const secs = Math.round((game.duration || 30000) / 1000);
  switch (game.type) {
    case 'trivia':
      return `🎮 TRIVIA (${secs}s): "${game.question}" — Type A, B, C or D in chat!`;
    case 'vote':
      return `🎮 VOTE (${secs}s): "${game.question}" — ${(game.options || []).map((o, i) => `!vote ${i+1} = ${o.title}`).join(' | ')}`;
    case 'prediction':
      return `🎮 PREDICTION (${secs}s): "${game.question}" — ${(game.options || []).map((o, i) => `!predict ${i+1} = ${o.title}`).join(' | ')}`;
    case 'spin':
      return `🎮 RAFFLE (${secs}s): Type anything in chat to enter the spin!`;
    case 'number_guess':
      return `🎮 GUESS THE NUMBER (${secs}s): "${game.question}" — Type !guess [number] in chat!`;
    case 'fastest_finger':
      return `🎮 FASTEST FINGER: First to type "${game.keywordDisplay}" in chat wins! GO! ⚡`;
    case 'score_prediction':
      return `🎮 SCORE PREDICTION (${secs}s): "${game.question}" — Type !score [A]-[B] (e.g. !score 3-1) to predict!`;
    default:
      return null;
  }
}

function _logActivity(entry) {
  if (!state.twitch) return;
  if (!state.twitch.activityLog) state.twitch.activityLog = [];
  state.twitch.activityLog.push({ ...entry, timestamp: Date.now() });
  // Keep last 500 entries; don't broadcast full state (perf)
  if (state.twitch.activityLog.length > 500) state.twitch.activityLog.splice(0, state.twitch.activityLog.length - 500);
  // Feed the broadcast-analytics recorder (follow/subscribe/raid/bits counters).
  try { analytics.event(entry && entry.type, entry); } catch (e) {}
  broadcast(bridgeClients, { type: 'twitch_activity', data: entry });
}

function announceGameResult(result) {
  if (!chatManager?.isConnected || !result) return;
  let msg = '';
  if (result.type === 'trivia') {
    const correct = result.answers?.[result.correctAnswerIndex] || '?';
    const winners = result.winners || [];
    msg = winners.length > 0
      ? `🎮 Trivia over! Answer: "${correct}" | Winner${winners.length > 1 ? 's' : ''}: ${winners.slice(0, 3).map(w => '@' + w.username).join(', ')}`
      : `🎮 Trivia over! Answer was "${correct}" — nobody got it!`;
  } else if (result.type === 'prediction' || result.type === 'vote') {
    if (result.winner) {
      msg = `🎮 ${result.type === 'vote' ? 'Vote' : 'Prediction'} over! "${result.winner.title}" wins with ${result.winner.votes} vote${result.winner.votes !== 1 ? 's' : ''}!`;
    }
  } else if (result.type === 'spin') {
    msg = result.winner
      ? `🎮 Raffle spin over! Winner: @${result.winner.username} — congrats! 🎉`
      : '🎮 Raffle spin over! No entries this round.';
  } else if (result.type === 'number_guess') {
    const w = result.winner;
    msg = w
      ? `🎮 Number Guess over! The answer was ${result.targetNumber}. @${w.username} was closest (guessed ${w.guess})! 🏆`
      : `🎮 Number Guess over! The answer was ${result.targetNumber}. No guesses submitted.`;
  } else if (result.type === 'fastest_finger') {
    const w = result.winner;
    msg = w
      ? `⚡ Fastest Finger: @${w.username} typed "${result.keywordDisplay}" first! 🏆`
      : `⚡ Fastest Finger: Nobody typed "${result.keywordDisplay}" in time!`;
  } else if (result.type === 'score_prediction') {
    const score = result.actualScore ? `${result.actualScore[0]}-${result.actualScore[1]}` : '?-?';
    const w = result.winner;
    msg = w
      ? `🎮 Score Prediction: Final score was ${score}. @${w.username} predicted ${w.raw}! 🏆`
      : `🎮 Score Prediction over! Final score: ${score}. No predictions matched.`;
  }
  if (msg) chatManager.sendMessage(msg);
}

function stopPredictionPolling() {
  if (_predPollTimer) { clearInterval(_predPollTimer); _predPollTimer = null; }
}

function startPredictionPolling() {
  stopPredictionPolling();
  _predPollTimer = setInterval(async () => {
    const cur = state.twitch.predictions.current;
    if (!cur || !twitchClient || !state.twitch.channelId) { stopPredictionPolling(); return; }
    if (cur.state === 'RESOLVED' || cur.state === 'CANCELLED') { stopPredictionPolling(); return; }
    try {
      const result = await twitchClient.getPrediction(state.twitch.channelId, cur.id);
      if (!result) return;
      const normalized = normalizePrediction(result, 0);
      state.twitch.predictions.current = normalized;
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      if (normalized.state === 'RESOLVED' || normalized.state === 'CANCELLED') {
        stopPredictionPolling();
        setTimeout(() => {
          if (state.twitch.predictions.current?.id === normalized.id) {
            state.twitch.predictions.history.unshift(normalized);
            if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
            state.twitch.predictions.current = null;
            broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
            saveTwitchData();
          }
        }, 18000);
      }
    } catch (e) {
      console.warn('[PredPoll]', e.message);
    }
  }, 5000);
}

function handleMatchCreated(data) {
  // New game starts — reset game data, keep series. Do NOT cancel _postGameTimer here:
  // RL fires match_created almost immediately after game end, before the post-game delay
  // has elapsed. Do NOT cancel _postGameTimer here — let it run so OBS cuts to the caster
  // scene on schedule. If the kickoff fires first, state.view flips to 'hud' and the timer
  // guard prevents a stale mid-game switch.
  // If a game just finished, the post-game scoreboard is up — KEEP it through the wait / "choose
  // teams" and only swap to the in-game overlay at the next KICKOFF (returnToInGameForKickoff).
  const holdBoard = (state.view === 'scoreboard');
  state.game.blueScore   = 0;
  state.game.orangeScore = 0;
  state.game.time        = 300;
  state.game.isOT        = false;
  resetOvertimeTrigger();   // a fresh game can trigger its own overtime later
  state.awaitingKickoff = true;   // wait for THIS game's kickoff (clock_started) before showing the in-game overlay
  // Current game = games already played + 1 (idempotent with handleMatchEnded).
  state.game.number = Math.max(1, Math.min(state.bestOf, (state.series.blue || 0) + (state.series.orange || 0) + 1));
  state.players    = [];
  state.playerCache = {};
  state.inReplay   = false;
  state.currentGoal = null;
  _rlSpectatingActive = false;   // re-arm the "hide native UI on spectate" latch for this new lobby
  resetRlGameTrack();
  saveAppState();
  if (!holdBoard) {
    // first game / not on the board → go straight to the in-game overlay; reset the HUD now
    state.view = 'hud';
    broadcastFullState();
    broadcast(bridgeClients, { type: 'game_reset', data: { gameNumber: state.game.number } });
  }
  // else: leave state.view === 'scoreboard'; the board stays visible until the kickoff, when
  //       returnToInGameForKickoff() fires the game_reset + swaps the view/scene.

  // Auto-prediction: create "Who will win?" using the active team names
  const _apSkip = autoPredSkipReason();
  if (_apSkip) {
    setAutoPredStatus('skip', `Match start — no prediction opened: ${_apSkip}`);
  } else {
    const blueTeam   = (state.teams.blue.name   || 'Blue').slice(0, 25);
    const orangeTeam = (state.teams.orange.name || 'Orange').slice(0, 25);
    const title = state.twitch.predictions.settings.template === 'teams'
      ? `Game ${state.game.number}: Who will win?`
      : 'Who will win this game?';
    const durationSecs = Math.round((state.twitch.predictions.settings.cooldown || 300000) / 1000);

    const doCreate = () => {
      predictionManager.createPrediction(title, [blueTeam, orangeTeam], durationSecs)
        .then(result => {
          if (!result) return;
          state.twitch.predictions.current = normalizePrediction(result, durationSecs, [blueTeam, orangeTeam]);
          broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          saveTwitchData();
          // EventSub (channel.prediction.progress/lock/end) now delivers real-time updates.
          // Polling kept only as fallback in case EventSub disconnects mid-prediction.
          startPredictionPolling();
          setAutoPredStatus('created', `Opened "${title}" (${blueTeam} vs ${orangeTeam}) for ${durationSecs}s`);
          // Fallback: auto-cancel if still unresolved 60s after voting ends
          const msUntilEnd = durationSecs * 1000 + 60000;
          setTimeout(() => {
            const cur = state.twitch.predictions.current;
            if (cur && cur.id === result.id && cur.state !== 'RESOLVED') {
              console.warn('[AutoPred] Voting ended with no resolve — cancelling prediction', cur.id);
              stopPredictionPolling();
              predictionManager.cancelPrediction(cur.id)
                .then(() => {
                  state.twitch.predictions.current = null;
                  broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
                  saveTwitchData();
                })
                .catch(e => console.warn('[AutoPred] Fallback cancel failed:', e.message));
            }
          }, msUntilEnd);
        })
        .catch(e => setAutoPredStatus('error', `Create failed — ${explainTwitchApiError(e)}`));
    };

    // If there's a leftover active prediction from the previous game, cancel it first
    const prev = state.twitch.predictions.current;
    if (prev && prev.state !== 'RESOLVED' && prev.state !== 'CANCELLED') {
      console.log('[AutoPred] Cancelling leftover prediction before creating new one:', prev.id);
      stopPredictionPolling();
      predictionManager.cancelPrediction(prev.id)
        .then(() => {
          state.twitch.predictions.current = null;
          doCreate();
        })
        .catch(e => {
          console.warn('[AutoPred] Could not cancel old prediction:', e.message);
          state.twitch.predictions.current = null;
          doCreate();
        });
    } else {
      doCreate();
    }
  }

  // Auto Twitch chat announcement on match start
  if (chatManager?.isConnected && state.twitch.automations?.announceOnMatchStart) {
    const msg = state.twitch.automations.announceOnMatchStart
      .replace('{blue}', state.teams.blue.name || 'Blue')
      .replace('{orange}', state.teams.orange.name || 'Orange')
      .replace('{game}', state.activeGame || '');
    chatManager.sendMessage(msg);
  }

  // NOTE: do NOT switch OBS to the in-game scene here. A new match is created during the "choose
  // teams" phase — nobody needs to see the RL overlay yet. We bring up the in-game scene at the
  // KICKOFF (handleCountdownBegin), or the first live clock tick as a fallback. See awaitingKickoff.
  // The native-UI auto-hide, however, now fires as soon as the observer is spectating (first
  // UpdateState with players, handleUpdateState) so the pre-kickoff lobby wait isn't broadcast with
  // RL's UI showing; the kickoff re-hides since RL re-shows its UI when gameplay actually starts.

  // Stats: lazy-create a match record the first time a game starts in a series.
  // Link to the start.gg set being streamed (manual setId OR the auto-followed one) so the live
  // player stats land on the same record as the official result — see stats.startMatch reuse.
  if (!statsCurrentMatchId) {
    const link = currentStreamedSetLink();
    statsCurrentMatchId = stats.startMatch({
      gameType: 'rl',
      teamA: (link && link.teamA) || state.teams.blue.name,
      teamB: (link && link.teamB) || state.teams.orange.name,
      logoA: state.teams.blue.logo,
      logoB: state.teams.orange.logo,
      bestOf: state.bestOf,
      startggSetId: (link && link.setId) || null,
      tournament: (link && link.tournament) || state.startgg?.selectedEvent?.tournamentName || null
    });
  }
  statsCurrentGameId = stats.startGame({
    matchId: statsCurrentMatchId,
    gameNumber: state.game.number,
    gameType: 'rl'
  });
}

function scheduleRlHideNativeUi(gameNumber) {
  if (state.activeGame !== 'rocket-league') return;
  rlSpectatorUi.scheduleAutoHide(gameNumber, state.rlSpectatorUi, (result) => {
    broadcast(bridgeClients, {
      type: 'rl-ui-result',
      data: {
        ok: !!result.ok,
        message: result.ok
          ? `Sent ${state.rlSpectatorUi?.presses || 2}× "${state.rlSpectatorUi?.key || 'h'}" to Rocket League`
          : (result.reason || 'Failed to hide native UI'),
        auto: true
      }
    });
  });
}

async function triggerRlHideNativeUi() {
  const result = await rlSpectatorUi.runHideNativeUi(state.rlSpectatorUi);
  // Producer just hid the UI by hand — mark it hidden so a pending/retrying auto-hide press won't
  // fire the toggle again and bring the UI back up.
  if (result.ok) rlSpectatorUi.markHidden();
  broadcast(bridgeClients, {
    type: 'rl-ui-result',
    data: {
      ok: !!result.ok,
      message: result.ok
        ? `Sent ${state.rlSpectatorUi?.presses || 2}× "${state.rlSpectatorUi?.key || 'h'}" to Rocket League`
        : (result.reason || 'Failed — is Rocket League running?'),
      auto: false
    }
  });
  return result;
}

// ─── WS Bridge Server (port 3001) ────────────────────────────────────────────
function startBridgeServer() {
  // Loopback by default: every control message mutates producer state with no auth, so the
  // bridge must not be reachable from the LAN. Multi-PC setups (overlay sources on another
  // machine) can opt back in with WS_HOST=0.0.0.0 in .env.local — they accept the exposure.
  const wsHost = process.env.WS_HOST || '127.0.0.1';
  // Only enforce the token when the bridge is actually LAN-exposed (WS_HOST set to anything
  // but loopback). At least a dozen overlay scenes predate scene-base.js and open their own
  // raw WebSocket without fetching a token — gating on wsHost means the default single-PC
  // setup (the overwhelming common case) never breaks, including for any of those un-migrated
  // scenes or a future one that forgets to fetch it. The opt-in multi-PC case (WS_HOST=0.0.0.0)
  // is the one the audit actually flagged as unauthenticated-control-from-the-LAN — that's the
  // case this protects, and every current overlay + the control panel has been updated to send
  // the token so it keeps working there too.
  const enforceToken = wsHost !== '127.0.0.1' && wsHost !== 'localhost';
  bridgeWss = new WebSocket.Server({
    host: wsHost, port: WS_PORT,
    // Reject the handshake itself (before 'connection' fires) unless the caller has the
    // token handed out by GET /api/ws-token. Clients fetch the token once over HTTP (same
    // trust boundary as the rest of the API) and append it as ?token=…
    verifyClient: (info, cb) => {
      if (!enforceToken) return cb(true);
      let token = '';
      try { token = new URL(info.req.url, 'http://bridge').searchParams.get('token') || ''; } catch (e) {}
      if (token && token === wsAuthToken) return cb(true);
      cb(false, 401, 'Unauthorized');
    }
  });

  bridgeWss.on('connection', (ws) => {
    bridgeClients.add(ws);
    ws.isAlive = true;
    ws._role = 'unknown';   // set via a 'register' message: 'overlay' (browser source) | 'control' (panel)
    ws._page = '';          // overlay page path (e.g. /ticker.html) — drives the pre-flight "overlays reachable" check
    ws._imgvault = false;   // set true via 'imgvault_ready' — opt into compact @img: image refs
    ws.on('pong', () => { ws.isAlive = true; });
    // Send full state immediately on connect
    ws.send(JSON.stringify(getFullState()));
    if (_lastUpdateStatus) { try { ws.send(JSON.stringify({ type: 'update_status', data: _lastUpdateStatus })); } catch (e) {} }

    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }   // malformed frame — drop quietly
      const _role = currentCloudRole();
      if (msg && msg.type && !wsRoleAllows(msg.type, _role)) {
        try { ws.send(JSON.stringify({ type: 'perm-denied', data: { type: msg.type, role: _role } })); } catch (e) {}
        return;
      }
      try {
        handleControlMessage(msg, ws);
      } catch (e) {
        // A handler crash used to be indistinguishable from a malformed frame — both vanished
        // into one silent catch. Log the message type so broken controls leave a trail.
        console.error(`[bridge] handler crashed for '${msg && msg.type}':`, e && e.message);
      }
    });

    ws.on('close', () => { const was = ws._role; bridgeClients.delete(ws); if (was === 'overlay') maybeBroadcastOverlayCount(); });
    ws.on('error', () => { const was = ws._role; bridgeClients.delete(ws); if (was === 'overlay') maybeBroadcastOverlayCount(); });
  });

  // Heartbeat: ping every client; drop any that didn't pong since last round. This evicts
  // half-open/dead sockets so we don't keep "broadcasting" into the void (which looked like
  // the control panel freezing while overlays kept updating on their own live sockets).
  if (_bridgeHeartbeat) clearInterval(_bridgeHeartbeat);
  _bridgeHeartbeat = setInterval(() => {
    for (const ws of bridgeClients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} bridgeClients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    }
  }, 15000);

  console.log(`[Bridge] WS server on :${WS_PORT}`);
}

// ── WS handler registry ──────────────────────────────────────────────────────
// The incremental exit from the 296-case switch below: message types registered here
// dispatch directly (same (msg, ws) contract as the switch); everything else falls
// through to the legacy switch. Migrate cases group-by-group — veto_*/draft_* are the
// template: move the case body verbatim into registerWsHandlers({ type(msg, ws) {…} })
// and delete the case. Handler crashes are caught + logged by the ws.on('message') wrapper.
// ── Org-seat role enforcement ────────────────────────────────────────────────
// The cloud session's role comes from the producer's org SEAT (Licenses & Seats
// on the studio site). owner/admin/producer = full control. operator = full
// production but no credential/token mutations. talent/analyst = VIEW-ONLY (the
// app is their monitor + camera, not a control surface). Local sign-ins without
// a cloud session carry no role → never gated, so the local-first app can't be
// locked out by an outage.
const WS_VIEW_SAFE = new Set([
  'request_state', 'check_for_update', 'install_update', 'cloud_status'
]);
function wsRoleAllows(type, role) {
  if (!role || role === 'owner' || role === 'admin' || role === 'producer') return true;
  if (role === 'operator') return !/token|api_?key|secret|license/i.test(type);
  return WS_VIEW_SAFE.has(type);   // talent / analyst
}
function currentCloudRole() {
  try { const s = cloud.getSession(); return (s.authed && s.role) ? String(s.role) : null; } catch (_) { return null; }
}

const WS_HANDLERS = Object.create(null);
function registerWsHandlers(map) {
  for (const k of Object.keys(map)) {
    if (WS_HANDLERS[k]) console.warn(`[bridge] duplicate WS handler registered for '${k}' — the later one wins`);
    WS_HANDLERS[k] = map[k];
  }
}

// ── Map veto + champion draft handlers (first groups migrated out of the switch) ──
registerWsHandlers({
  set_veto(msg) {
    const v = msg.data || {};
    const cur = state.veto || {};
    const maps = Array.isArray(v.maps) ? v.maps.slice(0, 7).map((m) => ({
      name: (m.name || '').toString().slice(0, 40),
      mode: (m.mode || '').toString().slice(0, 40),
      image: (m.image || '').toString().slice(0, 2000),
      action: ['ban', 'pick', 'decider'].includes(m.action) ? m.action : '',
      by: ['a', 'b'].includes(m.by) ? m.by : '',
      winner: ['a', 'b'].includes(m.winner) ? m.winner : '',
      score: { a: Number(m.score?.a) || 0, b: Number(m.score?.b) || 0 }
    })) : cur.maps;
    state.veto = {
      visible: ('visible' in v) ? !!v.visible : !!cur.visible,
      title: typeof v.title === 'string' ? v.title : (cur.title ?? ''),
      maps
    };
    saveAppState();
    broadcastFullState();
  },
  // Guided multi-game map veto
  veto_start(msg, ws) {
    try {
      const d = msg.data || {};
      vetoStart({ game: d.game, bestOf: d.bestOf, teamStart: d.teamStart, title: d.title });
      if (typeof d.visible === 'boolean') state.veto.visible = d.visible;
      saveAppState(); broadcastFullState();
    } catch (e) {
      ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: false, message: e.message } }));
    }
  },
  veto_action(msg) {   // apply the current ban/pick step to a map
    vetoApply((msg.data && msg.data.mapId) || '');
    saveAppState(); broadcastFullState();
  },
  veto_undo()  { vetoUndo();  saveAppState(); broadcastFullState(); },
  veto_reset() { vetoReset(); saveAppState(); broadcastFullState(); },
  veto_result(msg) {   // record a played-map score/winner
    const d = msg.data || {};
    vetoResult(d.mapId, d.winner, d.score);
    saveAppState(); broadcastFullState();
  },
  veto_visible(msg) {
    if (state.veto) state.veto.visible = !!(msg.data && msg.data.visible);
    saveAppState(); broadcastFullState();
  },
  // Champion/hero draft
  draft_start(msg, ws) {
    try {
      const d = msg.data || {};
      draftStart({ game: d.game, teamStart: d.teamStart, title: d.title, subtitle: d.subtitle, owBanCount: d.owBanCount });
      if (typeof d.visible === 'boolean') state.draft.visible = d.visible;
      saveAppState(); broadcastFullState();
    } catch (e) {
      ws.send(JSON.stringify({ type: 'draft-result', data: { ok: false, message: e.message } }));
    }
  },
  // Live-edit the draft scene's title / subtext, and the which-team-starts preference — no restart.
  // (teamStart only re-shapes the order at the NEXT draft_start; stored here so the front UI owns it.)
  set_draft_meta(msg) {
    if (!state.draft) return;
    const d = msg.data || {};
    if (typeof d.title === 'string')    state.draft.title    = d.title.slice(0, 80);
    if (typeof d.subtitle === 'string') state.draft.subtitle = d.subtitle.slice(0, 120);
    if (d.teamStart === 'a' || d.teamStart === 'b') state.draft.teamStart = d.teamStart;
    // Overwatch ban-count preference — stored now, applied on the next draftStart (rebuilds the sequence).
    if (d.owBanCount != null) state.draft.owBanCount = Number(d.owBanCount) <= 2 ? 2 : 4;
    saveAppState(); broadcastFullState();
  },
  // Performance preferences (Settings ▸ Performance) — every knob is wired:
  // enabled (auto game mode), always (permanent lean), reduceAnimations,
  // pausePreviews (panel-side), broadcastRate (coalesce width).
  set_perf_mode(msg) {
    const pm = state.perfMode || (state.perfMode = { enabled: true, active: false });
    const d = msg.data || {};
    if ('enabled' in d) pm.enabled = !!d.enabled;
    if ('always' in d) pm.always = !!d.always;
    if ('reduceAnimations' in d) pm.reduceAnimations = !!d.reduceAnimations;
    if ('pausePreviews' in d) pm.pausePreviews = !!d.pausePreviews;
    if ('broadcastRate' in d && ['smooth', 'balanced', 'light'].includes(d.broadcastRate)) pm.broadcastRate = d.broadcastRate;
    if (pm.enabled === false && pm.active) pm.active = false;
    applyPerfSideEffects();
    saveAppState(); broadcastFullState();
  },
  // ── Event Ops (ESPORTS ▸ Event Ops): universal CSV table store + true-seed pull ──
  // Client-authoritative full replace, like set_leagues. The FULL spreadsheet is kept
  // (every header + every cell) so the panel can offer a sortable/filterable table of
  // ANY export; roleMap marks which columns mean team/player/email/challonge/flags
  // for the grouped-by-team view and the Challonge copy helpers.
  set_event_ops(msg) {
    const d = msg.data || {};
    const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
    const headers = (Array.isArray(d.headers) ? d.headers : []).slice(0, 80).map((h) => clean(h, 100));
    const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 3000)
      .map((r) => (Array.isArray(r) ? r.slice(0, Math.max(headers.length, 1)).map((c) => clean(c, 300)) : null))
      .filter((r) => r && r.some((c) => c));
    const rm = (d.roleMap && typeof d.roleMap === 'object') ? d.roleMap : {};
    const roleMap = {};
    ['team', 'team2', 'player', 'email', 'challonge', 'flags'].forEach((k) => {
      const n = Number(rm[k]);
      roleMap[k] = Number.isInteger(n) && n >= 0 && n < headers.length ? n : -1;
    });
    state.eventOps = {
      ...state.eventOps,
      headers, rows, roleMap,
      eventSlug: typeof d.eventSlug === 'string' ? d.eventSlug.trim().slice(0, 200) : (state.eventOps.eventSlug || ''),
      importedAt: rows.length ? Date.now() : 0
    };
    eventOpsVer++;
    saveAppState(); broadcastFullState();
  },
  eventops_fetch_seeds(msg, ws) {
    const reply = (ok, message, count) => {
      try { ws.send(JSON.stringify({ type: 'eventops-result', data: { ok, message, count: count || 0 } })); } catch (_) {}
    };
    // Accept a full start.gg URL or a bare event slug; fall back to the linked bracket/event.
    let slug = String((msg.data && msg.data.slug) || '').trim()
      .replace(/^https?:\/\/(www\.)?start\.gg\//i, '').replace(/\/+$/, '');
    if (!slug) slug = state.bracket.eventSlug || state.startgg.eventSlug || '';
    if (!slug) return reply(false, 'No start.gg event — paste an event slug/URL or link a bracket first.');
    (async () => {
      try {
        const seeds = await fetchEntrantSeedList(slug);
        state.eventOps = { ...state.eventOps, seeds, eventSlug: slug, seededAt: Date.now() };
        eventOpsVer++;
        saveAppState(); broadcastFullState();
        reply(true, `Pulled ${seeds.length} seeds from start.gg.`, seeds.length);
      } catch (e) {
        reply(false, (e && e.message) || 'Seed fetch failed.');
      }
    })();
  },
  draft_action(msg, ws) {
    try {
      draftAction((msg.data && msg.data.name) || '');
      saveAppState(); broadcastFullState();
    } catch (e) {
      ws.send(JSON.stringify({ type: 'draft-result', data: { ok: false, message: e.message } }));
    }
  },
  draft_undo()       { draftUndo();  saveAppState(); broadcastFullState(); },
  draft_reset()      { draftReset(); saveAppState(); broadcastFullState(); },
  draft_visible(msg) { if (state.draft) state.draft.visible = !!(msg.data && msg.data.visible); saveAppState(); broadcastFullState(); }
});

// ── Stream Credits (overlay/stream-credits.html) — plain visibility, Push Live like any other gfx.html scene ──
registerWsHandlers({
  // Single source of truth for the Stream Credits state (this registry entry shadows any switch-case
  // 'set_credits'). Every field is updated ONLY when present, so editing sponsors/talent/endText never
  // clobbers visibility (a bare set_credits used to force visible=false and drop the roll off-air).
  set_credits(msg) {
    const d = msg.data || {};
    if (!state.credits) state.credits = { visible: false, sponsors: [], talent: [], endText: '' };
    if (typeof d.visible === 'boolean') state.credits.visible = d.visible;
    if (typeof d.endText === 'string') state.credits.endText = d.endText.slice(0, 80);
    if (Array.isArray(d.talent)) {
      // Manual talent credits — crew from other shifts who still deserve the roll.
      state.credits.talent = d.talent.filter((t) => t && t.name).slice(0, 40).map((t) => ({
        name: (t.name || '').toString().slice(0, 60),
        role: (t.role || '').toString().slice(0, 60),
        group: ['casters', 'hosts', 'production', 'operations', 'observers'].includes(t.group) ? t.group : ''
      }));
    }
    if (Array.isArray(d.sponsors)) {
      state.credits.sponsors = d.sponsors.filter((s) => s && (s.name || s.logo)).slice(0, 40).map((s) => ({
        name: (s.name || '').toString().slice(0, 60),
        logo: (s.logo || '').toString().slice(0, 500000),
        tier: (s.tier || '').toString().slice(0, 40)
      }));
    }
    saveAppState(); broadcastFullState();
  }
});

// ── Overwatch 2 series scoreboard handlers ──
registerWsHandlers({
  ow_set_match(msg) {
    const d = msg.data || {};
    const cur = state.owMatch || {};
    state.owMatch = {
      visible: typeof d.visible === 'boolean' ? d.visible : !!cur.visible,
      format: ['FT2','FT3','FT4'].includes(d.format) ? d.format : (cur.format || 'FT3'),
      currentMapIdx: typeof d.currentMapIdx === 'number' ? d.currentMapIdx : (cur.currentMapIdx || 0),
      bansByMap: Array.isArray(d.bansByMap) ? d.bansByMap : (cur.bansByMap || [])
    };
    saveAppState(); broadcastFullState();
  },
  ow_visible(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
    state.owMatch.visible = !!(msg.data && msg.data.visible);
    saveAppState(); broadcastFullState();
  },
  ow_set_game_mode(msg) {
    const VALID_MODES = ['escort','hybrid','control','push','flashpoint','clash'];
    const mode = msg.data && msg.data.mode;
    if (VALID_MODES.includes(mode)) {
      if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
      state.owMatch.gameMode = mode;
      saveAppState(); broadcastFullState();
    }
  },
  ow_set_map_labels(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
    state.owMatch.showMapLabels = !!(msg.data && msg.data.show);
    saveAppState(); broadcastFullState();
  },
  ow_set_map_mode(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
    if (!Array.isArray(state.owMatch.mapModes)) state.owMatch.mapModes = [];
    const mmIdx = msg.data && typeof msg.data.mapIdx === 'number' ? msg.data.mapIdx : -1;
    const mmVal = msg.data && msg.data.mode;
    const VALID_MM = ['escort','hybrid','control','push','flashpoint','clash'];
    if (mmIdx >= 0 && mmIdx < 9 && VALID_MM.includes(mmVal)) {
      while (state.owMatch.mapModes.length <= mmIdx) state.owMatch.mapModes.push(null);
      state.owMatch.mapModes[mmIdx] = mmVal;
      saveAppState(); broadcastFullState();
    }
  },
  ow_set_map_winner(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
    if (!Array.isArray(state.owMatch.mapWinners)) state.owMatch.mapWinners = [];
    const mwIdx = msg.data && typeof msg.data.mapIdx === 'number' ? msg.data.mapIdx : -1;
    const mwVal = msg.data && msg.data.winner; // 'a' | 'b' | null
    if (mwIdx >= 0 && mwIdx < 9) {
      while (state.owMatch.mapWinners.length <= mwIdx) state.owMatch.mapWinners.push(null);
      state.owMatch.mapWinners[mwIdx] = mwVal || null;
      // Clearing a result also wipes the bans for that map so the ban display resets.
      if (!mwVal && Array.isArray(state.owMatch.bansByMap)) {
        state.owMatch.bansByMap[mwIdx] = {};
      }
      // Recount series from the full mapWinners array. reset_series clears mapWinners
      // so this is always a clean count relative to the current match.
      const winsA = state.owMatch.mapWinners.filter(w => w === 'a').length;
      const winsB = state.owMatch.mapWinners.filter(w => w === 'b').length;
      if (!state.series) state.series = {};
      state.series.blue   = winsA;
      state.series.orange = winsB;
      if (!state.game) state.game = {};
      state.game.number = Math.max(1, Math.min(state.bestOf || 5, winsA + winsB + 1));
      saveAppState(); broadcastFullState();
    }
  },
  ow_ban_hero(msg) {
    const d = msg.data || {};
    const cur = state.owMatch || {};
    const idx  = Number(d.mapIdx) || 0;
    const side = d.side === 'b' ? 'b' : 'a';
    const slot = d.slot === 1 ? 1 : 0;
    const bansByMap = [...(cur.bansByMap || [])];
    while (bansByMap.length <= idx) bansByMap.push({});
    const entry = { ...(bansByMap[idx] || {}) };
    // Normalise legacy single-object format → 2-element array
    const prev = entry[side];
    const arr = Array.isArray(prev) ? [...prev] : (prev && prev.hero ? [prev, { hero:'', role:'' }] : [{ hero:'', role:'' }, { hero:'', role:'' }]);
    while (arr.length < 2) arr.push({ hero:'', role:'' });
    arr[slot] = { hero: String(d.hero || ''), role: String(d.role || '') };
    entry[side] = arr;
    bansByMap[idx] = entry;
    state.owMatch = { ...cur, bansByMap };
    saveAppState(); broadcastFullState();
  },
  ow_set_map(msg) {
    const d = msg.data || {};
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [], attackSide: null };
    if (typeof d.currentMapIdx === 'number') state.owMatch.currentMapIdx = d.currentMapIdx;
    if (['FT2','FT3','FT4'].includes(d.format)) state.owMatch.format = d.format;
    saveAppState(); broadcastFullState();
  },
  ow_set_attack(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [], attackSide: null, showAttack: false };
    const side = (msg.data && msg.data.side) || null;
    state.owMatch.attackSide = ['a','b'].includes(side) ? side : null;
    saveAppState(); broadcastFullState();
  },
  ow_show_attack(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [], attackSide: null, showAttack: false };
    state.owMatch.showAttack = !!(msg.data && msg.data.visible);
    saveAppState(); broadcastFullState();
  }
});

// ── Marvel Rivals series scoreboard handlers ──
registerWsHandlers({
  mr_set_match(msg) {
    const d = msg.data || {};
    const cur = state.mrMatch || {};
    state.mrMatch = {
      visible: typeof d.visible === 'boolean' ? d.visible : !!cur.visible,
      format: typeof d.format === 'string' ? d.format : (cur.format || 'BO5'),
      bansByMap: Array.isArray(d.bansByMap) ? d.bansByMap : (cur.bansByMap || []),
      gameMode: typeof d.gameMode === 'string' ? d.gameMode : (cur.gameMode || 'convergence'),
      showMapLabels: typeof d.showMapLabels === 'boolean' ? d.showMapLabels : (cur.showMapLabels !== false),
      mapWinners: Array.isArray(d.mapWinners) ? d.mapWinners : (cur.mapWinners || []),
      mapModes: Array.isArray(d.mapModes) ? d.mapModes : (cur.mapModes || []),
      gepData: cur.gepData || null
    };
    saveAppState(); broadcastFullState();
  },
  mr_visible(msg) {
    if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    state.mrMatch.visible = !!(msg.data && msg.data.visible);
    saveAppState(); broadcastFullState();
  },
  mr_set_game_mode(msg) {
    const MR_VALID_MODES = ['convergence','domination','convoy'];
    const mrMode = msg.data && msg.data.mode;
    if (MR_VALID_MODES.includes(mrMode)) {
      if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
      state.mrMatch.gameMode = mrMode;
      saveAppState(); broadcastFullState();
    }
  },
  mr_set_map_labels(msg) {
    if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    state.mrMatch.showMapLabels = !!(msg.data && msg.data.show);
    saveAppState(); broadcastFullState();
  },
  mr_set_map_mode(msg) {
    if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    if (!Array.isArray(state.mrMatch.mapModes)) state.mrMatch.mapModes = [];
    const mrMmIdx = msg.data && typeof msg.data.mapIdx === 'number' ? msg.data.mapIdx : -1;
    const mrMmVal = msg.data && msg.data.mode;
    const MR_VALID_MM = ['convergence','domination','convoy'];
    if (mrMmIdx >= 0 && mrMmIdx < 9 && MR_VALID_MM.includes(mrMmVal)) {
      while (state.mrMatch.mapModes.length <= mrMmIdx) state.mrMatch.mapModes.push(null);
      state.mrMatch.mapModes[mrMmIdx] = mrMmVal;
      saveAppState(); broadcastFullState();
    }
  },
  mr_set_map_winner(msg) {
    if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    if (!Array.isArray(state.mrMatch.mapWinners)) state.mrMatch.mapWinners = [];
    const mrMwIdx = msg.data && typeof msg.data.mapIdx === 'number' ? msg.data.mapIdx : -1;
    const mrMwVal = msg.data && msg.data.winner;
    if (mrMwIdx >= 0 && mrMwIdx < 9) {
      while (state.mrMatch.mapWinners.length <= mrMwIdx) state.mrMatch.mapWinners.push(null);
      state.mrMatch.mapWinners[mrMwIdx] = mrMwVal || null;
      if (!mrMwVal && Array.isArray(state.mrMatch.bansByMap)) {
        state.mrMatch.bansByMap[mrMwIdx] = {};
      }
      const mrWinsA = state.mrMatch.mapWinners.filter(function(w) { return w === 'a'; }).length;
      const mrWinsB = state.mrMatch.mapWinners.filter(function(w) { return w === 'b'; }).length;
      if (!state.series) state.series = {};
      state.series.blue   = mrWinsA;
      state.series.orange = mrWinsB;
      if (!state.game) state.game = {};
      state.game.number = Math.max(1, Math.min(state.bestOf || 5, mrWinsA + mrWinsB + 1));
      saveAppState(); broadcastFullState();
    }
  },
  mr_ban_hero(msg) {
    const d = msg.data || {};
    const cur = state.mrMatch || {};
    const idx  = Number(d.mapIdx) || 0;
    const side = d.side === 'b' ? 'b' : 'a';
    const slot = Math.min(3, Math.max(0, Number(d.slot) || 0));
    const bansByMap = [...(cur.bansByMap || [])];
    while (bansByMap.length <= idx) bansByMap.push({});
    const entry = { ...(bansByMap[idx] || {}) };
    const prev = entry[side];
    const arr = Array.isArray(prev) ? [...prev] : [{ hero:'', role:'' },{ hero:'', role:'' },{ hero:'', role:'' },{ hero:'', role:'' }];
    while (arr.length < 4) arr.push({ hero:'', role:'' });
    arr[slot] = { hero: String(d.hero || ''), role: String(d.role || '') };
    entry[side] = arr;
    bansByMap[idx] = entry;
    state.mrMatch = { ...cur, bansByMap };
    saveAppState(); broadcastFullState();
  }
});

// ── Simple graphics setters (winner screen + team-lineup/intro card) ──
registerWsHandlers({
  set_winner(msg) {
    const w = msg.data || {};
    const cur = state.winner || {};
    state.winner = {
      visible: ('visible' in w) ? !!w.visible : !!cur.visible,
      side: ('side' in w) ? (w.side || '') : (cur.side ?? ''),
      name: typeof w.name === 'string' ? w.name : (cur.name ?? ''),
      logo: ('logo' in w) ? (w.logo || null) : (cur.logo ?? null),
      color: ('color' in w) ? (w.color || '') : (cur.color ?? ''),
      subtitle: typeof w.subtitle === 'string' ? w.subtitle : (cur.subtitle ?? '')
    };
    saveAppState();
    broadcastFullState();

    // Auto-prediction: resolve with the winning team's outcome
    if (state.twitch.connected && predictionManager && state.twitch.predictions.settings.autoCreate) {
      const winnerName = state.winner.name || (state.winner.side === 'blue' ? state.teams.blue.name : state.teams.orange.name);
      const current = state.twitch.predictions.current;
      // Skip if already resolved by score in handleMatchEnded
      if (current && current.state !== 'RESOLVED' && current.state !== 'CANCELLED' && winnerName) {
        const outcome = current.outcomes?.find(o =>
          o.title.toLowerCase().includes(winnerName.toLowerCase()) ||
          winnerName.toLowerCase().includes(o.title.toLowerCase())
        );
        if (outcome) {
          stopPredictionPolling();
          predictionManager.resolvePrediction(outcome.id, current.id)
            .then(result => {
              const resolvedId = current.id;
              const resolved = result
                ? normalizePrediction(result, 0)
                : { ...current, state: 'RESOLVED', winningOutcomeId: outcome.id };
              state.twitch.predictions.current = resolved;
              broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
              saveTwitchData();
              console.log('[AutoPred] Resolved with winner:', winnerName);
              setTimeout(() => {
                if (state.twitch.predictions.current?.id === resolvedId) {
                  state.twitch.predictions.history.unshift(state.twitch.predictions.current);
                  if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
                  state.twitch.predictions.current = null;
                  broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
                  saveTwitchData();
                }
              }, 18000);
            })
            .catch(e => console.warn('[AutoPred] Resolve failed:', e.message));
        } else {
          console.warn('[AutoPred] No matching outcome for winner:', winnerName, '— outcomes:', current.outcomes?.map(o => o.title));
        }
      }
    }
  },
  set_intro(msg) {
    const i = msg.data || {};
    const cur = state.intro || {};
    state.intro = {
      visible: ('visible' in i) ? !!i.visible : !!cur.visible,
      side: (i.side === 'orange' || i.side === 'blue') ? i.side : (cur.side ?? 'blue'),
      title: typeof i.title === 'string' ? i.title : (cur.title ?? ''),
      style: [1, 2].includes(Number(i.style)) ? Number(i.style) : (cur.style ?? 1),
      showFooter: ('showFooter' in i) ? !!i.showFooter : (cur.showFooter ?? false),
      showRealName: ('showRealName' in i) ? !!i.showRealName : (cur.showRealName ?? false)
    };
    saveAppState();
    broadcastFullState();
  }
});

// ── Sponsor / announcement ticker ──
registerWsHandlers({
  set_ticker(msg) {
    const p = msg.data || {};
    if (typeof p.visible === 'boolean') state.ticker.visible = p.visible;
    if (typeof p.source === 'string') state.ticker.source = (p.source === 'startgg') ? 'startgg' : 'manual';
    if (typeof p.sponsor === 'string') state.ticker.sponsor = p.sponsor.slice(0, 400000);   // small logo (downscaled client-side)
    if (Array.isArray(p.messages)) {
      state.ticker.messages = p.messages
        .map((m) => (m || '').toString().trim())
        .filter(Boolean)
        .slice(0, 30);
    }
    if (Number(p.speed) > 0) state.ticker.speed = Math.min(600, Math.max(3, Number(p.speed)));
    if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);   // build now; refreshes each poll
    saveAppState();
    broadcastFullState();
  }
});

// ── Upcoming-matches + standings overlays ──
registerWsHandlers({
  set_upcoming(msg) {
    const p = msg.data || {};
    if (typeof p.visible === 'boolean') state.upcoming.visible = p.visible;
    if (typeof p.title === 'string') state.upcoming.title = p.title;
    if (typeof p.eyebrow === 'string') state.upcoming.eyebrow = p.eyebrow;
    if (['cards', 'board', 'single', 'dual'].includes(p.layout)) state.upcoming.layout = p.layout;
    if (typeof p.showResults === 'boolean') state.upcoming.showResults = p.showResults;
    if (Array.isArray(p.matches)) state.upcoming.matches = p.matches;
    saveAppState();
    broadcastFullState();
  },
  set_standings(msg) {
    const p = msg.data || {};
    if (typeof p.visible === 'boolean') state.standings.visible = p.visible;
    if (typeof p.title === 'string') state.standings.title = p.title;
    if (typeof p.subtitle === 'string') state.standings.subtitle = p.subtitle;
    if (typeof p.showRecord === 'boolean') state.standings.showRecord = p.showRecord;
    if (typeof p.source === 'string') state.standings.source = p.source;
    if (Array.isArray(p.rows)) state.standings.rows = p.rows;
    saveAppState();
    broadcastFullState();
  }
});

// ── Teams to Watch (watchlist) + single-team spotlight ──
registerWsHandlers({
  set_watchlist(msg) {
    const p = msg.data || {};
    const w = state.watchlist;
    if (typeof p.visible === 'boolean') w.visible = p.visible;
    if (typeof p.title === 'string') w.title = p.title.slice(0, 80);
    if (typeof p.subtitle === 'string') w.subtitle = p.subtitle.slice(0, 120);
    if (typeof p.logo === 'string') w.logo = p.logo.slice(0, 600000);
    if (Array.isArray(p.fields)) w.fields = p.fields.slice(0, 6).map((f) => ({
      id: (f.id || ('f' + Math.random().toString(36).slice(2, 7))).toString().slice(0, 24),
      label: (f.label || 'FIELD').toString().slice(0, 40)
    }));
    if (Array.isArray(p.teams)) w.teams = p.teams.slice(0, 12).map((t) => ({
      id: (t.id || ('t' + Math.random().toString(36).slice(2, 9))).toString().slice(0, 24),
      name: (t.name || '').toString().slice(0, 80),
      players: Array.isArray(t.players) ? t.players.slice(0, 8).map((x) => (x || '').toString().slice(0, 60)) : [],
      values: (t.values && typeof t.values === 'object') ? Object.fromEntries(Object.entries(t.values).slice(0, 6).map(([k, v]) => [k.toString().slice(0, 24), (v || '').toString().slice(0, 40)])) : {},
      pos: Math.max(0, Math.min(12, Number(t.pos) || 0)),   // 0 = unranked; 1 = podium centre
      entrantId: (t.entrantId || '').toString().slice(0, 24),
      eventSlug: (t.eventSlug || '').toString().slice(0, 200)
    }));
    saveAppState();
    broadcastFullState();
  },
  // Mark / unmark one team (the ★ on event team cards) — toggles by name, preserving values.
  toggle_watchlist_team(msg) {
    const t = (msg.data && msg.data.team) || {};
    const name = (t.name || '').toString().trim();
    if (!name) return;
    const w = state.watchlist;
    if (!Array.isArray(w.teams)) w.teams = [];
    const i = w.teams.findIndex((x) => (x.name || '').toLowerCase() === name.toLowerCase());
    if (i >= 0) w.teams.splice(i, 1);
    else if (w.teams.length < 12) {
      w.teams.push({
        id: 't' + Math.random().toString(36).slice(2, 9),
        name: name.slice(0, 80),
        players: Array.isArray(t.players) ? t.players.slice(0, 8).map((x) => (x || '').toString().slice(0, 60)) : [],
        values: {}, pos: 0,
        entrantId: (t.entrantId || '').toString().slice(0, 24),   // for the single-team start.gg deep-dive
        eventSlug: (t.eventSlug || '').toString().slice(0, 200)
      });
      // Auto-fill the subtitle with the start.gg event name on the first marked team (overridable).
      const evName = (msg.data && msg.data.event || '').toString().trim();
      if (evName && !w.subtitle) w.subtitle = evName.slice(0, 120);
    }
    saveAppState();
    broadcastFullState();
  },
  // Single-team spotlight — target a team + (optionally) go live; start.gg data fetched async.
  set_team_spotlight(msg) {
    const p = msg.data || {};
    const ts = state.teamSpotlight;
    let retarget = false;
    if (typeof p.name === 'string') { if (p.name !== ts.name) retarget = true; ts.name = p.name.slice(0, 80); }
    if (typeof p.eventSlug === 'string') ts.eventSlug = p.eventSlug.slice(0, 200);
    if (typeof p.entrantId === 'string') { if (p.entrantId !== ts.entrantId) retarget = true; ts.entrantId = p.entrantId.slice(0, 24); }
    if (Array.isArray(p.players)) ts.players = p.players.slice(0, 8).map((x) => ({ gamerTag: ((x && x.gamerTag) || x || '').toString().slice(0, 60), name: '', seedRank: '' }));
    if (typeof p.visible === 'boolean') ts.visible = p.visible;
    if (retarget) { ts.sg = { seed: null, placement: null, record: { w: 0, l: 0 }, recent: [], next: null }; ts.lastSync = 0; ts.syncError = ''; }
    enrichSpotlightSeeding();
    saveAppState();
    broadcastFullState();
    if (p.fetch !== false && ts.entrantId) refreshTeamSpotlight().catch(() => {});
  }
});

function handleControlMessage(msg, ws) {
  const h = WS_HANDLERS[msg.type];
  if (h) return void h(msg, ws);
  switch (msg.type) {
    // App-level heartbeat: lets a client confirm its receive direction is alive (half-open detection).
    case 'ping':
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
      break;

    // Auto-update controls → forwarded to electron-updater in main.js.
    case 'check_for_update':  if (_updateHandlers && _updateHandlers.check)    _updateHandlers.check();    break;
    case 'download_update':   if (_updateHandlers && _updateHandlers.download) _updateHandlers.download(); break;
    case 'install_update':    if (_updateHandlers && _updateHandlers.install)  _updateHandlers.install();  break;

    case 'set_event_name':
      state.eventName = msg.data.name || '';
      saveAppState();
      broadcastFullState();
      break;

    case 'save_scene_preset': {
      const { scene: _sp_scene, name: _sp_name, config: _sp_cfg } = msg.data || {};
      if (!_sp_scene || !_sp_name || _sp_name === 'Default') break;
      if (!state.scenePresets[_sp_scene]) state.scenePresets[_sp_scene] = { active: 'Default', presets: {} };
      state.scenePresets[_sp_scene].presets[_sp_name] = { label: _sp_name, config: _sp_cfg || {} };
      state.scenePresets[_sp_scene].active = _sp_name;
      if (_sp_name !== '__preview__') saveAppState();
      broadcastFullState();
      break;
    }
    case 'delete_scene_preset': {
      const { scene: _dp_scene, name: _dp_name } = msg.data || {};
      if (!_dp_scene || !_dp_name || _dp_name === 'Default') break;
      const _dp_sp = state.scenePresets[_dp_scene];
      if (_dp_sp) {
        delete _dp_sp.presets[_dp_name];
        if (_dp_sp.active === _dp_name) _dp_sp.active = 'Default';
      }
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'activate_scene_preset': {
      const { scene: _ap_scene, name: _ap_name } = msg.data || {};
      if (!_ap_scene || !_ap_name) break;
      if (!state.scenePresets[_ap_scene]) state.scenePresets[_ap_scene] = { active: _ap_name, presets: {} };
      else state.scenePresets[_ap_scene].active = _ap_name;
      saveAppState();
      broadcastFullState();
      break;
    }

    // Custom "GAME x | BEST OF x" label override (e.g. "UPCOMING MATCH" or any custom text).
    // Empty string restores the automatic GAME/BEST-OF text.
    case 'set_game_label':
      state.gameLabel = (typeof msg.data.text === 'string') ? msg.data.text : '';
      saveAppState();
      broadcastFullState();
      break;

    case 'set_round_label':
      state.roundLabel = (typeof msg.data.text === 'string') ? msg.data.text : '';
      saveAppState();
      broadcastFullState();
      break;

    case 'set_speed_unit':
      state.speedUnit = (msg.data && msg.data.unit === 'kmh') ? 'kmh' : 'mph';
      saveAppState();
      broadcastFullState();
      break;

    case 'set_date_format':
      state.dateFormat = (msg.data && msg.data.format === 'intl') ? 'intl' : 'us';
      saveAppState();
      broadcastFullState();
      break;

    case 'set_team_record_settings': {
      const d = msg.data || {};
      if (typeof d.enabled === 'boolean') state.teamRecord.enabled = d.enabled;
      if (typeof d.metric === 'string') {
        const allowed = ['season', 'week', 'pts', 'place', 'record-pts'];
        if (allowed.includes(d.metric)) state.teamRecord.metric = d.metric;
      }
      if (typeof d.source === 'string' && ['stats', 'startgg', 'manual'].includes(d.source)) state.teamRecord.source = d.source;
      if ('leagueId' in d) state.teamRecord.leagueId = (d.leagueId == null ? '' : String(d.leagueId));
      if ('week' in d) state.teamRecord.week = (d.week == null ? '' : String(d.week));
      saveAppState();
      broadcastFullState();
      break;
    }

    // Per-team manual record (W-L, optional pts/place) edited in the team boxes. Stored keyed by the
    // team NAME currently on that side, so the record is tied to the team profile — it follows the
    // team across side swaps and reassignments instead of staying pinned to Blue/Orange.
    case 'set_team_record_manual': {
      const d = msg.data || {};
      const side = d.side === 'orange' ? 'orange' : (d.side === 'blue' ? 'blue' : null);
      if (!side) break;
      const key = ((state.teams[side] && state.teams[side].name) || '').trim().toLowerCase();
      if (!key) break;   // no team on that side — nothing to key the record to
      if (!state.teamRecord.manualByName) state.teamRecord.manualByName = {};
      const m = { ...(state.teamRecord.manualByName[key] || {}) };
      ['w', 'l', 'pts', 'place'].forEach((k) => {
        if (k in d) { const v = d[k]; m[k] = (v === '' || v == null) ? (k === 'w' || k === 'l' ? 0 : null) : Math.max(0, parseInt(v, 10) || 0); }
      });
      state.teamRecord.manualByName[key] = m;
      saveAppState();
      broadcastFullState();
      break;
    }

    // Edit a team's standing directly in an in-app league (from the Match — Teams box when
    // Team Record source = In-app). Writes back to the league standings so it updates there too.
    case 'set_league_team_record': {
      const d = msg.data || {};
      const lg = (state.leagues || []).find((l) => String(l.id) === String(d.leagueId));
      if (!lg) break;
      const key = String(d.teamName || '').trim().toLowerCase();
      const team = (lg.teams || []).find((t) => String(t.teamName || t.name || '').trim().toLowerCase() === key);
      if (!team) break;
      if (!Array.isArray(lg.standings)) lg.standings = [];
      let st = lg.standings.find((s) => s.teamId === team.id);
      if (!st) { st = { teamId: team.id, w: 0, l: 0, pts: 0 }; lg.standings.push(st); }
      ['w', 'l', 'pts'].forEach((k) => { if (k in d && d[k] !== '' && d[k] != null) st[k] = Math.max(0, parseInt(d[k], 10) || 0); });
      leaguesVer++;
      saveAppState();
      broadcastFullState();
      break;
    }

    // Toggle: match live-game team names to the saved-teams library (apply logo/colour).
    case 'set_auto_teams_from_game': {
      state.autoTeamsFromGame = !!(msg.data && msg.data.enabled);
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'use_startgg_round': {
      // Pull the bracket round (e.g. "Winners Finals") from the active start.gg set, falling back to
      // whichever set is currently live in the queue/match feed.
      const sg = state.startgg || {};
      const id = sg.setId || sg.lastPushedSetId || '';
      let round = '';
      if (id) {
        const m = (sg.queue || []).find(x => x.setId === id) || (sg.matchFeed || []).find(x => x.setId === id);
        if (m && m.round) round = m.round;
      }
      if (!round) {
        const live = (sg.queue || []).find(x => x.live) || (sg.matchFeed || []).find(x => x.live || x.status === 'in-progress');
        if (live && live.round) round = live.round;
      }
      state.roundLabel = (round || '').toString().toUpperCase();
      saveAppState();
      broadcastFullState();
      break;
    }

    // Overtime ad slot (sellable sponsor slot shown during OT). Partial updates merge.
    case 'set_overtime': {
      const o = msg.data || {};
      const cur = state.overtime || {};
      state.overtime = {
        label: typeof o.label === 'string' ? o.label : (cur.label ?? 'OVERTIME'),
        logo: ('logo' in o) ? (o.logo || null) : (cur.logo ?? null),
        bg: o.bg || cur.bg || '#e0202a',
        color: o.color || cur.color || '#ffffff'
      };
      saveAppState();
      broadcastFullState();
      break;
    }

    // Replay ad slot (sponsor logo in the REPLAY transition + replay tag). Partial updates merge.
    case 'set_replay': {
      const o = msg.data || {};
      const cur = state.replay || {};
      state.replay = {
        label: typeof o.label === 'string' ? o.label : (cur.label ?? 'REPLAY'),
        logo: ('logo' in o) ? (o.logo || null) : (cur.logo ?? null),
        outroLogo: ('outroLogo' in o) ? (o.outroLogo || null) : (cur.outroLogo ?? null),
        colorMode: ['mono', 'team', 'brand'].includes(o.colorMode) ? o.colorMode : (cur.colorMode || 'team'),
        skin: ('skin' in o) ? (o.skin || null) : (cur.skin ?? null)
      };
      saveAppState();
      broadcastFullState();
      break;
    }

    // Scoreboard ad slot (sponsor logo on the end-of-match scorecard). Partial updates merge.
    case 'set_scoreboard_ad': {
      const o = msg.data || {};
      const cur = state.scoreboardAd || {};
      state.scoreboardAd = {
        label: typeof o.label === 'string' ? o.label : (cur.label ?? 'PRESENTED BY'),
        logo: ('logo' in o) ? (o.logo || null) : (cur.logo ?? null),
        background: ('background' in o) ? (o.background || null) : (cur.background ?? null)
      };
      saveAppState();
      broadcastFullState();
      break;
    }

    // Desk footer manual override: a list of logos that replace the brand's desk sponsors on
    // the caster-desk scenes. Empty list → fall back to the active brand's desk-tagged sponsors.
    case 'set_desk_footer': {
      const o = msg.data || {};
      if (Array.isArray(o.logos)) {
        state.deskFooter = { logos: o.logos.filter((l) => typeof l === 'string' && l).slice(0, 8) };
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    // ── Desk Show (preshow.html) — discussion-topics rail + headline ───
    // ── Desk Show topic presets — named rundowns (pre-show / halftime / post-show…) ──
    case 'save_preshow_preset': {
      const name = (msg.data?.name || '').toString().trim().slice(0, 40);
      if (!name) break;
      if (!Array.isArray(state.preshowPresets)) state.preshowPresets = [];
      const entry = {
        id: Math.random().toString(36).slice(2, 11),
        name,
        headline: (state.preshow && state.preshow.headline) || '',
        topics: JSON.parse(JSON.stringify((state.preshow && state.preshow.topics) || []))
      };
      const idx = state.preshowPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
      if (idx >= 0) { entry.id = state.preshowPresets[idx].id; state.preshowPresets[idx] = entry; }
      else state.preshowPresets.push(entry);
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'apply_preshow_preset': {
      const preset = (state.preshowPresets || []).find((p) => p.id === msg.data?.id);
      if (!preset) break;
      state.preshow.headline = preset.headline || '';
      state.preshow.topics = JSON.parse(JSON.stringify(preset.topics || []));
      state.preshow.activeTopicIndex = 0;
      // Same rule as set_preshow: topics are brand content — persist onto the active package
      // so kit/package switches bring this rundown back.
      const kit = savedBrandKits.find((b) => b.id === state.activeBrandKitId);
      const pkg = kit ? activePackage(kit) : null;
      if (kit && pkg) { pkg.topicsHeadline = state.preshow.headline; pkg.topics = state.preshow.topics; saveBrandKits(); }
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'delete_preshow_preset': {
      if (Array.isArray(state.preshowPresets)) {
        state.preshowPresets = state.preshowPresets.filter((p) => p.id !== msg.data?.id);
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'set_preshow': {
      const p = msg.data || {};
      const cur = state.preshow || {};
      const topics = Array.isArray(p.topics)
        ? p.topics.filter((t) => t && typeof t === 'object').map((t) => ({
            text: typeof t.text === 'string' ? t.text.slice(0, 60) : '',
            sceneName: typeof t.sceneName === 'string' ? t.sceneName.slice(0, 100) : ''
          })).slice(0, 12)
        : cur.topics;
      const headline = typeof p.headline === 'string' ? p.headline.slice(0, 140) : (cur.headline ?? '');
      const predictions = Array.isArray(p.predictions)
        ? [0, 1].map((i) => (['blue', 'orange'].includes(p.predictions[i]) ? p.predictions[i] : ''))
        : (Array.isArray(cur.predictions) ? cur.predictions : ['', '']);
      state.preshow = {
        headline, topics,
        activeTopicIndex: ('activeTopicIndex' in p) ? Math.max(0, parseInt(p.activeTopicIndex, 10) || 0) : (cur.activeTopicIndex ?? 0),
        homeScene: typeof p.homeScene === 'string' ? p.homeScene.slice(0, 100) : (cur.homeScene ?? ''),
        predictions
      };
      // Headline/topics are brand content — persist onto the active package too, so switching
      // packages (or kits) brings the right Desk Show topics back automatically.
      if (typeof p.headline === 'string' || Array.isArray(p.topics)) {
        const kit = savedBrandKits.find((b) => b.id === state.activeBrandKitId);
        const pkg = kit ? activePackage(kit) : null;
        if (kit && pkg) {
          pkg.topicsHeadline = headline;
          pkg.topics = topics;
          saveBrandKits();
        }
      }
      saveAppState();
      broadcastFullState();
      break;
    }

    // ── Break / "starting soon" standby (countdown scene) ────────────────
    // Partial updates merge. endsAt = epoch ms target (or null to clear the timer).
    case 'set_break': {
      const b = msg.data || {};
      const cur = state.breakScreen || {};
      state.breakScreen = {
        visible: ('visible' in b) ? !!b.visible : !!cur.visible,
        title: typeof b.title === 'string' ? b.title : (cur.title ?? 'STARTING SOON'),
        message: typeof b.message === 'string' ? b.message : (cur.message ?? ''),
        finalMessage: typeof b.finalMessage === 'string' ? b.finalMessage : (cur.finalMessage ?? "WE'RE LIVE!"),
        // accept either an absolute endsAt, a `seconds` countdown from now, or a
        // `frozenSeconds` static value (paused producer timer). Running clears frozen.
        endsAt: ('frozenSeconds' in b) ? null
          : ('seconds' in b) ? (b.seconds > 0 ? Date.now() + Math.round(b.seconds * 1000) : null)
          : ('endsAt' in b ? (b.endsAt || null) : (cur.endsAt ?? null)),
        frozenSeconds: ('frozenSeconds' in b) ? (b.frozenSeconds != null ? Math.max(0, Math.round(b.frozenSeconds)) : null)
          : (('seconds' in b || 'endsAt' in b) ? null : (cur.frozenSeconds ?? null)),
        // OBS scene to auto-cut to when the countdown reaches 0 ('' = stay on the break screen).
        thenScene: typeof b.thenScene === 'string' ? b.thenScene : (cur.thenScene ?? ''),
        // Playout playlist to roll when the countdown ends (client-driven), then cut to thenScene.
        thenPlayout: typeof b.thenPlayout === 'string' ? b.thenPlayout : (cur.thenPlayout ?? '')
      };

      // Auto-start minigame when break screen becomes visible
      const wasVisible = cur.visible;
      const nowVisible = state.breakScreen.visible;

      if (!wasVisible && nowVisible && miniGameManager && state.twitch.minigame.settings.enabled) {
        // Break screen just turned on - auto-start a game
        const gameType = state.twitch.minigame.settings.breakScreenGameType || 'trivia';
        console.log('[Twitch] Auto-starting minigame on break screen:', gameType);

        // Create a default game based on type
        const _blueTeam   = state.teams?.blue?.name   || 'Blue';
        const _orangeTeam = state.teams?.orange?.name || 'Orange';
        const _triviaPool = [
          { q: 'How many players are on a Rocket League team?',       a: ['2', '3', '4', '5'],                                                  c: 1 },
          { q: 'How long is a standard Rocket League match?',          a: ['3 minutes', '4 minutes', '5 minutes', '6 minutes'],                  c: 2 },
          { q: 'What does RLCS stand for?',                             a: ['Rocket League Club Series', 'Rocket League Championship Series', 'Rocket League Cup Showdown', 'Rocket League Circuit Season'], c: 1 },
          { q: 'Which rank is the highest in Rocket League?',           a: ['Grand Champion', 'Champion', 'Diamond', 'Supersonic Legend'],        c: 3 },
          { q: 'How many goals are needed to win a standard RL match?', a: ['Most in 5 min', 'First to 5', 'First to 3', 'Most in 3 min'],        c: 0 },
          { q: 'What colour is the Rocket League logo?',                a: ['Blue', 'Red', 'Green', 'Orange'],                                    c: 0 },
          { q: `Who do you think will win this series — ${_blueTeam} or ${_orangeTeam}?`, a: [_blueTeam, _orangeTeam, 'Going to OT!', 'No idea!'], c: 0 },
        ];
        const _trivia = _triviaPool[Math.floor(Math.random() * _triviaPool.length)];

        let autoGame = null;
        if (gameType === 'trivia') {
          autoGame = miniGameManager.createTrivia(_trivia.q, _trivia.a, _trivia.c);
        } else if (gameType === 'prediction') {
          autoGame = miniGameManager.createPrediction(
            `Who will win — ${_blueTeam} or ${_orangeTeam}?`,
            [_blueTeam, _orangeTeam]
          );
        } else if (gameType === 'vote') {
          autoGame = miniGameManager.createVote(
            `Who do you think wins this series?`,
            [_blueTeam, _orangeTeam]
          );
        } else if (gameType === 'spin') {
          autoGame = miniGameManager.createSpin(['Sub Gift', '$10 Gift Card', 'Game Key', 'Shoutout']);
        }

        if (autoGame) {
          const gameId = autoGame.id;
          const duration = autoGame.duration || 30000;

          if (gameTimers.has(gameId)) clearTimeout(gameTimers.get(gameId));

          const timer = setTimeout(() => {
            if (miniGameManager && miniGameManager.currentGame?.id === gameId) {
              const result = miniGameManager.finalize();
              broadcastFullState();
              saveTwitchData();
              announceGameResult(result);
              console.log('[Twitch] Auto-game finalized');
              setTimeout(() => {
                if (state.twitch.minigame.current?.id === gameId) {
                  state.twitch.minigame.current = null;
                  broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
                }
              }, 10000);
            }
            gameTimers.delete(gameId);
          }, duration);

          gameTimers.set(gameId, timer);
        }
      }

      if (!wasVisible && nowVisible) flowBus.emit('break_shown', {});
      if (wasVisible && !nowVisible) flowBus.emit('break_hidden', {});
      saveAppState();
      broadcastFullState();
      obsSwitch(state.breakScreen.visible ? 'break' : 'inGame');
      scheduleBreakAutoSwitch();
      break;
    }

    // (set_winner migrated to the WS_HANDLERS registry above handleControlMessage)

    // ── Map veto / map-pool overview board ───────────────────────────────
    // (set_veto / veto_* migrated to the WS_HANDLERS registry above handleControlMessage)

    // (ow_* migrated to the WS_HANDLERS registry above handleControlMessage)
    // (mr_* migrated to the WS_HANDLERS registry above handleControlMessage)

    // ── Custom overlay URL management ────────────────────────────────────
    case 'manage_custom_overlay': {
      const d = msg.data || {};
      const gameId = String(d.gameId || '');
      if (!GAMES[gameId]) break;
      const custom = { ...(state.customOverlayLayouts || {}) };
      const list = [...(custom[gameId] || [])];
      if (d.action === 'add') {
        const name = String(d.name || '').trim();
        const path = String(d.path || '').trim();
        if (!name || !path) break;
        list.push({ id: 'custom-' + Date.now(), name, path });
        custom[gameId] = list;
        state.customOverlayLayouts = custom;
      } else if (d.action === 'remove') {
        const idx = list.findIndex((o) => o.id === d.overlayId);
        if (idx < 0) break;
        list.splice(idx, 1);
        custom[gameId] = list;
        state.customOverlayLayouts = custom;
      } else if (d.action === 'rename') {
        const idx = list.findIndex((o) => o.id === d.overlayId);
        if (idx < 0 || !String(d.name || '').trim()) break;
        list[idx] = { ...list[idx], name: String(d.name).trim() };
        custom[gameId] = list;
        state.customOverlayLayouts = custom;
      }
      saveAppState(); broadcastFullState();
      break;
    }

    // ── Game Config Builder — one active config per game, extending an EXISTING built-in game
    // (maps/roles/characters). Bundle is built entirely client-side (like the League Editor holds
    // lgLeagues locally); these handlers only fire on Export/Import/Reset. ────────────────────────
    case 'export_game_config': {
      const d = msg.data || {};
      const bundle = d.bundle;
      if (!bundle || typeof bundle !== 'object' || !GAMES[bundle.game]) {
        sendImportExportResult(ws, false, 'Nothing to export — pick a valid game first.', 'game-config');
        break;
      }
      const zip = new AdmZip();
      const manifest = extractAssetsToZip(bundle, zip);
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
      dialog.showSaveDialog({
        title: 'Export Game Config',
        defaultPath: (bundle.configId || bundle.game || 'game-config') + '.zip',
        filters: [{ name: 'NE Game Config', extensions: ['zip'] }]
      }).then(({ canceled, filePath }) => {
        if (canceled || !filePath) { sendImportExportResult(ws, false, 'Export cancelled.', 'game-config'); return; }
        try { zip.writeZip(filePath); sendImportExportResult(ws, true, 'Game config exported.', 'game-config'); }
        catch (e) { sendImportExportResult(ws, false, 'Export failed: ' + e.message, 'game-config'); }
      });
      break;
    }
    case 'import_game_config': {
      (async () => {
        try {
          const r = await dialog.showOpenDialog({
            title: 'Import Game Config',
            filters: [{ name: 'NE Game Config', extensions: ['zip'] }],
            properties: ['openFile']
          });
          if (r.canceled || !r.filePaths || !r.filePaths[0]) { sendImportExportResult(ws, false, 'Import cancelled.', 'game-config'); return; }
          const zip = new AdmZip(await fsp.readFile(r.filePaths[0]));
          const manifestEntry = zip.getEntry('manifest.json');
          if (!manifestEntry) throw new Error('Not a valid Game Config file (missing manifest.json).');
          const bundle = inflateAssetsFromZip(JSON.parse(manifestEntry.getData().toString('utf8')), zip);
          if (bundle.format !== 'ne-game-config') throw new Error('Not a valid Game Config file.');
          if (!GAMES[bundle.game]) throw new Error(`"${bundle.game}" isn't one of this app's built-in games — Game Configs can only extend an existing game.`);
          state.gameConfigs = { ...(state.gameConfigs || {}), [bundle.game]: bundle };
          saveAppState(); broadcastFullState();
          sendImportExportResult(ws, true, `Game config loaded for ${GAMES[bundle.game].name}.`, 'game-config');
        } catch (e) {
          sendImportExportResult(ws, false, 'Import failed: ' + e.message, 'game-config');
        }
      })();
      break;
    }
    case 'clear_game_config': {
      const gameId = String((msg.data && msg.data.gameId) || '');
      if (!state.gameConfigs || !state.gameConfigs[gameId]) break;
      state.gameConfigs = { ...state.gameConfigs };
      delete state.gameConfigs[gameId];
      saveAppState(); broadcastFullState();
      sendImportExportResult(ws, true, `Reset ${(GAMES[gameId] && GAMES[gameId].name) || gameId} to built-in content.`, 'game-config');
      break;
    }

    // (draft_* migrated to the WS_HANDLERS registry above handleControlMessage)
    // Toggle LoL champ-select automation (reads the live draft from the League Client).
    case 'lol_draft_auto': {
      if (!state.draft) break;
      if (!state.draft.auto) state.draft.auto = { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' };
      const d = msg.data || {};
      if (typeof d.lockfilePath === 'string') state.draft.auto.lockfilePath = d.lockfilePath.slice(0, 300);
      if (typeof d.enabled === 'boolean') {
        state.draft.auto.enabled = d.enabled;
        if (d.enabled) startLolDraftAuto(); else stopLolDraftAuto();
      }
      saveAppState(); broadcastFullState();
      break;
    }

    // Teamfight-transition control for the in-game LoL HUD: full | minimal | auto.
    case 'lol_hud_mode': {
      const m = msg.data && msg.data.mode;
      if (['full', 'minimal', 'auto'].includes(m)) {
        state.lol.hudMode = m;
        broadcast(bridgeClients, { type: 'lol_hud_mode', mode: m });
        broadcastLol();
        saveAppState();
      }
      break;
    }

    // Optional OCR gold override — enable + calibrate the two capture regions.
    case 'lol_ocr_config': {
      const d = msg.data || {};
      const o = state.lol.ocr;
      if (typeof d.enabled === 'boolean') o.enabled = d.enabled;
      if (d.regions) {
        ['blue', 'red'].forEach((s) => {
          if (d.regions[s]) ['x', 'y', 'w', 'h'].forEach((k) => {
            const v = Number(d.regions[s][k]);
            if (!isNaN(v)) o.regions[s][k] = Math.max(0, Math.round(v));
          });
        });
      }
      o.available = lolOcr.tessAvailable();
      // (Re)start or stop OCR to match — only meaningful while spectating League.
      stopLolOcr();
      if (o.enabled && state.activeGame === 'league' && _lolPollTimer) startLolOcr();
      else if (!o.enabled) o.status = 'off';
      saveAppState();
      broadcastFullState();
      break;
    }

    // (set_intro migrated to the WS_HANDLERS registry above handleControlMessage)

    case 'set_font_family':
      state.fontFamily = msg.data.fontFamily || 'Bourgeois';
      saveAppState();
      broadcastFullState();
      break;

    case 'set_theme':
      if (typeof msg.data.theme === 'string') state.themesByGame[state.activeGame] = msg.data.theme;
      saveAppState();
      broadcastFullState();
      break;

    case 'set_global_accent':
      if (typeof msg.data.color === 'string') {
        if (!state.brand) state.brand = {};
        state.brand.color = msg.data.color;
      }
      saveAppState();
      broadcastFullState();
      break;

    case 'set_default_bo':
      if (typeof msg.data.bestOf === 'number') state.defaultBestOf = msg.data.bestOf;
      saveAppState();
      break;

    case 'set_clock_format':
      state.clock24h = !!msg.data.clock24h;
      saveAppState();
      broadcastFullState();
      break;

    case 'set_show_series':
      state.showSeries = msg.data.show !== false;
      saveAppState();
      broadcastFullState();
      break;

    case 'set_banner_visibility':
      state.banner.visible = !!msg.data.visible;
      saveAppState();
      broadcastFullState();
      break;

    case 'add_banner_image':
      if (msg.data.image) {
        if (!state.banner.images) state.banner.images = [];
        if (!Array.isArray(state.banner.captions)) state.banner.captions = [];
        state.banner.images.push(msg.data.image);
        state.banner.captions[state.banner.images.length - 1] = typeof msg.data.caption === 'string' ? msg.data.caption : '';
        saveAppState();
        broadcastFullState();
      }
      break;

    case 'remove_banner_image':
      if (state.banner.images && typeof msg.data.index === 'number') {
        state.banner.images.splice(msg.data.index, 1);
        if (Array.isArray(state.banner.captions)) state.banner.captions.splice(msg.data.index, 1);
        saveAppState();
        broadcastFullState();
      }
      break;

    // Optional per-image caption text (e.g. USE CODE NAMELESS FOR 5% OFF), rendered by the banner overlay.
    case 'set_banner_caption':
      if (typeof msg.data.index === 'number') {
        if (!Array.isArray(state.banner.captions)) state.banner.captions = [];
        state.banner.captions[msg.data.index] = typeof msg.data.text === 'string' ? msg.data.text : '';
        saveAppState();
        broadcastFullState();
      }
      break;

    case 'set_banner_interval':
      state.banner.interval = Math.max(1, msg.data.interval || 10);
      saveAppState();
      broadcastFullState();
      break;

    case 'set_banner_slant':
      state.banner.slant = ['right', 'left', 'box'].includes(msg.data.slant) ? msg.data.slant : 'right';
      saveAppState();
      broadcastFullState();
      break;

    case 'set_banner_header':
      state.banner.header = typeof msg.data.header === 'string' ? msg.data.header.slice(0, 40) : '';
      saveAppState();
      broadcastFullState();
      break;

    case 'add_brand_kit_banner_image': {
      const kit = savedBrandKits.find((b) => b.id === msg.data?.id);
      if (kit && msg.data?.image) {
        if (!Array.isArray(kit.bannerImages)) kit.bannerImages = [];
        kit.bannerImages.push(msg.data.image);
        saveBrandKits();
        broadcastFullState();
      }
      break;
    }

    case 'remove_brand_kit_banner_image': {
      const kit = savedBrandKits.find((b) => b.id === msg.data?.id);
      if (kit && Array.isArray(kit.bannerImages) && typeof msg.data?.index === 'number') {
        kit.bannerImages.splice(msg.data.index, 1);
        saveBrandKits();
        broadcastFullState();
      }
      break;
    }

    // ── Casters / commentator lower-thirds ───────────────────────────────
    case 'set_casters': {
      const VALID_SOCIAL = new Set(['none', 'x', 'twitch', 'youtube', 'instagram', 'tiktok', 'discord', 'facebook', 'kick', 'other']);
      const list = Array.isArray(msg.data?.list) ? msg.data.list : [];
      state.casters.list = list.slice(0, 4).map((c, idx) => {
        const slot = Number(c.slot);
        const social = (c.social || 'none').toString().toLowerCase();
        const vol = Number(c.volume);
        return {
          id: c.id || Math.random().toString(36).slice(2, 11),
          name: (c.name || '').toString().slice(0, 40),
          handle: (c.handle || '').toString().slice(0, 80),
          gamertag: crewGamertagFor(c),        // desk display name (crew Handle/Gamertag field)
          socialHandle: (c.socialHandle || c.handle || '').toString().slice(0, 80),
          camUrl: (c.camUrl || '').toString().slice(0, 1000),
          // VDO building blocks (so the control panel can re-show + rebuild the clean view URL).
          streamId: (c.streamId || '').toString().slice(0, 120),
          room: (c.room || '').toString().slice(0, 120),
          volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 100,
          audio: sanitizeVdoAudio(c.audio),
          slot: slot >= 1 && slot <= 4 ? slot : idx + 1,
          social: VALID_SOCIAL.has(social) ? social : 'none'
        };
      });
      if (typeof msg.data?.lowerThird === 'string') {
        state.casters.lowerThird = msg.data.lowerThird.slice(0, 120);
      }
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'set_casters_visibility':
      state.casters.visible = !!msg.data.visible;
      saveAppState();
      broadcastFullState();
      obsSwitch(state.casters.visible ? 'casters' : 'inGame');
      break;

    case 'set_casters_show_country':
      state.casters.showCountry = !!msg.data?.showCountry;
      saveAppState();
      broadcastFullState();
      break;

    // ── Show Deck shifts: save the whole allocation (slots + roles + on-shift marks) as a
    // named preset, apply one at handoff, or clear everything between shifts. ──
    case 'save_shift': {
      const name = ((msg.data && msg.data.name) || '').toString().trim().slice(0, 40);
      if (!name) break;
      if (!Array.isArray(state.casters.shifts)) state.casters.shifts = [];
      const lib = state.casters.library || [];
      const slotName = (n) => {
        const e = (state.casters.lineup || []).find((x) => Number(x.slot) === n);
        const p = e && lib.find((l) => l.id === e.libraryId);
        return (p && p.name) || '';
      };
      const snapshot = {
        id: Math.random().toString(36).slice(2, 11),
        name,
        // Tag with whatever event is live right now (if any) so the credits screen can pull
        // "everyone scheduled for event X" by filtering saved shifts on this field.
        eventSlug: (state.activeEvent && state.activeEvent.slug) || '',
        eventName: (state.activeEvent && state.activeEvent.name) || '',
        slots: { 1: slotName(1), 2: slotName(2), 3: slotName(3), 4: slotName(4) },
        host: (state.casters.showRoles && state.casters.showRoles.host) || '',
        observer: (state.casters.showRoles && state.casters.showRoles.observer) || '',
        active: (state.crew || []).filter((c) => c && c.active).map((c) => c.name),
        // Display options ride the shift too — a shift is the whole desk setup.
        showCountry: !!state.casters.showCountry,
        nameMode: state.casters.nameMode === 'name' ? 'name' : 'gamertag'
      };
      // Same name overwrites — re-saving a shift updates it instead of stacking duplicates.
      const existing = state.casters.shifts.findIndex((s) => (s.name || '').toLowerCase() === name.toLowerCase());
      if (existing >= 0) { snapshot.id = state.casters.shifts[existing].id; state.casters.shifts[existing] = snapshot; }
      else state.casters.shifts.push(snapshot);
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'apply_shift': {
      const shift = (state.casters.shifts || []).find((s) => s.id === (msg.data && msg.data.id));
      if (!shift) break;
      // Slots: rebuild the desk lineup for slots 1-4 from the shift's names (library entry
      // found by name, created from the crew twin when missing — same join rule as elsewhere).
      if (!Array.isArray(state.casters.library)) state.casters.library = [];
      const lib = state.casters.library;
      const findOrCreate = (nm) => {
        const k = nm.toLowerCase();
        let e = lib.find((l) => l && (l.name || '').toLowerCase() === k);
        if (e) return e;
        const crew = (state.crew || []).find((c) => c && (c.name || '').toLowerCase() === k) || {};
        e = { id: Math.random().toString(36).slice(2, 11), name: nm, handle: crew.socialHandle || '', socialHandle: crew.socialHandle || '', social: crew.social || 'none', country: crew.country || '', camUrl: '', kind: 'caster' };
        lib.push(e);
        return e;
      };
      const lineup = (state.casters.lineup || []).filter((e) => !(Number(e.slot) >= 1 && Number(e.slot) <= 4));
      [1, 2, 3, 4].forEach((n) => {
        const nm = (shift.slots && shift.slots[n] || '').toString().trim();
        if (!nm) return;
        lineup.push({ libraryId: findOrCreate(nm).id, slot: n });
      });
      state.casters.lineup = lineup;
      state.casters.showRoles = { host: shift.host || '', observer: shift.observer || '' };
      const activeSet = new Set((shift.active || []).map((n) => (n || '').toLowerCase()));
      (state.crew || []).forEach((c) => {
        if (!c) return;
        c.active = activeSet.has((c.name || '').toLowerCase());
        if (c.active) c.workedEvent = true;   // same rule as update_crew_member: going active always marks worked
      });
      state.casters.activeShiftId = shift.id;   // so the Show Deck can show which preset is currently loaded
      // Display options saved with the shift (older snapshots without them leave settings alone).
      if (typeof shift.showCountry === 'boolean') state.casters.showCountry = shift.showCountry;
      if (shift.nameMode === 'name' || shift.nameMode === 'gamertag') state.casters.nameMode = shift.nameMode;
      resolveLineupToList();
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'delete_shift': {
      if (Array.isArray(state.casters.shifts)) {
        const id = msg.data && msg.data.id;
        state.casters.shifts = state.casters.shifts.filter((s) => s.id !== id);
        if (state.casters.activeShiftId === id) state.casters.activeShiftId = '';
        saveAppState();
        broadcastFullState();
      }
      break;
    }
    case 'clear_shift': {
      // Reset EVERY field on the Show Deck for a fresh show: desk slots, show roles, on-shift
      // marks, the credits list (workedEvent) and the support-crew column. Nothing is DELETED —
      // every crew record (and its group on the Crew page) survives, and saved presets are
      // untouched; the deck just starts empty.
      state.casters.lineup = (state.casters.lineup || []).filter((e) => !(Number(e.slot) >= 1 && Number(e.slot) <= 4));
      state.casters.list = [];
      state.casters.showRoles = { host: '', observer: '' };
      state.casters.activeShiftId = '';
      state.casters.support = [];
      (state.crew || []).forEach((c) => { if (c) { c.active = false; c.workedEvent = false; } });
      saveAppState();
      broadcastFullState();
      break;
    }

    // Show Deck support column — EVENT-scoped assignments [{crewId, role}]. Deliberately does NOT
    // touch crew.group: the deck is per-show, the crew record's group is their durable category on
    // the Crew page. Adding credits them (workedEvent); removing only takes the chip off the deck.
    case 'td_support_add': {
      const d = msg.data || {};
      const c = (state.crew || []).find((x) => x && x.id === d.crewId);
      if (!c) break;
      if (!Array.isArray(state.casters.support)) state.casters.support = [];
      const role = String(d.role || '').slice(0, 40);
      const cur = state.casters.support.find((s) => s && s.crewId === c.id);
      if (cur) { if (role) cur.role = role; }
      else state.casters.support.push({ crewId: c.id, role });
      c.workedEvent = true;
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'td_support_remove': {
      if (Array.isArray(state.casters.support)) {
        state.casters.support = state.casters.support.filter((s) => s && s.crewId !== (msg.data && msg.data.crewId));
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    // Show Deck host/observer allocation (crew member names) — casters get desk-lineup slots
    // via save_caster_to_library's deskSlot instead.
    case 'set_show_roles': {
      const d = msg.data || {};
      if (!state.casters.showRoles) state.casters.showRoles = { host: '', observer: '' };
      if (typeof d.host === 'string') state.casters.showRoles.host = d.host.slice(0, 60);
      if (typeof d.observer === 'string') state.casters.showRoles.observer = d.observer.slice(0, 60);
      saveAppState();
      broadcastFullState();
      break;
    }

    // Which name the desk overlays display for each caster: their gamertag/handle (default)
    // or the crew profile's real name.
    case 'set_casters_name_mode':
      state.casters.nameMode = (msg.data && msg.data.mode) === 'name' ? 'name' : 'gamertag';
      saveAppState();
      broadcastFullState();
      break;

    // Saved-caster library — reusable people you can load into any slot.
    case 'save_caster_to_library': {
      const VALID_SOCIAL = new Set(['none', 'x', 'twitch', 'youtube', 'instagram', 'tiktok', 'discord', 'facebook', 'kick', 'other']);
      const d = msg.data || {};
      if (!Array.isArray(state.casters.library)) state.casters.library = [];
      const social = (d.social || 'none').toString().toLowerCase();
      const libSlot = Number(d.slot);
      const entry = {
        id: d.id || Math.random().toString(36).slice(2, 11),
        name: (d.name || '').toString().slice(0, 40),
        handle: (d.handle || '').toString().slice(0, 80),
        role: (d.role || '').toString().slice(0, 40),
        camUrl: (d.camUrl || '').toString().slice(0, 1000),
        ...(typeof d.vdoOverride === 'string' ? { vdoOverride: d.vdoOverride.slice(0, 1000) } : {}),
        social: VALID_SOCIAL.has(social) ? social : 'none',
        ...(typeof d.camSlot  === 'string' ? { camSlot:  d.camSlot.slice(0, 40) } : {}),
        ...(typeof d.country  === 'string' ? { country:  d.country.slice(0, 60) } : {}),
        ...(typeof d.socialHandle === 'string' ? { socialHandle: d.socialHandle.slice(0, 80) } : {}),
        ...(typeof d.notes    === 'string' ? { notes:    d.notes.slice(0, 500) } : {}),
        ...(['host', 'caster', 'observer'].includes(d.kind) ? { kind: d.kind } : {}),
        ...(typeof d.slot !== 'undefined' ? { slot: (libSlot >= 1 && libSlot <= 4) ? libSlot : 0 } : {})
      };
      if (!entry.name && !entry.handle && !entry.camUrl) break;
      // Backfill IDs for any legacy entries that were saved before id was added
      state.casters.library.forEach(c => { if (!c.id) c.id = Math.random().toString(36).slice(2, 11); });
      // When editing (d.id provided), match only by id. When creating, prevent duplicates by name/handle.
      let idx;
      if (d.id) {
        idx = state.casters.library.findIndex(c => c.id === d.id);
      } else {
        idx = state.casters.library.findIndex(c =>
          (entry.handle && c.handle && c.handle.toLowerCase() === entry.handle.toLowerCase()) ||
          (entry.name && c.name && c.name.toLowerCase() === entry.name.toLowerCase())
        );
      }
      if (idx >= 0) {
        // Partial update: only overwrite the fields actually present in the message, so editing
        // (e.g. just @handle from a group card) never wipes name / camUrl / kind / etc.
        const cur = state.casters.library[idx];
        if (typeof d.name    === 'string') cur.name    = entry.name;
        if (typeof d.handle  === 'string') cur.handle  = entry.handle;
        if (typeof d.role    === 'string') cur.role    = entry.role;
        if (typeof d.camUrl  === 'string') cur.camUrl  = entry.camUrl;
        if (typeof d.vdoOverride === 'string') cur.vdoOverride = d.vdoOverride.slice(0, 1000);
        if (typeof d.camSlot === 'string') cur.camSlot = d.camSlot.slice(0, 40);
        if (typeof d.country === 'string') cur.country = d.country.slice(0, 60);
        if (typeof d.socialHandle === 'string') cur.socialHandle = d.socialHandle.slice(0, 80);
        if (typeof d.notes   === 'string') cur.notes   = d.notes.slice(0, 500);
        if (typeof d.social  === 'string') cur.social  = entry.social;
        if (['host', 'caster', 'observer'].includes(d.kind)) cur.kind = d.kind;
        if (typeof d.slot !== 'undefined') cur.slot = (libSlot >= 1 && libSlot <= 4) ? libSlot : 0;
      } else {
        state.casters.library.push(entry);
      }
      // Optional: assign/clear this caster's desk-lineup slot in the SAME call (used by the crew page
      // so producers can put a caster on-air without opening the Casters lineup UI). We know the final
      // library id here, so no client-side lookup is needed. Mirrors the swap/bump logic the Casters
      // page uses: taking an occupied slot bumps its current occupant to this caster's old slot (or off).
      if (typeof d.deskSlot !== 'undefined') {
        const libId = (idx >= 0) ? state.casters.library[idx].id : entry.id;
        const slot = Math.max(0, Math.min(4, parseInt(d.deskSlot, 10) || 0));
        if (!Array.isArray(state.casters.lineup)) state.casters.lineup = [];
        let lineup = state.casters.lineup;
        if (slot === 0) {
          state.casters.lineup = lineup.filter((x) => x.libraryId !== libId);
        } else {
          const occ = lineup.find((x) => Number(x.slot) === slot && x.libraryId !== libId);
          const mine = lineup.find((x) => x.libraryId === libId);
          const oldSlot = mine ? Number(mine.slot) : 0;
          if (mine) mine.slot = slot;
          else lineup.push({ libraryId: libId, slot, roomId: '', streamId: libId });
          if (occ) { if (oldSlot) occ.slot = oldSlot; else state.casters.lineup = lineup.filter((x) => x !== occ); }
        }
        if (!state.casters.lineup.length) state.casters.list = [];   // resolveLineupToList no-ops on empty
        // A caster placed on the desk (slot 1-4) is clearly working this event — mark the matching
        // crew record on-shift + worked so the On shift / Worked-this-event lists and the credits pick
        // them up without a second click. Pulling them off (slot 0) leaves workedEvent so they stay credited.
        if (slot >= 1 && Array.isArray(state.crew)) {
          const nm = (d.name || '').toLowerCase(), hd = (d.handle || '').toLowerCase();
          const cm = state.crew.find((c) => c && (((c.name || '').toLowerCase() === nm && nm) || (hd && (c.handle || '').toLowerCase() === hd)));
          if (cm) { cm.active = true; cm.workedEvent = true; }
        }
      }
      resolveLineupToList();   // re-join so name/handle/social edits propagate to overlay immediately
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'delete_caster_from_library': {
      if (Array.isArray(state.casters.library)) {
        state.casters.library = state.casters.library.filter((c) => c.id !== msg.data?.id);
        resolveLineupToList();   // remove stale list entries for deleted caster
        saveAppState();
        broadcastFullState();
      }
      break;
    }
    case 'set_library_cam_slot': {
      const d = msg.data || {};
      if (!d.id || !Array.isArray(state.casters.library)) break;
      const entry = state.casters.library.find((c) => c.id === d.id);
      if (entry) { entry.camSlot = String(d.camSlot || '').slice(0, 40); saveAppState(); broadcastFullState(); }
      break;
    }
    // ── Crew profiles (unified host/guest/caster/observer database) ──
    case 'add_crew_member': {
      const d = msg.data || {};
      if (!d.name) break;
      if (!Array.isArray(state.crew)) state.crew = [];
      const id = Math.random().toString(36).slice(2, 11);
      // workedEvent: broader than active (on shift RIGHT NOW) — sticks once true so credits can
      // still find someone whose shift already ended, without having to keep them "active."
      state.crew.push({ id, name: d.name, handle: d.handle || '', role: d.role || '', group: d.group || 'casters', social: d.social || 'none', socialHandle: d.socialHandle || '', defaultCam: d.defaultCam || '', country: d.country || '', paypal: d.paypal || '', notes: d.notes || '', active: !!d.active, workedEvent: !!d.active });
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'update_crew_member': {
      const d = msg.data || {};
      if (!d.id || !Array.isArray(state.crew)) break;
      const idx = state.crew.findIndex((c) => c.id === d.id);
      if (idx !== -1) {
        const cur = state.crew[idx];
        const nextActive = (typeof d.active === 'boolean') ? d.active : !!cur.active;
        // Going active always marks workedEvent (they're clearly working this event); going
        // inactive does NOT clear it — that's the whole point, so off-shift crew who worked
        // earlier stay creditable. An explicit d.workedEvent (the Show Deck's manual toggle) wins.
        const nextWorked = (typeof d.workedEvent === 'boolean') ? d.workedEvent : (nextActive || !!cur.workedEvent);
        // group: honour an EXPLICIT string (including '' — the "remove from Support Crew" signal),
        // otherwise keep the current group. `d.group || cur.group` swallowed '' and re-pinned them.
        state.crew[idx] = { ...cur, name: d.name || cur.name, handle: d.handle ?? cur.handle, role: d.role ?? cur.role, group: (typeof d.group === 'string') ? d.group : cur.group, social: d.social || cur.social, socialHandle: d.socialHandle ?? cur.socialHandle, defaultCam: d.defaultCam ?? cur.defaultCam ?? '', country: d.country ?? cur.country ?? '', paypal: d.paypal ?? cur.paypal ?? '', notes: d.notes ?? cur.notes ?? '', active: nextActive, workedEvent: nextWorked };
        // Crew ↔ caster-library ↔ on-air slots are twins linked by name/handle (see
        // delete_crew_member). Without this sync, editing a crew profile left STALE copies
        // in the library and on the desk — the overlay kept the old gamertag forever.
        const upd = state.crew[idx];
        const oldName = (cur.name || '').toLowerCase();
        const oldHandle = (cur.handle || '').toLowerCase();
        const matches = (e) => !!e && (((e.name || '').toLowerCase() === oldName && !!oldName)
          || (!!oldHandle && (e.handle || '').toLowerCase() === oldHandle));
        const syncEntry = (e) => {
          if (!matches(e)) return;
          e.name = upd.name;
          // Deliberately NOT e.handle: the caster-card UIs treat library `handle` as the
          // @social username, while the crew Handle/Gamertag feeds the desk display name
          // via crewGamertagFor() at resolve time — no field fight.
          if (upd.social) e.social = upd.social;
          if (upd.socialHandle !== undefined) e.socialHandle = upd.socialHandle;
          if (upd.country !== undefined) e.country = upd.country;
        };
        (state.casters.library || []).forEach(syncEntry);
        (state.casters.list || []).forEach(syncEntry);
        resolveLineupToList();   // rebuild the on-air slots from the refreshed library
        saveAppState();
        broadcastFullState();
      }
      break;
    }
    case 'delete_crew_member': {
      if (Array.isArray(state.crew)) {
        const member = state.crew.find((c) => c.id === msg.data?.id);
        state.crew = state.crew.filter((c) => c.id !== msg.data?.id);
        if (Array.isArray(state.casters.support)) {
          state.casters.support = state.casters.support.filter((s) => s && s.crewId !== msg.data?.id);
        }
        // Crew + caster-library are twins linked by name/handle: purge the library entry and
        // free any desk-lineup slot it held, or a "deleted" caster stays on the desk overlay.
        if (member && Array.isArray(state.casters.library)) {
          const nm = (member.name || '').toString().toLowerCase();
          const hd = (member.handle || '').toString().toLowerCase();
          const deadIds = new Set(state.casters.library
            .filter(c => (hd && c.handle && c.handle.toLowerCase() === hd) ||
                         (nm && c.name && c.name.toLowerCase() === nm))
            .map(c => c.id));
          if (deadIds.size) {
            state.casters.library = state.casters.library.filter(c => !deadIds.has(c.id));
            if (Array.isArray(state.casters.lineup)) {
              state.casters.lineup = state.casters.lineup.filter(e => !deadIds.has(e.libraryId));
            }
            if ((state.casters.lineup || []).length) resolveLineupToList();
            else if (Array.isArray(state.casters.list)) state.casters.list = state.casters.list.filter(c => !deadIds.has(c.id));
          }
        }
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'update_crew_order': {
      const ordered = msg.data?.crew;
      if (Array.isArray(ordered)) {
        state.crew = ordered;
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'delete_all_crew': {
      state.crew = [];
      state.casters.support = [];
      saveAppState();
      broadcastFullState();
      break;
    }

    // ── Show Roster: pre-show crew/player assignment + VDO generation ──────────
    case 'add_to_roster': {
      const d = msg.data || {};
      if (!d.crewId || !d.groupKey) break;
      if (!Array.isArray(state.showRoster)) state.showRoster = [];
      if (state.showRoster.find((r) => r.crewId === d.crewId && r.groupKey === d.groupKey)) break;
      const member = (state.crew || []).find((c) => c.id === d.crewId);
      if (!member) break;
      state.showRoster.push({ crewId: d.crewId, groupKey: d.groupKey, camSlot: member.defaultCam || '', streamId: '', joinUrl: '', viewUrl: '' });
      saveAppState(); broadcastFullState(); break;
    }
    case 'remove_from_roster': {
      const d = msg.data || {};
      if (!Array.isArray(state.showRoster)) break;
      state.showRoster = state.showRoster.filter((r) => !(r.crewId === d.crewId && r.groupKey === d.groupKey));
      saveAppState(); broadcastFullState(); break;
    }
    case 'update_roster_entry': {
      const d = msg.data || {};
      if (!Array.isArray(state.showRoster)) break;
      const entry = state.showRoster.find((r) => r.crewId === d.crewId && r.groupKey === d.groupKey);
      if (entry && d.camSlot !== undefined) entry.camSlot = String(d.camSlot).slice(0, 40);
      saveAppState(); broadcastFullState(); break;
    }
    case 'generate_roster_vdo': {
      // Uses the crew member's GROUP shared room so everyone in casters/guests/observers
      // all join one room — consistent with the Director and Camera Feeds VDO model.
      const d = msg.data || {};
      if (!Array.isArray(state.showRoster)) break;
      const entry = state.showRoster.find((r) => r.crewId === d.crewId && r.groupKey === d.groupKey);
      if (!entry) break;
      const member = (state.crew || []).find((c) => c.id === entry.crewId) || {};
      const gk = d.groupKey;
      let grm;
      if (gk === 'casters')             grm = ensureCasterVdo();
      else if (gk === 'hosts' || gk === 'guests') grm = ensureGuestsVdo();
      else if (gk === 'observers')      grm = ensureObserversVdo();
      else                              grm = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
      const streamId = vdoSlug(member.handle || member.name || entry.crewId);
      const lang = state.vdo?.lang || 'en-US';
      entry.streamId = streamId; entry.vdoRoom = grm.room; entry.vdoPassword = grm.password;
      entry.joinUrl = `${vdoBase()}/?room=${grm.room}&push=${streamId}&transcribe=${lang}&webcam&autostart#p=${grm.password}`;
      entry.viewUrl = `${vdoBase()}/?room=${grm.room}&view=${streamId}&solo#p=${grm.password}`;
      saveAppState(); broadcastFullState(); break;
    }
    case 'generate_all_roster_vdo': {
      const d = msg.data || {};
      if (!Array.isArray(state.showRoster)) break;
      const gk = d.groupKey;
      let grm;
      if (gk === 'casters')             grm = ensureCasterVdo();
      else if (gk === 'hosts' || gk === 'guests') grm = ensureGuestsVdo();
      else if (gk === 'observers')      grm = ensureObserversVdo();
      else                              grm = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
      const lang = state.vdo?.lang || 'en-US';
      state.showRoster.filter((r) => r.groupKey === gk && !r.joinUrl).forEach((entry) => {
        const member = (state.crew || []).find((c) => c.id === entry.crewId) || {};
        const streamId = vdoSlug(member.handle || member.name || entry.crewId);
        entry.streamId = streamId; entry.vdoRoom = grm.room; entry.vdoPassword = grm.password;
        entry.joinUrl = `${vdoBase()}/?room=${grm.room}&push=${streamId}&transcribe=${lang}&webcam&autostart#p=${grm.password}`;
        entry.viewUrl = `${vdoBase()}/?room=${grm.room}&view=${streamId}&solo#p=${grm.password}`;
      });
      saveAppState(); broadcastFullState(); break;
    }
    case 'clear_roster': {
      const d = msg.data || {};
      if (!Array.isArray(state.showRoster)) break;
      state.showRoster = d.groupKey ? state.showRoster.filter((r) => r.groupKey !== d.groupKey) : [];
      saveAppState(); broadcastFullState(); break;
    }
    // Assign a human-readable camera label (e.g. "CAM1") to a team player for the DCC board
    case 'set_player_cam_slot': {
      const d = msg.data || {};
      if (!d.side || !d.playerId) break;
      const team = state.teams && state.teams[d.side];
      if (!team) break;
      const player = (team.players || []).find((p) => String(p.id) === String(d.playerId));
      if (player) { player.camSlot = String(d.camSlot || '').slice(0, 40); saveAppState(); broadcastFullState(); }
      break;
    }
    case 'set_roster_custom_url': {
      const d = msg.data || {};
      if (!Array.isArray(state.showRoster)) break;
      const entry = state.showRoster.find((r) => r.crewId === d.crewId && r.groupKey === d.groupKey);
      if (entry) { entry.customVdoUrl = String(d.customVdoUrl || '').slice(0, 512); saveAppState(); broadcastFullState(); }
      break;
    }
    case 'push_to_obs_source': {
      // Push a URL directly to an OBS browser source input by name (e.g. CAM1)
      const d = msg.data || {};
      if (!d.url || !d.sourceName) break;
      if (obsClient && obsClient.isConnected()) {
        obsClient.call('SetInputSettings', { inputName: d.sourceName.trim(), inputSettings: { url: d.url.trim() } }).catch((e) => {
          console.warn('[OBS push] SetInputSettings failed:', e && e.message);
        });
      }
      break;
    }

    // Create a browser source in OBS if it doesn't exist yet (or retarget it if it does).
    // Used by LISTEN IN's "Add to OBS" so producers never hand-configure the source; audio is
    // rerouted (= "Control audio via OBS") and monitored so it reaches both stream and producer.
    case 'obs_ensure_browser_source': {
      const d = msg.data || {};
      const name = (d.sourceName || '').toString().trim();
      const url = (d.url || '').toString().trim();
      if (!name || !url) break;
      (async () => {
        let ok = false, message = '';
        try {
          if (!obsClient || !obsClient.isConnected()) throw new Error('Not connected to OBS — connect in Integrations, then try again.');
          const cur = await obsClient.call('GetCurrentProgramScene');
          const sceneName = (d.sceneName || '').toString().trim() || cur.currentProgramSceneName;
          const list = await obsClient.call('GetInputList');
          const exists = (list.inputs || []).some((i) => i.inputName === name);
          if (exists) {
            await obsClient.call('SetInputSettings', { inputName: name, inputSettings: { url } });
            message = `"${name}" already exists in OBS — URL updated.`;
          } else {
            await obsClient.call('CreateInput', {
              sceneName, inputName: name, inputKind: 'browser_source',
              inputSettings: { url, width: 1920, height: 1080, reroute_audio: true }
            });
            await obsClient.call('SetInputAudioMonitorType', { inputName: name, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' }).catch(() => {});
            message = `Added "${name}" to scene "${sceneName}" — audio is monitored and on stream.`;
          }
          ok = true;
        } catch (e) { message = (e && e.message) || 'OBS error'; }
        try { ws.send(JSON.stringify({ type: 'obs-ensure-result', data: { ok, message } })); } catch (e) {}
      })();
      break;
    }

    // Per-member audio for a library person (caster/guest/observer) — baked into their group
    // room view URL by buildTalentGroup, and driven by the Director mixer.
    case 'set_library_audio': {
      const d = msg.data || {};
      const e = (state.casters.library || []).find((c) => c.id === d.id);
      if (e) { e.audio = sanitizeVdoAudio(d.audio); saveAppState(); broadcastFullState(); }
      break;
    }
    // New room + password for a shared talent-group room (invalidates old links).
    case 'regenerate_group_room': {
      const g = msg.data?.group;
      if (g === 'casters') ensureCasterVdo(true);
      else if (g === 'guests') ensureGuestsVdo(true);
      else if (g === 'observers') ensureObserversVdo(true);
      else if (g === 'interview') ensureInterviewVdo(true);
      else break;
      saveAppState();
      broadcastFullState();
      break;
    }

    // ── Game & overlay design (theme) ────────────────────────────────────
    case 'set_active_game': {
      const g = msg.data?.game;
      if (g && GAMES[g]) {
        const prev = state.activeGame;
        state.activeGame = g;
        // Re-tint placeholder team colours to the new game's defaults (e.g. Overwatch → blue/red)
        // so the Match-Teams cards reflect the game. Saved teams' own brand colours are preserved
        // because those aren't part of the default palette.
        const dc = gameDefaultColors(g);
        if (state.teams.blue && DEFAULT_SIDE_COLOR_SET.has((state.teams.blue.color || '').toLowerCase())) {
          state.teams.blue.color = dc.a;
        }
        if (state.teams.orange && DEFAULT_SIDE_COLOR_SET.has((state.teams.orange.color || '').toLowerCase())) {
          state.teams.orange.color = dc.b;
        }
        if (directorEngine) directorEngine.reset();
        // Map Pool and Draft are keyed to the OLD game's pool/roster (map ids, hero rosters,
        // ban formats) — leaving them as-is showed stale maps/heroes from the previous game
        // (or Overwatch's ban board hanging around after switching away from Overwatch). Reset
        // both to their clean not-started shape so the next Start Veto / Start Draft builds
        // fresh from the NEW game's pool.
        if (prev !== g) {
          state.veto = { visible: false, title: '', maps: [] };
          // Board content resets (old game's pool/roster), but PRODUCER PREFERENCES survive:
          // teamStart and the Overwatch ban count are settings, not board state — resetting
          // owBanCount to 4 here silently undid "one ban per team" every time the game switched.
          state.draft = { visible: false, title: '', subtitle: '',
            game: '', teamStart: (state.draft && state.draft.teamStart) || 'a',
            owBanCount: (state.draft && state.draft.owBanCount) || 4,
            sequence: [], ops: [], turn: null, complete: false,
            auto: (state.draft && state.draft.auto) || { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' } };
        }
        // Stop data connections for the previous game
        if (prev === 'rocket-league' && g !== 'rocket-league') disconnectRL();
        if (prev === 'valorant' && g !== 'valorant') stopValorantPolling();
        if (prev === 'league' && g !== 'league') stopLolPolling();
        // Start data connections for the new game
        if (g === 'rocket-league' && prev !== 'rocket-league') connectToRL();
        if (g === 'valorant') startValorantPolling();
        if (g === 'league') startLolPolling();
        if (g === 'marvel-rivals') {
          if (!state.mrMatch) state.mrMatch = { visible: true, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
          state.mrMatch.visible = true;
        }
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'set_theme': {
      const t = msg.data?.theme;
      if (t) {
        const migrated = migrateThemeId(state.activeGame, t);
        if (isValidTheme(state.activeGame, migrated)) {
          state.themesByGame[state.activeGame] = migrated;
          saveAppState();
          broadcastFullState();
        }
      }
      break;
    }

    // ── CS2 GSI install ──────────────────────────────────────────────────
    case 'install_csgo_gsi': {
      try {
        const file = installGsiConfig(msg.data?.path || '');
        ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: true, message: `✓ Installed GSI config: ${file}. Restart CS2 if it was running.` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: false, message: e.message } }));
      }
      break;
    }

    case 'install_spectator_cfg': {
      try {
        const file = installSpectatorCfg(msg.data?.path || '');
        ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: true, message: `✓ Installed spectator HUD config: ${file}. In CS2 console run:  exec cs2-spectator  (F9 toggles).` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: false, message: e.message } }));
      }
      break;
    }

    case 'csgo_show_history': {
      state.csgo.showHistory = !!(msg.data && msg.data.visible);
      broadcastFullState();
      broadcastCsgo();
      break;
    }

    case 'csgo_radar_mode': {
      state.csgo.builtinRadar = !!(msg.data && msg.data.builtin);
      broadcastFullState();
      broadcastCsgo();
      break;
    }

    // ── Broadcast config presets ─────────────────────────────────────────
    case 'save_preset': {
      const name = (msg.data?.name || '').toString().trim();
      if (!name) break;
      const existing = savedPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
      const entry = { id: existing ? existing.id : Math.random().toString(36).slice(2, 11), name, game: state.activeGame, config: capturePreset() };
      if (existing) Object.assign(existing, entry);
      else savedPresets.push(entry);
      savePresets();
      broadcastFullState();
      break;
    }

    case 'load_preset': {
      const preset = savedPresets.find((p) => p.id === msg.data?.id);
      if (preset) {
        applyPreset(preset.config);
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'delete_preset': {
      savedPresets = savedPresets.filter((p) => p.id !== msg.data?.id);
      savePresets();
      broadcastFullState();
      break;
    }

    // ── Brand kits (client identities + sponsor sets) ────────────────────
    case 'save_brand_kit': {
      const k = msg.data || {};
      const name = (k.name || '').toString().trim();
      if (!name) break;
      const existing = savedBrandKits.find((b) => b.id === k.id) ||
        savedBrandKits.find((b) => b.name.toLowerCase() === name.toLowerCase());
      const entry = {
        id: existing ? existing.id : brandId(),
        name,
        logo: k.logo || null,
        color: k.color || null,
        accent: k.accent || null,
        font: k.font || null,
        themes: (k.themes && typeof k.themes === 'object') ? k.themes : {},
        obsSceneCollection: (typeof k.obsSceneCollection === 'string') ? k.obsSceneCollection.trim() : '',
        obsProfile: (typeof k.obsProfile === 'string') ? k.obsProfile.trim() : '',
        packages: [],
        activePackageId: null,
      };
      if (Array.isArray(k.packages) && k.packages.length) {
        // New client: identity + an explicit list of sponsor/banner packages.
        entry.packages = k.packages.map((p) => sanitizePackage(p));
        entry.activePackageId = entry.packages.some((p) => p.id === k.activePackageId) ? k.activePackageId : entry.packages[0].id;
      } else {
        // Legacy single-package payload (sponsors/banner at the top level) → wrap into one package,
        // reusing the existing active package id so a re-save edits in place.
        const pkg = sanitizePackage({ ...k, id: (existing && existing.activePackageId) || undefined, name: (existing && (existing.packages || [])[0] && existing.packages[0].name) || 'Main' });
        entry.packages = [pkg];
        entry.activePackageId = pkg.id;
      }
      if (existing) {
        Object.assign(existing, entry);
        PACKAGE_FIELDS.forEach((f) => delete existing[f]);   // strip any legacy top-level duplicates
      } else savedBrandKits.push(entry);
      saveBrandKits();
      // "Save & Activate" — put the saved profile on air in the same action (covers new kits
      // too, whose id only exists server-side). Plain save on the already-live kit still runs
      // the full package-activation side effects so a ★-star change takes effect in ONE save.
      if (msg.data && msg.data.activate) {
        activateBrandKitById(entry.id);
      } else if (entry.id === state.activeBrandKitId) {
        applyBrandSlots();
        syncActivePreshowTopics();
        const liveKit = existing || savedBrandKits.find((b) => b.id === entry.id);
        if (applyPackageSnapshot(activePackage(liveKit))) saveAppState();
      }
      broadcastFullState();
      break;
    }

    case 'activate_brand_kit': {
      activateBrandKitById(msg.data?.id || null);
      break;
    }

    // Pick which sponsor/banner package of a profile is live (the per-stream quick-switch).
    case 'activate_brand_package': {
      const kit = savedBrandKits.find((b) => b.id === msg.data?.kitId);
      if (kit) {
        ensureKitPackages(kit);
        if (kit.packages.some((p) => p.id === msg.data?.packageId)) {
          kit.activePackageId = msg.data.packageId;
          saveBrandKits();
          if (kit.id === state.activeBrandKitId) {
            applyBrandSlots();
            syncActivePreshowTopics();
            if (applyPackageSnapshot(activePackage(kit))) saveAppState();
          }
          broadcastFullState();
        }
      }
      break;
    }

    // "Capture current show setup" — snapshot the live scene presets / ticker / event name /
    // board titles / caster lineup + slot labels / OBS moment mappings into a package, so
    // activating it later restores the whole show configuration.
    case 'capture_package_snapshot': {
      const kit = savedBrandKits.find((b) => b.id === msg.data?.kitId);
      if (kit) {
        ensureKitPackages(kit);
        const pkg = kit.packages.find((p) => p.id === msg.data?.packageId);
        if (pkg) {
          pkg.showSnapshot = capturePackageSnapshot();
          saveBrandKits();
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'brand-result', data: { ok: true, message: `Show setup captured into "${pkg.name}".` } }));
        }
      }
      break;
    }

    // Duplicate a whole profile (identity + every package) as a new client.
    case 'duplicate_brand_kit': {
      const src = savedBrandKits.find((b) => b.id === msg.data?.id);
      if (src) {
        ensureKitPackages(src);
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = brandId();
        copy.name = 'Copy of ' + (src.name || 'Profile');
        const idMap = {};
        copy.packages = (copy.packages || []).map((p) => { const nid = brandId(); idMap[p.id] = nid; return { ...p, id: nid }; });
        copy.activePackageId = idMap[src.activePackageId] || (copy.packages[0] && copy.packages[0].id) || null;
        savedBrandKits.splice(savedBrandKits.indexOf(src) + 1, 0, copy);
        saveBrandKits();
        broadcastFullState();
      }
      break;
    }

    case 'export_brand_kit': {
      (async () => {
        const kit = savedBrandKits.find((b) => b.id === msg.data?.id);
        if (!kit) { sendImportExportResult(ws, false, 'Brand kit not found.'); return; }
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Export Brand Kit',
          defaultPath: (kit.name || 'brand-kit').replace(/[^a-z0-9]/gi, '-').toLowerCase() + '-brand-kit.json',
          filters: [{ name: 'NE Brand Kit', extensions: ['json'] }],
        });
        if (canceled || !filePath) { sendImportExportResult(ws, false, 'Export cancelled.'); return; }
        try {
          const payload = { format: 'ne-brand-kit', version: 1, exportedAt: Date.now(), kit: JSON.parse(JSON.stringify(kit)) };
          await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
          sendImportExportResult(ws, true, `Brand kit "${kit.name}" exported.`);
        } catch (e) { sendImportExportResult(ws, false, 'Export failed: ' + e.message); }
      })();
      break;
    }

    case 'import_brand_kit': {
      (async () => {
        try {
          const { canceled, filePaths } = await dialog.showOpenDialog({
            title: 'Import Brand Kit',
            filters: [{ name: 'NE Brand Kit', extensions: ['json'] }],
            properties: ['openFile'],
          });
          if (canceled || !filePaths || !filePaths[0]) { sendImportExportResult(ws, false, 'Import cancelled.'); return; }
          const raw = await fsp.readFile(filePaths[0], 'utf8');
          const parsed = JSON.parse(raw);
          if (!parsed || parsed.format !== 'ne-brand-kit' || !parsed.kit)
            throw new Error('Not a valid NE Brand Kit file.');
          const incoming = parsed.kit;
          if (!incoming.id) incoming.id = brandId();
          ensureKitPackages(incoming);
          const idx = savedBrandKits.findIndex((k) => (k.id && k.id === incoming.id) || k.name === incoming.name);
          if (idx >= 0) Object.assign(savedBrandKits[idx], incoming);
          else savedBrandKits.unshift(incoming);
          saveBrandKits();
          broadcastFullState();
          sendImportExportResult(ws, true, `Brand kit "${incoming.name}" imported.`);
        } catch (e) { sendImportExportResult(ws, false, 'Import failed: ' + e.message); }
      })();
      break;
    }

    // Colour mode: which source the overlays use for the two sides. Non-destructive —
    // team/brand/default each keep their own colours; this only picks the active one.
    case 'set_color_mode': {
      const m = msg.data?.mode;
      if (m === 'team' || m === 'brand' || m === 'default' || m === 'game') {
        state.colorMode = m;
        state.useBrandColors = (m === 'brand');   // keep the legacy flag in sync
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'set_scene_bg': {
      const { path, bg } = msg.data || {};
      if (typeof path === 'string' && path) {
        if (!state.sceneBg) state.sceneBg = {};
        const cleanPath = path.split('?')[0];   // strip ?timer=1 etc — overlays key by pathname
        if (bg && bg.on) {
          state.sceneBg[cleanPath] = { on: true, color: (bg.color || '#000000').slice(0, 20), op: Math.max(1, Math.min(100, Number(bg.op) || 50)) };
        } else {
          // Store explicit off so overlays can remove a URL-param bg; undefined means untouched.
          state.sceneBg[cleanPath] = { on: false };
        }
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    // Legacy: old clients sent a brand-colours on/off toggle → map it onto colorMode.
    case 'delete_brand_kit': {
      savedBrandKits = savedBrandKits.filter((b) => b.id !== msg.data?.id);
      if (state.activeBrandKitId === msg.data?.id) { state.activeBrandKitId = null; saveAppState(); }
      saveBrandKits();
      broadcastFullState();
      break;
    }

    // ── Player spotlight (featured-player lower-third) ───────────────────
    case 'set_spotlight': {
      const p = msg.data || {};
      if (typeof p.visible === 'boolean') state.spotlight.visible = p.visible;
      if (typeof p.playerName === 'string') state.spotlight.playerName = p.playerName;
      broadcastFullState();
      break;
    }

    // (set_ticker migrated to the WS_HANDLERS registry above handleControlMessage)

    case 'set_background': {
      const bg = msg.data || {};
      if (['solid', 'gradient', 'image'].includes(bg.type)) state.background.type = bg.type;
      if (typeof bg.color1 === 'string') state.background.color1 = bg.color1.slice(0, 20);
      if (typeof bg.color2 === 'string') state.background.color2 = bg.color2.slice(0, 20);
      if (typeof bg.angle === 'number') state.background.angle = Math.max(0, Math.min(360, bg.angle));
      if (typeof bg.imageUrl === 'string') state.background.imageUrl = bg.imageUrl.slice(0, 2000);
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'set_brand_social_preset': {
      const kitId = state.activeBrandKitId;
      const kit = kitId && savedBrandKits.find((k) => k.id === kitId);
      // No active brand kit → save to a state-level fallback instead of silently dropping it (a
      // kit-scoped preset only makes sense once kits are in use; most setups never activate one).
      const target = kit ? (kit.socialPreset || (kit.socialPreset = {})) : (state.socialPreset || (state.socialPreset = {}));
      const p = msg.data || {};
      if (typeof p.bgImageUrl === 'string') target.bgImageUrl = p.bgImageUrl.slice(0, 5000000);
      if (typeof p.bgStyle === 'string' && ['auto', 'dark', 'spotlight'].includes(p.bgStyle)) target.bgStyle = p.bgStyle;
      if (typeof p.presentedByEnabled === 'boolean') target.presentedByEnabled = p.presentedByEnabled;
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'set_team':
      if (msg.data.side === 'blue' || msg.data.side === 'orange') {
        // Preserve color/players already set for this side
        state.teams[msg.data.side] = {
          ...state.teams[msg.data.side],
          name: msg.data.name || '',
          logo: msg.data.logo || null
        };
        // Carry the saved team's own colour when one is provided (so Team colour-mode reflects it).
        if (typeof msg.data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.data.color)) {
          state.teams[msg.data.side].color = msg.data.color;
        }
        // Optional roster (e.g. picking a seeded start.gg team) → feeds the facecam rows.
        if (Array.isArray(msg.data.players)) {
          state.teams[msg.data.side].players = msg.data.players;
          rebuildCombinedPlayers();
        }
        saveAppState();
        broadcastFullState();
      }
      break;

    case 'set_team_color':
      if ((msg.data.side === 'blue' || msg.data.side === 'orange') && typeof msg.data.color === 'string') {
        const c = msg.data.color.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(c)) {
          state.teams[msg.data.side].color = c;
          saveAppState();
          broadcastFullState();
        }
      }
      break;

    // Pull the two teams currently live on the start.gg stream into blue/orange,
    // with logos + player rosters (the rosters feed the facecam rows).
    case 'autofill_stream_teams': {
      const q = state.startgg.queue || [];
      const wantStream = state.startgg.streamName;
      const set = q.find((s) => s.live && (!wantStream || s.stream === wantStream))
               || q.find((s) => s.live) || q[0];
      if (!set) {
        state.startgg.lastError = 'Stream queue is empty — on start.gg, attach sets to your stream (Match Settings → Stream), then they appear here.';
        broadcastFullState();
        break;
      }
      const upper = (s) => (s || '').toString().trim().toUpperCase();
      const assign = (side, teamName) => {
        const nm = upper(teamName);
        state.teams[side] = { ...state.teams[side], name: nm };
        const et = (state.startgg.eventTeams || []).find((t) => upper(t.name) === nm);
        const saved = savedTeams.find((t) => upper(t.name) === nm);
        const src = et || saved;
        if (src) {
          if (src.logo) state.teams[side].logo = src.logo;
          if (Array.isArray(src.players) && src.players.length) state.teams[side].players = src.players;
        }
      };
      assign('blue', set.teamA);
      assign('orange', set.teamB);
      rebuildCombinedPlayers();
      state.startgg.lastError = null;
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'adjust_series':
      if (msg.data.side === 'blue' || msg.data.side === 'orange') {
        state.series[msg.data.side] = Math.max(0, Math.min(Math.ceil(state.bestOf / 2), state.series[msg.data.side] + (msg.data.delta || 0)));
        // Auto-advance the current game to (games played + 1) so producers don't
        // have to bump BOTH the series win and the game number.
        const played = (state.series.blue || 0) + (state.series.orange || 0);
        state.game.number = Math.max(1, Math.min(state.bestOf, played + 1));
        saveAppState();
        broadcastFullState();
      }
      break;

    // Leagues are control-panel-authoritative: the editor pushes the whole list. Validate/normalize
    // every incoming league (migrate to the current shape, cap oversized logos, dedupe ids) rather
    // than trusting the payload verbatim — this is the single write path for the whole feature.
    case 'set_leagues': {
      const incoming = msg.data && msg.data.leagues;
      if (Array.isArray(incoming)) {
        const LEAGUES_MAX = 200;
        const capped = incoming.length > LEAGUES_MAX ? incoming.slice(0, LEAGUES_MAX) : incoming;
        if (incoming.length > LEAGUES_MAX) {
          console.warn(`[leagues] set_leagues payload had ${incoming.length} leagues — truncated to ${LEAGUES_MAX}.`);
        }
        const seenIds = new Set();
        const cleaned = [];
        for (const raw of capped) {
          if (!raw || typeof raw !== 'object') continue;
          const lg = migrateLeague(raw);
          if (seenIds.has(lg.id)) { console.warn(`[leagues] dropped duplicate league id "${lg.id}" in set_leagues payload.`); continue; }
          seenIds.add(lg.id);
          cleaned.push(lg);
        }
        state.leagues = cleaned;
        leaguesVer++;
      }
      saveAppState();
      broadcastFullState();
      break;
    }

    // Build a manual league seeded from a start.gg event's entrants (teams + rosters).
    case 'create_league_from_startgg': {
      (async () => {
        const input = (msg.data && (msg.data.input || msg.data.eventSlug || msg.data.url) || '').toString().trim();
        try {
          if (!startggApiToken) throw new Error('Add your start.gg API token in Settings first.');
          // Resolve to a concrete event slug (auto-pick a single-event tournament).
          let evSlug = parseEventSlug(input);
          if (!/\/event\//i.test(evSlug)) {
            const { tournamentSlug } = parseStartggInput(input);
            const events = tournamentSlug ? await fetchTournamentEvents(startggApiToken, tournamentSlug) : [];
            if (events.length === 1) evSlug = events[0].slug;
            else if (events.length > 1) throw new Error(`That tournament has ${events.length} events — paste the specific event URL.`);
            else throw new Error('Could not find a start.gg event from that link.');
          }
          const client = createStartGgClient(startggApiToken);
          const entrants = await fetchAllEntrants(client, evSlug);
          const teams = mapEntrantsToTeams(entrants).filter(Boolean).map((t) => ({
            id: 'lt' + Math.random().toString(36).slice(2, 9),
            name: t.name, logo: t.logo || null,
            players: (t.players || []).map((p) => ({ id: 'lp' + Math.random().toString(36).slice(2, 9), name: p.name, role: '', salary: 0, stats: {} }))
          }));
          if (!teams.length) throw new Error('No entrants found on that event yet.');
          const league = {
            id: 'lg' + Math.random().toString(36).slice(2, 9),
            name: (msg.data && msg.data.name || '').toString().slice(0, 80) || 'Start.gg League',
            game: state.activeGame, type: 'team', season: '', salaryCap: 0,
            teams, freeAgents: [],
            standings: teams.map((t) => ({ teamId: t.id, w: 0, l: 0, pts: 0 })),
            schedule: [], source: { startgg: evSlug }
          };
          if (!Array.isArray(state.leagues)) state.leagues = [];
          state.leagues.unshift(league);
          leaguesVer++;
          saveAppState();
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'event-result', data: { ok: true, leagueId: league.id, message: `Created league "${league.name}" with ${teams.length} team(s) from start.gg.` } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'event-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    // ── MY EVENTS — add/remove an event to the app's saved list. Start.gg events auto-sync their
    // roster (see refreshMyEvent) every ~3 min; Challonge/NXGEN events are saved as a reference —
    // no recurring sync loop for them yet, so `eventSlug` is left blank for those (refreshMyEvent's
    // own `!ev.eventSlug` guard already skips them safely).
    case 'add_my_event': {
      const d = msg.data || {};
      const platform = ['challonge', 'nxgen', 'manual'].includes(d.platform) ? d.platform : 'startgg';
      const eventSlug = platform === 'startgg' ? (d.eventSlug || '').toString().trim() : '';
      const platformSlug = platform === 'startgg' ? '' : (d.platformSlug || '').toString().trim();
      if (platform === 'startgg' ? !eventSlug : !platformSlug) break;
      if (!Array.isArray(state.myEvents)) state.myEvents = [];
      const dupe = platform === 'startgg'
        ? state.myEvents.some((e) => e.eventSlug === eventSlug)
        : state.myEvents.some((e) => e.platform === platform && e.platformSlug === platformSlug);
      if (dupe) { ws.send(JSON.stringify({ type: 'event-result', data: { ok: true, message: 'Already in MY EVENTS.' } })); break; }
      state.myEvents.unshift({
        id: 'ev' + Math.random().toString(36).slice(2, 10),
        platform,
        tournamentSlug: platform === 'startgg' ? (d.tournamentSlug || eventSlug.replace(/\/event\/.*$/, '')).toString() : '',
        eventSlug,
        platformSlug,
        name: (d.name || '').toString().slice(0, 160),
        tournamentName: (d.tournamentName || '').toString().slice(0, 160),
        game: (d.game || '').toString().slice(0, 80),
        numEntrants: Number(d.numEntrants) || 0,
        startAt: d.startAt || null,
        // Platform logos are short URLs; a manually-uploaded logo is a full base64 data URI —
        // don't truncate either (a truncated data URI is just corrupt image data).
        image: (d.image || '').toString(),
        url: (d.url || '').toString().slice(0, 600),
        addedAt: Date.now(),
        seeding: null
      });
      saveAppState();
      broadcastFullState();
      ws.send(JSON.stringify({ type: 'event-result', data: { ok: true, message: `Added "${d.name || 'event'}" to MY EVENTS.` } }));
      // Pull its roster (teams + players + seeds) right away so seeding has data immediately —
      // start.gg only; Challonge/NXGEN entries keep whatever summary info was saved above.
      if (platform === 'startgg') {
        const added = state.myEvents.find((e) => e.eventSlug === eventSlug);
        if (added) refreshMyEvent(added).then((ok) => { if (ok) { saveAppState(); broadcastFullState(); } }).catch(() => {});
      }
      break;
    }
    case 'remove_my_event': {
      const id = (msg.data && msg.data.id) || '';
      if (Array.isArray(state.myEvents)) state.myEvents = state.myEvents.filter((e) => e.id !== id);
      saveAppState();
      broadcastFullState();
      break;
    }
    // Manual / on-open refresh of one (or all) My Events from start.gg.
    case 'refresh_my_event': {
      const id = (msg.data && msg.data.id) || '';
      const all = !id;
      if (all) { refreshAllMyEvents({ force: true }).catch(() => {}); }
      else {
        const ev = Array.isArray(state.myEvents) ? state.myEvents.find((e) => e.id === id) : null;
        if (ev) refreshMyEvent(ev).then((ok) => { saveAppState(); broadcastFullState(); ws.send(JSON.stringify({ type: 'event-result', data: { ok, message: ok ? `Refreshed "${ev.name || 'event'}".` : (ev.syncError || 'Refresh failed.') } })); }).catch(() => {});
      }
      break;
    }
    // Persist a saved seeding draft onto a My Events entry.
    // Save discovered player profiles (6mans matches from rank verify) into the registry.
    case 'save_player_profiles': {
      const arr = Array.isArray(msg.data && msg.data.profiles) ? msg.data.profiles : [];
      arr.slice(0, 600).forEach((p) => {
        if (!p || !p.gamerTag) return;
        const patch = {};
        if (p.startggSlug) patch.startggSlug = p.startggSlug;
        if (p.sixmans && (p.sixmans.name || p.sixmans.elo != null)) patch.sixmans = p.sixmans;
        if (p.tracker && p.tracker.username) patch.tracker = p.tracker;
        if (patch.startggSlug || patch.sixmans || patch.tracker) upsertPlayerProfile(p.gamerTag, patch);
      });
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'set_event_seeding': {
      const id = (msg.data && msg.data.id) || '';
      const ev = Array.isArray(state.myEvents) ? state.myEvents.find((e) => e.id === id) : null;
      if (ev) {
        ev.seeding = {
          source: (msg.data.source || 'startgg').toString(),
          rankMode: (msg.data.rankMode || '').toString().slice(0, 24),   // active rank system (game-specific)
          agg: ['best', 'avg', 'sum'].includes(msg.data.agg) ? msg.data.agg : 'best',   // team value method
          savedAt: Date.now(),
          entrants: Array.isArray(msg.data.entrants) ? msg.data.entrants.slice(0, 512).map((x, i) => ({
            entrantId: (x.entrantId || '').toString(),
            name: (x.name || '').toString().slice(0, 160),
            seedNum: i + 1,
            players: Array.isArray(x.players) ? x.players.slice(0, 12).map((p) => ({
              gamerTag: (p.gamerTag || '').toString().slice(0, 80),
              rank:     (p.rank    || '').toString().slice(0, 40),
              epic:     (p.epic    || '').toString().slice(0, 80),
              steam:    (p.steam   || '').toString().slice(0, 80),
              alts:     Array.isArray(p.alts) ? p.alts.slice(0, 8).map((a) => ({
                          platform: (a && a.platform ? a.platform : '').toString().slice(0, 20),
                          username: (a && a.username ? a.username : '').toString().slice(0, 80),
                        })).filter((a) => a.username) : [],
              startggSlug:     p.startggSlug     ? String(p.startggSlug).slice(0, 120)  : null,
              startggPlayerId: p.startggPlayerId ? String(p.startggPlayerId).slice(0, 40) : null,
            })) : []
          })) : []
        };
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    // Series/match editor: format, division, per-map results.
    case 'set_match': {
      const p = msg.data || {};
      if (typeof p.format === 'string') {
        state.match.format = p.format;
        const bo = { bo1: 1, bo3: 3, bo5: 5, bo7: 7 }[p.format];
        if (bo) state.bestOf = bo;   // keep the legacy best-of in sync with the format
      }
      if (typeof p.seriesVisible === 'boolean') state.match.seriesVisible = p.seriesVisible;
      if (typeof p.division === 'string') state.match.division = p.division;
      if (Array.isArray(p.maps)) {
        state.match.maps = p.maps.slice(0, 9).map((m) => ({
          name: typeof m.name === 'string' ? m.name : '',
          scoreA: Math.max(0, Number(m.scoreA) || 0),
          scoreB: Math.max(0, Number(m.scoreB) || 0),
          played: !!m.played
        }));
      }
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'set_best_of':
      state.bestOf = msg.data.value || 5;
      state.game.number = Math.min(state.game.number, state.bestOf);
      state.series.blue = Math.min(state.series.blue, Math.ceil(state.bestOf / 2));
      state.series.orange = Math.min(state.series.orange, Math.ceil(state.bestOf / 2));
      saveAppState();
      broadcastFullState();
      break;

    case 'adjust_game_number':
      state.game.number = Math.max(1, Math.min(state.bestOf, state.game.number + (msg.data.delta || 0)));
      saveAppState();
      broadcastFullState();
      break;

    case 'reset_series':
      finalizeAndResetSeries();
      saveAppState();
      broadcastFullState();
      break;

    case 'force_scoreboard': {
      state.view = 'scoreboard';
      const roster = scoreboardRoster();
      state.scoreboard = {
        players: Object.values(roster).map((p) => ({ ...p })),
        blueScore: state.game.blueScore ?? 0,
        orangeScore: state.game.orangeScore ?? 0,
        series: { ...state.series }
      };
      broadcast(bridgeClients, { type: 'view_change', data: { view: 'scoreboard', playerCache: roster } });
      break;
    }

    case 'force_hud':
      state.view = 'hud';
      broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } });
      break;

    case 'set_facecams_enabled':
      state.facecamsEnabled = !!msg.data.enabled;
      saveAppState();
      broadcastFullState();
      break;

    case 'set_replay_cams':
      state.replayCams = !!msg.data.enabled;
      saveAppState();
      broadcastFullState();
      break;

    case 'save_team': {
      const { name, logo, oldName, color } = msg.data;
      const players = Array.isArray(msg.data.players) ? msg.data.players : null;
      const favorite = typeof msg.data.favorite === 'boolean' ? msg.data.favorite : undefined;
      // abbr: honour whenever the key is present (including null/'' = deliberately cleared);
      // it was silently dropped before, so the editor's Abbreviation field never saved.
      const hasAbbr = Object.prototype.hasOwnProperty.call(msg.data, 'abbr');
      const abbr = hasAbbr ? (String(msg.data.abbr || '').trim().toUpperCase().slice(0, 6) || null) : undefined;
      // Match the library entry by NORMALIZED name (trim + case-insensitive) so a quick-save of a
      // match team (whose name the panel uppercases) UPDATES the existing "Team Alpha" instead of
      // spawning a duplicate "TEAM ALPHA". Only an explicit rename (oldName present) changes the
      // stored casing; a plain re-save keeps the library entry's own name.
      const _tn = (s) => (s || '').trim().toLowerCase();
      let idx = -1;
      if (oldName) idx = savedTeams.findIndex(t => _tn(t.name) === _tn(oldName));
      if (idx === -1) idx = savedTeams.findIndex(t => _tn(t.name) === _tn(name));

      if (idx >= 0) {
        const prev = savedTeams[idx] || {};
        savedTeams[idx] = {
          ...prev,
          name: oldName ? name : (prev.name || name),
          logo: logo !== undefined ? logo : prev.logo,
          color: color !== undefined ? color : prev.color,
          ...(hasAbbr && { abbr }),
          // Preserve the existing roster unless an explicit players array was sent.
          players: players !== null ? players : (prev.players || []),
          ...(favorite !== undefined && { favorite })
        };
      } else {
        savedTeams.push({ name, logo: logo || null, color: color || null, ...(hasAbbr && { abbr }), players: players || [], ...(favorite !== undefined && { favorite }) });
      }

      // Explicit rename (oldName present, differs from the new name): cascade into every league
      // team-reference ({id, teamName}) that pointed at the old name, so leagues stay linked
      // instead of silently falling into lgResolveTeam's "unlinked" fallback. Also move any manual
      // team-record, which is deliberately keyed by team name so it "follows the team."
      if (oldName && _tn(oldName) !== _tn(name) && Array.isArray(state.leagues) && state.leagues.length) {
        let leaguesTouched = false;
        for (const lg of state.leagues) {
          for (const t of (lg.teams || [])) {
            if (t && t.teamName != null && _tn(t.teamName) === _tn(oldName)) { t.teamName = name; leaguesTouched = true; }
          }
        }
        if (leaguesTouched) leaguesVer++;
        const mb = state.teamRecord && state.teamRecord.manualByName;
        if (mb && Object.prototype.hasOwnProperty.call(mb, _tn(oldName))) {
          mb[_tn(name)] = mb[_tn(oldName)];
          delete mb[_tn(oldName)];
        }
        if (leaguesTouched) saveAppState();
      }

      saveTeams();
      broadcastFullState();
      break;
    }

    case 'apply_saved_team': {
      const d = msg.data || {};
      const side = d.side === 'orange' ? 'orange' : 'blue';
      const src  = savedTeams.find(t => t.name === d.name);
      if (src && state.teams[side]) {
        if (src.name)   state.teams[side].name   = src.name;
        if (src.color)  state.teams[side].color  = src.color;
        if (src.logo !== undefined) state.teams[side].logo = src.logo;
        if (Array.isArray(src.players)) {
          state.teams[side].players = src.players.map((p, i) => ({
            id: p.id || (Date.now() + i),
            name: p.name || '',
            realName: p.realName || '',
            role: p.role || '',
            country: p.country || '',
            platform: p.platform || '',
            platformId: p.platformId || '',
            camSlot: p.camSlot || p.assignedCamera || '',
            startgg: p.startgg || '',
            sixmans: p.sixmans || '',
            status: p.status || 'starter',
            photo: p.photo || '',
            discord: p.discord || '',
            twitter: p.twitter || '',
            twitch: p.twitch || '',
            instagram: p.instagram || '',
            tiktok: p.tiktok || '',
            youtube: p.youtube || '',
          }));
        }
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'delete_team': {
      savedTeams = savedTeams.filter(t => t.name !== msg.data.name);
      saveTeams();
      broadcastFullState();
      break;
    }

    case 'update_teams_order': {
      savedTeams = msg.data.teams || [];
      saveTeams();
      broadcastFullState();
      break;
    }

    // ── start.gg Event Teams (transient) management ─────────────────────────
    case 'select_startgg_event': {
      const d = msg.data || {};
      state.startgg.selectedEvent = {
        tournamentSlug: (d.tournamentSlug || '').trim(),
        eventSlug: (d.eventSlug || '').trim(),
        name: (d.name || '').trim(),
        tournamentName: (d.tournamentName || '').trim()
      };
      // Also sync top level slugs for queue etc.
      if (d.tournamentSlug) state.startgg.tournamentSlug = d.tournamentSlug.trim();
      if (d.eventSlug) state.startgg.eventSlug = d.eventSlug.trim();
      // The Bracket scene's "Tournament Organizer" source follows this immediately — without this
      // it wouldn't notice the switch until the next ~20s poll tick.
      syncBracketToActiveEvent().then(() => { saveAppState(); broadcastFullState(); }).catch(() => {});
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'load_startgg_event_teams': {
      const d = msg.data || {};
      (async () => {
        try {
          await loadStartggEventTeams(d.tournamentSlug, d.eventSlug);
          // func already broadcasts + saves
        } catch (e) {
          state.startgg.lastError = 'Load teams: ' + e.message;
          broadcastFullState();
        }
      })();
      break;
    }

    case 'clear_startgg_teams': {
      state.startgg.eventTeams = [];
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'delete_startgg_team': {
      const name = (msg.data && msg.data.name || '').trim();
      if (name) {
        state.startgg.eventTeams = (state.startgg.eventTeams || []).filter(t => t.name !== name);
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'mass_delete_startgg_teams': {
      // Optional filter by names list; if none, clear all
      const names = (msg.data && msg.data.names) || null;
      if (Array.isArray(names) && names.length) {
        const set = new Set(names);
        state.startgg.eventTeams = (state.startgg.eventTeams || []).filter(t => !set.has(t.name));
      } else {
        state.startgg.eventTeams = [];
      }
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'save_startgg_team': {
      // Copy one event team into savedTeams (for repeat week-to-week use)
      const name = (msg.data && msg.data.name || '').trim();
      const team = (state.startgg.eventTeams || []).find(t => t.name === name);
      if (team) {
        const idx = savedTeams.findIndex(st => (st.name || '').toLowerCase() === name.toLowerCase());
        if (idx >= 0) {
          // merge fresh players/logo but preserve existing custom logo if present
          const cur = savedTeams[idx];
          savedTeams[idx] = {
            name: team.name,
            logo: cur.logo || team.logo,
            players: team.players && team.players.length ? team.players : (cur.players || [])
          };
        } else {
          savedTeams.push({ name: team.name, logo: team.logo, players: team.players || [] });
        }
        saveTeams();
        broadcastFullState();
      }
      break;
    }

    case 'save_startgg_teams_bulk': {
      const names = (msg.data && msg.data.names) || [];
      const toSave = Array.isArray(names) && names.length
        ? (state.startgg.eventTeams || []).filter(t => names.includes(t.name))
        : (state.startgg.eventTeams || []);
      toSave.forEach((team) => {
        const idx = savedTeams.findIndex(st => (st.name || '').toLowerCase() === team.name.toLowerCase());
        if (idx >= 0) {
          const cur = savedTeams[idx];
          savedTeams[idx] = {
            name: team.name,
            logo: cur.logo || team.logo,
            players: (team.players && team.players.length) ? team.players : (cur.players || [])
          };
        } else {
          savedTeams.push({ name: team.name, logo: team.logo, players: team.players || [] });
        }
      });
      if (toSave.length) {
        saveTeams();
        broadcastFullState();
      }
      break;
    }

    case 'add_player': {
      const { side, player } = msg.data || {};
      if (side && state.teams[side]) {
        if (!state.teams[side].players) state.teams[side].players = [];
        const newPlayer = { id: Math.random().toString(36).substr(2, 9), ...player };
        state.teams[side].players.push(newPlayer);
        persistRosterToLibrary(side);   // mirror to the saved-team library (create/update by name)

        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'edit_player': {
      const { side, playerId, playerData } = msg.data || {};
      if (side && state.teams[side]) {
        const player = state.teams[side].players?.find(p => p.id === playerId);
        if (player) {
          Object.assign(player, playerData);
          persistRosterToLibrary(side);   // mirror the edit to the saved-team library

          saveAppState();
          broadcastFullState();
        }
      }
      break;
    }

    case 'delete_player': {
      const { side, playerId } = msg.data || {};
      if (side && state.teams[side]) {
        state.teams[side].players = state.teams[side].players?.filter(p => p.id !== playerId) || [];
        persistRosterToLibrary(side);   // mirror the removal to the saved-team library

        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'assign_camera_to_player': {
      const { side, playerId, cameraId } = msg.data || {};
      if (side && state.teams[side]) {
        const player = state.teams[side].players?.find(p => p.id === playerId);
        if (player) {
          player.assignedCamera = cameraId || null;
          saveAppState();
          broadcastFullState();
        }
      }
      break;
    }

    // ── VDO.Ninja talent workflow ────────────────────────────────────────
    case 'set_vdo_config': {
      const d = msg.data || {};
      const v = state.vdo;
      if (typeof d.base === 'string' && d.base.trim()) v.base = d.base.trim().replace(/\/+$/, '');
      if (typeof d.lang === 'string' && d.lang) v.lang = d.lang;
      if (typeof d.cleanOutput === 'boolean') v.cleanOutput = d.cleanOutput;
      if (typeof d.transparent === 'boolean') v.transparent = d.transparent;
      if (typeof d.cover === 'boolean') v.cover = d.cover;
      if (d.volume !== undefined) v.volume = Math.max(0, Math.min(100, Math.round(+d.volume) || 0));
      if (typeof d.codec === 'string') v.codec = d.codec;
      if (typeof d.bitrate === 'string' || typeof d.bitrate === 'number') v.bitrate = String(d.bitrate);
      if (typeof d.buffer === 'string' || typeof d.buffer === 'number') v.buffer = String(d.buffer);
      if (typeof d.viewParams === 'string') v.viewParams = d.viewParams.slice(0, 300);
      if (typeof d.pushParams === 'string') v.pushParams = d.pushParams.slice(0, 300);
      if (typeof d.audioMono === 'boolean') v.audioMono = d.audioMono;
      if (typeof d.audioBitrate === 'string' || typeof d.audioBitrate === 'number') v.audioBitrate = String(d.audioBitrate);
      if (typeof d.audioParams === 'string') v.audioParams = d.audioParams.slice(0, 300);
      saveAppState();
      broadcastFullState();
      break;
    }

    // Auto-provision rooms/passwords for the active match teams (and stream IDs for players).
    case 'generate_team_vdo': {
      const regen = !!msg.data?.regenerate;
      const sides = msg.data?.side ? [msg.data.side] : ['blue', 'orange'];
      for (const side of sides) {
        const team = state.teams[side];
        if (!team) continue;
        ensureTeamVdo(team, regen);
        if (Array.isArray(team.players)) {
          team.players.forEach((p) => { if (!p.vdoStreamId) p.vdoStreamId = playerStreamId(p); });
        }
        // A regenerated room invalidates the old links — a listen-in feed still pointed at
        // the dead room would silently play nothing, so drop it and let the producer re-arm.
        if (regen && state.listenIn && state.listenIn.active && state.listenIn.side === side) {
          state.listenIn = { active: false, side: '', scope: '', name: '', url: '' };
        }
      }
      saveAppState();
      broadcastFullState();
      break;
    }

    // Override a player's stream ID (defaults to their sanitized gamertag).
    case 'set_player_stream_id': {
      const { side, playerId, streamId } = msg.data || {};
      const player = side && state.teams[side]?.players?.find(p => p.id === playerId);
      if (player) {
        player.vdoStreamId = vdoSlug(streamId || '') || playerStreamId(player);
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    // Provision a shared private VDO room for all casters + auto-assign stream IDs and rebuild camUrls.
    case 'generate_caster_vdo': {
      const regen = !!msg.data?.regenerate;
      ensureCasterVdo(regen);
      if (Array.isArray(state.casters.list)) {
        state.casters.list.forEach((c, i) => {
          if (!c.streamId) c.streamId = vdoSlug(c.handle || c.name || `caster${i + 1}`);
          c.room = state.casters.vdo.room;
          c.camUrl = buildCasterObsUrl(c);
        });
      }
      saveAppState();
      broadcastFullState();
      break;
    }

    // Save (create or update) a named caster room.
    case 'save_caster_room': {
      const d = msg.data || {};
      const name = (d.name || '').toString().slice(0, 60).trim();
      if (!name) break;
      if (!Array.isArray(state.casters.rooms)) state.casters.rooms = [];
      const id = (d.id || '').toString() || Math.random().toString(36).slice(2, 11);
      const idx = state.casters.rooms.findIndex(r => r.id === id);
      const existing = idx >= 0 ? state.casters.rooms[idx] : null;
      const room = { id, name, vdo: (existing && existing.vdo) || { room: '', password: '' } };
      if (idx >= 0) state.casters.rooms[idx] = room;
      else state.casters.rooms.push(room);
      // New rooms get credentials immediately (producers can still "Link existing" to override).
      if (!room.vdo.room) ensureRoomVdo(room);
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'delete_caster_room': {
      if (Array.isArray(state.casters.rooms)) {
        const rid = msg.data?.id;
        state.casters.rooms = state.casters.rooms.filter(r => r.id !== rid);
        if (Array.isArray(state.casters.lineup)) {
          state.casters.lineup.forEach(e => { if (e.roomId === rid) e.roomId = ''; });
        }
        resolveLineupToList();
        saveAppState();
        broadcastFullState();
      }
      break;
    }
    case 'generate_caster_room_vdo': {
      if (!Array.isArray(state.casters.rooms)) break;
      const room = state.casters.rooms.find(r => r.id === msg.data?.id);
      if (!room) break;
      ensureRoomVdo(room, !!msg.data?.regenerate);
      resolveLineupToList();
      saveAppState();
      broadcastFullState();
      break;
    }
    // Plug an existing VDO room (name + password) into a MATCH TEAM or SAVED TEAM instead of
    // generating one — players' join/OBS links derive from team.vdo, so they follow instantly.
    case 'set_team_vdo_creds': {
      const d = msg.data || {};
      const vroom = (d.room || '').toString().trim().slice(0, 100);
      const vpass = (d.password || '').toString().trim().slice(0, 100);
      if (!vroom) break;
      let team = null;
      if (d.side === 'blue' || d.side === 'orange') team = state.teams[d.side];
      else if (d.teamName) team = savedTeams.find(t => t.name === d.teamName);
      if (!team) break;
      team.vdo = { room: vroom, password: vpass };
      // Refresh the mirrored library-team room too when the match team is a saved team.
      if (d.side && team.name) {
        const savedTwin = savedTeams.find(t => t.name === team.name);
        if (savedTwin) savedTwin.vdo = { room: vroom, password: vpass };
      }
      if (d.teamName) saveTeams(); else saveAppState();
      broadcastFullState();
      break;
    }
    // Plug an existing VDO room into one of the shared talent group rooms
    // (casters = HOSTS desk, guests = LOBBY, observers = OBSERVERS).
    case 'set_group_room_creds': {
      const d = msg.data || {};
      const vroom = (d.room || '').toString().trim().slice(0, 100);
      const vpass = (d.password || '').toString().trim().slice(0, 100);
      const key = d.group === 'guests' ? 'guestsVdo' : d.group === 'observers' ? 'observersVdo'
                : d.group === 'casters' ? 'vdo' : d.group === 'interview' ? 'interview' : null;
      if (!vroom || !key) break;
      state.casters[key] = { room: vroom, password: vpass };
      if (key === 'vdo') resolveLineupToList();   // caster room feeds the desk lineup URLs
      saveAppState();
      broadcastFullState();
      break;
    }
    // Plug in an existing VDO room (name + password) instead of generating new credentials.
    case 'set_caster_room_creds': {
      if (!Array.isArray(state.casters.rooms)) break;
      const room = state.casters.rooms.find(r => r.id === msg.data?.id);
      if (!room) break;
      const vroom = (msg.data?.room || '').toString().trim().slice(0, 100);
      const vpass = (msg.data?.password || '').toString().trim().slice(0, 100);
      if (vroom && vpass) {
        room.vdo = { room: vroom, password: vpass };
        resolveLineupToList();
        saveAppState();
        broadcastFullState();
      }
      break;
    }
    // Designate which named room is the interview / desk room (where casters sit + interviews happen).
    case 'set_desk_room': {
      const rid = (msg.data?.roomId || '').toString();
      if (!rid || (Array.isArray(state.casters.rooms) && state.casters.rooms.some(r => r.id === rid))) {
        state.casters.deskRoomId = rid;
        saveAppState();
        broadcastFullState();
      }
      break;
    }
    // Set this show's lineup — which library profiles are active, in which slots & rooms.
    case 'set_caster_lineup': {
      const entries = Array.isArray(msg.data?.lineup) ? msg.data.lineup : [];
      state.casters.lineup = entries.slice(0, 6).map((e, i) => ({
        libraryId: (e.libraryId || '').toString(),
        slot: Number(e.slot) || (i + 1),
        roomId: (e.roomId || '').toString(),
        streamId: (e.streamId || '').toString().slice(0, 80),
        customCamUrl: (e.customCamUrl || '').toString().slice(0, 1000),
        audio: sanitizeVdoAudio(e.audio)
      }));
      resolveLineupToList();
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'set_slot_label': {
      const slot = parseInt(msg.data?.slot);
      const label = String(msg.data?.label || '').trim().slice(0, 30);
      if (slot >= 1 && slot <= 4) {
        if (!state.casters.slotLabels || typeof state.casters.slotLabels !== 'object') {
          state.casters.slotLabels = { 1: 'Caster 1', 2: 'Caster 2', 3: 'Caster 3', 4: 'Caster 4' };
        }
        state.casters.slotLabels[slot] = label || `Caster ${slot}`;
        saveAppState();
        broadcastFullState();
      }
      break;
    }
    // Interviewee → Player Spotlight Desk right cam. Stores the player's production-room solo feed
    // so spotlightdesk.html shows their live camera + audio in the right (featured) position.
    case 'set_interviewee': {
      const side = (msg.data?.side || '').toString();
      const pid = msg.data?.playerId;
      const team = state.teams[side];
      if (!team) break;
      const player = (team.players || []).find((p) => p && (p.id === pid || String(p.id) === String(pid)));
      if (!player) break;
      const eff = effectiveTeamColors();
      state.casters.interviewee = {
        playerId: player.id, side, name: player.name || '', streamId: playerStreamId(player),
        teamName: team.name || '', color: (eff && eff[side]) || team.color || '',
        camUrl: buildPlayerInterviewViewUrl(player)
      };
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'clear_interviewee': {
      const pid = msg.data?.playerId;
      if (!pid || (state.casters.interviewee && String(state.casters.interviewee.playerId) === String(pid))) {
        state.casters.interviewee = null;
        saveAppState();
        broadcastFullState();
      }
      break;
    }
    // Track which caster overlay HTML is the active OBS source.
    case 'set_caster_active_layout': {
      const VALID_LAYOUTS = new Set(['/casters.html','/singlecam.html','/duorow.html','/triorow.html','/duosinglecam.html','/analystspecial.html','/campip.html','/talentbar.html','/interview.html','/quaddesk.html','/matchup.html','/spotlightdesk.html','/vertical.html']);
      const path = (msg.data?.path || '').toString().slice(0, 100);
      state.casters.activeLayout = VALID_LAYOUTS.has(path) ? path : '';
      saveAppState();
      broadcastFullState();
      break;
    }

    // One-click: auto-create a room if needed, provision VDO for all rooms, auto-assign rooms to slots.
    case 'generate_all_caster_links': {
      if (!Array.isArray(state.casters.lineup) || !state.casters.lineup.length) break;
      if (!Array.isArray(state.casters.rooms)) state.casters.rooms = [];
      if (!state.casters.rooms.length) {
        state.casters.rooms.push({ id: Math.random().toString(36).slice(2, 11), name: 'Main Desk', vdo: { room: '', password: '' } });
      }
      state.casters.rooms.forEach(room => ensureRoomVdo(room, false));
      const firstRoom = state.casters.rooms[0];
      state.casters.lineup.forEach((entry, i) => {
        entry.streamId = 'caster_' + (Number(entry.slot) || (i + 1));
        if (!entry.roomId && firstRoom) entry.roomId = firstRoom.id;
      });
      resolveLineupToList();
      saveAppState();
      broadcastFullState();
      break;
    }

    // Override stream ID for a player on a saved team (library, not active match).
    case 'set_saved_team_player_stream_id': {
      const { teamName, playerId, streamId } = msg.data || {};
      const team = savedTeams.find(t => t.name === teamName);
      const player = team?.players?.find(p => p.id === playerId);
      if (player) { player.vdoStreamId = vdoSlug(streamId || '') || ''; saveTeams(); }
      break;
    }

    // Per-player VDO audio override (volume / pan / mono / audio bitrate / extra params) for the
    // talent OBS feed. side = 'blue'|'orange' for a match player, or teamName for a saved-team player.
    case 'set_player_audio': {
      const { side, playerId, teamName } = msg.data || {};
      const audio = sanitizeVdoAudio(msg.data?.audio);
      let player, persist;
      if (side === 'blue' || side === 'orange') {
        player = state.teams[side]?.players?.find(p => p.id === playerId);
        persist = saveAppState;
      } else if (teamName) {
        const team = savedTeams.find(t => t.name === teamName);
        player = team?.players?.find(p => p.id === playerId);
        persist = saveTeams;
      }
      if (player) {
        if (audio) player.vdoAudio = audio; else delete player.vdoAudio;
        if (persist) persist();
        broadcastFullState();
      }
      break;
    }

    // Assign a player's VDO camera feed to a specific caster overlay slot.
    // Slots 1-4 = desk caster slots; slot 5 = the Player cam (Spotlight/Interview Desk),
    // kept in casters.playerCam so lineup rebuilds can't wipe it.
    case 'assign_talent_cam': {
      const { side, playerId, teamName, slot } = msg.data || {};
      const slotNum = Number(slot);
      if (slotNum < 1 || slotNum > 5) break;
      let team, player;
      if (side === 'blue' || side === 'orange') {
        team = state.teams[side];
        player = (team?.players || []).find(p => p.id === playerId);
      } else if (teamName) {
        team = savedTeams.find(t => t.name === teamName);
        player = (team?.players || []).find(p => p.id === playerId);
      }
      if (!team || !player || !team.vdo?.room) break;
      const camUrl = buildObsViewUrl(team, player);
      if (!camUrl) break;
      if (slotNum === 5) {
        state.casters.playerCam = { camUrl, name: player.name || '', playerId: player.id || '', side: side || '', teamName: teamName || (team.name || '') };
        saveAppState();
        broadcastFullState();
        break;
      }
      if (!Array.isArray(state.casters.list)) state.casters.list = [];
      let entry = state.casters.list.find(c => Number(c.slot) === slotNum);
      if (!entry) {
        entry = { id: Math.random().toString(36).slice(2, 11), name: '', handle: '', camUrl: '', slot: slotNum, social: 'none', streamId: '', room: '', volume: 100 };
        state.casters.list.push(entry);
        state.casters.list.sort((a, b) => Number(a.slot) - Number(b.slot));
      }
      entry.camUrl = camUrl;
      saveAppState();
      broadcastFullState();
      break;
    }

    // Clear the slot-5 player cam.
    case 'clear_player_cam': {
      state.casters.playerCam = null;
      saveAppState();
      broadcastFullState();
      break;
    }

    // Generate VDO rooms for saved teams in the library.
    // teamName = specific team; omit to provision all teams that don't have a room yet.
    case 'generate_saved_team_vdo': {
      const { teamName, regenerate } = msg.data || {};
      if (teamName) {
        const team = savedTeams.find(t => t.name === teamName);
        if (team) ensureTeamVdo(team, !!regenerate);
      } else {
        savedTeams.forEach(t => { if (regenerate || !t.vdo || !t.vdo.room) ensureTeamVdo(t); });
      }
      saveTeams();
      broadcastFullState();
      break;
    }

    // Point the LISTEN IN overlay at a player (audio + live captions), or clear it.
    case 'set_listen_in': {
      const { side, playerId, scope } = msg.data || {};
      const team = side && state.teams[side];
      if (!team) break;
      if (scope === 'room' || !playerId) {
        // Whole-team-room listen (primary): hear every connected player + their captions.
        state.listenIn = {
          active: true, side, scope: 'room',
          name: team.name || side.toUpperCase(),
          url: buildRoomListenInUrl(team)
        };
        saveAppState();
        broadcastFullState();
      } else {
        const player = team.players?.find(p => p.id === playerId);
        if (player) {
          state.listenIn = {
            active: true, side, scope: 'player', playerId,
            name: player.name || playerStreamId(player),
            url: buildListenInUrl(team, player)
          };
          saveAppState();
          broadcastFullState();
        }
      }
      break;
    }
    case 'clear_listen_in': {
      state.listenIn = { active: false, side: '', scope: '', name: '', url: '' };
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'set_listen_captions': {
      state.vdo.listenCaptions = !!(msg.data && msg.data.on);
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'save_facecam': {
      const { name, platform, platformId, link, nickname } = msg.data;
      const idx = savedFacecams.findIndex(fc => fc.name === name);
      const entry = { name, platform, platformId, link, nickname: nickname || name };
      if (idx >= 0) savedFacecams[idx] = entry;
      else savedFacecams.push(entry);
      saveFacecams();
      broadcastFullState();
      break;
    }

    case 'delete_facecam': {
      savedFacecams = savedFacecams.filter(fc => fc.name !== msg.data.name);
      saveFacecams();
      broadcastFullState();
      break;
    }
    
    // ── Producer profile (portable .zip — teams/brands/facecams/presets/leagues/casters/settings) ──
    // The one consolidated export/import for everything non-game-specific. Packaged as a zip
    // (manifest.json + real image files under assets/) via extractAssetsToZip/inflateAssetsFromZip
    // so images and data travel together in one shareable file — supersedes the old separate
    // teams+facecams-only export_data/import_data zip, which has been retired.
    case 'export_profile': {
      const zip = new AdmZip();
      const manifest = extractAssetsToZip(buildProfileBundle(), zip);
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
      dialog.showSaveDialog({
        title: 'Export Producer Profile',
        defaultPath: 'NE-Broadcast-Profile.zip',
        filters: [{ name: 'NE Broadcast Profile', extensions: ['zip'] }]
      }).then(({ canceled, filePath }) => {
        if (canceled || !filePath) { sendImportExportResult(ws, false, 'Export cancelled.'); return; }
        try { zip.writeZip(filePath); sendImportExportResult(ws, true, 'Profile exported — safe to share (no passwords or tokens included).'); }
        catch (e) { sendImportExportResult(ws, false, 'Export failed: ' + e.message); }
      });
      break;
    }
    case 'import_profile': {
      (async () => {
        try {
          let filePath = msg.data && msg.data.path;
          if (!filePath) {
            const r = await dialog.showOpenDialog({
              title: 'Import Producer Profile',
              filters: [{ name: 'NE Broadcast Profile', extensions: ['zip', 'json'] }],
              properties: ['openFile']
            });
            if (r.canceled || !r.filePaths || !r.filePaths[0]) { sendImportExportResult(ws, false, 'Import cancelled.'); return; }
            filePath = r.filePaths[0];
          }
          const raw = await fsp.readFile(filePath);
          let bundle;
          if (filePath.toLowerCase().endsWith('.json')) {
            // Legacy pre-zip export — plain JSON with images already inline as base64.
            bundle = JSON.parse(raw.toString('utf8'));
          } else {
            const zip = new AdmZip(raw);
            const manifestEntry = zip.getEntry('manifest.json');
            if (!manifestEntry) throw new Error('Not a valid NE Broadcast Profile file (missing manifest.json).');
            bundle = inflateAssetsFromZip(JSON.parse(manifestEntry.getData().toString('utf8')), zip);
          }
          const summary = applyProfileBundle(bundle, msg.data && msg.data.options);
          sendImportExportResult(ws, true, summary + '.');
          broadcastFullState();
        } catch (e) {
          sendImportExportResult(ws, false, 'Import failed: ' + e.message);
        }
      })();
      break;
    }

    // ── Cloud profile sync (Nameless backend) — dormant until BROADCAST_REMOTE_URL is set ──
    case 'cloud_status':
      ws.send(JSON.stringify({ type: 'cloud_status', data: cloud.getSession() }));
      break;
    case 'cloud_list_profiles': {
      (async () => {
        try {
          if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_profiles', data: { ok: false, message: cloud.configured() ? 'Sign in to the cloud first.' : 'Cloud sync not available yet.', profiles: [] } })); return; }
          ws.send(JSON.stringify({ type: 'cloud_profiles', data: { ok: true, profiles: await cloud.listProfiles() } }));
        } catch (e) { ws.send(JSON.stringify({ type: 'cloud_profiles', data: { ok: false, message: e.message, profiles: [] } })); }
      })();
      break;
    }
    case 'cloud_push_profile': {
      (async () => {
        try {
          if (!cloud.authed()) { sendImportExportResult(ws, false, cloud.configured() ? 'Sign in to the cloud first.' : 'Cloud sync not available yet.'); return; }
          const saved = await cloud.saveProfile(buildProfileBundle(), { id: msg.data && msg.data.id, name: (msg.data && msg.data.name) || 'My Profile' });
          sendImportExportResult(ws, true, 'Profile synced to cloud.');
          ws.send(JSON.stringify({ type: 'cloud_profile_saved', data: saved }));
        } catch (e) { sendImportExportResult(ws, false, 'Cloud sync failed: ' + e.message); }
      })();
      break;
    }
    case 'cloud_pull_profile': {
      (async () => {
        try {
          if (!cloud.authed()) { sendImportExportResult(ws, false, cloud.configured() ? 'Sign in to the cloud first.' : 'Cloud sync not available yet.'); return; }
          const res = await cloud.getProfile(msg.data && msg.data.id);
          const summary = applyProfileBundle(res.bundle || res, msg.data && msg.data.options);
          sendImportExportResult(ws, true, summary + ' (from cloud).');
          broadcastFullState();
        } catch (e) { sendImportExportResult(ws, false, 'Cloud load failed: ' + e.message); }
      })();
      break;
    }

    // ── Org broadcast-seat management (licensing) — owner/admin only, server-side
    // gated by the backend's canManageStaff() check; these are thin passthroughs. ──
    case 'cloud_list_org_seats': {
      (async () => {
        try {
          if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_org_seats', data: { ok: false, message: 'Sign in to the cloud first.', seats: [] } })); return; }
          const orgId = msg.data && msg.data.orgId;
          if (!orgId) { ws.send(JSON.stringify({ type: 'cloud_org_seats', data: { ok: false, message: 'No organization workspace.', seats: [] } })); return; }
          const res = await cloud.listOrgSeats(orgId);
          ws.send(JSON.stringify({ type: 'cloud_org_seats', data: { ok: true, ...res } }));
        } catch (e) { ws.send(JSON.stringify({ type: 'cloud_org_seats', data: { ok: false, message: e.message, seats: [] } })); }
      })();
      break;
    }
    case 'cloud_add_org_seat': {
      (async () => {
        try {
          if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'org-seats'); return; }
          const d = msg.data || {};
          if (!d.orgId || !d.userId || !d.role) { sendImportExportResult(ws, false, 'orgId, userId, and role are required.', 'org-seats'); return; }
          await cloud.addOrgSeat(d.orgId, { userId: d.userId, role: d.role });
          sendImportExportResult(ws, true, 'Seat granted.', 'org-seats');
        } catch (e) { sendImportExportResult(ws, false, 'Add seat failed: ' + e.message, 'org-seats'); }
      })();
      break;
    }
    case 'cloud_remove_org_seat': {
      (async () => {
        try {
          if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'org-seats'); return; }
          const d = msg.data || {};
          if (!d.orgId || !d.seatId) { sendImportExportResult(ws, false, 'orgId and seatId are required.', 'org-seats'); return; }
          await cloud.removeOrgSeat(d.orgId, d.seatId);
          sendImportExportResult(ws, true, 'Seat revoked.', 'org-seats');
        } catch (e) { sendImportExportResult(ws, false, 'Revoke seat failed: ' + e.message, 'org-seats'); }
      })();
      break;
    }

    // Website-hosted camera-session feeds (masked VDO join links, see /cameras/[token]
    // on the website) — thin passthrough so _pcamSources() can add them as a facecam group.
    case 'cloud_list_camera_feeds': {
      (async () => {
        try {
          if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_camera_feeds', data: { ok: false, message: 'Sign in to the cloud first.', feeds: [] } })); return; }
          const orgId = msg.data && msg.data.orgId;
          if (!orgId) { ws.send(JSON.stringify({ type: 'cloud_camera_feeds', data: { ok: false, message: 'No organization workspace.', feeds: [] } })); return; }
          const feeds = await cloud.listCameraFeeds(orgId);
          ws.send(JSON.stringify({ type: 'cloud_camera_feeds', data: { ok: true, feeds } }));
        } catch (e) { ws.send(JSON.stringify({ type: 'cloud_camera_feeds', data: { ok: false, message: e.message, feeds: [] } })); }
      })();
      break;
    }

    // Website-hosted Stations caster/observer VDO feeds (see /studio/access/stations on the
    // website) — thin passthrough so Camera Feeds can list them and the caster lineup can pull
    // caster-kind ones into the library, same pattern as cloud_list_camera_feeds above.
    case 'cloud_list_station_feeds': {
      (async () => {
        try {
          if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_station_feeds', data: { ok: false, message: 'Sign in to the cloud first.', feeds: [], shared: [] } })); return; }
          const orgId = msg.data && msg.data.orgId;
          if (!orgId) { ws.send(JSON.stringify({ type: 'cloud_station_feeds', data: { ok: false, message: 'No organization workspace.', feeds: [], shared: [] } })); return; }
          const { feeds, shared } = await cloud.listStationFeeds(orgId);
          ws.send(JSON.stringify({ type: 'cloud_station_feeds', data: { ok: true, feeds, shared } }));
        } catch (e) { ws.send(JSON.stringify({ type: 'cloud_station_feeds', data: { ok: false, message: e.message, feeds: [], shared: [] } })); }
      })();
      break;
    }

    case 'request_state':
      ws.send(JSON.stringify(getFullState()));
      break;

    // Client self-identifies its role so the pre-flight checklist can count live overlay
    // browser sources. 'overlay' = an OBS/browser overlay source; 'control' = the panel.
    case 'register': {
      const was = ws._role;
      ws._role = (msg.role === 'overlay' || msg.role === 'control') ? msg.role : 'unknown';
      ws._page = (typeof msg.page === 'string') ? msg.page.slice(0, 120) : '';
      if (ws._role === 'overlay' || was === 'overlay') maybeBroadcastOverlayCount();
      break;
    }

    // Client (overlay/sticky-logos.js) can restore vaulted "@img:<hash>" image refs → opt it into the
    // compact broadcast variant. Purely additive: without this the client always gets whole images.
    case 'imgvault_ready': { ws._imgvault = true; break; }

    case 'swap_teams': {
      // Swap names/logos
      const tempTeams = { ...state.teams.blue };
      state.teams.blue = { ...state.teams.orange };
      state.teams.orange = tempTeams;
      
      // Swap series scores
      const tempSeries = state.series.blue;
      state.series.blue = state.series.orange;
      state.series.orange = tempSeries;

      // Team records need no swapping now: both auto (stats/startgg) and manual (manualByName) are
      // keyed by team NAME, so they follow the team across the swap automatically.

      saveAppState();
      broadcastFullState();
      break;
    }

    case 'reset_all': {
      state.eventName = '';
      state.fontFamily = 'Industry';
      state.banner = { visible: false, images: [], captions: [], interval: 10, slant: 'right', header: '' };
      state.casters = { visible: true, list: [], lowerThird: '', library: [], vdo: { room: '', password: '' }, rooms: [], lineup: [], activeLayout: '', slotLabels: { 1: 'Caster 1', 2: 'Caster 2', 3: 'Caster 3', 4: 'Caster 4' } };
      state.breakScreen = { visible: false, title: 'STARTING SOON', message: '', endsAt: null };
      state.ticker = { visible: false, messages: [], speed: 40, source: 'manual', sponsor: '' };
      state.spotlight = { visible: false, playerName: '' };
      state.winner = { visible: false, side: '', name: '', logo: null, color: '', subtitle: '' };
      state.intro  = { visible: false, side: 'blue', title: '', style: 1, showFooter: false };
      state.veto   = { visible: false, title: state.veto.title || '', maps: [] };
      state.draft  = { ...state.draft, visible: false, ops: [], turn: null, complete: false };
      state.bestOf = 5;
      state.teams = {
        blue:   { name: 'BLUE TEAM',   logo: null, color: '#055fdb' },
        orange: { name: 'ORANGE TEAM', logo: null, color: '#e97139' }
      };
      state.series = { blue: 0, orange: 0 };
      state.game = { blueScore: 0, orangeScore: 0, time: 300, isOT: false, number: 1 };
      resetOvertimeTrigger();
      state.awaitingKickoff = false;
      state.view = 'hud';
      state.playerCache = {};
      state.players = [];

      saveAppState();
      broadcastFullState();
      break;
    }


    case 'set_startgg_settings': {
      const payload = msg.data || {};
      state.startgg.enabled = !!payload.enabled;
      state.startgg.tournamentSlug = (payload.tournamentSlug || '').trim();
      state.startgg.eventSlug = (payload.eventSlug || '').trim();
      state.startgg.setId = (payload.setId || '').trim();
      if (typeof payload.queueEnabled === 'boolean') state.startgg.queueEnabled = payload.queueEnabled;
      if (typeof payload.apiToken === 'string' && payload.apiToken.trim()) {
        startggApiToken = payload.apiToken.trim();
      }
      // Auto-enable queue polling when API is fully configured
      if (state.startgg.enabled && startggApiToken && state.startgg.tournamentSlug && payload.queueEnabled !== false) {
        state.startgg.queueEnabled = true;
      }
      saveAppState();
      broadcastFullState();
      applyStartggAutomation();
      if (startggApiToken) refreshAllMyEvents({ force: true }).catch(() => {});   // token just (re)set → sync My Events
      break;
    }

    case 'startgg_set_queue': {
      setStartggQueuePolling(!!msg.data?.enabled);
      break;
    }

    // Fully disconnect start.gg — clear the saved API token and turn the integration off. The normal
    // settings save treats an empty token as "keep current" (so re-saving other fields never wipes it),
    // so this explicit action is the only way to actually remove the token.
    case 'startgg_disconnect': {
      startggApiToken = '';
      state.startgg.enabled = false;
      state.startgg.connected = false;
      state.startgg.queueEnabled = false;
      state.startgg.lastError = '';
      if (typeof setStartggQueuePolling === 'function') setStartggQueuePolling(false);
      saveAppState();
      broadcastFullState();
      applyStartggAutomation();
      break;
    }

    case 'startgg_test_connection': {
      (async () => {
        try {
          if (!startggApiToken) {
            throw new Error('No API token saved. Enter and save your token first.');
          }

          console.log('[Start.gg Test] Starting test with token length:', startggApiToken.length);
          const user = await testStartGgConnection();
          state.startgg.connected = true;
          state.startgg.lastError = null;
          saveAppState();
          broadcastFullState();

          console.log('[Start.gg Test] SUCCESS:', user);
          ws.send(JSON.stringify({
            type: 'startgg-result',
            data: {
              ok: true,
              message: `✓ Connected as ${user.slug || user.id}`
            }
          }));
        } catch (e) {
          console.error('[Start.gg Test] FAILED:', e.message);
          state.startgg.connected = false;
          state.startgg.lastError = e.message;
          saveAppState();
          broadcastFullState();
          ws.send(JSON.stringify({
            type: 'startgg-result',
            data: {
              ok: false,
              message: e.message
            }
          }));
        }
      })();
      break;
    }

    case 'startgg_sync_set': {
      (async () => {
        try {
          const setId = (msg.data?.setId || state.startgg.setId || '').trim();
          const result = await syncStartGgSet(setId);
          ws.send(JSON.stringify({
            type: 'startgg-result',
            data: {
              ok: true,
              message: `Synced set ${result.setId}`,
              details: result
            }
          }));
        } catch (e) {
          state.startgg.lastSyncStatus = 'error';
          state.startgg.lastError = e.message;
          saveAppState();
          broadcastFullState();
          ws.send(JSON.stringify({
            type: 'startgg-result',
            data: {
              ok: false,
              message: e.message
            }
          }));
        }
      })();
      break;
    }

    // Which source drives the upcoming/schedule board: 'event' (stream queue) or 'team' (team search).
    // Sent when the producer switches the Stream Queue tab.
    case 'startgg_set_upcoming_mode': {
      const mode = ['team', 'manual'].includes(msg.data && msg.data.mode) ? msg.data.mode : 'event';
      state.upcoming.source = mode;
      // event → overlay shows the live stream queue (+ a couple non-stream extras, filled next poll).
      // team → clear until a team search populates it (so stale event extras don't show as "team").
      // manual → detached from start.gg entirely; the poll never touches the board (Clear uses this).
      state.upcoming.matches = (mode === 'event') ? buildEventUpcomingExtras(state.startgg.queue, []) : [];
      // Leaving team mode drops the single-team focus so the bracket overlay shows the FULL event again
      // (a team search sets startgg.focusTeam; nothing cleared it, so the bracket stayed stuck on that team).
      if (mode !== 'team') state.startgg.focusTeam = '';
      saveAppState();
      broadcastFullState();
      break;
    }

    // ── Start.gg stream queue (marked-for-stream matches) ────────────────
    case 'startgg_fetch_queue': {
      (async () => {
        try {
          if (msg.data?.tournamentSlug) state.startgg.tournamentSlug = msg.data.tournamentSlug.trim();
          const r = await fetchStreamQueue(state.startgg.tournamentSlug);
          saveAppState();
          ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: true, message: `Loaded ${r.count} queued set(s) across ${r.streams.length} stream(s).` } }));
        } catch (e) {
          state.startgg.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }
    case 'startgg_fetch_team_queue': {
      (async () => {
        try {
          const { teamName, tournamentSlug } = msg.data || {};
          if (tournamentSlug) state.startgg.tournamentSlug = tournamentSlug.trim();
          const r = await fetchTeamQueue(teamName, state.startgg.tournamentSlug);
          ws.send(JSON.stringify({ type: 'startgg-team-result', data: { ok: true, message: `Found ${r.count} match(es).` } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'startgg-team-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'startgg_push_set': {
      (async () => {
        try {
          const setId = (msg.data?.setId || '').trim();
          if (!setId) throw new Error('No set selected');
          const result = await syncStartGgSet(setId);
          state.startgg.lastPushedSetId = setId;
          ensureOnAirLiveInFeed();   // show the just-pushed match as LIVE in the ticker right away
          if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: true, message: `Pushed ${result.entrants.join(' vs ') || setId} to overlay` } }));
        } catch (e) {
          state.startgg.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'startgg_set_autofollow': {
      if (typeof msg.data?.streamName === 'string') state.startgg.streamName = msg.data.streamName;
      setStartggAutoFollow(!!msg.data?.enabled);
      if (state.startgg.autoFollow) setActivePlatform('startgg');   // silence Challonge / NXGEN follow
      if (state.startgg.autoFollow && !state.startgg.queueEnabled && startggApiToken && state.startgg.tournamentSlug) {
        setStartggQueuePolling(true);
      }
      ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: true, message: state.startgg.autoFollow ? 'Auto-follow ON — pushing the live set automatically.' : 'Auto-follow off.' } }));
      break;
    }

    // ── Challonge ───────────────────────────────────────────────────────────

    case 'set_challonge_settings': {
      const p = msg.data || {};
      state.challonge.enabled = !!p.enabled;
      state.challonge.tournamentSlug = (p.tournamentSlug || '').trim();
      if (typeof p.apiKey === 'string' && p.apiKey.trim()) challongeApiKey = p.apiKey.trim();
      saveAppState();
      broadcastFullState();
      if (state.challonge.enabled && challongeApiKey && state.challonge.tournamentSlug) {
        setChallongePolling(true);
      }
      break;
    }

    case 'set_challonge_auto_follow': {
      state.challonge.autoFollow = !!msg.data?.enabled;
      if (state.challonge.autoFollow) setActivePlatform('challonge');   // silence start.gg / NXGEN follow
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'cloud_email_login': {
      (async () => {
        try {
          const d = msg.data || {};
          const data = await cloud.loginWithEmail({ email: (d.email || '').trim(), password: d.password || '' });
          const cu = (data && data.user) || {};
          state.discord.connected = true;
          state.discord.userId = cu.discordId || '';
          state.discord.username = cu.username || (d.email || '').split('@')[0];
          state.discord.discriminator = '0';
          state.discord.globalName = cu.globalName || cu.username || (d.email || '').split('@')[0];
          state.discord.avatarUrl = cu.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
          saveDiscordUser();
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'cloud-email-login', data: { ok: true, message: 'Signed in as ' + state.discord.globalName } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'cloud-email-login', data: { ok: false, message: (e && e.message) || 'Login failed' } }));
        }
      })();
      break;
    }

    case 'clear_active_event': {
      state.activeEvent = { platform: null, slug: '', name: '', gameName: '', numEntrants: 0, format: '', url: '', loadedAt: null };
      // Clearing the event clears its DOWNSTREAM feeds too — the stream queue kept
      // polling and repopulating boards after the event was supposedly gone.
      state.startgg.queue = [];
      state.startgg.eventSlug = '';
      state.startgg.selectedEvent = null;
      state.startgg.matchFeed = [];
      if (state.ticker.source === 'startgg') state.ticker.feed = [];
      setStartggQueuePolling(false);   // stops the poll timer + persists queueEnabled=false
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'challonge_test_connection': {
      (async () => {
        try {
          const client = createChallongeClient(challongeApiKey);
          await client.get('/tournaments.json', { state: 'all', per_page: 1 });
          state.challonge.connected = true;
          state.challonge.lastError = null;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: 'Connected to Challonge successfully.' } }));
        } catch (e) {
          state.challonge.connected = false;
          state.challonge.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'load_challonge_tournament': {
      const slug = (msg.data?.slug || state.challonge.tournamentSlug || '').trim();
      if (!slug) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'No tournament slug provided.' } })); break; }
      if (!challongeApiKey) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'Challonge API key not configured.' } })); break; }
      (async () => {
        try {
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: 'Loading tournament…', loading: true } }));
          const result = await loadChalongeTournament(slug);
          saveAppState();
          setChallongePolling(true);
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: `Loaded "${result.name}" — ${result.teamsCount} teams, ${result.matchesCount} matches.`, loaded: true } }));
        } catch (e) {
          state.challonge.connected = false;
          state.challonge.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'challonge_refresh': {
      (async () => {
        try {
          await refreshChallongeLive();
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: 'Bracket refreshed.' } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'challonge_push_match': {
      const { matchId, scoreA, scoreB, winnerId } = msg.data || {};
      if (!matchId) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'matchId required.' } })); break; }
      if (!challongeApiKey) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'Challonge API key not configured.' } })); break; }
      const slug = state.challonge.tournamentSlug;
      if (!slug) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'No tournament loaded.' } })); break; }
      (async () => {
        try {
          const client = createChallongeClient(challongeApiKey);
          const body = { match: { scores_csv: `${scoreA || 0}-${scoreB || 0}` } };
          if (winnerId) body.match.winner_id = winnerId;
          await client.put(`/tournaments/${slug}/matches/${matchId}.json`, body);
          await refreshChallongeLive();
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: `Match ${matchId} updated.` } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'import_challonge_teams': {
      const slug = (msg.data?.slug || state.challonge.tournamentSlug || '').trim();
      if (!slug || !challongeApiKey) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'API key and tournament slug required.' } })); break; }
      (async () => {
        try {
          const client = createChallongeClient(challongeApiKey);
          const pData = await client.get(`/tournaments/${slug}/participants.json`);
          const partMap = challongePartMap(pData);
          let added = 0;
          Object.values(partMap).forEach((p) => {
            const existing = savedTeams.find((t) => t.name.toLowerCase() === p.name.toLowerCase());
            if (!existing) { savedTeams.push({ name: p.name, logo: p.logo || null, players: [] }); added++; }
          });
          saveTeams();
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: `Imported ${added} new teams (${pData.length} total participants).` } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'link_event_challonge': {
      const { eventId, challongeSlug, enabled = true } = msg.data || {};
      const evLink = (Array.isArray(state.myEvents) ? state.myEvents : []).find(e => e.id === eventId);
      if (!evLink) { ws.send(JSON.stringify({ type: 'link-result', data: { ok: false, message: 'Event not found.' } })); break; }
      if (!challongeApiKey) { ws.send(JSON.stringify({ type: 'link-result', data: { ok: false, message: 'Add Challonge API key in Settings first.' } })); break; }
      const lSlug = (challongeSlug || '').trim();
      if (!lSlug) { ws.send(JSON.stringify({ type: 'link-result', data: { ok: false, message: 'No tournament slug provided.' } })); break; }
      (async () => {
        try {
          ws.send(JSON.stringify({ type: 'link-result', data: { ok: true, message: 'Building participant map…', loading: true } }));
          const participantMap = await buildChallongeParticipantMap(lSlug);
          const count = Object.keys(participantMap).length;
          const prevPushed = (evLink.challongeSync && evLink.challongeSync.slug === lSlug) ? evLink.challongeSync.pushedMatches || {} : {};
          evLink.challongeSync = { slug: lSlug, enabled: !!enabled, participantMap, pushedMatches: prevPushed, lastSyncAt: null, lastError: null };
          saveAppState();
          broadcastFullState();
          syncLinkedChallongeTournament(evLink).catch(() => {});
          ws.send(JSON.stringify({ type: 'link-result', data: { ok: true, message: `Linked to challonge.com/${lSlug} — ${count} participants mapped.`, linked: true } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'link-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'unlink_event_challonge': {
      const { eventId: ulEvId } = msg.data || {};
      const evUnlink = (Array.isArray(state.myEvents) ? state.myEvents : []).find(e => e.id === ulEvId);
      if (evUnlink) { delete evUnlink.challongeSync; saveAppState(); broadcastFullState(); }
      ws.send(JSON.stringify({ type: 'link-result', data: { ok: true, message: 'Auto-sync unlinked.', unlinked: true } }));
      break;
    }

    case 'toggle_challonge_sync': {
      const { eventId: tsEvId, enabled: tsEnabled } = msg.data || {};
      const evToggle = (Array.isArray(state.myEvents) ? state.myEvents : []).find(e => e.id === tsEvId);
      if (evToggle && evToggle.challongeSync) { evToggle.challongeSync.enabled = !!tsEnabled; saveAppState(); broadcastFullState(); }
      break;
    }

    // ── NXGEN ────────────────────────────────────────────────────────────
    case 'set_nxgen_settings': {
      const p = msg.data || {};
      state.nxgen.enabled = !!p.enabled;
      state.nxgen.eventSlug = (p.eventSlug || '').trim();
      if (typeof p.apiKey === 'string' && p.apiKey.trim()) nxgenApiKey = p.apiKey.trim();
      saveAppState();
      broadcastFullState();
      if (state.nxgen.enabled && nxgenApiKey && state.nxgen.eventSlug) setNxgenPolling(true);
      break;
    }

    case 'set_nxgen_auto_follow': {
      state.nxgen.autoFollow = !!msg.data?.enabled;
      if (state.nxgen.autoFollow) setActivePlatform('nxgen');   // silence start.gg / Challonge follow
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'nxgen_test_connection': {
      (async () => {
        try {
          await getNxgenEvents(nxgenApiKey, { limit: 1 });
          state.nxgen.connected = true;
          state.nxgen.lastError = null;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: 'Connected to NXGEN successfully.' } }));
        } catch (e) {
          state.nxgen.connected = false;
          state.nxgen.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'load_nxgen_event': {
      const slug = (msg.data?.slug || state.nxgen.eventSlug || '').trim();
      if (!slug) { ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: 'No event slug provided.' } })); break; }
      if (!nxgenApiKey) { ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: 'NXGEN API key not configured — add it in Settings → Integrations.' } })); break; }
      (async () => {
        try {
          ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: 'Loading event…', loading: true } }));
          const result = await loadNxgenEvent(slug);
          saveAppState();
          broadcastFullState();
          setNxgenPolling(state.nxgen.enabled);
          ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: `Loaded "${result.name}" — ${result.teamsCount} participants, ${result.matchesCount} matches.`, loaded: true } }));
        } catch (e) {
          state.nxgen.connected = false;
          state.nxgen.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'nxgen_refresh': {
      (async () => {
        try {
          await refreshNxgenLive();
          ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: 'Event refreshed.' } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'nxgen_import_teams': {
      (async () => {
        try {
          const teams = state.nxgen.eventTeams || [];
          if (!teams.length) throw new Error('No participants loaded — load an event first.');
          let added = 0;
          teams.forEach(t => {
            const existing = savedTeams.find(s => s.name.toLowerCase() === (t.name || '').toLowerCase());
            if (!existing) { savedTeams.push({ name: t.name, logo: t.logo || null, players: [] }); added++; }
          });
          saveTeams();
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: `${added} new team${added !== 1 ? 's' : ''} added to library.` } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'set_obs_autoswitch': {
      if (typeof msg.data?.autoSwitch === 'boolean') {
        state.obs.autoSwitch = msg.data.autoSwitch;
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    // ── RL scene automation (Match ▸ Teams panel) — opt-in kickoff + post-game OBS scene cuts ─────
    case 'set_rl_scene_automation': {
      const p = msg.data || {};
      if (p.kickoff && typeof p.kickoff === 'object') {
        state.obs.kickoff = {
          enabled: !!p.kickoff.enabled,
          scene: typeof p.kickoff.scene === 'string' ? p.kickoff.scene.trim() : '',
          transition: typeof p.kickoff.transition === 'string' ? p.kickoff.transition.trim() : ''
        };
      }
      if (p.postGame && typeof p.postGame === 'object') {
        state.obs.postGame = {
          enabled: !!p.postGame.enabled,
          scene: typeof p.postGame.scene === 'string' ? p.postGame.scene.trim() : '',
          delaySec: Math.max(1, Math.min(120, Math.round(Number(p.postGame.delaySec) || 20))),
          transition: typeof p.postGame.transition === 'string' ? p.postGame.transition.trim() : ''
        };
      }
      saveAppState();
      broadcastFullState();
      break;
    }

    // Post-game stats screen skin (RL scoreboard) — show/hide the stat table + pick its design.
    case 'set_rl_stats_screen': {
      const p = msg.data || {};
      const DESIGNS = ['default', 'glass', 'block', 'radar'];
      const cur = state.rlStatsScreen || { showStats: true, design: 'default' };
      state.rlStatsScreen = {
        showStats: typeof p.showStats === 'boolean' ? p.showStats : cur.showStats,
        design: DESIGNS.includes(p.design) ? p.design : cur.design
      };
      saveAppState();
      broadcastFullState();
      break;
    }

    // Manual "clear the post-game board now" (it otherwise holds until the next kickoff).
    case 'clear_scoreboard': {
      clearPostGameBoard();
      break;
    }

    case 'set_rl_hide_ui': {
      state.rlHudHidden = !!(msg.data && msg.data.hidden);
      broadcastFullState();
      break;
    }

    // Stream-credits "credit sponsors" — the dedicated big call-out list in the end roll.
    // (set_credits is handled by the registry entry above — it shadows any case here.)

    // ── OBS WebSocket ────────────────────────────────────────────────────
    case 'set_obs_settings': {
      const payload = msg.data || {};
      const wasEnabled = state.obs.enabled;

      state.obs.enabled = !!payload.enabled;
      if (typeof payload.url === 'string' && payload.url.trim()) {
        state.obs.url = payload.url.trim();
      }
      if (typeof payload.autoSwitch === 'boolean') {
        state.obs.autoSwitch = payload.autoSwitch;
      }
      if (typeof payload.autoReplayOnGoal === 'boolean') {
        state.obs.autoReplayOnGoal = payload.autoReplayOnGoal;
      }
      if (typeof payload.postGameToCastersSec === 'number') {
        state.obs.postGameToCastersSec = Math.max(0, Math.min(120, Math.round(payload.postGameToCastersSec)));
      }
      // state.obs.kickoff is intentionally NOT settable from here — it's owned exclusively by
      // 'set_rl_scene_automation' (Match — Teams gear panel). This handler used to also accept a
      // `kickoff` field, which a hidden/unreachable duplicate control on this page sent on every
      // save with default (disabled) values, silently resetting the real setting each time.
      if (payload.scenes && typeof payload.scenes === 'object') {
        state.obs.scenes = { ...state.obs.scenes, ...payload.scenes };
      }
      if (typeof payload.password === 'string' && payload.password.trim()) {
        obsPassword = payload.password.trim();
      } else if (payload.clearPassword) {
        obsPassword = '';
      }

      saveAppState();
      broadcastFullState();

      // Apply connection state to match the new settings
      if (state.obs.enabled) {
        setupObsClient();
        connectObs();
      } else if (wasEnabled) {
        disconnectObs();
      }
      break;
    }

    // ── vMix (full alternative production backend) ──────────────────────────
    case 'set_vmix_settings': {
      const p = msg.data || {};
      if (typeof p.enabled === 'boolean') state.vmix.enabled = p.enabled;
      if (typeof p.host === 'string' && p.host.trim()) state.vmix.host = p.host.trim();
      if (typeof p.port === 'number' && p.port > 0) state.vmix.port = Math.max(1, Math.min(65535, Math.round(p.port)));
      if (!state.vmix.enabled) { state.vmix.connected = false; state.vmix.lastError = null; }
      saveAppState();
      broadcastFullState();
      if (state.vmix.enabled) pollVmix().catch(() => {});   // immediate connect attempt
      break;
    }

    // Pick the live production backend (mutually exclusive — vMix is a full alternative to OBS).
    case 'set_switcher_target': {
      state.switcher.target = (msg.data && msg.data.target) === 'vmix' ? 'vmix' : 'obs';
      saveAppState();
      broadcastFullState();
      break;
    }

    // ── Producer Switcher page (program/preview + take + audio, routed by backend) ──
    case 'switcher_watch': {
      _switcherWatching = !!(msg.data && msg.data.on);
      if (_switcherWatching) { pollObsPreview().catch(() => {}); pollVmix().catch(() => {}); }
      break;
    }
    case 'switcher_set_preview': switcherSetPreview((msg.data && msg.data.name) || '').catch(() => {}); break;
    case 'switcher_take': switcherTake((msg.data && msg.data.transition) || 'Cut', Number(msg.data && msg.data.duration) || 0).catch(() => {}); break;
    case 'switcher_stream': switcherStream(!!(msg.data && msg.data.on)); break;
    case 'switcher_record': switcherRecord(!!(msg.data && msg.data.on)); break;
    case 'switcher_ftb': switcherFtb(); break;
    case 'switcher_replay': switcherReplay().catch(() => {}); break;
    case 'switcher_studio_mode': {
      (async () => {
        if (obsClient && obsClient.isConnected()) {
          try { await obsClient.call('SetStudioModeEnabled', { studioModeEnabled: !!(msg.data && msg.data.on) }); state.obs.studioMode = !!(msg.data && msg.data.on); broadcastFullState(); } catch (e) {}
        }
      })();
      break;
    }
    case 'switcher_audio_set': switcherAudioSet((msg.data && msg.data.id), msg.data || {}).catch(() => {}); break;
    case 'switcher_audio_list': {
      (async () => {
        // vMix audio already rides in state.vmix.inputs; this is the OBS side.
        if (state.switcher.target === 'vmix' || !obsClient || !obsClient.isConnected()) { ws.send(JSON.stringify({ type: 'switcher-audio', data: { backend: state.switcher.target, sources: [] } })); return; }
        try {
          const list = await obsClient.call('GetInputList');
          const inputs = (list && list.inputs) || [];
          const out = [];
          for (const inp of inputs) {
            const name = inp.inputName;
            try {
              const vol = await obsClient.call('GetInputVolume', { inputName: name });
              const mute = await obsClient.call('GetInputMute', { inputName: name });
              out.push({ name, volumeDb: vol && typeof vol.inputVolumeDb === 'number' ? vol.inputVolumeDb : 0, muted: !!(mute && mute.inputMuted) });
            } catch (e) { /* input without audio — skip */ }
          }
          ws.send(JSON.stringify({ type: 'switcher-audio', data: { backend: 'obs', sources: out } }));
        } catch (e) { ws.send(JSON.stringify({ type: 'switcher-audio', data: { backend: 'obs', sources: [], error: e.message } })); }
      })();
      break;
    }
    case 'switcher_screenshot': {
      (async () => {
        const name = (msg.data && msg.data.name || '').trim();
        if (!obsClient || !obsClient.isConnected() || !name) { ws.send(JSON.stringify({ type: 'switcher-screenshot', data: { ok: false, name } })); return; }
        try {
          const r = await obsClient.call('GetSourceScreenshot', { sourceName: name, imageFormat: 'jpg', imageWidth: 320, imageHeight: 180, imageCompressionQuality: 40 });
          ws.send(JSON.stringify({ type: 'switcher-screenshot', data: { ok: !!(r && r.imageData), name, img: (r && r.imageData) || null } }));
        } catch (e) { ws.send(JSON.stringify({ type: 'switcher-screenshot', data: { ok: false, name } })); }
      })();
      break;
    }

    // Fire an arbitrary vMix function from the UI (test button / power actions).
    case 'vmix_call': {
      const p = msg.data || {};
      if (p.function) (async () => { const r = await vmixDo(p.function, p.params || {}); if (!r.ok) broadcastFullState(); })();
      break;
    }

    // Quick connection test — used by the Settings "Test" button.
    case 'vmix_test_connection': {
      (async () => {
        try {
          const s = await vmix.vmixState(state.vmix.host, state.vmix.port);
          state.vmix.connected = true; state.vmix.lastError = null;
          Object.assign(state.vmix, { version: s.version, edition: s.edition, inputs: s.inputs, overlays: s.overlays, active: s.active, preview: s.preview, streaming: s.streaming, recording: s.recording });
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'vmix-result', data: { ok: true, message: `Connected — vMix ${s.version} (${s.edition}), ${s.inputs.length} input(s).`, inputs: s.inputs } }));
        } catch (e) {
          state.vmix.connected = false;
          state.vmix.lastError = e.code === 'ECONNREFUSED' ? 'vMix not reachable (running with Web API on?)' : e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'vmix-result', data: { ok: false, message: state.vmix.lastError } }));
        }
      })();
      break;
    }

    case 'obs_test_connection': {
      (async () => {
        if (!createObsClient) {
          ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: 'OBS integration not available in this build.' } }));
          return;
        }
        // Share any in-flight connect started by set_obs_settings; don't start a second concurrent one.
        const ok = await connectObs();
        const scenes = state.obs.availableScenes || [];
        ws.send(JSON.stringify({
          type: 'obs-result',
          data: ok
            ? { ok: true, message: `Connected — found ${scenes.length} scene(s).`, scenes }
            : { ok: false, message: state.obs.lastError || 'Connection failed.' }
        }));
      })();
      break;
    }

    case 'obs_refresh_scenes': {
      (async () => {
        if (!obsClient || !obsClient.isConnected()) {
          ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: 'Not connected to OBS.' } }));
          return;
        }
        const scenes = filterSwitchableScenes(await obsClient.getScenes());
        state.obs.availableScenes = scenes;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'obs-result', data: { ok: true, message: `Refreshed — ${scenes.length} scene(s).`, scenes } }));
      })();
      break;
    }

    case 'obs_switch_scene': {
      const sceneName = (msg.data && msg.data.sceneName || '').trim();
      // A manual cut cancels any pending auto post-game→casters or countdown→scene switch.
      if (_postGameTimer) { clearTimeout(_postGameTimer); _postGameTimer = null; }
      clearBreakAutoSwitch();
      // Route through the active backend (OBS scene name or vMix input) — one path, both switchers.
      if (sceneName) switcherCut(sceneName);
      break;
    }

    // Commercial break — cut to the Commercial scene (auto-returns when the video ends).
    case 'obs_start_commercial': {
      const r = startCommercial();
      ws.send(JSON.stringify({ type: 'obs-result', data: r }));
      break;
    }
    case 'obs_end_commercial': {
      ws.send(JSON.stringify({ type: 'obs-result', data: endCommercial() }));
      break;
    }
    case 'obs_toggle_commercial': {
      ws.send(JSON.stringify({ type: 'obs-result', data: state.commercial.active ? endCommercial() : startCommercial() }));
      break;
    }
    case 'set_commercial_auto_return': {
      state.obs.commercialAutoReturn = !!(msg.data && msg.data.enabled);
      saveAppState();
      broadcastFullState();
      break;
    }

    // Floating OBS program preview — a JPEG screenshot of the live program scene.
    // (OBS WebSocket can't stream video; this polls a low-res still on request.)
    case 'obs_screenshot': {
      (async () => {
        if (!obsClient || !obsClient.isConnected()) {
          ws.send(JSON.stringify({ type: 'obs-screenshot', data: { ok: false, reason: 'OBS not connected' } }));
          return;
        }
        const scene = obsClient.getCurrentScene();
        if (!scene) { ws.send(JSON.stringify({ type: 'obs-screenshot', data: { ok: false, reason: 'No program scene' } })); return; }
        const width = Math.min(960, Math.max(160, Number(msg.data?.width) || 480));
        const r = await obsClient.call('GetSourceScreenshot', {
          sourceName: scene, imageFormat: 'jpg', imageWidth: width, imageCompressionQuality: 40
        });
        ws.send(JSON.stringify({ type: 'obs-screenshot', data: { ok: !!(r && r.imageData), img: (r && r.imageData) || null, scene } }));
      })();
      break;
    }

    // Ensure OBS's Virtual Camera output is running (so the OBS Program preview can show a smooth
    // live feed). msg.data.on === false stops it; default is "start if not already active".
    case 'obs_virtualcam': {
      (async () => {
        if (!obsClient || !obsClient.isConnected()) {
          ws.send(JSON.stringify({ type: 'obs-virtualcam', data: { ok: false, reason: 'OBS not connected' } }));
          return;
        }
        try {
          const want = !(msg.data && msg.data.on === false);
          let active = false;
          try { active = !!(await obsClient.call('GetVirtualCamStatus')).outputActive; } catch (e) {}
          if (want && !active) { await obsClient.call('StartVirtualCam'); active = true; }
          else if (!want && active) { await obsClient.call('StopVirtualCam'); active = false; }
          ws.send(JSON.stringify({ type: 'obs-virtualcam', data: { ok: true, active } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'obs-virtualcam', data: { ok: false, reason: (e && e.message) || 'Virtual camera unavailable' } }));
        }
      })();
      break;
    }

    case 'obs_save_replay': {
      (async () => {
        if (!obsClient || !obsClient.isConnected()) {
          ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: 'Not connected to OBS.' } }));
          return;
        }
        const active = await obsClient.isReplayBufferActive();
        if (!active) {
          ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: 'Replay Buffer is not running — start it first (in OBS or the button here).' } }));
          return;
        }
        const ok = await obsClient.saveReplayBuffer();
        ws.send(JSON.stringify({
          type: 'obs-result',
          data: { ok, message: ok ? '✓ Replay clip saved.' : (obsClient.getLastError() || 'Failed to save replay.') }
        }));
      })();
      break;
    }

    case 'obs_toggle_replay_buffer': {
      (async () => {
        if (!obsClient || !obsClient.isConnected()) {
          ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: 'Not connected to OBS.' } }));
          return;
        }
        const active = await obsClient.isReplayBufferActive();
        const ok = active ? await obsClient.stopReplayBuffer() : await obsClient.startReplayBuffer();
        ws.send(JSON.stringify({
          type: 'obs-result',
          data: { ok, message: ok ? (active ? 'Replay Buffer stopped.' : 'Replay Buffer started.') : (obsClient.getLastError() || 'Failed to toggle Replay Buffer.') }
        }));
      })();
      break;
    }

    // ── Replay to screen (browser source) ───────────────────────────────
    case 'replay_play': {
      const p = msg.data || {};
      // 'preview'/'program' are the two fixed buses; a playlist given its OWN dedicated browser
      // source (replay-player.html?playlist=<id>) sends bus:'pl_<id>' — that must pass through
      // as-is, not collapse into 'program', or the dedicated source never receives anything (the
      // whole point of giving it its own bus is independence from the main program output).
      const bus = (typeof p.bus === 'string' && p.bus.trim()) ? p.bus.trim() : 'program';
      const rawUrl = typeof p.url === 'string' ? p.url.trim() : '';
      if (!rawUrl) {
        ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: 'No replay URL to play.' } }));
        break;
      }

      const commit = (url) => {
        state.replay[bus] = {
          url,
          name: typeof p.name === 'string' ? p.name : '',
          loop: !!p.loop,
          playing: true,
          trimIn: typeof p.trimIn === 'number' ? p.trimIn : 0,
          trimOut: typeof p.trimOut === 'number' ? p.trimOut : null,
          // transition is a tiny string and safe to persist in full_state; the logo image is
          // forwarded only on this live message (never stored) so no blob enters the broadcast.
          transition: typeof p.transition === 'string' ? p.transition : 'cut'
        };
        broadcast(bridgeClients, { type: 'replay_play', data: { bus, ...state.replay[bus], transitionLogo: typeof p.transitionLogo === 'string' ? p.transitionLogo : '', stinger: typeof p.stinger === 'string' ? p.stinger : '' } });
        broadcastFullState();
        // User-triggered replay — switch OBS to the target scene.
        // p.scene comes from the "Program scene" dropdown on the Replays page (or per-playlist override).
        // Falls back to the globally-mapped 'replay' scene key in OBS settings.
        // Note: we bypass obsSwitch() here intentionally — this is a manual producer action,
        // not an automatic game-event switch, so OBS_AUTO_SWITCH_DISABLED must not block it.
        if (bus === 'program') {
          const sc = (typeof p.scene === 'string' ? p.scene.trim() : '')
            || (state.obs && state.obs.scenes && state.obs.scenes.replay || '').trim();
          if (sc && obsClient && obsClient.isConnected()) { obsClient.switchScene(sc); }
        }
      };

      // Raw replay-buffer/highlight clips are often H.264 High-Profile with heavy B-frame usage —
      // fine for storage, expensive for OBS's own Browser Source (CEF) to decode in real time
      // (continuous lag/dropped frames a normal browser tab doesn't show). Transparently swap in a
      // fast, decode-friendly baseline transcode before going to air — cached by source path, so
      // repeat pushes of the same clip are instant. Montage exports (a different URL/route, already
      // a normal CRF encode) skip this; only the raw /api/clips/file route is affected.
      const clipMatch = /^(.*)\/api\/clips\/file\?(?:.*&)?path=([^&]+)/.exec(rawUrl);
      const clipPath = clipMatch ? (() => { try { return decodeURIComponent(clipMatch[2]); } catch (e) { return null; } })() : null;
      if (clipPath && clipSystem) {
        if (!clipSystem.isAirPrepReady(clipPath)) {
          ws.send(JSON.stringify({ type: 'replay_preparing', data: { bus } }));
        }
        clipSystem.prepareForAir(clipPath).then((preparedPath) => {
          const url = (preparedPath === clipPath) ? rawUrl : `${clipMatch[1]}/api/clips/file?path=${encodeURIComponent(preparedPath)}`;
          commit(url);
        }).catch(() => commit(rawUrl));
      } else {
        commit(rawUrl);
      }
      break;
    }

    case 'replay_stop': {
      const p = msg.data || {};
      const bus = (typeof p.bus === 'string' && p.bus.trim()) ? p.bus.trim() : 'program';
      state.replay[bus] = { url: '', name: '', loop: false, playing: false };
      broadcast(bridgeClients, { type: 'replay_stop', data: { bus } });
      broadcastFullState();
      break;
    }

    // Promote whatever is in Preview to Program (the multiview "take" action).
    case 'replay_take': {
      const p = msg.data || {};
      state.replay.program = { ...state.replay.preview };
      // Apply the transition the producer picked so the take eases to air (not a hard cut).
      if (typeof p.transition === 'string') state.replay.program.transition = p.transition;
      broadcast(bridgeClients, { type: 'replay_play', data: { bus: 'program', ...state.replay.program, transitionLogo: typeof p.transitionLogo === 'string' ? p.transitionLogo : '' } });
      broadcastFullState();
      break;
    }

    // The replay-player overlay reports its own playback so the producer panel can show
    // time-remaining and return to the prior scene when a replay ends. Pure relay — these
    // are transient and never touch persisted state or full_state.
    case 'replay_progress':
    case 'replay_ended': {
      broadcast(bridgeClients, { type: msg.type, data: msg.data || {} });
      break;
    }

    // (set_upcoming / set_standings migrated to the WS_HANDLERS registry above handleControlMessage)

    // ── Unified graphics overlay (gfx.html) active scene ─────────────────
    case 'set_gfx_active': {
      const scene = (msg.data && msg.data.scene) || null;
      state.gfxActive = scene && typeof scene === 'string' ? scene : null;
      // Single-select for the exclusive punch-up graphics. gfx.html only ever RENDERS one layer
      // (state.gfxActive), but each graphic also carries its own .visible flag, and the various push
      // surfaces (qrail Put-On-Air, deck, flows, main Push Live) set/clear only their own flag — so
      // several graphics could read "on air" (green) at once even though just one is showing. Mirror
      // .visible to gfxActive here, in the ONE place every push routes through: the active layer's
      // flag on, all other exclusive layers off. Persistent overlays (Ticker, Sponsor, Casters/Desk,
      // Teams-to-Watch) are deliberately NOT in this map — they're meant to stack alongside a graphic.
      const GFX_EXCLUSIVE_VISIBLE = {
        break: 'breakScreen', winner: 'winner', intro: 'intro', veto: 'veto', draft: 'draft',
        bracket: 'bracket', schedule: 'upcoming', upcoming: 'upcoming', standings: 'standings', credits: 'credits'
        // matchup has no independent .visible flag (it's active purely via gfxActive) — nothing to clear.
        // The spotlight/watchlist/teamSpotlight family is deliberately left out: the gfx key 'spotlight'
        // is wired to watchlist.visible in one surface and spotlight.visible in another, so auto-clearing
        // by key could hide the one that's actually live. They're niche and stay independent.
      };
      const activeObj = GFX_EXCLUSIVE_VISIBLE[state.gfxActive] || null;
      Object.keys(GFX_EXCLUSIVE_VISIBLE).forEach((k) => {
        const objName = GFX_EXCLUSIVE_VISIBLE[k];
        if (objName === activeObj) return;                       // leave the now-active layer alone
        const o = state[objName];
        if (o && typeof o === 'object' && o.visible) o.visible = false;
      });
      if (activeObj && state[activeObj] && typeof state[activeObj] === 'object') state[activeObj].visible = true;
      broadcastFullState();
      break;
    }

    // (set_watchlist / toggle_watchlist_team / set_team_spotlight migrated to the WS_HANDLERS registry above handleControlMessage)

    // ── Bracket ──────────────────────────────────────────────────────────
    case 'set_bracket_settings': {
      const p = msg.data || {};
      if (typeof p.eventSlug === 'string') {
        state.bracket.eventSlug = p.eventSlug.trim();
        // Typing a slug that ISN'T the active event = explicit override → stop following the
        // active event. Clearing it (or matching the active event) resumes following.
        state.bracket.followActive = !state.bracket.eventSlug
          || state.bracket.eventSlug === (state.startgg.eventSlug || '').trim();
      }
      if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
      // Overlay view mode — drives the single bracket source + the live preview.
      if (typeof p.view === 'string' && ['both', 'winners', 'losers', 'finals', 'schedule', 'standings', 'matrix'].includes(p.view)) state.bracket.view = p.view;
      if (p.rounds != null) { const n = parseInt(p.rounds, 10); if (Number.isFinite(n) && n >= 1 && n <= 20) state.bracket.rounds = n; }
      if (typeof p.title === 'string') state.bracket.title = p.title.slice(0, 120);
      if (typeof p.subtitle === 'string') state.bracket.subtitle = p.subtitle.slice(0, 140);
      if (typeof p.showRecord === 'boolean') state.bracket.showRecord = p.showRecord;
      saveAppState();
      broadcastFullState();
      if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
      break;
    }

    // ─── Flow CRUD ────────────────────────────────────────────────────────────
    case 'save_flow': {
      const flow = msg.data;
      if (!flow || !flow.id) break;
      const idx = state.flows.findIndex(f => f.id === flow.id);
      if (idx >= 0) state.flows[idx] = flow;
      else state.flows.push(flow);
      _syncFlowIntervals();
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'delete_flow': {
      const id = msg.data && msg.data.id;
      if (!id) break;
      if (_flowSeqState[id]) { clearTimeout(_flowSeqState[id].timeoutHandle); delete _flowSeqState[id]; }
      state.flows = state.flows.filter(f => f.id !== id);
      _syncFlowIntervals();
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'toggle_flow': {
      const id = msg.data && msg.data.id;
      const f = id && state.flows.find(f => f.id === id);
      if (f) {
        f.enabled = !f.enabled;
        if (!f.enabled && _flowSeqState[id]) { clearTimeout(_flowSeqState[id].timeoutHandle); delete _flowSeqState[id]; }
        _syncFlowIntervals();
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    case 'fire_flow_manual': {
      const id = msg.data && msg.data.id;
      flowBus.emit('manual', { flowId: id || '' });
      break;
    }

    case 'reset_flow_var': {
      const varName = msg.data && msg.data.name;
      if (!state.flowVars) state.flowVars = {};
      if (varName) delete state.flowVars[varName];
      else state.flowVars = {};
      broadcastFullState();
      break;
    }

    case 'flow_dry_run': {
      const drId = msg.data && msg.data.id;
      const drFlow = (state.flows || []).find(f => f.id === drId);
      if (!drFlow) break;
      const drLog = { flowId: drId, flowName: drFlow.name, conditions: [], actions: [], conditionsPassed: false };
      // Evaluate conditions
      const conds = drFlow.conditions || [];
      drLog.conditions = conds.map(c => ({
        type: c.type, params: c.params || {},
        passed: _evalCondition(c)
      }));
      drLog.conditionsPassed = !conds.length || drLog.conditions.every(c => c.passed);
      // Describe each action (with resolved tokens, no execution)
      const mockCtx = {};
      drLog.actions = (drFlow.actions || []).map((a, i) => {
        const rp = Object.fromEntries(Object.entries(a.params || {}).map(([k,v]) => [k, typeof v === 'string' ? _substituteTokens(v, mockCtx) : v]));
        return { index: i, type: a.type, delay: a.delay || 0, rawParams: a.params || {}, resolvedParams: rp };
      });
      ws.send(JSON.stringify({ type: 'flow_dry_run_result', data: drLog }));
      break;
    }

    // Hard-reload every connected overlay/browser source — busts OBS's in-memory cache so they
    // pick up freshly-served code (used after overlay updates that OBS would otherwise keep stale).
    case 'reload_overlays': {
      broadcast(bridgeClients, { type: 'reload_overlays' });
      break;
    }

    // Manually-built bracket (no start.gg). Writes the same winners/losers/finals
    // shape the bracket overlay already renders.
    // Manual builder is the source of truth for its phases — it sends the whole set.
    case 'set_bracket_phases': {
      const p = msg.data || {};
      if (Array.isArray(p.phases)) state.bracket.phases = p.phases;
      if (p.activePhaseId != null) state.bracket.activePhaseId = p.activePhaseId;
      if (typeof p.title === 'string') state.bracket.title = p.title;
      if (Array.isArray(p.teams)) state.bracket.teams = p.teams;     // [{name,logo}] for overlay logos
      state.bracket.matches = [];
      state.bracket.eventSlug = '';      // manual mode is not start.gg-backed
      state.bracket.mode = 'manual';     // the in-app builder now owns these phases — no external clobber
      state.bracket.source = '';
      state.bracket.lastFetchAt = Date.now();
      syncActiveBracketPhase();          // mirror the active phase to the top-level overlay fields
      if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
      saveAppState();
      broadcastFullState();
      if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
      break;
    }

    // Switch which phase is live on the overlay (works for manual OR start.gg phases).
    case 'bracket_select_phase': {
      const p = msg.data || {};
      if (p.phaseId != null) state.bracket.activePhaseId = p.phaseId;
      if (p.poolId != null) state.bracket.activePoolId = p.poolId;   // reset to a specific pool when switching phase, if given
      syncActiveBracketPhase();
      if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
      saveAppState();
      broadcastFullState();
      if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
      break;
    }

    // Switch which pool (Start.gg phaseGroup, or a manually-built pool) is live
    // on the overlay, when the active phase has more than one running at once.
    case 'bracket_select_pool': {
      const p = msg.data || {};
      const ph = (state.bracket.phases || []).find((x) => x.id === state.bracket.activePhaseId);
      const pools = (ph && ph.pools) || [];
      if (p.poolId != null && pools.some((pl) => pl.id === p.poolId)) state.bracket.activePoolId = p.poolId;
      syncActiveBracketPhase();
      saveAppState();
      broadcastFullState();
      break;
    }

    // Find a team anywhere in the loaded tournament: auto-select the phase + pool they play
    // in and highlight them on the overlay (startgg.focusTeam). Empty name clears the focus.
    // Built for major-scale events where hunting a team through 30 pool chips is hopeless.
    case 'bracket_focus_team': {
      const q = (msg.data?.name || '').toString().trim().toLowerCase();
      if (!q) {
        state.startgg.focusTeam = '';
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'bracket-result', data: { ok: true, message: 'Team focus cleared.' } }));
        break;
      }
      const nameHit = (n) => n && n !== 'TBD' && n.toLowerCase().includes(q);
      let found = null;   // { phaseId, poolId, name }
      for (const ph of (state.bracket.phases || [])) {
        for (const pl of (ph.pools || [])) {
          const names = [...(pl.roster || []), ...((pl.standings || []).map((r) => r.name))];
          const hit = names.find(nameHit);
          if (hit) { found = { phaseId: ph.id, poolId: pl.id, name: hit }; break; }
          for (const round of (pl.schedule || [])) {
            for (const s of (round.sets || [])) {
              const hit2 = [s.a && s.a.name, s.b && s.b.name].find(nameHit);
              if (hit2) { found = { phaseId: ph.id, poolId: pl.id, name: hit2 }; break; }
            }
            if (found) break;
          }
          if (found) break;
        }
        if (found) break;
        // Elimination phases keep sets at phase level (winners/losers/finals).
        for (const round of [...(ph.winners || []), ...(ph.losers || []), ...(ph.finals || []), ...(ph.schedule || [])]) {
          for (const s of (round.sets || [])) {
            const hit = [s.a && s.a.name, s.b && s.b.name].find(nameHit);
            if (hit) { found = { phaseId: ph.id, poolId: '', name: hit }; break; }
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) {
        state.bracket.activePhaseId = found.phaseId;
        if (found.poolId) state.bracket.activePoolId = found.poolId;
        state.startgg.focusTeam = found.name;
        syncActiveBracketPhase();
        saveAppState();
        broadcastFullState();
        const ph = (state.bracket.phases || []).find((x) => x.id === found.phaseId);
        const pl = ph && (ph.pools || []).find((x) => x.id === found.poolId);
        ws.send(JSON.stringify({ type: 'bracket-result', data: { ok: true,
          message: `Found ${found.name} — ${ph ? ph.name : 'phase'}${pl ? ' · ' + pl.name : ''}. Highlighted on the bracket.` } }));
      } else {
        ws.send(JSON.stringify({ type: 'bracket-result', data: { ok: false, message: `No team matching "${msg.data.name}" in this bracket.` } }));
      }
      break;
    }

    // Legacy single-bracket path — wrap the payload into a one-phase model.
    case 'set_manual_bracket': {
      const p = msg.data || {};
      state.bracket.phases = [{
        id: 'phase1', name: 'Bracket', type: p.type || 'SINGLE_ELIMINATION',
        winners: p.winners || [], losers: p.losers || [], finals: p.finals || [],
        standings: p.standings || [], schedule: p.schedule || [], roster: p.roster || [],
        pools: Array.isArray(p.pools) ? p.pools : [], matrix: p.matrix || null
      }];
      state.bracket.activePhaseId = 'phase1';
      if (typeof p.title === 'string') state.bracket.title = p.title;
      if (Array.isArray(p.teams)) state.bracket.teams = p.teams;
      state.bracket.matches = [];
      state.bracket.eventSlug = '';
      // Manual ownership — without this, a later eventSlug set would let the start.gg
      // poll silently overwrite the hand-built bracket (set_bracket_phases gets this right).
      state.bracket.mode = 'manual';
      state.bracket.source = '';
      state.bracket.lastFetchAt = Date.now();
      syncActiveBracketPhase();
      if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
      saveAppState();
      broadcastFullState();
      if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
      break;
    }

    case 'fetch_bracket': {
      (async () => {
        try {
          const slug = (msg.data?.eventSlug || state.bracket.eventSlug || state.startgg.eventSlug || '').trim();
          // Immediate ack: a big import runs for a while — without this the panel's
          // request timed out with "No response from the server" while data was
          // actually loading fine in the background.
          ws.send(JSON.stringify({
            type: 'bracket-result',
            data: { ok: true, message: 'Importing bracket — large events load phase by phase…' }
          }));
          const result = await fetchBracket(slug);
          const label = result.type ? result.type.replace(/_/g, ' ').toLowerCase() : 'bracket';
          ws.send(JSON.stringify({
            type: 'bracket-result',
            data: { ok: true, message: result.inProgress
              ? 'Import already running — phases appear as they load'
              : `Loaded ${result.sets} set(s) — ${label}` }
          }));
        } catch (e) {
          state.bracket.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'bracket-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'select_match': {
      (async () => {
        try {
          const setId = (msg.data?.setId || '').trim();
          if (!setId) throw new Error('No match selected');
          const result = await syncStartGgSet(setId);

          // New matchup → start a fresh series unless told to keep it
          if (msg.data?.keepSeries !== true) {
            state.series = { blue: 0, orange: 0 };
            state.game.number = 1;
          }
          saveAppState();
          broadcastFullState();

          ws.send(JSON.stringify({
            type: 'event-result',
            data: { ok: true, message: `Now playing: ${(result.entrants || []).join('  vs  ') || setId}` }
          }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'event-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'load_event': {
      (async () => {
        try {
          const slug = (msg.data?.eventSlug || state.bracket.eventSlug || '').trim();
          const r = await loadEvent(slug);
          ws.send(JSON.stringify({
            type: 'event-result',
            data: {
              ok: true,
              message: `Loaded "${r.title}" — ${r.teams} team(s), ${r.players} player(s), ${r.logos} logo(s), ${r.sets} set(s).`
            }
          }));
        } catch (e) {
          state.bracket.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'event-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    // Unified "make this the broadcast event": full import (teams→library + bracket
    // phases + eventTeams) AND mark it the selected start.gg event. The result tells
    // the panel to open the Events tab on this tournament for first-use.
    // Paste-a-link / one-click load. Accepts { url } (tournament OR event URL/slug)
    // or { eventSlug, tournamentSlug }. Resolves tournament→event (picker if >1),
    // then full-loads teams + bracket + queue.
    case 'load_startgg_url': {
      (async () => {
        const d = msg.data || {};
        const input = (d.url || d.eventSlug || d.tournamentSlug || '').trim();
        try {
          const r = await resolveStartggUrl(input);
          if (r.needsEventPick) {
            ws.send(JSON.stringify({
              type: 'event-result',
              data: { ok: true, needsEventPick: true, tournamentSlug: r.tournamentSlug, tournamentName: r.tournamentName, events: r.events,
                message: `Pick an event — ${r.events.length} found on ${r.tournamentName || 'this tournament'}.` }
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'event-result',
              data: { ok: true, activated: true, tournamentSlug: r.tournamentSlug, eventSlug: r.eventSlug,
                message: `Loaded "${r.eventName || r.title}" — ${r.teams} team(s), bracket + ${r.queued} queued set(s).` }
            }));
          }
        } catch (e) {
          state.startgg.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'event-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'activate_startgg_event': {
      (async () => {
        const d = msg.data || {};
        const eventSlug = (d.eventSlug || '').trim();
        const tournamentSlug = (d.tournamentSlug || '').trim() || eventSlug.replace(/\/event\/.*$/, '');
        try {
          // If we weren't handed a proper /event/ slug (e.g. a tournament URL, an /events or
          // /details page, or a bare tournament slug), resolve it like a pasted link — fetch the
          // tournament's events and auto-activate a single one, or return a picker for several.
          if (!/\/event\//i.test(eventSlug)) {
            const r = await resolveStartggUrl(eventSlug || tournamentSlug);
            if (r.needsEventPick) {
              ws.send(JSON.stringify({ type: 'event-result', data: { ok: true, needsEventPick: true, tournamentSlug: r.tournamentSlug, tournamentName: r.tournamentName, events: r.events, message: `Pick an event — ${r.events.length} found on ${r.tournamentName || 'this tournament'}.` } }));
            } else {
              ws.send(JSON.stringify({ type: 'event-result', data: { ok: true, activated: true, tournamentSlug: r.tournamentSlug, eventSlug: r.eventSlug, message: `Loaded "${r.eventName || r.title}" — ${r.teams} team(s), bracket + ${r.queued} queued set(s).` } }));
            }
            return;
          }
          const r = await activateStartggEvent(tournamentSlug, eventSlug, { name: d.name, tournamentName: d.tournamentName });
          ws.send(JSON.stringify({
            type: 'event-result',
            data: {
              ok: true, activated: true, tournamentSlug: r.tournamentSlug, eventSlug: r.eventSlug,
              message: `Activated "${r.eventName || r.title}" — ${r.teams} team(s) imported, bracket + ${r.queued} queued set(s).`
            }
          }));
        } catch (e) {
          state.startgg.lastError = e.message;
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'event-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    // Teams page "Pull from start.gg" — import entrants into the library only.
    case 'import_startgg_teams': {
      (async () => {
        const d = msg.data || {};
        try {
          const r = await importStartggTeams((d.eventSlug || d.slug || '').trim());
          ws.send(JSON.stringify({
            type: 'event-result',
            data: { ok: true, message: `Imported ${r.teams} team(s), ${r.players} player(s) to your library (${r.teamsAdded} new).` }
          }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'event-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    case 'rl_hide_native_ui': {
      triggerRlHideNativeUi();
      break;
    }

    case 'set_rl_spectator_ui': {
      const d = msg.data || {};
      state.rlSpectatorUi = {
        ...rlSpectatorUi.DEFAULTS,
        ...(state.rlSpectatorUi || {}),
        ...d
      };
      if ('enabled' in d) state.rlSpectatorUi.enabled = !!d.enabled;
      if ('autoOnMatch' in d) state.rlSpectatorUi.autoOnMatch = !!d.autoOnMatch;
      if ('focusWindow' in d) state.rlSpectatorUi.focusWindow = !!d.focusWindow;
      saveAppState();
      broadcastFullState();
      if (onRlSpectatorUiHotkeyChange) onRlSpectatorUiHotkeyChange();
      break;
    }

    // ── AI Auto-Director ─────────────────────────────────────────────────
    case 'set_director': {
      const d = msg.data || {};
      if (directorEngine) {
        // Patch must only carry the keys the client actually sent — setSettings
        // tests key presence, so a present-but-undefined key wipes that setting.
        const patch = {};
        if ('enabled' in d) patch.enabled = !!d.enabled;
        if ('sensitivity' in d) patch.sensitivity = Number(d.sensitivity);
        if ('lockTarget' in d) patch.lockTarget = d.lockTarget || null;
        if ('autoSwitch' in d) patch.autoSwitch = !!d.autoSwitch;
        directorEngine.setSettings(patch);
        state.director = mergeDirectorRuntime(directorEngine.getState());
        autoSwitch.setEnabled(!!state.director.autoSwitch);
      } else if (state.director) {
        if ('enabled' in d) state.director.enabled = !!d.enabled;
        if ('sensitivity' in d) state.director.sensitivity = Math.max(0, Math.min(1, Number(d.sensitivity) || 0.5));
        if ('lockTarget' in d) state.director.lockTarget = d.lockTarget || null;
        if ('autoSwitch' in d) {
          state.director.autoSwitch = !!d.autoSwitch;
          autoSwitch.setEnabled(state.director.autoSwitch);
        }
      }
      saveAppState();
      broadcastDirectorUpdate();
      break;
    }

    case 'director_feed_action': {
      const { feedId, action } = msg.data || {};
      const feedItem = (state.director?.feed || []).find((f) => f.id === feedId);
      if (!feedItem) break;
      (async () => {
        let clipOk = false;
        if (action === 'capture' || action === 'both') {
          const clip = await triggerClipCapture({
            type: feedItem.type,
            game: state.activeGame,
            player: feedItem.target || '',
            reason: feedItem.reason || 'Producer tagged from feed',
            label: `Feed — ${feedItem.type} ${feedItem.target || ''}`,
            captureKey: `feed:${feedId}`,
            feedTs: feedItem.ts,
            force: true
          });
          clipOk = !!clip;
        }
        if ((action === 'train' || action === 'both') && directorEngine) {
          directorEngine.recordFeedback({
            eventType: feedItem.type,
            targetId: feedItem.targetId || feedItem.target,
            action: 'accepted'
          });
          if (telemetry) telemetry.directorDecision({
            recommendation: { type: feedItem.type, target: { id: feedItem.targetId || null, name: feedItem.target || null }, reason: feedItem.reason || null },
            decision: 'accept', note: 'tagged from feed',
          });
          state.director = mergeDirectorRuntime(directorEngine.getState());
          broadcastDirectorUpdate();
        }
        ws.send(JSON.stringify({
          type: 'clips-result',
          data: {
            ok: clipOk || action === 'train',
            message: clipOk
              ? `Saved replay clip for ${feedItem.type} — ${feedItem.target || 'moment'}`
              : (action === 'train' ? 'Trained AI on feed moment' : 'Replay save failed — check OBS + replay buffer')
          }
        }));
      })();
      break;
    }

    case 'director_feedback': {
      if (directorEngine && msg.data) {
        const action = msg.data.action || 'accepted';
        directorEngine.recordFeedback({
          eventType: msg.data.eventType || state.director?.primary?.type || 'unknown',
          targetId: msg.data.targetId || state.director?.primary?.target?.id,
          action
        });
        // Telemetry: map the engine action → a training decision label.
        const DEC = { accepted: 'accept', overridden: 'override', locked: 'lock', declined: 'decline', rejected: 'decline' };
        recordDirectorDecision(DEC[action] || 'accept', {
          chosen: msg.data.chosen || (msg.data.targetId ? { kind: 'player', id: msg.data.targetId } : null),
          note: msg.data.note || null,
        });
        state.director = mergeDirectorRuntime(directorEngine.getState());
        broadcastDirectorUpdate();
      }
      break;
    }

    case 'director_accept': {
      if (directorEngine) {
        directorEngine.recordFeedback({
          eventType: state.director?.primary?.type,
          targetId: state.director?.primary?.target?.id,
          action: 'accepted'
        });
        recordDirectorDecision('accept', { note: (msg.data && msg.data.note) || null });
        state.director = mergeDirectorRuntime(directorEngine.getState());
        broadcastDirectorUpdate();
      }
      break;
    }

    // ── AI master controls (Shield kill-switch + telemetry) ───────────────
    case 'set_ai_shield': {
      const on = !!(msg.data && msg.data.on);
      if (!state.ai) state.ai = { shield: false, telemetry: { enabled: true } };
      state.ai.shield = on;
      if (telemetry) telemetry.mark('shield', { on });
      console.log(`[AI] Shield ${on ? 'ENGAGED — all AI automations paused' : 'released'}`);
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'set_telemetry': {
      const on = !!(msg.data && msg.data.enabled);
      if (!state.ai) state.ai = { shield: false, telemetry: { enabled: true } };
      state.ai.telemetry = { enabled: on };
      if (telemetry) telemetry.setEnabled(on);
      saveAppState();
      broadcastFullState();
      break;
    }

    // ── Clips & montages ─────────────────────────────────────────────────
    case 'set_clips': {
      const c = msg.data || {};
      if (state.clips) {
        if ('captureMode' in c && ['auto', 'prompt', 'manual'].includes(c.captureMode)) {
          state.clips.captureMode = c.captureMode;
          state.clips.autoCapture = c.captureMode === 'auto';   // keep manager in sync
        }
        if ('autoMontage' in c) state.clips.autoMontage = !!c.autoMontage;
        if ('autoCapture' in c) state.clips.autoCapture = !!c.autoCapture;
        if ('replayFolder' in c) state.clips.replayFolder = c.replayFolder || '';
        if (c.captureRules) state.clips.captureRules = { ...state.clips.captureRules, ...c.captureRules };
      }
      if (clipSystem) clipSystem.setSettings({
        autoCapture: state.clips.autoCapture,
        replayFolder: state.clips.replayFolder,
        captureRules: state.clips.captureRules
      });
      saveAppState();
      if (clipSystem) syncClipsState();
      broadcastClipsUpdate();
      break;
    }

    // Native folder picker for the OBS replay/output folder (Electron dialog in the main process).
    case 'pick_replay_folder': {
      dialog.showOpenDialog({
        title: 'Select OBS Replay / Output Folder',
        properties: ['openDirectory'],
        defaultPath: (state.clips && state.clips.replayFolder) || undefined
      }).then(({ canceled, filePaths }) => {
        if (canceled || !filePaths || !filePaths[0]) return;
        if (!state.clips) state.clips = {};
        state.clips.replayFolder = filePaths[0];
        if (clipSystem) clipSystem.setSettings({
          autoCapture: state.clips.autoCapture,
          replayFolder: state.clips.replayFolder,
          captureRules: state.clips.captureRules
        });
        saveAppState();
        if (clipSystem) syncClipsState();
        broadcastClipsUpdate();
      }).catch(() => {});
      break;
    }

    // Producer clicked "Clip it" on a prompt-mode pop-up → capture now.
    case 'clip_prompt_accept': {
      (async () => {
        const meta = { ...(msg.data?.meta || {}), force: true };
        const clip = await triggerClipCapture(meta);
        if (clip) maybeAutoMontage(clip);
        ws.send(JSON.stringify({ type: 'clips-result', data: {
          ok: !!(clip && clip.path),
          message: (clip && clip.path) ? '✓ Clipped.' : ((clipSystem && clipSystem.getLastError()) || 'Clip failed.')
        } }));
      })();
      break;
    }

    case 'clip_capture_manual': {
      (async () => {
        const meta = {
          type: 'manual',
          game: state.activeGame,
          player: msg.data?.player || '',
          reason: msg.data?.reason || 'Manual capture',
          label: msg.data?.label || 'Manual clip',
          force: true
        };
        const clip = await triggerClipCapture(meta);
        let ok = false, message;
        if (clip && clip.path) { ok = true; message = '✓ Clip captured to library.'; }
        else { message = (clipSystem && clipSystem.getLastError()) || 'Capture failed — is the OBS Replay Buffer enabled and running?'; }
        ws.send(JSON.stringify({ type: 'clips-result', data: { ok, message } }));
      })();
      break;
    }

    case 'clip_remove': {
      if (clipSystem && msg.data?.id) {
        clipSystem.manager.removeClip(msg.data.id);
        syncClipsState();
        broadcastClipsUpdate();
      }
      break;
    }

    case 'clip_update': {
      if (clipSystem && msg.data?.id) {
        clipSystem.manager.updateClip(msg.data.id, msg.data);
        syncClipsState();
        broadcastClipsUpdate();
        // Telemetry: a producer edit on a clip (trim/tags/notes) is a training signal.
        if (telemetry) {
          const d = msg.data;
          const trim = ('trimIn' in d || 'trimOut' in d) ? { in: d.trimIn ?? null, out: d.trimOut ?? null, editedByHuman: true } : null;
          telemetry.clipDecision({ clipId: d.id, decision: 'edit', trim, tags: d.tags || null, note: d.description || d.note || null });
        }
      }
      break;
    }

    case 'montage_create': {
      if (clipSystem && Array.isArray(msg.data?.clipIds)) {
        clipSystem.manager.createMontage({
          name: msg.data.name || 'Highlight Reel',
          clipIds: msg.data.clipIds,
          template: msg.data.template || 'highlights'
        });
        syncClipsState();
        broadcastClipsUpdate();
      }
      break;
    }

    case 'montage_reorder': {
      if (clipSystem && msg.data?.montageId && Array.isArray(msg.data?.clipIds)) {
        clipSystem.manager.reorderMontage(msg.data.montageId, msg.data.clipIds);
        syncClipsState();
        broadcastClipsUpdate();
      }
      break;
    }

    case 'montage_rename': {
      if (clipSystem && msg.data?.montageId && typeof msg.data?.name === 'string') {
        clipSystem.manager.renameMontage(msg.data.montageId, msg.data.name);
        syncClipsState();
        broadcastClipsUpdate();
      }
      break;
    }

    // Live-playout settings for a playlist: which OBS scene it plays in + the between-clip transition.
    case 'montage_settings': {
      if (clipSystem && msg.data?.montageId) {
        clipSystem.manager.setMontageSettings(msg.data.montageId, {
          programScene: msg.data.programScene,
          kind: msg.data.kind,
          loop: msg.data.loop,
          returnEnabled: msg.data.returnEnabled,
          transition: msg.data.transition
        });
        syncClipsState();
        broadcastClipsUpdate();
      }
      break;
    }

    case 'montage_delete': {
      if (clipSystem && msg.data?.montageId) {
        clipSystem.manager.deleteMontage(msg.data.montageId);
        syncClipsState();
        broadcastClipsUpdate();
      }
      break;
    }

    case 'montage_delete_export': {
      if (clipSystem && msg.data?.montageId) {
        clipSystem.manager.deleteMontageExport(msg.data.montageId);
        syncClipsState();
        broadcastClipsUpdate();
      }
      break;
    }

    case 'montage_save_export': {
      if (!clipSystem || !msg.data?.montageId) break;
      const _saveMontage = (clipSystem.getState().montages || []).find((x) => x.id === msg.data.montageId);
      const _savePath = _saveMontage && _saveMontage.outputPath;
      const _saveReply = (ok, message) => { try { ws.send(JSON.stringify({ type: 'montage_save_result', data: { ok, message } })); } catch {} };
      if (!_savePath) { _saveReply(false, 'No encoded file found — encode the playlist first.'); break; }
      if (!fs.existsSync(_savePath)) { _saveReply(false, 'Encoded file not found on disk.'); break; }
      const _saveExt = path.extname(_savePath) || '.mp4';
      const _saveName = (_saveMontage.name || 'playlist').replace(/[<>:"/\\|?*]/g, '_') + _saveExt;
      const _saveDesktop = (() => { try { return _electronApp.getPath('desktop'); } catch { return os.homedir(); } })();
      dialog.showSaveDialog({
        title: 'Save Encoded Playlist',
        defaultPath: path.join(_saveDesktop, _saveName),
        filters: [{ name: 'Video', extensions: [_saveExt.replace('.', '')] }]
      }).then(({ canceled, filePath }) => {
        if (canceled || !filePath) return;
        fs.copyFile(_savePath, filePath, (err) => {
          if (err) _saveReply(false, 'Save failed: ' + err.message);
          else _saveReply(true, 'Saved to ' + filePath);
        });
      }).catch((e) => _saveReply(false, 'Dialog error: ' + e.message));
      break;
    }

    case 'montage_encode': {
      if (clipSystem && msg.data?.montageId) {
        (async () => {
          const m = clipSystem.getState().montages.find((x) => x.id === msg.data.montageId);
          const opts = msg.data.opts || {};
          // 'logo' transition: persist the picked logo (data URL) to a file ffmpeg can read.
          // Async write — a multi-MB logo written synchronously stalls the main-process window.
          if (opts.transition === 'logo' && typeof opts.transitionLogo === 'string' && opts.transitionLogo.startsWith('data:image/')) {
            try {
              const mm = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(opts.transitionLogo);
              if (mm) {
                const dir = path.join(clipSystem.manager.getClipsDir(), 'work');
                await fsp.mkdir(dir, { recursive: true });
                const lp = path.join(dir, `translogo_${msg.data.montageId}.${mm[1] === 'jpeg' ? 'jpg' : mm[1]}`);
                await fsp.writeFile(lp, Buffer.from(mm[2], 'base64'));
                opts.transitionLogoPath = lp;
              }
            } catch (e) { /* falls back to a black dip */ }
          }
          delete opts.transitionLogo;   // don't carry the big data URL further
          const res = clipSystem.enqueueMontage(msg.data.montageId, m?.name || 'Montage', opts);
          syncClipsState();
          broadcastClipsUpdate();
          ws.send(JSON.stringify({
            type: 'clips-result',
            data: res && res.error
              ? { ok: false, message: res.error }
              : { ok: true, message: 'Encoding started — progress shows in the toolbar.' }
          }));
        })().catch((e) => { try { ws.send(JSON.stringify({ type: 'clips-result', data: { ok: false, message: 'Encode failed to start: ' + e.message } })); } catch {} });
      }
      break;
    }

    case 'encode_cancel': {
      if (clipSystem && msg.data?.jobId) {
        clipSystem.encoder.cancel(msg.data.jobId);
        state.encode = clipSystem.encoder.getQueue();
        broadcastClipsUpdate();
      }
      break;
    }

    default:
      break;
  }
}

function sendImportExportResult(ws, result, message, context) {
  ws.send(JSON.stringify({
    type: 'import-export-result',
    data: { result, message, context: context || 'profile' }
  }));
}

function mergeAtTop(savedArray, importedArray, isSameItem) {
  const filteredNew = importedArray.filter(importItem => {
    return !savedArray.some(savedItem => isSameItem(savedItem, importItem));
  });

  return [...filteredNew, ...savedArray];
}

// Image vault: repeat base64 images (team/standings/ad logos) are the bulk of the live payload but
// almost never change. Clients that sent `imgvault_ready` (overlay/sticky-logos.js) cache each image
// the first time they see it and thereafter accept a compact "@img:<hash>" reference. This strips the
// bytes off every subsequent broadcast for those clients — big win for remote overlays. Legacy clients
// (no script / didn't opt in) get the untouched payload, so nothing regresses.
const _imgSent = new Set();
function _imgHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + '.' + s.length; }
function _vaultImages(str) {
  return str.replace(/"data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{1024,}"/g, (m) => {
    const val = m.slice(1, -1);
    const h = _imgHash(val);
    if (_imgSent.has(h)) return '"@img:' + h + '"';
    _imgSent.add(h);            // first sight → send whole so capable clients cache it
    return m;
  });
}
let _bcTimer = null, _bcPending = false, _lastLibSig = '', _lastMsgStr = '';
function _flushFullState() {
  const data = buildLiveState();
  const sig = librarySig();
  const libChanged = (sig !== _lastLibSig);
  if (libChanged) { _lastLibSig = sig; Object.assign(data, libraryData()); }   // library only when it changed
  // Serialize ONCE. Skip byte-identical re-sends (a mutation that didn't change anything live — only a
  // library/local key moved, or an identical value was written). New clients get their own snapshot via
  // the connection handler, so deduping the throttled path never starves them.
  const realStr = JSON.stringify({ type: 'full_state', data });
  if (realStr === _lastMsgStr) { feedDirectorBroadcast(); return; }
  _lastMsgStr = realStr;
  // Build the vaulted variant once, only if some connected client can use it.
  let vaultStr = null;
  for (const ws of bridgeClients) { if (ws._imgvault) { vaultStr = _vaultImages(realStr); break; } }
  for (const ws of bridgeClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(ws._imgvault && vaultStr ? vaultStr : realStr);
  }
  feedDirectorBroadcast();
}
// Coalesce bursts: broadcast immediately (leading edge), then at most once per 40ms. Collapses
// the common `saveAppState(); broadcastFullState();` storms and rapid multi-field updates into
// a single send, so the main thread isn't re-stringifying/​re-sending dozens of times a second.
function broadcastFullState() {
  if (_bcTimer) { _bcPending = true; return; }
  _flushFullState();
  _bcTimer = setTimeout(() => {
    _bcTimer = null;
    if (_bcPending) { _bcPending = false; broadcastFullState(); }
    // Coalesce width follows the Performance settings: wider while a match is live /
    // lean mode, and the producer's chosen overlay update rate otherwise. (RL tick
    // data rides the tiny state_update channel and is never delayed by this.)
  }, perfCoalesceMs());
}

// ─── HTTP Server (port 3000) — serves overlay ────────────────────────────────
function startHttpServer(baseDir) {
  const app = express();
  const overlayDir = path.join(baseDir, 'overlay');
  const overridesDir = path.join(dataDir, 'overlay-overrides');
  overlayEditor = createOverlayEditor({ overlayDir, overridesDir });

  // Inject the sticky-logos client as the first <head> script of EVERY served overlay page, so remote
  // overlays opt into compact @img: image refs (see overlay/sticky-logos.js) with zero per-file edits.
  // Covers user overrides and base overlays; on any read error it falls through to normal serving.
  const _stickyTag = '<script src="/sticky-logos.js"></script>';
  const _resolveOverlayHtml = (reqPath) => {
    const ov = overlayEditor.resolveFileForRequest(reqPath);
    if (ov) return ov;
    const rel = (reqPath === '/' ? '' : reqPath.replace(/^\/+/, ''));
    if (!rel || !/\.html$/i.test(rel)) return null;
    const full = path.join(overlayDir, rel);
    if (!full.startsWith(overlayDir)) return null;   // path-traversal guard
    return fs.existsSync(full) ? full : null;
  };
  app.get(/^\/([^?]*\.html)?$/i, (req, res, next) => {
    const file = _resolveOverlayHtml(req.path);
    if (!file || !/\.html$/i.test(file)) return next();
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next();
      const out = html.indexOf('sticky-logos.js') >= 0 ? html
        : (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + '\n  ' + _stickyTag)
                                     : _stickyTag + '\n' + html);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.type('html').send(out);
    });
  });

  // Custom overlay files (user HTML overrides) before static fallback
  app.get(/^\/[^?]*\.(html|css|js)$/i, (req, res, next) => {
    const file = overlayEditor.resolveFileForRequest(req.path);
    if (!file) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(file);
  });
  app.get('/', (req, res, next) => {
    const file = overlayEditor.resolveFileForRequest('/');
    if (!file) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(file);
  });

  app.get('/api/overlay/source', async (req, res) => {
    try {
      const data = await overlayEditor.getSource(req.query.path || '/');
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.post('/api/overlay/save', express.json({ limit: '4mb' }), async (req, res) => {
    try {
      const { path: filePath, content } = req.body || {};
      const data = await overlayEditor.saveOverride(filePath, content);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.post('/api/overlay/revert', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      const data = await overlayEditor.revert((req.body || {}).path);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.get('/api/overlay/overrides', async (req, res) => {
    try {
      const paths = await overlayEditor.listOverrides();
      res.json({ ok: true, paths });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Almost every overlay file opens with a `<!-- filename.html — description... -->` header
  // comment (see duorow.html, preshow.html, etc.) — pull the first line of it as a free
  // auto-description so newly-added, not-yet-curated scenes still show something useful in
  // the "Other Overlays" fallback group instead of a generic placeholder.
  async function overlayAutoDescription(filePath) {
    try {
      const fh = await fsp.open(filePath, 'r');
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fh.read(buf, 0, 2048, 0);
      await fh.close();
      const head = buf.slice(0, bytesRead).toString('utf8');
      const m = head.match(/<!--\s*([\s\S]*?)-->/);
      if (!m) return '';
      const firstLine = m[1].split('\n').map((l) => l.trim()).find((l) => l);
      if (!firstLine) return '';
      return firstLine.replace(/^[\w.-]+\.html\s*[—-]\s*/, '').trim();
    } catch (e) { return ''; }
  }

  // List every overlay HTML on disk so the Scenes page auto-discovers new scenes
  // (no need to hand-maintain a list). Internal pages are excluded.
  app.get('/api/overlays', async (req, res) => {
    const EXCLUDE = new Set(['scenes.html', 'index.html', 'upcoming.html']);  // launcher + overlay index + upcoming→schedule redirect stub
    try {
      const files = (await fsp.readdir(overlayDir))
        .filter((f) => /\.html$/i.test(f) && !EXCLUDE.has(f.toLowerCase()))
        .sort();
      const overlays = await Promise.all(files.map(async (f) => ({
        file: f, path: '/' + f, desc: await overlayAutoDescription(path.join(overlayDir, f))
      })));
      res.json({ ok: true, overlays });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // ─── OBS Scene Collection ────────────────────────────────────────────────────
  // Shared helper: build the collection JSON from current caster state.
  const OBS_COLLECTION_NAME = 'NE Broadcast Suite';

  function buildSceneCollection() {
    return generateSceneCollection({ name: OBS_COLLECTION_NAME });
  }

  // Best guess at OBS's scene-collection folder (used only to DEFAULT the save dialog there —
  // the user can browse anywhere, so portable / custom installs still work).
  function guessObsScenesDir() {
    const candidates = process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio', 'basic', 'scenes')]
      : process.platform === 'win32'
        ? [path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obs-studio', 'basic', 'scenes')]
        : [ // linux: native + flatpak + snap
            path.join(os.homedir(), '.config', 'obs-studio', 'basic', 'scenes'),
            path.join(os.homedir(), '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio', 'basic', 'scenes'),
            path.join(os.homedir(), 'snap', 'obs-studio', 'current', '.config', 'obs-studio', 'basic', 'scenes'),
          ];
    return candidates.find(d => { try { return fs.existsSync(d); } catch { return false; } }) || '';
  }

  // OBS scene collections and profiles — used by brand kit editor to populate picker dropdowns.
  app.get('/api/obs/scene-collections', async (req, res) => {
    if (!obsClient || !obsClient.isConnected()) return res.json({ ok: true, collections: [], current: '' });
    const r = await obsClient.call('GetSceneCollectionList').catch(() => null);
    res.json({ ok: true, collections: (r && r.sceneCollections) || [], current: (r && r.currentSceneCollectionName) || '' });
  });
  app.get('/api/obs/profiles', async (req, res) => {
    if (!obsClient || !obsClient.isConnected()) return res.json({ ok: true, profiles: [], current: '' });
    const r = await obsClient.call('GetProfileList').catch(() => null);
    res.json({ ok: true, profiles: (r && r.profiles) || [], current: (r && r.currentProfileName) || '' });
  });

  // Returns all audio/video inputs currently known to OBS — used to populate flow action dropdowns.
  app.get('/api/obs/inputs', async (req, res) => {
    if (!obsClient || !obsClient.isConnected()) return res.json({ inputs: [] });
    const inputs = await obsClient.getInputList().catch(() => []);
    res.json({ inputs });
  });

  // Screenshot the current OBS program output — used by the in-app preview panel.
  // Tries GetVideoMixFrame (OBS WS 5.3+ / OBS 30+) first; falls back to
  // GetSourceScreenshot on the current program scene for older versions.
  app.get('/api/obs/screenshot', async (req, res) => {
    if (!obsClient || !obsClient.isConnected()) {
      return res.status(503).json({ error: 'OBS not connected' });
    }
    const w = Math.min(Math.max(parseInt(req.query.w) || 960, 160), 1920);
    const h = Math.round(w * 9 / 16);
    const imgOpts = { imageFormat: 'jpg', imageWidth: w, imageHeight: h, imageCompressionQuality: 72 };

    // Primary: GetVideoMixFrame — directly captures what viewers see (OBS WS ≥5.3)
    let r = await obsClient.call('GetVideoMixFrame', {
      videoMixType: 'OBS_WEBSOCKET_VIDEO_MIX_TYPE_PROGRAM',
      ...imgOpts,
    });

    // Fallback: GetSourceScreenshot on the current program scene (any OBS WS v5)
    if (!r || !r.imageData) {
      const scene = obsClient.getCurrentScene();
      if (scene) {
        r = await obsClient.call('GetSourceScreenshot', { sourceName: scene, ...imgOpts });
      }
    }

    if (!r || !r.imageData) {
      const err = obsClient.getLastError() || 'Screenshot unavailable';
      console.warn('[OBS Preview] Screenshot failed:', err);
      return res.status(503).json({ error: err });
    }
    const buf = Buffer.from(r.imageData.replace(/^data:[^;]+;base64,/, ''), 'base64');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.end(buf);
  });

  // GET  → download as file (manual import fallback).
  app.get('/api/obs/scene-collection', (req, res) => {
    try {
      const collection = buildSceneCollection();
      res.setHeader('Content-Disposition', `attachment; filename="${OBS_COLLECTION_NAME}.json"`);
      res.json(collection);
    } catch (e) {
      console.error('[OBS] Scene collection generation failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST → save the collection to a folder the USER picks (native dialog), defaulting to the
  // detected OBS scenes folder. We don't assume a fixed OBS install path; the user imports the
  // saved .json via OBS → Scene Collection → Import (or it appears automatically if saved into
  // the OBS scenes folder). (own express.json — registered before the global body parser.)
  app.post('/api/obs/install-collection', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const collection = buildSceneCollection();
      const json = JSON.stringify(collection, null, 2);

      const obsDir = guessObsScenesDir();
      const defaultDir = obsDir || (() => { try { return _electronApp.getPath('desktop'); } catch { return os.homedir(); } })();

      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save OBS Scene Collection',
        defaultPath: path.join(defaultDir, `${OBS_COLLECTION_NAME}.json`),
        filters: [{ name: 'OBS Scene Collection', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (canceled || !filePath) {
        return res.json({ ok: false, canceled: true, message: 'Save cancelled.' });
      }

      await fsp.writeFile(filePath, json, 'utf8');
      console.log(`[OBS] Saved scene collection to ${filePath}`);

      // If it landed in the OBS scenes folder, optionally hot-switch via WebSocket.
      const savedInObsDir = obsDir && path.dirname(filePath) === obsDir;
      let switched = false;
      if (savedInObsDir && obsClient && obsClient.isConnected()) {
        try { await obsClient.call('SetCurrentSceneCollection', { sceneCollectionName: OBS_COLLECTION_NAME }); switched = true; }
        catch (wsErr) { console.warn('[OBS] SetCurrentSceneCollection failed:', wsErr.message); }
      }

      // Post-install glue: auto-map EMPTY broadcast moments to the collection's known scene
      // names so hotkeys/quick-bar work immediately (never overwrites a producer's own mapping).
      const AUTO_MAP = { inGame: 'In Game', replay: 'Replay', postGame: 'Post-Game (Winner)',
        break: 'Break (Countdown)', casters: 'DuoCam Row', bracket: 'Bracket' };
      let mapped = false;
      Object.entries(AUTO_MAP).forEach(([key, sceneName]) => {
        if (!state.obs.scenes[key]) { state.obs.scenes[key] = sceneName; mapped = true; }
      });
      if (mapped) { saveAppState(); broadcastFullState(); }

      res.json({
        ok: true,
        path: filePath,
        name: OBS_COLLECTION_NAME,
        savedInObsDir: !!savedInObsDir,
        switched,
        message: switched
          ? `Saved & switched OBS to "${OBS_COLLECTION_NAME}".`
          : savedInObsDir
            ? `Saved into your OBS folder. Restart OBS (or Scene Collection menu) and pick "${OBS_COLLECTION_NAME}".`
            : `Saved "${OBS_COLLECTION_NAME}.json". In OBS: Scene Collection → Import → choose that file.`,
      });
    } catch (e) {
      console.error('[OBS] install-collection failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ─── Stats API ───────────────────────────────────────────────────────────────
  app.get('/api/stats/matches', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      res.json({ ok: true, matches: stats.getRecentMatches(limit) });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get('/api/stats/matches/:id', (req, res) => {
    try {
      const detail = stats.getMatchDetail(parseInt(req.params.id));
      if (!detail) return res.status(404).json({ ok: false, message: 'Not found' });
      res.json({ ok: true, match: detail });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get('/api/stats/players', (req, res) => {
    try {
      const name = req.query.name || '';
      if (!name) return res.status(400).json({ ok: false, message: 'name param required' });
      res.json({ ok: true, history: stats.getPlayerHistory(name) });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get('/api/stats/aggregate', (req, res) => {
    try { res.json({ ok: true, ...stats.getAggregateStats() }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  // Deep analytics: player leaderboards (RL + CS2) and team records.
  app.get('/api/stats/leaders', (req, res) => {
    try { res.json({ ok: true, ...stats.getLeaders(Number(req.query.limit) || 25) }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/teams', (req, res) => {
    try { res.json({ ok: true, teams: stats.getTeamRecords() }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/h2h', (req, res) => {
    try { res.json({ ok: true, ...stats.getHeadToHead(req.query.a || '', req.query.b || '') }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  // Cross-game player profile + the distinct-player list that feeds its picker.
  app.get('/api/stats/player-list', (req, res) => {
    try { res.json({ ok: true, players: stats.listPlayers() }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/profile', (req, res) => {
    try {
      const name = req.query.name || '';
      if (!name) return res.status(400).json({ ok: false, message: 'name param required' });
      const profile = stats.getPlayerProfile(name);
      if (!profile) return res.status(404).json({ ok: false, message: 'no record for that player' });
      res.json({ ok: true, profile });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/player-event', (req, res) => {
    try {
      const { name, tournament } = req.query;
      if (!name || !tournament) return res.status(400).json({ ok: false, message: 'name and tournament params required' });
      const result = stats.getPlayerEventStats(name, tournament);
      res.json({ ok: true, stats: result || null });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // ── Filtered analytics dashboard (single source of truth) ──────────────────
  app.get('/api/stats/filters', (req, res) => {
    try { res.json({ ok: true, ...stats.getFilterOptions() }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/dashboard', (req, res) => {
    try {
      const f = { from: req.query.from ? Number(req.query.from) : 0, to: req.query.to ? Number(req.query.to) : 0,
        game: req.query.game || '', tournament: req.query.tournament || '' };
      res.json({ ok: true, filters: f, data: stats.getDashboard(f) });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // ── Analytics: broadcast sessions (producer show reports) ──────────────────
  app.get('/api/analytics/overview', (req, res) => res.json({ ok: true, ...analytics.overview(req.query.event), auto: analytics.getAuto() }));
  app.get('/api/analytics/live', (req, res) => res.json({ ok: true, live: analytics.getLive() }));
  app.get('/api/analytics/sessions', (req, res) => res.json({ ok: true, sessions: analytics.getSessions() }));
  app.get('/api/analytics/session/:id', (req, res) => {
    const s = analytics.getSession(req.params.id);
    if (!s) return res.status(404).json({ ok: false, message: 'not found' });
    res.json({ ok: true, session: s });
  });
  app.post('/api/analytics/start', (req, res) => res.json({ ok: true, live: analytics.startSession(req.body && req.body.label) }));
  app.post('/api/analytics/stop', (req, res) => res.json({ ok: true, session: analytics.stopSession() }));
  app.post('/api/analytics/auto', (req, res) => { analytics.setAuto(!(req.body && req.body.on === false)); res.json({ ok: true, auto: analytics.getAuto() }); });
  app.delete('/api/analytics/session/:id', (req, res) => { analytics.deleteSession(req.params.id); res.json({ ok: true, sessions: analytics.getSessions() }); });
  // Clear ALL broadcast sessions (fresh reporting).
  app.delete('/api/analytics/sessions', (req, res) => { try { analytics.clearAllSessions(); } catch (e) {} res.json({ ok: true, sessions: analytics.getSessions() }); });
  app.delete('/api/stats/match/:id', (req, res) => { const ok = stats.deleteMatch(req.params.id); res.json({ ok }); });
  app.delete('/api/stats/matches', (req, res) => { stats.clearAllMatches(); res.json({ ok: true }); });
  app.delete('/api/stats/team/:name', (req, res) => { const n = stats.deleteMatchesByTeam(decodeURIComponent(req.params.name)); res.json({ ok: true, removed: n }); });
  app.delete('/api/stats/player/:name', (req, res) => { const n = stats.deletePlayerStats(decodeURIComponent(req.params.name)); res.json({ ok: true, removed: n }); });
  app.get('/api/analytics/export', (req, res) => {
    const out = analytics.exportCsv((req.query.session || '').toString());
    if (!out) return res.status(404).json({ ok: false, message: 'not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${out.name}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(out.csv);
  });

  // ── Twitch channel stats (followers / subs / past broadcasts / clips) ───────
  app.get('/api/twitch/stats', async (req, res) => {
    const token = state.twitch && state.twitch.apiToken;
    const userId = state.twitch && state.twitch.channelId;
    if (!token || !userId) return res.status(400).json({ ok: false, needsReconnect: true, message: 'Twitch not connected — reconnect in Settings to pull channel stats.' });
    if (!req.query.refresh && _twitchStatsCache && (Date.now() - _twitchStatsCache.at < 60000)) {
      return res.json({ ok: true, data: _twitchStatsCache.data, cached: true });
    }
    try {
      const data = await twitchStats.fetchTwitchStats({ clientId: process.env.TWITCH_CLIENT_ID, accessToken: token, userId });
      _twitchStatsCache = { at: Date.now(), data };
      res.json({ ok: true, data });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // YouTube channel stats — subscriber count, video views, recent uploads, live viewer count
  app.get('/api/youtube/stats', async (req, res) => {
    if (!socialPublisher) return res.status(503).json({ ok: false, message: 'Social publisher not initialised.' });
    if (!socialPublisher.getConnections().youtube.connected) return res.status(400).json({ ok: false, needsConnect: true, message: 'YouTube not connected — connect via Settings → Social.' });
    try {
      const data = await socialPublisher.getYouTubeStats();
      if (!data) return res.status(400).json({ ok: false, needsConnect: true, message: 'YouTube not connected.' });
      res.json({ ok: true, data });
    } catch (e) {
      console.error('[youtube/stats]', e.message);
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // ── Import historical results from the producer's own start.gg tournaments ──
  // Runs in the background; progress + final summary are pushed over WS ('startgg_import').
  app.post('/api/stats/import-startgg', (req, res) => {
    if (!startggApiToken) return res.status(400).json({ ok: false, message: 'Connect start.gg in Settings first.' });
    if (_startggImportRunning) return res.status(409).json({ ok: false, message: 'An import is already running.' });
    const nameQuery = (req.body && req.body.nameQuery || 'rocket rush').toString().slice(0, 80);
    const gameQuery = (req.body && req.body.gameQuery || 'rocket league').toString().slice(0, 80);
    _startggImportRunning = true;
    const client = createStartGgClient(startggApiToken);
    const onProgress = (p) => broadcast(bridgeClients, { type: 'startgg_import', data: p });
    res.json({ ok: true, started: true });
    startggImport.importFromStartgg({ client, stats, nameQuery, gameQuery, onProgress })
      .then((summary) => { broadcast(bridgeClients, { type: 'startgg_import', data: { message: 'Import complete.', summary, done: true } }); })
      .catch((err) => { broadcast(bridgeClients, { type: 'startgg_import', data: { message: 'Import failed: ' + err.message, error: true, done: true } }); })
      .finally(() => { _startggImportRunning = false; });
  });

  // Import ONE searched start.gg event (find-and-add) into the stats DB.
  app.post('/api/stats/import-startgg-event', (req, res) => {
    if (!startggApiToken) return res.status(400).json({ ok: false, message: 'Connect start.gg in Settings first.' });
    if (_startggImportRunning) return res.status(409).json({ ok: false, message: 'An import is already running.' });
    const eventId = req.body && req.body.eventId;
    if (!eventId) return res.status(400).json({ ok: false, message: 'eventId required' });
    const tournamentName = (req.body.tournamentName || '').toString().slice(0, 120);
    const gameType = (req.body.gameType || 'rl').toString();
    _startggImportRunning = true;
    const client = createStartGgClient(startggApiToken);
    const onProgress = (p) => broadcast(bridgeClients, { type: 'startgg_import', data: p });
    res.json({ ok: true, started: true });
    startggImport.importEventById({ client, stats, eventId, tournamentName, gameType, onProgress })
      .then((summary) => { broadcast(bridgeClients, { type: 'startgg_import', data: { message: 'Import complete.', summary, done: true } }); })
      .catch((err) => { broadcast(bridgeClients, { type: 'startgg_import', data: { message: 'Import failed: ' + err.message, error: true, done: true } }); })
      .finally(() => { _startggImportRunning = false; });
  });

  // ── Analytics: event / tournament (computed live from start.gg + bracket + stats) ──
  app.get('/api/analytics/event', (req, res) => {
    try {
      const sg = state.startgg || {}, br = state.bracket || {};
      let total = 0, done = 0;
      const countRounds = (rounds) => (rounds || []).forEach((r) => (r.sets || []).forEach((s) => {
        total++; if ((s.a && s.a.winner) || (s.b && s.b.winner)) done++;
      }));
      countRounds(br.winners); countRounds(br.losers); countRounds(br.finals);
      const feed = sg.matchFeed || [], queue = sg.queue || [];
      const liveCount = feed.filter((m) => m.status === 'live' || m.state === 2).length;
      const doneCount = feed.filter((m) => m.status === 'done' || m.state === 3).length;
      const upcomingCount = (queue.filter((m) => m.state === 1 || m.status === 'upcoming').length) || Math.max(0, (queue.length - liveCount));
      const sel = sg.selectedEvent || {};
      res.json({ ok: true, data: {
        event: { name: sel.name || state.eventName || '', tournament: sel.tournamentName || '', game: state.activeGame || '',
          entrants: (sg.eventTeams || []).length || 0 },
        bracket: { type: br.type || '', total, completed: done, pct: total ? Math.round(done / total * 100) : 0,
          phases: (br.phases || []).map((p) => ({ id: p.id, name: p.name, type: p.type })) },
        queue: { live: liveCount, done: doneCount, upcoming: upcomingCount, streams: sg.streams || [], following: sg.streamName || '' },
        pacing: stats.getPacing(), maps: stats.getMapStats(), tournaments: stats.getTournaments()
      } });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // ── Analytics: audience engagement (computed live from Twitch state) ───────
  app.get('/api/analytics/engagement', (req, res) => {
    try {
      const tw = state.twitch || {};
      const ph = (tw.predictions && tw.predictions.history) || [];
      const cur = tw.predictions && tw.predictions.current;
      const allPreds = cur ? [cur, ...ph] : ph.slice();
      const sumOut = (p, f) => (p.outcomes || []).reduce((a, o) => a + (o[f] || 0), 0);
      const predictions = {
        total: allPreds.length,
        resolved: allPreds.filter((p) => p.state === 'RESOLVED').length,
        cancelled: allPreds.filter((p) => p.state === 'CANCELLED').length,
        totalPoints: allPreds.reduce((a, p) => a + sumOut(p, 'votes'), 0),
        totalVoters: allPreds.reduce((a, p) => a + sumOut(p, 'users'), 0),
        recent: allPreds.slice(0, 10).map((p) => ({ title: p.title, state: p.state, points: sumOut(p, 'votes'), voters: sumOut(p, 'users'), createdAt: p.createdAt }))
      };
      const polls = (tw.poll && tw.poll.history) || [];
      const pollStats = { total: polls.length, totalVotes: polls.reduce((a, p) => a + (p.total || 0), 0),
        recent: polls.slice(0, 10).map((p) => ({ title: p.title, total: p.total, endedAt: p.endedAt })) };
      const wheel = tw.wheel || {}, wHist = wheel.history || [];
      const wheelStats = { spins: wHist.length, participants: (wheel.participants || []).length, byMethod: {} };
      (wheel.participants || []).forEach((p) => { wheelStats.byMethod[p.method] = (wheelStats.byMethod[p.method] || 0) + 1; });
      const mini = tw.minigame || {}, mHist = mini.history || [];
      const miniStats = { total: mHist.length, byType: {} };
      mHist.forEach((g) => { miniStats.byType[g.type] = (miniStats.byType[g.type] || 0) + 1; });
      const log = tw.activityLog || [];
      const act = { follow: 0, subscribe: 0, raid: 0, bits: 0, raidViewers: 0, bitsAmount: 0 };
      log.forEach((e) => {
        if (e.type === 'follow') act.follow++;
        else if (e.type === 'subscribe') act.subscribe++;
        else if (e.type === 'raid') { act.raid++; act.raidViewers += e.viewers || 0; }
        else if (e.type === 'bits') { act.bits++; act.bitsAmount += e.amount || 0; }
      });
      let stream = { isLive: false, viewers: 0, title: '', game: '' };
      try { if (typeof streamStateManager !== 'undefined' && streamStateManager) stream = { isLive: streamStateManager.streamState.isLive, viewers: streamStateManager.streamState.viewerCount, title: streamStateManager.streamState.title, game: streamStateManager.streamState.game }; } catch (e) {}
      res.json({ ok: true, data: { stream, predictions, polls: pollStats, wheel: wheelStats, minigames: miniStats, activity: act, recentActivity: log.slice(-40).reverse() } });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // ── VDO.Ninja talent links + local QR ────────────────────────────────────
  // Generate a QR locally (never sends the join URL — which carries the room password —
  // to any third-party service). <img src="/api/vdo/qr?text=<encoded join url>">
  app.get('/api/vdo/qr', (req, res) => {
    try {
      const text = req.query.text || '';
      if (!text) return res.status(400).send('text required');
      const QRCode = require('qrcode');
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      QRCode.toString(String(text), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000ff', light: '#ffffffff' } },
        (err, svg) => { if (err) return res.status(500).send(err.message); res.send(svg); });
    } catch (e) { res.status(500).send(e.message); }
  });

  // Resolved talent links — active match teams (blue/orange) + all saved teams.
  app.get('/api/vdo/links', (req, res) => {
    try {
      let mutated = false;
      // Provision the production/interview (caster) room + director API key up front so the control
      // center always has a transfer target + IFrame-API key to work with. The interview room IS
      // the caster/production room.
      if (!state.casters.vdo || !state.casters.vdo.room) { ensureCasterVdo(); mutated = true; }
      if (!state.casters.apiKey) { ensureDirectorApiKey(); mutated = true; }
      const pack = (side) => {
        const team = state.teams[side];
        if (!team) return null;
        if (!team.vdo || !team.vdo.room) { ensureTeamVdo(team); mutated = true; }
        const players = (team.players || []).map((p) => ({
          playerId: p.id, name: p.name || '', primaryid: p.primaryid || '',
          streamId: playerStreamId(p),
          joinUrl: buildTalentJoinUrl(team, p),
          obsUrl:  buildObsViewUrl(team, p),
          listenUrl: buildListenInUrl(team, p),
          audio: p.vdoAudio || null,
          // Interview workflow: pushed into the dedicated interview room; view = solo desk feed.
          interviewUrl: buildPlayerInterviewJoinUrl(p),
          interviewViewUrl: buildPlayerInterviewViewUrl(p)
        }));
        return { name: team.name, color: team.color, room: team.vdo.room, players,
          roomListenUrl: buildRoomListenInUrl(team), roomJoinUrl: buildRoomJoinUrl(team), directorUrl: buildDirectorUrl(team.vdo) };
      };
      // All saved teams — only include per-player links if the team already has a VDO room
      // (don't auto-provision here; explicit "generate" action does that).
      const allTeams = savedTeams.map((team) => {
        const hasRoom = !!(team.vdo && team.vdo.room && team.vdo.password);
        if (!hasRoom) return { name: team.name, color: team.color || null, room: null, hasRoom: false, players: [] };
        const players = (team.players || []).map((p) => ({
          playerId: p.id, name: p.name || '', primaryid: p.primaryid || '',
          streamId: playerStreamId(p),
          joinUrl: buildTalentJoinUrl(team, p),
          obsUrl:  buildObsViewUrl(team, p),
          listenUrl: buildListenInUrl(team, p),
          audio: p.vdoAudio || null,
          // Interview workflow: join the caster room for an on-desk interview, view = desk feed.
          interviewUrl: buildPlayerInterviewJoinUrl(p),
          interviewViewUrl: buildPlayerInterviewViewUrl(p)
        }));
        return { name: team.name, color: team.color || null, room: team.vdo.room, hasRoom: true, players };
      });
      const deskVdo = deskRoomVdo() || { room: '', password: '' };
      const prodRoom = { room: deskVdo.room || '', directorUrl: (deskVdo.room && deskVdo.password) ? buildDirectorUrl(deskVdo) : '' };
      const out = { ok: true, base: vdoBase(), lang: state.vdo?.lang || 'en-US',
        teams: { blue: pack('blue'), orange: pack('orange') }, allTeams,
        // Director control center: one API key for every embedded console; per-room director URLs.
        apiKey: ensureDirectorApiKey(),
        // The interview room IS the production/caster room — expose both keys pointing at it so
        // older client refs keep working.
        casterRoom: prodRoom,
        interview: prodRoom,
        // Named caster rooms also get a director console.
        namedRooms: (state.casters.rooms || []).filter(r => r.vdo && r.vdo.room).map(r => ({
          id: r.id, name: r.name, room: r.vdo.room, directorUrl: buildDirectorUrl(r.vdo)
        })) };

      // Three shared talent-group rooms (Casters / Guests / Observers), members from the library by
      // kind. Auto-provision a group's room as soon as it has a member so the Director can see it.
      const lib = state.casters.library || [];
      const casterMembers = lib.filter(p => p.kind !== 'host' && p.kind !== 'observer');
      const guestMembers  = lib.filter(p => p.kind === 'host');
      const obsMembers    = lib.filter(p => p.kind === 'observer');
      if (casterMembers.length && (!state.casters.vdo || !state.casters.vdo.room)) { ensureCasterVdo(); mutated = true; }
      if (guestMembers.length  && (!state.casters.guestsVdo || !state.casters.guestsVdo.room)) { ensureGuestsVdo(); mutated = true; }
      if (obsMembers.length    && (!state.casters.observersVdo || !state.casters.observersVdo.room)) { ensureObserversVdo(); mutated = true; }
      // The casters group is the "Hosts" desk (room = state.casters.vdo, no separate interview/desk);
      // Guests and Observers each keep their own shared room.
      out.groups = {
        casters:   buildTalentGroup('HOSTS',     '#e83a8b', state.casters.vdo,           casterMembers),
        guests:    buildTalentGroup('LOBBY',     '#a855f7', state.casters.guestsVdo,      guestMembers),
        observers: buildTalentGroup('OBSERVERS', '#2dd4bf', state.casters.observersVdo,   obsMembers),
      };

      if (mutated) saveAppState();
      res.json(out);
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // Resolved caster VDO links — shared caster room + per-caster join/obs URLs.
  app.get('/api/vdo/caster-links', (req, res) => {
    try {
      const vdo = state.casters?.vdo;
      const hasRoom = !!(vdo && vdo.room && vdo.password);
      const casters = (state.casters?.list || []).map((c) => {
        const sid = vdoSlug(c.streamId || c.handle || c.name || 'caster');
        return {
          id: c.id, name: c.name || '', handle: c.handle || '', streamId: sid,
          joinUrl: hasRoom ? buildCasterJoinUrl(c) : '',
          obsUrl:  hasRoom ? buildCasterObsUrl(c) : ''
        };
      });
      res.json({ ok: true, hasRoom, room: hasRoom ? vdo.room : null, casters });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // ── Overwolf GEP → Overwatch live game data ─────────────────────────────────
  // Called by the companion Overwolf app on the spectator PC (same relay pattern as
  // Marvel Rivals below). Body: { roster: [{player_name,battlenet_tag,hero_name,hero_role,
  // team,kills,deaths,assists,damage,healed,mitigated,is_local}×12], map, game_mode,
  // game_state, match_outcome }
  app.post('/api/ow-gep', express.json({ limit: '64kb' }), (req, res) => {
    const b = req.body || {};
    if (!state.owMatch) {
      state.owMatch = { visible: true, format: 'FT3', currentMapIdx: 0, bansByMap: [], gameMode: 'escort', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    }
    const prev = state.owMatch.gepData || {};
    state.owMatch.gepData = {
      gepConnected: true,
      lastSeen: Date.now(),
      roster: Array.isArray(b.roster) ? b.roster.slice(0, 12) : (prev.roster || []),
      map: (typeof b.map === 'string' && b.map) ? b.map : (prev.map || null),
      game_mode: (typeof b.game_mode === 'string' && b.game_mode) ? b.game_mode : (prev.game_mode || null),
      game_state: b.game_state || prev.game_state || null,
      match_outcome: b.match_outcome || null
    };
    // Auto game-mode: GEP mode strings map cleanly onto the scoreboard's mode set.
    const gm = String(b.game_mode || '').toLowerCase();
    const hit = ['escort', 'hybrid', 'control', 'push', 'flashpoint', 'clash'].find((k) => gm.includes(k));
    if (hit) state.owMatch.gameMode = hit;
    // GEP match/round events -> Flow triggers (same shape as the CS2 GSI ones). The
    // companion posts { events: ['match_start' | 'round_start' | 'round_end' | 'match_end', ...] }.
    const OW_EVENT_TRIGGERS = { match_start: 'ow_match_start', round_start: 'ow_round_start', round_end: 'ow_round_end', match_end: 'ow_match_end' };
    (Array.isArray(b.events) ? b.events : []).forEach((ev) => {
      const name = typeof ev === 'string' ? ev : (ev && ev.name);
      const trig = OW_EVENT_TRIGGERS[String(name || '').toLowerCase()];
      if (trig) flowBus.emit(trig, {
        map: state.owMatch.gepData.map || null,
        game_mode: state.owMatch.gepData.game_mode || null,
        match_outcome: state.owMatch.gepData.match_outcome || null
      });
    });
    broadcastFullState();
    res.json({ ok: true });
  });

  // ── Overwolf GEP → Marvel Rivals live game data ─────────────────────────────
  // Called by the companion Overwolf app (companion-overwolf/) on a PC that is IN the
  // match — GEP reads the local client (see docs/marvel-rivals-production.md §3).
  // Body: { roster: [{name,character_name,character_id,team,kills,deaths,assists,ult_charge,is_alive,…}×12],
  //         map, game_mode, game_type, match_id, scene, match_outcome,
  //         banned_characters: [{character_id,character_name,is_teammate}], selected_character,
  //         player_stats: {damage_dealt,damage_block,accuracy,total_heal},
  //         objective_progress: {game_mode,checkpoint,left_capture,right_capture,team},
  //         events: ['match_start'|'round_start'|'round_end'|'match_end' | {name:'kill_feed',data:{attacker,victim}}] }
  app.post('/api/mr-gep', express.json({ limit: '64kb' }), (req, res) => {
    const body = req.body || {};
    if (!state.mrMatch) {
      state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    }
    const prevGep = state.mrMatch.gepData || {};
    state.mrMatch.gepData = {
      gepConnected: true,
      lastSeen: Date.now(),
      roster: Array.isArray(body.roster) ? body.roster.slice(0, 12) : (prevGep.roster || []),
      map: typeof body.map === 'string' && body.map ? body.map : (prevGep.map || null),
      game_mode: typeof body.game_mode === 'string' && body.game_mode ? body.game_mode : (prevGep.game_mode || null),
      game_type: typeof body.game_type === 'string' && body.game_type ? body.game_type : (prevGep.game_type || null),
      match_id: body.match_id || prevGep.match_id || null,
      scene: body.scene || prevGep.scene || null,
      match_outcome: body.match_outcome || null,
      banned_characters: Array.isArray(body.banned_characters) ? body.banned_characters : (prevGep.banned_characters || []),
      selected_character: body.selected_character || prevGep.selected_character || null,
      player_stats: body.player_stats || prevGep.player_stats || null,
      objective_progress: body.objective_progress || prevGep.objective_progress || null,
      killFeed: Array.isArray(prevGep.killFeed) ? prevGep.killFeed : []
    };
    // Auto game-mode: GEP mode strings map onto the series scoreboard's mode set
    // (objective_progress.game_mode is the reliable one; match_info.game_mode is a display name).
    const mrGm = String(body.game_mode || (body.objective_progress && body.objective_progress.game_mode) || '').toLowerCase();
    const mrHit = ['convergence', 'domination', 'convoy'].find((k) => mrGm.includes(k.slice(0, 6)));
    if (mrHit) state.mrMatch.gameMode = mrHit;
    // GEP match/round events → Flow triggers (same shape as the Overwatch relay above).
    // kill_feed entries accumulate on gepData.killFeed (last 12) for overlay use.
    const MR_EVENT_TRIGGERS = { match_start: 'mr_match_start', round_start: 'mr_round_start', round_end: 'mr_round_end', match_end: 'mr_match_end' };
    (Array.isArray(body.events) ? body.events : []).forEach((ev) => {
      const name = String((typeof ev === 'string' ? ev : (ev && ev.name)) || '').toLowerCase();
      if (name === 'kill_feed') {
        const kf = (ev && ev.data) || {};
        state.mrMatch.gepData.killFeed = state.mrMatch.gepData.killFeed
          .concat([{ attacker: kf.attacker || null, victim: kf.victim || null, ts: Date.now() }]).slice(-12);
        return;
      }
      const trig = MR_EVENT_TRIGGERS[name];
      if (trig) flowBus.emit(trig, {
        map: state.mrMatch.gepData.map || null,
        game_mode: state.mrMatch.gepData.game_mode || null,
        match_outcome: state.mrMatch.gepData.match_outcome || null
      });
    });
    broadcastFullState();
    res.json({ ok: true });
  });

  // ── In-app bug report → Discord webhook + GitHub Issues ──────────────────────
  // This route is registered before the global express.json() below, so it needs
  // its own body parser — otherwise req.body is empty and reports look blank.
  // GITHUB_TOKEN is a dev-only secret (like BUG_REPORT_WEBHOOK) — NOT in gen-prod-env.js's
  // PUBLIC_KEYS, so it's stripped from distributed builds; only Armour's own dev environment
  // files real GitHub issues. Discord and GitHub are attempted independently — either one
  // succeeding counts as an overall success, so a misconfigured/down one doesn't block the other.
  app.post('/api/bug-report', express.json({ limit: '12mb' }), async (req, res) => {
    const hook = process.env.BUG_REPORT_WEBHOOK || '';
    const ghToken = process.env.GITHUB_TOKEN || '';
    const ghRepo = process.env.GITHUB_REPO || 'armour-studios/NEBroadcastSuite';
    if (!hook && !ghToken) return res.status(503).json({ ok: false, message: 'No bug-report destination configured (set BUG_REPORT_WEBHOOK and/or GITHUB_TOKEN in .env.local).' });
    const b = req.body || {};
    const isFeature = b.type === 'feature';
    const title = String(b.title || '').trim().slice(0, 256);
    const description = String(b.description || '').trim().slice(0, 3800);
    if (!title && !description) return res.status(400).json({ ok: false, message: 'Add a title or description.' });

    const ctx = b.context || {};
    const fields = [];

    if (isFeature) {
      const PRI = {
        'nice-to-have':  { emoji: '🔵', label: 'Nice to have' },
        'would-help':    { emoji: '🟡', label: 'Would help a lot' },
        'essential':     { emoji: '🔴', label: 'Essential to workflow' },
      };
      const pri = PRI[b.priority] || PRI['would-help'];
      fields.push({ name: 'Priority', value: `${pri.emoji} ${pri.label}`, inline: true });
      if (b.category) fields.push({ name: '📂 Area', value: String(b.category).slice(0, 100), inline: true });
      if (ctx.page)   fields.push({ name: '📄 Page', value: String(ctx.page).slice(0, 100), inline: true });
      if (b.reporter) fields.push({ name: '🧑 Requested by', value: String(b.reporter).slice(0, 100), inline: true });
    } else {
      const SEV = {
        low:      { color: 0x4ade80, emoji: '🟢' },
        medium:   { color: 0xfbbf24, emoji: '🟡' },
        high:     { color: 0xf97316, emoji: '🟠' },
        critical: { color: 0xdc2626, emoji: '🔴' }
      };
      const severity = ['low', 'medium', 'high', 'critical'].includes(b.severity) ? b.severity : 'medium';
      const sev = SEV[severity];
      fields.push({ name: 'Severity', value: `${sev.emoji} ${severity.toUpperCase()}`, inline: true });
      if (b.category) fields.push({ name: '📂 Area',     value: String(b.category).slice(0, 100), inline: true });
      if (ctx.page)   fields.push({ name: '📄 Page',     value: String(ctx.page).slice(0, 100),   inline: true });
      if (ctx.game)   fields.push({ name: '🎮 Game',     value: String(ctx.game).slice(0, 100),   inline: true });
      if (b.reporter) fields.push({ name: '🧑 Reporter', value: String(b.reporter).slice(0, 100), inline: true });
    }

    // Optional screenshot (data URL). Decode → attach to the embed via attachment:// .
    let imgBuf = null, imgName = null;
    if (!isFeature && typeof b.image === 'string' && b.image.startsWith('data:image/')) {
      const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.image);
      if (m) {
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 0 && buf.length <= 8 * 1024 * 1024) {
          imgBuf = buf;
          imgName = 'screenshot.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
        }
      }
    }

    // Optional browser console log (recent output + any uncaught errors, captured client-side).
    // Kept as a plain-text FILE attachment rather than jammed into the embed — Discord embed
    // fields/descriptions have small character limits a console dump blows through instantly.
    let logBuf = null;
    const LOG_NAME = 'console.log';
    const LOG_CAP = 60000;   // defense in depth — cap regardless of what the client already trimmed
    if (typeof b.consoleLog === 'string' && b.consoleLog.trim()) {
      const raw = b.consoleLog;
      const capped = raw.length > LOG_CAP ? `…(truncated, showing the most recent output)…\n${raw.slice(-LOG_CAP)}` : raw;
      logBuf = Buffer.from(capped, 'utf8');
    }

    const severity = ['low', 'medium', 'high', 'critical'].includes(b.severity) ? b.severity : 'medium';
    const embedColor = isFeature ? 0x7c3aed : { low: 0x4ade80, medium: 0xfbbf24, high: 0xf97316, critical: 0xdc2626 }[severity];
    const embed = {
      author: { name: isFeature ? 'NE Broadcast Suite · Feature Request' : 'NE Broadcast Suite · Bug Report' },
      title: (title || (isFeature ? 'Feature request' : 'Bug report')).slice(0, 256),
      description: description || '_(no details provided)_',
      color: embedColor,
      fields,
      footer: { text: `${(ctx.app || 'NE Broadcast Suite')} · v${appVersion}` },
      timestamp: new Date().toISOString()
    };
    if (imgBuf) embed.image = { url: `attachment://${imgName}` };

    // Discord supports multiple files per message (files[0], files[1], …) each needing a matching
    // {id, filename} entry in `attachments` — build both lists together so ids always line up.
    const discordFiles = [];
    if (imgBuf) {
      const ext = imgName.split('.').pop();
      discordFiles.push({ id: discordFiles.length, filename: imgName, buf: imgBuf, mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` });
    }
    if (logBuf) discordFiles.push({ id: discordFiles.length, filename: LOG_NAME, buf: logBuf, mime: 'text/plain' });

    const payload = {
      username: isFeature ? 'NE Feature Requests' : 'NE Bug Reports',
      embeds: [embed],
      ...(discordFiles.length ? { attachments: discordFiles.map((f) => ({ id: f.id, filename: f.filename })) } : {})
    };

    const result = { discordOk: false, githubOk: false, githubUrl: null, errors: [] };

    // Use axios (Node 16 in Electron has no global fetch). 8s timeout so a slow/unreachable
    // Discord can't hang the request. Discord returns 204 on success → axios resolves on 2xx.
    if (hook) {
      try {
        if (discordFiles.length) {
          const form = new FormData();
          form.append('payload_json', JSON.stringify(payload), { contentType: 'application/json' });
          discordFiles.forEach((f) => form.append(`files[${f.id}]`, f.buf, { filename: f.filename, contentType: f.mime }));
          await axios.post(hook, form, { headers: form.getHeaders(), timeout: 12000, maxContentLength: Infinity, maxBodyLength: Infinity });
        } else {
          await axios.post(hook, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
        }
        result.discordOk = true;
      } catch (e) {
        if (e.response) {
          const txt = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data || {});
          result.errors.push(`Discord rejected the report (${e.response.status}). ${String(txt).slice(0, 160)}`);
        } else {
          result.errors.push((e.code === 'ECONNABORTED') ? 'Discord did not respond in time (timed out).' : e.message);
        }
      }
    }

    if (ghToken) {
      try {
        const labels = [isFeature ? 'enhancement' : 'bug'];
        if (!isFeature) labels.push('severity:' + severity);
        if (b.category) labels.push('area:' + String(b.category).slice(0, 40));
        let bodyLines = [
          description || '_(no details provided)_',
          '',
          '---',
          b.reporter ? `**Reporter:** ${b.reporter}` : '',
          ctx.page ? `**Page:** ${ctx.page}` : '',
          ctx.game ? `**Game:** ${ctx.game}` : '',
          imgBuf ? '_A screenshot was attached to the Discord report._' : '',
          `_Submitted from ${(ctx.app || 'NE Broadcast Suite')} v${appVersion}_`
        ].filter(Boolean).join('\n');
        // GitHub issue bodies have plenty of headroom (65536 chars) but a raw dump is unwieldy —
        // wrap it in a collapsed <details> block so it's there without overwhelming the issue.
        if (logBuf) {
          const GH_LOG_CAP = 15000;
          const logText = logBuf.toString('utf8');
          const ghLog = logText.length > GH_LOG_CAP ? logText.slice(-GH_LOG_CAP) : logText;
          bodyLines += `\n\n<details>\n<summary>Console log${ghLog.length < logText.length ? ' (truncated, most recent output)' : ''}</summary>\n\n\`\`\`\n${ghLog}\n\`\`\`\n\n</details>`;
        }
        const ghRes = await axios.post(`https://api.github.com/repos/${ghRepo}/issues`, {
          title: (title || (isFeature ? 'Feature request' : 'Bug report')).slice(0, 256),
          body: bodyLines,
          labels
        }, {
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          timeout: 10000
        });
        result.githubOk = true;
        result.githubUrl = (ghRes.data && ghRes.data.html_url) || null;
      } catch (e) {
        if (e.response) {
          const txt = typeof e.response.data === 'string' ? e.response.data : JSON.stringify((e.response.data && e.response.data.message) || e.response.data || {});
          result.errors.push(`GitHub rejected the issue (${e.response.status}). ${String(txt).slice(0, 160)}`);
        } else {
          result.errors.push((e.code === 'ECONNABORTED') ? 'GitHub did not respond in time (timed out).' : e.message);
        }
      }
    }

    if (result.discordOk || result.githubOk) {
      res.json({ ok: true, discordOk: result.discordOk, githubOk: result.githubOk, githubUrl: result.githubUrl, message: result.errors.join(' ') || undefined });
    } else {
      res.status(502).json({ ok: false, message: result.errors.join(' ') || 'Failed to send report.' });
    }
  });

  // Middleware to strip Range headers (prevents Range Not Satisfiable errors)
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      delete req.headers['range'];
    }
    next();
  });

  // Overlay HTML/JS/CSS must never be cached — OBS's embedded browser (CEF) caches
  // hard and would keep showing a stale overlay after edits. Force revalidation.
  app.use(express.static(path.join(baseDir, 'overlay'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }));

  // Auto-reload overlays when their files change on disk (app update, overlay editor save,
  // manual edit). Headers are already no-store, but a page LOADED in OBS's CEF stays in
  // memory until reloaded — this pushes the reload so producers never touch OBS's cache.
  //
  // CRITICAL: only reload when a watched file's CONTENT actually changes. fs.watch fires on
  // metadata-only touches too — and when the project lives under OneDrive (or an AV scanner is
  // active), those touches are near-constant, which used to reload every overlay browser source
  // on a loop ("lots of full-frame refreshes"). We dedupe by SHA-1 of the bytes and pre-hash on
  // startup so the first spurious touch after boot doesn't reload either.
  try {
    const _crypto = require('crypto');
    const overlayDir = path.join(baseDir, 'overlay');
    const _ovHashes = new Map();
    const _ovPending = new Set();
    let _ovReloadTimer = null;
    const _hashFile = (rel) => {
      try { return _crypto.createHash('sha1').update(fs.readFileSync(path.join(overlayDir, rel))).digest('hex'); }
      catch (_) { return null; }
    };
    // Seed hashes for the files present at boot so a metadata-only touch is a no-op.
    try { fs.readdirSync(overlayDir).forEach((f) => { if (/\.(html|css|js)$/i.test(f)) { const h = _hashFile(f); if (h) _ovHashes.set(f, h); } }); } catch (_) {}

    fs.watch(overlayDir, { recursive: true }, (evt, file) => {
      if (!file || !/\.(html|css|js)$/i.test(file)) return;
      if (/(^|[\\/])~\$|\.tmp$|\.crdownload$|\.swp$/i.test(file)) return;   // editor / OneDrive / download temp files
      _ovPending.add(file);
      clearTimeout(_ovReloadTimer);
      _ovReloadTimer = setTimeout(() => {
        const pending = [..._ovPending]; _ovPending.clear();
        const changed = [];
        for (const rel of pending) {
          const h = _hashFile(rel);
          if (h && _ovHashes.get(rel) !== h) { _ovHashes.set(rel, h); changed.push(rel); }
        }
        if (changed.length) {
          console.log(`[Overlay] content changed (${changed.join(', ')}) — reloading affected overlay sources`);
          // Pass the changed files so each overlay reloads ONLY if it's affected (and can hot-swap
          // a pure CSS change without blanking). Editing standings.html won't touch the bracket source.
          broadcast(bridgeClients, { type: 'reload_overlays', files: changed });
        }
      }, 1000);
    });
  } catch (e) { console.warn('[Overlay] file watcher unavailable:', e.message); }

  // Serve assets
  app.use('/assets', express.static(path.join(baseDir, 'assets')));

  // Serve userData (clips, logos, exports) — with CORS so the control-panel can
  // draw clip frames to canvas for thumbnails (file:// → localhost cross-origin).
  app.use('/data', express.static(dataDir, {
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  }));

  // Parse JSON bodies (GSI payloads can be a bit large)
  // Capture raw body for Twitch webhook signature verification using verify callback
  app.use(express.json({
    limit: '2mb',
    verify: (req, res, buf, encoding) => {
      // Store raw body for webhook signature verification
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  }));

  // ─── Clips API ────────────────────────────────────────────────────────────
  // Scan the OBS replay/output folder for video files not yet imported.
  app.get('/api/clips/scan-folder', async (req, res) => {
    try {
      const folder = state.clips?.replayFolder || '';
      if (!folder) return res.json({ ok: true, files: [], reason: 'No folder configured' });
      if (!fs.existsSync(folder)) return res.json({ ok: true, files: [], reason: 'Folder not found' });

      const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.ts', '.flv', '.avi', '.wmv']);
      // Async walk — a big replay folder scanned with readdirSync/statSync stalls the window.
      const entries = await fsp.readdir(folder);
      const library = (clipSystem ? clipSystem.getState().library : []) || [];
      // Match by sourceFile (exact original path) so the staging area can show ✓ imported
      const importedSourceFiles = new Set(library.map(c => path.resolve(c.sourceFile || '')).filter(Boolean));
      const importedPaths = new Set(library.map(c => path.resolve(c.path || '')).filter(Boolean));

      const allFiles = [];
      for (const f of entries) {
        if (!VIDEO_EXT.has(path.extname(f).toLowerCase())) continue;
        const full = path.join(folder, f);
        try {
          const stat = await fsp.stat(full);
          const resolved = path.resolve(full);
          const imported = importedPaths.has(resolved) || importedSourceFiles.has(resolved);
          const importedClip = library.find(c =>
            path.resolve(c.sourceFile || '') === resolved ||
            path.resolve(c.path || '') === resolved
          );
          allFiles.push({ name: f, path: full, size: stat.size, mtimeMs: stat.mtimeMs, imported, importedId: importedClip?.id || null });
        } catch { /* unreadable file — skip */ }
      }
      allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

      // Cap the payload for safety on huge folders, but report the TRUE total so the count
      // stays accurate (the old 100 cap made the count pin at 100 and never drop on delete).
      const MAX_STAGING = 1000;
      res.json({ ok: true, files: allFiles.slice(0, MAX_STAGING), total: allFiles.length, folder });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Stream a video file from the replay folder (or clips dir) so the panel can
  // preview it and the overlay can play it. Path-restricted; sendFile supports Range.
  app.get('/api/clips/file', (req, res) => {
    try {
      const abs = path.resolve(String(req.query.path || ''));
      const folder = state.clips?.replayFolder ? path.resolve(state.clips.replayFolder) : '';
      const clipsDir = clipSystem ? path.resolve(clipSystem.manager.getClipsDir()) : '';
      const inside = (root) => root && (abs === root || abs.startsWith(root + path.sep));
      if (!inside(folder) && !inside(clipsDir)) return res.status(403).end();
      if (!fs.existsSync(abs)) return res.status(404).end();
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.sendFile(abs);
    } catch (e) {
      res.status(500).end();
    }
  });

  // Server-generated poster thumbnail (a single frame via ffmpeg, cached on disk by path+mtime).
  // Far more reliable than decoding the video in the browser for the staging list.
  app.get('/api/clips/thumb', (req, res) => {
    try {
      const abs = path.resolve(String(req.query.path || ''));
      const folder = state.clips?.replayFolder ? path.resolve(state.clips.replayFolder) : '';
      const clipsDir = clipSystem ? path.resolve(clipSystem.manager.getClipsDir()) : '';
      const inside = (root) => root && (abs === root || abs.startsWith(root + path.sep));
      if (!inside(folder) && !inside(clipsDir)) return res.status(403).end();
      if (!fs.existsSync(abs)) return res.status(404).end();
      if (!clipsDir) return res.status(503).end();

      const stat = fs.statSync(abs);
      // 'v2' invalidates the earlier (often-black) cached thumbnails.
      const key = require('crypto').createHash('md5').update(abs + ':' + stat.mtimeMs + ':v2').digest('hex');
      const thumbDir = path.join(clipsDir, 'thumbs');
      fs.mkdirSync(thumbDir, { recursive: true });
      const thumbPath = path.join(thumbDir, key + '.jpg');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);

      const ff = (clipSystem && clipSystem.encoder && clipSystem.encoder.ffmpegPath && clipSystem.encoder.ffmpegPath()) || 'ffmpeg';
      const ffprobe = (ff !== 'ffmpeg') ? ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : 'ffprobe';
      const { spawn } = require('child_process');
      let done = false;
      const finish = (ok) => { if (done) return; done = true; if (ok && fs.existsSync(thumbPath)) res.sendFile(thumbPath); else res.status(404).end(); };

      // Replay clips often have a long black fade-in, so seek to ~45% (mid-clip) for a real frame.
      let probed = '';
      let probe;
      try { probe = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs], { windowsHide: true }); }
      catch (e) { probe = null; }
      const extract = () => {
        const dur = parseFloat(probed) || 0;
        const seek = dur > 4 ? (dur * 0.45).toFixed(1) : '0.5';
        const proc = spawn(ff, ['-y', '-ss', seek, '-i', abs, '-frames:v', '1', '-vf', 'scale=240:-1', '-q:v', '3', thumbPath], { windowsHide: true });
        proc.on('close', (code) => finish(code === 0));
        proc.on('error', () => finish(false));
      };
      if (probe) {
        probe.stdout.on('data', (d) => { probed += d.toString(); });
        probe.on('close', extract);
        probe.on('error', extract);
      } else { extract(); }
      setTimeout(() => finish(false), 15000);
    } catch (e) { res.status(500).end(); }
  });

  // Rename a file in the OBS replay/staging folder (path-restricted to that folder only).
  app.post('/api/clips/rename-staged', (req, res) => {
    try {
      const abs = path.resolve(String(req.body?.filePath || ''));
      const folder = state.clips?.replayFolder ? path.resolve(state.clips.replayFolder) : '';
      if (!folder || !(abs === folder || abs.startsWith(folder + path.sep))) return res.status(403).json({ ok: false, message: 'Path outside replay folder' });
      if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, message: 'File not found' });
      const ext = path.extname(abs);
      let safe = String(req.body?.newName || '').replace(/[\\/:*?"<>|]+/g, '').trim();
      if (!safe) return res.status(400).json({ ok: false, message: 'Enter a valid name' });
      if (!safe.toLowerCase().endsWith(ext.toLowerCase())) safe += ext;
      const dest = path.join(path.dirname(abs), safe);
      if (path.resolve(dest) === abs) return res.json({ ok: true, path: abs, name: safe });
      if (fs.existsSync(dest)) return res.status(409).json({ ok: false, message: 'A file with that name already exists' });
      fs.renameSync(abs, dest);
      res.json({ ok: true, path: dest, name: safe });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // Delete a file from the OBS replay/staging folder (path-restricted to that folder only).
  app.post('/api/clips/delete-staged', (req, res) => {
    try {
      const abs = path.resolve(String(req.body?.filePath || ''));
      const folder = state.clips?.replayFolder ? path.resolve(state.clips.replayFolder) : '';
      if (!folder || !abs.startsWith(folder + path.sep)) return res.status(403).json({ ok: false, message: 'Path outside replay folder' });
      if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, message: 'File not found' });
      fs.unlinkSync(abs);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Import a specific file from the replay folder into the clip library.
  app.post('/api/clips/import-file', (req, res) => {
    try {
      const { filePath, label } = req.body || {};
      if (!filePath) return res.status(400).json({ ok: false, message: 'filePath required' });
      if (!fs.existsSync(filePath)) return res.status(400).json({ ok: false, message: 'File not found' });
      if (!clipSystem) return res.status(503).json({ ok: false, message: 'Clip system not ready' });

      clipSystem.manager.importReplayFile(filePath, { label: label || path.basename(filePath, path.extname(filePath)) })
        .then((clip) => {
          broadcastClipsUpdate();
          res.json({ ok: true, clip });
        })
        .catch(e => res.status(500).json({ ok: false, message: e.message }));
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // GET /api/clips — return the local clip library for the Social page
  app.get('/api/clips', (req, res) => {
    if (!clipSystem) return res.json({ library: [], clips: [] });
    const { library } = clipSystem.getState();
    res.json({ library: library || [], clips: library || [] });
  });

  // POST /api/clips/social-encode — bake intro + clip + outro into a social-ready MP4
  app.post('/api/clips/social-encode', (req, res) => {
    if (!clipSystem) return res.status(503).json({ error: 'Clip system not ready' });
    const { introId, clipId, outroId, opts = {} } = req.body || {};
    if (!clipId) return res.status(400).json({ error: 'No clip selected' });
    const library = clipSystem.getState().library || [];
    const findClip = (id) => (id ? library.find((c) => c.id === id) : null);
    const mainClip = findClip(clipId);
    if (!mainClip || !mainClip.path) return res.status(400).json({ error: 'Clip not found or has no video file' });
    const segments = [];
    const intro = findClip(introId);
    if (intro && intro.path) segments.push({ path: intro.path, trimIn: 0, trimOut: null, name: 'Intro' });
    segments.push({ path: mainClip.path, trimIn: mainClip.trimIn || 0, trimOut: mainClip.trimOut || null, name: mainClip.name || 'Clip' });
    const outro = findClip(outroId);
    if (outro && outro.path) segments.push({ path: outro.path, trimIn: 0, trimOut: null, name: 'Outro' });
    const safeName = 'social_' + (mainClip.name || 'clip').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const jobId = clipSystem.encoder.enqueue({
      name: safeName,
      segments,
      opts: { quality: opts.quality || 'high', transition: opts.transition || 'fade', format: '.mp4' }
    });
    res.json({ ok: true, jobId });
  });

  // The control panel runs from a file:// origin (Electron loadFile), so allow it to
  // read these localhost-only API responses cross-origin.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Hands the WS bridge auth token to same-host clients (control panel + overlay browser
  // sources) so they can open ws://…:3001/?token=… — see getOrCreateWsToken() / the
  // bridgeWss connection handler in startBridgeServer(). Same trust boundary as every
  // other route on this HTTP server; the point isn't to hide the token from this host,
  // it's to keep a bare port-scan of :3001 from getting in when WS_HOST=0.0.0.0 is set.
  app.get('/api/ws-token', (req, res) => {
    res.json({ token: wsAuthToken });
  });

  // ── Pulse multiview ───────────────────────────────────────────────────────
  // overlay/pulse.html (a same-origin browser source) fetches this; we proxy the org's live games
  // from the cloud using THIS app's stored session, so no credentials ever ride the browser source.
  // Any failure / unlinked app returns an empty list → pulse.html falls back to its demo slate.
  function pulseOrgId() {
    const s = cloud.getSession();
    if (!cloud.authed() || !s.workspaceId || String(s.workspaceId).startsWith('user:')) return null;
    return s.workspaceId;
  }
  app.get('/api/multiview', async (req, res) => {
    const orgId = pulseOrgId();
    if (!orgId) return res.json({ games: [] });
    try { res.json({ games: await cloud.getMultiview(orgId) }); }
    catch (e) { res.json({ games: [] }); }
  });

  // Heartbeat: publish THIS app's live game so it shows on other producers' Pulse. Opt-in
  // (state.pulse.publish) + only when the cloud is linked — otherwise a no-op. Stops publishing (and
  // clears the row) when disabled. The teams come from the shared library, the score/clock from live
  // state, so an observer keys in nothing beyond flipping the toggle.
  const PULSE_UNIT = { 'rocket-league': 'g', 'csgo': 'rd', 'valorant': 'rd', 'rainbow6': 'rd', 'cod': 'rd', 'overwatch': 'pt', 'marvel-rivals': 'pt', 'league': 'pt', 'dota2': 'pt', 'mobile-legends': 'pt', 'honor-of-kings': 'pt' };
  let _pulseWasPublishing = false;
  setInterval(async () => {
    const orgId = pulseOrgId();
    const on = !!(state.pulse && state.pulse.publish) && !!orgId;
    if (!on) {
      if (_pulseWasPublishing && orgId) { try { await cloud.stopObservedGame(orgId); } catch (e) { /* ignore */ } }
      _pulseWasPublishing = false;
      return;
    }
    try {
      const g = GAMES[state.activeGame] || {};
      const blue = (state.teams && state.teams.blue) || {}, orange = (state.teams && state.teams.orange) || {};
      const live = state.game || {};
      const feedUrl = (state.pulse.feedViewUrl || '').trim();
      await cloud.publishObservedGame(orgId, {
        game: g.name || state.activeGame,
        teams: {
          a: { name: blue.name || 'Team A', logo: blue.logo || null, color: blue.color || null, score: Number(live.blueScore || 0) },
          b: { name: orange.name || 'Team B', logo: orange.logo || null, color: orange.color || null, score: Number(live.orangeScore || 0) }
        },
        clock: Number(live.time || 0),
        status: (state.roundLabel || (state.series ? `Series ${state.series.blue}-${state.series.orange}` : '') || '').toString().slice(0, 60),
        unit: PULSE_UNIT[state.activeGame] || 'score',
        feed: feedUrl ? { viewUrl: feedUrl } : undefined
      });
      _pulseWasPublishing = true;
    } catch (e) { /* transient — try again next tick */ }
  }, 3000);

  // ── Media library ─────────────────────────────────────────────────────────
  // Browsable image store under <dataDir>/media, served at /data/media/<...>.
  // Reusable picker source for Brands, Teams, Scenes. Local album = filesystem;
  // Web album = paste-a-URL (stored as a small .url pointer); Cloud is reserved.
  const mediaRoot = path.join(dataDir, 'media');
  try { fs.mkdirSync(mediaRoot, { recursive: true }); } catch (e) { /* ignore */ }
  const mediaJson = express.json({ limit: '40mb' });   // images can exceed the global 2mb cap
  const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

  // Resolve a client-supplied relative path safely inside mediaRoot (no traversal).
  function safeMediaPath(rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.normalize(path.join(mediaRoot, clean));
    if (abs !== mediaRoot && !abs.startsWith(mediaRoot + path.sep)) return null;
    return abs;
  }

  app.get('/api/media/list', async (req, res) => {
    const rel = req.query.path || '';
    const abs = safeMediaPath(rel);
    if (!abs) return res.status(400).json({ ok: false, error: 'Bad path' });
    try {
      const entries = fs.existsSync(abs) ? await fsp.readdir(abs, { withFileTypes: true }) : [];
      const folders = [], files = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const childRel = (rel ? rel.replace(/\/+$/, '') + '/' : '') + e.name;
        if (e.isDirectory()) {
          folders.push({ name: e.name, path: childRel });
        } else if (IMG_RE.test(e.name)) {
          let size = 0; try { size = (await fsp.stat(path.join(abs, e.name))).size; } catch (x) {}
          files.push({ name: e.name, path: childRel, url: '/data/media/' + childRel.split('/').map(encodeURIComponent).join('/'), size });
        }
      }
      res.json({ ok: true, path: rel, folders, files });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/media/folder', mediaJson, async (req, res) => {
    const { path: rel, name } = req.body || {};
    const safeName = String(name || '').replace(/[^\w\-. ]+/g, '').trim();
    if (!safeName) return res.status(400).json({ ok: false, error: 'Bad folder name' });
    const abs = safeMediaPath((rel ? rel + '/' : '') + safeName);
    if (!abs) return res.status(400).json({ ok: false, error: 'Bad path' });
    try { await fsp.mkdir(abs, { recursive: true }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/media/upload', mediaJson, async (req, res) => {
    const { path: rel, name, dataUrl, url } = req.body || {};
    const safeName = String(name || '').replace(/[^\w\-. ]+/g, '_').trim();
    if (!safeName) return res.status(400).json({ ok: false, error: 'Missing file name' });
    const dir = safeMediaPath(rel || '');
    if (!dir) return res.status(400).json({ ok: false, error: 'Bad path' });
    try {
      await fsp.mkdir(dir, { recursive: true });
      // Web album: store a tiny .url pointer instead of binary data.
      if (url && !dataUrl) {
        await fsp.writeFile(path.join(dir, safeName.replace(IMG_RE, '') + '.url'), String(url));
        return res.json({ ok: true, web: true });
      }
      const m = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl || '');
      if (!m) return res.status(400).json({ ok: false, error: 'Expected a base64 data URL' });
      const fname = IMG_RE.test(safeName) ? safeName : safeName + '.png';
      // Async — uploads run up to the 40MB body cap; a sync write that size freezes the window.
      await fsp.writeFile(path.join(dir, fname), Buffer.from(m[1], 'base64'));
      res.json({ ok: true, name: fname, url: '/data/media/' + ((rel ? rel + '/' : '') + fname).split('/').map(encodeURIComponent).join('/') });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/media/delete', mediaJson, async (req, res) => {
    const abs = safeMediaPath((req.body || {}).path);
    if (!abs || abs === mediaRoot) return res.status(400).json({ ok: false, error: 'Bad path' });
    try {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) await fsp.rm(abs, { recursive: true, force: true });
      else await fsp.unlink(abs);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── CS2 Game State Integration receiver ───────────────────────────────────
  app.post('/gsi', (req, res) => {
    try {
      const body = req.body || {};
      // Optional auth token check (set in the GSI cfg)
      const token = body.auth && body.auth.token;
      if (token && token !== GSI_TOKEN) {
        return res.status(403).end();
      }
      handleGsi(body);
    } catch (e) {
      console.error('[GSI] parse error:', e.message);
    }
    res.status(200).end();
  });

  // ── Start.gg API routes ──────────────────────────────────────────────────
  app.post('/api/startgg/search-teams', async (req, res) => {
    const { query, apiToken } = req.body;

    if (!apiToken) {
      return res.status(400).json({ error: 'Start.gg API token required' });
    }

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query too short' });
    }

    try {
      const client = createStartGgClient(apiToken);
      const gqlQuery = `
        query searchTeams($query: String!) {
          teams(query: {filter: {name: $query}}) {
            nodes {
              id
              slug
              name
              members {
                id
              }
            }
          }
        }
      `;
      const result = await client.request(gqlQuery, { query });

      if (!result || result.errors) {
        return res.status(400).json({ error: 'Invalid Start.gg token or API error' });
      }

      const teams = (result?.teams?.nodes || []).map(t => ({
        name: t.name,
        slug: t.slug,
        playerCount: t.members?.length || 0,
        state: 'Active'
      }));
      res.json({ teams: teams.slice(0, 10) });
    } catch (err) {
      console.error('[Team Search Error]', err.message);
      res.status(500).json({ error: 'Failed to search teams. Check your API token.' });
    }
  });

  app.post('/api/startgg/test-token', async (req, res) => {
    const { apiToken } = req.body;

    if (!apiToken) {
      return res.status(400).json({ error: 'API token required', valid: false });
    }

    try {
      console.log('[Token Test] Testing with token length:', apiToken.length);
      const client = createStartGgClient(apiToken);
      const gqlQuery = `
        query {
          currentUser {
            id
            slug
          }
        }
      `;
      const result = await client.request(gqlQuery);

      console.log('[Token Test] Response:', result);

      if (result?.currentUser?.id) {
        console.log('[Token Test] SUCCESS - User:', result.currentUser.slug);
        res.json({ valid: true, user: result.currentUser.slug });
      } else if (result?.errors) {
        console.error('[Token Test] GraphQL Errors:', result.errors);
        res.json({ valid: false, error: 'GraphQL error: ' + (result.errors[0]?.message || 'Unknown') });
      } else {
        console.warn('[Token Test] No user in response:', result);
        res.json({ valid: false, error: 'Token returned no user' });
      }
    } catch (err) {
      console.error('[Token Test] Exception:', err.message);
      console.error('[Token Test] Full error:', err);
      res.json({ valid: false, error: 'Error: ' + err.message });
    }
  });

  // Pull season standings (placement + league points) from a start.gg LEAGUE and store them
  // so the overlay team-record feature can show authoritative season points/placement.
  app.post('/api/startgg/league-standings', async (req, res) => {
    const slug = (req.body && req.body.slug) || state.startggLeagueStandings.slug || '';
    if (!slug) return res.status(400).json({ error: 'League slug or URL required' });
    try {
      const { name, teams } = await fetchLeagueStandings(slug);
      state.startggLeagueStandings = {
        slug: normalizeLeagueSlug(slug), name, teams,
        fetchedAt: Date.now(), lastError: null
      };
      saveAppState();
      broadcastFullState();
      res.json({ ok: true, name, count: teams.length, teams });
    } catch (err) {
      state.startggLeagueStandings.lastError = err.message;
      state.startggLeagueStandings.slug = normalizeLeagueSlug(slug);
      saveAppState();
      broadcastFullState();
      res.status(502).json({ error: err.message });
    }
  });

  // Search start.gg leagues by name
  app.post('/api/startgg/search-leagues', async (req, res) => {
    const { name } = req.body || {};
    if (!name || name.length < 2) return res.status(400).json({ error: 'Search name too short' });
    try {
      const results = await searchStartggLeagues(name);
      res.json({ results });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Get league info (name + tournament list) without syncing
  app.post('/api/startgg/league-info', async (req, res) => {
    const { slug } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'Slug required' });
    try {
      res.json(await fetchLeagueInfo(slug));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Sync completed sets from a start.gg league into an in-app league's schedule
  app.post('/api/startgg/league-sync', async (req, res) => {
    const { leagueId, slug } = req.body || {};
    const lg = (state.leagues || []).find(l => l.id === leagueId);
    if (!lg) return res.status(404).json({ error: 'League not found in app' });
    const rawSlug = slug || lg.startggSource;
    if (!rawSlug) return res.status(400).json({ error: 'No start.gg source set for this league' });

    try {
      const leagueInfo = await fetchLeagueInfo(rawSlug);

      // Build team name index for fuzzy matching against in-app roster
      const inAppTeams = (lg.teams || []).map(ref => ({
        id: ref.id,
        name: (ref.teamName || ref.name || '').trim()
      }));
      function fuzzyMatch(entrantName) {
        if (!entrantName || !inAppTeams.length) return null;
        const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const needle = norm(entrantName);
        let hit = inAppTeams.find(t => norm(t.name) === needle);
        if (!hit) hit = inAppTeams.find(t => { const tn = norm(t.name); return tn && (tn.includes(needle) || needle.includes(tn)); });
        return hit ? hit.id : null;
      }

      const existingSggIds = new Set((lg.schedule || []).map(m => m.sggSetId).filter(Boolean));
      // Content fallback so matches added BEFORE sggSetId was reliably stored (or any that lost it)
      // still dedup — a given matchup in a given week is unique in league play.
      const contentKey = (a, b, wk) => `${String(a || '').toLowerCase().trim()}|${String(b || '').toLowerCase().trim()}|${String(wk || '')}`;
      const existingContent = new Set((lg.schedule || []).map(m => contentKey(m.sggTeamA, m.sggTeamB, m.week)));
      let imported = 0, skipped = 0;

      for (const tournament of leagueInfo.tournaments) {
        if (!tournament.slug) continue;
        let tData;
        try { tData = await fetchTournamentSets(tournament.slug); } catch (e) {
          console.warn('[league-sync] tournament skipped:', tournament.slug, e.message);
          continue;
        }
        const weekMatch = (tData.name || '').match(/\b(\d+)\b/);
        const week = weekMatch ? weekMatch[1] : '';
        const date = tData.startAt ? new Date(tData.startAt * 1000).toISOString().slice(0, 10) : '';

        for (const event of (tData.events || [])) {
          const sets = (event.sets && event.sets.nodes) || [];
          for (const set of sets) {
            if (!set) continue;
            if (existingSggIds.has(String(set.id))) { skipped++; continue; }
            const slots = set.slots || [];
            if (slots.length < 2) continue;
            const entA = slots[0] && slots[0].entrant;
            const entB = slots[1] && slots[1].entrant;
            if (!entA || !entB) continue;
            const cKey = contentKey(entA.name, entB.name, week);
            if (existingContent.has(cKey)) { skipped++; continue; }   // same matchup+week already present

            // Parse score from displayScore e.g. "TEAM A 2 - TEAM B 1"
            let scoreA = null, scoreB = null;
            const ds = String(set.displayScore || '');
            const sm = ds.match(/(\d+)\s*-\s*(\d+)/);
            if (sm) { scoreA = Number(sm[1]); scoreB = Number(sm[2]); }

            lg.schedule = lg.schedule || [];
            lg.schedule.push({
              id: srvLgUid('m'),
              sggSetId: String(set.id),
              teamA: fuzzyMatch(entA.name),
              teamB: fuzzyMatch(entB.name),
              sggTeamA: entA.name,
              sggTeamB: entB.name,
              format: 'BO3',
              week,
              date,
              result: { scoreA, scoreB }
            });
            existingSggIds.add(String(set.id));
            existingContent.add(cKey);
            imported++;
          }
        }
      }

      lg.startggSource = normalizeLeagueSlug(rawSlug);
      lg.sggSyncedAt = Date.now();
      lg.sggLeagueName = leagueInfo.name;

      if (imported > 0) lgRecalcServer(lg);
      saveAppState();
      broadcastFullState();
      // Return the updated league so the client can refresh its authoritative copy (schedule +
      // sggSetIds + standings). Without this the client keeps a stale copy — its next set_leagues save
      // wipes the imported matches, so the next sync's dedup set is empty and re-imports everything.
      res.json({ ok: true, imported, skipped, leagueName: leagueInfo.name, tournaments: leagueInfo.tournaments.length, league: lg });
    } catch (err) {
      console.error('[league-sync]', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/startgg/search-tournaments', async (req, res) => {
    const { query } = req.body;
    const apiToken = req.body.apiToken || startggApiToken;   // fall back to the saved token

    if (!apiToken) {
      return res.status(400).json({ error: 'Start.gg API token required (set it in Settings → start.gg)' });
    }
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query too short' });
    }

    // Optional date window: 'upcoming' (now→future), 'past' (→now), or 'all'.
    const filter = req.body.filter || 'all';
    const nowSec = Math.floor(Date.now() / 1000);
    const dateFilter = filter === 'upcoming' ? `, afterDate: ${nowSec}`
      : filter === 'past' ? `, beforeDate: ${nowSec}` : '';

    try {
      const client = createStartGgClient(apiToken);
      const gqlQuery = `
        query searchTournaments($query: String!) {
          tournaments(query: {perPage: 32, page: 1, filter: {name: $query${dateFilter}}, sortBy: "startAt asc"}) {
            nodes {
              id slug name startAt endAt numAttendees countryCode city
              events { id }
              images { type url }
            }
          }
        }
      `;
      const result = await client.request(gqlQuery, { query });
      if (!result || result.errors) {
        console.error('[Tournament Search] API Error:', result.errors);
        return res.status(400).json({ error: 'Start.gg API error. Check your token.' });
      }

      const tournaments = (result?.tournaments?.nodes || []).map(t => {
        const imageUrl = t.images?.find(img => img.type === 'profile')?.url ||
                        t.images?.find(img => img.type === 'banner')?.url ||
                        t.images?.[0]?.url || null;
        return {
          name: t.name, slug: t.slug, id: t.id,
          startAt: t.startAt, endAt: t.endAt,
          numAttendees: t.numAttendees || 0,
          eventCount: (t.events || []).length,
          countryCode: t.countryCode || '', city: t.city || '',
          image: imageUrl
        };
      });
      res.json({ tournaments });
    } catch (err) {
      console.error('[Start.gg Tournament Search]', err);
      res.status(500).json({ error: 'Failed to search. Verify your API token in Settings.' });
    }
  });

  app.post('/api/startgg/import-tournament', async (req, res) => {
    const { tournamentSlug, eventSlug, apiToken } = req.body;

    if (!apiToken) {
      return res.status(400).json({ error: 'Start.gg API token required' });
    }

    if (!tournamentSlug && !eventSlug) {
      return res.status(400).json({ error: 'Tournament or event slug required' });
    }

    try {
      const token = apiToken || startggApiToken;
      const slug = parseEventSlug(eventSlug || tournamentSlug);
      if (!slug) return res.status(400).json({ error: 'Invalid slug' });

      const client = createStartGgClient(token);
      const entrants = await fetchAllEntrants(client, slug);
      const teams = mapEntrantsToTeams(entrants);

      // Legacy behavior: still merge into saved on this call (for backward compat with old UI)
      let teamsAdded = 0;
      let playersAdded = 0;
      teams.forEach((t) => {
        const existing = savedTeams.find((st) => (st.name || '').toLowerCase() === t.name.toLowerCase());
        if (existing) {
          if (t.players && t.players.length) existing.players = t.players;
          if (t.logo && !existing.logo) existing.logo = t.logo;
        } else {
          savedTeams.push({ name: t.name, logo: t.logo, players: t.players });
          teamsAdded++;
        }
        playersAdded += (t.players || []).length;
      });
      saveTeams();
      broadcastFullState();

      res.json({ teamsAdded, playersAdded, totalTeams: teams.length });
    } catch (err) {
      console.error('[import-tournament]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // List tournaments the authenticated user administrates/owns (for Event picker)
  app.post('/api/startgg/my-tournaments', async (req, res) => {
    const { apiToken } = req.body;
    const token = apiToken || startggApiToken;
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    try {
      const list = await fetchMyTournaments(token);
      res.json({ tournaments: list });
    } catch (err) {
      console.error('[my-tournaments]', err.message);
      res.status(500).json({ error: err.message || 'Failed to load your tournaments' });
    }
  });

  // Full detail for one tournament (Events tab): events + player roster + sponsorship aggregates
  app.post('/api/startgg/tournament-detail', async (req, res) => {
    const { slug, apiToken } = req.body;
    const token = apiToken || startggApiToken;
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    if (!slug) return res.status(400).json({ error: 'Tournament slug required' });
    try {
      const detail = await fetchTournamentDetail(token, slug);
      res.json({ detail });
    } catch (err) {
      console.error('[tournament-detail]', err.message);
      res.status(500).json({ error: err.message || 'Failed to load tournament' });
    }
  });

  // Seeding studio — entrants + their current start.gg seed for an event.
  app.post('/api/startgg/event-seeding', async (req, res) => {
    const token = (req.body && req.body.apiToken) || startggApiToken;
    const eventSlug = (req.body && req.body.eventSlug || '').trim();
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    if (!eventSlug) return res.status(400).json({ error: 'eventSlug required' });
    try {
      const data = await fetchEventSeeding(token, eventSlug);
      res.json({ ok: true, ...data });
    } catch (err) {
      console.error('[event-seeding]', err.message);
      res.status(500).json({ error: err.message || 'Failed to load entrants' });
    }
  });

  // Fetch recent tournament standings for a list of start.gg user slugs, compute a
  // weighted performance score per player (0-100). Used by the seeding studio.
  app.post('/api/startgg/player-standings', async (req, res) => {
    const token = (req.body?.apiToken) || startggApiToken;
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs.filter(Boolean).slice(0, 200) : [];
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    if (!slugs.length) return res.json({ ok: true, scores: {} });

    const client = createStartGgClient(token);
    const BATCH = 8;
    const scores = {};

    for (let i = 0; i < slugs.length; i += BATCH) {
      const batch = slugs.slice(i, i + BATCH);
      const fields = batch.map((slug, j) =>
        `p${j}: user(slug: ${JSON.stringify(slug)}) { player { recentStandings(limit: 10) { placement entrant { event { numEntrants startAt } } } } }`
      ).join('\n');
      try {
        const data = await client.request(`query { ${fields} }`);
        batch.forEach((slug, j) => {
          const standings = (data[`p${j}`]?.player?.recentStandings) || [];
          scores[slug] = computeSggPerformanceScore(standings);
        });
      } catch (err) {
        console.error('[player-standings] batch error:', err.message);
      }
      if (i + BATCH < slugs.length) await new Promise((r) => setTimeout(r, 700));
    }

    res.json({ ok: true, scores });
  });

  // Local history score — uses the already-imported Rocket Rush set records in the stats DB.
  // Returns a win-rate-based score (0–100) per team name. Instant, no API calls.
  app.post('/api/seeding/local-scores', (req, res) => {
    const teams = Array.isArray(req.body?.teams) ? req.body.teams.filter(Boolean) : [];
    if (!teams.length) return res.json({ ok: true, scores: {} });
    const normName = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const records = stats.getTeamRecords();
    const byNorm = new Map(records.map((r) => [normName(r.team), r]));
    const scores = {};
    teams.forEach((name) => {
      const r = byNorm.get(normName(name));
      if (!r || r.matches < 2) { scores[name] = null; return; }
      // Win rate, regressed toward 50% when sample is small (< 10 matches)
      const conf = Math.min(r.matches / 10, 1);
      scores[name] = Math.round((r.winPct * conf + 50 * (1 - conf)) * 10) / 10;
    });
    res.json({ ok: true, scores, totalMatches: records.reduce((s, r) => s + r.matches, 0) });
  });

  // ── rl6mans.com rank verification ───────────────────────────────────────
  // Look up a list of gamertags against the rl6mans leaderboards for a region.
  // Scrapes on first call, then serves from a 24 h in-memory cache.
  app.post('/api/rl6mans/lookup', async (req, res) => {
    const names  = Array.isArray(req.body?.names) ? req.body.names.filter(Boolean).slice(0, 300) : [];
    const region = (req.body?.region || 'NA').toUpperCase().trim();
    if (!names.length) return res.status(400).json({ error: 'names array required' });
    if (region !== 'ALL' && !rl6mans.REGION_LIST.includes(region)) return res.status(400).json({ error: `Unknown region: ${region}` });
    try {
      const results = await rl6mans.lookupPlayers(names, region, { profilesOnly: req.body?.profilesOnly !== false });
      res.json({ ok: true, region, results });
      // Persist updated profile cache so next session re-verification is instant
      if (dataDir) fs.writeFile(path.join(dataDir, 'rl6mans-cache.json'), JSON.stringify(rl6mans.dumpProfileCache()), () => {});
    } catch (err) {
      console.error('[rl6mans/lookup]', err.message);
      res.status(500).json({ error: err.message || 'Lookup failed' });
    }
  });

  // ── Player database ───────────────────────────────────────────────────────
  // Persistent cross-event registry keyed by gamertag. Never cleared on state reset.

  app.get('/api/playerdb', (req, res) => {
    const { q, rank, region, limit } = req.query;
    res.json({ ok: true, players: playerDb.search({ q, rank, region, limit: limit ? Number(limit) : 200 }), total: playerDb.count() });
  });

  app.get('/api/playerdb/:gamertag', (req, res) => {
    const rec = playerDb.get(req.params.gamertag);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, player: rec });
  });

  app.post('/api/playerdb', (req, res) => {
    const records = Array.isArray(req.body) ? req.body : [req.body];
    const updated = [];
    for (const r of records) {
      if (!r || !r.gamertag) continue;
      const rec = playerDb.upsert(r.gamertag, r);
      if (rec) {
        updated.push(rec);
        upsertPlayerProfile(r.gamertag, { startggSlug: r.startggSlug, startggPlayerId: r.startggId, sixmans: r.sixmans });
      }
    }
    if (updated.length) { saveAppState(); broadcastFullState(); }
    res.json({ ok: true, updated: updated.length });
  });

  app.delete('/api/playerdb/:gamertag', (req, res) => {
    const removed = playerDb.remove(req.params.gamertag);
    res.json({ ok: true, removed });
  });
  // Clear the ENTIRE player database (also wipes the in-state profile map).
  app.delete('/api/playerdb', (req, res) => {
    const n = playerDb.clearAll();
    state.playerProfiles = {}; state.playerProfilesVer = (state.playerProfilesVer || 0) + 1;
    try { saveAppState(); } catch (e) {}
    res.json({ ok: true, removed: n });
  });

  app.post('/api/rl6mans/invalidate', (req, res) => {
    const region = req.body?.region ? req.body.region.toUpperCase() : null;
    rl6mans.invalidateCache(region);
    res.json({ ok: true });
  });

  // All known rl6mans usernames for a region — feeds the manual-match autocomplete
  // so a producer can quickly find the right account when a name didn't auto-match.
  app.get('/api/rl6mans/names', async (req, res) => {
    const region = (req.query?.region || 'NA').toString().toUpperCase().trim();
    if (region !== 'ALL' && !rl6mans.REGION_LIST.includes(region)) return res.status(400).json({ error: `Unknown region: ${region}` });
    try {
      const idx = await rl6mans.buildIndex(region);
      res.json({ ok: true, region, names: idx.allPlayers.map((p) => p.name) });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to load names' });
    }
  });

  // Single direct profile lookup by exact rl6mans name (for manual correction of
  // a name that didn't auto-match) → exact ELO + tier + region + platform.
  app.post('/api/rl6mans/profile', async (req, res) => {
    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      const prof = await rl6mans.fetchProfile(name);
      res.json({ ok: true, name, profile: prof });
    } catch (err) {
      console.error('[rl6mans/profile]', err.message);
      res.status(500).json({ error: err.message || 'Profile lookup failed' });
    }
  });

  // Check whether the tracker.gg API key is configured.
  app.get('/api/trackergg/status', (_req, res) => {
    res.json({ configured: true, method: 'browser' });
  });

  // tracker.gg rank lookup — uses in-app BrowserWindow, no API key required.
  app.post('/api/trackergg/lookup', async (req, res) => {
    const platform = (req.body?.platform || '').toString().trim().toLowerCase();
    const username = (req.body?.username || '').toString().trim();
    if (!platform || !username) return res.status(400).json({ error: 'platform and username required' });
    const validPlatforms = ['epic', 'steam', 'psn', 'xbl', 'switch'];
    const isAuto = platform === 'auto';   // try the handle across all platforms, first hit wins
    if (!isAuto && !validPlatforms.includes(platform)) return res.status(400).json({ found: false, error: 'bad_platform', platform });
    try {
      const trackergg = require('./backend/trackergg');
      const result = isAuto ? await trackergg.lookupAny(username) : await trackergg.lookup(platform, username);
      res.json(result);
    } catch (err) {
      console.error('[trackergg/lookup]', err.message);
      res.status(500).json({ found: false, error: err.message || 'Lookup failed' });
    }
  });

  // Push a new seed order back to start.gg (TO/admin token required).
  app.post('/api/startgg/push-seeding', async (req, res) => {
    const token = (req.body && req.body.apiToken) || startggApiToken;
    const eventSlug = (req.body && req.body.eventSlug || '').trim();
    const order = (req.body && Array.isArray(req.body.order)) ? req.body.order : [];
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    if (!eventSlug) return res.status(400).json({ error: 'eventSlug required' });
    if (!order.length) return res.status(400).json({ error: 'No seeding order provided' });
    try {
      const data = await pushEventSeeding(token, eventSlug, order);
      res.json({ ok: true, ...data });
    } catch (err) {
      console.error('[push-seeding]', err.message);
      res.status(500).json({ error: err.message || 'Failed to push seeding to start.gg' });
    }
  });

  // List events/phases under a tournament slug (so user can pick the right event for teams/stats)
  app.post('/api/startgg/tournament-events', async (req, res) => {
    const { tournamentSlug, apiToken } = req.body;
    const token = apiToken || startggApiToken;
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    if (!tournamentSlug) return res.status(400).json({ error: 'tournamentSlug required' });
    try {
      const events = await fetchTournamentEvents(token, tournamentSlug);
      res.json({ events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Load transient event teams (for start.gg teams list). Does NOT auto-save to saved library.
  app.post('/api/startgg/event-teams', async (req, res) => {
    const { tournamentSlug, eventSlug, apiToken } = req.body;
    const token = apiToken || startggApiToken;
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    const slug = eventSlug || tournamentSlug;
    if (!slug) return res.status(400).json({ error: 'eventSlug or tournamentSlug required' });
    try {
      const teams = await loadStartggEventTeams(tournamentSlug, eventSlug);  // reuses the func which also updates state + broadcasts
      // loadStartgg... already broadcast; return count
      res.json({ ok: true, teamsLoaded: teams.teams || 0, playersLoaded: teams.players || 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Challonge API routes ──────────────────────────────────────────────────

  app.post('/api/challonge/test-token', async (req, res) => {
    const key = (req.body?.apiKey || challongeApiKey || '').trim();
    if (!key) return res.status(400).json({ error: 'API key required' });
    try {
      const client = createChallongeClient(key);
      await client.get('/tournaments.json', { state: 'all', per_page: 1 });
      res.json({ ok: true, message: 'API key is valid.' });
    } catch (e) {
      res.status(401).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/challonge/my-tournaments', async (req, res) => {
    const key = (req.body?.apiKey || challongeApiKey || '').trim();
    const extraSubdomains = Array.isArray(req.body?.subdomains)
      ? req.body.subdomains.filter(s => s && typeof s === 'string').map(s => s.trim().toLowerCase())
      : [];
    if (!key) return res.status(400).json({ error: 'API key required' });
    try {
      const client = createChallongeClient(key);
      const subdomainErrors = [];
      async function fetchGroup(subdomain) {
        const p = subdomain ? { subdomain } : {};
        try {
          const [pending, inProgress, ended] = await Promise.all([
            client.get('/tournaments.json', { state: 'pending',  ...p }),
            client.get('/tournaments.json', { state: 'underway', ...p }),
            client.get('/tournaments.json', { state: 'ended',    ...p })
          ]);
          return [...(inProgress || []), ...(pending || []), ...((ended || []).slice(0, 15))];
        } catch (e) {
          if (subdomain) subdomainErrors.push({ subdomain, error: e.message });
          return [];
        }
      }
      const groups = await Promise.all([fetchGroup(''), ...extraSubdomains.map(s => fetchGroup(s))]);
      const seen = new Set();
      const all = groups.flat().filter(t => {
        const id = t?.tournament?.id;
        if (!id || seen.has(id)) return false;
        seen.add(id); return true;
      });
      const tournaments = all.map((t) => {
        const d = t.tournament;
        const sub = (d.subdomain || '').toLowerCase();
        const rawUrl = d.url || '';
        const apiSlug = sub ? `${sub}-${rawUrl}` : rawUrl;
        return { id: d.id, slug: apiSlug, name: d.name, url: d.full_challonge_url, type: d.tournament_type, state: d.state, participantsCount: d.participants_count, gameName: d.game_name || '', startedAt: d.started_at, logo: d.live_image_url || '', subdomain: sub };
      });
      res.json({ tournaments, subdomainErrors: subdomainErrors.length ? subdomainErrors : undefined });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/challonge/tournament-detail', async (req, res) => {
    const key = (req.body?.apiKey || challongeApiKey || '').trim();
    const slug = (req.body?.slug || '').trim();
    if (!key) return res.status(400).json({ error: 'API key required' });
    if (!slug) return res.status(400).json({ error: 'Tournament slug required' });
    try {
      const client = createChallongeClient(key);
      const [tData, pData, mData] = await Promise.all([
        client.get(`/tournaments/${slug}.json`),
        client.get(`/tournaments/${slug}/participants.json`),
        client.get(`/tournaments/${slug}/matches.json`)
      ]);
      const t = tData.tournament;
      const partMap = challongePartMap(pData);
      const participants = Object.values(partMap).sort((a, b) => (a.seed || 99) - (b.seed || 99));
      const openMatches = mData.filter((m) => ['open', 'pending'].includes(m.match.state)).length;
      res.json({ tournament: { id: t.id, slug: t.url, name: t.name, url: t.full_challonge_url, type: t.tournament_type, state: t.state, participantsCount: t.participants_count, gameName: t.game_name || '' }, participants, openMatches, totalMatches: mData.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Challonge cross-platform push routes ─────────────────────────────────

  // Create a new Challonge tournament
  app.post('/api/challonge/create-tournament', async (req, res) => {
    const key = (req.body?.apiKey || challongeApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { name, slug, tournamentType = 'single elimination', gameName = '', private: isPrivate = false } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Tournament name required' });
    if (!slug || !slug.trim()) return res.status(400).json({ ok: false, error: 'Tournament URL/slug required' });
    try {
      const client = createChallongeClient(key);
      const data = await client.post('/tournaments.json', {
        tournament: {
          name: name.trim(),
          url: slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_').slice(0, 60),
          tournament_type: tournamentType,
          game_name: gameName || '',
          open_signup: false,
          private: !!isPrivate
        }
      });
      const t = data.tournament;
      res.json({ ok: true, slug: t.url, name: t.name, url: t.full_challonge_url, id: t.id });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Bulk-add participants to a Challonge tournament (with optional seeding + username mapping)
  app.post('/api/challonge/sync-participants', async (req, res) => {
    const key = (req.body?.apiKey || challongeApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { tournamentSlug, participants, clearExisting = false, eventSlug } = req.body || {};
    if (!tournamentSlug) return res.status(400).json({ ok: false, error: 'Tournament slug required' });
    if (!Array.isArray(participants) || participants.length === 0) return res.status(400).json({ ok: false, error: 'No participants provided' });
    try {
      const client = createChallongeClient(key);
      const slug = tournamentSlug.trim();

      // Prefer start.gg's REAL bracket seed over whatever the caller supplied — locally-cached
      // roster/seeding-studio order can drift from the seed that actually produced the real
      // bracket's bye placement, which would seed a mirrored Challonge bracket with a DIFFERENT
      // shape (wrong pairings throughout, not just cosmetically wrong seed numbers).
      let trueSeeds = null;
      if (eventSlug) { try { trueSeeds = await fetchEntrantTrueSeeds(eventSlug); } catch (e) { console.warn('[Challonge sync] true-seed fetch failed (falling back to supplied seeds):', e.message); } }

      // Optionally clear existing participants (only works if bracket not started)
      if (clearExisting) {
        try {
          const existing = await client.get(`/tournaments/${slug}/participants.json`);
          if (Array.isArray(existing) && existing.length > 0) {
            await client.del(`/tournaments/${slug}/participants/clear.json`);
          }
        } catch (clearErr) {
          // Non-fatal: if clear fails (e.g. bracket started), we proceed and add new ones
          console.warn('[Challonge sync] Clear participants failed (ignored):', clearErr.message);
        }
      }

      // Build participant payload — process in chunks of 100
      const CHUNK = 100;
      let added = 0;
      const errors = [];
      for (let i = 0; i < participants.length; i += CHUNK) {
        const chunk = participants.slice(i, i + CHUNK).map((p, idx) => {
          const entry = { name: (p.name || '').slice(0, 64) };
          const trueSeed = trueSeeds && trueSeeds[(p.name || '').toLowerCase()];
          const seed = trueSeed != null ? trueSeed : p.seed;
          if (seed) entry.seed = seed;
          if (p.challongeUsername) entry.challonge_username = p.challongeUsername;
          if (p.misc) entry.misc = String(p.misc).slice(0, 255);
          return entry;
        });
        try {
          await client.post(`/tournaments/${slug}/participants/bulk_add.json`, { participants: chunk });
          added += chunk.length;
        } catch (chunkErr) {
          errors.push(chunkErr.message);
        }
      }

      const msg = errors.length
        ? `Added ${added} of ${participants.length} participants. Errors: ${errors.join('; ')}`
        : `${added} participant${added !== 1 ? 's' : ''} added to "${slug}".`;
      res.json({ ok: errors.length === 0, added, total: participants.length, message: msg, errors });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Start (generate bracket for) a Challonge tournament
  app.post('/api/challonge/start-bracket', async (req, res) => {
    const key = (req.body?.apiKey || challongeApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { tournamentSlug } = req.body || {};
    if (!tournamentSlug) return res.status(400).json({ ok: false, error: 'Tournament slug required' });
    try {
      const client = createChallongeClient(key);
      await client.post(`/tournaments/${tournamentSlug.trim()}/start.json`, {});
      res.json({ ok: true, message: 'Bracket generated successfully.' });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Repair an already-started Challonge bracket whose shape doesn't match start.gg's real one —
  // this happens when it was originally seeded with stale/wrong numbers (see fetchEntrantTrueSeeds).
  // Resets the tournament (clears recorded results, unlocks participant edits — does NOT remove
  // participants), re-applies each participant's TRUE start.gg seed, then regenerates the bracket.
  // After this, /api/challonge/push-results can actually find matching pairings to fill in.
  app.post('/api/challonge/rebuild-bracket', async (req, res) => {
    if (!challongeApiKey) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { tournamentSlug, eventSlug } = req.body || {};
    if (!tournamentSlug) return res.status(400).json({ ok: false, error: 'Challonge tournament slug required' });
    if (!eventSlug) return res.status(400).json({ ok: false, error: 'start.gg event slug required' });
    const slug = tournamentSlug.trim();
    try {
      const trueSeeds = await fetchEntrantTrueSeeds(eventSlug);
      const client = createChallongeClient(challongeApiKey);

      const tData = await client.get(`/tournaments/${slug}.json`);
      if (tData.tournament.state !== 'pending') {
        await client.post(`/tournaments/${slug}/reset.json`, {});
      }

      const participants = await client.get(`/tournaments/${slug}/participants.json`);
      let reseeded = 0, missed = 0;
      for (const p of (participants || [])) {
        const d = p.participant || p;
        const trueSeed = trueSeeds[(d.name || d.display_name || '').toLowerCase()];
        if (trueSeed == null) { missed++; continue; }
        if (d.seed === trueSeed) continue;   // already correct, skip the write
        try {
          await client.put(`/tournaments/${slug}/participants/${d.id}.json`, { participant: { seed: trueSeed } });
          reseeded++;
        } catch (e) {
          console.error('[challonge rebuild-bracket] reseed failed for', d.name, e.message);
        }
      }

      await client.post(`/tournaments/${slug}/start.json`, {});
      res.json({ ok: true, reseeded, missed, total: (participants || []).length, message: `Reseeded ${reseeded} participant(s) with their true start.gg seed and regenerated the bracket.` });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Backfill every COMPLETED start.gg result onto a Challonge bracket, in one call. Works for a
  // fully-played PAST event (fills in the whole bracket at once) and for a partially-played
  // current one (fills in what's done so far — live results then keep flowing via the existing
  // link_event_challonge auto-sync). Independent of state.bracket, so it doesn't matter whether
  // this event is the one currently loaded live — it fetches the event's own sets fresh.
  app.post('/api/challonge/push-results', async (req, res) => {
    if (!challongeApiKey) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { tournamentSlug, eventSlug } = req.body || {};
    if (!tournamentSlug) return res.status(400).json({ ok: false, error: 'Challonge tournament slug required' });
    if (!eventSlug) return res.status(400).json({ ok: false, error: 'start.gg event slug required' });
    if (!startggApiToken) return res.status(400).json({ ok: false, error: 'start.gg API token required (set it in Settings)' });
    const slug = tournamentSlug.trim();
    try {
      const sgClient = createStartGgClient(startggApiToken);
      const { sets } = await fetchAllSets(sgClient, eventSlug);

      // Every decided 1v1 set with two named entrants — this is the full result history.
      const completed = [];
      (sets || []).forEach((s) => {
        if (!s || !s.winnerId) return;
        const slots = s.slots || [];
        if (slots.length !== 2) return;
        const [s0, s1] = slots;
        const nameA = s0.entrant && s0.entrant.name, nameB = s1.entrant && s1.entrant.name;
        if (!nameA || !nameB) return;
        const scoreOf = (slot) => { const v = slot.standing && slot.standing.stats && slot.standing.stats.score && slot.standing.stats.score.value; return (v == null) ? null : Number(v); };
        let scoreA = scoreOf(s0), scoreB = scoreOf(s1);
        const winnerIsA = s.winnerId === s0.entrant.id;
        if (scoreA == null || scoreB == null) { scoreA = winnerIsA ? 1 : 0; scoreB = winnerIsA ? 0 : 1; }   // DQ/no-score sets
        completed.push({ nameA, nameB, scoreA, scoreB, winnerIsA, round: Number(s.round) || 0 });
      });
      if (!completed.length) return res.json({ ok: true, pushed: 0, total: 0, message: 'No completed matches yet on start.gg for this event.' });

      // Order so that when the SAME two teams meet more than once (e.g. Winners match then a Grand
      // Finals rematch), the earlier-bracket result is consumed first: winners/GF (round>0) ascending,
      // then losers (round<0) by depth. This keeps rematches from grabbing each other's result.
      const _rk = (r) => (r >= 0 ? r : 1e6 + Math.abs(r));
      completed.sort((a, b) => _rk(a.round) - _rk(b.round));

      const pm = await buildChallongeParticipantMap(slug);
      const cClient = createChallongeClient(challongeApiKey);

      // Resolve each set's two entrants to Challonge participants up front (tolerant of case/spacing/
      // punctuation differences). Names that don't resolve are reported, not silently dropped — a
      // missing prerequisite stalls the cascade and leaves losers/grand finals empty.
      const nameMisses = new Set();
      completed.forEach((cm) => {
        cm.pA = resolveChallongeParticipant(pm, cm.nameA);
        cm.pB = resolveChallongeParticipant(pm, cm.nameB);
        cm.consumed = false;
        if (!cm.pA) nameMisses.add(cm.nameA);
        if (!cm.pB) nameMisses.add(cm.nameB);
      });

      // Challonge only opens a match once its feeders are recorded, so cascade: fill every open
      // match we can, re-fetch, repeat until a full pass makes no progress. Iterate OPEN matches and
      // take the first unconsumed set for each pairing — so a Grand-Finals rematch gets its OWN
      // result instead of being deduped away (the previous bug that left grand finals blank).
      let pushed = 0, guard = 0, progressed = true;
      while (progressed && guard < 60) {
        guard++;
        progressed = false;
        const mData = await cClient.get(`/tournaments/${slug}/matches.json`);
        const openMatches = (mData || []).filter((m) => (m.match || m).state === 'open');
        if (!openMatches.length) break;
        for (const m of openMatches) {
          const d = m.match || m;
          if (!d.player1_id || !d.player2_id) continue;
          const cm = completed.find((c) => !c.consumed && c.pA && c.pB &&
            ((d.player1_id === c.pA.id && d.player2_id === c.pB.id) ||
             (d.player1_id === c.pB.id && d.player2_id === c.pA.id)));
          if (!cm) continue;
          const isAp1 = d.player1_id === cm.pA.id;
          const winnerId = cm.winnerIsA ? cm.pA.id : cm.pB.id;
          const scoresCSV = isAp1 ? `${cm.scoreA}-${cm.scoreB}` : `${cm.scoreB}-${cm.scoreA}`;
          try {
            await cClient.put(`/tournaments/${slug}/matches/${d.id}.json`, { match: { winner_id: winnerId, scores_csv: scoresCSV } });
            cm.consumed = true; pushed++; progressed = true;
          } catch (e) {
            cm.consumed = true;   // don't let one rejected set spin the cascade — skip it and continue
            console.error('[challonge push-results] failed:', cm.nameA, 'vs', cm.nameB, e.message);
          }
        }
      }

      const misses = Array.from(nameMisses);
      const unplaced = completed.filter((c) => c.pA && c.pB && !c.consumed).map((c) => `${c.nameA} vs ${c.nameB}`);
      let message = `Pushed ${pushed} of ${completed.length} completed result(s) to Challonge.`;
      if (misses.length) message += ` ${misses.length} team name(s) don't match any Challonge participant: ${misses.slice(0, 8).join(', ')}${misses.length > 8 ? '…' : ''}. Rename them in Challonge to match start.gg, then push again.`;
      else if (unplaced.length) message += ` ${unplaced.length} result(s) never found an open Challonge match — the bracket shape likely differs from start.gg. Try Rebuild bracket, then push again.`;
      res.json({ ok: true, pushed, total: completed.length, unmatchedNames: misses, unplaced, message });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── NXGEN API routes ──────────────────────────────────────────────────────

  app.post('/api/nxgen/events', async (req, res) => {
    const key = (req.body?.apiKey || nxgenApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    try {
      const { limit = 30, status, includePast = false } = req.body || {};
      const data = await getNxgenEvents(key, { limit, status, includePast });
      res.json({ ok: true, events: data.events || [] });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/nxgen/event-live', async (req, res) => {
    const key = (req.body?.apiKey || nxgenApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    const slug = (req.body?.slug || '').trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });
    try {
      const data = await getNxgenEventLive(key, slug);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/nxgen/leaderboard', async (req, res) => {
    const key = (req.body?.apiKey || nxgenApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    try {
      const data = await getNxgenLeaderboard(key);
      res.json({ ok: true, teams: data.teams || [], players: data.players || [] });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── Twitch Integration ────────────────────────────────────────────────────
  registerTwitchWebhooks(app, state, (type, data) => {
    bridgeClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, data }));
      }
    });
  }, wheelManager, miniGameManager, chatParser);

  // Set Twitch API token manually
  app.post('/api/twitch/set-token', async (req, res) => {
    const { apiToken } = req.body;
    if (!apiToken) {
      return res.status(400).json({ error: 'API token required' });
    }

    try {
      // Derive identity from the token itself (don't trust client-supplied displayName/
      // channelId — a bare manual paste has neither). applyTwitchAccessToken validates the
      // token via Helix, wires up the clients, and broadcasts the connected state.
      const user = await applyTwitchAccessToken(String(apiToken), '');
      console.log('[Twitch] Token saved, connected as:', user.login);
      res.json({ success: true, message: 'Token saved', displayName: user.login });
    } catch (err) {
      console.error('[Twitch] Token error:', err.response?.data || err.message);
      res.status(400).json({ error: 'Token validation failed' });
    }
  });

  // Disconnect from Twitch
  app.post('/api/twitch/disconnect', (req, res) => {
    console.log('[Twitch] Disconnecting');
    state.twitch.connected = false;
    state.twitch.apiToken = '';
    state.twitch.displayName = '';
    state.twitch.userId = '';
    state.twitch.channelId = '';
    state.twitch.profilePicture = '';
    twitchClient = null;
    predictionManager = null;
    wheelManager = null;

    // Stop polling stream state
    streamStateManager.stopPolling();

    // Disconnect from IRC chat
    chatManager.disconnect();

    // Close the EventSub WebSocket
    try { eventSubService.stop(); } catch (e) { console.error('[EventSub] stop failed:', e.message); }

    saveTwitchData();
    broadcast(bridgeClients, { type: 'full_state', data: state });

    res.json({ success: true, message: 'Disconnected' });
  });

  // ─── OAuth Session Management ───────────────────────────────────────────
  // Store OAuth sessions in memory (expires after 15 minutes)
  const oauthSessions = new Map();

  // POST /api/oauth/twitch/init - Create a new OAuth session
  app.post('/api/oauth/twitch/init', (req, res) => {
    try {
      const sessionId = Math.random().toString(36).substring(2, 15);
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

      oauthSessions.set(sessionId, {
        state: sessionId,
        accessToken: null,
        expiresAt
      });

      console.log('[OAuth] Session created:', sessionId);
      res.json({ sessionId });
    } catch (err) {
      console.error('[OAuth Init]', err);
      res.status(500).json({ error: 'Failed to create OAuth session' });
    }
  });

  // Validate an access token (from the Implicit-grant fragment) and wire up the Twitch
  // clients. Shared by the OAuth callback page below. Throws if the token is invalid.
  async function applyTwitchAccessToken(accessToken, refreshToken) {
    const userRes = await axios.get('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-ID': TWITCH_CLIENT_ID }
    });
    const user = userRes.data?.data?.[0];
    if (!user) throw new Error('No user data');

    state.twitch.apiToken = accessToken;
    state.twitch.refreshToken = refreshToken || '';
    state.twitch.displayName = user.login;
    state.twitch.channelId = user.id;
    state.twitch.profilePicture = user.profile_image_url || '';
    state.twitch.connected = true;
    _twitchTokenInvalid = false;   // fresh token → re-enable EventSub/IRC/poll retries
    _twitchStatsCache = null;
    twitchClient = new TwitchClient(TWITCH_CLIENT_ID, null, accessToken);
    predictionManager = new PredictionManager(twitchClient, user.id);
    wheelManager = new WheelManager(state);
    miniGameManager = new MiniGameManager(state);
    chatParser = new ChatParser(miniGameManager);
    if (streamStateManager && typeof streamStateManager.startPolling === 'function') streamStateManager.startPolling();
    chatManager.connect(user.login, accessToken).catch(err => console.error('[IRC Connect]', err.message));
    saveTwitchData();
    // Implicit-grant tokens have no refresh token; only schedule a refresh if we got one.
    if (refreshToken) scheduleTokenRefresh();
    // Open the EventSub WebSocket so live events (subs/raids/redemptions/etc.) flow in.
    try { eventSubService.start(); } catch (e) { console.error('[EventSub] start failed:', e.message); }
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
    console.log('[OAuth] State applied for:', user.login);
    return user;
  }

  // POST /api/oauth/twitch/apply-token - Apply a token captured from the callback fragment.
  app.post('/api/oauth/twitch/apply-token', express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const accessToken = req.body && req.body.accessToken;
      if (!accessToken) return res.status(400).json({ error: 'Missing access token' });
      const user = await applyTwitchAccessToken(String(accessToken), '');
      res.json({ ok: true, login: user.login, channelId: user.id });
    } catch (err) {
      console.error('[OAuth ApplyToken]', err.response?.data || err.message);
      res.status(400).json({ error: 'Token validation failed' });
    }
  });

  // GET /api/oauth/twitch/callback - OAuth redirect target (Implicit grant flow).
  // This is a public desktop client with NO client secret, so we request response_type=token.
  // Twitch returns the access token in the URL fragment (#access_token=...), which the browser
  // never sends to the server. We return a page that reads the fragment and POSTs the token to
  // /api/oauth/twitch/apply-token, which validates it and wires up the Twitch clients.
  app.get('/api/oauth/twitch/callback', (req, res) => {
    const { error, error_description } = req.query;
    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connecting to Twitch…</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .container { background: #fff; border-radius: 16px; padding: 48px; text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 420px; }
    .badge { width: 80px; height: 80px; margin: 0 auto 24px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; font-size: 44px;
      background: #9146FF; color: #fff; }
    .badge.ok { background: #10b981; } .badge.err { background: #ef4444; }
    h1 { color: #1f2937; font-size: 26px; margin-bottom: 12px; }
    .username { color: #9146FF; font-size: 20px; font-weight: 600; margin-bottom: 20px; }
    .message { color: #6b7280; font-size: 15px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge" id="badge">⟳</div>
    <h1 id="title">Connecting to Twitch…</h1>
    <div class="username" id="user" style="display:none"></div>
    <div class="message" id="msg">Finishing sign-in, one moment…</div>
  </div>
  <script>
    var qErr = ${JSON.stringify(String(error || ''))};
    var qErrDesc = ${JSON.stringify(String(error_description || ''))};
    function fail(text){
      document.getElementById('badge').textContent = '✕';
      document.getElementById('badge').className = 'badge err';
      document.getElementById('title').textContent = 'Connection failed';
      document.getElementById('msg').textContent = text || 'Could not connect to Twitch. Close this window and try again.';
    }
    function ok(login){
      document.getElementById('badge').textContent = '✓';
      document.getElementById('badge').className = 'badge ok';
      document.getElementById('title').textContent = 'Connected to Twitch!';
      var u = document.getElementById('user'); u.textContent = '@' + login; u.style.display = 'block';
      document.getElementById('msg').textContent = 'Your account is linked. Closing this window…';
      setTimeout(function(){ window.close(); }, 1800);
    }
    if (qErr) { fail(qErrDesc || qErr); }
    else {
      var params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
      var token = params.get('access_token');
      if (!token) { fail('No access token was returned by Twitch.'); }
      else {
        fetch('/api/oauth/twitch/apply-token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: token })
        }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
          .then(function(o){ if (o.ok && o.j && o.j.ok) ok(o.j.login); else fail((o.j && o.j.error) || 'Token validation failed.'); })
          .catch(function(){ fail('Could not reach NE Broadcast Suite. Is the app still running?'); });
      }
    }
  </script>
</body>
</html>`);
  });

  // GET /api/oauth/twitch/token/:sessionId - Poll for token
  app.get('/api/oauth/twitch/token/:sessionId', (req, res) => {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({ error: 'Missing sessionId' });
      }

      const session = oauthSessions.get(sessionId);

      if (!session) {
        return res.status(401).json({ error: 'Session not found' });
      }

      if (Date.now() > session.expiresAt) {
        oauthSessions.delete(sessionId);
        return res.status(401).json({ error: 'Session expired' });
      }

      if (!session.accessToken) {
        // Still waiting for callback
        return res.status(202).json({ status: 'pending' });
      }

      // Token is ready!
      res.json({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        displayName: session.displayName,
        channelId: session.channelId,
        profilePicture: session.profilePicture
      });
    } catch (err) {
      console.error('[OAuth Token]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Discord OAuth ───────────────────────────────────────────────────────────

  // GET /api/oauth/discord/status - Returns current Discord user (no token)
  app.get('/api/oauth/discord/status', (req, res) => {
    res.json({
      connected: state.discord.connected,
      userId: state.discord.userId,
      username: state.discord.username,
      discriminator: state.discord.discriminator,
      globalName: state.discord.globalName,
      avatarUrl: state.discord.avatarUrl,
      needsContract: !!_pendingContract,   // approved but license unsigned — accept in-app
      lastError: state.discord.lastError || ''
    });
  });

  // ── In-app license acceptance (first sign-in after approval) ────────────────
  // GET returns the license text the backend sent with the refused login;
  // POST forwards the typed legal-name signature and completes the sign-in.
  app.get('/api/cloud/contract', (req, res) => {
    if (!_pendingContract) return res.json({ pending: false });
    res.json({ pending: true, license: _pendingContract.license || null });
  });

  app.post('/api/cloud/contract/accept', async (req, res) => {
    if (!_pendingContract) return res.status(400).json({ ok: false, message: 'No agreement is waiting — sign in first.' });
    const signatureName = String((req.body && req.body.signatureName) || '').trim();
    if (signatureName.length < 3) return res.status(400).json({ ok: false, message: 'Type your full legal name to sign the agreement.' });
    try {
      const data = await cloud.acceptContract({ token: _pendingContract.token, signatureName });
      const cu = (data && data.user) || {};
      state.discord.connected     = true;
      state.discord.userId        = cu.discordId || '';
      state.discord.username      = cu.username || '';
      state.discord.discriminator = cu.discriminator || '0';
      state.discord.globalName    = cu.globalName || cu.username || '';
      state.discord.avatarUrl     = cu.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
      state.discord.lastError     = '';
      _pendingContract = null;
      saveDiscordUser();
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      console.log('[Cloud] License accepted, signed in as', state.discord.username);
      res.json({ ok: true });
    } catch (e) {
      // Expired token → make them sign in again (which issues a fresh one).
      if (e && e.status === 401) _pendingContract = null;
      res.status(400).json({ ok: false, message: (e && e.message) || 'Could not record the signature.' });
    }
  });

  // POST /api/launcher/resize - the launcher asks for more room (license view)
  app.post('/api/launcher/resize', (req, res) => {
    const w = Math.max(360, Math.min(900, Number(req.body && req.body.width) || 0));
    const h = Math.max(240, Math.min(800, Number(req.body && req.body.height) || 0));
    try {
      if (typeof _launcherResizeCb === 'function' && w && h) _launcherResizeCb(w, h);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // POST /api/launcher/launch - the launcher window finished auth + its load animation;
  // main.js swaps it for the studio window via the registered callback.
  app.post('/api/launcher/launch', (req, res) => {
    try {
      if (typeof _launcherLaunchCb === 'function') _launcherLaunchCb();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'launch failed' });
    }
  });

  // POST /api/oauth/discord/init - Returns the Discord OAuth URL for the client to open
  app.post('/api/oauth/discord/init', (req, res) => {
    if (!DISCORD_CLIENT_ID) {
      return res.status(500).json({ error: 'DISCORD_CLIENT_ID not configured — add it to .env.local' });
    }
    // The callback can only exchange the code if it has a secret (local mode) or a backend to do it.
    // Fail HERE with a clear message instead of opening an OAuth flow that dead-ends at the callback.
    if (!cloud.configured() && !(process.env.DISCORD_CLIENT_SECRET || '')) {
      return res.status(500).json({ error: 'Discord login can\'t finish: add DISCORD_CLIENT_SECRET to .env.local (Discord Developer Portal → your app → OAuth2 → Client Secret), or set BROADCAST_REMOTE_URL to use the Nameless backend. Then relaunch.' });
    }
    const stateParam = Math.random().toString(36).substring(2, 18);
    const _crypto = require('crypto');
    const codeVerifier = _crypto.randomBytes(48).toString('base64url');
    const codeChallenge = _crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    oauthSessions.set(stateParam, { state: stateParam, expiresAt: Date.now() + 15 * 60 * 1000, type: 'discord', codeVerifier });
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify email',   // email lets the Nameless backend link the same site account
      state: stateParam,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
    res.json({ url: `https://discord.com/oauth2/authorize?${params}` });
  });

  // GET /api/oauth/discord/callback - Discord redirects here after auth
  app.get('/api/oauth/discord/callback', async (req, res) => {
    const { code, state: stateParam, error, error_description } = req.query;
    if (error) {
      return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>NE Broadcast Suite</title><style>*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#111318;color:#e8eaf0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center}.card{background:#1a1d24;border:1px solid #2a2e3a;border-radius:16px;padding:40px 36px;text-align:center;width:320px;animation:fadeIn .3s ease-out}.logo{width:36px;height:36px;object-fit:contain;margin-bottom:20px;opacity:.85}.ring{width:64px;height:64px;border-radius:50%;background:rgba(245,101,101,.1);border:2px solid rgba(245,101,101,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 20px}.title{font-size:17px;font-weight:600;margin-bottom:8px}.msg{font-size:13px;color:#6b7280;margin-bottom:24px;line-height:1.5}.btn{background:#2a2e3a;border:none;color:#e8eaf0;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer}.btn:hover{background:#333740}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}</style></head><body><div class="card"><img src="/assets/images/small.png" class="logo" alt=""><div class="ring"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#f56565" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div><div class="title">Discord Error</div><div class="msg">${error_description || error}</div><button class="btn" onclick="window.close()">Close Window</button></div></body></html>`);
    }
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }

    const _sess = stateParam ? oauthSessions.get(stateParam) : null;
    const codeVerifier = _sess && _sess.codeVerifier;
    const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
    // Prefer the LOCAL direct exchange whenever a client secret is present (dev machines): it's
    // registered for the localhost redirect and doesn't depend on the Nameless backend being
    // deployed/ready. BROADCAST_REMOTE_URL DEFAULTS to namelessesports.com (so cloud.configured() is
    // always true), which was silently routing local dev logins through a backend still being built —
    // that's where the 400 came from. Only use the backend when there's no local secret (production).
    // Set DISCORD_USE_BACKEND=1 to FORCE the backend path with a secret still present — this exercises
    // the exact production flow (POST namelessesports.com/api/auth/discord) so you can verify it.
    const forceBackend = process.env.DISCORD_USE_BACKEND === '1';
    const useBackend = cloud.configured() && (forceBackend || !DISCORD_CLIENT_SECRET);
    if (!useBackend && !DISCORD_CLIENT_SECRET) {
      return res.status(500).send('Discord login is not configured — no backend (BROADCAST_REMOTE_URL) and no DISCORD_CLIENT_SECRET.');
    }
    // The login used PKCE (code_challenge), so the token exchange REQUIRES the matching code_verifier
    // we stashed at init. It lives in memory, so it's gone if the server restarted (or nodemon reloaded
    // it) between clicking Sign in and returning here → Discord replies 400 invalid_grant. Detect that
    // and say so plainly instead of a cryptic 400.
    if (!codeVerifier) {
      state.discord.connected = false;
      state.discord.lastError = 'Login session expired (the app restarted mid-login) — just click Sign in with Discord again.';
      try { broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (e) {}
      return res.status(400).send(state.discord.lastError);
    }

    try {
      let u, avatarUrl, accessToken = '', refreshToken = '';

      if (useBackend) {
        // Nameless backend holds DISCORD_CLIENT_SECRET and performs the PKCE code exchange.
        const data = await cloud.loginWithDiscord({ code, codeVerifier, redirectUri: DISCORD_REDIRECT_URI });
        const cu = (data && data.user) || {};
        u = {
          id: cu.discordId || '',
          username: cu.username || '',
          global_name: cu.globalName || cu.username || '',
          discriminator: cu.discriminator || '0'
        };
        avatarUrl = cu.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
      } else {
        // Local dev fallback — direct exchange with the bundled secret.
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
          new URLSearchParams(Object.assign({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: DISCORD_REDIRECT_URI
          }, codeVerifier ? { code_verifier: codeVerifier } : {})),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        accessToken = tokenRes.data.access_token;
        refreshToken = tokenRes.data.refresh_token || '';
        const userRes = await axios.get('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        u = userRes.data;
        avatarUrl = u.avatar
          ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
          : `https://cdn.discordapp.com/embed/avatars/${(BigInt(u.id) >> 22n) % 6n}.png`;
      }

      state.discord.connected    = true;
      state.discord.userId       = u.id;
      state.discord.username     = u.username;
      state.discord.discriminator = u.discriminator || '0';
      state.discord.globalName   = u.global_name || u.username;
      state.discord.avatarUrl    = avatarUrl;
      state.discord.accessToken  = accessToken;
      state.discord.refreshToken = refreshToken;
      state.discord.lastError    = '';
      _pendingContract = null;

      saveDiscordUser();

      // In local-secret mode, record the user in the namelessesports DB. In backend mode the
      // /api/auth/discord exchange already upserts the user, so we skip the extra sync.
      if (!useBackend && BROADCAST_REMOTE_URL && BROADCAST_API_KEY) {
        axios.post(`${BROADCAST_REMOTE_URL}/api/broadcast-users/sync`, {
          discordId:     u.id,
          username:      u.username,
          globalName:    u.global_name || u.username,
          discriminator: u.discriminator || '0',
          avatarUrl:     avatarUrl,
        }, {
          headers: { 'x-api-key': BROADCAST_API_KEY, 'Content-Type': 'application/json' },
          timeout: 5000
        }).catch(err => console.warn('[Discord] Remote user sync failed (non-fatal):', err.message));
      }

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      console.log('[Discord] Logged in as', u.username, useBackend ? '(via Nameless backend)' : '(local)');

      if (stateParam) oauthSessions.delete(stateParam);

      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>NE Broadcast Suite</title><style>*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#111318;color:#e8eaf0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center}.card{background:#1a1d24;border:1px solid #2a2e3a;border-radius:16px;padding:40px 36px;text-align:center;width:320px;animation:fadeIn .3s ease-out}.logo{width:36px;height:36px;object-fit:contain;margin-bottom:20px;opacity:.85}.check-ring{width:64px;height:64px;border-radius:50%;background:rgba(88,101,242,.12);border:2px solid rgba(88,101,242,.35);display:flex;align-items:center;justify-content:center;margin:0 auto 20px}.avatar{width:56px;height:56px;border-radius:50%;border:2px solid #5865f2;margin-bottom:12px}.name{font-size:18px;font-weight:600;margin-bottom:4px}.handle{font-size:13px;color:#6b7280;}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}</style></head><body><div class="card"><img src="/assets/images/small.png" class="logo" alt="NE Broadcast Suite"><div class="check-ring"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#5865f2" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><img src="${avatarUrl}" class="avatar" alt=""><div class="name">${u.global_name || u.username}</div><div class="handle">@${u.username}</div></div></body></html>`);
    } catch (err) {
      // Approved but the license isn't signed yet — the backend sent the agreement
      // (token + text). Stash it; the launcher / auth gate shows it for acceptance.
      const cd = err && err.data;
      if (err && err.status === 403 && cd && cd.error && cd.error.code === 'unsigned' && cd.contract) {
        _pendingContract = cd.contract;
        state.discord.connected = false;
        state.discord.lastError = '';
        try { broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (e) {}
        if (stateParam) oauthSessions.delete(stateParam);
        console.log('[Discord] Signed in but license unsigned — awaiting in-app acceptance.');
        return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>NE Broadcast Suite</title><style>*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#111318;color:#e8eaf0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center}.card{background:#1a1d24;border:1px solid #2a2e3a;border-radius:16px;padding:40px 36px;text-align:center;width:340px}.t{font-size:16px;font-weight:700;margin-bottom:8px}.s{font-size:13px;color:#9aa0ae;line-height:1.5}</style></head><body><div class="card"><div class="t">One more step</div><div class="s">You're approved — return to the NE Broadcast Suite app to review and sign the license agreement.</div></div></body></html>`);
      }
      // Surface the ACTUAL Discord error (redirect_uri_mismatch / invalid_client / invalid_grant …)
      // both to the terminal AND into state so the panel/login-poll can show why it failed.
      const d = err.response && err.response.data;
      // Surface the REAL Discord error: prefer error_description/error, else the raw body, else message.
      const reason = (d && (d.error_description || d.error))
        || (d && typeof d === 'object' ? JSON.stringify(d).slice(0, 180) : (typeof d === 'string' ? d : ''))
        || err.message || 'Discord authentication failed';
      console.error('[Discord OAuth] token exchange failed:', err.response ? err.response.status : '', d || err.message);
      state.discord.connected = false;
      state.discord.lastError = String(reason).slice(0, 220);
      try { broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (e) {}
      res.status(500).send(`Discord authentication failed: ${reason} — check the terminal for details.`);
    }
  });

  // POST /api/oauth/discord/logout - Clear Discord session
  app.post('/api/oauth/discord/logout', (req, res) => {
    // Also drop the cloud session — otherwise a logout leaves a live 30-day
    // refresh token sitting in cloud-session.json on disk.
    try { cloud.clearSession(); } catch (_) {}
    state.discord.connected    = false;
    state.discord.userId       = '';
    state.discord.username     = '';
    state.discord.discriminator = '';
    state.discord.globalName   = '';
    state.discord.avatarUrl    = '';
    state.discord.accessToken  = '';
    state.discord.refreshToken = '';
    _pendingContract = null;
    saveDiscordUser();
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
    console.log('[Discord] Logged out');
    res.json({ ok: true });
  });

  // ─── Roles / Production Teams (local store) ──────────────────────────────────

  const rolesFile = () => path.join(path.dirname(discordDataFile || path.join(require('os').homedir(), 'dummy')), 'roles.json');

  app.get('/api/roles', (req, res) => {
    try {
      const data = fs.existsSync(rolesFile()) ? safeReadJson(rolesFile(), { teams: [] }) : { teams: [] };
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/roles/teams', (req, res) => {
    try {
      const data = fs.existsSync(rolesFile()) ? safeReadJson(rolesFile(), { teams: [] }) : { teams: [] };
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const team = { id: Date.now().toString(36), name, members: [] };
      data.teams.push(team);
      safeWriteJson(rolesFile(), data);
      res.json(team);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/roles/teams/:id', (req, res) => {
    try {
      const data = fs.existsSync(rolesFile()) ? safeReadJson(rolesFile(), { teams: [] }) : { teams: [] };
      const team = data.teams.find((t) => t.id === req.params.id);
      if (!team) return res.status(404).json({ error: 'Team not found' });
      if (req.body.name) team.name = req.body.name;
      if (Array.isArray(req.body.members)) team.members = req.body.members;
      safeWriteJson(rolesFile(), data);
      res.json(team);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/roles/teams/:id', (req, res) => {
    try {
      const data = fs.existsSync(rolesFile()) ? safeReadJson(rolesFile(), { teams: [] }) : { teams: [] };
      data.teams = data.teams.filter((t) => t.id !== req.params.id);
      safeWriteJson(rolesFile(), data);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Proxy: search registered broadcast users from the remote DB.
  // API key stays server-side — the client only hits localhost:3000.
  app.get('/api/broadcast-users/search', async (req, res) => {
    if (!BROADCAST_REMOTE_URL || !BROADCAST_API_KEY) {
      return res.json({ users: [] });
    }
    try {
      const r = await axios.get(`${BROADCAST_REMOTE_URL}/api/broadcast-users/search`, {
        params: { q: req.query.q || '' },
        headers: { 'x-api-key': BROADCAST_API_KEY },
        timeout: 5000
      });
      res.json(r.data);
    } catch (err) {
      console.warn('[broadcast-users] search proxy failed:', err.message);
      res.json({ users: [] });
    }
  });

  // Prediction creation
  app.post('/api/twitch/prediction/settings', (req, res) => {
    const { autoCreate, template, cooldown, overlayLoop, overlayHide, overlayHidden, hideInReplay } = req.body;
    if (typeof autoCreate === 'boolean') state.twitch.predictions.settings.autoCreate = autoCreate;
    if (template) state.twitch.predictions.settings.template = template;
    if (typeof cooldown === 'number') state.twitch.predictions.settings.cooldown = cooldown;
    if (typeof overlayLoop === 'number') state.twitch.predictions.settings.overlayLoop = overlayLoop;
    if (typeof overlayHide === 'number') state.twitch.predictions.settings.overlayHide = Math.max(1, Math.round(overlayHide));
    if (typeof overlayHidden === 'boolean') state.twitch.predictions.settings.overlayHidden = overlayHidden;
    if (typeof hideInReplay === 'boolean') state.twitch.predictions.settings.hideInReplay = hideInReplay;
    saveTwitchData();
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
    res.json({ ok: true });
  });

  app.post('/api/twitch/wheel/settings', (req, res) => {
    const { prizes, entryMethod, duration, requireLiveView } = req.body;
    if (Array.isArray(prizes)) state.twitch.wheel.prizes = prizes;
    if (entryMethod) state.twitch.wheel.settings.entryMethod = entryMethod;
    if (typeof duration === 'number') state.twitch.wheel.settings.duration = duration;
    if (typeof requireLiveView === 'boolean') state.twitch.wheel.settings.requireLiveView = requireLiveView;
    saveTwitchData();
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
    res.json({ ok: true });
  });

  app.post('/api/twitch/prediction/create', async (req, res) => {
    const { title, outcomes, duration } = req.body;
    console.log(`[Twitch] Create prediction: "${title}"`);

    if (!predictionManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    if (!title || !outcomes || outcomes.length < 2) {
      return res.status(400).json({ error: 'Title and at least 2 outcomes required' });
    }

    try {
      const durationSeconds = duration || 300; // 5 min default
      const result = await predictionManager.createPrediction(
        title,
        outcomes,
        durationSeconds
      );

      // Update state with new prediction
      state.twitch.predictions.current = normalizePrediction(result, durationSeconds, outcomes);
      try { analytics.event('prediction_create'); } catch (e) {}

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      startPredictionPolling();

      res.json({
        success: true,
        predictionId: result.id,
        prediction: state.twitch.predictions.current
      });
    } catch (err) {
      console.error('[Twitch] Prediction creation failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // If the app has no record of a running prediction, ADOPT the channel's live one from
  // Twitch (created on the dashboard / another tool, or lost across a relaunch or a
  // failed-create confusion) so resolve/lock/cancel still work on it.
  async function adoptActivePrediction() {
    if (state.twitch.predictions.current) return state.twitch.predictions.current;
    if (!twitchClient || !state.twitch.channelId) return null;
    try {
      const list = await twitchClient.getLatestPredictions(state.twitch.channelId, 5);
      const live = (list || []).find((p) => p.status === 'ACTIVE' || p.status === 'LOCKED');
      if (!live) return null;
      const endsAt = new Date(live.created_at).getTime() + (Number(live.prediction_window) || 0) * 1000;
      const secs = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      state.twitch.predictions.current = normalizePrediction(live, secs);
      if (predictionManager) predictionManager.currentPrediction = live;
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      console.log('[Twitch] Adopted live prediction from Twitch:', live.id, `"${live.title}"`);
      return state.twitch.predictions.current;
    } catch (e) {
      console.warn('[Twitch] adopt prediction failed:', e.message);
      return null;
    }
  }

  // Prediction resolution
  app.post('/api/twitch/prediction/resolve', async (req, res) => {
    const { outcomeId } = req.body;

    if (!predictionManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    if (!(await adoptActivePrediction())) {
      return res.status(400).json({ error: 'No active prediction — none running on the channel either' });
    }

    if (!outcomeId) {
      return res.status(400).json({ error: 'Outcome ID required' });
    }

    try {
      const prior = state.twitch.predictions.current;
      stopPredictionPolling();
      const result = await predictionManager.resolvePrediction(outcomeId, prior?.id);
      const resolved = result
        ? normalizePrediction(result, 0)
        : { ...prior, state: 'RESOLVED', winningOutcomeId: outcomeId };
      state.twitch.predictions.current = resolved;
      try { analytics.event('prediction_resolve'); } catch (e) {}

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      res.json({ success: true, message: 'Prediction resolved' });

      // Clear after overlay has time to show winner splash
      const resolvedId = resolved.id;
      setTimeout(() => {
        if (state.twitch.predictions.current?.id === resolvedId) {
          state.twitch.predictions.history.unshift(state.twitch.predictions.current);
          if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
          state.twitch.predictions.current = null;
          broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          saveTwitchData();
        }
      }, 18000);
    } catch (err) {
      console.error('[Twitch] Prediction resolution failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Prediction lock (close voting window early)
  app.post('/api/twitch/prediction/lock', async (req, res) => {
    if (!predictionManager) return res.status(400).json({ error: 'Twitch not connected' });
    if (!(await adoptActivePrediction())) return res.status(400).json({ error: 'No active prediction — none running on the channel either' });
    try {
      await predictionManager.lockPrediction(state.twitch.predictions.current.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[Twitch] Prediction lock failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Prediction cancel
  app.post('/api/twitch/prediction/cancel', async (req, res) => {
    if (!predictionManager) return res.status(400).json({ error: 'Twitch not connected' });
    if (!(await adoptActivePrediction())) return res.status(400).json({ error: 'No active prediction — none running on the channel either' });
    try {
      stopPredictionPolling();
      await predictionManager.cancelPrediction(state.twitch.predictions.current.id);
      state.twitch.predictions.current = null;
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      res.json({ success: true });
    } catch (err) {
      console.error('[Twitch] Prediction cancel failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Wheel spin
  app.post('/api/twitch/wheel/spin', async (req, res) => {
    console.log(`[Twitch] Spin wheel`);

    if (!wheelManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    if (!state.twitch.wheel.participants || state.twitch.wheel.participants.length === 0) {
      return res.status(400).json({ error: 'No participants in wheel' });
    }

    try {
      const result = wheelManager.spin(4000);
      try { analytics.event('wheel_spin'); } catch (e) {}

      // Broadcast spin state
      broadcast(bridgeClients, { type: 'full_state', data: state });
      saveTwitchData();

      res.json({
        success: true,
        spinId: result.spinId,
        winner: result.winner,
        duration: result.duration
      });
    } catch (err) {
      console.error('[Twitch] Wheel spin failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Clear wheel participants
  app.post('/api/twitch/wheel/clear', async (req, res) => {
    console.log(`[Twitch] Clear wheel participants`);

    if (!wheelManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    try {
      wheelManager.clearParticipants();
      broadcast(bridgeClients, { type: 'full_state', data: state });
      saveTwitchData();

      res.json({ success: true, message: 'Participants cleared' });
    } catch (err) {
      console.error('[Twitch] Clear participants failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Mini-game creation (universal endpoint)
  app.post('/api/twitch/minigame/create', async (req, res) => {
    const { type, question, answers, correctAnswerIndex, options, prizes,
            targetNumber, keyword, teamA, teamB, maxGames, duration } = req.body;
    console.log(`[Twitch] Create mini-game: ${type}`);

    if (!miniGameManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    const durationMs = duration ? Math.max(5000, Math.min(600000, Number(duration) * 1000)) : undefined;

    try {
      let game;
      if (type === 'trivia') {
        if (!question || !answers || answers.length < 2) {
          return res.status(400).json({ error: 'Trivia requires question and at least 2 answers' });
        }
        const correctIdx = (correctAnswerIndex !== undefined && correctAnswerIndex !== null)
          ? Number(correctAnswerIndex)
          : Math.floor(Math.random() * answers.length);
        game = miniGameManager.createTrivia(question, answers, correctIdx, durationMs);
      } else if (type === 'prediction' || type === 'vote') {
        if (!question || !options || options.length < 2) {
          return res.status(400).json({ error: 'Vote requires question and at least 2 options' });
        }
        game = type === 'prediction'
          ? miniGameManager.createPrediction(question, options, durationMs)
          : miniGameManager.createVote(question, options, durationMs);
      } else if (type === 'spin') {
        if (!prizes || prizes.length < 2) {
          return res.status(400).json({ error: 'Spin requires at least 2 prizes' });
        }
        game = miniGameManager.createSpin(prizes, durationMs);
      } else if (type === 'number_guess') {
        if (!question || targetNumber === undefined || targetNumber === null) {
          return res.status(400).json({ error: 'Number Guess requires a question and target number' });
        }
        game = miniGameManager.createNumberGuess(question, Number(targetNumber), durationMs);
      } else if (type === 'fastest_finger') {
        if (!keyword) {
          return res.status(400).json({ error: 'Fastest Finger requires a keyword' });
        }
        game = miniGameManager.createFastestFinger(keyword, durationMs);
      } else if (type === 'score_prediction') {
        game = miniGameManager.createScorePrediction(question, teamA, teamB, maxGames ? Number(maxGames) : 5, durationMs);
      } else {
        return res.status(400).json({ error: 'Unknown game type' });
      }

      try { analytics.event('minigame'); } catch (e) {}

      // Auto-finalize game after duration
      const gameId = game.id;
      const duration = game.duration || 30000;

      if (gameTimers.has(gameId)) {
        clearTimeout(gameTimers.get(gameId));
      }

      const timer = setTimeout(() => {
        if (miniGameManager && miniGameManager.currentGame?.id === gameId) {
          const result = miniGameManager.finalize();
          broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          saveTwitchData();
          announceGameResult(result);
          console.log('[Twitch] Game auto-finalized:', gameId);
          setTimeout(() => {
            if (state.twitch.minigame.current?.id === gameId) {
              state.twitch.minigame.current = null;
              broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
            }
          }, 10000);
        }
        gameTimers.delete(gameId);
      }, duration);

      gameTimers.set(gameId, timer);

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();

      // Announce in chat so viewers know the game started
      const chatAnnounce = buildGameAnnouncement(game);
      if (chatAnnounce && chatManager?.isConnected) chatManager.sendMessage(chatAnnounce);

      res.json({
        success: true,
        gameId: game.id,
        game
      });
    } catch (err) {
      console.error('[Twitch] Mini-game creation failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Mini-game response (chat interaction)
  app.post('/api/twitch/minigame/respond', async (req, res) => {
    const { userId, username, answer, optionId } = req.body;

    if (!miniGameManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    try {
      const added = miniGameManager.addResponse(userId, username, answer, optionId);

      if (added) {
        broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      }

      res.json({ success: true, added });
    } catch (err) {
      console.error('[Twitch] Game response failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Finalize mini-game
  app.post('/api/twitch/minigame/finalize', async (req, res) => {
    if (!miniGameManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    try {
      const gameId = miniGameManager.currentGame?.id;
      const { actualScore } = req.body || {};
      const result = miniGameManager.finalize(actualScore ? { actualScore } : {});

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      announceGameResult(result);

      if (gameId) {
        setTimeout(() => {
          if (state.twitch.minigame.current?.id === gameId) {
            state.twitch.minigame.current = null;
            broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          }
        }, 10000);
      }

      res.json({ success: true, result });
    } catch (err) {
      console.error('[Twitch] Game finalization failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Cancel mini-game
  app.post('/api/twitch/minigame/cancel', async (req, res) => {
    if (!miniGameManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    try {
      const gameId = miniGameManager.currentGame?.id;
      if (gameId && gameTimers.has(gameId)) {
        clearTimeout(gameTimers.get(gameId));
        gameTimers.delete(gameId);
      }
      miniGameManager.cancel();
      state.twitch.minigame.current = null;
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      res.json({ success: true });
    } catch (err) {
      console.error('[Twitch] Game cancel failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Mini-game settings
  app.post('/api/twitch/minigame/settings', async (req, res) => {
    const { enabled, breakScreenGameType, defaultDuration, pointReward } = req.body;

    try {
      if (typeof enabled === 'boolean') {
        state.twitch.minigame.settings.enabled = enabled;
      }
      if (breakScreenGameType) {
        state.twitch.minigame.settings.breakScreenGameType = breakScreenGameType;
      }
      if (typeof defaultDuration === 'number') {
        state.twitch.minigame.settings.defaultDuration = defaultDuration;
      }
      if (pointReward !== undefined) {
        state.twitch.minigame.settings.pointReward = pointReward;
      }

      saveTwitchData();
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });

      res.json({ success: true, settings: state.twitch.minigame.settings });
    } catch (err) {
      console.error('[Twitch] Settings error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Twitch Channel Management ─────────────────────────────────────────────

  // PATCH /api/twitch/channel — update stream title and/or game
  app.patch('/api/twitch/channel', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { title, gameId, gameName } = req.body;
    try {
      let resolvedGameId = gameId;
      if (!resolvedGameId && gameName) {
        console.log('[Twitch] Searching for game:', gameName);
        const games = await twitchClient.searchGames(gameName);
        if (games && games.length > 0) resolvedGameId = games[0].id;
      }
      await twitchClient.updateChannel(state.twitch.channelId, { title, gameId: resolvedGameId });
      console.log('[Twitch] Channel updated — title:', title, 'gameId:', resolvedGameId);
      res.json({ success: true, title, gameId: resolvedGameId });
    } catch (e) {
      console.error('[Twitch] updateChannel error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // GET /api/twitch/games/search?q= — search for a game/category
  app.get('/api/twitch/games/search', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q param required' });
    try {
      const games = await twitchClient.searchGames(q);
      res.json((games || []).map(g => ({ id: g.id, name: g.name, boxArtUrl: g.box_art_url || '' })));
    } catch (e) {
      console.error('[Twitch] searchGames error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/announcement — send a chat announcement
  app.post('/api/twitch/announcement', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { message, color } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    try {
      console.log('[Twitch] Posting announcement:', message.slice(0, 60));
      await twitchClient.postAnnouncement(state.twitch.channelId, state.twitch.channelId, message, color || 'PRIMARY');
      res.json({ success: true });
    } catch (e) {
      console.error('[Twitch] postAnnouncement error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/shoutout — send a shoutout to a user by login
  // Tries the Helix API first (requires broadcaster to be live); falls back to IRC /shoutout command.
  app.post('/api/twitch/shoutout', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { login } = req.body;
    if (!login) return res.status(400).json({ error: 'login required' });
    try {
      const user = await twitchClient.getUserByLogin(login);
      if (!user) return res.status(404).json({ error: `User not found: ${login}` });
      console.log('[Twitch] Sending shoutout to:', login, user.id);
      try {
        await twitchClient.sendShoutout(state.twitch.channelId, user.id, state.twitch.channelId);
        return res.json({ success: true, userId: user.id, displayName: user.display_name });
      } catch (apiErr) {
        // API requires broadcaster to be live — fall back to IRC /shoutout chat command
        console.warn('[Twitch] API shoutout failed, using IRC fallback:', apiErr.message);
        if (chatManager?.isConnected) {
          chatManager.sendMessage(`/shoutout ${user.login || login}`);
          return res.json({ success: true, userId: user.id, displayName: user.display_name, method: 'irc' });
        }
        throw apiErr;
      }
    } catch (e) {
      console.error('[Twitch] sendShoutout error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/raid — start a raid to a user by login
  app.post('/api/twitch/raid', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { login } = req.body;
    if (!login) return res.status(400).json({ error: 'login required' });
    try {
      const user = await twitchClient.getUserByLogin(login);
      if (!user) return res.status(404).json({ error: `User not found: ${login}` });
      console.log('[Twitch] Starting raid to:', login, user.id);
      const result = await twitchClient.startRaid(state.twitch.channelId, user.id);
      res.json({ success: true, userId: user.id, displayName: user.display_name, raid: result });
    } catch (e) {
      console.error('[Twitch] startRaid error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // GET /api/twitch/raid/target?login= — fetch stream info for a raid target (viewer count + live status)
  app.get('/api/twitch/raid/target', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const login = (req.query.login || '').trim().toLowerCase();
    if (!login) return res.status(400).json({ error: 'login required' });
    try {
      const user = await twitchClient.getUserByLogin(login);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const info = await twitchClient.getStreamInfo(user.id);
      res.json({ displayName: user.display_name, isLive: info.live, viewers: info.viewerCount, game: info.gameName });
    } catch (e) {
      console.error('[Twitch] raid/target error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // DELETE /api/twitch/raid — cancel an active raid
  app.delete('/api/twitch/raid', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      console.log('[Twitch] Cancelling raid');
      await twitchClient.cancelRaid(state.twitch.channelId);
      res.json({ success: true });
    } catch (e) {
      console.error('[Twitch] cancelRaid error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // GET /api/twitch/chat/settings — get current chat moderation settings
  app.get('/api/twitch/chat/settings', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      const result = await twitchClient.getChatSettings(state.twitch.channelId, state.twitch.channelId);
      res.json(result);
    } catch (e) {
      console.error('[Twitch] getChatSettings error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // PATCH /api/twitch/chat/settings — update chat moderation settings
  app.patch('/api/twitch/chat/settings', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { subOnly, slowMode, slowModeSeconds, emoteOnly, followerOnly, followerOnlyMinutes, uniqueChat } = req.body;
    const settings = {};
    if (typeof subOnly === 'boolean')             settings.subscriber_mode = subOnly;
    if (typeof slowMode === 'boolean')            settings.slow_mode = slowMode;
    if (typeof slowModeSeconds === 'number')      settings.slow_mode_wait_time = slowModeSeconds;
    if (typeof emoteOnly === 'boolean')           settings.emote_mode = emoteOnly;
    if (typeof followerOnly === 'boolean')        settings.follower_mode = followerOnly;
    if (typeof followerOnlyMinutes === 'number')  settings.follower_mode_duration = followerOnlyMinutes;
    if (typeof uniqueChat === 'boolean')          settings.unique_chat_mode = uniqueChat;
    try {
      console.log('[Twitch] Updating chat settings:', settings);
      const result = await twitchClient.updateChatSettings(state.twitch.channelId, state.twitch.channelId, settings);
      Object.assign(state.twitch.chatSettings, result);
      saveTwitchData();
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      res.json({ success: true, chatSettings: state.twitch.chatSettings });
    } catch (e) {
      console.error('[Twitch] updateChatSettings error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // GET /api/twitch/chat/shield — get shield mode status
  app.get('/api/twitch/chat/shield', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      const result = await twitchClient.getShieldMode(state.twitch.channelId, state.twitch.channelId);
      res.json(result);
    } catch (e) {
      console.error('[Twitch] getShieldMode error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // PUT /api/twitch/chat/shield — set shield mode on or off
  app.put('/api/twitch/chat/shield', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { active } = req.body;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
    try {
      console.log('[Twitch] Setting shield mode:', active);
      const result = await twitchClient.setShieldMode(state.twitch.channelId, state.twitch.channelId, active);
      res.json({ success: true, shieldMode: result });
    } catch (e) {
      console.error('[Twitch] setShieldMode error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/ad/snooze — snooze the next scheduled ad
  app.post('/api/twitch/ad/snooze', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      console.log('[Twitch] Snoozing next ad');
      const result = await twitchClient.snoozeNextAd(state.twitch.channelId);
      res.json({ success: true, snooze: result });
    } catch (e) {
      console.error('[Twitch] snoozeNextAd error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/ad/run — run a Twitch ad break (commercial) of the given length (seconds)
  app.post('/api/twitch/ad/run', async (req, res) => {
    // Ads are producer-action ONLY: reject anything originating from the flow engine.
    if (req.headers['x-ne-flow']) return res.status(403).json({ error: 'Ads cannot be triggered by automations' });
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    if (state.twitch.adsEnabled === false) return res.status(409).json({ error: 'Ads are turned off' });
    const length = [30, 60, 90, 120, 150, 180].includes(Number(req.body && req.body.length)) ? Number(req.body.length) : 30;
    try {
      console.log('[Twitch] Running', length + 's commercial');
      const result = await twitchClient.runCommercial(state.twitch.channelId, length);
      res.json({ success: true, ad: result });
    } catch (e) {
      console.error('[Twitch] runCommercial error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/ad/enabled — producer toggle: enable/disable running Twitch ads
  app.post('/api/twitch/ad/enabled', (req, res) => {
    const enabled = !(req.body && req.body.enabled === false);
    state.twitch.adsEnabled = enabled;
    saveTwitchData();
    broadcastFullState();
    console.log('[Twitch] Ads', enabled ? 'enabled' : 'disabled', 'by producer');
    res.json({ success: true, adsEnabled: enabled });
  });

  // ── Sponsor proof-of-play (impression reports) ─────────────────────────────
  app.get('/api/adproof', (req, res) => res.json(adProofReport()));

  app.post('/api/adproof/start', (req, res) => {
    adProofStart(req.body && req.body.label);
    res.json({ success: true, report: adProofReport() });
  });

  app.post('/api/adproof/stop', (req, res) => {
    const session = adProofStop();
    res.json({ success: true, session, report: adProofReport() });
  });

  app.post('/api/adproof/reset', (req, res) => {
    adProof.active = false;
    if (_adProofTimer) { clearInterval(_adProofTimer); _adProofTimer = null; }
    adProof.ticks = 0; adProof.sponsors = {}; adProof.startedAt = 0; adProof.label = '';
    broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
    res.json({ success: true, report: adProofReport() });
  });

  app.delete('/api/adproof/session/:id', (req, res) => {
    const before = (state.adProofSessions || []).length;
    state.adProofSessions = (state.adProofSessions || []).filter((s) => s.id !== req.params.id);
    if (state.adProofSessions.length !== before) saveAppState();
    broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
    res.json({ success: true, report: adProofReport() });
  });
  // Clear ALL saved sponsor sessions (fresh reporting).
  app.delete('/api/adproof/sessions', (req, res) => {
    state.adProofSessions = [];
    try { saveAppState(); } catch (e) {}
    broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
    res.json({ success: true, report: adProofReport() });
  });

  // Download one session (or the live tracker) as CSV or JSON.
  app.get('/api/adproof/export', (req, res) => {
    const which = (req.query.session || 'current').toString();
    let sess;
    if (which === 'current' || which === '') {
      sess = { label: adProof.label || (state.eventName || 'Broadcast'), startedAt: adProof.startedAt, endedAt: Date.now(), durationSec: adProof.ticks,
        sponsors: Object.values(adProof.sponsors).map((r) => ({
          name: r.name, seconds: r.seconds, impressions: r.impressions, byPlacement: { ...r.byPlacement },
          viewerSeconds: r.viewerSeconds || 0, ...adProofValueMetrics(r)
        })).sort((a, b) => b.seconds - a.seconds) };
    } else {
      sess = (state.adProofSessions || []).find((s) => s.id === which);
      if (!sess) return res.status(404).json({ error: 'Session not found' });
    }
    const safe = (sess.label || 'proof-of-play').toString().replace(/[^a-z0-9_-]+/gi, '-').slice(0, 50) || 'proof-of-play';
    if ((req.query.format || 'csv').toString() === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.json"`);
      res.setHeader('Content-Type', 'application/json');
      return res.send(JSON.stringify(sess, null, 2));
    }
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(adProofCsv(sess));
  });

  // GET /api/twitch/stream — get live stream info (title, game, viewers)
  app.get('/api/twitch/stream', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      const info = await twitchClient.getStreamInfo(state.twitch.channelId);
      res.json(info);
    } catch (e) {
      console.error('[Twitch] getStreamInfo error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/poll — create a channel poll
  app.post('/api/twitch/poll', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { title, choices, duration } = req.body;
    if (!title || !Array.isArray(choices) || choices.length < 2) {
      return res.status(400).json({ error: 'title and at least 2 choices required' });
    }
    try {
      console.log('[Twitch] Creating poll:', title);
      const poll = await twitchClient.createPoll(state.twitch.channelId, title, choices, duration || 60);
      try { analytics.event('poll_create'); } catch (e) {}
      res.json({ success: true, poll });
    } catch (e) {
      console.error('[Twitch] createPoll error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/automations — save match-start/end automation message templates
  app.post('/api/twitch/automations', (req, res) => {
    const { announceOnMatchStart, announceOnMatchEnd } = req.body;
    if (typeof announceOnMatchStart === 'string') state.twitch.automations.announceOnMatchStart = announceOnMatchStart;
    if (typeof announceOnMatchEnd   === 'string') state.twitch.automations.announceOnMatchEnd   = announceOnMatchEnd;
    saveTwitchData();
    console.log('[Twitch] Automations updated:', state.twitch.automations);
    res.json({ success: true, automations: state.twitch.automations });
  });

  // Twitch EventSub + stream-state routes. They're defined at module scope below (so they
  // can use eventSubService/streamStateManager) but MUST be registered here, where `app`
  // exists — registering at module top-level crashed on load ("app is not defined").
  registerTwitchEventSubRoutes(app);

  // Catch-all for unhandled errors thrown inside route handlers
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[HTTP] Unhandled route error:', err.stack || err.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });

  httpServer = app.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[HTTP] Overlay at http://localhost:${HTTP_PORT}`);
  });
  httpServer.keepAliveTimeout = 2000;
  httpServer.headersTimeout = 3000;
}

// ─── Start ───────────────────────────────────────────────────────────────────
module.exports.start = function(baseDir) {
  appDir = baseDir || __dirname;

  // Data paths — use userData so teams survive portable exe relocation
  const userData = _electronApp.getPath('userData');
  dataDir   = path.join(userData, 'data');
  teamsFile = path.join(dataDir, 'teams.json');
  stateFile = path.join(dataDir, 'state.json');
  facecamsFile = path.join(dataDir, 'facecams.json');
  presetsFile = path.join(dataDir, 'presets.json');
  brandsFile = path.join(dataDir, 'brands.json');
  twitchDataFile  = path.join(dataDir, 'twitch-data.json');
  discordDataFile = path.join(dataDir, 'discord-user.json');
  wsTokenFile     = path.join(dataDir, 'ws-token.json');

  fs.mkdirSync(dataDir, { recursive: true });
  wsAuthToken = getOrCreateWsToken();
  stats.init(dataDir);
  analytics.init({ dataDir, getState: () => state, broadcast, bridgeClients });
  playerDb.init(dataDir);

  // Restore rl6mans profile cache from previous session so re-verification is instant
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'rl6mans-cache.json'), 'utf8'));
    rl6mans.loadPersistedCache(raw);
  } catch (_) {}

  // Seed state.playerProfiles from the persistent player DB — playerDb survives event resets
  // while state.json doesn't. Merge: state.json wins on conflicts (it's the current session).
  {
    const dbMap = playerDb.toProfilesMap();
    if (!state.playerProfiles) state.playerProfiles = {};
    for (const [key, rec] of Object.entries(dbMap)) {
      const existing = state.playerProfiles[key];
      if (!existing || (rec.updatedAt && (!existing.updatedAt || rec.updatedAt > existing.updatedAt))) {
        state.playerProfiles[key] = { ...rec, ...existing };
      }
    }
  }

  // Social publisher — init with userData so tokens persist across restarts
  socialPublisher = new SocialPublisher(userData, {
    GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    TWITTER_CLIENT_ID:    process.env.TWITTER_CLIENT_ID,
    TWITTER_CLIENT_SECRET: process.env.TWITTER_CLIENT_SECRET
  });
  socialPublisher.startScheduler(post => {
    broadcast(bridgeClients, { type: 'social_published', data: post });
  });
  loadTeams();
  loadState();
  // Re-join the desk lineup against the crew/library so slots carry the current gamertag
  // (the persisted list is a snapshot; without this, a relaunch keeps stale display names).
  try { resolveLineupToList(); } catch (e) { /* no lineup yet */ }
  resetRlGameTrack();
  loadFacecams();
  loadPresets();
  loadBrandKits();
  syncActivePreshowTopics();   // Desk Show headline/topics come from the active kit/package, not the save file
  loadTwitchData();
  loadDiscordUser();
  initFlowEngine();
  // Resume LoL champ-select automation if it was left on.
  if (state.draft && state.draft.auto && state.draft.auto.enabled) { try { startLolDraftAuto(); } catch (e) {} }
  // Nameless cloud client — dormant unless BROADCAST_REMOTE_URL is configured.
  try { cloud.init({ baseUrl: BROADCAST_REMOTE_URL, dataDir, appVersion }); } catch (e) { console.warn('[Cloud] init skipped:', e.message); }
  // Access enforcement: re-validate the cloud session shortly after boot (catches a
  // revoked user relaunching, during the launcher's load) and every 10 minutes while
  // running. Signs out ONLY on a definitive backend refusal — see validateCloudSession.
  setTimeout(() => { validateCloudSession('boot'); }, 2500);
  setInterval(() => { validateCloudSession('periodic'); }, 10 * 60 * 1000);

  // Initialize Twitch integration if API token is configured
  if (state.twitch.apiToken) {
    // Validate token on startup; silently refresh if expired, then schedule proactive refresh
    scheduleTokenRefresh();

    twitchClient = new TwitchClient(TWITCH_CLIENT_ID, null, state.twitch.apiToken);
    if (state.twitch.channelId) {
      predictionManager = new PredictionManager(twitchClient, state.twitch.channelId);
      wheelManager = new WheelManager(state);
      miniGameManager = new MiniGameManager(state);
      chatParser = new ChatParser(miniGameManager);
      state.twitch.connected = true;
      streamStateManager.startPolling();
      chatManager.connect(state.twitch.displayName, state.twitch.apiToken).catch(err =>
        console.error('[IRC auto-connect]', err.message)
      );
      // Re-open the EventSub WebSocket so live events resume after a restart.
      try { eventSubService.start(); } catch (e) { console.error('[EventSub] start failed:', e.message); }
      console.log('[Twitch] Initialized (predictions, wheel, minigames, chat parsing, EventSub enabled)');
    }
  }

  startHttpServer(appDir);
  startBridgeServer();
  connectToRL();
  if (state.activeGame === 'valorant') startValorantPolling();
  if (state.activeGame === 'league') startLolPolling();
  startResourceWatchdog();

  // Connect to OBS if it was enabled previously
  if (state.obs.enabled && createObsClient) {
    setupObsClient();
    connectObs();
  }

  // Re-load the bracket on startup if one was configured
  if (state.bracket.eventSlug && startggApiToken) {
    fetchBracket(state.bracket.eventSlug).catch((e) => {
      state.bracket.lastError = e.message;
    });
  }

  // Keep saved My Events fresh from start.gg (entrants / teams / players / seeds) in the background.
  startMyEventsAutoSync();
  // Refresh the single-team spotlight's start.gg data while it's live.
  startTeamSpotlightAutoSync();

  if (state.startgg.queueEnabled && startggApiToken && state.startgg.tournamentSlug) {
    setStartggQueuePolling(true);
  }
  // Enforce single-active-platform on boot too: if a tournament platform was the active event last
  // session, make sure the other platforms' auto-follow didn't survive in the saved state and start
  // fighting it after restart.
  if (state.activeEvent && state.activeEvent.platform) setActivePlatform(state.activeEvent.platform);


  // AI training-data recorder (Phase 0 — local JSONL of producer decisions + context).
  telemetry = createTelemetryRecorder({
    dataDir,
    appVersion,
    getContext: buildTelemetryContext,
    // producerId prefers the cloud account; falls back to a stable per-install id.
    getIdentity: () => {
      let s = {}; try { s = cloud.getSession() || {}; } catch (_) {}
      return { producerId: (s.user && s.user.discordId) || null, workspaceId: s.workspaceId || null };
    },
  });
  telemetry.setEnabled(state.ai?.telemetry?.enabled !== false);

  // AI Auto-Director + clip system
  directorEngine = createDirectorEngine({
    dataDir,
    getActiveGame: () => state.activeGame,
    getBroadcastState: () => state,
    onEvents: onDirectorEvents,
    onPrimaryChange: (out) => {
      // Shadow stream: log what the engine WANTED, whenever the primary target changes,
      // regardless of whether auto-switch is on. Reset the latency clock for the next decision.
      if (out.primary && out.primary.target?.id !== _lastRecTargetId) {
        _lastRecTargetId = out.primary.target?.id || null;
        _directorRecShownAt = Date.now();
        if (telemetry) telemetry.recommendation({ recommendation: currentDirectorRec(), autoActed: !!out.autoSwitch });
      }
      if (!out.autoSwitch || !out.primary || aiShielded()) return;   // shield blocks the action
      // Keyboard observer-slot switching (CS2 only). RL in-game camera control was removed.
      const result = autoSwitch.trySwitch({
        gameId: state.activeGame,
        primary: out.primary,
        gameState: getDirectorGameState()
      });
      if (result.ok) {
        state.director.lastAutoSwitch = { at: Date.now(), target: result.target, key: result.key };
        try { analytics.event('auto_switch'); } catch (e) {}
        broadcastDirectorUpdate();
      }
    },
    onUpdate: (out) => {
      state.director = mergeDirectorRuntime(out);
      broadcastDirectorUpdate();
    }
  });
  if (state.director) {
    directorEngine.setSettings({
      enabled: state.director.enabled,
      sensitivity: state.director.sensitivity,
      autoSwitch: state.director.autoSwitch
    });
    autoSwitch.setEnabled(!!state.director.autoSwitch);
    state.director = mergeDirectorRuntime(directorEngine.getState());
  }

  clipSystem = createClipSystem({
    dataDir,
    getObsClient: () => obsClient,
    onUpdate: (clipsState) => {
      state.clips = { ...clipsState, encode: state.encode };
      broadcastClipsUpdate();
    },
    onEncodeProgress: (progress) => {
      state.encode = progress;
      broadcast(bridgeClients, { type: 'encode_progress', data: progress });
      if (onEncodeProgressCallback) onEncodeProgressCallback(progress);
    }
  });
  state.clips = clipSystem.getState();
};

// ─── Resource Watchdog ───────────────────────────────────────────────────────
const CPU_WARN_PERCENT = 80;
const RAM_WARN_MB = 1500;

let _watchdogInterval = null;

function startResourceWatchdog() {
  let lastCpu = process.cpuUsage();
  let lastTs = process.hrtime.bigint();

  _watchdogInterval = setInterval(() => {
    const now = process.hrtime.bigint();
    const cur = process.cpuUsage();
    const elapsedUs = Number(now - lastTs) / 1000;
    const cpuPercent = Math.round(
      (cur.user - lastCpu.user + cur.system - lastCpu.system) / elapsedUs * 100
    );
    lastCpu = cur;
    lastTs = now;

    const ramMb = Math.round(process.memoryUsage().rss / 1048576);
    if (cpuPercent >= CPU_WARN_PERCENT || ramMb >= RAM_WARN_MB) {
      broadcast(bridgeClients, {
        type: 'resource_warning',
        data: { cpu: cpuPercent, ramMb }
      });
    }
  }, 10000);
}

// ─── Twitch EventSub Service ─────────────────────────────────────────────────
class EventSubService {
  constructor() {
    this.subscriptions = new Map(); // Map of subscription_type -> { id, status, cost, created_at }
    this.webhookSecret = null;
    this.totalCost = 0;
    this.maxTotalCost = 100; // WebSocket EventSub allows 300 subscriptions per session
    this.subscriptionIds = new Set(); // Track all subscription IDs for deduplication
    this.retryQueue = [];
    this.rateLimitResetTime = 0;
    this.rateLimitRemaining = 120;

    // EventSub WebSocket transport — works from localhost (no public URL / webhook needed).
    // Twitch delivers events down an outbound WS we open, so there's nothing to expose.
    this.ws = null;
    this.sessionId = null;
    this.wsUrl = 'wss://eventsub.wss.twitch.tv/ws';
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this._kaTimeout = 10; // seconds; Twitch tells us the real value in session_welcome
    this.shouldRun = false;
    this.connected = false;
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────────────
  // Open the EventSub WebSocket and (on welcome) subscribe to all event types.
  start() {
    this.shouldRun = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._connect();
  }

  stop() {
    this.shouldRun = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._clearKeepalive();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.on('error', () => {});  // absorb async error if socket was still CONNECTING
        this.ws.terminate();
      } catch (_) {}
      this.ws = null;
    }
    this.sessionId = null;
    this.connected = false;
  }

  _connect() {
    if (!this.shouldRun) return;
    if (!state.twitch.apiToken) { console.warn('[EventSub] No Twitch token — WS not started'); return; }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.on('error', () => {});  // absorb async error if socket was still CONNECTING
        this.ws.terminate();
      } catch (_) {}
      this.ws = null;
    }

    let ws;
    try { ws = new WebSocket(this.wsUrl); }
    catch (e) { console.error('[EventSub] WS connect error:', e.message); return this._scheduleReconnect(); }
    this.ws = ws;

    ws.on('open', () => console.log('[EventSub] WebSocket connecting…'));
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('error', (e) => console.error('[EventSub] WS error:', e.message));
    ws.on('close', (code) => {
      if (ws !== this.ws) return; // a stale socket we already replaced
      this._clearKeepalive();
      this.connected = false;
      console.warn('[EventSub] WS closed (' + code + ')');
      this.ws = null;
      if (this.shouldRun) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || !this.shouldRun) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, 3000);
  }

  async _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const type = msg.metadata && msg.metadata.message_type;

    if (type === 'session_welcome') {
      this.sessionId = msg.payload.session.id;
      this.connected = true;
      this._armKeepalive(msg.payload.session.keepalive_timeout_seconds);
      console.log('[EventSub] WebSocket session ready:', this.sessionId);
      // Fresh session has no subscriptions — (re)create them against this session id.
      this.subscriptions.clear();
      this.subscriptionIds.clear();
      this.totalCost = 0;
      try { await this.subscribeToAll(state.twitch.channelId); } catch (e) { console.error('[EventSub] subscribeToAll failed:', e.message); }
      broadcast(bridgeClients, { type: 'twitch_eventsub_status', data: this.getStatus() });
    } else if (type === 'session_keepalive') {
      this._armKeepalive();
    } else if (type === 'notification') {
      this._armKeepalive();
      const sub = msg.payload.subscription || {};
      this.handleEvent({ type: sub.type, data: msg.payload.event });
    } else if (type === 'session_reconnect') {
      // Twitch is asking us to move; simplest robust path is a fresh reconnect + re-subscribe.
      console.log('[EventSub] Reconnect requested — reconnecting');
      this._connect();
    } else if (type === 'revocation') {
      console.warn('[EventSub] Subscription revoked:', msg.payload.subscription && msg.payload.subscription.type);
    }
  }

  // If no keepalive/notification arrives within the timeout (+grace), the link is dead.
  _armKeepalive(sec) {
    if (sec) this._kaTimeout = sec;
    this._clearKeepalive();
    this.keepaliveTimer = setTimeout(() => {
      console.warn('[EventSub] Keepalive timeout — forcing reconnect');
      if (this.ws) { try { this.ws.terminate(); } catch (_) {} }
    }, ((this._kaTimeout || 10) + 5) * 1000);
  }

  _clearKeepalive() {
    if (this.keepaliveTimer) { clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null; }
  }

  // Set webhook configuration
  setWebhookConfig(webhookUrl, webhookSecret) {
    this.webhookUrl = webhookUrl;
    this.webhookSecret = webhookSecret;
    console.log('[EventSub] Webhook configured:', webhookUrl);
  }

  // Verify webhook signature (Twitch requirement)
  verifyWebhookSignature(req) {
    const signature = req.headers['twitch-eventsub-message-signature'];
    const timestamp = req.headers['twitch-eventsub-message-timestamp'];
    const id = req.headers['twitch-eventsub-message-id'];
    const body = req.rawBody || '';

    if (!signature || !timestamp || !id) return false;

    const hmac = require('crypto').createHmac('sha256', this.webhookSecret);
    hmac.update(id + timestamp + body);
    const expectedSignature = 'sha256=' + hmac.digest('hex');

    return signature === expectedSignature;
  }

  // Register for an EventSub subscription (over the WebSocket session)
  async subscribe(eventType, version = '1', condition = {}) {
    if (!state.twitch.apiToken) {
      console.error('[EventSub] Cannot subscribe: No Twitch token');
      return null;
    }
    if (!this.sessionId) {
      console.warn('[EventSub] Cannot subscribe: WebSocket session not ready');
      return null;
    }

    try {
      const costEstimate = this.getCost(eventType);
      if (this.totalCost + costEstimate > this.maxTotalCost) {
        console.warn('[EventSub] Subscription cost would exceed limit', { eventType, costEstimate, totalCost: this.totalCost });
        return null;
      }

      const body = {
        type: eventType,
        version: version,
        condition: condition,
        // WebSocket transport — events stream down the open socket; no callback/secret.
        transport: {
          method: 'websocket',
          session_id: this.sessionId
        }
      };

      const response = await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', body, {
        headers: {
          'Authorization': `Bearer ${state.twitch.apiToken}`,
          'Client-ID': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 202 && response.data.data && response.data.data.length > 0) {
        const sub = response.data.data[0];
        this.subscriptions.set(eventType, {
          id: sub.id,
          status: sub.status,
          cost: costEstimate,
          created_at: new Date().toISOString()
        });
        this.subscriptionIds.add(sub.id);
        this.totalCost += costEstimate;
        console.log('[EventSub] Subscribed to', eventType, '- Total cost:', this.totalCost);
        return sub;
      }
    } catch (err) {
      const status = err.response?.status;
      const twitchMsg = err.response?.data?.message || '';
      if (status === 401) {
        // Dead token — stop trying the remaining subscriptions (subscribeToAll breaks on this).
        this._authFailed = true;
        return null;
      }
      if (status === 409) {
        // Duplicate subscription — already active from a previous session that hasn't
        // been fully cleaned up yet. Not an error; events will still arrive.
        console.warn('[EventSub] Duplicate subscription (already active):', eventType);
      } else if (status === 403) {
        console.warn('[EventSub] Scope missing for', eventType, '— reconnect Twitch to grant updated permissions');
      } else if (status === 400 && twitchMsg.toLowerCase().includes('role')) {
        // Twitch: "The broadcaster does not have the required role" — Affiliate/Partner only
        console.warn('[EventSub] Skipping', eventType, '— channel not eligible (Affiliate/Partner required)');
      } else {
        console.error('[EventSub] Subscription failed:', eventType, 'status:', status, twitchMsg || err.message);
      }
      if (status === 429) {
        this.rateLimitRemaining = parseInt(err.response.headers['ratelimit-remaining']) || 0;
        this.rateLimitResetTime = parseInt(err.response.headers['ratelimit-reset']) * 1000;
      }
    }
    return null;
  }

  // Get cost for an event type
  getCost(eventType) {
    const costs = {
      'stream.online': 1,
      'stream.offline': 1,
      'channel.follow': 1,
      'channel.subscribe': 1,
      'channel.cheer': 1,
      'channel.raid': 1,
      'channel.channel_points_custom_reward_redemption.add': 1,
      'channel.hype_train.begin': 1,
      'channel.hype_train.progress': 1,
      'channel.hype_train.end': 1,
      'channel.poll.begin': 1,
      'channel.poll.progress': 1,
      'channel.poll.end': 1,
      'channel.prediction.begin': 1,
      'channel.prediction.progress': 1,
      'channel.prediction.lock': 1,
      'channel.prediction.end': 1,
      'channel.ad_break.begin': 1,
      'clip.create': 1
    };
    return costs[eventType] || 1;
  }

  // Subscribe to all recommended event types. Each type carries the version + condition
  // shape Twitch currently requires (follow=v2 + moderator_user_id, raid keys on
  // to_broadcaster_user_id, redemptions use the .add subtype). Types the token lacks scopes
  // for simply fail individually and are skipped — the rest still subscribe.
  async subscribeToAll(channelId) {
    if (!channelId) { console.warn('[EventSub] No channelId — cannot subscribe'); return []; }
    const specs = [
      { type: 'stream.online',  version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: channelId, moderator_user_id: channelId } },
      { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.cheer', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: channelId } },
      { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.hype_train.begin', version: '2', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.hype_train.progress', version: '2', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.hype_train.end', version: '2', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.poll.begin', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.poll.progress', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.poll.end', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.prediction.begin', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.prediction.progress', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.prediction.lock', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.prediction.end', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.ad_break.begin', version: '1', condition: { broadcaster_user_id: channelId } }
    ];

    this._authFailed = false;
    const results = [];
    for (const s of specs) {
      if (this._authFailed) break;   // token rejected — stop hammering Twitch with the rest
      const sub = await this.subscribe(s.type, s.version, s.condition);
      results.push({ eventType: s.type, success: !!sub });
      await new Promise(r => setTimeout(r, 150)); // Rate limit spacing
    }
    if (this._authFailed) { markTwitchTokenInvalid('EventSub token rejected (401)'); return results; }
    const ok = results.filter(r => r.success).length;
    console.log('[EventSub] Subscribed to ' + ok + '/' + results.length + ' event types');
    return results;
  }

  // Handle incoming webhook events
  handleEvent(event) {
    const { type, data } = event;
    console.log('[EventSub Event]', type);

    switch (type) {
      case 'stream.online':
        state.twitch.isLive = true;
        broadcast(bridgeClients, { type: 'twitch_stream_online', data });
        flowBus.emit('twitch_stream_online', {});
        break;

      case 'stream.offline':
        state.twitch.isLive = false;
        broadcast(bridgeClients, { type: 'twitch_stream_offline', data });
        flowBus.emit('twitch_stream_offline', {});
        break;

      case 'channel.follow':
        broadcast(bridgeClients, { type: 'twitch_follow', data: { user: data.user_name, timestamp: data.followed_at } });
        chatManager.onFollow(data.user_name);
        flowBus.emit('twitch_follow', { user: data.user_name });
        _logActivity({ type: 'follow', username: data.user_name });
        break;

      case 'channel.subscribe':
        broadcast(bridgeClients, { type: 'twitch_subscribe', data: { user: data.user_name, tier: data.tier } });
        chatManager.onSubscribe(data.user_name, data.tier);
        flowBus.emit('twitch_sub', { user: data.user_name, tier: data.tier });
        _logActivity({ type: 'sub', username: data.user_name, tier: data.tier });
        break;

      case 'channel.subscription.message':
        // Resub with message
        broadcast(bridgeClients, { type: 'twitch_subscribe', data: { user: data.user_name, tier: data.tier, resub: true, months: data.cumulative_months } });
        flowBus.emit('twitch_sub', { user: data.user_name, tier: data.tier, resub: true });
        _logActivity({ type: 'resub', username: data.user_name, tier: data.tier, months: data.cumulative_months || 1 });
        break;

      case 'channel.subscription.gift':
        broadcast(bridgeClients, { type: 'twitch_subscribe', data: { user: data.recipient_user_name, tier: data.tier, gift: true, gifter: data.user_name } });
        flowBus.emit('twitch_sub', { user: data.recipient_user_name, tier: data.tier, gift: true });
        _logActivity({ type: 'gift_sub', username: data.recipient_user_name, gifter: data.user_name || 'Anonymous', tier: data.tier });
        break;

      case 'channel.raid':
        broadcast(bridgeClients, { type: 'twitch_raid', data: { from: data.from_broadcaster_user_login, viewers: data.viewers } });
        chatManager.onRaid(data.from_broadcaster_user_login, data.viewers);
        flowBus.emit('twitch_raid', { from: data.from_broadcaster_user_login, viewers: data.viewers });
        _logActivity({ type: 'raid', from: data.from_broadcaster_user_login, viewers: data.viewers || 0 });
        break;

      case 'channel.channel_points_custom_reward_redemption.add':
        broadcast(bridgeClients, { type: 'twitch_channel_points', data: { user: data.user_name, reward: data.reward && data.reward.title, status: data.status } });
        flowBus.emit('twitch_channel_points', { user: data.user_name, reward: data.reward && data.reward.title });
        _logActivity({ type: 'channel_points', username: data.user_name, reward: data.reward && data.reward.title });
        break;

      case 'channel.cheer':
        broadcast(bridgeClients, { type: 'twitch_bits', data: { user: data.user_name, bits: data.bits } });
        flowBus.emit('twitch_bits', { user: data.user_name, bits: data.bits || 0 });
        _logActivity({ type: 'bits', username: data.user_name || 'Anonymous', amount: data.bits || 0 });
        break;

      case 'channel.hype_train.begin':
        broadcast(bridgeClients, { type: 'twitch_hype_train_begin', data });
        flowBus.emit('twitch_hype_train', { level: data.level || 1 });
        break;

      case 'channel.hype_train.progress':
        broadcast(bridgeClients, { type: 'twitch_hype_train_progress', data });
        break;

      case 'channel.hype_train.end':
        broadcast(bridgeClients, { type: 'twitch_hype_train_end', data });
        _logActivity({ type: 'hype_train', level: data.level || 1 });
        break;

      case 'channel.poll.begin':
      case 'channel.poll.progress': {
        const poll = normalizePoll(data);
        state.twitch.poll.current = poll;
        broadcast(bridgeClients, { type: 'twitch_poll_update', data: poll });
        broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
        break;
      }

      case 'channel.poll.end': {
        const poll = normalizePoll(data);
        state.twitch.poll.current = poll;
        broadcast(bridgeClients, { type: 'twitch_poll_end', data: poll });
        broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
        flowBus.emit('twitch_poll_end', { title: poll.title, total: poll.total });
        setTimeout(() => {
          if (state.twitch.poll.current?.id === poll.id) {
            state.twitch.poll.history.unshift(state.twitch.poll.current);
            if (state.twitch.poll.history.length > 20) state.twitch.poll.history.pop();
            state.twitch.poll.current = null;
            broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          }
        }, 20000);
        break;
      }

      case 'channel.prediction.begin':
      case 'channel.prediction.progress':
      case 'channel.prediction.lock': {
        const pred = normalizePrediction(data, 0);
        if (type === 'channel.prediction.lock') pred.state = 'LOCKED';
        // Only overwrite if this is the same prediction or there's no current one
        if (!state.twitch.predictions.current || state.twitch.predictions.current.id === pred.id) {
          state.twitch.predictions.current = pred;
          broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
        }
        break;
      }

      case 'channel.prediction.end': {
        const pred = normalizePrediction(data, 0);
        if (state.twitch.predictions.current?.id === pred.id || !state.twitch.predictions.current) {
          state.twitch.predictions.current = pred;
          broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          saveTwitchData();
          stopPredictionPolling();
          if (predictionManager) predictionManager.clearCooldown();
          const resolvedId = pred.id;
          setTimeout(() => {
            if (state.twitch.predictions.current?.id === resolvedId) {
              if (pred.state !== 'CANCELLED') {
                state.twitch.predictions.history.unshift(state.twitch.predictions.current);
                if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
              }
              state.twitch.predictions.current = null;
              broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
              saveTwitchData();
            }
          }, 18000);
        }
        break;
      }

      case 'channel.ad_break.begin': {
        const duration = data.duration_seconds || 0;
        const startedAt = data.started_at || new Date().toISOString();
        const endsAt = new Date(new Date(startedAt).getTime() + duration * 1000).toISOString();
        state.twitch.adBreak = { active: true, duration, startedAt, endsAt, isAutomatic: !!data.is_automatic };
        try { analytics.event('ad', { sec: duration }); } catch (e) {}
        broadcast(bridgeClients, { type: 'twitch_ad_break', data: { duration, isAutomatic: data.is_automatic, endsAt } });
        broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
        flowBus.emit('twitch_ad_break', { duration, isAutomatic: !!data.is_automatic });
        console.log(`[EventSub] Ad break: ${duration}s (${data.is_automatic ? 'automatic' : 'manual'})`);
        setTimeout(() => {
          if (state.twitch.adBreak.active) {
            state.twitch.adBreak.active = false;
            broadcast(bridgeClients, { type: 'twitch_ad_break_end', data: {} });
            broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          }
        }, (duration + 3) * 1000);
        break;
      }

      default:
        console.log('[EventSub] Unknown event type:', type);
    }
  }

  // Get subscription status
  getStatus() {
    return {
      subscriptions: Object.fromEntries(this.subscriptions),
      totalCost: this.totalCost,
      maxCost: this.maxTotalCost,
      rateLimitRemaining: this.rateLimitRemaining,
      rateLimitReset: this.rateLimitResetTime
    };
  }
}

// Centralised handling of an expired/invalid Twitch token. The token is implicit-grant with no
// refresh, so once it 401s every transport (EventSub WS, IRC, stream poll) would retry forever and
// flood the console + hammer Twitch. Halt them all once and surface a reconnect prompt instead.
function markTwitchTokenInvalid(reason) {
  if (_twitchTokenInvalid) return;
  _twitchTokenInvalid = true;
  console.warn('[Twitch] OAuth token invalid/expired — halting EventSub/IRC/stream-poll. Reconnect Twitch in Settings to resume. (' + (reason || 'auth failure') + ')');
  state.twitch.connected = false;
  try { eventSubService.stop(); } catch (e) {}
  try { chatManager.disconnect(); } catch (e) {}
  try { streamStateManager.stopPolling(); } catch (e) {}
  try { broadcast(bridgeClients, { type: 'twitch_auth_invalid', data: { needsReconnect: true } }); } catch (e) {}
  try { broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (e) {}
}

const eventSubService = new EventSubService();

// ─── Twitch Stream State Manager (viewer count, ads, stream info) ───────────
class TwitchStreamStateManager {
  constructor() {
    this.streamState = {
      isLive: false,
      viewerCount: 0,
      title: '',
      game: '',
      startedAt: null
    };
    this.adSchedule = {
      nextAdAt: null,
      lastAdAt: null,
      adDuration: 120, // 2 minutes default
      prerollFreeTime: 0,   // seconds of pre-roll free time remaining (from Twitch)
      prerollFreeUntil: 0,  // absolute ms when pre-roll free time runs out (0 = none)
      scheduleWindow: 30 * 60 * 1000 // 30 minute window
    };
    this.pollInterval = null;
    this.pollIntervalMs = 30 * 1000; // Poll every 30 seconds
    this.isPolling = false;
  }

  // Start polling for stream state
  startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;

    const poll = async () => {
      if (!state.twitch?.apiToken || !state.twitch?.channelId) return;

      try {
        // Fetch current stream info
        const streamRes = await axios.get('https://api.twitch.tv/helix/streams', {
          params: { user_id: state.twitch.channelId },
          headers: {
            'Authorization': `Bearer ${state.twitch.apiToken}`,
            'Client-ID': process.env.TWITCH_CLIENT_ID
          }
        });

        if (streamRes.data.data && streamRes.data.data.length > 0) {
          const stream = streamRes.data.data[0];
          this.streamState.isLive = true;
          this.streamState.viewerCount = stream.viewer_count;
          this.streamState.title = stream.title;
          this.streamState.game = stream.game_name;
          this.streamState.startedAt = stream.started_at;

          console.log('[Stream] Live:', this.streamState.viewerCount, 'viewers');
        } else {
          this.streamState.isLive = false;
          this.streamState.viewerCount = 0;
          this.streamState.startedAt = null;

          // Fetch channel info so title/category show even when offline
          try {
            const chanRes = await axios.get('https://api.twitch.tv/helix/channels', {
              params: { broadcaster_id: state.twitch.channelId },
              headers: {
                'Authorization': `Bearer ${state.twitch.apiToken}`,
                'Client-ID': process.env.TWITCH_CLIENT_ID
              }
            });
            const chan = chanRes.data.data && chanRes.data.data[0];
            if (chan) {
              this.streamState.title = chan.title || '';
              this.streamState.game  = chan.game_name || '';
            }
          } catch (e) {
            console.log('[Stream] Channel info unavailable:', e.response?.status || e.message);
          }

          console.log('[Stream] Offline');
        }

        // Fetch ad schedule (if supported)
        try {
          const adRes = await axios.get('https://api.twitch.tv/helix/channels/ads', {
            params: { broadcaster_id: state.twitch.channelId },
            headers: {
              'Authorization': `Bearer ${state.twitch.apiToken}`,
              'Client-ID': process.env.TWITCH_CLIENT_ID
            }
          });

          if (adRes.data.data && adRes.data.data.length > 0) {
            const ad = adRes.data.data[0];
            this.adSchedule.lastAdAt  = ad.last_ad_at  ? new Date(ad.last_ad_at)  : null;
            this.adSchedule.adDuration = ad.duration || 30;
            // Pre-roll free time: how long new viewers won't see a pre-roll ad (earned by ad breaks).
            const pf = Number(ad.preroll_free_time) || 0;
            this.adSchedule.prerollFreeTime  = pf;
            this.adSchedule.prerollFreeUntil = pf > 0 ? Date.now() + pf * 1000 : 0;
            // Use Twitch's authoritative next-ad timestamp when available.
            this.adSchedule.nextAdAt = ad.next_ad_at ? new Date(ad.next_ad_at) : null;
          }
        } catch (e) {
          // Ad schedule endpoint may not be available for all tokens
          console.log('[Ads] Schedule unavailable:', e.response?.status);
        }

        // Feed the broadcast-analytics recorder: viewer sample + auto start/stop on live transitions.
        try { analytics.recordStreamPoll(this.streamState.isLive, currentViewers()); } catch (e) {}

        // Broadcast state update
        broadcast(bridgeClients, {
          type: 'twitch_stream_state',
          data: {
            stream: this.streamState,
            ads: this.adSchedule
          }
        });

      } catch (err) {
        if (err.response && err.response.status === 401) { markTwitchTokenInvalid('stream poll 401'); return; }
        console.error('[Stream Poll]', err.message);
      }
    };

    // Poll immediately, then on interval
    poll();
    this.pollInterval = setInterval(poll, this.pollIntervalMs);
  }

  // Stop polling
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isPolling = false;
  }

  // Get current state
  getState() {
    return {
      stream: this.streamState,
      ads: this.adSchedule,
      nextAdCountdown: this.getAdCountdown()
    };
  }

  // Get seconds until next ad
  getAdCountdown() {
    if (!this.adSchedule.nextAdAt) return null;
    const now = new Date();
    const ms = this.adSchedule.nextAdAt.getTime() - now.getTime();
    if (ms <= 0) return 0;
    return Math.ceil(ms / 1000);
  }
}

const streamStateManager = new TwitchStreamStateManager();

// ─── Twitch Chat Manager (IRC + Automations) ────────────────────────────────
class TwitchChatManager {
  constructor() {
    this.ircSocket = null;
    this.isConnected = false;
    this.channelName = '';
    this.botName = 'nebroadcastbot';
    this.autoGreetings = {
      enabled: true,
      followMessage: 'Welcome {user}! Thanks for following!',
      subscribeMessage: 'Big thanks to {user} for subscribing! {tier}',
      raidMessage: 'Huge thanks to {user} for raiding with {viewers} viewers!'
    };
  }

  async connect(channelName, oauthToken) {
    if (this.isConnected) return;
    this._stopped = false;            // a fresh connect re-enables reconnects
    this.channelName  = channelName.toLowerCase();
    this._oauthToken  = oauthToken;   // keep for reconnect
    const tls = require('tls');

    return new Promise((resolve, reject) => {
      try {
        this.ircSocket = tls.connect({
          host: 'irc.chat.twitch.tv',
          port: 6697,
          rejectUnauthorized: false
        }, () => {
          console.log('[IRC] TLS connected — authenticating as', this.channelName);
          // CAP REQ must come before PASS/NICK per Twitch docs
          this.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
          this.send(`PASS oauth:${oauthToken}`);
          this.send(`NICK ${this.channelName}`);
          this.send(`JOIN #${this.channelName}`);
        });

        this.ircSocket.on('data', (data) => this.handleData(data, resolve));
        this.ircSocket.on('error', (err) => {
          console.error('[IRC] Socket error:', err.message);
          this.isConnected = false;
          state.twitch.chatConnected = false;
          broadcast(bridgeClients, { type: 'twitch_chat_disconnected' });
          this._scheduleReconnect();
        });
        this.ircSocket.on('close', () => {
          console.log('[IRC] Connection closed');
          this.isConnected = false;
          state.twitch.chatConnected = false;
          broadcast(bridgeClients, { type: 'twitch_chat_disconnected' });
          this._scheduleReconnect();
        });

        setTimeout(() => {
          if (!this.isConnected) reject(new Error('IRC connection timeout'));
        }, 12000);
      } catch (err) {
        reject(err);
      }
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._stopped || _twitchTokenInvalid) return;   // don't loop on a dead token
    const delay = 8000;
    console.log(`[IRC] Reconnecting in ${delay / 1000}s…`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this.isConnected && this.channelName && this._oauthToken) {
        this.connect(this.channelName, this._oauthToken).catch(e => console.error('[IRC Reconnect]', e.message));
      }
    }, delay);
  }

  send(message) {
    if (!this.ircSocket) return;
    this.ircSocket.write(message + '\r\n');
  }

  sendMessage(message) {
    if (!this.isConnected) return;
    this.send(`PRIVMSG #${this.channelName} :${message}`);
  }

  handleData(data, _resolve) {
    const lines = data.toString().split('\r\n');
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('PING')) {
        this.send('PONG :tmi.twitch.tv');
        continue;
      }
      // Detect successful JOIN ack — mark as connected here (not in the TLS callback)
      if (!this.isConnected && line.includes(`JOIN #${this.channelName}`)) {
        this.isConnected = true;
        state.twitch.chatConnected = true;
        state.twitch.chatChannel   = this.channelName;
        broadcast(bridgeClients, { type: 'twitch_chat_connected', data: { channel: this.channelName } });
        broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
        if (typeof _resolve === 'function') _resolve();
        console.log('[IRC] Authenticated and joined #' + this.channelName);
        continue;
      }
      // Login failed — Twitch sends various auth error messages
      if (line.includes('Login authentication failed') ||
          line.includes('NOTICE * :Error') ||
          line.includes(':Improperly formatted auth') ||
          line.includes('NOTICE * :Improperly') ||
          (line.includes(':tmi.twitch.tv NOTICE * :') && !line.includes('JOIN'))) {
        console.error('[IRC] Auth/login error:', line.trim());
        this.isConnected = false;
        state.twitch.chatConnected = false;
        broadcast(bridgeClients, { type: 'twitch_chat_disconnected' });
        markTwitchTokenInvalid('IRC login failed');   // bad token → halt, don't reconnect-loop
        this.ircSocket?.destroy();
        continue;
      }
      if (line.includes('PRIVMSG')) {
        this.handleChatMessage(line);
      } else if (line.includes('USERNOTICE')) {
        this.handleUserNotice(line);
      }
    }
  }

  handleUserNotice(line) {
    try {
      let tags = {};
      if (line.startsWith('@')) {
        const sp = line.indexOf(' ');
        line.slice(1, sp).split(';').forEach(t => {
          const eq = t.indexOf('=');
          if (eq !== -1) tags[t.slice(0, eq)] = t.slice(eq + 1);
        });
      }
      const msgId = tags['msg-id'];
      if (!msgId) return;
      const displayName = tags['display-name'] || tags['login'] || 'Someone';

      if (msgId === 'sub' || msgId === 'resub') {
        const plan = tags['msg-param-sub-plan'];
        const tier = plan === '2000' ? 2 : plan === '3000' ? 3 : 1;
        const months = parseInt(tags['msg-param-cumulative-months'] || '1', 10);
        broadcast(bridgeClients, {
          type: 'twitch_subscribe',
          data: { user: displayName, tier, months, resub: msgId === 'resub' }
        });
        this.onSubscribe(displayName, plan);
        console.log(`[IRC] ${msgId === 'resub' ? 'Resub' : 'Sub'}: ${displayName} (T${tier}, ${months}mo)`);
      } else if (msgId === 'subgift' || msgId === 'anonsubgift') {
        const plan = tags['msg-param-sub-plan'];
        const tier = plan === '2000' ? 2 : plan === '3000' ? 3 : 1;
        const recipient = tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'] || 'someone';
        broadcast(bridgeClients, {
          type: 'twitch_subscribe',
          data: { user: displayName, tier, gift: true, recipient }
        });
        console.log(`[IRC] Gift sub: ${displayName} → ${recipient}`);
      } else if (msgId === 'raid') {
        const viewers = parseInt(tags['msg-param-viewerCount'] || '0', 10);
        const raider = tags['msg-param-displayName'] || tags['msg-param-login'] || displayName;
        broadcast(bridgeClients, {
          type: 'twitch_raid',
          data: { from: raider, viewers }
        });
        this.onRaid(raider, viewers);
        console.log(`[IRC] Raid from ${raider} with ${viewers} viewers`);
      }
    } catch (err) {
      console.error('[USERNOTICE parse]', err.message);
    }
  }

  handleChatMessage(line) {
    try {
      // Parse IRCv3 tags (color, display-name) if present
      let tags = {};
      let rest = line;
      if (line.startsWith('@')) {
        const sp = line.indexOf(' ');
        line.slice(1, sp).split(';').forEach(t => { const [k, v] = t.split('='); tags[k] = v || ''; });
        rest = line.slice(sp + 1);
      }

      const match = rest.match(/:(\w+)!.*PRIVMSG #\w+ :(.*)/);
      if (!match) return;
      const username = tags['display-name'] || match[1];
      const message = match[2];
      const color = tags['color'] || '';

      broadcast(bridgeClients, {
        type: 'twitch_chat_message',
        data: { username, message, color, timestamp: new Date().toISOString() }
      });

      // Route to active mini-game
      if (chatParser && miniGameManager?.currentGame?.state === 'active') {
        const userId = tags['user-id'] || match[1];
        const added = chatParser.parseMessage(userId, username, message);
        if (added) {
          broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          // fastest_finger: auto-finalize the moment someone wins
          if (added === 'won') {
            const gameId = miniGameManager.currentGame?.id;
            if (gameId && gameTimers.has(gameId)) {
              clearTimeout(gameTimers.get(gameId)); gameTimers.delete(gameId);
            }
            const result = miniGameManager.finalize();
            broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
            saveTwitchData();
            announceGameResult(result);
            if (result) setTimeout(() => {
              if (state.twitch.minigame.current?.id === result.id) {
                state.twitch.minigame.current = null;
                broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
              }
            }, 10000);
          }
        }
      }

      if (message.startsWith('!')) {
        this.handleCommand(match[1], message);
        // Emit for flow twitch_chat_command triggers
        const _cmdParts = message.trim().slice(1).split(/\s+/);
        flowBus.emit('twitch_chat_command', {
          user: username, command: _cmdParts[0].toLowerCase(),
          message: message.trim(), args: _cmdParts.slice(1).join(' ')
        });
      }
      console.log(`[Chat] ${username}: ${message}`);
    } catch (err) {
      console.error('[Chat Parse]', err.message);
    }
  }

  handleCommand(username, message) {
    const parts = message.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '!giveaway':
        broadcast(bridgeClients, { type: 'chat_command', data: { command: 'giveaway', user: username } });
        break;
      case '!game':
        if (parts[1]) {
          // Subcommand — forward to overlay bridge
          broadcast(bridgeClients, { type: 'chat_command', data: { command: 'game', user: username, gameType: parts[1] } });
        } else {
          // No subcommand — reply with active game
          const gameName = state.activeGame || 'Unknown';
          this.sendMessage(`Current game: ${gameName}`);
        }
        break;
      case '!clip':
        broadcast(bridgeClients, { type: 'chat_command', data: { command: 'clip', user: username } });
        this.sendMessage('Clip saved!');
        break;
      case '!score': {
        const blue   = state.teams?.blue?.name   || 'Blue';
        const orange = state.teams?.orange?.name || 'Orange';
        const bs = state.game?.blueScore   ?? state.game?.score?.blue   ?? 0;
        const os = state.game?.orangeScore ?? state.game?.score?.orange ?? 0;
        this.sendMessage(`${blue} ${bs} - ${os} ${orange}`);
        break;
      }
      case '!teams': {
        const blue   = state.teams?.blue?.name   || 'Blue';
        const orange = state.teams?.orange?.name || 'Orange';
        this.sendMessage(`${blue} vs ${orange}`);
        break;
      }
      case '!bracket': {
        const slug = state.startgg?.eventSlug || '';
        const tSlug = state.startgg?.tournamentSlug || '';
        if (slug && tSlug) {
          this.sendMessage(`Bracket: https://www.start.gg/tournament/${tSlug}/event/${slug}`);
        } else if (slug) {
          this.sendMessage(`Bracket: https://www.start.gg/event/${slug}`);
        } else {
          this.sendMessage('No bracket linked yet.');
        }
        break;
      }
    }
  }

  onFollow(username) {
    if (!this.autoGreetings.enabled) return;
    const msg = this.autoGreetings.followMessage.replace('{user}', username);
    this.sendMessage(msg);
  }

  onSubscribe(username, tier) {
    if (!this.autoGreetings.enabled) return;
    const tierName = tier === '1000' ? 'Tier 1' : tier === '2000' ? 'Tier 2' : 'Tier 3';
    const msg = this.autoGreetings.subscribeMessage.replace('{user}', username).replace('{tier}', tierName);
    this.sendMessage(msg);
  }

  onRaid(username, viewers) {
    if (!this.autoGreetings.enabled) return;
    const msg = this.autoGreetings.raidMessage.replace('{user}', username).replace('{viewers}', viewers);
    this.sendMessage(msg);
  }

  disconnect() {
    this._stopped = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ircSocket) {
      try { this.send(`PART #${this.channelName}`); } catch (e) {}
      this.ircSocket.destroy();
      this.ircSocket = null;
    }
    this.isConnected = false;
  }

  getStatus() {
    return { connected: this.isConnected, channel: this.channelName, autoGreetings: this.autoGreetings };
  }
}

const chatManager = new TwitchChatManager();

// ─── EventSub Webhook Endpoints ──────────────────────────────────────────────
// Registered from inside startHttpServer() via registerTwitchEventSubRoutes(app) — the
// Express `app` only exists in that scope, so these can't be attached at module top-level.
function registerTwitchEventSubRoutes(app) {

// POST /api/twitch/eventsub/webhook - Receive EventSub events
app.post('/api/twitch/eventsub/webhook', (req, res) => {
  if (!eventSubService.verifyWebhookSignature(req)) {
    console.error('[EventSub] Invalid signature');
    return res.status(403).send('Forbidden');
  }

  const messageType = req.headers['twitch-eventsub-message-type'];
  const data = req.body;

  // Twitch requires the challenge echoed back as plain text with 200
  if (messageType === 'webhook_callback_verification') {
    console.log('[EventSub] Challenge received, responding');
    return res.status(200).type('text/plain').send(data.challenge);
  }

  // Acknowledge all other message types immediately
  res.status(204).send();

  if (messageType === 'notification_revocation') {
    console.warn('[EventSub] Subscription revoked:', data.subscription?.id, data.subscription?.status);
    return;
  }

  if (messageType === 'notification') {
    try {
      eventSubService.handleEvent({
        type: data.subscription.type,
        data: data.event
      });
    } catch (err) {
      console.error('[EventSub] Event handling error:', err);
    }
  }
});

// POST /api/twitch/eventsub/subscribe - Register for events
app.post('/api/twitch/eventsub/subscribe', async (req, res) => {
  const { eventTypes, channelId } = req.body;

  if (!state.twitch.apiToken) {
    return res.status(400).json({ error: 'Not connected to Twitch' });
  }

  if (!channelId) {
    return res.status(400).json({ error: 'Channel ID required' });
  }

  try {
    let results = [];

    // EventSub now runs over a WebSocket session that's opened automatically on connect.
    // Make sure it's running so there's a session to attach subscriptions to.
    if (!eventSubService.sessionId) eventSubService.start();

    const V2_TYPES = new Set(['channel.follow', 'channel.hype_train.begin', 'channel.hype_train.progress', 'channel.hype_train.end']);
    if (eventTypes && Array.isArray(eventTypes)) {
      for (const eventType of eventTypes) {
        const version = V2_TYPES.has(eventType) ? '2' : '1';
        const sub = await eventSubService.subscribe(eventType, version, { broadcaster_user_id: channelId });
        results.push({ eventType, success: !!sub });
      }
    } else {
      results = await eventSubService.subscribeToAll(channelId);
    }

    res.json({ subscriptions: results, status: eventSubService.getStatus() });
  } catch (err) {
    console.error('[EventSub Subscribe]', err);
    res.status(500).json({ error: 'Subscription failed', details: err.message });
  }
});

// GET /api/twitch/eventsub/status - Get subscription status
app.get('/api/twitch/eventsub/status', (req, res) => {
  res.json(eventSubService.getStatus());
});

// GET /api/twitch/activity-log
app.get('/api/twitch/activity-log', (req, res) => {
  res.json({ log: (state.twitch && state.twitch.activityLog) || [] });
});

// POST /api/twitch/activity-log/clear
app.post('/api/twitch/activity-log/clear', (req, res) => {
  if (state.twitch) state.twitch.activityLog = [];
  broadcast(bridgeClients, { type: 'twitch_activity_log_cleared' });
  res.json({ ok: true });
});

// ─── Twitch Clips API ──────────────────────────────────────────────────────────
// GET /api/twitch/clips
app.get('/api/twitch/clips', async (req, res) => {
  if (!state.twitch || !state.twitch.channelId || !twitchClient) {
    return res.status(400).json({ error: 'Twitch not connected', clips: [], cursor: null });
  }
  try {
    const result = await twitchClient.getClips(state.twitch.channelId, {
      cursor: req.query.cursor,
      first:  req.query.first || 20
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, clips: [], cursor: null });
  }
});

// ─── Social Publishing API ─────────────────────────────────────────────────────
const _socialGuard = (req, res) => {
  if (!socialPublisher) { res.status(503).json({ error: 'Social publisher not initialized yet' }); return false; }
  return true;
};

// GET /api/social/connections — which platforms are connected/configured
app.get('/api/social/connections', (req, res) => {
  if (!_socialGuard(req, res)) return;
  res.json(socialPublisher.getConnections());
});

// GET /api/social/auth/youtube — start YouTube OAuth
app.get('/api/social/auth/youtube', (req, res) => {
  if (!_socialGuard(req, res)) return;
  try { res.json({ url: socialPublisher.getYouTubeAuthUrl() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/social/callback/youtube — YouTube OAuth callback
app.get('/api/social/callback/youtube', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(_oauthDonePage('YouTube', false, error));
  if (!code) return res.status(400).send('<h2>Missing code</h2>');
  try {
    await socialPublisher.handleYouTubeCallback(code);
    broadcast(bridgeClients, { type: 'social_connected', platform: 'youtube' });
    res.send(_oauthDonePage('YouTube', true));
  } catch (e) {
    res.send(_oauthDonePage('YouTube', false, e.message));
  }
});

// GET /api/social/auth/twitter — start Twitter/X OAuth
app.get('/api/social/auth/twitter', (req, res) => {
  if (!_socialGuard(req, res)) return;
  try {
    const { url, state: twState } = socialPublisher.getTwitterAuthUrl();
    res.json({ url });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/social/callback/twitter — Twitter OAuth callback
app.get('/api/social/callback/twitter', async (req, res) => {
  const { code, state: twState, error } = req.query;
  if (error) return res.send(_oauthDonePage('Twitter / X', false, error));
  if (!code) return res.status(400).send('<h2>Missing code</h2>');
  try {
    await socialPublisher.handleTwitterCallback(code, twState);
    broadcast(bridgeClients, { type: 'social_connected', platform: 'twitter' });
    res.send(_oauthDonePage('Twitter / X', true));
  } catch (e) {
    res.send(_oauthDonePage('Twitter / X', false, e.message));
  }
});

// POST /api/social/disconnect/:platform
app.post('/api/social/disconnect/:platform', (req, res) => {
  if (!_socialGuard(req, res)) return;
  socialPublisher.disconnect(req.params.platform);
  res.json({ ok: true });
});

// POST /api/social/clip/download — download a Twitch clip to the local library
app.post('/api/social/clip/download', async (req, res) => {
  if (!_socialGuard(req, res)) return;
  const { clipUrl, thumbnailUrl, title } = req.body || {};
  if (!clipUrl) return res.status(400).json({ error: 'clipUrl required' });
  try {
    const tmp = await socialPublisher.downloadTwitchClip(
      thumbnailUrl, clipUrl,
      state.twitch?.apiToken, TWITCH_CLIENT_ID
    );
    let clip = null;
    if (clipSystem) {
      clip = await clipSystem.manager.importReplayFile(tmp, { label: title || 'Twitch Clip', type: 'twitch-clip' });
      try { fs.unlinkSync(tmp); } catch {}
      state.clips = clipSystem.getState();
      broadcastClipsUpdate();
    }
    res.json({ ok: true, clip });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/social/schedule — list all scheduled posts
app.get('/api/social/schedule', (req, res) => {
  if (!_socialGuard(req, res)) return;
  res.json({ schedule: socialPublisher.getSchedule() });
});

// POST /api/social/schedule — add a scheduled post
// YouTube: upload immediately with publishAt so YouTube handles the publish time natively.
// Twitter: pre-upload media now so posting later is just a fast tweet call.
app.post('/api/social/schedule', async (req, res) => {
  if (!_socialGuard(req, res)) return;
  try {
    const body = req.body;
    const post = socialPublisher.addPost(body);
    res.json({ ok: true, post });
    // Background work after responding — no need to block the client
    const platforms = post.platforms || [];
    if (platforms.includes('youtube') && post.scheduledAt) {
      // Upload to YouTube now with the future publishAt; YouTube handles the reveal
      try {
        const results = await socialPublisher.publish({ ...post, platforms: ['youtube'] });
        const entry = socialPublisher.getSchedule().find(p => p.id === post.id);
        if (entry) {
          entry.youtubeUploaded = true;
          entry.publishResults  = { platforms: results.platforms };
        }
        socialPublisher._save(socialPublisher.schedulePath, socialPublisher.schedule);
        console.log('[Social] YouTube pre-upload done for scheduled post', post.id);
      } catch (e) {
        console.error('[Social] YouTube pre-upload failed:', e.message);
      }
    }
    if (platforms.includes('twitter') && post.scheduledAt) {
      try {
        const mediaId = await socialPublisher.prepareTwitterMedia(post);
        if (mediaId) {
          const entry = socialPublisher.getSchedule().find(p => p.id === post.id);
          if (entry) entry.twitterMediaId = mediaId;
          socialPublisher._save(socialPublisher.schedulePath, socialPublisher.schedule);
          console.log('[Social] Twitter media pre-uploaded for scheduled post', post.id);
        }
      } catch (e) {
        console.error('[Social] Twitter pre-upload failed:', e.message);
      }
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// DELETE /api/social/schedule/:id — cancel a scheduled post
app.delete('/api/social/schedule/:id', (req, res) => {
  if (!_socialGuard(req, res)) return;
  const ok = socialPublisher.cancelPost(req.params.id);
  res.json({ ok });
});

// POST /api/social/publish-now — immediate publish (no schedule)
app.post('/api/social/publish-now', async (req, res) => {
  if (!_socialGuard(req, res)) return;
  try {
    // Inject Twitch credentials so the downloader can use authenticated GQL requests
    const post = { ...req.body, _twitchToken: state.twitch?.apiToken, _twitchClientId: TWITCH_CLIENT_ID };
    const results = await socialPublisher.publish(post);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function _oauthDonePage(platform, success, err) {
  const color = success ? '#48bb78' : '#ef4444';
  const msg   = success ? `${platform} connected successfully!` : `Error: ${err || 'Unknown error'}`;
  return `<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0d0d14;color:#fff">
    <div style="font-size:48px;margin-bottom:20px;">${success ? '✓' : '✗'}</div>
    <h2 style="color:${color};margin-bottom:12px;">${msg}</h2>
    <p style="color:rgba(255,255,255,0.5);">You can close this window and return to NE Broadcast Suite.</p>
    <script>setTimeout(()=>window.close(),2000)</script>
  </body></html>`;
}

// Set webhook URL for EventSub (using ngrok or public URL)
const EVENTSUB_WEBHOOK_URL = process.env.EVENTSUB_WEBHOOK_URL || 'http://localhost:3000/api/twitch/eventsub/webhook';
// Use a persisted secret so HMAC verification survives restarts.
// Priority: env var → saved twitch-data.json → generate-and-persist.
let EVENTSUB_WEBHOOK_SECRET = process.env.EVENTSUB_WEBHOOK_SECRET || state.twitch.webhookSecret;
if (!EVENTSUB_WEBHOOK_SECRET) {
  EVENTSUB_WEBHOOK_SECRET = 'broadcast-studio-secret-' + Math.random().toString(36).substring(7);
  state.twitch.webhookSecret = EVENTSUB_WEBHOOK_SECRET;
  saveTwitchData();
}
eventSubService.setWebhookConfig(EVENTSUB_WEBHOOK_URL, EVENTSUB_WEBHOOK_SECRET);

// ─── Stream State API Endpoints ──────────────────────────────────────────────

// GET /api/twitch/stream/state - Get current stream state (viewer count, live status, title, game)
// GET /twitch-embed?channel= — proxy page served at localhost so the Twitch player parent param is valid
// (Control panel loads as file:// so direct player.twitch.tv embeds are rejected by Twitch)
app.get('/twitch-embed', (req, res) => {
  const channel = (req.query.channel || '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
  if (!channel) return res.status(400).send('Missing channel');
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;overflow:hidden;}html,body,iframe{width:100%;height:100%;border:0;background:#0e0e10;}</style></head><body><iframe src="https://player.twitch.tv/?channel=${channel}&parent=localhost&muted=true&autoplay=false" allowfullscreen></iframe></body></html>`);
});

app.get('/api/twitch/stream/state', (req, res) => {
  res.json(streamStateManager.getState());
});

// GET /api/twitch/stream/viewers - Get just viewer count
app.get('/api/twitch/stream/viewers', (req, res) => {
  res.json({
    viewers: streamStateManager.streamState.viewerCount,
    isLive: streamStateManager.streamState.isLive,
    title: streamStateManager.streamState.title,
    game: streamStateManager.streamState.game
  });
});

// GET /api/twitch/ads/countdown - Get seconds until next ad
app.get('/api/twitch/ads/countdown', (req, res) => {
  const countdown = streamStateManager.getAdCountdown();
  res.json({
    secondsUntilAd: countdown,
    nextAdAt: streamStateManager.adSchedule.nextAdAt,
    lastAdAt: streamStateManager.adSchedule.lastAdAt,
    adDuration: streamStateManager.adSchedule.adDuration
  });
});

// GET /api/twitch/test - Validate token; auto-refresh if expired
app.get('/api/twitch/test', async (req, res) => {
  if (!state.twitch.apiToken) return res.json({ ok: false, error: 'No token stored — please connect first' });

  const validate = async (token) => {
    const r = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${token}` }
    });
    return r.data;
  };

  try {
    let d;
    try {
      d = await validate(state.twitch.apiToken);
    } catch (e) {
      if (e.response?.status === 401 && state.twitch.refreshToken) {
        const newToken = await refreshTwitchToken();
        d = await validate(newToken);
      } else throw e;
    }
    const expiresHours = d.expires_in ? Math.round(d.expires_in / 3600) : '?';
    res.json({ ok: true, displayName: d.login, scopes: d.scopes, expiresIn: `${expiresHours}h` });
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    if (status === 401) {
      res.json({ ok: false, error: `Token expired — reconnect to generate a new one (${msg})` });
    } else {
      res.json({ ok: false, error: `Twitch API error ${status || ''}: ${msg}` });
    }
  }
});

// ─── Dual Clip Endpoint (OBS replay buffer + Twitch clip) ────────────────────

app.post('/api/twitch/clip', async (req, res) => {
  const result = { obs: false, twitch: false, clipId: null, editUrl: null, errors: [] };

  // OBS replay buffer save
  if (obsClient && obsClient.isConnected()) {
    try {
      const active = await obsClient.isReplayBufferActive();
      if (!active) {
        await obsClient.startReplayBuffer();
        await new Promise(r => setTimeout(r, 800)); // brief settle before saving
      }
      const ok = await obsClient.saveReplayBuffer();
      result.obs = !!ok;
      if (!ok) result.errors.push('OBS: ' + (obsClient.getLastError() || 'save failed'));
    } catch (e) {
      result.errors.push('OBS: ' + e.message);
    }
  } else {
    result.errors.push('OBS: not connected');
  }

  // Twitch clip (channel must be live — API returns 422 if offline)
  if (twitchClient && state.twitch.connected && state.twitch.channelId) {
    try {
      const clip = await twitchClient.createClip(state.twitch.channelId);
      if (clip) {
        result.twitch = true;
        result.clipId = clip.id;
        result.editUrl = clip.edit_url || null;
        console.log(`[Clip] Twitch clip created: ${clip.id}`);
      } else {
        result.errors.push('Twitch: empty response');
      }
    } catch (e) {
      const msg = e.response?.data?.message || e.message;
      const status = e.response?.status;
      if (status === 404 || status === 422) {
        result.errors.push('Twitch: channel must be live to create clips');
      } else {
        result.errors.push('Twitch: ' + msg);
      }
      console.error('[Clip] Twitch clip failed:', msg);
    }
  } else {
    result.errors.push('Twitch: not connected');
  }

  res.json(result);
});

// ─── Chat Management API Endpoints ──────────────────────────────────────────

// GET /api/twitch/chat/status - Get chat connection status
app.get('/api/twitch/chat/status', (req, res) => {
  res.json(chatManager.getStatus());
});

// POST /api/twitch/chat/send - Send a message to chat
app.post('/api/twitch/chat/send', (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }
  if (!chatManager.isConnected) {
    return res.status(400).json({ error: 'Chat not connected' });
  }

  try {
    chatManager.sendMessage(message);
    res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/twitch/chat/automations - Update auto-greetings settings
app.post('/api/twitch/chat/automations', (req, res) => {
  const { enabled, followMessage, subscribeMessage, raidMessage } = req.body;

  if (typeof enabled === 'boolean') chatManager.autoGreetings.enabled = enabled;
  if (followMessage) chatManager.autoGreetings.followMessage = followMessage;
  if (subscribeMessage) chatManager.autoGreetings.subscribeMessage = subscribeMessage;
  if (raidMessage) chatManager.autoGreetings.raidMessage = raidMessage;

  res.json({ success: true, automations: chatManager.autoGreetings });
});

// POST /api/twitch/marker — drop a stream marker in the VOD
app.post('/api/twitch/marker', async (req, res) => {
  if (!twitchClient || !state.twitch.channelId) {
    return res.status(503).json({ error: 'Twitch not connected' });
  }
  try {
    const { description } = req.body;
    const result = await twitchClient.createStreamMarker(
      state.twitch.channelId,
      description || 'BroadcastStudio marker'
    );
    res.json({ ok: true, marker: result });
  } catch (err) {
    console.error('[Twitch] Marker error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

} // ── end registerTwitchEventSubRoutes ──

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
module.exports.shutdown = function () {
  stopValorantPolling();
  if (_watchdogInterval) { clearInterval(_watchdogInterval); _watchdogInterval = null; }
  if (_bridgeHeartbeat) { clearInterval(_bridgeHeartbeat); _bridgeHeartbeat = null; }
  if (_bcTimer) { clearTimeout(_bcTimer); _bcTimer = null; }
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (rlReconnectTimer) { clearTimeout(rlReconnectTimer); rlReconnectTimer = null; }
  if (rlSocket) { try { rlSocket.destroy(); } catch (e) { /* ignore */ } rlSocket = null; }

  for (const client of bridgeClients) {
    try { client.terminate(); } catch (e) { /* ignore */ }
  }
  bridgeClients.clear();

  if (bridgeWss) { bridgeWss.close(() => {}); bridgeWss = null; }
  if (httpServer) { httpServer.close(() => {}); httpServer = null; }

  try { _saveAppStateNow(true); } catch (e) { /* ignore */ }   // sync flush so the write completes before exit
  stats.close();
  playerDb.close();
};

module.exports.broadcastCrashAlert = function (message) {
  broadcast(bridgeClients, { type: 'crash_alert', data: { message } });
};

module.exports.setEncodeProgressCallback = function (cb) {
  onEncodeProgressCallback = cb;
};

// Launcher window handoff: main.js registers how to swap launcher → studio window;
// the launcher page POSTs /api/launcher/launch when auth + load animation are done.
module.exports.setLauncherLaunchCallback = function (cb) {
  _launcherLaunchCb = cb;
};

module.exports.setLauncherResizeCallback = function (cb) {
  _launcherResizeCb = cb;
};

// Game performance mode: main.js lowers/restores every app process's priority here.
module.exports.setPerfPriorityCallback = function (cb) {
  _perfPriorityCb = cb;
};

module.exports.setRlSpectatorUiHotkeyChangeCallback = function (cb) {
  onRlSpectatorUiHotkeyChange = cb;
};

// Auto-update bridge (driven by main.js / electron-updater).
module.exports.setUpdateHandlers = function (handlers) {
  _updateHandlers = handlers || null;
};
module.exports.broadcastUpdateStatus = function (status) {
  _lastUpdateStatus = status || null;
  broadcast(bridgeClients, { type: 'update_status', data: _lastUpdateStatus });
};

module.exports.getRlSpectatorUiConfig = function () {
  return state.rlSpectatorUi || rlSpectatorUi.DEFAULTS;
};

module.exports.hideRlNativeUi = function () {
  return triggerRlHideNativeUi();
};


