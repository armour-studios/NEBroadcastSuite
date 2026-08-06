// replay-renamer.js — manual, on-demand batch tool: scans a local RL replay folder and renames every
// file that still looks like RL's own un-renamed default output to a human-readable name (team names +
// game number + score), matched against this app's recorded game history by timestamp proximity. No RL
// binary .replay parsing — deliberately avoided (this app's own game-history log already carries the
// team/score/timestamp data a producer wants in the filename). Not a watcher: invoked once per button
// press via scanAndRenameReplays(), unlike ballchasing-watcher.js's continuous fs.watch lifecycle.
//
// Design notes:
// - Idempotency without a persisted "seen" file: we only ever touch files whose CURRENT name still
//   matches RL's default hash-like pattern (see DEFAULT_NAME_RE below). A file already renamed by this
//   tool, or named by the producer, never matches again — so re-running the scan is always safe.
// - RL may still be flushing a very recently finished replay to disk. Reuses ballchasing-watcher.js's
//   settle-before-touch idea: wait until file size is stable across two checks before reading its mtime
//   or renaming it, so a half-written file is never raced.
// - No match within tolerance => leave the file untouched and report "no match". Never guess — a wrong
//   rename is worse than a skipped one, and the file stays eligible for a future run once history exists.
const fs = require('fs');
const path = require('path');

// RL's default replay output is a 32-character hex, hyphen/space-free name (e.g.
// "05C9E9BB4667C6BF3AD26C93BB1BEEEA.replay"). Confirm against a real replay folder before relying on
// this for a live event — see the plan's open question if files aren't being picked up as expected.
const DEFAULT_NAME_RE = /^[0-9A-F]{32}\.replay$/i;

function isReplay(f) { return /\.replay$/i.test(f); }
function isDefaultName(f) { return DEFAULT_NAME_RE.test(f); }

// Reusable filename-part sanitizer, scoped to this feature only (no shared sanitizer exists yet in
// this repo — every other call site rolls its own inline regex; not retrofitting those here).
function sanitizeFilenamePart(s, maxLen) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]+/g, '')      // Windows-illegal characters
    .replace(/[^\x20-\x7E]+/g, '_')     // non-ASCII -> underscore
    .trim()
    .slice(0, maxLen || 40) || 'Unknown';
}

// "{YYYY-MM-DD} G{NN} - {team_a} vs {team_b} ({score_a}-{score_b}).replay"
function proposeReplayName({ teamA, teamB, gameNumber, scoreA, scoreB, startedAt }) {
  const d = new Date(startedAt || Date.now());
  const date = d.toISOString().slice(0, 10);
  const g = String(gameNumber || 1).padStart(2, '0');
  const a = sanitizeFilenamePart(teamA), b = sanitizeFilenamePart(teamB);
  return `${date} G${g} - ${a} vs ${b} (${scoreA ?? 0}-${scoreB ?? 0}).replay`;
}

// Numeric-suffix collision resolution: "name.replay" -> "name (2).replay" -> "name (3).replay" ...
function resolveCollisionName(dir, desiredName) {
  if (!fs.existsSync(path.join(dir, desiredName))) return desiredName;
  const ext = path.extname(desiredName);
  const base = desiredName.slice(0, -ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

// Wait until file size is stable across two checks ~1.2s apart (same cadence as
// ballchasing-watcher.js's settleThenUpload), as a Promise since this is a one-shot batch scan rather
// than an event-driven watcher.
function settle(absPath) {
  return new Promise((resolve, reject) => {
    let lastSize = -1;
    const check = () => {
      let st;
      try { st = fs.statSync(absPath); } catch (e) { reject(e); return; }
      if (st.size > 0 && st.size === lastSize) { resolve(st); return; }
      lastSize = st.size;
      setTimeout(check, 1200);
    };
    setTimeout(check, 1200);
  });
}

// Main entry point. findNearestGame(timestampMs) -> same shape as stats.findNearestRlGame(), or null.
// Returns { renamed: [{absPath, originalName, newName, matchedGame}], skipped: [{originalName, reason}] }.
// Does NOT upload — the caller hands renamed[].absPath to the existing ballchasing upload path.
async function scanAndRenameReplays({ folder, findNearestGame, log } = {}) {
  const note = (m) => { try { (log || (() => {}))(m); } catch (_) {} };
  const renamed = [], skipped = [];
  let entries;
  try { entries = fs.readdirSync(folder); } catch (e) { throw new Error('Cannot read folder: ' + e.message); }

  const candidates = entries.filter(isReplay);
  const alreadyNamed = candidates.filter((f) => !isDefaultName(f)).length;
  if (alreadyNamed) note(`Rename: skipping ${alreadyNamed} file(s) that don't look like default RL names (already renamed or producer-named).`);

  for (const f of candidates.filter(isDefaultName)) {
    const abs = path.join(folder, f);
    let st;
    try { st = await settle(abs); } catch (e) { skipped.push({ originalName: f, reason: 'Vanished before it could be read.' }); continue; }
    const match = findNearestGame(st.mtimeMs);
    if (!match) { skipped.push({ originalName: f, reason: 'No matching recorded game within the time window.' }); continue; }
    const desired = proposeReplayName({ teamA: match.teamA, teamB: match.teamB, gameNumber: match.gameNumber, scoreA: match.scoreA, scoreB: match.scoreB, startedAt: match.startedAt });
    const finalName = resolveCollisionName(folder, desired);
    const newAbs = path.join(folder, finalName);
    try { fs.renameSync(abs, newAbs); } catch (e) { skipped.push({ originalName: f, reason: 'Rename failed: ' + e.message }); continue; }
    renamed.push({ absPath: newAbs, originalName: f, newName: finalName, matchedGame: { teamA: match.teamA, teamB: match.teamB, gameNumber: match.gameNumber, scoreA: match.scoreA, scoreB: match.scoreB, deltaMs: match.deltaMs } });
  }
  return { renamed, skipped };
}

module.exports = { scanAndRenameReplays, isDefaultName, isReplay, proposeReplayName, sanitizeFilenamePart, resolveCollisionName, DEFAULT_NAME_RE };
