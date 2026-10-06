const path = require('path');
const fs = require('fs');
const os = require('os');

let app, BrowserWindow, ipcMain, nativeTheme, Tray, Menu, nativeImage, globalShortcut;

try {
  const electron = require('electron');
  if (!electron) {
    console.error('[INIT] FATAL: Electron module is null or undefined');
    process.exit(1);
  }
  ({ app, BrowserWindow, ipcMain, nativeTheme, Tray, Menu, nativeImage, globalShortcut } = electron);
  if (!app) {
    console.error('[INIT] FATAL: app property not found in electron module');
    console.error('[INIT] Electron exports:', Object.keys(electron));
    process.exit(1);
  }
  console.log('[INIT] Loaded electron successfully');
} catch (e) {
  console.error('[INIT] FATAL: Failed to require electron:', e.message);
  process.exit(1);
}

let server;
let controlPanel;
let launcherWin = null;      // small pre-auth launcher window (branding + login + updates)
let panelDidLoad = false;    // control panel renderer finished loading (gates the launcher animation)
let tray = null;
let encodeTrayTitle = 'NE Broadcast Suite';
let rlUiHotkeyRegistered = null;

// Dev machines only (same .env.local signal as the DevTools auto-open below): expose the
// Chromium remote-debugging port so UI changes can be verified against the REAL renderer
// (drive tabs, read the console) instead of static checks. Binds 127.0.0.1 only; never
// active in shipped builds (.env.local is scrubbed from them).
if (fs.existsSync(path.join(__dirname, '.env.local'))) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

const CRASH_LOG = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'ne-broadcast-suite', 'logs', 'crash.log'
);

function writeCrashLog(label, err) {
  try {
    fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
    const line = `[${new Date().toISOString()}] ${label}: ${err && (err.stack || err.message || err)}\n`;
    fs.appendFileSync(CRASH_LOG, line);
  } catch (_) { }
}

process.on('uncaughtException', (err) => {
  console.error('[CRASH] uncaughtException:', err);
  writeCrashLog('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] unhandledRejection:', reason);
  writeCrashLog('unhandledRejection', reason);
});

// GPU/utility process deaths are silent by default — they surface only as a window that stops
// painting. Log them so a mid-show render fault leaves a trace in crash.log.
if (app) {
  app.on('child-process-gone', (_e, d) => {
    writeCrashLog('child-process-gone', new Error(d.type + '/' + (d.serviceName || '') + ' reason=' + d.reason + ' exitCode=' + d.exitCode));
  });
}

// Renderer acceleration. This has to be decided BEFORE app-ready — earlier than the server and its
// state file load — so the choice lives in its own tiny JSON next to userData and is read
// synchronously here. Default is GPU: compositing on the GPU keeps CPU headroom for the game and
// the encoder during a show. CPU mode stays available for machines where GPU compositing misbehaves
// (it was the unconditional default until 2026-08, when it turned out to be why an idle control
// panel still burned CPU and why occluded-window repaints stalled — see backgroundThrottling below).
const RENDER_MODE_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'ne-broadcast-suite', 'render-mode.json'
);
function readRenderMode() {
  try {
    const raw = JSON.parse(fs.readFileSync(RENDER_MODE_FILE, 'utf8'));
    return raw && raw.mode === 'cpu' ? 'cpu' : 'gpu';
  } catch (e) { return 'gpu'; }
}
const RENDER_MODE = readRenderMode();

// Registered at module scope, NOT inside setupPopoutHandler(): that runs after
// createControlPanel(), so the panel could ask for the current mode before a handler existed.
// ipcMain is available as soon as electron is required, so there is no reason to defer these.
// The mode is read before app-ready (above), so writing it only takes effect on the next launch.
if (ipcMain) {
  ipcMain.handle('get-render-mode', () => RENDER_MODE);
  ipcMain.handle('set-render-mode', (_event, mode) => {
    const next = mode === 'cpu' ? 'cpu' : 'gpu';
    try {
      fs.mkdirSync(path.dirname(RENDER_MODE_FILE), { recursive: true });
      fs.writeFileSync(RENDER_MODE_FILE, JSON.stringify({ mode: next }, null, 2), 'utf8');
      console.log('[INIT] Renderer acceleration set to ' + next + ' (applies on next launch)');
      return { ok: true, mode: next, restartRequired: next !== RENDER_MODE };
    } catch (e) {
      console.error('[INIT] Could not save render mode:', e.message);
      return { ok: false, error: e.message };
    }
  });
}

// Apply flags as early as possible (only if app is ready)
if (app) {
  try {
    app.commandLine.appendSwitch('log-level', '3');
    app.commandLine.appendSwitch('disable-logging');
    if (RENDER_MODE === 'cpu') app.disableHardwareAcceleration();
    console.log('[INIT] Renderer acceleration: ' + (RENDER_MODE === 'cpu' ? 'CPU (hardware acceleration disabled)' : 'GPU'));
  } catch (e) {
    console.error('[INIT] Error applying flags:', e.message);
  }
}

// The app shipped under several names over time (jota-overlay → nameless-esports →
// ne-broadcast-suite), and Electron derives userData from the app name — so each rename
// pointed at a fresh folder with factory-default state, making the user's settings look
// like they "reset". We pin userData to a single stable folder and pull legacy data forward.
const FACTORY_EVENT_NAME = 'ROCKET LEAGUE TOURNAMENT';

function setupUserDataFolder() {
  if (!app) return;
  const STABLE_USER_DATA = path.join(app.getPath('appData'), 'ne-broadcast-suite');
  app.setPath('userData', STABLE_USER_DATA);

  const currentDataDir = path.join(STABLE_USER_DATA, 'data');
  const DATA_FILES = ['state.json', 'teams.json', 'brands.json', 'facecams.json', 'presets.json', 'clips-library.json', 'director-learning.json', 'twitch-data.json'];

  // Every userData folder a past build may have used (newest filtered/sorted below).
  const LEGACY_DATA_ROOTS = ['jota-overlay', 'JotaOverlay', 'nameless-esports']
    .map(n => path.join(app.getPath('appData'), n, 'data'))
    .filter(d => fs.existsSync(d));
  if (!LEGACY_DATA_ROOTS.length) return;

  fs.mkdirSync(currentDataDir, { recursive: true });

  // Newest legacy copy of a given file across all legacy roots.
  const newestLegacy = (file) => LEGACY_DATA_ROOTS
    .map(root => path.join(root, file))
    .filter(p => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;

  // 1) First-run import: bring forward any file the stable folder doesn't have yet.
  for (const file of DATA_FILES) {
    const dst = path.join(currentDataDir, file);
    if (fs.existsSync(dst)) continue;
    const src = newestLegacy(file);
    if (src) { try { fs.copyFileSync(src, dst); } catch (e) { } }
  }

  // 2) Rescue stranded settings: if a default state.json already existed in the stable
  //    folder (so step 1 skipped it), recover the real event title from legacy data.
  //    Idempotent — once a real title is present this is a no-op.
  try {
    const dst = path.join(currentDataDir, 'state.json');
    const legacyState = newestLegacy('state.json');
    if (fs.existsSync(dst) && legacyState) {
      const cur = JSON.parse(fs.readFileSync(dst, 'utf8'));
      const curName = (cur.eventName || '').trim();
      if (!curName || curName === FACTORY_EVENT_NAME) {
        const legacyName = (JSON.parse(fs.readFileSync(legacyState, 'utf8')).eventName || '').trim();
        if (legacyName && legacyName !== FACTORY_EVENT_NAME) {
          cur.eventName = legacyName;
          fs.writeFileSync(dst, JSON.stringify(cur, null, 2));
          console.log('[Migration] Restored stranded event title:', legacyName);
        }
      }
    }
  } catch (e) { console.warn('[Migration] event-title rescue failed:', e.message); }
}

function syncRlHideNativeUiHotkey() {
  if (!app || !app.isReady()) return;
  const cfg = typeof server?.getRlSpectatorUiConfig === 'function'
    ? server.getRlSpectatorUiConfig()
    : null;
  if (rlUiHotkeyRegistered) {
    try { globalShortcut.unregister(rlUiHotkeyRegistered); } catch (e) { }
    rlUiHotkeyRegistered = null;
  }
  if (!cfg || cfg.enabled === false) return;
  const accel = (cfg.hotkey || 'F9').trim();
  if (!accel) return;
  try {
    const ok = globalShortcut.register(accel, () => {
      if (typeof server?.hideRlNativeUi === 'function') server.hideRlNativeUi();
    });
    if (ok) rlUiHotkeyRegistered = accel;
  } catch (e) {
    console.warn('[RL UI] Hotkey registration failed:', e.message);
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch (e) {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip(encodeTrayTitle);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Control Panel', click: () => { if (controlPanel) { controlPanel.show(); controlPanel.focus(); } } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('double-click', () => {
    if (controlPanel) { controlPanel.show(); controlPanel.focus(); }
  });
}

function updateTrayEncode(progress) {
  if (!tray) return;
  const active = progress?.active;
  if (active?.status === 'encoding') {
    const pct = active.progress || 0;
    encodeTrayTitle = `Encoding: ${active.name || 'Montage'} — ${pct}%`;
    tray.setToolTip(encodeTrayTitle);
  } else if (active?.status === 'done') {
    encodeTrayTitle = `Export done: ${active.name || 'Montage'}`;
    tray.setToolTip(encodeTrayTitle);
    setTimeout(() => {
      encodeTrayTitle = 'NE Broadcast Suite';
      if (tray) tray.setToolTip(encodeTrayTitle);
    }, 8000);
  } else {
    encodeTrayTitle = 'NE Broadcast Suite';
    tray.setToolTip(encodeTrayTitle);
  }
}

// Small launcher window — the app's front door. Branding + Discord/email login +
// Check for Updates. Authenticated users get the 5s load animation, then it hands
// off to the (already loaded, hidden) control panel via POST /api/launcher/launch.
function createLauncherWindow() {
  const launcher = new BrowserWindow({
    width: 440,
    height: 360,
    frame: false,
    show: false,
    resizable: false,
    center: true,
    backgroundColor: '#0b0c0f',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  // "Sign in with Discord" and studio-site links open in the system browser.
  launcher.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
  launcher.loadFile(path.join(__dirname, 'launcher.html'));
  launcher.once('ready-to-show', () => launcher.show());
  return launcher;
}

function createControlPanel() {
  // The window is frameless (titleBarStyle:'hidden') and the menu bar is hidden below, but
  // Electron's default application menu still exists underneath and registers its own
  // Ctrl+Shift+I/F12 "Toggle Developer Tools" accelerator. That fired in parallel with the
  // before-input-event handler below (same toggle, same keys) and the two raced — open then
  // instantly close in the same tick — so DevTools appeared to never open. Removing the
  // default menu leaves the before-input-event handler as the sole toggle.
  Menu.setApplicationMenu(null);
  controlPanel = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 680,
    minHeight: 600,
    show: false,   // paint fully before showing to eliminate white-flash
    title: 'NE | Broadcast Suite',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#0b0c0f',
    // Frameless: drop the OS title bar so our header sits at the very top, but keep
    // the native min/max/close buttons overlaid at the top-right (no custom IPC needed).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0c0f', symbolColor: '#c5c8d0', height: 44 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'control-panel', 'preload.js'),
      // A mid-show freeze was measured here as 1 rendered frame in 63s with the DOM fully intact
      // and the heap flat — a paint/scheduling stall, not a JS crash. During a show this window
      // sits behind OBS/the game, and Chromium throttles rAF/timers hard once it considers a
      // window occluded (made worse by disableHardwareAcceleration() above: all compositing is
      // on the CPU). A control surface has to keep painting when it isn't foreground.
      backgroundThrottling: false
    }
  });
  controlPanel.loadFile(path.join(__dirname, 'control-panel', 'index.html'));
  // Tell the launcher when the studio is actually painted. Its load animation used to be a fixed
  // 5s sleep that started AFTER sign-in resolved — dead time bolted onto every launch whether the
  // panel was ready in 400ms or still loading at 6s. Now the animation covers this instead.
  controlPanel.webContents.once('did-finish-load', () => {
    panelDidLoad = true;
    if (server && typeof server.markPanelReady === 'function') server.markPanelReady();
  });
  controlPanel.setMenuBarVisibility(false);

  // A dead or wedged renderer looks IDENTICAL to a working one from the outside: the window just
  // sits there painting its background colour. Nothing was listening for it, so a mid-show freeze
  // produced a black panel, no log line, and no recovery. Record it, and reload once so the
  // producer gets the panel back instead of having to restart the suite mid-broadcast.
  let panelReloads = 0;
  const recoverPanel = (why) => {
    writeCrashLog('controlPanel:' + why, new Error(why));
    if (panelReloads >= 3) { console.error('[NE] Control panel ' + why + ' — reload limit hit, leaving as-is.'); return; }
    panelReloads++;
    console.error('[NE] Control panel ' + why + ' — reloading (' + panelReloads + '/3).');
    try { if (!controlPanel.isDestroyed()) controlPanel.reload(); } catch (_) { }
  };
  controlPanel.webContents.on('render-process-gone', (_e, details) => {
    recoverPanel('render-process-gone reason=' + details.reason + ' exitCode=' + details.exitCode);
  });
  // Fires when the renderer stops pumping its message loop (the freeze this was reported for).
  controlPanel.on('unresponsive', () => recoverPanel('unresponsive'));
  controlPanel.on('responsive', () => console.log('[NE] Control panel responsive again.'));

  // Auto-open the dev console on launch (detached) for the DEVELOPER only — never in a build shipped
  // to end users. Enabled when ANY dev signal is present:
  //   • !app.isPackaged      → running from source (`electron .` / npm start) = a dev run
  //   • NE_DEVTOOLS=1        → explicit override (e.g. to debug a packaged build)
  //   • .env.local exists    → the dev-vs-production marker server.js uses; scrubbed from public/
  //                            white-label builds, so its presence is a reliable "dev machine" check.
  // A shipped end-user build is packaged + has no .env.local + no override → stays closed.
  // (Checked via fs, not process.env, because server.js's dotenv hasn't run yet at this point.)
  const devConsole = !app.isPackaged
    || process.env.NE_DEVTOOLS === '1'
    || fs.existsSync(path.join(__dirname, '.env.local'));
  if (devConsole) {
    console.log('[NE] Dev console enabled — opening DevTools.');
    // Open once the page has loaded AND the window is on-screen. Opening it here (right after
    // loadFile, while the window is still show:false and the page hasn't loaded) could get swallowed,
    // and a detached DevTools window can also open hidden behind the main one — so wait for
    // ready-to-show, then open + focus so it's actually visible.
    const openDevConsole = () => {
      try {
        if (!controlPanel.webContents.isDevToolsOpened()) controlPanel.webContents.openDevTools({ mode: 'detach' });
        const dt = controlPanel.webContents.devToolsWebContents;
        if (dt) dt.focus();
      } catch (e) { console.warn('[NE] openDevTools failed:', e && e.message); }
    };
    controlPanel.once('ready-to-show', () => setTimeout(openDevConsole, 300));
  }

  // F12 / Ctrl+Shift+I → toggle DevTools; Ctrl+R / Ctrl+Shift+R → reload. Removing the default
  // application menu (above) dropped its built-in accelerators for all three, so they're
  // reimplemented here manually.
  controlPanel.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const devToolsKey = input.key === 'F12' ||
      ((input.key === 'I' || input.key === 'i') && input.control && input.shift);
    if (devToolsKey) {
      if (controlPanel.webContents.isDevToolsOpened()) {
        controlPanel.webContents.closeDevTools();
      } else {
        controlPanel.webContents.openDevTools({ mode: 'detach' });
      }
      return;
    }
    if (input.key === 'r' && input.control) {
      if (input.shift) controlPanel.webContents.reloadIgnoringCache();
      else controlPanel.webContents.reload();
    }
  });

  // Forward renderer errors to the main-process stdout so real crashes are visible even when
  // the DevTools console is flooded with VDO.ninja WebRTC spam (postMessage/sequence errors
  // from their embedded iframes repeat every ~300ms and bury our own error output).
  controlPanel.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    if (level < 2) return; // 0=verbose 1=info 2=warning 3=error
    const msg = message || '', src = sourceId || '';
    const isVdoNoise =
      (msg.includes('postMessage') && msg.includes('sequence')) ||
      msg.includes('remoteInterfaceAPI') ||
      src.includes('vdo.ninja') ||
      src.includes('webrtc.js') ||
      /[?&]ver=\d+/.test(src) ||   // VDO cache-bust query on its bundled scripts
      src.includes('?director=') || src.includes('?room=') || src.includes('?push=') || src.includes('?view=');
    if (isVdoNoise) return;
    const tag = level === 3 ? 'ERR' : 'WARN';
    console.error(`[renderer:${tag}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`);
  });

  controlPanel.on('focus', () => {
    controlPanel.webContents.focus();
  });

  controlPanel.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  controlPanel.on('closed', () => {
    controlPanel = null;
    app.quit();
  });

  controlPanel.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  // getUserMedia in cross-origin iframes (e.g. embedded VDO.ninja director consoles in the
  // Director Control Center) also goes through a synchronous permission CHECK, which Electron
  // denies for non-main frames by default. Grant media/display so the consoles can connect.
  controlPanel.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    return ['media', 'mediaKeySystem', 'camera', 'microphone', 'audioCapture', 'videoCapture', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission);
  });
}

// ── Popout windows (opened via IPC from the control panel) ──────────────────
const _popoutWindows = {};
function setupPopoutHandler() {
  // Discord OAuth — opens a managed BrowserWindow so we can close it and
  // focus the main window automatically when authentication completes.
  ipcMain.handle('open-discord-oauth', (_event, url) => {
    if (!url || !url.startsWith('https://discord.com/')) return;
    const authWin = new BrowserWindow({
      width: 500, height: 760,
      title: 'Sign in with Discord',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      backgroundColor: '#111318',
      parent: controlPanel,
      modal: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    authWin.setMenuBarVisibility(false);
    authWin.loadURL(url);

    const CALLBACK_PREFIX = 'http://localhost:3000/api/oauth/discord/callback';
    let closing = false;
    const finish = () => {
      if (closing) return;
      closing = true;
      if (!authWin.isDestroyed()) authWin.close();
      if (controlPanel && !controlPanel.isDestroyed()) {
        controlPanel.show();
        if (controlPanel.isMinimized()) controlPanel.restore();
        controlPanel.focus();
      }
    };
    authWin.webContents.on('did-navigate', (_e, navUrl) => {
      if (navUrl.startsWith(CALLBACK_PREFIX)) finish();
    });
    authWin.webContents.on('will-redirect', (_e, navUrl) => {
      if (navUrl.startsWith(CALLBACK_PREFIX)) finish();
    });
  });

  // Twitch OAuth — same idea as Discord. The panel used to window.open('') a BLANK popup and then
  // point it at Twitch; the control panel's window-open handler denies every non-http URL, so the
  // blank popup was always refused and "Continue with Twitch" did nothing. The callback page
  // (localhost:3000/api/oauth/twitch/callback) finishes the sign-in itself and window.close()s.
  ipcMain.handle('open-twitch-oauth', (_event, url) => {
    if (!url || !url.startsWith('https://id.twitch.tv/')) return false;
    const authWin = new BrowserWindow({
      width: 520, height: 780,
      title: 'Sign in with Twitch',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      backgroundColor: '#18181b',
      parent: controlPanel,
      modal: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    authWin.setMenuBarVisibility(false);
    // Links inside Twitch's page (help, sign-up) go to the real browser, never a stray popup.
    authWin.webContents.setWindowOpenHandler(({ url: u }) => {
      if (u.startsWith('http')) require('electron').shell.openExternal(u);
      return { action: 'deny' };
    });
    authWin.on('closed', () => {
      if (controlPanel && !controlPanel.isDestroyed()) {
        controlPanel.show();
        if (controlPanel.isMinimized()) controlPanel.restore();
        controlPanel.focus();
      }
    });
    authWin.loadURL(url);
    return true;
  });

  ipcMain.handle('open-popout-window', (_event, page) => {
    if (!page || typeof page !== 'string') return;
    // Re-focus if already open
    if (_popoutWindows[page] && !_popoutWindows[page].isDestroyed()) {
      _popoutWindows[page].focus();
      return;
    }
    const labels = {
      principal: 'Dashboard', events: 'Events', produccion: 'Production',
      director: 'Director', replays: 'Replays', scenes: 'Scenes',
      equipos: 'Talent', facecams: 'Cameras', brands: 'Brands',
      media: 'Media', integrations: 'Integrations', stats: 'Stats',
      ajustes: 'Settings', roles: 'Roles', triggers: 'Triggers', timer: 'Countdown Timer', match: 'Match — Teams',
      graphics: 'Graphics',
    };
    const label = labels[page] || page;
    // The timer pop-out is a small, draggable utility window sized to the timer panel; everything
    // else opens as a full page window.
    const isTimer = page === 'timer';
    const win = new BrowserWindow({
      width: isTimer ? 440 : 1280, height: isTimer ? 620 : 900,
      minWidth: isTimer ? 320 : 640, minHeight: isTimer ? 380 : 400,
      alwaysOnTop: isTimer,
      title: 'NE | ' + label,
      icon: path.join(__dirname, 'assets', 'icon.png'),
      backgroundColor: '#0b0c0f',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: 'rgba(0,0,0,0.40)', symbolColor: '#ffffff', height: 36 },
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      }
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'control-panel', 'index.html'), { query: { page } });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) require('electron').shell.openExternal(url);
      return { action: 'deny' };
    });
    _popoutWindows[page] = win;
    win.on('closed', () => { delete _popoutWindows[page]; });
  });

  // Print a report (HTML string). Electron has NO Chromium print-preview UI — webContents.print()
  // only shows the classic OS print dialog (no preview pane). To give the real print preview (live
  // PDF pane + "Save as PDF" destination), open the report in the user's DEFAULT BROWSER and
  // auto-trigger its print preview. `mode: 'pdf'` instead saves a PDF straight to a chosen path.
  ipcMain.handle('print-report', async (_event, html, mode) => {
    if (!html || typeof html !== 'string') return { ok: false, error: 'no-html' };
    const { dialog, shell } = require('electron');
    try {
      if (mode === 'pdf') {
        // Direct Save-as-PDF (no browser): render offscreen → printToPDF → Save dialog.
        const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
        const tmp = path.join(os.tmpdir(), 'ne-report-' + Date.now() + '.html');
        try {
          fs.writeFileSync(tmp, html, 'utf8');
          await win.loadFile(tmp);
          await new Promise((r) => setTimeout(r, 300));
          const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
          const res = await dialog.showSaveDialog(controlPanel || win, { title: 'Save report as PDF', defaultPath: 'ne-report.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          if (res.canceled || !res.filePath) return { ok: false, canceled: true };
          fs.writeFileSync(res.filePath, pdf);
          shell.openPath(res.filePath).catch(() => {});
          return { ok: true, saved: res.filePath };
        } finally {
          try { win.destroy(); } catch (_) {}
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
      }
      // Default: open in the browser with auto print preview.
      const withPrint = html.replace('</body>', '<script>window.addEventListener("load",function(){setTimeout(function(){try{window.print();}catch(e){}},400);});</script></body>');
      const tmp = path.join(os.tmpdir(), 'ne-report-' + Date.now() + '.html');
      fs.writeFileSync(tmp, withPrint, 'utf8');
      const err = await shell.openPath(tmp);   // opens .html in the default browser
      if (err) return { ok: false, error: err };
      return { ok: true, opened: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// Main setup - only run when app is available
// ── Auto-update (electron-updater + GitHub Releases) ────────────────────────
// main.js owns the updater; the control panel drives it and shows status through the
// WS bridge (server runs in this same process). Only functional in a packaged build.
function setupAutoUpdate() {
  let autoUpdater;
  try { autoUpdater = require('electron-updater').autoUpdater; }
  catch (e) { console.log('[UPDATE] electron-updater unavailable:', e.message); return; }

  autoUpdater.autoDownload = true;           // download silently in background; user just clicks install
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.fullChangelog = false;

  const push = (status) => {
    try {
      if (server && typeof server.broadcastUpdateStatus === 'function') {
        server.broadcastUpdateStatus({ currentVersion: app.getVersion(), packaged: app.isPackaged, ...status });
      }
    } catch (e) { /* ignore */ }
  };
  const notes = (info) => (typeof info?.releaseNotes === 'string' ? info.releaseNotes : '').replace(/<[^>]+>/g, '').slice(0, 1500);

  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => push({ state: 'available', version: info.version, notes: notes(info) }));
  autoUpdater.on('update-not-available', () => push({ state: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => push({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => push({ state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => push({ state: 'error', message: (err && err.message) || String(err) }));

  if (server && typeof server.setUpdateHandlers === 'function') {
    server.setUpdateHandlers({
      check: () => {
        if (!app.isPackaged) { push({ state: 'dev' }); return; }   // only works in the installed build
        autoUpdater.checkForUpdates().catch((e) => push({ state: 'error', message: e.message }));
      },
      download: () => autoUpdater.downloadUpdate().catch((e) => push({ state: 'error', message: e.message })),
      install: () => { try { autoUpdater.quitAndInstall(); } catch (e) { push({ state: 'error', message: e.message }); } }
    });
  }

  // Silent check shortly after launch (packaged only); in dev just tell the UI.
  if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch((e) => push({ state: 'error', message: e.message })), 4000);
  else push({ state: 'dev' });
}

function setupApp() {
  if (!app) {
    console.error('[APP] app is not available, cannot set up');
    return;
  }

  console.log('[APP] Setting up app event handlers...');

  // Set theme and initialize server when ready
  nativeTheme.themeSource = 'dark';

  app.on('ready', () => {
    console.log('[APP] App ready event fired');
    setupUserDataFolder();

    // The small launcher window is the front door (branding + login + update check).
    // The control panel loads hidden behind it and is only shown when the launcher
    // says so — after the session is authenticated and its load animation played.
    const launcher = launcherWin = createLauncherWindow();
    createControlPanel();
    setupPopoutHandler();
    // Overlays popped out over the game (transparent, click-through) for solo casters.
    require('./backend/game-overlay-windows').setup(app, {
      notify: (list) => { try { if (controlPanel && !controlPanel.isDestroyed()) controlPanel.webContents.send('game-overlays-changed', list); } catch (_) { } },
    });
    createTray();

    let _shown = false;
    const showMain = () => {
      if (_shown) return;
      _shown = true;
      if (controlPanel && !controlPanel.isDestroyed()) {
        try { controlPanel.maximize(); } catch (_) {}   // open the studio maximized (full screen)
        controlPanel.show();
        controlPanel.focus();
      }
      try { if (!launcher.isDestroyed()) launcher.close(); } catch (_) {}
    };
    // Closing the launcher without signing in = quitting the app (standard launcher behavior).
    launcher.on('closed', () => { launcherWin = null; if (!_shown) app.quit(); });

    try {
      // Load server AFTER the window exists so startup I/O doesn't block the launcher paint.
      server = require('./server');
      server.start(__dirname);
      // The panel can finish painting before `server` is assigned above — replay it if so.
      if (panelDidLoad && typeof server.markPanelReady === 'function') server.markPanelReady();
      // The launcher POSTs /api/launcher/launch when it's time to swap to the studio.
      if (typeof server.setLauncherLaunchCallback === 'function') {
        server.setLauncherLaunchCallback(showMain);
      }
      // The launcher asks for a bigger window when showing the license agreement.
      if (typeof server.setLauncherResizeCallback === 'function') {
        server.setLauncherResizeCallback((w, h) => {
          if (launcherWin && !launcherWin.isDestroyed()) {
            try { launcherWin.setSize(w, h); launcherWin.center(); } catch (_) {}
          }
        });
      }
      // Game performance mode: while an RL match is live, drop every app process
      // (main + renderers + GPU helper) below-normal so the game wins scheduling;
      // restore normal priority when the match ends.
      if (typeof server.setPerfPriorityCallback === 'function') {
        const os = require('os');
        server.setPerfPriorityCallback((on) => {
          const prio = on ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL;
          const pids = [process.pid, ...app.getAppMetrics().map((m) => m.pid)];
          let ok = 0;
          pids.forEach((pid) => { try { os.setPriority(pid, prio); ok++; } catch (_) {} });
          console.log(`[Perf] ${on ? 'lowered' : 'restored'} priority on ${ok}/${pids.length} app processes`);
        });
      }
    } catch (e) {
      // A startup throw here used to die silently (blank window, no backend). Surface it.
      const msg = (e && e.stack) ? e.stack : String(e);
      console.error('[APP] FATAL startup error:', msg);
      try {
        const _fs = require('fs'), _path = require('path');
        _fs.writeFileSync(_path.join(app.getPath('userData'), 'startup-error.log'),
          new Date().toISOString() + '\n' + msg + '\n');
      } catch (_) { }
      try { require('electron').dialog.showErrorBox('NE Broadcast Suite — startup error', msg); } catch (_) { }
      throw e;
    }

    if (typeof server.setEncodeProgressCallback === 'function') {
      server.setEncodeProgressCallback(updateTrayEncode);
    }
    if (typeof server.setRlSpectatorUiHotkeyChangeCallback === 'function') {
      server.setRlSpectatorUiHotkeyChangeCallback(syncRlHideNativeUiHotkey);
    }
    syncRlHideNativeUiHotkey();
    setupAutoUpdate();
  });

  app.on('will-quit', () => {
    if (rlUiHotkeyRegistered) {
      try { globalShortcut.unregister(rlUiHotkeyRegistered); } catch (e) { }
    }
    if (typeof server?.shutdown === 'function') server.shutdown();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
// Enforce a single instance: a second `npm start` focuses the existing window instead of
// launching a rival process that crashes binding ports 3000/3001 (EADDRINUSE).
if (!app) {
  console.error('[INIT] FATAL: app is not available at boot time');
  process.exit(1);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[APP] Another instance is already running — focusing it and exiting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // During the launcher phase the control panel exists but is hidden (pre-auth) —
    // focus the launcher instead of revealing the un-authenticated studio window.
    if (launcherWin && !launcherWin.isDestroyed()) {
      launcherWin.focus();
    } else if (controlPanel) {
      if (controlPanel.isMinimized()) controlPanel.restore();
      controlPanel.show();
      controlPanel.focus();
    }
  });
  setupApp();   // registers the 'ready' handler that starts the server + opens the control panel
}

