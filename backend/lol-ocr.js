/* ─── League gold OCR (optional, overrides the gold estimate) ─────────────────
 *
 * Riot's spectator Live Client Data API does not expose gold, so backend/lol-live.js
 * ESTIMATES team gold. This module reads the REAL team-gold totals straight off the
 * spectator scoreboard the way community tools (LeagueOCR) do: screen-capture the two
 * gold-number regions and OCR them, then hand the numbers back so server.js can
 * override the estimate. The producer calibrates the capture regions once.
 *
 * Capture: PowerShell + System.Drawing (Windows, no native npm module) — the same
 * dependency-free approach the LCU process fallback uses. Regions are upscaled 3x for
 * legibility. OCR: tesseract.js (lazy-loaded; if it isn't installed the module reports
 * 'unavailable' and the app keeps running on the estimate).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _tess = null;          // lazily-required tesseract.js
let _worker = null;        // reused OCR worker
let _workerReady = null;

function tessAvailable() {
  if (_tess) return true;
  try { _tess = require('tesseract.js'); return true; } catch (e) { return false; }
}

async function getWorker() {
  if (_worker) return _worker;
  if (!_workerReady) {
    _workerReady = (async () => {
      const { createWorker } = _tess;
      const w = await createWorker('eng');
      await w.setParameters({ tessedit_char_whitelist: '0123456789.,kK', tessedit_pageseg_mode: '7' });
      _worker = w;
      return w;
    })();
  }
  return _workerReady;
}

const TMP = path.join(os.tmpdir(), 'ne-lol-ocr');
try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) {}

// Capture the two gold regions to PNG (upscaled 3x) via PowerShell System.Drawing.
function captureRegions(blue, red) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('screen capture is Windows-only'));
    const bluePath = path.join(TMP, 'blue.png');
    const redPath  = path.join(TMP, 'red.png');
    // PowerShell single-quoted strings treat backslashes literally — do NOT escape
    // them (that would corrupt the Windows path). Only ' needs doubling.
    const psPath = (p) => p.replace(/'/g, "''");
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

// "32.4k" / "32,400" / "32400" → 32400
function parseGold(text) {
  if (!text) return null;
  let t = String(text).replace(/[^0-9.,kK]/g, '').trim();
  if (!t) return null;
  const hasK = /k/i.test(t);
  t = t.replace(/[kK]/g, '').replace(/,/g, '');
  let n = parseFloat(t);
  if (isNaN(n)) return null;
  if (hasK) n = n * 1000;                       // 32.4k → 32400
  else if (n < 1000 && /\./.test(t)) n = n * 1000;  // bare "32.4" reads as 32.4k
  return Math.round(n);
}

async function readOnce(regions) {
  if (!tessAvailable()) throw new Error('tesseract.js not installed');
  const { bluePath, redPath } = await captureRegions(regions.blue, regions.red);
  const w = await getWorker();
  const rb = await w.recognize(bluePath);
  const rr = await w.recognize(redPath);
  return {
    blue: parseGold(rb.data.text), blueRaw: (rb.data.text || '').replace(/\s+/g, ''),
    red:  parseGold(rr.data.text), redRaw:  (rr.data.text || '').replace(/\s+/g, '')
  };
}

// startOcr({ getRegions, onResult, onStatus, intervalMs }) → stop()
function startOcr(opts) {
  const { getRegions, onResult, onStatus } = opts || {};
  const intervalMs = (opts && opts.intervalMs) || 2000;
  let stopped = false, busy = false, timer = null;
  const status = (s, d) => { try { onStatus && onStatus(s, d || ''); } catch (e) {} };

  if (process.platform !== 'win32') { status('unavailable', 'OCR capture is Windows-only'); return () => {}; }
  if (!tessAvailable()) { status('unavailable', 'tesseract.js not installed — run npm install'); return () => {}; }
  status('starting', 'initialising OCR engine');

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const res = await readOnce(getRegions());
      status('reading', 'blue ' + (res.blueRaw || '-') + ' / red ' + (res.redRaw || '-'));
      try { onResult && onResult(res); } catch (e) {}
    } catch (e) {
      status('error', (e && e.message) || 'ocr error');
    } finally { busy = false; }
  }
  timer = setInterval(tick, intervalMs);
  tick();
  return function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; };
}

async function shutdown() {
  if (_worker) { try { await _worker.terminate(); } catch (e) {} }
  _worker = null; _workerReady = null;
}

module.exports = { startOcr, readOnce, parseGold, tessAvailable, shutdown, captureRegions };
