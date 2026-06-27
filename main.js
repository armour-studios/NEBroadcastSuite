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
let tray = null;
let encodeTrayTitle = 'NE Broadcast Suite';
let rlUiHotkeyRegistered = null;

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

// Apply flags as early as possible (only if app is ready)
if (app) {
  try {
    app.commandLine.appendSwitch('log-level', '3');
    app.commandLine.appendSwitch('disable-logging');
    app.disableHardwareAcceleration();
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

function createControlPanel() {
  controlPanel = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 680,
    minHeight: 600,
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
      preload: path.join(__dirname, 'control-panel', 'preload.js')
    }
  });
  controlPanel.loadFile(path.join(__dirname, 'control-panel', 'index.html'));
  controlPanel.setMenuBarVisibility(false);

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
      equipos: 'Teams', facecams: 'Camera Feeds', brands: 'Brands',
      media: 'Media', integrations: 'Integrations', stats: 'Stats',
      ajustes: 'Settings', roles: 'Roles', triggers: 'Triggers', timer: 'Countdown Timer', match: 'Match — Teams',
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
    try {
      setupUserDataFolder();

      // Load server
      server = require('./server');
      server.start(__dirname);
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
    createControlPanel();
    setupPopoutHandler();
    createTray();
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
    if (controlPanel) {
      if (controlPanel.isMinimized()) controlPanel.restore();
      controlPanel.show();
      controlPanel.focus();
    }
  });
  setupApp();   // registers the 'ready' handler that starts the server + opens the control panel
}

