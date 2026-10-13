// Top-level state keys that are NOT saved under their own name in buildSaveSnapshot(), and why.
// persist-roundtrip.test.js fails on any state key that is neither saved nor listed here, so a new
// setting can't be added to state and silently forgotten by the save.
const LIVE = 'live game / connection data, rebuilt at runtime';
module.exports = {
  // Saved under other names, or in their own files.
  draft: 'saved as draftAuto + draftLook (board look); the board itself is per show',
  csgo: 'settings saved as csgoCfgPath, csgoAutoWinner, csgoProLayout, …',
  lol: 'settings saved as lolHudMode + lolOcr',
  twitch: 'own file: twitch-data.json',
  discord: 'own file: discord-user.json',
  multichat: 'own file: multichat-data.json',
  questions: 'own file: questions-data.json',
  // Runtime only.
  version: 'the running app version', view: 'RL HUD view, follows the game',
  rlHudHidden: 'manual hide-HUD switch, deliberately not persisted',
  listenIn: 'who is being listened to right now',
  compFeed: LIVE, compSync: LIVE, cloudCompetitions: 'pulled from the website', cloudEventsMeta: 'pulled from the website',
  customOverlayRevs: 'per-session overlay revision counters',
  spotlight: 'on-air lower third content', commercial: 'an ad break in progress',
  chatHighlight: 'the chat message on air now', marbleRace: 'a race in progress',
  valorant: LIVE, teamPlayers: LIVE, gameTeams: LIVE, players: LIVE, playerCache: LIVE, currentGoal: LIVE,
  spectatedPlayer: LIVE, rlConnected: LIVE, rlStale: LIVE, rlLastTouch: LIVE, rlPaused: LIVE,
  challengermodePlacements: 'fetched placements', challongePlacements: 'fetched placements',
  startggPlacements: 'fetched placements', startggCharacters: 'fetched characters',
  leagueStats: 'recomputed from leagues', leagueCapture: 'a capture in progress', leagueLeaderboard: 'recomputed from leagues',
  gfxActive: 'which graphic is on air (graphics come back hidden)', encode: 'an encode in progress',
  flowVars: 'automation variables for the running show'
};
