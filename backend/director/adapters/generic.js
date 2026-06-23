/**
 * Generic adapter — works for any game using shared production state
 * (spotlight, series, scores, teams). Used until a game gets a live feed adapter.
 */

const { createAdapter, makeEvent, targetPlayer, targetArea } = require('./sdk');

const PRIORITY = {
  match_point: 85,
  series_lead: 70,
  spotlight: 75,
  comeback: 65,
  close_game: 55,
  break_soon: 40,
  baseline: 20
};

function extractEvents(prev, cur) {
  const events = [];
  const game = cur.game || {};
  const series = cur.series || {};
  const bestOf = cur.bestOf || 5;
  const winsNeeded = Math.ceil(bestOf / 2);

  const blueMP = (series.blue || 0) === winsNeeded - 1;
  const orangeMP = (series.orange || 0) === winsNeeded - 1;

  if ((blueMP || orangeMP) && !(prev?.series && (
    (prev.series.blue || 0) === winsNeeded - 1 ||
    (prev.series.orange || 0) === winsNeeded - 1
  ))) {
    const side = blueMP ? (cur.teams?.blue?.name || 'Team A') : (cur.teams?.orange?.name || 'Team B');
    events.push(makeEvent({
      type: 'match_point',
      game: cur._gameId || 'generic',
      target: targetArea('match_point', side),
      priority: PRIORITY.match_point,
      reason: `Match point — ${side}`,
      ttl: 30000
    }));
  }

  const b = game.blueScore || 0;
  const o = game.orangeScore || 0;
  if (Math.abs(b - o) === 1 && b + o >= 2) {
    const leader = b > o ? (cur.teams?.blue?.name || 'Blue') : (cur.teams?.orange?.name || 'Orange');
    events.push(makeEvent({
      type: 'close_game',
      game: cur._gameId || 'generic',
      target: targetArea('action', leader),
      priority: PRIORITY.close_game,
      reason: `Close game — ${leader} leads by 1`,
      ttl: 15000
    }));
  }

  const spot = cur.spotlight;
  if (spot?.visible && spot.playerName) {
    const prevSpot = prev?.spotlight?.playerName;
    if (spot.playerName !== prevSpot) {
      events.push(makeEvent({
        type: 'spotlight',
        game: cur._gameId || 'generic',
        target: targetPlayer(spot.playerName, spot.playerName),
        priority: PRIORITY.spotlight,
        reason: `Featured player — ${spot.playerName}`,
        ttl: 20000
      }));
    }
  }

  if (cur.breakScreen?.visible && cur.breakScreen?.endsAt) {
    const remaining = cur.breakScreen.endsAt - Date.now();
    if (remaining > 0 && remaining < 120000) {
      events.push(makeEvent({
        type: 'break_soon',
        game: cur._gameId || 'generic',
        target: targetArea('casters', 'Casters'),
        priority: PRIORITY.break_soon,
        reason: 'Break ending soon — prep return to game',
        ttl: 10000
      }));
    }
  }

  return events;
}

function getBaseline(cur) {
  const spot = cur.spotlight;
  if (spot?.visible && spot.playerName) {
    return makeEvent({
      type: 'baseline',
      game: cur._gameId || 'generic',
      target: targetPlayer(spot.playerName, spot.playerName),
      priority: PRIORITY.baseline + 10,
      reason: `Following ${spot.playerName}`,
      ttl: 4000
    });
  }
  const spec = cur.spectatedPlayer;
  if (spec) {
    return makeEvent({
      type: 'baseline',
      game: cur._gameId || 'generic',
      target: targetPlayer(spec, spec),
      priority: PRIORITY.baseline + 5,
      reason: `Following ${spec}`,
      ttl: 4000
    });
  }
  return makeEvent({
    type: 'baseline',
    game: cur._gameId || 'generic',
    target: targetArea('action', 'Action'),
    priority: PRIORITY.baseline,
    reason: 'Watch the action',
    ttl: 3000
  });
}

const base = createAdapter({
  gameId: 'generic',
  gameLabel: 'Generic',
  priority: PRIORITY,
  extractEvents,
  getBaseline
});

function wrapForGame(gameId) {
  let prevSnapshot = null;
  return {
    ...base,
    id: gameId,
    gameId,
    onUpdate(state) {
      const enriched = { ...state, _gameId: gameId };
      const events = extractEvents(prevSnapshot, enriched);
      prevSnapshot = {
        series: { ...enriched.series },
        game: { ...enriched.game },
        spotlight: enriched.spotlight ? { ...enriched.spotlight } : null,
        breakScreen: enriched.breakScreen ? { visible: enriched.breakScreen.visible, endsAt: enriched.breakScreen.endsAt } : null
      };
      return events;
    },
    reset() { prevSnapshot = null; }
  };
}

module.exports = { PRIORITY, extractEvents, getBaseline, wrapForGame, base };