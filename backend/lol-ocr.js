/* ─── League gold OCR (optional, overrides the gold estimate) ─────────────────
 *
 * Riot's spectator Live Client Data API does not expose gold, so backend/lol-live.js
 * ESTIMATES team gold. This module reads the REAL team-gold totals straight off the
 * spectator scoreboard the way community tools (LeagueOCR) do: grab the two gold-number
 * regions off the observer display, OCR them, and hand the numbers back so server.js can
 * override the estimate.
 *
 * Built on backend/ocr/engine.js (capture + preprocessing + Tesseract). This file owns what
 * is League-specific:
 *   - parseGold:   "32.4k" / "32,400" / "32400" → 32400
 *   - GoldTracker: rejects reads that cannot be true (low confidence, out of range, gold
 *                  going DOWN mid-game, a jump bigger than a team can earn in the time
 *                  since the last read) so one misread never flickers the overlay
 *   - autoLocate:  finds the two gold numbers on the top HUD band by OCR so the producer
 *                  clicks one button instead of typing pixel coordinates
 *   - snapshot:    the calibration picture (whole display + what the engine sees per box)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('./ocr/engine');

const WHITELIST = '0123456789.,kK';
const GOLD_MAX = 250000;          // no pro game has come near this; anything above is a misread

function tessAvailable() { return engine.available(); }
function configure(opts) { engine.configure(opts); }

// "32.4k" / "32,4k" / "32,400" / "32.400" / "32400" / "324" → gold, or null when it cannot be gold.
function parseGold(text) {
  if (text == null) return null;
  let t = String(text).replace(/[^0-9.,kK]/g, '');
  if (!t) return null;
  const hasK = /k/i.test(t);
  t = t.replace(/[kK]/g, '');
  if (!/^\d/.test(t)) return null;
  let n;
  const m = t.match(/^(\d+)(?:[.,](\d+))?$/);
  if (!m) return null;
  const whole = m[1], frac = m[2];
  if (hasK) {
    // 32.4k, 32,4k, 32k, 32.45k → thousands with up to 2 decimals
    if (frac != null && frac.length > 2) return null;
    n = (parseInt(whole, 10) + (frac ? parseInt(frac, 10) / Math.pow(10, frac.length) : 0)) * 1000;
  } else if (frac != null && frac.length === 3) {
    n = parseInt(whole + frac, 10);                              // 32,400 thousands separator
  } else if (frac != null && frac.length <= 2 && parseInt(whole, 10) < 1000) {
    n = (parseInt(whole, 10) + parseInt(frac, 10) / Math.pow(10, frac.length)) * 1000;   // "32.4" = 32.4k with the k lost
  } else if (frac != null) {
    return null;
  } else {
    n = parseInt(whole, 10);
    if (n < 1000 && whole.length <= 3) n = n * 1000;                 // bare "32" = 32k (the k dropped)
  }
  if (!isFinite(n) || n < 0 || n > GOLD_MAX * 4) return null;
  return Math.round(n);
}

// Per-side sanity filter + smoothing. accept(side, value, confidence, ts) → { value, accepted, reason }
//   value    = the number the overlay should show (the accepted read, or the last good one)
//   accepted = whether THIS read was taken
// Rules: minConfidence gate; range gate; gold never decreases within a game (a drop of more
// than half is treated as a new game, but only once it repeats); an increase larger than the
// team could earn since the last read must repeat before it is believed.
class GoldTracker {
  constructor(opts) {
    const o = opts || {};
    this.minConfidence = o.minConfidence == null ? 55 : o.minConfidence;
    this.maxRatePerSec = o.maxRatePerSec == null ? 2500 : o.maxRatePerSec;   // 5 kills + objectives in a fight
    this.jumpAllow = o.jumpAllow == null ? 4000 : o.jumpAllow;               // slack on top of the rate
    this.maxGold = o.maxGold == null ? GOLD_MAX : o.maxGold;
    this.last = {};        // side → { value, ts }
    this.candidate = {};   // side → { value, count } for jumps/resets awaiting confirmation
  }
  reset() { this.last = {}; this.candidate = {}; }
  _confirm(side, value) {
    const c = this.candidate[side];
    if (c && Math.abs(c.value - value) <= Math.max(500, value * 0.05)) { c.count++; return c.count >= 2; }
    this.candidate[side] = { value, count: 1 };
    return false;
  }
  accept(side, value, confidence, ts) {
    const now = ts || Date.now();
    const last = this.last[side];
    const keep = (reason) => ({ value: last ? last.value : null, accepted: false, reason });
    if (value == null || isNaN(value)) return keep('noread');
    if ((Number(confidence) || 0) < this.minConfidence) return keep('lowconf');
    if (value < 0 || value > this.maxGold) return keep('range');
    if (!last) { this.last[side] = { value, ts: now }; this.candidate[side] = null; return { value, accepted: true, reason: 'first' }; }
    const dt = Math.max(0, (now - last.ts) / 1000);
    if (value < last.value) {
      // Within a game gold only grows. A collapse to under half is a NEW game; anything else
      // is a misread (a dropped digit reads 3.2k for 32k). Both must repeat before they count.
      if (value < last.value * 0.5 && this._confirm(side, value)) { this.last[side] = { value, ts: now }; this.candidate[side] = null; return { value, accepted: true, reason: 'reset' }; }
      return keep('decrease');
    }
    const allowed = this.jumpAllow + this.maxRatePerSec * dt;
    if (value - last.value > allowed && !this._confirm(side, value)) return keep('jump');
    this.last[side] = { value, ts: now }; this.candidate[side] = null;
    return { value, accepted: true, reason: 'ok' };
  }
}

// ── Capture fallback (PowerShell + System.Drawing) — only when Electron capture is missing ──
const TMP = path.join(os.tmpdir(), 'ne-lol-ocr');
try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) {}

function captureRegions(blue, red) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('screen capture is Windows-only'));
    const bluePath = path.join(TMP, 'blue.png');
    const redPath  = path.join(TMP, 'red.png');
    const psPath = (p) => p.replace(/'/g, "''");   // single-quoted PS strings: only ' needs doubling
    const SCALE = 3;
    const cap = (r, p) => `Cap ${Math.round(r.x)} ${Math.round(r.y)} ${Math.max(1,Math.round(r.w))} ${Math.max(1,Math.round(r.h))} '${psPath(p)}'`;
    const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
function Cap($x,$y,$w,$h,$p){
  $src = New-Object System.Drawing.Bitmap $w,$h
  $g = [System.Drawing.Graphics]::FromImage($src)
  $g.CopyFromScreen($x,$y,0,0,$src.Size)
  $dst = New-Object System.Drawing.Bitmap (($w*${SCALE}),($h*${SCALE}))
  $g2 = [System.Drawing.Graphics]::FromImage($dst)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($src,0,0,($w*${SCALE}),($h*${SCALE}))
  $dst.Save($p,[System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $g2.Dispose(); $src.Dispose(); $dst.Dispose()
}
${cap(blue, bluePath)}
${cap(red, redPath)}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => err += d);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ bluePath, redPath }) : reject(new Error((err || '').trim() || ('powershell exit ' + code))));
  });
}

async function readOnceLegacy(regions) {
  const { bluePath, redPath } = await captureRegions(regions.blue, regions.red);
  const rb = await engine.recognize(bluePath, { whitelist: WHITELIST, psm: 7 });
  const rr = await engine.recognize(redPath, { whitelist: WHITELIST, psm: 7 });
  return {
    blue: parseGold(rb.text), blueRaw: rb.text.replace(/\s+/g, ''), blueConf: rb.confidence,
    red:  parseGold(rr.text), redRaw:  rr.text.replace(/\s+/g, ''), redConf:  rr.confidence,
    capture: 'powershell'
  };
}

// readOnce(regions, displayId) → { blue, blueRaw, blueConf, red, redRaw, redConf, capture }
async function readOnce(regions, displayId) {
  if (!engine.available()) throw new Error('tesseract.js not installed');
  if (!engine.captureAvailable()) return readOnceLegacy(regions);
  const frame = await engine.captureDisplay(displayId);
  const rb = await engine.readRegion(frame, regions.blue, { whitelist: WHITELIST, psm: 7 });
  const rr = await engine.readRegion(frame, regions.red,  { whitelist: WHITELIST, psm: 7 });
  return {
    blue: parseGold(rb.text), blueRaw: rb.text.replace(/\s+/g, ''), blueConf: Math.round(rb.confidence),
    red:  parseGold(rr.text), redRaw:  rr.text.replace(/\s+/g, ''), redConf:  Math.round(rr.confidence),
    capture: 'display'
  };
}

// ── Auto-locate ───────────────────────────────────────────────────────────────
const GOLD_WORD_RE = /^\d{1,3}([.,]\d{1,2})?[kK]$|^\d{1,3}[.,]\d{3}$|^\d{4,6}$/;

// pickGoldWords(words, frameWidth) → { blue, red } regions or null. Gold numbers sit either
// side of the centre clock on the spectator top bar: blue's is the rightmost gold-looking word
// LEFT of centre, red's the leftmost RIGHT of centre (both nearest the clock).
function pickGoldWords(words, frameWidth, minConfidence) {
  const min = minConfidence == null ? 50 : minConfidence;
  const cands = (words || []).filter((w) => GOLD_WORD_RE.test(w.text) && w.confidence >= min && w.w > 0 && w.h > 0);
  if (cands.length < 2) return null;
  const mid = frameWidth / 2;
  const left = cands.filter((w) => w.x + w.w / 2 < mid).sort((a, b) => (b.x + b.w) - (a.x + a.w));
  const right = cands.filter((w) => w.x + w.w / 2 >= mid).sort((a, b) => a.x - b.x);
  let blue = left[0], red = right[0];
  if (!blue || !red) {
    // Nothing straddles the centre (odd layouts): fall back to the outermost pair.
    const byX = cands.slice().sort((a, b) => a.x - b.x);
    blue = byX[0]; red = byX[byX.length - 1];
    if (blue === red) return null;
  }
  const box = (w) => {
    const px = Math.max(6, Math.round(w.h * 0.4)), py = Math.max(4, Math.round(w.h * 0.3));
    return { x: Math.max(0, w.x - px), y: Math.max(0, w.y - py), w: w.w + 2 * px, h: Math.max(16, w.h + 2 * py) };
  };
  return { blue: box(blue), red: box(red), words: { blue, red } };
}

// autoLocate({ displayId, bandHeight }) → { ok, regions, words, message }
// Scans the top band of the display in sparse-text mode and picks the two gold numbers.
async function autoLocate(opts) {
  const o = opts || {};
  if (!engine.available()) return { ok: false, message: 'tesseract.js not installed' };
  if (!engine.captureAvailable()) return { ok: false, message: 'Auto-detect needs the app\'s screen capture (not available here).' };
  const frame = await engine.captureDisplay(o.displayId);
  const bandH = Math.min(frame.height, Math.round((o.bandHeight || 0.09) <= 1 ? frame.height * (o.bandHeight || 0.09) : o.bandHeight));
  const band = { x: 0, y: 0, w: frame.width, h: bandH };
  const { words } = await engine.locateWords(frame, band, { whitelist: WHITELIST, scale: 2 });
  const pick = pickGoldWords(words, frame.width);
  if (!pick) {
    const seen = words.filter((w) => w.confidence >= 40).map((w) => w.text).slice(0, 8).join(' ');
    return { ok: false, message: 'Could not find two gold numbers on the top of the screen. Is the spectator scoreboard showing?' + (seen ? ' Saw: ' + seen : ''), words };
  }
  return { ok: true, regions: { blue: pick.blue, red: pick.red }, words: pick.words, displayId: frame.displayId, frame: { width: frame.width, height: frame.height } };
}

// snapshot({ displayId, regions }) → calibration picture: the display (downscaled JPEG) plus
// each box exactly as the engine sees it and what it read there.
async function snapshot(opts) {
  const o = opts || {};
  if (!engine.captureAvailable()) return { ok: false, message: 'Snapshot needs the app\'s screen capture (not available here).' };
  const frame = await engine.captureDisplay(o.displayId);
  const out = { ok: true, displayId: frame.displayId, width: frame.width, height: frame.height, image: engine.frameToJpegDataUrl(frame, 1280, 72) };
  if (o.regions && engine.available()) {
    for (const side of ['blue', 'red']) {
      if (!o.regions[side]) continue;
      try {
        const r = await engine.readRegion(frame, o.regions[side], { whitelist: WHITELIST, psm: 7 });
        out[side] = { png: engine.grayToDataUrl(r.pass === 'binary' ? r.pre.binary : r.pre.gray), text: r.text, value: parseGold(r.text), confidence: Math.round(r.confidence), pass: r.pass, inverted: r.pre.inverted };
      } catch (e) {
        out[side] = { error: (e && e.message) || 'read failed' };
      }
    }
  }
  return out;
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
// startOcr({ getRegions, getDisplayId, onResult, onStatus, intervalMs }) → stop()
// onResult gets { blue, red, blueRaw, redRaw, blueConf, redConf, accepted:{blue,red}, reason:{blue,red} }
// where blue/red are the TRACKER's values (validated + held over a bad frame), not the raw read.
function startOcr(opts) {
  const { getRegions, getDisplayId, onResult, onStatus } = opts || {};
  const intervalMs = (opts && opts.intervalMs) || 1000;
  let stopped = false, busy = false, timer = null, errors = 0;
  const tracker = new GoldTracker(opts && opts.tracker);
  const status = (s, d) => { try { onStatus && onStatus(s, d || ''); } catch (e) {} };

  if (!engine.available()) { status('unavailable', 'tesseract.js not installed — run npm install'); return () => {}; }
  if (!engine.captureAvailable() && process.platform !== 'win32') { status('unavailable', 'OCR capture is Windows-only outside the app'); return () => {}; }
  status('starting', 'initialising OCR engine');

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const raw = await readOnce(getRegions(), getDisplayId ? getDisplayId() : '');
      const now = Date.now();
      const b = tracker.accept('blue', raw.blue, raw.blueConf, now);
      const r = tracker.accept('red', raw.red, raw.redConf, now);
      errors = 0;
      const res = {
        blue: b.value, red: r.value, blueRaw: raw.blueRaw, redRaw: raw.redRaw,
        blueConf: raw.blueConf, redConf: raw.redConf,
        accepted: { blue: b.accepted, red: r.accepted }, reason: { blue: b.reason, red: r.reason }, capture: raw.capture
      };
      const locked = b.accepted && r.accepted;
      status(locked ? 'reading' : (b.value != null && r.value != null ? 'holding' : 'searching'),
        'blue ' + (raw.blueRaw || '-') + ' (' + (raw.blueConf || 0) + '%) / red ' + (raw.redRaw || '-') + ' (' + (raw.redConf || 0) + '%)');
      try { onResult && onResult(res); } catch (e) {}
    } catch (e) {
      errors++;
      status('error', (e && e.message) || 'ocr error');
      if (errors >= 5) { try { await engine.terminate(); } catch (e2) {} errors = 0; }   // wedged worker → rebuild
    } finally { busy = false; }
  }
  timer = setInterval(tick, intervalMs);
  tick().catch((e) => console.warn('[lol-ocr: poll failed]', (e && e.message) || e));
  return function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; tracker.reset(); };
}

async function shutdown() { await engine.terminate(); }

function listDisplays() { return engine.listDisplays(); }

module.exports = {
  startOcr, readOnce, parseGold, tessAvailable, shutdown, captureRegions, configure,
  GoldTracker, pickGoldWords, autoLocate, snapshot, listDisplays, GOLD_WORD_RE, WHITELIST
};
