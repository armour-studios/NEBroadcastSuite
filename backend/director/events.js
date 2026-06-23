/**
 * Common event model for the auto-director.
 * { type, game, target:{kind, id, name}, priority, reason, gameTime, ttl, ts }
 */

function makeEvent({ type, game, target, priority, reason, gameTime, ttl = 8000 }) {
  return {
    type,
    game,
    target: target || { kind: 'area', id: 'action', name: 'Action' },
    priority: priority ?? 50,
    reason: reason || type,
    gameTime: gameTime ?? null,
    ttl,
    ts: Date.now()
  };
}

function targetPlayer(id, name) {
  return { kind: 'player', id: String(id), name: name || '?' };
}

function targetBall() {
  return { kind: 'ball', id: 'ball', name: 'Ball' };
}

function targetArea(id, name) {
  return { kind: 'area', id: id || 'site', name: name || 'Site' };
}

function isExpired(event, now = Date.now()) {
  return now - event.ts > (event.ttl || 8000);
}

function pruneEvents(events, now = Date.now()) {
  return events.filter((e) => !isExpired(e, now));
}

module.exports = { makeEvent, targetPlayer, targetBall, targetArea, isExpired, pruneEvents };