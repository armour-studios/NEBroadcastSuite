'use strict';
// player-db.js — permanent per-player registry, keyed by gamertag (lowercase).
// Lives in its own file (player-db.json) and is never cleared when teams or
// state are wiped. Survives fresh-event resets so rank data / profile links
// accumulate over time and make re-verification instant.

const fs   = require('fs');
const path = require('path');

let _file    = null;
let _db      = new Map();   // gamertag → record
let _dirty   = false;
let _saveTmr = null;

// ── Lifecycle ──────────────────────────────────────────────────────────────

function init(dataDir) {
  _file = path.join(dataDir, 'player-db.json');
  _load();
  console.log(`[PlayerDB] Ready: ${_db.size} players — ${_file}`);
}

function close() {
  clearTimeout(_saveTmr);
  if (_dirty) _flush(true);
}

function _load() {
  try {
    if (!fs.existsSync(_file)) return;
    const raw = JSON.parse(fs.readFileSync(_file, 'utf8'));
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (r && r.gamertag) _db.set(r.gamertag, r);
      }
    }
  } catch (e) {
    console.error('[PlayerDB] Failed to load:', e.message);
  }
}

function _queueSave() {
  _dirty = true;
  clearTimeout(_saveTmr);
  _saveTmr = setTimeout(() => _flush(false), 1500);
}

function _flush(sync = false) {
  _dirty = false;
  if (!_file) return;
  const data = JSON.stringify([..._db.values()], null, 2);
  const tmp  = _file + '.tmp';
  if (sync) {
    try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, _file); }
    catch (e) { console.error('[PlayerDB] Save failed:', e.message); }
    return;
  }
  fs.writeFile(tmp, data, (err) => {
    if (!err) fs.rename(tmp, _file, () => {});
    else console.error('[PlayerDB] Save failed:', err.message);
  });
}

// ── Read ───────────────────────────────────────────────────────────────────

function get(gamertag) {
  return _db.get(_key(gamertag)) || null;
}

// Search players. opts: { q, rank, region, limit }
function search(opts = {}) {
  let rows = [..._db.values()];
  if (opts.q) {
    const q = (opts.q || '').toLowerCase();
    rows = rows.filter((r) => r.gamertag.includes(q) || (r.displayName || '').toLowerCase().includes(q));
  }
  if (opts.rank)   rows = rows.filter((r) => r.sixmans && r.sixmans.rank === opts.rank);
  if (opts.region) rows = rows.filter((r) => r.sixmans && r.sixmans.region === opts.region);
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (opts.limit) rows = rows.slice(0, Number(opts.limit));
  return rows;
}

function all() { return [..._db.values()]; }
function count() { return _db.size; }

// ── Write ──────────────────────────────────────────────────────────────────

// Upsert a player record. Only fields present on `fields` are written (null
// removes a field; undefined skips it). Returns the updated record.
function upsert(gamertag, fields) {
  const key = _key(gamertag);
  if (!key) return null;
  const now = Date.now();
  const cur = _db.get(key) || { gamertag: key, createdAt: now };
  const next = { ...cur };

  if (fields.displayName  !== undefined) next.displayName  = fields.displayName || cur.displayName || gamertag;
  if (fields.realName     !== undefined) next.realName     = fields.realName     || null;
  if (fields.startggSlug  !== undefined) next.startggSlug  = fields.startggSlug  || null;
  if (fields.startggId    !== undefined) next.startggId    = fields.startggId    || null;
  if (fields.twitch       !== undefined) next.twitch       = fields.twitch       || null;
  if (fields.twitter      !== undefined) next.twitter      = fields.twitter      || null;
  if (fields.country      !== undefined) next.country      = fields.country      || null;
  if (fields.countryCode  !== undefined) next.countryCode  = fields.countryCode  || null;
  if (fields.image        !== undefined) next.image        = fields.image        || null;

  if (fields.sixmans !== undefined) {
    if (!fields.sixmans) {
      next.sixmans = null;
    } else {
      const s = fields.sixmans;
      next.sixmans = {
        ...(cur.sixmans || {}),
        name:     s.name     || (cur.sixmans && cur.sixmans.name)     || '',
        elo:      s.elo      != null ? Number(s.elo)  : (cur.sixmans && cur.sixmans.elo)  || null,
        rank:     s.rank     || (cur.sixmans && cur.sixmans.rank)     || '',
        region:   s.region   || (cur.sixmans && cur.sixmans.region)   || '',
        platform: s.platform || (cur.sixmans && cur.sixmans.platform) || '',
        wins:     s.wins     != null ? Number(s.wins)   : (cur.sixmans && cur.sixmans.wins)   || null,
        losses:   s.losses   != null ? Number(s.losses) : (cur.sixmans && cur.sixmans.losses) || null,
      };
      next.lastVerifiedAt = now;
    }
  }

  next.updatedAt = now;
  _db.set(key, next);
  _queueSave();
  return next;
}

// Bulk upsert — for start.gg roster imports etc.
function upsertMany(records) {
  for (const r of records) {
    if (r && r.gamertag) upsert(r.gamertag, r);
  }
}

function remove(gamertag) {
  const key = _key(gamertag);
  if (!key) return false;
  const had = _db.delete(key);
  if (had) _queueSave();
  return had;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _key(s) { return (s || '').trim().toLowerCase(); }

// Return all records shaped as the state.playerProfiles map (gamertag → profile).
// Used to seed state.playerProfiles at startup.
function toProfilesMap() {
  const map = {};
  for (const [key, r] of _db) {
    map[key] = {
      gamerTag:        r.displayName || r.gamertag,
      realName:        r.realName    || null,
      startggSlug:     r.startggSlug || '',
      startggPlayerId: r.startggId   || '',
      sixmans:         r.sixmans     || null,
      twitch:          r.twitch      || null,
      twitter:         r.twitter     || null,
      country:         r.country     || null,
      countryCode:     r.countryCode || null,
      image:           r.image       || null,
      updatedAt:       r.updatedAt,
    };
  }
  return map;
}

function clearAll() { const n = _db.size; _db.clear(); if (n) _queueSave(); return n; }

module.exports = { init, close, get, search, all, count, upsert, upsertMany, remove, clearAll, toProfilesMap };
