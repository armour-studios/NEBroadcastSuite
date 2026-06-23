require('dotenv').config({ path: require('path').join(__dirname, '.env.local') });
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
const IS_DEV = () => _electronApp && !_electronApp.isPackaged;
const { createStartGgClient } = require('./backend/integrations/startgg-client');
const { createDirectorEngine } = require('./backend/director');
const { createClipSystem } = require('./backend/clips');
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

let httpServer = null;
let bridgeWss = null;
let _bridgeHeartbeat = null;

// Stats tracking — match/game IDs for the current broadcast session
let statsCurrentMatchId = null;
let statsCurrentGameId  = null;  // RL
let statsCs2GameId      = null;  // CS2

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
  'marvel-rivals': { id: 'marvel-rivals', name: 'Marvel Rivals', overlay: '',           format: 'team6', teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 6, logo: 'games/rivals.png',        features: ['heroes'],               themes: [] },
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
  eventName: 'ROCKET LEAGUE TOURNAMENT',
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
  casters: { visible: true, list: [], lowerThird: '' },   // [{ id, name, handle, camUrl, slot, social }]
  // Break / "starting soon" standby. endsAt = epoch ms target for the countdown scene; null = no timer.
  breakScreen: { visible: false, title: 'STARTING SOON', message: '', endsAt: null, frozenSeconds: null, finalMessage: "WE'RE LIVE!" },
  ticker: { visible: false, messages: [], speed: 40 },   // scrolling lower-third; speed = loop seconds
  spotlight: { visible: false, playerName: '' },          // featured-player lower-third (live stats)
  // Post-match WINNER screen (game-agnostic). side resolves a team from `teams`; or set name/logo/color directly.
  winner: { visible: false, side: '', name: '', logo: null, color: '', subtitle: '' },
  // Map veto / map-pool overview board (CS2/Valorant/etc.). Each map: name, mode, image, action, by, score, winner.
  // action: 'ban'|'pick'|'decider'|''  by: 'a'|'b'|''  winner: 'a'|'b'|''  score: { a, b }
  veto: { visible: false, title: '', maps: [] },
  // Overwatch 2 series scoreboard — hero bans per map + format display.
  // bansByMap: [{ a: { hero, role }, b: { hero, role } }] indexed by map order.
  owMatch: { visible: true, format: 'FT3', currentMapIdx: 0, bansByMap: [], gameMode: 'escort', showMapLabels: true, mapWinners: [], mapModes: [] },
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
    eventTeams: []         // [{ name, logo, players: [{id,name,platform,platformId,assignedCamera}], startggId }]
  },
  obs: {
    enabled: false,
    connected: false,
    url: 'ws://127.0.0.1:4455',
    autoSwitch: true,
    autoReplayOnGoal: false,   // save an OBS replay-buffer clip on every goal
    lastError: null,
    postGameToCastersSec: 0,  // auto-switch post-game → casters after N seconds (0 = off)
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
    lastFetchAt: null,
    lastError: null
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
        overlayLoop: 30
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
    }
  }
};

let directorEngine = null;
let clipSystem = null;
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
}

function saveBrandKits() {
  try { safeWriteJson(brandsFile, savedBrandKits); } catch (e) { console.error('Error saving brand kits:', e); }
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

// The active client brand kit, resolved for overlays (or null → overlays fall back to event branding).
function activeBrand() {
  const kit = savedBrandKits.find((b) => b.id === state.activeBrandKitId);
  if (!kit) return null;
  const sponsors = (Array.isArray(kit.sponsors) ? kit.sponsors : []).map((s) => ({
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
    sponsorLabel: kit.sponsorLabel || 'PARTNERS',
    sponsorInterval: Number(kit.sponsorInterval) > 0 ? Number(kit.sponsorInterval) : 6,
    bannerImages: Array.isArray(kit.bannerImages) ? kit.bannerImages : [],
    bannerInterval: Number(kit.bannerInterval) > 0 ? Number(kit.bannerInterval) : 10,
    sponsors,                                  // all (for the editor + back-compat consumers)
    railSponsors: tagged('rail'),              // rotating corner bug
    deskSponsors: tagged('desk'),              // caster-desk footer logos
    bannerSponsors: tagged('banner'),          // sponsor-banner rotation
    spots: {                                   // single-logo ad slots → first tagged sponsor's logo
      overtime: (tagged('overtime')[0] || {}).logo || null,
      replayGoal: (tagged('replayGoal')[0] || {}).logo || null,
      replayOutro: (tagged('replayOutro')[0] || {}).logo || null,
      scoreboard: (tagged('scoreboard')[0] || {}).logo || null
    }
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
      if (saved.eventName) state.eventName = saved.eventName;
      if (saved.fontFamily) state.fontFamily = saved.fontFamily;
      if (saved.facecamsEnabled !== undefined) state.facecamsEnabled = saved.facecamsEnabled;
      if (saved.replayCams !== undefined) state.replayCams = saved.replayCams;
      if (saved.banner) state.banner = saved.banner;
      if (saved.casters && typeof saved.casters === 'object') {
        state.casters = {
          visible: !!saved.casters.visible,
          lowerThird: typeof saved.casters.lowerThird === 'string' ? saved.casters.lowerThird : '',
          list: Array.isArray(saved.casters.list) ? saved.casters.list : []
        };
      }
      if (saved.ticker && typeof saved.ticker === 'object') {
        state.ticker = {
          visible: !!saved.ticker.visible,
          messages: Array.isArray(saved.ticker.messages) ? saved.ticker.messages : [],
          speed: Number(saved.ticker.speed) > 0 ? Number(saved.ticker.speed) : 40
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
      if (saved.breakScreen && typeof saved.breakScreen === 'object') {
        state.breakScreen = {
          visible: !!saved.breakScreen.visible,
          title: saved.breakScreen.title || 'STARTING SOON',
          message: saved.breakScreen.message || '',
          finalMessage: saved.breakScreen.finalMessage || "WE'RE LIVE!",
          // Don't restore a stale countdown across restarts
          endsAt: null
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
          eventTeams: Array.isArray(saved.startgg.eventTeams) ? saved.startgg.eventTeams : []
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
      fontFamily: state.fontFamily,
      facecamsEnabled: state.facecamsEnabled,
      banner: state.banner,
      casters: state.casters,
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
      // Persist content for the momentary production graphics; visibility is reset on restart.
      winner: { side: state.winner.side, name: state.winner.name, logo: state.winner.logo, color: state.winner.color, subtitle: state.winner.subtitle },
      veto: { title: state.veto.title, maps: state.veto.maps },
      intro: { side: state.intro.side, title: state.intro.title, style: state.intro.style },
      owMatch: { visible: !!state.owMatch.visible, format: state.owMatch.format, currentMapIdx: state.owMatch.currentMapIdx, bansByMap: state.owMatch.bansByMap, attackSide: state.owMatch.attackSide || null, showAttack: !!state.owMatch.showAttack, gameMode: state.owMatch.gameMode || 'escort', showMapLabels: state.owMatch.showMapLabels !== false, mapWinners: Array.isArray(state.owMatch.mapWinners) ? state.owMatch.mapWinners : [], mapModes: Array.isArray(state.owMatch.mapModes) ? state.owMatch.mapModes : [] },
      customOverlayLayouts: state.customOverlayLayouts || {},
      bestOf: state.bestOf,
      teams: state.teams,
      series: state.series,
      match: state.match,
      leagues: state.leagues,
      game: { number: state.game.number },
      startgg: state.startgg,
      startggApiToken,
      obs: {
        enabled: state.obs.enabled,
        url: state.obs.url,
        autoSwitch: state.obs.autoSwitch,
        autoReplayOnGoal: state.obs.autoReplayOnGoal,
        postGameToCastersSec: state.obs.postGameToCastersSec,
        commercialAutoReturn: state.obs.commercialAutoReturn,
        scenes: state.obs.scenes
      },
      obsPassword,
      // Persist the full bracket so it renders instantly on restart (then refreshes)
      bracket: state.bracket,
      csgoCfgPath: state.csgo.cfgPath,
      director: {
        enabled: state.director?.enabled !== false,
        sensitivity: state.director?.sensitivity ?? 0.5,
        autoSwitch: !!state.director?.autoSwitch
      },
      clips: {
        captureMode: state.clips?.captureMode || 'auto',
        autoCapture: state.clips?.autoCapture !== false,
        autoMontage: !!state.clips?.autoMontage,
        replayFolder: state.clips?.replayFolder || '',
        captureRules: state.clips?.captureRules || {}
      },
      rlSpectatorUi: state.rlSpectatorUi || rlSpectatorUi.DEFAULTS
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
  // Effective side colours for the active mode — overlays read teams.x.color; the control
  // panel can still see each team's own colour via teams.x.ownColor.
  const eff = effectiveTeamColors();
  return {
    ...state,
    teams: {
      blue:   { ...state.teams.blue,   color: eff.blue,   ownColor: state.teams.blue.color },
      orange: { ...state.teams.orange, color: eff.orange, ownColor: state.teams.orange.color }
    },
    colorMode: state.colorMode || 'team',
    startgg: publicStartgg,
    obs: publicObs,
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
    formattedTime: formatTime(state.game.time)
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
    mainBanner: state.banner
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
    const sp = (k.sponsors || []).reduce((a, s) => a + ((s && s.logo || '').length) + ((s && s.name || '').length), 0);
    const bn = (k.bannerImages || []).reduce((a, img) => a + ((img || '').length), 0);
    return k.id + ':' + (k.name || '') + ':' + (k.color || '') + ':' + (k.accent || '') + ':' + (k.logo ? k.logo.length : 0)
      + ':' + (k.sponsors || []).length + ':' + sp + ':' + bn;
  }).join(',');
  // …plus active-kit selection + banner toggle/images so brand/banner/mainBanner re-send when they change.
  const bn = (state.banner.images || []).reduce((a, i) => a + ((i || '').length), 0);
  const extra = '|ab:' + (state.activeBrandKitId || '') + '|bv:' + (state.banner.visible ? 1 : 0) + '|bi:' + bn;
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

  const blueEntrant = entrants[0];
  const orangeEntrant = entrants[1];

  if (blueEntrant) {
    state.teams.blue.name = (blueEntrant.name || 'BLUE TEAM').toUpperCase();
  }
  if (orangeEntrant) {
    state.teams.orange.name = (orangeEntrant.name || 'ORANGE TEAM').toUpperCase();
  }

  // Auto-apply saved logos/players when the entrant matches a team in the library
  ['blue', 'orange'].forEach((side) => {
    const tn = (state.teams[side].name || '').toUpperCase();
    const saved = savedTeams.find((t) => (t.name || '').toUpperCase() === tn);
    if (saved) {
      if (saved.logo) state.teams[side].logo = saved.logo;
      if (Array.isArray(saved.players) && saved.players.length) {
        state.teams[side].players = saved.players;
      }
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
              entrant { id name }
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
    (q?.sets || []).forEach((set, idx) => {
      const ents = (set.slots || []).map((s) => s?.entrant).filter(Boolean);
      const scoreA = set.slots?.[0]?.standing?.stats?.score?.value;
      const scoreB = set.slots?.[1]?.standing?.stats?.score?.value;
      queue.push({
        setId: String(set.id),
        stream: streamName,
        round: set.fullRoundText || '',
        state: set.state,                 // 1 not started, 2 in progress, 3 done
        teamA: ents[0]?.name || 'TBD',
        teamB: ents[1]?.name || 'TBD',
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
  } catch (e) {
    state.startgg.connected = false;
    state.startgg.lastError = e.message;
    broadcastFullState();
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

// ─── Start.gg bracket ────────────────────────────────────────────────────────
function parseEventSlug(input) {
  const s = (input || '').trim();
  if (!s) return '';
  // Accept a full start.gg URL or a bare slug
  const m = s.match(/tournament\/[^/\s]+\/event\/[^/?#\s]+/i);
  return m ? m[0] : s;
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
  const slug = (tournamentSlug || '').trim();
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
    const res = await client.request(query, { slug, page });
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
  const slug = (tournamentSlug || '').trim();
  if (!slug) return [];
  const client = createStartGgClient(apiToken);
  const query = `
    query TournamentEvents($slug: String!) {
      tournament(slug: $slug) {
        id
        name
        slug
        events {
          nodes {
            id
            slug
            name
            startAt
          }
        }
      }
    }
  `;
  try {
    const res = await client.request(query, { slug });
    const evs = (res && res.tournament && res.tournament.events && res.tournament.events.nodes) || [];
    return evs.map(e => ({
      id: e.id,
      slug: e.slug,
      name: e.name,
      startAt: e.startAt,
      tournamentSlug: slug,
      tournamentName: (res.tournament && res.tournament.name) || ''
    }));
  } catch (e) {
    console.warn('[start.gg] Could not fetch events for tournament', slug, e.message);
    return [];
  }
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
  // Keep the transient picker list in sync too.
  state.startgg.eventTeams = mapEntrantsToTeams(entrants);
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
  const r = mergeEntrantsIntoLibrary(entrants);   // teams+players → library + eventTeams

  saveTeams();
  saveAppState();
  broadcastFullState();

  return {
    title: event.name || '',
    type: state.bracket.type,
    teams: entrants.length,
    teamsAdded: r.teamsAdded,
    players: r.playersTotal,
    logos: r.logosFound,
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

  broadcastValorant();
}

function broadcastValorant() {
  broadcast(bridgeClients, { type: 'valorant_update', data: state.valorant });
}

let _valPollTimer = null;

function startValorantPolling() {
  if (_valPollTimer) return;
  _valPollTimer = setInterval(async () => {
    if (state.activeGame !== 'valorant') return;
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

const DIRECTOR_CAPTURE_TYPES = new Set([
  'goal', 'save', 'ace', 'clutch', 'demo', 'shot', 'kickoff', 'multi_kill', 'defuse', 'match_point'
]);

function buildCaptureMetaFromEvent(event, gameId) {
  return {
    type: event.type,
    game: gameId,
    player: event.target?.name || '',
    reason: event.reason || '',
    label: `${event.type} — ${event.target?.name || 'highlight'}`,
    captureKey: `${event.type}:${event.target?.id || event.target?.name}:${event.ts}`,
    feedTs: event.ts
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
      triggerClipCapture(meta).then((clip) => maybeAutoMontage(clip)).catch((e) => console.error('[Clips] Capture error:', e.message));
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
    } else if (mapPhase === 'warmup' && prev !== 'warmup') {
      obsSwitch('break');
    }
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
      state.obs.currentScene = sceneName || '';
      broadcastFullState();
    },
    // Live mirror of the connected OBS profile's scene collection.
    onSceneListChange: (scenes) => {
      state.obs.availableScenes = Array.isArray(scenes) ? scenes : [];
      broadcastFullState();
    },
    // A media (commercial video) finished — auto-cut back to program if enabled.
    onMediaEnded: () => {
      if (state.commercial.active && state.obs.commercialAutoReturn) endCommercial();
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

// Switch OBS to the scene mapped to a broadcast moment, if auto-switch is on.
function obsSwitch(sceneKey) {
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

// Fire-and-forget: save an OBS replay clip when a goal is scored (if enabled).
function obsAutoReplay() {
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

function connectToRL() {
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
      handleClock(data);
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
    case 'PreCountdownBegin':
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
  state.awaitingKickoff = false;
  if (state.view === 'scoreboard') { state.view = 'hud'; broadcastFullState(); }
  obsSwitch('inGame');   // the RL overlay scene comes up at kickoff, not during "choose teams"
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
  if ('TimeSeconds' in data) state.game.time = data.TimeSeconds;
  else if ('time_seconds' in data) state.game.time = data.time_seconds;

  if ('bOvertime' in data) state.game.isOT = data.bOvertime;
  maybeTriggerOvertime();   // detect the 0:00 ground-touch OT trigger (before RL's own late flag)

  rlGameTrack.gameTime = state.game.time;

  // Fallback for the post-game → kickoff scene return: a live clock tick (not during a replay) means
  // gameplay has started. If the countdown event never came, bring up the in-game scene now.
  if (state.awaitingKickoff && !state.inReplay && state.view !== 'goal' && state.view !== 'scoreboard') {
    returnToInGameForKickoff();
  }

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

  // Update game
  if ('SecondsRemaining' in game) state.game.time = game.SecondsRemaining;
  else if ('time_seconds' in game) state.game.time = game.time_seconds;
  
  if ('IsOT' in game) state.game.isOT = game.IsOT;
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

  // Ball state (official Stats API — when exposed in UpdateState)
  const ballRaw = data.Ball || data.ball || null;
  if (ballRaw && typeof ballRaw === 'object') {
    state.rlBall = {
      x: ballRaw.X ?? ballRaw.x ?? null,
      y: ballRaw.Y ?? ballRaw.y ?? null,
      z: ballRaw.Z ?? ballRaw.z ?? null
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

  // Detect spectated player
  let spec = null;
  if (game.bHasTarget !== false && game.Target) {
    spec = game.Target.Name || game.Target.name || null;
  }
  
  if (spec) {
    state.spectatedPlayer = spec;
  } else {
    // fallback to isPrimary
    const primary = normalised.find(p => p.isPrimary);
    if (primary) state.spectatedPlayer = primary.name;
    else state.spectatedPlayer = null;
  }

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

function handleGoalScored(data) {
  const scorer   = data.Scorer   || data.scorer   || {};
  const assister = data.Assister || data.assister || null;
  const speed    = data.GoalSpeedKPH ?? data.goalSpeedKPH ?? data.GoalSpeed ?? data.goalSpeed ?? 0;
  const team     = scorer.TeamNum ?? scorer.teamNum ?? scorer.team ?? data.teamnum ?? 0;

  state.currentGoal = {
    scorer:   scorer.Name   || scorer.name   || '',
    assisterName: assister ? (assister.Name || assister.name || '') : null,
    speed:    Math.round(speed),
    team:     team
  };

  // Tell overlays the instant the ball hits the net (BEFORE the replay starts), so
  // goal-triggered animations fire at the goal, not when the replay kicks in.
  broadcast(bridgeClients, { type: 'goal_scored', data: { team: state.currentGoal.team, goal: state.currentGoal } });

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
  state.awaitingKickoff = true;   // we're in post-game — don't return to the RL overlay scene until the next kickoff
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
        predictionManager.resolvePrediction(outcome.id)
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

  saveAppState();
  broadcastFullState();

  setTimeout(() => {
    // Freeze playerCache as final scoreboard data
    state.view = 'scoreboard';
    broadcast(bridgeClients, {
      type: 'view_change',
      data: {
        view: 'scoreboard',
        series: state.series,
        playerCache: state.playerCache
      }
    });
    obsSwitch('postGame');

    // Auto-trigger: after the post-game scoreboard, switch to the caster desk
    // automatically after a configurable delay (0 = off).
    const delay = Number(state.obs.postGameToCastersSec) || 0;
    if (_postGameTimer) { clearTimeout(_postGameTimer); _postGameTimer = null; }
    if (delay > 0) {
      _postGameTimer = setTimeout(() => { _postGameTimer = null; obsSwitch('casters'); }, delay * 1000);
    }
  }, 3000);
}

// Normalize a raw Twitch API prediction result into our internal shape.
// The API uses 'status' (not 'state'), 'locks_at' (not 'endsAt'),
// and 'channel_points' / 'users' on outcomes (not 'votes').
function normalizePrediction(result, durationSeconds, fallbackOutcomes = []) {
  return {
    id:    result.id,
    title: result.title,
    state: result.status || result.state || 'ACTIVE',
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
  state.game.blueScore   = 0;
  state.game.orangeScore = 0;
  state.game.time        = 300;
  state.game.isOT        = false;
  resetOvertimeTrigger();   // a fresh game can trigger its own overtime later
  state.awaitingKickoff = true;   // wait for THIS game's kickoff before showing the RL overlay scene
  // Current game = games already played + 1 (idempotent with handleMatchEnded).
  state.game.number = Math.max(1, Math.min(state.bestOf, (state.series.blue || 0) + (state.series.orange || 0) + 1));
  state.players    = [];
  state.playerCache = {};
  state.view       = 'hud';
  state.inReplay   = false;
  state.currentGoal = null;
  resetRlGameTrack();
  saveAppState();
  broadcastFullState();
  broadcast(bridgeClients, { type: 'game_reset', data: { gameNumber: state.game.number } });

  // Auto-prediction: create "Who will win?" using the active team names
  if (state.twitch.connected && predictionManager && state.twitch.predictions.settings.autoCreate) {
    const blueTeam   = state.teams.blue.name   || 'Blue';
    const orangeTeam = state.teams.orange.name || 'Orange';
    const title = state.twitch.predictions.settings.template === 'teams'
      ? `Game ${state.game.number}: Who will win?`
      : 'Who will win this game?';
    const durationSecs = Math.round((state.twitch.predictions.settings.cooldown || 300000) / 1000);
    predictionManager.createPrediction(title, [blueTeam, orangeTeam], durationSecs)
      .then(result => {
        if (!result) return;
        state.twitch.predictions.current = normalizePrediction(result, durationSecs, [blueTeam, orangeTeam]);
        broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
        saveTwitchData();
        startPredictionPolling();
        console.log('[AutoPred] Created:', result.id);
        // Fallback: auto-cancel if still unresolved 60s after voting ends
        const msUntilEnd = durationSecs * 1000 + 60000;
        setTimeout(() => {
          const cur = state.twitch.predictions.current;
          if (cur && cur.id === result.id && cur.state !== 'RESOLVED') {
            console.warn('[AutoPred] Voting ended with no resolve — cancelling prediction', cur.id);
            stopPredictionPolling();
            predictionManager.cancelPrediction()
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
          : (('seconds' in b || 'endsAt' in b) ? null : (cur.frozenSeconds ?? null))
      };

      // Auto-start minigame when break screen becomes visible
      const wasVisible = cur.visible;
      const nowVisible = state.breakScreen.visible;

      if (!wasVisible && nowVisible && miniGameManager && state.twitch.minigame.settings.enabled) {
        // Break screen just turned on - auto-start a game
        const gameType = state.twitch.minigame.settings.breakScreenGameType || 'trivia';
        console.log('[Twitch] Auto-starting minigame on break screen:', gameType);

        // Create a default game based on type
        let autoGame = null;
        if (gameType === 'trivia') {
          autoGame = miniGameManager.createTrivia(
            'What is the capital of France?',
            ['Paris', 'London', 'Berlin', 'Madrid'],
            0
          );
        } else if (gameType === 'prediction') {
          autoGame = miniGameManager.createPrediction(
            'Will we win the next round?',
            ['Yes', 'No']
          );
        } else if (gameType === 'vote') {
          autoGame = miniGameManager.createVote(
            'Which game should we play?',
            ['Rocket League', 'CS2', 'Valorant']
          );
        } else if (gameType === 'spin') {
          autoGame = miniGameManager.createSpin([
            { name: 'Sub Gift', color: '#FF6B6B' },
            { name: '$25 Amazon', color: '#4ECDC4' },
            { name: 'Game Copy', color: '#FFE66D' }
          ]);
        }

        if (autoGame) {
          // Auto-finalize after duration
          const gameId = autoGame.id;
          const duration = autoGame.duration || 30000;

          if (gameTimers.has(gameId)) {
            clearTimeout(gameTimers.get(gameId));
          }

          const timer = setTimeout(() => {
            if (miniGameManager && miniGameManager.currentGame?.id === gameId) {
              miniGameManager.finalize();
              broadcastFullState();
              saveTwitchData();
              console.log('[Twitch] Auto-game finalized');
            }
            gameTimers.delete(gameId);
          }, duration);

          gameTimers.set(gameId, timer);
        }
      }

      saveAppState();
      broadcastFullState();
      obsSwitch(state.breakScreen.visible ? 'break' : 'inGame');
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
            predictionManager.resolvePrediction(outcome.id)
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

    // ── Game & overlay design (theme) ────────────────────────────────────
    case 'set_active_game': {
      const g = msg.data?.game;
      if (g && GAMES[g]) {
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
        if (g === 'valorant') startValorantPolling();
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
        id: existing ? existing.id : Math.random().toString(36).slice(2, 11),
        name,
        logo: k.logo || null,
        color: k.color || null,
        accent: k.accent || null,
        font: k.font || null,
        sponsorLabel: (k.sponsorLabel || 'PARTNERS').toString(),
        sponsorInterval: Number(k.sponsorInterval) > 0 ? Number(k.sponsorInterval) : 6,
        sponsors: Array.isArray(k.sponsors) ? k.sponsors.map((s) => ({
          id: s.id || Math.random().toString(36).slice(2, 9),
          name: (s.name || '').toString(), logo: s.logo || null, tier: s.tier || 'partner',
          placements: sanitizePlacements(s.placements)
        })) : [],
        themes: (k.themes && typeof k.themes === 'object') ? k.themes : {},
        bannerImages: Array.isArray(k.bannerImages) ? k.bannerImages : (existing ? existing.bannerImages || [] : []),
        bannerCaptions: Array.isArray(k.bannerCaptions) ? k.bannerCaptions.map((t) => (typeof t === 'string' ? t : '')) : (existing ? existing.bannerCaptions || [] : []),
        bannerSlant: ['right', 'left', 'box'].includes(k.bannerSlant) ? k.bannerSlant : (existing ? existing.bannerSlant || 'right' : 'right'),
        bannerHeader: typeof k.bannerHeader === 'string' ? k.bannerHeader.slice(0, 40) : (existing ? existing.bannerHeader || '' : ''),
        bannerInterval: Number(k.bannerInterval) > 0 ? Number(k.bannerInterval) : 10
      };
      if (existing) Object.assign(existing, entry); else savedBrandKits.push(entry);
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
      // Automation: snap this game's theme to the kit's preferred design, if set.
      if (kit && kit.themes && isValidTheme(state.activeGame, kit.themes[state.activeGame])) {
        state.themesByGame[state.activeGame] = kit.themes[state.activeGame];
      }
      applyBrandSlots();           // fill the ad slots from this brand's sponsor placements
      saveAppState();
      broadcastFullState();        // brand colours apply automatically when colorMode === 'brand'
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
      if (Array.isArray(p.messages)) {
        state.ticker.messages = p.messages
          .map((m) => (m || '').toString().trim())
          .filter(Boolean)
          .slice(0, 30);
      }
      if (Number(p.speed) > 0) state.ticker.speed = Math.min(300, Math.max(5, Number(p.speed)));
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
      saveAppState();
      broadcastFullState();
      obsSwitch('inGame');
      break;

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
      state.eventName = 'ROCKET LEAGUE TOURNAMENT';
      state.fontFamily = 'Bourgeois';
      state.banner = { visible: false, images: [], captions: [], interval: 10, slant: 'right', header: '' };
      state.casters = { visible: true, list: [], lowerThird: '' };
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
      // A manual cut cancels any pending auto post-game→casters switch.
      if (_postGameTimer) { clearTimeout(_postGameTimer); _postGameTimer = null; }
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
      broadcast(bridgeClients, { type: 'replay_play', data: { bus, ...state.replay[bus], transitionLogo: typeof p.transitionLogo === 'string' ? p.transitionLogo : '' } });
      broadcastFullState();
      // Auto-switch OBS to the configured replay scene when pushing to program
      if (bus === 'program') {
        obsSwitch('replay');
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

    // ── Bracket ──────────────────────────────────────────────────────────
    case 'set_bracket_settings': {
      const p = msg.data || {};
      if (typeof p.eventSlug === 'string') state.bracket.eventSlug = p.eventSlug.trim();
      if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
      saveAppState();
      broadcastFullState();
      if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
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
    case 'activate_startgg_event': {
      (async () => {
        const d = msg.data || {};
        const eventSlug = (d.eventSlug || '').trim();
        const tournamentSlug = (d.tournamentSlug || '').trim() || eventSlug.replace(/\/event\/.*$/, '');
        try {
          const r = await loadEvent(eventSlug);
          state.startgg.selectedEvent = {
            tournamentSlug,
            eventSlug,
            name: (d.name || r.title || '').trim(),
            tournamentName: (d.tournamentName || '').trim()
          };
          if (tournamentSlug) state.startgg.tournamentSlug = tournamentSlug;
          if (eventSlug) state.startgg.eventSlug = eventSlug;
          saveAppState();
          broadcastFullState();
          ws.send(JSON.stringify({
            type: 'event-result',
            data: {
              ok: true, activated: true, tournamentSlug, eventSlug,
              message: `Activated "${d.name || r.title}" — ${r.teams} team(s) imported, bracket loaded.`
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
        directorEngine.recordFeedback({
          eventType: msg.data.eventType || state.director?.primary?.type || 'unknown',
          targetId: msg.data.targetId || state.director?.primary?.target?.id,
          action: msg.data.action || 'accepted'
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
        state.director = mergeDirectorRuntime(directorEngine.getState());
        broadcastDirectorUpdate();
      }
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

  // ─── OBS Scene Collection ────────────────────────────────────────────────────
  // Shared helper: build the collection JSON from current caster state.
  function buildSceneCollection() {
    const casters = (state.casters && state.casters.list) || [];
    const bySlot = (slot) => {
      const c = casters.find(c => Number(c.slot) === slot);
      return (c && c.camUrl) ? c.camUrl : '';
    };
    return generateSceneCollection({
      caster1CamUrl: bySlot(1),
      caster2CamUrl: bySlot(2),
      hostCamUrl:    bySlot(3),
    });
  }

  // GET  → download as file (manual import fallback)
  app.get('/api/obs/scene-collection', (req, res) => {
    try {
      const collection = buildSceneCollection();
      res.setHeader('Content-Disposition', 'attachment; filename="NE-Broadcast-Suite.json"');
      res.json(collection);
    } catch (e) {
      console.error('[OBS] Scene collection generation failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST → write directly to OBS scenes folder + switch via WebSocket
  app.post('/api/obs/install-collection', async (req, res) => {
    const COLLECTION_NAME = 'NE-Broadcast-Suite';
    try {
      const collection = buildSceneCollection();
      const json = JSON.stringify(collection, null, 2);

      // OBS stores scene collections in %APPDATA%\obs-studio\basic\scenes\ on Windows
      // and ~/Library/Application Support/obs-studio/basic/scenes/ on Mac.
      const obsDir = process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio', 'basic', 'scenes')
        : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obs-studio', 'basic', 'scenes');

      if (!fs.existsSync(obsDir)) {
        return res.status(404).json({ ok: false, error: 'OBS scenes folder not found. Is OBS installed?' });
      }

      const dest = path.join(obsDir, `${COLLECTION_NAME}.json`);
      fs.writeFileSync(dest, json, 'utf8');
      console.log(`[OBS] Wrote scene collection to ${dest}`);

      // Switch OBS to the new collection via WebSocket (OBS must be open)
      let switched = false;
      if (obsClient && obsClient.isConnected()) {
        try {
          await obsClient.call('SetCurrentSceneCollection', { sceneCollectionName: COLLECTION_NAME });
          switched = true;
        } catch (wsErr) {
          console.warn('[OBS] SetCurrentSceneCollection failed:', wsErr.message);
        }
      }

      res.json({
        ok: true,
        path: dest,
        switched,
        message: switched
          ? `Installed and switched to "${COLLECTION_NAME}" in OBS.`
          : `Installed to OBS folder. Open OBS → Scene Collection → ${COLLECTION_NAME} to activate.`
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

      const files = entries
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
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 100);

      res.json({ ok: true, files, folder });
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
  app.post('/api/twitch/set-token', (req, res) => {
    const { apiToken, displayName, channelId, profilePicture } = req.body;
    if (!apiToken) {
      return res.status(400).json({ error: 'API token required' });
    }

    try {
      state.twitch.apiToken = apiToken;
      state.twitch.displayName = displayName || 'Unknown';
      state.twitch.channelId = channelId || '';
      state.twitch.profilePicture = profilePicture || '';
      twitchClient = new TwitchClient(TWITCH_CLIENT_ID, null, apiToken);
      state.twitch.connected = true;
      wheelManager = new WheelManager(state);

      // Start polling stream state (viewer count, ads, stream info)
      streamStateManager.startPolling();

      // Connect to IRC chat
      chatManager.connect(displayName, apiToken).catch(err => {
        console.error('[IRC Connect]', err.message);
      });

      console.log('[Twitch] Token saved, connected as:', displayName);
      saveTwitchData();

      res.json({ success: true, message: 'Token saved', displayName });
    } catch (err) {
      console.error('[Twitch] Token error:', err.message);
      res.status(500).json({ error: err.message });
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

    saveTwitchData();
    broadcast(bridgeClients, { type: 'full_state', data: state });

    res.json({ success: true, message: 'Disconnected' });
  });

  // OAuth callback (TODO: implement full OAuth flow)
  app.get('/oauth/twitch/callback', (req, res) => {
    const { code, error } = req.query;
    if (error) {
      res.send(`<h1>❌ OAuth Error</h1><p>${error}</p><p><a href="http://localhost:3000">Back to control panel</a></p>`);
      return;
    }

    if (!code) {
      res.send(`<h1>❌ No authorization code</h1><p><a href="http://localhost:3000">Back to control panel</a></p>`);
      return;
    }

    // TODO: Exchange code for access token using Client ID + Secret
    // For now, show the user what to do
    res.send(`
      <h1>✅ Authorization Successful</h1>
      <p>Your authorization code:</p>
      <code style="display:block; padding:12px; background:#f0f0f0; margin:12px 0;">${code}</code>
      <p>Full OAuth exchange not yet implemented. You can:</p>
      <ol>
        <li>Use an online tool like <a href="https://twitchtokengenerator.com/" target="_blank">TwitchTokenGenerator</a></li>
        <li>Or manually exchange this code for a token using your Client ID + Secret</li>
        <li>Then paste the access token in the "Paste Token" field</li>
      </ol>
      <p><a href="http://localhost:3000">Back to control panel</a></p>
      <script>window.close();</script>
    `);
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

  // GET /api/oauth/twitch/callback - Handle Twitch OAuth callback
  app.get('/api/oauth/twitch/callback', async (req, res) => {
    const { code, state: oauthState, error, error_description } = req.query;

    console.log('[OAuth Callback]', { code: !!code, state: oauthState, error });

    if (error) {
      return res.json({ error, description: error_description });
    }

    if (!code || !oauthState) {
      return res.status(400).json({ error: 'Missing code or state' });
    }

    // Get or create session (allows client-side temp session IDs)
    let session = oauthSessions.get(oauthState);
    if (!session) {
      const expiresAt = Date.now() + 15 * 60 * 1000;
      session = { state: oauthState, accessToken: null, expiresAt };
      oauthSessions.set(oauthState, session);
      console.log('[OAuth] Auto-created session for state:', oauthState);
    }

    if (Date.now() > session.expiresAt) {
      oauthSessions.delete(oauthState);
      return res.status(401).json({ error: 'Session expired' });
    }

    try {
      // Exchange code for access token
      const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: {
          client_id: TWITCH_CLIENT_ID,
          client_secret: process.env.TWITCH_CLIENT_SECRET || '',
          code,
          grant_type: 'authorization_code',
          redirect_uri: 'http://localhost:3000/api/oauth/twitch/callback'
        }
      });

      const tokenData = tokenRes.data;
      const accessToken = tokenData.access_token;

      if (!accessToken) {
        return res.status(400).json({ error: 'No access token in response' });
      }

      // Get user info
      const userRes = await axios.get('https://api.twitch.tv/helix/users', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Client-ID': TWITCH_CLIENT_ID
        }
      });

      const userData = userRes.data;
      const user = userData.data?.[0];

      if (!user) {
        return res.status(400).json({ error: 'No user data' });
      }

      // Store token in session
      session.accessToken = accessToken;
      session.refreshToken = tokenData.refresh_token || null;
      session.displayName = user.login;
      session.channelId = user.id;
      session.profilePicture = user.profile_image_url || '';

      console.log('[OAuth] Token stored for:', user.login);

      // Apply token directly to state and broadcast — in Electron, window.open() is
      // intercepted and opens in the external browser, so the control panel never gets
      // a return value from window.open() and can't poll. Broadcasting here means the
      // control panel UI updates the moment the external browser completes the OAuth flow.
      try {
        state.twitch.apiToken = accessToken;
        state.twitch.refreshToken = tokenData.refresh_token || '';
        state.twitch.displayName = user.login;
        state.twitch.channelId = user.id;
        state.twitch.profilePicture = user.profile_image_url || '';
        state.twitch.connected = true;
        twitchClient = new TwitchClient(TWITCH_CLIENT_ID, null, accessToken);
        wheelManager = new WheelManager(state);
        if (streamStateManager && typeof streamStateManager.startPolling === 'function') streamStateManager.startPolling();
        chatManager.connect(user.login, accessToken).catch(err => console.error('[IRC Connect]', err.message));
        saveTwitchData();
        scheduleTokenRefresh();
        broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
        console.log('[OAuth] State applied and broadcast for:', user.login);
      } catch (applyErr) {
        console.error('[OAuth] Failed to auto-apply token:', applyErr.message);
      }

      // Return a pretty success page that auto-closes
      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>✅ Connected to Twitch</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
            }
            .container {
              background: white;
              border-radius: 16px;
              padding: 48px;
              text-align: center;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              max-width: 400px;
            }
            .checkmark {
              width: 80px;
              height: 80px;
              margin: 0 auto 24px;
              background: #10b981;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 48px;
              animation: scaleIn 0.5s ease-out;
            }
            @keyframes scaleIn {
              0% { transform: scale(0); }
              100% { transform: scale(1); }
            }
            h1 {
              color: #1f2937;
              font-size: 28px;
              margin-bottom: 12px;
            }
            .username {
              color: #667eea;
              font-size: 20px;
              font-weight: 600;
              margin-bottom: 24px;
            }
            .message {
              color: #6b7280;
              font-size: 16px;
              line-height: 1.5;
              margin-bottom: 24px;
            }
            .closing {
              color: #9ca3af;
              font-size: 14px;
              animation: fadeIn 1s ease-out 2s both;
            }
            @keyframes fadeIn {
              0% { opacity: 0; }
              100% { opacity: 1; }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="checkmark">✓</div>
            <h1>Connected to Twitch!</h1>
            <div class="username">@${user.login}</div>
            <div class="message">
              Your Twitch account has been successfully connected to NE Broadcast Suite.
            </div>
            <div class="closing">
              Closing this window...
            </div>
          </div>
          <script>
            // Close window after 2 seconds
            setTimeout(() => window.close(), 2000);
          </script>
        </body>
        </html>
      `);
    } catch (err) {
      console.error('[OAuth Callback]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
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

  // Prediction creation
  app.post('/api/twitch/prediction/settings', (req, res) => {
    const { autoCreate, template, cooldown, overlayLoop } = req.body;
    if (typeof autoCreate === 'boolean') state.twitch.predictions.settings.autoCreate = autoCreate;
    if (template) state.twitch.predictions.settings.template = template;
    if (typeof cooldown === 'number') state.twitch.predictions.settings.cooldown = cooldown;
    if (typeof overlayLoop === 'number') state.twitch.predictions.settings.overlayLoop = overlayLoop;
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
      const result = await predictionManager.resolvePrediction(outcomeId);
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

  // Prediction cancel
  app.post('/api/twitch/prediction/cancel', async (req, res) => {
    if (!predictionManager) return res.status(400).json({ error: 'Twitch not connected' });
    if (!state.twitch.predictions.current) return res.status(400).json({ error: 'No active prediction' });
    try {
      stopPredictionPolling();
      await predictionManager.cancelPrediction();
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
    const { type, question, answers, options, prizes } = req.body;
    console.log(`[Twitch] Create mini-game: ${type}`);

    if (!miniGameManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    try {
      let game;
      if (type === 'trivia') {
        if (!question || !answers || answers.length < 2) {
          return res.status(400).json({ error: 'Trivia requires question and at least 2 answers' });
        }
        const correctIdx = Math.floor(Math.random() * answers.length);
        game = miniGameManager.createTrivia(question, answers, correctIdx);
      } else if (type === 'prediction' || type === 'vote') {
        if (!question || !options || options.length < 2) {
          return res.status(400).json({ error: 'Vote requires question and at least 2 options' });
        }
        game = type === 'prediction'
          ? miniGameManager.createPrediction(question, options)
          : miniGameManager.createVote(question, options);
      } else if (type === 'spin') {
        if (!prizes || prizes.length < 2) {
          return res.status(400).json({ error: 'Spin requires at least 2 prizes' });
        }
        game = miniGameManager.createSpin(prizes);
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
          miniGameManager.finalize();
          broadcast(bridgeClients, { type: 'full_state', data: state });
          saveTwitchData();
          console.log('[Twitch] Game auto-finalized:', gameId);
        }
        gameTimers.delete(gameId);
      }, duration);

      gameTimers.set(gameId, timer);

      broadcast(bridgeClients, { type: 'full_state', data: state });
      saveTwitchData();

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
        broadcast(bridgeClients, { type: 'full_state', data: state });
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
      const result = miniGameManager.finalize();

      broadcast(bridgeClients, { type: 'full_state', data: state });
      saveTwitchData();

      res.json({
        success: true,
        result
      });
    } catch (err) {
      console.error('[Twitch] Game finalization failed:', err.message);
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
  app.post('/api/twitch/shoutout', async (req, res) => {
    if (!twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { login } = req.body;
    if (!login) return res.status(400).json({ error: 'login required' });
    try {
      const user = await twitchClient.getUserByLogin(login);
      if (!user) return res.status(404).json({ error: `User not found: ${login}` });
      console.log('[Twitch] Sending shoutout to:', login, user.id);
      await twitchClient.sendShoutout(state.twitch.channelId, user.id, state.twitch.channelId);
      res.json({ success: true, userId: user.id, displayName: user.display_name });
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
  twitchDataFile = path.join(dataDir, 'twitch-data.json');

  fs.mkdirSync(dataDir, { recursive: true });
  stats.init(dataDir);
  loadTeams();
  loadState();
  resetRlGameTrack();
  loadFacecams();
  loadPresets();
  loadBrandKits();
  loadTwitchData();

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
      console.log('[Twitch] Initialized (predictions, wheel, minigames, chat parsing enabled)');
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

  if (state.startgg.queueEnabled && startggApiToken && state.startgg.tournamentSlug) {
    setStartggQueuePolling(true);
  }


  // AI Auto-Director + clip system
  directorEngine = createDirectorEngine({
    dataDir,
    getActiveGame: () => state.activeGame,
    getBroadcastState: () => state,
    onEvents: onDirectorEvents,
    onPrimaryChange: (out) => {
      if (!out.autoSwitch || !out.primary) return;
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
    this.maxTotalCost = 10; // Hard limit from Twitch
    this.subscriptionIds = new Set(); // Track all subscription IDs for deduplication
    this.retryQueue = [];
    this.rateLimitResetTime = 0;
    this.rateLimitRemaining = 120;
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

  // Register for an EventSub subscription
  async subscribe(eventType, accessToken, channelId, condition = {}) {
    if (!state.twitch.apiToken) {
      console.error('[EventSub] Cannot subscribe: No Twitch token');
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
        version: '1',
        condition: { broadcaster_user_id: channelId, ...condition },
        transport: {
          method: 'webhook',
          callback: this.webhookUrl,
          secret: this.webhookSecret
        }
      };

      const response = await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', body, {
        headers: {
          'Authorization': `Bearer ${state.twitch.apiToken}`,
          'Client-ID': process.env.TWITCH_CLIENT_ID,
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
      console.error('[EventSub] Subscription failed:', eventType, err.response?.data || err.message);
      if (err.response?.status === 429) {
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
      'channel.channel_points_custom_reward_redemption': 1,
      'channel.hype_train.begin': 1,
      'channel.hype_train.progress': 1,
      'channel.hype_train.end': 1,
      'clip.create': 1
    };
    return costs[eventType] || 1;
  }

  // Subscribe to all recommended event types
  async subscribeToAll(channelId) {
    const eventTypes = [
      'stream.online',
      'stream.offline',
      'channel.follow',
      'channel.subscribe',
      'channel.raid',
      'channel.channel_points_custom_reward_redemption',
      'channel.hype_train.begin',
      'channel.hype_train.progress',
      'channel.hype_train.end'
    ];

    const results = [];
    for (const eventType of eventTypes) {
      const sub = await this.subscribe(eventType, state.twitch.apiToken, channelId);
      if (sub) results.push({ eventType, success: true });
      else results.push({ eventType, success: false });
      await new Promise(r => setTimeout(r, 200)); // Rate limit spacing
    }
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
        break;

      case 'stream.offline':
        state.twitch.isLive = false;
        broadcast(bridgeClients, { type: 'twitch_stream_offline', data });
        break;

      case 'channel.follow':
        broadcast(bridgeClients, { type: 'twitch_follow', data: { user: data.user_name, timestamp: data.followed_at } });
        chatManager.onFollow(data.user_name);
        break;

      case 'channel.subscribe':
        broadcast(bridgeClients, { type: 'twitch_subscribe', data: { user: data.user_name, tier: data.tier } });
        chatManager.onSubscribe(data.user_name, data.tier);
        break;

      case 'channel.raid':
        broadcast(bridgeClients, { type: 'twitch_raid', data: { from: data.from_broadcaster_user_login, viewers: data.viewers } });
        chatManager.onRaid(data.from_broadcaster_user_login, data.viewers);
        break;

      case 'channel.channel_points_custom_reward_redemption':
        broadcast(bridgeClients, { type: 'twitch_channel_points', data: { user: data.user_name, reward: data.reward.title, status: data.status } });
        break;

      case 'channel.hype_train.begin':
        broadcast(bridgeClients, { type: 'twitch_hype_train_begin', data });
        break;

      case 'channel.hype_train.progress':
        broadcast(bridgeClients, { type: 'twitch_hype_train_progress', data });
        break;

      case 'channel.hype_train.end':
        broadcast(bridgeClients, { type: 'twitch_hype_train_end', data });
        break;

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
    this.botName = 'namelessbot';
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
          host: 'irc-ws.chat.twitch.tv',
          port: 6697,
          rejectUnauthorized: false
        }, () => {
          console.log('[IRC] Connected to Twitch chat server');
          // NICK must match the account that owns the OAuth token
          this.send(`PASS oauth:${oauthToken}`);
          this.send(`NICK ${this.channelName}`);
          this.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
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
        if (typeof _resolve === 'function') _resolve();
        console.log('[IRC] Authenticated and joined #' + this.channelName);
        continue;
      }
      // Login failed
      if (line.includes('Login authentication failed') || line.includes('NOTICE * :Error')) {
        console.error('[IRC] Auth failed:', line);
        this.isConnected = false;
        state.twitch.chatConnected = false;
        this.ircSocket?.destroy();
        continue;
      }
      if (line.includes('PRIVMSG')) {
        this.handleChatMessage(line);
      }
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

    if (eventTypes && Array.isArray(eventTypes)) {
      for (const eventType of eventTypes) {
        const sub = await eventSubService.subscribe(eventType, state.twitch.apiToken, channelId);
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

// Set webhook URL for EventSub (using ngrok or public URL)
const EVENTSUB_WEBHOOK_URL = process.env.EVENTSUB_WEBHOOK_URL || 'http://localhost:3000/api/twitch/eventsub/webhook';
const EVENTSUB_WEBHOOK_SECRET = process.env.EVENTSUB_WEBHOOK_SECRET || 'broadcast-studio-secret-' + Math.random().toString(36).substring(7);
eventSubService.setWebhookConfig(EVENTSUB_WEBHOOK_URL, EVENTSUB_WEBHOOK_SECRET);

// ─── Stream State API Endpoints ──────────────────────────────────────────────

// GET /api/twitch/stream/state - Get current stream state (viewer count, live status, title, game)
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

} // ── end registerTwitchEventSubRoutes ──

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
module.exports.shutdown = function () {
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
