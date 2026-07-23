/* fgc-bridge.js — transport shim for the ported FGCasterOverlay templates.
 *
 * The upstream FGCasterOverlay (github.com/LolJohn11/FGCasterOverlay, MIT) drives its
 * templates over socket.io: the template's inline script calls `io()` and registers an
 * `update_scoreboard` handler that does ALL the rendering. Our suite has no socket.io
 * server — overlays get their data from the :3001 WS bridge via scene-base.js.
 *
 * Rather than rewrite each template's render logic, we keep it verbatim and only replace
 * the pipe underneath it. This file must load BEFORE the template's inline <script> (it
 * takes the slot the socket.io CDN tag used to occupy) so that when the template calls
 * `io()` it gets our stub instead of the real client.
 *
 *   window.io(...)           → returns a fake socket whose .on() records handlers
 *   window.__fgcEmit(evt,d)  → fgc-adapter.js calls this to fan our mapped state out to
 *                              every registered handler (i.e. the template's renderer)
 *
 * Any handler error is caught so one bad frame can't wedge the overlay.
 */
(function () {
  'use strict';
  var handlers = Object.create(null);

  function on(evt, cb) {
    if (typeof cb !== 'function') return fakeSocket;
    (handlers[evt] || (handlers[evt] = [])).push(cb);
    return fakeSocket;
  }

  var fakeSocket = {
    on: on,
    off: function () { return fakeSocket; },
    emit: function () { return fakeSocket; },   // template never emits, but keep it safe
    connect: function () { return fakeSocket; },
    disconnect: function () { return fakeSocket; },
    get connected() { return true; }
  };

  // The template calls io({...opts}) — options are irrelevant, we just hand back the stub.
  window.io = function () { return fakeSocket; };

  // Dispatch a mapped payload to every handler registered for `evt`.
  window.__fgcEmit = function (evt, data) {
    var list = handlers[evt];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); }
      catch (e) { console.error('[fgc-bridge] handler for "' + evt + '" threw:', e); }
    }
  };

  // Let the adapter know a fresh connection just fired (some templates gate on 'connect').
  window.__fgcConnect = function () { window.__fgcEmit('connect'); };
})();
