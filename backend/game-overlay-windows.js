'use strict';
// ── Game overlay windows ─────────────────────────────────────────────────────
// For a solo caster/producer who plays on the same PC: an overlay pops out into its own
// frameless, transparent, always-on-top window that sits over the game, instead of only
// being an OBS browser source. One window per overlay path.
//
// Two modes per window:
//   locked (default once placed) — click-through, never takes focus, so the game keeps
//                                  every click and keystroke.
//   edit                         — mouse-interactive, dashed frame + toolbar (injected by
//                                  game-overlay-preload.js) to move, resize, fade, move to
//                                  another screen, lock or close.
// Global hotkeys exist only while at least one window is open, so we never squat on keys
// the producer's game or OBS might want the rest of the time:
//   Ctrl+Shift+F9  toggle edit / locked on every game overlay
//   Ctrl+Shift+F10 hide / show every game overlay
//
// Only works over BORDERLESS / WINDOWED games: exclusive fullscreen bypasses the desktop
// compositor, so no window (ours, Discord's, Steam's) can draw over it.
//
// Zoom: overlays are authored at a fixed native size (1920×1080 or 1080×1920). The window is
// scaled with setZoomFactor(window width / native width). Chromium keeps zoom per ORIGIN, and
// every overlay is on localhost:3000, so each window gets its own in-memory partition — a
// shared one would make two different-sized overlays fight over a single zoom value.

const path = require('path');
const fs = require('fs');
const { BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');

const HOTKEY_EDIT = 'CommandOrControl+Shift+F9';
const HOTKEY_HIDE = 'CommandOrControl+Shift+F10';
const MIN_SCALE = 0.15;

const _wins = new Map();          // key (overlay path) -> entry
let _prefs = null;                // { [key]: { x, y, width, height, opacity } }
let _prefsFile = null;
let _saveTimer = null;
let _hotkeysOn = false;
let _hiddenAll = false;
let _notify = () => {};

function prefsFile(app) {
  if (!_prefsFile) _prefsFile = path.join(app.getPath('userData'), 'game-overlays.json');
  return _prefsFile;
}
function loadPrefs(app) {
  if (_prefs) return _prefs;
  try { _prefs = JSON.parse(fs.readFileSync(prefsFile(app), 'utf8')) || {}; } catch (_) { _prefs = {}; }
  return _prefs;
}
// Async + debounced: this runs in the Electron main process alongside server.js, and a drag
// fires 'moved' many times.
function savePrefsSoon(app) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fs.promises.writeFile(prefsFile(app), JSON.stringify(_prefs || {}, null, 2), 'utf8')
      .catch((e) => console.warn('[GameOverlay] Could not save positions:', e.message));
  }, 400);
}

function keyFor(p) { return String(p || '/').trim() || '/'; }
function partitionFor(key) { return 'ne-gameoverlay-' + key.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'; }

// Largest native-aspect rect that fits the display, centred. Uses full bounds, not the work
// area: a borderless game covers the taskbar too.
function fitToDisplay(display, nw, nh) {
  const b = display.bounds;
  const s = Math.min(b.width / nw, b.height / nh);
  const w = Math.round(nw * s), h = Math.round(nh * s);
  return { x: b.x + Math.round((b.width - w) / 2), y: b.y + Math.round((b.height - h) / 2), width: w, height: h };
}

// Keep a rect wholly on ONE screen: the display it overlaps most. A drag could leave a window half
// off the edge or straddling two monitors, and that rect was saved and restored as-is (reported as
// "opens on the wrong monitor"). Oversized rects are shrunk to fit, keeping the overlay's aspect.
function clampToDisplay(r, nw, nh) {
  const area = (d) => {
    const b = d.bounds;
    const w = Math.min(r.x + r.width, b.x + b.width) - Math.max(r.x, b.x);
    const h = Math.min(r.y + r.height, b.y + b.height) - Math.max(r.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const all = screen.getAllDisplays();
  const best = all.reduce((a, d) => (area(d) > area(a) ? d : a), all[0]);
  if (!area(best)) return null;   // on no connected screen at all
  const b = best.bounds;
  let { width, height } = r;
  if (width > b.width || height > b.height) {
    const s = Math.min(b.width / nw, b.height / nh);
    width = Math.round(nw * s); height = Math.round(nh * s);
  }
  return {
    x: Math.min(Math.max(r.x, b.x), b.x + b.width - width),
    y: Math.min(Math.max(r.y, b.y), b.y + b.height - height),
    width, height,
  };
}

function list() {
  return [..._wins.values()].map((e) => ({
    key: e.key, name: e.name, locked: e.locked,
    opacity: Math.round(e.opacity * 100),
    scale: Math.round((e.win.getBounds().width / e.nativeW) * 100),
    hidden: _hiddenAll,
  }));
}
function changed() { try { _notify(list()); } catch (_) {} }

function applyZoom(e) {
  if (e.win.isDestroyed()) return;
  const z = e.win.getBounds().width / e.nativeW;
  try { e.win.webContents.setZoomFactor(Math.max(MIN_SCALE, z)); } catch (_) {}
}

function setLocked(e, locked) {
  if (e.win.isDestroyed()) return;
  e.locked = !!locked;
  // Click-through in BOTH modes. Edit mode only forwards mouse moves so the preload can take the
  // mouse while the pointer is over its toolbar (game-overlay:interactive); the rest of the screen
  // always belongs to the game. Locked windows forward mouse MOVES too (never clicks), so the
  // preload can fade whichever HUD piece the cursor is over and the producer can see past it.
  e.win.setIgnoreMouseEvents(true, { forward: true });
  e.win.webContents.send('game-overlay:edit', {
    on: !e.locked, name: e.name,
    scale: Math.round((e.win.getBounds().width / e.nativeW) * 100),
    opacity: Math.round(e.opacity * 100),
    hotkeyEdit: 'Ctrl+Shift+F9', hotkeyHide: 'Ctrl+Shift+F10',
  });
  if (e.locked) e.win.blur();
  changed();
}

function remember(app, e) {
  if (e.win.isDestroyed()) return;
  const prefs = loadPrefs(app);
  prefs[e.key] = { ...(clampToDisplay(e.win.getBounds(), e.nativeW, e.nativeH) || e.win.getBounds()), opacity: e.opacity };
  savePrefsSoon(app);
}

// Resize around the window centre, keeping the overlay's native aspect.
function rescale(app, e, factor) {
  const b = e.win.getBounds();
  const disp = screen.getDisplayMatching(b).bounds;
  const maxS = Math.min(disp.width / e.nativeW, disp.height / e.nativeH);
  const s = Math.min(maxS, Math.max(MIN_SCALE, (b.width / e.nativeW) * factor));
  const w = Math.round(e.nativeW * s), h = Math.round(e.nativeH * s);
  e.win.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: Math.round(b.y + (b.height - h) / 2), width: w, height: h });
  applyZoom(e);
  remember(app, e);
  setLocked(e, e.locked);   // refreshes the toolbar's size readout
}

function fit(app, e, display) {
  const d = display || screen.getDisplayMatching(e.win.getBounds());
  e.win.setBounds(fitToDisplay(d, e.nativeW, e.nativeH));
  applyZoom(e);
  remember(app, e);
  setLocked(e, e.locked);
}

function nextScreen(app, e) {
  const all = screen.getAllDisplays();
  if (all.length < 2) return;
  const cur = screen.getDisplayMatching(e.win.getBounds());
  const i = all.findIndex((d) => d.id === cur.id);
  fit(app, e, all[(i + 1) % all.length]);
}

function setOpacity(app, e, pct) {
  e.opacity = Math.min(1, Math.max(0.1, pct / 100));
  remember(app, e);
  setLocked(e, e.locked);   // the preload applies it to the page (see note in open())
}

function syncHotkeys() {
  const want = _wins.size > 0;
  if (want === _hotkeysOn) return;
  if (want) {
    try {
      globalShortcut.register(HOTKEY_EDIT, () => {
        const anyLocked = [..._wins.values()].some((e) => e.locked);
        _wins.forEach((e) => setLocked(e, !anyLocked));
        // Editing something you can't see is pointless — unhide on the way into edit mode.
        if (anyLocked && _hiddenAll) toggleHidden();
      });
      globalShortcut.register(HOTKEY_HIDE, toggleHidden);
    } catch (err) { console.warn('[GameOverlay] Hotkey registration failed:', err.message); }
  } else {
    try { globalShortcut.unregister(HOTKEY_EDIT); globalShortcut.unregister(HOTKEY_HIDE); } catch (_) {}
    _hiddenAll = false;
  }
  _hotkeysOn = want;
}

function toggleHidden() {
  _hiddenAll = !_hiddenAll;
  _wins.forEach((e) => { if (e.win.isDestroyed()) return; if (_hiddenAll) e.win.hide(); else e.win.showInactive(); });
  changed();
}

function open(app, opts) {
  const key = keyFor(opts.path);
  const existing = _wins.get(key);
  if (existing && !existing.win.isDestroyed()) {
    if (_hiddenAll) toggleHidden();
    existing.win.showInactive();
    existing.win.moveTop();
    return { ok: true, key };
  }
  const url = String(opts.url || '');
  if (!/^http:\/\/localhost:\d+\//.test(url)) return { ok: false, error: 'bad-url' };

  const nativeW = Math.max(100, +opts.nativeW || 1920);
  const nativeH = Math.max(100, +opts.nativeH || 1080);
  const saved = loadPrefs(app)[key];
  let bounds;
  // A saved rect is snapped wholly onto the screen it mostly covers; one on no connected screen
  // (monitor unplugged since) is dropped.
  if (saved && saved.width) bounds = clampToDisplay(saved, nativeW, nativeH);
  // Default: the primary display, where games run by default.
  if (!bounds) bounds = fitToDisplay(screen.getPrimaryDisplay(), nativeW, nativeH);

  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,       // transparent windows can't be edge-resized on Windows; the toolbar scales instead
    maximizable: false,
    fullscreenable: false,
    // In the taskbar on purpose: a producer must always be able to find and close it (right-click
    // > Close window, or Alt+Tab) without remembering hotkeys or unlocking it first.
    skipTaskbar: false,
    // Must stay focusable: on Windows focusable:false (and setFocusable(false)) also drops the window
    // from the taskbar. Locked windows still never take focus: clicks pass through
    // (setIgnoreMouseEvents) and they are shown with showInactive().
    focusable: true,
    alwaysOnTop: true,
    title: 'NE Overlay — ' + (opts.name || key),
    icon: path.join(__dirname, '..', 'assets', 'app-icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,   // keeps animating while the game is the foreground window
      partition: partitionFor(key),
      preload: path.join(__dirname, 'game-overlay-preload.js'),
    },
  });
  // 'screen-saver' is the highest z-band — the normal always-on-top band loses to some
  // borderless games that also set topmost.
  win.setAlwaysOnTop(true, 'screen-saver');
  // Windows clamps a new window to the work area (taskbar excluded), which squashed a 1080p
  // overlay to 1032 tall. An explicit setBounds afterwards is allowed to cover the taskbar.
  win.setBounds(bounds);
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Keep our taskbar name: the overlay's own <title> would otherwise replace it, and every HUD
  // window would read "NE Broadcast Suite — Rocket League (Modern)".
  win.on('page-title-updated', (ev) => ev.preventDefault());

  const e = {
    key, win, name: String(opts.name || key), nativeW, nativeH,
    opacity: saved && saved.opacity ? Math.min(1, Math.max(0.1, saved.opacity)) : 1,
    // Always opens in edit mode: the toolbar is how the producer locks it in place, and a window
    // that came up locked (as remembered placements used to) showed no way to do that.
    locked: false,
  };
  _wins.set(key, e);
  // NEVER win.setOpacity() here: on Windows it turns the window into an alpha-layered window, which
  // overrides the per-pixel transparency and the whole overlay renders invisible (window reports
  // visible + on top, nothing reaches the screen). Opacity is applied as CSS by the preload instead.

  win.webContents.on('did-finish-load', () => {
    applyZoom(e);
    setLocked(e, e.locked);
    if (!_hiddenAll) win.showInactive();
  });
  win.on('moved', () => remember(app, e));
  win.on('closed', () => { _wins.delete(key); syncHotkeys(); changed(); });

  win.loadURL(url);
  syncHotkeys();
  changed();
  return { ok: true, key };
}

function close(key) {
  if (key == null) { [..._wins.values()].forEach((e) => { try { e.win.close(); } catch (_) {} }); return; }
  const e = _wins.get(keyFor(key));
  if (e) try { e.win.close(); } catch (_) {}
}

function entryForSender(sender) {
  for (const e of _wins.values()) if (!e.win.isDestroyed() && e.win.webContents === sender) return e;
  return null;
}

function setup(app, { notify } = {}) {
  if (typeof notify === 'function') _notify = notify;

  ipcMain.handle('game-overlay:open', (_ev, opts) => open(app, opts || {}));
  ipcMain.handle('game-overlay:list', () => list());
  ipcMain.handle('game-overlay:command', (_ev, key, cmd, arg) => {
    if (cmd === 'close-all') { close(null); return { ok: true }; }
    if (cmd === 'toggle-hidden') { toggleHidden(); return { ok: true }; }
    const e = _wins.get(keyFor(key));
    if (!e) return { ok: false, error: 'not-open' };
    return runCommand(app, e, cmd, arg);
  });
  // From the overlay window's own edit toolbar.
  ipcMain.on('game-overlay:toolbar', (ev, cmd, arg) => {
    const e = entryForSender(ev.sender);
    if (e) runCommand(app, e, cmd, arg);
  });
  // A drag that started in the frame: move by the pointer delta (setBounds keeps the size exact,
  // where -webkit-app-region drag on a zoomed transparent window can drift).
  ipcMain.on('game-overlay:drag', (ev, dx, dy) => {
    const e = entryForSender(ev.sender);
    if (!e) return;
    const b = e.win.getBounds();
    e.win.setBounds({ x: b.x + Math.round(dx), y: b.y + Math.round(dy), width: b.width, height: b.height });
  });
  // Edit mode asks for the mouse over its toolbar; a locked window asks only over its small
  // Edit / Hide pill (shown while the cursor is on a HUD piece). Everywhere else stays the game's.
  ipcMain.on('game-overlay:interactive', (ev, on) => {
    const e = entryForSender(ev.sender);
    if (!e || e.win.isDestroyed()) return;
    if (on) e.win.setIgnoreMouseEvents(false);
    else e.win.setIgnoreMouseEvents(true, { forward: true });
  });
  ipcMain.on('game-overlay:drag-end', (ev) => {
    const e = entryForSender(ev.sender); if (!e) return;
    const c = clampToDisplay(e.win.getBounds(), e.nativeW, e.nativeH);
    if (c) e.win.setBounds(c);
    remember(app, e);
  });

  app.on('will-quit', () => {
    if (_hotkeysOn) { try { globalShortcut.unregister(HOTKEY_EDIT); globalShortcut.unregister(HOTKEY_HIDE); } catch (_) {} }
  });
}

function runCommand(app, e, cmd, arg) {
  switch (cmd) {
    case 'lock': setLocked(e, true); break;
    case 'edit': setLocked(e, false); if (_hiddenAll) toggleHidden(); break;
    case 'toggle-lock': setLocked(e, !e.locked); break;
    case 'bigger': rescale(app, e, 1.1); break;
    case 'smaller': rescale(app, e, 1 / 1.1); break;
    case 'fit': fit(app, e); break;
    case 'next-screen': nextScreen(app, e); break;
    case 'opacity': setOpacity(app, e, +arg || 100); break;
    case 'close': close(e.key); break;
    default: return { ok: false, error: 'unknown-command' };
  }
  return { ok: true };
}

module.exports = { setup, list, close };
