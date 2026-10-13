'use strict';
// The server's end of the link to the Electron main process, when the server runs in its own
// utility process (backend/server-process.js). Messages:
//   main  -> child  { t: 'init', info }            app paths/version, keychain status, data key
//                   { t: 'res', id, ok, v, err }    answer to an rpc
//                   { t: 'push', k, v }             cached values (displays, idle seconds)
//                   { t: 'call', m, a }             main asks the server to do something
//   child -> main   { t: 'rpc', id, m, a }          ask main for something, await the answer
//                   { t: 'fire', m, a }             tell main something, no answer
const { EventEmitter } = require('events');

const port = process.parentPort || null;
const link = new EventEmitter();
link.available = !!port;
link.info = null;          // set by 'init'
link.cache = Object.create(null);   // pushed values

let nextId = 1;
const pending = new Map();

function post(msg) { if (port) port.postMessage(msg); }

link.rpc = function rpc(m, ...a) {
  if (!port) return Promise.reject(new Error('no main-process link'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ t: 'rpc', id, m, a });
  });
};
link.fire = function fire(m, ...a) { post({ t: 'fire', m, a }); };

const callHandlers = Object.create(null);
link.handle = function handle(m, fn) { callHandlers[m] = fn; };

// Buffers cross the link as Uint8Array; give callers Buffers back.
function revive(v) {
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (x instanceof Uint8Array && !Buffer.isBuffer(x)) v[k] = Buffer.from(x.buffer, x.byteOffset, x.byteLength);
    }
  }
  return v;
}

if (port) {
  port.on('message', (e) => {
    const msg = e && e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'res') {
      const p = pending.get(msg.id); if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(revive(msg.v)); else p.reject(new Error(msg.err || 'main process error'));
    } else if (msg.t === 'push') {
      link.cache[msg.k] = msg.v;
      link.emit('push:' + msg.k, msg.v);
    } else if (msg.t === 'init') {
      link.info = msg.info;
      link.emit('init', msg.info);
    } else if (msg.t === 'call') {
      const fn = callHandlers[msg.m];
      if (!fn) { console.warn('[server-link] no handler for', msg.m); return; }
      try {
        const r = fn(...(msg.a || []));
        if (msg.id) Promise.resolve(r).then((v) => post({ t: 'res', id: msg.id, ok: true, v }), (err) => post({ t: 'res', id: msg.id, ok: false, err: err && err.message }));
      } catch (err) {
        console.error('[server-link] call', msg.m, 'failed:', err);
        if (msg.id) post({ t: 'res', id: msg.id, ok: false, err: err && err.message });
      }
    }
  });
}

module.exports = link;
