/* scene-bg.js — per-scene background fill (injected into every served overlay page).
 *
 * The Scenes page offers a "Background fill" (colour + opacity %) on EVERY scene card, so a
 * producer can drop a solid wash behind any graphic to make it readable over busy gameplay.
 * That control used to be wired only inside scene-base.js — which 19 overlays never load
 * (index/rl-hud/live/valorant/lol-hud/apex/pulse/upcoming/stream-credits/ministation/…). On all
 * of those the toggle appeared to work, saved fine, and did nothing on air.
 *
 * Injecting this alongside sticky-logos.js makes the fill universal with zero per-overlay edits,
 * and any overlay added later gets it for free.
 *
 * Two independent inputs, both supported:
 *   1) URL params  ?bg=RRGGBB&bgop=0-100   — baked into a copied browser-source URL.
 *   2) Live state  full_state.sceneBg[<pathname>] — the panel's colour/opacity controls, applied
 *      without re-copying the URL. An explicit {on:false} REMOVES a URL-param wash; a missing
 *      entry means "the server was never told about this scene", which leaves the URL param alone.
 *
 * Live updates ride the existing bridge socket rather than opening a second one: we wrap
 * window.WebSocket and attach a PASSIVE message listener. Loading after sticky-logos.js means our
 * wrapper sits outside its wrapper, so frames we observe are already image-restored, and we never
 * touch onmessage/addEventListener semantics the overlay depends on.
 */
(function (global) {
  'use strict';

  var EL_ID = 'scene-bg-wash';

  function clamp01(n) { return Math.min(1, Math.max(0, n)); }

  function ensureEl() {
    var el = document.getElementById(EL_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = EL_ID;
    // Behind every scene's own content but above the page canvas, and never clickable.
    el.style.cssText = 'position:fixed;inset:0;z-index:-9999;pointer-events:none;';
    var mount = function () {
      var p = document.body || document.documentElement;
      if (p && !document.getElementById(EL_ID)) p.insertBefore(el, p.firstChild);
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
    return el;
  }

  function remove() {
    var el = document.getElementById(EL_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /** Apply a { on, color, op } entry. Falsy / {on:false} clears the wash. */
  function apply(bg) {
    if (!bg || !bg.on) { remove(); return; }
    var hex = String(bg.color || '#000000').replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3,8}$/.test(hex)) hex = '000000';
    var op = Number(bg.op);
    if (!isFinite(op) || op <= 0) op = 50;
    var el = ensureEl();
    el.style.background = '#' + hex;
    el.style.opacity = clamp01(op / 100);
  }

  // ── 1) URL params ──────────────────────────────────────────────────────────
  (function fromUrl() {
    try {
      var q = new URLSearchParams(global.location.search);
      var bg = q.get('bg');
      var op = parseFloat(q.get('bgop'));
      if (bg && op > 0) apply({ on: true, color: bg, op: op });
    } catch (e) {}
  })();

  // ── 2) Live state ──────────────────────────────────────────────────────────
  // The panel keys sceneBg by the scene's path as listed on the Scenes page ('/countdown.html',
  // '/' for the main overlay). Accept the obvious equivalents so a browser source added as
  // /index.html — or with different casing — still matches what the producer configured.
  function candidateKeys() {
    var p = String(global.location.pathname || '/');
    var keys = [p, p.toLowerCase()];
    if (/^\/index\.html$/i.test(p)) keys.push('/');
    if (p === '/') keys.push('/index.html');
    return keys;
  }

  function fromState(state) {
    if (!state || !state.sceneBg) return;
    var map = state.sceneBg;
    var keys = candidateKeys();
    for (var i = 0; i < keys.length; i++) {
      var entry = map[keys[i]];
      // undefined = server has no opinion on this scene → leave any URL-param wash in place.
      if (entry !== undefined) { apply(entry); return; }
    }
  }

  var Native = global.WebSocket;
  if (Native) {
    var Patched = function (url, protocols) {
      var ws = (protocols === undefined) ? new Native(url) : new Native(url, protocols);
      try {
        if (/:3001(\/|\?|$)/.test(String(url))) {
          // Passive observer only — we never consume, rewrite or block the frame.
          ws.addEventListener('message', function (ev) {
            try {
              if (typeof ev.data !== 'string' || ev.data.indexOf('sceneBg') < 0) return;
              var msg = JSON.parse(ev.data);
              if (msg && msg.type === 'full_state') fromState(msg.data);
            } catch (e) {}
          });
        }
      } catch (e) {}
      return ws;
    };
    Patched.prototype = Native.prototype;
    Patched.CONNECTING = Native.CONNECTING; Patched.OPEN = Native.OPEN;
    Patched.CLOSING = Native.CLOSING; Patched.CLOSED = Native.CLOSED;
    try { global.WebSocket = Patched; } catch (e) {}
  }

  global.SceneBg = { apply: apply, fromState: fromState, remove: remove };
})(window);
