// Marvel Tokon board position (Match ▸ Teams ▸ Marvel Tokon ▸ Position) is persisted state that
// overlay/tokon.html turns straight into pixel offsets, so it must always come back complete and
// on-screen. Drives the REAL normalizeTokonLayout out of server.js (pulled out by source), and checks
// the overlay's own [default, min, max] table still agrees with it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = require('./lib/server-source').serverSource();
const start = src.indexOf('function normalizeTokonLayout');
assert.ok(start > 0, 'normalizeTokonLayout not found in server.js');
const end = src.indexOf('\n}', start) + 2;
const normalize = new Function(src.slice(start, end) + ' return normalizeTokonLayout;')();

const DEFAULTS = { top: 2, w: 1140, gutter: 340, spony: 1017, sponw: 130, barlift: 0 };

// No saved value (fresh install, or a state.json from before the setting existed) → full defaults.
assert.deepStrictEqual(normalize(undefined), DEFAULTS);

// One edited value keeps the rest; strings from a number input are accepted and rounded.
const one = normalize({ ...DEFAULTS, spony: '1010.6' });
assert.strictEqual(one.spony, 1011);
assert.strictEqual(one.w, 1140);

// Out-of-range input is clamped, junk falls back to the default, unknown/retired keys are dropped.
const bad = normalize({ top: -50, w: 99999, gutter: 'abc', spony: '', metery: 1054, evil: 1 });
assert.strictEqual(bad.top, 0);
assert.strictEqual(bad.w, 1700);
assert.strictEqual(bad.gutter, 340);
assert.strictEqual(bad.spony, 1017);
assert.ok(!('evil' in bad) && !('metery' in bad), 'unknown and retired keys dropped');

// The overlay clamps the same keys with the same table — they must not drift apart.
const html = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'tokon.html'), 'utf8');
const m = /const LAYOUT = (\{[\s\S]*?\});/.exec(html);
assert.ok(m, 'LAYOUT table not found in tokon.html');
const table = new Function('return ' + m[1])();
Object.keys(DEFAULTS).forEach((k) => assert.strictEqual(table[k][0], DEFAULTS[k], 'overlay default for ' + k));
assert.deepStrictEqual(Object.keys(table).sort(), Object.keys(DEFAULTS).sort(), 'overlay keys match server');

console.log('tokon-layout: ok');
