/*
 * sqlite-store.js — SQLite persistence for stats, via sql.js (WASM SQLite, no native build).
 *
 * Design goals (see the local-first / cloud-ready plan):
 *   • Real SQLite in a single local file (stats.sqlite) — no separate DB server/app.
 *   • Cloud-ready schema: every record carries identity + sync metadata
 *       (uid, workspace_id, owner_id, created_at, updated_at, rev, deleted_at)
 *     so a future cloud sync can do last-write-wins / merge / tombstone deletes.
 *   • Normalized "common core + per-game extension": one player_stats table with a
 *     game-specific JSON blob, so CS2 / RL / Valorant / OW… all fit without 8 schemas.
 *   • SAFE: this runs ALONGSIDE the existing JSON store. If sql.js fails to load,
 *     everything degrades to a no-op — it can never break the live app.
 *
 * sql.js init is async (loads a .wasm); writes that arrive before it's ready are buffered
 * and replayed once the DB is open.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch (e) { initSqlJs = null; }

let SQL = null;
let db = null;
let ready = false;
let available = false;
let disabled = !initSqlJs;   // sql.js missing or init failed → mirror is a no-op (never grows the buffer)
let dbFile = null;
let saveTimer = null;
const buffer = [];     // ops queued before the DB is ready: () => void

const WORKSPACE = 'local';   // single local workspace today; the hook for shared/cloud later
const OWNER = 'local';

function uuid() { try { return crypto.randomUUID(); } catch (e) { return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36); } }
function meta() { const t = Date.now(); return { uid: uuid(), workspace_id: WORKSPACE, owner_id: OWNER, created_at: t, updated_at: t, rev: 1, deleted_at: null }; }

// Cloud-ready metadata columns shared by every table.
const META_COLS = 'uid TEXT, workspace_id TEXT DEFAULT \'local\', owner_id TEXT, created_at INTEGER, updated_at INTEGER, rev INTEGER DEFAULT 1, deleted_at INTEGER';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY, game_type TEXT, team_a TEXT, team_b TEXT, logo_a TEXT, logo_b TEXT,
  best_of INTEGER, score_a INTEGER, score_b INTEGER, winner TEXT,
  startgg_set_id TEXT, tournament TEXT, started_at INTEGER, ended_at INTEGER, ${META_COLS});
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY, match_id INTEGER, game_number INTEGER, game_type TEXT,
  duration_sec INTEGER, score_a INTEGER, score_b INTEGER, winner TEXT, map TEXT, overtime INTEGER,
  started_at INTEGER, ended_at INTEGER, ${META_COLS});
CREATE TABLE IF NOT EXISTS player_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER, game_type TEXT, team TEXT, name TEXT,
  stats_json TEXT, ${META_COLS});
CREATE TABLE IF NOT EXISTS cs2_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER, round_number INTEGER, winner TEXT,
  win_condition TEXT, bomb_planted INTEGER, bomb_defused INTEGER, ${META_COLS});
CREATE INDEX IF NOT EXISTS idx_games_match ON games(match_id);
CREATE INDEX IF NOT EXISTS idx_pstats_game ON player_stats(game_id);
CREATE INDEX IF NOT EXISTS idx_pstats_name ON player_stats(name);
CREATE INDEX IF NOT EXISTS idx_rounds_game ON cs2_rounds(game_id);
`;

function scheduleSave() {
  if (!ready) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = Buffer.from(db.export());
      const tmp = dbFile + '.tmp';
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, dbFile);
    } catch (e) { console.error('[StatsDB] save failed:', e.message); }
  }, 1200);
}

// Run a parameterized statement, swallowing per-op errors so a bad row never crashes the app.
function run(sql, params) {
  if (disabled) return;                                       // mirror off → no-op
  if (!ready) { if (buffer.length < 5000) buffer.push(() => run(sql, params)); return; }   // queue until init, bounded
  try { db.run(sql, params); scheduleSave(); }
  catch (e) { console.error('[StatsDB] run failed:', e.message); }
}

function columnsAndValues(obj) {
  const keys = Object.keys(obj);
  return {
    cols: keys.join(', '),
    placeholders: keys.map(() => '?').join(', '),
    // sql.js only binds null/number/string/blob — coerce undefined→null and booleans→0/1.
    values: keys.map((k) => { let v = obj[k]; if (v === undefined) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; })
  };
}
function insert(table, row) {
  const full = { ...row, ...meta() };
  const { cols, placeholders, values } = columnsAndValues(full);
  run(`INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`, values);
}

// ── Public write API (mirrors what stats.js records) ──────────────────────────
const Store = {
  get available() { return available; },

  recordMatch(m) {
    insert('matches', {
      id: m.id, game_type: m.game_type, team_a: m.team_a, team_b: m.team_b, logo_a: m.logo_a, logo_b: m.logo_b,
      best_of: m.best_of, score_a: m.score_a, score_b: m.score_b, winner: m.winner,
      startgg_set_id: m.startgg_set_id, tournament: m.tournament, started_at: m.started_at, ended_at: m.ended_at
    });
  },
  recordGame(g) {
    insert('games', {
      id: g.id, match_id: g.match_id, game_number: g.game_number, game_type: g.game_type,
      duration_sec: g.duration_sec, score_a: g.score_a, score_b: g.score_b, winner: g.winner,
      map: g.map, overtime: g.overtime ? 1 : 0, started_at: g.started_at, ended_at: g.ended_at
    });
  },
  // Generic player row — `core` = { game_id, game_type, team, name }, `stats` = per-game blob.
  recordPlayerStats(core, stats) {
    insert('player_stats', {
      game_id: core.game_id, game_type: core.game_type, team: core.team, name: core.name,
      stats_json: JSON.stringify(stats || {})
    });
  },
  recordCs2Round(r) {
    insert('cs2_rounds', {
      game_id: r.game_id, round_number: r.round_number, winner: r.winner,
      win_condition: r.win_condition, bomb_planted: r.bomb_planted ? 1 : 0, bomb_defused: r.bomb_defused ? 1 : 0
    });
  },

  // Read helper for SQL-backed analytics.
  query(sql, params) {
    if (!ready) return [];
    try {
      const stmt = db.prepare(sql);
      if (params) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } catch (e) { console.error('[StatsDB] query failed:', e.message); return []; }
  },

  // Rebuild the legacy in-memory DB shape from SQLite, so the existing stats readers can run
  // against SQLite with identical output (no reader rewrite, no parity drift). null until ready.
  snapshot() {
    if (!ready) return null;
    try {
      const matches = Store.query('SELECT id,game_type,team_a,team_b,logo_a,logo_b,best_of,score_a,score_b,winner,startgg_set_id,tournament,started_at,ended_at FROM matches WHERE deleted_at IS NULL');
      const games = Store.query('SELECT id,match_id,game_number,game_type,duration_sec,score_a,score_b,winner,map,overtime,started_at,ended_at FROM games WHERE deleted_at IS NULL');
      const cs2_rounds = Store.query('SELECT id,game_id,round_number,winner,win_condition,bomb_planted,bomb_defused FROM cs2_rounds WHERE deleted_at IS NULL');
      const ps = Store.query('SELECT id,game_id,game_type,team,name,stats_json FROM player_stats WHERE deleted_at IS NULL');
      // Re-number per game type to mirror the legacy per-type id sequence (rl 1..n, cs2 1..n, val 1..n),
      // since SQLite shares one auto-increment across them. Insertion order is preserved by rowid.
      const rl_player_stats = [], cs2_player_stats = [], val_player_stats = [];
      let rlId = 0, csId = 0, valId = 0;
      ps.forEach((p) => {
        let s = {}; try { s = JSON.parse(p.stats_json || '{}'); } catch (e) {}
        if (p.game_type === 'rl') {
          rl_player_stats.push({ id: ++rlId, game_id: p.game_id, player_name: p.name, team: p.team, goals: s.goals || 0, assists: s.assists || 0, saves: s.saves || 0, shots: s.shots || 0, demos: s.demos || 0, score: s.score || 0 });
        } else if (p.game_type === 'valorant') {
          val_player_stats.push({ id: ++valId, game_id: p.game_id, player_name: p.name, team: p.team, agent: s.agent || '', kills: s.kills || 0, deaths: s.deaths || 0, assists: s.assists || 0 });
        } else {
          cs2_player_stats.push({ id: ++csId, game_id: p.game_id, steam_id: s.steam_id || null, player_name: p.name, team: p.team, kills: s.kills || 0, deaths: s.deaths || 0, assists: s.assists || 0, hs_kills: s.hs_kills || 0, mvps: s.mvps || 0, score: s.score || 0 });
        }
      });
      return { matches, games, rl_player_stats, cs2_player_stats, val_player_stats, cs2_rounds };
    } catch (e) { console.error('[StatsDB] snapshot failed:', e.message); return null; }
  }
};

// ── Init + one-time migration from the legacy JSON store ──────────────────────
async function init(dataDir, legacyDB) {
  if (!initSqlJs) { disabled = true; console.warn('[StatsDB] sql.js not available — SQLite mirror disabled (JSON store still active).'); return false; }
  dbFile = path.join(dataDir, 'stats.sqlite');
  try {
    const sqlDir = path.dirname(require.resolve('sql.js'));
    SQL = await initSqlJs({ locateFile: (f) => path.join(sqlDir, f) });
    db = fs.existsSync(dbFile) ? new SQL.Database(fs.readFileSync(dbFile)) : new SQL.Database();
    db.run(SCHEMA);
    ready = true; available = true;

    // First run: import the existing stats.json so no history is lost.
    const have = db.exec('SELECT COUNT(*) c FROM matches');
    const count = (have[0] && have[0].values[0][0]) || 0;
    if (count === 0 && legacyDB) migrateFromLegacy(legacyDB);

    // Replay anything that arrived before we were ready.
    while (buffer.length) buffer.shift()();
    scheduleSave();
    console.log(`[StatsDB] SQLite ready (${dbFile}) — ${count} existing, mirror active.`);
    return true;
  } catch (e) {
    console.error('[StatsDB] init failed — SQLite mirror disabled:', e.message);
    available = false; ready = false; disabled = true; buffer.length = 0; return false;
  }
}

function migrateFromLegacy(L) {
  try {
    (L.matches || []).forEach((m) => Store.recordMatch(m));
    (L.games || []).forEach((g) => Store.recordGame(g));
    (L.rl_player_stats || []).forEach((p) => Store.recordPlayerStats(
      { game_id: p.game_id, game_type: 'rl', team: p.team, name: p.player_name },
      { goals: p.goals, assists: p.assists, saves: p.saves, shots: p.shots, demos: p.demos, score: p.score }));
    (L.cs2_player_stats || []).forEach((p) => Store.recordPlayerStats(
      { game_id: p.game_id, game_type: 'csgo', team: p.team, name: p.player_name },
      { steam_id: p.steam_id, kills: p.kills, deaths: p.deaths, assists: p.assists, hs_kills: p.hs_kills, mvps: p.mvps, score: p.score }));
    (L.cs2_rounds || []).forEach((r) => Store.recordCs2Round(r));
    console.log('[StatsDB] migrated legacy stats.json into SQLite.');
  } catch (e) { console.error('[StatsDB] migration failed:', e.message); }
}

module.exports = { init, store: Store, get available() { return available; } };
