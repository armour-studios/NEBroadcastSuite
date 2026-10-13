// node test/persist-roundtrip.test.js
//
// Every setting the app saves must come back after a restart. Saving and loading are written out
// field by field (buildSaveSnapshot / loadState in server.js), so a field added to one side and not
// the other silently resets to its default on the next launch.
//
// How: take the default snapshot, change every leaf value to something different but plausible,
// write it as state.json, run the REAL loadState(), rebuild the snapshot and compare leaf by leaf.
// A leaf that does not survive is either a real loss or a value loadState() deliberately rejects
// (an enum, a clamp). Those are listed in ALLOWED with the reason, so a new loss fails the test.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const stub = new Proxy(function () {}, { get: (t, k) => (k === '__esModule' ? false : stub), apply: () => stub, construct: () => stub });
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      app: { getPath: () => os.tmpdir(), isPackaged: false, on() {}, getVersion: () => '0.0.0' },
      dialog: stub, BrowserWindow: stub, ipcMain: stub, shell: stub, screen: stub, nativeImage: stub,
      Notification: stub, powerMonitor: stub, safeStorage: { isEncryptionAvailable: () => false }
    };
  }
  return origLoad.call(this, req, ...rest);
};
const quiet = console.log; const quietErr = console.error; const quietWarn = console.warn;
console.log = () => {}; console.warn = () => {};
const loadErrors = [];
console.error = (...a) => loadErrors.push(a.map(String).join(' '));
const server = require(path.join(__dirname, '..', 'server.js'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-roundtrip-'));
const file = path.join(dir, 'state.json');

fs.writeFileSync(file, '{}');
server._testLoadState(file);
const defaults = server._testSaveSnapshot();

// A different value of the same type. Strings get a suffix; numbers move by one; booleans flip;
// arrays gain nothing (an empty default list stays empty: its items' shapes are unknown here).
function perturb(v, key) {
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return v === 0 ? 1 : v + 1;
  if (typeof v === 'string') return v + 'x';
  if (Array.isArray(v)) return v.map((x, i) => perturb(x, key + '[' + i + ']'));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = perturb(v[k], key + '.' + k); return o; }
  return v;
}
// Secrets are restored through restoreSecrets(), which decrypts them; they are covered elsewhere.
const SECRET = /token|apikey|password|refreshkey|serviceaccount|feedtokens/i;
const changed = {};
for (const k of Object.keys(defaults)) changed[k] = SECRET.test(k) ? defaults[k] : perturb(defaults[k], k);
fs.writeFileSync(file, JSON.stringify(changed));
loadErrors.length = 0;
const { abort, state: loadedState } = server._testLoadState(file);
const after = server._testSaveSnapshot();
console.log = quiet; console.error = quietErr; console.warn = quietWarn;

// Leaves that loadState deliberately normalises (validated enums, clamps, derived values).
// key path -> why it may not round-trip a perturbed value.
const ALLOWED = require('./fixtures/persist-allowed.js');

const lost = [];
function walk(a, b, p) {
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    for (const k of Object.keys(a)) walk(a[k], b == null ? undefined : b[k], p ? p + '.' + k : k);
    return;
  }
  if (Array.isArray(a)) { if (JSON.stringify(a) !== JSON.stringify(b)) lost.push(p); return; }
  if (a !== b) lost.push(p);
}
for (const k of Object.keys(changed)) { if (!SECRET.test(k)) walk(changed[k], after[k], k); }
const allowedHit = (p) => Object.keys(ALLOWED).some((a) => p === a || p.startsWith(a + '.') || p.startsWith(a + '['));
const unexpected = lost.filter((p) => !allowedHit(p));
const staleAllow = Object.keys(ALLOWED).filter((a) => !lost.some((p) => p === a || p.startsWith(a + '.') || p.startsWith(a + '[')));

let failures = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++; };
check(!abort, 'loadState() completed' + (abort ? ' — ' + abort.error : ''));
check(Object.keys(defaults).length > 100, 'snapshot has ' + Object.keys(defaults).length + ' saved settings');
check(!unexpected.length, 'every saved setting survives a restart' + (unexpected.length ? ':\n    ' + unexpected.join('\n    ') : ''));
// Every state key is either saved or declared runtime-only (with its reason).
const RUNTIME = require('./fixtures/persist-runtime.js');
const undeclared = Object.keys(loadedState).filter((k) => !(k in after) && !(k in RUNTIME));
check(!undeclared.length, 'every state key is saved or declared runtime-only' + (undeclared.length ? ': ' + undeclared.join(', ') + ' (add it to buildSaveSnapshot + loadState, or to test/fixtures/persist-runtime.js)' : ''));
const staleRuntime = Object.keys(RUNTIME).filter((k) => k in after || !(k in loadedState));
check(!staleRuntime.length, 'runtime-only list is current' + (staleRuntime.length ? ': remove ' + staleRuntime.join(', ') : ''));
if (staleAllow.length) console.log('note: these allowed entries now round-trip and can be removed: ' + staleAllow.join(', '));
if (process.env.LIST) console.log(lost.join('\n'));
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
