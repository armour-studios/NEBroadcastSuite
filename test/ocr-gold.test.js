// OCR gold pipeline: number parsing, the sanity tracker, auto-locate word picking and the
// pure-JS pixel ops in backend/ocr/engine.js. None of this needs Electron or Tesseract, so it
// runs in plain node. Set OCR_LIVE=1 to also run the real recogniser on a rendered image
// (Windows only — the image is drawn with System.Drawing).
//
// Run: node test/ocr-gold.test.js
const assert = require('assert');
const path = require('path');
const zlib = require('zlib');
const { parseGold, GoldTracker, pickGoldWords } = require('../backend/lol-ocr');
const engine = require('../backend/ocr/engine');

let n = 0;
const ok = (msg) => { n++; };

// ── parseGold ────────────────────────────────────────────────────────────────
const parse = [
  ['32.4k', 32400], ['32,4k', 32400], ['32k', 32000], ['32.45k', 32450],
  ['32,400', 32400], ['32.400', 32400], ['32400', 32400],
  ['32.4', 32400],            // the k lost by OCR
  ['32', 32000],              // bare "32" = 32k
  ['1.2K', 1200],
  [' 58.1k ', 58100],
  ['', null], [null, null], ['k', null], ['.', null], ['32.4.1k', null],
  ['32.456k', null],          // 3 decimals with k is not a gold read
  ['999999999', null],        // far past any plausible total
];
for (const [inp, exp] of parse) { assert.strictEqual(parseGold(inp), exp, 'parseGold(' + JSON.stringify(inp) + ')'); ok(); }

// ── GoldTracker ──────────────────────────────────────────────────────────────
{
  const t = new GoldTracker();
  const t0 = 1000000;
  let r = t.accept('blue', 12000, 90, t0);
  assert.deepStrictEqual([r.value, r.accepted, r.reason], [12000, true, 'first']); ok();

  // Low confidence: held, last good value returned.
  r = t.accept('blue', 15000, 40, t0 + 1000);
  assert.deepStrictEqual([r.value, r.accepted, r.reason], [12000, false, 'lowconf']); ok();

  // Normal growth over one second.
  r = t.accept('blue', 12600, 88, t0 + 2000);
  assert.deepStrictEqual([r.value, r.accepted, r.reason], [12600, true, 'ok']); ok();

  // A dropped digit: 12.6k read as 1.6k — that is a decrease, hold.
  r = t.accept('blue', 1600, 85, t0 + 3000);
  assert.deepStrictEqual([r.value, r.accepted, r.reason], [12600, false, 'decrease']); ok();

  // An impossible jump (+40k in 1s) is held the first time…
  r = t.accept('blue', 52600, 92, t0 + 4000);
  assert.deepStrictEqual([r.value, r.accepted, r.reason], [12600, false, 'jump']); ok();
  // …and believed once it repeats (the game really is there; maybe a long capture gap).
  r = t.accept('blue', 52700, 92, t0 + 5000);
  assert.deepStrictEqual([r.value, r.accepted, r.reason], [52700, true, 'ok']); ok();

  // Out-of-range garbage never gets in.
  r = t.accept('blue', 900000, 99, t0 + 6000);
  assert.deepStrictEqual([r.value, r.accepted, r.reason], [52700, false, 'range']); ok();

  // A new game: gold collapses to under half and stays there → accepted on the repeat.
  r = t.accept('blue', 2500, 90, t0 + 7000);
  assert.strictEqual(r.accepted, false); ok();
  r = t.accept('blue', 2550, 90, t0 + 8000);
  assert.deepStrictEqual([r.value, r.accepted, r.reason], [2550, true, 'reset']); ok();

  // A jump candidate that does NOT repeat is discarded, not accumulated.
  const t2 = new GoldTracker();
  t2.accept('red', 10000, 90, t0);
  assert.strictEqual(t2.accept('red', 40000, 90, t0 + 1000).accepted, false);
  assert.strictEqual(t2.accept('red', 10300, 90, t0 + 2000).accepted, true);
  assert.strictEqual(t2.accept('red', 45000, 90, t0 + 3000).accepted, false, 'a different jump must start its own confirmation');
  ok();

  // Sides are independent.
  const t3 = new GoldTracker();
  t3.accept('blue', 20000, 90, t0);
  assert.strictEqual(t3.accept('red', 5000, 90, t0).accepted, true); ok();

  // Big allowance scales with elapsed time (a 30 s gap allows a big move).
  const t4 = new GoldTracker();
  t4.accept('blue', 20000, 90, t0);
  assert.strictEqual(t4.accept('blue', 60000, 90, t0 + 30000).accepted, true); ok();
}

// ── pickGoldWords ────────────────────────────────────────────────────────────
{
  const W = 1920;
  const words = [
    { text: '12:34', confidence: 90, x: 930, y: 10, w: 60, h: 22 },      // clock, not gold
    { text: '32.4k', confidence: 88, x: 800, y: 14, w: 70, h: 24 },      // blue gold
    { text: '7', confidence: 95, x: 700, y: 14, w: 12, h: 24 },          // kills (single digit) — not gold
    { text: '35.1k', confidence: 91, x: 1050, y: 14, w: 70, h: 24 },     // red gold
    { text: '28.0k', confidence: 30, x: 1300, y: 14, w: 70, h: 24 },     // low confidence noise
    { text: '4', confidence: 90, x: 1200, y: 14, w: 12, h: 24 },
  ];
  const p = pickGoldWords(words, W);
  assert(p, 'should find both');
  assert.strictEqual(p.words.blue.text, '32.4k');
  assert.strictEqual(p.words.red.text, '35.1k');
  assert(p.blue.x < 800 && p.blue.w > 70 && p.blue.h >= 24, 'blue box padded around the word');
  assert(p.red.x < 1050 && p.red.x + p.red.w > 1120, 'red box padded around the word');
  ok();

  // Two candidates left of centre: the one NEAREST the clock is blue's.
  const p2 = pickGoldWords([
    { text: '11.1k', confidence: 90, x: 300, y: 14, w: 70, h: 24 },
    { text: '32.4k', confidence: 90, x: 800, y: 14, w: 70, h: 24 },
    { text: '35.1k', confidence: 90, x: 1050, y: 14, w: 70, h: 24 },
  ], W);
  assert.strictEqual(p2.words.blue.text, '32.4k'); ok();

  // Only one gold-looking word → null (never guess a second box).
  assert.strictEqual(pickGoldWords([{ text: '32.4k', confidence: 90, x: 800, y: 14, w: 70, h: 24 }], W), null); ok();
  assert.strictEqual(pickGoldWords([], W), null); ok();
}

// ── engine pixel ops on a synthetic frame ────────────────────────────────────
{
  // 40×20 BGRA frame: dark background with a light 10×8 block (a "glyph") at (10,6).
  const W = 40, H = 20;
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = 20; data[i * 4 + 1] = 22; data[i * 4 + 2] = 26; data[i * 4 + 3] = 255; }
  for (let y = 6; y < 14; y++) for (let x = 10; x < 20; x++) { const i = (y * W + x) * 4; data[i] = 90; data[i + 1] = 200; data[i + 2] = 230; }
  const frame = { data, width: W, height: H };

  const g = engine.cropGray(frame, { x: 0, y: 0, w: W, h: H });
  assert.strictEqual(g.width, W); assert.strictEqual(g.height, H);
  assert(g.data[6 * W + 10] > 150 && g.data[0] < 40, 'luma separates glyph from background'); ok();

  // Region clamping never reads outside the frame.
  const c = engine.cropGray(frame, { x: 35, y: 15, w: 100, h: 100 });
  assert.deepStrictEqual([c.width, c.height], [5, 5]); ok();

  const pre = engine.preprocess(frame, { x: 5, y: 2, w: 25, h: 16 }, { scale: 3, pad: 4 });
  assert.strictEqual(pre.inverted, true, 'light-on-dark gets inverted');
  assert.strictEqual(pre.gray.width, 25 * 3 + 8); assert.strictEqual(pre.gray.height, 16 * 3 + 8);
  // After inversion the glyph is DARK on a LIGHT page; the padding is white.
  assert.strictEqual(pre.gray.data[0], 255, 'padding is white');
  const gx = (10 - 5 + 5) * 3 + 4, gy = (6 - 2 + 4) * 3 + 4;   // a point well inside the glyph
  assert(pre.gray.data[gy * pre.gray.width + gx] < 60, 'glyph is dark after invert + stretch');
  assert.strictEqual(pre.binary.data[gy * pre.binary.width + gx], 0, 'binarised glyph is black');
  assert.strictEqual(pre.binary.data[0], 255, 'binarised page is white');
  ok();

  // Otsu on a clean bimodal image lands between the modes.
  const t = engine.otsuThreshold(pre.gray);
  assert(t > 40 && t < 220, 'otsu threshold ' + t); ok();

  // Upscale keeps proportions; pad adds the border on every side.
  const up = engine.upscale({ data: new Uint8Array([0, 255, 255, 0]), width: 2, height: 2 }, 2);
  assert.deepStrictEqual([up.width, up.height], [4, 4]);
  assert.strictEqual(up.data[0], 0); assert.strictEqual(up.data[3], 255); ok();
  const pd = engine.pad({ data: new Uint8Array([7]), width: 1, height: 1 }, 2, 255);
  assert.deepStrictEqual([pd.width, pd.height], [5, 5]); assert.strictEqual(pd.data[12], 7); assert.strictEqual(pd.data[0], 255); ok();

  // PNG encoder: valid signature/IHDR and the IDAT inflates back to the filtered scanlines.
  const png = engine.grayToPng(pre.gray);
  assert.deepStrictEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.strictEqual(png.readUInt32BE(16), pre.gray.width); assert.strictEqual(png.readUInt32BE(20), pre.gray.height);
  assert.strictEqual(png[24], 8); assert.strictEqual(png[25], 0);
  const idatLen = png.readUInt32BE(33); assert.strictEqual(png.toString('ascii', 37, 41), 'IDAT');
  const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
  assert.strictEqual(raw.length, (pre.gray.width + 1) * pre.gray.height); ok();

  // A dark-on-light region is NOT inverted.
  const light = Buffer.alloc(W * H * 4, 240);
  const pre2 = engine.preprocess({ data: light, width: W, height: H }, { x: 0, y: 0, w: W, h: H }, { scale: 1, pad: 0 });
  assert.strictEqual(pre2.inverted, false); ok();
}

// ── Optional: the real recogniser on a rendered number (OCR_LIVE=1, Windows) ──
(async () => {
  if (process.env.OCR_LIVE !== '1') { console.log('ocr-gold: ' + n + ' checks passed (set OCR_LIVE=1 for the live Tesseract check)'); return; }
  const fs = require('fs'); const os = require('os'); const { spawnSync } = require('child_process');
  const dir = path.join(os.tmpdir(), 'ne-ocr-test'); fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'gold.png');
  const ps = `Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 160,44; $g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(18,20,28)); $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$f = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$g.DrawString('32.4k', $f, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230,200,90))), 8, 4)
$bmp.Save('${p.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
  assert.strictEqual(r.status, 0, 'render: ' + String(r.stderr));
  engine.configure({ langPath: path.join(__dirname, '..', 'assets', 'ocr'), cachePath: dir });
  const res = await engine.recognize(p, { whitelist: '0123456789.,kK', psm: 7 });
  assert.strictEqual(parseGold(res.text), 32400, 'live read: ' + JSON.stringify(res.text));
  assert(res.confidence > 60, 'confidence ' + res.confidence);
  await engine.terminate();
  n++;
  console.log('ocr-gold: ' + n + ' checks passed (live Tesseract read "' + res.text + '" at ' + res.confidence + '%)');
})().catch((e) => { console.error(e); process.exit(1); });
