'use strict';
/**
 * Stats store — pure JS, no native modules, no installation required.
 * All match/game/player data is kept in memory and written to a single
 * JSON file in userData. For the scale of an esports broadcast suite
 * (hundreds of matches/year) this is faster and simpler than SQLite.
 */
const fs   = require('fs');
const path = require('path');

let dataDir  = null;
let dbFile   = null;
let _dirty   = false;
let _saveTmr = null;

const DB = {
  matches:         [],  // { id, game_type, team_a, team_b, logo_a, logo_b, best_of, score_a, score_b, winner, startgg_set_id, tournament, started_at, ended_at }
  games:           [],  // { id, match_id, game_number, game_type, duration_sec, score_a, score_b, winner, map, overtime, started_at, ended_at }
  rl_player_stats: [],  // { id, game_id, player_name, team, goals, assists, saves, shots, demos, score }
  cs2_rounds:      [],  // { id, game_id, round_number, winner, win_condition, bomb_planted, bomb_defused }
  cs2_player_stats:[]   // { id, game_id, steam_id, player_name, team, kills, deaths, assists, hs_kills, mvps, score }
};
let _seq = { matches: 0, games: 0, rl: 0, cs2r: 0, cs2p: 0 };

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function init(dir) {
  dataDir = dir;
  dbFile  = path.join(dir, 'stats.json');
  _load();
  console.log('[Stats] Store ready:', dbFile);
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
  }
  _queueSave();
}

// ─── Read / Stats API ────────────────────────────────────────────────────────

function getRecentMatches(limit = 20) {
  const sorted = [...DB.matches].sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  return sorted.slice(0, limit).map(m => ({
    ...m,
    game_count: DB.games.filter(g => g.match_id === m.id).length
  }));
}

function getMatchDetail(matchId) {
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
      }
      return game;
    });

  return { ...match, games };
}

function getPlayerHistory(playerName, limit = 50) {
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
  const rlList = Object.values(rl).map((a) => ({ ...a, gpg: a.games ? +(a.goals / a.games).toFixed(2) : 0 }))
    .sort((x, y) => y.goals - x.goals).slice(0, limit);
  const cs2List = Object.values(cs2).map((a) => ({ ...a, kd: a.deaths ? +(a.kills / a.deaths).toFixed(2) : a.kills }))
    .sort((x, y) => y.kills - x.kills).slice(0, limit);
  return { rl: rlList, cs2: cs2List };
}

// Win/loss records per team, from ended matches.
function getTeamRecords() {
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

module.exports = {
  init, close,
  startMatch, endMatch,
  startGame, endGame,
  saveRlPlayerStats,
  logCs2Round, saveCs2PlayerStats,
  getRecentMatches, getMatchDetail, getPlayerHistory, getAggregateStats,
  getLeaders, getTeamRecords, getHeadToHead
};
