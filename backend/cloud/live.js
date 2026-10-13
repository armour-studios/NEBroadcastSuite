'use strict';
// Push updates for loaded website events (website DESKTOP_INTEGRATION 7.2 / 7.3). With push on, a
// result entered on the website reaches the desk in about a second instead of on the minute poll.
//
//   configure(hints)  the list's `live` block: { push, channelPrefix, event, listPollSeconds, ... }.
//                     push false / missing = stop and stay on polling (exactly the old behaviour)
//   followOnly(map)   Map<competitionId, docSeq>: subscribe to these events, drop the rest
//   stop()            sign-out, session revoked, shutdown
//
// Each message goes through a ProducerLiveTracker (backend/cloud/producer-live.js, the website's
// tracker ported): in order = refetch the document (ETag, usually tiny); a gap or a reconnect =
// catch up through /live?since=. Refetches for one event run one at a time; a change announced
// while one runs triggers exactly one more. Every refetch that carried a message leaves a latency
// sample (publish -> overlay) for the website's Studio analytics.
//
// deps: { cloud, Ably, onRefetch(competitionId) -> Promise<seq|null>, log, now }
const { ProducerLiveTracker, clockOffsetMs, latencySample } = require('./producer-live');

const MAX_SAMPLES = 200;

function createLive(deps) {
  const cloud = deps.cloud;
  const log = deps.log || console;
  const now = deps.now || Date.now;
  let Ably = deps.Ably || null;
  const trackers = new Map();   // competitionId -> { tracker, channel, listener, running, again }
  const samples = [];
  let rt = null, hints = null, connected = false, wasDown = false, offset = 0;

  function ably() {
    if (!Ably) Ably = require('ably');
    return Ably;
  }

  function configure(h) {
    hints = h && typeof h === 'object' ? h : null;
    if (!hints || !hints.push) { stop(); return; }
    if (!rt) start();
  }

  function start() {
    const A = ably();
    rt = new A.Realtime({
      autoConnect: true,
      echoMessages: false,
      authCallback: (params, cb) => {
        cloud.getLiveToken().then((r) => {
          const ts = Number(r && r.tokenRequest && r.tokenRequest.timestamp);
          offset = clockOffsetMs(ts, r.sentAt, r.receivedAt);
          cb(null, r.tokenRequest);
        }, (e) => cb((e && e.message) || 'live token refused', null));
      },
    });
    rt.connection.on((change) => {
      const cur = change && change.current;
      if (cur === 'connected') {
        const back = wasDown;
        connected = true; wasDown = false;
        // Anything may have been missed while the connection was down.
        if (back) for (const [id, e] of trackers) run(id, e.tracker.onReconnect(), null);
      } else if (cur === 'disconnected' || cur === 'suspended' || cur === 'failed' || cur === 'closed') {
        if (connected) wasDown = true;
        connected = false;
      }
    });
  }

  function follow(id, seq) {
    if (!rt || trackers.has(id)) return;
    const tracker = new ProducerLiveTracker(id, seq == null ? null : seq);
    const channel = rt.channels.get((hints.channelPrefix || 'competition:') + id);
    const listener = (msg) => {
      const receivedAt = now();
      const data = msg && msg.data;
      run(id, tracker.onMessage(data), { message: data, receivedAt, transport: 'push' });
    };
    const e = { tracker, channel, listener, running: false, again: null };
    trackers.set(id, e);
    Promise.resolve().then(() => channel.subscribe(hints.event || 'change', listener))
      .catch((err) => log.warn('[live] subscribe failed for', id, (err && err.message) || err));
  }

  function unfollow(id) {
    const e = trackers.get(id);
    if (!e) return;
    try { e.channel.unsubscribe(e.listener); } catch (_) {}
    try { if (rt && rt.channels && typeof rt.channels.release === 'function') rt.channels.release(e.channel.name); } catch (_) {}
    trackers.delete(id);
  }

  function followOnly(map) {
    if (!rt) return;
    for (const id of [...trackers.keys()]) if (!map.has(id)) unfollow(id);
    for (const [id, seq] of map) follow(id, seq);
  }

  function noteSample(id, ctx) {
    if (!ctx || !ctx.message) return;
    const s = latencySample({ competitionId: id, message: ctx.message, receivedAtLocal: ctx.receivedAt, appliedAtLocal: now(), clockOffsetMs: offset, transport: ctx.transport || 'push' });
    if (!s) return;
    samples.push(s);
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  }

  async function run(id, action, ctx) {
    const e = trackers.get(id);
    if (!e || !action || action.type === 'ignore') return;
    if (action.type === 'catch_up') {
      let answer;
      try { answer = await cloud.liveCatchUp(id, action.since); }
      catch (err) { e.tracker.onCatchUpFailed(); log.warn('[live] catch-up failed for', id, (err && err.message) || err); return; }
      const changes = Array.isArray(answer && answer.changes) ? answer.changes : [];
      const last = changes.length ? changes[changes.length - 1] : null;
      return run(id, e.tracker.onCatchUp(answer), last ? { message: last, receivedAt: now(), transport: 'poll' } : null);
    }
    if (action.type !== 'refetch') return;
    if (e.running) { e.again = ctx || e.again || {}; return; }
    e.running = true;
    try {
      let c = ctx;
      for (let i = 0; i < 4; i++) {
        const seq = await deps.onRefetch(id);
        const more = e.tracker.onDocument(seq == null ? null : seq);
        noteSample(id, c);
        c = e.again; e.again = null;
        if (!more && !c) break;
      }
    } catch (err) {
      log.warn('[live] refetch failed for', id, (err && err.message) || err);
    } finally {
      e.running = false;
    }
  }

  function stop() {
    for (const id of [...trackers.keys()]) unfollow(id);
    if (rt) { try { rt.close(); } catch (_) {} }
    rt = null; connected = false; wasDown = false;
  }

  return {
    configure, follow, unfollow, followOnly, stop,
    takeSamples: () => samples.splice(0, 50),
    get connected() { return connected; },
    get pushOn() { return !!rt; },
    get listPollSeconds() { return hints && hints.listPollSeconds; },
    get following() { return [...trackers.keys()]; },
  };
}

module.exports = { createLive };
