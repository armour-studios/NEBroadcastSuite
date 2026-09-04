/* ─── nav-simplify.js — progressive disclosure for the sidebar ────────────────
   The control panel exposes 13 top-level pages, 84 sub-tabs and ~2,000 controls. That density is
   correct for a producer mid-season and actively hostile to someone opening the app for the first
   time, who has no way to tell which five pages matter.

   So the sidebar starts with the pages you need to run a show and everything else sits behind one
   "More" click. Nothing is removed, the chip shows how many are hidden, the page you are currently
   on is never hidden, and an explicit choice is remembered forever. window.NENavShowAll() restores
   the lot in one call. */
(function () {
  'use strict';

  var KEY = 'ne_nav_simple';
  // Pages a first-run user does not need in order to get a show on air. All reachable in one click
  // via More, and every one of them is still reachable from deep links elsewhere in the app.
  var ADVANCED = ['media', 'stats', 'replays', 'roles'];

  // Collapsed is the DEFAULT for everyone, not just new installs. The five pages behind More are
  // library and reporting surfaces (media, analytics, social, video editor, crew roles) — none is
  // needed to get a show on air, and all are one click away with a visible count on the chip.
  // An explicit choice always wins and is remembered forever.
  function simplified() {
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (_) {}
    if (v === '1') return true;
    if (v === '0') return false;
    return true;
  }
  function setSimplified(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (_) {}
    apply();
  }

  var toggleBtn = null, toggleLabel = null;

  function apply() {
    var nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    var on = simplified();
    var hiddenCount = 0;
    ADVANCED.forEach(function (tab) {
      var btn = nav.querySelector('.nav-item[data-tab="' + tab + '"]');
      if (!btn) return;
      // Never hide the page the producer is actually on — that reads as the app losing their place.
      var isActive = btn.classList.contains('active');
      var hide = on && !isActive;
      btn.style.display = hide ? 'none' : '';
      if (hide) hiddenCount++;
    });
    // The "System" group label would sit alone if everything under it were hidden; it isn't
    // (Integrations + Settings stay), so no special handling needed there.
    if (toggleLabel) {
      toggleLabel.textContent = on ? 'More (' + hiddenCount + ')' : 'Show fewer';
      toggleBtn.title = on
        ? 'Show the remaining pages: media library, analytics, video editor and crew roles'
        : 'Collapse back to the pages needed to run a show';
      toggleBtn.setAttribute('aria-expanded', on ? 'false' : 'true');
    }
  }

  function init() {
    var nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'nav-item nav-more-toggle';
    toggleBtn.id = 'nav-more-toggle';
    toggleBtn.innerHTML = '<span class="nav-ico" aria-hidden="true">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
      + '</svg></span><span class="nav-label">More</span>';
    nav.appendChild(toggleBtn);
    toggleLabel = toggleBtn.querySelector('.nav-label');
    toggleBtn.addEventListener('click', function () { setSimplified(!simplified()); });
    // Switching to a hidden page (via a deep link elsewhere) must reveal it rather than leave the
    // user on a page with no nav entry.
    nav.addEventListener('click', function () { setTimeout(apply, 0); });
    apply();
  }


  // ── Sub-nav density ────────────────────────────────────────────────────────
  // Same idea one level down. The sidebar fix only reached the top level; the 84 sub-tabs are where
  // density actually compounds — the league editor alone opens onto nine.
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
    ['lg2',    '#lg2-tabs',     'lg2-tab',        'tab',     ['rankings', 'stats', 'settings']],
    ['int',    '#int-subnav',   'ev-subnav-btn',  'inttab',  ['cameras', 'games', 'tournaments', 'developers']]
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
    setSimplified(false);
    SUBNAVS.forEach(function (c) { try { localStorage.setItem(subKey(c[0]), '0'); } catch (_) {} applySub(c); });
  };

  function boot() { init(); initSubnavsWhenReady(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
