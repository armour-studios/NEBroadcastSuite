// node test/panel-load.test.js
// Runs the control panel's whole classic-script chain (scripts/panel-load-sim.js: index.html's
// script order, a permissive DOM stub) and requires every file to load without throwing: a TDZ
// read, a missing identifier or a syntax error in any panel script fails here.
'use strict';
const assert = require('assert');
const cp = require('child_process');
const path = require('path');

const out = cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'panel-load-sim.js')], { encoding: 'utf8', timeout: 120000 });
const loaded = out.split('\n').filter((l) => /^OK /.test(l));
const failed = out.split('\n').filter((l) => /^FAIL |^ {5}at /.test(l));
assert.ok(!failed.length, 'every panel script loads:\n' + failed.join('\n'));
assert.ok(loaded.some((l) => /^OK {3}app\.js$/.test(l)) && loaded.length >= 40, 'the chain ran, app.js included (' + loaded.length + ' scripts)');
console.log(`panel-load: ${loaded.length} scripts loaded, no load-time errors`);
