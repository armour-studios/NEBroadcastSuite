// The show timeline: an always-on, plain record of what happened during a broadcast, so an
// intermittent "the scene got stuck" or "the score was wrong" can be traced to the step that
// stopped progressing instead of guessed at from the final screen.
//
// What goes in (see the record() calls in server.js): scene cuts asked for, landed, failed or
// dropped as stale; transitions borrowed and restored; game feed connect / disconnect / silent /
// flowing; game events received, applied, or rejected as duplicates; API replies dropped as stale;
// integration polls failing and recovering; browser sources refreshed; flows paused.
//
// Kept in memory (the last MAX events, for the panel and bug reports) and appended to
// <dataDir>/logs/show-timeline.jsonl, rotated at ROTATE_BYTES (one .1 file kept). Writes are batched
// and async: this runs in Electron's main process and must never block it. Never record secrets:
// callers pass names, ids and short messages only.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX = 2000;
const ROTATE_BYTES = 5 * 1024 * 1024;
const FLUSH_MS = 2000;

function createShowTimeline(opts = {}) {
  const ring = [];
  let seq = 0;
  let file = null, pending = [], timer = null, writing = false;

  function setDir(dataDir) {
    try {
      const dir = path.join(dataDir, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'show-timeline.jsonl');
    } catch (e) { file = null; }
  }
  if (opts.dataDir) setDir(opts.dataDir);

  function clean(v, depth) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '...' : v;
    if (depth > 2) return undefined;
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, depth + 1));
    if (typeof v === 'object') {
      const o = {};
      Object.keys(v).slice(0, 20).forEach((k) => { if (!/token|secret|password|key/i.test(k)) o[k] = clean(v[k], depth + 1); });
      return o;
    }
    return undefined;
  }

  // kind: short dotted name, e.g. 'scene.cut', 'rl.event.duplicate', 'api.stale'.
  function record(kind, data) {
    const ev = { seq: ++seq, t: Date.now(), kind: String(kind || 'event').slice(0, 60) };
    if (data !== undefined) ev.data = clean(data, 0);
    ring.push(ev);
    if (ring.length > MAX) ring.splice(0, ring.length - MAX);
    if (file) {
      pending.push(JSON.stringify(ev));
      if (!timer) { timer = setTimeout(flush, FLUSH_MS); if (timer.unref) timer.unref(); }
    }
    return ev;
  }

  async function flush() {
    timer = null;
    if (writing || !file || !pending.length) return;
    writing = true;
    const lines = pending.splice(0).join('\n') + '\n';
    try {
      try {
        const st = await fs.promises.stat(file);
        if (st.size > ROTATE_BYTES) await fs.promises.rename(file, file + '.1');
      } catch (e) { /* no file yet */ }
      await fs.promises.appendFile(file, lines);
    } catch (e) { /* diagnostics must never take the show down */ }
    writing = false;
    if (pending.length && !timer) { timer = setTimeout(flush, FLUSH_MS); if (timer.unref) timer.unref(); }
  }

  function since(afterSeq, limit) {
    const n = Number(afterSeq) || 0;
    const out = ring.filter((e) => e.seq > n);
    return limit ? out.slice(-limit) : out;
  }

  // Human-readable lines (bug reports, the panel's copy button).
  function text(limit) {
    return since(0, limit || 300).map((e) => {
      const d = new Date(e.t);
      const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0'), ss = String(d.getSeconds()).padStart(2, '0'), ms = String(d.getMilliseconds()).padStart(3, '0');
      return hh + ':' + mm + ':' + ss + '.' + ms + '  ' + e.kind + (e.data !== undefined ? '  ' + JSON.stringify(e.data) : '');
    }).join('\n');
  }

  return { record, since, text, flush, setDir, size: () => ring.length };
}

module.exports = { createShowTimeline };
