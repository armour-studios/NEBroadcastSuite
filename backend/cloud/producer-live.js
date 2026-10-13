'use strict';
/**
 * The producer's live client, the pure half (website BUILD_PLAN 7.2 and 7.3). A line-for-line
 * CommonJS port of NENetworkWebsite lib/studio/producer-live.ts (types stripped); its cases are
 * pinned in test/producer-live.test.js, copied from the website's lib/studio/phase7.test.ts.
 * Keep the two in step. The wiring (Ably, refetch, catch-up) is backend/cloud/live.js.
 *
 *   1. GET /api/broadcast/competitions/:id      the document; the X-Live-Seq header is its seq
 *   2. GET /api/broadcast/live-token            an Ably token request (subscribe-only, competition:*)
 *   3. subscribe to `competition:{id}`, event "change", messages { seq, kind, fixtureId, stageId, at }
 *   4. each message goes through tracker.onMessage, which answers what to do:
 *        ignore    an old or duplicate seq
 *        refetch   the next seq in order: refetch the document (If-None-Match keeps it cheap)
 *        catch_up  one or more were missed: GET /api/broadcast/competitions/:id/live?since=<seq>
 *   5. after a reconnect, ask catch_up once; the answer goes through tracker.onCatchUp
 *   6. with push connected, poll the events list every 5 minutes instead of every minute
 */

const LIST_POLL_PUSH_MS = 5 * 60 * 1000;
const LIST_POLL_FALLBACK_MS = 60 * 1000;
const DOC_POLL_FALLBACK_MS = 30 * 1000;
const LATENCY_TARGET_MS = 3000;

function listPollMs(pushConnected, pushSeconds = LIST_POLL_PUSH_MS / 1000) {
  if (!pushConnected) return LIST_POLL_FALLBACK_MS;
  const s = Number.isFinite(pushSeconds) ? Math.min(900, Math.max(60, Math.round(pushSeconds))) : LIST_POLL_PUSH_MS / 1000;
  return s * 1000;
}

function validMessage(m) {
  if (!m || typeof m !== 'object') return false;
  return Number.isInteger(m.seq) && m.seq >= 0 && typeof m.kind === 'string';
}

class ProducerLiveTracker {
  constructor(competitionId, initialSeq) {
    this.competitionId = competitionId;
    const s = Number.isInteger(initialSeq) && initialSeq >= 0 ? initialSeq : 0;
    this.docSeq = s;          // the seq the document on screen reflects
    this.knownSeq = s;        // the highest seq this tracker has been told about
    this.pendingCatchUp = false;
    this.announced = 0;       // the highest seq announced while a catch-up was in flight
  }

  get seq() { return this.knownSeq; }
  get renderedSeq() { return this.docSeq; }

  onMessage(raw) {
    if (!validMessage(raw)) return { type: 'ignore' };
    const m = raw;
    if (m.seq <= this.knownSeq) return { type: 'ignore' };
    if (m.seq === this.knownSeq + 1 && !this.pendingCatchUp) {
      this.knownSeq = m.seq;
      return { type: 'refetch', seq: m.seq, fixtureId: m.fixtureId == null ? null : m.fixtureId, kind: m.kind };
    }
    // A gap: ask what was missed from the last seq we know, once at a time. Messages that arrive
    // meanwhile are remembered, so the refetch after the answer covers them too.
    if (this.pendingCatchUp) {
      this.announced = Math.max(this.announced, m.seq);
      return { type: 'ignore' };
    }
    this.pendingCatchUp = true;
    this.announced = m.seq;
    return { type: 'catch_up', since: this.knownSeq };
  }

  onReconnect() {
    if (this.pendingCatchUp) return { type: 'ignore' };
    this.pendingCatchUp = true;
    return { type: 'catch_up', since: this.knownSeq };
  }

  onCatchUp(answer) {
    this.pendingCatchUp = false;
    const announced = this.announced;
    this.announced = 0;
    if (!answer || !Number.isInteger(answer.seq)) return { type: 'refetch', seq: Math.max(this.knownSeq, announced), fixtureId: null, kind: 'update' };
    if (answer.plan === 'current' && answer.seq <= this.knownSeq && announced <= this.knownSeq) return { type: 'ignore' };
    const changes = Array.isArray(answer.changes) ? answer.changes : [];
    const last = changes.length ? changes[changes.length - 1] : null;
    // A server behind us (a restored database) resets our idea of the seq.
    this.knownSeq = Math.max(answer.seq, announced);
    const single = answer.plan === 'replay' && changes.length === 1 && announced <= answer.seq;
    return { type: 'refetch', seq: this.knownSeq, fixtureId: single ? (last && last.fixtureId != null ? last.fixtureId : null) : null, kind: (last && last.kind) || 'update' };
  }

  onCatchUpFailed() { this.pendingCatchUp = false; }

  onDocument(seq) {
    if (Number.isInteger(seq) && seq >= 0) {
      this.docSeq = seq;
      if (seq > this.knownSeq) this.knownSeq = seq;
    } else {
      this.docSeq = this.knownSeq;
    }
    return this.docSeq < this.knownSeq;
  }
}

function clockOffsetMs(serverTimestamp, sentAtLocal, receivedAtLocal) {
  if (![serverTimestamp, sentAtLocal, receivedAtLocal].every(Number.isFinite)) return 0;
  const midpoint = sentAtLocal + (receivedAtLocal - sentAtLocal) / 2;
  return Math.round(midpoint - serverTimestamp);
}

function latencySample(input) {
  const m = input.message;
  if (!Number.isFinite(m.at) || !Number.isFinite(input.receivedAtLocal) || !Number.isFinite(input.appliedAtLocal)) return null;
  const deliverMs = Math.max(0, Math.round(input.receivedAtLocal - input.clockOffsetMs - m.at));
  const applyMs = Math.max(0, Math.round(input.appliedAtLocal - input.receivedAtLocal));
  return { competitionId: input.competitionId, fixtureId: m.fixtureId == null ? null : m.fixtureId, seq: m.seq, kind: m.kind, transport: input.transport, deliverMs, applyMs };
}

module.exports = {
  LIST_POLL_PUSH_MS, LIST_POLL_FALLBACK_MS, DOC_POLL_FALLBACK_MS, LATENCY_TARGET_MS,
  listPollMs, ProducerLiveTracker, clockOffsetMs, latencySample,
};
