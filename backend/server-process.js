'use strict';
// Entry point of the server's own process (an Electron utility process started by
// backend/server-host.js). Keeps the HTTP/WS servers, state, game integrations and file I/O off
// the main process, so a slow handler can no longer freeze windows, menus or the tray.
//
// Boot: wait for 'init' from main -> have main decrypt the keychain secrets the data files hold
// (they are read synchronously during load) -> start server.js -> report 'ready'.
const fs = require('fs');
const path = require('path');
const link = require('./server-link');
const api = require('./electron-api');

function crashLog(kind, err) {
  try {
    const info = link.info || {};
    if (!info.paths || !info.paths.userData) return;
    const dir = path.join(info.paths.userData, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'crash.log'), `[${new Date().toISOString()}] [server process] ${kind}: ${(err && err.stack) || err}\n`);
  } catch (e) { /* nothing left to report to */ }
}
process.on('uncaughtException', (err) => { console.error('[CRASH] server uncaughtException:', err); crashLog('uncaughtException', err); });
process.on('unhandledRejection', (reason) => { console.error('[CRASH] server unhandledRejection:', reason); crashLog('unhandledRejection', reason); });

// Every distinct 'enc:...' string in the data folder's JSON files.
function keychainSecretsOnDisk(dataDir) {
  const found = new Set();
  let files = [];
  try { files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dataDir, f), 'utf8'); } catch (e) { continue; }
    if (!text.includes('"enc:')) continue;
    for (const m of text.matchAll(/"(enc:[A-Za-z0-9+/=]+)"/g)) found.add(m[1]);
  }
  return [...found];
}

link.once('init', async (info) => {
  try {
    if (info.keychain) {
      const enc = keychainSecretsOnDisk(path.join(info.paths.userData, 'data'));
      if (enc.length) {
        const plain = await link.rpc('secrets.decryptMany', enc);
        api.secrets.prefetched(Object.fromEntries(enc.map((e, i) => [e, plain[i]])));
      }
    }

    const server = require(path.join(info.baseDir, 'server.js'));
    server.setLauncherLaunchCallback(() => link.fire('launcherLaunch'));
    server.setLauncherResizeCallback((w, h) => link.fire('launcherResize', w, h));
    server.setPerfPriorityCallback((on) => link.fire('perfPriority', !!on));
    server.setEncodeProgressCallback((p) => link.fire('encodeProgress', p));
    server.setRlSpectatorUiHotkeyChangeCallback(() => link.fire('rlUiConfig', server.getRlSpectatorUiConfig()));
    server.setUpdateHandlers({
      check: () => link.fire('update', 'check'),
      download: () => link.fire('update', 'download'),
      install: () => link.fire('update', 'install')
    });
    link.on('secrets-settled', () => { try { server.resaveSecrets(); } catch (e) { console.warn('[secrets] re-save failed:', e.message); } });

    link.handle('markPanelReady', () => server.markPanelReady());
    link.handle('hideRlNativeUi', () => server.hideRlNativeUi());
    link.handle('broadcastUpdateStatus', (s) => server.broadcastUpdateStatus(s));
    link.handle('broadcastCrashAlert', (m) => server.broadcastCrashAlert(m));
    link.handle('shutdown', () => { server.shutdown(); return true; });

    server.start(info.baseDir);
    link.fire('ready', { rlUiConfig: server.getRlSpectatorUiConfig() });
  } catch (err) {
    console.error('[server process] FATAL startup error:', err);
    crashLog('startup', err);
    link.fire('fatal', (err && err.stack) || String(err));
  }
});
