// Headless render check for every overlay page.
//
// The load simulator (panel-load-sim.js) proves the CONTROL PANEL's script chain parses and runs.
// This is its counterpart for the OVERLAYS, which the sim can't cover: they are real pages served
// over HTTP, they talk to the bridge WebSocket, and their failure mode is a JS error at load that
// leaves a browser source blank on air with nothing in any log the producer can see.
//
// Opens each page in an offscreen Electron window against the ALREADY-RUNNING app (so it needs no
// ports of its own and can't fight the real server), waits for it to settle, and reports every
// uncaught error, unhandled rejection, console error, and failed subresource.
//
// Run:  npx electron scripts/overlay-render-check.js
//       npx electron scripts/overlay-render-check.js ticker.html rl-hud.html   (subset)
// Note: unset ELECTRON_RUN_AS_NODE first — with it set, Electron starts as plain node and `app`
// is undefined.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = 'http://127.0.0.1:3000';
const OVERLAY_DIR = path.join(__dirname, '..', 'overlay');
const SETTLE_MS = Number(process.env.SETTLE_MS || 2500);

// Pages that are templates/partials rather than standalone browser sources.
const SKIP = new Set(['scene.css', 'styles.css']);

function listPages() {
  const arg = process.argv.slice(2).filter((a) => a.endsWith('.html'));
  if (arg.length) return arg;
  return fs.readdirSync(OVERLAY_DIR)
    .filter((f) => f.endsWith('.html') && !SKIP.has(f))
    .sort();
}

function serverUp() {
  return new Promise((resolve) => {
    const req = http.get(BASE + '/api/time', (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

async function checkPage(page) {
  const problems = [];
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  const wc = win.webContents;

  wc.on('console-message', (_e, level, message, line, sourceId) => {
    // 3 = error. Warnings are noisy and mostly upstream (fonts, autoplay).
    if (level === 3) problems.push(`console error: ${message}` + (sourceId ? `  (${sourceId}:${line})` : ''));
  });
  wc.on('render-process-gone', (_e, d) => problems.push(`RENDERER GONE: ${d.reason}`));
  wc.on('preload-error', (_e, f, err) => problems.push(`preload error ${f}: ${err.message}`));
  wc.on('did-fail-load', (_e, code, desc, url) => problems.push(`page failed to load (${code} ${desc}) ${url}`));
  wc.on('did-fail-provisional-load', (_e, code, desc, url, isMain) => {
    if (isMain) problems.push(`main-frame load failed (${code} ${desc}) ${url}`);
  });

  try {
    await wc.loadURL(`${BASE}/${page}`);
    // Surface uncaught errors + rejections that fire AFTER load (timers, WS handlers).
    await wc.executeJavaScript(`
      window.__errs = window.__errs || [];
      window.addEventListener('error', (e) => window.__errs.push(
        'uncaught: ' + (e.message || e.type) + (e.filename ? '  (' + e.filename + ':' + e.lineno + ')' : '')));
      window.addEventListener('unhandledrejection', (e) => window.__errs.push(
        'unhandled rejection: ' + ((e.reason && (e.reason.message || e.reason)) || 'unknown')));
      true;
    `);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const errs = await wc.executeJavaScript('window.__errs || []');
    problems.push(...errs);
    // A page that rendered nothing at all is broken even without throwing.
    const bodyLen = await wc.executeJavaScript('document.body ? document.body.innerHTML.trim().length : 0');
    if (!bodyLen) problems.push('body rendered EMPTY');
  } catch (e) {
    problems.push('harness error: ' + e.message);
  } finally {
    win.destroy();
  }
  return problems;
}

app.disableHardwareAcceleration();
// Each page is checked in its own window, so between pages the window count hits zero — which on
// Windows fires Electron's default quit. Without this the run ends after the FIRST page (and the
// second page reports a phantom ERR_FAILED as the app tears down under it).
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  if (!(await serverUp())) {
    console.error(`No app answering on ${BASE} — start NE Broadcast Suite first (this checker attaches to it).`);
    app.exit(2);
    return;
  }
  const pages = listPages();
  console.log(`Checking ${pages.length} overlay page(s) against ${BASE}\n`);
  let bad = 0;
  for (const page of pages) {
    let problems = await checkPage(page);
    // Creating offscreen windows back-to-back can exhaust the GPU/renderer pool and fail a load
    // that is actually fine (ERR_FAILED with no page-level error). Retry once, after a breath,
    // so the report shows real page bugs rather than harness churn.
    if (problems.some((p) => p.includes('ERR_FAILED'))) {
      await new Promise((r) => setTimeout(r, 1500));
      problems = await checkPage(page);
    }
    if (problems.length) {
      bad++;
      console.log(`FAIL  ${page}`);
      for (const p of [...new Set(problems)].slice(0, 8)) console.log(`        ${p}`);
    } else {
      console.log(`ok    ${page}`);
    }
  }
  console.log(`\n${pages.length - bad} clean, ${bad} with problems`);
  app.exit(bad ? 1 : 0);
});
