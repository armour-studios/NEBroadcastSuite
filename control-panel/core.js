/* ─── core.js — shared foundation for every control-panel script ─────────────
   Loads BEFORE app.js (see the script tags at the end of index.html). Classic
   scripts share one global scope, so everything here (WS_URL, ws, currentState,
   send, el, esc, dialogs, image pipeline) is visible to app.js and to any
   future per-domain files exactly as when it lived at the top of app.js.
   Extracted 2026-07 as step 1 of the app.js modularization. */


/* ─── Console/error capture for bug reports ───────────────────────────────
   Wraps console.log/warn/error/info/debug to ALSO keep a rolling in-memory
   buffer (still calls through to the real console — devtools is unaffected),
   plus captures uncaught errors and unhandled promise rejections. The
   bug-report modal attaches this buffer so a report shows exactly what the
   console was doing right before something broke, instead of relying on
   the user to notice/describe/screenshot an error. Placed at the very top
   of the file (before any other declaration) so it captures from the
   earliest possible point and never risks referencing anything not yet
   initialized. */
const __consoleBuffer = [];
const __CONSOLE_BUFFER_MAX = 400;
function __pushConsoleEntry(level, args) {
  try {
    const text = Array.prototype.map.call(args, (a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return (a.stack || a.message || String(a));
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
    __consoleBuffer.push(`[${new Date().toISOString().slice(11, 23)}] ${level.toUpperCase()}: ${text}`);
    if (__consoleBuffer.length > __CONSOLE_BUFFER_MAX) __consoleBuffer.shift();
  } catch (_) { /* never let logging itself throw */ }
}
['log', 'warn', 'error', 'info', 'debug'].forEach((level) => {
  const orig = console[level] ? console[level].bind(console) : function () {};
  console[level] = function (...args) { __pushConsoleEntry(level, args); orig.apply(console, args); };
});
window.addEventListener('error', (e) => {
  // Include e.error.stack when present: for a "Maximum call stack size exceeded" overflow the message
  // alone is useless — the STACK names the recursing function (the actual bug). Truncated so a deep
  // repeating stack can't blow out the console buffer.
  const stack = (e.error && e.error.stack) ? ('\n' + String(e.error.stack).slice(0, 4000)) : '';
  __pushConsoleEntry('error', [`Uncaught: ${e.message} (${e.filename}:${e.lineno}:${e.colno})${stack}`]);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  __pushConsoleEntry('error', [`Unhandled rejection: ${(r && (r.stack || r.message)) || r}`]);
});
function getConsoleBufferText(maxChars) {
  const text = __consoleBuffer.join('\n');
  if (!maxChars || text.length <= maxChars) return text;
  return '…(truncated, showing the most recent output)…\n' + text.slice(-maxChars);
}

const WS_URL = 'ws://127.0.0.1:3001';
let ws;
let _hbTimer = null, _lastRx = 0;   // WebSocket heartbeat (half-open detection)
let currentState = {};
let pendingLogoBlue   = null;  // base64 data URL
let pendingLogoOrange = null;
let _autofillPending  = false; // awaiting an "Auto-fill from stream" result
let _lastPlayerKey    = '';    // guard to avoid unnecessary select rebuilds

// ── Helpers ───────────────────────────────────────────────────────────────
function send(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data: data || {} }));
  }
}

function el(id) { return document.getElementById(id); }

// THE HTML escaper. Escapes the full set (& < > " ') so output is safe in both element
// and attribute contexts. Seven per-domain clones used to coexist with different escape
// subsets (one missed >, most missed ') — they all delegate here now; use esc() in new code.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// True only when the user is actively typing in a text field / select inside `wrap`.
// Used to guard live re-renders so we don't clobber in-progress edits — but a focused
// BUTTON (e.g. a just-clicked delete/add) must NOT block the re-render, or deletes appear
// to do nothing because the row never refreshes off-screen.
function _editingInside(wrap) {
  const a = document.activeElement;
  if (!wrap || !a || !wrap.contains(a)) return false;
  const tag = a.tagName;
  if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const t = (a.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(t);
  }
  return false;
}

// Default team logo for the active game (used when a team has no custom logo).
function gameLogo() {
  const g = (currentState.games && currentState.games[currentState.activeGame]) || null;
  return g && g.logo ? `../assets/${g.logo}` : '../assets/rl.png';
}

// Set a team-card logo preview to the team's own logo, or the active game's logo as a fallback.
// Game-logo fallbacks get .game-logo-white so they render white (visible on the dark UI); a real
// team logo keeps its own colours.
function setSideLogo(side, teamLogo) {
  const img = document.getElementById(`preview-logo-${side}`);
  if (!img) return;
  img.src = teamLogo || gameLogo();
  img.classList.toggle('game-logo-white', !teamLogo);
}

// Downscale + recompress an uploaded image BEFORE it becomes base64 in state. A multi-MB phone
// photo or full-res PNG logo otherwise gets embedded and re-broadcast on every update (a single
// 520KB logo bloated every live broadcast — see the payload-split perf fix). The whole app renders
// in Chromium (control panel + OBS CEF), so WebP (alpha-preserving, ~5-10× smaller than PNG) is
// safe everywhere. SVG (already vector/tiny), GIF (would lose animation) and non-images pass
// through untouched; anything that errors falls back to the original so an upload never breaks.
const IMG_MAX_DIM = 640;    // longest side after downscale — ample for any broadcast logo/badge
const IMG_QUALITY = 0.9;
function downscaleDataUrl(dataUrl, type, maxDim) {
  maxDim = maxDim || IMG_MAX_DIM;
  return new Promise((resolve) => {
    try {
      if (!type || !type.startsWith('image/') || type === 'image/svg+xml' || type === 'image/gif') return resolve(dataUrl);
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return resolve(dataUrl);
          const scale = Math.min(1, maxDim / Math.max(w, h));
          if (scale === 1 && dataUrl.length < 120000) return resolve(dataUrl);   // already small + compact
          const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, cw, ch);
          let out = canvas.toDataURL('image/webp', IMG_QUALITY);
          if (!out || out.indexOf('data:image/webp') !== 0) out = canvas.toDataURL('image/png');   // webp unsupported → png
          resolve(out && out.length < dataUrl.length ? out : dataUrl);   // never make it bigger
        } catch (_) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch (_) { resolve(dataUrl); }
  });
}
function fileToBase64(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = async e => {
      let out = e.target.result;
      try { out = await downscaleDataUrl(e.target.result, file && file.type, maxDim); } catch (_) {}
      // Keep a managed copy of every uploaded image in the local media library (logos/). Overlays
      // still use the embedded base64 returned here, so deleting the original file — or the library
      // copy — never breaks an overlay; the copy just gives a reusable, app-owned source. Fire-and-forget.
      try { backupUploadToLibrary(file, out); } catch (_) {}
      resolve(out);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
// djb2 hash → short content key so re-uploading the same image overwrites (no duplicate files).
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
  return (h >>> 0).toString(36);
}
function backupUploadToLibrary(file, dataUrl) {
  if (!file || !dataUrl) return;
  const isImg = /^image\//i.test(file.type || '') || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file.name || '');
  if (!isImg) return;
  const base = (file.name || 'logo').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'logo';
  // Derive the extension from the actual data URL mime (uploads are recompressed to webp by
  // fileToBase64), falling back to the original filename — so the saved copy matches its bytes.
  const mime = (dataUrl.match(/^data:image\/([a-z0-9.+-]+)/i) || [])[1];
  const ext = (mime || ((file.name || '').match(/\.([a-z0-9]+)$/i) || [, 'png'])[1])
    .toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const name = `${base}-${hashStr(dataUrl)}.${ext}`;
  fetch('http://127.0.0.1:3000/api/media/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'logos', name, dataUrl })
  }).catch(() => {});
}

// Upload an image FILE to the server media store and return its ABSOLUTE served URL. Use this for
// heavy full-frame assets (e.g. the replay-transition background) instead of embedding base64 in a
// broadcast/persisted blob — a URL keeps the brand-kit JSON tiny so saves + library broadcasts stay
// fast. Absolute (http://127.0.0.1:3000/...) so it resolves from the file:// control panel AND from
// OBS overlays. Downscales/re-encodes first (same pipeline as fileToBase64).
async function uploadImageFile(file, folder, maxDim) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const optimized = await downscaleDataUrl(dataUrl, file && file.type, maxDim);
  const base = (file.name || 'img').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'img';
  const mime = (optimized.match(/^data:image\/([a-z0-9.+-]+)/i) || [])[1];
  const ext = (mime || 'webp').toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const name = `${base}-${hashStr(optimized)}.${ext}`;
  const res = await fetch('http://127.0.0.1:3000/api/media/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folder, name, dataUrl: optimized })
  }).then((r) => r.json());
  if (!res || !res.ok || !res.url) throw new Error('media upload failed');
  return 'http://127.0.0.1:3000' + res.url;
}

// ── Custom Modal ──────────────────────────────────────────────────────────
let modalResolve = null;

// Legacy wrapper — now routes to the canonical appConfirm dialog (mp-modal markup stays for other code).
function customConfirm(title, message, confirmText = 'Confirm') {
  const combined = title && message ? title + ' — ' + message : (title || message || '');
  return appConfirm(combined, confirmText);
}

function closeModal(result) {
  el('modal-container').classList.remove('active');
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}

el('modal-btn-confirm')?.addEventListener('click', () => closeModal(true));
el('modal-btn-cancel')?.addEventListener('click', () => closeModal(false));
el('modal-btn-close')?.addEventListener('click', () => closeModal(false));

// Prompt for a line of text (Electron disables window.prompt). Resolves to the trimmed string, or
// null if cancelled/empty. Self-contained overlay — no HTML needed.
function customPrompt(title, message, defaultValue = '', confirmText = 'Create') {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'app-prompt-overlay';
    ov.innerHTML =
      '<div class="app-prompt-card">' +
        '<div class="app-prompt-title"></div>' +
        '<div class="app-prompt-msg"></div>' +
        '<input class="input-text app-prompt-input" type="text" autocomplete="off">' +
        '<div class="app-prompt-btns">' +
          '<button class="btn btn-primary btn-sm app-prompt-ok"></button>' +
          '<button class="btn btn-ghost btn-sm app-prompt-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    ov.querySelector('.app-prompt-title').textContent = title || '';
    const msgEl = ov.querySelector('.app-prompt-msg');
    if (message) msgEl.textContent = message; else msgEl.style.display = 'none';
    const inp = ov.querySelector('.app-prompt-input');
    inp.value = defaultValue || '';
    ov.querySelector('.app-prompt-ok').textContent = confirmText;
    document.body.appendChild(ov);
    const close = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('.app-prompt-ok').addEventListener('click', () => close(inp.value.trim() || null));
    ov.querySelector('.app-prompt-cancel').addEventListener('click', () => close(null));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(null); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(inp.value.trim() || null); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
