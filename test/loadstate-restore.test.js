// node test/loadstate-restore.test.js
//
// Runs the REAL loadState() from server.js against a state file and fails if the restore aborts
// part-way, or if the crew roster does not come back.
//
// Why: loadState() is one long try block. A throw anywhere in it skips every field restored after
// the throw, and the next auto-save writes those empty defaults over the good file. That is how a
// producer's whole crew roster vanished (2026-09-18): the Smash restore called normalizeSmashMode(),
// which was declared inside handleControlMessage's switch and so did not exist at module scope —
// ReferenceError, restore aborted, crew never restored, crew saved as [].
//
// The fixture is the app's own default state (so every `if (saved.x)` branch with a default shape
// runs) plus a crew roster, round-tripped through a file.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// server.js is written for Electron's main process; stub just enough to require it under node.
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

let failures = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++; };

const errors = [];
const origErr = console.error;
console.error = (...a) => errors.push(a.map((v) => (v && v.stack) ? v.stack : String(v)).join(' '));

const server = require(path.join(__dirname, '..', 'server.js'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-loadstate-'));
const file = path.join(dir, 'state.json');

// Pass 1: an empty file gives us the app's default state to use as the fixture.
fs.writeFileSync(file, '{}');
const defaults = JSON.parse(JSON.stringify(server._testLoadState(file).state));
const crew = [
  { id: 'c1', name: 'Alpha', handle: 'alpha', role: '', group: 'casters', active: false, workedEvent: false },
  { id: 'c2', name: 'Bravo', handle: 'bravo', role: 'Producer', group: 'producer', active: true, workedEvent: true }
];
fs.writeFileSync(file, JSON.stringify({ ...defaults, crew, smash: { ...(defaults.smash || {}), mode: 'doubles' } }));

// Pass 2: the real restore.
errors.length = 0;
const { state, abort } = server._testLoadState(file);
console.error = origErr;

check(!abort, 'loadState() completes without aborting' + (abort ? ` — ${abort.error}` : ''));
check(!errors.some((e) => /RESTORE ABORTED/.test(e)), 'no RESTORE ABORTED logged');
check(Array.isArray(state.crew) && state.crew.length === 2, 'crew roster restored (2 members)');
check(state.smash && state.smash.mode === 'doubles', 'smash mode restored');

if (abort || failures) errors.filter((e) => /loading state/i.test(e)).forEach((e) => console.log(e.split('\n').slice(0, 4).join('\n')));
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
