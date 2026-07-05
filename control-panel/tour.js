/* NE Broadcast Suite — guided app walkthrough for new users.
 * Self-contained coach-mark tour: dims the app, spotlights an element, and shows a tooltip that
 * explains the feature. Steps can switch sidebar pages (and show sub-nav bars) so the tour actually
 * navigates the app and teaches the key features on each page.
 * Launch with window.NEStartTour() — wired to the Settings button and the Dashboard CTA banner.
 * No dependencies; vanilla DOM. */
(function () {
  'use strict';

  // target = CSS selector to spotlight (null = centered intro/outro card)
  // tab    = sidebar page to switch to first (data-tab value)
  // run    = optional fn to run after the page switches, before measuring (e.g. open a sub-tab)
  // placement = preferred tooltip side ('right' hugs the sidebar; else auto below/above)
  var STEPS = [
    { title: 'Welcome to NE Broadcast Suite',
      body: "This tour walks you through the whole app — the sidebar pages, the sub-tabs inside them, the quick-actions rail, and the key features you'll use to run a broadcast. Use Next and Back to move, or Skip to leave. You can replay it anytime from Settings." },
    { target: '.sidebar-nav', placement: 'right', title: 'The left sidebar — your pages',
      body: "Everything lives here. The top group (Live) are the pages you run a show from; the lower group (System) are setup and tools. Let's walk through each one and what's inside it." },
    { target: '#qrail', tab: 'principal', title: 'The right rail — quick actions',
      body: 'This rail is on every page. Its icons open quick panels: scene cuts, the rundown, the start.gg queue, overlay toggles, graphic triggers, automation flows, talent cams, NEURAL AI, notes and Twitch chat — so you never have to leave the page you’re on to run the show. Drag its edge to resize it.' },

    // ── Dashboard: the most-used page, so cover its key widgets ──
    { target: '#tab-principal', tab: 'principal', placement: 'right', title: 'Dashboard — your live cockpit',
      body: 'This is where you actually run the broadcast. It’s a customizable grid of widgets — let’s look at the important ones.' },
    { target: '[data-dash-id="event"]', tab: 'principal', title: 'Event & tournament',
      body: 'Name your broadcast, then connect a tournament with the platform tabs (start.gg, Challonge or NXGEN) to auto-pull teams, brackets and the live match.' },
    { target: '[data-dash-id="teams"]', tab: 'principal', title: 'Match — Teams & score',
      body: 'Set the two teams, their logos, colors, series score and rosters. This drives the scoreboard and every team-aware overlay.' },
    { target: '[data-dash-id="obs"]', tab: 'principal', title: 'OBS & going live',
      body: 'Connect OBS here, then cut between your scenes and go live. The app follows OBS so overlays and automation stay in sync with what’s on air.' },
    { target: '#dash-customize-btn', tab: 'principal', title: 'Make it yours',
      body: 'Click Customize to rearrange widgets, change columns, or add/remove cards — build the cockpit that fits how you produce.' },

    // ── Production + its 6 sub-tabs ──
    { target: '#tab-produccion', tab: 'produccion', placement: 'right', title: 'Production — build your show',
      body: 'Everything you cut to during a broadcast lives here, split across a row of sub-tabs.' },
    { target: '#pd-subnav', tab: 'produccion', title: 'Production sub-tabs',
      body: 'Deck (your Stream-Deck button grid) · Graphics (overlay graphics) · Rundown (run of show) · Flows (automation) · Hotkeys · NEURAL AI (the director). Click any tab to switch panels — let’s look at the two you’ll use most.' },
    { target: '#prod-graphics-board', tab: 'produccion', run: function () { if (window._pdShow) window._pdShow('graphics'); }, title: 'Production ▸ Graphics',
      body: 'The Graphics panel is where you build and stage on-screen elements — lower thirds, stat cards, standings, matchups, sponsor plates and more. Configure each, preview it, then push it live to the overlay (or stage it and fire it from a trigger or flow).' },
    { target: '#flows-section', tab: 'produccion', run: function () { if (window._pdShow) window._pdShow('flows'); }, title: 'Production ▸ Flows',
      body: 'Flows are automations — a chain of actions (scene cuts, overlays, timers, commercials) you fire with one click or a hotkey. Build your show’s repeatable moments here: going live, starting-soon, ad breaks, back-from-break and match transitions, so one button runs the whole sequence.' },

    // ── Talent + role sub-tabs ──
    { target: '#tab-equipos', tab: 'equipos', placement: 'right', title: 'Talent — teams & on-air crew',
      body: 'Manage everyone in front of and behind the camera. It’s organized by role across the sub-tabs.' },
    { target: '#tab-equipos-content .ev-subnav, #tab-equipos-content .cf-subnav', tab: 'equipos', title: 'Talent sub-tabs',
      body: 'Teams · Player Rooms · Casters · Observers · Guests. Set up each person’s VDO camera room, the caster desk lineup, and the Director Control Center for moving people between rooms live.' },

    // ── ESPORTS + its sub-tabs ──
    { target: '#tab-events', tab: 'events', placement: 'right', title: 'ESPORTS — tournaments & leagues',
      body: 'Connect brackets and manage the competitive side of your event.' },
    { target: '#ev-subnav', tab: 'events', title: 'ESPORTS sub-tabs',
      body: 'Tournaments · Leagues · My Events · Seeding · Spotlight. Pull a bracket, seed players by rank, mark teams to watch, and auto-follow the live match onto your scoreboard.' },

    // ── Video Editor ──
    { target: '#tab-replays', tab: 'replays', placement: 'right', title: 'Video Editor — replays & clips',
      body: 'Capture replays from the OBS buffer, trim clips, and build montages & playlists (commercials, intros, outros).' },
    { target: '#rp-to-program', tab: 'replays', title: 'Push replays live to OBS',
      body: 'Once a replay or playlist is ready, hit “To Air” to push it straight to your OBS Program output — it switches to your chosen scene, plays with audio, and can auto-return when it finishes. “Preview” cues it to the preview bus first, without going live.' },

    // ── Assets + sub-tabs ──
    { target: '#tab-media', tab: 'media', placement: 'right', title: 'Assets — media, overlays & profiles',
      body: 'Your media library, the live overlay/scene editor, and your client brand profiles.' },
    { target: '#assets-subnav', tab: 'media', title: 'Assets sub-tabs',
      body: 'Three sub-tabs — Assets (your media library: logos, backgrounds, sponsor art), Overlays (edit scene HTML with live previews), and Profiles (client brand kits — a logo, colors and sponsor set that recolor every overlay at once, so you can rebrand the whole show in one click).' },

    // ── Analytics + sub-tabs ──
    { target: '#tab-stats', tab: 'stats', placement: 'right', title: 'Analytics — measure the show',
      body: 'Data on every broadcast, plus your player/team database and printable reports.' },
    { target: '#stats-subnav', tab: 'stats', title: 'Analytics sub-tabs',
      body: 'Overview · Broadcasts · Audience · Event · Players · Teams · Proof of Play. Track viewers, engagement, tournament ops and per-sponsor on-screen exposure.' },

    // ── Top-bar utilities (the account / notifications cluster) ──
    { target: '.topbar-right', title: 'Top bar — account & utilities',
      body: 'Up here: the notifications bell, an OBS Program preview, and the account menu (the gear/avatar) — which is where you’ll find Report a Bug, Feature Request, Roles & Teams, and Settings.' },

    // ── Settings & Integrations ──
    { target: '#tab-ajustes', tab: 'ajustes', placement: 'right', title: 'Settings — preferences',
      body: 'App preferences, per-game overlays, keyboard shortcuts, software updates — and Getting Started, where you can replay this walkthrough anytime.' },
    { target: '#tab-integrations', tab: 'integrations', placement: 'right', title: 'Integrations — connect accounts',
      body: 'Link Twitch, YouTube, OBS, start.gg, Challonge and more. Set your API keys and tokens here first — the rest of the app builds on these connections.' },

    // ── Finale: the single best first setup step ──
    { target: '#btn-obs-download-collection', tab: 'integrations', placement: 'auto', title: 'Set up OBS in one click',
      body: 'Best first move: here in Integrations ▸ OBS, click “Save Scene Collection” to install a ready-made OBS scene collection — 30 scenes plus caster/host cam framing, all pre-wired to these overlays. Import it in OBS and you’re broadcast-ready. Replay this tour anytime from Settings ▸ Getting Started.' }
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
    setTimeout(function () {
      if (typeof step.run === 'function') { try { step.run(); } catch (_) {} }
      paint(step);
    }, step.tab ? 150 : 0);
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
    dismissBanner();   // engaging with the tour retires the Dashboard CTA
    overlay.classList.add('show');
    go(0);
  }

  function end(done) {
    active = false;
    if (overlay) overlay.classList.remove('show');
    // On finish, leave the user on the last step's page (Integrations ▸ OBS scene collection) so the
    // suggested first action is right in front of them — don't yank them back to the Dashboard.
    if (done) { try { localStorage.setItem('ne_tour_done', '1'); } catch (_) {} }
  }

  window.NEStartTour = start;

  // ── Dashboard CTA banner: invite new users to the tour; the ✕ retires it for good ──
  function dismissBanner() {
    try { localStorage.setItem('ne_tour_banner_dismissed', '1'); } catch (_) {}
    var b = document.getElementById('dash-tour-cta'); if (b) b.style.display = 'none';
  }

  function init() {
    var settingsBtn = document.getElementById('btn-start-tour');
    if (settingsBtn) settingsBtn.addEventListener('click', function () { start(); });

    var banner = document.getElementById('dash-tour-cta');
    if (banner) {
      var dismissed = false;
      try { dismissed = !!localStorage.getItem('ne_tour_banner_dismissed'); } catch (_) {}
      banner.style.display = dismissed ? 'none' : '';
      var goBtn = document.getElementById('dash-tour-cta-go');
      var xBtn = document.getElementById('dash-tour-cta-x');
      if (goBtn) goBtn.addEventListener('click', function () { start(); });
      if (xBtn) xBtn.addEventListener('click', function () { dismissBanner(); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
