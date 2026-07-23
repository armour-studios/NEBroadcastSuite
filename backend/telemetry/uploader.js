'use strict';

/**
 * Telemetry uploader — Phase 2 of the AI producer/director pipeline.
 *
 * A cursor-based tailer over the JSONL files recorder.js already writes to
 * `${dataDir}/telemetry/decisions-YYYYMMDD.jsonl`. Sibling to recorder.js — never
 * imports or modifies it; purely reads what's already on disk.
 *
 * Cursor is a byte offset per file (not a line count), persisted to
 * `telemetry/upload-cursor.json`, so each poll can seek straight to where it left
 * off instead of re-reading the whole file. Concurrency safety: recorder.js only
 * ever appends past EOF, and this only ever reads up to the last confirmed `\n` —
 * those two never touch the same bytes, so no lock is needed. A possibly-partial
 * final line (recorder.js mid-write) is simply left for the next poll.
 *
 * The cursor only advances when the CALLER confirms the upload succeeded (commit()
 * is a separate step) — so a crash or failed request just re-reads the same bytes
 * next time. Harmless: the server's skipDuplicates collapses the re-upload.
 */

const fs = require('fs');
const path = require('path');

const MAX_BATCH = 500;
const FILE_RE = /^decisions-(\d{8})\.jsonl$/;

function createTelemetryUploader({ dataDir } = {}) {
  const dir = path.join(dataDir || '.', 'telemetry');
  const cursorFile = path.join(dir, 'upload-cursor.json');

  function loadCursor() {
    try { return JSON.parse(fs.readFileSync(cursorFile, 'utf8')) || {}; } catch (_) { return {}; }
  }
  function saveCursor(cursor) {
    try { fs.writeFileSync(cursorFile, JSON.stringify(cursor)); } catch (e) { console.error('[Telemetry] cursor save failed:', e.message); }
  }

  function listFiles() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return []; }
    return names.filter((f) => FILE_RE.test(f)).sort();
  }

  // Reads new complete lines from `file` starting at `startOffset`, returns an array
  // of { record, endOffset } — endOffset is the byte offset immediately after that
  // line's trailing `\n`, so a caller can resume from any entry's endOffset. Lines
  // past the last `\n` in the read chunk are never included (may still be mid-write).
  function readNewLines(file, startOffset) {
    const full = path.join(dir, file);
    let buf;
    try {
      const stat = fs.statSync(full);
      if (stat.size <= startOffset) return [];
      const fd = fs.openSync(full, 'r');
      buf = Buffer.alloc(stat.size - startOffset);
      fs.readSync(fd, buf, 0, buf.length, startOffset);
      fs.closeSync(fd);
    } catch (e) {
      console.warn('[Telemetry] read failed for', file, '—', e.message);
      return [];
    }
    const out = [];
    let lineStart = 0;
    while (true) {
      const nl = buf.indexOf(10, lineStart); // '\n'
      if (nl < 0) break; // partial trailing line — left for next poll
      const lineBuf = buf.slice(lineStart, nl);
      const endOffset = startOffset + nl + 1;
      lineStart = nl + 1;
      const line = lineBuf.toString('utf8');
      if (!line.trim()) continue;
      try { out.push({ record: JSON.parse(line), endOffset }); }
      catch (e) { console.warn('[Telemetry] skipping malformed line in', file, '—', e.message); out.push({ record: null, endOffset }); }
    }
    return out;
  }

  // Collects up to MAX_BATCH unsent records (oldest files first), without mutating
  // the persisted cursor. Never returns more than MAX_BATCH — the server hard-rejects
  // oversized batches, so a file with more fresh lines than the remaining room is
  // trimmed to an exact line boundary and the rest picked up on the next poll.
  function collectUnsentBatch() {
    const cursor = loadCursor();
    const pendingCursor = Object.assign({}, cursor);
    const records = [];
    for (const file of listFiles()) {
      if (records.length >= MAX_BATCH) break;
      const lines = readNewLines(file, cursor[file] || 0);
      if (!lines.length) continue;
      const room = MAX_BATCH - records.length;
      const take = lines.slice(0, room);
      for (const entry of take) { if (entry.record) records.push(entry.record); }
      pendingCursor[file] = take[take.length - 1].endOffset;
    }
    return { records, pendingCursor };
  }

  function commit(pendingCursor) {
    if (!pendingCursor) return;
    saveCursor(pendingCursor);
  }

  return { collectUnsentBatch, commit };
}

module.exports = { createTelemetryUploader };
