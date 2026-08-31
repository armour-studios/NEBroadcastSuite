'use strict';
// player-identity.js — the permanent identity layer under seeding.
//
// Two stores, one file (identity.json), both keyed on STABLE IDS rather than strings:
//
//   players   — { id, primary, aliases:{ startgg,epic,steam,discord,sixmans,gamertag }, verified }
//               One record per human. Every spelling of their gamertag and every platform account
//               we have ever seen for them hangs off the same id, so the registration sheet's
//               "Jonesy", start.gg's "NE | Jonesy_" and rl6mans' "jonesy." resolve to one player.
//
//   lineages  — { id, names:[…], rosters:[{ playerIds, at, eventSlug }], results:[…] }
//               One record per competitive TEAM ENTITY, matched by roster overlap. This is what
//               keeps a squad's placement history when they rebrand — getTeamPlacementScores()
//               buckets on the normalized team name, so a rename used to wipe the record.
//
// Deliberately additive: nothing here is required for the existing seeding path to run. It records
// and answers questions; the caller decides whether to trust it. All matching math lives in
// control-panel/identity-core.js (pure, shared with the control panel) — this file is storage,
// lifecycle and the mutations that need an audit trail.

const fs   = require('fs');
const path = require('path');
const IC   = require('../control-panel/identity-core');

let _file    = null;
let _players = new Map();   // id -> player record
let _lineage = new Map();   // id -> lineage record
let _index   = null;        // IdentityCore.buildIndex() result; invalidated on every write
let _seq     = 0;
let _dirty   = false;
let _saveTmr = null;

// ── Lifecycle ──────────────────────────────────────────────────────────────

function init(dataDir) {
  _file = path.join(dataDir, 'identity.json');
  _load();
  console.log(`[Identity] Ready: ${_players.size} players, ${_lineage.size} team lineages — ${_file}`);
}

function close() {
  clearTimeout(_saveTmr);
  if (_dirty) _flush(true);
}

function _load() {
  try {
    if (!fs.existsSync(_file)) return;
    const raw = JSON.parse(fs.readFileSync(_file, 'utf8'));
    (raw.players  || []).forEach((p) => { if (p && p.id) _players.set(p.id, _normalizePlayer(p)); });
    (raw.lineages || []).forEach((l) => { if (l && l.id) _lineage.set(l.id, l); });
    _seq = Number(raw.seq) || 0;
  } catch (e) {
    console.error('[Identity] Failed to load:', e.message);
  }
  _index = null;
}

function _queueSave() {
  _dirty = true;
  clearTimeout(_saveTmr);
  _saveTmr = setTimeout(() => _flush(false), 1500);
}

// Index maintenance is deliberately SEPARATE from saving. _queueSave() used to drop the match index
// as well, which meant every single write re-ran buildIndex over every player on the next lookup —
// O(players) per write. The boot backfill (~9.4k upserts against ~4.6k players) paid that ~9.4k
// times and took over three minutes, which was the whole of the app's slow launch.
//
// So: additive writes fold the touched record straight into the live index, and only writes that
// REMOVE an alias or a whole player throw it away (a key can't be un-owned in place).
function _indexTouch(rec) { if (_index && rec) IC.indexRecord(_index, rec); }
function _indexDrop() { _index = null; }

// Async by default — this runs inside the Electron main process, where a sync write stalls the UI
// and every overlay with it (see the perf notes on main-process I/O). Sync only on shutdown.
function _flush(sync) {
  _dirty = false;
  if (!_file) return;
  const payload = JSON.stringify({
    seq: _seq,
    players:  [..._players.values()],
    lineages: [..._lineage.values()],
  });
  if (sync) { try { fs.writeFileSync(_file, payload); } catch (e) { console.error('[Identity] save failed:', e.message); } return; }
  fs.writeFile(_file, payload, (err) => { if (err) console.error('[Identity] save failed:', err.message); });
}

function _now() { return Date.now(); }
function _id(prefix) { return prefix + '_' + (_now().toString(36)) + '_' + (++_seq).toString(36); }

// Aliases are stored as de-duplicated arrays of the ORIGINAL spellings (not normalized) so the UI
// can show a producer what it actually saw. Normalization happens at index time.
function _normalizePlayer(p) {
  const aliases = {};
  IC.ALIAS_KINDS.forEach((k) => {
    const v = (p.aliases && p.aliases[k]) || [];
    aliases[k] = [...new Set((Array.isArray(v) ? v : [v]).filter(Boolean).map((x) => String(x).trim()).filter(Boolean))];
  });
  return {
    id: p.id,
    primary: p.primary || aliases.gamertag[0] || '',
    aliases,
    verified: p.verified || null,          // { at, by, via } once a human (or a strong id) confirmed it
    createdAt: p.createdAt || _now(),
    updatedAt: p.updatedAt || _now(),
    seen: Number(p.seen) || 0,             // how many imports have resolved to this record
    notes: p.notes || '',
  };
}

function _index_() {
  if (!_index) _index = IC.buildIndex([..._players.values()]);
  return _index;
}

// ── Players ────────────────────────────────────────────────────────────────

function getPlayer(id) { return _players.get(id) || null; }
function allPlayers() { return [..._players.values()]; }

// Read-only lookup. Never creates. Returns IdentityCore's verdict plus the hydrated records so the
// caller can render candidates without a second round trip.
//
// On top of the pure match verdict this applies the CONFIRMATION PROMOTION. IdentityCore scores a
// match on string evidence alone, so an exact gamertag hit maxes out at 'probable'/'review'. But
// once a producer has confirmed a spelling, confirm() stores it as an alias on a verified record —
// and re-asking about a name they already settled, every event, while still discounting its rank,
// would make the triage step feel broken and never shrink. So a hit on an alias we actually hold,
// against a confirmed record, with no rival candidate, is promoted to auto/verified.
//
// Two deliberate narrowings, both guarding against linking the wrong human:
//   - an EXACT alias hit is required; a fuzzy near-miss on a confirmed record is still a near-miss.
//   - only a HUMAN confirmation promotes. A record auto-verified from a start.gg slug is trusted
//     for that slug, not for its display name — otherwise the second, unrelated "Jonesy" to appear
//     in a sheet would be silently absorbed into the first one's identity on name alone. Records
//     with a strong id already resolve at 100 whenever the id is present, so nothing is lost.
function resolve(input, opts) {
  const res = IC.resolveIdentity(input || {}, _index_(), opts);
  const record = res.id ? getPlayer(res.id) : null;
  let tier = IC.tierFromResolve(res);
  let status = res.status;
  const humanConfirmed = !!(record && record.verified && record.verified.via === 'confirmed');
  if (humanConfirmed && !res.contested && res.score >= IC.MATCH_SCORE.gamertag) {
    tier = 'verified';
    status = 'auto';
  }
  return {
    ...res, status, tier, record,
    promoted: status !== res.status,
    candidates: (res.candidates || []).map((c) => ({ ...c, record: getPlayer(c.id) })),
  };
}

// Resolve a batch in one pass. Same shape as resolve(), keyed by the caller's own row key so the
// UI can line results up against its rows without re-matching on gamertag (which is the very thing
// we are trying to stop doing).
function resolveMany(inputs, opts) {
  return (inputs || []).map((row, i) => ({
    key: (row && row.key) != null ? row.key : i,
    input: row,
    ...resolve(row, opts),
  }));
}

// Attach an alias to an existing record. Returns false when the value already belongs to a
// DIFFERENT player — that is a merge decision, not a link, and it must not happen silently.
function link(id, kind, value) {
  const rec = _players.get(id);
  if (!rec || !kind || !value || IC.ALIAS_KINDS.indexOf(kind) < 0) return { ok: false, error: 'bad link' };
  const keys = IC.aliasKeys(kind, value);
  const idx = _index_();
  for (const k of keys) {
    const owner = idx.byKey.get(k);
    if (owner && owner !== id) return { ok: false, error: 'alias already belongs to another player', conflictId: owner };
  }
  // De-dupe on the CANONICAL key (keys[0]) only. Every spelling of a gamertag shares the
  // punctuation-stripped key, so an any-key comparison treats "NE | Jonesy_" as already stored
  // because "Jonesy" is — and the exact spelling never lands. That silently defeats the
  // confirmation promotion in resolve(), which needs the exact alias present to stop re-asking.
  if (!rec.aliases[kind].some((v) => IC.aliasKeys(kind, v)[0] === keys[0])) {
    rec.aliases[kind].push(String(value).trim());
  }
  rec.updatedAt = _now();
  _indexTouch(rec);
  _queueSave();
  return { ok: true, record: rec };
}

// Create a brand-new identity from whatever aliases we have.
//
// A record anchored to a platform account (start.gg slug, Epic, Steam, Discord) is born verified:
// those ids come from the platform itself, so there is nothing for a human to confirm — and leaving
// them unverified would cap their rank confidence for a player we are actually certain about.
function create(input, opts) {
  const strongKind = IC.STRONG_KINDS.find((k) => input && input[k]);
  const rec = _normalizePlayer({
    id: _id('p'),
    primary: (input && (input.primary || input.gamertag)) || '',
    aliases: IC.ALIAS_KINDS.reduce((a, k) => { if (input && input[k]) a[k] = [input[k]]; return a; }, {}),
    verified: (opts && opts.verified) ? { at: _now(), by: opts.by || 'producer', via: opts.via || 'manual' }
            : strongKind ? { at: _now(), by: 'system', via: strongKind }
            : null,
    seen: 1,
  });
  _players.set(rec.id, rec);
  _indexTouch(rec);
  _queueSave();
  return rec;
}

// The main write path used by imports.
//
//   auto   → link any new aliases onto the matched record and return it
//   review → do NOT touch anything; hand the candidates back for the producer to decide
//   new    → create, unless opts.createNew is false (dry runs pass false)
//
// This is what makes the triage screen a real gate rather than a report: an ambiguous match stays
// ambiguous in the store until a human resolves it.
function upsert(input, opts) {
  opts = opts || {};
  const res = resolve(input, opts);
  if (res.status === 'review' && !opts.force) return { action: 'review', ...res };

  if (res.status === 'auto' || (res.status === 'review' && opts.force)) {
    const rec = _players.get(res.id);
    if (rec) {
      IC.ALIAS_KINDS.forEach((k) => { if (input && input[k]) link(rec.id, k, input[k]); });
      rec.seen++;
      rec.updatedAt = _now();
      // A strong platform id matching exactly IS verification — no human needed to confirm that a
      // start.gg user slug is the person it belongs to.
      if (!rec.verified && res.score >= IC.MATCH_SCORE.strong) rec.verified = { at: _now(), by: 'system', via: (res.matchedOn || [])[0] || 'strong-id' };
      if (opts.confirm) rec.verified = { at: _now(), by: opts.by || 'producer', via: 'confirmed' };
      _indexTouch(rec);
      _queueSave();
      return { action: 'linked', ...resolve(input, opts) };
    }
  }
  if (opts.createNew === false) return { action: 'would-create', ...res };
  const rec = create(input, opts);
  return { action: 'created', id: rec.id, record: rec, score: 0, status: 'new', tier: rec.verified ? 'verified' : 'unverified', matchedOn: [], candidates: [] };
}

// Producer confirmed (or rejected) an ambiguous match from the triage screen.
function confirm(id, input, by) {
  const rec = _players.get(id);
  if (!rec) return { ok: false, error: 'unknown player' };
  IC.ALIAS_KINDS.forEach((k) => { if (input && input[k]) link(id, k, input[k]); });
  rec.verified = { at: _now(), by: by || 'producer', via: 'confirmed' };
  rec.updatedAt = _now();
  _indexTouch(rec);
  _queueSave();
  return { ok: true, record: rec };
}

function unverify(id) {
  const rec = _players.get(id);
  if (!rec) return { ok: false, error: 'unknown player' };
  rec.verified = null; rec.updatedAt = _now();
  _indexTouch(rec);
  _queueSave();
  return { ok: true, record: rec };
}

// Fold mergeId into keepId: aliases union, verification kept if either had it, and every lineage
// roster repointed so team history survives the merge.
function merge(keepId, mergeId) {
  const keep = _players.get(keepId), gone = _players.get(mergeId);
  if (!keep || !gone || keepId === mergeId) return { ok: false, error: 'bad merge' };
  IC.ALIAS_KINDS.forEach((k) => {
    gone.aliases[k].forEach((v) => {
      const keys = IC.aliasKeys(k, v);
      if (!keep.aliases[k].some((x) => IC.aliasKeys(k, x)[0] === keys[0])) keep.aliases[k].push(v);
    });
  });
  if (!keep.verified && gone.verified) keep.verified = gone.verified;
  keep.seen += gone.seen;
  keep.updatedAt = _now();
  _players.delete(mergeId);
  _lineage.forEach((L) => {
    (L.rosters || []).forEach((r) => {
      r.playerIds = [...new Set((r.playerIds || []).map((p) => (p === mergeId ? keepId : p)))];
    });
  });
  _indexDrop();   // a player was deleted and its keys reassigned — nothing to fix up in place
  _queueSave();
  return { ok: true, record: keep };
}

// Split an alias back out into its own record — the undo for a bad merge or a wrong confirm.
function unlink(id, kind, value) {
  const rec = _players.get(id);
  if (!rec || IC.ALIAS_KINDS.indexOf(kind) < 0) return { ok: false, error: 'bad unlink' };
  const keys = IC.aliasKeys(kind, value);
  rec.aliases[kind] = rec.aliases[kind].filter((v) => !IC.aliasKeys(kind, v).some((k) => keys.indexOf(k) >= 0));
  rec.updatedAt = _now();
  _indexDrop();   // alias keys were removed; they still point here until the index is rebuilt
  _queueSave();
  return { ok: true, record: rec };
}

// ── Team lineages ──────────────────────────────────────────────────────────

function allLineages() { return [..._lineage.values()]; }
function getLineage(id) { return _lineage.get(id) || null; }

// Which known team entity is this roster? Read-only.
function matchTeam(playerIds, name, opts) {
  const m = IC.matchLineage(playerIds || [], name || '', allLineages(), opts);
  return { ...m, record: m.id ? getLineage(m.id) : null,
    candidates: (m.candidates || []).map((c) => ({ ...c, record: getLineage(c.id) })) };
}

// Record that this roster played under this name (optionally at this event). Extends the matched
// lineage, or starts a new one. Rosters are kept per event so matchLineage() can score against the
// team's BEST historical roster rather than only its latest.
function recordTeam(name, playerIds, meta) {
  meta = meta || {};
  const ids = [...new Set((playerIds || []).filter(Boolean))];
  const m = IC.matchLineage(ids, name || '', allLineages(), meta.matchOpts);
  let L = m.id ? _lineage.get(m.id) : null;
  if (!L) {
    L = { id: _id('t'), names: [], rosters: [], createdAt: _now(), updatedAt: _now() };
    _lineage.set(L.id, L);
  }
  if (name && !L.names.some((n) => IC.bareTag(n) === IC.bareTag(name))) L.names.unshift(String(name).trim());
  if (ids.length) {
    const slug = meta.eventSlug || null;
    const existing = slug ? L.rosters.find((r) => r.eventSlug === slug) : null;
    if (existing) existing.playerIds = ids;
    else L.rosters.push({ playerIds: ids, at: meta.at || _now(), eventSlug: slug });
    L.rosters.sort((a, b) => (b.at || 0) - (a.at || 0));
    if (L.rosters.length > 40) L.rosters.length = 40;
  }
  L.updatedAt = _now();
  _queueSave();
  return { lineage: L, matched: m.id ? { score: m.score, basis: m.basis } : null };
}

// Every name this entity has competed under — the lookup getTeamPlacementScores() needs to gather
// a renamed team's results back together.
function namesForLineage(id) {
  const L = _lineage.get(id);
  return L ? L.names.slice() : [];
}

function mergeLineages(keepId, mergeId) {
  const keep = _lineage.get(keepId), gone = _lineage.get(mergeId);
  if (!keep || !gone || keepId === mergeId) return { ok: false, error: 'bad merge' };
  gone.names.forEach((n) => { if (!keep.names.some((x) => IC.bareTag(x) === IC.bareTag(n))) keep.names.push(n); });
  gone.rosters.forEach((r) => { if (!keep.rosters.some((x) => x.eventSlug && x.eventSlug === r.eventSlug)) keep.rosters.push(r); });
  keep.rosters.sort((a, b) => (b.at || 0) - (a.at || 0));
  keep.updatedAt = _now();
  _lineage.delete(mergeId);
  _queueSave();
  return { ok: true, record: keep };
}

// ── Backfill ───────────────────────────────────────────────────────────────
// Seed the store from what the app already knows, so the identity layer does not start empty on a
// machine with seasons of history. Idempotent — re-running it links rather than duplicates.
//
// Both importers run with fuzzy matching OFF. Backfill is O(n) inserts over the whole back
// catalogue and the fuzzy path scans every existing record, so leaving it on turns startup into an
// O(n^2) name-similarity sweep. Exact and strong-id links are all a backfill should ever make on
// its own anyway — near-miss spellings are a producer decision, surfaced by the triage screen.
//
// profiles: state.playerProfiles, keyed gamertag-lowercase → { gamerTag, startggSlug, sixmans, … }
// The producer-confirmed tracker.gg account (profile.tracker / playerDb.tracker) is the only place
// an Epic/Steam/PSN handle is recorded anywhere in the app, and it is exactly the platform-unique
// anchor this layer wants — so it is mapped onto the matching strong alias kind rather than
// discarded. Unknown platforms (psn/xbl, which have no alias kind yet) are skipped, not guessed at.
function _trackerAlias(tracker, out) {
  if (!tracker || !tracker.username) return out;
  const plat = String(tracker.platform || 'epic').toLowerCase();
  if (plat === 'epic' || plat === 'steam') out[plat] = tracker.username;
  return out;
}

function importProfiles(profiles) {
  let created = 0, linked = 0, review = 0;
  Object.values(profiles || {}).forEach((p) => {
    if (!p || !p.gamerTag) return;
    const input = _trackerAlias(p.tracker, {
      gamertag: p.gamerTag,
      startgg:  p.startggSlug || p.startggPlayerId || '',
      discord:  p.discord || '',
      sixmans:  (p.sixmans && p.sixmans.name) || '',
    });
    const r = upsert(input, { createNew: true, fuzzy: false });
    if (r.action === 'created') created++;
    else if (r.action === 'linked') linked++;
    else review++;
  });
  return { created, linked, review, total: _players.size };
}

// records: backend/player-db.js rows — { gamertag (lowercased key), displayName, startggSlug,
// startggId, sixmans:{name}, tracker:{platform,username} }. displayName carries the original
// spelling, so both it and the key are registered as gamertag aliases.
function importPlayerDb(records) {
  let created = 0, linked = 0, review = 0;
  (records || []).forEach((p) => {
    if (!p || !p.gamertag) return;
    const r = upsert(_trackerAlias(p.tracker, {
      gamertag: p.displayName || p.gamertag,
      startgg:  p.startggSlug || p.startggId || '',
      discord:  p.discord || '',
      sixmans:  (p.sixmans && p.sixmans.name) || '',
    }), { createNew: true, fuzzy: false });
    if (r.action === 'created') created++;
    else if (r.action === 'linked') linked++;
    else review++;
    // Register the lowercased key as a second spelling when it differs, so lookups by either form hit.
    if (r.id && p.displayName && p.displayName !== p.gamertag) link(r.id, 'gamertag', p.gamertag);
  });
  return { created, linked, review, total: _players.size };
}

function stats() {
  let verified = 0, withStrong = 0;
  _players.forEach((p) => {
    if (p.verified) verified++;
    if (IC.STRONG_KINDS.some((k) => p.aliases[k] && p.aliases[k].length)) withStrong++;
  });
  return {
    players: _players.size, verified, withStrong,
    lineages: _lineage.size,
    collisions: _index_().collisions.length,
  };
}

module.exports = {
  init, close,
  // players
  resolve, resolveMany, upsert, create, link, unlink, confirm, unverify, merge,
  getPlayer, allPlayers,
  // lineages
  matchTeam, recordTeam, getLineage, allLineages, namesForLineage, mergeLineages,
  // backfill + introspection
  importProfiles, importPlayerDb, stats,
};
