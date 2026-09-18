// CS2 map pool carries every map we have radar art for (Active Duty + Reserve), but the guided
// veto's STD7 order is authored for 7 maps. Vetoing a bigger pool must still end on the right
// number of maps instead of leaving every extra map standing as a decider.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const veto = require('../backend/veto.js');

const root = path.join(__dirname, '..');
const cs = veto.MAP_POOLS.csgo;

// Every CS map points at a real bundled image (a missing one draws a broken card on air).
cs.forEach((m) => assert.ok(fs.existsSync(path.join(root, m.image)), 'missing art for ' + m.id + ': ' + m.image));
assert.strictEqual(new Set(cs.map((m) => m.id)).size, cs.length, 'duplicate CS map ids');
assert.strictEqual(cs.filter((m) => m.tier === 'Active Duty').length, 7, 'Active Duty must stay a 7-map pool');
assert.strictEqual(veto.getMeta('csgo').strikeFrom, 'Active Duty');

// Simulate a veto: returns how many maps get played (picks + deciders).
function played(game, bo, poolSize) {
  const seq = veto.buildSequence(game, bo, poolSize);
  assert.ok(seq.length < poolSize, `${game} Bo${bo} on ${poolSize}: ${seq.length} steps would exhaust the pool`);
  for (let i = 1; i < seq.length; i++) {
    assert.notStrictEqual(seq[i].teamIdx, seq[i - 1].teamIdx, `${game} Bo${bo} on ${poolSize}: step ${i} repeats a team`);
  }
  return seq.filter((s) => s.action === 'pick').length + (poolSize - seq.length);
}

[1, 3, 5].forEach((bo) => {
  // 7-map pool is exactly the authored STD7 order.
  assert.deepStrictEqual(veto.buildSequence('csgo', bo, 7).map((s) => [s.action, s.teamIdx]), veto.VETO_FORMATS.csgo[bo]);
  // Active Duty, Reserve (9), and all maps (16) all resolve to a real Bo-N.
  [7, 9, cs.length].forEach((n) => assert.strictEqual(played('csgo', bo, n), bo, `csgo Bo${bo} on ${n} maps`));
});

// Games with other formats are untouched by the STD7 scaling.
assert.strictEqual(veto.buildSequence('overwatch', 3, 21).length, veto.VETO_FORMATS.overwatch[3].length);

console.log('veto-cs-pool: ok (' + cs.length + ' CS maps)');
