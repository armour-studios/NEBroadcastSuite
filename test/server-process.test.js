// node test/server-process.test.js
// The server runs in its own Electron utility process (refactor step 6). It reaches Electron only
// through backend/electron-api.js; backend/server-host.js answers for it in the main process.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0;
const ok = (cond, why) => { assert.ok(cond, why); pass++; };

// ── 'enc2:' secrets ──
const { aesEncrypt, aesDecrypt } = require('../backend/secret-aes');
const key = crypto.randomBytes(32);
const box = aesEncrypt(key, 'token-123');
ok(/^enc2:/.test(box) && aesDecrypt(key, box) === 'token-123', 'enc2 round trip');
ok(aesEncrypt(key, 'token-123') !== box, 'fresh IV per secret');
ok((() => { try { aesDecrypt(crypto.randomBytes(32), box); return false; } catch (e) { return true; } })(), 'the wrong key cannot read it');

// ── electron-api in plain node: nothing Electron-backed ──
const plain = require('../backend/electron-api');
ok(plain.mode === 'node' && plain.dialog === undefined && plain.screenCapture.available() === false, 'plain node gets no Electron services');
ok(plain.secrets.decrypt('enc:abc') === '' && plain.secrets.decrypt('enc2:abc') === '' && plain.secrets.decrypt('legacy') === 'legacy', 'plain node reads only plaintext secrets');

// ── electron-api in the utility process (fake link) ──
function loadUtilityApi() {
  for (const m of ['../backend/electron-api', '../backend/server-link']) delete require.cache[require.resolve(m)];
  const port = new EventEmitter();
  const posted = [];
  port.postMessage = (m) => posted.push(m);
  const saved = { type: process.type, parentPort: process.parentPort };
  Object.defineProperty(process, 'type', { value: 'utility', configurable: true, writable: true });
  process.parentPort = port;
  try {
    const api = require('../backend/electron-api');
    return { api, port, posted, link: require('../backend/server-link') };
  } finally {
    Object.defineProperty(process, 'type', { value: saved.type, configurable: true, writable: true });
    process.parentPort = saved.parentPort;
  }
}
const deliver = (port, data) => port.emit('message', { data });

(async () => {
  const u = loadUtilityApi();
  ok(u.api.mode === 'utility', 'utility mode picked inside a utility process');
  deliver(u.port, { t: 'init', info: { keychain: true, dataKey: key.toString('hex'), isPackaged: true, version: '9.9.9', paths: { userData: 'C:/ud', desktop: 'C:/desk' } } });
  ok(u.api.app.isPackaged === true && u.api.app.getVersion() === '9.9.9' && u.api.app.getPath('desktop') === 'C:/desk', 'app info comes from init');
  ok((() => { try { u.api.app.getPath('nope'); return false; } catch (e) { return true; } })(), 'an unknown path throws like Electron');

  // Secrets on disk at boot ('enc:') were decrypted by main beforehand.
  u.api.secrets.prefetched({ 'enc:OLD': 'old-token' });
  ok(u.api.secrets.decrypt('enc:OLD') === 'old-token', 'prefetched keychain secret reads synchronously');
  ok(u.api.secrets.encrypt('old-token') === 'enc:OLD', 'an unchanged secret is saved as the same keychain ciphertext');

  // A new secret: enc2 straight away, keychain form once main answers, then a re-save.
  const first = u.api.secrets.encrypt('new-token');
  ok(/^enc2:/.test(first) && u.api.secrets.decrypt(first) === 'new-token', 'a new secret is encrypted synchronously (enc2)');
  const ask = u.posted.find((m) => m.t === 'rpc' && m.m === 'secrets.encrypt');
  ok(ask && ask.a[0] === 'new-token', 'and main is asked for its keychain form');
  let settled = false;
  u.link.on('secrets-settled', () => { settled = true; });
  deliver(u.port, { t: 'res', id: ask.id, ok: true, v: 'enc:NEW' });
  await new Promise((r) => setTimeout(r, 400));
  ok(settled, 'the server is told to re-save');
  ok(u.api.secrets.encrypt('new-token') === 'enc:NEW', 'later saves write the keychain form (older versions can read it)');
  ok(u.api.secrets.decrypt('enc:NEW') === 'new-token', 'and it reads back');

  // Buffers come back as Buffers; pushed values are cached for synchronous reads.
  const cap = u.api.screenCapture.captureDisplay('1');
  const capAsk = u.posted.find((m) => m.t === 'rpc' && m.m === 'captureDisplay');
  deliver(u.port, { t: 'res', id: capAsk.id, ok: true, v: { data: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 } });
  const frame = await cap;
  ok(Buffer.isBuffer(frame.data) && frame.data[3] === 4, 'captured frames arrive as Buffers');
  deliver(u.port, { t: 'push', k: 'idle', v: 42 });
  deliver(u.port, { t: 'push', k: 'displays', v: [{ id: '1' }] });
  ok(u.api.powerMonitor.getSystemIdleTime() === 42 && u.api.screenCapture.listDisplays().length === 1, 'idle time and displays read from pushed values');
  const failing = u.api.dialog.showOpenDialog({});
  const dAsk = u.posted.find((m) => m.t === 'rpc' && m.m === 'dialog.showOpenDialog');
  deliver(u.port, { t: 'res', id: dAsk.id, ok: false, err: 'boom' });
  ok(await failing.then(() => false, (e) => e.message === 'boom'), 'a failed host call rejects with its message');

  // No keychain on this machine: plaintext, as before.
  const v = loadUtilityApi();
  deliver(v.port, { t: 'init', info: { keychain: false, paths: {} } });
  ok(v.api.secrets.encrypt('x') === 'x' && !v.posted.some((m) => m.m === 'secrets.encrypt'), 'no keychain: plaintext fallback, nothing asked');

  // ── Only main-process files load Electron ──
  const MAIN_ONLY = new Set(['backend/host-services.js', 'backend/server-host.js', 'backend/game-overlay-windows.js', 'backend/game-overlay-preload.js']);
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = (dir + '/' + e.name).replace(/^\.\//, '');
      if (e.isDirectory()) walk(rel);
      else if (/\.js$/.test(e.name) && !MAIN_ONLY.has(rel) && /require\(\s*['"]electron['"]\s*\)/.test(read(rel))) offenders.push(rel);
    }
  })('backend');
  if (/require\(\s*['"]electron['"]\s*\)/.test(read('server.js'))) offenders.push('server.js');
  ok(!offenders.length, 'server code reaches Electron only through electron-api: ' + offenders.join(', '));

  // ── Both ends of the link agree ──
  const host = read('backend/server-host.js');
  const api = read('backend/electron-api.js');
  const proc = read('backend/server-process.js');
  const block = (name) => host.slice(host.indexOf('const ' + name + ' = {'), host.indexOf('\n  };', host.indexOf('const ' + name + ' = {')));
  const keysOf = (src) => new Set([...src.matchAll(/^ {4}'?([A-Za-z.]+)'?:/gm)].map((m) => m[1]));
  const rpcKeys = keysOf(block('RPC')), fireKeys = keysOf(block('FIRE'));
  const asked = [...(api + proc).matchAll(/link\.rpc\('([A-Za-z.]+)'/g)].map((m) => m[1]);
  const told = [...(api + proc).matchAll(/link\.fire\('([A-Za-z.]+)'/g)].map((m) => m[1]);
  ok(asked.length >= 8 && asked.every((m) => rpcKeys.has(m)), 'every rpc the server makes has a host handler: ' + asked.filter((m) => !rpcKeys.has(m)).join(', '));
  ok(told.length >= 8 && told.every((m) => fireKeys.has(m)), 'every message the server fires has a host handler: ' + told.filter((m) => !fireKeys.has(m)).join(', '));
  const handled = new Set([...proc.matchAll(/link\.handle\('([A-Za-z]+)'/g)].map((m) => m[1]));
  const called = [...host.matchAll(/\bcall\('([A-Za-z]+)'/g)].map((m) => m[1]).concat(/m: 'shutdown'/.test(host) ? ['shutdown'] : []);
  ok(called.length >= 5 && called.every((m) => handled.has(m)), 'every call main makes is handled by the server process: ' + called.filter((m) => !handled.has(m)).join(', '));

  // main.js calls the same methods on the host proxy as it did on require('./server').
  const mainJs = read('main.js');
  const used = new Set([...mainJs.matchAll(/\bserver\??\.([a-zA-Z]+)\b/g)].map((m) => m[1]).filter((n) => !['start', 'isProcess', 'js'].includes(n)));   // 'js': "server.js" in comments
  const proxy = host.slice(host.indexOf('  return {\n    isProcess: true'));
  const missing = [...used].filter((n) => !new RegExp('\\b' + n + '\\(').test(proxy));
  ok(used.size >= 8 && !missing.length, 'the host proxy offers every method main.js calls: ' + missing.join(', '));
  ok(/NE_SERVER_IN_MAIN === '1'[\s\S]{0,120}require\('\.\/server'\)[\s\S]{0,200}startServerProcess\(__dirname\)/.test(mainJs), 'server process by default, NE_SERVER_IN_MAIN=1 runs it in main');
  ok(/if \(!everReady && deaths\.length >= 2\) \{ fallbackToMain\(code\); return; \}/.test(host) && /function fallbackToMain\(code\) \{[\s\S]{0,900}mod\.start\(baseDir\)/.test(host), 'a server process that never starts falls back to running in main');
  ok(/deaths\.length < 3\) setTimeout\(\(\) => \{ if \(!stopping\) spawn\(\); \}/.test(host), 'a crashed server process is restarted (up to 3 times a minute)');
  ok(/server\.isProcess[\s\S]{0,200}e\.preventDefault\(\)[\s\S]{0,120}server\.shutdown\(\)\.finally\(\(\) => app\.quit\(\)\)/.test(mainJs), 'quitting waits for the server process to save');

  console.log(`server-process: all ${pass} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
