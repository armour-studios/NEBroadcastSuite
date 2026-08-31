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
  val_player_stats:[],  // { id, game_id, player_name, team, agent, kills, deaths, assists }
  event_results:   []   // { id, event_slug, event_name, tournament, game_type, num_entrants, started_at, fetched_at, standings:[{placement,team}] }
};
let _seq = { matches: 0, games: 0, rl: 0, cs2r: 0, cs2p: 0, val: 0, eventResults: 0 };

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

function startMatch({ gameType, teamA, teamB, logoA, logoB, bestOf, startggSetId, tournament, startedAt }) {
  // If this match is tied to a start.gg set we've already recorded (e.g. the official result was
  // imported, or it was streamed before), REUSE that row instead of creating a duplicate — so the
  // live games + player stats land on the same record as the official result ("one clean record").
  // Drop any placeholder games (no player stats) from a prior import so the live games replace them.
  if (startggSetId) {
    const existing = DB.matches.find((m) => m.startgg_set_id && String(m.startgg_set_id) === String(startggSetId));
    if (existing) {
      const psGameIds = new Set([].concat(DB.rl_player_stats, DB.cs2_player_stats, DB.val_player_stats || []).map((p) => p.game_id));
      DB.games = DB.games.filter((g) => g.match_id !== existing.id || psGameIds.has(g.id));
      if (tournament && !existing.tournament) existing.tournament = tournament;
      _queueSave();
      sqlite.store.recordMatch(existing);
      return existing.id;
    }
  }
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
    started_at:     startedAt || Date.now(),   // startedAt lets historical imports keep real dates
    ended_at:       null
  };
  DB.matches.push(record);
  _queueSave();
  sqlite.store.recordMatch(record);
  return record.id;
}

function endMatch(matchId, { scoreA, scoreB, winner, endedAt } = {}) {
  const m = DB.matches.find(r => r.id === matchId);
  if (!m) return;
  // A start.gg-linked row already carries the authoritative final result — don't let a live
  // capture overwrite it (live series score can lag the official set). Only fill if missing.
  const official = m.startgg_set_id && m.winner;
  if (!official) {
    m.score_a = scoreA ?? m.score_a;
    m.score_b = scoreB ?? m.score_b;
    m.winner  = winner || m.winner || null;
  }
  m.ended_at = endedAt || m.ended_at || Date.now();
  _queueSave();
  sqlite.store.recordMatch(m);
}

// ─── Game ────────────────────────────────────────────────────────────────────

function startGame({ matchId, gameNumber, gameType, map, startedAt }) {
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
    started_at:   startedAt || Date.now(),
    ended_at:     null
  };
  DB.games.push(record);
  _queueSave();
  sqlite.store.recordGame(record);
  return record.id;
}

function endGame(gameId, { scoreA, scoreB, winner, durationSec, overtime, map, endedAt } = {}) {
  const g = DB.games.find(r => r.id === gameId);
  if (!g) return;
  g.score_a     = scoreA      ?? g.score_a;
  g.score_b     = scoreB      ?? g.score_b;
  g.winner      = winner      || null;
  g.duration_sec = durationSec || null;
  g.overtime    = overtime ? 1 : 0;
  if (map) g.map = map;
  g.ended_at    = endedAt || Date.now();
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

// In-game names arrive decorated: a "Team | " clan prefix, a "#1234" platform discriminator, the
// odd [TAG]. A raw substring test against the decorated string misses all of them, so match on a
// stripped form as well as the original.
function _normPlayer(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^[^|]{1,12}\|\s*/, '')      // "Team | Name"
    .replace(/^\[[^\]]{1,10}\]\s*/, '')   // "[TAG] Name"
    .replace(/#\d+$/, '')                 // "Name#1234"
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/* Player game history, best match first.
 *
 * Matching used to be a bare `includes` over the decorated player_name, which meant a two-letter
 * query matched half the table and an exactly-correct name ranked no better than a coincidental
 * substring. Now: the players whose names match are RANKED (exact > prefix > substring), and the
 * cap is applied to that ranking rather than to a date sort — so searching a real player can no
 * longer return 50 rows belonging to someone else who merely contains the same letters.
 */
function getPlayerHistory(playerName, limit = 50) {
  const DB = _source();
  const raw = String(playerName || '').toLowerCase().trim();
  if (!raw) return [];
  const needle = _normPlayer(raw);
  const gameById = new Map(DB.games.map(g => [g.id, g]));
  const matchById = new Map(DB.matches.map(m => [m.id, m]));

  // Score a stored name against the query. -1 drops the row.
  const rank = (stored) => {
    const low = String(stored || '').toLowerCase();
    const norm = _normPlayer(low);
    if (norm && needle && norm === needle) return 100;
    if (low === raw) return 100;
    if (norm.startsWith(needle) && needle) return 70;
    if (low.startsWith(raw)) return 65;
    if (needle && norm.includes(needle)) return 40;
    if (low.includes(raw)) return 35;
    return -1;
  };

  // Rank names, not rows: every row for one player shares a score, so the sort below stays a
  // date sort within a player and the cap can't interleave two players' games arbitrarily.
  const scoreByName = new Map();
  for (const r of DB.rl_player_stats) {
    if (scoreByName.has(r.player_name)) continue;
    scoreByName.set(r.player_name, rank(r.player_name));
  }

  return DB.rl_player_stats
    .filter(r => (scoreByName.get(r.player_name) || -1) >= 0)
    .sort((a, b) => {
      const d = (scoreByName.get(b.player_name) || 0) - (scoreByName.get(a.player_name) || 0);
      if (d) return d;
      const ga = gameById.get(a.game_id);
      const gb = gameById.get(b.game_id);
      return (gb?.started_at || 0) - (ga?.started_at || 0);
    })
    .slice(0, limit)
    .map(r => {
      const g = gameById.get(r.game_id) || {};
      const m = matchById.get(g.match_id) || {};
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

// ─── Event results (final standings of OUR OWN events) ───────────────────────
// getTeamRecords() only knows set win/loss, which can't tell "won the bracket" from "went 2-1 in
// pools" — and it weights a match from six months ago the same as last Saturday's final. Seeding
// needs the finish, so we keep each completed event's final standings here and score off placement.
// Read/written against DB directly (the SQLite mirror has no table for this).

function _normTeam(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Upsert one event's final standings, keyed by event slug (re-importing an event replaces it).
function recordEventResults({ eventSlug, eventName, tournament, gameType, numEntrants, startedAt, standings }) {
  if (!eventSlug || !Array.isArray(standings)) return null;
  const rows = standings
    .map((s) => ({
      placement: Number(s.placement) || 0,
      team: (s.team || '').trim(),
      // Roster as it played THAT event. Optional (older records predate it) and only used to
      // re-identify a team that has since rebranded, so nothing here is load-bearing for scoring.
      players: Array.isArray(s.players)
        ? s.players.map((p) => ({ gamerTag: (p && p.gamerTag) || '', startgg: (p && p.startgg) || '' }))
                   .filter((p) => p.gamerTag || p.startgg)
        : [],
    }))
    .filter((s) => s.placement > 0 && s.team)
    .sort((a, b) => a.placement - b.placement);
  if (!rows.length) return null;
  const rec = {
    id:           _nextId('eventResults'),
    event_slug:   eventSlug,
    event_name:   eventName || '',
    tournament:   tournament || '',
    game_type:    gameType || 'rl',
    num_entrants: Number(numEntrants) || rows.length,
    started_at:   Number(startedAt) || Date.now(),
    fetched_at:   Date.now(),
    standings:    rows,
  };
  const i = DB.event_results.findIndex((e) => e.event_slug === eventSlug);
  if (i >= 0) { rec.id = DB.event_results[i].id; DB.event_results[i] = rec; }
  else DB.event_results.push(rec);
  _queueSave();
  return rec;
}

// Newest first. Optionally filtered to one game.
function getEventResults(gameType) {
  return DB.event_results
    .filter((e) => !gameType || e.game_type === gameType)
    .slice()
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
}

function hasEventResults(eventSlug) { return DB.event_results.some((e) => e.event_slug === eventSlug); }

// Cross-event performance rating (0–100) per team, keyed by normalized team name. This is the
// PRIMARY seeding signal: how a team actually finishes our events, which is what a producer means
// by "they've won the last couple". Three factors, all of them things a set win% throws away:
//
//   placement  — 1st in a full field = 100, last = 0.
//   recency    — each event decays on a half-life, so last week outranks last season.
//   field size — winning a 34-team open counts for more than winning a 12-team one (log-scaled).
//
// Volume then regresses the result toward 50: one bracket is a reading, a season of them is a
// verdict. A team with no events at all is absent from the result (the caller imputes it from
// roster rank) — scoring it 50 would silently plant unknowns mid-board.
// `aliasMap` (optional): normalizedTeamName -> canonical key. Supply it and every name a squad has
// competed under collapses into ONE bucket, which is what stops a rebrand deleting a team's record.
// Without it the function behaves exactly as before, keyed on the normalized name — the caller owns
// team identity (backend/player-identity.js resolves it by roster overlap); this file just counts.
//
// Results are emitted under BOTH the canonical key and every alias that fed it, so a lookup by any
// of the team's names finds the merged score without the caller needing to know the canonical id.
function getTeamPlacementScores({ halfLifeDays = 45, gameType = null, excludeSlug = null, maxEvents = 40, aliasMap = null } = {}) {
  const now = Date.now();
  const canon = (name) => {
    const k = _normTeam(name);
    if (!k) return '';
    if (!aliasMap) return k;
    const m = aliasMap instanceof Map ? aliasMap.get(k) : aliasMap[k];
    return m || k;
  };
  const events = getEventResults(gameType)
    .filter((e) => e.event_slug !== excludeSlug)
    .slice(0, maxEvents);
  const acc = {};
  events.forEach((e) => {
    const size   = e.num_entrants || e.standings.length;
    const field  = Math.max(size - 1, 1);
    const days   = Math.max((now - (e.started_at || now)) / 86400000, 0);
    const decay  = Math.pow(0.5, days / halfLifeDays);
    // A 32-team event is the reference (1.0); a 8-team one counts ~0.6, a 64-team one ~1.2.
    const fieldW = Math.log2(Math.max(size, 2)) / 5;
    const weight = decay * fieldW;
    if (weight <= 0) return;
    e.standings.forEach((s) => {
      const nameKey = _normTeam(s.team); if (!nameKey) return;
      const key = canon(s.team);
      const a = acc[key] || (acc[key] = { team: s.team, wSum: 0, wTotal: 0, events: [], names: new Set() });
      a.names.add(nameKey);
      // Keep the most RECENT name as the display label — events iterate newest-first, so the first
      // one to claim the bucket is the team's current identity, not whatever it was two seasons ago.
      a.wSum   += weight * (1 - (s.placement - 1) / field);
      a.wTotal += weight;
      a.events.push({
        event: e.event_name || e.tournament || e.event_slug,
        placement: s.placement, of: size, as: s.team,
        at: e.started_at, weight: Math.round(weight * 100) / 100,
      });
    });
  });
  const out = {};
  Object.entries(acc).forEach(([key, a]) => {
    if (!a.wTotal) return;
    const raw  = (a.wSum / a.wTotal) * 100;
    const n    = a.events.length;
    const conf = 1 - Math.pow(0.5, n / 1.5);   // 1 ev = 0.37, 2 = 0.60, 3 = 0.76, 6 = 0.94
    a.events.sort((x, y) => (y.at || 0) - (x.at || 0));
    const names = [...a.names];
    const rec = { team: a.team, n, events: a.events, confidence: Math.round(conf * 100),
      raw: Math.round(raw * 10) / 10,
      score: Math.round((raw * conf + 50 * (1 - conf)) * 10) / 10,
      names, merged: names.length > 1 };
    out[key] = rec;
    // Publish under every alias too, so a caller looking up any one of the team's names gets the
    // merged record without having to know the canonical key.
    names.forEach((nk) => { if (!out[nk]) out[nk] = rec; });
  });
  return out;
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

// ─── Tournament-organizer analytics ──────────────────────────────────────────

// Per-map plays + win split, by game type. Drives "most played / map win rates".
function getMapStats() {
  const DB = _source();
  const byKey = {};
  DB.games.filter((g) => g.ended_at && g.map).forEach((g) => {
    const key = (g.game_type || '?') + '|' + g.map;
    const m = byKey[key] || (byKey[key] = { map: g.map, game_type: g.game_type || '?', played: 0, aWins: 0, bWins: 0, draws: 0, overtime: 0 });
    m.played++;
    if (g.winner === 'a') m.aWins++;
    else if (g.winner === 'b') m.bWins++;
    else m.draws++;
    if (g.overtime) m.overtime++;
  });
  return Object.values(byKey).sort((x, y) => y.played - x.played);
}

// Match + game duration distribution — for schedule planning / "match pacing".
function getPacing(limit = 200) {
  const DB = _source();
  // Prefer an explicit duration_sec; fall back to ended_at - started_at so pacing works
  // even before duration_sec is populated by the game integrations.
  const gameDur = (g) => g.duration_sec > 0 ? g.duration_sec : (g.ended_at && g.started_at ? Math.round((g.ended_at - g.started_at) / 1000) : 0);
  const games = DB.games.filter((g) => g.ended_at && gameDur(g) > 0);
  const matches = DB.matches.filter((m) => m.ended_at && m.started_at);
  const gDur = games.map(gameDur);
  const mDur = matches.map((m) => Math.round((m.ended_at - m.started_at) / 1000)).filter((s) => s > 0);
  const stat = (arr) => {
    if (!arr.length) return { count: 0, avg: 0, min: 0, max: 0, median: 0 };
    const s = arr.slice().sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    return { count: s.length, avg: Math.round(sum / s.length), min: s[0], max: s[s.length - 1], median: s[Math.floor(s.length / 2)] };
  };
  const byGame = {};
  ['rl', 'cs2', 'valorant'].forEach((gt) => {
    const d = games.filter((g) => g.game_type === gt).map(gameDur);
    if (d.length) byGame[gt] = stat(d);
  });
  return { games: stat(gDur), matches: stat(mDur), byGame, recentGameDurations: gDur.slice(-limit) };
}

// ─── Filterable dashboard (the analytics single source of truth) ─────────────
// Distinct tournaments / games / date bounds — populates the global filter bar.
function getFilterOptions() {
  const DB = _source();
  const tournaments = {}; const games = {}; let min = Infinity, max = 0;
  DB.matches.forEach((m) => {
    if (!m.ended_at) return;
    if (m.tournament) tournaments[m.tournament] = (tournaments[m.tournament] || 0) + 1;
    if (m.game_type) games[m.game_type] = (games[m.game_type] || 0) + 1;
    if (m.started_at) { if (m.started_at < min) min = m.started_at; if (m.started_at > max) max = m.started_at; }
  });
  return {
    tournaments: Object.entries(tournaments).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    games: Object.entries(games).map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
    minDate: isFinite(min) ? min : null, maxDate: max || null
  };
}

function _stat(arr) {
  if (!arr.length) return { count: 0, avg: 0, min: 0, max: 0, median: 0, total: 0 };
  const s = arr.slice().sort((a, b) => a - b); const total = s.reduce((a, b) => a + b, 0);
  return { count: s.length, avg: Math.round(total / s.length), min: s[0], max: s[s.length - 1], median: s[Math.floor(s.length / 2)], total };
}
function _histogram(values, bins) {
  if (!values.length) return [];
  const min = Math.min(...values), max = Math.max(...values);
  if (max === min) return [{ label: Math.round(min / 60) + 'm', count: values.length }];
  const w = (max - min) / bins;
  const b = Array.from({ length: bins }, (_, i) => ({ lo: min + i * w, hi: min + (i + 1) * w, count: 0 }));
  values.forEach((v) => { let i = Math.floor((v - min) / w); if (i >= bins) i = bins - 1; if (i < 0) i = 0; b[i].count++; });
  return b.map((x) => ({ label: Math.round(x.lo / 60) + '–' + Math.round(x.hi / 60) + 'm', count: x.count }));
}

// One filtered pass → every aggregate the dashboard needs. filters: { from, to, game, tournament }.
function getDashboard({ from, to, game, tournament } = {}) {
  const DB = _source();
  const lo = from ? Number(from) : 0, hi = to ? Number(to) : Infinity;
  const gf = (game && game !== 'all') ? game : null;
  const tf = (tournament && tournament !== 'all') ? tournament : null;
  const mAll = new Map(DB.matches.map((m) => [m.id, m]));
  const matchIn = (m) => m.ended_at && m.started_at >= lo && m.started_at <= hi && (!gf || m.game_type === gf) && (!tf || m.tournament === tf);
  const matches = DB.matches.filter(matchIn);
  const mById = new Map(matches.map((m) => [m.id, m]));
  // Games are filtered on their OWN date/type (+ parent tournament) and only require the GAME to be
  // ended — so player stats from live broadcasts whose match was never formally closed still count.
  const gameIn = (g) => {
    if (!g.ended_at) return false;
    const pm = mAll.get(g.match_id);
    const date = g.started_at || (pm && pm.started_at) || 0;
    if (date < lo || date > hi) return false;
    if (gf && g.game_type !== gf) return false;
    if (tf && (!pm || pm.tournament !== tf)) return false;
    return true;
  };
  const games = DB.games.filter(gameIn);
  const gIds = new Set(games.map((g) => g.id));
  const gameDur = (g) => g.duration_sec > 0 ? g.duration_sec : (g.ended_at && g.started_at ? Math.round((g.ended_at - g.started_at) / 1000) : 0);

  // Timeline: matches + games per day (sorted).
  const byDay = {};
  const bucket = (k) => byDay[k] || (byDay[k] = { date: k, matches: 0, games: 0 });
  matches.forEach((m) => { bucket(new Date(m.started_at).toISOString().slice(0, 10)).matches++; });
  games.forEach((g) => { const d = g.started_at || (mAll.get(g.match_id) || {}).started_at; if (d) bucket(new Date(d).toISOString().slice(0, 10)).games++; });
  const timeline = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

  // Team records.
  const rec = {};
  const bump = (name, win) => { if (!name) return; const r = rec[name] || (rec[name] = { team: name, wins: 0, losses: 0, matches: 0 }); r.matches++; if (win) r.wins++; else r.losses++; };
  matches.filter((m) => m.winner).forEach((m) => { const aWon = m.winner === 'a'; bump(m.team_a, aWon); bump(m.team_b, !aWon); });
  const teams = Object.values(rec).map((r) => ({ ...r, winPct: r.matches ? Math.round((r.wins / r.matches) * 100) : 0 })).sort((a, b) => b.wins - a.wins || b.winPct - a.winPct);

  // Player leaders (only player rows whose game is in range).
  const rl = {}, cs2 = {}, val = {};
  DB.rl_player_stats.forEach((p) => { if (!gIds.has(p.game_id)) return; const k = p.player_name || '?'; const a = rl[k] || (rl[k] = { player: k, games: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, score: 0 }); a.games++; a.goals += p.goals || 0; a.assists += p.assists || 0; a.saves += p.saves || 0; a.shots += p.shots || 0; a.demos += p.demos || 0; a.score += p.score || 0; });
  DB.cs2_player_stats.forEach((p) => { if (!gIds.has(p.game_id)) return; const k = p.player_name || '?'; const a = cs2[k] || (cs2[k] = { player: k, games: 0, kills: 0, deaths: 0, assists: 0, hs: 0, mvps: 0, score: 0 }); a.games++; a.kills += p.kills || 0; a.deaths += p.deaths || 0; a.assists += p.assists || 0; a.hs += p.hs_kills || 0; a.mvps += p.mvps || 0; a.score += p.score || 0; });
  (DB.val_player_stats || []).forEach((p) => { if (!gIds.has(p.game_id)) return; const k = p.player_name || '?'; const a = val[k] || (val[k] = { player: k, games: 0, kills: 0, deaths: 0, assists: 0, agent: p.agent || '' }); a.games++; a.kills += p.kills || 0; a.deaths += p.deaths || 0; a.assists += p.assists || 0; if (p.agent) a.agent = p.agent; });
  const leaders = {
    rl: Object.values(rl).map((a) => ({ ...a, gpg: a.games ? +(a.goals / a.games).toFixed(2) : 0 })).sort((x, y) => y.goals - x.goals).slice(0, 100),
    cs2: Object.values(cs2).map((a) => ({ ...a, kd: a.deaths ? +(a.kills / a.deaths).toFixed(2) : a.kills })).sort((x, y) => y.kills - x.kills).slice(0, 100),
    val: Object.values(val).map((a) => ({ ...a, kd: a.deaths ? +(a.kills / a.deaths).toFixed(2) : a.kills })).sort((x, y) => y.kills - x.kills).slice(0, 100)
  };

  // Map stats.
  const maps = {};
  games.filter((g) => g.map).forEach((g) => { const key = (g.game_type || '?') + '|' + g.map; const m = maps[key] || (maps[key] = { map: g.map, game_type: g.game_type || '?', played: 0, aWins: 0, bWins: 0, overtime: 0 }); m.played++; if (g.winner === 'a') m.aWins++; else if (g.winner === 'b') m.bWins++; if (g.overtime) m.overtime++; });
  const mapStats = Object.values(maps).sort((a, b) => b.played - a.played);

  // Pacing.
  const mDur = matches.map((m) => Math.round((m.ended_at - m.started_at) / 1000)).filter((s) => s > 0);
  const gDur = games.map(gameDur).filter((s) => s > 0);
  const pacing = { matches: _stat(mDur), games: _stat(gDur), histogram: _histogram(mDur, 8) };

  // Per-tournament breakdown.
  const tour = {};
  matches.forEach((m) => { const t = m.tournament || '(none)'; const e = tour[t] || (tour[t] = { tournament: t, game: m.game_type, matches: 0, games: 0, teams: new Set(), firstAt: m.started_at, lastAt: m.started_at }); e.matches++; if (m.team_a) e.teams.add(m.team_a); if (m.team_b) e.teams.add(m.team_b); if (m.started_at < e.firstAt) e.firstAt = m.started_at; if (m.started_at > e.lastAt) e.lastAt = m.started_at; });
  games.forEach((g) => { const m = mAll.get(g.match_id); const t = (m && m.tournament) || '(none)'; if (tour[t]) tour[t].games++; });
  const perTournament = Object.values(tour).map((e) => ({ tournament: e.tournament, game: e.game, matches: e.matches, games: e.games, teams: e.teams.size, firstAt: e.firstAt, lastAt: e.lastAt })).sort((a, b) => b.lastAt - a.lastAt);

  return {
    totals: { matches: matches.length, games: games.length, teams: teams.length, players: leaders.rl.length + leaders.cs2.length + leaders.val.length, tournaments: perTournament.length },
    timeline, teams, leaders, mapStats, pacing, perTournament
  };
}

// All start.gg set IDs already recorded — lets the start.gg importer skip duplicates.
function getStartggSetIds() {
  const DB = _source();
  return DB.matches.filter((m) => m.startgg_set_id).map((m) => String(m.startgg_set_id));
}

// Tournaments seen in recorded matches (with completion + date range).
function getTournaments() {
  const DB = _source();
  const t = {};
  DB.matches.filter((m) => m.tournament).forEach((m) => {
    const e = t[m.tournament] || (t[m.tournament] = { tournament: m.tournament, matches: 0, completed: 0, firstAt: m.started_at, lastAt: m.started_at });
    e.matches++;
    if (m.ended_at) e.completed++;
    if (m.started_at && m.started_at < e.firstAt) e.firstAt = m.started_at;
    if (m.started_at && m.started_at > e.lastAt) e.lastAt = m.started_at;
  });
  return Object.values(t).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

// Delete one match + its cascade (games + all player stats for those games).
function deleteMatch(id) {
  id = Number(id);
  const before = DB.matches.length;
  const gameIds = new Set(DB.games.filter((g) => g.match_id === id).map((g) => g.id));
  DB.matches = DB.matches.filter((m) => m.id !== id);
  DB.games = DB.games.filter((g) => g.match_id !== id);
  DB.rl_player_stats = DB.rl_player_stats.filter((r) => !gameIds.has(r.game_id));
  DB.cs2_rounds = DB.cs2_rounds.filter((r) => !gameIds.has(r.game_id));
  DB.cs2_player_stats = DB.cs2_player_stats.filter((r) => !gameIds.has(r.game_id));
  DB.val_player_stats = DB.val_player_stats.filter((r) => !gameIds.has(r.game_id));
  if (DB.matches.length !== before) { try { sqlite.store.deleteMatch(id); } catch (e) {} _queueSave(); return true; }
  return false;
}
// Wipe ALL match/game/player-stat history (fresh reporting).
function clearAllMatches() {
  ['matches', 'games', 'rl_player_stats', 'cs2_rounds', 'cs2_player_stats', 'val_player_stats'].forEach((k) => { DB[k].length = 0; });
  _seq = { matches: 0, games: 0, rl: 0, cs2r: 0, cs2p: 0, val: 0 };
  try { sqlite.store.clearAll(); } catch (e) {}
  _queueSave();
  return true;
}

// Delete every match a team appears in (team-level clear) — cascades via deleteMatch.
function deleteMatchesByTeam(name) {
  const nm = String(name || '').toLowerCase(); if (!nm) return 0;
  const ids = DB.matches.filter((m) => (m.team_a || '').toLowerCase() === nm || (m.team_b || '').toLowerCase() === nm).map((m) => m.id);
  let n = 0; ids.forEach((id) => { if (deleteMatch(id)) n++; }); return n;
}
// Remove one player from the leaderboards (their per-game stat rows across all titles).
function deletePlayerStats(name) {
  const nm = String(name || '').toLowerCase(); if (!nm) return 0;
  let n = 0;
  ['rl_player_stats', 'cs2_player_stats', 'val_player_stats'].forEach((k) => { const before = DB[k].length; DB[k] = DB[k].filter((r) => (r.player_name || '').toLowerCase() !== nm); n += before - DB[k].length; });
  if (n) { try { sqlite.store.deletePlayerStatsByName(name); } catch (e) {} _queueSave(); } return n;
}

// Per-player stats scoped to a specific tournament — used by the lineup overlay.
// tournament param is a substring match against match.tournament (case-insensitive).
function getPlayerEventStats(playerName, tournament) {
  const DB = _source();
  if (!playerName || !tournament) return null;
  const nameLow = String(playerName).toLowerCase();
  const tLow = String(tournament).toLowerCase();

  const matchIds = new Set(
    DB.matches
      .filter((m) => m.game_type === 'rl' && m.tournament && m.tournament.toLowerCase().includes(tLow))
      .map((m) => m.id)
  );
  if (!matchIds.size) return null;

  const gameMap = new Map();
  DB.games.forEach((g) => { if (matchIds.has(g.match_id)) gameMap.set(g.id, g); });
  if (!gameMap.size) return null;

  const rows = DB.rl_player_stats.filter((p) =>
    gameMap.has(p.game_id) && (p.player_name || '').toLowerCase() === nameLow
  );
  if (!rows.length) return null;

  let goals = 0, assists = 0, saves = 0, games = 0, wins = 0;
  for (const r of rows) {
    goals += r.goals || 0;
    assists += r.assists || 0;
    saves += r.saves || 0;
    games++;
    const g = gameMap.get(r.game_id);
    if (g && g.winner && r.team && g.winner === r.team) wins++;
  }
  return { games, wins, goals, assists, saves, gpg: games ? +(goals / games).toFixed(1) : 0 };
}

// Find the single closest RL game to a given timestamp (a replay file's mtime) — the only signal
// the replay-history renamer uses to match a file to a played game (no binary .replay parsing).
// Deliberately NOT scoped by league/tournament — state.leagues <-> DB.matches only has a loose
// free-text substring link (see getPlayerEventStats above), and a replay's timestamp is already a
// precise, strong signal on its own. Cross-event collisions on one PC within toleranceMs are a rare,
// accepted limitation. Returns null when nothing recorded falls within toleranceMs of timestampMs.
function findNearestRlGame(timestampMs, toleranceMs) {
  const DB = _source();
  let best = null, bestDelta = Infinity;
  for (const g of DB.games) {
    if (g.game_type !== 'rl') continue;
    const t = g.ended_at || g.started_at;
    if (!t) continue;
    const delta = Math.abs(t - timestampMs);
    if (delta > toleranceMs || delta >= bestDelta) continue;
    bestDelta = delta; best = g;
  }
  if (!best) return null;
  const m = DB.matches.find((r) => r.id === best.match_id);
  if (!m) return null;   // orphaned game row (parent match deleted) — treat as no match
  return {
    matchId: m.id, gameId: best.id, gameNumber: best.game_number,
    teamA: m.team_a || '', teamB: m.team_b || '',
    // best.score_a/b is the INDIVIDUAL game's score — what the replay filename wants, not the series tally.
    scoreA: typeof best.score_a === 'number' ? best.score_a : 0,
    scoreB: typeof best.score_b === 'number' ? best.score_b : 0,
    startedAt: best.started_at || m.started_at,
    deltaMs: bestDelta
  };
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
  recordEventResults, getEventResults, hasEventResults, getTeamPlacementScores,
  getPlayerProfile, listPlayers, getPlayerEventStats,
  getMapStats, getPacing, getTournaments, getStartggSetIds,
  getDashboard, getFilterOptions,
  findNearestRlGame,
  deleteMatch, clearAllMatches, deleteMatchesByTeam, deletePlayerStats
};
