/* NE Broadcast Suite — guided app walkthrough for new users.
 * Self-contained coach-mark tour: dims the app, spotlights an element, and shows a tooltip that
 * explains the feature. Steps can switch sidebar pages so the tour actually navigates the app.
 * Launch with window.NEStartTour() (Settings button) or the one-time first-run auto-offer.
 * No dependencies; vanilla DOM. */
(function () {
  'use strict';

  // target = CSS selector to spotlight (null = centered intro/outro card)
  // tab = sidebar page to switch to first (data-tab value)
  // placement = preferred tooltip side ('right' hugs the sidebar; else auto below/above)
  var STEPS = [
    { title: 'Welcome to NE Broadcast Suite',
      body: "This quick tour walks you through the app — every page in the sidebar and what it's for. Use Next and Back to move through it, or Skip to leave. You can replay it anytime from Settings." },
    { target: '.sidebar-nav', placement: 'right', title: 'The sidebar is your map',
      body: "Everything lives here. The top group (Live) are the pages you run a show from; the lower group (System) are setup and tools. Let's look at each one." },
    { target: '#tab-principal', tab: 'principal', placement: 'right', title: 'Dashboard — your live cockpit',
      body: 'Set the match, teams, colors and score, trigger overlays, and go live. This is where you actually run the broadcast from.' },
    { target: '#tab-produccion', tab: 'produccion', placement: 'right', title: 'Production — build your show',
      body: 'A customizable Stream-Deck grid plus Graphics, Rundown, Flows (automation) and Hotkeys. Everything you cut to during a broadcast is set up here.' },
    { target: '#tab-equipos', tab: 'equipos', placement: 'right', title: 'Talent — teams & on-air crew',
      body: 'Manage teams, casters, hosts and observers: their VDO camera rooms, the caster desk lineup, and the Director Control Center for moving people between rooms.' },
    { target: '#tab-events', tab: 'events', placement: 'right', title: 'ESPORTS — tournaments & leagues',
      body: 'Connect start.gg or Challonge, pull in brackets, seed players, mark teams to watch, and auto-follow the live match onto your scoreboard.' },
    { target: '#tab-replays', tab: 'replays', placement: 'right', title: 'Video Editor — replays & clips',
      body: 'Capture replays from OBS, trim clips, build montages, and play them out to your Program feed.' },
    { target: '#tab-media', tab: 'media', placement: 'right', title: 'Assets — media & overlays',
      body: 'Your media library plus the live overlay/scene editor — logos, backgrounds, sponsor art, and scene previews.' },
    { target: '#tab-stats', tab: 'stats', placement: 'right', title: 'Analytics — measure the show',
      body: 'Broadcast, audience, tournament and sponsor analytics, a player/team database, and printable proof-of-play reports.' },
    { target: '#tab-integrations', tab: 'integrations', placement: 'right', title: 'Integrations — connect accounts',
      body: 'Link Twitch, YouTube, OBS, start.gg, Challonge and more. Set your API keys and tokens here first so the rest of the app can talk to them.' },
    { target: '#tab-ajustes', tab: 'ajustes', placement: 'right', title: 'Settings — preferences',
      body: 'App preferences, per-game overlays, keyboard shortcuts and updates — plus the button to replay this walkthrough whenever you want.' },
    { target: '#btn-start-tour', tab: 'ajustes', placement: 'auto', title: 'Replay this anytime',
      body: "That's the tour! This button — Settings ▸ Getting Started ▸ Start walkthrough — brings it back whenever you need a refresher. A good first move: open Integrations to connect your accounts, then set up your first match on the Dashboard." }
  ];

  var overlay, hl, tip, elStep, elTitle, elBody, btnBack, btnNext, curIdx = 0, active = false;

  function mk(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function ensureDom() {
    if (overlay) return;
    overlay = mk('div', 'tour-overlay');
    hl = mk('div', 'tour-hl');
    tip = mk('div', 'tour-tip');
    tip.innerHTML =
      '<div class="tour-tip-step"></div>' +
      '<h3 class="tour-tip-title"></h3>' +
      '<p class="tour-tip-body"></p>' +
      '<div class="tour-tip-bar">' +
        '<button type="button" class="tour-btn tour-skip">Skip tour</button>' +
        '<div class="tour-tip-nav">' +
          '<button type="button" class="tour-btn tour-back">Back</button>' +
          '<button type="button" class="tour-btn tour-next">Next</button>' +
        '</div>' +
      '</div>';
    overlay.appendChild(hl);
    overlay.appendChild(tip);
    document.body.appendChild(overlay);
    elStep = tip.querySelector('.tour-tip-step');
    elTitle = tip.querySelector('.tour-tip-title');
    elBody = tip.querySelector('.tour-tip-body');
    btnBack = tip.querySelector('.tour-back');
    btnNext = tip.querySelector('.tour-next');
    tip.querySelector('.tour-skip').addEventListener('click', function () { end(false); });
    btnBack.addEventListener('click', function () { go(curIdx - 1); });
    btnNext.addEventListener('click', function () { if (curIdx >= STEPS.length - 1) end(true); else go(curIdx + 1); });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); end(false); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (curIdx < STEPS.length - 1) go(curIdx + 1); else end(true); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(curIdx - 1); }
  }

  function targetOf(step) { return step && step.target ? document.querySelector(step.target) : null; }

  function go(i) {
    curIdx = Math.max(0, Math.min(STEPS.length - 1, i));
    var step = STEPS[curIdx];
    if (step.tab) {
      var btn = document.querySelector('.tab-btn[data-tab="' + step.tab + '"]');
      if (btn && !btn.classList.contains('active')) btn.click();
    }
    // let the page (re)render before measuring the target
    setTimeout(function () { paint(step); }, step.tab ? 140 : 0);
  }

  function paint(step) {
    elStep.textContent = (curIdx + 1) + ' / ' + STEPS.length;
    elTitle.textContent = step.title || '';
    elBody.textContent = step.body || '';
    btnBack.style.visibility = curIdx === 0 ? 'hidden' : '';
    btnNext.textContent = curIdx >= STEPS.length - 1 ? 'Done' : 'Next';
    var t = targetOf(step);
    if (t && t.scrollIntoView) { try { t.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {} }
    requestAnimationFrame(function () { place(step, t); });
  }

  function place(step, t) {
    if (t) {
      var r = t.getBoundingClientRect(), pad = 6;
      hl.style.display = '';
      hl.style.left = (r.left - pad) + 'px';
      hl.style.top = (r.top - pad) + 'px';
      hl.style.width = (r.width + pad * 2) + 'px';
      hl.style.height = (r.height + pad * 2) + 'px';
      positionTip(r, step.placement);
    } else {
      hl.style.display = 'none';
      tip.style.transform = 'translate(-50%,-50%)';
      tip.style.left = '50%';
      tip.style.top = '50%';
    }
  }

  function positionTip(r, placement) {
    tip.style.transform = 'none';
    var tw = tip.offsetWidth, th = tip.offsetHeight, gap = 14;
    var vw = window.innerWidth, vh = window.innerHeight, left, top;
    if (placement === 'right' && r.right + gap + tw < vw) { left = r.right + gap; top = r.top; }
    else if (r.bottom + gap + th < vh) { left = r.left; top = r.bottom + gap; }
    else if (r.top - gap - th > 0) { left = r.left; top = r.top - gap - th; }
    else if (r.right + gap + tw < vw) { left = r.right + gap; top = r.top; }
    else { left = r.left - gap - tw; top = r.top; }
    left = Math.max(12, Math.min(left, vw - tw - 12));
    top = Math.max(12, Math.min(top, vh - th - 12));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function reposition() { if (active) place(STEPS[curIdx], targetOf(STEPS[curIdx])); }

  function start() {
    ensureDom();
    active = true;
    try { localStorage.setItem('ne_tour_seen', '1'); } catch (_) {}
    overlay.classList.add('show');
    go(0);
  }

  function end(done) {
    active = false;
    if (overlay) overlay.classList.remove('show');
    try { localStorage.setItem('ne_tour_seen', '1'); if (done) localStorage.setItem('ne_tour_done', '1'); } catch (_) {}
    if (done) { var db = document.querySelector('.tab-btn[data-tab="principal"]'); if (db) db.click(); }
  }

  window.NEStartTour = start;

  function init() {
    var b = document.getElementById('btn-start-tour');
    if (b) b.addEventListener('click', function () { start(); });
    // First-run auto-offer, exactly once (guarded by ne_tour_seen so it never nags).
    try {
      if (!localStorage.getItem('ne_tour_seen')) {
        setTimeout(function () { if (!localStorage.getItem('ne_tour_seen')) start(); }, 1600);
      }
    } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
