// backend/cs2-netcon.js — CS2's network console (launch option `-netconport <port>`).
//
// A plain line-based TCP console on 127.0.0.1: write "command\n", the game's console output comes
// back as text. Unlike the observer-slot keys (PowerShell SendKeys), it needs no window focus and
// can send ANY spectator command — which is what drives the scripted freezetime camera
// (spec_goto) and lets the producer capture a camera pose (getpos) without typing in the console.
//
// Opt-in: only connects while start() has been called (Cinematic freezetime enabled). Reconnects
// with a gentle backoff, because CS2 is usually started after the app.
'use strict';
const net = require('net');

function createNetcon({ onStatus } = {}) {
  let sock = null, port = 2121, wanted = false, connected = false;
  let retryT = null, retryMs = 2000;
  let buf = '';
  const listeners = new Set();   // (line) => void, for query()

  const setStatus = (s, detail) => { try { onStatus && onStatus(s, detail || ''); } catch (e) {} };

  function open() {
    clearTimeout(retryT);
    if (!wanted) return;
    const s = net.createConnection({ host: '127.0.0.1', port });
    sock = s;
    s.setNoDelay(true);
    s.setEncoding('utf8');
    s.on('connect', () => { connected = true; retryMs = 2000; setStatus('connected', 'port ' + port); });
    s.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        listeners.forEach((fn) => { try { fn(line); } catch (e) {} });
      }
      if (buf.length > 65536) buf = '';
    });
    const down = () => {
      if (sock !== s) return;
      sock = null; buf = '';
      const was = connected; connected = false;
      if (!wanted) { setStatus('off'); return; }
      setStatus('waiting', was ? 'CS2 closed the console' : 'CS2 not reachable on port ' + port);
      retryT = setTimeout(open, retryMs);
      retryMs = Math.min(15000, Math.round(retryMs * 1.5));
    };
    s.on('error', down);
    s.on('close', down);
  }

  function start(p) {
    const np = Number(p) > 0 && Number(p) < 65536 ? Number(p) : 2121;
    const changed = np !== port;
    port = np;
    if (wanted && !changed) return;
    wanted = true;
    if (sock) { const s = sock; sock = null; try { s.destroy(); } catch (e) {} }
    connected = false;
    setStatus('waiting', 'connecting to port ' + port);
    open();
  }

  function stop() {
    wanted = false;
    clearTimeout(retryT);
    if (sock) { const s = sock; sock = null; try { s.destroy(); } catch (e) {} }
    connected = false;
    setStatus('off');
  }

  // Fire-and-forget. Several commands may be joined with ';' on one line.
  function send(cmd) {
    if (!sock || !connected) return false;
    try { sock.write(String(cmd).replace(/[\r\n]+/g, ' ') + '\n'); return true; } catch (e) { return false; }
  }

  // Send a command and resolve with the first console line matching `re` (or null on timeout).
  function query(cmd, re, timeoutMs = 1200) {
    return new Promise((resolve) => {
      if (!send(cmd)) return resolve(null);
      const fn = (line) => { const m = re.exec(line); if (m) { done(m); } };
      const t = setTimeout(() => done(null), timeoutMs);
      function done(v) { clearTimeout(t); listeners.delete(fn); resolve(v); }
      listeners.add(fn);
    });
  }

  return { start, stop, send, query, isConnected: () => connected, getPort: () => port };
}

module.exports = { createNetcon };
