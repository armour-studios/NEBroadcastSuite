'use strict';
// Who may call the local API / WS bridge. Every legitimate caller found in the codebase must pass;
// a foreign web page must not (it could otherwise read state and drive the show).
const assert = require('assert');
const { isAllowedOrigin } = require('../backend/origin-guard');

let pass = 0;
const ok = (origin, host, why) => { assert.strictEqual(isAllowedOrigin(origin, host), true, why + ' should be allowed'); pass++; };
const no = (origin, host, why) => { assert.strictEqual(isAllowedOrigin(origin, host), false, why + ' should be refused'); pass++; };

// Legitimate callers
ok(undefined, 'localhost:3000', 'OBS / Stream Deck / curl (no Origin)');
ok('', 'localhost:3000', 'empty Origin');
ok('null', 'localhost:3000', 'control panel (file:// sends "null")');
ok('file://', 'localhost:3000', 'control panel (file://)');
ok('http://localhost:3000', 'localhost:3001', 'overlay on localhost -> bridge');
ok('http://127.0.0.1:3000', '127.0.0.1:3001', 'overlay on 127.0.0.1');
ok('http://[::1]:3000', '[::1]:3001', 'overlay on ::1');
ok('http://localhost:5173', 'localhost:3000', 'local dev server (e.g. companion app)');
ok('overwolf-extension://abcdefghijklmnop', '127.0.0.1:3000', 'Overwolf GEP relay');
ok('http://192.168.1.20:3000', '192.168.1.20:3001', 'overlay opened by LAN IP talking back to the same host');
ok('HTTP://LOCALHOST:3000', 'localhost:3001', 'case-insensitive');

// Foreign pages
no('https://evil.example', 'localhost:3000', 'a random website');
no('https://nenetwork.gg', '127.0.0.1:3001', 'even our own website (it never calls the local app)');
no('http://192.168.1.99:8080', '192.168.1.20:3000', 'another LAN host');
no('http://localhost.evil.example', 'localhost:3000', 'look-alike host');
no('chrome-extension://xyz', 'localhost:3000', 'browser extension pages');
no('not a url', 'localhost:3000', 'garbage');

// Escape hatch
process.env.NE_ALLOW_ORIGINS = 'https://tools.example.org';
ok('https://tools.example.org', 'localhost:3000', 'NE_ALLOW_ORIGINS entry');
delete process.env.NE_ALLOW_ORIGINS;
no('https://tools.example.org', 'localhost:3000', 'same origin once the env var is gone');

console.log(`origin-guard: all ${pass} checks passed`);
