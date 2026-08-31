/* identity-core.js — pure (DOM-free) identity matching for players and team lineages.
 *
 * WHY THIS EXISTS. Every seeding signal used to be keyed on a gamertag STRING: the registration
 * sheet's "Jonesy", start.gg's "NE | Jonesy_" and rl6mans' "jonesy." were three different people,
 * and a team that rebranded between events lost its entire placement history because
 * getTeamPlacementScores() buckets on the normalized team NAME. This module replaces both keys:
 *
 *   players — a stable playerId carrying an ALIAS SET (start.gg slug, Epic, Steam, Discord,
 *             rl6mans name, plus every gamertag spelling we have seen). Sources resolve to the id.
 *   teams   — a lineage matched by ROSTER OVERLAP, not by name. The same three players under a new
 *             org tag is the same competitive entity and keeps its results.
 *
 * Kept free of DOM/globals so it runs in the control panel (script tag) and in the backend
 * (require) off one implementation — the same trick seed-resolve-core.js uses. Pure: no I/O, no
 * clock. Callers pass timestamps in where recency matters.
 */
(function (root) {
  'use strict';

  // ── Normalization ──────────────────────────────────────────────────────────
  // normTag mirrors seeding-spotlight.js's normTag() so CSV imports that already matched keep
  // matching. bareTag is the lossy last resort — it throws away every separator, which is what
  // makes "Jonesy_" and "j o n e s y" collide, so it is scored well below an exact hit.
  function normTag(s) {
    return (s || '').toString()
      .replace(/^[^|#]*[|]\s*/, '')     // strip "TEAM | " prefix
      .replace(/\s*[#]\w+$/, '')         // strip "#1234" discriminator suffix
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
  function bareTag(s) { return normTag(s).replace(/[^a-z0-9]/g, ''); }

  // start.gg slugs arrive as "user/abc123" or bare depending on the query; Epic/Steam arrive with
  // wildly inconsistent casing. Strong ids are compared case-folded but NOT stripped — a Steam id64
  // and an Epic display name must never be flattened into the same key.
  function normStrong(v) { return (v || '').toString().trim().toLowerCase().replace(/^user\//, ''); }

  // The alias kinds we index. STRONG_KINDS are platform-unique account identifiers: an exact hit is
  // proof of identity. gamertag is a display name — many people share one, so it can only ever be
  // evidence. sixmans sits between: unique on rl6mans.com, but that site is not the account system.
  const ALIAS_KINDS = ['startgg', 'epic', 'steam', 'discord', 'sixmans', 'gamertag'];
  const STRONG_KINDS = ['startgg', 'epic', 'steam', 'discord'];

  function isStrongKind(kind) { return STRONG_KINDS.indexOf(kind) >= 0; }

  // Index key(s) for an alias. Gamertags index on BOTH normTag and bareTag (two keys, one alias) so
  // a lookup can tell an exact spelling hit from a punctuation-stripped one and score them apart.
  //
  // Both keys are emitted even when the two forms are identical. They must be: the keys are used for
  // storing AND looking up, so a stored "Jonesy" (where norm === bare) that only registered
  // "gamertag:jonesy" is invisible to an incoming "NE | Jonesy_", whose exact form is "jonesy_" and
  // whose only route back is the "gamertag~:jonesy" bucket.
  function aliasKeys(kind, value) {
    if (!kind || value == null || value === '') return [];
    if (kind === 'gamertag') {
      const n = normTag(value), b = bareTag(value);
      const out = [];
      if (n) out.push('gamertag:' + n);
      if (b) out.push('gamertag~:' + b);
      return out;
    }
    const v = normStrong(value);
    return v ? [kind + ':' + v] : [];
  }

  // ── Match scoring ──────────────────────────────────────────────────────────
  // 0-100 confidence that a lookup input IS a stored identity. The bands below are the whole
  // policy: AUTO_LINK and above resolves silently, REVIEW..AUTO_LINK goes to the producer as an
  // ambiguous match with candidates, below REVIEW is treated as a new player.
  const MATCH_SCORE = {
    strong:        100,   // exact start.gg / Epic / Steam / Discord id
    sixmans:        95,   // exact rl6mans profile name
    gamertag:       72,   // exact gamertag spelling (normTag)
    gamertagLoose:  64,   // same gamertag once punctuation is stripped
    fuzzyMax:       58,   // ceiling for edit-distance matches — never auto-links on its own
    fuzzyMin:       38,
  };
  const AUTO_LINK = 90;   // at or above this, resolve without asking
  const REVIEW    = 38;   // at or above this, offer as a candidate; below is a new player
  const CORROBORATION_BONUS = 8;   // per additional independent alias kind agreeing on the same record

  // Bounded Levenshtein. Bails out as soon as the best possible distance exceeds max, so a long
  // gamertag list stays cheap (this runs over every stored alias for every unmatched input).
  function editDistance(a, b, max) {
    a = a || ''; b = b || '';
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (max == null) max = Math.max(la, lb);
    if (Math.abs(la - lb) > max) return max + 1;
    if (!la) return lb;
    if (!lb) return la;
    let prev = new Array(lb + 1), cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      let rowMin = cur[0];
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      const t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }

  // Similarity 0-1 on the bare forms. Short names are held to a stricter bar: one edit in a
  // 4-character tag is a different person far more often than one edit in a 12-character one.
  function similarity(a, b) {
    const x = bareTag(a), y = bareTag(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    const len = Math.max(x.length, y.length);
    const maxEdits = len <= 5 ? 1 : len <= 9 ? 2 : 3;
    const d = editDistance(x, y, maxEdits);
    if (d > maxEdits) return 0;
    return 1 - d / len;
  }
  const FUZZY_MIN_SIM = 0.78;   // below this we do not even offer it as a candidate

  // ── Identity resolution ────────────────────────────────────────────────────
  // input  : { gamertag, startgg, epic, steam, discord, sixmans } — any subset.
  // store  : { byKey: Map(aliasKey -> playerId), records: Map(playerId -> record) } from buildIndex().
  // Returns: { id, score, matchedOn, contested, status:'auto'|'review'|'new', candidates:[…] }
  //
  // Strong hits short-circuit. Everything else accumulates per-candidate evidence and takes the
  // best; agreement between two independent aliases adds a bonus, because two weak signals pointing
  // at the same record is qualitatively better than one.
  function resolveIdentity(input, store, opts) {
    opts = opts || {};
    const get = (m, k) => (m instanceof Map ? m.get(k) : m[k]);
    const byKey = (store && store.byKey) || new Map();
    const records = (store && store.records) || new Map();
    // id -> { kind -> bestScore }. Evidence is banked PER ALIAS KIND, not per index hit: a gamertag
    // lands on two keys (exact + punctuation-stripped) and those are one signal, not two. Only
    // distinct kinds corroborate — see the CORROBORATION_BONUS fold below.
    const evidence = new Map();
    const bump = (id, kind, score, how) => {
      if (!id) return;
      let byKind = evidence.get(id);
      if (!byKind) { byKind = new Map(); evidence.set(id, byKind); }
      const cur = byKind.get(kind);
      if (!cur || score > cur.score) byKind.set(kind, { score, how });
    };

    for (const kind of ALIAS_KINDS) {
      const raw = input && input[kind];
      if (!raw) continue;
      const keys = aliasKeys(kind, raw);
      for (let ki = 0; ki < keys.length; ki++) {
        const id = get(byKey, keys[ki]);
        if (!id) continue;
        if (isStrongKind(kind)) {
          // An exact platform-account hit is identity, full stop — no further evidence needed.
          return { id, score: MATCH_SCORE.strong, matchedOn: [kind], contested: false, status: 'auto', candidates: [{ id, score: MATCH_SCORE.strong, matchedOn: [kind] }] };
        }
        if (kind === 'sixmans') bump(id, 'sixmans', MATCH_SCORE.sixmans, 'sixmans');
        else bump(id, 'gamertag', ki === 0 ? MATCH_SCORE.gamertag : MATCH_SCORE.gamertagLoose, ki === 0 ? 'gamertag' : 'gamertag~');
      }
    }

    // Fuzzy sweep over stored gamertags — only for inputs that produced no exact hit at all, and
    // only when the caller supplies a gamertag. This is the expensive path; it is capped.
    const tag = input && input.gamertag;
    if (tag && !evidence.size && opts.fuzzy !== false) {
      const list = records instanceof Map ? records.values() : Object.values(records || {});
      let scanned = 0;
      const cap = opts.fuzzyCap || 5000;
      for (const rec of list) {
        if (++scanned > cap) break;
        const tags = (rec && rec.aliases && rec.aliases.gamertag) || [];
        let best = 0;
        for (const t of tags) { const s = similarity(tag, t); if (s > best) best = s; }
        if (best >= FUZZY_MIN_SIM && best < 1) {
          const span = MATCH_SCORE.fuzzyMax - MATCH_SCORE.fuzzyMin;
          const score = Math.round(MATCH_SCORE.fuzzyMin + span * ((best - FUZZY_MIN_SIM) / (1 - FUZZY_MIN_SIM)));
          bump(rec.id, 'fuzzy', score, 'fuzzy');
        }
      }
    }

    if (!evidence.size) return { id: null, score: 0, matchedOn: [], contested: false, status: 'new', candidates: [] };
    // Fold each candidate's per-kind evidence into one score: the strongest single signal, plus a
    // bonus per ADDITIONAL independent kind that agrees. Capped below MATCH_SCORE.strong so no pile
    // of display-name evidence can ever impersonate an exact platform-id match.
    const ranked = [...evidence.entries()].map(([id, byKind]) => {
      const parts = [...byKind.values()].sort((a, b) => b.score - a.score);
      const score = Math.min(parts[0].score + CORROBORATION_BONUS * (parts.length - 1), MATCH_SCORE.strong - 1);
      return { id, score, matchedOn: parts.map((p) => p.how) };
    }).sort((a, b) => b.score - a.score);
    const top = ranked[0], runnerUp = ranked[1];
    // Two records matching almost equally well means the aliases themselves are ambiguous — that is
    // the same-name-different-player case, so refuse to auto-link however high it scored.
    const contested = !!(runnerUp && top.score - runnerUp.score < 10);
    const status = (top.score >= AUTO_LINK && !contested) ? 'auto'
                 : top.score >= REVIEW ? 'review'
                 : 'new';
    return {
      id: status === 'new' ? null : top.id,
      score: top.score, matchedOn: top.matchedOn, contested, status,
      candidates: ranked.slice(0, 6),
    };
  }

  // Build the lookup index from a flat list of identity records.
  // record: { id, primary, aliases: { gamertag:[], startgg:[], epic:[], … }, verified }
  // A key claimed by two records is left pointing at the FIRST — a collision means the two records
  // should be merged, and silently repointing it would hide that from the producer.
  // Fold ONE record into an existing index, in place. Deliberately identical in effect to the pass
  // buildIndex() would make over that record — first owner of a key wins, a rival owner is reported
  // as a collision rather than overwriting — so an index maintained incrementally is
  // indistinguishable from a freshly built one.
  //
  // This exists so a store can keep its index HOT across writes. Rebuilding after every write is
  // O(all players) per write, which turned the identity backfill (~9.4k upserts over ~4.6k players)
  // into a three-minute stall on every app launch.
  //
  // ADDITIVE ONLY. A record whose aliases were REMOVED cannot be fixed up in place, because a key
  // it no longer owns is still pointing at it; those callers must rebuild.
  function indexRecord(index, rec) {
    if (!index || !rec || !rec.id) return index;
    index.records.set(rec.id, rec);
    if (!index.collisionKeys) index.collisionKeys = new Set();
    ALIAS_KINDS.forEach((kind) => {
      ((rec.aliases && rec.aliases[kind]) || []).forEach((v) => {
        aliasKeys(kind, v).forEach((k) => {
          const owner = index.byKey.get(k);
          if (owner && owner !== rec.id) {
            // Re-touching a record must not re-report a collision it already carries, or the count
            // would climb every time the record is written.
            // ids can't contain ':', so putting the free-form alias key LAST keeps this unambiguous.
            const sig = owner + ':' + rec.id + ':' + k;
            if (!index.collisionKeys.has(sig)) {
              index.collisionKeys.add(sig);
              index.collisions.push({ key: k, ids: [owner, rec.id] });
            }
            return;
          }
          index.byKey.set(k, rec.id);
        });
      });
    });
    return index;
  }

  function buildIndex(records) {
    const index = { byKey: new Map(), records: new Map(), collisions: [], collisionKeys: new Set() };
    (records || []).forEach((rec) => indexRecord(index, rec));
    return index;
  }

  // ── Verification tiers ─────────────────────────────────────────────────────
  // What a player's identity status is WORTH to the rating engine. This is the gate: a rank typed
  // into a registration form by someone we could not identify must not outvote our own tournament
  // results, which is exactly what it did when CSV import stamped every row at confidence 60.
  //
  //   verified   — a human confirmed the link, or a strong platform id matched exactly.
  //   probable   — exact gamertag/6mans hit, nobody has confirmed it.
  //   unverified — no match; the name is all we have.
  //   conflicted — matched, but something disagrees (region mismatch, contested aliases).
  const IDENTITY_TIER = { verified: 1.0, probable: 0.8, unverified: 0.45, conflicted: 0.3 };
  const TIER_ORDER = ['conflicted', 'unverified', 'probable', 'verified'];

  function tierFromResolve(res) {
    if (!res || res.status === 'new') return 'unverified';
    if (res.contested) return 'conflicted';
    if (res.score >= MATCH_SCORE.strong) return 'verified';
    if (res.score >= MATCH_SCORE.gamertagLoose) return 'probable';
    return 'unverified';
  }

  // Scale a source confidence by how sure we are the rank belongs to this player at all. A rank is
  // only as trustworthy as the identity it is attached to, so the two multiply rather than the
  // identity acting as a separate later filter.
  function capConfidence(confidence, tier) {
    const f = IDENTITY_TIER[tier] != null ? IDENTITY_TIER[tier] : IDENTITY_TIER.unverified;
    return Math.max(0, Math.round((confidence || 0) * f));
  }

  // ── Team lineage (roster continuity) ───────────────────────────────────────
  function rosterOverlap(a, b) {
    const A = new Set((a || []).filter(Boolean));
    const B = new Set((b || []).filter(Boolean));
    if (!A.size || !B.size) return { shared: 0, ratio: 0, jaccard: 0, union: A.size + B.size };
    let shared = 0;
    A.forEach((x) => { if (B.has(x)) shared++; });
    const union = A.size + B.size - shared;
    return { shared, ratio: shared / Math.min(A.size, B.size), jaccard: union ? shared / union : 0, union };
  }

  // Is this the same competitive entity? Ratio-driven so it scales across roster sizes: 2-of-3 (RL)
  // clears 0.6, 3-of-5 (Valorant) clears it, 2-of-5 does not. Two shared players is the floor —
  // one returning player is a transfer, not a lineage.
  const LINEAGE_MIN_SHARED = 2;
  const LINEAGE_MIN_RATIO  = 0.6;

  function lineageScore(overlap, sameName) {
    if (!overlap || overlap.shared < LINEAGE_MIN_SHARED) return sameName ? 55 : 0;
    if (overlap.ratio < LINEAGE_MIN_RATIO) return sameName ? 60 : 0;
    // 0.6 ratio -> ~70, full roster -> ~95; an unchanged name on top of a roster match is
    // corroboration, not the basis.
    const base = 70 + Math.round((overlap.ratio - LINEAGE_MIN_RATIO) / (1 - LINEAGE_MIN_RATIO) * 25);
    return Math.min(99, base + (sameName ? 4 : 0));
  }

  // Match a roster against known lineages.
  // lineages: [{ id, names:[…], rosters:[{ playerIds:[], at }] }]
  // Each lineage is scored on its BEST historical roster — a team that ran a stand-in for one event
  // should still match its core, so averaging across rosters would wrongly punish it.
  function matchLineage(playerIds, name, lineages, opts) {
    opts = opts || {};
    const nName = bareTag(name);
    const out = [];
    (lineages || []).forEach((L) => {
      if (!L) return;
      const sameName = !!(nName && (L.names || []).some((n) => bareTag(n) === nName));
      let best = null;
      (L.rosters || []).forEach((r) => {
        const ov = rosterOverlap(playerIds, r && r.playerIds);
        const sc = lineageScore(ov, sameName);
        if (!best || sc > best.score) best = { score: sc, overlap: ov, at: r && r.at };
      });
      if (!best && sameName) best = { score: 55, overlap: { shared: 0, ratio: 0, jaccard: 0 }, at: null };
      if (best && best.score > 0) {
        out.push({ id: L.id, name: (L.names || [])[0] || '', sameName, score: best.score, overlap: best.overlap, at: best.at });
      }
    });
    out.sort((a, b) => b.score - a.score);
    const min = opts.minScore != null ? opts.minScore : 55;
    const top = out[0];
    return {
      id: top && top.score >= min ? top.id : null,
      score: top ? top.score : 0,
      basis: top ? (top.overlap.shared >= LINEAGE_MIN_SHARED ? 'roster' : 'name') : null,
      candidates: out.slice(0, 6),
    };
  }

  const api = {
    normTag, bareTag, normStrong, aliasKeys, isStrongKind, ALIAS_KINDS, STRONG_KINDS,
    MATCH_SCORE, AUTO_LINK, REVIEW, FUZZY_MIN_SIM, CORROBORATION_BONUS,
    editDistance, similarity, resolveIdentity, buildIndex, indexRecord,
    IDENTITY_TIER, TIER_ORDER, tierFromResolve, capConfidence,
    rosterOverlap, lineageScore, matchLineage, LINEAGE_MIN_SHARED, LINEAGE_MIN_RATIO,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.IdentityCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
