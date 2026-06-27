'use strict';

/**
 * Telemetry recorder — Phase 0 of the AI producer/director pipeline.
 *
 * Captures the producer's DECISIONS (accept/decline/override/lock a director rec,
 * keep/edit a clip, scene changes) plus the engine's recommendations, each stamped
 * with the game/score/scene context at that instant, and appends them as newline-
 * delimited JSON to `${dataDir}/telemetry/decisions-YYYYMMDD.jsonl`.
 *
 * Local-only and additive: nothing is uploaded here. A later phase batches these
 * records to the central training server (see docs/ai-producer-architecture.md).
 *
 * Each record = a common envelope (ts, session, producer, workspace, game, context)
 * + a `kind` + kind-specific fields. The label the model learns from is `decision`.
 *
 * Writes are async (this runs in the Electron main process — never block it).
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createTelemetryRecorder({ dataDir, appVersion = '', getContext, getIdentity } = {}) {
  const dir = path.join(dataDir || '.', 'telemetry');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  // Stable per-install id — the fallback "producer" when the app isn't cloud-authed yet.
  const installFile = path.join(dir, 'install-id');
  let installId = '';
  try { installId = fs.readFileSync(installFile, 'utf8').trim(); } catch (_) {}
  if (!installId) {
    installId = 'inst_' + randomUUID();
    try { fs.writeFileSync(installFile, installId); } catch (_) {}
  }

  let sessionId = 'sess_' + randomUUID();
  let enabled = true;
  const buffer = [];
  let flushTimer = null;
  let writing = false;

  function fileForNow() {
    const d = new Date();
    const day = '' + d.getFullYear()
      + String(d.getMonth() + 1).padStart(2, '0')
      + String(d.getDate()).padStart(2, '0');
    return path.join(dir, `decisions-${day}.jsonl`);
  }

  function identity() {
    let id = {};
    try { id = (typeof getIdentity === 'function' && getIdentity()) || {}; } catch (_) {}
    return { producerId: id.producerId || installId, workspaceId: id.workspaceId || 'local' };
  }

  function envelope() {
    let ctx = {};
    try { ctx = (typeof getContext === 'function' && getContext()) || {}; } catch (_) {}
    const who = identity();
    return {
      v: 1,
      ts: Date.now(),
      app: appVersion || null,
      sessionId,
      producerId: who.producerId,
      workspaceId: who.workspaceId,
      game: ctx.game || null,
      matchId: ctx.matchId != null ? ctx.matchId : null,
      gameId: ctx.gameId != null ? ctx.gameId : null,
      context: ctx.context || null,
    };
  }

  function scheduleFlush() {
    if (flushTimer || !buffer.length) return;
    flushTimer = setTimeout(flush, 1500);
  }

  function flush() {
    flushTimer = null;
    if (writing || !buffer.length) return;
    writing = true;
    const batch = buffer.splice(0, buffer.length);
    const lines = batch.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFile(fileForNow(), lines, (err) => {
      writing = false;
      if (err) console.error('[Telemetry] append failed:', err.message);
      if (buffer.length) scheduleFlush();
    });
  }

  function record(kind, payload) {
    if (!enabled) return null;
    const rec = Object.assign(envelope(), { kind }, payload || {});
    buffer.push(rec);
    scheduleFlush();
    return rec;
  }

  return {
    // ── session / control ──
    startSession() { sessionId = 'sess_' + randomUUID(); return sessionId; },
    getSessionId() { return sessionId; },
    getInstallId() { return installId; },
    setEnabled(v) { enabled = !!v; },
    isEnabled() { return enabled; },
    flush,

    // ── record kinds ──
    // The producer reacted to a camera/target recommendation.
    //   decision: 'accept' | 'override' | 'lock' | 'decline' | 'ignore'
    directorDecision(d = {}) {
      return record('director_decision', {
        recommendation: d.recommendation || null,
        decision: d.decision || 'accept',
        chosen: d.chosen || null,
        note: d.note || null,
        latencyMs: d.latencyMs != null ? d.latencyMs : null,
      });
    },

    // The engine proposed a new primary target (shadow stream — what it WANTED).
    recommendation(r = {}) {
      return record('recommendation', {
        recommendation: r.recommendation || r || null,
        autoActed: !!r.autoActed,
      });
    },

    // A clip was auto-captured or the producer kept/edited/rejected one.
    //   decision: 'auto' | 'keep' | 'edit' | 'reject' | 'tag'
    clipDecision(d = {}) {
      return record('clip_decision', {
        clipId: d.clipId || null,
        trigger: d.trigger || null,
        decision: d.decision || 'auto',
        trim: d.trim || null,
        tags: d.tags || null,
        note: d.note || null,
        playedToAir: !!d.playedToAir,
      });
    },

    // OBS program scene changed (the authoritative "on air" signal).
    sceneChange(s = {}) {
      return record('scene_change', {
        scene: s.scene || null,
        prevScene: s.prevScene || null,
        source: s.source || null,   // 'manual' | 'auto' | 'director' | 'unknown'
      });
    },

    // Raw normalized game event (optional; high-volume — wire sparingly).
    gameEvent(e = {}) {
      return record('game_event', { event: e || null });
    },

    // System marks (shield on/off, session boundaries, mode changes) — context for the dataset.
    mark(kind, payload = {}) {
      return record('mark:' + kind, payload);
    },
  };
}

module.exports = { createTelemetryRecorder };
