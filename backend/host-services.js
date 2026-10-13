'use strict';
// Electron work the server needs but can only happen in the MAIN process: native dialogs, the OS
// keychain, offscreen page renders, screen capture, idle time. When the server runs inside main
// (NE_SERVER_IN_MAIN=1, tests) backend/electron-api.js calls these directly; when it runs in its
// own utility process, backend/server-host.js calls them for it over the process link.
const crypto = require('crypto');
const { aesEncrypt, aesDecrypt } = require('./secret-aes');
const fs = require('fs');
const path = require('path');
const { app, dialog, shell, safeStorage, powerMonitor, screen, desktopCapturer, BrowserWindow, nativeImage } = require('electron');

// ── Secrets ──────────────────────────────────────────────────────────────────
// 'enc:'  = safeStorage (OS keychain) ciphertext, base64. The long-standing format.
// 'enc2:' = AES-256-GCM with a data key that is itself stored keychain-encrypted in userData.
//           Lets a process without keychain access (the server's utility process) encrypt
//           synchronously while it saves; it rewrites them as 'enc:' once the keychain answers.
// Anything else is plaintext (legacy, or a machine with no keychain).
function keychainAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
}
let _dataKey = null;
function dataKey(create) {
  if (_dataKey) return _dataKey;
  if (!keychainAvailable()) return null;
  const file = path.join(app.getPath('userData'), 'secret-key.bin');
  try {
    if (fs.existsSync(file)) {
      _dataKey = Buffer.from(safeStorage.decryptString(fs.readFileSync(file)), 'hex');
      if (_dataKey.length === 32) return _dataKey;
      _dataKey = null;
    }
    if (!create) return null;
    const k = crypto.randomBytes(32);
    fs.writeFileSync(file, safeStorage.encryptString(k.toString('hex')));
    _dataKey = k;
    return k;
  } catch (e) { console.warn('[secrets] data key unavailable:', e.message); return null; }
}
function encryptSecret(plain) {
  if (!plain) return '';
  try {
    if (keychainAvailable()) return 'enc:' + safeStorage.encryptString(String(plain)).toString('base64');
  } catch (e) { console.warn('[secrets] encryption unavailable, storing plaintext:', e.message); }
  return plain;
}
function decryptSecret(stored) {
  if (!stored || typeof stored !== 'string') return '';
  try {
    if (stored.startsWith('enc:')) {
      if (keychainAvailable()) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
      return '';
    }
    if (stored.startsWith('enc2:')) {
      const k = dataKey(false);
      return k ? aesDecrypt(k, stored) : '';
    }
  } catch (e) { console.warn('[secrets] failed to decrypt a stored secret (OS keychain changed?):', e.message); return ''; }
  return stored;   // legacy plaintext, or the no-keychain fallback
}

// ── Offscreen page render (overlay thumbnails) ───────────────────────────────
async function renderThumb({ url, width, waitMs }) {
  const win = new BrowserWindow({ show: false, width: 1920, height: 1080, useContentSize: true, frame: false, enableLargerThanScreen: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    win.webContents.setAudioMuted(true);
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, waitMs || 0));   // fonts, state sync, intro animations
    const img = await win.webContents.capturePage();
    return img.resize({ width, quality: 'good' }).toPNG();
  } finally { try { win.destroy(); } catch (e) {} }
}

// ── Screen capture (OCR) ─────────────────────────────────────────────────────
// [{ id, label, x, y, width, height, scaleFactor, primary }] — width/height in PHYSICAL pixels,
// which is the coordinate space every region uses (what the producer sees in a screenshot).
function listDisplays() {
  if (!screen) return [];
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => {
    const sf = d.scaleFactor || 1;
    return {
      id: String(d.id), label: 'Display ' + (i + 1) + ' (' + Math.round(d.size.width * sf) + '×' + Math.round(d.size.height * sf) + ')' + (d.id === primary.id ? ' · primary' : ''),
      x: d.bounds.x, y: d.bounds.y, width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf),
      scaleFactor: sf, primary: d.id === primary.id
    };
  });
}
// captureDisplay(displayId, crop?) → { data: Buffer(BGRA), width, height, displayId, offsetX, offsetY }
// Physical-pixel frame of one display. displayId '' = primary. crop { x, y, w, h } returns just that
// part (live OCR reads two small regions; a whole 4K frame is ~33 MB to hand to the server).
async function captureDisplay(displayId, crop) {
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
  let img = src.thumbnail;
  if (!img || img.isEmpty()) throw new Error('empty frame from ' + src.name);
  let sz = img.getSize(), offsetX = 0, offsetY = 0;
  if (crop && crop.w > 0 && crop.h > 0) {
    const x = Math.max(0, Math.min(sz.width - 1, Math.round(crop.x || 0))), y = Math.max(0, Math.min(sz.height - 1, Math.round(crop.y || 0)));
    const r = { x, y, width: Math.max(1, Math.min(sz.width - x, Math.round(crop.w))), height: Math.max(1, Math.min(sz.height - y, Math.round(crop.h))) };
    img = img.crop(r); sz = img.getSize(); offsetX = x; offsetY = y;
  }
  return { data: img.toBitmap(), width: sz.width, height: sz.height, displayId: String(want.id), offsetX, offsetY };
}

// Downscaled JPEG data URL of a captured frame (OCR calibration preview).
function frameToJpegDataUrl(frame, maxWidth, quality) {
  const img = nativeImage.createFromBitmap(Buffer.from(frame.data), { width: frame.width, height: frame.height });
  const w = Math.min(frame.width, maxWidth || 960);
  const small = w < frame.width ? img.resize({ width: w }) : img;
  return 'data:image/jpeg;base64,' + small.toJPEG(quality || 70).toString('base64');
}

function idleSeconds() {
  try { return powerMonitor.getSystemIdleTime(); } catch (e) { return 0; }
}

// Paths the server reads through app.getPath().
const PATH_NAMES = ['userData', 'appData', 'desktop', 'documents', 'downloads', 'home', 'temp', 'videos', 'pictures', 'music', 'exe', 'logs'];
function appInfo() {
  const paths = {};
  for (const n of PATH_NAMES) { try { paths[n] = app.getPath(n); } catch (e) {} }
  return { paths, isPackaged: app.isPackaged, version: app.getVersion(), name: app.getName(), appPath: app.getAppPath() };
}

module.exports = {
  dialog, shell, app,
  keychainAvailable, dataKey, aesEncrypt, aesDecrypt, encryptSecret, decryptSecret,
  renderThumb, listDisplays, captureDisplay, frameToJpegDataUrl, idleSeconds, appInfo
};
