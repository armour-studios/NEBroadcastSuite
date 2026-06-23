const { makeEvent, targetPlayer, targetBall } = require('../events');

const PRIORITY = {
  goal: 95,
  overtime: 88,
  save: 80,
  shot: 65,
  demo: 60,
  boost_starve: 50,
  momentum: 55,
  kickoff: 45,
  baseline: 20
};

let prevSnapshot = null;

function extractEvents(prev, cur) {
  const events = [];
  const players = cur.players || [];
  const game = cur.game || {};
  const gameTime = game.isOT ? `OT ${formatClock(game.time)}` : formatClock(game.time);

  if (game.isOT && !prev?.game?.isOT) {
    events.push(makeEvent({
      type: 'overtime',
      game: 'rocket-league',
      target: targetBall(),
      priority: PRIORITY.overtime,
      reason: 'Overtime — every touch matters',
      gameTime,
      ttl: 30000
    }));
  }

  // Stat diffs
  players.forEach((p) => {
    const prevP = (prev?.players || []).find((x) => x.name === p.name);
    if (!prevP) return;

    if ((p.goals || 0) > (prevP.goals || 0)) {
      events.push(makeEvent({
        type: 'goal',
        game: 'rocket-league',
        target: targetPlayer(p.primaryid || p.name, p.name),
        priority: PRIORITY.goal,
        reason: `GOAL — ${p.name}`,
        gameTime,
        ttl: 12000
      }));
    }
    if ((p.saves || 0) > (prevP.saves || 0)) {
      const late = (game.time || 300) < 30;
      events.push(makeEvent({
        type: 'save',
        game: 'rocket-league',
        target: targetPlayer(p.primaryid || p.name, p.name),
        priority: PRIORITY.save + (late ? 15 : 0),
        reason: late ? `Clutch save — ${p.name}` : `Save — ${p.name}`,
        gameTime,
        ttl: 8000
      }));
    }
    if ((p.shots || 0) > (prevP.shots || 0)) {
      events.push(makeEvent({
        type: 'shot',
        game: 'rocket-league',
        target: targetPlayer(p.primaryid || p.name, p.name),
        priority: PRIORITY.shot,
        reason: `Shot on goal — ${p.name}`,
        gameTime,
        ttl: 5000
      }));
    }
    if ((p.demos || 0) > (prevP.demos || 0)) {
      events.push(makeEvent({
        type: 'demo',
        game: 'rocket-league',
        target: targetPlayer(p.primaryid || p.name, p.name),
        priority: PRIORITY.demo,
        reason: `Demolition — ${p.name}`,
        gameTime,
        ttl: 6000
      }));
    }
    if (p.boost != null && p.boost < 15 && (prevP.boost == null || prevP.boost >= 15)) {
      events.push(makeEvent({
        type: 'boost_starve',
        game: 'rocket-league',
        target: targetPlayer(p.primaryid || p.name, p.name),
        priority: PRIORITY.boost_starve,
        reason: `${p.name} low boost — may need boost steal`,
        gameTime,
        ttl: 5000
      }));
    }
  });

  // Momentum swing — score diff changed
  if (prev?.game) {
    const prevDiff = (prev.game.blueScore || 0) - (prev.game.orangeScore || 0);
    const curDiff = (game.blueScore || 0) - (game.orangeScore || 0);
    if (prevDiff !== 0 && curDiff === 0 && (game.blueScore || 0) > 0) {
      events.push(makeEvent({
        type: 'momentum',
        game: 'rocket-league',
        target: targetBall(),
        priority: PRIORITY.momentum,
        reason: 'Game tied — momentum swing',
        gameTime,
        ttl: 10000
      }));
    }
  }

  // Kickoff — clock resets to 5:00 (regulation) or 0:00 (overtime)
  if (prev && isKickoffClockReset(prev.game?.time, game.time, game.isOT)) {
    events.push(makeEvent({
      type: 'kickoff',
      game: 'rocket-league',
      target: targetBall(),
      priority: PRIORITY.kickoff,
      reason: 'Kickoff — watch the 50/50',
      gameTime,
      ttl: 8000
    }));
  }

  return events;
}

/** Regulation kickoffs reset to ~300s; OT kickoffs reset to 0. */
function isKickoffClockReset(prevTime, curTime, isOT) {
  if (prevTime == null || curTime == null) return false;
  const prev = Number(prevTime);
  const cur = Number(curTime);
  if (!Number.isFinite(prev) || !Number.isFinite(cur)) return false;
  if (isOT) return prev > 0 && cur <= 0.5;
  return cur >= 299 && prev < 295 && prev > 0;
}

function formatClock(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getBaseline(cur) {
  const spec = cur.spectatedPlayer;
  if (spec) {
    const p = (cur.players || []).find((x) => x.name === spec);
    return makeEvent({
      type: 'baseline',
      game: 'rocket-league',
      target: targetPlayer(p?.primaryid || spec, spec),
      priority: PRIORITY.baseline + 5,
      reason: `Following ${spec}`,
      ttl: 3000
    });
  }
  const mvp = [...(cur.players || [])].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  if (mvp) {
    return makeEvent({
      type: 'baseline',
      game: 'rocket-league',
      target: targetPlayer(mvp.primaryid || mvp.name, mvp.name),
      priority: PRIORITY.baseline,
      reason: `Match MVP pace — ${mvp.name}`,
      ttl: 3000
    });
  }
  return makeEvent({
    type: 'baseline',
    game: 'rocket-league',
    target: targetBall(),
    priority: PRIORITY.baseline,
    reason: 'Follow the ball',
    ttl: 3000
  });
}

function snapshot(state) {
  return {
    game: {
      time: state.game?.time,
      isOT: state.game?.isOT,
      blueScore: state.game?.blueScore,
      orangeScore: state.game?.orangeScore
    },
    players: (state.players || []).map((p) => ({
      name: p.name,
      goals: p.goals,
      saves: p.saves,
      shots: p.shots,
      demos: p.demos,
      boost: p.boost,
      score: p.score
    }))
  };
}

function onUpdate(state) {
  const snap = snapshot(state);
  const events = extractEvents(prevSnapshot, state);
  prevSnapshot = snap;
  return events;
}

function onDiscreteEvent(data) {
  const events = [];
  if (data.type === 'goal' && data.scorer) {
    events.push(makeEvent({
      type: 'goal',
      game: 'rocket-league',
      target: targetPlayer(data.scorerId || data.scorer, data.scorer),
      priority: PRIORITY.goal,
      reason: data.assister ? `GOAL — ${data.scorer} (${data.assister} assist)` : `GOAL — ${data.scorer}`,
      gameTime: data.gameTime || null,
      ttl: 15000
    }));
  }
  return events;
}

function reset() {
  prevSnapshot = null;
}

module.exports = {
  id: 'rocket-league',
  gameId: 'rocket-league',
  PRIORITY,
  extractEvents,
  getBaseline,
  onUpdate,
  onDiscreteEvent,
  reset
};