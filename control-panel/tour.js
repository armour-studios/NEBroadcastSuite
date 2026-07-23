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
    // ── Orientation ──
    { title: 'Welcome to NE Broadcast Suite',
      body: "This tour walks the whole app — every sidebar page, the sub-tabs inside them, the top bar and the quick-actions rail. It's thorough: about five minutes if you read everything. Use Next / Back (or the arrow keys), or Skip to leave. Replay it anytime from Settings ▸ Getting Started." },
    { target: '.sidebar-nav', placement: 'right', title: 'The left sidebar — your pages',
      body: "Everything lives here. The top group is where you run a show — Dashboard, Production, Talent, Cameras, ESPORTS, Video Editor. Below are setup and tools — Assets, Analytics, Integrations, Settings. We'll visit every one." },
    { target: '#qrail', tab: 'principal', title: 'The right rail — quick actions',
      body: "This rail rides along on every page. Its icon tabs open quick panels: QUICK (scene cuts + put-on-air), Rundown, the start.gg queue, overlay toggles, Flows, Replay, Talent cams, NEURAL AI, Notes, Stream info and Twitch chat — so you never leave the page you're on to run the show. Drag its edge to resize it." },
    { target: '#qk-put', tab: 'principal',
      run: function () { var t = document.querySelector('.qrail-tab[data-qtab="quick"]'); if (t) t.click(); },
      title: 'Put-on-air chips',
      body: "Each chip puts one graphic on air — click it to fire, click again to clear. Chips with a gear take options first (team, player, countdown length): the gear opens a small setup panel; press the same gear again or click away to close it." },

    // ── Dashboard ──
    { target: '#tab-principal', tab: 'principal', placement: 'right', title: 'Dashboard — your live cockpit',
      body: "Where you actually run the broadcast: a customizable grid of widgets. Let's look at the important ones." },
    { target: '[data-dash-id="event"]', tab: 'principal', title: 'Event & tournament',
      body: "Name your broadcast, then link a tournament (start.gg, Challonge or NXGEN). The ACTIVE event drives everything downstream — the bracket, standings, the stream queue and the scores ticker all follow it automatically." },
    { target: '[data-dash-id="teams"]', tab: 'principal', title: 'Match — teams & score',
      body: "Set the two teams, logos, colors, series score and rosters. This drives the scoreboard and every team-aware overlay — the lineup card, matchup, winner screen. The gear opens match settings: series format, team records, scene automation." },
    { target: '[data-dash-id="deck"]', tab: 'principal', title: 'Cutting scenes & going live',
      body: "The Deck widget cuts your mapped scenes right from the dashboard, with preview and hotkeys. Connect your switcher first — Integrations ▸ Video Switcher, OBS or vMix (pick one, they're a clean either/or) — then this grid drives it live and stays in sync with whatever's actually on air." },
    { target: '#dcc-showdeck-home', tab: 'principal', title: 'Show Deck — your on-air talent',
      body: "The Director Control Center's home tab: who's on camera right now. Put hosts and casters on deck, watch their cams, and swap the on-air lineup live." },
    { target: '#dash-customize-btn', tab: 'principal', title: 'Make it yours',
      body: "Click Customize to rearrange widgets, change columns, or add/remove cards — build the cockpit that fits how you produce." },

    // ── Top bar ──
    { target: '#ck-chip-program', title: 'PROGRAM — what viewers see',
      body: "The live OBS program scene, always visible. If a graphic is pushed but this scene doesn't show overlays, your viewers aren't seeing it — this chip is the single source of truth for what's on air." },
    { target: '#prod-timer', title: 'Countdown timer',
      body: "The producer segment timer — it drives the countdown overlay. The small arrow opens the full panel (set the time, headline, what happens at zero); pop it out to a second monitor if you like. If you have an Elgato Stream Deck, the plugin's Countdown keys drive and display this same timer." },
    { target: '#btn-bb-clip', title: 'Clip — instant highlights',
      body: "Saves the OBS replay buffer AND creates a Twitch clip in one press. The dot shows readiness: green = buffer + Twitch both live. If the replay buffer is off, the button becomes 'Start Replay Buffer' — press it and clips are ready to capture." },
    { target: '#tb-ad-area', title: 'Twitch ads — manual only',
      body: "Ad controls live here: allow/deny ads, pick a length, play one now, or snooze the next. Ads NEVER fire automatically — a commercial only runs when you press the button." },
    { target: '.topbar-right', title: 'Utilities',
      body: "The notifications bell, an OBS program preview, bug reporting (files straight to the devs), and Settings." },

    // ── Production ──
    { target: '#tab-produccion', tab: 'produccion', placement: 'right', title: 'Production — build your show',
      body: "Everything you cut to during a broadcast, split across a row of sub-tabs: Deck, Graphics, Rundown, Flows, Hotkeys and NEURAL AI. We'll walk each one." },
    { target: '.deck-layout', tab: 'produccion', run: function () { if (window._pdShow) window._pdShow('deck'); },
      title: 'Production ▸ Deck',
      body: "Your on-screen button grid for scene cuts, graphics and flows — each button restylable and hotkey-able. Click Edit to add, reorder or recolor. And if you own an Elgato Stream Deck, the same actions live on physical keys — we'll see that in Integrations." },
    { target: '#prod-graphics-board', tab: 'produccion', run: function () { if (window._pdShow) window._pdShow('graphics'); },
      title: 'Production ▸ Graphics',
      body: "Every overlay graphic as a card — lower thirds, standings, bracket, matchup, desk topics, sponsor plates. Edit content right on the card, then Push Live. The bracket card is a mini control center: pick the phase and pool, search for a team, switch views." },
    { target: '#rundown-section', tab: 'produccion', run: function () { if (window._pdShow) window._pdShow('rundown'); },
      title: 'Production ▸ Rundown',
      body: "Your run of show: segments in order — scene cuts, graphics, countdowns, playlists, flows — organized under section headers, with per-segment hold times that auto-advance. Run it from the rail's Rundown tab, or from Stream Deck keys that always show the current and next segment by name." },
    { target: '#flows-section', tab: 'produccion', run: function () { if (window._pdShow) window._pdShow('flows'); },
      title: 'Production ▸ Flows',
      body: "Automations — a chain of actions (scene cuts, overlays, timers, Twitch actions) fired by one click, a hotkey, or a trigger like 'kickoff' or 'match ended'. Build your repeatable moments: going live, starting-soon, back-from-break, match transitions." },
    { target: '#prod-hotkeys-tab', tab: 'produccion', run: function () { if (window._pdShow) window._pdShow('hotkeys'); },
      title: 'Production ▸ Hotkeys',
      body: "The live legend of every keyboard shortcut bound to a deck button. Capture a combo on any button in the Deck editor and it fires from anywhere in the app — no matter which page you're on." },
    { target: '#director-section', tab: 'produccion', run: function () { if (window._pdShow) window._pdShow('director'); },
      title: 'Production ▸ NEURAL AI',
      body: "The AI director. It watches the game feed and can suggest — or, when you arm it, make — scene cuts: kickoff to gameplay, goals to replays, downtime to casters. It learns from the cuts you accept and reject. Everything it may do on its own is listed below in What's Armed." },
    { target: '#whats-armed', tab: 'produccion', run: function () { if (window._pdShow) window._pdShow('director'); },
      title: "What's Armed — trust, verified",
      body: "Every automation currently allowed to act on its own — auto-switching, flow triggers, the AI director — listed in one place, with a log of what actually fired. If the show ever changes scenes 'by itself', this panel tells you exactly why." },

    // ── Video Editor ──
    { target: '#tab-replays', tab: 'replays', placement: 'right', title: 'Video Editor — replays & clips',
      body: "Capture replays from the OBS buffer, trim clips in the editor, and build playlists and montages (commercials, intros, halftime reels) with transitions and status badges that show what's ready to air." },
    { target: '#rp-to-program', tab: 'replays', title: 'Push it to air',
      body: "'To Air' plays a clip or an encoded playlist straight on your OBS program — it switches to your chosen scene, plays with audio, and can auto-return when done. 'Preview' cues it on the preview bus first, without going live." },

    // ── Talent ──
    { target: '#tab-equipos', tab: 'equipos', placement: 'right', title: 'Talent — teams & on-air crew',
      body: "Everyone in front of the camera. Teams (with CSV import and JSON backup), casters and their desk lineup, guests — and private VDO.Ninja camera rooms with per-person join links and QR codes. No pasting URLs around." },
    { target: '#talent-page-nav', tab: 'equipos', title: 'Talent sub-tabs',
      body: "Teams and Crew. Crew filters down to Casters · Hosts · Guests · Observers — each with a private VDO.Ninja camera room, a join link and a QR code." },

    // ── Cameras ──
    { target: '#tab-facecams', tab: 'facecams', placement: 'right', title: 'Cameras — feeds & rooms',
      body: "The Talent page is who's on your roster. This is where their actual video lives — assign cams, set VDO.Ninja rooms, request screenshares, and route feeds into your OBS scenes. If your studio is part of an Organization, camera feeds shared by other producers show up here too." },
    { target: '#dcc-monitor-view', tab: 'principal',
      run: function () { var t = document.querySelector('.qrail-tab[data-qtab="talent"]'); if (t) t.click(); },
      title: 'Talent Monitor & Director Control Center',
      body: "The rail's Talent tab monitors every camera room from any page. Pop it out into the full Director Control Center to move casters and players between rooms live, cue interviews, and listen in on any room without putting it on air." },

    // ── ESPORTS ──
    { target: '#tab-events', tab: 'events', placement: 'right', title: 'ESPORTS — tournaments & leagues',
      body: "The competitive side. Pull a bracket and it adapts to any scale — phases and pools are selectable, swiss stages render as a records ladder, and you can search a team by name to jump straight to their pool." },
    { target: '#ev-subnav', tab: 'events', title: 'ESPORTS sub-tabs',
      body: "Tournaments · Leagues · My Events · Seeding · Spotlight. Seeding verifies player ranks across sources (rl6mans, start.gg, tracker profiles) and auto-orders your roster; Spotlight builds teams-to-watch cards for the watchlist overlay." },

    // ── Assets ──
    { target: '#tab-media', tab: 'media', placement: 'right', title: 'Assets — media, overlays & profiles',
      body: "Your media library, a live scene-HTML editor for customizing overlays, per-game Game Configs (maps, roles, characters — import/export), and brand Profiles." },
    { target: '#assets-subnav', tab: 'media', title: 'Brand kits & packages',
      body: "A Profile is a full brand kit — logo, colors, fonts, sponsor placements — and each kit holds packages (per-sponsor or per-show variants). Packages capture your whole show setup: desk topics, tickers, titles, scene presets. 'Save & Activate' switches the entire broadcast's look in one click, and Profiles export as a zip to move between machines." },

    // ── Analytics ──
    { target: '#tab-stats', tab: 'stats', placement: 'right', title: 'Analytics — measure the show',
      body: "Data on every broadcast, plus the player/team stats database." },
    { target: '#stats-subnav', tab: 'stats', title: 'Analytics sub-tabs',
      body: "Overview · Tournaments (import a tournament's full history from start.gg) · Teams · Players · Broadcasts · Audience (live Twitch followers, subs, clips) · Sponsors · Reports for per-sponsor on-screen exposure proof." },

    // ── Integrations ──
    { target: '#int-store-grid', tab: 'integrations', placement: 'right', title: 'Integrations — the app store',
      body: "Every platform the suite talks to, as cards with LIVE connection status: green connected, amber needs attention, gray not set up. Click a card to open just that app's settings — each key field has a 'How do I get this?' walkthrough with exact steps and links." },
    { target: '#integration-streamdeck', tab: 'integrations',
      run: function () { if (window._intShowTab) window._intShowTab('streamdeck'); },
      title: 'Elgato Stream Deck — physical keys',
      body: "The suite has an official Stream Deck plugin: score keys that show the live series score in team colors, graphics that light up while on air, a ticking countdown clock, run-of-show navigation, audio mutes and replays. Download it right here — it finds the app automatically, and this page shows a green Connected chip once its keys are live." },

    // ── Settings ──
    { target: '#tab-ajustes', tab: 'ajustes', placement: 'right', title: 'Settings — preferences',
      body: "App preferences, per-game options, keyboard shortcuts, software updates — and Getting Started, where you can replay this walkthrough anytime. If your studio uses an Organization, sign in here too — it syncs your profile to the cloud and, for org members, shares teams, leagues and camera feeds with the rest of your producers." },

    // ── Finale ──
    { target: '#btn-obs-download-collection', tab: 'integrations', placement: 'auto',
      run: function () { if (window._intShowTab) window._intShowTab('switcher'); },
      title: 'Best first move: OBS in one click',
      body: "Here in Integrations ▸ OBS Studio, click 'Save Scene Collection' to install a ready-made OBS scene collection — 32 scenes plus caster/player cam framing, pre-wired to these overlays. Import it in OBS and you're broadcast-ready. Replay this tour anytime from Settings ▸ Getting Started." }
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
