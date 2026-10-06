'use strict';

// ── Valorant live data, via the Overwolf GEP relay ───────────────────────────
//
// THE HISTORY THIS REPLACES: the suite used to poll https://127.0.0.1:2999/liveclientdata/…
// for Valorant. That port belongs to the LEAGUE OF LEGENDS client — Valorant's local API is
// lockfile-authenticated on a random port and serves nothing like it — so the Valorant HUD
// could never connect, and if League happened to be running on the same PC the poller would
// succeed and pour League data into a Valorant scoreboard. The feed now comes from Overwolf,
// the same relay already carrying Overwatch, Marvel Rivals and R6.
//
// EVERY FIELD BELOW IS ONE OVERWOLF DOCUMENTS (overwolf.github.io/api/live-game-data/
// supported-games/valorant). What GEP does NOT give is listed here too, because the last
// implementation's real failure was drawing widgets for data nothing supplied:
//
//   • per-player HEALTH — not in `scoreboard`. Only `shield` is. `me.health` is the local
//     player alone, so a 10-player health column cannot be honest. Not carried.
//   • per-player UTILITY charges (the C/Q/E pips) — local-player-only. Not carried.
//   • credits SPENT — only current `money` is exposed.
//
// GEP reads the LOCAL client, so the relay PC must be in the match — an observer seat counts,
// and `match_info.observing` names whoever that seat is watching.

const { resolveAgent } = require('../valorant-agents');

// GEP reports Riot's internal map codenames; these are the names to put on air.
const MAP_NAMES = {
  ascent: 'Ascent', bonsai: 'Split', duality: 'Bind', triad: 'Haven', port: 'Icebox',
  foxtrot: 'Breeze', canyon: 'Fracture', pitt: 'Pearl', jam: 'Lotus', juliett: 'Sunset',
  infinity: 'Abyss', rook: 'Corrode', range: 'The Range'
};

/** Round phases GEP reports: shopping | combat | end | game_end. The overlay's vocabulary is
 *  warmup | shopping | live | bomb | paused, and 'bomb' is driven by the spike, not the phase. */
function mapPhase(rawPhase, spikeState) {
  const p = String(rawPhase || '').toLowerCase();
  if (spikeState === 'planted') return 'bomb';
  if (p === 'shopping') return 'shopping';
  if (p === 'combat') return 'live';
  if (p === 'end' || p === 'game_end') return 'end';
  return 'warmup';
}

/** Shield value → the overlay's armour tier. Valorant sells light (25) and heavy (50) shields. */
function armorTier(shield) {
  const s = Number(shield) || 0;
  if (s >= 50) return 2;
  if (s >= 25) return 1;
  return 0;
}

/** GEP's weapon strings are asset ids ("TX_Hud_Pistol_Classic"); the overlay's art keys are bare
 *  lowercase names. Strip the known prefixes and keep the tail. */
function weaponSlug(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const tail = s.replace(/^TX_(Hud|Killfeed)_/i, '').replace(/^(Pistol|Rifle|SMG|Shotgun|Sniper|Heavy|Melee)_/i, '');
  return tail.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** One `scoreboard_N` entry → a player row. team 0/1 is GEP's stable team index; the overlay
 *  thinks in ORDER/CHAOS (fixed team identities that do NOT swap at half), so index 0 is ORDER.
 *  Only fields GEP actually sends survive this function. */
function normalisePlayer(p) {
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '').trim();
  if (!name) return null;
  const agent = resolveAgent(p.character);
  return {
    name,
    agent: agent.slug,
    agentName: agent.name,
    team: Number(p.team) === 1 ? 'CHAOS' : 'ORDER',
    isLocal: !!p.is_local,
    teammate: !!p.teammate,
    alive: p.alive !== false,
    shield: Number(p.shield) || 0,
    armor: armorTier(p.shield),
    kills: Number(p.kills) || 0,
    deaths: Number(p.deaths) || 0,
    assists: Number(p.assists) || 0,
    credits: Number(p.money) || 0,
    ultPointsGained: Number(p.ult_points) || 0,
    ultPointsNeeded: Number(p.ult_max) || 0,
    weapon: weaponSlug(p.weapon),
    hasSpike: !!p.spike
  };
}

/** A kill_feed event → a killfeed row. GEP gives assist slots as art ids, so only the count of
 *  filled slots is meaningful, not who assisted. */
function normaliseKill(k) {
  if (!k || typeof k !== 'object') return null;
  const attacker = String(k.attacker || '').trim();
  const victim = String(k.victim || '').trim();
  if (!attacker && !victim) return null;
  return {
    attacker, victim,
    attackerTeammate: !!k.is_attacker_teammate,
    victimTeammate: !!k.is_victim_teammate,
    weapon: weaponSlug(k.weapon),
    headshot: !!k.headshot,
    assists: ['assist1', 'assist2', 'assist3', 'assist4'].filter((s) => String(k[s] || '').trim()).length,
    ts: Date.now()
  };
}

/** Round history is DERIVED, not reported: GEP sends the running score, so a side's score going
 *  up is that side winning the round just played. Derivation beats guessing at `round_report`,
 *  whose shape Overwolf does not document.
 *
 *  `firstContact` is the important argument. When the relay attaches to a match already at 8-5,
 *  the ORDER of those thirteen rounds is unknowable — writing eight ORDER wins followed by five
 *  CHAOS wins would draw a round strip that is simply false. So history starts empty and fills
 *  from the first round we actually watch resolve. Earlier slots render blank, which is true. */
function extendHistory(prevHistory, prevOrder, prevChaos, order, chaos, firstContact) {
  const history = Array.isArray(prevHistory) ? prevHistory.slice() : [];
  if (firstContact) return history;
  // A score that went DOWN means a new map/match — start over.
  if (order < prevOrder || chaos < prevChaos) return [];
  const gained = (order - prevOrder) + (chaos - prevChaos);
  if (gained <= 0) return history;
  // Normally one round resolves at a time; if a tick was missed, attribute each gained round
  // to the side whose score moved. The round NUMBER is the live one, so the strip lines up even
  // when the first rounds of the map were never seen.
  const base = prevOrder + prevChaos;
  let slot = base;
  for (let i = 0; i < order - prevOrder; i++) history.push({ round: ++slot, winner: 'ORDER' });
  for (let i = 0; i < chaos - prevChaos; i++) history.push({ round: ++slot, winner: 'CHAOS' });
  return history;
}

/**
 * Fold one relay POST into the previous Valorant state.
 *
 * Body (what companion-overwolf/background.html sends — the relay owns the GEP→this mapping so
 * this contract survives Overwolf renaming a field):
 *   { scoreboard: [ …scoreboard_N objects… ], roster: [ …roster_N objects… ],
 *     map, round_number, round_phase, match_score: {team_0,team_1}, team, observing,
 *     game_mode, match_outcome, pseudo_match_id, events: [ 'spike_planted' | {name,data} … ] }
 */
function applyGepUpdate(prev, body) {
  const b = body || {};
  const p = prev || {};
  const next = {
    connected: true,
    lastUpdate: Date.now(),
    source: 'gep',
    map: { name: '', displayName: '' },
    round: { number: 1, phase: 'warmup' },
    order: { score: 0 },
    chaos: { score: 0 },
    spikeState: p.spikeState || '',
    players: [],
    observed: null,
    roundHistory: [],
    killfeed: Array.isArray(p.killfeed) ? p.killfeed.slice(-8) : [],
    gameMode: b.game_mode != null ? String(b.game_mode) : (p.gameMode || ''),
    matchId: b.pseudo_match_id != null ? String(b.pseudo_match_id) : (p.matchId || ''),
    // Which side the RELAY PC's team is on this half. GEP reports it for the local client only,
    // so it labels the observer's perspective — it is not a property of the match.
    localSide: b.team != null ? String(b.team) : (p.localSide || '')
  };

  // Map
  const rawMap = b.map != null ? String(b.map) : ((p.map && p.map.name) || '');
  next.map.name = rawMap;
  next.map.displayName = MAP_NAMES[rawMap.toLowerCase()] || rawMap;

  // Score. match_score is {team_0, team_1}; keep the last good one when a tick omits it.
  const ms = b.match_score && typeof b.match_score === 'object' ? b.match_score : null;
  const prevOrder = (p.order && p.order.score) || 0;
  const prevChaos = (p.chaos && p.chaos.score) || 0;
  next.order.score = ms && ms.team_0 != null ? Number(ms.team_0) || 0 : prevOrder;
  next.chaos.score = ms && ms.team_1 != null ? Number(ms.team_1) || 0 : prevChaos;

  // Spike — event-driven, cleared when a new round opens.
  const events = Array.isArray(b.events) ? b.events : [];
  for (const ev of events) {
    const name = typeof ev === 'string' ? ev : String((ev && ev.name) || '');
    if (name === 'spike_planted') next.spikeState = 'planted';
    else if (name === 'spike_defused') next.spikeState = 'defused';
    else if (name === 'spike_detonated') next.spikeState = 'detonated';
    else if (name === 'match_start') { next.spikeState = ''; next.killfeed = []; }
    else if (name === 'kill_feed') {
      const row = normaliseKill(typeof ev === 'object' ? ev.data : null);
      if (row) next.killfeed = next.killfeed.concat([row]).slice(-8);
    }
  }

  // Round
  const roundNum = b.round_number != null ? (Number(b.round_number) || 0) : ((p.round && p.round.number) || 1);
  const prevRound = (p.round && p.round.number) || 0;
  if (roundNum > prevRound) next.spikeState = '';   // new round — the old spike state is stale
  next.round.number = Math.max(1, roundNum);
  next.round.phase = mapPhase(b.round_phase != null ? b.round_phase : (p.round && p.round.rawPhase), next.spikeState);
  next.round.rawPhase = b.round_phase != null ? String(b.round_phase) : ((p.round && p.round.rawPhase) || '');

  // Players. `scoreboard` is the live one; `roster` is agent-select and is only a fallback so
  // the HUD can show locked-in agents before the first scoreboard tick.
  const board = Array.isArray(b.scoreboard) ? b.scoreboard : [];
  if (board.length) {
    next.players = board.map(normalisePlayer).filter(Boolean);
  } else if (Array.isArray(b.roster) && b.roster.length) {
    next.players = b.roster.map((r) => {
      const row = normalisePlayer({ ...r, team: r.teammate ? 0 : 1 });
      return row ? { ...row, alive: true } : null;
    }).filter(Boolean);
  } else {
    next.players = Array.isArray(p.players) ? p.players : [];
  }

  // Observed player — `observing` is the name the relay seat is spectating.
  const watching = b.observing != null ? String(b.observing).trim() : '';
  if (watching) next.observed = next.players.find((pl) => pl.name === watching) || null;
  else next.observed = next.players.find((pl) => pl.isLocal) || null;

  // First contact = the relay just attached. Rounds already on the board were not observed, so
  // their winners are not knowable — see extendHistory.
  next.roundHistory = extendHistory(p.roundHistory, prevOrder, prevChaos, next.order.score, next.chaos.score, !p.lastUpdate);
  return next;
}

module.exports = { applyGepUpdate, normalisePlayer, normaliseKill, mapPhase, armorTier, weaponSlug, extendHistory, MAP_NAMES };
