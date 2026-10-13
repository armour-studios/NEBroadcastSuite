// Headless render check for the CONTROL PANEL.
//
// panel-load-sim.js proves the script chain parses and runs against a stubbed DOM. This loads the
// real file:// page in Electron against the running app, lets it connect to the bridge and apply
// real state, then walks every nav destination — which is where render bugs actually surface
// (a throw inside one panel's renderer, a handler wired to a missing element, an applyState abort).
//
// Run:  npx electron scripts/panel-render-check.js
// (unset ELECTRON_RUN_AS_NODE first, or Electron starts as plain node and `app` is undefined.)
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { readConsoleMessage } = require('../backend/console-message');
const http = require('http');

const PANEL = path.join(__dirname, '..', 'control-panel', 'index.html');
const SETTLE_MS = Number(process.env.SETTLE_MS || 6000);
const NAV_SETTLE_MS = Number(process.env.NAV_SETTLE_MS || 700);

// Noise that is expected on a file:// page pointed at a live app and says nothing about our render
// health (autoplay policy, favicon, an integration the producer simply has not connected).
const IGNORE = [
  /favicon/i,
  /play\(\) failed|autoplay/i,
  /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i,
  // VDO.ninja's own bundle, running inside the camera/talent preview IFRAMES. Third-party code on
  // a remote origin, and it throws in a headless window with no camera/mic — nothing to do with
  // whether OUR panel rendered.
  /webrtc\.js|vdo\.ninja|Failed to execute 'postMessage'/i,
];
const noisy = (s) => IGNORE.some((re) => re.test(s));

function serverUp() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:3000/api/time', (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  if (!(await serverUp())) {
    console.error('No app answering on http://127.0.0.1:3000 — start NE Broadcast Suite first.');
    app.exit(2);
    return;
  }

  const problems = [];
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { offscreen: true } });
  const wc = win.webContents;
  wc.on('console-message', (...args) => {
    const { level, message, line, sourceId } = readConsoleMessage(...args);
    // Test the SOURCE as well as the text: a long third-party error arrives split across messages,
    // so the tail of a VDO.ninja stack shows up as a bare number that no text filter can catch.
    if (level === 3 && !noisy(message) && !noisy(sourceId || '')) {
      problems.push(`console error: ${message}` + (sourceId ? `  (${path.basename(sourceId)}:${line})` : ''));
    }
  });
  wc.on('render-process-gone', (_e, d) => problems.push(`RENDERER GONE: ${d.reason}`));

  await wc.loadFile(PANEL);
  await wc.executeJavaScript(`
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push('uncaught: ' + (e.message || e.type)
      + (e.filename ? '  (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '')));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push(
      'unhandled rejection: ' + ((e.reason && (e.reason.message || e.reason)) || 'unknown')));
    true;
  `);
  console.log('panel loaded — settling ' + SETTLE_MS + 'ms for the bridge connection + first state…');
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // Sanity: did the shell actually render, and did the bridge deliver state? `currentState` is a
  // top-level `let` in a classic script, so it is NOT a window property — read the DOM signals the
  // panel itself updates instead of guessing at globals.
  const health = await wc.executeJavaScript(`({
    navItems: document.querySelectorAll('.sidebar-nav .nav-item[data-tab]').length,
    panels: document.querySelectorAll('.tab-content').length,
    connected: !!(document.getElementById('status-dot') || {}).classList
      && document.getElementById('status-dot').classList.contains('ok'),
    bodyLen: document.body.innerHTML.trim().length
  })`);
  console.log('  nav items: ' + health.navItems + ' | panels: ' + health.panels
    + ' | bridge dot connected: ' + health.connected + ' | body: ' + health.bodyLen + ' chars');
  if (!health.navItems) problems.push('no nav items rendered — the shell did not build');
  if (!health.panels) problems.push('no .tab-content panels found — the page body did not build');
  if (!health.bodyLen) problems.push('body rendered EMPTY');

  // Walk every nav destination (main sidebar + each page's own sub-tab strips), collecting errors
  // thrown by that destination's renderer.
  const targets = await wc.executeJavaScript(`
    (function () {
      const out = [];
      const push = (sel, label) => document.querySelectorAll(sel).forEach((e, i) => out.push({ sel, i, label: label(e, i) }));
      push('.sidebar-nav .nav-item[data-tab]', (e) => 'page:' + e.dataset.tab);
      push('[data-talentpage]',  (e) => 'talent:' + e.dataset.talentpage);
      push('[data-qrtab]',       (e) => 'qrail:' + e.dataset.qrtab);
      push('[data-navgroup]',    (e) => 'gfxgroup:' + e.dataset.navgroup);
      return out;
    })()
  `);
  console.log('\nvisiting ' + targets.length + ' nav destinations…');
  for (const t of targets) {
    const before = (await wc.executeJavaScript('window.__errs.length')) || 0;
    await wc.executeJavaScript(
      `(function(){ var n = document.querySelectorAll(${JSON.stringify(t.sel)})[${t.i}];
         if (n) n.click(); return true; })();`);
    await new Promise((r) => setTimeout(r, NAV_SETTLE_MS));
    const errs = (await wc.executeJavaScript('window.__errs.slice(' + before + ')')).filter((e) => !noisy(e));
    if (errs.length) {
      console.log('  FAIL  ' + t.label);
      for (const e of [...new Set(errs)].slice(0, 5)) { console.log('          ' + e); problems.push(`[${t.label}] ${e}`); }
    } else {
      console.log('  ok    ' + t.label);
    }
  }

  const tail = await wc.executeJavaScript('window.__errs || []');
  for (const e of tail) if (!noisy(e) && !problems.some((p) => p.includes(e))) problems.push(e);

  win.destroy();
  const uniq = [...new Set(problems)];
  console.log('\n' + (uniq.length ? uniq.length + ' problem(s):\n  ' + uniq.join('\n  ') : 'control panel rendered clean'));
  app.exit(uniq.length ? 1 : 0);
});
