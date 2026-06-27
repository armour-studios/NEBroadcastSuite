'use strict';
/**
 * Stats store — pure JS, no native modules, no installation required.
 * All match/game/player data is kept in memory and written to a single
 * JSON file in userData. For the scale of an esports broadcast suite
 * (hundreds of matches/year) this is faster and simpler than SQLite.
 */
const fs   = require('fs');
const path = require('path');
const sqlite = require('./sqlite-store');   // SQLite mirror (cloud-ready schema). Safe no-op if sql.js is unavailable.

let dataDir  = null;
let dbFile   = null;
let _dirty   = false;
let _saveTmr = null;

const DB = {
  matches:         [],  // { id, game_type, team_a, team_b, logo_a, logo_b, best_of, score_a, score_b, winner, startgg_set_id, tournament, started_at, ended_at }
  games:           [],  // { id, match_id, game_number, game_type, duration_sec, score_a, score_b, winner, map, overtime, started_at, ended_at }
  rl_player_stats: [],  // { id, game_id, player_name, team, goals, assists, saves, shots, demos, score }
  cs2_rounds:      [],  // { id, game_id, round_number, winner, win_condition, bomb_planted, bomb_defused }
  cs2_player_stats:[],  // { id, game_id, steam_id, player_name, team, kills, deaths, assists, hs_kills, mvps, score }
  val_player_stats:[]   // { id, game_id, player_name, team, agent, kills, deaths, assists }
};
let _seq = { matches: 0, games: 0, rl: 0, cs2r: 0, cs2p: 0, val: 0 };

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function init(dir) {
  dataDir = dir;
  dbFile  = path.join(dir, 'stats.json');
  _load();
  console.log('[Stats] Store ready:', dbFile);
  // Mirror into SQLite (cloud-ready schema) alongside the JSON store — async, fire-and-forget.
  // Pass a SNAPSHOT of the just-loaded data so the one-time migration imports only pre-existing
  // records (live writes during the brief async init are handled by the dual-write, not re-migrated).
  // The JSON store stays the source of truth for now.
  try { sqlite.init(dir, JSON.parse(JSON.stringify(DB))); } catch (e) { /* mirror is best-effort */ }
}

function close() {
  if (_saveTmr) { clearTimeout(_saveTmr); _saveTmr = null; }
  if (_dirty) _flush(true);   // sync flush on shutdown so the write completes before exit
}

function _load() {
  try {
    if (fs.existsSync(dbFile)) {
      const parsed = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const key of Object.keys(DB)) {
          if (Array.isArray(parsed[key])) DB[key] = parsed[key];
        }
        if (parsed._seq) Object.assign(_seq, parsed._seq);
      }
    }
  } catch (e) {
    console.error('[Stats] Failed to load stats.json:', e.message);
  }
}

function _queueSave() {
  _dirty = true;
  clearTimeout(_saveTmr);
  _saveTmr = setTimeout(_flush, 1000);
}

// Runs in the Electron main process, so the debounced path is async to avoid stalling
// the window during a match (stats flush ~1×/s). Shutdown passes sync=true to finish before exit.
let _flushing = false;
function _flush(sync = false) {
  _dirty = false;
  const tmp = dbFile + '.tmp';
  const json = JSON.stringify({ ...DB, _seq }, null, 2);
  if (sync) {
    try { fs.writeFileSync(tmp, json); fs.renameSync(tmp, dbFile); }
    catch (e) { console.error('[Stats] Failed to save stats.json:', e.message); }
    return;
  }
  if (_flushing) { _queueSave(); return; }   // a write is in flight — re-queue the latest
  _flushing = true;
  fs.writeFile(tmp, json, (wErr) => {
    if (wErr) { _flushing = false; console.error('[Stats] write failed:', wErr.message); return; }
    fs.rename(tmp, dbFile, (rErr) => { _flushing = false; if (rErr) console.error('[Stats] rename failed:', rErr.message); });
  });
}

function _nextId(table) {
  _seq[table] = (_seq[table] || 0) + 1;
  return _seq[table];
}

// ─── Match ───────────────────────────────────────────────────────────────────

function startMatch({ gameType, teamA, teamB, logoA, logoB, bestOf, startggSetId, tournament }) {
  const record = {
    id: _nextId('matches'),
    game_type:      gameType  || 'rl',
    team_a:         teamA     || '',
    team_b:         teamB     || '',
    logo_a:         logoA     || null,
    logo_b:         logoB     || null,
    best_of:        bestOf    || 5,
    score_a:        0,
    score_b:        0,
    winner:         null,
    startgg_set_id: startggSetId || null,
    tournament:     tournament   || null,
    started_at:     Date.now(),
    ended_at:       null
  };
  DB.matches.push(record);
  _queueSave();
  sqlite.store.recordMatch(record);
  return record.id;
}

function endMatch(matchId, { scoreA, scoreB, winner } = {}) {
  const m = DB.matches.find(r => r.id === matchId);
  if (!m) return;
  m.score_a  = scoreA ?? m.score_a;
  m.score_b  = scoreB ?? m.score_b;
  m.winner   = winner || null;
  m.ended_at = Date.now();
  _queueSave();
  sqlite.store.recordMatch(m);
}

// ─── Game ────────────────────────────────────────────────────────────────────

function startGame({ matchId, gameNumber, gameType, map }) {
  const record = {
    id:           _nextId('games'),
    match_id:     matchId,
    game_number:  gameNumber || 1,
    game_type:    gameType   || 'rl',
    duration_sec: null,
    score_a:      0,
    score_b:      0,
    winner:       null,
    map:          map  || null,
    overtime:     0,
    started_at:   Date.now(),
    ended_at:     null
  };
  DB.games.push(record);
  _queueSave();
  sqlite.store.recordGame(record);
  return record.id;
}

function endGame(gameId, { scoreA, scoreB, winner, durationSec, overtime, map } = {}) {
  const g = DB.games.find(r => r.id === gameId);
  if (!g) return;
  g.score_a     = scoreA      ?? g.score_a;
  g.score_b     = scoreB      ?? g.score_b;
  g.winner      = winner      || null;
  g.duration_sec = durationSec || null;
  g.overtime    = overtime ? 1 : 0;
  if (map) g.map = map;
  g.ended_at    = Date.now();
  _queueSave();
  sqlite.store.recordGame(g);
}

// ─── RL Player Stats ─────────────────────────────────────────────────────────

function saveRlPlayerStats(gameId, players) {
  if (!Array.isArray(players)) return;
  for (const p of players) {
    DB.rl_player_stats.push({
      id:          _nextId('rl'),
      game_id:     gameId,
      player_name: p.name    || '',
      team:        p.team    || '',
      goals:       p.goals   || 0,
      assists:     p.assists || 0,
      saves:       p.saves   || 0,
      shots:       p.shots   || 0,
      demos:       p.demos   || 0,
      score:       p.score   || 0
    });
    sqlite.store.recordPlayerStats({ game_id: gameId, game_type: 'rl', team: p.team || '', name: p.name || '' },
      { goals: p.goals || 0, assists: p.assists || 0, saves: p.saves || 0, shots: p.shots || 0, demos: p.demos || 0, score: p.score || 0 });
  }
  _queueSave();
}

// ─── CS2 Round + Player Stats ─────────────────────────────────────────────────

function logCs2Round(gameId, { roundNumber, winner, winCondition, bombPlanted, bombDefused }) {
  DB.cs2_rounds.push({
    id:            _nextId('cs2r'),
    game_id:       gameId,
    round_number:  roundNumber  || 0,
    winner:        winner       || null,
    win_condition: winCondition || null,
    bomb_planted:  bombPlanted  ? 1 : 0,
    bomb_defused:  bombDefused  ? 1 : 0
  });
  sqlite.store.recordCs2Round({ game_id: gameId, round_number: roundNumber || 0, winner: winner || null, win_condition: winCondition || null, bomb_planted: bombPlanted, bomb_defused: bombDefused });
  _queueSave();
}

function saveCs2PlayerStats(gameId, players) {
  if (!Array.isArray(players)) return;
  for (const p of players) {
    DB.cs2_player_stats.push({
      id:          _nextId('cs2p'),
      game_id:     gameId,
      steam_id:    p.steamId   || null,
      player_name: p.name      || '',
      team:        p.team      || '',
      kills:       p.kills     || 0,
      deaths:      p.deaths    || 0,
      assists:     p.assists   || 0,
      hs_kills:    p.hsKills   || 0,
      mvps:        p.mvps      || 0,
      score:       p.score     || 0
    });
    sqlite.store.recordPlayerStats({ game_id: gameId, game_type: 'csgo', team: p.team || '', name: p.name || '' },
      { steam_id: p.steamId || null, kills: p.kills || 0, deaths: p.deaths || 0, assists: p.assists || 0, hs_kills: p.hsKills || 0, mvps: p.mvps || 0, score: p.score || 0 });
  }
  _queueSave();
}

// ─── Valorant Player Stats ───────────────────────────────────────────────────

function saveValorantPlayerStats(gameId, players) {
  if (!Array.isArray(players)) return;
  for (const p of players) {
    DB.val_player_stats.push({
      id:          _nextId('val'),
      game_id:     gameId,
      player_name: p.name  || '',
      team:        p.team  || '',
      agent:       p.agent || '',
      kills:       p.kills   || 0,
      deaths:      p.deaths  || 0,
      assists:     p.assists || 0
    });
    sqlite.store.recordPlayerStats({ game_id: gameId, game_type: 'valorant', team: p.team || '', name: p.name || '' },
      { agent: p.agent || '', kills: p.kills || 0, deaths: p.deaths || 0, assists: p.assists || 0 });
  }
  _queueSave();
}

// ─── Read / Stats API ────────────────────────────────────────────────────────

// Read source: the SQLite mirror (rebuilt into the legacy shape) when it's up, else the
// in-memory store — which is always maintained, so this can never read stale/empty.
function _source() {
  if (process.env.STATS_FORCE_DB) return DB;   // debug/parity hook
  if (sqlite.available) { const snap = sqlite.store.snapshot(); if (snap) return snap; }
  return DB;
}

function getRecentMatches(limit = 20) {
  const DB = _source();
  const sorted = [...DB.matches].sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  return sorted.slice(0, limit).map(m => ({
    ...m,
    game_count: DB.games.filter(g => g.match_id === m.id).length
  }));
}

function getMatchDetail(matchId) {
  const DB = _source();
  const match = DB.matches.find(m => m.id === matchId);
  if (!match) return null;

  const games = DB.games
    .filter(g => g.match_id === matchId)
    .sort((a, b) => a.game_number - b.game_number)
    .map(g => {
      const game = { ...g };
      if (g.game_type === 'rl') {
        game.players = DB.rl_player_stats
          .filter(p => p.game_id === g.id)
          .sort((a, b) => b.score - a.score);
      } else if (g.game_type === 'cs2') {
        game.players = DB.cs2_player_stats
          .filter(p => p.game_id === g.id)
          .sort((a, b) => b.kills - a.kills);
        game.rounds = DB.cs2_rounds
          .filter(r => r.game_id === g.id)
          .sort((a, b) => a.round_number - b.round_number);
      } else if (g.game_type === 'valorant') {
        game.players = (DB.val_player_stats || [])
          .filter(p => p.game_id === g.id)
          .sort((a, b) => b.kills - a.kills);
      }
      return game;
    });

  return { ...match, games };
}

function getPlayerHistory(playerName, limit = 50) {
  const DB = _source();
  const needle = playerName.toLowerCase();
  return DB.rl_player_stats
    .filter(r => r.player_name.toLowerCase().includes(needle))
    .sort((a, b) => {
      const ga = DB.games.find(g => g.id === a.game_id);
      const gb = DB.games.find(g => g.id === b.game_id);
      return (gb?.started_at || 0) - (ga?.started_at || 0);
    })
    .slice(0, limit)
    .map(r => {
      const g = DB.games.find(g => g.id === r.game_id) || {};
      const m = DB.matches.find(m => m.id === g.match_id) || {};
      return { ...r, game_number: g.game_number, game_type: g.game_type,
               game_at: g.started_at, team_a: m.team_a, team_b: m.team_b,
               match_score_a: m.score_a, match_score_b: m.score_b };
    });
}

function getAggregateStats() {
  const DB = _source();
  const endedMatches = DB.matches.filter(m => m.ended_at);
  const endedGames   = DB.games.filter(g => g.ended_at);
  const durations    = endedGames.map(g => g.duration_sec).filter(Boolean);
  const avgDuration  = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  const goalsByPlayer = {};
  DB.rl_player_stats.forEach(p => {
    goalsByPlayer[p.player_name] = (goalsByPlayer[p.player_name] || 0) + (p.goals || 0);
  });
  let topScorer = null;
  let topGoals  = 0;
  for (const [name, goals] of Object.entries(goalsByPlayer)) {
    if (goals > topGoals) { topGoals = goals; topScorer = { player_name: name, total_goals: goals }; }
  }

  return {
    matchCount:      endedMatches.length,
    gameCount:       endedGames.length,
    avgDurationSec:  avgDuration,
    topScorer
  };
}

// ─── Deep analytics: leaderboards, team records, head-to-head ─────────────────

// Per-player aggregates across every recorded game, split by game type.
function getLeaders(limit = 25) {
  const DB = _source();
  const rl = {};
  DB.rl_player_stats.forEach((p) => {
    const k = p.player_name || '?';
    const a = rl[k] || (rl[k] = { player: k, games: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, score: 0 });
    a.games++; a.goals += p.goals || 0; a.assists += p.assists || 0; a.saves += p.saves || 0;
    a.shots += p.shots || 0; a.demos += p.demos || 0; a.score += p.score || 0;
  });
  const cs2 = {};
  DB.cs2_player_stats.forEach((p) => {
    const k = p.player_name || '?';
    const a = cs2[k] || (cs2[k] = { player: k, games: 0, kills: 0, deaths: 0, assists: 0, hs: 0, mvps: 0, score: 0 });
    a.games++; a.kills += p.kills || 0; a.deaths += p.deaths || 0; a.assists += p.assists || 0;
    a.hs += p.hs_kills || 0; a.mvps += p.mvps || 0; a.score += p.score || 0;
  });
  const val = {};
  (DB.val_player_stats || []).forEach((p) => {
    const k = p.player_name || '?';
    const a = val[k] || (val[k] = { player: k, games: 0, kills: 0, deaths: 0, assists: 0, agent: p.agent || '' });
    a.games++; a.kills += p.kills || 0; a.deaths += p.deaths || 0; a.assists += p.assists || 0;
    if (p.agent) a.agent = p.agent;
  });
  const rlList = Object.values(rl).map((a) => ({ ...a, gpg: a.games ? +(a.goals / a.games).toFixed(2) : 0 }))
    .sort((x, y) => y.goals - x.goals).slice(0, limit);
  const cs2List = Object.values(cs2).map((a) => ({ ...a, kd: a.deaths ? +(a.kills / a.deaths).toFixed(2) : a.kills }))
    .sort((x, y) => y.kills - x.kills).slice(0, limit);
  const valList = Object.values(val).map((a) => ({ ...a, kd: a.deaths ? +(a.kills / a.deaths).toFixed(2) : a.kills }))
    .sort((x, y) => y.kills - x.kills).slice(0, limit);
  return { rl: rlList, cs2: cs2List, val: valList };
}

// Win/loss records per team, from ended matches.
function getTeamRecords() {
  const DB = _source();
  const rec = {};
  const bump = (name, win) => {
    if (!name) return;
    const r = rec[name] || (rec[name] = { team: name, wins: 0, losses: 0, matches: 0 });
    r.matches++; if (win) r.wins++; else r.losses++;
  };
  DB.matches.filter((m) => m.ended_at && m.winner).forEach((m) => {
    const aWon = m.winner === 'a' || m.winner === m.team_a;
    bump(m.team_a, aWon); bump(m.team_b, !aWon);
  });
  return Object.values(rec)
    .map((r) => ({ ...r, winPct: r.matches ? Math.round((r.wins / r.matches) * 100) : 0 }))
    .sort((x, y) => y.wins - x.wins || y.winPct - x.winPct);
}

// Head-to-head record + match list between two team names.
function getHeadToHead(teamA, teamB) {
  const DB = _source();
  const a = (teamA || '').toLowerCase(), b = (teamB || '').toLowerCase();
  if (!a || !b) return { a: teamA, b: teamB, aWins: 0, bWins: 0, matches: [] };
  let aWins = 0, bWins = 0;
  const matches = DB.matches.filter((m) => {
    const ta = (m.team_a || '').toLowerCase(), tb = (m.team_b || '').toLowerCase();
    return (ta === a && tb === b) || (ta === b && tb === a);
  }).sort((x, y) => (y.started_at || 0) - (x.started_at || 0)).map((m) => {
    const aIsTeamA = (m.team_a || '').toLowerCase() === a;
    const winnerIsA = m.winner === 'a' || m.winner === m.team_a;
    const aWon = aIsTeamA ? winnerIsA : !winnerIsA;
    if (m.ended_at && m.winner) { if (aWon) aWins++; else bWins++; }
    return { id: m.id, team_a: m.team_a, team_b: m.team_b, score_a: m.score_a, score_b: m.score_b, winner: m.winner, started_at: m.started_at, tournament: m.tournament };
  });
  return { a: teamA, b: teamB, aWins, bWins, matches };
}

// ─── Cross-game player profile ───────────────────────────────────────────────

// The payoff of the unified store: one name resolves to a single profile that
// spans every title the player has appeared in (RL, CS2, Valorant). Returns
// per-title aggregates (with win/loss, since team is normalized to a/b at the
// stat-write hooks), the teams/agents they've used, and a merged game timeline.
function getPlayerProfile(playerName, timelineLimit = 40) {
  const DB = _source();
  const needle = (playerName || '').toLowerCase().trim();
  if (!needle) return null;

  const gameById  = new Map(DB.games.map(g => [g.id, g]));
  const matchById = new Map(DB.matches.map(m => [m.id, m]));
  const teamsUsed = new Map();   // teamName → appearances
  const timeline  = [];
  let canonicalName = null;

  // Resolve a stat row's match/game context + win/loss (side is a/b; winner is a/b).
  const ctx = (row) => {
    const g = gameById.get(row.game_id) || {};
    const m = matchById.get(g.match_id) || {};
    const side = (row.team === 'a' || row.team === 'b') ? row.team : null;
    const teamName = side ? (side === 'a' ? m.team_a : m.team_b) : null;
    if (teamName) teamsUsed.set(teamName, (teamsUsed.get(teamName) || 0) + 1);
    const won = (side && g.winner) ? (g.winner === side) : null;
    return { g, m, side, teamName, won };
  };
  const tally = (agg, won) => { agg.games++; if (won === true) agg.wins++; else if (won === false) agg.losses++; };
  const matchRow = (r) => { const n = (r.player_name || ''); if (n.toLowerCase() === needle) { if (!canonicalName) canonicalName = n; return true; } return false; };

  // ── Rocket League ──
  const rl = { games: 0, wins: 0, losses: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, score: 0 };
  DB.rl_player_stats.filter(matchRow).forEach((r) => {
    const { g, m, won } = ctx(r);
    tally(rl, won);
    rl.goals += r.goals || 0; rl.assists += r.assists || 0; rl.saves += r.saves || 0;
    rl.shots += r.shots || 0; rl.demos += r.demos || 0; rl.score += r.score || 0;
    timeline.push({ game_at: g.started_at || 0, game_type: 'rl', map: g.map || null, team_a: m.team_a, team_b: m.team_b, tournament: m.tournament || null, won,
      line: { goals: r.goals || 0, assists: r.assists || 0, saves: r.saves || 0, shots: r.shots || 0, demos: r.demos || 0, score: r.score || 0 } });
  });

  // ── CS2 ──
  const cs2 = { games: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0, hs: 0, mvps: 0, score: 0 };
  DB.cs2_player_stats.filter(matchRow).forEach((r) => {
    const { g, m, won } = ctx(r);
    tally(cs2, won);
    cs2.kills += r.kills || 0; cs2.deaths += r.deaths || 0; cs2.assists += r.assists || 0;
    cs2.hs += r.hs_kills || 0; cs2.mvps += r.mvps || 0; cs2.score += r.score || 0;
    timeline.push({ game_at: g.started_at || 0, game_type: 'cs2', map: g.map || null, team_a: m.team_a, team_b: m.team_b, tournament: m.tournament || null, won,
      line: { kills: r.kills || 0, deaths: r.deaths || 0, assists: r.assists || 0, hs: r.hs_kills || 0, mvps: r.mvps || 0 } });
  });

  // ── Valorant ──
  const valAgents = {};
  const val = { games: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0 };
  (DB.val_player_stats || []).filter(matchRow).forEach((r) => {
    const { g, m, won } = ctx(r);
    tally(val, won);
    val.kills += r.kills || 0; val.deaths += r.deaths || 0; val.assists += r.assists || 0;
    if (r.agent) valAgents[r.agent] = (valAgents[r.agent] || 0) + 1;
    timeline.push({ game_at: g.started_at || 0, game_type: 'valorant', map: g.map || null, team_a: m.team_a, team_b: m.team_b, tournament: m.tournament || null, won,
      line: { agent: r.agent || '', kills: r.kills || 0, deaths: r.deaths || 0, assists: r.assists || 0 } });
  });

  if (canonicalName === null) return null;   // player never appeared in any title

  const pct = (w, total) => (total ? Math.round((w / total) * 100) : 0);
  const titles = {};
  if (rl.games)  titles.rl  = { ...rl,  gpg: rl.games ? +(rl.goals / rl.games).toFixed(2) : 0, winPct: pct(rl.wins, rl.wins + rl.losses) };
  if (cs2.games) titles.cs2 = { ...cs2, kd: cs2.deaths ? +(cs2.kills / cs2.deaths).toFixed(2) : cs2.kills, hsPct: cs2.kills ? Math.round((cs2.hs / cs2.kills) * 100) : 0, winPct: pct(cs2.wins, cs2.wins + cs2.losses) };
  if (val.games) {
    const agentList = Object.entries(valAgents).sort((a, b) => b[1] - a[1]).map(([agent, games]) => ({ agent, games }));
    titles.valorant = { ...val, kd: val.deaths ? +(val.kills / val.deaths).toFixed(2) : val.kills, winPct: pct(val.wins, val.wins + val.losses), agents: agentList, topAgent: agentList[0]?.agent || '' };
  }

  timeline.sort((a, b) => (b.game_at || 0) - (a.game_at || 0));
  const totalGames  = rl.games + cs2.games + val.games;
  const totalWins   = rl.wins + cs2.wins + val.wins;
  const totalLosses = rl.losses + cs2.losses + val.losses;

  return {
    player: canonicalName,
    gamesPlayed: Object.keys(titles),
    totals: { games: totalGames, wins: totalWins, losses: totalLosses, winPct: pct(totalWins, totalWins + totalLosses) },
    teams: Array.from(teamsUsed.entries()).sort((a, b) => b[1] - a[1]).map(([team, games]) => ({ team, games })),
    titles,
    timeline: timeline.slice(0, timelineLimit)
  };
}

// Distinct player names across every title — drives the profile picker/typeahead.
function listPlayers() {
  const DB = _source();
  const names = new Map();   // lowercased → { name, titles:Set }
  const add = (n, t) => {
    if (!n) return;
    const k = n.toLowerCase();
    const e = names.get(k) || (names.set(k, { name: n, titles: new Set() }), names.get(k));
    e.titles.add(t);
  };
  DB.rl_player_stats.forEach(r => add(r.player_name, 'rl'));
  DB.cs2_player_stats.forEach(r => add(r.player_name, 'cs2'));
  (DB.val_player_stats || []).forEach(r => add(r.player_name, 'valorant'));
  return Array.from(names.values())
    .map(e => ({ player: e.name, titles: Array.from(e.titles) }))
    .sort((a, b) => a.player.localeCompare(b.player));
}

module.exports = {
  init, close,
  startMatch, endMatch,
  startGame, endGame,
  saveRlPlayerStats,
  logCs2Round, saveCs2PlayerStats,
  saveValorantPlayerStats,
  getRecentMatches, getMatchDetail, getPlayerHistory, getAggregateStats,
  getLeaders, getTeamRecords, getHeadToHead,
  getPlayerProfile, listPlayers
};
