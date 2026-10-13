/* bridge-host.js — one bridge socket for a wrapper source and every overlay embedded in it.
   Used by gfx.html and triggers.html (each marks <html data-ne-bridge="1"> and loads this file).
   Their embedded graphics each used to open their own socket to :3001 (gfx.html: 18 sockets and 18
   full_state parses per broadcast for ONE OBS source). Pages built on SceneBase see the marker, find
   window.parent.__neBridge (same origin) and ride this socket instead: they get every frame as the raw
   string (already image-restored by sticky-logos.js, which wraps this socket) and send through it.
   Pages with their own socket code are unaffected.

   window.__neBridge.subscribe(fn) -> unsubscribe   fn('open') on every (re)connect, fn('message', raw)
   window.__neBridge.send(obj | string)             false while disconnected */
(function () {
  'use strict';
  if (window.__neBridge) return;
  var host = location.hostname || 'localhost';
  if (host === 'localhost') host = '127.0.0.1';   // the bridge binds IPv4; localhost can resolve to ::1
  var token = null, ws = null, retryMs = 1000;
  var subs = [];
  function fanout(kind, data) {
    subs.slice().forEach(function (fn) {
      try { fn(kind, data); }
      catch (e) {
        // A subscriber from a page that has since reloaded (its realm is gone) throws on every call:
        // drop it. Live pages catch their own render errors, so a throw here means a dead page.
        var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1);
        if (window.console) console.warn('[bridge] dropped a subscriber that failed', e);
      }
    });
    // This wrapper page itself (bridge-host.js / its own html) changed, or "Reload OBS": reload it.
    if (kind === 'message' && typeof data === 'string' && data.indexOf('reload_overlays') >= 0) {
      try {
        var m = JSON.parse(data);
        if (m && m.type === 'reload_overlays') {
          var files = Array.isArray(m.files) ? m.files.map(function (f) { return String(f).replace(/\\/g, '/').toLowerCase().split('/').pop(); }) : null;
          var page = (location.pathname.split('/').pop() || '').toLowerCase();
          if (!files || !files.length || files.indexOf(page) >= 0 || files.indexOf('bridge-host.js') >= 0) setTimeout(function () { location.reload(); }, 50);
        }
      } catch (e) {}
    }
  }
  // Every embedded page asks for the full state when the socket opens; answered one by one on this
  // ONE socket, each reply reached every page (19 full payloads x 18 parses at each reconnect).
  // Requests arriving together become one; its reply reaches every subscriber anyway.
  var stateReqTimer = null;
  function requestState() {
    if (stateReqTimer) return;
    stateReqTimer = setTimeout(function () {
      stateReqTimer = null;
      if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'request_state', role: 'overlay' })); } catch (e) {} }
    }, 150);
  }
  window.__neBridge = {
    subscribe: function (fn) {
      subs.push(fn);
      if (ws && ws.readyState === 1) { try { fn('open'); } catch (e) {} }
      return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
    },
    send: function (obj) {
      if (!ws || ws.readyState !== 1) return false;
      if (obj && typeof obj === 'object' && obj.type === 'request_state') { requestState(); return true; }
      try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (e) { return false; }
    },
  };
  function retry() {
    var wait = retryMs + Math.round(Math.random() * 300);
    retryMs = Math.min(5000, Math.round(retryMs * 1.6));
    setTimeout(connect, wait);
  }
  function connect() {
    var go = function () {
      var sock;
      try { sock = ws = new WebSocket('ws://' + host + ':3001' + (token ? ('?token=' + encodeURIComponent(token)) : '')); }
      catch (e) { return retry(); }
      var opened = false;
      sock.onopen = function () {
        opened = true; retryMs = 1000;
        try { sock.send(JSON.stringify({ type: 'register', role: 'overlay', page: location.pathname })); } catch (e) {}
        requestState();
        fanout('open');
      };
      sock.onmessage = function (e) { fanout('message', e.data); };
      sock.onclose = function () { if (ws === sock) ws = null; if (!opened) token = null; retry(); };
      sock.onerror = function () { try { sock.close(); } catch (e) {} };
    };
    if (token !== null) return go();
    // Token (needed when the bridge is LAN-exposed), with a deadline so a stalled app can't stall us.
    var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ac ? setTimeout(function () { ac.abort(); }, 4000) : null;
    fetch('http://' + host + ':3000/api/ws-token', ac ? { signal: ac.signal } : undefined)
      .then(function (r) { return r.json(); })
      .then(function (j) { token = (j && j.token) || ''; }, function () { token = ''; })
      .then(function () { if (t) clearTimeout(t); go(); });
  }
  connect();
})();
