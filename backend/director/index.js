const { getAdapter, resetAll } = require('./adapters');
const { createDirectorCore } = require('./core');
const { createLearningStore } = require('./learning');
const { buildStorylineContext } = require('./storyline');

const TICK_MS = 250; // 4 Hz — low CPU

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {() => string} opts.getActiveGame
 * @param {(state: object) => void} opts.onUpdate
 */
function createDirectorEngine({ dataDir, getActiveGame, getBroadcastState, onUpdate, onPrimaryChange, onEvents }) {
  const learning = createLearningStore(dataDir);
  let lastBroadcast = '';
  let lastPrimaryKey = '';
  let pendingGame = null;
  let pendingState = null;
  let tickTimer = null;

  const core = createDirectorCore({
    learning,
    onStateChange: (out) => {
      const str = JSON.stringify(out);
      const pk = out.primary ? `${out.primary.type}:${out.primary.name}` : '';
      if (pk && pk !== lastPrimaryKey && onPrimaryChange) {
        lastPrimaryKey = pk;
        onPrimaryChange(out);
      }
      if (str !== lastBroadcast) {
        lastBroadcast = str;
        onUpdate(out);
      }
    }
  });

  function runTick() {
    const gameId = getActiveGame();
    const adapter = getAdapter(gameId);
    if (!adapter || !pendingState || pendingGame !== gameId) return;
    if (getBroadcastState) core.setStorylineContext(buildStorylineContext(getBroadcastState()));
    core.tick(adapter, pendingState);
  }

  function ensureTimer() {
    if (tickTimer) return;
    tickTimer = setInterval(runTick, TICK_MS);
  }

  function deliverEvents(gameId, events) {
    if (!events.length) return;
    core.ingestEvents(events);
    if (onEvents) onEvents(gameId, events);
  }

  function onGameUpdate(gameId, gameState) {
    const adapter = getAdapter(gameId);
    if (!adapter) return;
    if (getActiveGame() !== gameId) return;

    pendingGame = gameId;
    pendingState = gameState;
    ensureTimer();

    const events = adapter.onUpdate(gameState);
    deliverEvents(gameId, events);
  }

  function onDiscreteEvent(gameId, data) {
    const adapter = getAdapter(gameId);
    if (!adapter || getActiveGame() !== gameId) return;
    if (typeof adapter.onDiscreteEvent === 'function') {
      const events = adapter.onDiscreteEvent(data);
      deliverEvents(gameId, events);
    }
  }

  function setSettings(patch) {
    core.setSettings(patch);
  }

  function recordFeedback(payload) {
    learning.recordFeedback({
      game: getActiveGame(),
      eventType: payload.eventType,
      targetId: payload.targetId,
      action: payload.action,
      sensitivity: core.getSettings().sensitivity
    });
    core.tick(getAdapter(getActiveGame()), pendingState || {});
  }

  function reset() {
    resetAll();
    core.reset();
    pendingState = null;
    lastBroadcast = '';
    lastPrimaryKey = '';
  }

  function getState() {
    return core.getOutput();
  }

  function destroy() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  return {
    onGameUpdate,
    onDiscreteEvent,
    setSettings,
    recordFeedback,
    reset,
    getState,
    destroy
  };
}

module.exports = { createDirectorEngine };