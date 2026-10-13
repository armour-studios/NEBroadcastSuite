/* ─── sticky-fit.js — pinned side lists that always fit the screen ─────────────────────────────
   Pages with a list pinned beside their editor (Graphics' picker, the Event page's event list) gave it
   a fixed max-height guess (100vh - N). At the top of the page the list starts lower than the guess
   assumes, so its last items hung below the bottom bar until the whole page was scrolled. Here each
   pinned list is sized to the space it actually has: from where it sits now to the bottom of the
   page's scroll area, recomputed on scroll and resize. It scrolls inside itself; nothing is ever
   off screen. A list that is not pinned (narrow layouts stack it) is left alone. */
(function () {
  'use strict';
  var SELECTORS = ['.gfx-sidenav', '.sev-side'];
  var GAP = 12;
  var queued = false;
  function scroller(el) {
    var p = el.parentElement;
    while (p && p !== document.body) {
      var oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll') return p;
      p = p.parentElement;
    }
    return null;
  }
  function fit() {
    queued = false;
    SELECTORS.forEach(function (sel) {
      [].forEach.call(document.querySelectorAll(sel), function (el) {
        if (!el.offsetParent) return;                                  // hidden page
        if (getComputedStyle(el).position !== 'sticky') { if (el.style.maxHeight) el.style.removeProperty('max-height'); return; }
        var sc = scroller(el);
        var head = 0;
        // Pin it just below any pinned header of the same scroll area (the Modern page title bar),
        // or its top slid under that header while the page scrolled.
        if (sc) {
          [].forEach.call(sc.children, function (c) {
            if (c.contains(el) || !c.getClientRects().length) return;
            var cs = getComputedStyle(c);
            if (cs.position === 'sticky' && (parseFloat(cs.top) || 0) === 0) head = Math.max(head, c.offsetHeight);
          });
          var want = (head + GAP) + 'px';
          if (el.style.top !== want) el.style.setProperty('top', want, 'important');
        }
        var r = el.getBoundingClientRect();
        var bottom = sc ? sc.getBoundingClientRect().bottom : window.innerHeight;
        // The fixed bottom bar (Go live / Record) overlays the page's scroll area: stop above it.
        var bar = document.getElementById('bottom-bar');
        if (bar && bar.getClientRects().length && getComputedStyle(bar).position === 'fixed')   // (offsetParent is always null for a fixed element)
          bottom = Math.min(bottom, bar.getBoundingClientRect().top);
        // Where it sits when pinned: below the scroll area's top and any pinned header.
        var top = sc ? Math.max(r.top, sc.getBoundingClientRect().top + head + GAP) : Math.max(r.top, 0);
        var h = Math.max(240, Math.floor(bottom - top - GAP));
        if (el.style.maxHeight !== h + 'px') el.style.setProperty('max-height', h + 'px', 'important');   // beats the stylesheet's fallback guess
      });
    });
  }
  function queue() { if (!queued) { queued = true; requestAnimationFrame(fit); } }
  // Scroll events do not bubble, but they do reach a capturing listener on the document.
  document.addEventListener('scroll', queue, true);
  window.addEventListener('resize', queue);
  // Page switches, the dock opening and content loading all move things: a cheap periodic check.
  setInterval(queue, 700);
  window.__stickyFit = queue;
})();
