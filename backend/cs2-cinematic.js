// backend/cs2-cinematic.js — scripted freezetime camera for CS2 (MyHUD-style "cinematic freezetime").
//
// During each freezetime the observer camera plays up to two slow moves (a start pose gliding to an
// end pose) over the map, then hands back to a player before the round goes live. Poses go to CS2
// through the network console (cs2-netcon.js) as `spec_goto x y z pitch yaw`, re-sent ~30x/sec with
// an ease-in-out so the move reads as a dolly, not a cut.
//
// Shots per map: producer-captured shots (state.csgo.cinematic.shots[map][i]) win; otherwise a
// starter shot orbits above each bombsite, built from the site world centres the radar already uses
// (overlay/csgo.html CS_MAPS[...].sites.*.w). Starters are a high aerial look-down so the camera
// sits above the roofs — they are a starting point, not a substitute for capturing real angles.
'use strict';

// Bombsite world centres [x, y, z] — same source as the radar (drweissbrot/cs-hud bombsites.json).
const SITES = {
  de_ancient:  { A: [-1406, 862, 68],     B: [797, 62, 144] },
  de_anubis:   { A: [1238, 1960, -192.5], B: [-1044, 692, -4] },
  de_dust2:    { A: [1112, 2480, 144],    B: [-1536, 2680, 48] },
  de_inferno:  { A: [1976, 434, 180],     B: [368, 2776, 192] },
  de_mirage:   { A: [-440, -2168, -168],  B: [-2048, 256, -151] },
  de_nuke:     { A: [688.5, -719, -367.5], B: [592, -1008, -748] },
  de_overpass: { A: [-2136, 662, 502],    B: [-1104, 64, 104] },
  de_train:    { A: [568, -17.5, -160.5], B: [52, -1279, -303] },
  de_vertigo:  { A: [-293.5, -621, 11791.5], B: [-2248, 797.5, 11758] },
  de_cache:    { A: [-239.5, 1754.5, 1703.5], B: [-46.5, -1260, 1677] }
};

const r1 = (n) => Math.round(n * 10) / 10;
function lookAt(cam, target) {
  const dx = target[0] - cam.x, dy = target[1] - cam.y, dz = target[2] - cam.z;
  const yaw = Math.atan2(dy, dx) * 180 / Math.PI;
  const pitch = -Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI;   // Source: +pitch looks down
  return { ...cam, pitch: r1(pitch), yaw: r1(yaw) };
}
// Starter orbit above one site: camera on the far side of the site (away from the other site),
// 520 up and 420 out, sweeping 50 degrees around it while it keeps the site centred.
function starterShot(site, other, label) {
  let dx = site[0] - other[0], dy = site[1] - other[1];
  const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
  const at = (deg) => {
    const a = deg * Math.PI / 180;
    const ox = dx * Math.cos(a) - dy * Math.sin(a), oy = dx * Math.sin(a) + dy * Math.cos(a);
    return lookAt({ x: r1(site[0] + ox * 420), y: r1(site[1] + oy * 420), z: r1(site[2] + 520) }, site);
  };
  return { name: label, from: at(-25), to: at(25), starter: true };
}
function starterShots(map) {
  const s = SITES[map];
  if (!s) return [];
  return [starterShot(s.A, s.B, 'A site'), starterShot(s.B, s.A, 'B site')];
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
function lerpYaw(a, b, t) { let d = ((b - a + 540) % 360) - 180; return a + d * t; }
function poseAt(shot, t) {
  const k = ease(Math.max(0, Math.min(1, t)));
  const f = shot.from, to = shot.to || shot.from;
  return { x: lerp(f.x, to.x, k), y: lerp(f.y, to.y, k), z: lerp(f.z, to.z, k), pitch: lerp(f.pitch, to.pitch, k), yaw: lerpYaw(f.yaw, to.yaw, k) };
}
const gotoCmd = (p) => `spec_goto ${r1(p.x)} ${r1(p.y)} ${r1(p.z)} ${r1(p.pitch)} ${r1(p.yaw)}`;
const POSE_RE = /setpos\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*;\s*setang\s+(-?[\d.]+)\s+(-?[\d.]+)/;

function createCinematic({ netcon, getConfig, onReturn, onStatus }) {
  let lastPhase = '', run = null;
  const status = (s) => { try { onStatus && onStatus(s); } catch (e) {} };

  function shotsFor(map) {
    const cfg = getConfig() || {};
    const custom = (cfg.shots && cfg.shots[map]) || [];
    const base = starterShots(map);
    const out = [0, 1].map((i) => (custom[i] && custom[i].from ? { ...custom[i], starter: false } : base[i])).filter(Boolean);
    return out;
  }

  function stop(returnCam) {
    if (!run) return;
    clearInterval(run.timer);
    const r = run; run = null;
    status({ playing: false });
    if (returnCam && r.returnCam) { try { onReturn && onReturn(); } catch (e) {} }
  }

  // Play `shots` across `seconds`, each shot taking an equal slice.
  function play(shots, seconds, returnCam) {
    stop(false);
    if (!shots.length || !netcon.isConnected()) return false;
    const total = Math.max(1, seconds) * 1000, slice = total / shots.length, t0 = Date.now();
    let lastIdx = -1;
    run = { returnCam, timer: setInterval(() => {
      const el = Date.now() - t0;
      if (el >= total) { stop(true); return; }
      const idx = Math.min(shots.length - 1, Math.floor(el / slice));
      if (idx !== lastIdx) { lastIdx = idx; status({ playing: true, shot: idx, name: shots[idx].name || ('Shot ' + (idx + 1)) }); }
      netcon.send(gotoCmd(poseAt(shots[idx], (el - idx * slice) / slice)));
    }, 33) };
    return true;
  }

  // Called on every CS2 GSI update.
  function onCsgo(cs) {
    const cfg = getConfig() || {};
    const phase = (cs && cs.phase) || '';
    const prev = lastPhase; lastPhase = phase;
    if (run && run.auto && phase !== 'freezetime') { stop(true); return; }
    if (!cfg.enabled || !netcon.isConnected()) return;
    if (phase !== 'freezetime' || prev === 'freezetime') return;
    if (!cs.map || cs.map.phase !== 'live') return;            // not warmup / halftime / gameover
    const secs = Number(cs.phaseEndsIn);
    const window = (isFinite(secs) && secs > 3 ? secs : 15) - 1.5;   // hand back ~1.5s before live
    if (window < 3) return;
    if (play(shotsFor(cs.map.name), window, true) && run) run.auto = true;
  }

  // Producer preview of one shot from the control panel (no hand-back afterwards).
  function preview(map, idx) {
    const shot = shotsFor(map)[idx];
    if (!shot) return false;
    return play([shot], 5, false);
  }

  // Read CS2's current camera pose (spectator free-roam) via `getpos`.
  async function capturePose() {
    const m = await netcon.query('getpos', POSE_RE);
    if (!m) return null;
    return { x: r1(+m[1]), y: r1(+m[2]), z: r1(+m[3]), pitch: r1(+m[4]), yaw: r1(+m[5]) };
  }

  return { onCsgo, preview, capturePose, shotsFor, stop: () => stop(false), isPlaying: () => !!run };
}

module.exports = { createCinematic, starterShots, poseAt, gotoCmd, SITES, POSE_RE };
