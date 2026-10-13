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

// DNS rebinding: a public name pointed at 127.0.0.1 is same-origin with us, so the Host is the tell.
no('http://evil.example:3000', 'evil.example:3000', 'rebinding page (Origin host == Host)');
no(undefined, 'evil.example:3000', 'rebinding page, same-origin GET with no Origin');
ok(undefined, 'studio-pc:3000', 'LAN machine name');
ok('http://studio-pc.local:3000', 'studio-pc.local:3001', 'mDNS LAN name');

// "null" / file:// only from the app or OBS (their User-Agent), never a sandboxed iframe in a browser.
const ua = (origin, host, agent, want, why) => { assert.strictEqual(isAllowedOrigin(origin, host, agent), want, why); pass++; };
ua('null', 'localhost:3000', 'Mozilla/5.0 Chrome/100.0 Electron/18.3.15 Safari/537.36', true, 'panel (Electron)');
ua('file://', '127.0.0.1:3001', 'Mozilla/5.0 Chrome/100.0 Electron/18.3.15', true, 'panel WS (Electron)');
ua('null', 'localhost:3000', 'Mozilla/5.0 Chrome/103.0 Safari/537.36 OBS/30.0.2', true, 'OBS local-file source');
ua('null', '127.0.0.1:3001', 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36', false, 'sandboxed iframe in a browser');
ua('null', '127.0.0.1:3001', '', false, 'no user agent');
ua('http://localhost:3000', 'localhost:3001', 'Mozilla/5.0 Chrome/126.0', true, 'overlay origin is unaffected by UA');

// Escape hatch
process.env.NE_ALLOW_ORIGINS = 'https://tools.example.org';
ok('https://tools.example.org', 'localhost:3000', 'NE_ALLOW_ORIGINS entry');
delete process.env.NE_ALLOW_ORIGINS;
no('https://tools.example.org', 'localhost:3000', 'same origin once the env var is gone');

console.log(`origin-guard: all ${pass} checks passed`);
