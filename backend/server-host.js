'use strict';
// Main-process side of the server's own process. startServerProcess(baseDir) forks
// backend/server-process.js as an Electron utility process and returns an object with the same
// methods main.js used to call on require('./server'), so main.js treats both the same way.
//
// The server asks main for what only main can do (dialogs, keychain, offscreen renders, screen
// capture: backend/host-services.js) and tells it about launcher/tray/priority/update events.
// If the server process dies it is restarted (the panel and overlays reconnect on their own);
// three deaths inside a minute stop the retries and say so. If it can't start at all (dies twice
// before ever being ready), the server runs inside the main process instead, as it used to.
const fs = require('fs');
const path = require('path');
const { app, utilityProcess, screen } = require('electron');
const h = require('./host-services');

function crashLog(line) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'crash.log'), `[${new Date().toISOString()}] [server host] ${line}\n`);
  } catch (e) { /* ignore */ }
}

function startServerProcess(baseDir) {
  const cb = {};                 // callbacks main.js registers (same names as server.js setters)
  let child = null;
  let ready = false;
  let stopping = false;
  let rlUiConfig = null;
  let panelReady = false;
  let lastUpdateStatus = null;
  let updateHandlers = null;
  const deaths = [];
  const pendingCalls = new Map();
  let nextCallId = 1;
  let everReady = false;
  let inMain = null;             // server.js loaded in this process (fallback)

  const RPC = {
    'dialog.showOpenDialog': (o) => h.dialog.showOpenDialog(o || {}),
    'dialog.showSaveDialog': (o) => h.dialog.showSaveDialog(o || {}),
    'dialog.showMessageBox': (o) => h.dialog.showMessageBox(o || {}),
    'shell.openExternal': (u) => h.shell.openExternal(String(u)),
    'shell.openPath': (p) => h.shell.openPath(String(p)),
    'secrets.decryptMany': (list) => (Array.isArray(list) ? list : []).map((s) => h.decryptSecret(s)),
    'secrets.encrypt': (plain) => h.encryptSecret(plain),
    renderThumb: (o) => h.renderThumb(o || {}),
    captureDisplay: (id, crop) => h.captureDisplay(id, crop),
    frameToJpegDataUrl: (f, w, q) => h.frameToJpegDataUrl(f, w, q)
  };
  const FIRE = {
    'dialog.showErrorBox': (t, c) => h.dialog.showErrorBox(String(t || ''), String(c || '')),
    'shell.showItemInFolder': (p) => h.shell.showItemInFolder(String(p)),
    'app.quit': () => app.quit(),
    launcherLaunch: () => cb.launcherLaunch && cb.launcherLaunch(),
    launcherResize: (w, hh) => cb.launcherResize && cb.launcherResize(w, hh),
    perfPriority: (on) => cb.perfPriority && cb.perfPriority(on),
    encodeProgress: (p) => cb.encodeProgress && cb.encodeProgress(p),
    rlUiConfig: (cfg) => { rlUiConfig = cfg || null; if (cb.rlUiHotkey) cb.rlUiHotkey(); },
    update: (cmd) => { const fn = updateHandlers && updateHandlers[cmd]; if (typeof fn === 'function') fn(); },
    ready: (r) => {
      ready = true; everReady = true;
      rlUiConfig = (r && r.rlUiConfig) || rlUiConfig;
      if (cb.rlUiHotkey) cb.rlUiHotkey();
      if (panelReady) call('markPanelReady');
      if (lastUpdateStatus) call('broadcastUpdateStatus', lastUpdateStatus);
      console.log('[server host] server process ready');
    },
    fatal: (msg) => {
      crashLog('server failed to start: ' + msg);
      try { h.dialog.showErrorBox('Broadcast Studio — startup error', String(msg)); } catch (e) {}
    }
  };

  function send(msg) { if (child) { try { child.postMessage(msg); } catch (e) { console.warn('[server host] send failed:', e.message); } } }
  function call(m, ...a) { if (ready) send({ t: 'call', m, a }); }
  function push(k, v) { send({ t: 'push', k, v }); }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'rpc') {
      const fn = RPC[msg.m];
      if (!fn) { send({ t: 'res', id: msg.id, ok: false, err: 'unknown host call ' + msg.m }); return; }
      Promise.resolve().then(() => fn(...(msg.a || [])))
        .then((v) => send({ t: 'res', id: msg.id, ok: true, v }), (err) => send({ t: 'res', id: msg.id, ok: false, err: (err && err.message) || String(err) }));
    } else if (msg.t === 'fire') {
      const fn = FIRE[msg.m];
      if (!fn) { console.warn('[server host] unknown message', msg.m); return; }
      try { fn(...(msg.a || [])); } catch (e) { console.warn('[server host]', msg.m, 'failed:', e.message); }
    } else if (msg.t === 'res') {
      const p = pendingCalls.get(msg.id); if (p) { pendingCalls.delete(msg.id); p(msg.ok); }
    }
  }

  // The app is going away (including app.exit paths that skip will-quit): its end is not a crash.
  app.once('quit', () => { stopping = true; });
  process.once('exit', () => { stopping = true; });

  const pushDisplays = () => { try { push('displays', h.listDisplays()); } catch (e) {} };
  const idleTimer = setInterval(() => push('idle', h.idleSeconds()), 5000);
  if (idleTimer.unref) idleTimer.unref();
  try { ['display-added', 'display-removed', 'display-metrics-changed'].forEach((ev) => screen.on(ev, pushDisplays)); } catch (e) {}

  function spawn() {
    ready = false;
    child = utilityProcess.fork(path.join(__dirname, 'server-process.js'), [], { serviceName: 'NE Broadcast Studio server', stdio: 'pipe' });
    // 'inherit' loses the output whenever main's stdout is a pipe; forward it so the server's
    // log lines land wherever main's do.
    if (child.stdout) child.stdout.on('data', (d) => { try { process.stdout.write(d); } catch (e) {} });
    if (child.stderr) child.stderr.on('data', (d) => { try { process.stderr.write(d); } catch (e) {} });
    child.on('message', onMessage);
    child.on('spawn', () => {
      const keychain = h.keychainAvailable();
      const key = keychain ? h.dataKey(true) : null;
      send({ t: 'init', info: { ...h.appInfo(), baseDir, keychain, dataKey: key ? key.toString('hex') : null } });
      pushDisplays();
      push('idle', h.idleSeconds());
    });
    child.on('exit', (code) => {
      child = null; ready = false;
      for (const done of pendingCalls.values()) done(false);
      pendingCalls.clear();
      if (stopping) return;
      const now = Date.now();
      deaths.push(now);
      while (deaths.length && now - deaths[0] > 60000) deaths.shift();
      if (!everReady && deaths.length >= 2) { fallbackToMain(code); return; }
      crashLog('server process exited unexpectedly (code ' + code + ')');
      console.error('[server host] server process exited (code ' + code + ')' + (deaths.length < 3 ? ', restarting' : ''));
      if (deaths.length < 3) setTimeout(() => { if (!stopping) spawn(); }, 500);
      else {
        try { h.dialog.showErrorBox('Broadcast Studio', 'The broadcast server stopped three times in a minute and was not restarted. Details are in logs/crash.log. Restart the app to try again.'); } catch (e) {}
      }
    });
  }
  // Electron before 22 has no utilityProcess (a checkout whose node_modules was not reinstalled):
  // run the server in this process instead. Deferred so main.js has registered its callbacks.
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') setImmediate(() => fallbackToMain('no utilityProcess in this Electron'));
  else spawn();

  function fallbackToMain(code) {
    crashLog('server process could not start (code ' + code + '); running the server in the main process');
    console.error('[server host] server process could not start; running the server in the main process');
    clearInterval(idleTimer);
    try {
      const mod = require(path.join(baseDir, 'server.js'));
      if (cb.launcherLaunch) mod.setLauncherLaunchCallback(cb.launcherLaunch);
      if (cb.launcherResize) mod.setLauncherResizeCallback(cb.launcherResize);
      if (cb.perfPriority) mod.setPerfPriorityCallback(cb.perfPriority);
      if (cb.encodeProgress) mod.setEncodeProgressCallback(cb.encodeProgress);
      if (cb.rlUiHotkey) mod.setRlSpectatorUiHotkeyChangeCallback(cb.rlUiHotkey);
      if (updateHandlers) mod.setUpdateHandlers(updateHandlers);
      mod.start(baseDir);
      inMain = mod;
      if (panelReady) mod.markPanelReady();
      if (lastUpdateStatus) mod.broadcastUpdateStatus(lastUpdateStatus);
      if (cb.rlUiHotkey) cb.rlUiHotkey();
    } catch (e) {
      crashLog('server failed to start in the main process too: ' + ((e && e.stack) || e));
      try { h.dialog.showErrorBox('Broadcast Studio — startup error', String((e && e.stack) || e)); } catch (err) {}
    }
  }

  return {
    isProcess: true,
    get pid() { return child ? child.pid : 0; },
    get inMainProcess() { return !!inMain; },
    markPanelReady() { panelReady = true; if (inMain) inMain.markPanelReady(); else call('markPanelReady'); },
    hideRlNativeUi() { if (inMain) inMain.hideRlNativeUi(); else call('hideRlNativeUi'); },
    getRlSpectatorUiConfig() { return inMain ? inMain.getRlSpectatorUiConfig() : rlUiConfig; },
    broadcastUpdateStatus(s) { lastUpdateStatus = s || null; if (inMain) inMain.broadcastUpdateStatus(lastUpdateStatus); else call('broadcastUpdateStatus', lastUpdateStatus); },
    broadcastCrashAlert(m) { if (inMain) inMain.broadcastCrashAlert(m); else call('broadcastCrashAlert', m); },
    setUpdateHandlers(handlers) { updateHandlers = handlers || null; if (inMain) inMain.setUpdateHandlers(updateHandlers); },
    setLauncherLaunchCallback(f) { cb.launcherLaunch = f; if (inMain) inMain.setLauncherLaunchCallback(f); },
    setLauncherResizeCallback(f) { cb.launcherResize = f; if (inMain) inMain.setLauncherResizeCallback(f); },
    setPerfPriorityCallback(f) { cb.perfPriority = f; if (inMain) inMain.setPerfPriorityCallback(f); },
    setEncodeProgressCallback(f) { cb.encodeProgress = f; if (inMain) inMain.setEncodeProgressCallback(f); },
    setRlSpectatorUiHotkeyChangeCallback(f) { cb.rlUiHotkey = f; if (inMain) inMain.setRlSpectatorUiHotkeyChangeCallback(f); },
    // Resolves once the server has flushed its saves and exited (or after 5s).
    shutdown() {
      stopping = true;
      clearInterval(idleTimer);
      if (inMain) { try { inMain.shutdown(); } catch (e) {} return Promise.resolve(); }
      const c = child;
      if (!c) return Promise.resolve();
      return new Promise((resolve) => {
        // Saves flushed (or no answer) -> end the process -> resolve once it has exited.
        let killed = false;
        const kill = () => { if (killed) return; killed = true; try { c.kill(); } catch (e) {} };
        const t = setTimeout(() => { console.warn('[server host] server did not stop in 5s'); kill(); resolve(); }, 5000);
        c.once('exit', () => { clearTimeout(t); resolve(); });
        if (!ready) { kill(); return; }
        const id = nextCallId++;
        pendingCalls.set(id, kill);
        send({ t: 'call', m: 'shutdown', a: [], id });
      });
    }
  };
}

module.exports = { startServerProcess };
