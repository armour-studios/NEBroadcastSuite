'use strict';
// CS2 gunfight prediction: positions + view lineups -> the fight about to happen and whose POV.
const test = require('node:test');
const assert = require('assert');
const { createDuelPredictor } = require('../backend/director/cs2-duel');

const P = (steamid, team, x, y, fx, fy, z = 0) => ({ steamid, name: steamid, team, alive: true, health: 100, pos: { x, y, z }, fwd: { x: fx, y: fy } });

test('a player holding an angle while an enemy pushes into it is the POV', () => {
  const d = createDuelPredictor();
  // CT at the origin aiming +x; T walking toward him along -x, looking at his feet direction (not at him yet).
  let out;
  for (let i = 0; i <= 6; i++) {
    const tX = 1500 - i * 25;   // 250 units/s at 10 updates/s
    out = d.predict([P('ct1', 'CT', 0, 0, 1, 0), P('t1', 'T', tX, 300, -0.6, -0.8)], { now: 1000 + i * 100 });
  }
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].watch.steamid, 'ct1', 'the holder sees the peek come into the crosshair');
  assert.ok(out[0].score > 0.6, 'score ' + out[0].score);
  assert.match(out[0].reason, /pushing into ct1/);
});

test('two players lined up on each other is a duel; the camera stays on whoever is already shown', () => {
  const d = createDuelPredictor();
  const ps = [P('ct1', 'CT', 0, 0, 1, 0), P('t1', 'T', 900, 0, -1, 0)];
  const a = d.predict(ps, { now: 1, observedId: 't1' });
  assert.strictEqual(a[0].watch.steamid, 't1');
  assert.match(a[0].reason, /^Duel:/);
  const b = createDuelPredictor().predict(ps, { now: 1, observedId: 'ct1' });
  assert.strictEqual(b[0].watch.steamid, 'ct1');
});

test('players facing away from each other, another floor, or out of range are not a duel', () => {
  const d = createDuelPredictor();
  assert.strictEqual(d.predict([P('ct1', 'CT', 0, 0, -1, 0), P('t1', 'T', 900, 0, 1, 0)], { now: 1 }).length, 0, 'back to back');
  const floor = d.predict([P('ct2', 'CT', 0, 0, 1, 0, 0), P('t2', 'T', 700, 0, -1, 0, 400)], { now: 1, min: 0 });
  const same = d.predict([P('ct3', 'CT', 0, 0, 1, 0, 0), P('t3', 'T', 700, 0, -1, 0, 0)], { now: 1, min: 0 });
  assert.ok(floor[0].score < same[0].score * 0.5, 'another floor is heavily discounted');
  assert.strictEqual(d.predict([P('ct4', 'CT', 0, 0, 1, 0), P('t4', 'T', 3000, 0, -1, 0)], { now: 1 }).length, 0, 'too far');
  assert.strictEqual(d.predict([Object.assign(P('ct5', 'CT', 0, 0, 1, 0), { alive: false }), P('t5', 'T', 500, 0, -1, 0)], { now: 1 }).length, 0, 'dead players');
});

test('the best fight comes first when several are lining up', () => {
  const d = createDuelPredictor();
  const out = d.predict([
    P('ct1', 'CT', 0, 0, 1, 0), P('t1', 'T', 600, 0, -1, 0),            // close, both aiming
    P('ct2', 'CT', 0, 3000, 1, 0), P('t2', 'T', 1800, 3000, -0.8, 0.6), // far, half-aimed
  ], { now: 1, min: 0.3 });
  assert.strictEqual(out[0].a.steamid, 'ct1');
});
