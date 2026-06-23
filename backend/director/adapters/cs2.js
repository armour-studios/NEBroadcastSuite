const { makeEvent, targetPlayer, targetArea } = require('../events');

const PRIORITY = {
  ace: 98,
  multi_kill: 85,
  clutch: 90,
  defuse: 88,
  bomb_planted: 82,
  low_hp_duel: 75,
  trade: 70,
  lurk: 55,
  economy: 40,
  round_start: 35,
  baseline: 20
};

let prevSnapshot = null;

function dist(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function teamAlive(players, team) {
  return players.filter((p) => p.team === team && p.alive);
}

function extractEvents(prev, cur) {
  const events = [];
  if (!cur || !cur.connected) return events;

  const players = cur.players || [];
  const round = cur.round?.number || 0;
  const gameTime = cur.phaseEndsIn != null ? `${cur.phase} (${cur.phaseEndsIn}s)` : cur.phase;

  // Round tick-over — streak / economy context
  if (prev && prev.round?.number !== round && round > 0) {
    const top = [...players].sort((a, b) => (b.roundKills || 0) - (a.roundKills || 0))[0];
    if (top && top.roundKills === 0) {
      const streaker = players.find((p) => (p.kills || 0) >= 3 && p.alive);
      if (streaker) {
        events.push(makeEvent({
          type: 'round_start',
          game: 'csgo',
          target: targetPlayer(streaker.steamid, streaker.name),
          priority: PRIORITY.round_start + 15,
          reason: `${streaker.name} on a hot streak — open the round on them`,
          gameTime,
          ttl: 12000
        }));
      }
    }
    const ctAlive = teamAlive(players, 'CT').length;
    const tAlive = teamAlive(players, 'T').length;
    const ctMoney = teamAlive(players, 'CT').reduce((s, p) => s + (p.money || 0), 0);
    const tMoney = teamAlive(players, 'T').reduce((s, p) => s + (p.money || 0), 0);
    if (ctMoney < 8000 && tMoney < 8000) {
      events.push(makeEvent({
        type: 'economy',
        game: 'csgo',
        target: targetArea('mid', 'Mid'),
        priority: PRIORITY.economy,
        reason: 'Eco round — expect unusual plays',
        gameTime,
        ttl: 15000
      }));
    }
  }

  // Per-player kill milestones this round
  players.forEach((p) => {
    const prevP = (prev?.players || []).find((x) => x.steamid === p.steamid);
    const rk = p.roundKills || 0;
    const prevRk = prevP?.roundKills || 0;
    if (rk >= 5 && prevRk < 5) {
      events.push(makeEvent({
        type: 'ace',
        game: 'csgo',
        target: targetPlayer(p.steamid, p.name),
        priority: PRIORITY.ace,
        reason: `ACE — ${p.name} just took the round`,
        gameTime,
        ttl: 10000
      }));
    } else if (rk === 4 && prevRk < 4) {
      events.push(makeEvent({
        type: 'multi_kill',
        game: 'csgo',
        target: targetPlayer(p.steamid, p.name),
        priority: PRIORITY.multi_kill + 5,
        reason: `4K — ${p.name} one away from ace`,
        gameTime,
        ttl: 8000
      }));
    } else if (rk === 3 && prevRk < 3) {
      events.push(makeEvent({
        type: 'multi_kill',
        game: 'csgo',
        target: targetPlayer(p.steamid, p.name),
        priority: PRIORITY.multi_kill,
        reason: `Multi-kill — ${p.name} (${rk} this round)`,
        gameTime,
        ttl: 7000
      }));
    }
  });

  // Bomb state
  const bomb = cur.bomb || {};
  const prevBomb = prev?.bomb || {};
  if (bomb.state === 'planted' && prevBomb.state !== 'planted') {
    const planter = players.find((p) => p.hasBomb) || players.find((p) => p.steamid === bomb.player);
    events.push(makeEvent({
      type: 'bomb_planted',
      game: 'csgo',
      target: planter ? targetPlayer(planter.steamid, planter.name) : targetArea('site', 'Bomb Site'),
      priority: PRIORITY.bomb_planted,
      reason: 'Bomb planted — watch the site',
      gameTime,
      ttl: 20000
    }));
  }
  if (bomb.state === 'defusing' && prevBomb.state !== 'defusing') {
    const defuser = players.find((p) => p.steamid === bomb.player) || players.find((p) => p.hasKit && p.alive);
    events.push(makeEvent({
      type: 'defuse',
      game: 'csgo',
      target: defuser ? targetPlayer(defuser.steamid, defuser.name) : targetArea('site', 'Defuse'),
      priority: PRIORITY.defuse,
      reason: defuser ? `${defuser.name} defusing` : 'Defuse in progress',
      gameTime,
      ttl: 12000
    }));
  }

  // Clutch: one alive vs 2+
  ['CT', 'T'].forEach((team) => {
    const mine = teamAlive(players, team);
    const theirs = teamAlive(players, team === 'CT' ? 'T' : 'CT');
    if (mine.length === 1 && theirs.length >= 2 && mine[0].alive) {
      events.push(makeEvent({
        type: 'clutch',
        game: 'csgo',
        target: targetPlayer(mine[0].steamid, mine[0].name),
        priority: PRIORITY.clutch,
        reason: `Clutch ${mine[0].name} — 1v${theirs.length}`,
        gameTime,
        ttl: 15000
      }));
    }
  });

  // Low HP duel
  const ctA = teamAlive(players, 'CT');
  const tA = teamAlive(players, 'T');
  if (ctA.length === 1 && tA.length === 1) {
    const a = ctA[0];
    const b = tA[0];
    if (a.health <= 40 && b.health <= 40) {
      const near = dist(a.pos, b.pos) < 800;
      const focus = near ? (a.health <= b.health ? a : b) : (a.roundKills >= b.roundKills ? a : b);
      events.push(makeEvent({
        type: 'low_hp_duel',
        game: 'csgo',
        target: targetPlayer(focus.steamid, focus.name),
        priority: PRIORITY.low_hp_duel + (near ? 10 : 0),
        reason: near ? `Low HP duel — ${focus.name}` : `1v1 — ${focus.name}`,
        gameTime,
        ttl: 8000
      }));
    }
  }

  // Lurk detection — far from teammates
  players.filter((p) => p.alive && p.pos).forEach((p) => {
    const mates = players.filter((m) => m.team === p.team && m.alive && m.steamid !== p.steamid && m.pos);
    if (!mates.length) return;
    const avgX = mates.reduce((s, m) => s + m.pos.x, 0) / mates.length;
    const avgY = mates.reduce((s, m) => s + m.pos.y, 0) / mates.length;
    const d = dist(p.pos, { x: avgX, y: avgY });
    if (d > 1200) {
      events.push(makeEvent({
        type: 'lurk',
        game: 'csgo',
        target: targetPlayer(p.steamid, p.name),
        priority: PRIORITY.lurk,
        reason: `${p.name} flanking — away from team`,
        gameTime,
        ttl: 6000
      }));
    }
  });

  return events;
}

function getBaseline(cur) {
  if (!cur?.connected) return null;
  const obs = cur.observed;
  if (obs?.steamid) {
    return makeEvent({
      type: 'baseline',
      game: 'csgo',
      target: targetPlayer(obs.steamid, obs.name),
      priority: PRIORITY.baseline + 5,
      reason: `Following ${obs.name} (spectator)`,
      ttl: 3000
    });
  }
  const top = [...(cur.players || [])].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  if (top) {
    return makeEvent({
      type: 'baseline',
      game: 'csgo',
      target: targetPlayer(top.steamid, top.name),
      priority: PRIORITY.baseline,
      reason: `Top fragger — ${top.name}`,
      ttl: 3000
    });
  }
  return null;
}

function snapshot(state) {
  return {
    round: state.round ? { ...state.round } : {},
    players: (state.players || []).map((p) => ({
      steamid: p.steamid,
      roundKills: p.roundKills,
      alive: p.alive,
      health: p.health,
      pos: p.pos ? { ...p.pos } : null
    })),
    bomb: state.bomb ? { ...state.bomb } : {}
  };
}

function onUpdate(state) {
  const snap = snapshot(state);
  const events = extractEvents(prevSnapshot, state);
  prevSnapshot = snap;
  return events;
}

function reset() {
  prevSnapshot = null;
}

module.exports = { id: 'csgo', gameId: 'csgo', PRIORITY, extractEvents, getBaseline, onUpdate, reset };