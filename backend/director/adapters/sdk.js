/**
 * Adapter SDK — implement these three functions for any game feed.
 *
 *   extractEvents(prevState, curState) -> DirectorEvent[]
 *   getBaseline(curState) -> DirectorEvent | null
 *   onUpdate(curState) -> DirectorEvent[]   (optional wrapper with snapshot diff)
 *
 * Use createAdapter() for a ready-made diff-based adapter.
 */

const { makeEvent, targetPlayer, targetBall, targetArea } = require('../events');

function createAdapter({ gameId, gameLabel, priority = {}, extractEvents, getBaseline, onDiscreteEvent }) {
  let prevSnapshot = null;

  function snapshot(state) {
    return state;
  }

  function onUpdate(state) {
    const events = extractEvents(prevSnapshot, state);
    prevSnapshot = snapshot(state);
    return events;
  }

  function reset() {
    prevSnapshot = null;
  }

  return {
    id: gameId,
    gameId,
    gameLabel: gameLabel || gameId,
    PRIORITY: priority,
    extractEvents,
    getBaseline: getBaseline || (() => null),
    onDiscreteEvent: onDiscreteEvent || null,
    onUpdate,
    reset
  };
}

module.exports = { createAdapter, makeEvent, targetPlayer, targetBall, targetArea };