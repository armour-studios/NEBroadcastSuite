// node test/producer-live.test.js
// backend/cloud/producer-live.js, the port of the website's lib/studio/producer-live.ts. These cases
// are copied from the website's lib/studio/phase7.test.ts: keep them in step.
'use strict';
const assert = require('assert/strict');
const { ProducerLiveTracker, listPollMs, clockOffsetMs, latencySample } = require('../backend/cloud/producer-live');
let pass = 0;
const test = (name, fn) => { fn(); pass++; };
const msg = (seq, extra = {}) => ({ seq, kind: 'result', fixtureId: 'fx1', stageId: null, at: 1000 + seq, ...extra });

test('tracker: in-order messages refetch, old ones are ignored, a gap asks for a catch-up once', () => {
  const t = new ProducerLiveTracker('comp1', 10);
  assert.deepEqual(t.onMessage(msg(10)), { type: 'ignore' });
  assert.deepEqual(t.onMessage(msg(11)), { type: 'refetch', seq: 11, fixtureId: 'fx1', kind: 'result' });
  assert.deepEqual(t.onMessage({ seq: 'x' }), { type: 'ignore' });
  assert.deepEqual(t.onMessage(msg(14)), { type: 'catch_up', since: 11 });
  assert.deepEqual(t.onMessage(msg(15)), { type: 'ignore' }, 'one catch-up at a time');
  const after = t.onCatchUp({ seq: 14, plan: 'replay', changes: [msg(12), msg(13), msg(14)] });
  assert.equal(after.type, 'refetch');
  assert.equal(t.seq, 15, 'a message announced during the catch-up is not lost');
  assert.equal(t.onDocument(14), true, 'the document is older than announced: fetch again');
  assert.equal(t.onDocument(15), false);
  assert.equal(t.renderedSeq, 15);
});

test('tracker: reconnect, current, snapshot and failure paths', () => {
  const t = new ProducerLiveTracker('comp1', 5);
  assert.deepEqual(t.onReconnect(), { type: 'catch_up', since: 5 });
  assert.deepEqual(t.onReconnect(), { type: 'ignore' });
  assert.deepEqual(t.onCatchUp({ seq: 5, plan: 'current', changes: [] }), { type: 'ignore' });
  t.onReconnect();
  t.onCatchUpFailed();
  assert.deepEqual(t.onReconnect(), { type: 'catch_up', since: 5 }, 'a failed catch-up can be retried');
  const snap = t.onCatchUp({ seq: 90, plan: 'snapshot', changes: [] });
  assert.deepEqual(snap, { type: 'refetch', seq: 90, fixtureId: null, kind: 'update' });
  const single = new ProducerLiveTracker('c', 1);
  single.onMessage(msg(3));
  assert.deepEqual(single.onCatchUp({ seq: 2, plan: 'replay', changes: [msg(2, { fixtureId: 'fx9' })] }), { type: 'refetch', seq: 3, fixtureId: null, kind: 'result' });
  assert.equal(new ProducerLiveTracker('c', null).seq, 0);
  const fresh = new ProducerLiveTracker('c', 0);
  assert.equal(fresh.onDocument(null), false, 'an older site without X-Live-Seq');
});

test('list poll: 5 minutes with push, a minute without, clamped', () => {
  assert.equal(listPollMs(true), 300000);
  assert.equal(listPollMs(false), 60000);
  assert.equal(listPollMs(true, 10), 60000);
  assert.equal(listPollMs(true, 5000), 900000);
  assert.equal(listPollMs(true, Number.NaN), 300000);
});

test('latency samples correct for clock skew', () => {
  // Local clock 2 s ahead of the server; the token round trip took 100 ms.
  const offset = clockOffsetMs(10000, 11950, 12050);
  assert.equal(offset, 2000);
  const s = latencySample({ competitionId: 'comp123', message: { seq: 4, kind: 'result', fixtureId: 'fx1', at: 20000 }, receivedAtLocal: 22400, appliedAtLocal: 22700, clockOffsetMs: offset, transport: 'push' });
  assert.deepEqual(s, { competitionId: 'comp123', fixtureId: 'fx1', seq: 4, kind: 'result', transport: 'push', deliverMs: 400, applyMs: 300 });
  assert.equal(latencySample({ competitionId: 'c', message: { seq: 1, kind: 'x', fixtureId: null, at: Number.NaN }, receivedAtLocal: 1, appliedAtLocal: 2, clockOffsetMs: 0, transport: 'poll' }), null);
});

console.log(`producer-live: all ${pass} tests passed`);
