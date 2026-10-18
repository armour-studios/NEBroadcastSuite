'use strict';
// One table for the shape of the app's state: for every top-level key of `state` (server.js), how it
// is broadcast and whether / how it is saved to state.json and restored at launch.
//
//   tier  'live'    rides EVERY broadcast. Keep it small: no base64, no libraries.
//         'library' heavy / rarely-changing; travels via libraryData() (on connect + on change,
//                   gated by librarySig — a new library key MUST also be signed).
//         'local'   server-only; never broadcast.
//         null      not declared: still broadcast, but the server warns once (the tripwire that
//                   stops payload bloat creeping in; the old spread-then-denylist once put
//                   ~600KB on every broadcast).
//   save  'plain'   written as-is by buildSaveSnapshot() (generated from this table)
//         'custom'  buildSaveSnapshot() has a serializer for it (trims, drops live fields)
//         false     runtime only, never saved
//   load  'typed'   restored by restoreTyped() when the saved value has the default's type
//         'custom'  loadState() restores and validates it
//
// Adding a setting: give it a default in `state`, then one line here. A plain string / number /
// boolean setting needs nothing else: S('live', 'plain', 'typed') saves and restores it.
// test/state-schema.test.js fails on a state key missing from this table, and
// test/persist-roundtrip.test.js on any saved value that does not survive a restart.
const S = (tier, save, load) => ({ tier, save, load: load || null });

const STATE_SCHEMA = {
  version: S('live', false),
  view: S('live', false),
  rlHudHidden: S('live', false),
  rlReplayTransitions: S('live', 'plain', 'typed'),
  rlSponsorRoll: S('live', 'plain', 'typed'),
  worldsSidebar: S('live', 'plain', 'custom'),
  worldsTicker: S('live', 'plain', 'typed'),
  rlScoreboardSeparate: S('live', 'plain', 'typed'),
  perfMode: S('live', 'custom', 'custom'),
  orgLibrary: S('live', 'custom', 'custom'),
  activeGame: S('live', 'plain', 'custom'),
  pulse: S('live', 'plain', 'custom'),
  matchTitles: S('live', 'custom', 'custom'),
  themesByGame: S('live', 'plain', 'custom'),
  eventName: S('live', 'plain', 'typed'),
  eventNameSlug: S('live', 'custom', 'custom'),
  gameLabel: S('live', 'plain', 'typed'),
  roundLabel: S('live', 'plain', 'typed'),
  dateFormat: S('live', 'custom', 'custom'),
  speedUnit: S('live', 'plain', 'custom'),
  fontFamily: S('live', 'plain', 'custom'),
  clock24h: S('live', 'plain', 'typed'),
  followSetGame: S('live', 'custom', 'custom'),
  showSeries: S('live', 'plain', 'typed'),
  defaultBestOf: S('live', 'plain', 'typed'),
  facecamsEnabled: S('live', 'plain', 'custom'),
  replayCams: S('live', 'plain', 'custom'),
  lanSeats: S('live', 'custom', 'custom'),
  activeBrandKitId: S('live', 'plain', 'custom'),
  useBrandColors: S('live', 'plain', 'custom'),
  colorMode: S('live', 'plain', 'custom'),
  sceneBg: S('live', 'custom', 'custom'),
  banner: S('live', 'plain', 'custom'),
  credits: S('live', 'plain', 'custom'),
  casters: S('live', 'plain', 'custom'),
  vdo: S('live', 'plain', 'custom'),
  listenIn: S('live', false),
  breakScreen: S('live', 'custom', 'custom'),
  ticker: S('live', 'plain', 'custom'),
  competition: S('live', 'plain', 'custom'),
  compFeed: S('live', false),
  compSync: S('live', false),
  cloudCompetitions: S('library', false),   // website competition picker list — panel only
  cloudEventsMeta: S('library', false),
  customOverlayRevs: S('live', false),
  adProofSessions: S('library', 'custom', 'custom'),
  spotlight: S('live', false),
  winner: S('live', 'custom', 'custom'),
  veto: S('live', 'custom', 'custom'),
  owMatch: S('live', 'custom', 'custom'),
  mrMatch: S('live', 'custom', 'custom'),
  r6: S('live', 'custom', 'custom'),
  bedwars: S('live', 'custom', 'custom'),
  customOverlayLayouts: S('live', 'custom', 'custom'),
  gameConfigs: S('live', 'custom', 'custom'),
  gameConfigVersions: S('library', 'custom', 'custom'),
  gameConfigFrom: S('live', 'custom', 'custom'),
  pointMatrices: S('live', 'custom', 'custom'),
  draft: S('live', false),
  intro: S('live', 'custom', 'custom'),
  overtime: S('live', 'plain', 'custom'),
  replay: S('library', 'custom', 'custom'),
  scoreboardAd: S('live', 'plain', 'custom'),
  rlStatsScreen: S('live', 'plain', 'custom'),
  seriesStats: S('live', 'plain', 'custom'),
  background: S('live', 'plain', 'custom'),
  deskFooter: S('live', 'plain', 'custom'),
  preshow: S('live', 'plain', 'custom'),
  dota: S('live', 'custom', 'custom'),   // Dota 2 GSI: settings + the latest parsed frame (10 players, ~6KB)
  csgo: S('live', false),
  valorant: S('live', false),
  lol: S('live', false),
  apex: S('live', 'custom', 'custom'),
  br: S('live', 'custom', 'custom'),
  bestOf: S('live', 'plain', 'custom'),
  teams: S('live', 'plain', 'custom'),
  teamPlayers: S('live', false),
  series: S('live', 'plain', 'custom'),
  activePlayer: S('live', 'plain', 'custom'),
  observedPlayer: S('live', 'plain', 'custom'),
  smash: S('live', 'plain', 'custom'),
  brawlhalla: S('live', 'plain', 'custom'),
  tokon: S('live', 'plain', 'custom'),
  match: S('live', 'plain', 'custom'),
  leagues: S('library', 'plain', 'custom'),
  myEvents: S('library', 'plain', 'custom'),
  eventOps: S('library', 'plain', 'custom'),
  playerProfiles: S('library', 'custom', 'custom'),
  teamVault: S('live', 'custom', 'custom'),
  game: S('live', 'custom', 'custom'),
  gameTeams: S('live', false),
  players: S('live', false),
  playerCache: S('live', false),
  currentGoal: S('live', false),
  spectatedPlayer: S('live', false),
  rlConnected: S('live', false),
  rlStale: S('live', false),
  rlReplayLenMs: S('live', 'custom', 'custom'),
  rlSpectatorUi: S('live', 'custom', 'custom'),
  rlLastTouch: S('live', false),
  rlPaused: S('live', false),
  startgg: S('live', 'plain', 'custom'),
  ballchasing: S('live', 'plain', 'custom'),
  liquipedia: S('live', 'custom', 'custom'),
  riot: S('live', 'custom', 'custom'),
  challonge: S('live', 'custom', 'custom'),
  nxgen: S('live', 'custom', 'custom'),
  challengermode: S('live', 'custom', 'custom'),
  challengermodePlacements: S('live', false),
  challongePlacements: S('live', false),
  faceit: S('live', 'custom', 'custom'),
  sheets: S('live', 'custom', 'custom'),
  activeEvent: S('live', 'plain', 'custom'),
  obsStinger: S('live', 'plain', 'custom'),
  obs: S('live', 'custom', 'custom'),
  vmix: S('live', 'custom', 'custom'),
  switcher: S('live', 'custom', 'custom'),
  commercial: S('live', false),
  chatHighlight: S('live', false),
  multichat: S('live', false),
  questions: S('library', false),
  marbleRace: S('live', false),
  bracket: S('library', 'plain', 'custom'),
  upcoming: S('live', 'plain', 'custom'),
  startggPlacements: S('live', false),
  startggCharacters: S('live', false),
  standings: S('live', 'plain', 'custom'),
  leagueStats: S('live', false),
  leagueCapture: S('live', false),
  siteEvent: S('live', 'plain', 'custom'),
  leagueLeaderboard: S('live', false),
  teamRecord: S('live', 'plain', 'custom'),
  autoTeamsFromGame: S('live', 'plain', 'typed'),
  startggLeagueStandings: S('live', 'plain', 'custom'),
  gfxActive: S('live', false),
  scenePresets: S('local', 'custom', 'custom'),
  watchlist: S('live', 'plain', 'custom'),
  teamSpotlight: S('live', 'plain', 'custom'),
  director: S('live', 'custom', 'custom'),
  ai: S('live', 'custom', 'custom'),
  clips: S('library', 'custom', 'custom'),
  encode: S('live', false),
  chatCommands: S('live', 'plain', 'custom'),
  twitch: S('live', false),
  discord: S('live', false),
  flows: S('live', 'custom', 'custom'),
  flowVars: S('live', false),
};

// Keys buildLiveState() adds to the broadcast payload on top of `state` (computed, never saved).
const DERIVED_TIERS = {
  brand: 'library',
  customOverlays: 'library',   // Overlays ▸ Builder: the list (names only; layouts load on request)
  cloudRole: 'live',
  cloudHealth: 'live',
  cloudLoops: 'live',
  crew: 'live',   // also in libraryData — overlays read it live, panel backfills it
  awaitingKickoff: 'live',
  inReplay: 'live',
  otTriggered: 'live',
  rlBall: 'live',
  scoreboard: 'live',
  showRoster: 'live',
  sponsorBanner: 'live',
  preshowPresets: 'live',
  playerProfilesVer: 'live',
  games: 'live',
  vetoPools: 'live',
  vetoMeta: 'live',
  draftGames: 'live',
  theme: 'live',
  brMeta: 'live',
  activeOverlay: 'live',
  overlayLayout: 'live',
  presets: 'live',
  facecams: 'live',
  formattedTime: 'live',
  teamRecords: 'live',
  leagueStandings: 'live',
  flowFireLog: 'live',
  autoLog: 'live',
  overlays: 'live',
  sceneConfig: 'live',
  streamdeck: 'live',   // { connected } for the Apps page Stream Deck card
  pollFailures: 'live',
  lanHost: 'live',
  rundownStatus: 'live',   // tiny current/next labels the Stream Deck rundown keys show
};

// Saved alongside the state keys but not state keys themselves (secrets, prefs kept elsewhere):
// written by buildSaveSnapshot()'s serializers and read back by loadState().
const SAVED_EXTRA = [
  'draftAuto', 'draftLook', 'lolHudMode', 'lolOcr', 'bedwarsToken', 'startggApiToken',
  'challengermodeRefreshKey', 'challongeApiKey', 'nxgenApiKey', 'liquipediaApiKey', 'riotApiKey', 'apexStatsToken',
  'liquipediaBudget', 'liquipediaCache', 'faceitApiKey', 'ballchasingApiKey',
  'sheetsServiceAccount', 'competitionApiKey', 'competitionFeedTokens', 'obsPassword',
  'slobsToken', 'brand', 'preshowPresets', 'csgoCfgPath', 'csgoAutoWinner', 'csgoShowHistory',
  'csgoBuiltinRadar', 'csgoProLayout', 'csgoAutoHud', 'csgoObserverAssist', 'csgoRadarLayout',
  'csgoCinematic', 'crew'
];

// tier per broadcast key (state keys + derived keys)
function broadcastTiers() {
  const t = {};
  for (const [k, v] of Object.entries(STATE_SCHEMA)) if (v.tier) t[k] = v.tier;
  return Object.assign(t, DERIVED_TIERS);
}
// The as-is part of the saved snapshot.
function plainSnapshot(state) {
  const out = {};
  for (const [k, v] of Object.entries(STATE_SCHEMA)) if (v.save === 'plain') out[k] = state[k];
  return out;
}
// Restore every 'typed' key whose saved value has the same type as its default.
function restoreTyped(state, saved) {
  for (const [k, v] of Object.entries(STATE_SCHEMA)) {
    if (v.load !== 'typed' || saved[k] === undefined) continue;
    if (typeof saved[k] === typeof state[k]) state[k] = saved[k];
  }
}

module.exports = { STATE_SCHEMA, DERIVED_TIERS, SAVED_EXTRA, broadcastTiers, plainSnapshot, restoreTyped };
