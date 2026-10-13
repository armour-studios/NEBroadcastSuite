// Saved settings that persist-roundtrip.test.js may see change across a restart, and why.
// The test changes every saved value; these are the ones loadState() deliberately validates,
// derives or resets. Anything NOT listed here that fails to come back is a real loss.
const ENUM = 'validated against a fixed list of choices (the test writes an invalid value)';
const HIDDEN = 'graphics always come back hidden after a restart (never on air at boot)';
const STATUS = 'live status, recomputed at runtime';
module.exports = {
  activeGame: ENUM, 'themesByGame.rocket-league': ENUM, 'themesByGame.csgo': ENUM, colorMode: ENUM,
  'worldsSidebar.source': ENUM, 'seriesStats.design': ENUM, speedUnit: ENUM, 'perfMode.broadcastRate': ENUM,
  'casters.nameMode': ENUM, 'ticker.source': ENUM, 'draftLook.layout': ENUM, 'draftLook.stripPos': ENUM,
  'dota.radiantSide': ENUM, lolHudMode: ENUM, 'br.game': ENUM, 'br.scoringPreset': ENUM,
  'replay.colorMode': ENUM, 'replay.style': ENUM, 'rlStatsScreen.design': ENUM, 'winner.style': ENUM,
  'intro.side': ENUM, 'owMatch.format': ENUM, 'owMatch.seriesLabel': ENUM, 'observedPlayer.side': ENUM,
  'smash.mode': ENUM, 'smash.railPos': ENUM, 'brawlhalla.mode': ENUM, 'brawlhalla.rankMode': ENUM,
  'brawlhalla.region': ENUM, 'brawlhalla.railPos': ENUM, 'tokon.railPos': ENUM, 'riot.region': ENUM,
  'riot.platform': ENUM, 'faceit.competitionType': ENUM, 'obs.app': ENUM, 'switcher.target': ENUM,
  csgoProLayout: ENUM, 'clips.captureMode': ENUM, dateFormat: ENUM, 'background.type': ENUM, 'preshow.predictions': 'each pick is "", "blue" or "orange"',
  'observedPlayer.playerId': 'only kept with a valid side',
  'credits.visible': HIDDEN, 'watchlist.visible': HIDDEN, 'teamSpotlight.visible': HIDDEN,
  'upcoming.visible': HIDDEN, 'standings.visible': HIDDEN, 'br.dropmap.visible': HIDDEN,
  'intro.showFooter': 'always reset to off (opt-in each show)',
  'clips.autoCapture': 'derived from captureMode',
  'br.format.teamSize': 'derived from the format id',
  'br.leagueId': 'cleared when that league no longer exists', 'br.seriesId': 'cleared with its league',
  'smash.blue.players': 'resized and clamped to the saved crew size / starting stocks',
  'smash.orange.players': 'resized and clamped to the saved crew size / starting stocks',
  'smash.blue.characters': 'resized to the saved crew size', 'smash.orange.characters': 'resized to the saved crew size',
  'tokon.layoutV': 'layout version: only the current version restores its layout',
  'tokon.layout': 'restored only for the current layout version',
  rlReplayLenMs: 'only a measured length between 3 and 15 seconds is kept',
  'startgg.connected': STATUS, 'startgg.streamOffQueue': STATUS, 'siteEvent.lastReport': STATUS,
  'brawlhalla.lastError': STATUS, 'brawlhalla.lastLookupAt': STATUS,
  'lanSeats.agent.token': 'pairing token, regenerated'
};
