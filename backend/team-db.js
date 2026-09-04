'use strict';
// team-db.js — the permanent TEAM vault, the team-level twin of player-db.js.
//
// The team library (savedTeams / teams.json) is a WORKING list: it gets churned by every event
// import, matched purely on the team's name string, and cleared out between seasons. That made
// three things impossible, all of which a producer hits every single event:
//
//   1. A team that renames ("Nameless" -> "Nameless Esports" -> "NE") arrives as a brand new team
//      and loses the logo, colour, abbreviation and roster someone already set by hand.
//   2. Most orgs never upload a crest to start.gg, so `pickEntrantLogo` returns null and the
//      producer re-uploads the same PNG at every event, forever.
//   3. There is nowhere to record that a player has LEFT a roster — the import just overwrites
//      `players`, so last season's line-up silently vanishes with no history.
//
// The vault fixes all three by keying on identity rather than on a name:
//
//   startggTeamId / startggSlug   start.gg's GlobalTeam — stable across every event the org enters
//   aliases                       every normalized name this team has ever competed under
//   roster fingerprint            overlap of start.gg player ids, so an unnamed pickup squad that
//                                 keeps 2 of 3 players still resolves to the same record
//
// Producer edits are PINNED (`pins.logo` etc.) and an import may never overwrite a pinned field.
// That is the whole "set it once and future events just work" promise: the vault is the source of
// truth for branding, start.gg is the source of truth for who entered.
//
// Lives in its own file (team-db.json) and is never cleared by an event reset or a library wipe,
// exactly like player-db.json.

const fs   = require('fs');
const path = require('path');

let _file    = null;
let _db      = new Map();   // id -> record
let _seq     = 0;
let _dirty   = false;
let _saveTmr = null;

const MAX_EVENTS  = 30;     // per-team event history cap (a busy org plays ~1/week)
const MAX_ALIASES = 24;
// Retired crests kept per team. A logo is a base64 blob, so this is the one field that can bloat a
// record — 12 is several seasons of rebrands and still small enough to ship in a detail response.
const MAX_BRAND_HISTORY = 12;
const MAX_NAME_HISTORY  = 12;

// ── Lifecycle ──────────────────────────────────────────────────────────────

function init(dataDir) {
  _file = path.join(dataDir, 'team-db.json');
  _load();
  console.log(`[TeamDB] Ready: ${_db.size} teams — ${_file}`);
}

function close() {
  clearTimeout(_saveTmr);
  if (_dirty) _flush(true);
}

function _load() {
  try {
    if (!fs.existsSync(_file)) return;
    const raw = JSON.parse(fs.readFileSync(_file, 'utf8'));
    const rows = Array.isArray(raw) ? raw : (raw.teams || []);
    rows.forEach((t) => { if (t && t.id) _db.set(String(t.id), _normalize(t)); });
    _seq = Number(raw && raw.seq) || rows.reduce((m, t) => Math.max(m, Number(String(t.id).replace(/\D/g, '')) || 0), 0);
  } catch (e) {
    console.error('[TeamDB] Failed to load:', e.message);
  }
}

function _queueSave() {
  _dirty = true;
  clearTimeout(_saveTmr);
  _saveTmr = setTimeout(() => _flush(false), 1500);
}

// Async by default — this runs inside the Electron main process, where a sync write stalls the UI
// and every overlay with it. Sync only on shutdown (see the perf notes on main-process I/O).
function _flush(sync) {
  _dirty = false;
  if (!_file) return;
  const payload = JSON.stringify({ seq: _seq, teams: [..._db.values()] }, null, 2);
  const tmp = _file + '.tmp';
  if (sync) {
    try { fs.writeFileSync(tmp, payload); fs.renameSync(tmp, _file); }
    catch (e) { console.error('[TeamDB] Save failed:', e.message); }
    return;
  }
  fs.writeFile(tmp, payload, (err) => {
    if (!err) fs.rename(tmp, _file, () => {});
    else console.error('[TeamDB] Save failed:', err.message);
  });
}

// ── Normalisation helpers ──────────────────────────────────────────────────

// Display-ish normalized form: case/whitespace folded, punctuation collapsed. Used for aliases.
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
// Aggressive form for near-miss matching ("N.E. Esports" === "neesports").
function bare(s) { return norm(s).replace(/ /g, ''); }

// Words that carry no identity on their own — an alias that reduces to only these is too generic
// to match on ("Esports", "Team", "The Squad").
const STOPWORDS = new Set(['esports', 'esport', 'gaming', 'team', 'the', 'gg', 'club', 'academy', 'main', 'roster']);
function meaningfulAlias(a) {
  const words = norm(a).split(' ').filter(Boolean);
  return words.some((w) => !STOPWORDS.has(w));
}

// Stable per-player key for roster overlap. A start.gg player id is exact and survives a gamertag
// change; the normalized tag is the fallback for manual/CSV rosters that have no id at all.
function playerKey(p) {
  if (!p) return '';
  const id = p.startggPlayerId || p.platformId || (p.platform === 'startgg' ? p.platformId : '');
  if (id) return 'sgg:' + String(id);
  const slug = p.startggSlug || p.startgg || '';
  const m = String(slug).match(/user\/([A-Za-z0-9_-]+)/);
  if (m) return 'usr:' + m[1].toLowerCase();
  const tag = bare(p.name || p.gamerTag || '');
  return tag ? 'tag:' + tag : '';
}

function rosterKeys(players) {
  const out = new Set();
  (players || []).forEach((p) => { const k = playerKey(p); if (k) out.add(k); });
  return out;
}

function _normalize(t) {
  const r = { ...t };
  r.id            = String(r.id);
  r.name          = r.name || '';
  r.aliases       = Array.isArray(r.aliases) ? [...new Set(r.aliases.map(norm).filter(Boolean))] : [];
  r.roster        = Array.isArray(r.roster) ? r.roster : [];
  r.events        = Array.isArray(r.events) ? r.events : [];
  r.pins          = r.pins && typeof r.pins === 'object' ? r.pins : {};
  // Retired crests, newest first. Each entry remembers the NAME the team flew under at the time,
  // so a producer reverting a logo can see which era they are reaching back to.
  r.brandHistory  = Array.isArray(r.brandHistory) ? r.brandHistory.filter((h) => h && h.logo) : [];
  // Past names in their ORIGINAL casing. `aliases` is normalised for matching and reads as
  // nonsense in a UI ('clrty esports'); this is the same history, printable.
  r.nameHistory   = Array.isArray(r.nameHistory) ? r.nameHistory.filter((h) => h && h.name) : [];
  // The crest start.gg last reported, recorded even when it is NOT the one on air. This is what
  // lets the vault offer "start.gg has a different logo now" instead of either silently
  // overwriting the producer's choice or hiding that a newer crest exists.
  r.startggLogo   = r.startggLogo || null;
  r.startggLogoAt = Number(r.startggLogoAt) || null;
  r.startggTeamId = r.startggTeamId ? String(r.startggTeamId) : null;
  r.startggSlug   = r.startggSlug || null;
  r.roster.forEach((p) => { if (p && !p.rosterStatus) p.rosterStatus = 'active'; });
  return r;
}

function _nextId() { return 'tm' + (++_seq); }

// ── Read ───────────────────────────────────────────────────────────────────

function all()   { return [..._db.values()]; }
function count() { return _db.size; }
function get(id) { return _db.get(String(id)) || null; }

function search(opts = {}) {
  let rows = all();
  const q = norm(opts.q || '');
  if (q) {
    rows = rows.filter((t) =>
      norm(t.name).includes(q) ||
      (t.aliases || []).some((a) => a.includes(q)) ||
      (t.roster || []).some((p) => norm(p.name).includes(q)));
  }
  if (opts.linked === true)  rows = rows.filter((t) => !!(t.startggTeamId || t.startggSlug));
  if (opts.linked === false) rows = rows.filter((t) => !(t.startggTeamId || t.startggSlug));
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (opts.limit) rows = rows.slice(0, Number(opts.limit));
  // The vault list renders up to 500 cards. Retired crests are base64 blobs nothing on that screen
  // draws, so they ship as a COUNT here and in full only from get(id) when a card is opened.
  return rows.map((t) => {
    const { brandHistory, startggLogo, ...rest } = t;
    return {
      ...rest,
      brandCount: (brandHistory || []).length,
      // A boolean, not the image: enough for the card to badge "start.gg has a newer crest".
      startggLogoDiffers: !!(startggLogo && startggLogo !== t.logo),
    };
  });
}

function stats() {
  const rows = all();
  return {
    teams:   rows.length,
    linked:  rows.filter((t) => t.startggTeamId || t.startggSlug).length,
    withLogo: rows.filter((t) => t.logo).length,
    players: rows.reduce((n, t) => n + (t.roster || []).length, 0),
    active:  rows.reduce((n, t) => n + (t.roster || []).filter((p) => p.rosterStatus !== 'inactive').length, 0),
  };
}

// ── Identity resolution ────────────────────────────────────────────────────
//
// The cascade, strongest first. Every step returns WHY it matched so the UI can show a producer
// "matched by roster (3 of 3 players)" instead of silently rewriting a team they didn't recognise.
//
// `sig` is a platform-neutral team signature:
//   { name, startggTeamId, startggSlug, players:[{ name, startggPlayerId, startggSlug }] }

const ROSTER_MIN_SHARED = 2;    // one shared player is a coincidence, two is a squad
const ROSTER_MIN_RATIO  = 0.5;  // ...and they must be at least half of the smaller roster

function resolve(sig) {
  if (!sig) return { rec: null, via: null, score: 0 };
  const rows = all();

  // 1. start.gg GlobalTeam id — exact, collision-proof, survives any rename.
  if (sig.startggTeamId) {
    const hit = rows.find((t) => t.startggTeamId && t.startggTeamId === String(sig.startggTeamId));
    if (hit) return { rec: hit, via: 'startgg-id', score: 1 };
  }
  // 2. start.gg team slug (the /team/<slug> discriminator) — same guarantee, different key.
  if (sig.startggSlug) {
    const s = String(sig.startggSlug).toLowerCase();
    const hit = rows.find((t) => (t.startggSlug || '').toLowerCase() === s);
    if (hit) return { rec: hit, via: 'startgg-slug', score: 1 };
  }
  // 3. Canonical name or a recorded alias.
  const n = norm(sig.name);
  if (n) {
    const hit = rows.find((t) => norm(t.name) === n || (t.aliases || []).includes(n));
    if (hit) return { rec: hit, via: 'name', score: 0.9 };
    const b = bare(sig.name);
    if (b && meaningfulAlias(sig.name)) {
      const near = rows.find((t) => bare(t.name) === b || (t.aliases || []).some((a) => bare(a) === b));
      if (near) return { rec: near, via: 'name-loose', score: 0.8 };
    }
  }
  // 4. Roster overlap — the "same players are playing" rule. Scored against the SMALLER roster so a
  //    3-stack that enters a 4-player event still matches, and only the ACTIVE half of the stored
  //    roster counts (an ex-player must not drag a squad onto their old org's record).
  const inc = rosterKeys(sig.players);
  if (inc.size) {
    let best = null;
    for (const t of rows) {
      const known = rosterKeys((t.roster || []).filter((p) => p.rosterStatus !== 'inactive'));
      if (!known.size) continue;
      let shared = 0;
      for (const k of inc) if (known.has(k)) shared++;
      if (!shared) continue;
      const ratio = shared / Math.max(1, Math.min(inc.size, known.size));
      const enough = shared >= ROSTER_MIN_SHARED
        ? ratio >= ROSTER_MIN_RATIO
        // A 1v1 / duo entrant has no room for two shared players — for those, one exact start.gg
        // player id IS the whole roster, so accept it. A tag-only match never qualifies here.
        : (inc.size <= 2 && known.size <= 2 && ratio >= ROSTER_MIN_RATIO &&
           [...inc].some((k) => k.startsWith('sgg:') && known.has(k)));
      if (!enough) continue;
      if (!best || ratio > best.score || (ratio === best.score && shared > best.shared)) {
        best = { rec: t, via: 'roster', score: ratio, shared };
      }
    }
    if (best) return best;
  }
  return { rec: null, via: null, score: 0 };
}

// ── Write ──────────────────────────────────────────────────────────────────

function _addAlias(rec, name) {
  const a = norm(name);
  if (!a || !meaningfulAlias(name)) return;
  if (norm(rec.name) === a) return;
  if (rec.aliases.includes(a)) return;
  rec.aliases.push(a);
  if (rec.aliases.length > MAX_ALIASES) rec.aliases = rec.aliases.slice(-MAX_ALIASES);
}

// Rename, keeping the outgoing name as an alias. Must be one helper: calling _addAlias BEFORE the
// assignment silently drops the alias, because _addAlias refuses to store a name equal to the
// record's current one — which the old name still is at that point. That defeats the entire
// rebrand-matching feature, and it fails silently.
function _rename(rec, next) {
  const name = String(next == null ? '' : next).trim();
  if (!name || norm(name) === norm(rec.name)) return false;
  const prev = rec.name;
  rec.name = name;
  _addAlias(rec, prev);
  // aliases are normalised for matching; keep the printable form too, newest first.
  if (prev) {
    const nh = Array.isArray(rec.nameHistory) ? rec.nameHistory : [];
    rec.nameHistory = [{ name: prev, at: Date.now() }, ...nh.filter((h) => norm(h.name) !== norm(prev))]
      .slice(0, MAX_NAME_HISTORY);
  }
  return true;
}

// Bank the brand that is on its way out. Deliberately keyed on the LOGO: this history exists so a
// producer can put an old crest back, and an entry that duplicates the live crest would offer a
// revert to what is already showing.
function _snapshotBrand(rec, meta = {}) {
  if (!rec.logo) return;                                       // nothing to preserve yet
  const hist = Array.isArray(rec.brandHistory) ? rec.brandHistory : [];
  if (hist[0] && hist[0].logo === rec.logo) return;            // already on top of the stack
  rec.brandHistory = [{
    logo:      rec.logo,
    // meta.name is the name this crest was WORN under. A rename has usually already happened by
    // the time we get here, so rec.name is the incoming brand, not the one being retired.
    name:      meta.name || rec.name || '',
    color:     rec.color || null,
    abbr:      rec.abbr || null,
    source:    meta.source || 'startgg',
    eventSlug: meta.eventSlug || null,
    at:        Date.now(),
  }, ...hist.filter((h) => h.logo !== rec.logo)].slice(0, MAX_BRAND_HISTORY);
}

// The ONLY way a logo is allowed to change. Same rule as _rename: routing every write through one
// helper is what keeps the history complete — an assignment that skips this loses the old crest
// forever, and it fails silently because nothing reads brandHistory until the producer looks.
function _setLogo(rec, logo, meta = {}) {
  const next = logo || null;
  if (next === (rec.logo || null)) return false;
  _snapshotBrand(rec, meta);
  rec.logo = next;
  // The live crest is never also a history row.
  rec.brandHistory = (rec.brandHistory || []).filter((h) => h.logo !== next);
  return true;
}

// Merge an incoming roster into the stored one. Players are matched on playerKey, so a gamertag
// edit that kept the start.gg id updates the SAME slot instead of forking a duplicate.
//
// Absent-means-inactive only applies to start.gg-sourced players: a coach, sub or a hand-typed
// stand-in the producer added themselves is never demoted by an import that couldn't have known
// about them. Nobody is ever DELETED — that is the roster history the vault exists to keep.
function _mergeRoster(rec, incoming, ctx) {
  const now = Date.now();
  const byKey = new Map();
  rec.roster.forEach((p) => { const k = playerKey(p); if (k) byKey.set(k, p); });
  const seen = new Set();

  (incoming || []).forEach((p) => {
    const k = playerKey(p);
    if (!k) return;
    seen.add(k);
    const cur = byKey.get(k);
    if (cur) {
      // Import refreshes the platform-owned facts; producer-owned fields (photo, role, camSlot,
      // notes) are only filled in when they're still empty.
      const keep = { ...cur };
      ['name', 'realName', 'country', 'countryCode', 'prefix', 'twitter', 'twitch', 'startgg', 'platformId', 'startggPlayerId']
        .forEach((f) => { if (p[f]) keep[f] = p[f]; });
      if (p.photo && !keep.photo) keep.photo = p.photo;
      keep.rosterStatus = cur.pinned ? cur.rosterStatus : 'active';
      keep.lastSeenAt   = now;
      if (ctx && ctx.eventSlug) keep.lastEvent = ctx.eventSlug;
      Object.assign(cur, keep);
    } else {
      rec.roster.push({
        ...p,
        id: p.id || ('p' + Math.random().toString(36).slice(2, 9)),
        source: p.source || 'startgg',
        rosterStatus: 'active',
        firstSeenAt: now,
        lastSeenAt: now,
        lastEvent: (ctx && ctx.eventSlug) || null,
      });
    }
  });

  // Anyone start.gg didn't list this time has left the active roster.
  if (seen.size) {
    rec.roster.forEach((p) => {
      const k = playerKey(p);
      if (!k || seen.has(k)) return;
      if (p.pinned) return;
      if ((p.source || 'startgg') !== 'startgg') return;
      p.rosterStatus = 'inactive';
    });
  }
}

function _recordEvent(rec, ctx, sig) {
  if (!ctx || !ctx.eventSlug) return;
  const slug = ctx.eventSlug;
  rec.events = rec.events.filter((e) => e && e.slug !== slug);
  rec.events.unshift({
    slug,
    name: ctx.eventName || '',
    enteredAs: sig.name || '',
    entrantId: sig.entrantId ? String(sig.entrantId) : null,
    seed: sig.seed || 0,
    at: Date.now(),
  });
  if (rec.events.length > MAX_EVENTS) rec.events.length = MAX_EVENTS;
}

// Fold an incoming team signature into the vault. Creates the record if the cascade found nothing.
// Returns { rec, via, created } — `via` is null for a fresh record.
function applyEntrant(sig, ctx = {}) {
  if (!sig || !(sig.name || '').trim()) return { rec: null, via: null, created: false };
  const found = resolve(sig);
  const now = Date.now();
  let rec = found.rec;
  let created = false;
  // The name this record carried BEFORE this import — the era any retired crest belongs to.
  let eraName = null;

  if (!rec) {
    rec = _normalize({
      id: _nextId(),
      name: (sig.name || '').trim(),
      abbr: null, color: null, logo: null,
      startggTeamId: sig.startggTeamId ? String(sig.startggTeamId) : null,
      startggSlug: sig.startggSlug || null,
      aliases: [], roster: [], events: [],
      pins: {},
      source: 'startgg',
      createdAt: now,
    });
    _db.set(rec.id, rec);
    created = true;
  } else {
    // A record found by name/roster gets its start.gg keys backfilled, so next event it matches on
    // the strong key instead of re-running the fuzzy cascade.
    if (sig.startggTeamId && !rec.startggTeamId) rec.startggTeamId = String(sig.startggTeamId);
    if (sig.startggSlug   && !rec.startggSlug)   rec.startggSlug   = sig.startggSlug;
    _addAlias(rec, sig.name);
    eraName = rec.name;
    // The name only follows start.gg while the producer hasn't claimed it.
    if (!rec.pins.name) _rename(rec, sig.name);
  }

  // Branding: a pin is absolute, and everything else FOLLOWS start.gg.
  //
  // This used to read `!rec.logo` — first crest to arrive won forever. Since the name does follow
  // start.gg (above), a rebrand produced the new name wearing the old logo, which is exactly the
  // bug this vault was built to prevent. An unpinned logo is not a choice anyone made, it is just
  // whatever landed first, so a newer crest may replace it — and the old one goes to history
  // rather than being lost, so it can be put back.
  if (sig.logo) {
    // Always record what start.gg is serving, even when it is not what goes on air. That is the
    // evidence behind the "start.gg has a different crest" offer in the vault UI.
    if (sig.logo !== rec.startggLogo) { rec.startggLogo = sig.logo; rec.startggLogoAt = now; }
    if (!rec.pins.logo) _setLogo(rec, sig.logo, { source: 'startgg', eventSlug: ctx && ctx.eventSlug, name: eraName });
  }

  _mergeRoster(rec, sig.players, ctx);
  _recordEvent(rec, ctx, sig);
  rec.updatedAt = now;
  _queueSave();
  return { rec, via: found.via, created };
}

// Write a producer's team-library edit through to the vault, PINNING whatever they set. This is
// what makes "edit once" stick: the next import reads these back instead of the raw start.gg data.
function upsertFromLibrary(team, opts = {}) {
  if (!team || !(team.name || '').trim()) return null;
  const sig = {
    name: team.name,
    startggTeamId: team.startggTeamId || null,
    startggSlug: team.startggSlug || null,
    players: team.players || [],
  };
  const found = resolve(sig);
  const now = Date.now();
  let rec = found.rec;

  if (!rec) {
    rec = _normalize({
      id: _nextId(), name: String(team.name).trim(),
      aliases: [], roster: [], events: [], pins: {}, source: opts.source || 'manual', createdAt: now,
    });
    _db.set(rec.id, rec);
  }

  if (opts.rename && norm(opts.rename) !== norm(team.name)) _addAlias(rec, opts.rename);
  _rename(rec, team.name);
  rec.pins.name = true;

  if (team.logo  !== undefined && team.logo)  { _setLogo(rec, team.logo, { source: opts.source || 'library' }); rec.pins.logo = true; }
  if (team.color !== undefined && team.color) { rec.color = team.color; rec.pins.color = true; }
  if (team.abbr  !== undefined && team.abbr)  { rec.abbr  = team.abbr;  rec.pins.abbr  = true; }
  if (typeof team.favorite === 'boolean') rec.favorite = team.favorite;
  if (team.startggTeamId) rec.startggTeamId = String(team.startggTeamId);
  if (team.startggSlug)   rec.startggSlug   = team.startggSlug;

  // A library save is an explicit statement of the CURRENT line-up, but it still must not erase
  // roster history: players it omits go inactive, they don't disappear.
  if (Array.isArray(team.players)) {
    const marked = team.players.map((p) => ({ ...p, source: p.source || 'manual' }));
    const byKey = new Map();
    rec.roster.forEach((p) => { const k = playerKey(p); if (k) byKey.set(k, p); });
    const seen = new Set();
    marked.forEach((p) => {
      const k = playerKey(p); if (!k) return;
      seen.add(k);
      const cur = byKey.get(k);
      if (cur) Object.assign(cur, { ...p, id: cur.id, source: cur.source, firstSeenAt: cur.firstSeenAt, rosterStatus: 'active', lastSeenAt: now });
      else rec.roster.push({ ...p, id: p.id || ('p' + Math.random().toString(36).slice(2, 9)), rosterStatus: 'active', firstSeenAt: now, lastSeenAt: now });
    });
    rec.roster.forEach((p) => { const k = playerKey(p); if (k && !seen.has(k) && !p.pinned) p.rosterStatus = 'inactive'; });
  }

  rec.updatedAt = now;
  _queueSave();
  return rec;
}

// Direct edit from the vault UI (field-level; only keys present are written).
function update(id, fields = {}) {
  const rec = _db.get(String(id));
  if (!rec) return null;
  const eraName = rec.name;   // captured before any rename, for the same reason as applyEntrant
  if (fields.name !== undefined && String(fields.name).trim()) {
    _rename(rec, fields.name);
    rec.pins.name = true;
  }
  // logo goes through _setLogo so the outgoing crest reaches brandHistory — this is also the path
  // a "revert to this old logo" click takes, which is why reverting banks the current one.
  if (fields.logo !== undefined) {
    _setLogo(rec, fields.logo, { source: fields.logoSource || 'manual', name: eraName });
    rec.pins.logo = !!fields.logo;
  }
  ['color', 'abbr', 'notes'].forEach((f) => {
    if (fields[f] === undefined) return;
    rec[f] = fields[f] || null;
    if (f !== 'notes') rec.pins[f] = !!fields[f];
  });
  if (fields.startggLogo !== undefined) {
    rec.startggLogo   = fields.startggLogo || null;
    rec.startggLogoAt = fields.startggLogo ? Date.now() : null;
  }
  // Explicitly forget one retired crest.
  if (fields.forgetBrandLogo) {
    rec.brandHistory = (rec.brandHistory || []).filter((h) => h.logo !== fields.forgetBrandLogo);
  }
  if (fields.startggSlug   !== undefined) rec.startggSlug   = fields.startggSlug || null;
  if (fields.startggTeamId !== undefined) rec.startggTeamId = fields.startggTeamId ? String(fields.startggTeamId) : null;
  // When the org's start.gg TEAM page was last read. Drives the automatic sweep's skip window, and
  // is stamped even on a failed/dead slug so one bad link isn't retried after every import.
  if (fields.enrichedAt !== undefined) rec.enrichedAt = Number(fields.enrichedAt) || null;
  if (typeof fields.favorite === 'boolean') rec.favorite = fields.favorite;
  if (fields.pins && typeof fields.pins === 'object') rec.pins = { ...rec.pins, ...fields.pins };
  if (Array.isArray(fields.roster)) {
    rec.roster = fields.roster.map((p) => ({
      ...p,
      id: p.id || ('p' + Math.random().toString(36).slice(2, 9)),
      rosterStatus: p.rosterStatus === 'inactive' ? 'inactive' : 'active',
    }));
  }
  if (Array.isArray(fields.aliases)) rec.aliases = [...new Set(fields.aliases.map(norm).filter(Boolean))];
  rec.updatedAt = Date.now();
  _queueSave();
  return rec;
}

// Flip one roster slot active/inactive. `pin` freezes it so imports stop moving it.
function setRosterStatus(id, playerId, rosterStatus, pin) {
  const rec = _db.get(String(id));
  if (!rec) return null;
  const p = rec.roster.find((x) => x.id === playerId || playerKey(x) === playerId);
  if (!p) return null;
  p.rosterStatus = rosterStatus === 'inactive' ? 'inactive' : 'active';
  if (pin !== undefined) p.pinned = !!pin;
  rec.updatedAt = Date.now();
  _queueSave();
  return rec;
}

function removePlayer(id, playerId) {
  const rec = _db.get(String(id));
  if (!rec) return null;
  const before = rec.roster.length;
  rec.roster = rec.roster.filter((x) => x.id !== playerId && playerKey(x) !== playerId);
  if (rec.roster.length !== before) { rec.updatedAt = Date.now(); _queueSave(); }
  return rec;
}

function remove(id) {
  const had = _db.delete(String(id));
  if (had) _queueSave();
  return had;
}

// Fold `fromId` into `intoId` — the fix for "the cascade made two records for one org". The target
// keeps its own branding and pins; it inherits the other's aliases, roster history and events.
function merge(intoId, fromId) {
  const a = _db.get(String(intoId));
  const b = _db.get(String(fromId));
  if (!a || !b || a === b) return null;
  _addAlias(a, b.name);
  (b.aliases || []).forEach((x) => { if (!a.aliases.includes(x)) a.aliases.push(x); });
  // The absorbed record's brand era is history too — including the name it competed under, and
  // its crest, which is often the reason the producer is merging in the first place.
  a.brandHistory = [...(a.brandHistory || []), ...(b.brandHistory || [])]
    .concat(b.logo && b.logo !== a.logo ? [{ logo: b.logo, name: b.name || '', color: b.color || null, abbr: b.abbr || null, source: 'merge', at: b.updatedAt || Date.now() }] : [])
    .filter((h, i, arr) => h && h.logo && h.logo !== a.logo && arr.findIndex((o) => o.logo === h.logo) === i)
    .sort((x, y) => (y.at || 0) - (x.at || 0))
    .slice(0, MAX_BRAND_HISTORY);
  a.nameHistory = [...(a.nameHistory || []), ...(b.nameHistory || [])]
    .concat(b.name ? [{ name: b.name, at: b.updatedAt || Date.now() }] : [])
    .filter((h, i, arr) => h && h.name && norm(h.name) !== norm(a.name) && arr.findIndex((o) => norm(o.name) === norm(h.name)) === i)
    .sort((x, y) => (y.at || 0) - (x.at || 0))
    .slice(0, MAX_NAME_HISTORY);
  if (!a.startggTeamId && b.startggTeamId) a.startggTeamId = b.startggTeamId;
  if (!a.startggSlug   && b.startggSlug)   a.startggSlug   = b.startggSlug;
  if (!a.logo  && b.logo  && !a.pins.logo)  a.logo  = b.logo;
  if (!a.color && b.color && !a.pins.color) a.color = b.color;
  if (!a.abbr  && b.abbr  && !a.pins.abbr)  a.abbr  = b.abbr;
  const have = new Set(a.roster.map(playerKey).filter(Boolean));
  (b.roster || []).forEach((p) => {
    const k = playerKey(p);
    if (!k || have.has(k)) return;
    have.add(k);
    // Everything arriving from the losing record is history until an import says otherwise.
    a.roster.push({ ...p, rosterStatus: 'inactive' });
  });
  const seenEv = new Set(a.events.map((e) => e && e.slug));
  (b.events || []).forEach((e) => { if (e && !seenEv.has(e.slug)) { seenEv.add(e.slug); a.events.push(e); } });
  a.events.sort((x, y) => (y.at || 0) - (x.at || 0));
  if (a.events.length > MAX_EVENTS) a.events.length = MAX_EVENTS;
  a.updatedAt = Date.now();
  _db.delete(String(fromId));
  _queueSave();
  return a;
}

// ── Projection ─────────────────────────────────────────────────────────────

// The vault record as a savedTeams-shaped entry. Only the ACTIVE roster ships — inactive players
// are history, and putting them on an overlay is exactly the bug this replaces.
function toLibraryTeam(rec, extra = {}) {
  if (!rec) return null;
  return {
    name: rec.name,
    logo: rec.logo || null,
    color: rec.color || null,
    ...(rec.abbr ? { abbr: rec.abbr } : {}),
    ...(rec.favorite ? { favorite: true } : {}),
    players: (rec.roster || [])
      .filter((p) => p.rosterStatus !== 'inactive')
      .map((p) => {
        const { rosterStatus, firstSeenAt, lastSeenAt, lastEvent, pinned, source, ...rest } = p;
        return rest;
      }),
    vaultId: rec.id,
    startggTeamId: rec.startggTeamId || undefined,
    startggSlug: rec.startggSlug || undefined,
    ...extra,
  };
}

function clearAll() { const n = _db.size; _db.clear(); if (n) _queueSave(); return n; }

module.exports = {
  init, close, all, count, get, search, stats,
  resolve, applyEntrant, upsertFromLibrary, update,
  setRosterStatus, removePlayer, remove, merge, toLibraryTeam, clearAll,
  norm, bare, playerKey,
};
