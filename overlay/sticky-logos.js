/* sticky-logos.js — remote-overlay bandwidth optimizer (injected into every served overlay page).
 *
 * The live full_state broadcast carries base64 logos (teams, standings, ad backgrounds, player
 * photos) that rarely change but ride every broadcast — ~180KB of the ~280KB payload, up to 25×/s.
 * For overlays loaded over a network (http://<host>:3000) that is real bandwidth.
 *
 * This patches window.WebSocket so that, transparently to the overlay's own code:
 *   1) on connect to the :3001 bridge it announces `imgvault_ready` — the server then replaces
 *      already-seen images with a short "@img:<hash>" reference instead of resending the bytes;
 *   2) every incoming frame is scanned: real `data:image…` strings are cached by content hash, and
 *      "@img:<hash>" references are swapped back to the cached image before the overlay ever sees it.
 *
 * Fully graceful: any parse/patch error passes the original frame through untouched, and a cache
 * miss simply leaves the reference in place (the overlay falls back to its default logo). The server
 * only ever sends compact refs to clients that opted in, so a page WITHOUT this script is unaffected.
 */
(function () {
  'use strict';
  var Native = window.WebSocket;
  if (!Native) return;

  var cache = Object.create(null);   // contentHash -> full "data:image…" string

  // djb2 + length — MUST match server _imgHash() exactly so refs resolve.
  function imgHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '.' + s.length;
  }

  function walk(n) {
    if (n === null || n === undefined) return n;
    var t = typeof n;
    if (t === 'string') {
      if (n.length >= 1024 && n.lastIndexOf('data:image', 0) === 0) { cache[imgHash(n)] = n; return n; }
      if (n.lastIndexOf('@img:', 0) === 0) { var v = cache[n.slice(5)]; return v === undefined ? n : v; }
      return n;
    }
    if (t !== 'object') return n;
    if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) n[i] = walk(n[i]); return n; }
    for (var k in n) { if (Object.prototype.hasOwnProperty.call(n, k)) n[k] = walk(n[k]); }
    return n;
  }

  // Return a message event whose .data has images restored. If nothing needs restoring we cache any
  // real images (to seed for later refs) and hand back the ORIGINAL event (no wasteful re-stringify).
  function fix(ev) {
    var d = ev && ev.data;
    if (typeof d !== 'string') return ev;
    var hasRef = d.indexOf('@img:') >= 0;
    var hasReal = d.indexOf('data:image') >= 0;
    if (!hasRef && !hasReal) return ev;
    try {
      var m = JSON.parse(d);
      walk(m);
      if (!hasRef) return ev;                 // only real images present → cache seeded, pass original
      var s = JSON.stringify(m);
      return { data: s, origin: ev.origin, lastEventId: ev.lastEventId, source: ev.source,
               ports: ev.ports, type: ev.type, target: ev.target, currentTarget: ev.currentTarget };
    } catch (e) { return ev; }
  }

  function Patched(url, protocols) {
    var ws = (protocols === undefined) ? new Native(url) : new Native(url, protocols);

    // Only the bridge understands imgvault; announce capability once open.
    try {
      if (/:3001(\/|\?|$)/.test(String(url))) {
        ws.addEventListener('open', function () { try { ws.send(JSON.stringify({ type: 'imgvault_ready' })); } catch (e) {} });
      }
    } catch (e) {}

    var userOn = null;
    var nativeAdd = Native.prototype.addEventListener.bind(ws);
    var nativeRemove = Native.prototype.removeEventListener.bind(ws);

    // Drive `ws.onmessage = fn` through one native listener that restores images first.
    nativeAdd('message', function (ev) { if (userOn) userOn.call(ws, fix(ev)); });
    try {
      Object.defineProperty(ws, 'onmessage', {
        configurable: true, enumerable: true,
        get: function () { return userOn; },
        set: function (fn) { userOn = (typeof fn === 'function') ? fn : null; }
      });
    } catch (e) {}

    // Wrap addEventListener('message', …) so listener-style overlays are restored too.
    ws.addEventListener = function (type, listener, opts) {
      if (type === 'message' && typeof listener === 'function') {
        var wrapped = function (ev) { return listener.call(ws, fix(ev)); };
        listener.__slWrapped = wrapped;
        return nativeAdd('message', wrapped, opts);
      }
      return nativeAdd(type, listener, opts);
    };
    ws.removeEventListener = function (type, listener, opts) {
      if (type === 'message' && listener && listener.__slWrapped) return nativeRemove('message', listener.__slWrapped, opts);
      return nativeRemove(type, listener, opts);
    };

    return ws;
  }
  Patched.prototype = Native.prototype;
  Patched.CONNECTING = Native.CONNECTING; Patched.OPEN = Native.OPEN;
  Patched.CLOSING = Native.CLOSING; Patched.CLOSED = Native.CLOSED;

  try { window.WebSocket = Patched; } catch (e) {}
})();
