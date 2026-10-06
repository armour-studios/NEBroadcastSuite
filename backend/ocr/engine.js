/* ─── Screen OCR engine (shared by every game that has to READ a HUD) ─────────
 *
 * Some games give us no live data (Overwatch 2, Marvel Rivals, Rainbow Six, and League's
 * team gold, which the spectator API leaves out). The fallback is to read the spectator HUD
 * off the observer PC's screen. This module is the one place that knows how to do that; a
 * game-specific reader (backend/lol-ocr.js) just says WHICH boxes to read and what the
 * numbers mean.
 *
 * Pipeline per read:  capture display → crop region → grayscale → auto-invert (HUD text is
 * light-on-dark; Tesseract wants dark-on-light) → contrast stretch → upscale → pad →
 * recognise. When the first pass is unsure it retries on an Otsu-binarised copy and keeps
 * whichever pass Tesseract is more confident about.
 *
 * Capture: Electron's desktopCapturer from the main process (server.js runs there), which is
 * one in-process frame grab per tick instead of spawning PowerShell + System.Drawing and
 * writing PNGs to disk. Outside Electron (tests, node scripts) capture reports unavailable but
 * every pixel op and the recogniser still work, so the pipeline is testable on synthetic
 * images.
 *
 * OCR: tesseract.js, lazily required. Language data is bundled under assets/ocr so a venue
 * with no internet never hits tesseract.js's default CDN download; the worker cache lives in
 * userData (configure({ cachePath })) because the install directory is read-only.
 */
const path = require('path');
const os = require('os');
const zlib = require('zlib');

let _electron = null;
try {
  const e = require('electron');
  if (e && e.nativeImage && e.desktopCapturer) _electron = e;
} catch (e) { _electron = null; }

let _tess = null;
function available() {
  if (_tess) return true;
  try { _tess = require('tesseract.js'); return true; } catch (e) { return false; }
}

const _cfg = {
  langPath: path.join(__dirname, '..', '..', 'assets', 'ocr'),
  cachePath: path.join(os.tmpdir(), 'ne-ocr-cache'),
  lang: 'eng'
};
function configure(opts) {
  if (!opts) return;
  if (opts.langPath) _cfg.langPath = opts.langPath;
  if (opts.cachePath) _cfg.cachePath = opts.cachePath;
  if (opts.lang) _cfg.lang = opts.lang;
}

// ── Worker ────────────────────────────────────────────────────────────────────
let _worker = null, _workerReady = null, _paramsKey = '';

async function getWorker() {
  if (_worker) return _worker;
  if (!_workerReady) {
    _workerReady = (async () => {
      if (!available()) throw new Error('tesseract.js not installed');
      const { createWorker } = _tess;
      // OEM 1 = LSTM only. gzip:false because assets/ocr ships the plain .traineddata.
      const w = await createWorker(_cfg.lang, 1, {
        langPath: _cfg.langPath, cachePath: _cfg.cachePath, gzip: false, logger: () => {}
      });
      _worker = w;
      _paramsKey = '';
      return w;
    })().catch((e) => { _workerReady = null; throw e; });
  }
  return _workerReady;
}

async function setParams(w, whitelist, psm) {
  const key = whitelist + '|' + psm;
  if (key === _paramsKey) return;
  await w.setParameters({ tessedit_char_whitelist: whitelist || '', tessedit_pageseg_mode: String(psm || 7) });
  _paramsKey = key;
}

// recognize(pngBuffer, { whitelist, psm }) → { text, confidence, words:[{ text, confidence, bbox }] }
// A failed call tears the worker down so the next call gets a fresh one (tesseract.js workers
// do not recover from a wedged recognise).
async function recognize(png, opts) {
  const o = opts || {};
  const w = await getWorker();
  try {
    await setParams(w, o.whitelist != null ? o.whitelist : '', o.psm || 7);
    const r = await w.recognize(png);
    const d = r && r.data || {};
    return {
      text: (d.text || '').trim(),
      confidence: Number(d.confidence) || 0,
      words: (d.words || []).map((x) => ({ text: (x.text || '').trim(), confidence: Number(x.confidence) || 0, bbox: x.bbox }))
    };
  } catch (e) {
    await terminate();
    throw e;
  }
}

async function terminate() {
  const w = _worker;
  _worker = null; _workerReady = null; _paramsKey = '';
  if (w) { try { await w.terminate(); } catch (e) {} }
}

// ── Capture ───────────────────────────────────────────────────────────────────
function captureAvailable() { return !!_electron; }

// [{ id, label, x, y, width, height, scaleFactor, primary }] — width/height in PHYSICAL pixels,
// which is the coordinate space every region uses (what the producer sees in a screenshot).
function listDisplays() {
  if (!_electron || !_electron.screen) return [];
  const primary = _electron.screen.getPrimaryDisplay();
  return _electron.screen.getAllDisplays().map((d, i) => {
    const sf = d.scaleFactor || 1;
    return {
      id: String(d.id), label: 'Display ' + (i + 1) + ' (' + Math.round(d.size.width * sf) + '×' + Math.round(d.size.height * sf) + ')' + (d.id === primary.id ? ' · primary' : ''),
      x: d.bounds.x, y: d.bounds.y, width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf),
      scaleFactor: sf, primary: d.id === primary.id
    };
  });
}

// captureDisplay(displayId) → { data: Buffer(BGRA), width, height, displayId }
// Physical-pixel frame of one display. displayId '' = primary.
async function captureDisplay(displayId) {
  if (!_electron) throw new Error('screen capture needs the app (not available in plain node)');
  const { desktopCapturer, screen } = _electron;
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const want = displays.find((d) => String(d.id) === String(displayId || '')) || primary;
  const sf = want.scaleFactor || 1;
  const size = { width: Math.round(want.size.width * sf), height: Math.round(want.size.height * sf) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size, fetchWindowIcons: false });
  if (!sources.length) throw new Error('no screen sources (capture blocked?)');
  let src = sources.find((s) => String(s.display_id) === String(want.id));
  if (!src) {
    // Some drivers report no display_id; fall back to the source whose index matches.
    const idx = displays.indexOf(want);
    src = sources[idx] || sources[0];
  }
  const img = src.thumbnail;
  if (!img || img.isEmpty()) throw new Error('empty frame from ' + src.name);
  const sz = img.getSize();
  return { data: img.toBitmap(), width: sz.width, height: sz.height, displayId: String(want.id) };
}

// ── Pixel ops (pure JS, BGRA in / 8-bit gray out) ─────────────────────────────
function clampRegion(frame, r) {
  const x = Math.max(0, Math.min(frame.width - 1, Math.round(r.x || 0)));
  const y = Math.max(0, Math.min(frame.height - 1, Math.round(r.y || 0)));
  const w = Math.max(1, Math.min(frame.width - x, Math.round(r.w || 1)));
  const h = Math.max(1, Math.min(frame.height - y, Math.round(r.h || 1)));
  return { x, y, w, h };
}

// Crop + grayscale in one pass. Rec. 601 luma; channel order (BGRA vs RGBA) does not matter
// for a gray value within rounding, and we never need colour.
function cropGray(frame, region) {
  const r = clampRegion(frame, region);
  const out = new Uint8Array(r.w * r.h);
  const src = frame.data, W = frame.width;
  for (let y = 0; y < r.h; y++) {
    let si = ((r.y + y) * W + r.x) * 4, oi = y * r.w;
    for (let x = 0; x < r.w; x++, si += 4, oi++) {
      out[oi] = (src[si] * 29 + src[si + 1] * 150 + src[si + 2] * 77 + 128) >> 8;
    }
  }
  return { data: out, width: r.w, height: r.h, region: r };
}

function meanGray(g) {
  let s = 0; for (let i = 0; i < g.data.length; i++) s += g.data[i];
  return g.data.length ? s / g.data.length : 0;
}

function invert(g) {
  const out = new Uint8Array(g.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 255 - g.data[i];
  return { data: out, width: g.width, height: g.height };
}

// Stretch the 1st..99th percentile to 0..255 so dim HUD text fills the range.
function stretchContrast(g) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
  const n = g.data.length, loN = n * 0.01, hiN = n * 0.99;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loN) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n - hiN) { hi = v; break; } }
  if (hi - lo < 8) return { data: Uint8Array.from(g.data), width: g.width, height: g.height };
  const out = new Uint8Array(g.data.length), k = 255 / (hi - lo);
  for (let i = 0; i < out.length; i++) {
    const v = (g.data[i] - lo) * k;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
  return { data: out, width: g.width, height: g.height };
}

function otsuThreshold(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
  const total = g.data.length;
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = v; }
  }
  return thr;
}

function binarize(g, thr) {
  const t = thr == null ? otsuThreshold(g) : thr;
  const out = new Uint8Array(g.data.length);
  for (let i = 0; i < out.length; i++) out[i] = g.data[i] > t ? 255 : 0;
  return { data: out, width: g.width, height: g.height, threshold: t };
}

// Bilinear upscale — glyphs ~12px tall read badly; 3x puts them in Tesseract's comfort zone.
function upscale(g, factor) {
  const f = Math.max(1, factor || 1);
  if (f === 1) return { data: Uint8Array.from(g.data), width: g.width, height: g.height };
  const w = g.width, h = g.height, W = Math.round(w * f), H = Math.round(h * f);
  const out = new Uint8Array(W * H), src = g.data;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, y / f), y0 = sy | 0, y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, x / f), x0 = sx | 0, x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const a = src[y0 * w + x0], b = src[y0 * w + x1], c = src[y1 * w + x0], d = src[y1 * w + x1];
      out[y * W + x] = (a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy + 0.5) | 0;
    }
  }
  return { data: out, width: W, height: H };
}

// White border: Tesseract mis-segments text that touches the image edge.
function pad(g, p, value) {
  const v = value == null ? 255 : value;
  const W = g.width + 2 * p, H = g.height + 2 * p;
  const out = new Uint8Array(W * H).fill(v);
  for (let y = 0; y < g.height; y++) out.set(g.data.subarray(y * g.width, (y + 1) * g.width), (y + p) * W + p);
  return { data: out, width: W, height: H };
}

// ── PNG encode (8-bit grayscale, pure JS + zlib) ──────────────────────────────
// Lets the recogniser run on preprocessed pixels without nativeImage, so the same code path
// works inside Electron and in node tests.
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function grayToPng(g) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(g.width, 0); ihdr.writeUInt32BE(g.height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit, grayscale
  const raw = Buffer.alloc((g.width + 1) * g.height);
  for (let y = 0; y < g.height; y++) {
    raw[y * (g.width + 1)] = 0;   // filter: none
    raw.set(g.data.subarray(y * g.width, (y + 1) * g.width), y * (g.width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Preprocess + read ─────────────────────────────────────────────────────────
// preprocess(frame, region, opts) → { gray, binary, png, pngBinary, scale, pad, inverted, region }
//   opts.scale (3), opts.pad (10), opts.invert ('auto' | true | false)
function preprocess(frame, region, opts) {
  const o = opts || {};
  const scale = o.scale || 3, p = o.pad == null ? 10 : o.pad;
  let g = cropGray(frame, region);
  const reg = g.region;
  const mean = meanGray(g);
  const inv = o.invert === true || (o.invert !== false && mean < 128);   // light-on-dark → flip
  if (inv) g = invert(g);
  g = stretchContrast(g);
  const gray = pad(upscale(g, scale), p, 255);
  const binary = binarize(gray);
  return { gray, binary, png: grayToPng(gray), pngBinary: grayToPng(binary), scale, pad: p, inverted: inv, region: reg, mean };
}

// readRegion(frame, region, { whitelist, psm, scale, minConfidence }) → { text, confidence, pass }
// Two-pass: contrast-stretched gray first; if Tesseract is unsure, retry on the binarised
// copy and keep the more confident answer. Real HUD text (gradients, glow, textured
// backgrounds) is what makes the second pass pay for itself.
async function readRegion(frame, region, opts) {
  const o = opts || {};
  const pre = preprocess(frame, region, o);
  const min = o.minConfidence == null ? 75 : o.minConfidence;
  const a = await recognize(pre.png, { whitelist: o.whitelist, psm: o.psm || 7 });
  if (a.confidence >= min && a.text) return { text: a.text, confidence: a.confidence, pass: 'gray', pre };
  const b = await recognize(pre.pngBinary, { whitelist: o.whitelist, psm: o.psm || 7 });
  const best = (b.confidence > a.confidence || !a.text) && b.text ? { text: b.text, confidence: b.confidence, pass: 'binary' } : { text: a.text, confidence: a.confidence, pass: 'gray' };
  best.pre = pre;
  return best;
}

// locateWords(frame, region, { whitelist, scale }) → words with bboxes in FRAME pixel space.
// Sparse-text mode (psm 11) over a wide band; used to find where numbers sit on a HUD so the
// producer does not have to type pixel coordinates.
async function locateWords(frame, region, opts) {
  const o = opts || {};
  const pre = preprocess(frame, region, { scale: o.scale || 2, pad: 8, invert: o.invert });
  const r = await recognize(pre.png, { whitelist: o.whitelist, psm: 11 });
  const words = r.words.filter((w) => w.text && w.bbox).map((w) => {
    const b = w.bbox;
    const x0 = (b.x0 - pre.pad) / pre.scale + pre.region.x, x1 = (b.x1 - pre.pad) / pre.scale + pre.region.x;
    const y0 = (b.y0 - pre.pad) / pre.scale + pre.region.y, y1 = (b.y1 - pre.pad) / pre.scale + pre.region.y;
    return { text: w.text, confidence: w.confidence, x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  });
  return { words, confidence: r.confidence };
}

// Downscaled JPEG data URL of a whole frame (calibration preview). Electron only.
function frameToJpegDataUrl(frame, maxWidth, quality) {
  if (!_electron) return '';
  const img = _electron.nativeImage.createFromBitmap(frame.data, { width: frame.width, height: frame.height });
  const w = Math.min(frame.width, maxWidth || 960);
  const small = w < frame.width ? img.resize({ width: w }) : img;
  return 'data:image/jpeg;base64,' + small.toJPEG(quality || 70).toString('base64');
}
function grayToDataUrl(g) { return 'data:image/png;base64,' + grayToPng(g).toString('base64'); }

module.exports = {
  available, configure, recognize, terminate,
  captureAvailable, listDisplays, captureDisplay,
  cropGray, meanGray, invert, stretchContrast, otsuThreshold, binarize, upscale, pad, grayToPng,
  preprocess, readRegion, locateWords, frameToJpegDataUrl, grayToDataUrl
};
