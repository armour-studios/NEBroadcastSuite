// node test/live-feed.test.js
// backend/cloud/live.js with a fake Ably and a fake cloud: push messages refetch in order, gaps and
// reconnects catch up, refetches for one event never overlap, latency samples are recorded, and
// push off / stop leaves nothing subscribed.
'use strict';
const assert = require('assert/strict');
const { createLive } = require('../backend/cloud/live');

let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };
const tick = () => new Promise((r) => setImmediate(r));

function fakeAbly() {
  const made = [];
  class Realtime {
    constructor(opts) {
      this.opts = opts; this.closed = false; this.handlers = []; this.subs = new Map(); made.push(this);
      this.connection = { on: (fn) => this.handlers.push(fn) };
      this.channels = {
        get: (name) => ({
          name,
          subscribe: (ev, fn) => { this.subs.set(name, { ev, fn }); return Promise.resolve(); },
          unsubscribe: () => { this.subs.delete(name); },
        }),
        release: () => {},
      };
    }
    close() { this.closed = true; }
    emitState(current) { this.handlers.forEach((h) => h({ current })); }
    publish(name, data) { const s = this.subs.get(name); if (s) s.fn({ data }); }
  }
  return { Realtime, made };
}

(async () => {
  const A = fakeAbly();
  let clock = 100000;
  const refetches = [], catchUps = [];
  let docSeq = 10, gate = null;
  const cloud = {
    async getLiveToken() { return { tokenRequest: { timestamp: 99000 }, sentAt: 99950, receivedAt: 100050 }; },
    async liveCatchUp(id, since) { catchUps.push({ id, since }); return { seq: 14, plan: 'replay', changes: [{ seq: 12, kind: 'result', fixtureId: 'f1', at: 99500 }, { seq: 14, kind: 'fixture', fixtureId: 'f2', at: 99600 }] }; },
  };
  const live = createLive({
    cloud, Ably: A, now: () => clock, log: { warn() {} },
    onRefetch: async (id) => { refetches.push(id); if (gate) await gate; return docSeq; },
  });

  // Push off: nothing starts.
  live.configure({ push: false });
  ok(!live.pushOn && A.made.length === 0, 'push off: no realtime connection');
  live.configure(null);
  ok(!live.pushOn, 'no hints: no realtime connection');

  live.configure({ push: true, channelPrefix: 'competition:', event: 'change', listPollSeconds: 300 });
  ok(live.pushOn && A.made.length === 1, 'push on: one connection');
  const rt = A.made[0];
  // The auth callback goes through the cloud session and measures the clock offset.
  const tok = await new Promise((r) => rt.opts.authCallback({}, (err, t) => r({ err, t })));
  ok(!tok.err && tok.t.timestamp === 99000, 'auth callback answers the website\'s token request');
  rt.emitState('connected');
  ok(live.connected, 'connected');

  live.followOnly(new Map([['c1', 10], ['c2', 3]]));
  await tick();
  ok(rt.subs.has('competition:c1') && rt.subs.has('competition:c2'), 'subscribed to each followed event');
  live.followOnly(new Map([['c1', 10]]));
  ok(!rt.subs.has('competition:c2') && live.following.join() === 'c1', 'events no longer followed are dropped');

  // In order: refetch, and a latency sample (publish -> applied).
  docSeq = 11;
  clock = 100500;
  rt.publish('competition:c1', { seq: 11, kind: 'result', fixtureId: 'f1', at: 99800 });
  await tick(); await tick();
  ok(refetches.length === 1 && refetches[0] === 'c1', 'the next seq refetches the document');
  const s1 = live.takeSamples();
  ok(s1.length === 1 && s1[0].transport === 'push' && s1[0].seq === 11, 'a latency sample per applied change');
  // Old / duplicate: ignored.
  rt.publish('competition:c1', { seq: 11, kind: 'result', fixtureId: 'f1', at: 99800 });
  await tick();
  ok(refetches.length === 1, 'a duplicate seq is ignored');

  // A gap: catch up, then one refetch for the newest change.
  docSeq = 14;
  rt.publish('competition:c1', { seq: 14, kind: 'fixture', fixtureId: 'f2', at: 99900 });
  await tick(); await tick(); await tick();
  ok(catchUps.length === 1 && catchUps[0].since === 11, 'a gap asks for a catch-up from the last known seq');
  ok(refetches.length === 2, 'and then refetches once');
  ok(live.takeSamples()[0].transport === 'poll', 'changes found by catch-up are sampled as poll');

  // Refetches for one event never overlap; a change during one triggers exactly one more.
  let release; gate = new Promise((r) => { release = r; });
  docSeq = 15;
  rt.publish('competition:c1', { seq: 15, kind: 'result', fixtureId: 'f1', at: 100000 });
  await tick();
  docSeq = 16;
  rt.publish('competition:c1', { seq: 16, kind: 'result', fixtureId: 'f1', at: 100100 });
  await tick();
  ok(refetches.length === 3, 'the second change waits for the running refetch');
  gate = null; release();
  await tick(); await tick(); await tick();
  ok(refetches.length === 4, 'then exactly one more refetch');

  // Reconnect after a drop: catch up.
  rt.emitState('disconnected');
  ok(!live.connected, 'disconnected');
  rt.emitState('connected');
  await tick(); await tick();
  ok(catchUps.length === 2 && catchUps[1].since === 16, 'a reconnect catches up');

  // A failed catch-up can be retried.
  cloud.liveCatchUp = async () => { throw new Error('offline'); };
  rt.emitState('disconnected'); rt.emitState('connected');
  await tick(); await tick();
  cloud.liveCatchUp = async (id, since) => { catchUps.push({ id, since }); return { seq: 16, plan: 'current', changes: [] }; };
  rt.emitState('disconnected'); rt.emitState('connected');
  await tick(); await tick();
  ok(catchUps.length === 3, 'after a failed catch-up the next reconnect tries again');

  // Stop: unsubscribed and closed.
  live.stop();
  ok(rt.closed && !rt.subs.size && !live.pushOn && !live.connected, 'stop closes the connection and drops every subscription');
  live.configure({ push: false });
  ok(A.made.length === 1, 'push off after stop: nothing new');

  console.log(`live-feed: all ${pass} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
