// backend/director/cs2-duel.js — predicts the CS2 gunfight that is about to happen, so the Director
// can put the camera on it BEFORE the first shot instead of after the kill.
//
// From GSI (observer client, ~10 updates a second) each alive player has a position {x, y, z} and a
// view direction {x, y}. For every CT/T pair it scores:
//   range    — fights happen inside ~2000 units; the closer, the sooner.
//   lineup   — how well each player's view points at the other (cosine of the angle). One player
//              aiming at the other is someone holding an angle; both aiming is a duel already on.
//   closing  — distance shrinking over the last half second (someone is peeking / pushing).
//   height   — more than ~180 units apart vertically is usually another floor: heavily discounted.
// GSI has no map geometry, so a wall between two players cannot be seen; the view lineup is the
// proxy (players pre-aim the angles an enemy can appear from).
//
// The POV to watch is the player the fight will be seen best from: the one whose view lines up on the
// enemy (their crosshair is where the enemy will appear). Ties go to the player already on screen, so
// the camera doesn't flip between the two sides of the same fight.
'use strict';

const RANGE_MAX = 2200;     // units: beyond this, no duel
const RANGE_NEAR = 450;     // units: at or inside this, range score is full
const RUN_SPEED = 250;      // units/s, knife-out run speed; closing speed is measured against it
const FLOOR_GAP = 180;      // units of height that usually mean another floor
const HISTORY_MS = 600;     // how far back closing speed looks

const len = (v) => Math.sqrt(v.x * v.x + v.y * v.y);
const clamp01 = (n) => Math.max(0, Math.min(1, n));
// 0 when the view is 45° or more off, 1 when it points straight at the other player.
const aimScore = (cos) => clamp01((cos - 0.707) / (0.985 - 0.707));

function lineup(from, to) {
  if (!from.fwd || !from.pos || !to.pos) return 0;
  const d = { x: to.pos.x - from.pos.x, y: to.pos.y - from.pos.y };
  const dl = len(d), fl = len(from.fwd);
  if (!dl || !fl) return 0;
  return (d.x * from.fwd.x + d.y * from.fwd.y) / (dl * fl);
}

function createDuelPredictor() {
  const hist = new Map();   // pairKey -> [{t, d}] recent distances

  function closingSpeed(key, d, now) {
    const h = hist.get(key) || [];
    h.push({ t: now, d });
    while (h.length > 2 && now - h[0].t > HISTORY_MS) h.shift();
    hist.set(key, h);
    const first = h[0];
    const dt = (now - first.t) / 1000;
    return dt > 0.15 ? (first.d - d) / dt : 0;   // positive = getting closer
  }

  // players: [{ steamid, name, team:'CT'|'T', alive, pos:{x,y,z}, fwd:{x,y}, health }]
  // Returns pairs scoring above `min`, best first: { a, b, watch, score, dist, reason }.
  function predict(players, { now = Date.now(), observedId = '', min = 0.5 } = {}) {
    const alive = (players || []).filter((p) => p && p.alive && p.pos);
    const ct = alive.filter((p) => p.team === 'CT');
    const t = alive.filter((p) => p.team === 'T');
    const out = [];
    const seen = new Set();
    for (const a of ct) {
      for (const b of t) {
        const key = a.steamid + '|' + b.steamid;
        seen.add(key);
        const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const closing = closingSpeed(key, dist, now);
        if (dist > RANGE_MAX) continue;
        const range = clamp01((RANGE_MAX - dist) / (RANGE_MAX - RANGE_NEAR));
        const la = aimScore(lineup(a, b)), lb = aimScore(lineup(b, a));
        const aim = Math.max(la, lb) * 0.7 + Math.min(la, lb) * 0.3;   // one holding counts; both = duel on
        const close = clamp01(closing / RUN_SPEED);
        const dz = (a.pos.z != null && b.pos.z != null) ? Math.abs(a.pos.z - b.pos.z) : 0;
        const floor = dz > FLOOR_GAP ? 0.35 : 1;
        // Lineup matters most; range and closing make it imminent.
        const score = (range * 0.35 + aim * 0.45 + close * 0.2) * floor * (aim > 0 ? 1 : 0.5);
        if (score < min) continue;
        // Whose POV: the one lined up on the enemy; on a tie (both aiming, within 0.15) stay on screen.
        let watch = la >= lb ? a : b;
        if (Math.abs(la - lb) < 0.15 && (observedId === a.steamid || observedId === b.steamid)) watch = observedId === a.steamid ? a : b;
        const other = watch === a ? b : a;
        const both = la > 0.5 && lb > 0.5;
        const reason = both ? `Duel: ${watch.name} and ${other.name} lined up on each other`
          : close > 0.4 ? `${other.name} pushing into ${watch.name}'s angle`
            : `${watch.name} holding the angle on ${other.name}`;
        out.push({ a, b, watch, other, score, dist: Math.round(dist), reason });
      }
    }
    // Forget pairs that are gone (deaths, round end).
    for (const k of hist.keys()) if (!seen.has(k)) hist.delete(k);
    return out.sort((x, y) => y.score - x.score);
  }

  function reset() { hist.clear(); }
  return { predict, reset };
}

module.exports = { createDuelPredictor, lineup, aimScore, RANGE_MAX };
