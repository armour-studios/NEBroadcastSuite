/**
 * Storyline weighting — series context, match point, comeback, spotlight.
 * Pure functions; no game knowledge.
 */

function getStorylineBoost(event, ctx) {
  if (!ctx) return 0;
  let boost = 0;

  const series = ctx.series || {};
  const game = ctx.game || {};
  const bestOf = ctx.bestOf || 5;
  const blue = series.blue || 0;
  const orange = series.orange || 0;
  const winsNeeded = Math.ceil(bestOf / 2);

  const blueMatchPoint = blue === winsNeeded - 1;
  const orangeMatchPoint = orange === winsNeeded - 1;
  const isMatchPoint = blueMatchPoint || orangeMatchPoint;

  if (isMatchPoint) {
    boost += 12;
    if (['goal', 'ace', 'clutch', 'round_win'].includes(event.type)) boost += 8;
  }

  const bScore = game.blueScore || 0;
  const oScore = game.orangeScore || 0;
  const diff = Math.abs(bScore - oScore);
  if (diff === 1 && (bScore + oScore) >= 3) boost += 6;

  const spotlight = ctx.spotlight?.playerName;
  if (spotlight && event.target?.name === spotlight) boost += 10;

  const starIds = ctx.starPlayerIds || [];
  if (event.target?.id && starIds.includes(String(event.target.id))) boost += 8;
  if (event.target?.name && (ctx.starPlayerNames || []).includes(event.target.name)) boost += 8;

  if (ctx.comebackTeam) {
    const t = event.target?.team ?? event.target?.teamNum;
    if (t != null && String(t) === String(ctx.comebackTeam)) boost += 7;
  }

  return boost;
}

function buildStorylineContext(state) {
  if (!state) return {};
  const series = state.series || {};
  const game = state.game || {};
  const spotlight = state.spotlight || {};
  const starPlayerNames = [];
  if (spotlight.visible && spotlight.playerName) starPlayerNames.push(spotlight.playerName);
  if (state.spectatedPlayer) starPlayerNames.push(state.spectatedPlayer);

  const players = state.players || state.csgo?.players || [];
  const starPlayerIds = players
    .filter((p) => (p.score || 0) >= 300 || (p.kills || 0) >= 15)
    .map((p) => String(p.steamid || p.primaryid || p.name))
    .filter(Boolean);

  let comebackTeam = null;
  const b = game.blueScore || 0;
  const o = game.orangeScore || 0;
  if (b >= 2 && o === 0) comebackTeam = '1';
  if (o >= 2 && b === 0) comebackTeam = '0';

  return {
    series,
    game,
    bestOf: state.bestOf,
    spotlight,
    starPlayerIds,
    starPlayerNames,
    comebackTeam
  };
}

module.exports = { getStorylineBoost, buildStorylineContext };