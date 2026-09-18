/* ─── nav-simplify.js — progressive disclosure for sub-navs ──────────────────
   The sidebar used to hide Assets / Analytics / Video Editor / Roles behind a "More" / "Show fewer"
   toggle; that was removed (2026-09-17) — every top-level page is always listed. What remains is the
   same idea one level down: less-used sub-tabs sit behind a "More" chip. window.NENavShowAll()
   expands them all in one call. */
(function () {
  'use strict';

  // ── Sub-nav density ────────────────────────────────────────────────────────
  // The sub-tabs are where density compounds — the league editor alone opens onto nine.
  //
  // Two constraints learned the hard way from the markup:
  //  1. Hide with a CLASS, never style.display. #lg2-tab-ballchasing already carries its own
  //     display:none (Rocket League only); clearing that inline style would reveal a tab that is
  //     supposed to stay hidden for every other game.
  //  2. The "More" chip must NOT carry the nav's item class. #lg2-tabs delegates on its container
  //     (e.target.closest('.lg2-tab')), so a chip with that class would call lgSwitchTab(undefined)
  //     and blank the panel. Other sub-navs bind per-button at load, so a chip added afterwards is
  //     inert there — but the chip also stops propagation, which covers both styles.
  var SUBNAVS = [
    // key      container        item class        data-attr  collapse these
    // The league editor no longer collapses tabs: it was cut to eight (Power rankings moved inside
    // Standings, Tournaments/Ballchasing only show when they apply) and the tab row wraps, so a
    // 'More' chip would only hide things. Add an entry here for any future sub-nav that needs it.
  ];

  function subKey(k) { return 'ne_subnav_' + k; }
  function subSimplified(k) {
    var v = null;
    try { v = localStorage.getItem(subKey(k)); } catch (_) {}
    if (v === '1') return true;
    if (v === '0') return false;
    return true;
  }

  function applySub(cfg) {
    var key = cfg[0], sel = cfg[1], itemCls = cfg[2], attr = cfg[3], adv = cfg[4];
    var nav = document.querySelector(sel);
    if (!nav) return;
    var on = subSimplified(key);
    var hidden = 0;
    adv.forEach(function (t) {
      var btn = nav.querySelector('.' + itemCls + '[data-' + attr + '="' + t + '"]');
      if (!btn) return;
      // Never collapse the tab currently open, and never touch a tab something else has hidden.
      var isActive = btn.classList.contains('active');
      var hide = on && !isActive;
      btn.classList.toggle('subnav-collapsed', hide);
      if (hide && btn.style.display !== 'none') hidden++;
    });
    var chip = nav.querySelector('.subnav-more');
    if (chip) {
      chip.textContent = on ? 'More' + (hidden ? ' (' + hidden + ')' : '') : 'Less';
      chip.title = on ? 'Show the remaining tabs' : 'Collapse the less-used tabs';
      chip.setAttribute('aria-expanded', on ? 'false' : 'true');
      chip.style.display = (on && !hidden) ? 'none' : '';   // nothing left to reveal -> no chip
    }
  }

  function initSub(cfg) {
    var key = cfg[0], sel = cfg[1];
    var nav = document.querySelector(sel);
    if (!nav || nav.querySelector('.subnav-more')) return;
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'subnav-more';       // deliberately NOT the nav's item class (see note above)
    chip.textContent = 'More';
    nav.appendChild(chip);
    chip.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();                // container-delegated navs must not see this as a tab click
      try { localStorage.setItem(subKey(key), subSimplified(key) ? '0' : '1'); } catch (_) {}
      applySub(cfg);
    });
    // The active tab changes as the producer moves around; re-evaluate so the open tab is never
    // the one being hidden.
    nav.addEventListener('click', function () { setTimeout(function () { applySub(cfg); }, 0); });
    applySub(cfg);
  }

  function initSubnavs() { SUBNAVS.forEach(initSub); }

  // Sub-navs live inside pages that may not be built when this runs (the league editor is populated
  // on first render), so retry briefly rather than assuming they exist at DOMContentLoaded.
  function initSubnavsWhenReady() {
    var tries = 0;
    (function attempt() {
      initSubnavs();
      if (++tries < 20 && SUBNAVS.some(function (c) { return !document.querySelector(c[1] + ' .subnav-more'); })) {
        setTimeout(attempt, 400);
      }
    })();
  }

  // Expose for the tour / settings, so "show me everything" is always one call away.
  window.NENavShowAll = function () {
    SUBNAVS.forEach(function (c) { try { localStorage.setItem(subKey(c[0]), '0'); } catch (_) {} applySub(c); });
  };

  function boot() { initSubnavsWhenReady(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
