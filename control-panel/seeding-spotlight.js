/* ─── seeding-spotlight.js — Seeding studio + Spotlight/Teams-to-Watch domains ──
   Seeding studio (team→player seeding, drag order, start.gg push), rl6mans rank
   verification, Spotlight & watchlist overlay builders, start.gg entrant linking.
   Also carries shared profile-link utils (teStartggLink/teSixmansLink/
   playerProfileChips/csvParse) that the Teams editor calls at runtime.
   Extracted verbatim from app.js (2026-07). Loads after app.js. */

// ── Seeding studio ───────────────────────────────────────────────────────────
// Funneled through My Events. Pull entrants + current seeds from start.gg (events you admin) OR
// import a CSV (outside TOs). Drag to reorder, sort, save onto the event, copy/export the list.
let _seedEvent = null;          // the My Events entry being seeded
let _seedRows = [];             // [{ entrantId, name, seedNum, players:[{gamerTag,rank,rankValue}], leaguePts }]
let _seedIncomplete = [];       // teams with fewer players than the game's roster size — parked on the Incomplete tab, out of the seed board until their roster fills in (re-pull from start.gg)
let _pendingCsvRows = null;     // CSV rows held while the column-mapping modal is open
let _seedDragIdx = -1;
let _seedLeagueId = '';         // optional league cross-reference (returning teams seed by points)
let _seedMode = 'rl-6mans';     // active rank system (per-event)
let _seedAgg = 'best';          // how a team's value aggregates its players: best | avg | sum
let _seedSortKey = 'rank';      // current order: rank | league | seed | name
let _seedTab = 'verified';      // active seeding tab: 'verified' | 'unverified'
let _seedUnvSort = 'unranked';  // unverified tab sort: 'unranked' | 'name'
let _seedUnvShowAll = false;    // when true, show all teams including verified ones
let _seedTeamSize = 0;          // per-event players-per-team override (0 = auto-derive, see seedRosterSize)
let _seedSizeWhy = '';          // how the auto-derived size was decided, for the sidebar note

// Rank systems per title. kind 'num' = free number (MMR/Premier/Elo); 'tier' = named tiers + division.
const SEED_RANK_MODES = {
  // rl6mans: MMR-canonical (continuous ELO) with the tier ladder as a display bucket. Every source
  // normalizes to an MMR estimate; the seed value is a confidence-weighted blend (see seedApplyEstimate).
  'rl-6mans': { label: 'Rocket League · 6mans (MMR-weighted)', kind: 'tier', nodiv: true, canonical: 'mmr', mmrRange: [100, 1600], ph: 'e.g. A, B+, H', tiers: ['H', 'E', 'D', 'C', 'B', 'B+', 'A', 'X', 'S'] },
  'rl-tier':  { label: 'Rocket League · Ranked (standard)',        kind: 'tier', ph: 'e.g. Diamond II', tiers: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Champion', 'Grand Champion', 'Supersonic Legend'] },
  'val':      { label: 'Valorant · Rank',           kind: 'tier', ph: 'e.g. Immortal 2', tiers: ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal', 'Radiant'] },
  'cs2':      { label: 'CS2 · Premier rating',      kind: 'num',  ph: 'Premier e.g. 18500' },
  'ow':       { label: 'Overwatch 2 · Rank',        kind: 'tier', ph: 'e.g. Master 3', tiers: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Grandmaster', 'Champion'] },
  'apex':     { label: 'Apex Legends · Rank',       kind: 'tier', ph: 'e.g. Diamond 4', tiers: ['Rookie', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Apex Predator'] },
  'generic':  { label: 'Generic · number / Elo',    kind: 'num',  ph: 'number' },
};
function seedMode() { return SEED_RANK_MODES[_seedMode] || SEED_RANK_MODES.generic; }

// ── 6mans MMR canonical layer (Rocket League) ──────────────────────────────
// For MMR-canonical modes every source becomes an estimate {source, mmr, confidence, detail, tier?,
// exactElo?} on p.estimates[]; the seed value p.seedMMR is their confidence-weighted blend, and p.rank
// is just the tier bucket of that MMR. Non-MMR games never touch this path (they keep p.rankValue via
// seedRankValue). See seed-resolve-core.js.
function seedIsMMR() { return seedMode().canonical === 'mmr'; }
let _seedMidpoints = (window.SeedResolveCore ? window.SeedResolveCore.SIXMANS_TIER_DEFAULTS.slice() : [100, 250, 400, 550, 700, 850, 1050, 1300, 1600]);
let _seedMidpointMeta = null;
// The base ladder per-event calibration builds on. SIXMANS_TIER_DEFAULTS is a rough hardcoded guess and
// is badly off the real rl6mans scale (it puts A at 1050 where real players sit far higher), so we
// replace it with a ladder MEASURED off the rl6mans leaderboards — see seedLoadTierLadder.
let _seedLadderBase = (window.SeedResolveCore ? window.SeedResolveCore.SIXMANS_TIER_DEFAULTS.slice() : [100, 250, 400, 550, 700, 850, 1050, 1300, 1600]);
let _seedLadderMeta = null;     // { tiers:[{tier,elo,n,source}], region, players, measuredTiers, measuredAt }
// Which tiers this region actually has players in. A region with nobody at S or X (EU and NA, at
// time of writing) cannot produce an S-rank player, so a sheet claiming one must not be handed an
// ELO no living player there holds. Unmeasured ladder => no cap, i.e. previous behaviour.
function seedPopulatedTiers() {
  const meta = _seedLadderMeta;
  if (!meta || !Array.isArray(meta.tiers)) return null;
  return meta.tiers.filter((t) => (t.n || 0) > 0).map((t) => t.tier);
}
function seedTierToMMR(tier) {
  const C = window.SeedResolveCore; if (!C) return null;
  const m = C.mmrFromTier(tier, _seedMidpoints);
  if (m == null) return null;
  return C.capToPopulatedTiers(m, seedPopulatedTiers(), _seedMidpoints);
}
function seedMMRToTier(mmr) { const C = window.SeedResolveCore; return C ? C.tierFromMMR(mmr, _seedMidpoints) : null; }

// Pull the measured tier→ELO ladder (median real ELO per tier off the rl6mans leaderboards) and adopt
// it as the base. Server-cached for a day, so this is normally instant; refresh:true re-scrapes.
// Best-effort — on failure we keep whatever base we already had rather than blocking seeding.
async function seedLoadTierLadder(refresh) {
  const btn = el('seed-calibrate-ladder');
  if (btn) { btn.disabled = true; btn.textContent = refresh ? 'Measuring…' : btn.textContent; }
  try {
    const r = await fetch('http://localhost:3000/api/rl6mans/tier-ladder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: el('seed-6mans-region')?.value || 'ALL', refresh: refresh === true }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(d.midpoints) || d.midpoints.length !== 9) throw new Error(d.error || 'No ladder returned');
    _seedLadderBase = d.midpoints.slice();
    _seedLadderMeta = d;
    // Re-run per-event calibration on the new base so every tier-derived estimate re-values.
    seedCalibrateMidpoints();
    seedRecomputeValues();
    if (_seedRows.length) seedSort(_seedSortKey);
    seedRenderLadderNote();
    if (refresh) seedStatus(`✓ 6mans ELO ladder measured from ${d.players} leaderboard players — ${d.measuredTiers}/9 tiers from real data.`, 'ok');
    return true;
  } catch (e) {
    if (refresh) seedStatus(`Couldn't measure the ELO ladder — ${e.message || 'rl6mans unreachable'}. Keeping the current one.`, 'err');
    console.warn('[seed-ladder]', e);
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Re-measure ELO ladder'; }
  }
}
// Show the ladder in the sidebar so the numbers seeding runs on are never invisible.
function seedRenderLadderNote() {
  const note = el('seed-ladder-note'); if (!note) return;
  if (!_seedLadderMeta) { note.textContent = 'Using the built-in ELO ladder (not measured yet).'; return; }
  const m = _seedLadderMeta;
  const ladder = (window.SeedResolveCore ? window.SeedResolveCore.SIXMANS_TIERS : [])
    .map((t, i) => `${t} ${_seedMidpoints[i]}`).join(' · ');
  // Be straight about it when the leaderboards yielded no usable ELOs — the ladder is then still the
  // built-in guess, and only verified players (whose profiles carry an exact ELO) will correct it.
  note.textContent = m.measuredTiers === 0
    ? `rl6mans leaderboards returned no ELOs — still on the built-in ladder: ${ladder}`
    : `Measured off ${m.players} rl6mans players (${m.measuredTiers}/9 tiers real): ${ladder}`;
}
// Learn the tier→MMR ladder from this event's rl6mans-exact players (they carry both a tier and a real
// ELO), then refresh every tier-derived estimate under the new ladder. Falls back per-tier to the
// measured leaderboard ladder for tiers this event doesn't have enough verified players in.
function seedCalibrateMidpoints() {
  const C = window.SeedResolveCore; if (!C) return;
  const samples = [];
  seedAllRows().forEach((r) => (r.players || []).forEach((p) => (p.estimates || []).forEach((e) => {
    if (e.source === 'sixmans' && e.exactElo > 0 && e.tier) samples.push({ tier: e.tier, elo: e.exactElo });
  })));
  const cal = C.calibrateTierMidpoints(samples, _seedLadderBase, { minSamples: 2, minGap: 50 });
  _seedMidpoints = cal.midpoints; _seedMidpointMeta = cal.meta;
  // Tier-derived estimates (manual, tracker, tier-only 6mans) were computed with the old ladder — refresh.
  seedAllRows().forEach((r) => (r.players || []).forEach((p) => {
    (p.estimates || []).forEach((e) => { if (e.tier && !(e.exactElo > 0)) { const m = seedTierToMMR(e.tier); if (m != null) e.mmr = m; } });
    blendMMRToPlayer(p);
  }));
  seedRenderLadderNote();
}
// ── Manual override ────────────────────────────────────────────────────────
// A rank the producer typed into a player's box is a DECISION, not another opinion to be averaged.
// It used to be filed as a 'manual' estimate at 60% confidence and then blended — which meant that on
// any player who already had a verified rl6mans reading (98%) the blend, sharpened by k=5, weighted the
// override at (60/98)^5 ≈ 9% and the typed value snapped straight back. It looked like the edit didn't
// save. It now sets p.override, which wins outright over the blend.
//
// The auto blend is still computed and kept on p.auto, so the "why" panel can show what the sources
// said and what you overrode — and so Revert restores it exactly.
function seedIsOverridden(p) { return !!(p && p.override && (p.override.tier || Number.isFinite(p.override.mmr))); }
function seedSetOverride(p, typed) {
  if (!p) return false;
  const t = (typed || '').trim();
  if (!t) { seedClearOverride(p); return false; }
  if (seedIsMMR()) {
    // Accept either a tier letter ("B+") or a raw ELO ("1420") — producers use both.
    const asNum = /^[\d.]+$/.test(t) ? parseFloat(t) : null;
    const mmr = (asNum != null && asNum > 0) ? asNum : seedTierToMMR(t);
    if (mmr == null) return false;                       // unparseable — leave the player alone
    p.override = { tier: asNum != null ? (seedMMRToTier(asNum) || '') : t, mmr, at: Date.now() };
  } else {
    const rv = seedRankValue(t, _seedMode);
    p.override = { tier: t, rankValue: rv, at: Date.now() };
  }
  seedApplyPlayerValue(p);
  return true;
}
function seedClearOverride(p) {
  if (!p) return;
  delete p.override;
  seedApplyPlayerValue(p);
}
// Resolve a player's EFFECTIVE rank: the override if there is one, else whatever auto worked out.
// Every write path ends here, so an override can never be silently outvoted.
function seedApplyPlayerValue(p) {
  if (!p) return;
  if (seedIsMMR()) blendMMRToPlayer(p);
  else {
    if (seedIsOverridden(p)) {
      p.rank = p.override.tier || '';
      p.rankValue = Number.isFinite(p.override.rankValue) ? p.override.rankValue : seedRankValue(p.rank, _seedMode);
      p.source = 'override'; p.confidence = 100;
      p.sourceDetail = `You set this to ${p.rank}` + (p.auto && p.auto.rank ? ` · auto said ${p.auto.rank}` : '');
    } else if (p.auto && p.auto.rank) {
      p.rank = p.auto.rank; p.rankValue = p.auto.rankValue;
      p.source = p.auto.source; p.sourceDetail = p.auto.detail || '';
      // Non-MMR modes have no estimate blend to scale, so the identity gate is applied to the
      // resolved confidence directly here — same rule, other half of the cascade.
      p.confidence = seedGateConfidence(p, p.auto.confidence);
    }
  }
}
// Blend a player's estimates → seedMMR + display tier + dominant source/confidence + breakdown tooltip.
function blendMMRToPlayer(p) {
  const C = window.SeedResolveCore; if (!C || !p) return;
  // k=5 sharpens the confidence weighting so the highest-accuracy source strongly dominates: a
  // verified rl6mans exact ELO (conf ~98) outweighs a placement guess (~50) by (98/50)^5 ≈ 25×, so
  // weak sources nudge the seed by only a few ELO instead of dragging it a full tier. Near-peer
  // sources still blend meaningfully — it's dominant, not absolute.
  const b = C.blendEstimates(seedGatedEstimates(p), { k: 5 });
  const lbl = SEED_SRC_SHORT;
  // What auto thinks, always kept — the override displaces it on screen but never erases it.
  p.auto = (b.mmr == null) ? null : {
    mmr: b.mmr, rank: seedMMRToTier(b.mmr) || '',
    source: b.dominant ? b.dominant.source : '', confidence: b.confidence,
    detail: (b.breakdown || []).map((e) => `${lbl[e.source] || e.source} ${Math.round(e.mmr)} (${e.confidence}%)`).join(' · ')
      + ` → blend ${b.mmr}`,
  };
  const exact = (p.estimates || []).find((e) => e.exactElo > 0);
  p.elo = exact ? exact.exactElo : (p.elo || null);

  if (seedIsOverridden(p)) {
    p.seedMMR = p.override.mmr; p.rankValue = p.override.mmr;
    p.rank = p.override.tier || seedMMRToTier(p.override.mmr) || '';
    p.source = 'override'; p.confidence = 100;
    p.sourceDetail = `You set this to ${p.rank} (${Math.round(p.override.mmr)})`
      + (p.auto ? ` · auto said ${p.auto.rank} (${p.auto.mmr})` : '');
    return;
  }
  if (!p.auto) { p.seedMMR = null; p.rankValue = null; p.rank = ''; p.source = ''; p.confidence = 0; p.sourceDetail = ''; return; }
  p.seedMMR = p.auto.mmr; p.rankValue = p.auto.mmr; p.rank = p.auto.rank;
  p.source = p.auto.source; p.confidence = p.auto.confidence; p.sourceDetail = p.auto.detail;
}
// Upsert one estimate per source and re-blend. THE single write path for MMR-canonical modes.
// An overridden player still COLLECTS estimates (so the why-panel can show what auto found, and so
// Revert has something to fall back to) — seedApplyPlayerValue just keeps the override on top.
function seedApplyEstimate(p, est) {
  if (!p || !est || !Number.isFinite(est.mmr) || !(est.confidence > 0)) return false;
  if (!Array.isArray(p.estimates)) p.estimates = [];
  // 6mans-verified authority (rl6mans exact ELO is the gold standard): a verified 6mans always beats
  // tracker.gg, which is a fallback only. So skip a tracker estimate when a verified 6mans exists,
  // and when a verified 6mans arrives, evict any tracker estimate that was already blended in.
  const hasVerified6m = p.estimates.some((e) => e.source === 'sixmans' && e.exactElo > 0);
  if (est.source === 'tracker' && hasVerified6m) return false;
  if (est.source === 'sixmans' && est.exactElo > 0) p.estimates = p.estimates.filter((e) => e.source !== 'tracker');
  const i = p.estimates.findIndex((e) => e.source === est.source);
  if (i >= 0) p.estimates[i] = est; else p.estimates.push(est);
  blendMMRToPlayer(p);
  return true;
}
function seedRemoveEstimate(p, source) {
  if (!p || !Array.isArray(p.estimates)) return;
  p.estimates = p.estimates.filter((e) => e.source !== source);
  blendMMRToPlayer(p);
}
// Non-MMR equivalent of seedApplyEstimate: record what auto worked out on p.auto, then let
// seedApplyPlayerValue decide whether it or the override is what actually shows. Without this an
// auto pass would overwrite a typed rank the moment it ran.
function seedResolveApply(p, cand) {
  const C = window.SeedResolveCore; if (!C || !p || !cand) return false;
  // Let the core's keep-highest-confidence rule arbitrate between AUTO sources only, on a scratch
  // object, so an override never takes part in (or is beaten by) that comparison.
  const scratch = p.auto ? { source: p.auto.source, confidence: p.auto.confidence, rank: p.auto.rank, rankValue: p.auto.rankValue, sourceDetail: p.auto.detail } : {};
  const applied = C.resolveApply(scratch, cand);
  if (applied) p.auto = { source: scratch.source, confidence: scratch.confidence, rank: scratch.rank, rankValue: scratch.rankValue, detail: scratch.sourceDetail || cand.detail || '' };
  seedApplyPlayerValue(p);
  return applied;
}
// Estimate builders from raw lookup results (used by both the unverified-tab buttons and the cascade).
function seedEst6mans(result, conf, detail) {
  if (!result || !result.found) return null;
  const tier = (result.rank && result.rank !== 'Unranked') ? result.rank : '';
  if (result.elo > 0) return { source: 'sixmans', mmr: result.elo, confidence: conf, tier: tier || seedMMRToTier(result.elo), exactElo: result.elo, detail: detail || 'rl6mans.com' };
  if (tier) { const m = seedTierToMMR(tier); if (m != null) return { source: 'sixmans', mmr: m, confidence: Math.min(conf, 70), tier, detail: (detail || 'rl6mans.com') + ' (tier only)' }; }
  return null;
}
function seedEstTracker(result, conf, detail) {
  if (!result || !result.found || !result.sixmansTier) return null;   // no 6mans tier → skip (never raw RL MMR)
  const m = seedTierToMMR(result.sixmansTier); if (m == null) return null;
  return { source: 'tracker', mmr: m, confidence: conf, tier: result.sixmansTier, detail: detail || 'tracker.gg' };
}
function seedEstManual(tier, detail) {
  const t = (tier || '').trim(); if (!t) return null;
  const m = seedTierToMMR(t); if (m == null) return null;
  return { source: 'manual', mmr: m, confidence: 60, tier: t, detail: detail || 'Entered manually' };
}
// Migrate a player that carries a plain rank/source but no estimates (CSV-built teams, boards saved
// before the MMR rework, prior numeric-mode ranks) into one synthesized estimate so the blend
// reproduces its value — then re-blend. A leaked numeric "1180" now becomes a legitimate MMR estimate.
function seedMigratePlayerEstimates(p) {
  if (!p || !seedIsMMR()) return;
  // An overridden player's displayed rank is the override, NOT a reading to be back-derived into a
  // fake "manual" estimate — that would turn a decision into a source and let the blend outvote it.
  if (seedIsOverridden(p)) { blendMMRToPlayer(p); return; }
  if (Array.isArray(p.estimates) && p.estimates.length) { blendMMRToPlayer(p); return; }
  p.estimates = [];
  const rankStr = ('' + (p.rank || '')).trim();
  if (rankStr) {
    const src = p.source || 'manual';
    const conf = p.confidence || (src === 'manual' ? 60 : 90);
    let mmr = null, tier = null, exactElo;
    if (p.elo > 0 && src === 'sixmans') { mmr = p.elo; exactElo = p.elo; tier = seedMMRToTier(p.elo); }
    else if (/^[\d.]+$/.test(rankStr)) { const n = parseFloat(rankStr); if (n > 0) { mmr = n; tier = seedMMRToTier(n); if (src === 'sixmans') exactElo = n; } }
    else { const m = seedTierToMMR(rankStr); if (m != null) { mmr = m; tier = rankStr; } }
    if (mmr != null) p.estimates = [{ source: src, mmr, confidence: conf, tier, exactElo, detail: 'restored' }];
  }
  blendMMRToPlayer(p);
}
function seedMigrateAllEstimates() { if (seedIsMMR()) _seedRows.forEach((r) => (r.players || []).forEach((p) => seedMigratePlayerEstimates(p))); }
// A team is "verified" when every player has a non-empty rank.
function isTeamVerified(row) {
  const ps = row.players || [];
  return ps.length > 0 && ps.every((p) => p.rank && p.rank.trim());
}

// Every team the studio is holding, board + parked, as one list.
function seedAllRows() { return [..._seedRows, ..._seedIncomplete]; }

// The game registry's nominal roster size (RL=3, CS2/Val/OW=5, CoD=4…), resolved from the event's game
// and falling back to the active seed mode. This is the game's DEFAULT format, not this event's.
function seedGameRosterSize() {
  const games = currentState.games || {};
  const g = _seedEvent && _seedEvent.game;
  let gm = (g && games[g]) || null;
  if (!gm && g) { const gk = Object.keys(games).find((k) => k === g || (games[k].name || '').toLowerCase() === String(g).toLowerCase()); gm = gk ? games[gk] : null; }
  if (!gm) { const mg = { 'rl-6mans': 'rocket-league', 'rl-mmr': 'rocket-league', 'rl-tier': 'rocket-league', 'val': 'valorant', 'cs2': 'csgo', 'ow': 'overwatch', 'apex': 'apex' }[_seedMode]; gm = mg ? games[mg] : null; }
  const n = gm && gm.rosterSize;
  return (typeof n === 'number' && n > 0) ? n : 0;
}
// The most common roster length across a team list — the event's real format. A 2v2 Rocket League
// event reads 2 here, where the game registry would wrongly insist on 3. Ties break high.
function seedModalRosterSize(rows) {
  const freq = new Map();
  (rows || []).forEach((r) => {
    const n = (r.players || []).length;
    if (n > 0) freq.set(n, (freq.get(n) || 0) + 1);
  });
  if (freq.size === 0) return 0;
  let best = 0, bestCount = 0;
  [...freq.entries()].sort((a, b) => a[0] - b[0]).forEach(([n, c]) => { if (c >= bestCount) { best = n; bestCount = c; } });
  return best;
}
// Expected players per team for THIS event — a team below it is "incomplete" and parks on the Incomplete
// tab instead of the seed board. Resolved best-first:
//   1. the producer's explicit Team size override (sidebar, saved per event)
//   2. start.gg's own teamRosterSize for the event (authoritative when the API returns it)
//   3. the most common roster length in the field — how a 2v2 event is recognised as 2v2
//   4. the game registry's nominal size, then 3
// Pass the row set being partitioned so step 3 reads the incoming teams, not the stale buckets.
function seedRosterSize(rows) {
  if (_seedTeamSize > 0) { _seedSizeWhy = 'set by you'; return _seedTeamSize; }
  const sgg = Number((_seedEvent && (_seedEvent.rosterSize || (_seedEvent.seeding || {}).startggRosterSize)) || 0);
  if (sgg > 0) { _seedSizeWhy = 'from start.gg'; return sgg; }
  const modal = seedModalRosterSize(rows || seedAllRows());
  if (modal > 0) { _seedSizeWhy = 'from the field'; return modal; }
  const gm = seedGameRosterSize();
  if (gm > 0) { _seedSizeWhy = 'game default'; return gm; }
  _seedSizeWhy = 'fallback';
  return 3;
}
function isRosterComplete(row) { return (row.players || []).length >= seedRosterSize(); }
// Split a combined team list into the active seed board (_seedRows, complete) and the parked Incomplete
// tab (_seedIncomplete), preserving order within each bucket. Call wherever the full team set is (re)built
// so completed rosters flow onto the board and short rosters stay out of seeding.
function seedApplyPartition(allRows) {
  const size = seedRosterSize(allRows);
  _seedRows = (allRows || []).filter((r) => (r.players || []).length >= size);
  _seedIncomplete = (allRows || []).filter((r) => (r.players || []).length < size);
  seedSyncTeamSizeUI();
}
// Reflect the resolved team size in the sidebar (the select stays on "Auto" until overridden; the note
// spells out the number and where it came from, so a parked Incomplete tab is never a mystery).
function seedSyncTeamSizeUI() {
  const sel = el('seed-teamsize'); if (sel) sel.value = _seedTeamSize > 0 ? String(_seedTeamSize) : '';
  const note = el('seed-teamsize-note'); if (!note) return;
  const size = seedRosterSize();
  const parked = _seedIncomplete.length;
  note.textContent = `${size} per team (${_seedSizeWhy})`
    + (parked ? ` — ${parked} team${parked !== 1 ? 's' : ''} below that are parked on Incomplete.` : '.');
}

// Tag a player's rank provenance for the confidence chips (see seed-resolve-core.js). Use for direct
// user/verified writes; the auto-resolve cascade uses SeedResolveCore.resolveApply (keep-highest).
function seedTagSource(p, source, confidence, detail) {
  if (!p) return;
  p.source = source || ''; p.confidence = confidence || 0; p.sourceDetail = detail || '';
}

function seedUpdateTabCounts() {
  const vBtn = el('seed-tab-verified'), uvBtn = el('seed-tab-unverified'), incBtn = el('seed-tab-incomplete');
  if (!vBtn || !uvBtn) return;
  const verified = _seedRows.filter((r) => isTeamVerified(r)).length;
  const unverified = _seedRows.length - verified;
  vBtn.textContent = 'Verified' + (_seedRows.length ? ` (${verified})` : '');
  uvBtn.textContent = 'Unverified' + (_seedRows.length ? ` (${unverified})` : '');
  if (incBtn) incBtn.textContent = 'Incomplete' + (_seedIncomplete.length ? ` (${_seedIncomplete.length})` : '');
}

function seedSwitchTab(tab) {
  _seedTab = tab;
  const vPanel = el('seed-verified-panel'), uvPanel = el('seed-unverified-panel'), incPanel = el('seed-incomplete-panel');
  const vBtn = el('seed-tab-verified'), uvBtn = el('seed-tab-unverified'), incBtn = el('seed-tab-incomplete');
  if (vPanel)  vPanel.style.display   = tab === 'verified'   ? '' : 'none';
  if (uvPanel) uvPanel.style.display  = tab === 'unverified' ? '' : 'none';
  if (incPanel) incPanel.style.display = tab === 'incomplete' ? '' : 'none';
  if (vBtn)  vBtn.classList.toggle('active',  tab === 'verified');
  if (uvBtn) uvBtn.classList.toggle('active', tab === 'unverified');
  if (incBtn) incBtn.classList.toggle('active', tab === 'incomplete');
  if (tab === 'unverified') { seedRenderUnverified(); }
  else if (tab === 'incomplete') { seedRenderIncomplete(); }
}

// The rank string a lookup result yields under the current seed mode (single source of truth for
// both the "Use" buttons and the auto-apply in "Lookup All"). Returns null when nothing is usable.
function _6mUseRank(result) {
  if (!result || !result.found) return null;
  if (_seedMode === 'rl-6mans' || _seedMode === 'rl-tier') return result.rank || null;
  return null;
}
function _tgUseRank(result) {
  if (!result || !result.found) return null;
  if (_seedMode === 'rl-6mans') return result.sixmansTier || null;
  if (_seedMode === 'rl-tier') return result.rank || result.tier || null;
  return null;
}
// Build the rl6mans lookup result block for one player.
function build6mansResult(result, ti, pi) {
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (!result || !result.found) {
    const msg = (result && result.error === 'not_found')
      ? 'Not on rl6mans.com — enter rank manually'
      : 'Not found — enter rank manually';
    return `<div class="seed-6m-result seed-6m-err">${msg}</div>`;
  }
  const useRank = _6mUseRank(result);
  const useBtn = useRank
    ? `<button class="btn btn-primary btn-xs seed-6m-use" data-ti="${ti}" data-pi="${pi}" data-rank="${esc(useRank)}">Use ${esc(useRank)}</button>`
    : '';
  return `<div class="seed-6m-result">
    <span class="seed-6m-rank">${esc(result.rank || 'Unranked')}</span>
    ${result.elo > 0 ? `<span class="seed-6m-elo">${result.elo} ELO</span>` : ''}
    ${result.region ? `<span class="seed-6m-region">${esc(result.region)}</span>` : ''}
    ${result.wins != null ? `<span class="seed-6m-record">${result.wins}W-${result.losses || 0}L</span>` : ''}
    ${useBtn}
  </div>`;
}

// Look up one player on rl6mans.com and store the result on the player object.
async function _6mansLookupPlayer(ti, pi, name) {
  const resp = await fetch('http://localhost:3000/api/rl6mans/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await resp.json();
  const row = _seedRows[ti]; if (!row) return null;
  const p = row.players[pi]; if (!p) return null;
  p._6mResult = data.ok ? data.profile : { found: false, error: data.error || 'network' };
  return p._6mResult;
}

// Build the tracker.gg in-game rank result block.
function buildTGResult(result, ti, pi) {
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (!result || !result.found) {
    const errMap = {
      not_found:      'Not found on tracker.gg',
      load_failed:    'Page failed to load',
      timeout:        'Timed out — try again',
      render_timeout: 'Rank data not found on page',
      no_rank:        'No ranked data on profile',
    };
    const msg = errMap[result && result.error] || 'Lookup failed — enter rank manually';
    return `<div class="seed-tg-result seed-tg-err">${msg}</div>`;
  }
  const useRank = _tgUseRank(result);
  const useBtn = useRank
    ? `<button class="btn btn-primary btn-xs seed-tg-use" data-ti="${ti}" data-pi="${pi}" data-rank="${esc(useRank)}">Use ${esc(useRank)}</button>`
    : '';
  return `<div class="seed-tg-result">
    <span class="seed-tg-tier">${esc(result.tier || '')}${result.division ? ' ' + esc(result.division) : ''}</span>
    ${result.mmr != null ? `<span class="seed-tg-mmr">${Math.round(result.mmr).toLocaleString()} MMR</span>` : ''}
    ${result.sixmansTier ? `<span class="seed-tg-6mmap">6mans: ${esc(result.sixmansTier)}</span>` : ''}
    ${useBtn}
  </div>`;
}

// Look up a player's in-game rank on tracker.gg via the in-app browser (no API key required).
async function _tgLookupByAccount(ti, pi, platform, username) {
  const resp = await fetch('http://localhost:3000/api/trackergg/lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, username }),
  });
  const data = await resp.json();
  const row = _seedRows[ti]; if (!row) return null;
  const p = row.players[pi]; if (!p) return null;
  p._tgResult = data;
  // Auto-lookup resolves the ACTUAL platform that hit — remember the working handle so it prefills
  // next time (and across events, via the registry) instead of falling back to the gamerTag.
  if (data && data.found) seedRememberTracker(p, data.platform || platform, data.username || username);
  return data;
}

// The best-known tracker.gg handle for a player, in priority order: this session's manual edit →
// the producer-verified account remembered in the registry (keyed on gamerTag) → the connected
// Epic/Steam account start.gg gave us (rare) → the tournament gamerTag tried across ALL platforms.
function seedTgHandle(p) {
  const reg = (p && p.gamerTag && currentState.playerProfiles) ? currentState.playerProfiles[p.gamerTag.trim().toLowerCase()] : null;
  const regTrk = (reg && reg.tracker && reg.tracker.username) ? reg.tracker : null;
  const platform = p._tgPlat || (regTrk ? regTrk.platform : (p.epic ? 'epic' : p.steam ? 'steam' : 'auto'));
  const username = (p._tgUser != null && p._tgUser !== '') ? p._tgUser
    : (regTrk ? regTrk.username : (p.epic || p.steam || p.gamerTag || ''));
  return { platform, username };
}

// Remember a working/corrected tracker.gg account on the player (session) AND in the registry (keyed
// on gamerTag, so it survives across events). 'auto' isn't a real platform, so it's session-only.
function seedRememberTracker(p, platform, username) {
  if (!p || !username) return;
  platform = (platform || 'epic').toLowerCase();
  p._tgPlat = platform; p._tgUser = username;
  if (platform === 'steam') p.steam = username; else if (platform === 'epic') p.epic = username;
  if (p.gamerTag && platform !== 'auto') {
    send('save_player_profiles', { profiles: [{ gamerTag: p.gamerTag, tracker: { platform, username } }] });
  }
}

// Render the Unverified tab — fills #seed-unv-list only (sidebar is static HTML).
function seedRenderUnverified() {
  const panel = el('seed-unverified-panel');
  if (!panel || panel.style.display === 'none') return;
  const list = el('seed-unv-list'); if (!list) return;
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  list.innerHTML = '';
  seedUpdateTabCounts();

  // Keep sort buttons in sync with state.
  panel.querySelectorAll('.seed-unv-sortbtn').forEach((b) => b.classList.toggle('active', b.dataset.unvsort === _seedUnvSort));
  const showAllBtn = el('seed-unv-showall-btn');
  if (showAllBtn) showAllBtn.classList.toggle('is-on', _seedUnvShowAll);

  // Build display rows.
  let rows = _seedRows.map((row, ti) => ({ row, ti }));
  if (!_seedUnvShowAll) rows = rows.filter(({ row }) => !isTeamVerified(row));

  if (!rows.length) {
    list.innerHTML = `<div class="seed-empty">${_seedUnvShowAll ? 'No teams loaded yet.' : 'All teams are verified — every player has a rank.'}</div>`;
    return;
  }

  // Sort.
  if (_seedUnvSort === 'name') {
    rows.sort((a, b) => (a.row.name || '').localeCompare(b.row.name || ''));
  } else {
    rows.sort((a, b) => {
      const ua = (a.row.players || []).filter((p) => !p.rank || !p.rank.trim()).length;
      const ub = (b.row.players || []).filter((p) => !p.rank || !p.rank.trim()).length;
      return ub - ua;
    });
  }

  const mode = seedMode();
  let listId = '';
  if (mode.kind === 'tier' && mode.tiers) {
    listId = 'seed-unv-tier-opts';
    let dl = document.getElementById(listId);
    if (!dl) { dl = document.createElement('datalist'); dl.id = listId; list.appendChild(dl); }
    const opts = mode.nodiv ? mode.tiers.slice() : mode.tiers.flatMap((t) => ['III', 'II', 'I'].map((d) => `${t} ${d}`));
    dl.innerHTML = opts.map((o) => `<option value="${esc(o)}">`).join('');
  }

  rows.forEach(({ row, ti }) => {
    const card = document.createElement('div');
    card.className = 'seed-team';
    const unvCount = (row.players || []).filter((p) => !p.rank || !p.rank.trim()).length;
    const statusBadge = unvCount === 0
      ? `<span class="seed-unv-verified-badge">Verified</span>`
      : `<span class="seed-unv-badge">${unvCount} unranked</span>`;
    const head = `<div class="seed-team-head">
      <span class="seed-num">${ti + 1}</span>
      <div class="seed-team-name">${esc(row.name) || '(unnamed)'}</div>
      ${statusBadge}
    </div>`;

    const playersHtml = (row.players || []).map((p, pi) => {
      const isRanked = p.rank && p.rank.trim();
      // Tracker.gg lookup row — pre-filled with the best-known handle (see seedTgHandle). start.gg
      // rarely gives OTHER players' connected accounts, so when we only have the tournament gamerTag
      // the platform defaults to 'auto' (try epic/psn/steam/xbl until one hits) since we don't know
      // which platform that handle belongs to. A verified/remembered account overrides all of this.
      const { platform: tgPlt, username: tgUsrRaw } = seedTgHandle(p);
      const tgUsr = esc(tgUsrRaw);
      const platOpt = (v, lbl) => `<option value="${v}"${tgPlt === v ? ' selected' : ''}>${lbl || v}</option>`;
      const tgRowHtml = `<div class="seed-tg-row">
        <select class="seed-tg-plat-sel">
          ${platOpt('auto', 'auto (all)')}
          ${platOpt('epic')}
          ${platOpt('steam')}
          ${platOpt('psn')}
          ${platOpt('xbl')}
          ${platOpt('switch')}
        </select>
        <input class="input-text seed-tg-id-inp" value="${tgUsr}" placeholder="username">
        <button class="btn btn-ghost btn-xs seed-tg-rank-btn" data-ti="${ti}" data-pi="${pi}" title="Look up in-game rank on tracker.gg">Rank</button>
      </div>`;
      const m6ResultHtml = p._6mResult ? build6mansResult(p._6mResult, ti, pi) : '';
      const tgResultHtml = p._tgResult ? buildTGResult(p._tgResult, ti, pi) : '';
      return `<div class="seed-unv-player${isRanked ? ' seed-unv-player-ranked' : ''}" data-ti="${ti}" data-pi="${pi}">
        <div class="seed-unv-player-top">
          <span class="seed-ptag">${esc(p.gamerTag) || '(player)'}</span>${seedConfidenceChip(p)}
          <input class="input-text seed-prank seed-unv-prank" data-ti="${ti}" data-pi="${pi}"
            value="${esc(p.rank)}" placeholder="${esc(mode.ph || 'rank')}"${listId ? ` list="${listId}"` : ''}
            title="Enter rank manually">
          <button class="btn btn-ghost btn-xs seed-6m-lookup" data-ti="${ti}" data-pi="${pi}" data-name="${esc(p.gamerTag)}" title="Look up on rl6mans.com">6mans</button>
        </div>
        ${tgRowHtml}
        ${m6ResultHtml}
        ${tgResultHtml}
      </div>`;
    }).join('');

    card.innerHTML = head + `<div class="seed-players-wrap">${playersHtml}</div>`;
    list.appendChild(card);
  });

  // Rank inputs — immediate edit without going to verified tab.
  list.querySelectorAll('.seed-unv-prank').forEach((inp) => {
    inp.addEventListener('mousedown', (e) => e.stopPropagation());
    inp.addEventListener('change', function () {
      const ti = +this.dataset.ti, pi = +this.dataset.pi;
      const row = _seedRows[ti]; if (!row) return;
      const p = row.players[pi]; if (!p) return;
      const typed = this.value.trim();
      if (seedIsMMR()) {
        const est = seedEstManual(typed);
        if (est) seedApplyEstimate(p, est); else seedRemoveEstimate(p, 'manual');
      } else {
        p.rank = typed; p.rankValue = seedRankValue(p.rank, _seedMode);
        if (p.rank) seedTagSource(p, 'manual', 60, 'Entered manually'); else seedTagSource(p, '', 0, '');
      }
      seedRecomputeValues();
      const playerDiv = this.closest('.seed-unv-player');
      if (playerDiv) playerDiv.classList.toggle('seed-unv-player-ranked', !!p.rank);
      const card2 = this.closest('.seed-team');
      if (card2) {
        const badge = card2.querySelector('.seed-unv-badge, .seed-unv-verified-badge');
        const unvLeft = (row.players || []).filter((pp) => !pp.rank || !pp.rank.trim()).length;
        if (badge) {
          if (unvLeft === 0) { badge.className = 'seed-unv-verified-badge'; badge.textContent = 'Verified'; }
          else { badge.className = 'seed-unv-badge'; badge.textContent = unvLeft + ' unranked'; }
        }
      }
      seedUpdateTabCounts();
    });
  });

  // Per-player 6mans lookup buttons.
  list.querySelectorAll('.seed-6m-lookup').forEach((btn) => {
    btn.addEventListener('click', async function () {
      const ti = +this.dataset.ti, pi = +this.dataset.pi, name = this.dataset.name;
      this.disabled = true; this.textContent = '...';
      try {
        await _6mansLookupPlayer(ti, pi, name);
        seedRenderUnverified();
      } catch (e) {
        this.disabled = false; this.textContent = '6mans';
        seedStatus('6mans lookup failed: ' + (e.message || 'network error'), 'err');
      }
    });
  });

  // Use buttons — apply 6mans looked-up rank.
  list.querySelectorAll('.seed-6m-use').forEach((btn) => {
    btn.addEventListener('click', function () {
      const ti = +this.dataset.ti, pi = +this.dataset.pi, rank = this.dataset.rank;
      const row = _seedRows[ti]; if (!row) return;
      const p = row.players[pi]; if (!p) return;
      if (seedIsMMR()) { const est = seedEst6mans(p._6mResult, 95, 'rl6mans.com — applied'); if (est) seedApplyEstimate(p, est); }
      else { p.rank = rank; p.rankValue = seedRankValue(rank, _seedMode); seedTagSource(p, 'sixmans', 95, 'rl6mans.com — applied'); }
      seedRecomputeValues();
      seedRenderUnverified();
      seedRender();
    });
  });

  // Rank buttons — tracker.gg in-game rank lookup (reads platform + username from the row's inputs).
  list.querySelectorAll('.seed-tg-rank-btn').forEach((btn) => {
    btn.addEventListener('click', async function () {
      const ti = +this.dataset.ti, pi = +this.dataset.pi;
      const row2 = this.closest('.seed-tg-row');
      const platform = row2 ? (row2.querySelector('.seed-tg-plat-sel') || {}).value || 'epic' : 'epic';
      const username = (row2 ? (row2.querySelector('.seed-tg-id-inp') || {}).value : '') || '';
      if (!username.trim()) { seedStatus('Enter a username first.', 'warn'); return; }
      this.disabled = true; this.textContent = '...';
      try {
        await _tgLookupByAccount(ti, pi, platform, username.trim());
        seedRenderUnverified();
      } catch (e) {
        this.disabled = false; this.textContent = 'Rank';
        seedStatus('tracker.gg lookup failed: ' + (e.message || 'network error'), 'err');
      }
    });
  });

  // Persist tracker.gg account edits onto the player (p.epic / p.steam) so a corrected username or
  // platform survives the frequent re-renders (every 6mans lookup re-renders the list) and is saved
  // with the seeding. Without this, an edit would revert to the gamertag pre-fill on the next render.
  list.querySelectorAll('.seed-tg-row').forEach((rowEl) => {
    const wrap = rowEl.closest('.seed-unv-player'); if (!wrap) return;
    const ti = +wrap.dataset.ti, pi = +wrap.dataset.pi;
    const inp = rowEl.querySelector('.seed-tg-id-inp');
    const sel = rowEl.querySelector('.seed-tg-plat-sel');
    const persist = () => {
      const p = _seedRows[ti] && _seedRows[ti].players[pi]; if (!p) return;
      const plat = (sel && sel.value) || 'auto';
      const v = (inp && inp.value.trim()) || '';
      p._tgPlat = plat; p._tgUser = v;   // survive re-renders within the session (any platform)
      if (plat === 'steam') p.steam = v; else if (plat === 'epic') p.epic = v;
      if (v && plat !== 'auto') seedRememberTracker(p, plat, v);   // remember concrete handles across events
    };
    if (inp) { inp.addEventListener('mousedown', (e) => e.stopPropagation()); inp.addEventListener('change', persist); }
    if (sel) sel.addEventListener('change', persist);
  });

  // Use buttons — apply tracker.gg looked-up rank.
  list.querySelectorAll('.seed-tg-use').forEach((btn) => {
    btn.addEventListener('click', function () {
      const ti = +this.dataset.ti, pi = +this.dataset.pi, rank = this.dataset.rank;
      const row = _seedRows[ti]; if (!row) return;
      const p = row.players[pi]; if (!p) return;
      if (seedIsMMR()) { const est = seedEstTracker(p._tgResult, 85, 'tracker.gg — applied'); if (est) seedApplyEstimate(p, est); }
      else { p.rank = rank; p.rankValue = seedRankValue(rank, _seedMode); seedTagSource(p, 'tracker', 92, 'tracker.gg — applied'); }
      seedRecomputeValues();
      seedRenderUnverified();
      seedRender();
    });
  });

  // Lookup All button — look up every unranked player on rl6mans.com.
  const lookupAllBtn = el('seed-unv-lookup-all');
  if (lookupAllBtn) {
    const newBtn = lookupAllBtn.cloneNode(true);
    lookupAllBtn.replaceWith(newBtn);
    newBtn.addEventListener('click', async function () {
      const targets = [];
      rows.forEach(({ row, ti }) => {
        (row.players || []).forEach((p, pi) => {
          if (!p.rank || !p.rank.trim()) targets.push({ ti, pi, name: p.gamerTag });
        });
      });
      if (!targets.length) { seedStatus('No unranked players to look up.', 'info'); return; }
      const statusEl = el('seed-unv-lookup-status');
      this.disabled = true;
      const stillUnranked = () => targets.filter((t) => {
        const p = _seedRows[t.ti] && _seedRows[t.ti].players[t.pi];
        return p && (!p.rank || !p.rank.trim());
      });
      const apply = (t, useRank, source, conf, detail) => {
        const p = _seedRows[t.ti] && _seedRows[t.ti].players[t.pi];
        if (!p) return false;
        if (seedIsMMR()) {
          const est = source === 'sixmans' ? seedEst6mans(p._6mResult, 95, detail)
                    : source === 'tracker' ? seedEstTracker(p._tgResult, 85, detail) : null;
          return est ? seedApplyEstimate(p, est) : false;
        }
        if (useRank) { p.rank = useRank; p.rankValue = seedRankValue(useRank, _seedMode); seedTagSource(p, source, conf, detail); return true; }
        return false;
      };
      let got6m = 0, gotTg = 0;

      // Pass 1 — rl6mans.com by gamertag. Confident hits auto-apply (the profile is an exact-tag match).
      this.textContent = `rl6mans 0/${targets.length}`;
      if (statusEl) { statusEl.style.display = ''; statusEl.textContent = `rl6mans 0 / ${targets.length}`; }
      let d1 = 0;
      for (const t of targets) {
        try { if (apply(t, _6mUseRank(await _6mansLookupPlayer(t.ti, t.pi, t.name)), 'sixmans', 98, 'rl6mans.com — Lookup All')) got6m++; } catch (_) {}
        d1++;
        this.textContent = `rl6mans ${d1}/${targets.length}`;
        if (statusEl) statusEl.textContent = `rl6mans ${d1} / ${targets.length}`;
      }

      // Pass 2 — tracker.gg fallback for anyone still unranked, using the best-known handle
      // (seedTgHandle). When we only have the gamerTag the platform is 'auto', so tracker.gg tries
      // epic/psn/steam/xbl until one hits instead of assuming Epic. A hit is remembered for next time.
      const left = stillUnranked();
      if (left.length) {
        let d2 = 0;
        for (const t of left) {
          const p = _seedRows[t.ti] && _seedRows[t.ti].players[t.pi];
          if (p) {
            const { platform, username: uname } = seedTgHandle(p);
            const username = (uname || '').trim();
            if (username) {
              try { if (apply(t, _tgUseRank(await _tgLookupByAccount(t.ti, t.pi, platform, username)), 'tracker', 92, 'tracker.gg ' + platform + ' — Lookup All')) gotTg++; } catch (_) {}
            }
          }
          d2++;
          this.textContent = `tracker.gg ${d2}/${left.length}`;
          if (statusEl) statusEl.textContent = `tracker.gg ${d2} / ${left.length}`;
        }
      }

      this.disabled = false; this.textContent = 'Lookup All';
      if (statusEl) statusEl.style.display = 'none';
      seedRecomputeValues();
      seedRenderUnverified();
      seedRender();
      const remaining = stillUnranked().length;
      const parts = [`${got6m} from rl6mans`];
      if (gotTg) parts.push(`${gotTg} from tracker.gg`);
      seedStatus(`Auto-ranked ${parts.join(' + ')}` + (remaining ? ` · ${remaining} still need a manual rank` : ' · every player ranked'), remaining ? 'warn' : 'ok');
    });
  }
}
// Best default rank system for a game id/name.
function seedDefaultMode(game) {
  const g = (game || '').toString().toLowerCase();
  if (/rocket|\brl\b/.test(g)) return 'rl-6mans';
  if (/valorant/.test(g)) return 'val';
  if (/cs2|counter|cs:?go/.test(g)) return 'cs2';
  if (/overwatch/.test(g)) return 'ow';
  if (/apex/.test(g)) return 'apex';
  return 'generic';
}
// Parse one rank string → numeric value (higher = better) under the active mode. null if blank/unknown.
function seedRankValue(str, modeKey) {
  const mode = SEED_RANK_MODES[modeKey] || SEED_RANK_MODES.generic;
  const s = (str || '').toString().trim().toLowerCase();
  if (!s) return null;
  const num = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (mode.kind === 'num') return Number.isFinite(num) ? num : null;
  // tier: tier index (1-based) * 10 + division (I/II/III or 1..5); plain numbers still pass through.
  const tiers = mode.tiers || [];
  let ti = 0;
  for (let i = 0; i < tiers.length; i++) { if (s.includes(tiers[i].toLowerCase())) ti = Math.max(ti, i + 1); }
  if (!ti) {
    // Unknown tier word → a bare number, but on a fixed tier ladder it MUST stay within the ladder.
    // A leaked ELO/MMR (e.g. 1180 from a numeric-mode session) must not masquerade as a giant seed
    // value that rockets a team to seed #1 — treat out-of-ladder numbers as unranked.
    if (!Number.isFinite(num)) return null;
    const maxV = tiers.length * 10 + (mode.nodiv ? 0 : 9);
    return (num >= 0 && num <= maxV) ? num : null;
  }
  const roman = (s.match(/\biii\b|\bii\b|\bi\b/) || [''])[0];
  const digit = (s.match(/\b([1-5])\b/) || [, ''])[1];
  const div = { iii: 3, ii: 2, i: 1 }[roman] || (digit ? parseInt(digit, 10) : 0);
  return ti * 10 + div;
}
// A team's seed value from its players' ranks, under the active aggregation (best | avg | sum).
// For avg: divide by ALL players (not just ranked ones) so teams with unranked players sort lower.
function seedTeamValue(row) {
  const ps = row.players || [];
  const vals = ps.map((p) => p.rankValue).filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  if (_seedAgg === 'sum') return vals.reduce((a, b) => a + b, 0);
  if (_seedAgg === 'avg') {
    const total = ps.length || 1;
    return Math.round((vals.reduce((a, b) => a + b, 0) / total) * 10) / 10;
  }
  return Math.max(...vals);   // best player (default)
}
// Re-derive every player's rankValue under the current mode (after a mode change / import). Covers the
// parked Incomplete teams too, so ranks entered there are already valued when their roster fills in.
function seedRecomputeValues() {
  const rows = seedAllRows();
  seedCalibrateSelfReports();   // measure sheet honesty first — the blends below consume it
  if (seedIsMMR()) {
    // MMR-canonical (RL): the seed value is the blend of estimates, not a re-parse of the display tier.
    rows.forEach((row) => (row.players || []).forEach((p) => blendMMRToPlayer(p)));
    return;
  }
  rows.forEach((row) => (row.players || []).forEach((p) => {
    p.rankValue = seedRankValue(p.rank, _seedMode);
    if (p.auto && !seedIsOverridden(p)) p.confidence = seedGateConfidence(p, p.auto.confidence);
  }));
}
function seedAggLabel() { return _seedAgg === 'sum' ? 'Sum of players' : _seedAgg === 'avg' ? 'Average of players' : 'Best player'; }
// Update the topbar chip (team/player count) and connection dot.
function seedUpdateHeader() {
  const chip = el('seed-team-chip');
  const dot  = el('seed-conn-dot');
  if (chip) {
    if (_seedRows.length) {
      const players = _seedRows.reduce((s, r) => s + (r.players || []).length, 0);
      chip.textContent = `${_seedRows.length} teams · ${players} players`;
      chip.removeAttribute('hidden');
    } else {
      chip.setAttribute('hidden', '');
    }
  }
  if (dot) {
    const hasToken = !!(currentState.startgg && currentState.startgg.hasToken);
    dot.className = 'seed-conn-dot ' + (hasToken ? 'ok' : 'err');
    dot.title = hasToken ? 'start.gg connected' : 'No start.gg API token — add one in Settings → Integrations';
  }
}
// Returns a human-readable label for the team badge.
// tier+best → rank string of the top player ("A+"); tier+avg+nodiv → nearest tier ("~B+"); else number.
function seedTeamDisplay(row) {
  const tv = seedTeamValue(row);
  if (tv == null) return null;
  const mode = seedMode();
  // MMR-canonical: the team value IS an MMR — show its tier bucket + the number.
  if (mode.canonical === 'mmr') { const t = seedMMRToTier(tv); return (t ? '~' + t : '') + ' ' + Math.round(tv); }
  if (mode.kind === 'tier') {
    if (_seedAgg === 'best') {
      const best = (row.players || []).find((p) => p.rankValue === tv);
      if (best && best.rank) return best.rank.toUpperCase();
    } else if (_seedAgg === 'avg' && mode.nodiv && mode.tiers) {
      let closest = null, closestDist = Infinity;
      mode.tiers.forEach((t, i) => { const d = Math.abs((i + 1) * 10 - tv); if (d < closestDist) { closestDist = d; closest = t; } });
      if (closest) return '~' + closest.toUpperCase();
    }
  }
  return tv;
}

function seedPopulateLeagues() {
  const sel = el('seed-league'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">No league</option>' + (currentState.leagues || [])
    .map((l) => `<option value="${l.id}">${(l.name || 'League').replace(/</g, '&lt;')}</option>`).join('');
  sel.value = cur || _seedLeagueId || '';
}
function seedPopulateModes() {
  const sel = el('seed-rankmode'); if (!sel) return;
  sel.innerHTML = Object.keys(SEED_RANK_MODES).map((k) => `<option value="${k}">${SEED_RANK_MODES[k].label}</option>`).join('');
  sel.value = _seedMode;
}
function leaguePointsByName(league, name) {
  if (!league) return null;
  const key = (name || '').trim().toLowerCase();
  const team = (league.teams || []).find((t) => (t.name || '').trim().toLowerCase() === key);
  if (!team) return null;                       // not in the league → a new team
  const st = (league.standings || []).find((s) => s.teamId === team.id);
  return st ? (st.pts || 0) : 0;                 // in the league but no standings yet → 0 pts
}
function seedApplyLeague() {
  _seedLeagueId = el('seed-league')?.value || '';
  const league = (currentState.leagues || []).find((l) => l.id === _seedLeagueId) || null;
  _seedRows.forEach((r) => { r.leaguePts = league ? leaguePointsByName(league, r.name) : null; });

  const sortBtn   = el('seed-sort-league');
  const summaryEl = el('seed-league-summary');
  if (sortBtn) sortBtn.style.display = league ? '' : 'none';

  if (league) {
    const returning = _seedRows.filter((r) => r.leaguePts != null);
    const newCount  = _seedRows.length - returning.length;
    const topThree  = [...returning].sort((a, b) => (b.leaguePts || 0) - (a.leaguePts || 0)).slice(0, 3);
    if (summaryEl) {
      summaryEl.style.display = '';
      summaryEl.innerHTML =
        `<strong style="color:var(--text);">${returning.length}</strong> returning &nbsp;·&nbsp; <strong style="color:var(--text);">${newCount}</strong> new<br>` +
        topThree.map((r) => `${tlEsc(r.name)} <span style="opacity:.6">${r.leaguePts} pts</span>`).join('<br>');
    }
    seedSort('league');
    seedStatus(`${returning.length} returning from "${league.name}" seeded by points — ${newCount} new team(s) follow by rank.`, 'ok');
  } else {
    if (summaryEl) summaryEl.style.display = 'none';
    seedRender();
  }
}

function seedStatus(msg, kind) {
  const s = el('seed-status'); if (!s) return;
  s.textContent = msg || ''; s.style.color = kind === 'err' ? '#f56565' : (kind === 'ok' ? '#9ae6b4' : 'var(--muted)');
}
// Seeding is its own ESPORTS sub-tab. The panel shows EITHER the event picker (#seed-pick) or the
// studio (#seeding-studio, relocated into #seed-studio-host at load).
function seedShowStudio(on) {
  const studio = el('seeding-studio'), pick = el('seed-pick');
  if (studio) studio.style.display = on ? '' : 'none';
  if (pick) pick.style.display = on ? 'none' : '';
}
// Switch the ESPORTS subnav to a given tab (drives panel visibility via the #ev-subnav handler).
function evSelectTab(tab) {
  // 'brackets' is NOT in this sub-nav: buildGraphicsHub() relocates the bracket builder into
  // Production ▸ Graphics ▸ Bracket and deletes the button. Without this, callers (Event Ops'
  // "Go to bracket") silently no-op'd — querySelector found nothing and the click never fired.
  if (tab === 'brackets') { openBracketBuilder(); return; }
  const btn = document.querySelector(`#ev-subnav .ev-subnav-btn[data-evtab="${tab}"]`);
  if (btn) btn.click();
}
// Jump to the manual tournament/bracket builder wherever it currently lives. Single place to update
// if the builder moves again.
function openBracketBuilder() {
  document.querySelector('.tab-btn.nav-item[data-tab="produccion"]')?.click();
  if (typeof window._pdShow === 'function') window._pdShow('graphics');
  document.getElementById('gfx-tab-bracket')?.click();
}
window.openBracketBuilder = openBracketBuilder;
// Picker inside the Seeding tab — lists saved events; click one to seed it.
function renderSeedPicker() {
  const list = el('seed-pick-list'); if (!list) return;
  const empty = el('seed-pick-empty');
  const events = currentState.myEvents || [];
  if (empty) empty.style.display = events.length ? 'none' : '';
  list.innerHTML = '';
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  events.forEach((ev) => {
    const card = document.createElement('div'); card.className = 'my-event-card';
    const rosterN = Array.isArray(ev.roster) ? ev.roster.length : (ev.numEntrants || 0);
    const sub = [ev.game, rosterN ? rosterN + ' teams' : '', ev.tournamentName].filter(Boolean).join(' · ');
    const seeded = !!(ev.seeding && Array.isArray(ev.seeding.entrants) && ev.seeding.entrants.length);
    card.innerHTML = evCardLogo(ev) + `<div class="me-info"><div class="me-name">${esc(ev.name || 'Event')}${seeded ? ` <span class="me-live" style="background:#3b82f6;">${ev.seeding.entrants.length} SEEDED</span>` : ''}</div>`
      + `<div class="me-sub">${esc(sub)}</div><div class="me-meta">${evSyncBadge(ev)}</div></div>`;
    const acts = document.createElement('div'); acts.className = 'me-acts';
    const b = document.createElement('button'); b.className = 'btn btn-primary btn-sm';
    b.textContent = seeded ? 'Edit seeding' : 'Seed event';
    b.addEventListener('click', () => openSeedingStudio(ev));
    acts.appendChild(b); card.appendChild(acts); list.appendChild(card);
  });
}
// Re-render the My Events list / seeding picker when a background sync changes something — but only
// when actually visible and only on a real change (cheap signature), so it never churns the UI.
let _evMySig = '';
function evLiveRefreshOpen() {
  const evs = currentState.myEvents || [];
  const sig = evs.map((e) => `${e.id}:${e.lastSync || 0}:${(e.roster || []).length}:${e.syncError ? 1 : 0}:${e.seeding ? (e.seeding.entrants || []).length : 0}`).join('|');
  if (sig === _evMySig) return;
  _evMySig = sig;
  const me = el('ev-myevents-panel'); if (me && me.offsetParent !== null) renderMyEvents();
  const pick = el('seed-pick'); if (pick && pick.offsetParent !== null) renderSeedPicker();
}
function openSeedingStudio(ev) {
  evSelectTab('seeding');   // jump to the Seeding tab (no-op if already there)
  // Re-resolve to the live My Events entry (so we save by id).
  _seedEvent = (currentState.myEvents || []).find((e) => e.id === ev.id || e.eventSlug === ev.eventSlug) || ev;
  el('seed-title').textContent = 'Seeding — ' + (_seedEvent.name || 'event');
  seedShowStudio(true);
  _seedUnvSort = 'unranked'; _seedUnvShowAll = false;
  seedSwitchTab('verified');
  seedUpdateHeader();
  // Restore per-event config (rank system + aggregation), else infer from the game.
  const sd = _seedEvent.seeding || {};
  const savedMode = sd.rankMode === 'rl-mmr' ? 'rl-6mans' : sd.rankMode;   // rl-mmr folded into rl-6mans (MMR-canonical)
  _seedMode = (savedMode && SEED_RANK_MODES[savedMode]) ? savedMode : seedDefaultMode(_seedEvent.game);
  _seedAgg = ['best', 'avg', 'sum'].includes(sd.agg) ? sd.agg : (_seedMode === 'rl-6mans' ? 'avg' : 'best');
  _seedSortKey = 'rank';
  // Team size: an explicit override the producer saved for this event, else auto-derive per pull.
  _seedTeamSize = (typeof sd.teamSize === 'number' && sd.teamSize > 0 && sd.teamSize <= 7) ? sd.teamSize : 0;
  seedPopulateModes(); seedPopulateLeagues();
  const am = el('seed-aggmethod'); if (am) am.value = _seedAgg;
  seedSyncTeamSizeUI();
  seedRenderLadderNote();
  // Adopt the measured rl6mans ELO ladder (server-cached, so normally instant). Fire-and-forget: it
  // re-values and re-sorts the board when it lands, and seeding stays usable if rl6mans is down.
  if (seedIsMMR()) seedLoadTierLadder(false);
  _seedAutoStats = null;
  seedLoadSignalPrefs();
  seedAdvApply();
  if (Array.isArray(sd.entrants) && sd.entrants.length) {
    seedApplyPartition(sd.entrants.map((x) => ({
      entrantId: x.entrantId || '', name: x.name || '', seedNum: x.seedNum || null,
      autoBasis: x.autoBasis || null, placementScore: Number.isFinite(x.placementScore) ? x.placementScore : null,
      perfScore: Number.isFinite(x.placementScore) ? x.placementScore : null,
      perfSource: x.autoBasis === 'placements' ? 'ourEvents' : null,
      players: (x.players || []).map((p) => ({
        gamerTag: p.gamerTag || '', rank: p.rank || '', rankValue: null,
        epic: p.epic || '', steam: p.steam || '', alts: Array.isArray(p.alts) ? p.alts : [],
        startggSlug: p.startggSlug || null, startggPlayerId: p.startggPlayerId || null,
        source: p.source || '', confidence: p.confidence || 0, sourceDetail: p.sourceDetail || '', elo: p.elo || null,
        estimates: Array.isArray(p.estimates) ? p.estimates : null, seedMMR: (typeof p.seedMMR === 'number') ? p.seedMMR : null,
        // Restore the producer's override so a reopened board still shows their call, not the blend.
        override: (p.override && (p.override.tier || Number.isFinite(p.override.mmr))) ? { ...p.override } : undefined,
      })),
      leaguePts: null,
    })));
    seedMigrateAllEstimates();   // rebuild/refresh MMR estimates from saved data (old boards → synthesized)
    seedCalibrateMidpoints();    // learn tier→MMR ladder from restored rl6mans ELOs, then re-blend
    seedRecomputeValues();
    seedApplyLeague();
    seedMergeRoster(_seedEvent.roster);   // fold in any newly-registered teams from the live refresh
    // A saved board is a decision someone already made — never re-seed over it on open.
    _seedSortKey = 'custom';
    seedOrderLabel();
    seedAutoNote(`Your saved board — <b>${_seedRows.length}</b> teams in the order you left them. <b>Re-seed</b> rebuilds it from the latest tournament placements.`);
    seedAutoButtonLabel();
  } else if (Array.isArray(_seedEvent.roster) && _seedEvent.roster.length) {
    // Never seeded: the field is already cached, so go straight to seeding it.
    seedFromRoster(_seedEvent.roster);
    seedAutoSeed();
  } else {
    // Never seeded and no cached field — auto-seed pulls it from start.gg first.
    _seedRows = []; _seedIncomplete = []; seedRender();
    seedAutoSeed();
  }
}
// The auto-seed button doubles as Re-seed once there's a board to rebuild.
function seedAutoButtonLabel() {
  const btn = el('seed-autoseed');
  if (btn && !_seedAutoRunning) btn.textContent = _seedRows.length ? 'Re-seed' : 'Auto-seed';
}
// Build seed rows from a live roster ([{entrantId,name,seedNum,players:[{gamerTag}]}]).
function seedFromRoster(roster) {
  seedApplyPartition((roster || []).map((e) => ({
    entrantId: e.entrantId || '', name: e.name || '', seedNum: e.seedNum || null,
    players: (e.players || []).map((p) => ({ gamerTag: p.gamerTag || '', rank: '', rankValue: null,
      epic: p.epic || '', steam: p.steam || '', alts: p.alts || [],
      startggSlug: p.startggSlug || null, startggPlayerId: p.startggPlayerId || null })),
    leaguePts: null, perfScore: null,
  })));
  if (_seedLeagueId) seedApplyLeague(); else seedRender();
}
// Add roster teams not already present (by entrantId or name), preserving existing ranks. Works across
// both buckets (board + Incomplete) and re-partitions so a newly-registered full roster lands correctly.
function seedMergeRoster(roster) {
  if (!Array.isArray(roster) || !roster.length) { seedRender(); return; }
  const combined = [..._seedRows, ..._seedIncomplete];
  const have = new Set(combined.map((r) => r.entrantId || ('n:' + (r.name || '').toLowerCase())));
  let added = 0;
  roster.forEach((e) => {
    const key = e.entrantId || ('n:' + (e.name || '').toLowerCase());
    if (have.has(key)) return;
    combined.push({ entrantId: e.entrantId || '', name: e.name || '', seedNum: e.seedNum || null,
      players: (e.players || []).map((p) => ({ gamerTag: p.gamerTag || '', rank: '', rankValue: null,
        epic: p.epic || '', steam: p.steam || '', alts: p.alts || [],
        startggSlug: p.startggSlug || null, startggPlayerId: p.startggPlayerId || null })),
      leaguePts: null, perfScore: null });
    added++;
  });
  seedApplyPartition(combined);
  seedStatus(added ? `Loaded saved seeding + ${added} newly-registered team(s).` : 'Loaded your saved seeding.');
  seedRender();
}
async function seedLoadStartgg() {
  if (!_seedEvent) return;
  if (!currentState.startgg?.hasToken) { seedStatus('No start.gg API token — add one in Settings → Integrations.', 'err'); return; }
  const btn = el('seed-load-startgg'); if (btn) { btn.disabled = true; btn.textContent = 'Pulling…'; }
  seedStatus('Pulling teams and rosters from start.gg…');
  try {
    const r = await fetch('http://localhost:3000/api/startgg/event-seeding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventSlug: _seedEvent.eventSlug }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `start.gg returned HTTP ${r.status}`);
    const entrants = data.entrants || [];
    if (!entrants.length) throw new Error('No entrants found for this event on start.gg — check the event URL.');
    // start.gg's own team size for the event, when it reports one — beats guessing from the game registry.
    if (data.rosterSize > 0) _seedEvent.rosterSize = data.rosterSize;
    // Preserve any ranks already entered (match by entrantId, then player gamertag) — across both buckets.
    const prev = {}; seedAllRows().forEach((r2) => { if (r2.entrantId) prev[r2.entrantId] = r2; });
    const rows = entrants.map((e) => {
      const old = prev[e.entrantId];
      const players = (e.players || []).map((p) => {
        const op = old && (old.players || []).find((x) => x.gamerTag === p.gamerTag);
        return { gamerTag: p.gamerTag, rank: op ? op.rank : '', rankValue: null,
          epic: p.epic || '', steam: p.steam || '', alts: p.alts || [],
          startggSlug: p.startggSlug || null, startggPlayerId: p.startggPlayerId || null,
          // preserve resolution provenance across a re-pull (rank is kept, so keep its source too)
          source: op ? (op.source || '') : '', confidence: op ? (op.confidence || 0) : 0,
          sourceDetail: op ? (op.sourceDetail || '') : '', elo: op ? (op.elo || null) : null,
          // …and the full derivation plus the producer's override. Re-pulling the roster from start.gg
          // must never silently undo a rank decision someone already made.
          estimates: (op && Array.isArray(op.estimates)) ? op.estimates : null,
          auto: (op && op.auto) ? op.auto : null,
          override: (op && seedIsOverridden(op)) ? { ...op.override } : undefined };
      });
      return { entrantId: e.entrantId, name: e.name, seedNum: e.seedNum || null, players, leaguePts: null, perfScore: null };
    });
    const totalPlayers = rows.reduce((s, r2) => s + (r2.players || []).length, 0);
    seedApplyPartition(rows);
    seedRecomputeValues();
    if (_seedLeagueId) seedApplyLeague(); else seedRender();
    const incNote = _seedIncomplete.length ? ` · ${_seedIncomplete.length} roster(s) under ${seedRosterSize()} players parked on the Incomplete tab — change Team size in the sidebar if this event isn't ${seedRosterSize()}v${seedRosterSize()}` : '';
    seedStatus(`✓ Imported ${rows.length} teams · ${totalPlayers} players from start.gg${incNote}. Enter ranks or import a CSV, then Sort by Rank.`, 'ok');
  } catch (e) {
    seedStatus(`Pull failed — ${e.message || 'unknown error'}`, 'err');
    console.error('[seed-pull]', e);
  }
  finally { if (btn) { btn.disabled = false; btn.textContent = '↻ Pull from Platform'; } }
}
function seedRenumber() { _seedRows.forEach((r, i) => { r.seedNum = i + 1; }); }
function seedOrderLabel() {
  const dir = ' (high→low)';
  const lbl = { auto: `Tournament placements${dir}`, rank: `Team rank · ${seedAggLabel()}${dir}`, league: `League points, then team rank${dir}`, seed: 'start.gg current seed', name: 'Team name (A→Z)' }[_seedSortKey] || 'Custom order (dragged)';
  const o = el('seed-orderby'); if (o) o.textContent = '— ordered by ' + lbl;
  document.querySelectorAll('.seed-sortbtn').forEach((b) => b.classList.toggle('is-on', b.dataset.sort === _seedSortKey));
}
// Build a profile URL from a stored value that may be a full URL OR a slug/username.
function teStartggLink(v) { v = (v || '').trim(); return /^https?:\/\//i.test(v) ? v : 'https://www.start.gg/' + v.replace(/^\/+/, ''); }
function teSixmansLink(v) { v = (v || '').trim(); return /^https?:\/\//i.test(v) ? v : 'https://www.rl6mans.com/profile/' + encodeURIComponent(v.toLowerCase()); }
function teTwitterLink(v) { v = (v || '').trim().replace(/^@/, ''); return /^https?:\/\//i.test(v) ? v : 'https://x.com/' + encodeURIComponent(v); }
function teTwitchLink(v)  { v = (v || '').trim(); return /^https?:\/\//i.test(v) ? v : 'https://twitch.tv/' + encodeURIComponent(v); }
function teInstaLink(v)   { v = (v || '').trim().replace(/^@/, ''); return /^https?:\/\//i.test(v) ? v : 'https://instagram.com/' + encodeURIComponent(v); }
function teTikTokLink(v)  { v = (v || '').trim().replace(/^@/, ''); return /^https?:\/\//i.test(v) ? v : 'https://tiktok.com/@' + encodeURIComponent(v); }
function teYouTubeLink(v) { v = (v || '').trim().replace(/^@/, ''); return /^https?:\/\//i.test(v) ? v : 'https://youtube.com/@' + encodeURIComponent(v); }

// Profile-link chips for a player (start.gg + 6mans). Accepts a gamertag string OR a
// player object. Prefers links STORED on the player; falls back to the auto-linked
// registry (state.playerProfiles, keyed by gamertag). Shown across seeding/team/match.
function playerProfileChips(p) {
  let tag = '', storedSgg = '', storedSix = '', storedSocials = {};
  if (typeof p === 'string') tag = p;
  else if (p) {
    tag = p.gamerTag || p.name || '';
    storedSgg = p.startgg || '';
    storedSix = p.sixmans || '';
    storedSocials = { twitter: p.twitter || '', twitch: p.twitch || '', discord: p.discord || '', instagram: p.instagram || '', tiktok: p.tiktok || '', youtube: p.youtube || '' };
  }
  const reg = (tag && currentState.playerProfiles) ? currentState.playerProfiles[tag.trim().toLowerCase()] : null;
  const chips = [];
  const sggUrl = storedSgg ? teStartggLink(storedSgg)
    : (reg && reg.startggSlug ? 'https://www.start.gg/' + String(reg.startggSlug).replace(/^\/+/, '') : '');
  if (sggUrl) chips.push(`<a class="pp-chip pp-sgg" href="${sggUrl}" target="_blank" title="start.gg profile"><img src="../assets/images/start.png" alt="start.gg"></a>`);
  let sixUrl = '', sixTitle = '6mans profile';
  if (storedSix) { sixUrl = teSixmansLink(storedSix); }
  else if (reg && reg.sixmans && reg.sixmans.name) {
    const s = reg.sixmans;
    sixUrl = 'https://www.rl6mans.com/profile/' + encodeURIComponent(String(s.name).toLowerCase());
    const meta = [s.rank, s.elo ? s.elo + ' ELO' : '', s.region].filter(Boolean).join(' · ');
    if (meta) sixTitle = '6mans · ' + meta;
  }
  if (sixUrl) chips.push(`<a class="pp-chip pp-6m" href="${sixUrl}" target="_blank" title="${tlEsc(sixTitle)}"><img src="../assets/images/sixmanlogo.webp" alt="6mans"></a>`);
  // Twitch — player-stored takes priority over registry
  const twitchVal = storedSocials.twitch || (reg && reg.twitch) || '';
  if (twitchVal) chips.push(`<a class="pp-chip pp-twitch" href="https://twitch.tv/${encodeURIComponent(twitchVal)}" target="_blank" title="Twitch: ${tlEsc(twitchVal)}"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg></a>`);
  // Twitter/X — player-stored takes priority over registry
  const twitterVal = storedSocials.twitter || (reg && reg.twitter) || '';
  if (twitterVal) chips.push(`<a class="pp-chip pp-twitter" href="https://x.com/${encodeURIComponent(twitterVal.replace(/^@/, ''))}" target="_blank" title="X/Twitter: ${tlEsc(twitterVal)}"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>`);
  // Player-stored-only socials
  if (storedSocials.discord) chips.push(`<span class="pp-chip pp-discord" title="Discord: ${tlEsc(storedSocials.discord)}">DC</span>`);
  if (storedSocials.instagram) chips.push(`<a class="pp-chip pp-instagram" href="https://instagram.com/${encodeURIComponent(storedSocials.instagram.replace(/^@/, ''))}" target="_blank" title="Instagram: ${tlEsc(storedSocials.instagram)}">IG</a>`);
  if (storedSocials.tiktok) chips.push(`<a class="pp-chip pp-tiktok" href="https://tiktok.com/@${encodeURIComponent(storedSocials.tiktok.replace(/^@/, ''))}" target="_blank" title="TikTok: ${tlEsc(storedSocials.tiktok)}">TK</a>`);
  if (storedSocials.youtube) chips.push(`<a class="pp-chip pp-youtube" href="https://youtube.com/@${encodeURIComponent(storedSocials.youtube.replace(/^@/, ''))}" target="_blank" title="YouTube: ${tlEsc(storedSocials.youtube)}">YT</a>`);
  if (reg && reg.countryCode) chips.push(`<span class="pp-chip pp-flag" title="${tlEsc(reg.country || reg.countryCode.toUpperCase())}"><img src="https://flagcdn.com/16x12/${reg.countryCode.toLowerCase()}.png" alt="${tlEsc(reg.countryCode.toUpperCase())}" width="16" height="12"></span>`);
  return chips.length ? `<span class="pp-chips">${chips.join('')}</span>` : '';
}

// Return 'flag' (B/B+), 'flag-high' (A/X), or null.  Only fires for rl-6mans mode.
const _RL6MANS_FLAG  = new Set(['b', 'b+']);
const _RL6MANS_FLAGX = new Set(['a', 'x']);
function seedRankAlertLevel(rank, modeKey) {
  if (modeKey !== 'rl-6mans') return null;
  const s = (rank || '').trim().toLowerCase();
  if (_RL6MANS_FLAGX.has(s)) return 'flag-high';
  if (_RL6MANS_FLAG.has(s))  return 'flag';
  return null;
}

// ── Resolution confidence display ──────────────────────────────────────────
const SEED_SRC_LABEL = { sixmans: '6MANS', tracker: 'TRACKER', manual: 'MANUAL', ourEvents: 'OUR EVENTS', startgg: 'START.GG', teammate: 'TEAM AVG', override: 'YOUR CALL' };
const SEED_SRC_SHORT = { sixmans: '6mans', tracker: 'tracker', manual: 'manual', ourEvents: 'our-events', startgg: 'start.gg', teammate: 'team avg', override: 'your call' };
// Plain-English "where this came from", shown in the why-panel so a producer never has to guess what
// a source chip means or how far to trust it.
const SEED_SRC_WHY = {
  sixmans:   'Verified on rl6mans.com — their real hub ELO. The strongest source there is.',
  tracker:   'tracker.gg in-game rank, converted to a 6mans tier. A fallback: the RL ladder only maps onto the bottom of the 6mans ladder.',
  manual:    'A rank you imported (CSV) or that was restored from a saved board.',
  ourEvents: 'Correlated from how their team placed in our own past events.',
  startgg:   'Correlated from their recent start.gg placements.',
  teammate:  'No reading at all for this player — estimated from their teammates. Treat as a placeholder.',
  override:  'You typed this in. It overrides everything the sources said.',
};
function seedConfColor(c) { return c >= 85 ? '#48bb78' : c >= 60 ? '#4299e1' : c >= 40 ? '#d69e2e' : '#718096'; }
// ── Review queue ───────────────────────────────────────────────────────────
// Automation is only safe if the things it wasn't sure about surface by themselves. A player needs a
// human decision when auto resolved them weakly, or leaned on a teammate (no reading of their own),
// or found nothing at all. An override is by definition already reviewed — it's your call.
let _seedReviewOnly = false;         // board filter: show only teams containing flagged players
let _seedReviewThreshold = 70;       // confidence below which a player is flagged
function seedNeedsReview(p) {
  if (!p) return false;
  if (seedIsOverridden(p)) return false;              // you already decided this one
  if (!p.source || !p.confidence) return true;        // nothing resolved it
  if (p.source === 'teammate') return true;           // borrowed from teammates — never a real reading
  return (p.confidence || 0) < _seedReviewThreshold;
}
// Counts the SEED BOARD only, not the parked Incomplete teams — those are out of seeding entirely, so
// including them would show a review backlog the filter can't actually surface.
function seedReviewCounts() {
  let total = 0, flagged = 0, overridden = 0;
  _seedRows.forEach((r) => (r.players || []).forEach((p) => {
    total++;
    if (seedIsOverridden(p)) overridden++;
    else if (seedNeedsReview(p)) flagged++;
  }));
  return { total, flagged, overridden, clean: total - flagged - overridden };
}
function seedRenderReviewStat() {
  const box = el('seed-review-stat'); if (!box) return;
  const c = seedReviewCounts();
  if (!c.total) { box.innerHTML = '<span class="seed-review-none">No players loaded yet.</span>'; return; }
  const pct = Math.round((c.clean / c.total) * 100);
  box.innerHTML = `<div class="seed-review-bar" title="${c.clean} confident · ${c.flagged} need review · ${c.overridden} set by you">`
    + `<span class="seed-review-ok" style="flex:${c.clean || 0}"></span>`
    + `<span class="seed-review-warn" style="flex:${c.flagged || 0}"></span>`
    + `<span class="seed-review-ovr" style="flex:${c.overridden || 0}"></span></div>`
    + `<div class="seed-review-nums"><b>${c.flagged}</b> need review · ${c.clean} confident (${pct}%)`
    + (c.overridden ? ` · <span class="seed-review-ovr-txt">${c.overridden} yours</span>` : '') + '</div>';
  const btn = el('seed-review-toggle');
  if (btn) {
    btn.textContent = _seedReviewOnly ? 'Show all teams' : `Show only needs-review${c.flagged ? ` (${c.flagged})` : ''}`;
    btn.disabled = !c.flagged && !_seedReviewOnly;
  }
}

// ── "Why is this player this rank?" ────────────────────────────────────────
// Automation is only trustworthy if you can audit it. This renders the full derivation for one
// player: every source that had an opinion, what each one claimed, how much pull it got in the
// blend, and — when you've overridden it — what auto would have said instead.
// Keyed by "teamIdx:playerIdx" so a redraw keeps the open panels open.
const _seedWhyOpen = new Set();
function seedWhyKey(ti, pi) { return `${ti}:${pi}`; }
// Share of the blend each estimate actually carried, as a percentage. Mirrors blendEstimates' k=5
// weighting so the numbers on screen are the real ones, not a re-derivation that could drift.
function seedEstimateWeights(estimates) {
  const est = (estimates || []).filter((e) => e && Number.isFinite(e.mmr) && (e.confidence || 0) > 0);
  const ws = est.map((e) => Math.pow((e.confidence || 0) / 100, 5));
  const total = ws.reduce((a, b) => a + b, 0);
  return est.map((e, i) => ({ est: e, weight: total > 0 ? (ws[i] / total) * 100 : 0 }));
}
function seedWhyPanel(p, ti, pi) {
  if (!_seedWhyOpen.has(seedWhyKey(ti, pi))) return '';
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const rows = [];

  if (seedIsOverridden(p)) {
    const auto = p.auto
      ? `Auto-resolve says <b>${esc(p.auto.rank)}</b>${seedIsMMR() ? ` (${p.auto.mmr})` : ''} at ${p.auto.confidence}% confidence.`
      : 'Auto-resolve has nothing for this player.';
    rows.push(`<div class="seed-why-override"><b>Your override — ${esc(p.rank)}</b>${seedIsMMR() && Number.isFinite(p.override.mmr) ? ` (${Math.round(p.override.mmr)})` : ''}`
      + `<div class="seed-why-sub">This is what seeds. ${auto}</div>`
      + `<button class="btn btn-ghost btn-xs seed-why-revert" data-ti="${ti}" data-pi="${pi}">Revert to auto</button></div>`);
  }

  if (seedIsMMR()) {
    const weighted = seedEstimateWeights(p.estimates);
    if (!weighted.length) {
      rows.push('<div class="seed-why-empty">No source has a reading for this player yet. Run Resolve, or type a rank to set it yourself.</div>');
    } else {
      const sorted = weighted.slice().sort((a, b) => b.weight - a.weight);
      rows.push('<table class="seed-why-tbl"><thead><tr><th>Source</th><th>Says</th><th>Conf</th><th>Pull</th></tr></thead><tbody>'
        + sorted.map(({ est, weight }) => {
            const col = seedConfColor(est.confidence);
            const says = est.exactElo > 0 ? `${est.exactElo} ELO` : `${est.tier ? esc(est.tier) + ' · ' : ''}${Math.round(est.mmr)}`;
            return `<tr title="${esc(SEED_SRC_WHY[est.source] || '')}${est.detail ? ' — ' + esc(est.detail) : ''}">`
              + `<td><span class="seed-why-src" style="color:${col}">${esc(SEED_SRC_SHORT[est.source] || est.source)}</span></td>`
              + `<td>${says}</td><td>${est.confidence}%</td>`
              + `<td><span class="seed-why-bar"><span style="width:${Math.max(2, Math.round(weight))}%;background:${col}"></span></span>${Math.round(weight)}%</td></tr>`;
          }).join('')
        + '</tbody></table>');
      if (p.auto) rows.push(`<div class="seed-why-sub">Weighted blend → <b>${esc(p.auto.rank)}</b> (${p.auto.mmr}) at ${p.auto.confidence}% confidence. `
        + `Confidence is sharpened by a power of 5, so the best source dominates rather than being averaged away.</div>`);
      // The tier letters above are only meaningful against the ladder they were converted through.
      const tierDerived = weighted.some(({ est }) => est.tier && !(est.exactElo > 0));
      if (tierDerived && _seedLadderMeta) rows.push(`<div class="seed-why-sub">Tier→ELO via the ${_seedLadderMeta.measuredTiers ? 'measured' : 'built-in'} ladder: `
        + (window.SeedResolveCore ? window.SeedResolveCore.SIXMANS_TIERS : []).map((t, i) => `${t} ${_seedMidpoints[i]}`).join(' · ') + '</div>');
    }
  } else if (p.auto) {
    rows.push(`<div class="seed-why-sub">Auto-resolve: <b>${esc(p.auto.rank)}</b> from <b>${esc(SEED_SRC_SHORT[p.auto.source] || p.auto.source)}</b> at ${p.auto.confidence}% — ${esc(SEED_SRC_WHY[p.auto.source] || '')}${p.auto.detail ? '<br>' + esc(p.auto.detail) : ''}</div>`);
  } else {
    rows.push('<div class="seed-why-empty">No source has a reading for this player yet.</div>');
  }

  return `<div class="seed-why">${rows.join('')}</div>`;
}
// A small "SOURCE · NN%" pill showing how a player's rank was resolved (title = the detail string).
function seedConfidenceChip(p) {
  if (!p || !p.source || !p.confidence) return '';
  const lbl = SEED_SRC_LABEL[p.source] || p.source.toUpperCase();
  const col = seedConfColor(p.confidence);
  const t = (p.sourceDetail || lbl).toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const mmr = (seedIsMMR() && Number.isFinite(p.seedMMR)) ? ` · ${Math.round(p.seedMMR)}` : '';   // show blended MMR
  return `<span class="seed-conf-chip" title="${t}" style="display:inline-flex;align-items:center;margin-left:6px;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;letter-spacing:.3px;color:${col};background:${col}22;border:1px solid ${col}55;">${lbl}${mmr} · ${p.confidence}%</span>`;
}
// Team-level confidence = mean of its players' confidences (unresolved players count as 0).
function seedTeamConfidence(row) {
  const ps = (row && row.players) || [];
  if (!ps.length) return null;
  const counts = {};
  const sum = ps.reduce((s, p) => { const k = p.source || 'none'; counts[k] = (counts[k] || 0) + 1; return s + (p.confidence || 0); }, 0);
  return { pct: Math.round(sum / ps.length), counts };
}
function seedTeamConfBadge(row) {
  const tc = seedTeamConfidence(row);
  if (!tc || tc.pct <= 0) return '';   // nothing resolved yet → no badge (keeps a fresh pull clean)
  const col = seedConfColor(tc.pct);
  const parts = ['sixmans', 'tracker', 'manual', 'ourEvents', 'startgg', 'teammate', 'none']
    .filter((k) => tc.counts[k]).map((k) => `${tc.counts[k]} ${k === 'none' ? 'unresolved' : (SEED_SRC_LABEL[k] || k).toLowerCase()}`);
  // Deliberately muted (a small dot + grey "conf") so it never competes with the rank badge next to it.
  return `<span class="seed-team-conf" title="Rank confidence · ${parts.join(' · ')}" style="margin-left:8px;display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:600;color:var(--muted);">`
    + `<span style="width:7px;height:7px;border-radius:50%;background:${col};"></span>${tc.pct}% conf</span>`;
}
// One-line breakdown of how every player's rank was resolved (rendered in the Auto-Resolve panel).
function seedResolutionSummary() {
  const box = el('seed-resolve-summary'); if (!box) return;
  const counts = {}; let total = 0, resolved = 0;
  _seedRows.forEach((r) => (r.players || []).forEach((p) => {
    total++; const k = p.source || 'none';
    if (p.source && p.confidence) resolved++;
    counts[k] = (counts[k] || 0) + 1;
  }));
  if (!total || !resolved) { box.style.display = 'none'; return; }   // hide until something is resolved
  const parts = ['sixmans', 'tracker', 'manual', 'ourEvents', 'startgg', 'teammate']
    .filter((k) => counts[k]).map((k) => `${counts[k]} ${(SEED_SRC_LABEL[k] || k).toLowerCase()}`);
  const unresolved = counts['none'] || 0;
  box.style.display = '';
  box.textContent = `Resolved ${resolved}/${total} players — ${parts.join(' · ')}${unresolved ? ` · ${unresolved} unresolved` : ''}`;
}

// Tooltip for the performance badge — for our-events scores it lists the actual finishes, so a
// producer can see WHY a team scored what it did (and catch a team-name mismatch straight away).
function seedPerfTitle(row) {
  if (row.perfSource !== 'ourEvents') return `start.gg performance score (${row.perfScore}% — recency-weighted placements across their recent events)`;
  const d = row._ourEventsDetail || {};
  const lines = [`Our-events score ${row.perfScore}% — how this team finished OUR past events, recent first.`];
  (d.events || []).forEach((e) => lines.push(`  ${e.placement}${ordSuffix(e.placement)} of ${e.of} — ${e.event}`));
  if (!(d.events || []).length) lines.push('  No placement recorded — score is from set win/loss only.');
  if (d.record) lines.push(`Set record here: ${d.record.w}-${d.record.l}`);
  return lines.join('\n');
}
function ordSuffix(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; }

// Which rows have their per-player editor open. Collapsed by default: a 24-team board with every
// roster expanded is the wall of controls the studio was drowning in.
let _seedOpenRows = new Set();

// One row = one seeding decision, stated in full. Seed number, team, the power rating and where it
// came from, how sure we are, and any warning that should stop a producer trusting it — nothing
// else. Everything editable is one click away in the expanded body.
function seedRowHead(row, i, open) {
  const esc = escHtml;
  const F = _seedPowerField;
  // Bar is scaled across THIS field's actual range, not an absolute ladder, so the spread of the
  // teams in front of you is what you see.
  let pct = 0;
  if (row.power != null && F && F.median != null) {
    const lo = F.median - F.spread, hi = F.median + F.spread;
    pct = Math.round(SeedPowerCore.clamp((row.power - lo) / Math.max(hi - lo, 1), 0.04, 1) * 100);
  }
  const power = row.power != null
    ? `<span class="seed-power" title="${esc(row.powerExplain || '')}">${row.power}</span>`
    : `<span class="seed-power seed-power-none" title="No player ranks and no event history \u2014 nothing to seed on.">\u2014</span>`;
  const bar = `<span class="seed-bar"><span class="seed-bar-fill" style="width:${pct}%"></span></span>`;

  // The adjustment is the part a producer most needs to see: it is the only thing separating this
  // rating from the roster's raw skill, and it is what "they punch above their ranks" looks like.
  const adj = row.resultsAdj
    ? `<span class="seed-adj ${row.resultsAdj > 0 ? 'up' : 'down'}" title="${esc(row.powerExplain || '')}">${row.resultsAdj > 0 ? '+' : ''}${row.resultsAdj}</span>`
    : '';
  // A confidence on a team with no rating at all is noise — there is nothing for it to qualify.
  const conf = (row.powerConf != null && row.power != null)
    ? `<span class="seed-cf" style="color:${seedConfColor(row.powerConf)}" title="How much of this rating rests on measured data: roster coverage, source confidence and how much event history is behind it.">${row.powerConf}%</span>`
    : '';

  // Warnings only when they exist — a clean row stays clean.
  // Warnings, most severe first — only the first is shown as a chip (see seedWarnChip).
  const warn = [];
  const noRank = (row.players || []).filter((p) => !Number.isFinite(p.seedMMR) && p.rankValue == null).length;
  if (noRank) warn.push(`<span class="seed-warn" title="No rank found for these players — they are imputed at the field floor, which drags this team's confidence down.">${noRank} no rank</span>`);
  // Only meaningful once the identity check has actually run. Before that every player is nominally
  // "unverified", and flagging the entire board is a false alarm that trains the producer to ignore it.
  // An uneven line-up is docked for spread (see seed-power-core rosterSkill), and that discount is
  // invisible in the final number — a producer comparing a 996 against a 1076 has no way to know one
  // roster is 1250/1230/700. Flag it at the threshold where the discount actually moves seeds.
  const dock = (row.rosterMean != null && row.rosterMMR != null) ? row.rosterMean - row.rosterMMR : 0;
  if (dock >= 25) warn.push(`<span class="seed-warn" title="Mixed ranks: roster averages ${row.rosterMean} but spreads ${row.rosterSpread}, so the rating is docked ${dock}. An uneven line-up underperforms its average in team play — the weakest rotation is what gets targeted.">uneven −${dock}</span>`);
  const idRun = (row.players || []).some((p) => p && p.identity);
  const idc = seedTeamIdentityCount(row);
  if (idRun && idc.total && idc.verified < idc.total) warn.push(`<span class="seed-warn" title="Players whose identity is not confirmed have their rank confidence scaled down. Run Setup ▸ Check identities.">${idc.total - idc.verified} unverified</span>`);

  // A rename that changed this team's rating is stated outright, and kept OUT of the warning stack:
  // it is good news (history recovered), not a problem, and it must not be the thing a real warning
  // gets collapsed behind.
  const det = row._ourEventsDetail;
  const oldName = (det && det.renamed && (det.countedAs || [])[0])
    || (row.lineage && row.lineage.basis === 'roster'
        && !(row.lineage.names || []).some((n) => (n || '').toLowerCase() === (row.name || '').toLowerCase())
        && (row.lineage.names || [])[0]);
  // Truncated in JS rather than left to CSS ellipsis: the chip is the last thing on a fixed-width
  // row, so an over-long name gets sliced mid-glyph by the column edge before text-overflow can act.
  const shortOld = oldName && oldName.length > 12 ? oldName.slice(0, 11) + '…' : oldName;
  const note = oldName
    ? `<span class="seed-note" title="Counted as &quot;${esc(oldName)}&quot; — matched to earlier results by roster overlap, so this team's rating reflects everything the squad has posted despite the rename.">was ${esc(shortOld)}</span>`
    : '';

  const roster = (row.players || []).map((p) => esc(p.gamerTag)).filter(Boolean).join(' \u00b7 ');
  const lpts = row.leaguePts != null ? `<span class="seed-lpts" title="League points (returning team)">${row.leaguePts} pts</span>` : '';

  // Rating and evidence live in two separate fixed-width columns. They used to share one, which is
  // why the numbers, bars and chips landed at a different x on every row.
  return `<div class="seed-team-head">
    <span class="seed-grip" title="Drag to reorder">\u283f</span>
    <span class="seed-num">${i + 1}</span>
    <div class="seed-id">
      <div class="seed-team-name">${esc(row.name) || '(unnamed)'}</div>
      <div class="seed-roster" title="${esc(roster)}">${roster || '<span class="seed-roster-none">no players</span>'}</div>
    </div>
    ${bar}
    <div class="seed-metrics">${power}${adj}</div>
    <div class="seed-sub">${seedBasisChip(row)}${conf}${lpts}${seedWarnChip(warn)}${note}</div>
    <span class="seed-caret">${open ? '\u25be' : '\u25b8'}</span>
  </div>`;
}

// Warnings collapse to ONE chip. Three chips per row overflowed the column and got ellipsed into
// "1 no ran…", which is worse than useless — it costs space AND fails to communicate. The most
// severe issue shows; the rest are in its tooltip, where a producer looks once they care.
function seedWarnChip(warn) {
  if (!warn || !warn.length) return '';
  const first = warn[0];
  if (warn.length === 1) return first;
  const extra = warn.length - 1;
  const all = warn.map((w) => w.replace(/<[^>]+>/g, '')).join(' \u00b7 ');
  return first.replace('">', `" data-more="${extra}">`).replace(/<\/span>$/, ` +${extra}</span>`)
    .replace(/title="[^"]*"/, `title="${escHtml(all)}"`);
}

function seedRender() {
  const list = el('seed-list'); if (!list) return;
  seedRenumber();
  seedOrderLabel();
  seedUpdateHeader();
  seedUpdateTabCounts();
  seedRenderReviewStat();
  seedRenderStages();
  list.innerHTML = '';
  if (!_seedRows.length) { list.innerHTML = '<div class="seed-empty">No teams yet — Pull from Platform or Import a CSV.</div>'; return; }
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // Review filter — hide teams where every player is already settled. Seed numbers still come from
  // the real board position (seedRenumber ran above), so a filtered view never renumbers anything.
  const visible = _seedReviewOnly
    ? _seedRows.map((r, i) => ({ row: r, i })).filter(({ row }) => (row.players || []).some((p) => seedNeedsReview(p)))
    : _seedRows.map((r, i) => ({ row: r, i }));
  if (_seedReviewOnly && !visible.length) {
    list.innerHTML = '<div class="seed-empty">Nothing left to review — every player is either confidently resolved or set by you. Switch back to all teams to see the full board.</div>';
    return;
  }
  const mode = seedMode();
  // Typeahead datalist of tier names for tier-based games.
  let listId = '';
  if (mode.kind === 'tier' && mode.tiers) {
    listId = 'seed-tier-opts';
    let dl = document.getElementById(listId);
    if (!dl) { dl = document.createElement('datalist'); dl.id = listId; list.appendChild(dl); }
    const opts = mode.nodiv
      ? mode.tiers.slice()
      : mode.tiers.flatMap((t) => ['III', 'II', 'I'].map((d) => `${t} ${d}`));
    dl.innerHTML = opts.map((o) => `<option value="${esc(o)}">`).join('');
  }
  visible.forEach(({ row, i }) => {
    const open = _seedOpenRows.has(i);
    const card = document.createElement('div');
    card.className = 'seed-team' + (open ? ' is-open' : '');
    card.draggable = true; card.dataset.idx = i;
    const head = seedRowHead(row, i, open);
    const players = !open ? '' : (row.players || []).length
      ? (row.players || []).map((p, pi) => {
          const alert = seedRankAlertLevel(p.rank, _seedMode);
          const alertClass = alert ? ` seed-prank-${alert}` : '';
          const alertTitle = alert === 'flag-high' ? ' title="High-tier rank — double-check before finalising seeds"'
                           : alert === 'flag'      ? ' title="Mid-tier rank — verify before finalising seeds"'
                           : ' title="Player rank — sets this team\'s seed value"';
          const ovr = seedIsOverridden(p);
          const rev = !ovr && seedNeedsReview(p);
          return `<div class="seed-player${ovr ? ' seed-player-ovr' : ''}${rev ? ' seed-player-review' : ''}"><div class="seed-player-id"><span class="seed-ptag" title="${esc(p.gamerTag)}">${esc(p.gamerTag) || '(player)'}</span>${playerProfileChips(p.gamerTag)}${seedIdentityBadge(p)}${seedConfidenceChip(p)}`
            + `<button class="seed-why-btn${_seedWhyOpen.has(seedWhyKey(i, pi)) ? ' open' : ''}" data-ti="${i}" data-pi="${pi}" title="Why is this player this rank? Shows every source, what it claimed, and how much it counted.">why</button></div>`
            + `<input class="input-text seed-prank${alertClass}${ovr ? ' seed-prank-ovr' : ''}" data-pi="${pi}" value="${esc(p.rank)}" placeholder="${esc(mode.ph || 'rank')}"${listId ? ` list="${listId}"` : ''}${ovr ? ' title="Your override — auto-resolve will not change this. Clear the box to go back to auto."' : alertTitle}>`
            + seedWhyPanel(p, i, pi) + `</div>`;
        }).join('')
      : '<div class="seed-noplayers">No players listed — Pull from Platform or add a player column to your CSV.</div>';
    card.innerHTML = head + (open ? `<div class="seed-players-wrap">${players}</div>` : '');
    // The whole head toggles the per-player editor. Collapsed, a row states the seeding decision;
    // expanded, it becomes the rank/override surface. Keeping both on screen at once for 24 teams
    // is what made the board unreadable.
    const headEl = card.querySelector('.seed-team-head');
    if (headEl) headEl.addEventListener('click', (e) => {
      if (e.target.closest('.seed-prank, .seed-why-btn, input, button, a')) return;
      if (_seedOpenRows.has(i)) _seedOpenRows.delete(i); else _seedOpenRows.add(i);
      seedRender();
    });
    card.querySelectorAll('.seed-prank').forEach((inp) => {
      inp.draggable = false;
      inp.addEventListener('mousedown', (e) => e.stopPropagation());
      inp.addEventListener('change', function () {
        const p = row.players[+this.dataset.pi]; if (!p) return;
        const typed = this.value.trim();
        // Typing in the box is an override, not a vote — see seedSetOverride. Clearing it reverts to auto.
        if (!typed) { seedClearOverride(p); seedStatus(`${p.gamerTag || 'Player'} reverted to the auto-resolved rank.`); }
        else if (seedSetOverride(p, typed)) seedStatus(`${p.gamerTag || 'Player'} set to ${p.rank} — your override, locked against auto-resolve. Save to keep it.`, 'ok');
        else { seedStatus(`"${typed}" isn't a rank this mode understands (${seedMode().ph || 'see the list'}) — not applied.`, 'err'); this.value = p.rank || ''; return; }
        seedRender();   // redraw so the source/confidence chip + team badge update
      });
    });
    // "why" toggles the derivation panel; the panel's Revert drops the override back to auto.
    card.querySelectorAll('.seed-why-btn').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const k = seedWhyKey(+b.dataset.ti, +b.dataset.pi);
      if (_seedWhyOpen.has(k)) _seedWhyOpen.delete(k); else _seedWhyOpen.add(k);
      seedRender();
    }));
    card.querySelectorAll('.seed-why-revert').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = (_seedRows[+b.dataset.ti] || {}).players?.[+b.dataset.pi]; if (!p) return;
      seedClearOverride(p);
      seedStatus(`${p.gamerTag || 'Player'} back to auto — ${p.rank || 'no reading'}${p.confidence ? ` (${p.confidence}%)` : ''}.`);
      seedRender();
    }));
    card.addEventListener('dragstart', (e) => { if (e.target.classList && (e.target.classList.contains('seed-prank') || e.target.classList.contains('seed-why-btn'))) { e.preventDefault(); return; } _seedDragIdx = i; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { _seedDragIdx = -1; card.classList.remove('dragging'); });
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault(); card.classList.remove('drag-over');
      const from = _seedDragIdx, to = i;
      if (from < 0 || from === to) return;
      const moved = _seedRows.splice(from, 1)[0];
      _seedRows.splice(to, 0, moved);
      _seedSortKey = 'custom';
      seedRender();
    });
    list.appendChild(card);
  });
  seedResolutionSummary();
  // Keep the parked-rosters tab live after a re-pull (its "Re-pull" button routes back through here).
  if (_seedTab === 'incomplete') seedRenderIncomplete();
}
// Incomplete tab — teams whose start.gg roster has fewer than the game's roster size. Parked out of
// the seed board until their rosters fill in (re-pull), so seeding only ever runs on full teams.
function seedRenderIncomplete() {
  const list = el('seed-incomplete-list'); if (!list) return;
  seedUpdateTabCounts();
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const size = seedRosterSize();
  if (!_seedIncomplete.length) {
    list.innerHTML = `<div class="seed-empty">No incomplete rosters — every team has ${size} player${size === 1 ? '' : 's'}. Completed rosters stay on the Verified tab.</div>`;
    return;
  }
  const head = `<div class="seed-status" style="display:block;margin:0 0 8px;line-height:1.55;">`
    + `These teams have fewer than <b>${size}</b> players on start.gg (${_seedSizeWhy}), so they're held out of seeding. `
    + `Re-pull once their rosters fill and they move onto the seed board automatically. `
    + `If this event isn't ${size}v${size}, set <b>Team size</b> in the sidebar and they'll all seed. `
    + `<button class="btn btn-secondary btn-xs" id="seed-inc-repull" title="Pull teams + rosters from start.gg again">↻ Re-pull from start.gg</button></div>`;
  const cards = _seedIncomplete.map((row) => {
    const have = (row.players || []).length;
    const need = Math.max(0, size - have);
    const players = have
      ? (row.players || []).map((p) => {
          const acct = p.epic ? `<span class="seed-lpts" title="Epic account (from start.gg)">${esc(p.epic)}</span>`
                     : p.steam ? `<span class="seed-lpts" title="Steam account (from start.gg)">${esc(p.steam)}</span>` : '';
          return `<div class="seed-player"><span class="seed-ptag">${esc(p.gamerTag) || '(player)'}</span>${playerProfileChips(p.gamerTag)}${acct}</div>`;
        }).join('')
      : '<div class="seed-noplayers">No players registered yet.</div>';
    const head2 = `<div class="seed-team-head"><div class="seed-team-name">${esc(row.name) || '(unnamed)'}</div>`
      + `<span class="seed-tv" title="Players registered vs required">${have} / ${size}</span>`
      + `<span class="seed-tv seed-tv-empty" title="Players still needed">needs ${need} more</span></div>`;
    return `<div class="seed-team">${head2}<div class="seed-players-wrap">${players}</div></div>`;
  }).join('');
  list.innerHTML = head + cards;
  const rp = el('seed-inc-repull');
  if (rp) rp.addEventListener('click', () => seedLoadStartgg());
}

// Safe descending rank comparator — unranked (null) always goes below ranked teams.
// Using -Infinity causes NaN when both teams are null, producing indeterminate order.
//
// PURE roster rank, deliberately. Placements order the board under the 'auto' key (seedCmpAuto);
// folding them in here too would apply results twice and make the "team rank" button a results
// sort wearing a rank label. seedCmpAuto calls this as its tiebreak precisely because it is pure.
function seedCmpRank(a, b) {
  const av = seedTeamValue(a), bv = seedTeamValue(b);
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return bv - av;
}

// Unified sort. key: auto | rank | league | seed | name. 'rank'/'league' use the team aggregate value;
// 'auto' is the placement-first order auto-seed produced (re-applied without re-running any lookups).
function seedSort(key) {
  _seedSortKey = key;
  const cmpRank = seedCmpRank;
  if (key === 'auto') { seedAutoScoreRows(); _seedRows.sort(seedCmpAuto); }
  else if (key === 'name') _seedRows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  else if (key === 'seed') _seedRows.sort((a, b) => (a.seedNum || 99999) - (b.seedNum || 99999));
  else if (key === 'league') _seedRows.sort((a, b) => {
    const ar = a.leaguePts != null, br = b.leaguePts != null;
    if (ar && br) return (b.leaguePts - a.leaguePts) || cmpRank(a, b);
    if (ar !== br) return ar ? -1 : 1;
    return cmpRank(a, b);
  });
  else _seedRows.sort(cmpRank);   // 'rank' — unranked teams always bottom
  seedRender();
  if (key !== 'league') seedStatus(`Ordered by ${({ auto: 'tournament placements', rank: 'team rank', seed: 'start.gg seed', name: 'name' }[key] || key)}. Drag to fine-tune, then Save.`);
}
// Sort within each rank tier by event-performance score (higher % = better placement history).
// Teams in the same tier but with better results get seeded higher within that tier.
//
// The tier BUCKET is what matters here, not the raw value. On the MMR-canonical ladder a team's
// value is a continuous blend, so two teams practically never compare equal — comparing raw values
// made this button a no-op. Bucket by tier first, then let the results break the tie.
function seedTierBucket(row) {
  const v = seedTeamValue(row);
  if (v == null) return null;
  if (seedIsMMR()) { const C = window.SeedResolveCore; return C ? C.tierIndex(seedMMRToTier(v)) : Math.round(v / 100); }
  return Math.floor(v / 10);   // tier ladder: value is tierIndex*10 + division
}
function seedSortByPerfScore() {
  _seedRows.sort((a, b) => {
    const ab = seedTierBucket(a), bb = seedTierBucket(b);
    if (ab != null && bb != null && ab !== bb) return bb - ab;
    if ((ab == null) !== (bb == null)) return ab == null ? 1 : -1;
    const ap = a.perfScore, bp = b.perfScore;
    if (ap != null && bp != null && Math.abs(bp - ap) > 0.05) return bp - ap;
    if ((ap != null) !== (bp != null)) return ap != null ? -1 : 1;
    return seedCmpRank(a, b);
  });
  _seedSortKey = 'perf';
  seedRender();   // renumbers
  const n = _seedRows.filter((r) => r.perfScore != null).length;
  seedStatus(n
    ? `Sorted within rank tier by event results (${n} team${n !== 1 ? 's' : ''} have a score). Drag to fine-tune, then Save.`
    : 'No performance scores loaded yet — hit "Local" for our own event placements, or "start.gg" for player history.', n ? 'ok' : 'warn');
}

// ══ IDENTITY GATE (step 2) ═══════════════════════════════════════════════════
// A gamertag is a string, not a person. The registration sheet's "Jonesy", start.gg's
// "NE | Jonesy_" and rl6mans' "jonesy." are three spellings of one player, and until this step
// existed every one of them was a separate identity — which is why a CSV rank could be attached to
// nobody in particular and still outweigh our own tournament results.
//
// This resolves the whole field against the permanent registry (backend/player-identity.js) BEFORE
// any rank is trusted, and hands anything ambiguous to the producer instead of guessing. Two
// outputs: p.identity on every player, and a lineage id per team so a rebranded squad keeps its
// placement history.
//
// Additive by design — with the gate switched off, seeding behaves exactly as it did before.
let _identGate    = true;     // scale rank confidence by identity certainty
let _identResults = [];       // last resolve pass: [{ key, input, status, tier, id, candidates, … }]
let _identTeams   = [];       // last team-lineage pass
let _identDecide  = {};       // rowKey -> { action:'confirm'|'create'|'skip', id }
let _identTab     = 'review';

const IDENT_KEY = 'ne_seed_identity_v1';
function seedLoadIdentityPrefs() {
  try { const s = JSON.parse(localStorage.getItem(IDENT_KEY) || '{}'); if (typeof s.gate === 'boolean') _identGate = s.gate; } catch (_) {}
  const c = el('seed-identity-gate'); if (c) c.checked = _identGate;
}
function seedSaveIdentityPrefs() {
  try { localStorage.setItem(IDENT_KEY, JSON.stringify({ gate: _identGate })); } catch (_) {}
}

// A player's identity tier — what we actually know about who they are. Drives the confidence cap.
function seedIdentityTier(p) {
  if (!p) return 'unverified';
  return (p.identity && p.identity.tier) || 'unverified';
}

// Estimates as the blender should see them: each source's confidence multiplied by how sure we are
// the rank belongs to this player at all. A rank is only as good as the identity under it, so the
// two multiply here rather than the identity acting as a separate filter further downstream.
// Overrides are untouched — seedApplyPlayerValue keeps a producer's typed rank at 100 regardless.
function seedGatedEstimates(p) {
  let est = (p && p.estimates) || [];
  const IC = window.IdentityCore, RC = window.SeedResolveCore;

  // Self-reported ranks first. A manual/CSV entry on a player we could NOT independently verify is
  // corrected for the inflation this field actually shows, and discounted by how often the field's
  // self-reports turned out to be true. A player who already has a verified reading is untouched —
  // their manual estimate is about to lose to the verified one anyway, and adjusting it would
  // double-count the very evidence used to measure the bias.
  const t = _seedSelfTrust;
  if (RC && t && t.ok && est.length) {
    const verified = est.some((e) => e.source === 'sixmans' && e.exactElo > 0);
    if (!verified) {
      est = est.map((e) => (e.source !== 'manual' ? e : {
        ...e,
        mmr: RC.debiasSelfReport(e.mmr, t),
        confidence: Math.round((e.confidence || 0) * t.trust),
        _selfAdj: t.bias,
      }));
    }
  }

  if (!_identGate || !IC || !p || !p.identity) return est;
  const tier = seedIdentityTier(p);
  if (tier === 'verified') return est;
  return est.map((e) => ({ ...e, confidence: IC.capConfidence(e.confidence, tier), _gated: tier }));
}

// Scalar form of the same gate, for the non-MMR cascade where there is no estimate list.
function seedGateConfidence(p, confidence) {
  const IC = window.IdentityCore;
  if (!_identGate || !IC || !p || !p.identity) return confidence;
  return IC.capConfidence(confidence, seedIdentityTier(p));
}

// ══ SELF-REPORTED RANK TRUST ═════════════════════════════════════════════════
// Players misreport their rank on the sign-up sheet. Rather than assume a fixed trust level for
// CSV/manual entries, this measures it on the field in front of us: every player carrying BOTH a
// self-reported rank AND a verified rl6mans reading is a labelled sample of how honest this
// particular field is. Unverified self-reports are then de-biased and discounted by what those
// samples show.
//
// Recomputed on every value pass, because it improves as more players verify.
let _seedSelfTrust = null;   // { n, bias, mae, trust, agreement, ok }

function seedCalibrateSelfReports() {
  const RC = window.SeedResolveCore;
  if (!RC || !seedIsMMR()) { _seedSelfTrust = null; return null; }
  const samples = [];
  seedAllRows().forEach((row) => (row.players || []).forEach((p) => {
    const est = p && p.estimates;
    if (!Array.isArray(est)) return;
    const manual = est.find((e) => e.source === 'manual');
    // Only an EXACT rl6mans ELO counts as ground truth. A tier-only 6mans hit is itself a midpoint,
    // so scoring a self-reported tier against it would mostly measure the ladder, not the player.
    const truth = est.find((e) => e.source === 'sixmans' && e.exactElo > 0);
    if (manual && truth) samples.push({ reported: manual.mmr, verified: truth.exactElo });
  }));
  _seedSelfTrust = RC.selfReportTrust(samples);
  return _seedSelfTrust;
}

// One line for the strip, only when there is something to say.
function seedSelfTrustNote() {
  const t = _seedSelfTrust;
  if (!t || !t.ok) return '';
  const pct = Math.round(t.agreement * 100);
  if (t.bias >= 40)  return `Sheet ranks run <b>${t.bias}</b> MMR high across ${t.n} checked players — unverified entries corrected down.`;
  if (t.bias <= -40) return `Sheet ranks run <b>${Math.abs(t.bias)}</b> MMR low across ${t.n} checked players — unverified entries corrected up.`;
  return `Sheet ranks check out on ${pct}% of ${t.n} verified players.`;
}

// A short badge for the team/player cards: how much of this roster we can actually vouch for.
function seedIdentityBadge(p) {
  if (!p || !p.identity) return '';
  const t = seedIdentityTier(p);
  if (t === 'verified') return '';   // the normal case — no badge noise
  const label = t === 'probable' ? 'name only' : t === 'conflicted' ? 'ambiguous' : 'unknown player';
  const color = t === 'conflicted' ? '#e53e3e' : t === 'probable' ? '#d69e2e' : '#718096';
  return `<span class="seed-ident-badge" style="color:${color}; border-color:${color}" title="Identity ${t} — rank confidence is scaled down accordingly. Run Check identities to resolve.">${label}</span>`;
}

function seedTeamIdentityCount(row) {
  const ps = (row && row.players) || [];
  return { total: ps.length, verified: ps.filter((p) => seedIdentityTier(p) === 'verified').length };
}

// Every player in the field as a resolve input. The row key is "teamIndex:playerIndex" against
// seedAllRows() so results map straight back without re-matching on gamertag — the exact thing
// this layer exists to stop doing.
function seedIdentityInputs() {
  const out = [];
  seedAllRows().forEach((row, ti) => (row.players || []).forEach((p, pi) => {
    if (!p || !p.gamerTag) return;
    out.push({
      key: `${ti}:${pi}`,
      gamertag: p.gamerTag,
      startgg: p.startggSlug || p.startggPlayerId || '',
      epic: (p.tracker && p.tracker.platform === 'epic' && p.tracker.username) || p.epic || '',
      steam: (p.tracker && p.tracker.platform === 'steam' && p.tracker.username) || '',
      sixmans: (p.sixmans && p.sixmans.name) || '',
    });
  }));
  return out;
}

function seedPlayerByKey(key) {
  const [ti, pi] = String(key).split(':').map(Number);
  const row = seedAllRows()[ti];
  return row && row.players ? row.players[pi] : null;
}

// Run the check. Read-only on the server — nothing is written to the registry until Apply.
async function seedIdentityCheck() {
  const btn = el('seed-identity-check');
  const players = seedIdentityInputs();
  if (!players.length) { seedStatus('No players to check — load the field first.', 'err'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
  seedStatus(`Resolving ${players.length} players against the identity registry...`);
  try {
    const res = await fetch('http://localhost:3000/api/identity/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ players }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Resolve failed');
    _identResults = data.results || [];
    _identDecide = {};

    // Stamp every player with what we found, so the gate and the badges work even if the producer
    // closes the modal without deciding anything.
    _identResults.forEach((r) => {
      const p = seedPlayerByKey(r.key);
      if (!p) return;
      p.identity = { id: r.id || null, tier: r.tier, status: r.status, score: r.score,
        matchedOn: r.matchedOn || [], primary: (r.record && r.record.primary) || '' };
    });
    seedRecomputeValues();

    await seedIdentityMatchTeams();
    seedRenderIdentityStat();
    openIdentityModal();
    const need = _identResults.filter((r) => r.status === 'review').length;
    const fresh = _identResults.filter((r) => r.status === 'new').length;
    seedStatus(`Identity check: ${_identResults.length - need - fresh} matched, ${need} need a decision, ${fresh} new.`,
      need ? 'warn' : 'ok');
  } catch (err) {
    seedStatus(`Identity check failed: ${err.message}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check identities'; }
  }
}

// Which known team entity is each roster? Uses the ids we just resolved, so a team that rebranded
// still matches on roster overlap.
async function seedIdentityMatchTeams() {
  const teams = seedAllRows().map((row, ti) => ({
    key: String(ti), name: row.name,
    playerIds: (row.players || []).map((p) => p.identity && p.identity.id).filter(Boolean),
  })).filter((t) => t.playerIds.length);
  if (!teams.length) { _identTeams = []; return; }
  try {
    const res = await fetch('http://localhost:3000/api/identity/team-match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teams }),
    });
    const data = await res.json();
    _identTeams = (data && data.ok) ? (data.results || []) : [];
    _identTeams.forEach((t) => {
      const row = seedAllRows()[Number(t.key)];
      if (!row) return;
      row.lineage = t.id ? { id: t.id, score: t.score, basis: t.basis,
        names: (t.record && t.record.names) || [] } : null;
    });
  } catch (_) { _identTeams = []; }
}

function seedRenderIdentityStat() {
  const box = el('seed-identity-stat'); if (!box) return;
  if (!_identResults.length) { box.innerHTML = ''; return; }
  const need  = _identResults.filter((r) => r.status === 'review').length;
  const fresh = _identResults.filter((r) => r.status === 'new').length;
  const ok    = _identResults.length - need - fresh;
  // A rebrand we can actually see is the headline result of this step — surface it here, not just
  // inside the modal, because it is what changes a team's seed.
  const renames = seedAllRows().filter((r) => r.lineage && r.lineage.basis === 'roster'
    && !(r.lineage.names || []).some((n) => (n || '').toLowerCase() === (r.name || '').toLowerCase())).length;
  box.innerHTML = `<b>${ok}</b> identified · <b class="${need ? 'seed-ident-warn' : ''}">${need}</b> need you · <b>${fresh}</b> new`
    + (renames ? `<br><span class="seed-ident-rename">${renames} team${renames !== 1 ? 's' : ''} matched to earlier history under a different name</span>` : '');
}

// ── Triage modal ────────────────────────────────────────────────────────────
function openIdentityModal() {
  el('seed-ident-modal')?.removeAttribute('hidden');
  const need  = _identResults.filter((r) => r.status === 'review').length;
  const fresh = _identResults.filter((r) => r.status === 'new').length;
  const ok    = _identResults.length - need - fresh;
  const sum = el('seed-ident-summary');
  if (sum) sum.textContent = need
    ? `${ok} of ${_identResults.length} players identified. ${need} could be more than one person — pick the right one, or leave it and their rank stays discounted. ${fresh} look new.`
    : `${ok} of ${_identResults.length} players identified, ${fresh} new. Nothing ambiguous — Apply to record this field's rosters.`;
  siSwitchTab(need ? 'review' : fresh ? 'new' : 'matched');
}
function closeIdentityModal() { el('seed-ident-modal')?.setAttribute('hidden', ''); }

function siSwitchTab(tab) {
  _identTab = tab;
  el('seed-ident-modal')?.querySelectorAll('.si-tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.sitab === tab);
  });
  renderIdentityBody();
}

function siRowLabel(r) {
  const p = seedPlayerByKey(r.key);
  const [ti] = String(r.key).split(':').map(Number);
  const row = seedAllRows()[ti];
  return { tag: (p && p.gamerTag) || (r.input && r.input.gamertag) || '', team: (row && row.name) || '' };
}

function renderIdentityBody() {
  const body = el('seed-ident-body'); if (!body) return;
  const esc = escHtml;

  if (_identTab === 'teams') { body.innerHTML = renderIdentityTeams(); seedUpdateIdentCount(); return; }

  const want = _identTab === 'review' ? 'review' : _identTab === 'new' ? 'new' : 'auto';
  const rows = _identResults.filter((r) => r.status === want);
  if (!rows.length) {
    body.innerHTML = `<div class="si-empty">Nothing here — ${
      want === 'review' ? 'every player resolved cleanly.' : want === 'new' ? 'no new players in this field.' : 'no automatic matches.'}</div>`;
    seedUpdateIdentCount();
    return;
  }

  body.innerHTML = rows.map((r) => {
    const { tag, team } = siRowLabel(r);
    const dec = _identDecide[r.key] || {};
    if (want === 'auto') {
      const rec = r.record || {};
      return `<div class="si-row si-row-ok">
        <div class="si-main"><b>${esc(tag)}</b><span class="si-team">${esc(team)}</span></div>
        <div class="si-match">matched <b>${esc(rec.primary || '')}</b>
          <span class="si-on">via ${esc((r.matchedOn || []).join(', ') || 'name')}</span></div>
        <div class="si-tier si-tier-${esc(r.tier)}">${esc(r.tier)}</div>
      </div>`;
    }
    if (want === 'new') {
      const chosen = dec.action !== 'skip';
      return `<div class="si-row">
        <div class="si-main"><b>${esc(tag)}</b><span class="si-team">${esc(team)}</span></div>
        <div class="si-match si-muted">No match in the registry — will be added as a new player.</div>
        <label class="si-check"><input type="checkbox" ${chosen ? 'checked' : ''}
          onchange="siSetDecision('${esc(r.key)}', this.checked ? 'create' : 'skip')"> add</label>
      </div>`;
    }
    // review — the whole point of the gate: we found something, but not confidently enough to act.
    const cands = (r.candidates || []).slice(0, 4).map((c) => {
      const rec = c.record || {};
      const on = (c.matchedOn || []).join(', ');
      const tags = ((rec.aliases && rec.aliases.gamertag) || []).slice(0, 4).join(', ');
      const sel = dec.action === 'confirm' && dec.id === c.id;
      return `<label class="si-cand ${sel ? 'si-cand-sel' : ''}">
        <input type="radio" name="si-${esc(r.key)}" ${sel ? 'checked' : ''}
          onchange="siSetDecision('${esc(r.key)}', 'confirm', '${esc(c.id)}')">
        <span class="si-cand-name">${esc(rec.primary || c.id)}</span>
        <span class="si-cand-meta">${esc(tags)}</span>
        <span class="si-cand-score">${c.score}% ${esc(on)}</span>
      </label>`;
    }).join('');
    const isNew  = dec.action === 'create';
    const isSkip = !dec.action || dec.action === 'skip';
    return `<div class="si-row si-row-review">
      <div class="si-main"><b>${esc(tag)}</b><span class="si-team">${esc(team)}</span>
        ${r.contested ? '<span class="si-contested">two players match equally well</span>' : ''}</div>
      <div class="si-cands">
        ${cands}
        <label class="si-cand ${isNew ? 'si-cand-sel' : ''}">
          <input type="radio" name="si-${esc(r.key)}" ${isNew ? 'checked' : ''}
            onchange="siSetDecision('${esc(r.key)}', 'create')">
          <span class="si-cand-name">None of these</span>
          <span class="si-cand-meta">add as a new player</span>
        </label>
        <label class="si-cand ${isSkip ? 'si-cand-sel' : ''}">
          <input type="radio" name="si-${esc(r.key)}" ${isSkip ? 'checked' : ''}
            onchange="siSetDecision('${esc(r.key)}', 'skip')">
          <span class="si-cand-name">Decide later</span>
          <span class="si-cand-meta">stays confidence-capped</span>
        </label>
      </div>
    </div>`;
  }).join('');
  seedUpdateIdentCount();
}

// The rebrand view: which teams this field maps onto history we already have.
function renderIdentityTeams() {
  const esc = escHtml;
  const rows = seedAllRows().filter((r) => (r.players || []).length);
  if (!rows.length) return '<div class="si-empty">No teams loaded.</div>';
  return rows.map((row) => {
    const { total, verified } = seedTeamIdentityCount(row);
    const L = row.lineage;
    const renamed = L && (L.names || []).length && !(L.names || []).some((n) => (n || '').toLowerCase() === (row.name || '').toLowerCase());
    const hist = !L ? '<span class="si-muted">No earlier history — new team</span>'
      : renamed ? `Matched to <b>${esc((L.names || [])[0] || '')}</b> <span class="si-on">by ${esc(L.basis)} (${L.score}%)</span>`
      : `Known team <span class="si-on">${esc(L.basis)} match (${L.score}%)</span>`;
    return `<div class="si-row">
      <div class="si-main"><b>${esc(row.name)}</b>
        <span class="si-team">${verified}/${total} identified</span></div>
      <div class="si-match">${hist}</div>
    </div>`;
  }).join('');
}

function siSetDecision(key, action, id) {
  _identDecide[key] = { action, id: id || null };
  renderIdentityBody();
}

function seedUpdateIdentCount() {
  const c = el('seed-ident-count'); if (!c) return;
  const decided = Object.values(_identDecide).filter((d) => d.action && d.action !== 'skip').length;
  const need = _identResults.filter((r) => r.status === 'review').length;
  c.textContent = `${decided} decision${decided !== 1 ? 's' : ''} ready · ${need} ambiguous`;
}

// Accept every suggested match on the current tab: the top candidate for review rows, "add" for
// new players. Deliberately does NOT touch contested rows — those are ambiguous precisely because
// the top candidate is not clearly right, so bulk-accepting them would defeat the gate.
function seedIdentityAcceptAll() {
  let n = 0, skipped = 0;
  _identResults.forEach((r) => {
    if (_identTab === 'new' && r.status === 'new') { _identDecide[r.key] = { action: 'create' }; n++; }
    else if (_identTab === 'review' && r.status === 'review') {
      if (r.contested) { skipped++; return; }
      const top = (r.candidates || [])[0];
      if (top) { _identDecide[r.key] = { action: 'confirm', id: top.id }; n++; }
    }
  });
  renderIdentityBody();
  seedStatus(`Accepted ${n} suggested match${n !== 1 ? 'es' : ''}.`
    + (skipped ? ` ${skipped} contested row${skipped !== 1 ? 's' : ''} left for you — the top candidate isn't clearly right.` : ''),
    skipped ? 'warn' : 'ok');
}

// Commit the decisions, then re-resolve so every player carries its new tier and the gate reflects
// what the producer just confirmed.
async function seedIdentityApply() {
  const btn = el('seed-ident-apply');
  const decisions = Object.entries(_identDecide)
    .filter(([, d]) => d.action && d.action !== 'skip')
    .map(([key, d]) => {
      const r = _identResults.find((x) => String(x.key) === String(key));
      return { action: d.action, id: d.id, player: r ? r.input : null };
    });
  // Registering the field's rosters is worth doing even with zero identity decisions — it is what
  // records this event's lineups so a future rebrand has something to match against.
  if (btn) { btn.disabled = true; btn.textContent = 'Applying...'; }
  try {
    if (decisions.length) {
      const res = await fetch('http://localhost:3000/api/identity/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Commit failed');
      if ((data.failed || []).length) console.warn('[identity] commit issues:', data.failed);
    }
    await seedIdentityRecordRosters();
    closeIdentityModal();
    await seedIdentityCheckQuiet();
    seedStatus(decisions.length
      ? `Identity registry updated — ${decisions.length} decision${decisions.length !== 1 ? 's' : ''} applied. Rank confidence re-scored.`
      : 'Rosters recorded against the identity registry.', 'ok');
  } catch (err) {
    seedStatus(`Apply failed: ${err.message}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
  }
}

// Record this event's rosters so future events can match a rebrand back to them.
async function seedIdentityRecordRosters() {
  const teams = seedAllRows().map((row) => ({
    name: row.name,
    playerIds: (row.players || []).map((p) => p.identity && p.identity.id).filter(Boolean),
    eventSlug: (_seedEvent && _seedEvent.eventSlug) || null,
    // myEvents stores startAt in SECONDS; lineage rosters are timestamped in ms like Date.now().
    at: (_seedEvent && _seedEvent.startAt) ? _seedEvent.startAt * 1000 : null,
  })).filter((t) => t.playerIds.length >= 2);
  if (!teams.length) return;
  try {
    await fetch('http://localhost:3000/api/identity/team-record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teams }),
    });
  } catch (_) { /* recording history must never block the seed */ }
}

// Re-resolve without reopening the modal — used after Apply so tiers/badges refresh in place.
async function seedIdentityCheckQuiet() {
  const players = seedIdentityInputs();
  if (!players.length) return;
  try {
    const res = await fetch('http://localhost:3000/api/identity/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ players }),
    });
    const data = await res.json();
    if (!data.ok) return;
    _identResults = data.results || [];
    _identResults.forEach((r) => {
      const p = seedPlayerByKey(r.key);
      if (!p) return;
      p.identity = { id: r.id || null, tier: r.tier, status: r.status, score: r.score,
        matchedOn: r.matchedOn || [], primary: (r.record && r.record.primary) || '' };
    });
    await seedIdentityMatchTeams();
    seedRecomputeValues();
    seedRenderIdentityStat();
    seedRender();
  } catch (_) {}
}

// Score teams from OUR OWN event history — how they finished our past events (recency-weighted),
// backed up by set win/loss. The first call after adding an event pulls that event's final
// standings from start.gg; after that it's served from the local stats DB.
async function seedApplyOurEvents(opts) {
  const res = await fetch('http://localhost:3000/api/seeding/local-scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teams: _seedRows.map((r) => r.name),
      excludeSlug: (_seedEvent && _seedEvent.eventSlug) || null,   // never seed an event off its own result
      refresh: !!(opts && opts.refresh),
    }),
  });
  const data = await res.json();
  if (!data || !data.ok) throw new Error((data && data.error) || 'Request failed');
  _seedRows.forEach((row) => {
    const s = data.scores[row.name];
    row._ourEventsScore = (s != null) ? s : null;
    row._ourEventsDetail = (data.detail && data.detail[row.name]) || null;
    row.perfScore = row._ourEventsScore;          // the badge on the card
    row.perfSource = row._ourEventsScore != null ? 'ourEvents' : null;
  });
  return data;
}

// Force-refresh the past-event standings behind the placement scores — the one to hit when an event
// finished mid-session and its result isn't in the cache auto-seed reads.
async function seedFetchLocalScores() {
  const btn = el('seed-local-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
  seedStatus('Re-pulling our past event standings from start.gg...');
  try {
    const data = await seedApplyOurEvents({ refresh: true });
    seedComputePlacementScores();
    const scored = _seedRows.filter((r) => r._ourEventsScore != null).length;
    const withPlace = _seedRows.filter((r) => r._ourEventsDetail && r._ourEventsDetail.placementScore != null).length;
    seedStatus(data.eventsScored
      ? `Past-event standings refreshed: ${scored}/${_seedRows.length} teams scored — ${withPlace} from placements across ${data.eventsScored} event${data.eventsScored !== 1 ? 's' : ''}. Hit Re-seed to apply.`
      : `No past event standings found. Add your finished events under My Events (and set a start.gg API token) so seeding can count their placements.`, data.eventsScored ? 'ok' : 'warn');
    seedRender();
  } catch (err) {
    seedStatus(`Our-events score failed: ${err.message}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh past events'; }
  }
}

// Score teams by fetching each player's recent start.gg placements (all events, weighted by recency).
async function seedFetchPerformanceScores() {
  const btn = el('seed-score-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching...'; }
  seedStatus('Fetching start.gg tournament history...');

  const allSlugs = [...new Set(
    _seedRows.flatMap((r) => (r.players || []).map((p) => p.startggSlug).filter(Boolean))
  )];

  if (!allSlugs.length) {
    seedStatus('No start.gg player profiles found. Pull entrants from start.gg first (Data → Pull).', 'err');
    if (btn) { btn.disabled = false; btn.textContent = 'start.gg'; }
    return;
  }

  try {
    const res = await fetch('http://localhost:3000/api/startgg/player-standings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs: allSlugs }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Request failed');

    _seedRows.forEach((row) => (row.players || []).forEach((p) => {
      p._startggScore = (p.startggSlug && data.scores[p.startggSlug] != null) ? data.scores[p.startggSlug] : null;
    }));
    seedComputePlacementScores();   // one formula for what a placement is worth (shared with auto-seed)

    const scored = _seedRows.filter((r) => r.perfScore != null).length;
    seedStatus(`start.gg player history loaded for ${scored}/${_seedRows.length} teams (${allSlugs.length} players). Hit Re-seed to apply.`, 'ok');
    seedRender();
  } catch (err) {
    seedStatus(`Score fetch failed: ${err.message}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'From Platform'; }
  }
}

// ══ AUTO-SEED ════════════════════════════════════════════════════════════════
// The front door. Opening an unseeded event lands here: pull the field from start.gg, then order it
// by how these teams have actually FINISHED tournaments — our own past events first (real standings,
// recency-weighted), then each player's start.gg placement history for teams we've never run.
//
// Ranks are a layer, not the foundation. A team with tournament history is ordered by that history
// and nothing else; 6mans only speaks for teams with no history at all, and where it does, the team
// is slotted into the board using this field's own rank→placement curve (see SeedResolveCore.
// scoreFromRank) so a stacked new roster doesn't get buried under a team that went 9th of 16.
let _seedUse6mans = true;       // "Add 6mans ranks" — fills the teams placements can't speak for
let _seedUseTracker = true;     // tracker.gg fallback for players rl6mans has never seen (Advanced can disable)
let _seedNewTeams = 'slot';     // where history-less teams go: 'slot' (by rank) | 'bottom'
let _seedAutoRunning = false;
let _seedAutoAbort = false;
let _seedAutoStats = null;      // last run: { placed, ranked, none, events, fitted }

const SEED_SIG_KEY = 'ne_seed_signals_v1';
function seedLoadSignalPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem(SEED_SIG_KEY) || '{}');
    if (typeof s.use6mans === 'boolean') _seedUse6mans = s.use6mans;
    if (typeof s.useTracker === 'boolean') _seedUseTracker = s.useTracker;
    if (s.newTeams === 'slot' || s.newTeams === 'bottom') _seedNewTeams = s.newTeams;
  } catch (_) {}
  const b = el('seed-resolve-tracker');
  if (b) b.checked = _seedUseTracker;
  seedSyncSignalUI();
}
function seedSaveSignalPrefs() {
  try { localStorage.setItem(SEED_SIG_KEY, JSON.stringify({ use6mans: _seedUse6mans, useTracker: _seedUseTracker, newTeams: _seedNewTeams })); } catch (_) {}
}
// tracker.gg and the new-team placement only mean anything while 6mans is on — grey them out rather
// than leave dead controls that look live.
// Retained as a no-op: the 6mans/tracker toggles it used to grey out are gone (6mans always runs,
// tracker.gg is an Advanced opt-out), but seedLoadSignalPrefs still calls it.
function seedSyncSignalUI() {}


// The headline over the board: what the current order is standing on.
function seedAutoNote(html, kind) {
  const s = el('seed-auto-summary'); if (!s) return;
  s.innerHTML = kind === 'warn' ? `<span class="seed-auto-warn">${html}</span>` : html;
}
// The one always-true sentence on the strip: what this order actually stands on.
//
// Rewritten for the power rating. The old copy described the two-basis scorer — "N from past
// placements, N from 6mans ranks", plus a note about where new teams got slotted — which no longer
// describes anything that happens: every team is rated on the same scale from both signals, so
// there is no longer a population of teams seeded "from ranks" as opposed to "from placements".
function seedAutoBarRender() {
  const st = _seedAutoStats;
  const F = _seedPowerField;
  if (!st && !F) return;
  const P = window.SeedPowerCore;
  const label = (P && P.PRESETS[_seedPreset]) ? P.PRESETS[_seedPreset].label.toLowerCase() : _seedPreset;
  const rated = F ? F.rated : 0;
  const unrated = F ? (F.total - F.rated) : 0;

  const withResults = _seedRows.filter((r) => r.autoBasis === 'both' || r.autoBasis === 'results').length;
  const skillOnly   = _seedRows.filter((r) => r.autoBasis === 'skill').length;
  const bits = [];
  if (withResults) bits.push(`<b>${withResults}</b> with event history`);
  if (skillOnly)   bits.push(`<b>${skillOnly}</b> on roster rank alone`);
  const ev = (st && st.events) ? ` Counting ${st.events} past event${st.events !== 1 ? 's' : ''}.` : '';
  const un = unrated ? ` <b>${unrated}</b> unrated at the bottom — no ranks and no history.` : '';

  const selfNote = seedSelfTrustNote();
  seedAutoNote(
    (selfNote ? selfNote + ' ' : '')
    + `<b>${rated}</b> team${rated !== 1 ? 's' : ''} ordered by one power rating (${label})`
    + (bits.length ? ` — ${bits.join(', ')}.` : '.')
    + `${ev}${un} Drag to fine-tune, then Save.`,
    unrated && !rated ? 'warn' : '');
}

// Shared rank-lookup pass — rl6mans (registry prefill, then batched profile lookups), then tracker.gg
// as the optional slow fallback. Scoped to a caller-supplied row list so ONE implementation serves
// both auto-seed (just the history-less teams) and Advanced's "Resolve all ranks" (the whole field).
async function seedLookupRanksFor(rows, o) {
  o = o || {};
  const btn = o.btn, abort = o.abort || (() => false), label = o.label || 'Resolve';
  const region = (el('seed-6mans-region') && el('seed-6mans-region').value) || 'NA';
  const registry = currentState.playerProfiles || {};
  const hasSixmans = (p) => seedIsMMR() ? (p.estimates || []).some((e) => e.source === 'sixmans') : (p.confidence || 0) >= 95;
  const stat = { sixmans: 0, tracker: 0, looked: 0 };
  const need = [];
  rows.forEach((row) => {
    const ti = _seedRows.indexOf(row);
    (row.players || []).forEach((p, pi) => {
      if (hasSixmans(p)) return;                                     // already have a 6mans reading
      const reg = registry[(p.gamerTag || '').trim().toLowerCase()];
      if (reg && reg.sixmans && reg.sixmans.rank) {
        if (seedApplySixmans(p, { rank: reg.sixmans.rank, elo: reg.sixmans.elo || 0 }, reg.sixmans.elo > 0 ? 96 : 92,
          'rl6mans registry' + (reg.sixmans.elo ? ' · ' + reg.sixmans.elo + ' ELO' : ''))) stat.sixmans++;
      } else if (p.gamerTag && ti >= 0) {
        need.push({ ti, pi, p, name: p.gamerTag, alts: [p.epic, ...(p.alts || [])].filter(Boolean) });
      }
    });
  });
  stat.looked = need.length;
  const BATCH = 12;
  for (let i = 0; i < need.length; i += BATCH) {
    if (abort()) throw 'abort';
    const chunk = need.slice(i, i + BATCH);
    const at = Math.min(i + BATCH, need.length);
    seedStatus(`${label} — rl6mans ${at}/${need.length}…`);
    if (btn) btn.textContent = `Cancel · rl6mans ${at}/${need.length}`;
    try {
      const res = await fetch('http://localhost:3000/api/rl6mans/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: chunk.map((c) => ({ name: c.name, alts: c.alts })), region, profilesOnly: true }),
      });
      const data = await res.json();
      if (data && data.ok) (data.results || []).forEach((rr) => {
        if (!rr.match || rr.confidence !== 'exact') return;
        const c = chunk.find((x) => (x.name || '').toLowerCase() === (rr.input || '').toLowerCase());
        if (c && c.p && seedApplySixmans(c.p, rr.match, 98, 'rl6mans.com verified' + (rr.match.elo > 0 ? ' · ' + rr.match.elo + ' ELO' : ''))) stat.sixmans++;
      });
    } catch (_) { /* one batch failing must never abort the run */ }
  }
  if (abort()) throw 'abort';
  // Learn the tier→MMR ladder from the exact ELOs just gathered, then re-blend tier-derived estimates.
  if (seedIsMMR()) seedCalibrateMidpoints();

  if (!o.tracker || !seedIsMMR()) return stat;
  const targets = [];
  rows.forEach((row) => {
    const ti = _seedRows.indexOf(row);
    (row.players || []).forEach((p, pi) => {
      if (ti < 0) return;
      if (seedIsOverridden(p)) return;                                       // your call — don't spend a lookup
      if ((p.estimates || []).some((e) => e.source === 'sixmans')) return;    // already has the better source
      if ((p.estimates || []).some((e) => e.source === 'tracker')) return;    // already tried this run
      targets.push({ ti, pi, p });
    });
  });
  for (let i = 0; i < targets.length; i++) {
    if (abort()) throw 'abort';
    const t = targets[i];
    seedStatus(`${label} — tracker.gg ${i + 1}/${targets.length} (${t.p.gamerTag || 'player'})…`);
    if (btn) btn.textContent = `Cancel · tracker ${i + 1}/${targets.length}`;
    try {
      const h = seedTgHandle(t.p);
      if (!h || !h.username) continue;
      const data = await _tgLookupByAccount(t.ti, t.pi, h.platform, h.username);
      const est = seedEstTracker(data, 85, `tracker.gg · ${data && data.tier ? data.tier : 'rank'}`);
      if (est && seedApplyEstimate(t.p, est)) stat.tracker++;
    } catch (_) { /* one player failing must never abort the run */ }
  }
  return stat;
}

// Every team's placement score, from the two histories we can see. Our own events weigh heaviest —
// they're this field, this circuit, our own recorded standings; a player's wider start.gg record is
// a weaker second opinion (different games, different regions, whoever happened to be linked).
function seedComputePlacementScores() {
  _seedRows.forEach((row) => {
    row._leagueScore = seedLeagueWinPct(row.name);
    const oe = row._ourEventsScore, lg = row._leagueScore;
    const ours = (oe != null && lg != null) ? (0.75 * oe + 0.25 * lg) : (oe != null ? oe : lg);
    const sgVals = (row.players || []).map((p) => p._startggScore).filter((v) => v != null);
    const sg = sgVals.length ? sgVals.reduce((a, b) => a + b, 0) / sgVals.length : null;
    row._sggTeamScore = sg == null ? null : Math.round(sg * 10) / 10;
    row._teamScore = ours == null ? null : Math.round(ours * 10) / 10;   // what the rank cascade reads
    const combined = (ours != null && sg != null) ? (0.65 * ours + 0.35 * sg) : (ours != null ? ours : sg);
    row.placementScore = combined == null ? null : Math.round(combined * 10) / 10;
    row.placementFrom = (ours != null && sg != null) ? 'both' : (ours != null ? 'ourEvents' : (sg != null ? 'startgg' : null));
    // The card badge + its tooltip: our-events detail when we have it, else the start.gg wording.
    row.perfScore = row.placementScore;
    row.perfSource = ours != null ? 'ourEvents' : (sg != null ? 'startgg' : null);
  });
}

// Turn placement scores + (optionally) team rank into the single number the board sorts on.
// Teams WITH history keep their placement score untouched — a rank never moves them. Teams without
// get a placement-equivalent predicted from this field's own rank→placement fit, so they interleave
// honestly. Too little overlap to fit (fewer than 3 teams with both signals, or no real correlation)
// and we say so rather than guess: they fall to the bottom, ordered among themselves by rank.
// Which way the board leans: 'skill' | 'balanced' | 'results'. See SeedPowerCore.PRESETS.
let _seedPreset = 'skill';
let _seedPowerField = null;   // last rating pass: { spread, median, cap, rated, total, weights }

// ONE power rating per team — the single ordering. Replaces the old two-basis scorer, which ranked
// teams that had event history by placementScore ("a rank never moves them") and teams without it by
// a placement score reverse-engineered from their ranks. Which basis a team got depended on whether
// its NAME matched past standings, so a rebrand silently flipped a veteran onto the rank basis and
// the board became two interleaved orderings that disagreed. Now skill and results both feed every
// team's number; see control-panel/seed-power-core.js for the maths.
function seedAutoScoreRows() {
  const PC = window.SeedPowerCore;
  if (!PC) return { fitted: 0, anchors: 0 };   // core missing: leave the board untouched rather than mis-seed it

  const rated = PC.ratePower(_seedRows.map((row, i) => ({
    key: i,
    name: row.name,
    // Per-player seed MMR is already the confidence-weighted blend of 6mans / tracker.gg / manual
    // (blendMMRToPlayer), with the identity gate applied — so unverified players arrive pre-discounted.
    players: (row.players || []).map((p) => ({
      mmr: Number.isFinite(p.seedMMR) ? p.seedMMR : (seedIsMMR() ? null : p.rankValue),
      confidence: p.confidence || 0,
      identityTier: seedIdentityTier(p),
    })),
    resultsScore: row.placementScore != null ? row.placementScore : null,
    resultsConfidence: (row._ourEventsDetail && row._ourEventsDetail.confidence != null)
      ? row._ourEventsDetail.confidence
      : (row.placementScore != null ? 60 : 0),
    seedNum: row.seedNum,
  })), { preset: _seedPreset, rosterSize: seedRosterSize() });

  const byKey = new Map(rated.teams.map((t) => [t.key, t]));
  _seedRows.forEach((row, i) => {
    const t = byKey.get(i);
    if (!t) { row.autoScore = null; row.autoBasis = 'none'; return; }
    row.power        = t.power;
    row.rosterMMR    = t.rosterMMR;
    row.rosterMean   = t.rosterMean;
    row.rosterSpread = t.rosterSpread;
    row.resultsAdj   = t.resultsAdj;
    row.powerResidual= t.residual;
    row.powerConf    = t.confidence;
    row.powerExplain = t.explain;
    row.autoScore    = t.power;              // the one number the board sorts on
    row.autoBasis    = t.basis;              // 'both' | 'skill' | 'results' | 'none' — evidence, not ordering
  });
  _seedPowerField = rated.field;
  return { fitted: rated.field.rated, anchors: rated.field.total, field: rated.field };
}

// Auto-seed order: score desc. Anything unscored sits below everything scored — rank-only teams that
// couldn't be slotted first (by team rank), then teams with no signal at all in their start.gg order.
function seedCmpAuto(a, b) {
  const as = a.autoScore, bs = b.autoScore;
  if (as != null && bs != null) {
    if (Math.abs(bs - as) > 0.05) return bs - as;
    return seedCmpRank(a, b);
  }
  if (as != null) return -1;
  if (bs != null) return 1;
  const an = a.autoBasis === 'none', bn = b.autoBasis === 'none';
  if (an !== bn) return an ? 1 : -1;
  const av = seedTeamValue(a), bv = seedTeamValue(b);
  if (av != null && bv != null && av !== bv) return bv - av;
  if (av != null) return -1;
  if (bv != null) return 1;
  return (a.seedNum || 99999) - (b.seedNum || 99999);
}

// What a team's seed is standing on, for the card chip.
// What a team's seed is standing on, for the card chip. The basis now describes EVIDENCE, not a
// separate ordering — every team is on the one power scale regardless of which chip it shows.
function seedBasisChip(row) {
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const b = row.autoBasis;
  if (!b || b === 'none') {
    return `<span class="seed-basis seed-basis-none" title="Nothing to seed on — no player ranks and no event history. Type a rank on any player, or turn on the tracker.gg fallback and re-seed.">no data</span>`;
  }
  const lines = [row.powerExplain || ''];
  if (row.power != null) lines.push(`Power ${row.power}  (roster ${row.rosterMMR}${row.resultsAdj ? `, results ${row.resultsAdj > 0 ? '+' : ''}${row.resultsAdj}` : ''})`);
  const d = row._ourEventsDetail || {};
  (d.events || []).slice(0, 6).forEach((e) => lines.push(`  ${e.placement}${ordSuffix(e.placement)} of ${e.of} — ${e.event}`));
  if (row._sggTeamScore != null) lines.push(`start.gg player history: ${row._sggTeamScore}`);
  if (row._leagueScore != null) lines.push(`League win rate: ${row._leagueScore}%`);
  if (row.powerConf != null) lines.push(`Confidence ${row.powerConf}%`);
  const title = esc(lines.filter(Boolean).join('\n'));

  if (b === 'both')    return `<span class="seed-basis seed-basis-placements" title="${title}">rank + results</span>`;
  if (b === 'skill')   return `<span class="seed-basis seed-basis-ranks" title="${title}">rank only</span>`;
  if (b === 'results') return `<span class="seed-basis seed-basis-placements" title="${title}">results only</span>`;
  return '';
}

// The one button. Pull → placements → (6mans for the gaps) → order.
async function seedAutoSeed(opts) {
  opts = opts || {};
  const btn = el('seed-autoseed');
  if (_seedAutoRunning) { _seedAutoAbort = true; return; }     // click again = cancel
  if (!_seedEvent) return;
  _seedAutoRunning = true; _seedAutoAbort = false;
  const abort = () => _seedAutoAbort;
  if (btn) { btn.textContent = 'Cancel'; btn.classList.add('btn-danger'); btn.classList.remove('btn-primary'); }
  try {
    // 1 — the field itself.
    if (!_seedRows.length && _seedEvent.eventSlug) {
      seedAutoNote('Pulling the field from start.gg…');
      await seedLoadStartgg();
    }
    if (abort()) throw 'abort';
    if (!_seedRows.length) {
      seedAutoNote('No teams on the board yet — pull from start.gg or import a CSV under Advanced.', 'warn');
      return;
    }
    // Hand/CSV ranks already on the board still count as a source for the gap teams.
    if (seedIsMMR()) seedMigrateAllEstimates();

    // 2 — how these teams finished OUR past events (real standings, recency-weighted).
    seedAutoNote('Reading how these teams finished your past events…');
    seedStatus('Auto-seed — our past event placements…');
    let oeData = null;
    try { oeData = await seedApplyOurEvents({ refresh: !!opts.refresh }); } catch (_) {}
    if (abort()) throw 'abort';

    // 3 — each player's wider start.gg placement history (one request for the whole field).
    const slugs = [...new Set(_seedRows.flatMap((r) => (r.players || []).map((p) => p.startggSlug).filter(Boolean)))];
    if (slugs.length) {
      seedAutoNote('Reading each player\'s start.gg tournament history…');
      seedStatus(`Auto-seed — start.gg history for ${slugs.length} players…`);
      try {
        const res = await fetch('http://localhost:3000/api/startgg/player-standings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slugs }),
        });
        const data = await res.json();
        if (data && data.ok) _seedRows.forEach((row) => (row.players || []).forEach((p) => {
          p._startggScore = (p.startggSlug && data.scores[p.startggSlug] != null) ? data.scores[p.startggSlug] : null;
        }));
      } catch (_) {}
    }
    if (abort()) throw 'abort';

    seedComputePlacementScores();

    // 4 — ranks, for the WHOLE field.
    //
    // This used to run only over teams that placements could not speak for, which made sense when a
    // team with history was ordered purely by that history and "a rank never moves them". Under the
    // power rating roster skill is the BACKBONE of every team's number, so skipping the teams with
    // history left most of the field unresolved (the 45-of-137 case) and let those teams be rated on
    // a roster the engine had barely read.
    //
    // Cascade order is the producer's: whatever the CSV supplied is already in as manual estimates,
    // then rl6mans by gamertag, then tracker.gg for anyone rl6mans has never seen.
    const needRanks = _seedRows.filter((r) => (r.players || []).some((p) => !Number.isFinite(p.seedMMR)));
    if (_seedUse6mans && needRanks.length) {
      const n = needRanks.reduce((a, r) => a + (r.players || []).filter((p) => !Number.isFinite(p.seedMMR)).length, 0);
      seedAutoNote(`Looking up ${n} unresolved player${n !== 1 ? 's' : ''} — rl6mans first, then tracker.gg for anyone it has never seen…`);
      await seedLookupRanksFor(needRanks, { btn, abort, tracker: _seedUseTracker, label: 'Seed' });
    }
    if (abort()) throw 'abort';

    // Re-measure sheet honesty now that verified readings exist, so unverified CSV entries are
    // corrected before they reach the blend.
    seedCalibrateSelfReports();

    // 5 — order it. League points are refreshed onto the cards FIRST (seedApplyLeague re-sorts when a
    // league is selected), so the auto order is the last word either way.
    seedRecomputeValues();
    seedApplyLeague();
    const fitInfo = seedAutoScoreRows();
    _seedRows.sort(seedCmpAuto);
    _seedSortKey = 'auto';
    seedRender();

    _seedAutoStats = {
      placed: _seedRows.filter((r) => r.autoBasis === 'placements').length,
      ranked: _seedRows.filter((r) => r.autoBasis === 'ranks').length,
      none:   _seedRows.filter((r) => r.autoBasis === 'none').length,
      events: (oeData && oeData.eventsScored) || 0,
      fitted: fitInfo.fitted > 0,
    };
    seedAutoBarRender();
    seedStatus(_seedAutoStats.placed
      ? `Auto-seeded ${_seedRows.length} teams. Review the order, drag anything you disagree with, then Save (and Push ↑ to write it back to start.gg).`
      : 'Auto-seed found no tournament history for this field. Add your finished events under My Events, or turn on 6mans ranks and re-seed.', _seedAutoStats.placed ? 'ok' : 'warn');
  } catch (e) {
    if (e === 'abort') {
      seedRecomputeValues(); seedRender();
      seedAutoNote('Auto-seed cancelled — kept everything resolved so far.', 'warn');
      seedStatus('Auto-seed cancelled.', 'warn');
    } else {
      console.error('[seed-auto-seed]', e);
      seedAutoNote('Auto-seed hit an error: ' + ((e && e.message) || e), 'warn');
      seedStatus('Auto-seed error: ' + ((e && e.message) || e), 'err');
    }
  } finally {
    _seedAutoRunning = false;
    if (btn) { btn.textContent = _seedRows.length ? 'Re-seed' : 'Auto-seed'; btn.classList.remove('btn-danger'); btn.classList.add('btn-primary'); }
  }
}

// ── Auto-resolve: confidence-weighted rank cascade (Advanced) ───────────────
// The per-PLAYER engine, now behind Advanced: auto-seed is the front door and only ranks the teams
// placements can't speak for, while this resolves a rank for every player in the field.
// Best-source-first: manual → our-events/leagues placement (local) → rl6mans verified (batched) →
// tracker.gg fallback → start.gg placement → placement→rank correlation → teammate average.
// Verified always overrides an unverified manual rank; placement never overrides manual.
let _autoResolveAbort = false;
const SEED_NUM_RANGE = { 'cs2': [5000, 30000] };

// Win% of a team from in-app league standings (our-events signal, team-level). null if <2 games.
function seedLeagueWinPct(teamName) {
  const key = (teamName || '').trim().toLowerCase(); if (!key) return null;
  for (const lg of (currentState.leagues || [])) {
    const team = (lg.teams || []).find((t) => (((t.teamName || t.name || '') + '').trim().toLowerCase()) === key);
    if (!team) continue;
    const st = (lg.standings || []).find((s) => s.teamId === team.id);
    if (!st) continue;
    const g = (st.w || 0) + (st.l || 0) + (st.t || 0);
    if (g < 2) return null;
    return Math.round((((st.w || 0) + 0.5 * (st.t || 0)) / g) * 1000) / 10;
  }
  return null;
}

// Apply an rl6mans match {rank(tier), elo} to a player. MMR-canonical → emit a sixmans estimate (blend);
// non-MMR → the legacy keep-highest tier apply.
function seedApplySixmans(p, match, conf, detail) {
  const SRC = window.SeedResolveCore; if (!SRC || !match) return false;
  if (seedIsMMR()) {
    const est = seedEst6mans({ found: true, rank: match.rank, elo: match.elo || 0 }, conf, detail);
    return est ? seedApplyEstimate(p, est) : false;
  }
  const mode = seedMode();
  const tierVal = (match.rank && match.rank !== 'Unranked') ? seedRankValue(match.rank, _seedMode) : null;
  let rank, rankValue;
  if (mode.kind === 'num') {
    if (match.elo > 0) { rank = String(match.elo); rankValue = match.elo; }
    else if (tierVal != null) { rank = match.rank; rankValue = tierVal; }
    else return false;
  } else {
    const maxV = (mode.tiers ? mode.tiers.length : 9) * 10 + (mode.nodiv ? 0 : 9);
    if (tierVal == null || tierVal > maxV) return false;
    rank = match.rank; rankValue = tierVal;
  }
  const applied = seedResolveApply(p, { source: 'sixmans', confidence: conf, rank, rankValue, detail });
  if (applied && match.elo) p.elo = match.elo;
  return applied;
}

async function seedAutoResolve() {
  const SRC = window.SeedResolveCore;
  const btn = el('seed-auto-resolve');
  if (!SRC) { seedStatus('Resolver core not loaded — reload the panel.', 'err'); return; }
  if (btn && btn.dataset.running === '1') { _autoResolveAbort = true; return; }   // click again = cancel
  if (!_seedRows.length) { seedStatus('No teams to resolve — pull a roster first.', 'err'); return; }
  _autoResolveAbort = false;
  if (btn) { btn.dataset.running = '1'; btn.textContent = 'Cancel'; btn.classList.add('btn-danger'); }
  _seedReviewOnly = false;   // a fresh run re-evaluates the whole field; don't leave a stale filter on
  const mode = seedMode();
  const numRange = SEED_NUM_RANGE[_seedMode];
  const abort = () => _autoResolveAbort;
  try {
    // Pass 0 — seed existing hand/CSV ranks. MMR: ensure every rank is an estimate. Non-MMR: tag manual.
    if (seedIsMMR()) seedMigrateAllEstimates();
    else _seedRows.forEach((r) => (r.players || []).forEach((p) => {
      if (!p.source && p.rank && p.rank.trim()) { seedTagSource(p, 'manual', 60, 'Entered manually'); p.rankValue = seedRankValue(p.rank, _seedMode); }
    }));

    // Pass A — our-events placement history (start.gg standings of our past events, cached locally).
    seedStatus('Auto-resolve — our-events placements…');
    try { await seedApplyOurEvents(); } catch (_) {}
    if (abort()) throw 'abort';

    // Pass B — in-app league standings (local), then a combined team placement score. Same formula
    // auto-seed uses, so the two engines can never drift apart on what a placement is worth.
    seedComputePlacementScores();

    // Pass C — rl6mans verified (registry prefill + batched profile lookups), then the tracker.gg
    // fallback for whoever rl6mans couldn't verify, across the whole board. Shared with auto-seed,
    // which runs the same pass over just the history-less teams.
    const wantTracker = el('seed-resolve-tracker') ? el('seed-resolve-tracker').checked : true;
    await seedLookupRanksFor(_seedRows, { btn, abort, tracker: wantTracker, label: 'Auto-resolve' });
    if (abort()) throw 'abort';

    // Pass D — start.gg per-player placement (1 request; keep per-player, not team-averaged).
    const slugs = [...new Set(_seedRows.flatMap((r) => (r.players || []).map((p) => p.startggSlug).filter(Boolean)))];
    if (slugs.length) {
      seedStatus('Auto-resolve — start.gg placements…');
      if (btn) btn.textContent = 'Cancel · start.gg';
      try {
        const res = await fetch('http://localhost:3000/api/startgg/player-standings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slugs }) });
        const data = await res.json();
        if (data && data.ok) _seedRows.forEach((row) => (row.players || []).forEach((p) => { p._startggScore = (p.startggSlug && data.scores[p.startggSlug] != null) ? data.scores[p.startggSlug] : null; }));
      } catch (_) {}
      seedComputePlacementScores();   // fold the start.gg history into the team placement score/badge
    }
    if (abort()) throw 'abort';

    // Pass E — placement→value correlation, calibrated from this event's resolved players.
    const seedVal = (p) => seedIsMMR() ? p.seedMMR : p.rankValue;   // the value anchors/blend use
    const anchorsOE = [], anchorsSG = [];
    _seedRows.forEach((row) => (row.players || []).forEach((p) => {
      const v = seedVal(p);
      if ((p.confidence || 0) >= 60 && Number.isFinite(v)) {
        if (row._teamScore != null) anchorsOE.push({ score: row._teamScore, rankValue: v });
        if (p._startggScore != null) anchorsSG.push({ score: p._startggScore, rankValue: v });
      }
    }));
    const fitOE = SRC.fitCalibration(anchorsOE), fitSG = SRC.fitCalibration(anchorsSG);
    if (seedIsMMR()) {
      // Blend model: placement estimates ALWAYS contribute (weighted low) — no "fill only" gate.
      const mmrRange = mode.mmrRange || [100, 1600];
      _seedRows.forEach((row) => (row.players || []).forEach((p) => {
        if (row._teamScore != null) { const c = SRC.correlateMMR(row._teamScore, fitOE, mmrRange); if (c) seedApplyEstimate(p, { source: 'ourEvents', mmr: c.mmr, confidence: SRC.sourceConfidence('ourEvents', c.r2, c.inRange), detail: `our-events ${Math.round(row._teamScore)}%` }); }
        if (p._startggScore != null) { const c = SRC.correlateMMR(p._startggScore, fitSG, mmrRange); if (c) seedApplyEstimate(p, { source: 'startgg', mmr: c.mmr, confidence: SRC.sourceConfidence('startgg', c.r2, c.inRange), detail: `start.gg ${Math.round(p._startggScore)}` }); }
      }));
    } else {
      _seedRows.forEach((row) => (row.players || []).forEach((p) => {
        if ((p.confidence || 0) > 0) return;
        if (row._teamScore != null) { const c = SRC.correlate(row._teamScore, mode, fitOE, { numRange }); if (c) seedResolveApply(p, { source: 'ourEvents', confidence: SRC.sourceConfidence('ourEvents', c.r2, c.inRange), rank: c.rank, rankValue: c.rankValue, detail: `our-events ${Math.round(row._teamScore)}% → ${c.rank}` }); }
        if ((p.confidence || 0) === 0 && p._startggScore != null) { const c = SRC.correlate(p._startggScore, mode, fitSG, { numRange }); if (c) seedResolveApply(p, { source: 'startgg', confidence: SRC.sourceConfidence('startgg', c.r2, c.inRange), rank: c.rank, rankValue: c.rankValue, detail: `start.gg ${Math.round(p._startggScore)} → ${c.rank}` }); }
      }));
    }

    // Pass F — teammate average for anyone STILL with no reading at all.
    _seedRows.forEach((row) => {
      const resolved = (row.players || []).filter((p) => Number.isFinite(seedVal(p)));
      if (!resolved.length) return;
      const avg = resolved.reduce((s, p) => s + seedVal(p), 0) / resolved.length;
      (row.players || []).forEach((p) => {
        if (seedIsMMR()) { if (!(p.estimates && p.estimates.length)) seedApplyEstimate(p, { source: 'teammate', mmr: Math.round(avg), confidence: 15, detail: `avg of ${resolved.length} teammate(s)` }); }
        else if ((p.confidence || 0) === 0) { const snap = SRC.snapRankValue(avg, mode); if (snap) seedResolveApply(p, { source: 'teammate', confidence: 15, rank: snap.rank, rankValue: snap.rankValue, detail: `avg of ${resolved.length} teammate(s)` }); }
      });
    });

    seedRecomputeValues();
    seedAutoScoreRows();   // refresh the basis chips; the order still comes from the rank sort below
    seedSort('rank');
    seedRender();
    if (_seedTab === 'unverified') seedRenderUnverified();
    const c = seedReviewCounts();
    seedStatus(c.flagged
      ? `Resolved ${c.clean + c.flagged}/${c.total} players — ${c.flagged} need a decision. Hit "Show only needs-review" in step 3, then type a rank on any of them to override it.`
      : `Resolved all ${c.total} players confidently${c.overridden ? ` (${c.overridden} were already your call)` : ''}. Click "why" on any player to see how. Save when you're happy.`, 'ok');
  } catch (e) {
    if (e === 'abort') { seedRecomputeValues(); seedSort('rank'); seedRender(); seedStatus('Auto-resolve cancelled — kept everything resolved so far.', 'warn'); }
    else { console.error('[seed-auto-resolve]', e); seedStatus('Auto-resolve error: ' + (e && e.message || e), 'err'); }
  } finally {
    if (btn) { btn.dataset.running = ''; btn.textContent = 'Resolve all ranks'; btn.classList.remove('btn-danger'); }
  }
}

function seedCopyList() {
  const text = _seedRows.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
  if (navigator.clipboard) navigator.clipboard.writeText(text);
  seedStatus('Copied the ordered seed list to clipboard.', 'ok');
}
function seedSave() {
  if (!_seedEvent) return;
  // Persist BOTH the seeded board and the parked Incomplete rosters (board first so its order is kept
  // on reload; seedApplyPartition re-derives the buckets from player counts when the studio reopens).
  const entrants = seedAllRows().map((r) => ({
    entrantId: r.entrantId || '', name: r.name || '', seedNum: r.seedNum || null,
    // What auto-seed stood this team on — so a reopened board still explains its own order.
    autoBasis: r.autoBasis || null, placementScore: Number.isFinite(r.placementScore) ? r.placementScore : null,
    players: (r.players || []).map((p) => ({
      gamerTag: p.gamerTag || '', rank: p.rank || '',
      epic: p.epic || '', steam: p.steam || '', alts: Array.isArray(p.alts) ? p.alts : [],
      startggSlug: p.startggSlug || null, startggPlayerId: p.startggPlayerId || null,
      // resolution provenance — so a saved board reopens with its source + confidence chips intact
      source: p.source || '', confidence: p.confidence || 0, sourceDetail: p.sourceDetail || '', elo: p.elo || null,
      // MMR-canonical seed value + the per-source estimates that blended into it (so a reopened board
      // reproduces the exact seed + chips without re-running lookups).
      seedMMR: (typeof p.seedMMR === 'number') ? p.seedMMR : null,
      estimates: Array.isArray(p.estimates) ? p.estimates.map((e) => ({ source: e.source, mmr: e.mmr, confidence: e.confidence, tier: e.tier || null, exactElo: e.exactElo || null, detail: e.detail || '' })) : null,
      // The producer's own call. Persisted separately from the estimates so it survives a re-pull and
      // re-resolve — it's a decision, not a reading.
      override: seedIsOverridden(p) ? { tier: p.override.tier || '', mmr: Number.isFinite(p.override.mmr) ? p.override.mmr : null, rankValue: Number.isFinite(p.override.rankValue) ? p.override.rankValue : null, at: p.override.at || null } : null,
    })),
  }));
  send('set_event_seeding', { id: _seedEvent.id, source: _seedEvent.seeding?.source || 'startgg', rankMode: _seedMode, agg: _seedAgg, teamSize: _seedTeamSize, startggRosterSize: (_seedEvent.rosterSize || 0), entrants });
  seedStatus(`Saved · ${entrants.length} teams · ${seedMode().label} · ${seedAggLabel()}.`, 'ok');
}
async function seedPushStartgg() {
  if (!_seedEvent) return;
  if (!_seedEvent.eventSlug) { seedStatus('No start.gg event linked — activate the event first.', 'err'); return; }
  if (!currentState.startgg?.hasToken) { seedStatus('Add a start.gg TO/admin API token in Settings → Integrations to push seeds.', 'err'); return; }
  const order = _seedRows.map((r) => r.entrantId).filter(Boolean);
  const withoutId = _seedRows.filter((r) => !r.entrantId).length;
  if (!order.length) { seedStatus('No start.gg entrant IDs found — pull the roster from start.gg first, then import CSV ranks.', 'err'); return; }
  if (withoutId > 0) seedStatus(`Note: ${withoutId} CSV-only team(s) have no start.gg ID and will be skipped.`);
  if (!await appConfirm(`Push seed order for ${order.length} team${order.length !== 1 ? 's' : ''} to start.gg?\n\nThis overwrites the current seeding on "${_seedEvent.name || _seedEvent.eventSlug}".`, 'Push to start.gg')) return;
  const btn = el('seed-push'); if (btn) { btn.disabled = true; btn.textContent = 'Pushing…'; }
  seedStatus(`Exporting ${order.length} seeds to start.gg…`);
  try {
    const r = await fetch('http://localhost:3000/api/startgg/push-seeding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventSlug: _seedEvent.eventSlug, order }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `start.gg returned HTTP ${r.status}`);
    if (data.pushed < data.total) throw new Error(`Partial export: only ${data.pushed}/${data.total} seeds saved on "${data.phase}". Check your TO token permissions.`);
    seedSave();
    seedStatus(`✓ Exported ${data.pushed}/${data.total} seeds to start.gg phase "${data.phase}" — seeding saved locally.`, 'ok');
  } catch (e) {
    const msg = e.message || 'Export failed';
    seedStatus(`Export failed — ${msg}`, 'err');
    console.error('[push-seeding]', e);
  }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Push to start.gg'; } }
}
// Strip common tag decorations for fuzzy matching:
// "G2 | Jstn." → "jstn.",  "Player#1234" → "player"
function normTag(s) {
  return (s || '').toString()
    .replace(/^[^|#]*[|]\s*/, '')    // strip "Team | " prefix
    .replace(/\s*[#]\w+$/, '')        // strip "#1234" suffix
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Show the CSV column-mapping modal. Parses headers, pre-fills from saved event mapping or
// auto-detection, then waits for seedCsvConfirm() before running the actual import.
function seedImportCsv(text) {
  const rows = csvParse(text);
  if (!rows.length) { seedStatus('Empty or unreadable CSV.', 'err'); return; }
  _pendingCsvRows = rows;

  const rawHeaders = rows[0].map((h, i) => ({ label: (h || '').toString().trim() || `Col ${i + 1}`, idx: i }));
  const hdr = rawHeaders.map((h) => h.label.toLowerCase());
  const findCol = (...keys) => hdr.findIndex((h) => keys.some((k) => h.includes(k)));

  // Auto-detect — 'id' intentionally excluded (too broad, matches numeric ID columns)
  const autoTeam  = findCol('team', 'entrant', 'squad', 'org', 'group');
  const autoGamer = findCol('gamertag', 'gamer tag', 'gamer_tag', 'player', 'tag',
                             'username', 'handle', 'discord', 'epic', 'steam', 'rocket', 'rl');
  const autoRank  = findCol('rank', 'mmr', 'elo', 'rating', 'mr', 'tier', 'division', 'score', 'pts', 'point');

  // Load saved mapping keyed by event ID/slug
  const mapKey = `ne_seed_csv_map_${(_seedEvent && (_seedEvent.id || _seedEvent.slug)) || 'global'}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(mapKey) || '{}'); } catch { /* */ }

  const teamSel  = el('seed-csv-col-team');
  const gamerSel = el('seed-csv-col-gamer');
  const rankSel  = el('seed-csv-col-rank');
  if (!gamerSel || !rankSel) return;

  const buildOptions = (sel, preferred) => {
    sel.innerHTML = '<option value="-1">— not in CSV / skip —</option>';
    rawHeaders.forEach((h) => {
      const opt = document.createElement('option');
      opt.value = h.idx;
      const sample = rows.length > 1 ? (rows[1][h.idx] || '').toString().trim() : '';
      opt.textContent = `${h.label}${sample ? `  —  e.g. "${sample}"` : ''}`;
      sel.appendChild(opt);
    });
    sel.value = preferred >= 0 ? preferred : -1;
  };

  if (teamSel) buildOptions(teamSel,  saved.team  != null ? saved.team  : autoTeam);
  buildOptions(gamerSel, saved.gamer != null ? saved.gamer : autoGamer);
  buildOptions(rankSel,  saved.rank  != null ? saved.rank  : autoRank);

  // Wire live preview to all three selects and run once immediately.
  [teamSel, gamerSel, rankSel].forEach((sel) => {
    if (!sel) return;
    sel.removeEventListener('change', seedCsvPreview);
    sel.addEventListener('change', seedCsvPreview);
  });

  el('seed-csv-modal')?.removeAttribute('hidden');
  seedCsvPreview();
}

// Render a live match preview inside the modal.
// Scans the full CSV, collects all matches, then samples 4 spread across the list so the
// preview shows a variety of players — not always the same first row.
function seedCsvPreview() {
  const esc = escHtml;
  const previewEl = el('seed-csv-preview');
  if (!previewEl || !_pendingCsvRows || _pendingCsvRows.length < 2) {
    if (previewEl) previewEl.className = 'seed-csv-prev-idle';
    return;
  }

  const teamCol  = parseInt(el('seed-csv-col-team')?.value  ?? '-1');
  const gamerCol = parseInt(el('seed-csv-col-gamer')?.value ?? '-1');
  const rankCol  = parseInt(el('seed-csv-col-rank')?.value  ?? '-1');
  const rows = _pendingCsvRows;

  // BUILD mode — no start.gg roster at all (board AND Incomplete empty); echo what the column
  // selections pick up from rows 2–4.
  if (seedAllRows().length === 0) {
    const samples = rows.slice(1, 4).map((r, ri) => {
      const parts = [
        teamCol  >= 0 ? esc((r[teamCol]  || '').toString().trim()) : null,
        gamerCol >= 0 ? `<b>${esc((r[gamerCol] || '').toString().trim())}</b>` : null,
        rankCol  >= 0 ? esc((r[rankCol]  || '').toString().trim()) : null,
      ].filter(Boolean);
      return parts.length ? `<div class="seed-csv-prev-entry-build">Row ${ri + 2}: ${parts.join(' · ')}</div>` : null;
    }).filter(Boolean);
    previewEl.className = 'seed-csv-prev-idle';
    previewEl.innerHTML = samples.length ? samples.join('') : 'Select at least one column to preview.';
    return;
  }

  // MERGE mode — build lookup (same logic as seedExecuteCsvImport; both buckets, see the note there).
  const byGamer = new Map();
  const byTeamGamer = new Map();
  seedAllRows().forEach((sggRow) => {
    const normTeam = sggRow.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    (sggRow.players || []).forEach((p) => {
      if (!p.gamerTag) return;
      const raw  = p.gamerTag.toLowerCase().trim();
      const norm = normTag(p.gamerTag);
      const bare = raw.replace(/[^a-z0-9]/g, '');
      byGamer.set(raw,  { player: p, team: sggRow });
      if (norm !== raw) byGamer.set(norm, { player: p, team: sggRow });
      if (bare && bare !== norm) byGamer.set(bare, { player: p, team: sggRow });
      byTeamGamer.set(`${normTeam}|${norm}`, { player: p, team: sggRow });
      if (bare) byTeamGamer.set(`${normTeam}|${bare}`, { player: p, team: sggRow });
    });
  });

  // Scan all rows, collect every match.
  const allMatches = [];
  let firstUnmatched = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawGamer = (gamerCol >= 0 ? r[gamerCol] : r[0] || '').toString().trim();
    const rawTeam  = teamCol >= 0 ? (r[teamCol] || '').toString().trim() : '';
    const rank     = rankCol >= 0 ? (r[rankCol] || '').toString().trim() : '';
    if (!rawGamer) continue;
    let result = null;
    if (rawTeam) {
      const nt = rawTeam.toLowerCase().replace(/[^a-z0-9]/g, '');
      result = byTeamGamer.get(`${nt}|${normTag(rawGamer)}`)
            || byTeamGamer.get(`${nt}|${rawGamer.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
    }
    result = result || byGamer.get(rawGamer.toLowerCase()) || byGamer.get(normTag(rawGamer))
                    || byGamer.get(rawGamer.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (result) {
      allMatches.push({ result, csv: { rawGamer, rawTeam, rank }, rowIdx: i + 1 });
    } else if (!firstUnmatched) {
      firstUnmatched = { rawGamer, rawTeam, rank };
    }
  }

  if (allMatches.length === 0) {
    // No matches at all — show a comparison so the user understands the mismatch.
    const sggSample = seedAllRows().flatMap((r) => (r.players || []).map((p) => p.gamerTag)).slice(0, 3).join(', ');
    previewEl.className = 'seed-csv-prev seed-csv-prev-warn';
    previewEl.innerHTML = `
      <span class="seed-csv-prev-lbl">✗ No matches — check column selection</span>
      <div class="seed-csv-prev-rows">
        <div class="seed-csv-prev-row" style="grid-template-columns:68px 1fr">
          <span class="seed-csv-prev-field">CSV has</span>
          <span class="seed-csv-prev-val">${firstUnmatched ? esc(firstUnmatched.rawGamer) : '—'}</span>
        </div>
        <div class="seed-csv-prev-row" style="grid-template-columns:68px 1fr">
          <span class="seed-csv-prev-field">start.gg</span>
          <span class="seed-csv-prev-sgg" style="opacity:.6">${esc(sggSample)}…</span>
        </div>
      </div>`;
    return;
  }

  // Sample up to 4 matches spread evenly across the full match list for variety.
  const n = allMatches.length;
  const idxs = n <= 4
    ? allMatches.map((_, i) => i)
    : [0, Math.floor(n * 0.33), Math.floor(n * 0.66), n - 1];
  const samples = [...new Set(idxs)].map((i) => allMatches[i]);
  const unmatched = rows.slice(1).filter((r) => r.some((x) => (x || '').toString().trim())).length - allMatches.length;

  // Render samples as an aligned table so all columns line up across rows.
  const isNoRank = (r) => !r || r.trim() === '' || r.trim().toUpperCase() === 'NA';

  const rowHtml = samples.map(({ result, csv, rowIdx }) => {
    // Gamertag cell: show CSV value dimmed → start.gg value green; omit arrow if identical.
    const csvGamer = esc(csv.rawGamer);
    const sggGamer = esc(result.player.gamerTag);
    const gamerCell = csv.rawGamer.toLowerCase() === result.player.gamerTag.toLowerCase()
      ? `<span class="pcell-sgg">${sggGamer}</span>`
      : `<span class="pcell-csv">${csvGamer}</span><span class="pcell-arr">→</span><span class="pcell-sgg">${sggGamer}</span>`;

    // Team cell: use CSV team col value; fall back to "TEAM | Player" prefix from gamertag.
    let csvTeam = csv.rawTeam;
    if (!csvTeam && csv.rawGamer.includes('|')) csvTeam = csv.rawGamer.split('|')[0].trim();
    const sggTeam = esc(result.team.name);
    const teamCell = csvTeam
      ? `<span class="pcell-csv">${esc(csvTeam)}</span><span class="pcell-arr">→</span><span class="pcell-sgg">${sggTeam}</span>`
      : `<span class="pcell-sgg">${sggTeam}</span>`;

    // Rank cell: blank/NA players were admin-accepted without registering a rank — show dash.
    const rankCell = isNoRank(csv.rank)
      ? `<span class="pcell-rank-none">—</span>`
      : `<span class="pcell-rank-badge">${esc(csv.rank.trim())}</span>`;

    return `<tr>
      <td class="pcol-row">${rowIdx}</td>
      <td class="pcol-gamer">${gamerCell}</td>
      <td class="pcol-team">${teamCell}</td>
      <td class="pcol-rank">${rankCell}</td>
    </tr>`;
  }).join('');

  const unmatchedNote = unmatched > 0
    ? `<div class="seed-csv-prev-unmatched">${unmatched} row${unmatched !== 1 ? 's' : ''} not matched — columns may differ for those players</div>`
    : '';

  previewEl.className = 'seed-csv-prev seed-csv-prev-ok';
  previewEl.innerHTML = `
    <span class="seed-csv-prev-lbl">✓ ${allMatches.length} match${allMatches.length !== 1 ? 'es' : ''} — ${samples.length} shown</span>
    <table class="seed-csv-prev-table">
      <thead><tr>
        <th class="pcol-row">#</th>
        <th class="pcol-gamer">Gamertag</th>
        <th class="pcol-team">Team</th>
        <th class="pcol-rank">Rank</th>
      </tr></thead>
      <tbody>${rowHtml}</tbody>
    </table>
    ${unmatchedNote}`;
}

// Called by the mapping modal's Import button.
function seedCsvConfirm() {
  const rows = _pendingCsvRows;
  if (!rows) return;
  _pendingCsvRows = null;

  const teamCol  = parseInt(el('seed-csv-col-team')?.value  ?? '-1');
  const gamerCol = parseInt(el('seed-csv-col-gamer')?.value ?? '-1');
  const rankCol  = parseInt(el('seed-csv-col-rank')?.value  ?? '-1');

  if (el('seed-csv-remember')?.checked !== false) {
    const mapKey = `ne_seed_csv_map_${(_seedEvent && (_seedEvent.id || _seedEvent.slug)) || 'global'}`;
    localStorage.setItem(mapKey, JSON.stringify({ team: teamCol, gamer: gamerCol, rank: rankCol }));
  }

  el('seed-csv-modal')?.setAttribute('hidden', '');
  seedExecuteCsvImport(rows, teamCol, gamerCol, rankCol);
}

// Core CSV import — runs after column mapping is confirmed.
// teamCol: CSV column index for the team/squad name (-1 = not provided)
function seedExecuteCsvImport(rows, teamCol, gamerCol, rankCol) {
  // ── MERGE MODE: roster already loaded from start.gg ─────────────────────
  // Gate and index on BOTH buckets: a team parked on Incomplete still takes ranks, so its players must
  // be matchable (otherwise their CSV rows come back as "not matched" and the ranks silently vanish).
  if (seedAllRows().length > 0) {
    if (rankCol < 0) { seedStatus('No rank column selected — re-import and pick one.', 'err'); return; }

    // byGamer: gamerTag → player (fuzzy fallback)
    const byGamer = new Map();
    // byTeamGamer: "normTeam|normGamer" → player (precise match when team col is set)
    const byTeamGamer = new Map();
    seedAllRows().forEach((row) => {
      const normTeam = row.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      (row.players || []).forEach((p) => {
        if (!p.gamerTag) return;
        const raw  = p.gamerTag.toLowerCase().trim();
        const norm = normTag(p.gamerTag);
        const bare = raw.replace(/[^a-z0-9]/g, '');
        byGamer.set(raw, p);
        if (norm !== raw) byGamer.set(norm, p);
        if (bare && bare !== norm && bare !== raw) byGamer.set(bare, p);
        // precise team+gamer key
        byTeamGamer.set(`${normTeam}|${norm}`, p);
        if (bare) byTeamGamer.set(`${normTeam}|${bare}`, p);
      });
    });

    let matched = 0;
    const notFound = [];
    rows.slice(1).forEach((r) => {
      const rawGamer = (gamerCol >= 0 ? r[gamerCol] : r[0] || '').toString().trim();
      const rank     = rankCol >= 0 ? (r[rankCol] || '').toString().trim() : '';
      if (!rawGamer) return;

      let p;
      // If team col is mapped, try precise team+gamer match first to avoid cross-team collisions.
      if (teamCol >= 0) {
        const rawTeam  = (r[teamCol] || '').toString().trim();
        const normTeam = rawTeam.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normGamer = normTag(rawGamer);
        const bareGamer = rawGamer.toLowerCase().replace(/[^a-z0-9]/g, '');
        p = byTeamGamer.get(`${normTeam}|${normGamer}`) || byTeamGamer.get(`${normTeam}|${bareGamer}`);
      }
      // Fall back to gamer-only fuzzy lookup
      p = p || byGamer.get(rawGamer.toLowerCase())
            || byGamer.get(normTag(rawGamer))
            || byGamer.get(rawGamer.toLowerCase().replace(/[^a-z0-9]/g, ''));

      if (p) {
        // Skip rank update for admin-accepted players who bypassed registration (blank or NA rank).
        if (rank && rank.toUpperCase() !== 'NA') {
          if (seedIsMMR()) { const est = seedEstManual(rank, 'CSV import'); if (est) seedApplyEstimate(p, est); }
          else { p.rank = rank; p.rankValue = seedRankValue(rank, _seedMode); seedTagSource(p, 'manual', 60, 'CSV import'); }
        }
        matched++;
      } else notFound.push(rawGamer);
    });
    seedRecomputeValues();
    seedSort('rank');

    if (notFound.length) {
      const csvSample = notFound.slice(0, 4).join(', ');
      const sggSample = seedAllRows().flatMap((r) => (r.players || []).map((p) => p.gamerTag)).slice(0, 3).join(', ');
      const all = matched === 0;
      const warn = all
        ? `All ${notFound.length} unmatched — wrong column? CSV: ${csvSample}. start.gg: ${sggSample}…`
        : `${notFound.length} not matched. CSV: ${csvSample}. start.gg: ${sggSample}…`;
      seedStatus(`${matched} rank${matched !== 1 ? 's' : ''} updated · ${warn}`, all ? 'err' : '');
    } else {
      seedStatus(`✓ CSV merged — all ${matched} player ranks updated. Sorted by avg team rank.`, 'ok');
    }
    return;
  }

  // ── BUILD MODE: no roster yet — construct teams from CSV ─────────────────
  const hdr = rows[0].map((h) => (h || '').toString().trim().toLowerCase());
  const findHdr = (...keys) => hdr.findIndex((h) => keys.some((k) => h.includes(k)));
  // In BUILD mode, team col from the mapper takes priority; fall back to auto-detect.
  const buildTeamCol = teamCol >= 0 ? teamCol : findHdr('team', 'entrant', 'squad', 'org');
  const nameCol = buildTeamCol >= 0 ? buildTeamCol : (gamerCol >= 0 ? gamerCol : 0);
  const byTeam  = new Map();
  let players = 0;
  rows.slice(1).forEach((r) => {
    const teamName = (r[nameCol] || '').toString().trim();
    if (!teamName) return;
    const gamer = gamerCol >= 0 ? (r[gamerCol] || '').toString().trim() : '';
    const rank  = rankCol  >= 0 ? (r[rankCol]  || '').toString().trim() : '';
    const key   = teamName.toLowerCase();
    if (!byTeam.has(key)) byTeam.set(key, { entrantId: '', name: teamName, seedNum: null, players: [], leaguePts: null });
    const t = byTeam.get(key);
    if (gamer && gamer.toLowerCase() !== key) { t.players.push({ gamerTag: gamer, rank, rankValue: null }); players++; }
    else if (rank && !t.players.length) { t.players.push({ gamerTag: teamName, rank, rankValue: null }); players++; }
  });
  seedApplyPartition([...byTeam.values()]);
  seedMigrateAllEstimates();   // turn CSV-built rank strings into manual MMR estimates
  seedRecomputeValues();
  seedSort('rank');
  seedStatus(`Built ${_seedRows.length} teams · ${players} players from CSV${rankCol >= 0 ? ' · sorted by avg team rank.' : '.'}`, rankCol >= 0 ? 'ok' : 'err');
}
function csvParse(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((x) => (x || '').toString().trim()));
}
el('seed-back')?.addEventListener('click', () => { seedShowStudio(false); renderSeedPicker(); });
// Relocate the seeding studio out of (legacy) My Events into its own Seeding tab host.
(function relocateSeedingStudio() {
  const studio = document.getElementById('seeding-studio'), host = document.getElementById('seed-studio-host');
  if (studio && host && studio.parentElement !== host) host.appendChild(studio);
})();
// ── Auto-seed bar wiring ────────────────────────────────────────────────────
// Advanced hides/shows the whole manual toolkit (sidebar + Verified/Unverified tabs). Off by
// default: the board arrives seeded, and most events never need anything under here.
const SEED_ADV_KEY = 'ne_seed_adv_v1';
let _seedAdvOpen = (() => { try { return localStorage.getItem(SEED_ADV_KEY) === '1'; } catch (_) { return false; } })();
function seedAdvApply() {
  const studio = el('seeding-studio');
  if (studio) studio.classList.toggle('seed-adv-off', !_seedAdvOpen);
  // Both ids drive the same state: the strip's Setup button is the current control, seed-adv-toggle
  // the one it replaced. Kept tolerant so neither markup version breaks the other.
  [el('seed-setup-btn'), el('seed-adv-toggle')].forEach((b) => b && b.classList.toggle('is-on', _seedAdvOpen));
  // Setup-only tabs must never be left showing when the panel is closed.
  if (!_seedAdvOpen && _seedTab !== 'verified') seedSwitchTab('verified');
}
function seedAdvToggle() {
  _seedAdvOpen = !_seedAdvOpen;
  try { localStorage.setItem(SEED_ADV_KEY, _seedAdvOpen ? '1' : '0'); } catch (_) {}
  seedAdvApply();
}

// ── Command strip ───────────────────────────────────────────────────────────
// The skill/results balance. This is the one setting that materially changes the order, so it sits
// on the strip rather than in Setup — a producer switching between a weekly and a championship
// needs it in reach, and needs to see the board move when they touch it.
const SEED_PRESET_KEY = 'ne_seed_preset_v1';
function seedLoadPreset() {
  try { const v = localStorage.getItem(SEED_PRESET_KEY); if (v && window.SeedPowerCore && SeedPowerCore.PRESETS[v]) _seedPreset = v; } catch (_) {}
  seedSyncPresetUI();
}
function seedSyncPresetUI() {
  el('seed-preset')?.querySelectorAll('.seed-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === _seedPreset);
  });
}
function seedSetPreset(p) {
  if (!window.SeedPowerCore || !SeedPowerCore.PRESETS[p] || p === _seedPreset) return;
  _seedPreset = p;
  try { localStorage.setItem(SEED_PRESET_KEY, p); } catch (_) {}
  seedSyncPresetUI();
  // Re-rate and re-order in place. No lookups, no network — the inputs are unchanged, only their
  // weighting is, so the board should move instantly.
  seedSort('auto');
  const W = SeedPowerCore.PRESETS[p];
  seedStatus(`${W.label} — results now move a team by up to ${Math.round((_seedPowerField ? _seedPowerField.cap : 0))} MMR off its roster skill.`, 'ok');
}

// The stage readout: what has been done to this field, and what is still missing. Replaces the six
// numbered sidebar steps — same information, one line, and it reports state instead of demanding
// clicks for stages that have nothing to do.
function seedRenderStages() {
  const box = el('seed-stages'); if (!box) return;
  const rows = seedAllRows();
  if (!rows.length) { box.innerHTML = ''; return; }
  const players = rows.flatMap((r) => r.players || []);
  const ranked = players.filter((p) => Number.isFinite(p.seedMMR) || p.rankValue != null).length;
  const idChecked = players.filter((p) => p.identity).length;
  const idNeed = _identResults.filter((r) => r.status === 'review').length;
  const noData = _seedRows.filter((r) => r.power == null).length;

  const stage = (label, value, kind, title) =>
    `<span class="seed-stage seed-stage-${kind}" title="${escHtml(title)}">${escHtml(label)} <b>${escHtml(value)}</b></span>`;

  const bits = [
    stage('Field', `${_seedRows.length}`, 'ok', 'Teams on the board. Incomplete rosters are parked on their own tab.'),
    !idChecked
      ? stage('Identity', 'not checked', 'idle', 'Players have not been matched against the registry yet. Until they are, ranks from unidentified players are discounted.')
      : idNeed
        ? stage('Identity', `${idNeed} to confirm`, 'warn', 'Some players could be more than one person. Open Setup to settle them.')
        : stage('Identity', 'clear', 'ok', 'Every player resolved to a known identity.'),
    stage('Ranks', `${ranked}/${players.length}`, ranked === players.length ? 'ok' : ranked ? 'warn' : 'idle',
      'Players with a usable rank from 6mans, tracker.gg, CSV or your own override.'),
    noData
      ? stage('Unrated', `${noData}`, 'warn', 'Teams with neither ranks nor event history. They sit at the bottom until one of the two exists.')
      : stage('Rated', `${_seedRows.length}`, 'ok', 'Every team has a power rating.'),
  ];
  box.innerHTML = bits.join('');
}

el('seed-preset')?.querySelectorAll('.seed-seg-btn').forEach((b) => {
  b.addEventListener('click', () => seedSetPreset(b.dataset.preset));
});
seedLoadPreset();

el('seed-adv-toggle')?.addEventListener('click', seedAdvToggle);
el('seed-setup-btn')?.addEventListener('click', seedAdvToggle);
el('seed-setup-close')?.addEventListener('click', seedAdvToggle);
el('seed-setup-backdrop')?.addEventListener('click', () => { if (_seedAdvOpen) seedAdvToggle(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _seedAdvOpen) seedAdvToggle(); });
// Re-seed uses the cached past-event standings (syncOurEventResults still pulls any event it has
// never seen). Advanced → "Local history" is the force-refresh when an event finishes mid-session.
el('seed-autoseed')?.addEventListener('click', () => seedAutoSeed());
el('seed-resolve-tracker')?.addEventListener('change', function () {
  _seedUseTracker = this.checked;
  seedSaveSignalPrefs();
  seedStatus(_seedUseTracker
    ? 'tracker.gg fallback on — players rl6mans has never seen get looked up there instead of going unranked.'
    : 'tracker.gg fallback off — faster, but players missing from rl6mans will have no rank.', 'ok');
});
seedLoadSignalPrefs();
seedAdvApply();

el('seed-load-startgg')?.addEventListener('click', seedLoadStartgg);
el('seed-league')?.addEventListener('change', seedApplyLeague);
el('seed-local-btn')?.addEventListener('click', seedFetchLocalScores);
el('seed-score-btn')?.addEventListener('click', seedFetchPerformanceScores);
el('seed-auto-resolve')?.addEventListener('click', seedAutoResolve);
el('seed-sort-perf')?.addEventListener('click', seedSortByPerfScore);
// Sort buttons share a handler via data-sort; the active one is highlighted by seedOrderLabel().
document.querySelectorAll('.seed-sortbtn').forEach((b) => b.addEventListener('click', () => seedSort(b.dataset.sort)));
// Rank system + team-rank aggregation re-derive values and re-apply the current order.
el('seed-rankmode')?.addEventListener('change', function () {
  _seedMode = this.value; seedRecomputeValues();
  seedSort('rank');
  seedStatus(`Rank system: ${seedMode().label} — sorted by rank.`);
});
el('seed-aggmethod')?.addEventListener('change', function () {
  _seedAgg = this.value; seedRecomputeValues();
  seedSort('rank');
  seedStatus(`Team rank = ${seedAggLabel()} — sorted by rank.`);
});
// Team size re-partitions the board against the new expectation — teams that were parked on Incomplete
// only because the game's default format was bigger than this event's flow straight back onto the board.
el('seed-teamsize')?.addEventListener('change', function () {
  const n = parseInt(this.value || '0', 10);
  _seedTeamSize = (n > 0 && n <= 7) ? n : 0;
  seedApplyPartition(seedAllRows());
  seedRecomputeValues();
  if (_seedLeagueId) seedApplyLeague();
  seedSort(_seedSortKey);
  const size = seedRosterSize();
  seedStatus(`Team size ${size} — ${_seedRows.length} team(s) on the board, ${_seedIncomplete.length} parked on Incomplete.`, 'ok');
});
el('seed-calibrate-ladder')?.addEventListener('click', () => seedLoadTierLadder(true));
// Review controls — the manual-oversight pass over whatever automation wasn't sure about.
el('seed-review-toggle')?.addEventListener('click', () => {
  _seedReviewOnly = !_seedReviewOnly;
  seedRender();
  const c = seedReviewCounts();
  seedStatus(_seedReviewOnly
    ? `Showing only the ${c.flagged} player(s) that need a decision. Type a rank on any of them to override it.`
    : 'Showing the full board.');
});
el('seed-review-threshold')?.addEventListener('change', function () {
  _seedReviewThreshold = parseInt(this.value, 10) || 70;
  seedRender();
  const c = seedReviewCounts();
  seedStatus(`Flagging anything under ${_seedReviewThreshold > 100 ? 'a verified reading' : _seedReviewThreshold + '%'} — ${c.flagged} player(s) need review.`);
});
// Open every flagged player's why-panel at once so the whole review can be audited in one scroll.
el('seed-review-expand')?.addEventListener('click', () => {
  const before = _seedWhyOpen.size;
  _seedRows.forEach((r, ti) => (r.players || []).forEach((p, pi) => { if (seedNeedsReview(p)) _seedWhyOpen.add(seedWhyKey(ti, pi)); }));
  if (_seedWhyOpen.size === before && before > 0) _seedWhyOpen.clear();   // second click collapses
  seedRender();
  seedStatus(_seedWhyOpen.size ? `Explained ${_seedWhyOpen.size} flagged player(s) — click "Explain all flagged" again to collapse.` : 'Collapsed all explanations.');
});
el('seed-copy')?.addEventListener('click', seedCopyList);
el('seed-save')?.addEventListener('click', seedSave);
el('seed-push')?.addEventListener('click', seedPushStartgg);
el('seed-tab-verified')?.addEventListener('click', () => seedSwitchTab('verified'));
el('seed-tab-unverified')?.addEventListener('click', () => seedSwitchTab('unverified'));
el('seed-tab-incomplete')?.addEventListener('click', () => seedSwitchTab('incomplete'));

// Unverified tab controls.
document.querySelectorAll('.seed-unv-sortbtn').forEach((b) => b.addEventListener('click', () => {
  _seedUnvSort = b.dataset.unvsort; seedRenderUnverified();
}));
el('seed-unv-showall-btn')?.addEventListener('click', () => {
  _seedUnvShowAll = !_seedUnvShowAll; seedRenderUnverified();
});
// #seed-unv-lookup-all click is wired inside seedRenderUnverified() to stay in sync with the current row set.
el('seed-import-csv')?.addEventListener('click', () => el('seed-csv-file')?.click());
el('seed-csv-file')?.addEventListener('change', function () {
  const f = this.files && this.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => seedImportCsv(reader.result || '');
  reader.readAsText(f);
  this.value = '';
});

// ── 6mans rank verification ───────────────────────────────────────────────
// State for the verify modal: pending changes the user can accept/reject.
let _verifyPending = [];   // [{ player, currentRank, webRank, webElo, match, confidence }]
let _verifyTab = 'corrected';
let _verifyExpectedRegion = '';   // event region, for the same-name-different-region guard

// Show the rank EXACTLY as rl6mans.com does (H, S, A, B+, C, D, E…) — only un-normalise
// the BPLUS slug back to "B+". (An earlier H→S+ translation was wrong: the site labels
// the rank literally, e.g. "Rank H" at 1070 ELO.)
function rl6mansRankLabel(slug) {
  if (!slug) return '';
  return String(slug).toUpperCase().replace('BPLUS', 'B+');
}

// Find a player object in _seedRows by gamertag (case-insensitive)
function findSeedPlayerByTag(gamerTag) {
  const t = (gamerTag || '').toLowerCase();
  for (const row of _seedRows) {
    for (const p of (row.players || [])) {
      if ((p.gamerTag || '').toLowerCase() === t) return p;
    }
  }
  return null;
}

async function seedVerify6mans() {
  const btn = el('seed-verify-6mans');
  const region = el('seed-6mans-region')?.value || 'NA';

  // Send each player as { name: gamertag, alts: [Epic, …connected accounts] } so the
  // backend matches on the strong Epic identity first, then the gamertag/variants.
  const allPlayers = _seedRows
    .flatMap((r) => (r.players || []).map((p) => ({ name: p.gamerTag, alts: [p.epic, ...(p.alts || [])].filter(Boolean) })))
    .filter((x) => x.name);
  if (!allPlayers.length) { seedStatus('No players to verify — pull start.gg roster first.', 'err'); return; }
  const withEpic = allPlayers.filter((p) => p.alts.length).length;

  // Pre-fill from the player registry for anyone already verified — skip the network for them.
  const registryProfiles = currentState.playerProfiles || {};
  const preKnown = [];
  const needLookup = [];
  for (const p of allPlayers) {
    const reg = registryProfiles[(p.name || '').trim().toLowerCase()];
    if (reg && reg.sixmans && reg.sixmans.name && reg.sixmans.rank) {
      const s = reg.sixmans;
      preKnown.push({ input: p.name, match: { name: s.name, rank: s.rank, elo: s.elo || 0, region: s.region || '', platform: '' }, confidence: 'exact', distance: 0, candidates: [], totalIndexed: 0, source: 'registry' });
    } else {
      needLookup.push(p);
    }
  }

  if (btn) { btn.disabled = true; btn.textContent = needLookup.length ? 'Looking up…' : 'Loading…'; }

  // Look up in batches so we can show live progress and avoid one long hanging
  // request. Each batch does direct profile lookups only (fast); the slow
  // leaderboard index is never built here.
  const BATCH = 12;
  const total = needLookup.length;
  const results = [...preKnown];
  let failed = 0;
  try {
    for (let i = 0; i < total; i += BATCH) {
      const chunk = needLookup.slice(i, i + BATCH);
      const soFar = preKnown.length + Math.min(i + BATCH, total);
      seedStatus(`Looking up ranks — ${soFar} / ${allPlayers.length}${withEpic ? ` (${withEpic} via Epic)` : ''}…`, '');
      if (btn) btn.textContent = `${soFar}/${allPlayers.length}…`;
      try {
        const res = await fetch('http://localhost:3000/api/rl6mans/lookup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: chunk, region, profilesOnly: true }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Lookup failed');
        results.push(...data.results);
      } catch (e) {
        failed += chunk.length;
        chunk.forEach((p) => results.push({ input: p.name, match: null, confidence: 'none', candidates: [] }));
      }
    }
    const matched = results.filter((r) => r.confidence === 'exact').length;
    const cached = preKnown.length ? ` (${preKnown.length} from registry)` : '';
    const unmatched = allPlayers.length - matched;
    const tgHint = unmatched ? ` · ${unmatched} unmatched — open the Unverified tab and click “Lookup All” to try tracker.gg via their start.gg Epic/Steam.` : '';
    seedStatus(`Looked up ${allPlayers.length} players — ${matched} matched${cached}${failed ? `, ${failed} errored` : ''}.${tgHint}`, failed ? 'err' : 'ok');
    openVerifyModal(results, region);
  } catch (err) {
    seedStatus(`6mans lookup failed: ${err.message}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Verify ranks'; }
  }
}

function openVerifyModal(results, expectedRegion) {
  _verifyPending = [];
  const totalIndexed = results[0]?.totalIndexed || 0;
  // 'ALL' (international) → no single expected region, so don't flag region mismatches.
  const expReg = (!expectedRegion || expectedRegion === 'ALL') ? '' : expectedRegion.toUpperCase();
  _verifyExpectedRegion = expReg;

  results.forEach((r) => {
    if (r.confidence === 'none') return;
    const player = findSeedPlayerByTag(r.input);
    if (!player) return;
    const webRank = rl6mansRankLabel(r.match.rank);
    const webRegion = (r.match.region || '').toUpperCase();
    // Same-name-different-player guard: a matched profile whose region isn't the
    // event's expected region is likely a different account → needs review.
    const regionMismatch = !!(expReg && webRegion && webRegion !== expReg);
    const csv = (player.rank || '').trim().toUpperCase();
    _verifyPending.push({
      player,
      inputName: r.input,
      matchName: r.match.name,
      currentRank: player.rank || '',
      webRank,
      webElo: r.match.elo || 0,
      webRegion,
      webPlatform: (r.match.platform || '').toUpperCase(),
      regionMismatch,
      confidence: r.confidence,
      distance: r.distance,
      accepted: false,
      category: (csv === 'NA' || csv === 'N/A' || !csv) ? 'found'
              : (webRank && csv !== webRank) ? 'corrected'
              : 'confirmed',
    });
  });

  // Not-found: store with candidates for manual matching
  const notFoundEntries = results
    .filter((r) => r.confidence === 'none')
    .map((r) => ({ inputName: r.input, candidates: r.candidates || [], player: findSeedPlayerByTag(r.input) }))
    .filter((e) => e.player);

  // Pre-accept "found"/"corrected" entries — but NOT region mismatches, which the
  // producer must consciously confirm (likely a same-name different-region account).
  _verifyPending.forEach((p) => { if (p.category !== 'confirmed' && !p.regionMismatch) p.accepted = true; });

  renderVerifyModal(notFoundEntries, totalIndexed);
  el('seed-verify-modal')?.removeAttribute('hidden');
  // Auto-open the most actionable tab
  const firstNonEmpty = _verifyPending.some((p) => p.category === 'corrected') ? 'corrected'
                      : _verifyPending.some((p) => p.category === 'found') ? 'found'
                      : notFoundEntries.length ? 'notfound' : 'confirmed';
  svSwitchTab(firstNonEmpty);
}

function svSwitchTab(tab) {
  _verifyTab = tab;
  el('seed-verify-modal')?.querySelectorAll('.sv-tab-btn').forEach((b) => {
    const active = b.dataset.svtab === tab;
    b.classList.toggle('active', active);
    b.style.borderBottomColor = active ? 'var(--cp-accent)' : 'transparent';
    b.style.color = active ? 'var(--text)' : 'var(--muted)';
  });
  renderVerifyBody();
}

function renderVerifyModal(notFoundEntries, totalIndexed) {
  const corrected = _verifyPending.filter((p) => p.category === 'corrected');
  const found     = _verifyPending.filter((p) => p.category === 'found');
  const confirmed = _verifyPending.filter((p) => p.category === 'confirmed');

  const summary = el('seed-verify-summary');
  if (summary) summary.textContent =
    `${corrected.length} rank${corrected.length !== 1 ? 's' : ''} differ · ` +
    `${found.length} N/A filled · ` +
    `${confirmed.length} confirmed · ` +
    `${notFoundEntries.length} name mismatch — pick manually` +
    (totalIndexed ? ` (${totalIndexed} players indexed)` : '');

  el('seed-verify-modal').__notFoundEntries = notFoundEntries;
  renderVerifyBody();
}

// Populate a <datalist> of all rl6mans usernames for the region so the manual
// "exact name" input autocompletes — the producer can find the right account fast.
let _rl6mansNames = { region: null, names: [] };
async function ensureRl6mansNames(region) {
  region = (region || 'NA').toUpperCase();
  let dl = document.getElementById('sv-rl6mans-names');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'sv-rl6mans-names'; document.body.appendChild(dl); }
  // 'ALL' would scrape every region (~30-60s) just for autocomplete — skip it;
  // the manual exact-name lookup (direct profile) works without the datalist.
  if (region === 'ALL') return;
  if (_rl6mansNames.region === region && _rl6mansNames.names.length) return;
  try {
    const res = await fetch('http://localhost:3000/api/rl6mans/names?region=' + encodeURIComponent(region));
    const data = await res.json();
    if (data.ok && Array.isArray(data.names)) {
      _rl6mansNames = { region, names: data.names };
      dl.innerHTML = data.names.slice(0, 3000).map((n) => `<option value="${tlEsc(n)}"></option>`).join('');
    }
  } catch (e) { /* autocomplete is best-effort */ }
}

function renderVerifyBody() {
  const body = el('seed-verify-body'); if (!body) return;
  const notFoundEntries = el('seed-verify-modal')?.__notFoundEntries || [];

  if (_verifyTab === 'notfound') {
    ensureRl6mansNames(el('seed-6mans-region')?.value || _verifyExpectedRegion || 'NA');
    if (!notFoundEntries.length) {
      body.innerHTML = `<p style="padding:20px; text-align:center; color:var(--muted); font-size:12px;">All players matched automatically.</p>`;
      return;
    }
    // Show each unmatched player with top-3 candidates they can manually select
    const scanned = notFoundEntries.some((e) => (e.candidates || []).length);
    body.innerHTML = `<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; padding:10px 16px; border-bottom:1px solid var(--border);">
      <span style="font-size:11px; color:var(--muted);">These didn't match a profile directly. Scan the site to find the closest accounts, or enter the exact name.</span>
      <button class="btn btn-secondary btn-xs" id="sv-scan-remaining" title="Search rl6mans leaderboards for the closest match to each remaining player (builds a one-time index — international scans all regions and can take ~30-60s)">${scanned ? 'Re-scan site' : 'Scan site for remaining'}</button>
    </div>
    <div id="sv-scan-status" style="font-size:11px; color:var(--muted); padding:0 16px;"></div>` + notFoundEntries.map((e, ei) => {
      const cands = (e.candidates || []).slice(0, 3);
      const candidateHtml = cands.length
        ? cands.map((c, ci) => {
            const rankLabel = rl6mansRankLabel(c.rank);
            return `<button class="btn btn-ghost btn-xs sv-pick-cand" data-ei="${ei}" data-ci="${ci}"
              style="font-size:11px;" title="Use ${tlEsc(c.name)} (${tlEsc(rankLabel)}) for ${tlEsc(e.inputName)}">
              ${tlEsc(c.name)} · ${tlEsc(rankLabel)}${c.elo ? ' · ' + c.elo + ' ELO' : ''}
            </button>`;
          }).join('')
        : `<span style="color:var(--muted); font-size:11px;">No candidates</span>`;
      return `<div style="padding:10px 16px; border-bottom:1px solid var(--border);">
        <div style="font-size:12px; font-weight:600; margin-bottom:6px;">${tlEsc(e.inputName)}
          <a href="https://www.rl6mans.com/profile/${encodeURIComponent((e.inputName || '').toLowerCase())}" target="_blank" class="overlay-link" style="font-size:10px; font-weight:500;" title="Open this name's rl6mans profile">open profile &#8599;</a>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:6px;">
          <span style="font-size:10px; color:var(--muted); white-space:nowrap;">Closest on rl6mans:</span>
          ${candidateHtml}
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <span style="font-size:10px; color:var(--muted); white-space:nowrap;">Exact rl6mans name:</span>
          <input type="text" class="input-text sv-manual-name" list="sv-rl6mans-names" data-ei="${ei}" placeholder="search rl6mans username" style="font-size:11px; padding:4px 8px; width:180px;" value="${tlEsc(e.inputName)}">
          <button class="btn btn-secondary btn-xs sv-manual-lookup" data-ei="${ei}" style="font-size:11px;">Look up</button>
          <span class="sv-manual-result" data-ei="${ei}" style="font-size:10px; color:var(--muted);"></span>
        </div>
      </div>`;
    }).join('');

    // Opt-in site scan: build the rl6mans leaderboard index and surface the closest
    // candidates for the remaining players (the slow part — explicit, not automatic).
    body.querySelector('#sv-scan-remaining')?.addEventListener('click', async () => {
      const scanBtn = el('sv-scan-remaining'), status = el('sv-scan-status');
      const region = el('seed-6mans-region')?.value || 'NA';
      const names = notFoundEntries.map((e) => e.inputName).filter(Boolean);
      if (!names.length) return;
      scanBtn.disabled = true; scanBtn.textContent = 'Scanning…';
      if (status) status.textContent = region === 'ALL'
        ? 'Scanning all regions — first time builds a one-time index (~30-60s)…'
        : `Scanning the ${region} leaderboard…`;
      try {
        const res = await fetch('http://localhost:3000/api/rl6mans/lookup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: names.map((n) => ({ name: n, alts: [] })), region, profilesOnly: false }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Scan failed');
        const byInput = {};
        data.results.forEach((r) => { byInput[(r.input || '').toLowerCase()] = r; });
        let withCands = 0;
        notFoundEntries.forEach((e) => {
          const r = byInput[(e.inputName || '').toLowerCase()];
          if (r && r.candidates) { e.candidates = r.candidates; if (r.candidates.length) withCands++; }
        });
        renderVerifyBody();
        const st = el('sv-scan-status');
        if (st) st.textContent = `Found suggestions for ${withCands} / ${names.length} remaining players — pick or enter the exact name.`;
      } catch (err) {
        if (status) status.textContent = 'Scan failed: ' + err.message;
        scanBtn.disabled = false; scanBtn.textContent = 'Scan site for remaining';
      }
    });

    // Manual exact-name lookup → hits the rl6mans profile directly for exact ELO.
    body.querySelectorAll('.sv-manual-lookup').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ei = Number(btn.dataset.ei);
        const entry = notFoundEntries[ei];
        const inp = body.querySelector(`.sv-manual-name[data-ei="${ei}"]`);
        const out = body.querySelector(`.sv-manual-result[data-ei="${ei}"]`);
        const name = (inp?.value || '').trim();
        if (!entry || !name) return;
        btn.disabled = true; if (out) out.textContent = 'looking up…';
        try {
          const res = await fetch('http://localhost:3000/api/rl6mans/profile', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
          });
          const data = await res.json();
          if (!data.ok || !data.profile || !data.profile.found) { if (out) out.textContent = 'not found on rl6mans'; btn.disabled = false; return; }
          const prof = data.profile;
          const webRank = rl6mansRankLabel(prof.rank);
          const csv = (entry.player.rank || '').trim().toUpperCase();
          const webRegion = (prof.region || '').toUpperCase();
          const regionMismatch = !!(_verifyExpectedRegion && webRegion && webRegion !== _verifyExpectedRegion);
          _verifyPending.push({
            player: entry.player, inputName: entry.inputName, matchName: name,
            currentRank: entry.player.rank || '', webRank, webElo: prof.elo || 0,
            webRegion, webPlatform: (prof.platform || '').toUpperCase(), regionMismatch,
            confidence: 'manual', distance: 0, accepted: !regionMismatch,
            category: (csv === 'NA' || csv === 'N/A' || !csv) ? 'found' : 'corrected'
          });
          el('seed-verify-modal').__notFoundEntries = notFoundEntries.filter((_, i) => i !== ei);
          renderVerifyBody();
          updateAcceptCount();
        } catch (err) { if (out) out.textContent = 'lookup failed'; btn.disabled = false; }
      });
    });

    // Wire "pick candidate" buttons
    body.querySelectorAll('.sv-pick-cand').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ei = Number(btn.dataset.ei), ci = Number(btn.dataset.ci);
        const entry = notFoundEntries[ei];
        const cand  = (entry?.candidates || [])[ci];
        if (!entry || !cand) return;
        const webRank = rl6mansRankLabel(cand.rank);
        const csv = (entry.player.rank || '').trim().toUpperCase();
        const webRegion = (cand.region || '').toUpperCase();
        const regionMismatch = !!(_verifyExpectedRegion && webRegion && webRegion !== _verifyExpectedRegion);
        // Add to pending as a manual match
        _verifyPending.push({
          player: entry.player,
          inputName: entry.inputName,
          matchName: cand.name,
          currentRank: entry.player.rank || '',
          webRank,
          webElo: cand.elo || 0,
          webRegion,
          webPlatform: (cand.platform || '').toUpperCase(),
          regionMismatch,
          confidence: 'manual',
          distance: cand._distance || 0,
          accepted: !regionMismatch,
          category: (csv === 'NA' || csv === 'N/A' || !csv) ? 'found' : 'corrected',
        });
        // Remove from not-found
        el('seed-verify-modal').__notFoundEntries = notFoundEntries.filter((_, i) => i !== ei);
        renderVerifyBody();
        updateAcceptCount();
      });
    });
    return;
  }

  const rows = _verifyPending.filter((p) => p.category === _verifyTab);

  if (!rows.length) {
    body.innerHTML = `<p style="padding:20px; text-align:center; color:var(--muted); font-size:12px;">No entries in this category.</p>`;
    return;
  }

  body.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:12px;">
    <thead><tr style="border-bottom:1px solid var(--border);">
      <th style="padding:8px 16px; text-align:left; color:var(--muted); font-weight:600;">Player</th>
      <th style="padding:8px 8px; text-align:left; color:var(--muted); font-weight:600;">CSV Rank</th>
      <th style="padding:8px 8px; text-align:left; color:var(--muted); font-weight:600;">6mans Rank</th>
      ${_verifyTab !== 'confirmed' ? '<th style="padding:8px 16px; text-align:center; color:var(--muted); font-weight:600;">Accept</th>' : ''}
    </tr></thead>
    <tbody>${rows.map((p, i) => {
      const matchLabel = (p.confidence === 'fuzzy' || p.confidence === 'manual')
        ? ` <span style="color:var(--muted); font-size:10px;">(${p.confidence} → ${tlEsc(p.matchName)})</span>` : '';
      const eloLabel = p.webElo ? ` <span style="color:var(--muted);">${p.webElo} ELO</span>` : '';
      // Region/platform line — red ⚠ when the matched profile's region isn't the event's.
      const locLabel = (p.webRegion || p.webPlatform)
        ? (p.regionMismatch
            ? ` <span style="color:#f56565; font-weight:700;" title="Matched profile is ${tlEsc(p.webRegion)} but the event region differs — possibly a different player with the same name. Confirm before accepting.">&#9888; ${tlEsc(p.webRegion)}${p.webPlatform ? ' · ' + tlEsc(p.webPlatform) : ''}</span>`
            : ` <span style="color:var(--muted); font-size:10px;">${tlEsc(p.webRegion)}${p.webPlatform ? ' · ' + tlEsc(p.webPlatform) : ''}</span>`)
        : '';
      const csvCell = p.category === 'found'
        ? `<span style="color:#f56565;">N/A</span>`
        : `<span>${tlEsc(p.currentRank)}</span>`;
      const profileLink = p.matchName
        ? ` <a href="https://www.rl6mans.com/profile/${encodeURIComponent(p.matchName)}" target="_blank" class="overlay-link" title="Open ${tlEsc(p.matchName)} on rl6mans.com to confirm" style="font-size:10px;">${tlEsc(p.matchName)} &#8599;</a>` : '';
      const webCell = `<span style="color:#9ae6b4; font-weight:700;">${tlEsc(p.webRank)}</span>${eloLabel}${locLabel}${profileLink}`;
      const acceptCell = _verifyTab !== 'confirmed'
        ? `<td style="padding:8px 16px; text-align:center;">
             <input type="checkbox" class="sv-accept-chk" data-vi="${i}" ${p.accepted ? 'checked' : ''}>
           </td>` : '';
      return `<tr style="border-bottom:1px solid var(--border); ${p.regionMismatch ? 'background:rgba(245,101,101,.06);' : ''}" data-vi="${i}">
        <td style="padding:8px 16px;">${tlEsc(p.inputName)}${matchLabel}</td>
        <td style="padding:8px 8px;">${csvCell}</td>
        <td style="padding:8px 8px;">${webCell}</td>
        ${acceptCell}
      </tr>`;
    }).join('')}</tbody>
  </table>`;

  // Wire checkboxes
  body.querySelectorAll('.sv-accept-chk').forEach((chk) => {
    chk.addEventListener('change', () => {
      const vi = Number(chk.dataset.vi);
      const items = _verifyPending.filter((p) => p.category === _verifyTab);
      if (items[vi]) items[vi].accepted = chk.checked;
      updateAcceptCount();
    });
  });

  updateAcceptCount();
}

function updateAcceptCount() {
  const n = _verifyPending.filter((p) => p.accepted).length;
  const s = el('seed-verify-accept-count');
  if (s) s.textContent = n ? `${n} change${n !== 1 ? 's' : ''} selected` : '';
}

function applyVerifyChanges() {
  const accepted = _verifyPending.filter((p) => p.accepted && (p.webRank || p.webElo));
  if (!accepted.length) { seedStatus('No changes selected.', ''); return; }
  let applied = 0;

  // Feed each accepted match into the SAME estimate pipeline the cascade uses — no mode switch. On an
  // MMR board it becomes a sixmans estimate (exact ELO when present) that blends with the player's other
  // signals; on a legacy tier/num board it falls back to the old direct apply.
  accepted.forEach((p) => {
    p.player.elo = p.webElo || null;
    p.player.tier = p.webRank || '';
    if (seedIsMMR()) {
      seedApplySixmans(p.player, { rank: p.webRank, elo: p.webElo || 0 }, 98, 'rl6mans.com — verified' + (p.webElo > 0 ? ' · ' + p.webElo + ' ELO' : ''));
    } else if (p.webElo > 0) {
      p.player.rank = String(p.webElo); p.player.rankValue = p.webElo;
      seedTagSource(p.player, 'sixmans', 95, 'rl6mans.com — verified · ' + p.webElo + ' ELO');
    } else {
      p.player.rank = p.webRank; p.player.rankValue = seedRankValue(p.webRank, _seedMode);
      seedTagSource(p.player, 'sixmans', 95, 'rl6mans.com — verified');
    }
    applied++;
  });
  if (seedIsMMR()) seedCalibrateMidpoints();   // fold the newly-verified ELOs into the tier ladder

  // Persist the matched 6mans profiles into the registry (auto-links them everywhere).
  const profiles = accepted.filter((p) => p.matchName).map((p) => ({
    gamerTag: p.player.gamerTag,
    startggSlug: p.player.startggSlug || undefined,
    sixmans: { name: p.matchName, elo: p.webElo || null, rank: p.webRank || '', region: p.webRegion || '', platform: p.webPlatform || '' }
  })).filter((p) => p.gamerTag);
  if (profiles.length) {
    send('save_player_profiles', { profiles });
    // optimistic local update so the chips render immediately (before the broadcast returns)
    if (!currentState.playerProfiles) currentState.playerProfiles = {};
    profiles.forEach((p) => {
      const k = p.gamerTag.toLowerCase();
      const cur = currentState.playerProfiles[k] || {};
      currentState.playerProfiles[k] = { ...cur, gamerTag: p.gamerTag, startggSlug: p.startggSlug || cur.startggSlug, sixmans: p.sixmans };
    });
  }

  seedRecomputeValues();
  seedSort('rank');
  el('seed-verify-modal')?.setAttribute('hidden', '');
  seedStatus(`Applied ${applied} verified rank${applied !== 1 ? 's' : ''} from rl6mans.com — blended into each player's seed MMR.`, 'ok');
}

// Wire verify modal controls
el('seed-verify-6mans')?.addEventListener('click', seedVerify6mans);
el('seed-verify-close-btn')?.addEventListener('click', () => el('seed-verify-modal')?.setAttribute('hidden', ''));
el('seed-verify-apply')?.addEventListener('click', applyVerifyChanges);
el('seed-verify-accept-all')?.addEventListener('click', () => {
  _verifyPending.filter((p) => p.category !== 'confirmed').forEach((p) => { p.accepted = true; });
  renderVerifyBody();
});
el('seed-verify-modal')?.querySelectorAll('.sv-tab-btn').forEach((b) => {
  b.addEventListener('click', () => svSwitchTab(b.dataset.svtab));
});

// Wire the identity gate (step 2)
el('seed-identity-check')?.addEventListener('click', seedIdentityCheck);
el('seed-ident-close')?.addEventListener('click', closeIdentityModal);
el('seed-ident-apply')?.addEventListener('click', seedIdentityApply);
el('seed-ident-accept-all')?.addEventListener('click', seedIdentityAcceptAll);
el('seed-ident-modal')?.querySelectorAll('.si-tab-btn').forEach((b) => {
  b.addEventListener('click', () => siSwitchTab(b.dataset.sitab));
});
el('seed-identity-gate')?.addEventListener('change', function () {
  _identGate = this.checked;
  seedSaveIdentityPrefs();
  seedRecomputeValues();
  seedRender();
  seedStatus(_identGate
    ? 'Identity gate on — rank confidence is scaled by how sure we are who each player is.'
    : 'Identity gate off — every rank counts at face value regardless of who it belongs to.', _identGate ? 'ok' : 'warn');
});
seedLoadIdentityPrefs();

// ── Spotlight / "Teams to Watch" overlay builder ─────────────────────────────
let _wlSig = '';
let _wlDrag = -1;
let _wlTitleTimer = null;
let _wlSubTimer = null;
function wlState() { return (currentState && currentState.watchlist) || { title: 'TEAMS TO WATCH', logo: '', fields: [{ id: 'rank', label: 'CURRENT RANK' }], teams: [], visible: false }; }
function wlSend(patch) { send('set_watchlist', patch); }
const _wlEsc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// Read teams + per-field values out of the DOM (the source of truth while editing).
function wlCollectTeams() {
  const w = wlState(); const out = [];
  document.querySelectorAll('#wl-teams .wl-team-row').forEach((row) => {
    const t = (w.teams || []).find((x) => x.id === row.dataset.id) || { id: row.dataset.id, name: '', players: [] };
    const values = {};
    row.querySelectorAll('.wl-tv-input').forEach((inp) => { const v = inp.value.trim(); if (v) values[inp.dataset.fid] = v; });
    const ps = row.querySelector('.wl-pos');
    out.push({ id: t.id, name: t.name, players: t.players || [], values, pos: Number(ps && ps.value) || 0 });
  });
  return out;
}
function wlPopulateLeagues() {
  const sel = el('wl-league'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select league</option>' + (currentState.leagues || []).map((l) => `<option value="${l.id}">${_wlEsc(l.name || 'League')}</option>`).join('');
  sel.value = cur;
}
function wlRenderFields(w) {
  const wrap = el('wl-fields-chips'); if (wrap) {
    wrap.innerHTML = '';
    (w.fields || []).forEach((f) => {
      const chip = document.createElement('span'); chip.className = 'wl-field-chip';
      chip.innerHTML = `<span>${_wlEsc(f.label)}</span><button title="Remove field">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => wlSend({ fields: (wlState().fields || []).filter((x) => x.id !== f.id), teams: wlCollectTeams() }));
      wrap.appendChild(chip);
    });
  }
  const lf = el('wl-league-field'); if (lf) lf.innerHTML = (w.fields || []).map((f) => `<option value="${f.id}">${_wlEsc(f.label)}</option>`).join('');
}
function wlRenderTeams(w) {
  const wrap = el('wl-teams'); if (!wrap) return;
  wrap.innerHTML = '';
  (w.teams || []).forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'wl-team-row'; row.dataset.id = t.id; row.draggable = true;
    const n = (w.teams || []).length;
    const posOpts = ['<option value="0">—</option>'].concat(Array.from({ length: n }, (_, k) => `<option value="${k + 1}"${(t.pos || 0) === k + 1 ? ' selected' : ''}>${k + 1}</option>`)).join('');
    const fields = (w.fields || []).map((f) => `<label class="wl-tv"><span>${_wlEsc(f.label)}</span><input class="input-text wl-tv-input" data-fid="${f.id}" value="${_wlEsc((t.values || {})[f.id] || '')}" placeholder="—"></label>`).join('');
    row.innerHTML = `<span class="wl-team-grip" title="Drag to reorder">⠿</span>`
      + `<label class="wl-pos-wrap" title="Podium position — #1 shows in the centre of the overlay"><span>RANK</span><select class="input-select wl-pos">${posOpts}</select></label>`
      + `<div class="wl-team-main"><div class="wl-team-name">${_wlEsc(t.name) || '(unnamed)'}</div><div class="wl-team-players">${_wlEsc((t.players || []).join(', ')) || 'no players'}</div></div>`
      + `<div class="wl-team-fields">${fields}</div>`
      + `<button class="wl-solo${((currentState.teamSpotlight && currentState.teamSpotlight.name || '').toLowerCase() === (t.name || '').toLowerCase()) ? ' is-on' : ''}" title="Solo spotlight this team (start.gg deep-dive overlay)">◉</button>`
      + `<button class="wl-team-del" title="Remove from Teams to Watch">✕</button>`;
    row.querySelector('.wl-team-del').addEventListener('click', () => wlSend({ teams: wlCollectTeams().filter((x) => x.id !== t.id) }));
    row.querySelector('.wl-solo').addEventListener('click', () => tsSpotlight(t));
    row.querySelector('.wl-pos').addEventListener('mousedown', (e) => e.stopPropagation());
    row.querySelector('.wl-pos').addEventListener('change', () => wlSend({ teams: wlCollectTeams() }));
    row.querySelectorAll('.wl-tv-input').forEach((inp) => { inp.draggable = false; inp.addEventListener('mousedown', (e) => e.stopPropagation()); inp.addEventListener('change', () => wlSend({ teams: wlCollectTeams() })); });
    row.addEventListener('dragstart', (e) => { if (e.target.classList && e.target.classList.contains('wl-tv-input')) { e.preventDefault(); return; } _wlDrag = i; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { _wlDrag = -1; row.classList.remove('dragging'); });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drag-over'); if (_wlDrag < 0 || _wlDrag === i) return; const teams = wlCollectTeams(); const m = teams.splice(_wlDrag, 1)[0]; teams.splice(i, 0, m); wlSend({ teams }); });
    wrap.appendChild(row);
  });
}
function wlSyncValues(w) {
  document.querySelectorAll('#wl-teams .wl-team-row').forEach((row) => {
    const t = (w.teams || []).find((x) => x.id === row.dataset.id); if (!t) return;
    row.querySelectorAll('.wl-tv-input').forEach((inp) => { if (document.activeElement !== inp) inp.value = (t.values || {})[inp.dataset.fid] || ''; });
    const ps = row.querySelector('.wl-pos'); if (ps && document.activeElement !== ps) ps.value = String(t.pos || 0);
  });
}
function renderSpotlight() {
  const panel = el('ev-spotlight-panel'); if (!panel) return;
  const w = wlState();
  const gl = el('wl-golive');
  if (gl) { gl.textContent = w.visible ? '■ Stop' : 'Go live'; gl.classList.toggle('btn-danger', !!w.visible); gl.classList.toggle('btn-primary', !w.visible); }
  const ti = el('wl-title'); if (ti && document.activeElement !== ti) ti.value = w.title || '';
  const su = el('wl-subtitle'); if (su && document.activeElement !== su) su.value = w.subtitle || '';
  const lp = el('wl-logo-preview'), le = el('wl-logo-empty');
  if (w.logo) { if (lp) { lp.src = w.logo; lp.style.display = ''; } if (le) le.style.display = 'none'; }
  else { if (lp) lp.style.display = 'none'; if (le) le.style.display = ''; }
  wlPopulateLeagues();
  const sig = JSON.stringify({ f: (w.fields || []).map((f) => [f.id, f.label]), t: (w.teams || []).map((t) => [t.id, t.name, (t.players || []).join(',')]) });
  if (sig !== _wlSig) { _wlSig = sig; wlRenderFields(w); wlRenderTeams(w); } else wlSyncValues(w);
  const em = el('wl-empty-msg'); if (em) em.style.display = (w.teams || []).length ? 'none' : '';
  spPopulateEvents();
  if (_spMode === 'solo') { renderSpSoloList(); renderSpLink(); }
  renderTeamSpotlightBar();
  spRefreshPreviewBar();
}
function wlAddField() {
  const inp = el('wl-field-new'); const label = (inp && inp.value || '').trim(); if (!label) return;
  const fields = (wlState().fields || []).slice();
  if (fields.length >= 6) { evStatus('Max 6 custom fields.', 'err'); return; }
  fields.push({ id: 'f' + Math.random().toString(36).slice(2, 7), label });
  if (inp) inp.value = '';
  wlSend({ fields, teams: wlCollectTeams() });
}
function wlOrdinal(n) { if (!n) return ''; const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function wlLeagueFill() {
  const leagueId = el('wl-league')?.value, src = el('wl-league-src')?.value, fieldId = el('wl-league-field')?.value;
  if (!leagueId || !fieldId) { evStatus('Pick a league and a target field first.', 'err'); return; }
  const league = (currentState.leagues || []).find((l) => l.id === leagueId); if (!league) return;
  const byId = {}; (league.standings || []).forEach((s) => { byId[s.teamId] = s; });
  // Use stored standings order for rank (respects manual drag)
  const rankOf = {}; (league.standings || []).forEach((s, i) => { rankOf[s.teamId] = i + 1; });
  // Key league teams by resolved name (teamName field, not name)
  const teamByName = {}; (league.teams || []).forEach((t) => { teamByName[(lgResolveTeam(t).name || t.teamName || '').trim().toLowerCase()] = t; });
  let n = 0;
  const teams = wlCollectTeams().map((t) => {
    const lt = teamByName[(t.name || '').trim().toLowerCase()];
    const values = { ...t.values };
    if (lt) {
      const st = byId[lt.id] || {}; n++;
      if (src === 'rank') values[fieldId] = wlOrdinal(rankOf[lt.id] || 0);
      else if (src === 'record') values[fieldId] = `${st.w || 0}-${st.l || 0}`;
      else values[fieldId] = String(st.pts || 0);
    }
    return { ...t, values };
  });
  wlSend({ teams });
  const fld = el('wl-league-field'); const fldName = (fld && fld.selectedOptions[0] && fld.selectedOptions[0].textContent) || 'field';
  evStatus(n ? `Filled ${fldName} from "${league.name}" for ${n} team(s).` : `No teams matched "${league.name}" by name.`, n ? 'ok' : 'err');
}
el('wl-title')?.addEventListener('input', function () { clearTimeout(_wlTitleTimer); const v = this.value; _wlTitleTimer = setTimeout(() => wlSend({ title: v }), 350); });
el('wl-subtitle')?.addEventListener('input', function () { clearTimeout(_wlSubTimer); const v = this.value; _wlSubTimer = setTimeout(() => wlSend({ subtitle: v }), 350); });
el('wl-field-add')?.addEventListener('click', wlAddField);
el('wl-field-new')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wlAddField(); } });
el('wl-league-fill')?.addEventListener('click', wlLeagueFill);
el('wl-golive')?.addEventListener('click', () => wlSend({ visible: !wlState().visible }));
el('wl-logo-clear')?.addEventListener('click', () => wlSend({ logo: '' }));
el('wl-logo-preview')?.addEventListener('click', () => el('wl-logo-file')?.click());
el('wl-logo-empty')?.addEventListener('click', () => el('wl-logo-file')?.click());
el('wl-logo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; this.value = ''; if (!f) return;
  try { const b64 = await fileToBase64(f, 400); wlSend({ logo: b64 }); } catch (e) { evStatus('Could not load logo.', 'err'); }
});
el('wl-copy-url')?.addEventListener('click', (e) => {
  const url = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000') + '/watchlist.html';
  if (typeof copyText === 'function') copyText(url, e.currentTarget);
  else if (navigator.clipboard) navigator.clipboard.writeText(url);
  evStatus('Copied the Teams to Watch overlay URL.', 'ok');
});
{ const pv = el('wl-preview'); if (pv) pv.href = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000') + '/watchlist.html?preview=1'; }

// ── Single-team spotlight (start.gg deep-dive) ───────────────────────────────
function tsOrdinal(n) { if (!n) return ''; const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function tsSpotlight(t) {
  send('set_team_spotlight', { name: t.name, eventSlug: t.eventSlug || '', entrantId: t.entrantId || '', players: (t.players || []).map((p) => ({ gamerTag: p })) });
  evStatus(t.entrantId ? `Spotlighting "${t.name}" — pulling start.gg data…` : `Spotlighting "${t.name}" — re-mark it from the event for live start.gg stats.`, 'ok');
}
function renderTeamSpotlightBar() {
  const ts = (currentState && currentState.teamSpotlight) || {};
  const has = !!ts.name;
  const target = el('ts-bar-target'); if (target) target.textContent = has ? ts.name : 'No team selected — click ◉ on a team above.';
  const sync = el('ts-bar-sync');
  if (sync) {
    if (!has) { sync.textContent = ''; sync.className = 'ts-bar-sync'; }
    else if (ts.syncError) { sync.textContent = '⚠ ' + ts.syncError; sync.className = 'ts-bar-sync err'; }
    else if (ts.lastSync) { const sg = ts.sg || {}; const bits = []; if (sg.seed) bits.push('seed #' + sg.seed); if (sg.placement) bits.push(tsOrdinal(sg.placement)); if (sg.record && (sg.record.w || sg.record.l)) bits.push(sg.record.w + '–' + sg.record.l); sync.textContent = '● ' + (bits.join(' · ') || 'synced from start.gg'); sync.className = 'ts-bar-sync ok'; }
    else { sync.textContent = '… fetching'; sync.className = 'ts-bar-sync'; }
  }
  const gl = el('ts-golive'); if (gl) { gl.disabled = !has; gl.textContent = ts.visible ? '■ Stop' : 'Go live'; gl.classList.toggle('btn-danger', !!ts.visible); gl.classList.toggle('btn-primary', !ts.visible); }
  // Reflect the active solo target on the per-team ◉ buttons.
  document.querySelectorAll('#wl-teams .wl-team-row').forEach((row) => {
    const t = (wlState().teams || []).find((x) => x.id === row.dataset.id); const solo = row.querySelector('.wl-solo');
    if (solo && t) solo.classList.toggle('is-on', has && (ts.name || '').toLowerCase() === (t.name || '').toLowerCase());
  });
}
el('ts-golive')?.addEventListener('click', () => { const ts = currentState.teamSpotlight || {}; if (!ts.name) return; send('set_team_spotlight', { visible: !ts.visible, fetch: false }); });
el('ts-refresh')?.addEventListener('click', () => { const ts = currentState.teamSpotlight || {}; if (!ts.name) return; send('set_team_spotlight', { name: ts.name, eventSlug: ts.eventSlug, entrantId: ts.entrantId }); evStatus('Refreshing spotlight from start.gg…'); });
el('ts-copy-url')?.addEventListener('click', (e) => {
  const url = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000') + '/team-spotlight.html';
  if (typeof copyText === 'function') copyText(url, e.currentTarget); else if (navigator.clipboard) navigator.clipboard.writeText(url);
  evStatus('Copied the Team Spotlight overlay URL.', 'ok');
});
{ const pv = el('ts-preview'); if (pv) pv.href = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000') + '/team-spotlight.html?preview=1'; }

// ── Spotlight studio: mode toggle + in-page team picker + live WYSIWYG preview ──
let _spMode = 'watch';
let _spFramesInit = false;
// The control panel is loaded over file:// — point the preview iframes at the overlay server.
function spInitFrames() {
  if (_spFramesInit) return; _spFramesInit = true;
  const base = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000');
  const fw = el('sp-frame-watch'); if (fw) fw.src = base + '/watchlist.html?embed=1';
  const fs = el('sp-frame-solo'); if (fs) fs.src = base + '/team-spotlight.html?embed=1';
}
function spSetMode(mode) {
  spInitFrames();
  _spMode = (mode === 'solo') ? 'solo' : 'watch';
  document.querySelectorAll('#sp-modes .sp-mode-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.spmode === _spMode));
  const wb = el('sp-watch-build'), sb = el('sp-solo-build');
  if (wb) wb.style.display = _spMode === 'watch' ? '' : 'none';
  if (sb) sb.style.display = _spMode === 'solo' ? '' : 'none';
  const fw = el('sp-frame-watch'), fs = el('sp-frame-solo');
  if (fw) fw.style.display = _spMode === 'watch' ? '' : 'none';
  if (fs) fs.style.display = _spMode === 'solo' ? '' : 'none';
  const desc = el('sp-mode-desc');
  if (desc) desc.textContent = _spMode === 'watch'
    ? 'Feature a set of teams in one graphic — logos, custom stats, and a podium. Build it on the left, watch it live on the right.'
    : 'Deep-dive a single team — placement, seed, record and recent/next matches from start.gg, plus live in-game player stats when on-air.';
  if (_spMode === 'solo') { renderSpSoloList(); renderSpLink(); }
  spRefreshPreviewBar();
}
document.querySelectorAll('#sp-modes .sp-mode-btn').forEach((b) => b.addEventListener('click', () => spSetMode(b.dataset.spmode)));
let _spEvtSig = '';
function spPopulateEvents() {
  const sel = el('sp-event'); if (!sel) return;
  const cur = sel.value, evs = currentState.myEvents || [];
  const sig = evs.map((e) => e.id + ':' + (e.name || '')).join('|');
  if (sig === _spEvtSig && sel.options.length) return;   // don't rebuild the dropdown every broadcast
  _spEvtSig = sig;
  sel.innerHTML = '<option value="">Select a saved event…</option>' + evs.map((e) => `<option value="${e.id}">${_wlEsc(e.name || 'Event')}</option>`).join('');
  sel.value = (cur && evs.some((e) => e.id === cur)) ? cur : ((evs[0] && evs[0].id) || '');
}
function spSelectedEvent() { return (currentState.myEvents || []).find((e) => e.id === (el('sp-event') && el('sp-event').value)); }
let _spSrc = 'event';        // team source: 'event' (My Event roster) | 'library' (saved teams)
let _spPickSig = '';
// Resolve a small chip logo: the team's own logo, else a saved-team logo by name.
function spTeamLogo(name, ownLogo) {
  if (ownLogo) return ownLogo;
  const t = (currentState.savedTeams || []).find((x) => (x.name || '').toLowerCase() === (name || '').toLowerCase());
  return (t && t.logo) || '';
}
function spSetSource(src) {
  _spSrc = (src === 'library') ? 'library' : 'event';
  document.querySelectorAll('#sp-src-tabs .sp-src-tab').forEach((b) => b.classList.toggle('is-on', b.dataset.spsrc === _spSrc));
  const evSel = el('sp-event'); if (evSel) evSel.style.display = _spSrc === 'event' ? '' : 'none';
  if (_spTeamSearchCtl) _spTeamSearchCtl.refresh();
}
// Candidates for the Add-team search — same shape/logo lookup as before, minus teams already added.
function spTeamSearchCandidates(q) {
  q = (q || '').trim().toLowerCase();
  const marked = new Set(((currentState.watchlist && currentState.watchlist.teams) || []).map((t) => (t.name || '').toLowerCase()));
  let list = [];
  if (_spSrc === 'library') {
    list = (currentState.savedTeams || []).map((t) => ({ name: t.name || '', players: (t.players || []).map((p) => p.name || p.gamerTag).filter(Boolean), logo: t.logo || '', entrantId: '', eventSlug: '', source: 'saved' }));
  } else {
    const ev = spSelectedEvent(); if (!ev) return [];
    list = ((ev && ev.roster) || []).map((rt) => ({ name: rt.name || '', players: (rt.players || []).map((p) => p.gamerTag).filter(Boolean), logo: '', entrantId: rt.entrantId || '', eventSlug: ev.eventSlug, _evName: ev.name, source: 'event' }));
  }
  list = list.filter((t) => t.name && !marked.has(t.name.toLowerCase()));
  // Rank BEFORE the 60-item cap — capping an unranked list used to drop the exact match a producer
  // was typing whenever it happened to sit past the first 60 rows of the library.
  return NESearch.filter(list, q,
    (t) => [{ text: t.name, weight: 2 }].concat(t.players || []),
    { limit: 60 }).slice(0, 60);
}
// Add-team search — same logo-capable typeahead pattern as Match > Teams (setupTeamTypeahead) and
// the League "search library to add" field (setupLeagueTeamSearch): type, pick a result from the
// .team-dd popover, it's added immediately and the field clears so the next one can be typed.
let _spTeamSearchCtl = null;
function setupSpotlightTeamSearch() {
  const input = el('sp-team-search'), dd = el('sp-team-dd');
  if (!input || !dd) return null;
  let items = [], active = -1, open = false;
  const close = () => { dd.classList.remove('show'); open = false; active = -1; };
  const position = () => {
    const r = input.getBoundingClientRect();
    dd.style.left = r.left + 'px'; dd.style.width = r.width + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 220 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
  };
  const render = () => {
    if (!items.length) {
      const msg = _spSrc === 'library'
        ? ((currentState.savedTeams || []).length ? 'No matching teams' : 'No saved teams yet — add them on the Teams page')
        : (!spSelectedEvent() ? 'Pick a saved event above to search its teams.' : 'No matching teams');
      dd.innerHTML = `<div class="team-dd-empty">${msg}</div>`;
      position(); dd.classList.add('show'); open = true; return;
    }
    dd.innerHTML = items.map((t, i) => {
      const logo = spTeamLogo(t.name, t.logo);
      const nm = _wlEsc((t.name || '').toUpperCase());
      const tag = t.source === 'event' ? '<span class="team-dd-tag">EVENT</span>' : '';
      return `<div class="team-dd-item${i === active ? ' active' : ''}" data-i="${i}" role="option">`
        + `<img class="team-dd-logo${logo ? '' : ' game-logo-white'}" src="${logo || gameLogo()}" alt="" onerror="this.style.visibility='hidden'">`
        + `<span class="team-dd-name">${nm}</span>${tag}</div>`;
    }).join('');
    position(); dd.classList.add('show'); open = true;
    const act = dd.querySelector('.team-dd-item.active'); if (act) act.scrollIntoView({ block: 'nearest' });
  };
  const refresh = () => { items = spTeamSearchCandidates(input.value); active = -1; render(); };
  const pick = (t) => {
    if (!t) return;
    send('toggle_watchlist_team', { team: { name: t.name, players: t.players, entrantId: t.entrantId, eventSlug: t.eventSlug }, event: t._evName || '' });
    input.value = ''; refresh(); input.focus();
  };
  input.addEventListener('focus', refresh);
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (!open && e.key === 'ArrowDown') { refresh(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && items[active]) pick(items[active]); else if (items.length === 1) pick(items[0]); }
    else if (e.key === 'Escape') { close(); }
  });
  dd.addEventListener('mousedown', (e) => { const it = e.target.closest('.team-dd-item'); if (!it) return; e.preventDefault(); pick(items[Number(it.dataset.i)]); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  window.addEventListener('scroll', () => { if (open) position(); }, true);
  window.addEventListener('resize', () => { if (open) close(); });
  return { refresh, close };
}
_spTeamSearchCtl = setupSpotlightTeamSearch();
document.querySelectorAll('#sp-src-tabs .sp-src-tab').forEach((b) => b.addEventListener('click', () => spSetSource(b.dataset.spsrc)));
el('sp-event')?.addEventListener('change', () => { if (_spTeamSearchCtl) _spTeamSearchCtl.refresh(); });
function spCustomAdd() {
  const inp = el('sp-custom-name'); const name = (inp && inp.value || '').trim(); if (!name) return;
  const marked = new Set(((currentState.watchlist && currentState.watchlist.teams) || []).map((t) => (t.name || '').toLowerCase()));
  if (marked.has(name.toLowerCase())) { evStatus(`"${name}" is already added.`); if (inp) inp.value = ''; return; }
  send('toggle_watchlist_team', { team: { name, players: [], entrantId: '', eventSlug: '' } });
  if (inp) inp.value = '';
  evStatus(`Added "${name}".`, 'ok');
}
el('sp-custom-add')?.addEventListener('click', spCustomAdd);
el('sp-custom-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); spCustomAdd(); } });
let _spSoloSig = '';
// Team Spotlight's solo-pick control — a logo-capable dropdown (native <select> can't host <img>,
// so this is a custom button + popover list, styled and behaving like a dropdown/combobox).
function spSoloDdClose() { const dd = el('sp-solo-dd'); const menu = el('sp-solo-dd-menu'); if (dd) dd.classList.remove('is-open'); if (menu) menu.style.display = 'none'; }
function spSoloDdOpen() { const dd = el('sp-solo-dd'); const menu = el('sp-solo-dd-menu'); if (dd) dd.classList.add('is-open'); if (menu) menu.style.display = ''; }
function renderSpSoloList() {
  const menu = el('sp-solo-dd-menu'), btn = el('sp-solo-dd-btn'); if (!menu || !btn) return;
  const teams = (currentState.watchlist && currentState.watchlist.teams) || [];
  const cur = (currentState.teamSpotlight && currentState.teamSpotlight.name || '').toLowerCase();
  const sig = cur + '#' + teams.map((t) => (t.name || '') + ':' + (t.players || []).length + ':' + (t.entrantId ? 1 : 0) + ':' + (t.logo || '')).join(',');
  if (sig !== _spSoloSig || !menu.children.length) {
    _spSoloSig = sig;
    menu.innerHTML = '';
    if (!teams.length) {
      menu.innerHTML = '<span class="sp-pick-empty">No teams marked yet — add some in Teams to Watch.</span>';
    } else {
      teams.forEach((t) => {
        const on = (t.name || '').toLowerCase() === cur;
        const logoUrl = spTeamLogo(t.name, t.logo);
        const item = document.createElement('button'); item.type = 'button'; item.className = 'sp-solo-dd-item' + (on ? ' is-on' : '');
        const link = t.entrantId
          ? '<span class="sp-solo-dd-item-link ok" title="Linked to start.gg">● start.gg</span>'
          : '<span class="sp-solo-dd-item-link" title="Not linked — link it after selecting for full stats">○ no link</span>';
        item.innerHTML = (logoUrl ? `<img class="sp-solo-dd-item-logo" src="${_wlEsc(logoUrl)}" alt="">` : `<span class="sp-solo-dd-item-logo"></span>`)
          + `<span class="sp-solo-dd-item-main"><span class="sp-solo-dd-item-name">${_wlEsc(t.name || 'Team')}</span><span class="sp-solo-dd-item-players">${_wlEsc((t.players || []).join(' · ')) || 'no players'}</span></span>`
          + link;
        item.addEventListener('click', () => { tsSpotlight(t); spSoloDdClose(); });
        menu.appendChild(item);
      });
    }
  }
  // Closed-button face always reflects the current pick — cheap, updates even when the menu itself
  // didn't need a rebuild (e.g. only the spotlighted team changed, not the team list).
  const curTeam = teams.find((t) => (t.name || '').toLowerCase() === cur);
  const logoEl = el('sp-solo-dd-logo'), labelEl = el('sp-solo-dd-label');
  if (curTeam) {
    const logoUrl = spTeamLogo(curTeam.name, curTeam.logo);
    if (logoEl) { if (logoUrl) { logoEl.src = logoUrl; logoEl.style.display = ''; } else logoEl.style.display = 'none'; }
    if (labelEl) labelEl.textContent = curTeam.name || 'Team';
  } else {
    if (logoEl) logoEl.style.display = 'none';
    if (labelEl) labelEl.textContent = 'Select a team to spotlight…';
  }
}
el('sp-solo-dd-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = el('sp-solo-dd'); if (!dd) return;
  if (dd.classList.contains('is-open')) spSoloDdClose(); else spSoloDdOpen();
});
document.addEventListener('click', (e) => {
  const dd = el('sp-solo-dd'); if (!dd || !dd.classList.contains('is-open')) return;
  if (!dd.contains(e.target)) spSoloDdClose();
});

// "Add team" dropdown (Teams to Watch) — opens the same source-tabs/search/pick-list/custom-add
// controls in a popover instead of an always-expanded scroll-and-click grid. Stays open after a
// pick so several teams can be added in a row; closes on outside click or the button again.
function spAddDdClose() { const dd = el('sp-adddd'); const menu = el('sp-adddd-menu'); if (dd) dd.classList.remove('is-open'); if (menu) menu.style.display = 'none'; }
function spAddDdOpen() { const dd = el('sp-adddd'); const menu = el('sp-adddd-menu'); if (dd) dd.classList.add('is-open'); if (menu) menu.style.display = ''; el('sp-team-search')?.focus(); }
el('sp-adddd-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = el('sp-adddd'); if (!dd) return;
  if (dd.classList.contains('is-open')) spAddDdClose(); else spAddDdOpen();
});
document.addEventListener('click', (e) => {
  const dd = el('sp-adddd'); if (!dd || !dd.classList.contains('is-open')) return;
  if (!dd.contains(e.target)) spAddDdClose();
});
function spRefreshPreviewBar() {
  const base = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000');
  const open = el('sp-open'); if (open) open.href = base + (_spMode === 'solo' ? '/team-spotlight.html' : '/watchlist.html') + '?preview=1';
  const gl = el('sp-golive'), foot = el('sp-preview-foot');
  if (_spMode === 'solo') {
    const ts = currentState.teamSpotlight || {};
    if (gl) { gl.disabled = !ts.name; gl.textContent = ts.visible ? '■ Stop' : 'Go live'; gl.classList.toggle('btn-danger', !!ts.visible); gl.classList.toggle('btn-primary', !ts.visible); }
    if (foot) foot.textContent = ts.name ? (ts.visible ? 'ON AIR · ' + ts.name : 'Ready · ' + ts.name) : 'Pick a team to spotlight.';
  } else {
    const w = currentState.watchlist || {}, n = (w.teams || []).length;
    if (gl) { gl.disabled = !n; gl.textContent = w.visible ? '■ Stop' : 'Go live'; gl.classList.toggle('btn-danger', !!w.visible); gl.classList.toggle('btn-primary', !w.visible); }
    if (foot) foot.textContent = n ? (w.visible ? `ON AIR · ${n} team${n === 1 ? '' : 's'}` : `Ready · ${n} team${n === 1 ? '' : 's'}`) : 'Add teams to build the card.';
  }
}
el('sp-golive')?.addEventListener('click', () => {
  if (_spMode === 'solo') { const ts = currentState.teamSpotlight || {}; if (!ts.name) return; send('set_team_spotlight', { visible: !ts.visible, fetch: false }); }
  else { const w = currentState.watchlist || {}; if (!(w.teams || []).length) return; send('set_watchlist', { visible: !w.visible }); }
});
el('sp-copy-url')?.addEventListener('click', (e) => {
  const base = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000');
  const url = base + (_spMode === 'solo' ? '/team-spotlight.html' : '/watchlist.html');
  if (typeof copyText === 'function') copyText(url, e.currentTarget); else if (navigator.clipboard) navigator.clipboard.writeText(url);
  evStatus('Copied the overlay URL.', 'ok');
});

// ── Link a library / custom-added team to a start.gg entrant (for the full deep-dive) ──
function spLinkBestMatch(roster, name) {
  const k = (name || '').trim().toLowerCase();
  return (roster || []).find((r) => (r.name || '').trim().toLowerCase() === k)
    || (roster || []).find((r) => (r.name || '').toLowerCase().includes(k) || k.includes((r.name || '').toLowerCase()));
}
let _spLinkSig = '';
function renderSpLink() {
  const panel = el('sp-link'); if (!panel) return;
  const ts = currentState.teamSpotlight || {};
  if (!ts.name) { panel.style.display = 'none'; _spLinkSig = ''; return; }
  panel.style.display = '';
  const lbl = el('sp-link-lbl'); if (lbl) lbl.textContent = ts.entrantId ? 'start.gg link ✓' : '⚠ Link to start.gg';
  const evs = currentState.myEvents || [];
  const sig = ts.name + '#' + (ts.eventSlug || '') + '#' + (ts.entrantId || '') + '#' + evs.map((e) => e.id).join(',');
  if (sig === _spLinkSig) return;   // don't rebuild the dropdowns every broadcast
  _spLinkSig = sig;
  const evSel = el('sp-link-event'); if (!evSel) return;
  evSel.innerHTML = '<option value="">Select event…</option>' + evs.map((e) => `<option value="${e.id}">${_wlEsc(e.name || 'Event')}</option>`).join('');
  const pre = evs.find((e) => e.eventSlug === ts.eventSlug) || evs[0];
  evSel.value = pre ? pre.id : '';
  spLinkPopulateEntrants();
}
function spLinkPopulateEntrants() {
  const sel = el('sp-link-entrant'); if (!sel) return;
  const ev = (currentState.myEvents || []).find((e) => e.id === (el('sp-link-event') && el('sp-link-event').value));
  const roster = (ev && ev.roster) || [];
  sel.innerHTML = '<option value="">Match team…</option>' + roster.map((r) => `<option value="${_wlEsc(r.entrantId)}">${_wlEsc(r.name || 'Team')}</option>`).join('');
  const ts = currentState.teamSpotlight || {};
  const best = spLinkBestMatch(roster, ts.name);
  sel.value = (ts.entrantId && roster.some((r) => String(r.entrantId) === String(ts.entrantId))) ? ts.entrantId : (best ? best.entrantId : '');
}
function spLinkApply() {
  const ts = currentState.teamSpotlight || {};
  const target = ts.name; if (!target) return;
  const ev = (currentState.myEvents || []).find((e) => e.id === (el('sp-link-event') && el('sp-link-event').value));
  const entrantId = el('sp-link-entrant') && el('sp-link-entrant').value;
  if (!ev || !entrantId) { spLinkStatus('Pick an event and entrant.', 'err'); return; }
  const rt = (ev.roster || []).find((r) => String(r.entrantId) === String(entrantId));
  const rtPlayers = rt ? (rt.players || []).map((p) => p.gamerTag).filter(Boolean) : [];
  const teams = ((currentState.watchlist && currentState.watchlist.teams) || []).map((t) =>
    (t.name || '').toLowerCase() === target.toLowerCase()
      ? { ...t, entrantId, eventSlug: ev.eventSlug, players: (t.players && t.players.length) ? t.players : rtPlayers }
      : t);
  send('set_watchlist', { teams });
  const finalT = teams.find((t) => (t.name || '').toLowerCase() === target.toLowerCase());
  send('set_team_spotlight', { name: target, eventSlug: ev.eventSlug, entrantId, players: ((finalT && finalT.players) || rtPlayers).map((p) => ({ gamerTag: p })) });
  spLinkStatus(`Linked to "${(rt && rt.name) || 'entrant'}" — pulling stats…`, 'ok');
}
function spLinkStatus(msg, kind) { const s = el('sp-link-status'); if (!s) return; s.textContent = msg || ''; s.style.color = kind === 'err' ? '#f87171' : (kind === 'ok' ? '#34d399' : 'var(--muted)'); }
el('sp-link-event')?.addEventListener('change', spLinkPopulateEntrants);
el('sp-link-btn')?.addEventListener('click', spLinkApply);

