/* NE Broadcast Suite — walkthroughs.
 *
 * Two parts:
 *  - The hub: a library of short chapters (Quick start, then one per page / area), with saved
 *    progress, "resume at step N", and a "tour this page" shortcut. Opened from the ? button in
 *    the top bar, Settings ▸ Getting Started, and the Dashboard banner.
 *  - The coach-mark engine: dims the app, spotlights one control, and explains it in a card that
 *    points at it.
 *
 * Content lives in tour-steps.js (window.NETourChapters). The engine:
 *  - navigates with the app's OWN entry points (_pdShow, _talentShowPage, _intShowTab, qrailShowTab,
 *    openSettings…) rather than guessing at clicks, then WAITS for the target to render instead of
 *    sleeping a fixed 150ms;
 *  - skips a step whose target isn't on screen (feature off, integration not connected) rather than
 *    floating a card over nothing;
 *  - blocks the app while a card is up (clicks AND keyboard, so a producer's scene hotkeys can't fire
 *    mid-tour), except on "try it" steps, where only the highlighted control is live;
 *  - puts the producer back where they were (page, rail tab, Settings) when they leave early.
 * No dependencies; vanilla DOM. */
(function () {
  'use strict';

  var CHAPTERS = window.NETourChapters || [];
  var LS_PROGRESS = 'ne_tour_v2';
  var LS_BANNER = 'ne_tour_banner_dismissed';
  var LS_LEGACY_DONE = 'ne_tour_done';
  var SECONDS_PER_STEP = 15;

  // ── Progress ────────────────────────────────────────────────────────────────
  // { done: { chapterId: true }, at: { chapterId: stepIndex } }
  function loadProgress() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem(LS_PROGRESS) || 'null'); } catch (_) {}
    var out = { done: (p && p.done) || {}, at: (p && p.at) || {} };
    // Someone who finished the old single tour has seen the basics.
    try { if (!p && localStorage.getItem(LS_LEGACY_DONE)) out.done.quick = true; } catch (_) {}
    return out;
  }
  var progress = loadProgress();
  function saveProgress() { try { localStorage.setItem(LS_PROGRESS, JSON.stringify(progress)); } catch (_) {} }

  function chapterById(id) {
    for (var i = 0; i < CHAPTERS.length; i++) if (CHAPTERS[i].id === id) return CHAPTERS[i];
    return null;
  }
  // The next chapter in order that isn't done yet (falls back to the next one in order).
  function nextChapter(ch) {
    var i = CHAPTERS.indexOf(ch);
    for (var j = i + 1; j < CHAPTERS.length; j++) if (!progress.done[CHAPTERS[j].id]) return CHAPTERS[j];
    return CHAPTERS[i + 1] || null;
  }
  function activeTab() {
    var b = document.querySelector('.sidebar-nav .tab-btn.active');
    return b ? b.dataset.tab : null;
  }
  function chapterForPage(tab) {
    if (!tab) return null;
    for (var i = 0; i < CHAPTERS.length; i++) if (CHAPTERS[i].page === tab) return CHAPTERS[i];
    return null;
  }
  function minutes(ch) { return Math.max(1, Math.round(ch.steps.length * SECONDS_PER_STEP / 60)); }

  // ── Small DOM helpers ───────────────────────────────────────────────────────
  function mk(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // First element matching the selector (comma lists allowed) that is actually on screen.
  function findVisible(sel) {
    var list;
    try { list = document.querySelectorAll(sel); } catch (_) { return null; }
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.closest('[hidden]')) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      var cs = window.getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      return n;
    }
    return null;
  }
  function waitFor(find, ms, cb) {
    var deadline = Date.now() + ms;
    (function tick() {
      var n = null;
      try { n = find(); } catch (_) {}
      if (n || Date.now() >= deadline) { cb(n); return; }
      setTimeout(tick, 40);
    })();
  }

  // ── Navigation: the app's own entry points ─────────────────────────────────
  function goTab(tab) {
    var b = document.querySelector('.tab-btn[data-tab="' + tab + '"]');
    if (b && !b.classList.contains('active')) { b.click(); return true; }
    return false;
  }
  function call(fn, arg) {
    if (typeof window[fn] === 'function') { try { window[fn](arg); } catch (e) { console.warn('[tour] ' + fn + ' failed', e); } }
  }
  function clickSel(sel) { var b = document.querySelector(sel); if (b) b.click(); }
  function settingsModal() { return document.getElementById('tab-ajustes-content'); }
  function settingsOpen() { var m = settingsModal(); return !!(m && m.classList.contains('open')); }
  function closeSettings() {
    if (!settingsOpen()) return;
    if (typeof window.closeSettingsModal === 'function') window.closeSettingsModal();
    else clickSel('#btn-settings-close');
  }

  // Returns true when it had to move somewhere (the target needs longer to appear).
  function applyNav(nav) {
    nav = nav || {};
    // Settings is a modal over everything — open exactly when a step lives in it.
    if (nav.settings) { if (typeof window.openSettings === 'function') window.openSettings(nav.settings); return true; }
    closeSettings();
    var moved = false;
    if (nav.tab) moved = goTab(nav.tab) || moved;
    if (nav.prod) { moved = goTab('produccion') || moved; call('_pdShow', nav.prod); moved = true; }
    if (nav.talent) { moved = goTab('equipos') || moved; call('_talentShowPage', nav.talent); moved = true; }
    if (nav.teams) clickSel('[data-teamstab="' + nav.teams + '"]');
    if (nav.ev) { moved = goTab('events') || moved; clickSel('#ev-subnav [data-evtab="' + nav.ev + '"]'); moved = true; }
    if (nav.assets) { moved = goTab('media') || moved; call('_assetsShow', nav.assets); moved = true; }
    if (nav.stats) { moved = goTab('stats') || moved; clickSel('#stats-subnav [data-stab="' + nav.stats + '"]'); moved = true; }
    if (nav.integ) { moved = goTab('integrations') || moved; call('_intShowTab', nav.integ); moved = true; }
    // An integration card is the app's real way into one app's settings (it narrows shared panels).
    if (nav.card) { goTab('integrations'); call('_intShowTab', 'store'); clickSel('#int-store-grid .int-card[data-card="' + nav.card + '"]'); moved = true; }
    // qrailShowTab always OPENS — clicking a rail tab would toggle an open one shut.
    if (nav.rail) { call('qrailShowTab', nav.rail); moved = true; }
    return moved;
  }

  // ── Engine state ────────────────────────────────────────────────────────────
  var S = {
    active: false, ch: null, idx: 0, dir: 1, token: 0, target: null, step: null,
    snap: null, openedDrawer: false, trackUntil: 0, raf: 0, poll: 0, ro: null, clickH: null
  };
  var root, hl, cover, shades, tip, T = {};

  function ensureDom() {
    if (root) return;
    root = mk('div', 'tour-root');
    root.setAttribute('aria-hidden', 'true');
    shades = ['top', 'right', 'bottom', 'left'].map(function (side) {
      var s = mk('div', 'tour-shade tour-shade-' + side); root.appendChild(s); return s;
    });
    cover = mk('div', 'tour-cover');
    hl = mk('div', 'tour-hl');
    tip = mk('div', 'tour-tip',
      '<div class="tour-tip-arrow"></div>' +
      '<div class="tour-tip-head">' +
        '<span class="tour-tip-chapter"></span>' +
        '<span class="tour-tip-count"></span>' +
        '<button type="button" class="tour-x" aria-label="Close walkthrough" title="Close (Esc)">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="tour-tip-progress"><span></span></div>' +
      '<h3 class="tour-tip-title" id="tour-tip-title"></h3>' +
      '<p class="tour-tip-body" id="tour-tip-body"></p>' +
      '<div class="tour-tip-hint"><span class="tour-tip-hint-dot"></span><span class="tour-tip-hint-txt"></span></div>' +
      '<button type="button" class="tour-tip-continue"></button>' +
      '<div class="tour-tip-foot">' +
        '<button type="button" class="tour-btn tour-link tour-all">All walkthroughs</button>' +
        '<div class="tour-tip-nav">' +
          '<button type="button" class="tour-btn tour-back">Back</button>' +
          '<button type="button" class="tour-btn tour-primary tour-next">Next</button>' +
        '</div>' +
      '</div>');
    tip.setAttribute('role', 'dialog');
    tip.setAttribute('aria-modal', 'true');
    tip.setAttribute('aria-labelledby', 'tour-tip-title');
    tip.setAttribute('aria-describedby', 'tour-tip-body');
    root.appendChild(cover);
    root.appendChild(hl);
    root.appendChild(tip);
    document.body.appendChild(root);

    T.arrow = tip.querySelector('.tour-tip-arrow');
    T.chapter = tip.querySelector('.tour-tip-chapter');
    T.count = tip.querySelector('.tour-tip-count');
    T.bar = tip.querySelector('.tour-tip-progress > span');
    T.title = tip.querySelector('.tour-tip-title');
    T.body = tip.querySelector('.tour-tip-body');
    T.hint = tip.querySelector('.tour-tip-hint');
    T.hintTxt = tip.querySelector('.tour-tip-hint-txt');
    T.cont = tip.querySelector('.tour-tip-continue');
    T.back = tip.querySelector('.tour-back');
    T.next = tip.querySelector('.tour-next');

    tip.querySelector('.tour-x').addEventListener('click', function () { exit(); });
    tip.querySelector('.tour-all').addEventListener('click', function () { exit(); openHub(); });
    T.back.addEventListener('click', back);
    T.next.addEventListener('click', next);
    T.cont.addEventListener('click', function () {
      var n = nextChapter(S.ch);
      if (n) continueTo(n);
    });
    // Clicking the dimmed app does nothing — but say so, rather than feeling broken.
    shades.concat([cover]).forEach(function (s) {
      s.addEventListener('mousedown', function (e) { e.preventDefault(); nudge(); });
    });
    window.addEventListener('resize', schedulePlace);
    window.addEventListener('scroll', schedulePlace, true);
  }

  function nudge() {
    tip.classList.remove('is-nudge');
    void tip.offsetWidth;   // restart the animation
    tip.classList.add('is-nudge');
  }

  // ── Starting / stopping ─────────────────────────────────────────────────────
  // What to put back if the producer leaves early.
  function snapshot() {
    var railBtn = document.querySelector('.qrail-tab.active[data-qtab]');
    var savedCat = null;
    try { savedCat = localStorage.getItem('ne_settings_cat'); } catch (_) {}
    S.snap = {
      tab: activeTab(),
      rail: railBtn ? railBtn.dataset.qtab : null,
      railCollapsed: !!document.querySelector('.app-shell.qrail-collapsed'),
      settings: settingsOpen(),
      settingsCat: savedCat,
      focus: document.activeElement
    };
  }

  function start(id, fromIdx) {
    var ch = chapterById(id) || CHAPTERS[0];
    if (!ch || !ch.steps || !ch.steps.length) return;
    closeHub();
    ensureDom();
    if (!S.active) snapshot();
    S.active = true;
    S.ch = ch;
    S.step = null;
    dismissBanner();
    root.classList.add('show');
    root.removeAttribute('aria-hidden');
    document.body.classList.add('tour-active');
    var i = (typeof fromIdx === 'number' && fromIdx > 0 && fromIdx < ch.steps.length) ? fromIdx : 0;
    go(i, 1);
  }

  function continueTo(ch) {
    markDone(S.ch);
    S.ch = ch;
    S.step = null;
    go(0, 1);
  }

  function markDone(ch) {
    progress.done[ch.id] = true;
    delete progress.at[ch.id];
    saveProgress();
    if (ch.id === 'quick') { try { localStorage.setItem(LS_LEGACY_DONE, '1'); } catch (_) {} }
  }

  function finish() {
    // Every step was skipped (nothing on screen): don't claim the chapter was seen.
    if (!S.step) { console.warn('[tour] ' + S.ch.id + ': no step could be shown'); teardown(true); return; }
    var last = S.ch.steps[S.ch.steps.length - 1];
    markDone(S.ch);
    // "stay" steps end on something to do next (install the OBS scenes, customize the dashboard):
    // leave the producer on it. Everything else goes back to where they started.
    teardown(!(S.step === last && last.stay));
  }

  function exit() { teardown(true); }

  function teardown(restore) {
    if (!S.active) return;
    S.active = false;
    S.token++;
    stopTracking();
    detachClick();
    root.classList.remove('show', 'is-try', 'is-center', 'is-busy');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('tour-active');
    if (S.openedDrawer) { document.body.classList.remove('nav-open'); S.openedDrawer = false; }
    var snap = S.snap || {};
    if (restore) {
      if (snap.settings) {
        if (typeof window.openSettings === 'function') window.openSettings(snap.settingsCat || 'general');
      } else {
        closeSettings();
      }
      if (snap.tab && snap.tab !== 'ajustes') goTab(snap.tab);
      if (snap.rail && typeof window.qrailShowTab === 'function') window.qrailShowTab(snap.rail);
      if (snap.railCollapsed && !document.querySelector('.app-shell.qrail-collapsed')) clickSel('#qrail-collapse');
    }
    if (snap.focus && snap.focus.focus && document.contains(snap.focus)) { try { snap.focus.focus({ preventScroll: true }); } catch (_) {} }
    S.snap = null;
    S.target = null;
    S.step = null;
  }

  // ── Stepping ────────────────────────────────────────────────────────────────
  function next() {
    if (!S.active) return;
    if (S.idx >= S.ch.steps.length - 1) finish();
    else go(S.idx + 1, 1);
  }
  function back() {
    if (!S.active || S.idx <= 0) return;
    go(S.idx - 1, -1);
  }

  function go(i, dir) {
    var steps = S.ch.steps;
    if (i >= steps.length) { finish(); return; }
    if (i < 0) { i = 0; dir = 1; }
    S.idx = i;
    S.dir = dir || 1;
    var token = ++S.token;
    var step = steps[i];
    detachClick();
    progress.at[S.ch.id] = i;
    saveProgress();
    root.classList.add('is-busy');

    var moved = applyNav(step.nav);
    if (!step.target) { render(step, null); return; }
    waitFor(function () { return findVisible(step.target); }, moved ? 2200 : 700, function (t) {
      if (token !== S.token || !S.active) return;
      if (t) { render(step, t); return; }
      if (!step.optional) console.warn('[tour] ' + S.ch.id + ' step ' + (i + 1) + ': nothing visible for ' + step.target + ', skipped');
      // Skip in the direction of travel. Backing past the start turns around.
      var n = i + (S.dir < 0 ? -1 : 1);
      if (n < 0) { S.dir = 1; n = i + 1; }
      go(n, S.dir);
    });
  }

  function render(step, t) {
    var steps = S.ch.steps, i = S.idx, isLast = i === steps.length - 1;
    S.step = step;
    S.target = t;

    T.chapter.textContent = S.ch.title;
    T.count.textContent = (i + 1) + ' of ' + steps.length;
    T.bar.style.width = Math.round(((i + 1) / steps.length) * 100) + '%';
    T.title.textContent = step.title || '';
    T.body.textContent = step.body || '';
    T.back.style.visibility = i === 0 ? 'hidden' : '';
    T.next.textContent = isLast ? 'Finish' : (step.action ? 'Skip' : 'Next');
    T.next.classList.toggle('tour-primary', !step.action || isLast);

    var up = isLast ? nextChapter(S.ch) : null;
    T.cont.style.display = up ? '' : 'none';
    if (up) T.cont.innerHTML = 'Continue with <strong>' + esc(up.title) + '</strong><span aria-hidden="true">&#8250;</span>';

    var trying = !!(step.action && t);
    T.hint.style.display = trying ? '' : 'none';
    T.hintTxt.textContent = step.hint || 'Click the highlighted control.';
    root.classList.toggle('is-try', trying);
    root.classList.toggle('is-center', !t);
    if (trying) attachClick(t, S.token);

    // The mobile nav is an off-canvas drawer: open it for sidebar targets, close it otherwise.
    var inSidebar = !!(t && t.closest && t.closest('#sidebar'));
    if (inSidebar && !document.body.classList.contains('nav-open') && window.matchMedia('(max-width: 900px)').matches) {
      document.body.classList.add('nav-open'); S.openedDrawer = true;
    } else if (!inSidebar && S.openedDrawer) {
      document.body.classList.remove('nav-open'); S.openedDrawer = false;
    }

    if (t && t.scrollIntoView) {
      try { t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
      // A target taller than the view is better shown from its top.
      var r = t.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) { try { t.scrollIntoView({ block: 'center' }); } catch (_) {} }
    }
    startTracking(t);
    root.classList.remove('is-busy');
    place();
    try { T.next.focus({ preventScroll: true }); } catch (_) {}
  }

  // "Try it" steps: the producer clicks the real control; the tour follows.
  function attachClick(t, token) {
    S.clickH = function (e) {
      if (!S.active || token !== S.token) return;
      if (t.contains(e.target)) setTimeout(function () { if (S.active && token === S.token) next(); }, 220);
    };
    document.addEventListener('click', S.clickH, true);
  }
  function detachClick() {
    if (S.clickH) document.removeEventListener('click', S.clickH, true);
    S.clickH = null;
  }

  // ── Keeping the spotlight on its target ─────────────────────────────────────
  // Live state re-renders panels constantly, and pages settle after a tab switch, so follow the
  // target for a moment after each step, then fall back to a slow poll + resize/scroll events.
  function startTracking(t) {
    stopTracking();
    S.trackUntil = Date.now() + 900;
    (function frame() {
      place();
      if (Date.now() < S.trackUntil) S.raf = requestAnimationFrame(frame);
    })();
    S.poll = setInterval(place, 400);
    if (t && typeof ResizeObserver === 'function') {
      S.ro = new ResizeObserver(schedulePlace);
      S.ro.observe(t);
      S.ro.observe(tip);
    }
  }
  function stopTracking() {
    if (S.raf) cancelAnimationFrame(S.raf);
    if (S.poll) clearInterval(S.poll);
    if (S.ro) S.ro.disconnect();
    S.raf = 0; S.poll = 0; S.ro = null;
  }
  var placeQueued = false;
  function schedulePlace() {
    if (!S.active || placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(function () { placeQueued = false; place(); });
  }

  function place() {
    if (!S.active || !S.step) return;
    var t = S.target;
    // The panel re-rendered and replaced our node: find its successor.
    if (t && !document.contains(t) && S.step.target) {
      t = S.target = findVisible(S.step.target);
      if (t && S.step.action) { detachClick(); attachClick(t, S.token); }
    }
    var vw = window.innerWidth, vh = window.innerHeight;
    if (!t) {
      // Centered card: the spotlight collapses to a point so its shadow dims everything.
      setBox(hl, vw / 2, vh / 2, 0, 0);
      setBox(shades[0], 0, 0, vw, vh);
      setBox(shades[1], 0, 0, 0, 0); setBox(shades[2], 0, 0, 0, 0); setBox(shades[3], 0, 0, 0, 0);
      setBox(cover, 0, 0, 0, 0);
      centerTip(vw, vh);
      return;
    }
    var r = t.getBoundingClientRect(), pad = 6, m = 4;
    var x1 = Math.max(m, r.left - pad), y1 = Math.max(m, r.top - pad);
    var x2 = Math.min(vw - m, r.right + pad), y2 = Math.min(vh - m, r.bottom + pad);
    if (x2 < x1) x2 = x1;
    if (y2 < y1) y2 = y1;
    setBox(hl, x1, y1, x2 - x1, y2 - y1);
    setBox(shades[0], 0, 0, vw, y1);                 // top
    setBox(shades[2], 0, y2, vw, vh - y2);           // bottom
    setBox(shades[3], 0, y1, x1, y2 - y1);           // left
    setBox(shades[1], x2, y1, vw - x2, y2 - y1);     // right
    setBox(cover, x1, y1, x2 - x1, y2 - y1);         // blocks the hole unless it's a "try it" step
    positionTip({ left: x1, top: y1, right: x2, bottom: y2, width: x2 - x1, height: y2 - y1 }, S.step.placement);
  }
  function setBox(n, x, y, w, h) {
    n.style.left = x + 'px'; n.style.top = y + 'px';
    n.style.width = Math.max(0, w) + 'px'; n.style.height = Math.max(0, h) + 'px';
  }
  function centerTip(vw, vh) {
    tip.dataset.side = 'center';
    tip.style.left = Math.max(12, (vw - tip.offsetWidth) / 2) + 'px';
    tip.style.top = Math.max(12, (vh - tip.offsetHeight) / 2) + 'px';
  }

  function positionTip(r, pref) {
    var tw = tip.offsetWidth, th = tip.offsetHeight, gap = 14, m = 12;
    var vw = window.innerWidth, vh = window.innerHeight, left, top, side;

    // Phones: dock the card to whichever edge the target isn't on.
    if (vw < 640) {
      side = 'dock';
      left = m;
      top = (r.bottom > vh - th - m - 8 && r.top > th + m * 2) ? m : vh - th - m;
      tip.dataset.side = side;
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
      return;
    }
    var fits = {
      right: r.right + gap + tw <= vw - m,
      left: r.left - gap - tw >= m,
      bottom: r.bottom + gap + th <= vh - m,
      top: r.top - gap - th >= m
    };
    var order = [pref, 'bottom', 'right', 'top', 'left'];
    for (var k = 0; k < order.length; k++) { if (order[k] && fits[order[k]]) { side = order[k]; break; } }

    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (side === 'right' || side === 'left') {
      left = side === 'right' ? r.right + gap : r.left - gap - tw;
      top = clamp(cy - th / 2, m, vh - th - m);
      T.arrow.style.top = clamp(cy - top, 18, th - 18) + 'px';
      T.arrow.style.left = '';
    } else if (side === 'bottom' || side === 'top') {
      top = side === 'bottom' ? r.bottom + gap : r.top - gap - th;
      left = clamp(cx - tw / 2, m, vw - tw - m);
      T.arrow.style.left = clamp(cx - left, 18, tw - 18) + 'px';
      T.arrow.style.top = '';
    } else {
      // The target fills the screen: sit in the bottom-right corner, over it.
      side = 'inside';
      left = vw - tw - m - 8;
      top = vh - th - m - 8;
    }
    tip.dataset.side = side;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── Keyboard ────────────────────────────────────────────────────────────────
  // Capture phase on window, so it runs before the app's own shortcuts. While the tour or the hub
  // is up, keys never reach the app — a stray number key must not cut a scene mid-tour.
  function onKey(e) {
    if (hubEl && hubEl.classList.contains('show')) {
      if (e.key === 'Escape') { e.preventDefault(); closeHub(); }
      else if (e.key === 'Tab') trapFocus(e, hubEl);
      e.stopPropagation();
      return;
    }
    if (!S.active) return;
    var t = e.target;
    var inTarget = !!(S.step && S.step.action && S.target && S.target.contains(t));
    var onButton = tip.contains(t) && t.tagName === 'BUTTON';
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exit(); return; }
    if (inTarget) return;   // "try it": the live control keeps its keyboard
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.key === 'Enter' && !onButton) { e.preventDefault(); next(); }
    else if (e.key === 'Tab') trapFocus(e, tip);
    e.stopPropagation();
  }
  function trapFocus(e, box) {
    var f = Array.prototype.filter.call(box.querySelectorAll('button, [href], input, select'), function (n) {
      return !n.disabled && n.offsetParent !== null && n.style.visibility !== 'hidden';
    });
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1];
    if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  window.addEventListener('keydown', onKey, true);

  // ── The hub ─────────────────────────────────────────────────────────────────
  var hubEl = null, hubFocus = null, resetArmed = 0;
  var ICON_DONE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function ensureHub() {
    if (hubEl) return;
    hubEl = mk('div', 'tourhub',
      '<div class="tourhub-box" role="dialog" aria-modal="true" aria-labelledby="tourhub-title">' +
        '<div class="tourhub-head">' +
          '<div class="tourhub-headtxt">' +
            '<h2 id="tourhub-title">Walkthroughs</h2>' +
            '<p>Short guided tours that run over the app. Your progress is saved, so you can stop at any time and pick up where you left off.</p>' +
          '</div>' +
          '<button type="button" class="tourhub-x" aria-label="Close">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="tourhub-meter"><div class="tourhub-meter-bar"><span></span></div><span class="tourhub-meter-txt"></span></div>' +
        '<div class="tourhub-featured"></div>' +
        '<div class="tourhub-sub">All chapters</div>' +
        '<div class="tourhub-grid"></div>' +
        '<div class="tourhub-foot">' +
          '<span class="tourhub-keys">Arrow keys move between steps. Esc closes a walkthrough.</span>' +
          '<button type="button" class="tour-btn tour-link tourhub-reset">Reset progress</button>' +
        '</div>' +
      '</div>');
    document.body.appendChild(hubEl);
    hubEl.addEventListener('mousedown', function (e) { if (e.target === hubEl) closeHub(); });
    hubEl.querySelector('.tourhub-x').addEventListener('click', closeHub);
    hubEl.addEventListener('click', function (e) {
      var c = e.target.closest('[data-tour-ch]');
      if (!c) return;
      var ch = chapterById(c.dataset.tourCh);
      if (!ch) return;
      var resumeAt = (!progress.done[ch.id] && typeof progress.at[ch.id] === 'number') ? progress.at[ch.id] : 0;
      start(ch.id, resumeAt);
    });
    var reset = hubEl.querySelector('.tourhub-reset');
    reset.addEventListener('click', function () {
      // Two clicks: the first arms it, so a stray click can't wipe progress.
      if (Date.now() - resetArmed > 4000) {
        resetArmed = Date.now();
        reset.textContent = 'Click again to reset';
        setTimeout(function () { if (Date.now() - resetArmed >= 4000) reset.textContent = 'Reset progress'; }, 4100);
        return;
      }
      resetArmed = 0;
      progress = { done: {}, at: {} };
      saveProgress();
      try { localStorage.removeItem(LS_LEGACY_DONE); } catch (_) {}
      reset.textContent = 'Reset progress';
      renderHub();
    });
  }

  function chapterState(ch) {
    if (progress.done[ch.id]) return 'done';
    if (typeof progress.at[ch.id] === 'number' && progress.at[ch.id] > 0) return 'progress';
    return 'new';
  }
  function actionLabel(ch) {
    var st = chapterState(ch);
    if (st === 'done') return 'Replay';
    if (st === 'progress') return 'Resume at step ' + (progress.at[ch.id] + 1);
    return 'Start';
  }
  function cardHtml(ch, extraCls, kicker) {
    var st = chapterState(ch);
    return '<button type="button" class="tourhub-card ' + (extraCls || '') + ' is-' + st + '" data-tour-ch="' + esc(ch.id) + '">' +
      (kicker ? '<span class="tourhub-kicker">' + esc(kicker) + '</span>' : '') +
      '<span class="tourhub-card-top">' +
        '<span class="tourhub-state" aria-hidden="true">' + (st === 'done' ? ICON_DONE : '') + '</span>' +
        '<span class="tourhub-card-title">' + esc(ch.title) + '</span>' +
      '</span>' +
      '<span class="tourhub-card-sum">' + esc(ch.summary || '') + '</span>' +
      '<span class="tourhub-card-meta">' +
        '<span>' + ch.steps.length + ' steps &middot; about ' + minutes(ch) + ' min</span>' +
        '<span class="tourhub-card-go">' + esc(actionLabel(ch)) + '</span>' +
      '</span>' +
    '</button>';
  }

  function renderHub() {
    var done = CHAPTERS.filter(function (c) { return progress.done[c.id]; }).length;
    hubEl.querySelector('.tourhub-meter-bar > span').style.width = (CHAPTERS.length ? Math.round(done / CHAPTERS.length * 100) : 0) + '%';
    hubEl.querySelector('.tourhub-meter-txt').textContent = done + ' of ' + CHAPTERS.length + ' complete';

    // Featured: Quick start until it's done, and the page the producer is looking at right now.
    var quick = chapterById('quick');
    var here = chapterForPage(settingsOpen() ? 'ajustes' : activeTab());
    var feat = '';
    if (quick && !progress.done.quick) feat += cardHtml(quick, 'is-featured', 'Start here');
    if (here) feat += cardHtml(here, 'is-featured', 'This page');
    if (quick && progress.done.quick && !here) feat += cardHtml(quick, 'is-featured', 'The basics');
    hubEl.querySelector('.tourhub-featured').innerHTML = feat;

    hubEl.querySelector('.tourhub-grid').innerHTML = CHAPTERS.map(function (c) { return cardHtml(c); }).join('');
  }

  function openHub() {
    if (S.active) exit();
    ensureHub();
    renderHub();
    hubFocus = document.activeElement;
    hubEl.classList.add('show');
    dismissBanner();
    var first = hubEl.querySelector('.tourhub-card');
    try { (first || hubEl.querySelector('.tourhub-x')).focus({ preventScroll: true }); } catch (_) {}
  }
  function closeHub() {
    if (!hubEl || !hubEl.classList.contains('show')) return;
    hubEl.classList.remove('show');
    if (hubFocus && hubFocus.focus && document.contains(hubFocus)) { try { hubFocus.focus({ preventScroll: true }); } catch (_) {} }
    hubFocus = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  function reset() { progress = { done: {}, at: {} }; saveProgress(); }
  window.NETour = { open: openHub, start: start, close: function () { closeHub(); exit(); }, reset: reset, chapters: CHAPTERS };
  // Back-compat: NEStartTour('essentials') was the first-run path; NEStartTour(id) starts a chapter;
  // NEStartTour() opens the library.
  window.NEStartTour = function (mode) {
    if (mode === 'essentials') start('quick');
    else if (mode && chapterById(mode)) start(mode);
    else openHub();
  };

  // ── Entry points ────────────────────────────────────────────────────────────
  function dismissBanner() {
    try { localStorage.setItem(LS_BANNER, '1'); } catch (_) {}
    var b = document.getElementById('dash-tour-cta'); if (b) b.style.display = 'none';
  }

  function init() {
    var on = function (id, fn) { var n = document.getElementById(id); if (n) n.addEventListener('click', fn); };
    on('btn-tour-help', function () { openHub(); });
    on('btn-start-tour', function () { openHub(); });
    on('btn-start-quick', function () { start('quick'); });
    on('dash-tour-cta-go', function () { start('quick'); });
    on('dash-tour-cta-browse', function () { openHub(); });
    on('dash-tour-cta-x', function () { dismissBanner(); });

    var banner = document.getElementById('dash-tour-cta');
    if (banner) {
      var dismissed = false;
      try { dismissed = !!localStorage.getItem(LS_BANNER); } catch (_) {}
      banner.style.display = dismissed ? 'none' : '';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
