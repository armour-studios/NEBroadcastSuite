'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { frameJson } = require('../backend/rl-framing');

test('a lone complete object is emitted immediately, not held back', () => {
  const r = frameJson('{"Event":"MatchEnded","Data":{"a":1}}');
  assert.deepStrictEqual(r.messages, ['{"Event":"MatchEnded","Data":{"a":1}}']);
  assert.strictEqual(r.rest, '');
});
test('back-to-back objects with and without separators', () => {
  const r = frameJson('{"a":1}{"b":2}\n{"c":3}');
  assert.deepStrictEqual(r.messages.map((m) => JSON.parse(m)), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});
test('a partial tail is kept and completed by the next chunk', () => {
  const a = frameJson('{"a":1}{"b":{"x":');
  assert.strictEqual(a.messages.length, 1);
  const b = frameJson(a.rest + '2}}');
  assert.deepStrictEqual(JSON.parse(b.messages[0]), { b: { x: 2 } });
  assert.strictEqual(b.rest, '');
});
test('braces and escaped quotes inside strings do not confuse the scanner', () => {
  const obj = { Name: 'a}{b "q" \\ end}', Data: { n: 1 } };
  const r = frameJson(JSON.stringify(obj) + JSON.stringify(obj));
  assert.strictEqual(r.messages.length, 2);
  assert.deepStrictEqual(JSON.parse(r.messages[1]), obj);
});
test('stray leading noise is skipped', () => {
  const r = frameJson('  \n{"a":1}');
  assert.deepStrictEqual(r.messages, ['{"a":1}']);
});
