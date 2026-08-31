/* seed-resolve-core.js — pure (DOM-free) math for the seeding rank-resolution engine.
 *
 * Turns placement scores into ranks and decides which source wins per player. Kept free of any
 * DOM/global so it can be unit-tested in Node (see the export guard at the bottom). All rank maths
 * mirror seedRankValue() in seeding-spotlight.js: a "mode" is a SEED_RANK_MODES entry
 * ({ kind:'tier'|'num', tiers:[…low→high], nodiv:bool }). Tier seed-values are tierIndex*10+division
 * (rl-6mans nodiv ladder = 10,20,…,90); num modes are the raw number.
 */
(function (root) {
  'use strict';

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // Confidence each source is worth (0-100). Higher always wins in resolveApply(). rl6mans VERIFIED
  // (exact ELO) is the gold standard and sits clearly above everything, incl. tracker.gg — which is
  // a fallback only when there's no verified 6mans (see seedApplyEstimate's tracker gate).
  const SRC_CONF = {
    sixmans: 98, sixmansRegistry: 92,   // rl6mans.com verified — exact ELO (98) / remembered account (92)
    tracker: 92, trackerDom: 80,        // tracker.gg (raw MMR vs DOM-only fallback)
    manual: 60,                         // hand / CSV entered, unverified
    teammate: 15,                       // average of resolved teammates
    // ourEvents / startgg placement are calibration-scaled — see sourceConfidence()
  };

  // Snap an arbitrary numeric seed-value to the nearest VALID {rank, rankValue} for a mode. The
  // returned rank string always round-trips back through seedRankValue() to the same rankValue.
  function snapRankValue(value, mode) {
    if (value == null || !Number.isFinite(value)) return null;
    mode = mode || {};
    const tiers = mode.tiers || [];
    if (mode.kind === 'num' || !tiers.length) { const v = Math.round(value); return { rank: String(v), rankValue: v }; }
    const N = tiers.length;
    if (mode.nodiv) {
      const idx = clamp(Math.round(value / 10) - 1, 0, N - 1);
      return { rank: tiers[idx], rankValue: (idx + 1) * 10 };
    }
    let best = null;
    for (let ti = 1; ti <= N; ti++) {
      for (let div = 1; div <= 3; div++) {
        const cand = ti * 10 + div;
        const d = Math.abs(value - cand);
        if (!best || d < best.d) best = { d, ti, div };
      }
    }
    const roman = { 1: 'I', 2: 'II', 3: 'III' }[best.div];
    return { rank: tiers[best.ti - 1] + ' ' + roman, rankValue: best.ti * 10 + best.div };
  }

  // Least-squares fit of placement-score → rankValue over anchor players (those with a real rank AND
  // a placement score). Returns ok:false (caller falls back to fixed bands) when there are too few
  // anchors, the spread is degenerate, or the slope isn't positive (score must rise with rank).
  function fitCalibration(anchors) {
    const pts = (anchors || []).filter((a) => a && Number.isFinite(a.score) && Number.isFinite(a.rankValue));
    const n = pts.length;
    const out = { a: 0, b: 0, r2: 0, n: n, minScore: 0, maxScore: 0, yMin: 0, yMax: 0, ok: false };
    if (n < 3) return out;
    let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0;
    let minS = Infinity, maxS = -Infinity, yMin = Infinity, yMax = -Infinity;
    const distinctX = new Set(), distinctY = new Set();
    for (const p of pts) {
      Sx += p.score; Sy += p.rankValue; Sxx += p.score * p.score; Syy += p.rankValue * p.rankValue; Sxy += p.score * p.rankValue;
      minS = Math.min(minS, p.score); maxS = Math.max(maxS, p.score);
      yMin = Math.min(yMin, p.rankValue); yMax = Math.max(yMax, p.rankValue);
      distinctX.add(p.score); distinctY.add(p.rankValue);
    }
    out.minScore = minS; out.maxScore = maxS; out.yMin = yMin; out.yMax = yMax;
    if (distinctX.size < 2 || distinctY.size < 2) return out;
    const den = n * Sxx - Sx * Sx;
    if (Math.abs(den) < 1e-9) return out;
    const b = (n * Sxy - Sx * Sy) / den;
    const a = (Sy - b * Sx) / n;
    if (b <= 0) { out.a = a; out.b = b; return out; }   // non-monotonic → fallback
    const denY = n * Syy - Sy * Sy;
    const r2 = denY > 0 ? Math.pow(n * Sxy - Sx * Sy, 2) / (den * denY) : 0;
    return { a: a, b: b, r2: clamp(r2, 0, 1), n: n, minScore: minS, maxScore: maxS, yMin: yMin, yMax: yMax, ok: true };
  }

  // Map a 0-100 placement score to a rank for a mode. Uses the calibration fit when available,
  // otherwise a fixed percentile-across-the-ladder band. Returns { rank, rankValue, method, inRange }.
  function correlate(score, mode, fit, opts) {
    opts = opts || {};
    if (!Number.isFinite(score)) return null;
    mode = mode || {};
    if (fit && fit.ok) {
      let v = fit.a + fit.b * score;
      const step = mode.kind === 'tier' ? 10 : Math.max(1, (fit.yMax - fit.yMin) * 0.05);
      v = clamp(v, fit.yMin - step, fit.yMax + step);
      const snapped = snapRankValue(v, mode);
      if (!snapped) return null;
      return Object.assign(snapped, { method: 'calibrated', r2: fit.r2, inRange: score >= fit.minScore && score <= fit.maxScore });
    }
    // Fixed-band fallback
    const tiers = mode.tiers || [];
    if (mode.kind === 'tier' && tiers.length) {
      const N = tiers.length;
      const idx = clamp(Math.round((clamp(score, 0, 100) / 100) * (N - 1)), 0, N - 1);
      const val = mode.nodiv ? (idx + 1) * 10 : (idx + 1) * 10 + 2;   // mid-division for divisioned modes
      const snapped = snapRankValue(val, mode);
      return snapped && Object.assign(snapped, { method: 'band', r2: 0, inRange: true });
    }
    if (mode.kind === 'num' && Array.isArray(opts.numRange)) {
      const lo = opts.numRange[0], hi = opts.numRange[1];
      const val = lo + (clamp(score, 0, 100) / 100) * (hi - lo);
      const snapped = snapRankValue(val, mode);
      return snapped && Object.assign(snapped, { method: 'band', r2: 0, inRange: true });
    }
    return null;
  }

  // Confidence for a calibrated/banded placement result. Kept strictly below manual (60) and with
  // our-events above start.gg, so a placement guess never displaces a real source.
  function sourceConfidence(family, r2, inRange) {
    const ourEvents = family === 'ourEvents';
    const base = ourEvents ? 50 : 35;
    const quality = 0.6 + 0.4 * clamp(r2 || 0, 0, 1);
    const conf = Math.round(base * quality) - (inRange ? 0 : 10);
    return clamp(conf, 10, ourEvents ? 55 : 40);
  }

  // The ONE write path: only upgrade a player when the candidate is more confident. This is what
  // makes verified override manual, and placement/teammate never overwrite a hand-entered rank.
  function resolveApply(p, cand) {
    if (!p || !cand || cand.rankValue == null || cand.rank == null) return false;
    if ((cand.confidence || 0) > (p.confidence || 0)) {
      p.source = cand.source; p.confidence = cand.confidence; p.sourceDetail = cand.detail || '';
      p.rank = cand.rank; p.rankValue = cand.rankValue;
      return true;
    }
    return false;
  }

  // ── Continuous 6mans MMR model ─────────────────────────────────────────────
  // The canonical seed scale for Rocket League is a continuous ELO. Tier letters are just a display
  // bucket of it. Every source normalizes to an MMR estimate; a player's seed value is the
  // confidence-weighted blend of its estimates (blendEstimates), so scales can never collide.
  const SIXMANS_TIERS = ['H', 'E', 'D', 'C', 'B', 'B+', 'A', 'X', 'S'];   // low → high
  const SIXMANS_TIER_DEFAULTS = [100, 250, 400, 550, 700, 850, 1050, 1300, 1600];   // default ELO per tier

  function tierIndex(tier) {
    if (tier == null) return -1;
    const s = ('' + tier).trim().toUpperCase();
    let idx = SIXMANS_TIERS.indexOf(s);
    if (idx >= 0) return idx;
    // tolerate messy input ("B+ ", "bplus") — longest tier token first so B+ beats B
    if (/^B\s*\+|BPLUS/.test(s)) return SIXMANS_TIERS.indexOf('B+');
    for (let i = SIXMANS_TIERS.length - 1; i >= 0; i--) { if (s.indexOf(SIXMANS_TIERS[i].toUpperCase()) === 0) return i; }
    return -1;
  }
  function mmrFromTier(tier, midpoints) {
    const idx = tierIndex(tier);
    if (idx < 0) return null;
    const m = midpoints || SIXMANS_TIER_DEFAULTS;
    return (typeof m[idx] === 'number') ? m[idx] : SIXMANS_TIER_DEFAULTS[idx];
  }
  function tierFromMMR(mmr, midpoints) {
    if (!Number.isFinite(mmr)) return null;
    const m = midpoints || SIXMANS_TIER_DEFAULTS;
    const N = m.length;
    for (let i = 0; i < N - 1; i++) { if (mmr < (m[i] + m[i + 1]) / 2) return SIXMANS_TIERS[i]; }
    return SIXMANS_TIERS[N - 1];
  }
  // Learn tier→ELO midpoints from THIS event's rl6mans-exact players (they carry both a tier and an
  // exact ELO), falling back to defaults for sparse tiers and forcing the ladder strictly increasing.
  function calibrateTierMidpoints(samples, defaults, opts) {
    defaults = defaults || SIXMANS_TIER_DEFAULTS;
    const minSamples = (opts && opts.minSamples) || 2;
    const minGap = (opts && opts.minGap) || 50;
    const sums = SIXMANS_TIERS.map(() => 0), counts = SIXMANS_TIERS.map(() => 0);
    (samples || []).forEach((s) => {
      if (!s || !Number.isFinite(s.elo) || s.elo <= 0) return;
      const idx = tierIndex(s.tier); if (idx < 0) return;
      sums[idx] += s.elo; counts[idx]++;
    });
    const mids = SIXMANS_TIERS.map((_, i) => counts[i] >= minSamples ? Math.round(sums[i] / counts[i]) : defaults[i]);
    for (let i = 1; i < mids.length; i++) { if (mids[i] <= mids[i - 1]) mids[i] = mids[i - 1] + minGap; }
    const meta = SIXMANS_TIERS.map((t, i) => ({ tier: t, source: counts[i] >= minSamples ? 'calibrated' : 'default', n: counts[i] }));
    return { midpoints: mids, meta };
  }
  // Map a 0-100 placement score to an MMR (calibrated from anchors, else a fixed band). No tier snap.
  function correlateMMR(score, fit, mmrRange) {
    if (!Number.isFinite(score)) return null;
    if (fit && fit.ok) {
      let v = fit.a + fit.b * score;
      const pad = Math.max(25, (fit.yMax - fit.yMin) * 0.05);
      v = clamp(v, fit.yMin - pad, fit.yMax + pad);
      return { mmr: v, method: 'calibrated', r2: fit.r2, inRange: score >= fit.minScore && score <= fit.maxScore };
    }
    if (Array.isArray(mmrRange)) {
      const v = mmrRange[0] + (clamp(score, 0, 100) / 100) * (mmrRange[1] - mmrRange[0]);
      return { mmr: v, method: 'band', r2: 0, inRange: true };
    }
    return null;
  }
  // Inverse of the calibration fit: given a team's rank/MMR value, what placement score would a team
  // of that strength be expected to post? Auto-seed uses this to slot a brand-new team (no tournament
  // history, seeded off its 6mans ranks) into a board that is otherwise ordered by placements —
  // otherwise every new team piles up at the bottom regardless of how strong its roster is.
  // Returns null when the fit isn't trustworthy, which is the caller's cue to do exactly that.
  function scoreFromRank(rankValue, fit) {
    if (!fit || !fit.ok || !Number.isFinite(rankValue)) return null;
    if (!(Math.abs(fit.b) > 1e-9)) return null;
    const s = (rankValue - fit.a) / fit.b;
    if (!Number.isFinite(s)) return null;
    // Never extrapolate far past the observed placement range — a wild rank shouldn't invent a
    // score no real team in this field has earned.
    const pad = Math.max(5, (fit.maxScore - fit.minScore) * 0.15);
    return clamp(s, Math.max(0, fit.minScore - pad), Math.min(100, fit.maxScore + pad));
  }

  // Confidence-weighted blend of a player's source estimates → the single seed MMR. Weight = (conf/100)^k
  // (k=2 sharpens so a verified exact ELO dominates a manual guess ~2.5×, without erasing it).
  function blendEstimates(estimates, opts) {
    const k = (opts && opts.k) || 2;
    const tol = (opts && opts.tol) || 150;   // MMR within which sources "agree"
    const est = (estimates || []).filter((e) => e && Number.isFinite(e.mmr) && (e.confidence || 0) > 0);
    if (!est.length) return { mmr: null, confidence: 0, dominant: null, breakdown: [] };
    let wsum = 0, msum = 0, dom = est[0], domW = -1;
    est.forEach((e) => { const w = Math.pow((e.confidence || 0) / 100, k); wsum += w; msum += e.mmr * w; if (w > domW || (w === domW && e.confidence > dom.confidence)) { domW = w; dom = e; } });
    const mmr = wsum > 0 ? msum / wsum : dom.mmr;
    const agree = est.filter((e) => Math.abs(e.mmr - mmr) <= tol).length;
    const bonus = agree >= 2 ? Math.min((agree - 1) * 8, 15) : 0;
    const confidence = Math.min(99, Math.round(dom.confidence + (1 - dom.confidence / 100) * bonus));
    const breakdown = est.slice().sort((a, b) => Math.pow((b.confidence || 0) / 100, k) - Math.pow((a.confidence || 0) / 100, k));
    return { mmr: Math.round(mmr), confidence, dominant: dom, breakdown };
  }


  // ── Roster coherence prior ─────────────────────────────────────────────────
  // Rosters are homogeneous. Players team up with people near their own level, so if one player is
  // A rank his team-mates are far more likely to be A/B than to be the weakest player in the field.
  // A team-mate who simply does not play 6mans is an UNKNOWN, not a BAD player.
  //
  // The old imputation ignored that and stood every unresolved slot at the field floor (15th
  // percentile), which systematically buried any team that had players outside the 6mans scene —
  // exactly the teams a producer most needs seeded sensibly.
  //
  // So an unresolved slot is estimated from its own roster, pulled toward the field's middle by how
  // little of that roster we have actually measured:
  //
  //     imputed = w * rosterKnownMean + (1 - w) * fieldMid,   w = PRIOR_BASE + PRIOR_SLOPE * coverage
  //
  // 2-of-3 known leans on the team-mates; 1-of-3 leans on the field. Confidence stays low either
  // way, so ratePower's shrinkage still keeps a thinly-measured team honest.
  const PRIOR_BASE  = 0.25;
  const PRIOR_SLOPE = 0.65;

  function imputedValue(knownMean, fieldMid, coverage) {
    if (!Number.isFinite(knownMean)) return Number.isFinite(fieldMid) ? fieldMid : null;
    if (!Number.isFinite(fieldMid)) return knownMean;
    const w = clamp(PRIOR_BASE + PRIOR_SLOPE * clamp(coverage, 0, 1), 0, 1);
    return w * knownMean + (1 - w) * fieldMid;
  }

  // ── Self-reported rank trust ───────────────────────────────────────────────
  // Players misreport their rank on the sign-up sheet — sometimes by accident, sometimes not. Rather
  // than assume a fixed trust level for CSV/manual entries, MEASURE it on this very field: every
  // player who has BOTH a self-reported rank and a verified reading is a labelled sample.
  //
  // samples: [{ reported, verified }] in MMR. Returns:
  //   n           how many players could be checked
  //   bias        mean(reported - verified) — positive means the field inflates its own ranks
  //   mae         mean absolute error
  //   trust       0-1 multiplier to apply to unverified self-reported confidences
  //   agreement   fraction landing within tolerance
  //
  // Below MIN_SAMPLES there is nothing to learn and trust stays 1 (i.e. behave as before) — a
  // measurement from two players is noise, and over-correcting on it would be its own inaccuracy.
  const SELF_REPORT_MIN_SAMPLES = 4;
  const SELF_REPORT_TOL = 120;          // MMR within which a self-report counts as honest

  function selfReportTrust(samples, opts) {
    opts = opts || {};
    const tol = opts.tol || SELF_REPORT_TOL;
    const min = opts.minSamples || SELF_REPORT_MIN_SAMPLES;
    const pts = (samples || []).filter((s) => s && Number.isFinite(s.reported) && Number.isFinite(s.verified));
    const out = { n: pts.length, bias: 0, mae: 0, trust: 1, agreement: 1, ok: false };
    if (pts.length < min) return out;
    let bias = 0, mae = 0, agree = 0;
    pts.forEach((s) => {
      const d = s.reported - s.verified;
      bias += d; mae += Math.abs(d);
      if (Math.abs(d) <= tol) agree++;
    });
    out.bias = Math.round(bias / pts.length);
    out.mae = Math.round(mae / pts.length);
    out.agreement = agree / pts.length;
    // Trust falls with disagreement, floored so a self-report never becomes worthless — it is still
    // the only reading we have for players no source can identify.
    out.trust = clamp(0.35 + 0.65 * out.agreement, 0.35, 1);
    out.ok = true;
    return out;
  }

  // Correct a self-reported MMR for the field's measured inflation. If this field over-reports by
  // +140 on average, an unverified self-report of 900 is really about 760. Only applied when the
  // bias is both real and worth acting on.
  const BIAS_MIN = 40;
  function debiasSelfReport(mmr, trust) {
    if (!Number.isFinite(mmr) || !trust || !trust.ok) return mmr;
    if (Math.abs(trust.bias) < BIAS_MIN) return mmr;
    return mmr - trust.bias;
  }

  // ── Tier ladder population ─────────────────────────────────────────────────
  // The default ladder tops out at S=1600, but a region may simply have nobody at S or X right now
  // (as in EU and NA at present). A self-reported "S" then maps to an ELO that no living player in
  // that region holds, and one bad sheet entry rockets a team to the top of the board.
  //
  // Given the tiers actually observed, clamp anything above the highest populated tier back to it
  // plus one gap — enough to keep the claim ordered above real players without inventing a number
  // the region cannot produce.
  function capToPopulatedTiers(mmr, populatedTiers, midpoints, opts) {
    if (!Number.isFinite(mmr)) return mmr;
    const mids = midpoints || SIXMANS_TIER_DEFAULTS;
    const pop = (populatedTiers || []).map((t) => tierIndex(t)).filter((i) => i >= 0);
    if (!pop.length) return mmr;
    const top = Math.max.apply(null, pop);
    if (top >= mids.length - 1) return mmr;                 // ladder fully populated, nothing to cap
    const gap = (opts && opts.gap) || 75;
    const ceiling = (mids[top] || SIXMANS_TIER_DEFAULTS[top]) + gap;
    return Math.min(mmr, ceiling);
  }

  // Which tiers actually have players in this sample — feeds capToPopulatedTiers.
  function populatedTiers(samples, minCount) {
    const need = minCount || 1;
    const counts = SIXMANS_TIERS.map(() => 0);
    (samples || []).forEach((s) => {
      const i = tierIndex(s && (s.tier != null ? s.tier : s));
      if (i >= 0) counts[i]++;
    });
    return SIXMANS_TIERS.filter((t, i) => counts[i] >= need);
  }

  const api = { SRC_CONF, snapRankValue, fitCalibration, correlate, sourceConfidence, resolveApply, clamp,
    SIXMANS_TIERS, SIXMANS_TIER_DEFAULTS, tierIndex, mmrFromTier, tierFromMMR, calibrateTierMidpoints, correlateMMR, scoreFromRank, blendEstimates,
    PRIOR_BASE, PRIOR_SLOPE, imputedValue, selfReportTrust, debiasSelfReport, capToPopulatedTiers, populatedTiers,
    SELF_REPORT_MIN_SAMPLES, SELF_REPORT_TOL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SeedResolveCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
