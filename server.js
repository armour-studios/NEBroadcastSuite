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
const { dialog, app: _electronApp } = require('electron');
const { EventEmitter } = require('events');
const IS_DEV = () => _electronApp && !_electronApp.isPackaged;
const { createStartGgClient } = require('./backend/integrations/startgg-client');
const { createDirectorEngine } = require('./backend/director');
const cloud = require('./backend/cloud/cloud-client');   // Nameless cloud (dormant until BROADCAST_REMOTE_URL set)
const { createClipSystem } = require('./backend/clips');
const { createTelemetryRecorder } = require('./backend/telemetry/recorder');   // AI training-data capture (Phase 0, local JSONL)
const autoSwitch = require('./backend/director/auto-switch');
const rlSpectatorUi = require('./backend/integrations/rl-spectator-ui');
const { createOverlayEditor } = require('./backend/scenes/overlay-editor');
const vetoData = require('./backend/veto');
const draftData = require('./backend/draft');
const stats = require('./backend/db/stats');

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
const { PredictionManager } = require('./backend/integrations/twitch-predictions');
const { WheelManager } = require('./backend/integrations/twitch-wheel');
const { MiniGameManager } = require('./backend/integrations/twitch-minigames');
const { ChatParser } = require('./backend/integrations/twitch-chat-parser');
let twitchDataFile = '';
let discordDataFile = '';
let twitchClient = null;
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
let startggApiToken = '';

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
  ]
};
const GENERIC_OVERLAY_LAYOUTS = [
  { id: 'production', name: 'Production browser sources', path: '' }
];

const GAMES = {
  'rocket-league': { id: 'rocket-league', name: 'Rocket League', overlay: '/',          format: 'duo',   teamLabels: { a: 'Blue', b: 'Orange' },           rosterSize: 3, logo: 'games/rocketleague.svg',  features: ['boost', 'stats-api', 'director'],   themes: [] },
  'csgo':          { id: 'csgo',          name: 'CS2 / CS:GO',   overlay: '/csgo.html', format: 'team5', teamLabels: { a: 'CT', b: 'T' },                  rosterSize: 5, logo: 'games/cs2.svg',           features: ['gsi', 'radar', 'vetoes', 'director'], themes: [] },
  'valorant':      { id: 'valorant',      name: 'Valorant',      overlay: '',           format: 'team5', teamLabels: { a: 'Attackers', b: 'Defenders' },   rosterSize: 5, logo: 'games/valorant.svg',      features: ['vetoes', 'agents', 'director'],     themes: [] },
  'league':        { id: 'league',        name: 'League of Legends', overlay: '',       format: 'team5', teamLabels: { a: 'Blue', b: 'Red' },              rosterSize: 5, logo: 'games/lol.svg',           features: ['draft', 'director'],                themes: [] },
  'dota2':         { id: 'dota2',         name: 'Dota 2',        overlay: '',           format: 'team5', teamLabels: { a: 'Radiant', b: 'Dire' },          rosterSize: 5, logo: 'games/dota2.svg',         features: ['draft'],                themes: [] },
  'overwatch':     { id: 'overwatch',     name: 'Overwatch 2',   overlay: '/overwatch.html', format: 'team5', teamLabels: { a: 'Defenders', b: 'Attackers' }, rosterSize: 5, logo: 'games/overwatch2.png',    features: ['heroes', 'vetoes'],     themes: [] },
  'rainbow6':      { id: 'rainbow6',      name: 'Rainbow Six Siege', overlay: '',       format: 'team5', teamLabels: { a: 'Attack', b: 'Defense' },        rosterSize: 5, logo: 'games/rainbow6.svg',      features: ['vetoes', 'operators'],  themes: [] },
  'cod':           { id: 'cod',           name: 'Call of Duty',  overlay: '',           format: 'team4', teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 4, logo: 'games/cod.png',           features: ['vetoes'],               themes: [] },
  'apex':          { id: 'apex',          name: 'Apex Legends',  overlay: '',           format: 'ffa',   teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 3, logo: 'games/apex.svg',          features: ['battle-royale', 'legends'], themes: [] },
  'fortnite':      { id: 'fortnite',      name: 'Fortnite',      overlay: '',           format: 'ffa',   teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 4, logo: 'games/fortnite.png',      features: ['battle-royale'],        themes: [] },
  'marvel-rivals': { id: 'marvel-rivals', name: 'Marvel Rivals', overlay: '/marvel-rivals.html', format: 'team6', teamLabels: { a: 'Team A', b: 'Team B' }, rosterSize: 6, logo: 'games/rivals.png',        features: ['heroes'],               themes: [] },
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
  'valorant': { default: 'valorant-hud', midnight: 'valorant-hud', neon: 'valorant-hud' }
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
  activeGame: 'rocket-league',
  themesByGame: { 'rocket-league': 'classic', 'csgo': 'cs2-hud' },
  eventName: '',   // fresh installs start with no preset title — the producer sets their own
  gameLabel: '',   // custom "GAME x | BEST OF x" override (e.g. "UPCOMING MATCH"); '' = auto
  fontFamily: 'Bourgeois',
  facecamsEnabled: true,
  replayCams: true,         // show all player cams + cards during replays (RL React HUD)
  activeBrandKitId: null,   // selected client brand kit (recolors overlays + drives sponsor rail)
  useBrandColors: false,    // legacy mirror of (colorMode === 'brand') — kept for back-compat
  // Which colours overlays use for the two sides. Non-destructive: each source is kept separately
  // (team = teams.x.color, brand = active kit, default = per-game) and the effective colour is
  // computed at broadcast time, so toggling never overwrites a team's own colour.
  colorMode: 'team',        // 'team' | 'brand' | 'default'
  banner: { visible: false, images: [], captions: [], interval: 10, slant: 'right', header: '' },
  casters: { visible: true, list: [], lowerThird: '', library: [], vdo: { room: '', password: '' }, guestsVdo: { room: '', password: '' }, observersVdo: { room: '', password: '' }, rooms: [], lineup: [], activeLayout: '', interview: { room: '', password: '' }, apiKey: '', interviewee: null, deskRoomId: '' },   // list = on-air slots; library = saved casters/guests/observers (by kind); vdo/guestsVdo/observersVdo = the three shared group rooms; rooms = named VDO rooms; lineup = this-show active assignments; apiKey = director IFrame-API key; interviewee = spotlight-desk right cam; deskRoomId = which named room is the interview/desk room
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
  // Playout playlists — sequences of clips and/or media files (commercials/intros/outros) that can
  // be pushed live through the replay program bus with auto-return. See save_playout.
  playouts: [],
  ticker: { visible: false, messages: [], speed: 40, source: 'manual', feed: [] },   // scrolling lower-third; speed = loop seconds
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
  // Champion/hero draft board (LoL etc.). sequence/ops drive the live pick-ban.
  draft: { visible: false, title: '', game: '', teamStart: 'a', sequence: [], ops: [], turn: null, complete: false },
  // Team-lineup / player-intro card scene. side = which team to feature ('blue'|'orange'); style = card variant.
  intro: { visible: false, side: 'blue', title: '', style: 1 },
  // Overtime ad slot — sellable sponsor slot shown on the overlay during OT.
  overtime: { label: 'OVERTIME', logo: null, bg: '#e0202a', color: '#ffffff' },
  // Replay ad slot. logo = sponsor on the goal swipe; outroLogo = logo on the after-replay swipe
  // (e.g. tournament-organizer logo); colorMode: 'team' | 'mono' (B&W).
  replay: { label: 'REPLAY', logo: null, outroLogo: null, colorMode: 'team' },
  // Scoreboard ad slot — sponsor logo + uploadable scene background on the scorecard.
  scoreboardAd: { label: 'PRESENTED BY', logo: null, background: null },
  // Desk footer logos — manual Dashboard override. When non-empty these replace the active
  // brand's desk-tagged sponsors on the caster-desk scenes; when empty the brand's logos show.
  deskFooter: { logos: [] },
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
  bestOf: 5,
  teams: {
    blue:   { name: 'BLUE TEAM',   logo: null, color: '#055fdb', players: [] },
    orange: { name: 'ORANGE TEAM', logo: null, color: '#e97139', players: [] }
  },
  teamPlayers: {}, // keyed by side, contains player data
  series:  { blue: 0, orange: 0 },
  // Series/match editor: format + division + per-map results (feeds the HUDs).
  // maps: [{ name, scoreA, scoreB, played }]
  match:   { format: '', division: '', maps: [] },
  // Manually-managed leagues (NOT start.gg). Each league:
  // { id, name, game, type:'team'|'freeagent'|'salary', season, salaryCap,
  //   teams:[{id,name,logo,players:[{id,name,role,salary,stats}]}],
  //   freeAgents:[{id,name,role,salary,stats}], standings:[{teamId,w,l,pts}], schedule:[{a,b,scoreA,scoreB,date,played}] }
  leagues: [],
  // Events the producer has "added to the app" (the MY EVENTS page). Each:
  // { id, tournamentSlug, eventSlug, name, tournamentName, game, numEntrants, startAt, addedAt,
  //   seeding: { entrants:[{entrantId,name,seedNum,players:[{gamerTag,rankField,rankValue}]}], fieldMap:{} } }
  myEvents: [],
  game:    { blueScore: 0, orangeScore: 0, time: 300, isOT: false, number: 1 },
  gameTeams: { blue: '', orange: '' },
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
  obs: {
    enabled: false,
    connected: false,
    url: 'ws://127.0.0.1:4455',
    autoSwitch: true,
    autoReplayOnGoal: false,   // save an OBS replay-buffer clip on every goal
    lastError: null,
    postGameToCastersSec: 0,  // auto-switch post-game → casters after N seconds (0 = off)
    kickoff: { enabled: false, scene: '' },  // smart trigger: auto-cut to this scene at the 3-2-1 kickoff countdown
    availableScenes: [],
    currentScene: '',    // live OBS PROGRAM scene = what viewers see (authoritative "on air")
    scenes: {            // OBS scene name to switch to for each broadcast moment
      inGame: '',
      replay: '',
      postGame: '',
      break: '',
      commercial: '',    // dedicated ad-break scene that plays commercial videos
      casters: '',
      bracket: ''
    },
    commercialAutoReturn: true   // auto-cut back to program when the commercial video ends
  },
  // Runtime (not persisted): are we currently in a commercial, and where to return.
  commercial: { active: false, returnScene: '' },
  bracket: {
    visible: false,
    eventSlug: '',
    title: '',
    type: '',            // SINGLE_ELIMINATION | DOUBLE_ELIMINATION | ROUND_ROBIN | SWISS (mirrors active phase)
    winners: [],         // [{ name, round, sets: [{ a:{name,score,winner}, b:{...} }] }] (mirrors active phase)
    losers: [],
    finals: [],
    standings: [],       // [{ placement, name, wins, losses }] for round-robin / swiss (mirrors active phase)
    matches: [],         // [{ id, round, a, b, state }] flat picker list
    // Multi-phase events (e.g. Day 1 double-elim → Day 2 single-elim/swiss).
    // Each phase: { id, name, type, winners, losers, finals, standings, schedule, roster }.
    // Top-level winners/losers/finals/standings/type mirror the ACTIVE phase so the
    // existing overlay keeps working unchanged.
    phases: [],
    activePhaseId: '',
    view: 'both',        // overlay view: both | winners | losers | finals (set from the Brackets tab)
    rounds: 4,           // for view='finals' — how many last round-columns of each bracket to show
    lastFetchAt: null,
    lastError: null
  },
  upcoming: {
    visible: false,
    title: 'UPCOMING MATCHES',
    matches: []   // manual entries/overrides: [{id,round,teamA,teamB,teamALogo,teamBLogo,scheduledTime,stream,note}]
  },
  standings: {
    visible: false,
    title: '',    // '' = inherit bracket.title; auto-populated from bracket.standings if rows is empty
    rows: []      // manual override: [{placement,name,logo,wins,losses,points}]
  },
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
    refreshToken: ''
  },

  // ─── Flows (production automation) ─────────────────────────────────────────
  // Each flow: { id, name, enabled, triggerMode: 'any'|'sequence', triggers: [...], actions: [...], cooldown }
  // Triggers: { id, type, params, timeout (sequence mode only) }
  // Actions:  { id, type, params }
  flows: []
};

let directorEngine = null;
let clipSystem = null;
let telemetry = null;            // AI decision recorder (Phase 0)
let _directorRecShownAt = 0;     // when the current primary rec was first emitted (for decision latency)
let _lastRecTargetId = null;     // de-dupe the shadow recommendation stream
let overlayEditor = null;
let onEncodeProgressCallback = null;
let onRlSpectatorUiHotkeyChange = null;
let lastGenericDirectorFeed = 0;

let savedTeams = [];   // [{ name, logo }]
let savedFacecams = []; // [{ name, platformId, link }]
let savedPresets = [];  // [{ id, name, game, config }] — broadcast config presets
// Client/production identities. Selecting one recolors overlays + loads its sellable sponsor set.
let savedBrandKits = []; // [{ id, name, logo, color, accent, font, sponsorLabel, sponsorInterval,
                         //    sponsors: [{ id, name, logo, tier }], themes: { [gameId]: themeId } }]

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

function loadTeams() {
  savedTeams = safeReadJson(teamsFile, []);
}

function saveTeams() {
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
  try { safeWriteJson(brandsFile, savedBrandKits); } catch (e) { console.error('Error saving brand kits:', e); }
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
        deskFooter:           s.deskFooter,
        vdo:                  s.vdo,
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
    state.leagues = mergeAtTop(state.leagues || [], d.leagues, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    parts.push(`${d.leagues.length} leagues`);
  }
  if (want('castersLibrary') && Array.isArray(d.castersLibrary)) {
    if (!Array.isArray(state.casters.library)) state.casters.library = [];
    state.casters.library = mergeAtTop(state.casters.library, d.castersLibrary, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    parts.push(`${d.castersLibrary.length} casters`);
  }
  if (want('settings') && d.settings && typeof d.settings === 'object') {
    const v = d.settings;
    ['fontFamily', 'colorMode', 'activeBrandKitId', 'bestOf', 'banner', 'ticker', 'overtime', 'replay', 'scoreboardAd', 'deskFooter', 'vdo', 'customOverlayLayouts']
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
      apiToken:       state.twitch.apiToken       || '',
      refreshToken:   state.twitch.refreshToken   || '',
      displayName:    state.twitch.displayName    || '',
      channelId:      state.twitch.channelId      || '',
      profilePicture: state.twitch.profilePicture || '',
      webhookSecret:  state.twitch.webhookSecret,
      predictions:    state.twitch.predictions,
      wheel:          state.twitch.wheel,
      minigame:       state.twitch.minigame,
      chatSettings:   state.twitch.chatSettings,
      automations:    state.twitch.automations
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
      if (data.apiToken)       state.twitch.apiToken       = data.apiToken;
      if (data.refreshToken)   state.twitch.refreshToken   = data.refreshToken;
      if (data.displayName)    state.twitch.displayName    = data.displayName;
      if (data.channelId)      state.twitch.channelId      = data.channelId;
      if (data.profilePicture) state.twitch.profilePicture = data.profilePicture;
      if (data.webhookSecret)  state.twitch.webhookSecret  = data.webhookSecret;
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
      accessToken:  state.discord.accessToken  || '',
      refreshToken: state.discord.refreshToken || ''
    };
    safeWriteJson(discordDataFile, data, sync);
  } catch (err) {
    console.error('[Discord] Error saving user:', err.message);
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
      if (data.accessToken)  { state.discord.accessToken = data.accessToken; state.discord.connected = true; }
      if (data.refreshToken) state.discord.refreshToken = data.refreshToken;
      console.log('[Discord] User loaded', data.username ? `(${data.username})` : '');
    }
  } catch (err) {
    console.error('[Discord] Failed to load user:', err.message);
  }
}

// Where a sponsor logo can be displayed. Each brand sponsor carries a `placements`
// map of these flags, set with checkmarks in the brand editor.
const SPONSOR_SPOTS = ['rail', 'desk', 'overtime', 'replayGoal', 'replayOutro', 'scoreboard', 'banner'];
function sanitizePlacements(p) {
  // No placements (legacy sponsor saved before this feature) → show on rail + caster desk,
  // matching the old "every sponsor shows on the rail/desk" behaviour.
  if (!p || typeof p !== 'object') {
    return { rail: true, desk: true, overtime: false, replayGoal: false, replayOutro: false, scoreboard: false, banner: false };
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
const PACKAGE_FIELDS = ['sponsorLabel', 'sponsorInterval', 'sponsors', 'bannerImages', 'bannerCaptions', 'bannerSlant', 'bannerHeader', 'bannerInterval'];

function sanitizePackage(p, fallbackName) {
  p = p || {};
  return {
    id: p.id || brandId(),
    name: (p.name || fallbackName || 'Main').toString().slice(0, 40),
    sponsorLabel: (p.sponsorLabel || 'PARTNERS').toString(),
    sponsorInterval: Number(p.sponsorInterval) > 0 ? Number(p.sponsorInterval) : 6,
    sponsors: Array.isArray(p.sponsors) ? p.sponsors.map((s) => ({
      id: s.id || brandId(), name: (s.name || '').toString(), logo: s.logo || null,
      tier: s.tier || 'partner', placements: sanitizePlacements(s.placements)
    })) : [],
    bannerImages: Array.isArray(p.bannerImages) ? p.bannerImages : [],
    bannerCaptions: Array.isArray(p.bannerCaptions) ? p.bannerCaptions.map((t) => (typeof t === 'string' ? t : '')) : [],
    bannerSlant: ['right', 'left', 'box'].includes(p.bannerSlant) ? p.bannerSlant : 'right',
    bannerHeader: typeof p.bannerHeader === 'string' ? p.bannerHeader.slice(0, 40) : '',
    bannerInterval: Number(p.bannerInterval) > 0 ? Number(p.bannerInterval) : 10,
  };
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
    placements: sanitizePlacements(s.placements)
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
    bannerImages: Array.isArray(pkg.bannerImages) ? pkg.bannerImages : [],
    bannerInterval: Number(pkg.bannerInterval) > 0 ? Number(pkg.bannerInterval) : 10,
    sponsors,                                  // all (for the editor + back-compat consumers)
    railSponsors: tagged('rail'),              // rotating corner bug
    deskSponsors: tagged('desk'),              // caster-desk footer logos
    bannerSponsors: tagged('banner'),          // sponsor-banner rotation
    spots: {                                   // single-logo ad slots → first tagged sponsor's logo
      overtime: (tagged('overtime')[0] || {}).logo || null,
      replayGoal: (tagged('replayGoal')[0] || {}).logo || null,
      replayOutro: (tagged('replayOutro')[0] || {}).logo || null,
      scoreboard: (tagged('scoreboard')[0] || {}).logo || null
    },
    // Package metadata for the editor + Dashboard quick-switch (names only — no base64).
    packages: (Array.isArray(kit.packages) ? kit.packages : []).map((p) => ({ id: p.id, name: p.name })),
    activePackageId: kit.activePackageId || null,
  };
}

// Push the active brand's single-logo spot assignments into the live ad-slot state so the
// existing overlays (which read state.overtime.logo / state.replay.* / state.scoreboardAd.logo)
// reflect brand placements with no overlay changes. Only writes when a sponsor is tagged, so a
// manual Dashboard upload is preserved when no sponsor claims that spot.
function applyBrandSlots() {
  const b = activeBrand();
  if (!b) return;
  const sponsorLogos = new Set(b.sponsors.map((s) => s.logo).filter(Boolean));
  // tagged → use it; no tag but the slot currently holds a brand sponsor → clear (the tick was
  // removed); otherwise keep (it's a manual Dashboard upload, not owned by the brand).
  const resolve = (cur, tagged) => (tagged != null ? tagged : (sponsorLogos.has(cur) ? null : cur));
  state.overtime.logo = resolve(state.overtime.logo, b.spots.overtime);
  state.replay.logo = resolve(state.replay.logo, b.spots.replayGoal);
  state.replay.outroLogo = resolve(state.replay.outroLogo, b.spots.replayOutro);
  state.scoreboardAd.logo = resolve(state.scoreboardAd.logo, b.spots.scoreboard);
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
  return { blue: state.teams.blue.color, orange: state.teams.orange.color };
}

// Snapshot of the event-level broadcast configuration (not live match scores).
function capturePreset() {
  return {
    activeGame: state.activeGame,
    theme: state.themesByGame[state.activeGame] || 'default',
    eventName: state.eventName,
    gameLabel: state.gameLabel,
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
  if (typeof cfg.fontFamily === 'string') state.fontFamily = cfg.fontFamily;
  if (cfg.bestOf) state.bestOf = cfg.bestOf;
  if (typeof cfg.facecamsEnabled === 'boolean') state.facecamsEnabled = cfg.facecamsEnabled;
  if (cfg.banner && typeof cfg.banner === 'object') state.banner = cfg.banner;
  if (cfg.ticker && typeof cfg.ticker === 'object') state.ticker = cfg.ticker;
  if (cfg.casters && typeof cfg.casters === 'object') state.casters = cfg.casters;
}

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
      if (saved.colorMode === 'team' || saved.colorMode === 'brand' || saved.colorMode === 'default') {
        state.colorMode = saved.colorMode;
      } else if (typeof saved.useBrandColors === 'boolean') {
        state.colorMode = saved.useBrandColors ? 'brand' : 'team';
      }
      state.useBrandColors = (state.colorMode === 'brand');
      // Use the saved value whenever it's a string (including '' — a deliberately cleared
      // title must NOT snap back to the factory default on reload).
      if (typeof saved.eventName === 'string') state.eventName = saved.eventName;
      if (typeof saved.gameLabel === 'string') state.gameLabel = saved.gameLabel;
      if (saved.fontFamily) state.fontFamily = saved.fontFamily;
      if (saved.facecamsEnabled !== undefined) state.facecamsEnabled = saved.facecamsEnabled;
      if (saved.replayCams !== undefined) state.replayCams = saved.replayCams;
      if (saved.banner) state.banner = saved.banner;
      if (saved.casters && typeof saved.casters === 'object') {
        state.casters = {
          visible: !!saved.casters.visible,
          lowerThird: typeof saved.casters.lowerThird === 'string' ? saved.casters.lowerThird : '',
          list: Array.isArray(saved.casters.list) ? saved.casters.list : [],
          library: Array.isArray(saved.casters.library) ? saved.casters.library : [],
          vdo: (saved.casters.vdo && saved.casters.vdo.room) ? saved.casters.vdo : { room: '', password: '' },
          rooms: Array.isArray(saved.casters.rooms) ? saved.casters.rooms : [],
          lineup: Array.isArray(saved.casters.lineup) ? saved.casters.lineup : [],
          activeLayout: typeof saved.casters.activeLayout === 'string' ? saved.casters.activeLayout : '',
          interview: (saved.casters.interview && saved.casters.interview.room) ? saved.casters.interview : { room: '', password: '' },
          apiKey: typeof saved.casters.apiKey === 'string' ? saved.casters.apiKey : '',
          interviewee: (saved.casters.interviewee && typeof saved.casters.interviewee === 'object') ? saved.casters.interviewee : null,
          deskRoomId: typeof saved.casters.deskRoomId === 'string' ? saved.casters.deskRoomId : ''
        };
      }
      if (saved.ticker && typeof saved.ticker === 'object') {
        state.ticker = {
          visible: !!saved.ticker.visible,
          messages: Array.isArray(saved.ticker.messages) ? saved.ticker.messages : [],
          speed: Number(saved.ticker.speed) > 0 ? Number(saved.ticker.speed) : 40,
          source: saved.ticker.source === 'startgg' ? 'startgg' : 'manual',
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
          colorMode: saved.replay.colorMode === 'mono' ? 'mono' : 'team'
        };
      }
      if (saved.scoreboardAd && typeof saved.scoreboardAd === 'object') {
        state.scoreboardAd = {
          label: typeof saved.scoreboardAd.label === 'string' ? saved.scoreboardAd.label : 'PRESENTED BY',
          logo: saved.scoreboardAd.logo || null,
          background: saved.scoreboardAd.background || null
        };
      }
      if (saved.deskFooter && Array.isArray(saved.deskFooter.logos)) {
        state.deskFooter = { logos: saved.deskFooter.logos.filter((l) => typeof l === 'string' && l) };
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
      if (Array.isArray(saved.playouts)) state.playouts = saved.playouts;
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
          style: [1, 2].includes(Number(saved.intro.style)) ? Number(saved.intro.style) : 1
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
          mapModes:   Array.isArray(saved.owMatch.mapModes)   ? saved.owMatch.mapModes   : []
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
      if (saved.bestOf) state.bestOf = saved.bestOf;
      if (saved.teams) {
        state.teams = saved.teams;
        // Ensure team colors exist for older saves
        if (state.teams.blue && !state.teams.blue.color) state.teams.blue.color = '#055fdb';
        if (state.teams.orange && !state.teams.orange.color) state.teams.orange.color = '#e97139';
      }
      if (saved.series) state.series = saved.series;
      if (saved.match && typeof saved.match === 'object') {
        state.match = {
          format: saved.match.format || '',
          division: saved.match.division || '',
          maps: Array.isArray(saved.match.maps) ? saved.match.maps : []
        };
      }
      if (Array.isArray(saved.leagues)) state.leagues = saved.leagues;
      if (Array.isArray(saved.myEvents)) state.myEvents = saved.myEvents;
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
        startggApiToken = saved.startggApiToken;
      }
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
            scene: (saved.obs.kickoff && saved.obs.kickoff.scene) || ''
          },
          commercialAutoReturn: saved.obs.commercialAutoReturn !== false,
          scenes: { ...state.obs.scenes, ...(saved.obs.scenes || {}) },
          // runtime fields are not restored
          connected: false,
          lastError: null,
          availableScenes: []
        };
      }
      if (typeof saved.obsPassword === 'string') {
        obsPassword = saved.obsPassword;
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
          matches: Array.isArray(saved.bracket.matches) ? saved.bracket.matches : [],
          phases: Array.isArray(saved.bracket.phases) ? saved.bracket.phases : [],
          activePhaseId: saved.bracket.activePhaseId || '',
          lastError: null
        };
      }
      if (saved.upcoming && typeof saved.upcoming === 'object') {
        state.upcoming = { ...state.upcoming, ...saved.upcoming, visible: false, matches: Array.isArray(saved.upcoming.matches) ? saved.upcoming.matches : [] };
      }
      if (saved.standings && typeof saved.standings === 'object') {
        state.standings = { ...state.standings, ...saved.standings, visible: false, rows: Array.isArray(saved.standings.rows) ? saved.standings.rows : [] };
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
      eventName: state.eventName,
      gameLabel: state.gameLabel,
      fontFamily: state.fontFamily,
      facecamsEnabled: state.facecamsEnabled,
      banner: state.banner,
      casters: state.casters,
      playouts: state.playouts,
      ticker: state.ticker,
      overtime: state.overtime,
      replay: state.replay,
      scoreboardAd: state.scoreboardAd,
      breakScreen: {
        visible: state.breakScreen.visible,
        title: state.breakScreen.title,
        message: state.breakScreen.message,
        finalMessage: state.breakScreen.finalMessage
      },
      playouts: state.playouts,
      // Persist content for the momentary production graphics; visibility is reset on restart.
      winner: { side: state.winner.side, name: state.winner.name, logo: state.winner.logo, color: state.winner.color, subtitle: state.winner.subtitle },
      veto: { title: state.veto.title, maps: state.veto.maps },
      intro: { side: state.intro.side, title: state.intro.title, style: state.intro.style },
      owMatch: { visible: !!state.owMatch.visible, format: state.owMatch.format, currentMapIdx: state.owMatch.currentMapIdx, bansByMap: state.owMatch.bansByMap, attackSide: state.owMatch.attackSide || null, showAttack: !!state.owMatch.showAttack, gameMode: state.owMatch.gameMode || 'escort', showMapLabels: state.owMatch.showMapLabels !== false, mapWinners: Array.isArray(state.owMatch.mapWinners) ? state.owMatch.mapWinners : [], mapModes: Array.isArray(state.owMatch.mapModes) ? state.owMatch.mapModes : [] },
      mrMatch: (function(){ const m=state.mrMatch||{}; return { visible: m.visible !== false, format: m.format || 'BO5', bansByMap: m.bansByMap || [], gameMode: m.gameMode || 'convergence', showMapLabels: m.showMapLabels !== false, mapWinners: Array.isArray(m.mapWinners)?m.mapWinners:[], mapModes: Array.isArray(m.mapModes)?m.mapModes:[], gepData: m.gepData||null }; })(),
      customOverlayLayouts: state.customOverlayLayouts || {},
      bestOf: state.bestOf,
      teams: state.teams,
      series: state.series,
      match: state.match,
      leagues: state.leagues,
      myEvents: state.myEvents,
      game: { number: state.game.number },
      startgg: state.startgg,
      startggApiToken,
      obs: {
        enabled: state.obs.enabled,
        url: state.obs.url,
        autoSwitch: state.obs.autoSwitch,
        autoReplayOnGoal: state.obs.autoReplayOnGoal,
        postGameToCastersSec: state.obs.postGameToCastersSec,
        kickoff: state.obs.kickoff,
        commercialAutoReturn: state.obs.commercialAutoReturn,
        scenes: state.obs.scenes
      },
      obsPassword,
      // Persist the full bracket so it renders instantly on restart (then refreshes)
      bracket: state.bracket,
      upcoming: state.upcoming,
      standings: state.standings,
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
      flows: state.flows || []
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
    return {
      id: prof.id || ('lineup_' + (entry.slot || (i + 1))),
      name: prof.name || '',
      handle: prof.handle || '',
      social: prof.social || 'none',
      slot: Number(entry.slot) || (i + 1),
      streamId: sid,
      room: vdo ? vdo.room : '',
      camUrl: entry.customCamUrl || (vdo ? buildCasterObsUrlFromVdo(fakeCaster, vdo) : (prof.camUrl || '')),
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
  const str = JSON.stringify(msg);
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
function buildLiveState() {
  const publicStartgg = { ...state.startgg, hasToken: !!startggApiToken };
  const publicObs = { ...state.obs, hasPassword: !!obsPassword };
  const publicDiscord = {
    connected: state.discord.connected,
    userId: state.discord.userId,
    username: state.discord.username,
    discriminator: state.discord.discriminator,
    globalName: state.discord.globalName,
    avatarUrl: state.discord.avatarUrl
  };
  // Effective side colours for the active mode — overlays read teams.x.color; the control
  // panel can still see each team's own colour via teams.x.ownColor.
  const eff = effectiveTeamColors();
  return {
    ...state,
    // Heavy, rarely-changing blobs (base64 logos/thumbnails) are stripped from the light
    // broadcast and re-sent only on change via libraryData(); client + overlays backfill them.
    // (bracket ≈ 0.9MB embedded team logos, replay ≈ 0.4MB frame thumbnails.) Leaving them in
    // ...state would put >1MB on EVERY broadcast and freeze the panel — the regression this fixes.
    bracket: undefined,
    replay: undefined,
    teams: {
      blue:   { ...state.teams.blue,   color: eff.blue,   ownColor: state.teams.blue.color },
      orange: { ...state.teams.orange, color: eff.orange, ownColor: state.teams.orange.color }
    },
    colorMode: state.colorMode || 'team',
    startgg: publicStartgg,
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
    vetoPools: vetoData.MAP_POOLS,   // per-game map pools for the veto manager
    vetoMeta: vetoData.VETO_META,    // per-game terminology (map/stage, Ban/Strike)
    draftGames: draftData.draftGames(),   // games with a champion-draft format
    theme: state.themesByGame[state.activeGame] || migrateThemeId(state.activeGame, 'default'),
    activeOverlay: activeOverlayPath(state.activeGame),
    overlayLayout: resolveOverlayLayout(state.activeGame, state.themesByGame[state.activeGame]),
    presets: savedPresets.map((p) => ({ id: p.id, name: p.name, game: p.game })),
    facecams: savedFacecams,
    formattedTime: formatTime(state.game.time),
    flows: state.flows || [],
    showRoster: state.showRoster || []
  };
}

// Heavy blobs that change rarely → sent on connect, then re-sent only when they change.
//   savedTeams / brandKits: control-panel libraries (base64 logos, tens-to-hundreds of KB).
//   brand / banner / mainBanner: derived from the active brand kit (base64 sponsor + banner
//     images, ~1MB) and read by overlays too — both sides backfill these when a light broadcast
//     omits them. This keeps live broadcasts at a few hundred bytes instead of ~2.6MB.
function libraryData() {
  return {
    savedTeams,
    brandKits: savedBrandKits,
    brand: activeBrand(),
    banner: bannerForBroadcast(),
    mainBanner: state.banner,
    bracket: state.bracket,   // manual bracket (embedded team logos) — backfilled by bracket overlay + panel
    replay: state.replay,     // replay-monitor thumbnails — backfilled by the replays page
    crew: state.crew || []    // unified crew profiles (hosts/guests/casters/observers)
  };
}
// Static config that never changes after startup → sent on connect only.
function staticData() {
  return { draftChampions: draftData.CHAMPIONS };   // League typeahead list (~20KB)
}
// Cheap signature (no base64 stringify — only lengths/counts) to detect library changes between
// broadcasts. Captures team name/colour/logo/roster and brand name/colours/logo/sponsors/banners.
function librarySig() {
  const t = savedTeams.map((t) => t.name + ':' + (t.color || '') + ':' + (t.logo ? t.logo.length : 0) + ':' + (t.players || []).length).join(',');
  const b = savedBrandKits.map((k) => {
    const pkg = activePackage(k) || {};
    const sp = (pkg.sponsors || []).reduce((a, s) => a + ((s && s.logo || '').length) + ((s && s.name || '').length), 0);
    const bn = (pkg.bannerImages || []).reduce((a, img) => a + ((img || '').length), 0);
    return k.id + ':' + (k.name || '') + ':' + (k.color || '') + ':' + (k.accent || '') + ':' + (k.logo ? k.logo.length : 0)
      + ':' + (k.activePackageId || '') + ':' + ((k.packages || []).length)
      + ':' + (pkg.sponsors || []).length + ':' + sp + ':' + bn;
  }).join(',');
  // …plus active-kit selection + banner toggle/images so brand/banner/mainBanner re-send when they change.
  const bn = (state.banner.images || []).reduce((a, i) => a + ((i || '').length), 0);
  // bracket + replay carry big base64 logos/thumbnails — sign their STRUCTURE + scalar fields but
  // collapse any long string to its length so we never stringify the base64 (this runs per-broadcast).
  const lite = (o) => { try { return JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 200) ? ('len' + v.length) : v) || ''; } catch { return ''; } };
  const extra = '|ab:' + (state.activeBrandKitId || '') + '|bv:' + (state.banner.visible ? 1 : 0) + '|bi:' + bn
    + '|brk:' + lite(state.bracket) + '|rpl:' + lite(state.replay) + '|crew:' + (state.crew || []).length;
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

  // Auto-apply saved logos/players when the entrant matches a team in the library;
  // fall back to the start.gg team logo (saved teams take priority — never clobber a custom one).
  [['blue', blueEntrant], ['orange', orangeEntrant]].forEach(([side, ent]) => {
    const tn = (state.teams[side].name || '').toUpperCase();
    const saved = savedTeams.find((t) => (t.name || '').toUpperCase() === tn);
    if (saved) {
      if (saved.logo) state.teams[side].logo = saved.logo;
      if (Array.isArray(saved.players) && saved.players.length) {
        state.teams[side].players = saved.players;
      }
    }
    if (!state.teams[side].logo) {
      const logo = pickEntrantLogo(ent) || logoForTeamName(state.teams[side].name);
      if (logo) state.teams[side].logo = logo;
    }
  });

  const bluePlayers = extractEntrantPlayers(blueEntrant?.name).map((name) => ({
    name,
    primaryid: null,
    team: 0,
    score: 0,
    goals: 0,
    assists: 0,
    saves: 0,
    shots: 0,
    demos: 0,
    boost: 0,
    isPrimary: false,
    isDemolished: false
  }));
  const orangePlayers = extractEntrantPlayers(orangeEntrant?.name).map((name) => ({
    name,
    primaryid: null,
    team: 1,
    score: 0,
    goals: 0,
    assists: 0,
    saves: 0,
    shots: 0,
    demos: 0,
    boost: 0,
    isPrimary: false,
    isDemolished: false
  }));

  const combinedPlayers = [...bluePlayers, ...orangePlayers];
  if (combinedPlayers.length > 0) {
    state.players = combinedPlayers;
    state.playerCache = {};
    combinedPlayers.forEach((p) => {
      state.playerCache[p.name] = { ...p };
    });
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
  const scoreA = slots[0]?.standing?.stats?.score?.value;
  const scoreB = slots[1]?.standing?.stats?.score?.value;
  const st = Number(set.state);
  let status = 'upcoming';
  if (extra?.live || st === 2) status = 'live';
  else if (st === 3) status = 'done';
  return {
    setId: String(set.id || set.setId || ''),
    round: (set.fullRoundText || set.round || '').toString(),
    teamA: (set.teamA || slots[0]?.entrant?.name || 'TBD').toString(),
    teamB: (set.teamB || slots[1]?.entrant?.name || 'TBD').toString(),
    scoreA: typeof scoreA === 'number' && scoreA >= 0 ? scoreA : (typeof set.scoreA === 'number' ? set.scoreA : null),
    scoreB: typeof scoreB === 'number' && scoreB >= 0 ? scoreB : (typeof set.scoreB === 'number' ? set.scoreB : null),
    status,
    stream: (extra?.stream || set.stream || '').toString()
  };
}

// Format the start.gg match feed into ticker scorelines: "LIVE   Team A  2-1  Team B".
function formatTickerFeed(feed) {
  return (feed || []).filter((m) => m && (m.status === 'live' || m.status === 'done')).map((m) => {
    const status = m.status === 'live' ? 'LIVE' : 'FINAL';
    const a = (typeof m.scoreA === 'number') ? m.scoreA : 0;
    const b = (typeof m.scoreB === 'number') ? m.scoreB : 0;
    return status + '   ' + m.teamA + '  ' + a + '-' + b + '  ' + m.teamB;
  });
}
function buildStartggMatchFeed(queue, recentSets, excludeSetId) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || !item.teamA || !item.teamB || item.teamA === 'TBD' || item.teamB === 'TBD') return;
    if (excludeSetId && item.setId === String(excludeSetId)) return;
    const key = item.setId || `${item.teamA}|${item.teamB}|${item.round}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  (queue || []).forEach((q) => push(mapStartggSetToFeedItem(q, { live: q.live, stream: q.stream })));
  (recentSets || []).forEach((s) => {
    if (Number(s.state) === 2 || Number(s.state) === 3) push(mapStartggSetToFeedItem(s));
  });
  const rank = (st) => (st === 'live' ? 0 : st === 'done' ? 1 : 2);
  return items.sort((a, b) => rank(a.status) - rank(b.status)).slice(0, 10);
}

async function fetchRecentEventSets(client, eventSlug) {
  const slug = parseEventSlug(eventSlug);
  if (!slug) return [];
  const query = `
    query RecentSets($slug: String!) {
      event(slug: $slug) {
        sets(perPage: 12, page: 1, sortType: RECENT) {
          nodes {
            id
            fullRoundText
            state
            slots {
              entrant { id name }
              standing { stats { score { value } } }
            }
          }
        }
      }
    }`;
  const res = await client.request(query, { slug });
  return res?.event?.sets?.nodes || [];
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

  const streams = [];
  const queue = [];
  sq.forEach((q) => {
    const streamName = q?.stream?.streamName || 'Stream';
    if (!streams.includes(streamName)) streams.push(streamName);
    // Capture any team logos start.gg returns directly on the queue entrants.
    indexEntrantLogos((q?.sets || []).flatMap((set) => (set.slots || []).map((s) => s?.entrant).filter(Boolean)));
    (q?.sets || []).forEach((set, idx) => {
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
  state.startgg.matchFeed = buildStartggMatchFeed(queue, recentSets, state.startgg.setId);
  if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);
  state.startgg.queueFetchedAt = new Date().toISOString();
  state.startgg.connected = true;
  state.startgg.lastError = null;
  broadcastFullState();
  return { streams, count: queue.length };
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
        console.log(`[Start.gg] Auto-followed live set ${live.setId}: ${live.teamA} vs ${live.teamB}`);
      }
    }
    // Live bracket/score refresh every tick (~20s) so progression + scores update on the bracket
    // (and standings) overlay without re-importing teams each time.
    if ((state.bracket.eventSlug || '').trim()) {
      try { await fetchBracket(state.bracket.eventSlug); } catch (e) { /* non-fatal */ }
    }
  } catch (e) {
    state.startgg.connected = false;
    state.startgg.lastError = e.message;
    broadcastFullState();
  }
}
let _startggBracketTick = 0;

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

// ─── My Events live-refresh ──────────────────────────────────────────────────
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
      players: (e.players || []).map((p) => ({ gamerTag: p.gamerTag })).filter((p) => p.gamerTag)
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

// Turn a flat list of Start.gg sets into a structured, type-aware bracket.
function buildBracket(sets) {
  const list = Array.isArray(sets) ? sets : [];

  // Dominant bracket type across the sets (an event/phase can mix, we pick the
  // most common so the display picks the right layout).
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

  // Live W–L standings (used for round-robin / swiss, computed from results).
  const standingsMap = new Map();
  list.forEach((s) => {
    const slots = s.slots || [];
    const e0 = slots[0] && slots[0].entrant;
    const e1 = slots[1] && slots[1].entrant;
    [e0, e1].forEach((e) => {
      if (e && e.id && !standingsMap.has(e.id)) standingsMap.set(e.id, { name: e.name, wins: 0, losses: 0 });
    });
    if (s.winnerId && e0 && e1) {
      const winId = s.winnerId;
      const win = winId === e0.id ? e0 : (winId === e1.id ? e1 : null);
      const lose = winId === e0.id ? e1 : (winId === e1.id ? e0 : null);
      if (win && standingsMap.has(win.id)) standingsMap.get(win.id).wins++;
      if (lose && standingsMap.has(lose.id)) standingsMap.get(lose.id).losses++;
    }
  });
  const standings = [...standingsMap.values()]
    .sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || a.name.localeCompare(b.name))
    .map((s, i) => ({ placement: i + 1, name: s.name, wins: s.wins, losses: s.losses }));

  if (!isElim) {
    return { type, winners: [], losers: [], finals: [], standings };
  }

  // Elimination: group sets into rounds, split winners / losers / grand finals.
  const isGrandFinal = (s) => /grand\s*final/i.test(s.fullRoundText || '');
  const groupRounds = (filterFn, sortFn) => {
    const m = new Map();
    list.filter(filterFn).forEach((s) => {
      const key = s.fullRoundText || `Round ${s.round}`;
      if (!m.has(key)) m.set(key, { name: key, round: s.round, sets: [] });
      const slots = s.slots || [];
      m.get(key).sets.push({ a: mapSlot(slots[0], s), b: mapSlot(slots[1], s) });
    });
    return [...m.values()].sort(sortFn);
  };

  const winners = groupRounds(
    (s) => s.round > 0 && !isGrandFinal(s),
    (a, b) => a.round - b.round
  );
  const losers = groupRounds(
    (s) => s.round < 0 && !isGrandFinal(s),
    (a, b) => Math.abs(a.round) - Math.abs(b.round)
  );
  const finals = groupRounds(isGrandFinal, (a, b) => a.round - b.round);

  return { type, winners, losers, finals, standings };
}

// Split a flat Start.gg set list into one bracket PHASE per Start.gg phase
// (so a Day-1 double-elim and a Day-2 single-elim/swiss stay separate).
function buildPhases(sets) {
  const groups = new Map();
  (sets || []).forEach((s) => {
    const ph = (s.phaseGroup && s.phaseGroup.phase) || null;
    const id = ph && ph.id != null ? 'p' + ph.id : 'default';
    const name = (ph && ph.name) || 'Bracket';
    if (!groups.has(id)) groups.set(id, { id, name, order: ph && ph.id != null ? Number(ph.id) : 0, sets: [] });
    groups.get(id).sets.push(s);
  });
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map((g) => {
      const b = buildBracket(g.sets);
      return { id: g.id, name: g.name, type: b.type, winners: b.winners, losers: b.losers, finals: b.finals, standings: b.standings, schedule: [], roster: [] };
    });
}

// Copy the active phase's bracket data up to the top-level fields the overlay reads.
function syncActiveBracketPhase() {
  const phases = state.bracket.phases || [];
  if (!phases.length) return;
  let ph = phases.find((x) => x.id === state.bracket.activePhaseId);
  if (!ph) { ph = phases[0]; state.bracket.activePhaseId = ph.id; }
  state.bracket.type = ph.type || '';
  state.bracket.winners = ph.winners || [];
  state.bracket.losers = ph.losers || [];
  state.bracket.finals = ph.finals || [];
  state.bracket.standings = ph.standings || [];
}

// Pull every page of an event's sets (capped so a misconfigured event can't loop).
async function fetchAllSets(client, slug, perPage = 50, maxPages = 16) {
  const query = `
    query BracketSets($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        id
        name
        tournament { name }
        sets(perPage: $perPage, page: $page, sortType: ROUND) {
          pageInfo { totalPages }
          nodes {
            id
            fullRoundText
            round
            state
            winnerId
            phaseGroup { bracketType phase { id name } }
            slots {
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
    const res = await client.request(query, { slug, perPage, page });
    event = res && res.event;
    if (!event) throw new Error('Event not found — check the slug/URL and your token');
    all.push(...((event.sets && event.sets.nodes) || []));
    totalPages = (event.sets && event.sets.pageInfo && event.sets.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= maxPages);
  return { event, sets: all };
}

// Pull every page of an event's entrants (teams + their players).
async function fetchAllEntrants(client, slug, perPage = 50, maxPages = 16) {
  const query = `
    query EventEntrants($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        entrants(query: { perPage: $perPage, page: $page }) {
          pageInfo { totalPages }
          nodes {
            id
            name
            participants { id gamerTag }
            team { images { url type } }
          }
        }
      }
    }
  `;
  let page = 1;
  let totalPages = 1;
  const all = [];
  do {
    const res = await client.request(query, { slug, perPage, page });
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
  const query = `
    query EventSeeding($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        id name images { type url }
        tournament { images { type url } }
        entrants(query: { perPage: $perPage, page: $page }) {
          pageInfo { totalPages }
          nodes { id name initialSeedNum participants { gamerTag user { name } } }
        }
      }
    }`;
  let page = 1, totalPages = 1, evName = '', evImage = '';
  const all = [];
  do {
    const res = await client.request(query, { slug, perPage: 75, page });
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
      players: (n.participants || []).map((p) => ({ gamerTag: p.gamerTag || (p.user && p.user.name) || '' })).filter((p) => p.gamerTag)
    }));
    totalPages = (ev.entrants && ev.entrants.pageInfo && ev.entrants.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= 16);
  all.sort((a, b) => (a.seedNum || 99999) - (b.seedNum || 99999));
  return { eventName: evName, eventSlug: slug, image: evImage, entrants: all };
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
      .map((p) => ({
        id: Math.random().toString(36).slice(2, 11),
        name: (p.gamerTag || '').trim(),
        platform: 'steam',
        platformId: '',
        assignedCamera: null
      }))
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
  const phases = buildPhases(sets);
  // Keep the active phase across a refresh if it still exists; else first phase.
  const keepId = phases.some((p) => p.id === state.bracket.activePhaseId) ? state.bracket.activePhaseId : (phases[0] && phases[0].id) || '';
  state.bracket = {
    ...state.bracket,
    eventSlug: slug,
    title: (event && event.name) || '',
    phases,
    activePhaseId: keepId,
    matches: buildMatches(sets),
    lastFetchAt: new Date().toISOString(),
    lastError: null
  };
  syncActiveBracketPhase();   // mirror active phase → top-level fields the overlay reads
}

// Refresh just the bracket (scores/progression) without re-importing teams.
async function fetchBracket(rawSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token (set it in Settings)');
  const slug = parseEventSlug(rawSlug);
  if (!slug) throw new Error('Missing event slug or URL');

  const client = createStartGgClient(startggApiToken);
  const { event, sets } = await fetchAllSets(client, slug);
  applyBracketResult(slug, event, sets);
  saveAppState();
  broadcastFullState();

  const rounds = state.bracket.winners.length + state.bracket.losers.length + state.bracket.finals.length;
  return { title: event.name || '', type: state.bracket.type, rounds, sets: sets.length };
}

// Merge a list of Start.gg entrants into the saved team library (update by name,
// don't clobber custom logos) and refresh the transient eventTeams list.
function mergeEntrantsIntoLibrary(entrants) {
  let teamsAdded = 0, playersTotal = 0, logosFound = 0;
  (entrants || []).forEach((ent) => {
    const name = (ent.name || '').trim();
    if (!name) return;
    const players = (ent.participants || [])
      .map((p) => ({
        id: Math.random().toString(36).slice(2, 11),
        name: (p.gamerTag || '').trim(),
        platform: 'steam',
        platformId: '',
        assignedCamera: null
      }))
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
  const slug = parseEventSlug(rawSlug);
  if (!slug) throw new Error('Missing event slug or URL');
  const client = createStartGgClient(startggApiToken);
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
  const { event, sets } = await fetchAllSets(client, slug);
  const entrants = await fetchAllEntrants(client, slug);

  applyBracketResult(slug, event, sets);          // bracket → phases
  // Only populate the transient event roster — don't touch savedTeams (user saves manually)
  const eventTeams = mapEntrantsToTeams(entrants);
  state.startgg.eventTeams = eventTeams;
  indexEntrantLogos(entrants);

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
    sets: sets.length
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
  state.startgg.enabled = true;
  state.startgg.selectedEvent = {
    tournamentSlug: tSlug,
    eventSlug: evSlug,
    name: (meta && meta.name) || loaded.title || '',
    tournamentName: (meta && meta.tournamentName) || loaded.tournamentName || ''
  };
  state.startgg.pendingEvents = [];

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
  state.startgg.queueEnabled = true;
  state.startgg.autoFollow = true;
  setStartggQueuePolling(true);

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
}

async function triggerClipCapture(meta) {
  if (!clipSystem) return null;
  const clip = await clipSystem.onHighlightEvent(meta);
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
      nades: wp.nades,
      hasKit: !!st.defusekit,
      hasBomb: wp.hasBomb
    };
  }).sort((a, b) => a.slot - b.slot);
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
      _id: m.id, name: m.name, mode: '', image: m.image || '',
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
  const g = vetoData.hasVeto(game) ? game : (vetoData.hasVeto(state.activeGame) ? state.activeGame : 'csgo');
  const pool = vetoData.mapPool(g);
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
function draftStart({ game, teamStart, title }) {
  const g = draftData.hasDraft(game) ? game : (draftData.hasDraft(state.activeGame) ? state.activeGame : 'league');
  if (!draftData.hasDraft(g)) throw new Error('No draft format defined for ' + g);
  const ts = teamStart === 'b' ? 'b' : 'a';
  const seq = draftData.buildDraft(g).map(s => ({ action: s.action, by: draftData.resolveSide(s.teamIdx, ts) }));
  state.draft = {
    visible: !!(state.draft && state.draft.visible),
    title: typeof title === 'string' ? title : (state.draft && state.draft.title) || '',
    game: g, teamStart: ts, sequence: seq, ops: [], turn: null, complete: false
  };
  rebuildDraftTurn();
}
function draftAction(name) {
  const d = state.draft;
  if (!d || !Array.isArray(d.sequence)) return;
  if (d.ops.length >= d.sequence.length) return;
  const champ = (name || '').toString().slice(0, 40).trim();
  if (!champ) return;
  const step = d.sequence[d.ops.length];
  d.ops.push({ name: champ, action: step.action, by: step.by });
  rebuildDraftTurn();
}
function draftUndo() { const d = state.draft; if (d && d.ops && d.ops.length) { d.ops.pop(); rebuildDraftTurn(); } }
function draftReset() { const d = state.draft; if (d) { d.ops = []; rebuildDraftTurn(); } }

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

const FLOW_TRIGGER_TYPES = [
  // Rocket League
  'rl_goal', 'rl_round_started', 'rl_match_ended', 'rl_overtime', 'rl_replay_start', 'rl_replay_end',
  // CS2
  'cs2_round_start', 'cs2_round_end', 'cs2_bomb_planted', 'cs2_half_time', 'cs2_match_ended',
  // Universal game / production
  'score_reached', 'series_ended', 'game_started',
  // OBS
  'obs_scene_changed', 'obs_stream_started', 'obs_stream_stopped', 'obs_recording_started', 'obs_recording_stopped', 'obs_replay_saved',
  'obs_source_shown', 'obs_source_hidden', 'obs_input_muted', 'obs_input_unmuted', 'obs_media_started', 'obs_media_ended',
  // Twitch
  'twitch_stream_online', 'twitch_stream_offline', 'twitch_raid', 'twitch_sub', 'twitch_bits', 'twitch_follow', 'twitch_channel_points', 'twitch_hype_train', 'twitch_poll_end', 'twitch_ad_break',
  // In-app / Timer
  'timer_countdown_end', 'break_shown', 'break_hidden',
  // Manual
  'manual'
];

function initFlowEngine() {
  FLOW_TRIGGER_TYPES.forEach(type => {
    flowBus.on(type, data => _onFlowTrigger(type, data || {}));
  });
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
    case 'manual':
      return !p.flowId || p.flowId === data.flowId;
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

async function _fireFlow(flow, triggerData) {
  const now = Date.now();
  const cooldown = Number(flow.cooldown) || 0;
  if (cooldown > 0 && _flowLastFired[flow.id] && now - _flowLastFired[flow.id] < cooldown) return;
  _flowLastFired[flow.id] = now;

  for (const action of (flow.actions || [])) {
    try { await _executeFlowAction(action, triggerData); }
    catch (e) { console.error('[Flow]', flow.name, '→', action.type, e.message); }
  }
}

async function _executeFlowAction(action, ctx) {
  const p = action.params || {};
  switch (action.type) {
    case 'wait':
      await new Promise(r => setTimeout(r, Math.max(0, Number(p.ms) || 0)));
      break;
    case 'obs_scene':
      if (obsClient && obsClient.isConnected() && p.scene)
        obsClient.switchScene(p.scene.trim());
      break;
    case 'obs_save_replay':
      if (obsClient && obsClient.isConnected())
        try { await obsClient.call('SaveReplayBuffer'); } catch(e){}
      break;
    case 'overlay_ticker':
      state.ticker = { ...state.ticker, text: p.text || '', visible: true };
      broadcastFullState();
      break;
    case 'overlay_ticker_hide':
      state.ticker = { ...state.ticker, visible: false };
      broadcastFullState();
      break;
    case 'overlay_lower_third': {
      state.ticker = { ...state.ticker, text: p.text || '', visible: true };
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
    case 'overlay_winner':
      state.winner = { ...state.winner, visible: true, side: p.side || 'blue', name: p.name || '' };
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
      if (predictionManager && predictionManager.currentPrediction) try {
        const outcomes = predictionManager.currentPrediction.outcomes || [];
        const idx = Number(p.outcomeIndex) || 0;
        const outcomeId = outcomes[idx] && outcomes[idx].id;
        if (outcomeId) await predictionManager.resolvePrediction(outcomeId);
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
      let body = {};
      try { body = p.body ? JSON.parse(p.body) : {}; } catch(e){}
      try { await axios.post(p.url, body, { timeout: 5000 }); }
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
  }
}

// ─── OBS WebSocket integration ──────────────────────────────────────────────
function setupObsClient() {
  if (!createObsClient || obsClient) return;
  obsClient = createObsClient({
    onStatus: ({ connected, lastError }) => {
      state.obs.connected = connected;
      state.obs.lastError = lastError || null;
      if (!connected) state.obs.currentScene = '';
      broadcastFullState();
    },
    // The OBS program scene = the authoritative "what's on air" signal.
    onSceneChange: (sceneName) => {
      const prev = state.obs.currentScene || '';
      state.obs.currentScene = sceneName || '';
      if (telemetry && (sceneName || '') !== prev) telemetry.sceneChange({ scene: sceneName || '', prevScene: prev, source: 'unknown' });
      flowBus.emit('obs_scene_changed', { scene: sceneName || '' });
      broadcastFullState();
    },
    // Live mirror of the connected OBS profile's scene collection.
    onSceneListChange: (scenes) => {
      state.obs.availableScenes = Array.isArray(scenes) ? scenes : [];
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
      flowBus.emit('obs_replay_saved', { path });
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
    state.obs.availableScenes = await obsClient.getScenes();
    state.obs.lastError = null;
    if (state.clips?.autoCapture) {
      try {
        const active = await obsClient.isReplayBufferActive();
        if (!active) await obsClient.startReplayBuffer();
      } catch (e) { /* replay buffer optional until producer enables it in OBS */ }
    }
    broadcastFullState();
    return true;
  } catch (e) {
    console.warn('[OBS] Connect failed:', e && e.message ? e.message : e);
    return false;
  }
}

async function disconnectObs() {
  if (!obsClient) return;
  try { await obsClient.disconnect(); } catch (e) { /* ignore */ }
  state.obs.connected = false;
  state.obs.availableScenes = [];
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
// auto-switch, where the producer explicitly picked the destination scene — so it bypasses
// the scene-mapping in obsSwitch() but still respects the OBS connection/enabled state.
function obsSwitchSceneName(name) {
  if (OBS_AUTO_SWITCH_DISABLED || aiShielded()) return;
  if (!obsClient || !state.obs.enabled) return;
  if (!obsClient.isConnected()) return;
  const sceneName = (name || '').trim();
  if (!sceneName) return;
  console.log(`[OBS] Countdown auto-switch → ${sceneName}`);
  obsClient.switchScene(sceneName);
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
const OT_BALL_GROUND_Z = 140;    // ball radius ≈ 93uu; z ≤ 140 ≈ on / about to touch the floor
const OT_SETTLE_MS     = 1000;   // if ball height isn't exposed, wait this long past 0:00 (lets a buzzer-beater untie)
let otSettleTimer = null;
function resetOvertimeTrigger() {
  state.otTriggered = false;
  if (otSettleTimer) { clearTimeout(otSettleTimer); otSettleTimer = null; }
}
function fireOvertime() {
  if (state.otTriggered) return;
  state.otTriggered = true;
  state.game.isOT = true;
  flowBus.emit('rl_overtime', {});
  if (otSettleTimer) { clearTimeout(otSettleTimer); otSettleTimer = null; }
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
  if (!state.awaitingKickoff) return;
  flowBus.emit('rl_round_started', {});
  state.awaitingKickoff = false;
  state.scoreboard = null;          // new game kicking off → drop the frozen post-game scoreboard
  const wasBoard = (state.view === 'scoreboard');
  state.view = 'hud';
  state.inReplay = false;
  broadcastFullState();
  // the post-game scoreboard was HELD through the wait, so the HUD wasn't reset at match-created —
  // reset it now, at the kickoff, for the new game.
  if (wasBoard) broadcast(bridgeClients, { type: 'game_reset', data: { gameNumber: state.game.number } });
  // Smart Trigger: at the kickoff countdown, cut to the producer-chosen scene if set; otherwise the
  // mapped In-Game scene. (Both respect the master autoSwitch + OBS connection state.)
  const kt = state.obs.kickoff;
  if (kt && kt.enabled && kt.scene && state.obs.autoSwitch) obsSwitchSceneName(kt.scene);
  else obsSwitch('inGame');   // the RL overlay scene comes up at kickoff, not during "choose teams"
}
// Kickoff fallback for stats APIs that don't emit clock_started / countdown events: when we're
// awaiting kickoff and the MATCH clock is running DOWN near 5:00 (>= 150s — so the separate ~60s
// "choose teams" timer can never trigger it), the game has begun → return to the in-game overlay.
// Called from BOTH handleClock and handleUpdateState, since some APIs send the clock via UpdateState
// (game.SecondsRemaining) rather than ClockUpdatedSeconds.
function maybeReturnForKickoff(prevTime) {
  if (!state.awaitingKickoff) return;
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
  if (!regOver || !tied) {                             // outside the OT-pending window → drop any pending settle
    if (otSettleTimer) { clearTimeout(otSettleTimer); otSettleTimer = null; }
    return;
  }
  // ball on the ground (when its height is exposed) → OT has just been triggered, fire now
  const z = state.rlBall && typeof state.rlBall.z === 'number' ? state.rlBall.z : null;
  if (z !== null && z <= OT_BALL_GROUND_Z) { fireOvertime(); return; }
  // otherwise wait a short beat so a goal off the last airborne touch can untie the score first
  if (!otSettleTimer) {
    otSettleTimer = setTimeout(() => {
      otSettleTimer = null;
      const stillTied = (state.game.blueScore ?? 0) === (state.game.orangeScore ?? 0);
      if (stillTied && (state.game.time ?? 999) <= 0 && state.view !== 'scoreboard') fireOvertime();
    }, OT_SETTLE_MS);
  }
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

function handleUpdateState(data) {
  const game = data.Game || data.game || {};
  const players = data.Players || data.players || [];
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
      if ((t.TeamNum === 0 || t.teamNum === 0)) {
        state.game.blueScore   = t.Score ?? t.score ?? 0;
        state.gameTeams.blue   = t.Name || t.name || 'BLUE';
      }
      if ((t.TeamNum === 1 || t.teamNum === 1)) {
        state.game.orangeScore = t.Score ?? t.score ?? 0;
        state.gameTeams.orange = t.Name || t.name || 'ORANGE';
      }
    });
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
  if (state.activeGame === 'rocket-league' && normalised.length >= 2) {
    scheduleRlHideNativeUi(state.game.number);
  }

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
  if (state.view !== 'goal' && !state.inReplay) return;

  state.view = 'hud';
  state.inReplay = false;
  state.currentGoal = null;
  broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } });
  obsSwitch('inGame');
}

let _postGameTimer = null;
function handleMatchEnded(data) {
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
            console.log('[AutoPred] Score-resolved — winner:', winnerName);
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
          .catch(e => console.warn('[AutoPred] Score-resolve failed:', e.message));
      } else {
        console.warn('[AutoPred] No outcome matched winner:', winnerName, '— outcomes:', current.outcomes?.map(o => o.title));
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

  setTimeout(() => {
    // Freeze playerCache as final scoreboard data
    state.view = 'scoreboard';
    // Snapshot the final scoreboard so it survives the next match_created (which clears the live cache)
    // and so the overlay can re-render it from a full_state on reload/reconnect (not just the view_change).
    state.scoreboard = {
      players: Object.values(state.playerCache || {}).map(p => ({ ...p })),
      blueScore: state.game.blueScore ?? 0,
      orangeScore: state.game.orangeScore ?? 0,
      series: { ...state.series }
    };
    broadcast(bridgeClients, {
      type: 'view_change',
      data: {
        view: 'scoreboard',
        series: state.series,
        playerCache: state.playerCache
      }
    });
    obsSwitch('postGame');

    // The post-game scoreboard HOLDS on screen until the NEXT game's kickoff (clock starts /
    // countdown begins → returnToInGameForKickoff). No timed auto-switch to the caster desk, so it
    // can't be pulled off early. Cancel any stray timer from a previous cycle.
    if (_postGameTimer) { clearTimeout(_postGameTimer); _postGameTimer = null; }
  }, 3000);
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
  // New game starts — cancel any pending post-game auto-switch, reset game data, keep series
  if (_postGameTimer) { clearTimeout(_postGameTimer); _postGameTimer = null; }
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
  if (state.twitch.connected && predictionManager && state.twitch.predictions.settings.autoCreate) {
    const blueTeam   = state.teams.blue.name   || 'Blue';
    const orangeTeam = state.teams.orange.name || 'Orange';
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
          console.log('[AutoPred] Created:', result.id);
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
        .catch(e => console.warn('[AutoPred] Create failed:', e.message));
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
  scheduleRlHideNativeUi(state.game.number);

  // Stats: lazy-create a match record the first time a game starts in a series
  if (!statsCurrentMatchId) {
    statsCurrentMatchId = stats.startMatch({
      gameType: 'rl',
      teamA: state.teams.blue.name,
      teamB: state.teams.orange.name,
      logoA: state.teams.blue.logo,
      logoB: state.teams.orange.logo,
      bestOf: state.bestOf,
      startggSetId: state.startgg?.setId || null,
      tournament: state.startgg?.selectedEvent?.tournamentName || null
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
  bridgeWss = new WebSocket.Server({ port: WS_PORT });

  bridgeWss.on('connection', (ws) => {
    bridgeClients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Send full state immediately on connect
    ws.send(JSON.stringify(getFullState()));
    if (_lastUpdateStatus) { try { ws.send(JSON.stringify({ type: 'update_status', data: _lastUpdateStatus })); } catch (e) {} }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleControlMessage(msg, ws);
      } catch (e) { /* ignore */ }
    });

    ws.on('close', () => bridgeClients.delete(ws));
    ws.on('error', () => bridgeClients.delete(ws));
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

function handleControlMessage(msg, ws) {
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

    // Custom "GAME x | BEST OF x" label override (e.g. "UPCOMING MATCH" or any custom text).
    // Empty string restores the automatic GAME/BEST-OF text.
    case 'set_game_label':
      state.gameLabel = (typeof msg.data.text === 'string') ? msg.data.text : '';
      saveAppState();
      broadcastFullState();
      break;

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
        colorMode: (o.colorMode === 'mono' || o.colorMode === 'team') ? o.colorMode : (cur.colorMode || 'team')
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

    // ── Post-match WINNER screen ─────────────────────────────────────────
    case 'set_winner': {
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
      break;
    }

    // ── Map veto / map-pool overview board ───────────────────────────────
    case 'set_veto': {
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
      break;
    }

    // ── Guided multi-game map veto ───────────────────────────────────────
    case 'veto_start': {
      try {
        const d = msg.data || {};
        vetoStart({ game: d.game, bestOf: d.bestOf, teamStart: d.teamStart, title: d.title });
        if (typeof d.visible === 'boolean') state.veto.visible = d.visible;
        saveAppState(); broadcastFullState();
      } catch (e) {
        ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: false, message: e.message } }));
      }
      break;
    }
    case 'veto_action': {     // apply the current ban/pick step to a map
      vetoApply((msg.data && msg.data.mapId) || '');
      saveAppState(); broadcastFullState();
      break;
    }
    case 'veto_undo':   { vetoUndo();  saveAppState(); broadcastFullState(); break; }
    case 'veto_reset':  { vetoReset(); saveAppState(); broadcastFullState(); break; }
    case 'veto_result': {     // record a played-map score/winner
      const d = msg.data || {};
      vetoResult(d.mapId, d.winner, d.score);
      saveAppState(); broadcastFullState();
      break;
    }
    case 'veto_visible': {
      if (state.veto) state.veto.visible = !!(msg.data && msg.data.visible);
      saveAppState(); broadcastFullState();
      break;
    }

    // ── Overwatch 2 series scoreboard ────────────────────────────────────
    case 'ow_set_match': {
      const d = msg.data || {};
      const cur = state.owMatch || {};
      state.owMatch = {
        visible: typeof d.visible === 'boolean' ? d.visible : !!cur.visible,
        format: ['FT2','FT3','FT4'].includes(d.format) ? d.format : (cur.format || 'FT3'),
        currentMapIdx: typeof d.currentMapIdx === 'number' ? d.currentMapIdx : (cur.currentMapIdx || 0),
        bansByMap: Array.isArray(d.bansByMap) ? d.bansByMap : (cur.bansByMap || [])
      };
      saveAppState(); broadcastFullState();
      break;
    }
    case 'ow_visible': {
      if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
      state.owMatch.visible = !!(msg.data && msg.data.visible);
      saveAppState(); broadcastFullState();
      break;
    }
    case 'ow_set_game_mode': {
      const VALID_MODES = ['escort','hybrid','control','push','flashpoint','clash'];
      const mode = msg.data && msg.data.mode;
      if (VALID_MODES.includes(mode)) {
        if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
        state.owMatch.gameMode = mode;
        saveAppState(); broadcastFullState();
      }
      break;
    }
    case 'ow_set_map_labels': {
      if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
      state.owMatch.showMapLabels = !!(msg.data && msg.data.show);
      saveAppState(); broadcastFullState();
      break;
    }
    case 'ow_set_map_mode': {
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
      break;
    }
    case 'ow_set_map_winner': {
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
      break;
    }
    case 'ow_ban_hero': {
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
      break;
    }
    case 'ow_set_map': {
      const d = msg.data || {};
      if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [], attackSide: null };
      if (typeof d.currentMapIdx === 'number') state.owMatch.currentMapIdx = d.currentMapIdx;
      if (['FT2','FT3','FT4'].includes(d.format)) state.owMatch.format = d.format;
      saveAppState(); broadcastFullState();
      break;
    }
    case 'ow_set_attack': {
      if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [], attackSide: null, showAttack: false };
      const side = (msg.data && msg.data.side) || null;
      state.owMatch.attackSide = ['a','b'].includes(side) ? side : null;
      saveAppState(); broadcastFullState();
      break;
    }
    case 'ow_show_attack': {
      if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [], attackSide: null, showAttack: false };
      state.owMatch.showAttack = !!(msg.data && msg.data.visible);
      saveAppState(); broadcastFullState();
      break;
    }

    // ── Marvel Rivals series scoreboard ──────────────────────────────────
    case 'mr_set_match': {
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
      break;
    }
    case 'mr_visible': {
      if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
      state.mrMatch.visible = !!(msg.data && msg.data.visible);
      saveAppState(); broadcastFullState();
      break;
    }
    case 'mr_set_game_mode': {
      const MR_VALID_MODES = ['convergence','domination','convoy'];
      const mrMode = msg.data && msg.data.mode;
      if (MR_VALID_MODES.includes(mrMode)) {
        if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
        state.mrMatch.gameMode = mrMode;
        saveAppState(); broadcastFullState();
      }
      break;
    }
    case 'mr_set_map_labels': {
      if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
      state.mrMatch.showMapLabels = !!(msg.data && msg.data.show);
      saveAppState(); broadcastFullState();
      break;
    }
    case 'mr_set_map_mode': {
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
      break;
    }
    case 'mr_set_map_winner': {
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
      break;
    }
    case 'mr_ban_hero': {
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
      break;
    }

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

    // ── Champion/hero draft ──────────────────────────────────────────────
    case 'draft_start': {
      try {
        const d = msg.data || {};
        draftStart({ game: d.game, teamStart: d.teamStart, title: d.title });
        if (typeof d.visible === 'boolean') state.draft.visible = d.visible;
        saveAppState(); broadcastFullState();
      } catch (e) {
        ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: false, message: e.message } }));
      }
      break;
    }
    case 'draft_action':  { draftAction((msg.data && msg.data.name) || ''); saveAppState(); broadcastFullState(); break; }
    case 'draft_undo':    { draftUndo();  saveAppState(); broadcastFullState(); break; }
    case 'draft_reset':   { draftReset(); saveAppState(); broadcastFullState(); break; }
    case 'draft_visible': { if (state.draft) state.draft.visible = !!(msg.data && msg.data.visible); saveAppState(); broadcastFullState(); break; }

    // ── Team-lineup / player-intro card scene ────────────────────────────
    case 'set_intro': {
      const i = msg.data || {};
      const cur = state.intro || {};
      state.intro = {
        visible: ('visible' in i) ? !!i.visible : !!cur.visible,
        side: (i.side === 'orange' || i.side === 'blue') ? i.side : (cur.side ?? 'blue'),
        title: typeof i.title === 'string' ? i.title : (cur.title ?? ''),
        style: [1, 2].includes(Number(i.style)) ? Number(i.style) : (cur.style ?? 1)
      };
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'set_font_family':
      state.fontFamily = msg.data.fontFamily || 'Bourgeois';
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
        social: VALID_SOCIAL.has(social) ? social : 'none',
        ...(typeof d.camSlot  === 'string' ? { camSlot:  d.camSlot.slice(0, 40) } : {}),
        ...(typeof d.country  === 'string' ? { country:  d.country.slice(0, 60) } : {}),
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
        if (typeof d.camSlot === 'string') cur.camSlot = d.camSlot.slice(0, 40);
        if (typeof d.country === 'string') cur.country = d.country.slice(0, 60);
        if (typeof d.notes   === 'string') cur.notes   = d.notes.slice(0, 500);
        if (typeof d.social  === 'string') cur.social  = entry.social;
        if (['host', 'caster', 'observer'].includes(d.kind)) cur.kind = d.kind;
        if (typeof d.slot !== 'undefined') cur.slot = (libSlot >= 1 && libSlot <= 4) ? libSlot : 0;
      } else {
        state.casters.library.push(entry);
      }
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'delete_caster_from_library': {
      if (Array.isArray(state.casters.library)) {
        state.casters.library = state.casters.library.filter((c) => c.id !== msg.data?.id);
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
      state.crew.push({ id, name: d.name, handle: d.handle || '', role: d.role || '', group: d.group || 'casters', social: d.social || 'none', socialHandle: d.socialHandle || '', defaultCam: d.defaultCam || '', country: d.country || '', paypal: d.paypal || '', notes: d.notes || '' });
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
        state.crew[idx] = { ...cur, name: d.name || cur.name, handle: d.handle ?? cur.handle, role: d.role ?? cur.role, group: d.group || cur.group, social: d.social || cur.social, socialHandle: d.socialHandle ?? cur.socialHandle, defaultCam: d.defaultCam ?? cur.defaultCam ?? '', country: d.country ?? cur.country ?? '', paypal: d.paypal ?? cur.paypal ?? '', notes: d.notes ?? cur.notes ?? '' };
        saveAppState();
        broadcastFullState();
      }
      break;
    }
    case 'delete_crew_member': {
      if (Array.isArray(state.crew)) {
        state.crew = state.crew.filter((c) => c.id !== msg.data?.id);
        saveAppState();
        broadcastFullState();
      }
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
        // Stop data connections for the previous game
        if (prev === 'rocket-league' && g !== 'rocket-league') disconnectRL();
        if (prev === 'valorant' && g !== 'valorant') stopValorantPolling();
        // Start data connections for the new game
        if (g === 'rocket-league' && prev !== 'rocket-league') connectToRL();
        if (g === 'valorant') startValorantPolling();
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
      // If this is the live brand, push its sponsor placements into the ad slots now.
      if (entry.id === state.activeBrandKitId) applyBrandSlots();
      broadcastFullState();
      break;
    }

    case 'activate_brand_kit': {
      const id = msg.data?.id || null;
      state.activeBrandKitId = id;
      const kit = savedBrandKits.find((b) => b.id === id);
      if (kit) ensureKitPackages(kit);
      // Automation: snap this game's theme to the kit's preferred design, if set.
      if (kit && kit.themes && isValidTheme(state.activeGame, kit.themes[state.activeGame])) {
        state.themesByGame[state.activeGame] = kit.themes[state.activeGame];
      }
      applyBrandSlots();           // fill the ad slots from this brand's sponsor placements
      saveAppState();
      broadcastFullState();        // brand colours apply automatically when colorMode === 'brand'
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
          if (kit.id === state.activeBrandKitId) applyBrandSlots();
          broadcastFullState();
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

    // Colour mode: which source the overlays use for the two sides. Non-destructive —
    // team/brand/default each keep their own colours; this only picks the active one.
    case 'set_color_mode': {
      const m = msg.data?.mode;
      if (m === 'team' || m === 'brand' || m === 'default') {
        state.colorMode = m;
        state.useBrandColors = (m === 'brand');   // keep the legacy flag in sync
        saveAppState();
        broadcastFullState();
      }
      break;
    }

    // Legacy: old clients sent a brand-colours on/off toggle → map it onto colorMode.
    case 'set_use_brand_colors': {
      const on = !!msg.data?.enabled;
      state.colorMode = on ? 'brand' : 'team';
      state.useBrandColors = on;
      saveAppState();
      broadcastFullState();
      break;
    }

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

    // ── Sponsor / announcement ticker ────────────────────────────────────
    case 'set_ticker': {
      const p = msg.data || {};
      if (typeof p.visible === 'boolean') state.ticker.visible = p.visible;
      if (typeof p.source === 'string') state.ticker.source = (p.source === 'startgg') ? 'startgg' : 'manual';
      if (Array.isArray(p.messages)) {
        state.ticker.messages = p.messages
          .map((m) => (m || '').toString().trim())
          .filter(Boolean)
          .slice(0, 30);
      }
      if (Number(p.speed) > 0) state.ticker.speed = Math.min(300, Math.max(5, Number(p.speed)));
      if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);   // build now; refreshes each poll
      saveAppState();
      broadcastFullState();
      break;
    }

    // ── Break / "Starting Soon" countdown scene ──────────────────────────
    case 'show_break': {
      const minutes = Number(msg.data?.durationMinutes);
      state.breakScreen.visible = true;
      if (typeof msg.data?.title === 'string') state.breakScreen.title = msg.data.title.slice(0, 60);
      if (typeof msg.data?.message === 'string') state.breakScreen.message = msg.data.message.slice(0, 120);
      state.breakScreen.endsAt = (minutes > 0)
        ? Date.now() + Math.round(minutes * 60 * 1000)
        : null;
      saveAppState();
      broadcastFullState();
      obsSwitch('break');
      break;
    }

    case 'update_break': {
      if (typeof msg.data?.title === 'string') state.breakScreen.title = msg.data.title.slice(0, 60);
      if (typeof msg.data?.message === 'string') state.breakScreen.message = msg.data.message.slice(0, 120);
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'hide_break':
      state.breakScreen.visible = false;
      state.breakScreen.endsAt = null;
      clearBreakAutoSwitch();
      saveAppState();
      broadcastFullState();
      obsSwitch('inGame');
      break;

    // ── Playout playlists (commercials / intros / outros) ────────────────────
    // Sequences of clip refs and/or media-file paths pushed live through the replay program bus.
    case 'save_playout': {
      const d = msg.data || {};
      const VALID_KIND = new Set(['commercial', 'intro', 'outro', 'general']);
      const items = Array.isArray(d.items) ? d.items.slice(0, 100).map((it) => {
        if (it && it.type === 'clip' && it.id) return { type: 'clip', id: String(it.id).slice(0, 64), name: (it.name || '').toString().slice(0, 120) };
        if (it && it.type === 'file' && it.path) return { type: 'file', path: String(it.path).slice(0, 1000), name: (it.name || '').toString().slice(0, 120), duration: Math.max(1, Math.min(3600, Math.round(Number(it.duration)) || 15)) };
        return null;
      }).filter(Boolean) : [];
      const id = (d.id || '').toString() || ('po_' + Math.random().toString(36).slice(2, 10));
      const entry = {
        id,
        name: (d.name || 'Playlist').toString().slice(0, 80),
        kind: VALID_KIND.has(d.kind) ? d.kind : 'general',
        loop: !!d.loop,
        programScene: (d.programScene || '').toString().slice(0, 120),   // OBS scene to play on
        returnScene: (d.returnScene || '').toString().slice(0, 120),     // OBS scene to finish to
        items
      };
      if (!Array.isArray(state.playouts)) state.playouts = [];
      const idx = state.playouts.findIndex((p) => p.id === id);
      if (idx >= 0) state.playouts[idx] = entry; else state.playouts.push(entry);
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'delete_playout': {
      if (Array.isArray(state.playouts)) {
        state.playouts = state.playouts.filter((p) => p.id !== msg.data?.id);
        saveAppState();
        broadcastFullState();
      }
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
        state.startgg.lastError = 'No match on the stream queue yet — load the queue first (Settings → start.gg).';
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

    case 'set_series':
      if (typeof msg.data.blue === 'number') state.series.blue   = Math.max(0, msg.data.blue);
      if (typeof msg.data.orange === 'number') state.series.orange = Math.max(0, msg.data.orange);
      saveAppState();
      broadcastFullState();
      break;

    // Leagues are control-panel-authoritative: the editor pushes the whole list.
    case 'set_leagues': {
      if (Array.isArray(msg.data && msg.data.leagues)) state.leagues = msg.data.leagues;
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
          saveAppState();
          broadcastFullState();
          ws.send(JSON.stringify({ type: 'event-result', data: { ok: true, leagueId: league.id, message: `Created league "${league.name}" with ${teams.length} team(s) from start.gg.` } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'event-result', data: { ok: false, message: e.message } }));
        }
      })();
      break;
    }

    // ── MY EVENTS — add/remove a start.gg event to the app's saved list ──────
    case 'add_my_event': {
      const d = msg.data || {};
      const eventSlug = (d.eventSlug || '').toString().trim();
      if (!eventSlug) break;
      if (!Array.isArray(state.myEvents)) state.myEvents = [];
      if (state.myEvents.some((e) => e.eventSlug === eventSlug)) { ws.send(JSON.stringify({ type: 'event-result', data: { ok: true, message: 'Already in MY EVENTS.' } })); break; }
      state.myEvents.unshift({
        id: 'ev' + Math.random().toString(36).slice(2, 10),
        tournamentSlug: (d.tournamentSlug || eventSlug.replace(/\/event\/.*$/, '')).toString(),
        eventSlug,
        name: (d.name || '').toString().slice(0, 160),
        tournamentName: (d.tournamentName || '').toString().slice(0, 160),
        game: (d.game || '').toString().slice(0, 80),
        numEntrants: Number(d.numEntrants) || 0,
        startAt: d.startAt || null,
        image: (d.image || '').toString().slice(0, 600),
        addedAt: Date.now(),
        seeding: null
      });
      saveAppState();
      broadcastFullState();
      ws.send(JSON.stringify({ type: 'event-result', data: { ok: true, message: `Added "${d.name || 'event'}" to MY EVENTS.` } }));
      // Pull its roster (teams + players + seeds) right away so seeding has data immediately.
      { const added = state.myEvents.find((e) => e.eventSlug === eventSlug); if (added) refreshMyEvent(added).then((ok) => { if (ok) { saveAppState(); broadcastFullState(); } }).catch(() => {}); }
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
            players: Array.isArray(x.players) ? x.players.slice(0, 12).map((p) => ({ gamerTag: (p.gamerTag || '').toString().slice(0, 80), rank: (p.rank || '').toString().slice(0, 40) })) : []
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
      // Stats: close out the series before wiping scores
      if (statsCurrentMatchId) {
        stats.endMatch(statsCurrentMatchId, {
          scoreA: state.series.blue,
          scoreB: state.series.orange,
          winner: state.series.blue > state.series.orange ? 'a'
                : state.series.orange > state.series.blue ? 'b' : null
        });
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
      saveAppState();
      broadcastFullState();
      break;

    case 'force_scoreboard':
      state.view = 'scoreboard';
      broadcast(bridgeClients, { type: 'view_change', data: { view: 'scoreboard', playerCache: state.playerCache } });
      break;

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
      let idx = -1;
      if (oldName) idx = savedTeams.findIndex(t => t.name === oldName);
      if (idx === -1) idx = savedTeams.findIndex(t => t.name === name);

      if (idx >= 0) {
        const prev = savedTeams[idx] || {};
        savedTeams[idx] = {
          ...prev,
          name,
          logo: logo !== undefined ? logo : prev.logo,
          color: color !== undefined ? color : prev.color,
          // Preserve the existing roster unless an explicit players array was sent.
          players: players !== null ? players : (prev.players || [])
        };
      } else {
        savedTeams.push({ name, logo: logo || null, color: color || null, players: players || [] });
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
            platform: p.platform || '',
            platformId: p.platformId || '',
            camSlot: p.camSlot || p.assignedCamera || '',
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

        // Also save to savedTeams if the team exists there
        const teamName = state.teams[side].name;
        const savedTeam = savedTeams.find(t => t.name === teamName);
        if (savedTeam) {
          if (!savedTeam.players) savedTeam.players = [];
          savedTeam.players.push(newPlayer);
          saveTeams();
        }

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

          // Also update in savedTeams
          const teamName = state.teams[side].name;
          const savedTeam = savedTeams.find(t => t.name === teamName);
          if (savedTeam && savedTeam.players) {
            const savedPlayer = savedTeam.players.find(p => p.id === playerId);
            if (savedPlayer) Object.assign(savedPlayer, playerData);
            saveTeams();
          }

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

        // Also remove from savedTeams
        const teamName = state.teams[side].name;
        const savedTeam = savedTeams.find(t => t.name === teamName);
        if (savedTeam && savedTeam.players) {
          savedTeam.players = savedTeam.players.filter(p => p.id !== playerId);
          saveTeams();
        }

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
    case 'assign_talent_cam': {
      const { side, playerId, teamName, slot } = msg.data || {};
      const slotNum = Number(slot);
      if (slotNum < 1 || slotNum > 4) break;
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
    
    case 'import_data': {
      (async () => {
        const { path } = msg.data || {};
        if (!path) return;
        try {
          const zipBuffer = await fsp.readFile(path);
          const zip = new AdmZip(zipBuffer);;
          const facecamsEntry  = zip.getEntry("facecams.json");
          const teamsEntry = zip.getEntry("teams.json");

          if (!facecamsEntry || !teamsEntry) {
            sendImportExportResult(ws, false, 'Zip file is missing required files.');
            return;
          }
          const facecams = JSON.parse(facecamsEntry.getData().toString("utf8"));
          const teams = JSON.parse(teamsEntry.getData().toString("utf8"));

          if (Array.isArray(facecams)) {
            savedFacecams = mergeAtTop(
              savedFacecams,
              facecams,
              (a, b) => a.platform === b.platform && a.platformId === b.platformId
            );
            await saveFacecams();
          } else {
            sendImportExportResult(ws, false, 'facecams.json is not valid.');
          }
          if (Array.isArray(teams)) {
            savedTeams = mergeAtTop(
              savedTeams,
              teams,
              (a, b) => a.name === b.name && a.logo === b.logo
            );
            await saveTeams();
          } else {
            sendImportExportResult(ws, false, 'teams.json is not valid.');
          }

          sendImportExportResult(ws, true, 'Data imported successfully.');
          broadcastFullState();
        } catch (err) {
          
          sendImportExportResult(ws, false, 'Error importing data: ' + err.message);
        }
      })();
      break;
    }

    case 'export_data': {
      const zip = new AdmZip();
      zip.addLocalFile(teamsFile);
      zip.addLocalFile(facecamsFile);

      dialog.showSaveDialog({
        title: 'Export Data',
        defaultPath: 'NE-Broadcast-Suite-Settings.zip',
        filters: [
          { name: 'Zip Files', extensions: ['zip'] }
        ]
      }).then(({ canceled, filePath }) => {
        if (canceled || !filePath) {
          sendImportExportResult(ws, false, 'Export cancelled.');
          return;
        }

        zip.writeZip(filePath);
        sendImportExportResult(ws, true, 'Data exported successfully.');
      });
      break;
    }

    // ── Producer profile (portable .json — teams/brands/facecams/presets/leagues/casters/settings) ──
    case 'export_profile': {
      const profile = buildProfileBundle();
      dialog.showSaveDialog({
        title: 'Export Producer Profile',
        defaultPath: 'NE-Broadcast-Profile.json',
        filters: [{ name: 'NE Broadcast Profile', extensions: ['json'] }]
      }).then(({ canceled, filePath }) => {
        if (canceled || !filePath) { sendImportExportResult(ws, false, 'Export cancelled.'); return; }
        try { fs.writeFileSync(filePath, JSON.stringify(profile, null, 2)); sendImportExportResult(ws, true, 'Profile exported — safe to share (no passwords or tokens included).'); }
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
              filters: [{ name: 'NE Broadcast Profile', extensions: ['json'] }],
              properties: ['openFile']
            });
            if (r.canceled || !r.filePaths || !r.filePaths[0]) { sendImportExportResult(ws, false, 'Import cancelled.'); return; }
            filePath = r.filePaths[0];
          }
          const raw = await fsp.readFile(filePath, 'utf8');
          const summary = applyProfileBundle(JSON.parse(raw), msg.data && msg.data.options);
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

    case 'request_state':
      ws.send(JSON.stringify(getFullState()));
      break;
    
    case 'swap_teams': {
      // Swap names/logos
      const tempTeams = { ...state.teams.blue };
      state.teams.blue = { ...state.teams.orange };
      state.teams.orange = tempTeams;
      
      // Swap series scores
      const tempSeries = state.series.blue;
      state.series.blue = state.series.orange;
      state.series.orange = tempSeries;

      saveAppState();
      broadcastFullState();
      break;
    }

    case 'reset_all': {
      state.eventName = '';
      state.fontFamily = 'Bourgeois';
      state.banner = { visible: false, images: [], captions: [], interval: 10, slant: 'right', header: '' };
      state.casters = { visible: true, list: [], lowerThird: '', library: [], vdo: { room: '', password: '' }, rooms: [], lineup: [], activeLayout: '' };
      state.breakScreen = { visible: false, title: 'STARTING SOON', message: '', endsAt: null };
      state.ticker = { visible: false, messages: [], speed: 40 };
      state.spotlight = { visible: false, playerName: '' };
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

    case 'startgg_push_set': {
      (async () => {
        try {
          const setId = (msg.data?.setId || '').trim();
          if (!setId) throw new Error('No set selected');
          const result = await syncStartGgSet(setId);
          state.startgg.lastPushedSetId = setId;
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
      if (state.startgg.autoFollow && !state.startgg.queueEnabled && startggApiToken && state.startgg.tournamentSlug) {
        setStartggQueuePolling(true);
      }
      ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: true, message: state.startgg.autoFollow ? 'Auto-follow ON — pushing the live set automatically.' : 'Auto-follow off.' } }));
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
      if (payload.kickoff && typeof payload.kickoff === 'object') {
        state.obs.kickoff = {
          enabled: !!payload.kickoff.enabled,
          scene: typeof payload.kickoff.scene === 'string' ? payload.kickoff.scene.trim() : ''
        };
      }
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
        const scenes = await obsClient.getScenes();
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
      if (obsClient && obsClient.isConnected() && sceneName) {
        obsClient.switchScene(sceneName);
      }
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
      const bus = p.bus === 'preview' ? 'preview' : 'program';
      const url = typeof p.url === 'string' ? p.url.trim() : '';
      if (!url) {
        ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: 'No replay URL to play.' } }));
        break;
      }
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
      break;
    }

    case 'replay_stop': {
      const bus = (msg.data && msg.data.bus) === 'preview' ? 'preview' : 'program';
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

    // ── Upcoming matches overlay ──────────────────────────────────────────
    case 'set_upcoming': {
      const p = msg.data || {};
      if (typeof p.visible === 'boolean') state.upcoming.visible = p.visible;
      if (typeof p.title === 'string') state.upcoming.title = p.title;
      if (Array.isArray(p.matches)) state.upcoming.matches = p.matches;
      saveAppState();
      broadcastFullState();
      break;
    }

    // ── Standings overlay ─────────────────────────────────────────────────
    case 'set_standings': {
      const p = msg.data || {};
      if (typeof p.visible === 'boolean') state.standings.visible = p.visible;
      if (typeof p.title === 'string') state.standings.title = p.title;
      if (Array.isArray(p.rows)) state.standings.rows = p.rows;
      saveAppState();
      broadcastFullState();
      break;
    }

    // ── Teams to Watch (spotlight) overlay ────────────────────────────────
    case 'set_watchlist': {
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
      break;
    }
    // Mark / unmark one team (the ★ on event team cards) — toggles by name, preserving values.
    case 'toggle_watchlist_team': {
      const t = (msg.data && msg.data.team) || {};
      const name = (t.name || '').toString().trim();
      if (!name) break;
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
      break;
    }
    // Single-team spotlight — target a team + (optionally) go live; start.gg data fetched async.
    case 'set_team_spotlight': {
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
      break;
    }

    // ── Bracket ──────────────────────────────────────────────────────────
    case 'set_bracket_settings': {
      const p = msg.data || {};
      if (typeof p.eventSlug === 'string') state.bracket.eventSlug = p.eventSlug.trim();
      if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
      // Overlay view mode — drives the single bracket source + the live preview.
      if (typeof p.view === 'string' && ['both', 'winners', 'losers', 'finals'].includes(p.view)) state.bracket.view = p.view;
      if (p.rounds != null) { const n = parseInt(p.rounds, 10); if (Number.isFinite(n) && n >= 1 && n <= 20) state.bracket.rounds = n; }
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
      saveAppState();
      broadcastFullState();
      break;
    }

    case 'delete_flow': {
      const id = msg.data && msg.data.id;
      if (!id) break;
      if (_flowSeqState[id]) { clearTimeout(_flowSeqState[id].timeoutHandle); delete _flowSeqState[id]; }
      state.flows = state.flows.filter(f => f.id !== id);
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
      syncActiveBracketPhase();
      if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
      saveAppState();
      broadcastFullState();
      if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
      break;
    }

    // Legacy single-bracket path — wrap the payload into a one-phase model.
    case 'set_manual_bracket': {
      const p = msg.data || {};
      state.bracket.phases = [{
        id: 'phase1', name: 'Bracket', type: p.type || 'SINGLE_ELIMINATION',
        winners: p.winners || [], losers: p.losers || [], finals: p.finals || [],
        standings: p.standings || [], schedule: p.schedule || [], roster: p.roster || []
      }];
      state.bracket.activePhaseId = 'phase1';
      if (typeof p.title === 'string') state.bracket.title = p.title;
      if (Array.isArray(p.teams)) state.bracket.teams = p.teams;
      state.bracket.matches = [];
      state.bracket.eventSlug = '';
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
          const slug = (msg.data?.eventSlug || state.bracket.eventSlug || '').trim();
          const result = await fetchBracket(slug);
          const label = result.type ? result.type.replace(/_/g, ' ').toLowerCase() : 'bracket';
          ws.send(JSON.stringify({
            type: 'bracket-result',
            data: { ok: true, message: `Loaded ${result.sets} set(s) — ${label}` }
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
        directorEngine.setSettings({
          enabled: 'enabled' in d ? !!d.enabled : undefined,
          sensitivity: 'sensitivity' in d ? Number(d.sensitivity) : undefined,
          lockTarget: 'lockTarget' in d ? (d.lockTarget || null) : undefined,
          autoSwitch: 'autoSwitch' in d ? !!d.autoSwitch : undefined
        });
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

    case 'montage_encode': {
      if (clipSystem && msg.data?.montageId) {
        const m = clipSystem.getState().montages.find((x) => x.id === msg.data.montageId);
        const opts = msg.data.opts || {};
        // 'logo' transition: persist the picked logo (data URL) to a file ffmpeg can read.
        if (opts.transition === 'logo' && typeof opts.transitionLogo === 'string' && opts.transitionLogo.startsWith('data:image/')) {
          try {
            const mm = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(opts.transitionLogo);
            if (mm) {
              const dir = path.join(clipSystem.manager.getClipsDir(), 'work');
              fs.mkdirSync(dir, { recursive: true });
              const lp = path.join(dir, `translogo_${msg.data.montageId}.${mm[1] === 'jpeg' ? 'jpg' : mm[1]}`);
              fs.writeFileSync(lp, Buffer.from(mm[2], 'base64'));
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

function sendImportExportResult(ws, result, message) {
  ws.send(JSON.stringify({
    type: 'import-export-result',
    data: { result, message }
  }));
}

function mergeAtTop(savedArray, importedArray, isSameItem) {
  const filteredNew = importedArray.filter(importItem => {
    return !savedArray.some(savedItem => isSameItem(savedItem, importItem));
  });

  return [...filteredNew, ...savedArray];
}

let _bcTimer = null, _bcPending = false, _lastLibSig = '';
function _flushFullState() {
  const data = buildLiveState();
  const sig = librarySig();
  if (sig !== _lastLibSig) { _lastLibSig = sig; Object.assign(data, libraryData()); }   // include library only when it changed
  broadcast(bridgeClients, { type: 'full_state', data });
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
  }, 40);
}

// ─── HTTP Server (port 3000) — serves overlay ────────────────────────────────
function startHttpServer(baseDir) {
  const app = express();
  const overlayDir = path.join(baseDir, 'overlay');
  const overridesDir = path.join(dataDir, 'overlay-overrides');
  overlayEditor = createOverlayEditor({ overlayDir, overridesDir });

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

  // List every overlay HTML on disk so the Scenes page auto-discovers new scenes
  // (no need to hand-maintain a list). Internal pages are excluded.
  app.get('/api/overlays', async (req, res) => {
    const EXCLUDE = new Set(['scenes.html', 'index.html']);  // launcher + overlay index
    try {
      const files = (await require('fs').promises.readdir(overlayDir))
        .filter((f) => /\.html$/i.test(f) && !EXCLUDE.has(f.toLowerCase()))
        .sort();
      res.json({ ok: true, overlays: files.map((f) => ({ file: f, path: '/' + f })) });
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

  // Returns all audio/video inputs currently known to OBS — used to populate flow action dropdowns.
  app.get('/api/obs/inputs', async (req, res) => {
    if (!obsClient || !obsClient.isConnected()) return res.json({ inputs: [] });
    const inputs = await obsClient.getInputList().catch(() => []);
    res.json({ inputs });
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

      fs.writeFileSync(filePath, json, 'utf8');
      console.log(`[OBS] Saved scene collection to ${filePath}`);

      // If it landed in the OBS scenes folder, optionally hot-switch via WebSocket.
      const savedInObsDir = obsDir && path.dirname(filePath) === obsDir;
      let switched = false;
      if (savedInObsDir && obsClient && obsClient.isConnected()) {
        try { await obsClient.call('SetCurrentSceneCollection', { sceneCollectionName: OBS_COLLECTION_NAME }); switched = true; }
        catch (wsErr) { console.warn('[OBS] SetCurrentSceneCollection failed:', wsErr.message); }
      }

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
          roomListenUrl: buildRoomListenInUrl(team), directorUrl: buildDirectorUrl(team.vdo) };
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

  // ── Overwolf GEP → Marvel Rivals live game data ─────────────────────────────
  // Called by a companion Overwolf app running on the spectator PC.
  // Body: { roster: [{name,character_name,team,kills,deaths,assists,ult_charge,is_alive}×12],
  //         map: string, match_outcome: string|null, banned_characters: string[] }
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
      match_outcome: body.match_outcome || null,
      banned_characters: Array.isArray(body.banned_characters) ? body.banned_characters : (prevGep.banned_characters || [])
    };
    broadcastFullState();
    res.json({ ok: true });
  });

  // ── In-app bug report → Discord webhook ─────────────────────────────────────
  // This route is registered before the global express.json() below, so it needs
  // its own body parser — otherwise req.body is empty and reports look blank.
  app.post('/api/bug-report', express.json({ limit: '12mb' }), async (req, res) => {
    const hook = process.env.BUG_REPORT_WEBHOOK || '';
    if (!hook) return res.status(503).json({ ok: false, message: 'No bug-report webhook configured (set BUG_REPORT_WEBHOOK in .env.local).' });
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
    const payload = {
      username: isFeature ? 'NE Feature Requests' : 'NE Bug Reports',
      embeds: [embed],
      ...(imgBuf ? { attachments: [{ id: 0, filename: imgName }] } : {})
    };

    // Use axios (Node 16 in Electron has no global fetch). 8s timeout so a slow/unreachable
    // Discord can't hang the request. Discord returns 204 on success → axios resolves on 2xx.
    try {
      if (imgBuf) {
        const ext = imgName.split('.').pop();
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload), { contentType: 'application/json' });
        form.append('files[0]', imgBuf, { filename: imgName, contentType: mime });
        await axios.post(hook, form, { headers: form.getHeaders(), timeout: 12000, maxContentLength: Infinity, maxBodyLength: Infinity });
      } else {
        await axios.post(hook, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
      }
      res.json({ ok: true });
    } catch (e) {
      if (e.response) {
        const txt = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data || {});
        return res.status(502).json({ ok: false, message: `Discord rejected the report (${e.response.status}). ${String(txt).slice(0, 160)}` });
      }
      const msg = (e.code === 'ECONNABORTED') ? 'Discord did not respond in time (timed out).' : e.message;
      res.status(500).json({ ok: false, message: msg });
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
  app.get('/api/clips/scan-folder', (req, res) => {
    try {
      const folder = state.clips?.replayFolder || '';
      if (!folder) return res.json({ ok: true, files: [], reason: 'No folder configured' });
      if (!fs.existsSync(folder)) return res.json({ ok: true, files: [], reason: 'Folder not found' });

      const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.ts', '.flv', '.avi', '.wmv']);
      const entries = fs.readdirSync(folder);
      const library = (clipSystem ? clipSystem.getState().library : []) || [];
      // Match by sourceFile (exact original path) so the staging area can show ✓ imported
      const importedSourceFiles = new Set(library.map(c => path.resolve(c.sourceFile || '')).filter(Boolean));
      const importedPaths = new Set(library.map(c => path.resolve(c.path || '')).filter(Boolean));

      const allFiles = entries
        .filter(f => VIDEO_EXT.has(path.extname(f).toLowerCase()))
        .map(f => {
          const full = path.join(folder, f);
          try {
            const stat = fs.statSync(full);
            const resolved = path.resolve(full);
            const imported = importedPaths.has(resolved) || importedSourceFiles.has(resolved);
            const importedClip = library.find(c =>
              path.resolve(c.sourceFile || '') === resolved ||
              path.resolve(c.path || '') === resolved
            );
            return { name: f, path: full, size: stat.size, mtimeMs: stat.mtimeMs, imported, importedId: importedClip?.id || null };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

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

  // The control panel runs from a file:// origin (Electron loadFile), so allow it to
  // read these localhost-only API responses cross-origin.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

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

  app.get('/api/media/list', (req, res) => {
    const rel = req.query.path || '';
    const abs = safeMediaPath(rel);
    if (!abs) return res.status(400).json({ ok: false, error: 'Bad path' });
    try {
      const entries = fs.existsSync(abs) ? fs.readdirSync(abs, { withFileTypes: true }) : [];
      const folders = [], files = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const childRel = (rel ? rel.replace(/\/+$/, '') + '/' : '') + e.name;
        if (e.isDirectory()) {
          folders.push({ name: e.name, path: childRel });
        } else if (IMG_RE.test(e.name)) {
          let size = 0; try { size = fs.statSync(path.join(abs, e.name)).size; } catch (x) {}
          files.push({ name: e.name, path: childRel, url: '/data/media/' + childRel.split('/').map(encodeURIComponent).join('/'), size });
        }
      }
      res.json({ ok: true, path: rel, folders, files });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/media/folder', mediaJson, (req, res) => {
    const { path: rel, name } = req.body || {};
    const safeName = String(name || '').replace(/[^\w\-. ]+/g, '').trim();
    if (!safeName) return res.status(400).json({ ok: false, error: 'Bad folder name' });
    const abs = safeMediaPath((rel ? rel + '/' : '') + safeName);
    if (!abs) return res.status(400).json({ ok: false, error: 'Bad path' });
    try { fs.mkdirSync(abs, { recursive: true }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/media/upload', mediaJson, (req, res) => {
    const { path: rel, name, dataUrl, url } = req.body || {};
    const safeName = String(name || '').replace(/[^\w\-. ]+/g, '_').trim();
    if (!safeName) return res.status(400).json({ ok: false, error: 'Missing file name' });
    const dir = safeMediaPath(rel || '');
    if (!dir) return res.status(400).json({ ok: false, error: 'Bad path' });
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Web album: store a tiny .url pointer instead of binary data.
      if (url && !dataUrl) {
        fs.writeFileSync(path.join(dir, safeName.replace(IMG_RE, '') + '.url'), String(url));
        return res.json({ ok: true, web: true });
      }
      const m = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl || '');
      if (!m) return res.status(400).json({ ok: false, error: 'Expected a base64 data URL' });
      const fname = IMG_RE.test(safeName) ? safeName : safeName + '.png';
      fs.writeFileSync(path.join(dir, fname), Buffer.from(m[1], 'base64'));
      res.json({ ok: true, name: fname, url: '/data/media/' + ((rel ? rel + '/' : '') + fname).split('/').map(encodeURIComponent).join('/') });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/media/delete', mediaJson, (req, res) => {
    const abs = safeMediaPath((req.body || {}).path);
    if (!abs || abs === mediaRoot) return res.status(400).json({ ok: false, error: 'Bad path' });
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      else fs.unlinkSync(abs);
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
      avatarUrl: state.discord.avatarUrl
    });
  });

  // POST /api/oauth/discord/init - Returns the Discord OAuth URL for the client to open
  app.post('/api/oauth/discord/init', (req, res) => {
    if (!DISCORD_CLIENT_ID) {
      return res.status(500).json({ error: 'DISCORD_CLIENT_ID not configured — add it to .env.local' });
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
      scope: 'identify',
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
    const useBackend = cloud.configured();
    const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
    if (!useBackend && !DISCORD_CLIENT_SECRET) {
      return res.status(500).send('Discord login is not configured — no backend (BROADCAST_REMOTE_URL) and no DISCORD_CLIENT_SECRET.');
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
      console.error('[Discord OAuth]', err.response?.data || err.message);
      res.status(500).send('Discord authentication failed — check server logs');
    }
  });

  // POST /api/oauth/discord/logout - Clear Discord session
  app.post('/api/oauth/discord/logout', (req, res) => {
    state.discord.connected    = false;
    state.discord.userId       = '';
    state.discord.username     = '';
    state.discord.discriminator = '';
    state.discord.globalName   = '';
    state.discord.avatarUrl    = '';
    state.discord.accessToken  = '';
    state.discord.refreshToken = '';
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

  // Prediction resolution
  app.post('/api/twitch/prediction/resolve', async (req, res) => {
    const { outcomeId } = req.body;

    if (!predictionManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    if (!state.twitch.predictions.current) {
      return res.status(400).json({ error: 'No active prediction' });
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
    if (!state.twitch.predictions.current) return res.status(400).json({ error: 'No active prediction' });
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
    if (!state.twitch.predictions.current) return res.status(400).json({ error: 'No active prediction' });
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

  fs.mkdirSync(dataDir, { recursive: true });
  stats.init(dataDir);
  loadTeams();
  loadState();
  resetRlGameTrack();
  loadFacecams();
  loadPresets();
  loadBrandKits();
  loadTwitchData();
  loadDiscordUser();
  initFlowEngine();
  // Nameless cloud client — dormant unless BROADCAST_REMOTE_URL is configured.
  try { cloud.init({ baseUrl: BROADCAST_REMOTE_URL, dataDir, appVersion }); } catch (e) { console.warn('[Cloud] init skipped:', e.message); }

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
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) {} this.ws = null; }
    this.sessionId = null;
    this.connected = false;
  }

  _connect() {
    if (!this.shouldRun) return;
    if (!state.twitch.apiToken) { console.warn('[EventSub] No Twitch token — WS not started'); return; }
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) {} this.ws = null; }

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
      if (this.ws) { try { this.ws.close(); } catch (_) {} }
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

    const results = [];
    for (const s of specs) {
      const sub = await this.subscribe(s.type, s.version, s.condition);
      results.push({ eventType: s.type, success: !!sub });
      await new Promise(r => setTimeout(r, 150)); // Rate limit spacing
    }
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
        const startedAt = data.timestamp || new Date().toISOString();
        const endsAt = new Date(new Date(startedAt).getTime() + duration * 1000).toISOString();
        state.twitch.adBreak = { active: true, duration, startedAt, endsAt, isAutomatic: !!data.is_automatic };
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
            const lastAd = adRes.data.data[0];
            this.adSchedule.lastAdAt = new Date(lastAd.timestamp);
            this.adSchedule.adDuration = lastAd.duration;

            // Calculate next ad time (roughly 8 minutes after last ad for mid-roll)
            const nextAdTime = new Date(this.adSchedule.lastAdAt.getTime() + 8 * 60 * 1000);
            this.adSchedule.nextAdAt = nextAdTime;
          }
        } catch (e) {
          // Ad schedule endpoint may not be available for all tokens
          console.log('[Ads] Schedule unavailable:', e.response?.status);
        }

        // Broadcast state update
        broadcast(bridgeClients, {
          type: 'twitch_stream_state',
          data: {
            stream: this.streamState,
            ads: this.adSchedule
          }
        });

      } catch (err) {
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
    if (this._reconnectTimer) return;
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
    if (this.ircSocket) {
      this.send(`PART #${this.channelName}`);
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
};

module.exports.broadcastCrashAlert = function (message) {
  broadcast(bridgeClients, { type: 'crash_alert', data: { message } });
};

module.exports.setEncodeProgressCallback = function (cb) {
  onEncodeProgressCallback = cb;
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

