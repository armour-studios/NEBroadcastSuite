/* seed-power-core.js — ONE power rating per team, on ONE scale.
 *
 * WHY THIS EXISTS. The old ordering split the field in two and ranked the halves by different
 * things: seedAutoScoreRows() ordered teams that had event history by placementScore and stated
 * outright that "a rank never moves them", while teams without history were ordered by a placement
 * score reverse-engineered from their 6mans ranks. Which half a team landed in depended on whether
 * its NAME matched past standings, so a rebrand flipped a veteran team onto the rank basis. Two
 * incompatible orderings interleaved in one list is what "the ranks are fighting each other" is.
 *
 * Here every team is rated the same way:
 *
 *     power = rosterMMR  +  resultsAdjustment
 *
 * rosterMMR is the skill backbone (6mans exact ELO, tracker.gg fallback, already blended per player
 * by seed-resolve-core). resultsAdjustment is how much a team OVER- or UNDER-performs what its
 * roster says it should do, expressed in MMR points and bounded. So results always count and skill
 * always counts, for every team — nobody is ordered on a different basis to their neighbour.
 *
 * The residual is measured in STANDARD SCORES across the field, not through a least-squares fit.
 * The fit approach (seed-resolve-core's fitCalibration/scoreFromRank) needs >= 3 anchor teams
 * carrying both signals, a positive slope and a sane spread; when any of that fails it silently
 * falls back and teams pile up at the bottom. z-scores have no degenerate case, and unlike
 * percentiles they do not compress at the ends of the field — under percentile residual the
 * top-ranked team can only ever LOSE ground against its own skill and collects a phantom penalty
 * however well it plays.
 *
 * Ratings are then shrunk toward the field median in proportion to how little of the roster was
 * actually measured, so a team with one resolved player out of three cannot out-seed a fully
 * measured squad on the strength of a guess.
 *
 * Pure: no DOM, no network, no clock. Runs in the control panel (script tag) and the backend
 * (require) off one implementation — same UMD pattern as seed-resolve-core.js / identity-core.js,
 * so the desktop studio and the website's seeding can share one source of truth instead of
 * disagreeing.
 */
(function (root) {
  'use strict';

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // ── Weight presets ─────────────────────────────────────────────────────────
  // How far results are allowed to move a team off its roster skill.
  //   resultsWeight — fraction of the measured over/under-performance actually applied.
  //   capFraction   — hard ceiling on the adjustment, as a fraction of the field's MMR spread.
  // 'skill' keeps 6mans/tracker as the backbone and lets results adjust it (the setting for a
  // scene whose rosters churn faster than its placement history ages).
  const PRESETS = {
    skill:    { resultsWeight: 0.35, capFraction: 0.50, label: 'Skill-weighted' },
    balanced: { resultsWeight: 0.60, capFraction: 0.75, label: 'Balanced' },
    results:  { resultsWeight: 0.90, capFraction: 1.10, label: 'Results-weighted' },
  };

  // Roster aggregation. A team is not its best player (the old "Best player" default, which let one
  // smurf set a 3-stack's seed), and it is not a naive average either — an average treats a coarse
  // tier guess as equal evidence to an exact ELO, which is what made mixed-rank rosters seed
  // erratically. Players are weighted by how well MEASURED they are, then the result is docked for
  // roster spread.
  const WEIGHT_FLOOR   = 0.35;   // weight of a completely unmeasured slot vs a fully measured one
  const CONF_EXP       = 1.5;    // how sharply confidence separates a measured player from a guess
  const IMPUTED_CONF   = 20;     // confidence assigned to a roster slot we have no reading for
  const ROSTER_SLOT_WEIGHT = 0.85;  // weight of an unresolved slot: nearly a full player, because it IS one
  const SPREAD_PENALTY = 0.25;   // MMR docked per 1 sd of roster spread (the weak-link discount)
  const ROSTER_DECAY   = 0.8;    // legacy export; no longer used by rosterSkill()

  // ── Roster skill ───────────────────────────────────────────────────────────
  // players: [{ mmr, confidence, identityTier }] — mmr may be null for an unresolved player.
  //
  // Missing players are IMPUTED, not skipped. Skipping them rates a team with one known strong
  // player as if that player were the whole roster, which is how thin-data teams used to seed far
  // too high. The stand-in value is the caller-supplied field floor (a low percentile of the known
  // field), and every imputed slot drags the team's confidence down.
  // Pulled from seed-resolve-core when present (both are loaded together in the panel and the
  // backend); falls back to a local blend so this module stays standalone-testable.
  function imputedValue(knownMean, fieldMid, coverage) {
    const RC = root.SeedResolveCore;
    if (RC && typeof RC.imputedValue === 'function') return RC.imputedValue(knownMean, fieldMid, coverage);
    if (!Number.isFinite(knownMean)) return fieldMid;
    if (!Number.isFinite(fieldMid)) return knownMean;
    const w = clamp(0.25 + 0.65 * clamp(coverage, 0, 1), 0, 1);
    return w * knownMean + (1 - w) * fieldMid;
  }

  function rosterSkill(players, opts) {
    opts = opts || {};
    const size = opts.rosterSize || (players || []).length || 1;
    const floor = Number.isFinite(opts.floorMMR) ? opts.floorMMR : null;
    const spreadK = opts.spreadK != null ? opts.spreadK : SPREAD_PENALTY;

    const known = (players || []).filter((p) => p && Number.isFinite(p.mmr));
    const missing = Math.max(0, size - known.length);
    if (!known.length) return { mmr: null, known: 0, missing, imputed: missing, confidence: 0, spread: null };

    // Every roster slot, measured or not. An unmeasured slot is still a player who will be on the
    // pitch, so it keeps a real (if low-confidence) weight rather than being dropped — dropping it
    // is what let a team with one resolved star out-rate a fully measured squad.
    const slots = known.map((p) => ({ mmr: p.mmr, conf: clamp(p.confidence || 0, 0, 100) }));
    // ROSTER COHERENCE. An unresolved slot is estimated from its own team-mates, pulled toward the
    // field's middle by how little of the roster we measured — not stood at the field floor.
    // Players team up with people near their own level, so a team-mate of an A-rank player is far
    // more likely to be A/B than to be the weakest player in the event. Someone who simply does not
    // play 6mans is an UNKNOWN, not a BAD player, and flooring them buried every team with players
    // outside the 6mans scene.
    const knownMean = known.reduce((a, p) => a + p.mmr, 0) / known.length;
    const coverage0 = known.length / size;
    const stand = imputedValue(knownMean, Number.isFinite(opts.fieldMid) ? opts.fieldMid : floor, coverage0);
    for (let i = 0; i < missing; i++) {
      slots.push({ mmr: Number.isFinite(stand) ? stand : knownMean, conf: IMPUTED_CONF, imputed: true });
    }

    // Weight by how well MEASURED each player is, not by where they sit in the roster.
    //
    // This is the fix for mixed-rank rosters seeding inconsistently. A tier-only reading (tracker.gg,
    // a CSV letter, a 6mans profile with no ELO) collapses to that tier's midpoint and is far
    // coarser than an exact rl6mans ELO — but the old aggregation weighted purely by rank ORDER and
    // ignored confidence entirely, so a wild guess counted exactly as much as a measured number.
    // Mixed rosters are precisely where some players resolve exactly and others do not, which is why
    // the inconsistency showed up there and nowhere else.
    //
    // The floor keeps every slot meaningful: even a pure guess is a real player, worth ~0.35 of a
    // measured one rather than nothing.
    // An IMPUTED slot is weighted as a roster slot, not as a measurement. Confidence weighting exists
    // to separate a precise ELO from a coarse tier guess AMONG PLAYERS WE HAVE READ; an unresolved
    // player is a different question — they are definitely playing, we just don't know how well.
    // Weighting them by their (necessarily low) confidence let the team be rated on its best two,
    // which is how a roster with an unknown could edge out its own fully-measured twin. The
    // uncertainty belongs in team confidence and in ratePower's shrinkage, both of which already
    // carry it.
    const wOf = (s) => (s.imputed ? ROSTER_SLOT_WEIGHT
      : WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * Math.pow(s.conf / 100, CONF_EXP));
    let wsum = 0, msum = 0;
    slots.forEach((s) => { const w = wOf(s); wsum += w; msum += s.mmr * w; });
    const mean = wsum > 0 ? msum / wsum : slots[0].mmr;

    // Weighted spread, and a penalty for it. A lopsided roster underperforms its own average in team
    // play — in 3v3 the weakest rotation is what gets targeted — so an uneven line-up should NOT
    // out-seed an even one of the same mean. The old rank-order decay did the opposite: it paid a
    // bonus for being top-heavy, so [1000,700,700] beat [800,800,800] despite identical averages.
    let vsum = 0;
    slots.forEach((s) => { const w = wOf(s); vsum += w * (s.mmr - mean) * (s.mmr - mean); });
    const sd = wsum > 0 ? Math.sqrt(vsum / wsum) : 0;
    const mmr = mean - spreadK * sd;

    const meanConf = known.reduce((s, p) => s + (p.confidence || 0), 0) / known.length;
    const coverage = known.length / size;
    return {
      mmr: Math.round(mmr),
      mean: Math.round(mean), spread: Math.round(sd),
      known: known.length, missing, imputed: missing,
      confidence: Math.round(clamp(meanConf * coverage, 0, 100)),
    };
  }

  // ── Percentiles ────────────────────────────────────────────────────────────
  // Fractional rank of each value within the list, 0 (lowest) .. 1 (highest). Ties share the mean
  // percentile so equal inputs cannot induce an arbitrary ordering downstream.
  function percentiles(values) {
    const idx = values.map((v, i) => ({ v, i })).filter((x) => Number.isFinite(x.v));
    if (!idx.length) return values.map(() => null);
    idx.sort((a, b) => a.v - b.v);
    const out = values.map(() => null);
    const n = idx.length;
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1].v === idx[i].v) j++;
      const pct = n === 1 ? 0.5 : ((i + j) / 2) / (n - 1);
      for (let k = i; k <= j; k++) out[idx[k].i] = pct;
      i = j + 1;
    }
    return out;
  }

  // Standard scores. Used instead of percentiles for the results residual: percentiles compress at
  // the ends of the field, so the highest-ranked team can only ever LOSE percentile points against
  // its own skill and picks up a phantom penalty no matter how well it does. z-scores are linear in
  // the underlying value, so a team that is both top-skill and top-results nets out at ~0.
  function zScores(values) {
    const vals = values.filter(Number.isFinite);
    if (vals.length < 2) return values.map((v) => (Number.isFinite(v) ? 0 : null));
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const varc = vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length;
    const sd = Math.sqrt(varc);
    if (!(sd > 0)) return values.map((v) => (Number.isFinite(v) ? 0 : null));
    return values.map((v) => (Number.isFinite(v) ? (v - mean) / sd : null));
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = clamp(q, 0, 1) * (sorted.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // ── The rating ─────────────────────────────────────────────────────────────
  // teams: [{
  //   key, name,
  //   players: [{ mmr, confidence, identityTier }],
  //   resultsScore,       // 0-100 placement rating (our events + circuits + league), or null
  //   resultsConfidence,  // 0-100, how much history is behind that score
  //   seedNum,            // platform's own seed, used only as the last tiebreak
  // }]
  // opts: { preset|weights, rosterSize, minSpread }
  //
  // Returns every team with power, its parts, a confidence, and a human-readable basis — plus the
  // ordered board. One pass, one scale, no branch where a team is ranked on a different basis.
  function ratePower(teams, opts) {
    opts = opts || {};
    const W = Object.assign({}, PRESETS[opts.preset || 'skill'] || PRESETS.skill, opts.weights || {});
    const list = (teams || []).map((t) => Object.assign({}, t));

    // Pass 1 — roster skill for teams that have any measured player. The field floor is the 15th
    // percentile of measured players, so imputation stands in a plausibly weak player rather than
    // a zero (which would make one missing player catastrophic) or the roster mean (which would
    // make missing players free).
    const allPlayerMMR = [];
    list.forEach((t) => (t.players || []).forEach((p) => { if (p && Number.isFinite(p.mmr)) allPlayerMMR.push(p.mmr); }));
    allPlayerMMR.sort((a, b) => a - b);
    const floorMMR = allPlayerMMR.length ? quantile(allPlayerMMR, 0.15) : null;
    // Median of measured PLAYERS (teams are not rated yet at this point) — the "field middle" an
    // unresolved slot is pulled toward.
    const preMedian = allPlayerMMR.length ? quantile(allPlayerMMR, 0.5) : null;

    list.forEach((t) => {
      t._skill = rosterSkill(t.players, { rosterSize: opts.rosterSize, floorMMR, fieldMid: preMedian, decay: opts.decay });
    });

    // Field spread — the yardstick the results adjustment is measured in. Guarded with a floor so a
    // field where everyone ranks identically cannot produce a zero-width (or explosive) adjustment.
    const skillVals = list.map((t) => t._skill.mmr).filter(Number.isFinite).sort((a, b) => a - b);
    const spread = skillVals.length >= 2
      ? Math.max((quantile(skillVals, 0.9) - quantile(skillVals, 0.1)), opts.minSpread || 200)
      : (opts.minSpread || 200);
    const medianMMR = skillVals.length ? quantile(skillVals, 0.5) : null;

    // Pass 2 — teams with results but no measurable roster get their skill IMPUTED from where they
    // finished, mapped onto this field's own skill distribution. That is what keeps them on the one
    // scale instead of spawning the second ordering this module exists to remove.
    const resPctAll = percentiles(list.map((t) => (t.resultsScore != null ? t.resultsScore : null)));
    list.forEach((t, i) => {
      if (t._skill.mmr == null && resPctAll[i] != null && skillVals.length >= 2) {
        t._skill = {
          mmr: Math.round(quantile(skillVals, resPctAll[i])),
          known: 0, missing: opts.rosterSize || (t.players || []).length, imputed: -1,
          confidence: Math.round(25 * clamp((t.resultsConfidence || 0) / 100, 0, 1)),
        };
        t._skillFromResults = true;
      }
    });

    // Pass 3 — the residual, in standard scores. z(results) - z(skill): positive means the team
    // finishes further above the field's average than its roster ranks do, i.e. genuine measured
    // over-performance. That difference is the only part of a placement record that roster skill
    // does not already account for, so it is the only part allowed to move the rating.
    const skillZ = zScores(list.map((t) => t._skill.mmr));
    const resZ   = zScores(list.map((t) => (t.resultsScore != null ? t.resultsScore : null)));
    const skillPct = percentiles(list.map((t) => t._skill.mmr));
    const resPct   = percentiles(list.map((t) => (t.resultsScore != null ? t.resultsScore : null)));
    // MMR per 1 sd of skill — the unit the residual is paid out in.
    const sdMMR = skillVals.length >= 2
      ? Math.sqrt(skillVals.reduce((s, v) => { const m = skillVals.reduce((a, b) => a + b, 0) / skillVals.length; return s + (v - m) * (v - m); }, 0) / skillVals.length)
      : (opts.minSpread || 200) / 2;
    const cap = spread * W.capFraction;

    list.forEach((t, i) => {
      const sz = skillZ[i], rz = resZ[i];
      let adj = 0, residual = null;
      // A team whose skill was imputed FROM its results has no independent second signal — applying
      // the residual would be feeding the same number back in and double-counting it.
      if (sz != null && rz != null && !t._skillFromResults) {
        residual = rz - sz;                                   // in standard deviations
        const conf = clamp((t.resultsConfidence != null ? t.resultsConfidence : 60) / 100, 0, 1);
        adj = clamp(residual * sdMMR * W.resultsWeight * conf, -cap, cap);
      }
      t.rosterMMR    = t._skill.mmr;
      t.rosterMean   = t._skill.mean != null ? t._skill.mean : null;
      t.rosterSpread = t._skill.spread != null ? t._skill.spread : null;
      t.rosterKnown  = t._skill.known;
      t.rosterMissing= t._skill.missing;
      t.resultsAdj  = Math.round(adj);
      t.residual    = residual == null ? null : Math.round(residual * 100) / 100;   // sd
      t.skillPct    = skillPct[i] == null ? null : Math.round(skillPct[i] * 100);
      t.resultsPct  = resPct[i] == null ? null : Math.round(resPct[i] * 100);

      // One confidence for the whole rating: how much of the roster we measured, lifted a little
      // when a real results record agrees.
      const rc = clamp((t.resultsConfidence || 0) / 100, 0, 1);
      t.confidence = t._skill.mmr == null ? 0
        : Math.round(clamp(t._skill.confidence * (t._skillFromResults ? 1 : (0.75 + 0.25 * rc)) + (t._skillFromResults ? 0 : rc * 12), 0, 99));

      // Shrink toward the field median in proportion to how little we actually know. A rating built
      // on one resolved player out of three is a guess wearing a number; without this it can
      // out-seed a fully-measured roster on evidence the producer would never accept if asked.
      // A fully-confident team is untouched.
      const raw = t._skill.mmr == null ? null : t._skill.mmr + adj;
      if (raw == null || medianMMR == null) {
        t.power = raw == null ? null : Math.round(raw);
        t.shrunk = 0;
      } else {
        const keep = 0.4 + 0.6 * (t.confidence / 100);
        const shrunk = medianMMR + (raw - medianMMR) * keep;
        t.power  = Math.round(shrunk);
        t.shrunk = Math.round(shrunk - raw);
      }

      t.basis = t.power == null ? 'none'
        : t._skillFromResults ? 'results'
        : (rz != null ? 'both' : 'skill');
      t.explain = explain(t, W);
      delete t._skill; delete t._skillFromResults;
    });

    // Order 1..N. Everything rated sorts on the single power number; unrated teams sink to the
    // bottom in platform-seed order rather than being scattered through the board.
    const ordered = list.slice().sort((a, b) => {
      if (a.power != null && b.power != null) {
        if (a.power !== b.power) return b.power - a.power;
        if (a.confidence !== b.confidence) return b.confidence - a.confidence;
        const ar = a.resultsScore != null ? a.resultsScore : -1, br = b.resultsScore != null ? b.resultsScore : -1;
        if (ar !== br) return br - ar;
      } else if (a.power != null || b.power != null) {
        return a.power != null ? -1 : 1;
      }
      return (a.seedNum || 99999) - (b.seedNum || 99999);
    });
    ordered.forEach((t, i) => { t.seed = i + 1; });

    return {
      teams: ordered,
      field: {
        spread: Math.round(spread), median: medianMMR == null ? null : Math.round(medianMMR),
        floorMMR: floorMMR == null ? null : Math.round(floorMMR),
        cap: Math.round(cap), preset: opts.preset || 'skill', weights: W,
        rated: ordered.filter((t) => t.power != null).length, total: ordered.length,
      },
    };
  }

  // One line a producer can read on the card, saying what moved this team and why.
  function explain(t, W) {
    if (t.power == null) return 'No rank and no results — nothing to seed on.';
    if (t.basis === 'results') return `No player ranks — placed from event results (${t.resultsScore != null ? Math.round(t.resultsScore) : '?'}/100).`;
    // Spell out the spread discount. "Different players of different ranks" is exactly the case a
    // producer cannot eyeball, so the row has to say what an uneven line-up cost rather than just
    // presenting a number that looks lower than the roster's average suggests it should be.
    const dock = (t.rosterMean != null && t.rosterMMR != null) ? t.rosterMean - t.rosterMMR : 0;
    const spread = (t.rosterSpread != null && dock >= 8)
      ? ` (avg ${t.rosterMean}, −${dock} for an uneven roster — spread ${t.rosterSpread})` : '';
    const gaps = t.rosterMissing ? ` ${t.rosterMissing} slot${t.rosterMissing !== 1 ? 's' : ''} unresolved.` : '';
    const base = `Roster ${t.rosterMMR}${spread}${gaps}`;
    if (t.basis === 'skill') return `${base} · no event history yet, so results don't move it.`;
    const dir = t.resultsAdj > 0 ? 'over' : t.resultsAdj < 0 ? 'under' : 'in line with';
    const held = (t.shrunk && Math.abs(t.shrunk) >= 15)
      ? ` Held ${t.shrunk > 0 ? 'up' : 'back'} ${Math.abs(t.shrunk)} — only ${t.confidence}% of this roster is measured.` : '';
    if (!t.resultsAdj) return `${base} · results ${dir} what the roster suggests — no adjustment.${held}`;
    return `${base} ${t.resultsAdj > 0 ? '+' : ''}${t.resultsAdj} — finishes ${Math.abs(t.residual)} sd ${dir}performing its ranks.${held}`;
  }

  const api = { PRESETS, ROSTER_DECAY, ROSTER_SLOT_WEIGHT, imputedValue, WEIGHT_FLOOR, CONF_EXP, IMPUTED_CONF, SPREAD_PENALTY, clamp, rosterSkill, percentiles, zScores, quantile, ratePower, explain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SeedPowerCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
