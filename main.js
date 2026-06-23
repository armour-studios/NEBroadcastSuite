const path = require('path');
const fs = require('fs');
const os = require('os');

let app, BrowserWindow, nativeTheme, Tray, Menu, nativeImage, globalShortcut;

try {
  const electron = require('electron');
  if (!electron) {
    console.error('[INIT] FATAL: Electron module is null or undefined');
    process.exit(1);
  }
  ({ app, BrowserWindow, nativeTheme, Tray, Menu, nativeImage, globalShortcut } = electron);
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

function setupUserDataFolder() {
  if (!app) return;
  const STABLE_USER_DATA = path.join(app.getPath('appData'), 'ne-broadcast-suite');
  app.setPath('userData', STABLE_USER_DATA);

  const LEGACY_DATA_ROOTS = ['jota-overlay', 'JotaOverlay'].map(n => path.join(app.getPath('appData'), n, 'data'));
  const currentDataDir = path.join(STABLE_USER_DATA, 'data');
  const DATA_FILES = ['state.json', 'teams.json', 'brands.json', 'facecams.json', 'presets.json', 'clips-library.json', 'director-learning.json', 'twitch-data.json'];

  for (const legacyRoot of LEGACY_DATA_ROOTS) {
    if (!fs.existsSync(legacyRoot)) continue;
    fs.mkdirSync(currentDataDir, { recursive: true });
    for (const file of DATA_FILES) {
      const src = path.join(legacyRoot, file);
      const dst = path.join(currentDataDir, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); } catch (e) { }
      }
    }
    break;
  }
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
      contextIsolation: true
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
  if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
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

    // Load server
    server = require('./server');
    server.start(__dirname);

    if (typeof server.setEncodeProgressCallback === 'function') {
      server.setEncodeProgressCallback(updateTrayEncode);
    }
    if (typeof server.setRlSpectatorUiHotkeyChangeCallback === 'function') {
      server.setRlSpectatorUiHotkeyChangeCallback(syncRlHideNativeUiHotkey);
    }
    syncRlHideNativeUiHotkey();
    createControlPanel();
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

