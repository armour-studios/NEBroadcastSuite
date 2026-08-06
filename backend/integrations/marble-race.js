// marble-race.js — chat-driven 3D obstacle-course game (Twitch/Kick/YouTube "!play" entry, or
// auto-entered from the live Twitch viewer list). No betting/currency — first marble across the
// finish line wins, that's it.
//
// Design notes:
// - The course is one continuous descending track built from 4 tilted "ramp" segments end-to-end
//   (start + bumper field -> windmill gauntlet -> zigzag baffles -> finish funnel), all primitive
//   geometry (boxes/spheres), no 3D models or textures needed.
// - Physics runs ONCE, headless, server-side (cannon-es, no renderer) — the result is sampled into a
//   keyframe timeline and broadcast as plain data; every connected overlay just replays those exact
//   keyframes in Three.js. No client ever runs its own physics, so every OBS source/preview window
//   shows an identical outcome, and the windmills/baffles' collision chaos can never diverge between
//   viewers.
// - Entry lifecycle: idle -> entry (countdown, "!play" and auto-enter both work) -> locked (physics
//   computing) -> finished. Owned entirely by this manager (its own single setTimeout for the entry
//   window), mirroring the lifecycle shape of the earlier betting version minus all money/payout logic.
const CANNON = require('cannon-es');

// ── Course geometry — a fixed, hand-authored track. MUST be mirrored by matching constants in
// overlay/marble-race.html's Three.js scene (this geometry is never sent over the wire — only marble
// positions are — so both sides drawing the identical layout is what keeps the replay lining up
// visually against what the marbles actually bounced off).
// Width is deliberately CONSTANT across every ramp (verified empirically — tapering it stage-to-stage
// creates a rail-boundary mismatch exactly at each joint: a marble near the old wider edge ends up
// outside the new, narrower rail at the exact instant it crosses over, and falls through the gap
// beside the new segment's floor. The "funnel" narrowing is achieved decoratively on the overlay
// instead, not by actually narrowing the physics track.
const TRACK_WIDTH = 18;
// 4 stages (same obstacle-zone COUNT as the original proven design — doubling to 6 stages was tried
// and reverted: total course time ballooned way out of proportion to the extra distance, i.e. marbles
// were genuinely stalling in the obstacle zones, not just taking longer to cover more ground).
// Longer and noticeably STEEPER (~27° vs ~21° originally) than the very first version — steeper means
// gravity dominates friction/obstacle drag more decisively, so marbles keep moving briskly through a
// bigger, denser obstacle field instead of crawling. Verified empirically after this change.
const RAMPS = [
  // { zStart, yStart, zEnd, yEnd, width } — a straight tilted platform from (zStart,yStart) to (zEnd,yEnd)
  { zStart: 0,   yStart: 132, zEnd: 60,  yEnd: 102, width: TRACK_WIDTH },   // 0: start + bumper field
  { zStart: 60,  yStart: 102, zEnd: 140, yEnd: 62,  width: TRACK_WIDTH },   // 1: windmill gauntlet
  { zStart: 140, yStart: 62,  zEnd: 220, yEnd: 22,  width: TRACK_WIDTH },   // 2: zigzag baffles
  { zStart: 220, yStart: 22,  zEnd: 260, yEnd: 0,   width: TRACK_WIDTH },   // 3: finish funnel
];
const FINISH_Z = 250;
const RAMP_THICKNESS = 2;
// Tall enough that a bounce off the slope-angle kink between two ramp segments can't hop over —
// verified empirically (a short 4-unit rail let edge-riding marbles launch clean over it at a joint).
const RAIL_HEIGHT = 16;
const MARBLE_RADIUS = 1.4;
const SAMPLE_INTERVAL_MS = 100;
const STEP_MS = 1000 / 60;
const ENTRY_CAP = 150;

function round2(n) { return Math.round(n * 100) / 100; }

// A tilted platform + two side rails, all static. Rotation is around the world X axis only, so a
// body's local/world X coordinate never changes under this rotation — that's what makes the rail
// placement below (offset in X, same rotation as the floor) land correctly without extra math.
function _addRamp(world, r) {
  const dz = r.zEnd - r.zStart, dy = r.yEnd - r.yStart;
  const length = Math.hypot(dz, dy);
  const midZ = (r.zStart + r.zEnd) / 2, midY = (r.yStart + r.yEnd) / 2;
  const angle = Math.atan2(dy, dz);

  const floorMat = new CANNON.Material('ramp');
  floorMat.friction = 0.25;
  floorMat.restitution = 0.25;
  const floorShape = new CANNON.Box(new CANNON.Vec3(r.width / 2, RAMP_THICKNESS / 2, length / 2));
  const floor = new CANNON.Body({ mass: 0, shape: floorShape, position: new CANNON.Vec3(0, midY, midZ), material: floorMat });
  floor.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -angle);
  world.addBody(floor);

  [-1, 1].forEach((side) => {
    const railShape = new CANNON.Box(new CANNON.Vec3(0.5, RAIL_HEIGHT / 2, length / 2));
    const rail = new CANNON.Body({ mass: 0, shape: railShape, position: new CANNON.Vec3(side * (r.width / 2), midY, midZ) });
    rail.quaternion.copy(floor.quaternion);
    world.addBody(rail);
  });
  return floor;
}

function _pointOnRamp(r, t) {
  return { z: r.zStart + (r.zEnd - r.zStart) * t, y: r.yStart + (r.yEnd - r.yStart) * t };
}

// Static spheres scattered over a ramp for chaotic spread — the 3D evolution of a pachinko peg
// field. Deliberately SPARSE — verified empirically that a denser field (more/bigger bumpers) leaves
// gaps narrower than a marble's diameter, damming every marble at the first row: they pile up,
// jitter against each other in an unstable resting contact, and eventually get launched
// unpredictably (including backward) from the resulting numerical energy buildup.
function _addBumpers(world, r) {
  const rows = 3, perRow = 3;
  for (let row = 0; row < rows; row++) {
    const t = (row + 1) / (rows + 1);
    const p = _pointOnRamp(r, t);
    for (let i = 0; i < perRow; i++) {
      const x = -r.width / 2 + (i + 0.5) * (r.width / perRow) + (row % 2 === 0 ? 0 : (r.width / perRow) / 2);
      if (Math.abs(x) > r.width / 2 - 1.5) continue;
      const body = new CANNON.Body({ mass: 0, shape: new CANNON.Sphere(0.8), position: new CANNON.Vec3(x, p.y + 1.2, p.z) });
      world.addBody(body);
    }
  }
}

// Kinematic "windmill" paddles on a ramp — position is fixed, rotation is driven explicitly every
// physics step (not force-driven), which is what "kinematic" means to cannon-es. This is the
// obstacle-course spectacle element a flat drop can't produce.
function _addWindmills(world, r, count = 4) {
  const paddles = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / (count + 1);
    const p = _pointOnRamp(r, t);
    const armLen = r.width * 0.8;
    const shape = new CANNON.Box(new CANNON.Vec3(armLen / 2, 1, 0.6));
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, shape, position: new CANNON.Vec3(0, p.y + 3, p.z) });
    body._angle = 0;
    body._angularSpeed = (i % 2 === 0 ? 1 : -1) * (1.1 + i * 0.35);
    world.addBody(body);
    paddles.push(body);
  }
  return paddles;
}

// Static angled wall segments on a ramp, alternating side to side — forces marbles to weave,
// creating the visible jockeying-for-position moment a straight chute wouldn't have.
function _addZigzag(world, r, count = 5) {
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const p = _pointOnRamp(r, t);
    const side = i % 2 === 0 ? 1 : -1;
    const len = r.width * 0.7;
    const shape = new CANNON.Box(new CANNON.Vec3(len / 2, 1.5, 0.6));
    const body = new CANNON.Body({ mass: 0, shape, position: new CANNON.Vec3(side * (r.width * 0.16), p.y + 1.5, p.z) });
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), side * 0.55);
    world.addBody(body);
  }
}

// A large flat catch-net spanning well below and along the whole (now longer) track — insurance
// against a marble tunneling through geometry at a ramp-to-ramp angle kink (a fast sphere vs. a thin
// box, one physics step apart, is a classic tunneling case) or squeezing past a rail. Without this, a
// tunneled marble free-falls forever and its keyframe positions blow up to nonsense values instead of
// just settling somewhere.
function _addSafetyNet(world) {
  const shape = new CANNON.Box(new CANNON.Vec3(400, 5, 400));
  const body = new CANNON.Body({ mass: 0, shape, position: new CANNON.Vec3(0, -40, RAMPS[RAMPS.length - 1].zEnd / 2) });
  world.addBody(body);
}

// Stage -> obstacle type, by ramp index. Reuses the same 3 proven obstacle builders across more
// stages (rather than inventing new, untested obstacle geometry) to extend the course length/variety
// with the least physics risk.
const STAGE_OBSTACLES = ['bumpers', 'windmill', 'zigzag', null];   // stage 3 = finish, undecorated

function _buildWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -30, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 10;
  RAMPS.forEach((r) => _addRamp(world, r));
  const windmills = [];
  RAMPS.forEach((r, i) => {
    const kind = STAGE_OBSTACLES[i];
    if (kind === 'bumpers') _addBumpers(world, r);
    else if (kind === 'windmill') windmills.push(..._addWindmills(world, r));
    else if (kind === 'zigzag') _addZigzag(world, r);
  });
  _addSafetyNet(world);
  return { world, windmills };
}

// Clamp marble speed each step — restitution/friction contact chains can occasionally inject energy
// (a known numerical-instability pattern in iterative solvers) and produce runaway velocities that
// tunnel straight through thin static geometry between one step and the next. A generous cap well
// above any realistic rolling/bouncing speed on this course closes that off without visibly affecting
// normal motion.
const MAX_SPEED = 70;
function _clampVelocities(marbles) {
  marbles.forEach((m) => {
    const v = m.body.velocity;
    const speed = v.length();
    if (speed > MAX_SPEED) v.scale(MAX_SPEED / speed, v);
  });
}

// Marbles wedged against a bumper/rail/baffle in an unstable resting contact can sit essentially
// motionless indefinitely (observed directly on a real run — a marble stuck for the whole race).
// Every STUCK_CHECK_INTERVAL_MS, check each marble's z-progress since its last check; if it hasn't
// advanced meaningfully, give it a small random impulse (forward + lateral + a touch of lift) to
// break the equilibrium. This never fires on a marble that's genuinely rolling, only ones that have
// stalled.
const STUCK_CHECK_INTERVAL_MS = 1200;
const STUCK_PROGRESS_THRESHOLD = 1.2;
const UNSTICK_IMPULSE = 14;
function _unstickMarbles(marbles, elapsedMs) {
  marbles.forEach((m) => {
    if (elapsedMs < m.nextStuckCheckAt) return;
    m.nextStuckCheckAt = elapsedMs + STUCK_CHECK_INTERVAL_MS;
    const z = m.body.position.z;
    if (z - m.lastCheckZ < STUCK_PROGRESS_THRESHOLD) {
      m.body.applyImpulse(new CANNON.Vec3(
        (Math.random() - 0.5) * UNSTICK_IMPULSE,
        UNSTICK_IMPULSE * 0.4,
        UNSTICK_IMPULSE * 0.7
      ));
    }
    m.lastCheckZ = z;
  });
}

// Runs a full headless simulation of `participantCount` marbles down the course. Returns
// { keyframes: [{t, positions:[{id,x,y,z}]}], winner: marbleIndex, durationMs, participantCount }.
// Marble index i corresponds to the i-th entry in whatever participant list the caller used to
// decide participantCount — this function itself doesn't know about platforms/usernames.
function runRace(participantCount, opts = {}) {
  const maxDurationMs = opts.maxDurationMs || 30000;
  const { world, windmills } = _buildWorld();

  const marbles = [];
  const start = RAMPS[0];
  // A full 3D spawn grid (columns in X, rows in Z, layers in Y), spaced well beyond the marble's own
  // diameter (2*MARBLE_RADIUS = 2.8) in every axis. Verified empirically that packing many marbles
  // into a flat grid narrower than their own diameter starts them OVERLAPPING — cannon-es's
  // penetration-resolution then violently ejects them off the track in the very first physics step,
  // which is what a dense same-row layout was actually causing (not the obstacles).
  const SPAWN_SPACING = 3.5, SPAWN_LAYER_HEIGHT = 4;
  const spawnCols = Math.max(1, Math.floor((start.width - 4) / SPAWN_SPACING));
  const spawnRowsPerLayer = 6;
  const perLayer = spawnCols * spawnRowsPerLayer;
  for (let i = 0; i < participantCount; i++) {
    const layer = Math.floor(i / perLayer);
    const idxInLayer = i % perLayer;
    const col = idxInLayer % spawnCols, row = Math.floor(idxInLayer / spawnCols);
    const x = -(spawnCols - 1) * SPAWN_SPACING / 2 + col * SPAWN_SPACING + (Math.random() - 0.5) * 0.4;
    const z = start.zStart + 3 + row * SPAWN_SPACING + (Math.random() - 0.5) * 0.3;
    const y = start.yStart + 4 + layer * SPAWN_LAYER_HEIGHT;
    const body = new CANNON.Body({
      mass: 1, shape: new CANNON.Sphere(MARBLE_RADIUS), position: new CANNON.Vec3(x, y, z),
      linearDamping: 0.08, angularDamping: 0.3
    });
    world.addBody(body);
    marbles.push({ id: i, body, lastCheckZ: z, nextStuckCheckAt: STUCK_CHECK_INTERVAL_MS });
  }

  const keyframes = [];
  let elapsedMs = 0, nextSampleAt = 0, winner = null;
  const dtSec = STEP_MS / 1000;
  const snapshot = () => keyframes.push({
    t: Math.round(elapsedMs),
    positions: marbles.map((m) => ({ id: m.id, x: round2(m.body.position.x), y: round2(m.body.position.y), z: round2(m.body.position.z) }))
  });

  while (elapsedMs < maxDurationMs) {
    windmills.forEach((p) => {
      p._angle += p._angularSpeed * dtSec;
      p.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), p._angle);
    });
    world.step(dtSec);
    _clampVelocities(marbles);
    elapsedMs += STEP_MS;
    _unstickMarbles(marbles, elapsedMs);

    if (elapsedMs >= nextSampleAt) { snapshot(); nextSampleAt += SAMPLE_INTERVAL_MS; }

    const finisher = marbles.find((m) => m.body.position.z >= FINISH_Z);
    if (finisher) { winner = finisher.id; break; }
  }
  if (winner === null) {
    winner = marbles.reduce((best, m) => (m.body.position.z > best.body.position.z ? m : best), marbles[0]).id;
  }
  snapshot();   // always end on the true finish moment so the replay doesn't freeze mid-air
  return { keyframes, winner, durationMs: Math.round(elapsedMs), participantCount };
}

const HISTORY_CAP = 20;

class MarbleRaceManager {
  constructor(state, { fetchAutoEntrants } = {}) {
    this.state = state;
    this.fetchAutoEntrants = fetchAutoEntrants || (async () => ({ ok: false, error: 'not configured' }));
    this.lockTimer = null;
    this._entered = new Set();   // 'platform:userId' already entered this round — one marble each
  }

  startRound({ entryWindowMs, autoEnterViewers, customViewers } = {}) {
    const s = this.state;
    if (s.marbleRace && s.marbleRace.status !== 'idle' && s.marbleRace.status !== 'finished') {
      throw new Error('A race is already in progress.');
    }
    if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }
    entryWindowMs = Math.max(10000, Math.min(180000, Math.round(Number(entryWindowMs) || 30000)));
    const custom = (Array.isArray(customViewers) ? customViewers : []).map((n) => String(n || '').trim()).filter(Boolean);

    this._entered.clear();
    const participants = [];
    custom.forEach((name) => {
      const key = 'custom:' + name.toLowerCase();
      if (this._entered.has(key)) return;
      this._entered.add(key);
      participants.push({ platform: 'custom', userId: name, username: name, source: 'custom' });
    });

    s.marbleRace = {
      status: 'entry',
      entryEndsAt: Date.now() + entryWindowMs,
      autoEnterViewers: !!autoEnterViewers,
      customViewers: custom,
      participants,
      droppedCount: 0,
      race: null,
      result: null,
      history: (s.marbleRace && s.marbleRace.history) || []
    };
    this.lockTimer = setTimeout(() => {
      this._lockAndRun().catch((e) => console.error('[MarbleRace] round failed:', e && e.message));
    }, entryWindowMs);
    return s.marbleRace;
  }

  // Adds one participant regardless of round status — shared by enterParticipant() (chat/custom
  // entries, gated to the 'entry' phase below) and the auto-enter-viewers pull in _lockAndRun(),
  // which runs AFTER status has already flipped to 'locked' and would otherwise be rejected by that
  // same gate (a real bug caught by this file's own verification test — auto-entrants were being
  // silently dropped every time).
  _addParticipant({ platform, userId, username, source }) {
    const mr = this.state.marbleRace;
    const key = platform + ':' + userId;
    if (this._entered.has(key)) return false;
    this._entered.add(key);
    mr.participants.push({ platform, userId, username, source });
    return true;
  }

  // Returns true if this entrant was newly added, false if the round isn't accepting entries or
  // they've already entered this round.
  enterParticipant({ platform, userId, username, source }) {
    const mr = this.state.marbleRace;
    if (!mr || mr.status !== 'entry') return false;
    return this._addParticipant({ platform, userId, username, source });
  }

  async _lockAndRun() {
    const s = this.state, mr = s.marbleRace;
    if (!mr || mr.status !== 'entry') return;
    this.lockTimer = null;
    mr.status = 'locked';

    if (mr.autoEnterViewers) {
      try {
        const r = await this.fetchAutoEntrants();
        if (r.ok) r.entrants.forEach((e) => this._addParticipant(e));
      } catch (e) { /* auto-enter is best-effort — a failed pull never blocks the race */ }
    }

    let participants = mr.participants;
    if (participants.length > ENTRY_CAP) {
      const shuffled = participants.slice().sort(() => Math.random() - 0.5);
      mr.droppedCount = participants.length - ENTRY_CAP;
      participants = shuffled.slice(0, ENTRY_CAP);
      mr.participants = participants;
    }
    if (!participants.length) {
      mr.status = 'finished';
      mr.result = { winnerParticipant: null };
      return;
    }

    const race = runRace(participants.length);
    mr.race = race;
    const winnerParticipant = participants[race.winner] || null;
    mr.result = { winnerParticipant };
    mr.status = 'finished';
    mr.history.unshift({ participantCount: participants.length, winner: winnerParticipant ? winnerParticipant.username : null, finishedAt: Date.now() });
    if (mr.history.length > HISTORY_CAP) mr.history.length = HISTORY_CAP;
  }

  cancel() {
    const s = this.state, mr = s.marbleRace;
    if (!mr || (mr.status !== 'entry' && mr.status !== 'locked')) return false;
    if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = null; }
    const history = mr.history;
    s.marbleRace = { status: 'idle', entryEndsAt: null, autoEnterViewers: false, customViewers: [], participants: [], droppedCount: 0, race: null, result: null, history };
    this._entered.clear();
    return true;
  }
}

module.exports = { MarbleRaceManager, runRace, RAMPS, FINISH_Z };
