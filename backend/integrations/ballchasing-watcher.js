// ballchasing-watcher.js — optional local-folder auto-upload. Watches a Rocket League replay
// folder and uploads every NEW .replay file into a league's ballchasing group as it appears, so a
// producer never has to hand-pick files mid-broadcast. Off by default; started/stopped by
// server.js's syncBallchasingAutoUpload().
//
// Design notes:
// - RL writes a .replay while a match is still saving; watching for the create event and uploading
//   immediately can grab a half-written file. We debounce per-file and only upload once the file
//   size has been STABLE for a couple of seconds (RL has finished flushing it).
// - fs.watch fires duplicate/oversensitive events on Windows (and OneDrive-synced folders — the same
//   AV/sync churn that bit the overlay reload watcher). We dedupe by absolute path + only act on
//   files we haven't already uploaded this session.
const fs = require('fs');
const path = require('path');

function createBallchasingWatcher({ onUpload, log } = {}) {
  let watcher = null;
  let watchedFolder = '';
  const seen = new Set();          // absolute paths already uploaded (or in flight) this session
  const settleTimers = new Map();  // path -> timeout while we wait for the file to stop growing

  const note = (m) => { try { (log || (() => {}))(m); } catch (_) {} };

  function isReplay(f) { return /\.replay$/i.test(f); }

  // Wait until the file size is stable across two checks ~1.2s apart, then hand it off.
  function settleThenUpload(abs) {
    if (seen.has(abs)) return;
    let lastSize = -1;
    const check = () => {
      let st;
      try { st = fs.statSync(abs); } catch { settleTimers.delete(abs); return; }   // vanished — ignore
      if (st.size > 0 && st.size === lastSize) {
        settleTimers.delete(abs);
        seen.add(abs);
        note('Auto-upload: ' + path.basename(abs));
        Promise.resolve().then(() => onUpload && onUpload(abs)).catch((e) => {
          seen.delete(abs);   // let a later event retry a failed upload
          note('Auto-upload failed for ' + path.basename(abs) + ': ' + (e && e.message));
        });
        return;
      }
      lastSize = st.size;
      settleTimers.set(abs, setTimeout(check, 1200));
    };
    settleTimers.set(abs, setTimeout(check, 1200));
  }

  function start(folder) {
    stop();
    if (!folder) return false;
    try {
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) { note('Auto-upload folder not found: ' + folder); return false; }
    } catch { return false; }
    watchedFolder = folder;
    // Pre-seed with existing files so we don't bulk-upload the whole back-catalogue on start —
    // only replays that appear AFTER watching begins are auto-uploaded.
    try { fs.readdirSync(folder).forEach((f) => { if (isReplay(f)) seen.add(path.join(folder, f)); }); } catch {}
    try {
      watcher = fs.watch(folder, { persistent: false }, (_evt, filename) => {
        if (!filename || !isReplay(filename)) return;
        const abs = path.join(folder, filename);
        if (seen.has(abs) || settleTimers.has(abs)) return;
        settleThenUpload(abs);
      });
      note('Auto-upload watching: ' + folder);
      return true;
    } catch (e) { note('Auto-upload watch failed: ' + (e && e.message)); return false; }
  }

  function stop() {
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    settleTimers.forEach((t) => clearTimeout(t));
    settleTimers.clear();
    watchedFolder = '';
  }

  return { start, stop, get folder() { return watchedFolder; }, get active() { return !!watcher; } };
}

module.exports = { createBallchasingWatcher };
