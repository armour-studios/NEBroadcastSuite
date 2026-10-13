// node test/ws-handlers.test.js
// Every WebSocket message the control panel, the overlays and the Stream Deck plugin send must have
// exactly one handler on the server: an entry in the WS_HANDLERS registry (registerWsHandlers, in
// server.js or a backend module). handleControlMessage only looks the type up; an unknown type is
// logged, so a typo in a button (or a handler removed in a refactor) shows up instead of doing nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// The dispatcher's switch lives in server.js; split-out modules are scanned for registry entries below.
const server = read('server.js');
let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };

// ── Handlers ──
const dispatch = server.indexOf('function handleControlMessage(msg, ws) {');
ok(dispatch > 0, 'handleControlMessage found');
const dispatcher = server.slice(dispatch, server.indexOf('\n}\n', dispatch));
// The 475-case switch became registry entries (refactor, 2026-10-13). Keep it that way.
ok(!/switch \(msg\.type\)/.test(dispatcher) && /if \(h\) return void h\(msg, ws\);\s*warnUnhandledType\(msg\.type\);/.test(dispatcher), 'handleControlMessage only dispatches through the registry (no switch)');
const switchCases = [];
const registry = new Map();   // type -> file
function scanRegistry(file, src) {
  // Generated form: registerWsHandlers(Object.fromEntries(['a', 'b'].map(...)))
  for (const b of src.matchAll(/registerWsHandlers\(Object\.fromEntries\(\s*\[([^\]]+)\]/g)) {
    for (const m of b[1].matchAll(/'([a-z0-9_]+)'/g)) registry.set(m[1], file);
  }
  for (const b of src.matchAll(/registerWsHandlers\(\{([\s\S]*?)\n\}\);/g)) {
    for (const m of b[1].matchAll(/^ {2}(?:async )?([a-z0-9_]+)\s*\([^)]*\)\s*\{/gm)) {
      if (/^(if|for|while|switch|catch|return|function)$/.test(m[1])) continue;
      assert.ok(!registry.has(m[1]), `'${m[1]}' is registered twice (${registry.get(m[1])} and ${file})`);
      registry.set(m[1], file);
    }
  }
}
scanRegistry('server.js', server);
// Feature modules register their own handlers (backend/**: registerWsHandlers passed in, or a
// `wsHandlers` export merged by server.js).
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel); else if (/\.js$/.test(e.name)) scanRegistry(rel, read(rel));
  }
})('backend');
// Types answered before dispatch (socket setup in the bridge's 'message' listener).
const PRE = new Set([...server.matchAll(/msg\.type\s*===\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));

const inBoth = switchCases.filter((t) => registry.has(t));
ok(!inBoth.length, 'no type is handled by both the switch and the registry (the switch copy would be dead): ' + inBoth.join(', '));
const dupCases = switchCases.filter((t, i) => switchCases.indexOf(t) !== i);
ok(!dupCases.length, 'no duplicate case labels: ' + dupCases.join(', '));
const handled = new Set([...switchCases, ...registry.keys(), ...PRE]);

// ── Senders ──
const sent = new Map();
const note = (t, where) => { if (!sent.has(t)) sent.set(t, where); };
const SEND_PATTERNS = [
  /\bsend\(\s*'([a-z0-9_]+)'/g,                       // panel: send('type', data)
  /\bsend\(\s*JSON\.stringify\(\s*\{\s*type:\s*'([a-z0-9_]+)'/g,
  /\.send\(\s*\{\s*type:\s*'([a-z0-9_]+)'/g,          // overlays via the bridge host
  /\bsendWs\(\s*'([a-z0-9_]+)'/g
];
for (const dir of ['control-panel', 'overlay']) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (!/\.(js|html)$/.test(f)) continue;
    const src = read(path.join(dir, f));
    for (const re of SEND_PATTERNS) for (const m of src.matchAll(re)) note(m[1], dir + '/' + f);
  }
}
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel);
    else if (/\.ts$/.test(e.name)) for (const m of read(rel).matchAll(/\bfire\([^,()]+,\s*["']([a-z0-9_]+)["']/g)) note(m[1], rel);
  }
})('streamdeck-plugin/src');

const missing = [...sent.keys()].filter((t) => !handled.has(t)).sort();
ok(sent.size > 300, 'found ' + sent.size + ' message types sent by the panel, overlays and Stream Deck');
ok(!missing.length, 'every sent message type has a handler:\n    ' + missing.map((t) => t + '  <- ' + sent.get(t)).join('\n    '));
ok(/function warnUnhandledType\(/.test(server), 'unknown message types are logged (once each), not dropped silently');
console.log(`ws-handlers: all ${pass} checks passed (${registry.size} registered handlers, ${sent.size} sent types)`);
