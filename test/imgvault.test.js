'use strict';
// Image vault: "@img:" refs must only go to clients that already hold the image.
// Regression for the global sent-set: an overlay that connected (or reloaded) later only got the
// images in its connect snapshot, so a logo that came back afterwards (team X plays again, brand kit
// switched back) arrived as a ref that overlay had never seen -> broken logo on air.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = require('./lib/server-source').serverSource();
const start = src.indexOf('function _imgHash(');
const end = src.indexOf('// Diagnostic', start);
assert.ok(start > 0 && end > start, 'image vault functions not found in server.js');
// eslint-disable-next-line no-new-func
const lib = new Function(src.slice(start, end) + '\nreturn { _imgHash, _imgSegments, _vaultFor, _seedImgSent };')();

const img = (seed) => 'data:image/png;base64,' + String(seed).repeat(1200);   // >= 1024 chars -> vaulted
const state = (logos) => JSON.stringify({ type: 'full_state', data: { teams: logos.map((l) => ({ logo: l })) } });
const send = (ws, str) => { const seg = lib._imgSegments(str); return seg ? lib._vaultFor(seg, ws, new Map()) : str; };
const holds = (out, logo) => out.indexOf(logo) >= 0;
const refs = (out) => (out.match(/"@img:[^"]+"/g) || []).length;

const X = img('X'), Y = img('Y');
let pass = 0;
function check(name, fn) { fn(); pass++; console.log('PASS ', name); }

check('first broadcast sends an image in full, the next one as a ref', () => {
  const a = { _imgvault: true };
  assert.ok(holds(send(a, state([X])), X));
  const out = send(a, state([X]));
  assert.ok(!holds(out, X) && refs(out) === 1);
});

check('a late overlay gets a logo in full when it returns, even though others already had it', () => {
  const a = { _imgvault: true }, b = { _imgvault: true };
  send(a, state([X]));                    // match 1: X on air, A receives X
  send(a, state([Y]));                    // match 2: Y on air
  const snap = state([Y]);                // B connects/reloads during match 2: snapshot has only Y
  lib._seedImgSent(b, snap);
  const forA = send(a, state([X])), forB = send(b, state([X]));   // match 3: X is back
  assert.ok(!holds(forA, X), 'A already holds X, should get a ref');
  assert.ok(holds(forB, X), 'B never saw X, must get it in full');
});

check('connect snapshot seeds the client, so its first broadcast is not re-sent in full', () => {
  const c = { _imgvault: true };
  lib._seedImgSent(c, state([X, Y]));
  const out = send(c, state([X, Y]));
  assert.ok(!holds(out, X) && !holds(out, Y) && refs(out) === 2);
});

check('the same image twice in one message: first in full, second as a ref', () => {
  const d = { _imgvault: true };
  const out = send(d, state([X, X]));
  assert.ok(holds(out, X) && refs(out) === 1);
});

check('clients missing the same images share one rendered string', () => {
  const seg = lib._imgSegments(state([X])), memo = new Map();
  const o1 = lib._vaultFor(seg, { _imgvault: true }, memo), o2 = lib._vaultFor(seg, { _imgvault: true }, memo);
  assert.strictEqual(o1, o2); assert.strictEqual(memo.size, 1);
});

check('small images and plain payloads pass through untouched', () => {
  assert.strictEqual(lib._imgSegments(JSON.stringify({ logo: 'data:image/png;base64,AAAA' })), null);
  assert.strictEqual(lib._imgSegments('{"a":1}'), null);
});

console.log(`\nimgvault: all ${pass} checks passed`);
