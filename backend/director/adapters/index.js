const cs2 = require('./cs2');
const rl = require('./rl');
const { wrapForGame } = require('./generic');

const DEDICATED = {
  csgo: cs2,
  'rocket-league': rl
};

const genericCache = {};

function getAdapter(gameId) {
  if (DEDICATED[gameId]) return DEDICATED[gameId];
  if (!gameId) return null;
  if (!genericCache[gameId]) genericCache[gameId] = wrapForGame(gameId);
  return genericCache[gameId];
}

function listAdapterGames() {
  return [...Object.keys(DEDICATED), ...Object.keys(genericCache)];
}

function resetAll() {
  Object.values(DEDICATED).forEach((a) => a.reset && a.reset());
  Object.values(genericCache).forEach((a) => a.reset && a.reset());
}

module.exports = { getAdapter, listAdapterGames, resetAll, DEDICATED, createAdapter: require('./sdk').createAdapter };