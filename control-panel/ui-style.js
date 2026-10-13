/* ─── ui-style.js — Interface style: Classic / Modern ("Studio") ─────────────────────────────
   Settings > Appearance > Interface style. Classic is the app as it has always been. Modern is a
   different app built over the SAME controls: every action still runs through the existing
   elements and handlers in app.js, so nothing a producer does changes behaviour.

   The Modern ("Studio") layout
   - Top command bar: app mark, game, search in the centre, live status, timer, Live dock toggle.
   - Icon rail on the left (icon over label), grouped by how a show runs:
       Live      Control · Graphics · Replays
       Prepare   Match · Event · Sponsors · People · Show
       Library   Assets · Insights
       (foot)    Apps (Marketplace) · Settings
   - Every page opens with a header: big title, one line on what it is for, and its sections as
     tabs across the top (mirrored from the page's own tab row, which Modern hides).
   - The old Dashboard is split into pages (views): Control room, Graphics, Match, Event, Sponsors
     and the Talent monitor.
   - Control room is NEW: a match hero (logos, names, giant score, game, best-of), the program
     preview beside a graphics grid, and the deck. It drives the existing hidden controls.
   - The right rail becomes the Live dock: tabs across the top, toggled from the command bar.
   - The bottom bar becomes the program bar: the scene on air is marked red.

   The rules that keep Classic safe
   - Modern is <html data-ui="modern">; every Modern style in ui-modern.css is scoped to it.
   - Elements Modern MOVES (search box → command bar, Settings ▸ Brand Kits → Sponsors) leave a
     placeholder comment and go back on switching to Classic.
   - Everything Modern adds carries .mx-only, which Classic hides.
   - The choice lives in localStorage (ne_ui_style); an inline <head> script applies it before
     first paint, and other windows follow through the storage event.
*/
(function () {
  'use strict';

  var KEY = 'ne_ui_style';
  var VIEW_KEY = 'ne_mx_view';
  var DOCK_KEY = 'ne_mx_dock';
  var root = document.documentElement;
  var BASE = window.SCENE_BASE_URL || 'http://localhost:3000';

  function readStyle() {
    try { return localStorage.getItem(KEY) === 'modern' ? 'modern' : 'classic'; } catch (e) { return 'classic'; }
  }
  function isModern() { return root.getAttribute('data-ui') === 'modern'; }

  function applyStyle(style, opts) {
    style = style === 'modern' ? 'modern' : 'classic';
    if (style === 'modern') root.setAttribute('data-ui', 'modern');
    else root.removeAttribute('data-ui');
    if (!(opts && opts.noSave)) { try { localStorage.setItem(KEY, style); } catch (e) {} }
    // Undo in the reverse order of applying, so Classic gets its original text back.
    if (style === 'modern') { fixCase(true); applyCopy(true); }
    else { applyCopy(false); fixCase(false); }
    root.classList.toggle('mx-rail-min', style === 'modern' && railMin());
    if (style === 'modern') {
      buildShell();
      closeDockAtBoot();
      setView(mxView, true);
      moveHome('kits', true);
      moveHome('search', true);
      moveHome('stats', true);
      moveHome('deck', true);
      refresh();
    } else {
      closeDrawer();
      root.removeAttribute('data-mx-view');
      moveHome('kits', false);
      moveHome('search', false);
      moveHome('stats', false);
      moveHome('deck', false);
      root.classList.remove('mx-obs-off');
    }
    syncChooser();
    refitPreviews();
  }
  // Live previews size themselves to their box on load; one that loaded while a style or page
  // view had it hidden measured 0 wide and stayed unscaled. Re-fit after every switch.
  function refitPreviews() {
    setTimeout(function () { if (typeof fitLivePreviews === 'function') fitLivePreviews(); }, 80);
  }
  // A preview that was hidden when it loaded (another page or view open) measured 0 wide and was
  // never fitted. Watch every preview box and fit its frame whenever the box gains a size, so it is
  // right no matter which page or style was showing when it loaded.
  if (typeof ResizeObserver === 'function') {
    var pvRO = new ResizeObserver(function (entries) {
      entries.forEach(function (en) {
        var f = en.target.querySelector('iframe');
        if (f && en.contentRect.width > 0 && typeof fitLivePreview === 'function') fitLivePreview(f);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.live-pv'), function (b) { pvRO.observe(b); });
  }
  window.__applyUiStyle = applyStyle;
  window.NEUiStyle = { get: readStyle, set: applyStyle };
  window.addEventListener('storage', function (e) { if (e.key === KEY) applyStyle(readStyle(), { noSave: true }); });

  // ── Settings chooser (works in both styles) ───────────────────────────────────────────────
  function syncChooser() {
    var cur = isModern() ? 'modern' : 'classic';
    var cards = document.querySelectorAll('.uis-card[data-ui-style]');
    for (var i = 0; i < cards.length; i++) {
      var on = cards[i].getAttribute('data-ui-style') === cur;
      cards[i].classList.toggle('is-selected', on);
      cards[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  document.addEventListener('click', function (e) {
    var card = e.target.closest && e.target.closest('.uis-card[data-ui-style]');
    if (card) applyStyle(card.getAttribute('data-ui-style'));
  });

  // ── One vocabulary for the whole app ──────────────────────────────────────────────────────
  // Classic says "Push Live", "On Air", "Put On Air", "Clear All", "Take off"… for the same idea.
  // Modern uses one plain set of words a first-time user understands:
  //   state   Live / Off            action   Show / Hide / Update
  // Labels app.js writes (and re-writes as state changes) are swapped as they appear, by exact
  // match only, and every swapped text node keeps its original so Classic gets it back. Only the
  // TEXT node changes, so an icon sharing the element is untouched.
  var VOCAB = {
    'Push Live': 'Show', 'PUSH LIVE': 'Show', 'Live — Re-push': 'Update', '● On Air': '● Live',
    'Clear All': 'Hide all', 'clear all': 'hide all', 'Put On Air': 'Graphics',
    'On Air': 'Live', 'ON AIR': 'Live', 'OFF AIR': 'Off', 'ON STREAM': 'Live', 'On stream': 'Live',
    'Team graphics fill for': 'Team graphics are about',
    'Update Stream Info': 'Update stream info',
    'BRAND KIT': 'Brand kit', 'PROGRAM CUTS': 'Program', 'LISTEN IN': 'Listen in',
    // Dock empty states that name pages Modern renamed.
    'No flows yet — build them on Production.': 'No automations yet. Click edit to build one.',
    'No talent yet — set teams on the Dashboard, add casters/guests on the Talent page.': 'Nobody yet. Set the teams on the Dashboard and add casters on the Talent page.',
    'Your Twitch token has expired — reconnect Twitch in Settings to pull channel stats.': 'Your Twitch sign-in has expired. Reconnect Twitch on the Apps page to pull channel stats.',
    'Graphs & Stats': 'Overview', 'All Teams': 'Every team', 'All Players': 'Every player',
    'Talent & Features': 'Talent', 'overlay ↗': 'Open overlay'
  };
  var vocabObs = null;
  function vocabNode(t) {
    var v = t.nodeValue;
    if (!v) return;
    var k = v.trim();
    if (!k || !Object.prototype.hasOwnProperty.call(VOCAB, k)) return;
    // Dock tab names have their own copy below; "Live" there would read as the Go live button.
    if (t.parentElement && t.parentElement.closest('#qrail-tabs')) return;
    t.__mxOrig = v;   // latest original: app code may have rewritten this node since the last swap
    t.nodeValue = v.replace(k, VOCAB[k]);
  }
  function vocabScan(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) { vocabNode(rootNode); return; }
    if (rootNode.nodeType !== 1 || rootNode.closest && rootNode.closest('textarea, [contenteditable="true"], .mx-only')) return;
    var w = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) vocabNode(n);
  }
  function fixCase(on) {
    if (on) {
      vocabScan(document.body);
      if (!vocabObs && typeof MutationObserver === 'function') {
        vocabObs = new MutationObserver(function (recs) {
          for (var i = 0; i < recs.length; i++) {
            var r = recs[i];
            if (r.type === 'characterData') vocabNode(r.target);
            else for (var j = 0; j < r.addedNodes.length; j++) vocabScan(r.addedNodes[j]);
          }
        });
        vocabObs.observe(document.body, { subtree: true, childList: true, characterData: true });
      }
    } else {
      if (vocabObs) { vocabObs.disconnect(); vocabObs = null; }
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = w.nextNode())) {
        if (n.__mxOrig != null) {
          // Restore only if the app has not rewritten it since (then the app's text is current).
          var cur = n.nodeValue.trim();
          var orig = n.__mxOrig;
          if (VOCAB[orig.trim()] === cur) n.nodeValue = orig;
          n.__mxOrig = null;
        }
      }
    }
  }

  // ── Plain copy for titles and descriptions (Modern only) ─────────────────────────────────
  var COPY = window.NE_MODERN_COPY || [];
  // Only TEXT nodes change (each remembers its original), so buttons, links and icons inside a
  // title keep their elements and handlers in both styles.
  function setCopy(node, text) {
    var texts = [];
    var w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null), t;
    while ((t = w.nextNode())) { if (t.nodeValue.trim() && !(t.parentNode && t.parentNode.closest && t.parentNode.closest('button, a, input, select, .mx-only') && t.parentNode !== node)) texts.push(t); }
    if (!texts.length) return;
    node.__mxCopy = texts.map(function (x) { return [x, x.nodeValue]; });
    texts[0].nodeValue = text;
    for (var j = 1; j < texts.length; j++) texts[j].nodeValue = '';
  }
  function applyCopy(on) {
    COPY.forEach(function (c) {
      var nodes = document.querySelectorAll(c[0]);
      if (nodes.length !== 1) return;          // a selector must name exactly one element
      var n = nodes[0];
      if (on) { if (n.__mxCopy == null) setCopy(n, c[1]); }
      else if (n.__mxCopy != null) {
        n.__mxCopy.forEach(function (pair) { pair[0].nodeValue = pair[1]; });
        n.__mxCopy = null;
      }
    });
  }

  // ── Navigation model ──────────────────────────────────────────────────────────────────────
  var ICONS = {
    overlays: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17.5l9 5 9-5" opacity=".55"/>',
    home:     '<path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/>',
    live:     '<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>',
    graphics: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M3 13h18M9 21h6M12 17v4"/>',
    replays:  '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    match:    '<path d="M4 4l7 7M20 4l-7 7M4 20l4-4M20 20l-4-4M9.5 14.5l-3 3M14.5 14.5l3 3"/><circle cx="12" cy="12" r="2"/>',
    event:    '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    sponsors: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    people:   '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    show:     '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M7 13h4M7 17h8"/>',
    assets:   '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    library:  '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h5"/>',
    stats:    '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    market:   '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.16V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-2.82-1.16l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3 15H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.16-2.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.16l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 21 9h.09a2 2 0 0 1 0 4H21a1.65 1.65 0 0 0-1.6 2z"/>',
    deck:     '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    collapse: '<path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/>',
    tv:       '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M17 2l-5 5-5-5"/>',
    palette:  '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.3-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16a6 6 0 0 0 6-6c0-5-4.5-9-10-9z"/>',
    obs:      '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>',
    close:    '<path d="M18 6L6 18M6 6l12 12"/>',
    popout:   '<path d="M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
    dock:     '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    plus:     '<path d="M12 5v14M5 12h14"/>',
    minus:    '<path d="M5 12h14"/>',
    swap:     '<path d="M7 16V4M7 4L3 8M7 4l4 4M17 8v12M17 20l4-4M17 20l-4-4"/>',
    refresh:  '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
    undo:     '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    edit:     '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'
  };
  function svg(name, cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  // go: { tab, view?, click? } — tab = the classic page; view = a Dashboard view; click = a real
  // sub-tab to press. subs.mirror: a classic tab row whose buttons become this page's top tabs.
  var NAV = [
    { id: 'home', rail: 'Home', label: 'Home', icon: 'home', go: { tab: 'principal', view: 'home' },
      desc: 'Nameless Esports: what is coming up, what we do, and tonight at a glance.' },
    { group: 'Live' },
    { id: 'live', rail: 'Dashboard', label: 'Dashboard', icon: 'live', go: { tab: 'principal', view: 'live' },
      desc: 'Run the show from one screen. Edit layout arranges the cards however you like.' },
    { id: 'graphics', rail: 'Graphics', label: 'Graphics', icon: 'graphics', go: { tab: 'principal', view: 'graphics' },
      desc: 'Edit every graphic, preview it and put it on air.' },
    { id: 'overlays', rail: 'Overlays', label: 'Overlays', icon: 'overlays', go: { tab: 'principal', view: 'overlays' },
      desc: 'Design your own overlays for any scene, or use the ones built into the app. Everything goes straight into OBS.' },
    { id: 'replays', rail: 'Replays', label: 'Replays', icon: 'replays', go: { tab: 'replays' },
      subs: [],
      desc: 'Capture moments during the game, play them back on air, and build highlight reels for the breaks.' },
    { group: 'Set up' },
    { id: 'match', rail: 'Match', label: 'Match', icon: 'match', go: { tab: 'principal', view: 'match' },
      desc: 'The two teams, their rosters and colours, the series and the game settings.' },
    { id: 'event', rail: 'Event', label: 'Event', icon: 'event', go: { tab: 'principal', view: 'event' },
      // One page. Leagues and tournaments are created and run on the Nameless website; the app's own
      // Competitions / Leagues / Browse start.gg pages are retired from the nav (site-events.js).
      subs: [],
      desc: 'Your leagues and tournaments from the Nameless website, or an event on start.gg and other platforms. Load one and the teams, matches, scores and standings fill in by themselves.' },
    { id: 'sponsors', rail: 'Brand', label: 'Brand', icon: 'sponsors', go: { tab: 'principal', view: 'sponsors' },
      desc: 'Brand kits, sponsor logos and where they appear on air.' },
    { id: 'people', rail: 'Talent', label: 'Talent', icon: 'people', go: { tab: 'equipos', click: '#talent-page-nav > button[data-talentpage="showdeck"]' },
      subs: [
        { mirror: '#talent-page-nav > button[data-talentpage="showdeck"]', tab: 'equipos' },
        { label: 'Live monitor', go: { tab: 'principal', view: 'monitor', click: '.dcc-role-tab[data-dcrole="monitor"]' } },
        { label: 'Cameras', go: { tab: 'produccion', click: '#pd-subnav > button[data-pd="cameras"]' }, pd: 'cameras' }
      ],
      desc: 'Who is on the show tonight: the desk, their cameras and the live monitor.' },
    { id: 'show', rail: 'Rundown', label: 'Rundown', icon: 'show', go: { tab: 'produccion', click: '#pd-subnav > button[data-pd]:not([data-pd="cameras"])', keep: true },
      subs: [{ mirror: '#pd-subnav > button[data-pd]:not([data-pd="cameras"])', tab: 'produccion' }],
      desc: 'Run of show, automations, hotkeys and the AI director.' },
    { group: 'Library' },
    { id: 'library', rail: 'Teams', label: 'Teams', icon: 'library', go: { tab: 'equipos', click: '#talent-page-nav > button[data-talentpage="teams"]' },
      subs: [{ mirror: '#talent-page-nav > button:not([data-talentpage="showdeck"])', tab: 'equipos' }],
      desc: 'Every team and person you have saved, ready to drop into a show.' },
    { id: 'assets', rail: 'Assets', label: 'Assets', icon: 'assets', go: { tab: 'media' },
      subs: [{ mirror: '#assets-subnav > button', tab: 'media' }],
      desc: 'Your images and every overlay browser source.' },
    { id: 'stats', rail: 'Analytics', label: 'Analytics', icon: 'stats', go: { tab: 'stats' },
      subs: [{ mirror: '#stats-subnav > button', tab: 'stats' }],
      subDesc: {
        'Overview': 'How the whole operation is doing, in one place.',
        'Tournaments': 'Bracket progress, match pace and map win rates for the events you have streamed.',
        'Teams': 'Win rates and records for every team in your matches.',
        'Players': 'Per-player stats from the matches you streamed.',
        'Broadcasts': 'One report per show: viewers, scene time, ads, clips and engagement.',
        'Audience': 'Channel growth and engagement on Twitch and YouTube.',
        'Sponsors': 'Proof of play: how long each sponsor was on screen.',
        'Reports': 'Exports and a print-ready recap for sponsors, teams and your org.',
        'Tools': 'Spreadsheets, seeds and the bracket explorer for event day.'
      },
      desc: 'How your broadcasts, teams, sponsors and audience are doing.' },
    { foot: true },
    { id: 'market', rail: 'Apps', label: 'Apps', icon: 'market', go: { tab: 'integrations', click: '#int-subnav > button[data-inttab="store"]' },
      subs: [{ mirror: '#int-subnav > button', tab: 'integrations' }],
      desc: 'Connect your platforms and add plugins.' },
    { id: 'settings', rail: 'Settings', label: 'Settings', icon: 'settings', action: 'settings' }
  ];
  var TAB_NAMES = {
    'Flows': 'Automations', 'NEURAL AI': 'AI director', 'Show Deck': 'Desk lineup', 'Assets': 'Media',
    'My Events': 'My events', 'Event Ops': 'Tools', 'Integrations': 'Connected apps', 'Highlights': 'Highlight reels'
  };
  var ITEM = {};
  NAV.forEach(function (n) { if (n.id) ITEM[n.id] = n; });

  var VIEW_OF = { home: 'home', overlays: 'overlays', live: 'live', graphics: 'graphics', match: 'match', event: 'event', sponsors: 'sponsors', monitor: 'people' };
  // Which view shows each Dashboard section (search deep-links switch to it first).
  var SECTION_VIEWS = {
    teams: ['match'], deck: ['live'], graphics: ['graphics'], onair: ['graphics'],
    gamesettings: ['match'], series: ['match'], 'section-ow-bans': ['match'], 'section-mr-bans': ['match'],
    event: ['event'], 'dash-mini-queue': ['event'], adslots: ['sponsors'], 'mx-kits': ['sponsors'],
    director: ['monitor'], talent: ['monitor'], casters: ['monitor']
  };
  var mxView = (function () { try { return localStorage.getItem(VIEW_KEY) || 'live'; } catch (e) { return 'live'; } })();
  if (!VIEW_OF[mxView]) mxView = 'live';

  function setView(v, quiet) {
    if (!VIEW_OF[v]) v = 'live';
    var changed = v !== mxView;
    mxView = v;
    if (isModern()) root.setAttribute('data-mx-view', v);
    try { localStorage.setItem(VIEW_KEY, v); } catch (e) {}
    if (changed && !quiet) { var sc = document.getElementById('tab-scroll'); if (sc) sc.scrollTop = 0; }
    if (changed) refitPreviews();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function navBtn(tab) { return document.querySelector('.sidebar-nav .tab-btn[data-tab="' + tab + '"]'); }
  function activeTab() { var b = document.querySelector('.sidebar-nav .tab-btn.active[data-tab]'); return b ? b.getAttribute('data-tab') : ''; }
  function pdActive() { var b = document.querySelector('#pd-subnav > button.active'); return b ? b.getAttribute('data-pd') : ''; }
  function mk(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function visibleBtn(b) {
    if (b.hidden || b.style.display === 'none') return false;
    if (b.classList.contains('subnav-more') || b.classList.contains('subnav-collapsed')) return false;
    return window.getComputedStyle(b).display !== 'none';
  }
  function cleanLabel(t) { return String(t || '').replace(/[↗→]/g, '').replace(/\s+/g, ' ').trim(); }
  function labelOf(b) {
    var copy = b.cloneNode(true);
    var junk = copy.querySelectorAll('[class*="chip"], [class*="badge"], [class*="count"]');
    for (var j = 0; j < junk.length; j++) junk[j].remove();
    return cleanLabel(copy.textContent);
  }
  function state() { try { return (typeof currentState !== 'undefined' && currentState) || null; } catch (e) { return null; } }

  function go(g) {
    if (!g) return;
    if (g.view) setView(g.view);
    var b = navBtn(g.tab);
    if (b && !b.classList.contains('active')) b.click();
    if (g.click) {
      var cur = document.querySelector('#pd-subnav > button.active');
      if (!(g.keep && cur && cur.matches(g.click))) { var c = document.querySelector(g.click); if (c) c.click(); }
    }
    setTimeout(refresh, 30);
  }
  // Belt and braces for the sideways shift: if anything ever scrolls the window frame horizontally
  // (it is never meant to), put it straight back.
  ['scroll'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      var t = e.target === document ? document.scrollingElement : e.target;
      if (t && (t === document.scrollingElement || t === document.body || (t.classList && t.classList.contains('app-shell'))) && t.scrollLeft) t.scrollLeft = 0;
    }, true);
  });
  // Tests and walkthroughs reach any page the way a nav click does: __mxGo({ tab, view, click }).
  window.__mxGo = go;

  function settingsOpen() { var m = $('tab-ajustes-content'); return !!m && m.classList.contains('open'); }
  function currentItem() {
    if (settingsOpen()) return 'settings';
    var tab = activeTab();
    if (tab === 'principal') return VIEW_OF[mxView] || 'live';
    if (tab === 'produccion') return pdActive() === 'cameras' ? 'people' : 'show';
    if (tab === 'equipos') {
      var tp = document.querySelector('#talent-page-nav .talent-page-btn.active');
      return tp && tp.getAttribute('data-talentpage') !== 'showdeck' ? 'library' : 'people';
    }
    return { replays: 'replays', events: 'event', media: 'assets', stats: 'stats', integrations: 'market' }[tab] || '';
  }

  function subItems(item) {
    var out = [], tab = activeTab();
    (item.subs || []).forEach(function (s) {
      if (s.mirror) {
        var btns = document.querySelectorAll(s.mirror);
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          if (!visibleBtn(b)) continue;
          var label = labelOf(b);
          if (TAB_NAMES[label]) label = TAB_NAMES[label];
          if (label) out.push({ label: label, active: tab === s.tab && b.classList.contains('active'), tab: s.tab, src: b });
        }
      } else {
        var on = s.go.view ? (tab === 'principal' && mxView === s.go.view) : (tab === s.go.tab && (!s.pd || pdActive() === s.pd));
        out.push({ label: s.label, active: on, go: s.go });
      }
    });
    return out;
  }

  // ── Elements Modern moves (with a placeholder so Classic gets them back) ────────────────────
  var HOMES = {
    kits:   { el: function () { return $('set-sec-brandkits'); }, host: function () { return document.querySelector('#mx-kits .mx-kits-body'); } },
    search: { el: function () { return $('navsearch'); }, host: function () { return $('mx-search-slot'); } },
    stats:  { el: function () { return $('topbar-live'); }, host: function () { return $('mx-bb-stats'); } },
    deck:   { el: function () { return document.querySelector('[data-dash-id="deck"]'); }, host: function () { return document.querySelector('#mx-cr .mx-deck-host'); } }
  };
  function moveHome(key, toModern) {
    var h = HOMES[key], node = h.el(), host = h.host();
    if (!node) return;
    if (toModern) {
      if (!host || node.parentElement === host) return;
      if (!h.mark) { h.mark = document.createComment(key + ' home'); node.parentNode.insertBefore(h.mark, node); }
      h.display = node.style.display;
      host.appendChild(node);
      node.style.display = '';   // e.g. the Settings category filter stamps display:none on the kits
    } else if (h.mark && h.mark.parentNode && node.parentElement !== h.mark.parentNode) {
      h.mark.parentNode.insertBefore(node, h.mark);
      node.style.display = h.display || '';
    }
  }

  // ── Shell ──────────────────────────────────────────────────────────────────────────────
  var built = false, navEl = null, head = null, connText = null, cr = null;

  function buildShell() {
    if (built) return;
    var sideNav = document.querySelector('.sidebar-nav');
    if (!sideNav) return;
    built = true;

    // Icon rail
    navEl = mk('div', 'mx-only mx-nav');
    navEl.setAttribute('role', 'navigation');
    sideNav.appendChild(navEl);
    navEl.addEventListener('click', onNavClick);

    // Command bar: a slot for the search box, the app name, and the Live dock toggle.
    var center = document.querySelector('.phm-center');
    if (center) {
      var slot = mk('div', 'mx-only mx-search-slot');
      slot.id = 'mx-search-slot';
      center.insertBefore(slot, center.firstChild);
    }
    var brand = document.querySelector('.prod-header-brand');
    if (brand) brand.appendChild(mk('span', 'mx-only mx-appname', 'Broadcast Studio'));
    var right = document.querySelector('.topbar-right');
    if (right) {
      var dock = mk('button', 'mx-only mx-dock-btn');
      dock.type = 'button';
      dock.id = 'mx-dock-btn';
      dock.title = 'Show or hide the Live dock (on air, up next, talent, replay, chat, automation, notes)';
      dock.innerHTML = svg('dock') + '<span>Live dock</span>';
      dock.addEventListener('click', toggleDock);
      right.insertBefore(dock, right.firstChild);
    }

    // Page header: title, purpose, tabs. Sticky at the top of the scrolling column.
    var scroll = $('tab-scroll');
    if (scroll) {
      head = mk('div', 'mx-only mx-head');
      head.innerHTML = '<div class="mx-head-row"><div class="mx-head-text"><h1 class="mx-head-title"></h1><p class="mx-head-desc"></p></div></div>'
        + '<div class="mx-tabs" role="tablist"></div>';
      scroll.insertBefore(head, scroll.firstChild);
      head.querySelector('.mx-tabs').addEventListener('click', onTabClick);
    }

    var sig = $('conn-signal');
    if (sig) { connText = mk('span', 'mx-only mx-conn-text'); sig.insertBefore(connText, sig.querySelector('.conn-tooltip')); }

    // Sponsors view: a home for the brand kit manager.
    var grid = $('dash-grid');
    if (grid) {
      var kits = mk('section', 'section mx-only mx-kits');
      kits.id = 'mx-kits';
      kits.innerHTML = '<div class="mx-kits-head"><h3 class="section-title">Brand kits</h3>'
        + '<p class="section-desc">One kit per client or event: its colours, logo and sponsors. The live kit recolours every overlay and drives the sponsor rail.</p></div>'
        + '<div class="mx-kits-body"></div>';
      grid.appendChild(kits);
    }

    buildControlRoom();
    buildProgramBar();
    buildDockHead();
    buildRailHandle();
    tagDockGroups();
    buildEventHero();
    buildGfxStrip();
    buildGfxPreview();
    buildMatchExtras();
    buildEventSteps();
    hookOpenSettings();
    hookScrollIntoView();

    document.addEventListener('click', function () { if (isModern()) setTimeout(refresh, 40); }, true);
    setInterval(function () { if (isModern()) refresh(); }, 1200);
    setInterval(function () { if (isModern() && crVisible()) renderControlRoom(); }, 400);
  }

  function onNavClick(e) {
    var b = e.target.closest('[data-mx-item]');
    if (!b) return;
    closeDrawer();
    var item = ITEM[b.getAttribute('data-mx-item')];
    if (!item) return;
    if (item.action === 'settings') { if (typeof window.openSettings === 'function') window.openSettings(); return; }
    // Settings is a full-page modal over the current page: any other sidebar page closes it first,
    // or the click changed the page UNDER Settings and the app looked frozen.
    var sm = document.getElementById('tab-ajustes-content');
    if (sm && sm.classList.contains('open') && typeof window.closeSettingsModal === 'function') window.closeSettingsModal();
    if (currentItem() !== item.id) go(item.go);
    if (document.body.classList.contains('nav-open') && typeof window.setMobileNav === 'function') window.setMobileNav(false);
  }
  function onTabClick(e) {
    var b = e.target.closest('.mx-tab');
    if (!b || !b.__mxSub) return;
    var s = b.__mxSub;
    if (s.src) { go({ tab: s.tab }); if (document.contains(s.src)) s.src.click(); }
    else go(s.go);
  }

  // Sidebar: a workspace card (game + event + live state) on top, then the pages as full rows with
  // live badges (the Control room glows while streaming, Graphics counts what is live, Event
  // counts queued matches), and a collapse button that shrinks it to icons.
  var RAIL_KEY = 'ne_mx_rail_min';
  function railMin() { try { return localStorage.getItem(RAIL_KEY) === '1'; } catch (e) { return false; } }
  function setRailMin(on) {
    try { localStorage.setItem(RAIL_KEY, on ? '1' : '0'); } catch (e) {}
    root.classList.toggle('mx-rail-min', !!on);
    if (navEl) navEl._sig = '';
    refitPreviews();
    refresh();
  }
  function navBadges(s) {
    var b = {};
    var obs = (s && s.obs) || {};
    if (obs.streaming) b.live = { text: 'Live', tone: 'live' };
    else if (obs.recording) b.live = { text: 'Rec', tone: 'live' };
    var on = document.querySelectorAll('#qk-put .qk-chip.on:not(.qk-chip--scene)').length;
    if (on) b.graphics = { text: String(on), tone: 'live' };
    var q = (s && s.startgg && Array.isArray(s.startgg.queue)) ? s.startgg.queue.filter(function (m) { return m && m.state !== 3; }).length : 0;
    if (q) b.event = { text: String(q), tone: 'info' };
    return b;
  }
  // The event's logo for the workspace card: the platform's own (start.gg tournament logo, FACEIT,
  // NXGEN), else the in-app league feeding the broadcast, else the active brand kit's logo.
  // Empty = the card falls back to the game logo.
  function eventLogo(s) {
    var ae = (s && s.activeEvent) || {};
    if (ae.logo) return ae.logo;
    var lid = s && s.competition && s.competition.leagueId;
    var lg = lid && (s.leagues || []).find(function (l) { return l && l.id === lid; });
    if (lg && lg.logo) return lg.logo;
    return (s && s.brand && s.brand.logo) || '';
  }
  function renderNav() {
    if (!navEl) return;
    var s = state() || {};
    var cur = currentItem();
    var viewOnly = document.body.classList.contains('role-viewonly');
    var badges = navBadges(s);
    var gameLogo = ($('game-dd-logo') || {}).src || '';
    var evLogo = eventLogo(s);
    var logo = evLogo || gameLogo;
    var gameName = (s.games && s.games[s.activeGame] && s.games[s.activeGame].name) || '';
    var eventName = s.eventName || '';
    var sig = JSON.stringify([cur, viewOnly, badges, logo.length > 200 ? logo.slice(0, 64) + logo.length : logo, gameName, eventName, railMin()]);
    if (navEl._sig === sig) return;
    navEl._sig = sig;
    navEl.textContent = '';

    var ws = mk('button', 'mx-ws');
    ws.type = 'button';
    ws.title = 'Your event: change the tournament without leaving this page';
    // Live state is on the program bar and the Control room row; the card keeps its room for the name.
    ws.innerHTML = '<span class="mx-ws-logo' + (evLogo ? ' is-event' : '') + '">' + (logo ? '<img alt="">' : svg('event')) + '</span>'
      + '<span class="mx-ws-text"><span class="mx-ws-event"></span><span class="mx-ws-game"></span></span>';
    if (logo) ws.querySelector('img').src = logo;
    ws.querySelector('.mx-ws-event').textContent = eventName || 'No event loaded';
    ws.querySelector('.mx-ws-game').textContent = gameName || 'No game picked';
    ws.addEventListener('click', function () { openDrawer('event') || go(ITEM.event.go); });
    navEl.appendChild(ws);

    NAV.forEach(function (n) {
      if (n.group) { navEl.appendChild(mk('div', 'mx-group', n.group)); return; }
      if (n.foot) { navEl.appendChild(mk('div', 'mx-nav-spacer')); return; }
      if (viewOnly && (n.id === 'settings' || n.id === 'market')) return;
      var b = mk('button', 'mx-item' + (n.id === cur ? ' is-active' : ''));
      b.type = 'button';
      b.setAttribute('data-mx-item', n.id);
      b.title = n.label + (n.desc ? '\n' + n.desc : '');
      var bd = badges[n.id];
      b.innerHTML = '<span class="mx-item-ico">' + svg(n.icon) + '</span><span class="mx-item-label"></span>'
        + (bd ? '<span class="mx-badge mx-badge--' + bd.tone + '"></span>' : '');
      b.querySelector('.mx-item-label').textContent = n.label;
      if (bd) b.querySelector('.mx-badge').textContent = bd.text;
      if (n.id === cur) b.setAttribute('aria-current', 'page');
      navEl.appendChild(b);
    });
  }

  function renderHead() {
    if (!head) return;
    var cur = currentItem();
    var item = ITEM[cur];
    var title = item ? item.label : cleanLabel((document.querySelector('.sidebar-nav .tab-btn.active .nav-label') || {}).textContent || '');
    var subs = item && item.subs ? subItems(item) : [];
    var activeSub = null;
    for (var si = 0; si < subs.length; si++) if (subs[si].active) activeSub = subs[si];
    var desc = item ? ((item.subDesc && activeSub && item.subDesc[activeSub.label]) || item.desc || '') : '';
    var sig = title + '|' + desc + '|' + JSON.stringify(subs.map(function (x) { return [x.label, x.active]; }));
    if (head._sig === sig) return;
    head._sig = sig;
    head.querySelector('.mx-head-title').textContent = title;
    head.querySelector('.mx-head-desc').textContent = desc;
    var tabs = head.querySelector('.mx-tabs');
    tabs.textContent = '';
    subs.forEach(function (s) {
      var t = mk('button', 'mx-tab' + (s.active ? ' is-active' : ''), s.label);
      t.type = 'button';
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', s.active ? 'true' : 'false');
      t.__mxSub = s;
      tabs.appendChild(t);
    });
    tabs.hidden = subs.length < 2;
    head.hidden = !title;
  }

  // "All connected" / "Waiting for OBS" / "OBS offline" / "App offline", from the signal's rows.
  function renderConn() {
    if (!connText) return;
    var rows = document.querySelectorAll('#conn-tooltip-rows .conn-tooltip-row');
    var bad = [], warn = [], serverDown = false;
    for (var i = 0; i < rows.length; i++) {
      var dot = rows[i].querySelector('.conn-dot');
      var lab = rows[i].querySelector('.conn-tooltip-label');
      var name = lab ? lab.textContent.trim() : '';
      if (!dot || !name) continue;
      if (name === 'Server') { if (dot.classList.contains('bad')) serverDown = true; continue; }
      if (dot.classList.contains('bad')) bad.push(name);
      else if (dot.classList.contains('warn')) warn.push(name);
    }
    var txt, cls;
    if (!rows.length) { txt = 'Connecting'; cls = 'warn'; }
    else if (serverDown) { txt = 'App offline'; cls = 'bad'; }
    else if (bad.indexOf(swName()) !== -1) { txt = swName() + ' offline'; cls = 'bad'; }
    // The streaming software is what puts anything on air, so it outranks every other service.
    else if (warn.indexOf(swName()) !== -1) { txt = 'Waiting for ' + swName(); cls = 'warn'; }
    else if (!bad.length && !warn.length) { txt = 'All connected'; cls = 'ok'; }
    else if (bad.length) { txt = bad.length === 1 ? bad[0] + ' offline' : bad.length + ' not connected'; cls = 'warn'; }
    else { txt = 'Connected'; cls = 'ok'; }
    if (connText.textContent !== txt) connText.textContent = txt;
    connText.setAttribute('data-state', cls);
  }

  // Program bar: mark the scene that is on air.
  function renderProgram() {
    var s = state();
    var cur = s && s.obs && s.obs.connected ? (s.obs.currentScene || '') : '';
    var btns = document.querySelectorAll('#qt-obs-scenes .qt-scene-btn[data-scene]');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('mx-program', !!cur && btns[i].getAttribute('data-scene') === cur);
  }

  // Settings opens as a full page between the rail and the program bar; it needs the real heights.
  function measureChrome() {
    var h = document.querySelector('.prod-header'), bb = $('bottom-bar');
    var top = h ? Math.round(h.getBoundingClientRect().height) : 52;
    // The bar is position: fixed, so offsetParent is always null; check that it is displayed.
    var bottom = bb && getComputedStyle(bb).display !== 'none' ? Math.round(bb.getBoundingClientRect().height) : 0;
    root.style.setProperty('--mx-top', top + 'px');
    root.style.setProperty('--mx-bottom', bottom + 'px');
  }

  // Live dock = the right rail. Closing it collapses the rail (its own collapse) and Modern hides
  // the leftover strip; opening it clicks the last-used tab, which runs the rail's own logic.
  // Tabs Modern folded into Controls / Show (ui-modern.css hides their buttons): a saved or
  // requested old tab opens where its controls live now.
  var DOCK_MERGED = { quick: 'controls', flows: 'controls', ai: 'controls', graphics: 'controls', golive: 'controls', ros: 'show', startgg: 'show', replay: 'show' };
  function dockTab(tab) { return DOCK_MERGED[tab] || tab; }
  function dockOpen() { var sh = $('app-shell'); return !!sh && !sh.classList.contains('qrail-collapsed'); }
  function toggleDock() {
    if (dockOpen()) { if (typeof window.qrailCollapse === 'function') window.qrailCollapse(); }
    else {
      var last = null; try { last = localStorage.getItem(DOCK_KEY); } catch (e) {}
      var t = document.querySelector('#qrail-tabs .qrail-tab[data-qtab="' + dockTab(last || 'controls') + '"]') || document.querySelector('#qrail-tabs .qrail-tab[data-qtab]');
      if (t) t.click();
    }
    setTimeout(refresh, 30);
  }
  // The dock is a slide-over in Modern (ui-modern.css): it starts closed, and a click outside it or
  // Esc puts it away. Clicks in its own floating lists / pop-ups don't count as outside.
  // Pinned (default): the dock is a fixed column beside the page that stays open until closed. Unpinned:
  // the old slide-over that a click outside puts away. Drawers and other panels always slide over.
  var PIN_KEY = 'ne_mx_dock_pinned';
  function dockPinned() { try { return localStorage.getItem(PIN_KEY) !== '0'; } catch (e) { return true; } }
  function applyDockPin() { document.body.classList.toggle('mx-dock-pinned', dockPinned()); }
  applyDockPin();
  function closeDockIfOpen() {
    if (document.body.classList.contains('popout-qrail')) return;   // the pop-out window IS the dock
    // A pinned dock only closes from its X, but only where it really is a column (ui-modern.css pins
    // it from 1200px); on a narrower window it slides over the page, so a click outside closes it.
    if (dockPinned() && window.innerWidth >= 1200) return;
    if (isModern() && dockOpen() && typeof window.qrailCollapse === 'function') { window.qrailCollapse(); setTimeout(refresh, 30); }
  }
  var dockBootDone = false;
  function closeDockAtBoot() {
    if (dockBootDone) return;
    dockBootDone = true;
    // app.js restores the last open tab during start-up; close after it has run.
    setTimeout(closeDockIfOpen, 1200);
  }
  document.addEventListener('mousedown', function (e) {
    if (!isModern() || !dockOpen()) return;
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.qrail, #mx-dock-btn, .team-dd, .mp-ipick-dd, .app-prompt-overlay, .mp-modal, .modal, [role="dialog"], .mx-drawer, .toast')) return;
    closeDockIfOpen();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !isModern() || !dockOpen()) return;
    if (document.querySelector('.app-prompt-overlay, .mp-modal[style*="flex"], .mx-drawer.is-open')) return;
    closeDockIfOpen();
  });
  function renderDock() {
    var b = $('mx-dock-btn');
    if (b) b.classList.toggle('is-on', dockOpen());
    var a = document.querySelector('#qrail-tabs .qrail-tab.active[data-qtab]');
    if (a) { try { localStorage.setItem(DOCK_KEY, a.getAttribute('data-qtab')); } catch (e) {} }
  }

  function refresh() {
    if (!built || !isModern()) return;
    if (root.getAttribute('data-mx-view') !== mxView) root.setAttribute('data-mx-view', mxView);
    renderNav();
    renderHead();
    renderConn();
    renderProgram();
    renderAirBar();
    renderDock();
    renderDockHead();
    renderRailHandle();
    renderDirectorNote();
    // Brand kit cards: Electron 18 has no :has(), so the live kit is tagged here for the grid.
    var kitCards = document.querySelectorAll('#brands-list > *');
    var kitCount = 0;
    for (var kc = 0; kc < kitCards.length; kc++) {
      if (kitCards[kc].id === 'brands-empty') continue;
      kitCount++;
      kitCards[kc].classList.toggle('mx-live-kit', !!kitCards[kc].querySelector('.brand-kit-live'));
    }
    var kitEmpty = $('brands-empty'); if (kitEmpty) kitEmpty.classList.toggle('mx-hide', kitCount > 0);
    if (mxView === 'home' && window.__mxHome) window.__mxHome.render(state() || {});
    if (mxView === 'overlays' && window.__mxOverlays) window.__mxOverlays.render(state() || {});
    if (mxView === 'event' || drawerKey === 'event') renderEventHero(state() || {});
    if ((mxView === 'event' || drawerKey === 'event') && window.__siteEvents) window.__siteEvents.render(state() || {});
    if ((mxView === 'graphics' && activeTab() === 'principal') || drawerKey === 'graphics') { renderGfxStrip(); renderGfxPreview(); }
    else unloadGfxPreview();
    measureChrome();
    if (crVisible()) { moveHome('deck', true); tagDeck(); }
    if (mxView === 'match') renderMatchExtras();
    if (crVisible()) renderControlRoom();
  }

  // ── Control room ──────────────────────────────────────────────────────────────────────────
  // Built for Modern from scratch around what a producer does while live: keep the score, see and
  // load the next match, know exactly what is on air and take things off it. It only reads state
  // and drives the existing controls: score/game use the scorecard's messages, swap/auto-fill/reset
  // press the real buttons (keeping their confirms), "Put on air" for a queued set uses the rail's
  // confirm + startgg_push_set, and "Take off" presses the On Air rail's own chip.
  function buildControlRoom() {
    var host = $('tab-principal-content'), grid = $('dash-grid');
    if (!host || !grid) return;
    cr = mk('section', 'mx-only mx-cr');
    cr.id = 'mx-cr';
    cr.innerHTML = wizHTML() +
      '<div class="mx-run">' +
      '<div class="mx-setup" hidden><div class="mx-setup-head"><span class="mx-card-title">Get set up</span>'
      + '<span class="mx-setup-count"></span><button type="button" class="mx-link" data-cr="setup-hide">Hide</button></div>'
      + '<div class="mx-setup-steps"></div></div>'
      + '<div class="mx-hero">'
      + '<div class="mx-hero-top"><span class="mx-hero-event"></span>'
      +   '<input type="text" class="mx-hero-round" placeholder="Round, e.g. Grand final" title="The round shown on the scoreboard" spellcheck="false">'
      +   '<span class="mx-hero-air"></span></div>'
      + '<div class="mx-hero-main">'
      +   teamHTML('blue')
      +   '<div class="mx-score">'
      +     scoreHTML('blue')
      +     '<div class="mx-score-mid"><span class="mx-score-dash">:</span><span class="mx-game"></span>'
      +       '<span class="mx-game-ctl"><button type="button" class="mx-ic" data-cr="game" data-d="-1" title="Previous game">' + svg('minus') + '</button>'
      +       '<button type="button" class="mx-ic" data-cr="game" data-d="1" title="Next game">' + svg('plus') + '</button></span>'
      +       '<span class="mx-seg mx-hero-bo" title="Best of">' + [1, 3, 5, 7].map(function (n) { return '<button type="button" data-cr="bo" data-n="' + n + '">Bo' + n + '</button>'; }).join('') + '</span></div>'
      +     scoreHTML('orange')
      +   '</div>'
      +   teamHTML('orange')
      + '</div>'
      + '<div class="mx-hero-actions">'
      +   '<button type="button" class="mx-btn" data-cr="swap" title="The players sat on the other sides: swap the two teams">' + svg('swap') + 'Swap sides</button>'
      +   '<button type="button" class="mx-btn" data-cr="reset" title="Start the series again from 0-0, game 1">' + svg('undo') + 'Reset series</button>'
      +   '<span class="mx-grow"></span>'
      +   '<span class="mx-hint">Click a team name to change it.</span>'
      +   '<button type="button" class="mx-btn mx-btn-quiet" data-cr="edit" title="Logos, colours, abbreviations and rosters">' + svg('edit') + 'Logos and rosters</button>'
      + '</div>'
      + '</div>'
      + '<div class="mx-card mx-deck-card"><div class="mx-card-head"><span class="mx-card-title">Deck</span><span class="mx-hint">One-press buttons for scenes, graphics, countdowns and automations. Each can have a hotkey.</span></div><div class="mx-deck-host"></div></div>'
      + '<div class="mx-cr-grid">'
      +   '<div class="mx-card mx-next">'
      +     '<div class="mx-card-head"><span class="mx-card-title">Up next</span><span class="mx-next-src"></span>'
      +       '<label class="mx-switch" title="Follow your stream automatically: when a match goes live on start.gg it is loaded for you">'
      +       '<span>Auto-follow</span><input type="checkbox" class="mx-follow"><i></i></label></div>'
      +     '<div class="mx-next-list"></div>'
      +   '</div>'
      +   '<div class="mx-cr-side">'
      +     '<div class="mx-card mx-livecard">'
      +       '<div class="mx-card-head"><span class="mx-card-title">Live now</span></div>'
      +       '<div class="mx-pgm"><span class="mx-pgm-dot"></span><span class="mx-pgm-text"><span class="mx-pgm-k">On program</span><b class="mx-pgm-v"></b></span></div>'
      +       '<div class="mx-pgm-scenes"></div>'
      +       '<div class="mx-live-sub"><span>Graphics showing</span><button type="button" class="mx-link" data-cr="clear" title="Hide every graphic">Hide all</button></div>'
      +       '<div class="mx-air-list"></div>'
      +       '<button type="button" class="mx-btn mx-btn-wide" data-cr="dock">' + svg('graphics') + 'Show a graphic</button>'
      +     '</div>'
      +     '<div class="mx-card mx-look">'
      +       '<div class="mx-card-head"><span class="mx-card-title">Brand and overlay</span>'
      +       '<button type="button" class="mx-link" data-cr="sponsors" title="Create and edit brand kits and sponsors">Edit kits</button></div>'
      +       '<div class="mx-look-sec"><span class="mx-look-k">Brand kit</span><div class="mx-kitlist" role="listbox" aria-label="Brand kit"></div></div>'
      +       '<div class="mx-look-sec"><span class="mx-look-k">Overlay</span><div class="mx-look-ov"></div></div>'
      +       '<div class="mx-field"><span>Overlay colours</span><div class="mx-seg mx-mode">'
      +         '<button type="button" data-mode="team" title="Each team&#39;s own colour">Teams</button>'
      +         '<button type="button" data-mode="brand" title="The live brand kit&#39;s colours on both sides">Brand</button>'
      +         '<button type="button" data-mode="default" title="The game&#39;s standard side colours">Game</button>'
      +         '<button type="button" data-mode="game" title="The colours the teams wear in the game (Rocket League)">In-game</button>'
      +       '</div></div>'
      +       '<div class="mx-field"><span>Team colours</span><div class="mx-colors">'
      +         '<label class="mx-color" data-side="blue"><input type="color"><b></b></label>'
      +         '<label class="mx-color" data-side="orange"><input type="color"><b></b></label>'
      +       '</div><p class="mx-hint mx-color-hint"></p></div>'
      +     '</div>'
      +     '<div class="mx-card mx-series">'
      +       '<div class="mx-card-head"><span class="mx-card-title">Series</span><span class="mx-series-bo"></span></div>'
      +       '<div class="mx-series-maps"></div>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      + '</div>';
    host.insertBefore(cr, grid);
    cr.addEventListener('click', onControlRoomClick);
    cr.addEventListener('input', function (e) {
      if (onTeamPicker(e)) return;
      if (e.target.classList.contains('mx-hero-round') && typeof send === 'function') {
        clearTimeout(cr._roundT);
        cr._roundT = setTimeout(function () { send('set_round_label', { text: e.target.value }); }, 350);
      }
    });
    cr.addEventListener('keydown', function (e) { if (onTeamPicker(e)) setTimeout(renderControlRoom, 80); });
    cr.querySelector('.mx-wiz').addEventListener('click', onWizClick);
    cr.querySelector('.mx-modes').addEventListener('click', onWizClick);
    cr.querySelector('.mx-run-banner').addEventListener('click', onWizClick);
    cr.querySelector('.mx-wiz').addEventListener('change', onWizChange);
    cr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.closest && e.target.closest('.mx-obs-form')) { e.preventDefault(); connectObs(); }
    });
    cr.querySelector('.mx-kitlist').addEventListener('click', function (e) {
      var b = e.target.closest('[data-kit]');
      if (!b || b.classList.contains('is-on')) return;
      if (typeof send === 'function') send('activate_brand_kit', { id: b.getAttribute('data-kit') || null });
      Array.prototype.forEach.call(this.querySelectorAll('[data-kit]'), function (x) { x.classList.toggle('is-on', x === b); });
    });
    cr.querySelector('.mx-mode').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mode]');
      if (b && typeof setColorMode === 'function') setColorMode(b.getAttribute('data-mode'));
      setTimeout(renderControlRoom, 60);
    });
    Array.prototype.forEach.call(cr.querySelectorAll('.mx-color input'), function (inp) {
      var side = inp.closest('.mx-color').getAttribute('data-side');
      // Same live message the Match page's colour picker sends; keep that picker in step too.
      inp.addEventListener('input', function () {
        if (typeof send === 'function') send('set_team_color', { side: side, color: this.value });
        var real = $('input-color-' + side); if (real) real.value = this.value;
      });
    });
    cr.querySelector('.mx-follow').addEventListener('change', function () {
      var real = $('sgg-autofollow');
      if (real && real.checked !== this.checked) real.click();
      setTimeout(renderControlRoom, 60);
    });
  }
  function teamHTML(side) {
    return '<div class="mx-team" data-side="' + side + '"><div class="mx-team-logo"><img alt=""></div>'
      + '<div class="mx-team-text"><div class="mx-team-side"></div><button type="button" class="mx-team-name" data-cr="team" title="Change this team">' + '</button></div></div>';
  }
  function scoreHTML(side) {
    return '<div class="mx-score-col" data-side="' + side + '">'
      + '<button type="button" class="mx-ic" data-cr="score" data-side="' + side + '" data-d="1" title="Add a map win">' + svg('plus') + '</button>'
      + '<span class="mx-score-num">0</span>'
      + '<button type="button" class="mx-ic" data-cr="score" data-side="' + side + '" data-d="-1" title="Remove a map win">' + svg('minus') + '</button></div>';
  }
  function onControlRoomClick(e) {
    if (onTeamPicker(e)) { setTimeout(renderControlRoom, 80); return; }
    var b = e.target.closest('[data-cr]');
    if (b) {
      var k = b.getAttribute('data-cr');
      var d = parseInt(b.getAttribute('data-d'), 10) || 0;
      if (k === 'scene' && typeof send === 'function') { send('obs_switch_scene', { sceneName: b.getAttribute('data-scene') }); return; }
      if (k === 'team') { var te = b.closest('.mx-team'); if (te.classList.contains('is-edit')) closeTeamPickers(); else openTeamPicker(te, state() || {}); return; }
      if (k === 'bo' && typeof send === 'function') send('set_best_of', { value: parseInt(b.getAttribute('data-n'), 10) });
      else if (k === 'score' && typeof send === 'function') send('adjust_series', { side: b.getAttribute('data-side'), delta: d });
      else if (k === 'game' && typeof send === 'function') send('adjust_game_number', { delta: d });
      else if (k === 'swap') { var sw = $('btn-swap-teams'); if (sw) sw.click(); }
      else if (k === 'reset') { if (typeof confirmResetSeries === 'function') confirmResetSeries(); }
      else if (k === 'edit') openDrawer('teams') || go(ITEM.match.go);
      else if (k === 'graphics') openDrawer('graphics') || go(ITEM.graphics.go);
      else if (k === 'sponsors') openDrawer('brand') || go(ITEM.sponsors.go);
      else if (k === 'dock') openDrawer('graphics') || openDock('controls');
      else if (k === 'obs-add') addOverlaysToObs();
      else if (k === 'obs-connect') connectObs();
      else if (k === 'app') { var card = b.getAttribute('data-card'); if (!openDrawer(card)) openApp(card); }
      else if (k === 'event') openDrawer('event') || go(ITEM.event.go);
      else if (k === 'clear') { var cl = $('gfx-top-clear'); if (cl) cl.click(); }
      else if (k === 'queue-on') { var q = $('sgg-queue-enabled'); if (q && !q.checked) q.click(); }
      else if (k === 'push') pushSet(b.getAttribute('data-set'));
      else if (k === 'setup-hide') { try { localStorage.setItem(SETUP_KEY, '1'); } catch (e2) {} cr._setupSig = ''; }
      else if (k === 'setup-go') { var dest = b.getAttribute('data-go'); if (ITEM[dest]) go(ITEM[dest].go); }
      else if (k === 'off') { var src = b.__src; if (src && document.contains(src)) src.click(); }
      setTimeout(renderControlRoom, 80);
    }
  }
  function pushSet(setId) {
    if (!setId || typeof send !== 'function') return;
    var go2 = function () { send('startgg_push_set', { setId: setId }); };
    if (typeof confirmQueuePush === 'function') Promise.resolve(confirmQueuePush()).then(function (ok) { if (ok) go2(); });
    else go2();
  }
  function crVisible() { return isModern() && mxView === 'live' && activeTab() === 'principal'; }
  window.NEModernSetup = function () { go(ITEM.live.go); setCrMode('setup'); };

  function renderControlRoom() {
    if (!cr) return;
    var s = state();
    if (!s) return;
    var teams = s.teams || {}, ser = s.series || {}, obs = s.obs || {};
    var games = s.games || {}, g = games[s.activeGame] || {};
    var labels = g.teamLabels || { a: 'Blue', b: 'Orange' };
    var sig = JSON.stringify([teams.blue && teams.blue.name, teams.orange && teams.orange.name, teams.blue && teams.blue.color, teams.orange && teams.orange.color,
      ser.blue, ser.orange, s.game && s.game.number, s.bestOf, s.eventName, s.roundLabel, obs.connected, obs.currentScene, labels.a, labels.b,
      ($('preview-logo-blue') || {}).src, ($('preview-logo-orange') || {}).src]);
    if (cr._sig !== sig) {
      cr._sig = sig;
      ['blue', 'orange'].forEach(function (side) {
        var t = teams[side] || {};
        var el = cr.querySelector('.mx-team[data-side="' + side + '"]');
        var logo = $('preview-logo-' + side);
        var img = el.querySelector('img');
        if (logo && logo.src && img.src !== logo.src) img.src = logo.src;
        el.querySelector('.mx-team-name').textContent = t.name || (side === 'blue' ? 'Team A' : 'Team B');
        el.querySelector('.mx-team-side').textContent = side === 'blue' ? labels.a : labels.b;
        var col = t.color || (side === 'blue' ? '#3d8bff' : '#ff8a3d');
        el.style.setProperty('--team', col);
        var sc = cr.querySelector('.mx-score-col[data-side="' + side + '"]');
        sc.style.setProperty('--team', col);
        sc.querySelector('.mx-score-num').textContent = String(Number(ser[side]) || 0);
      });
      var bo = Number(s.bestOf) || 0;
      cr.querySelector('.mx-game').textContent = 'Game ' + ((s.game && s.game.number) || 1) + (bo ? ' of ' + bo : '');
      cr.querySelector('.mx-hero-event').textContent = s.eventName || 'No event loaded';
      var rin = cr.querySelector('.mx-hero-round');
      if (document.activeElement !== rin) rin.value = s.roundLabel || '';
      var bos = cr.querySelectorAll('.mx-hero-bo button');
      for (var bi = 0; bi < bos.length; bi++) bos[bi].classList.toggle('is-on', parseInt(bos[bi].getAttribute('data-n'), 10) === bo);
      var air = cr.querySelector('.mx-hero-air');
      air.textContent = obs.connected ? (obs.currentScene ? 'Live: ' + obs.currentScene : 'OBS connected') : 'OBS not connected';
      air.setAttribute('data-state', obs.connected ? (obs.currentScene ? 'live' : 'ok') : 'off');
    }
    renderWizard(s);
    if (crMode(s) !== 'run') return;
    renderObsStatus(s);
    renderLook(s);
    renderNext(s);
    renderAir(s);
    renderSeries(s);
  }

  // Get set up: the four things a first show needs, ticked off from live state. Each step has the
  // one button that gets it done. Disappears when everything is done, or when dismissed.
  // The two overlays a show needs: the scoreboard (live.html follows whichever game is active) and
  // the graphics layer (gfx.html carries every graphic you show). Added to the current OBS scene,
  // or updated in place if they are already there; nothing is ever removed.
  var OBS_PACK = [
    { name: 'NE Scoreboard', path: '/live.html' },
    { name: 'NE Graphics', path: '/gfx.html' }
  ];
  var OBS_ADDED_KEY = 'ne_mx_obs_added';
  function obsHasOverlays(obs) {
    var srcs = (obs && obs.sources) || [];
    var names = {};
    srcs.forEach(function (x) { if (x && x.source) names[x.source] = 1; });
    if (OBS_PACK.every(function (p) { return names[p.name]; })) return true;
    try { return !!(obs && obs.connected) && localStorage.getItem(OBS_ADDED_KEY) === '1'; } catch (e) { return false; }
  }
  function addOverlaysToObs() {
    var s = state() || {};
    if (!(s.obs && s.obs.connected)) { if (typeof showToast === 'function') showToast('Connect OBS first, then add the overlays.', '#f59e0b', 4000); return; }
    var base = (typeof SCENE_BASE_URL !== 'undefined' && SCENE_BASE_URL) || BASE;
    // Staggered so the graphics layer reliably lands above the scoreboard.
    OBS_PACK.forEach(function (p, i) { setTimeout(function () { send('obs_add_overlay', { sourceName: p.name, url: base + p.path, width: 1920, height: 1080 }); }, i * 700); });
    try { localStorage.setItem(OBS_ADDED_KEY, '1'); } catch (e) {}
    if (cr) cr._setupSig = '';
  }
  // Connect OBS without leaving the Control room. The form fills the real OBS settings fields
  // (Apps > OBS Studio) and presses their Save, so it saves and connects exactly as before.
  function obsFormHTML() {
    var slobs = (($('select-obs-app') || {}).value) === 'streamlabs';
    var ip = ($(slobs ? 'input-slobs-ip' : 'input-obs-ip') || {}).value || '127.0.0.1';
    var port = ($(slobs ? 'input-slobs-port' : 'input-obs-port') || {}).value || (slobs ? '59650' : '4455');
    var esc2 = function (v) { return String(v).replace(/[&"<>]/g, function (c) { return { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    return '<div class="mx-obs-form">'
      + '<label class="mx-obs-app"><span>App</span><select class="mx-obs-appsel"><option value="obs"' + (slobs ? '' : ' selected') + '>OBS Studio</option><option value="streamlabs"' + (slobs ? ' selected' : '') + '>Streamlabs Desktop</option></select></label>'
      + '<label><span>Address</span><input type="text" class="mx-obs-ip" value="' + esc2(ip) + '" spellcheck="false"></label>'
      + '<label><span>Port</span><input type="number" class="mx-obs-port" value="' + esc2(port) + '" min="1" max="65535"></label>'
      + '<label class="mx-obs-pw"><span>' + (slobs ? 'API token' : 'Password') + '</span><input type="password" class="mx-obs-password" placeholder="' + (slobs ? 'Settings &gt; Remote Control' : 'From Show Connect Info') + '" autocomplete="off"></label>'
      + '<button type="button" class="mx-btn mx-btn-primary" data-cr="obs-connect">Connect</button>'
      + '<p class="mx-obs-status"></p></div>';
  }
  function connectObs() {
    var f = cr.querySelector('.mx-obs-form');
    if (!f) return;
    var set = function (id, v) { var e = $(id); if (e && v != null) e.value = v; };
    var slobs = f.querySelector('.mx-obs-appsel').value === 'streamlabs';
    set('select-obs-app', slobs ? 'streamlabs' : 'obs');
    set(slobs ? 'input-slobs-ip' : 'input-obs-ip', f.querySelector('.mx-obs-ip').value.trim() || '127.0.0.1');
    set(slobs ? 'input-slobs-port' : 'input-obs-port', f.querySelector('.mx-obs-port').value.trim() || (slobs ? '59650' : '4455'));
    var pw = f.querySelector('.mx-obs-password').value;
    if (pw) set(slobs ? 'input-slobs-token' : 'input-obs-password', pw);
    var en = $('check-obs-enabled');
    if (en && !en.checked) en.checked = true;
    var save = $('btn-obs-save');
    if (save) save.click();
    var st = f.querySelector('.mx-obs-status');
    if (st) { st.textContent = 'Connecting to ' + (slobs ? 'Streamlabs' : 'OBS') + '...'; st.setAttribute('data-state', 'warn'); }
    obsTried = Date.now();
  }
  var obsTried = 0;
  // Switching app in the quick form swaps the default port and what the secret is called.
  document.addEventListener('change', function (e) {
    var sel = e.target && e.target.closest && e.target.closest('.mx-obs-appsel');
    if (!sel) return;
    var f = sel.closest('.mx-obs-form'), slobs = sel.value === 'streamlabs';
    var port = f.querySelector('.mx-obs-port');
    if (port && (port.value === '4455' || port.value === '59650' || !port.value)) port.value = slobs ? '59650' : '4455';
    var lbl = f.querySelector('.mx-obs-pw span'), pw = f.querySelector('.mx-obs-password');
    if (lbl) lbl.textContent = slobs ? 'API token' : 'Password';
    if (pw) pw.placeholder = slobs ? 'Settings > Remote Control' : 'From Show Connect Info';
  });
  function renderObsStatus(s) {
    var st = cr.querySelector('.mx-obs-status');
    if (!st) return;
    var obs = s.obs || {};
    var slobs = obs.app === 'streamlabs', app = slobs ? 'Streamlabs' : 'OBS';
    if (obs.connected) { st.textContent = 'Connected to ' + app + '.'; st.setAttribute('data-state', 'ok'); }
    else if (obs.lastError && obsTried) { st.textContent = 'Could not connect: ' + obs.lastError + (slobs ? '' : '. Check OBS is open and the password matches.'); st.setAttribute('data-state', 'bad'); }
    else if (obs.enabled && obsTried) { st.textContent = 'Connecting to ' + app + '...'; st.setAttribute('data-state', 'warn'); }
  }

  // Open an app's settings card on the Apps page (OBS, Twitch...).
  function openApp(card) {
    go(ITEM.market.go);
    setTimeout(function () { var c = document.querySelector('.int-card[data-card="' + card + '"]'); if (c) c.click(); }, 60);
  }
  function openDock(tab) {
    tab = dockTab(tab);
    var t = document.querySelector('#qrail-tabs .qrail-tab[data-qtab="' + tab + '"]');
    if (!t) return;
    if (!dockOpen() || !t.classList.contains('active')) t.click();
    setTimeout(refresh, 30);
  }

  // Look: the live brand kit, which colours the overlays use, and each team's own colour.
  var MODE_NOTE = {
    brand: 'The overlays use the brand kit colours right now.',
    'default': 'The overlays use the game standard colours right now.',
    game: 'The overlays use the in-game colours right now.'
  };
  function renderLook(s) {
    var kits = Array.isArray(s.brandKits) ? s.brandKits : [];
    var mode = s.colorMode || 'team';
    var teams = s.teams || {};
    var own = function (side) { var t = teams[side] || {}; return t.ownColor || t.color || (side === 'blue' ? '#3d8bff' : '#ff8a3d'); };
    var sig = JSON.stringify([kits.map(function (k) { return [k.id, k.name, k.logo ? k.logo.length + k.logo.slice(-24) : '', k.color, k.accent, k.activePackageId, (k.packages || []).map(function (p) { return (p.sponsors || []).length; })]; }), s.activeBrandKitId, mode, own('blue'), own('orange'),
      teams.blue && teams.blue.color, teams.orange && teams.orange.color, teams.blue && teams.blue.name, teams.orange && teams.orange.name]);
    var look = cr.querySelector('.mx-look');
    if (look._sig === sig) return;
    look._sig = sig;
    // Brand kits as a list you can read at a glance: logo, name, colours, sponsor count. The live
    // one is ticked; a click switches the overlays to that kit.
    var list = cr.querySelector('.mx-kitlist');
    var initials = function (n) { return String(n || '?').trim().split(/s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?'; };
    var kitRow = function (k) {
      var on = k ? k.id === s.activeBrandKitId : !s.activeBrandKitId;
      var b = mk('button', 'mx-kitrow' + (on ? ' is-on' : '') + (k ? '' : ' mx-kitrow--none'));
      b.type = 'button';
      b.setAttribute('data-kit', k ? k.id : '');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      var ico = mk('span', 'mx-kitrow-ico');
      if (k && k.logo) { var im = document.createElement('img'); im.alt = ''; im.src = k.logo; ico.appendChild(im); }
      else { ico.textContent = k ? initials(k.name) : ''; if (k && k.color) ico.style.background = k.color; }
      var txt = mk('span', 'mx-kitrow-t');
      txt.appendChild(mk('b', '', k ? (k.name || 'Untitled kit') : 'No brand kit'));
      // Sponsors live in the kit's packages; the active package is what is on air.
      var pkgs = k && Array.isArray(k.packages) ? k.packages : [];
      var pkg = pkgs.find(function (p) { return p && p.id === k.activePackageId; }) || pkgs[0] || null;
      var n = pkg ? (pkg.sponsors || []).length : (k ? (k.sponsors || []).length : 0);
      var sub = k ? (n ? n + ' sponsor' + (n === 1 ? '' : 's') : 'No sponsors') + (pkgs.length > 1 && pkg ? ' · ' + (pkg.name || 'package') : '') : 'The default look';
      txt.appendChild(mk('span', '', sub));
      b.appendChild(ico); b.appendChild(txt);
      if (k) {
        var sw = mk('span', 'mx-kitrow-sw');
        [k.color, k.accent].filter(Boolean).forEach(function (c) { var i = document.createElement('i'); i.style.background = c; i.title = c; sw.appendChild(i); });
        b.appendChild(sw);
      }
      b.appendChild(mk('span', 'mx-kitrow-check'));
      return b;
    };
    list.textContent = '';
    kits.forEach(function (k) { list.appendChild(kitRow(k)); });
    list.appendChild(kitRow(null));
    list.classList.toggle('is-long', kits.length > 4);
    Array.prototype.forEach.call(cr.querySelectorAll('.mx-mode [data-mode]'), function (b) { b.classList.toggle('is-on', b.getAttribute('data-mode') === mode); });
    var lock = mode !== 'team';
    ['blue', 'orange'].forEach(function (side) {
      var lab = cr.querySelector('.mx-color[data-side="' + side + '"]');
      var inp = lab.querySelector('input');
      if (document.activeElement !== inp) inp.value = /^#[0-9a-f]{6}$/i.test(own(side)) ? own(side) : '#3d8bff';
      inp.disabled = lock;
      lab.classList.toggle('is-locked', lock);
      lab.querySelector('b').textContent = (teams[side] && teams[side].name) || (side === 'blue' ? 'Team A' : 'Team B');
      lab.style.setProperty('--sw', (teams[side] && teams[side].color) || own(side));
    });
    cr.querySelector('.mx-color-hint').textContent = lock
      ? (MODE_NOTE[mode] || '') + ' Pick Teams to use these.'
      : 'Changes show on stream straight away.';
  }

  var SETUP_KEY = 'ne_mx_setup_hidden';
  function renderSetup(s) {
    var box = cr.querySelector('.mx-setup');
    var hidden = true;
    var obs = s.obs || {}, sg = s.startgg || {}, tw = s.twitch || {};
    var overlaysIn = obsHasOverlays(obs);
    var steps = [
      swName(s) === 'vMix'
        ? { done: obsLinked(s), title: 'Connect vMix', text: 'Turn on the Web Controller in vMix (Settings), then connect it here.', btn: 'Set up vMix', act: 'app', card: 'obs' }
        : { done: !!obs.connected, title: 'Connect ' + swName(s), text: swName(s) === 'Streamlabs' ? 'In Streamlabs open Settings, Remote Control, and copy the API token from Show details.' : 'In OBS open Tools, WebSocket Server Settings, tick Enable, then click Show Connect Info for the password.', form: 'obs' },
      { done: eventLoaded(s), title: 'Load your event', text: 'Pull in the teams, the bracket and the matches on your stream.', btn: 'Load an event', go: 'event' },
      { done: overlaysIn, title: 'Add the overlays to ' + swName(s), text: obsLinked(s) ? 'One click adds the scoreboard and the graphics layer to your current scene.' : 'Connect ' + swName(s) + ' first, then this is one click.', btn: 'Add to ' + swName(s), act: 'obs-add', disabled: !obsLinked(s) },
      { done: !!tw.connected, title: 'Connect Twitch (optional)', text: 'Stream title, chat, predictions and viewer stats.', btn: 'Connect Twitch', act: 'app', card: 'twitch' }
    ];
    var left = steps.filter(function (x) { return !x.done; }).length;
    var show = !hidden && left > 0;
    var sig = show + '|' + !!obs.connected + '|' + swName(s) + '|' + steps.map(function (x) { return x.done ? 1 : 0; }).join('');
    if (cr._setupSig === sig) return;
    cr._setupSig = sig;
    box.hidden = !show;
    if (!show) return;
    cr.querySelector('.mx-setup-count').textContent = (steps.length - left) + ' of ' + steps.length + ' done';
    var host = cr.querySelector('.mx-setup-steps');
    host.textContent = '';
    steps.forEach(function (st, i) {
      var row = mk('div', 'mx-step' + (st.done ? ' is-done' : ''));
      row.innerHTML = '<span class="mx-step-n">' + (st.done ? '' : (i + 1)) + '</span><div class="mx-step-text"><b></b><span></span></div>'
        + (st.done ? '<span class="mx-step-ok">Done</span>'
           : st.form === 'obs' ? obsFormHTML()
           : '<button type="button" class="mx-btn mx-btn-sm" data-cr="setup-go"></button>');
      if (st.form === 'obs' && !st.done) row.classList.add('mx-step--wide');
      row.querySelector('b').textContent = st.title;
      row.querySelector('.mx-step-text span').textContent = st.text;
      var bt = row.querySelector('[data-cr="setup-go"]');
      if (bt) {
        bt.textContent = st.btn;
        if (st.act) bt.setAttribute('data-cr', st.act);
        if (st.go) bt.setAttribute('data-go', st.go);
        if (st.card) bt.setAttribute('data-card', st.card);
        if (st.disabled) bt.disabled = true;
      }
      host.appendChild(row);
    });
  }

  // Up next: the stream queue, as cards. Same filter as the rail (the producer's chosen stream).
  function renderNext(s) {
    var host = cr.querySelector('.mx-next-list');
    var sg = s.startgg || {};
    var queue = Array.isArray(sg.queue) ? sg.queue : [];
    var streamSel = $('sgg-stream');
    var want = (streamSel && streamSel.value) || '';
    var rows = queue.filter(function (m) { return !want || m.stream === want; });
    var follow = $('sgg-autofollow');
    var fb = cr.querySelector('.mx-follow');
    if (follow && fb && document.activeElement !== fb) fb.checked = !!follow.checked;
    var queueOn = !!($('sgg-queue-enabled') || {}).checked;
    var hasEvent = eventLoaded(s);
    cr.querySelector('.mx-next-src').textContent = want ? 'Stream: ' + want : (hasEvent ? ((sg.selectedEvent && (sg.selectedEvent.tournamentName || sg.selectedEvent.name)) || '') : '');
    var sig = JSON.stringify([rows.map(function (m) { return [m.setId, m.teamA, m.teamB, m.round, m.live, m.state, m.onStream, m.scoreA, m.scoreB]; }), sg.lastPushedSetId, queueOn, hasEvent]);
    if (host._sig === sig) return;
    host._sig = sig;
    host.textContent = '';
    if (!rows.length) {
      var empty = mk('div', 'mx-empty-state');
      if (!hasEvent) {
        empty.innerHTML = '<b>No event loaded</b><span>Load your tournament and its upcoming matches show up here, ready to put on air.</span>'
          + '<button type="button" class="mx-btn" data-cr="event">' + svg('event') + 'Load an event</button>';
      } else if (!queueOn) {
        empty.innerHTML = '<b>The stream queue is off</b><span>Turn it on to see the matches start.gg has lined up for your stream.</span>'
          + '<button type="button" class="mx-btn" data-cr="queue-on">' + svg('refresh') + 'Turn on the queue</button>';
      } else {
        empty.innerHTML = '<b>Nothing queued yet</b><span>When the tournament assigns matches to your stream they appear here.</span>';
      }
      host.appendChild(empty);
      return;
    }
    rows.slice(0, 8).forEach(function (m, i) {
      var onDeck = !m.live && m.state !== 3 && m.onStream;
      var status = m.live ? 'live' : (m.state === 3 ? 'done' : (onDeck ? 'deck' : 'next'));
      var onAir = m.setId === sg.lastPushedSetId;
      var card = mk('div', 'mx-match mx-match--' + status + (onAir ? ' is-onair' : ''));
      var badge = { live: 'Live', done: 'Finished', deck: 'On deck', next: i === 0 ? 'Next' : 'Later' }[status];
      var score = (m.scoreA != null || m.scoreB != null) ? '<span class="mx-match-score">' + (m.scoreA == null ? 0 : m.scoreA) + ' - ' + (m.scoreB == null ? 0 : m.scoreB) + '</span>' : '';
      card.innerHTML = '<span class="mx-match-badge"></span>'
        + '<div class="mx-match-teams"><span class="mx-match-team"><img alt=""><b></b></span><span class="mx-match-vs">vs</span><span class="mx-match-team"><img alt=""><b></b></span>' + score + '</div>'
        + '<span class="mx-match-round"></span>'
        + (onAir ? '<span class="mx-match-onair">Loaded</span>'
                 : '<button type="button" class="mx-btn mx-btn-sm" data-cr="push" title="Put these two teams on the scoreboard">Load match</button>');
      card.querySelector('.mx-match-badge').textContent = badge;
      var names = card.querySelectorAll('.mx-match-team b'), imgs = card.querySelectorAll('.mx-match-team img');
      names[0].textContent = m.teamA || 'TBD'; names[1].textContent = m.teamB || 'TBD';
      if (m.logoA) imgs[0].src = m.logoA; else imgs[0].remove();
      if (m.logoB) imgs[1].src = m.logoB; else imgs[1].remove();
      card.querySelector('.mx-match-round').textContent = m.round || '';
      var pb = card.querySelector('[data-cr="push"]');
      if (pb) pb.setAttribute('data-set', m.setId);
      host.appendChild(card);
    });
  }

  // On air now: the program scene plus every graphic that is live, each with a Take off button that
  // presses the On Air rail's chip (so configurable graphics behave exactly as they do there).
  function renderAir(s) {
    var obs = s.obs || {};
    var pg = cr.querySelector('.mx-pgm');
    var sv = pg.querySelector('.mx-pgm-v');
    var cur = obs.connected ? (obs.currentScene || '') : '';
    sv.textContent = obs.connected ? (cur || 'No scene selected') : swName(s) + ' is not connected';
    pg.setAttribute('data-state', cur ? 'live' : 'off');
    // Every scene as a chip; click cuts program. Scenes hidden on the dock's Program rail stay hidden here.
    var scHost = cr.querySelector('.mx-pgm-scenes');
    var hidden = (typeof _progHidden !== 'undefined' && _progHidden && _progHidden.has) ? _progHidden : null;
    var scenes = obs.connected ? (obs.availableScenes || []).filter(function (n) { return !/^═/.test(n) && !(hidden && hidden.has(n)); }) : [];
    var scSig = scenes.join('|') + '#' + cur;
    if (scHost._sig !== scSig) {
      scHost._sig = scSig;
      scHost.textContent = '';
      scenes.forEach(function (n) {
        var b = mk('button', 'mx-pgm-chip' + (n === cur ? ' is-on' : ''));
        b.type = 'button';
        b.setAttribute('data-cr', 'scene');
        b.setAttribute('data-scene', n);
        b.textContent = n;
        b.title = n === cur ? 'On program now' : 'Cut program to ' + n;
        scHost.appendChild(b);
      });
      scHost.hidden = !scenes.length;
    }
    var host = cr.querySelector('.mx-air-list');
    var wrap = $('qk-put');
    var items = [];
    if (wrap) {
      var chips = wrap.querySelectorAll('.qk-chip.on:not(.qk-chip--scene)');
      for (var i = 0; i < chips.length; i++) {
        var main = chips[i].querySelector('.qk-chip-main');
        if (main) items.push({ label: cleanLabel(main.textContent), src: main });
      }
    }
    var sig = items.map(function (x) { return x.label; }).join('|');
    if (host._sig === sig) { relink(host, items); return; }
    host._sig = sig;
    host.textContent = '';
    if (!items.length) { host.appendChild(mk('p', 'mx-air-empty', 'No graphics showing.')); return; }
    items.forEach(function (it) {
      var row = mk('div', 'mx-air-item');
      row.innerHTML = '<span class="mx-air-item-dot"></span><span class="mx-air-item-label"></span><button type="button" class="mx-link" data-cr="off">Hide</button>';
      row.querySelector('.mx-air-item-label').textContent = it.label;
      row.querySelector('[data-cr="off"]').__src = it.src;
      host.appendChild(row);
    });
  }
  // The rail re-renders its chips; keep each Take off button pointing at the current element.
  function relink(host, items) {
    var btns = host.querySelectorAll('[data-cr="off"]');
    for (var i = 0; i < btns.length && i < items.length; i++) btns[i].__src = items[i].src;
  }

  // Series: the maps played so far with their scores (from Match / Graphics ▸ Map Pool).
  function renderSeries(s) {
    var maps = ((s.match && s.match.maps) || []).filter(function (m) { return m && (m.name || m.played || m.scoreA || m.scoreB); });
    var bo = Number(s.bestOf) || 0;
    cr.querySelector('.mx-series-bo').textContent = bo ? 'Best of ' + bo : '';
    var host = cr.querySelector('.mx-series-maps');
    var teams = s.teams || {};
    var sig = JSON.stringify([maps, teams.blue && teams.blue.color, teams.orange && teams.orange.color]);
    if (host._sig === sig) return;
    host._sig = sig;
    host.textContent = '';
    if (!maps.length) {
      host.appendChild(mk('p', 'mx-air-empty', 'No maps yet. Add them under Graphics > Map Pool and the scores show here.'));
      return;
    }
    maps.forEach(function (m, i) {
      var a = Number(m.scoreA), b = Number(m.scoreB);
      var done = m.played || (!isNaN(a) && !isNaN(b) && (a || b));
      var win = done ? (a > b ? 'blue' : (b > a ? 'orange' : '')) : '';
      var row = mk('div', 'mx-map' + (done ? ' is-done' : ''));
      row.innerHTML = '<span class="mx-map-n">' + (i + 1) + '</span><span class="mx-map-name"></span><span class="mx-map-score"></span>';
      row.querySelector('.mx-map-name').textContent = m.name || 'Map ' + (i + 1);
      row.querySelector('.mx-map-score').textContent = done ? (isNaN(a) ? 0 : a) + ' - ' + (isNaN(b) ? 0 : b) : 'To play';
      if (win) row.style.setProperty('--win', (teams[win] && teams[win].color) || (win === 'blue' ? '#3d8bff' : '#ff8a3d'));
      host.appendChild(row);
    });
  }

  // ── Deck: tag each pad with its type so the Modern stylesheet can draw a proper icon ────────
  function tagDeck() {
    var grid = $('dash-deck-grid');
    var deck = window._deck;
    if (!grid || !deck || !Array.isArray(deck.buttons)) return;
    var byId = {};
    deck.buttons.forEach(function (b) { byId[b.id] = b; });
    var tiles = grid.querySelectorAll('.deck-tile[data-id]');
    for (var i = 0; i < tiles.length; i++) {
      var b = byId[tiles[i].getAttribute('data-id')];
      if (b && tiles[i].getAttribute('data-type') !== b.type) tiles[i].setAttribute('data-type', b.type);
    }
  }

  // ── Match page ───────────────────────────────────────────────────────────────────────────
  // The score lives in the Control room, so the Match page is pure setup: the two team cards, then
  // Match details (best of, round, match label, team record). Best of used to sit inside the score
  // column; it gets its own control here (same set_best_of message). The round / label / record
  // panel was hidden behind a gear; Modern shows it as a card.
  var matchHead = null;
  function buildMatchExtras() {
    var panel = $('match-settings-panel');
    if (!panel || matchHead) return;
    matchHead = mk('div', 'mx-only mx-match-head');
    matchHead.innerHTML = '<div><h3 class="section-title">Match details</h3>'
      + '<p class="section-desc">How the match is described on the overlays.</p></div>'
      + '<div class="mx-field mx-bo"><span>Best of</span><div class="mx-seg">'
      + [1, 3, 5, 7].map(function (n) { return '<button type="button" data-bo="' + n + '">' + n + '</button>'; }).join('')
      + '</div></div>';
    panel.parentNode.insertBefore(matchHead, panel);
    matchHead.addEventListener('click', function (e) {
      var b = e.target.closest('[data-bo]');
      if (b && typeof send === 'function') send('set_best_of', { value: parseInt(b.getAttribute('data-bo'), 10) });
      setTimeout(renderMatchExtras, 80);
    });
  }
  // A team card whose name was edited but not applied gets a clear "not on the overlay yet" state,
  // so nobody wonders why the scoreboard still shows the old name.
  function renderDirtyTeams(s) {
    ['blue', 'orange'].forEach(function (side) {
      var inp = $('input-name-' + side);
      var card = inp && inp.closest('.team-card');
      if (!card) return;
      var shown = String(((s.teams || {})[side] || {}).name || '').trim().toUpperCase();
      var typed = String(inp.value || '').trim().toUpperCase();
      var dirty = !!typed && typed !== shown;
      card.classList.toggle('mx-dirty', dirty);
      var acts = card.querySelector('.team-card-actions');
      var note = acts && acts.querySelector('.mx-dirty-note');
      if (acts && !note) {
        note = mk('span', 'mx-only mx-dirty-note', 'Not on the overlay yet');
        acts.insertBefore(note, acts.firstChild);
      }
    });
  }
  function renderMatchExtras() {
    if (!matchHead) return;
    var s = state() || {};
    renderDirtyTeams(s);
    var bo = Number(s.bestOf) || 0;
    Array.prototype.forEach.call(matchHead.querySelectorAll('[data-bo]'), function (b) {
      b.classList.toggle('is-on', Number(b.getAttribute('data-bo')) === bo);
    });
  }

  // ── Event page: three plain steps ──────────────────────────────────────────────────────────
  // The match source panel reads as one long form. Modern labels it as the order you do it in:
  // where the tournament is, find it, then the matches on your stream.
  var evSteps = false;
  function buildEventSteps() {
    if (evSteps) return;
    var tabs = $('ev-platform-tabs');
    var firstPanel = document.querySelector('[data-dash-id="event"] .ev-plat-panel');
    var queue = $('ev-queue-block');
    if (!tabs || !firstPanel || !queue) return;
    evSteps = true;
    var head = function (n, title, sub) {
      var h = mk('div', 'mx-only mx-evstep mx-evstep-' + n);
      h.innerHTML = '<i class="mx-evstep-n">' + n + '</i><p class="mx-evstep-body"><strong class="mx-evstep-t"></strong><em class="mx-evstep-d"></em></p>';
      h.querySelector('.mx-evstep-t').textContent = title;
      h.querySelector('.mx-evstep-d').textContent = sub;
      return h;
    };
    tabs.parentNode.insertBefore(head(1, 'Another platform', 'Your bracket is on start.gg, Challonge, FACEIT, NXGEN or Challengermode, or your schedule is in a Google Sheet: pick it here.'), tabs);
    firstPanel.parentNode.insertBefore(head(2, 'Find your event', 'Search by name or paste the tournament link, then Load event.'), firstPanel);
    queue.parentNode.insertBefore(head(3, 'Matches on your stream', 'Turn on the queue to see what is coming up. Auto-follow loads each match for you as it goes live.'), queue);
  }

  document.addEventListener('input', function (e) {
    if (isModern() && mxView === 'match' && e.target && /^input-name-(blue|orange)$/.test(e.target.id || '')) renderDirtyTeams(state() || {});
  }, true);

  // ── Show setup: a guided walkthrough for each event ───────────────────────────────────────
  // The Control room has two modes. "Set up the show" walks a first-time producer through every
  // thing a broadcast needs, in order, with the controls right there (or one click away): pick a
  // template, game and look, the event and its stream queue, the teams, the desk, OBS, the stream
  // and the starting-soon countdown, then save it all as a template for next time. "Run the show"
  // is the live cockpit. Every control drives an existing message or the real element, so it
  // behaves exactly like the page it came from.
  var CR_MODE_KEY = 'ne_mx_cr_mode', WIZ_STEP_KEY = 'ne_mx_wiz_step', WIZ_FLAG_KEY = 'ne_mx_wiz_flags';
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function wizFlags() { try { return JSON.parse(lsGet(WIZ_FLAG_KEY, '{}')) || {}; } catch (e) { return {}; } }
  function setWizFlag(k) { var f = wizFlags(); f[k] = 1; lsSet(WIZ_FLAG_KEY, JSON.stringify(f)); }
  var PLACEHOLDER_TEAM = /^(|tbd|blue team|orange team|team a|team b)$/i;
  function teamSet(s, side) { var n = String((((s.teams || {})[side]) || {}).name || '').trim(); return !PLACEHOLDER_TEAM.test(n); }
  function eventLoaded(s) {
    var sg = s.startgg || {};
    return !!(sg.selectedEvent || (s.activeEvent && s.activeEvent.slug));
  }
  var SCENE_KEYS = [
    ['inGame', 'Gameplay', 'The match itself, with the scoreboard'],
    ['casters', 'Casters', 'The desk / caster cameras'],
    ['break', 'Break', 'Between games, with the countdown'],
    ['replay', 'Replay', 'Instant replays'],
    ['postGame', 'After the game', 'Stats and winner after a game'],
    ['commercial', 'Ad break', 'Plays while an ad runs'],
    ['bracket', 'Bracket', 'The tournament bracket']
  ];
  var WIZ = [
    { id: 'template', title: 'Template', sub: 'Start from a saved show', optional: true,
      done: function (s, f) { return !!f.template; } },
    { id: 'look', title: 'Game and look', sub: 'Game, brand kit and colours',
      done: function (s) { return !!s.activeGame; } },
    { id: 'event', title: 'Event', sub: 'Name and tournament',
      done: function (s) { return !!String(s.eventName || '').trim(); } },
    { id: 'teams', title: 'Teams', sub: 'Who is playing and the format',
      done: function (s) { return teamSet(s, 'blue') && teamSet(s, 'orange'); } },
    { id: 'talent', title: 'Talent', sub: 'Casters on the desk', optional: true,
      done: function (s) { var c = s.casters || {}; return ((c.list || []).length + (c.lineup || []).length) > 0; } },
    { id: 'obs', title: 'Streaming software', sub: 'Connect, overlays and scenes',
      done: function (s) { var o = s.obs || {}; return swName(s) === 'vMix' ? obsLinked(s) : (!!o.connected && obsHasOverlays(o)); } },
    { id: 'stream', title: 'Stream', sub: 'Twitch and stream title', optional: true,
      done: function (s) { return !!(s.twitch && s.twitch.connected); } },
    { id: 'countdown', title: 'Starting soon', sub: 'Countdown before you go live', optional: true,
      done: function (s, f) { return !!(s.breakScreen && s.breakScreen.visible) || !!f.countdown; } },
    { id: 'finish', title: 'Ready', sub: 'Save as a template, then go live',
      done: function (s, f) { return !!f.finish; } }
  ];
  function wizProgress(s) {
    var f = wizFlags(), req = WIZ.filter(function (w) { return !w.optional && w.id !== 'finish'; });
    var done = req.filter(function (w) { return w.done(s, f); }).length;
    return { done: done, total: req.length, complete: done === req.length };
  }
  function crMode(s) {
    var m = lsGet(CR_MODE_KEY, '');
    if (m === 'setup' || m === 'run') return m;
    return s && wizProgress(s).complete ? 'run' : 'setup';
  }
  function setCrMode(m) { lsSet(CR_MODE_KEY, m); if (cr) { cr._wizSig = ''; cr._modeSig = ''; } renderControlRoom(); var sc = $('tab-scroll'); if (sc) sc.scrollTop = 0; }
  function wizStep() { var id = lsGet(WIZ_STEP_KEY, 'template'); return WIZ.some(function (w) { return w.id === id; }) ? id : 'template'; }
  function setWizStep(id) { lsSet(WIZ_STEP_KEY, id); if (cr) cr._wizSig = ''; renderControlRoom(); }
  function nextStep() { var i = WIZ.map(function (w) { return w.id; }).indexOf(wizStep()); if (i < WIZ.length - 1) setWizStep(WIZ[i + 1].id); }

  function wizHTML() {
    return '<div class="mx-modes" role="tablist">'
      + '<button type="button" data-wz="mode" data-m="setup">' + svg('show') + '<span>Set up the show</span><em class="mx-modes-count"></em></button>'
      + '<button type="button" data-wz="mode" data-m="run">' + svg('live') + '<span>Run the show</span></button>'
      + '</div>'
      + '<div class="mx-run-banner" hidden><span></span><button type="button" class="mx-link" data-wz="mode" data-m="setup">Finish setup</button></div>'
      + '<section class="mx-wiz"><nav class="mx-wiz-steps"></nav><div class="mx-wiz-body"></div></section>';
  }

  function primeWizardPickers(s) {
    var tps = cr.querySelectorAll('.mx-wz-team .mx-tp');
    for (var i = 0; i < tps.length; i++) if (!tps[i].querySelector('.mx-tp-list').childNodes.length) renderTeamList(tps[i], s);
  }
  function renderWizard(s) {
    var mode = crMode(s);
    var prog = wizProgress(s);
    var modeSig = mode + '|' + prog.done;
    if (cr._modeSig !== modeSig) {
      cr._modeSig = modeSig;
      cr.setAttribute('data-mode', mode);
      Array.prototype.forEach.call(cr.querySelectorAll('.mx-modes [data-m]'), function (b) { b.classList.toggle('is-on', b.getAttribute('data-m') === mode); });
      cr.querySelector('.mx-modes-count').textContent = prog.complete ? 'Ready' : prog.done + ' of ' + prog.total;
      var ban = cr.querySelector('.mx-run-banner');
      ban.hidden = !(mode === 'run' && !prog.complete);
      ban.querySelector('span').textContent = 'Setup is ' + prog.done + ' of ' + prog.total + ' done. Some things may not show on stream yet.';
    }
    if (mode !== 'setup') return;
    var f = wizFlags(), cur = wizStep();
    var listSig = cur + '|' + WIZ.map(function (w) { return w.done(s, f) ? 1 : 0; }).join('');
    var nav = cr.querySelector('.mx-wiz-steps');
    if (nav._sig !== listSig) {
      nav._sig = listSig;
      nav.textContent = '';
      WIZ.forEach(function (w, i) {
        var d = w.done(s, f);
        var b = mk('button', 'mx-wiz-step' + (w.id === cur ? ' is-current' : '') + (d ? ' is-done' : ''));
        b.type = 'button';
        b.setAttribute('data-wz', 'goto');
        b.setAttribute('data-step', w.id);
        b.innerHTML = '<span class="mx-wiz-n">' + (d ? '' : (i + 1)) + '</span><span class="mx-wiz-t"><b></b><i></i></span>';
        b.querySelector('b').textContent = w.title;
        b.querySelector('i').textContent = d ? 'Done' : (w.optional ? 'Optional' : w.sub);
        nav.appendChild(b);
      });
    }
    var body = cr.querySelector('.mx-wiz-body');
    // Never rebuild a panel under the producer's cursor: typing into it would be lost.
    if (body.contains(document.activeElement) && document.activeElement !== body && cr._wizStepShown === cur) { wizLive(s, body); return; }
    var sig = cur + '|' + wizPanelSig(cur, s);
    if (cr._wizSig === sig) { wizLive(s, body); return; }
    cr._wizSig = sig;
    cr._wizStepShown = cur;
    body.innerHTML = wizPanel(cur, s);
    if (cur === 'teams') primeWizardPickers(s);
    wizLive(s, body);
  }

  // What each panel's markup depends on (rebuild only when that changes).
  function wizPanelSig(id, s) {
    var o = s.obs || {}, sg = s.startgg || {}, c = s.casters || {};
    switch (id) {
      case 'template': return JSON.stringify(s.presets || []);
      case 'look': return JSON.stringify([s.activeGame, Object.keys(s.games || {}).length, (s.brandKits || []).map(function (k) { return [k.id, k.name, !!k.logo]; }), s.activeBrandKitId, s.colorMode]);
      case 'event': return JSON.stringify([eventLoaded(s), sg.selectedEvent && sg.selectedEvent.name, sg.queueEnabled, sg.autoFollow, sg.streamName, sg.streams]);
      case 'teams': return JSON.stringify([teams2(s), s.bestOf, (sg.queue || []).length]);
      case 'talent': return JSON.stringify([(c.list || []).map(function (x) { return x && x.name; }), (c.lineup || []).length, (c.rooms || []).length]);
      case 'obs': return JSON.stringify([o.connected, obsHasOverlays(o), o.availableScenes, o.scenes]);
      case 'stream': return JSON.stringify([s.twitch && s.twitch.connected, s.twitch && s.twitch.username, s.matchTitles && s.matchTitles.twitch && s.matchTitles.twitch.auto]);
      case 'countdown': return JSON.stringify([s.breakScreen && s.breakScreen.visible]);
      default: return '';
    }
  }
  function teams2(s) { var t = s.teams || {}; return [(t.blue || {}).name, (t.orange || {}).name]; }
  function h(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function panelHead(title, text) { return '<header class="mx-wp-head"><h2>' + h(title) + '</h2><p>' + h(text) + '</p></header>'; }
  function navRow(back) {
    return '<footer class="mx-wp-foot">' + (back ? '<button type="button" class="mx-btn mx-btn-quiet" data-wz="back">Back</button>' : '<span></span>')
      + '<button type="button" class="mx-btn mx-btn-primary" data-wz="next">Next step</button></footer>';
  }

  function wizPanel(id, s) {
    var o = s.obs || {}, sg = s.startgg || {};
    if (id === 'template') {
      var ps = Array.isArray(s.presets) ? s.presets : [];
      var games = s.games || {};
      return panelHead('Start from a template', 'A template remembers the game, event name, best of, ticker, banner and casters from a show you ran before. Pick one, or start fresh.')
        + '<div class="mx-tiles">'
        + '<button type="button" class="mx-tile mx-tile--fresh" data-wz="fresh"><b>Start fresh</b><span>Set everything up step by step</span></button>'
        + ps.map(function (p) { return '<button type="button" class="mx-tile" data-wz="preset" data-id="' + h(p.id) + '"><b>' + h(p.name) + '</b><span>' + h((games[p.game] && games[p.game].name) || p.game || '') + '</span></button>'; }).join('')
        + '</div>'
        + (ps.length ? '' : '<p class="mx-hint">No templates yet. At the end of setup you can save this show as one.</p>');
    }
    if (id === 'look') {
      var gs = s.games || {};
      var kits = Array.isArray(s.brandKits) ? s.brandKits : [];
      var mode = s.colorMode || 'team';
      return panelHead('Game and look', 'Pick the game you are broadcasting, then the brand kit that styles the overlays: colours, logo and sponsors.')
        + '<h3 class="mx-wp-sub">Game</h3><div class="mx-tiles mx-tiles--games">'
        + Object.keys(gs).map(function (k) { var g = gs[k]; return '<button type="button" class="mx-tile mx-tile--game' + (k === s.activeGame ? ' is-on' : '') + '" data-wz="game" data-id="' + h(k) + '">' + (g.logo ? '<img alt="" src="../assets/' + h(g.logo) + '">' : '') + '<b>' + h(g.name || k) + '</b></button>'; }).join('')
        + '</div>'
        + '<h3 class="mx-wp-sub">Brand kit</h3><div class="mx-tiles">'
        + '<button type="button" class="mx-tile' + (!s.activeBrandKitId ? ' is-on' : '') + '" data-wz="kit" data-id=""><b>No brand kit</b><span>Use the default look</span></button>'
        + kits.map(function (k) { return '<button type="button" class="mx-tile' + (k.id === s.activeBrandKitId ? ' is-on' : '') + '" data-wz="kit" data-id="' + h(k.id) + '">' + (k.logo ? '<img alt="" src="' + h(k.logo) + '">' : '') + '<b>' + h(k.name || 'Untitled kit') + '</b><span>' + ((k.sponsors || []).length || 0) + ' sponsors</span></button>'; }).join('')
        + '<button type="button" class="mx-tile mx-tile--add" data-wz="kits"><b>Create or edit kits</b><span>Opens Brand &amp; sponsors</span></button>'
        + '</div>'
        + '<h3 class="mx-wp-sub">Overlay colours</h3><div class="mx-seg mx-wz-mode">'
        + [['team', 'Team colours'], ['brand', 'Brand colours'], ['default', 'Game colours'], ['game', 'In-game']].map(function (m) { return '<button type="button" data-wz="cmode" data-m="' + m[0] + '" class="' + (m[0] === mode ? 'is-on' : '') + '">' + m[1] + '</button>'; }).join('')
        + '</div>' + navRow(true);
    }
    if (id === 'event') {
      var hasEv = eventLoaded(s);
      var isSgg = !!sg.selectedEvent;
      var streams = Array.isArray(sg.streams) ? sg.streams : [];
      return panelHead('Your event', 'Give the event a name for the overlays, then load your tournament so the teams and upcoming matches fill in on their own.')
        + '<label class="mx-wf"><span>Event name</span><input type="text" class="mx-in" data-wz-input="event-name" value="' + h(s.eventName || '') + '" placeholder="e.g. Friday Night Cup, Week 3"></label>'
        + '<div class="mx-wf"><span>Tournament</span>'
        + (hasEv ? '<div class="mx-status mx-status--ok">Loaded: ' + h((sg.selectedEvent && (sg.selectedEvent.tournamentName || sg.selectedEvent.name)) || (s.activeEvent && s.activeEvent.name) || 'your event') + '</div>'
                 : '<div class="mx-status">No tournament loaded. The app can read start.gg, Challonge, FACEIT, NXGEN and your own leagues.</div>')
        + '<div class="mx-row"><button type="button" class="mx-btn" data-wz="go-event">' + (hasEv ? 'Change tournament' : 'Load a tournament') + '</button>'
        + '<span class="mx-hint">No bracket? That is fine, you can type the teams yourself in the next step.</span></div></div>'
        + (isSgg ? '<div class="mx-wf"><span>Matches on your stream</span>'
          + '<div class="mx-toggles">'
          + '<label class="mx-switch"><input type="checkbox" data-wz-input="queue"' + (sg.queueEnabled ? ' checked' : '') + '><i></i><span>Show the stream queue</span></label>'
          + '<label class="mx-switch"><input type="checkbox" data-wz-input="follow"' + (sg.autoFollow ? ' checked' : '') + '><i></i><span>Auto-follow: load each match as it goes live</span></label>'
          + '</div>'
          + (streams.length > 1 ? '<label class="mx-wf mx-wf--inline"><span>Your stream</span><select class="mx-in" data-wz-input="station"><option value="">All streams</option>' + streams.map(function (x) { return '<option value="' + h(x) + '"' + (x === sg.streamName ? ' selected' : '') + '>' + h(x) + '</option>'; }).join('') + '</select></label>' : '')
          + '</div>' : '')
        + navRow(true);
    }
    if (id === 'teams') {
      var t = s.teams || {}, q = Array.isArray(sg.queue) ? sg.queue.filter(function (m) { return m && m.state !== 3; }) : [];
      var bo = Number(s.bestOf) || 0;
      return panelHead('Teams and format', 'The two teams on the scoreboard right now, and how many games the series has.')
        + (q.length ? '<div class="mx-row"><button type="button" class="mx-btn mx-btn-primary" data-wz="load-next" data-set="' + h(q[0].setId) + '">Load the next match: ' + h(q[0].teamA || 'TBD') + ' vs ' + h(q[0].teamB || 'TBD') + '</button></div>' : '')
        + '<div class="mx-wz-teams">'
        +   ['blue', 'orange'].map(function (side) {
              var tt = t[side] || {};
              return '<div class="mx-wz-team mx-team" data-side="' + side + '" style="--team:' + h(tt.color || (side === 'blue' ? '#3d8bff' : '#ff8a3d')) + '">'
                + '<div class="mx-wz-team-head"><span class="mx-team-side">' + (side === 'blue' ? 'Blue' : 'Orange') + '</span><b>' + h(teamSet(s, side) ? tt.name : 'Not set') + '</b></div>'
                + teamPickerHTML(side) + '</div>';
            }).join('<span class="mx-wz-vs">vs</span>')
        + '</div>'
        + '<div class="mx-row"><button type="button" class="mx-btn mx-btn-quiet" data-wz="go-match">Logos, colours and rosters</button></div>'
        + '<h3 class="mx-wp-sub">Best of</h3><div class="mx-seg mx-wz-bo">'
        + [1, 3, 5, 7].map(function (n) { return '<button type="button" data-wz="bo" data-n="' + n + '" class="' + (n === bo ? 'is-on' : '') + '">' + n + '</button>'; }).join('')
        + '</div>' + navRow(true);
    }
    if (id === 'talent') {
      var c = s.casters || {}, names = (c.list || []).map(function (x) { return x && x.name; }).filter(Boolean);
      return panelHead('Talent', 'Who is on the desk tonight. Their names go on the caster overlays, and remote talent joins through private video rooms.')
        + '<div class="mx-wf"><span>On the desk</span>'
        + (names.length ? '<div class="mx-chips">' + names.map(function (n) { return '<span class="mx-chip">' + h(n) + '</span>'; }).join('') + '</div>'
                        : '<div class="mx-status">Nobody on the desk yet.</div>')
        + '<div class="mx-row"><button type="button" class="mx-btn mx-btn-primary" data-wz="go-desk">Set up the desk</button>'
        + '<button type="button" class="mx-btn" data-wz="go-cams">Remote cameras and rooms</button></div></div>'
        + navRow(true);
    }
    if (id === 'obs' && swName(s) === 'vMix') {
      return panelHead('Connect vMix', 'vMix is the program that sends your stream. Connect it, then the app cuts its inputs, saves replays and goes live through it.')
        + '<div class="mx-wf"><span>Connection</span>'
        + (obsLinked(s) ? '<div class="mx-status mx-status--ok">Connected to vMix.</div>'
           : '<div class="mx-status">Turn on the Web Controller in vMix (Settings), then connect it in the streaming software settings.</div>')
        + '<div class="mx-row"><button type="button" class="mx-btn mx-btn-primary" data-wz="open-sw">Open streaming software settings</button></div></div>'
        + navRow(true);
    }
    if (id === 'obs') {
      var scenes = (o.availableScenes || []).filter(function (x) { return !/^═/.test(x); });
      var map = o.scenes || {};
      return panelHead('Connect ' + swName(s), swName(s) + ' is the program that sends your stream. Connect it, add the overlays, then tell the app which scene is which.')
        + '<div class="mx-wf"><span>1. Connection</span>'
        + (o.connected ? '<div class="mx-status mx-status--ok">Connected to OBS. ' + scenes.length + ' scenes found.</div>'
                       : '<div class="mx-status">In OBS open Tools, WebSocket Server Settings, tick Enable, then click Show Connect Info for the password.</div>' + obsFormHTML())
        + '</div>'
        + '<div class="mx-wf"><span>2. Overlays</span>'
        + (obsHasOverlays(o) ? '<div class="mx-status mx-status--ok">The scoreboard and graphics layer are in OBS.</div>'
           : '<div class="mx-row"><button type="button" class="mx-btn mx-btn-primary" data-cr="obs-add"' + (o.connected ? '' : ' disabled') + '>Add the overlays to OBS</button><span class="mx-hint">Adds the scoreboard and graphics to the scene you are on in OBS.</span></div>')
        + '</div>'
        + (o.connected ? '<div class="mx-wf"><span>3. Your scenes</span><p class="mx-hint">Match each moment of the show to one of your OBS scenes. The app switches to them for you.</p><div class="mx-scenemap">'
          + SCENE_KEYS.map(function (k) {
              return '<label class="mx-scene"><b>' + h(k[1]) + '</b><i>' + h(k[2]) + '</i><select class="mx-in" data-wz-input="scene" data-key="' + k[0] + '"><option value="">Not used</option>'
                + scenes.map(function (sc) { return '<option value="' + h(sc) + '"' + (map[k[0]] === sc ? ' selected' : '') + '>' + h(sc) + '</option>'; }).join('') + '</select></label>';
            }).join('') + '</div></div>' : '')
        + navRow(true);
    }
    if (id === 'stream') {
      var tw = s.twitch || {}, auto = !!(s.matchTitles && s.matchTitles.twitch && s.matchTitles.twitch.auto);
      return panelHead('Your stream', 'Connect Twitch to set the stream title from here, run predictions and see chat. You can skip this.')
        + '<div class="mx-wf"><span>Twitch</span>'
        + (tw.connected ? '<div class="mx-status mx-status--ok">Connected as ' + h(tw.username || tw.displayName || 'your channel') + '</div>'
                        : '<div class="mx-row"><button type="button" class="mx-btn mx-btn-primary" data-cr="app" data-card="twitch">Connect Twitch</button></div>')
        + '</div>'
        + (tw.connected ? '<label class="mx-wf"><span>Stream title</span><div class="mx-row"><input type="text" class="mx-in mx-grow" data-wz-input="title" placeholder="e.g. Friday Night Cup | Grand Finals"><button type="button" class="mx-btn" data-wz="title">Update title</button></div></label>'
          + '<label class="mx-switch"><input type="checkbox" data-wz-input="autotitle"' + (auto ? ' checked' : '') + '><i></i><span>Update the title for each match automatically</span></label>' : '')
        + navRow(true);
    }
    if (id === 'countdown') {
      var live = !!(s.breakScreen && s.breakScreen.visible);
      return panelHead('Starting soon', 'Put a countdown on screen before you go live. When it reaches zero you start the show.')
        + '<div class="mx-row mx-row--form"><label class="mx-wf"><span>Title</span><input type="text" class="mx-in" data-wz-input="cd-title" value="Starting soon"></label>'
        + '<label class="mx-wf mx-wf--narrow"><span>Minutes</span><input type="number" class="mx-in" data-wz-input="cd-min" value="5" min="1" max="120"></label></div>'
        + '<div class="mx-row">' + (live ? '<div class="mx-status mx-status--live">The countdown is on screen.</div><button type="button" class="mx-btn" data-wz="cd-hide">Hide it</button>'
                                          : '<button type="button" class="mx-btn mx-btn-primary" data-wz="cd-show">Show the countdown</button>') + '</div>'
        + navRow(true);
    }
    // finish
    return panelHead('You are ready', 'Save tonight’s setup as a template so next week takes one click, then switch to Run the show.')
      + '<label class="mx-wf"><span>Template name</span><div class="mx-row"><input type="text" class="mx-in mx-grow" data-wz-input="tpl-name" placeholder="e.g. Friday Night Cup"><button type="button" class="mx-btn" data-wz="save-tpl">Save as template</button></div></label>'
      + '<div class="mx-row mx-row--end"><button type="button" class="mx-btn mx-btn-primary mx-btn-big" data-wz="run">' + svg('live') + 'Run the show</button></div>';
  }

  // Bits of a panel that change while it is open (OBS status line).
  function wizLive(s, body) { renderObsStatus(s); }

  function onWizClick(e) {
    var b = e.target.closest('[data-wz]');
    if (!b) return;
    var k = b.getAttribute('data-wz'), id = b.getAttribute('data-id');
    var S = function (t, d) { if (typeof send === 'function') send(t, d); };
    if (k === 'mode') setCrMode(b.getAttribute('data-m'));
    else if (k === 'goto') setWizStep(b.getAttribute('data-step'));
    else if (k === 'next') nextStep();
    else if (k === 'back') { var i = WIZ.map(function (w) { return w.id; }).indexOf(wizStep()); if (i > 0) setWizStep(WIZ[i - 1].id); }
    else if (k === 'fresh') { setWizFlag('template'); nextStep(); }
    else if (k === 'preset') { S('load_preset', { id: id }); setWizFlag('template'); toast('Template loaded.'); nextStep(); }
    else if (k === 'game') { if (typeof onGameSelectChange === 'function') onGameSelectChange(id); else S('set_active_game', { game: id }); }
    else if (k === 'kit') S('activate_brand_kit', { id: id || null });
    else if (k === 'kits') openDrawer('brand') || go(ITEM.sponsors.go);
    else if (k === 'cmode') { if (typeof setColorMode === 'function') setColorMode(b.getAttribute('data-m')); }
    else if (k === 'go-event') openDrawer('event') || go(ITEM.event.go);
    else if (k === 'go-match') openDrawer('teams') || go(ITEM.match.go);
    else if (k === 'load-next') pushSet(b.getAttribute('data-set'));
    else if (k === 'bo') S('set_best_of', { value: parseInt(b.getAttribute('data-n'), 10) });
    else if (k === 'go-desk') { if (!openDrawer('desk')) { go(ITEM.people.go); } }
    else if (k === 'open-sw') { if (!openDrawer('obs')) openApp('obs'); }
    else if (k === 'go-cams') { if (!openDrawer('cams')) go({ tab: 'produccion', click: '#pd-subnav > button[data-pd="cameras"]' }); }
    else if (k === 'title') updateTitle(b.closest('.mx-row').querySelector('[data-wz-input="title"]').value);
    else if (k === 'cd-show') {
      var body = b.closest('.mx-wiz-body');
      var mins = Math.max(1, Math.min(120, parseInt(body.querySelector('[data-wz-input="cd-min"]').value, 10) || 5));
      S('set_break', { visible: true, title: body.querySelector('[data-wz-input="cd-title"]').value || 'Starting soon', seconds: mins * 60 });
      setWizFlag('countdown');
    }
    else if (k === 'cd-hide') S('set_break', { visible: false });
    else if (k === 'save-tpl') {
      var nm = b.closest('.mx-row').querySelector('[data-wz-input="tpl-name"]').value.trim();
      if (!nm) { toast('Give the template a name first.', true); return; }
      S('save_preset', { name: nm }); toast('Template saved: ' + nm);
    }
    else if (k === 'run') { setWizFlag('finish'); setCrMode('run'); }
    if (cr) cr._wizSig = '';
    setTimeout(renderControlRoom, 120);
  }
  function onWizChange(e) {
    var t = e.target, k = t.getAttribute && t.getAttribute('data-wz-input');
    if (!k) return;
    var S = function (ty, d) { if (typeof send === 'function') send(ty, d); };
    var s = state() || {}, sg = s.startgg || {};
    if (k === 'event-name') S('set_event_name', { name: t.value.trim() });
    else if (k === 'queue') S('startgg_set_queue', { enabled: t.checked });
    else if (k === 'follow') S('startgg_set_autofollow', { enabled: t.checked, streamName: sg.streamName || '' });
    else if (k === 'station') S('startgg_set_autofollow', { enabled: !!sg.autoFollow, streamName: t.value });
    else if (k === 'autotitle') S('set_match_titles', { twitch: { auto: t.checked } });
    else if (k === 'scene') {
      // Scene mapping is saved through the OBS settings form so nothing else in it changes.
      var sel = $('select-obs-scene-' + t.getAttribute('data-key'));
      if (sel) {
        if (![].some.call(sel.options, function (op) { return op.value === t.value; })) sel.appendChild(new Option(t.value, t.value));
        sel.value = t.value;
        var save = $('btn-obs-save'); if (save) save.click();
      }
    }
    if (cr) cr._wizSig = '';
  }
  function updateTitle(title) {
    title = String(title || '').trim();
    if (!title) { toast('Type a title first.', true); return; }
    fetch(BASE.replace(/\/$/, '') + '/api/twitch/channel', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title }) })
      .then(function (r) { toast(r.ok ? 'Stream title updated.' : 'Twitch did not accept the title.', !r.ok); })
      .catch(function () { toast('Could not reach the app to update the title.', true); });
  }
  function toast(msg, bad) { if (typeof showToast === 'function') showToast(msg, bad ? '#ef4444' : '#22c55e', 3500); }

  // ── Drawers: every tool, without leaving the Control room ─────────────────────────────────
  // A producer on air should never lose the cockpit. Instead of navigating, a drawer slides in from
  // the right and BORROWS the real section (the team editor, event loader, desk lineup, brand kits,
  // OBS and Twitch settings, the graphics editor, cameras). Same element, same handlers, so it works
  // exactly as it does on its own page. Closing it puts every borrowed node back where it was.
  var DRAWERS = {
    teams:    { title: 'Teams', desc: 'Names, logos, colours and rosters, then the round and format. Apply sends a team to the scoreboard.', sel: ['#match-teams-section', '.mx-match-head', '#match-settings-panel'], page: 'match', wide: true },
    event:    { title: 'Event and tournament', desc: 'Load your tournament and choose what the stream queue follows.', sel: ['[data-dash-id="event"]'], page: 'event' },
    desk:     { title: 'Desk lineup', desc: 'Who is on the desk tonight. Names feed the caster overlays.', sel: ['#talent-deck'], page: 'people', wide: true },
    brand:    { title: 'Brand and sponsors', desc: 'Pick or edit the brand kit, and choose the sponsors on the desk.', sel: ['#dash-brandkit', '#mx-kits', '[data-dash-id="adslots"]'], page: 'sponsors', wide: true },
    obs:      { title: 'Streaming software', desc: 'OBS Studio, Streamlabs Desktop or vMix: connect it and choose which scene the app uses for each moment.', sel: ['#integration-obs'], page: 'market', wide: true },
    twitch:   { title: 'Twitch', desc: 'Connect your channel for the stream title, chat and predictions.', sel: ['#integration-twitch'], page: 'market', wide: true },
    graphics: { title: 'Graphics', desc: 'Pick a graphic, set it up, then Show it.', sel: ['[data-dash-id="graphics"]'], page: 'graphics', full: true },
    cams:     { title: 'Cameras and rooms', desc: 'Private video rooms for players and talent, with their join links.', sel: ['#tab-facecams-content'], page: 'people', full: true },
    match:    { title: 'Match details', desc: 'Round, match label, best of and team records.', sel: ['.mx-match-head', '#match-settings-panel'], page: 'match' },
    rundown:  { title: 'Run of show', desc: 'The segments of tonight in order. Start, skip or hold them from the dock.', sel: ['#prod-rundown-content'], page: 'show', full: true },
    flows:    { title: 'Automation', desc: 'If this happens, do that. Fire a flow by hand from the dock any time.', sel: ['#prod-flows-content'], page: 'show', full: true }
  };
  var drawerEl = null, drawerKey = '', borrowed = [];
  function buildDrawer() {
    if (drawerEl) return;
    var scrim = mk('div', 'mx-only mx-scrim');
    scrim.addEventListener('click', closeDrawer);
    drawerEl = mk('aside', 'mx-only mx-drawer');
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-modal', 'true');
    drawerEl.innerHTML = '<header class="mx-dr-head"><div class="mx-dr-text"><h2></h2><p></p></div>'
      + '<button type="button" class="mx-btn mx-btn-quiet mx-dr-page">Open as a page</button>'
      + '<button type="button" class="mx-ic mx-dr-close" title="Close (Esc)" aria-label="Close">' + svg('close') + '</button></header>'
      + '<div class="mx-dr-body"></div>';
    drawerEl.querySelector('.mx-dr-close').addEventListener('click', closeDrawer);
    drawerEl.querySelector('.mx-dr-page').addEventListener('click', function () {
      var d = DRAWERS[drawerKey]; closeDrawer();
      if (d && ITEM[d.page]) go(ITEM[d.page].go);
    });
    document.body.appendChild(scrim);
    document.body.appendChild(drawerEl);
    drawerEl.__scrim = scrim;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawerKey) { e.stopPropagation(); closeDrawer(); } }, true);
  }
  function openDrawer(key) {
    var d = DRAWERS[key];
    if (!d || !isModern()) return false;
    buildDrawer();
    if (drawerKey) closeDrawer();
    var body = drawerEl.querySelector('.mx-dr-body');
    var nodes = [];
    d.sel.forEach(function (sel) { var n = document.querySelector(sel); if (n && nodes.indexOf(n) === -1) nodes.push(n); });
    if (!nodes.length) return false;
    nodes.forEach(function (n) {
      var mark = document.createComment('drawer home');
      n.parentNode.insertBefore(mark, n);
      borrowed.push({ node: n, mark: mark, display: n.style.display });
      n.style.display = '';
      body.appendChild(n);
    });
    drawerKey = key;
    drawerEl.querySelector('h2').textContent = d.title;
    drawerEl.querySelector('.mx-dr-text p').textContent = d.desc;
    drawerEl.classList.toggle('is-wide', !!d.wide);
    drawerEl.classList.toggle('is-full', !!d.full);
    drawerEl.setAttribute('data-drawer', key);
    root.classList.add('mx-drawer-open');
    body.scrollTop = 0;
    if (key === 'cams' && typeof cfShowSubtab === 'function') { try { cfShowSubtab('talent'); } catch (e) {} }
    if (key === 'flows' && typeof renderFlows === 'function') { try { renderFlows(); } catch (e) {} }
    if (key === 'obs' || key === 'twitch') { var c = document.querySelector('.int-card[data-card="' + key + '"]'); if (c) c.classList.add('is-on'); }
    refitPreviews();
    return true;
  }
  window.__mxOpenDrawer = function (key) { return openDrawer(key); };
  function closeDrawer() {
    if (!drawerKey) return;
    borrowed.forEach(function (b) {
      if (b.mark.parentNode) { b.mark.parentNode.insertBefore(b.node, b.mark); b.mark.parentNode.removeChild(b.mark); }
      b.node.style.display = b.display;
    });
    borrowed = [];
    drawerKey = '';
    root.classList.remove('mx-drawer-open');
    if (drawerEl) drawerEl.removeAttribute('data-drawer');
    refitPreviews();
    setTimeout(refresh, 30);
  }
  window.NEModernDrawer = { open: openDrawer, close: closeDrawer };
  // The dock's "edit" links jumped to the Production page mid-show. In Modern they open the same
  // editor in a drawer, so the producer keeps the page they were on.
  var DOCK_LINKS = [['.js-goto-rundown, #qk-ros-edit, .js-goto-ros', 'rundown'], ['.js-goto-flows', 'flows'], ['.qsgg-event-header .js-goto-dashboard', 'event']];
  document.addEventListener('click', function (e) {
    if (!isModern()) return;
    for (var i = 0; i < DOCK_LINKS.length; i++) {
      if (e.target.closest(DOCK_LINKS[i][0]) && openDrawer(DOCK_LINKS[i][1])) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    }
  }, true);

  // ── Program bar: the output, always in the same place ──────────────────────────────────────
  // Every switcher puts the broadcast's own controls along the bottom: are we live, are we
  // recording, which scene is on program. Modern does the same. Left: Go live and Record with their
  // uptime, then viewers and the ad chip (moved down from the top bar, since they describe the
  // stream). Middle: the scene buttons, with a red tally on the one on air. Right: Save replay and
  // Marker. Ending a stream takes two clicks; nothing here starts on its own.
  var airEl = null, airArm = { stream: 0, record: 0 }, airPending = { stream: 0, record: 0 };
  function buildProgramBar() {
    var bb = $('bottom-bar');
    if (!bb || airEl) return;
    airEl = mk('div', 'mx-only mx-airbar');
    airEl.id = 'mx-air';
    airEl.innerHTML =
        '<button type="button" class="mx-airbar-btn mx-airbar-stream" data-air="stream"><span class="mx-airbar-dot"></span>'
      + '<span class="mx-airbar-main"><b class="mx-airbar-label">Go live</b><span class="mx-airbar-sub">Off air</span></span></button>'
      + '<button type="button" class="mx-airbar-btn mx-airbar-record" data-air="record"><span class="mx-airbar-dot"></span>'
      + '<span class="mx-airbar-main"><b class="mx-airbar-label">Record</b><span class="mx-airbar-sub">Not recording</span></span></button>'
      + '<div class="mx-bb-stats" id="mx-bb-stats"></div>';
    bb.insertBefore(airEl, bb.firstChild);
    airEl.addEventListener('click', onAirClick);

    var off = mk('div', 'mx-only mx-bb-off');
    off.id = 'mx-bb-off';
    off.innerHTML = '<span class="mx-bb-off-text"><b class="mx-sw-off">OBS is not connected.</b> Scenes, Go live and Record work once it is.</span>'
      + '<button type="button" class="mx-btn mx-btn-primary mx-bb-connect" data-air="connect">Connect OBS</button>';
    var scenes = $('qt-obs-scenes');
    if (scenes) scenes.parentNode.insertBefore(off, scenes.nextSibling);
    off.addEventListener('click', onAirClick);
    setInterval(function () { if (isModern()) renderAirBar(); }, 1000);
  }
  function fmtUptime(ms) {
    var t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  // "OBS", "Streamlabs" or "vMix": whichever program sends the stream (Apps ▸ Streaming software).
  function swName(s) {
    s = s || state() || {};
    if (s.switcher && s.switcher.target === 'vmix') return 'vMix';
    return (s.obs && s.obs.app === 'streamlabs') ? 'Streamlabs' : 'OBS';
  }
  function obsLinked(s) {
    var sw = (s && s.switcher && s.switcher.target) || 'obs';
    if (sw === 'vmix') return !!(s.vmix && s.vmix.connected);
    return !!(s && s.obs && s.obs.connected);
  }
  // Stream / record state lives on whichever switcher is in charge.
  function outState(s) { return (s && s.switcher && s.switcher.target === 'vmix') ? (s.vmix || {}) : ((s && s.obs) || {}); }
  function onAirClick(e) {
    var b = e.target.closest('[data-air]');
    if (!b) return;
    var k = b.getAttribute('data-air'), s = state() || {}, obs = outState(s);
    if (k === 'connect' || !obsLinked(s)) { openDrawer('obs') || openApp('obs'); return; }
    var on = k === 'stream' ? !!obs.streaming : !!obs.recording;
    // Going live and ending a stream are both public; they need a second click within 3 seconds.
    // Starting a recording is private and harmless, so it is one click; stopping it is two.
    var needsConfirm = k === 'stream' || on;
    if (needsConfirm && Date.now() - airArm[k] > 3000) { airArm[k] = Date.now(); renderAirBar(); setTimeout(renderAirBar, 3050); return; }
    airArm[k] = 0;
    airPending[k] = Date.now();
    send(k === 'stream' ? 'switcher_stream' : 'switcher_record', { on: !on });
    renderAirBar();
  }
  function renderAirBar() {
    if (!airEl) return;
    var s = state() || {}, obs = outState(s), linked = obsLinked(s), now = Date.now();
    root.classList.toggle('mx-obs-off', !linked);
    var nm = swName(s);
    var offB = document.querySelector('#mx-bb-off .mx-sw-off'); if (offB && offB.textContent !== nm + ' is not connected.') offB.textContent = nm + ' is not connected.';
    var offBtn = document.querySelector('#mx-bb-off .mx-bb-connect'); if (offBtn && offBtn.textContent !== 'Connect ' + nm) offBtn.textContent = 'Connect ' + nm;
    [['stream', !!obs.streaming, obs.streamStartedAt], ['record', !!obs.recording, obs.recordStartedAt]].forEach(function (r) {
      var k = r[0], on = r[1], since = r[2];
      var b = airEl.querySelector('[data-air="' + k + '"]');
      if (!b) return;
      if (airPending[k] && (now - airPending[k] > 12000 || b.__was !== undefined && b.__was !== on)) airPending[k] = 0;
      b.__was = on;
      var armed = now - airArm[k] <= 3000;
      var label, sub;
      if (k === 'stream') {
        label = armed ? (on ? 'Click to end' : 'Click to go live') : (on ? 'Live' : 'Go live');
        sub = !linked ? nm + ' offline' : airPending[k] ? (on ? 'Stopping' : 'Starting') : on ? (since ? fmtUptime(now - since) : 'On air') : armed ? 'Confirm' : 'Off air';
      } else {
        label = armed ? 'Click to stop' : (on ? 'Rec' : 'Record');
        sub = !linked ? nm + ' offline' : airPending[k] ? (on ? 'Stopping' : 'Starting') : on ? (since ? fmtUptime(now - since) : 'Recording') : 'Not recording';
      }
      b.classList.toggle('is-on', on);
      b.classList.toggle('is-armed', armed);
      b.classList.toggle('is-off', !linked);
      var l = b.querySelector('.mx-airbar-label'), sb = b.querySelector('.mx-airbar-sub');
      if (l.textContent !== label) l.textContent = label;
      if (sb.textContent !== sub) sb.textContent = sub;
      b.title = !linked ? 'Connect OBS first' : k === 'stream'
        ? (on ? 'You are live. Click twice to end the stream.' : 'Start streaming. Click twice to confirm.')
        : (on ? 'Recording. Click twice to stop.' : 'Start recording to disk.');
    });
  }

  // ── Live dock: a header that says what this tab is for, with pop out and close ─────────────
  var DOCK_TABS = {
    controls: ['Controls', 'The things you change mid-show: score, break timer, graphics, scenes, automation.'],
    show:    ['Show', 'Next matches, the run of show, replays and your stream title.'],
    quick:   ['On air', 'What viewers see now, and one-press graphics and scenes.'],
    ros:     ['Up next', 'Your rundown and the next matches in the bracket.'],
    startgg: ['Up next', 'Your rundown and the next matches in the bracket.'],
    talent:  ['Talent', 'Who is connected, with their camera and mic.'],
    replay:  ['Replay', 'Capture a moment and play it back on air.'],
    twitch:  ['Chat', 'Your chat, alerts and viewer questions.'],
    flows:   ['Auto', 'Automatic actions and the AI director.'],
    ai:      ['Auto', 'Automatic actions and the AI director.'],
    notes:   ['Notes', 'A scratchpad for this show, saved on this computer.']
  };
  var dockHead = null;
  function buildDockHead() {
    var q = $('qrail'), content = q && q.querySelector('.qrail-content');
    if (!content || dockHead) return;
    dockHead = mk('div', 'mx-only mx-dock-head');
    dockHead.innerHTML = '<div class="mx-dock-text"><b class="mx-dock-title"></b><span class="mx-dock-desc"></span></div>'
      + '<button type="button" class="mx-ic mx-dock-pin" data-dock="pin" title="Pinned: the dock stays beside the page. Click to make it slide over the page instead"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/></svg></button>'
      + '<button type="button" class="mx-ic mx-dock-pop" data-dock="pop" title="Open the dock in its own window">' + svg('popout') + '</button>'
      + '<button type="button" class="mx-ic mx-dock-close" data-dock="close" title="Hide the dock">' + svg('close') + '</button>';
    q.insertBefore(dockHead, q.firstChild);
    dockHead.addEventListener('click', function (e) {
      var b = e.target.closest('[data-dock]');
      if (!b) return;
      var popped = document.body.classList.contains('popout-qrail');
      if (b.getAttribute('data-dock') === 'pin') {
        try { localStorage.setItem(PIN_KEY, dockPinned() ? '0' : '1'); } catch (e2) {}
        applyDockPin(); b.classList.toggle('is-on', dockPinned());
        b.title = dockPinned() ? 'Pinned: the dock stays beside the page. Click to make it slide over the page instead' : 'Slides over the page. Click to pin it beside the page';
      }
      else if (b.getAttribute('data-dock') === 'pop') { var p = $('qrail-popout-btn'); if (p) p.click(); }
      else if (popped) { var r = $('qrail-return'); if (r) r.click(); }
      else toggleDock();
      setTimeout(refresh, 40);
    });
  }
  function renderDirectorNote() {
    var pane = $('tab-director-content'), sec = $('director-section');
    if (!pane || !sec) return;
    var off = getComputedStyle(sec).display === 'none';   // hidden inline by applyDirectorState, or by CSS before state arrives
    var note = pane.querySelector('.mx-dir-note');
    if (!note) {
      note = mk('div', 'mx-only mx-dir-note');
      note.innerHTML = '<b>The AI director is not available for this game.</b><span>It reads live game data to pick the camera and cut scenes on its own. That data exists for Rocket League and Counter-Strike 2. Pick one of those in the top bar and this page fills in.</span>';
      pane.appendChild(note);
    }
    note.hidden = !off;
  }
  function renderDockHead() {
    if (!dockHead) return;
    // On air pane: no switcher means no program scene to show; say so with the fix one click away.
    var pane = document.querySelector('.qrail-panel[data-qpanel="quick"]');
    if (pane) {
      var linked = obsLinked(state() || {});
      pane.classList.toggle('mx-noobs', !linked);
      if (!pane.querySelector('.mx-dock-noobs')) {
        var note = mk('div', 'mx-only mx-dock-noobs');
        note.innerHTML = '<span>' + swName() + ' is not connected, so there is no program scene to show.</span><button type="button" class="mx-btn mx-btn-quiet" data-air="connect">Connect</button>';
        note.addEventListener('click', onAirClick);
        pane.insertBefore(note, pane.firstChild);
      }
    }
    var a = document.querySelector('#qrail-tabs .qrail-tab.active[data-qtab]');
    var t = DOCK_TABS[a ? a.getAttribute('data-qtab') : 'quick'] || ['Live dock', ''];
    var popped = document.body.classList.contains('popout-qrail');
    var title = dockHead.querySelector('.mx-dock-title'), desc = dockHead.querySelector('.mx-dock-desc');
    if (title.textContent !== t[0]) title.textContent = t[0];
    if (desc.textContent !== t[1]) desc.textContent = t[1];
    dockHead.querySelector('.mx-dock-pop').hidden = popped;
    dockHead.querySelector('.mx-dock-close').title = popped ? 'Put the dock back in the main window' : 'Hide the dock';
  }

  // ── Sidebar handle: one chip on the edge, half way down, to collapse or expand ──────────────
  function buildRailHandle() {
    var sb = document.querySelector('.sidebar');
    if (!sb || $('mx-rail-handle')) return;
    var h = mk('button', 'mx-only mx-rail-handle');
    h.type = 'button';
    h.id = 'mx-rail-handle';
    h.innerHTML = svg('collapse');
    h.addEventListener('click', function () { setRailMin(!railMin()); });
    sb.appendChild(h);
  }
  function renderRailHandle() {
    var h = $('mx-rail-handle');
    if (h) h.title = railMin() ? 'Expand the sidebar' : 'Collapse the sidebar';
  }

  // ── Live dock, On air pane: status first, then one-press graphics, then scenes ──────────────
  // The stream title and category are a Twitch detail, not a show control; they fold away under a
  // row you can open.
  function tagDockGroups() {
    var pane = document.querySelector('.qrail-panel[data-qpanel="quick"]');
    if (!pane || pane.__mxTagged) return;
    var groups = pane.querySelectorAll('.qrail-group');
    for (var i = 0; i < groups.length; i++) {
      var lab = groups[i].querySelector('.qrail-label');
      if (!lab || !/stream title/i.test(lab.textContent)) continue;
      var g = groups[i];
      g.classList.add('mx-dock-stream');
      lab.addEventListener('click', function (e) {
        if (!isModern() || e.target.closest('a, button, input, select')) return;
        g.classList.toggle('is-open');
      });
      break;
    }
    pane.__mxTagged = true;
  }

  // ── Event page: the event you are on, with the finder folded away until you change it ────────
  var evHero = null;
  var PLAT_NAMES = { nameless: 'Nameless', startgg: 'start.gg', challonge: 'Challonge', challengermode: 'Challengermode', nxgen: 'NXGEN', faceit: 'FACEIT', league: 'My league' };
  function buildEventHero() {
    var sec = document.querySelector('[data-dash-id="event"]');
    if (!sec || evHero) return;
    evHero = mk('div', 'mx-only mx-evhero');
    evHero.innerHTML = '<div class="mx-evhero-ico">' + svg('event') + '</div>'
      + '<div class="mx-evhero-main"><span class="mx-evhero-plat"></span><b class="mx-evhero-name"></b><span class="mx-evhero-meta"></span></div>'
      + '<div class="mx-evhero-acts"><button type="button" class="mx-btn mx-btn-primary" data-ev="change">Change event</button></div>';
    sec.insertBefore(evHero, sec.firstChild);
    evHero.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ev]');
      if (!b) return;
      sec.classList.toggle('mx-ev-change');
      if (sec.classList.contains('mx-ev-change')) {
        var inp = $('sgg-event-search');
        setTimeout(function () { if (inp) { inp.focus(); inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, 60);
      }
    });
  }
  function renderEventHero(s) {
    if (!evHero) return;
    // The section itself: site-events.js moves this card into its right pane, so parentElement is
    // no longer the section and the classes that fold/unfold the loaders landed on the wrong node.
    var sec = evHero.closest('[data-dash-id="event"]') || evHero.parentElement;
    var ae = s.activeEvent || {};
    var has = !!ae.name;
    sec.classList.toggle('mx-ev-has', has);
    if (!has) sec.classList.remove('mx-ev-change');
    var plat = has ? (PLAT_NAMES[ae.platform] || ae.platform || 'Event') : '';
    var name = ae.name || s.eventName || 'No event loaded';
    var meta = [];
    if (has) {
      if (ae.gameName) meta.push(ae.gameName);
      if (ae.numEntrants) meta.push(ae.numEntrants + ' entrants');
      var fmt = String(ae.format || '').replace(/_/g, ' ').trim(); if (fmt) meta.push(fmt.toLowerCase());
      var sg = s.startgg || {};
      var q = Array.isArray(sg.queue) ? sg.queue.filter(function (m) { return m && m.state !== 3; }).length : 0;
      meta.push(sg.queueEnabled ? (q ? q + ' in the stream queue' : 'stream queue on') : 'stream queue off');
    } else {
      meta.push(s.eventName ? 'Named only: no tournament loaded, so no bracket, queue or schedule.' : 'Pick the site that runs your bracket below, then search for your event.');
    }
    var sig = plat + '|' + name + '|' + meta.join('|') + '|' + sec.classList.contains('mx-ev-change');
    if (evHero._sig === sig) return;
    evHero._sig = sig;
    var pl = evHero.querySelector('.mx-evhero-plat'); pl.textContent = plat; pl.hidden = !plat;
    evHero.querySelector('.mx-evhero-name').textContent = name;
    evHero.querySelector('.mx-evhero-meta').textContent = meta.join(' · ');
    var btn = evHero.querySelector('[data-ev]');
    btn.textContent = !has ? 'Find your event' : sec.classList.contains('mx-ev-change') ? 'Keep this event' : 'Change event';
    btn.hidden = !has;
  }

  // ── Graphics page: what is on air, and one Show button on the graphic you are editing ───────
  var gfxStrip = null;
  function currentGfxKey() {
    var b = document.querySelector('#gfx-scene-nav .gfx-sidenav-btn.active');
    return b ? b.getAttribute('data-gfxscene') : '';
  }
  function buildGfxStrip() {
    var bar = document.querySelector('.gfx-top .gfx-top-bar');
    if (!bar || gfxStrip) return;
    gfxStrip = mk('div', 'mx-only mx-gfx-live');
    gfxStrip.innerHTML = '<span class="mx-gfx-live-lbl"><span class="mx-gfx-dot"></span>On air now</span><div class="mx-gfx-live-chips"></div>'
      + '<button type="button" class="mx-btn mx-btn-quiet mx-gfx-hideall" data-gfx="hideall" title="Take every graphic off air">Hide all</button>';
    bar.parentNode.insertBefore(gfxStrip, bar);
    gfxStrip.addEventListener('click', function (e) {
      var b = e.target.closest('[data-gfx]');
      if (!b) return;
      if (b.getAttribute('data-gfx') === 'hideall') { var c = $('gfx-top-clear'); if (c) c.click(); }
      else if (b.__src) b.__src.click();
      setTimeout(refresh, 80);
    });
    var head = $('gfx-scene-head');
    if (head) {
      var act = mk('div', 'mx-only mx-gfx-act');
      act.innerHTML = '<button type="button" class="mx-btn mx-btn-quiet" data-gfxact="hide">Hide</button>'
        + '<button type="button" class="mx-btn mx-btn-live" data-gfxact="show">Show on air</button>';
      head.appendChild(act);
      act.addEventListener('click', function (e) {
        var b = e.target.closest('[data-gfxact]');
        if (!b) return;
        if (b.getAttribute('data-gfxact') === 'show') { var p = $('gfx-top-push'); if (p) p.click(); }
        else if (typeof window._gfxDoClear === 'function') window._gfxDoClear(currentGfxKey());
        setTimeout(refresh, 80);
      });
    }
  }
  function renderGfxStrip() {
    if (!gfxStrip) return;
    // The dock's chips already know every graphic's live state; mirror them.
    var chips = document.querySelectorAll('#qk-put .qk-chip.on:not(.qk-chip--scene)');
    var wrap = gfxStrip.querySelector('.mx-gfx-live-chips');
    var sig = [].map.call(chips, function (c) { return c.getAttribute('data-id'); }).join('|');
    if (wrap._sig !== sig) {
      wrap._sig = sig;
      wrap.textContent = '';
      if (!chips.length) wrap.appendChild(mk('span', 'mx-gfx-none', 'Nothing on air'));
      for (var i = 0; i < chips.length; i++) {
        var main = chips[i].querySelector('.qk-chip-main');
        var nm = main ? main.textContent.trim() : chips[i].getAttribute('data-id');
        var b = mk('button', 'mx-gfx-chip');
        b.type = 'button';
        b.setAttribute('data-gfx', 'off');
        b.innerHTML = '<span class="mx-gfx-chip-name"></span>' + svg('close');
        b.querySelector('.mx-gfx-chip-name').textContent = nm;
        b.title = 'Hide ' + nm;
        b.__src = main;
        wrap.appendChild(b);
      }
      gfxStrip.classList.toggle('is-live', !!chips.length);
      gfxStrip.querySelector('.mx-gfx-hideall').hidden = !chips.length;
    }
    var act = document.querySelector('.mx-gfx-act');
    if (act) {
      var lb = $('gfx-scene-head-live');
      var live = !!lb && !lb.classList.contains('is-off');
      var key = currentGfxKey();
      act.querySelector('[data-gfxact="hide"]').hidden = !live;
      var sb = act.querySelector('[data-gfxact="show"]');
      var txt = key === 'preshow' ? 'Cut to this scene' : live ? 'Update on air' : 'Show on air';
      if (sb.textContent !== txt) sb.textContent = txt;
    }
  }

  // ── Team picker: set a side's team right where you are ──────────────────────────────────────
  // Used inline in the Control room hero and the setup wizard. Type a name: saved and event teams
  // match as you type; pick one to take its logo, colour and roster, or press Set to use the typed
  // name as is. Sends the same set_team the Match page sends.
  function teamPickerHTML(side) {
    return '<div class="mx-tp" data-side="' + side + '">'
      + '<div class="mx-tp-row"><input type="text" class="mx-tp-in" placeholder="Type a team name" autocomplete="off" spellcheck="false">'
      + '<button type="button" class="mx-btn mx-btn-primary" data-tp="set">Set</button></div>'
      + '<div class="mx-tp-list"></div></div>';
  }
  function teamPool(s) {
    var list = [];
    try { if (typeof allMatchTeams === 'function') list = allMatchTeams() || []; } catch (e) {}
    if (!list.length) list = (s && s.savedTeams) || [];
    return list.filter(function (t) { return t && t.name; });
  }
  function renderTeamList(tp, s) {
    var inp = tp.querySelector('.mx-tp-in'), list = tp.querySelector('.mx-tp-list');
    var q = (inp.value || '').trim().toLowerCase();
    var pool = teamPool(s), hits = [];
    for (var i = 0; i < pool.length && hits.length < 6; i++) {
      var nm = String(pool[i].name).toLowerCase();
      if (!q || nm.indexOf(q) !== -1) hits.push(pool[i]);
    }
    list.textContent = '';
    hits.forEach(function (t, i) {
      var b = mk('button', 'mx-tp-item');
      b.type = 'button';
      b.setAttribute('data-tp', 'pick');
      b.__team = t;
      b.innerHTML = '<span class="mx-tp-logo">' + (t.logo ? '<img alt="">' : '') + '</span><span class="mx-tp-name"></span>'
        + (Array.isArray(t.players) && t.players.length ? '<span class="mx-tp-meta">' + t.players.length + ' players</span>' : '');
      if (t.logo) b.querySelector('img').src = t.logo;
      b.querySelector('.mx-tp-name').textContent = t.name;
      list.appendChild(b);
    });
    if (!hits.length && q) list.appendChild(mk('div', 'mx-tp-none', 'No saved team called that. Set uses the name as typed.'));
    if (!hits.length && !q) list.appendChild(mk('div', 'mx-tp-none', 'No saved teams yet. Type a name and press Set.'));
    var tbd = mk('button', 'mx-tp-item mx-tp-tbd');
    tbd.type = 'button'; tbd.setAttribute('data-tp', 'tbd'); tbd.textContent = 'TBD (no team yet)';
    list.appendChild(tbd);
  }
  function setSideTeam(side, t) {
    if (typeof send !== 'function') return;
    var payload = { side: side, name: t.name, logo: t.logo || null, abbr: t.abbr || '' };
    payload.players = Array.isArray(t.players) ? t.players : [];
    if (t.color) payload.color = t.color;
    send('set_team', payload);
  }
  function clearSideTeam(side) {
    if (typeof send !== 'function') return;
    send('set_team', { side: side, name: 'TBD', logo: null, players: [], color: side === 'blue' ? '#055fdb' : '#e97139', abbr: '' });
  }
  function onTeamPicker(e) {
    var tp = e.target.closest('.mx-tp');
    if (!tp) return false;
    var side = tp.getAttribute('data-side');
    var b = e.target.closest('[data-tp]');
    if (e.type === 'input') { renderTeamList(tp, state() || {}); return true; }
    if (e.type === 'keydown') {
      if (e.key === 'Enter') { e.preventDefault(); commitTyped(tp, side); return true; }
      if (e.key === 'Escape') { closeTeamPickers(); return true; }
      return false;
    }
    if (!b) return false;
    var k = b.getAttribute('data-tp');
    if (k === 'pick' && b.__team) { setSideTeam(side, b.__team); closeTeamPickers(); }
    else if (k === 'tbd') { clearSideTeam(side); closeTeamPickers(); }
    else if (k === 'set') commitTyped(tp, side);
    return true;
  }
  function commitTyped(tp, side) {
    var name = (tp.querySelector('.mx-tp-in').value || '').trim();
    if (!name) return;
    if (PLACEHOLDER_TEAM.test(name)) { clearSideTeam(side); closeTeamPickers(); return; }
    var pool = teamPool(state() || {}), low = name.toLowerCase();
    var t = null;
    for (var i = 0; i < pool.length; i++) if (String(pool[i].name).toLowerCase() === low) { t = pool[i]; break; }
    setSideTeam(side, t || { name: name.toUpperCase() });
    closeTeamPickers();
  }
  function openTeamPicker(teamEl, s) {
    closeTeamPickers();
    teamEl.classList.add('is-edit');
    var side = teamEl.getAttribute('data-side');
    var host = teamEl.querySelector('.mx-team-text');
    var tp = mk('div', 'mx-tp-host');
    tp.innerHTML = teamPickerHTML(side);
    host.appendChild(tp);
    var inp = tp.querySelector('.mx-tp-in');
    var cur = (((s.teams || {})[side]) || {}).name || '';
    inp.value = PLACEHOLDER_TEAM.test(cur) ? '' : cur;
    renderTeamList(tp.querySelector('.mx-tp'), s);
    setTimeout(function () { inp.focus(); inp.select(); }, 20);
  }
  function closeTeamPickers() {
    var open = document.querySelectorAll('.mx-team.is-edit');
    for (var i = 0; i < open.length; i++) {
      open[i].classList.remove('is-edit');
      var h = open[i].querySelector('.mx-tp-host'); if (h) h.remove();
    }
  }
  document.addEventListener('mousedown', function (e) {
    if (!document.querySelector('.mx-team.is-edit')) return;
    if (e.target && e.target.closest && e.target.closest('.mx-team.is-edit')) return;
    closeTeamPickers();
  });

  // ── Graphics editor: a live preview beside the fields, and fields in two columns ──────────
  var gfxPv = null, gfxPvFit = null;
  function buildGfxPreview() {
    var col = $('gfx-settings-col');
    if (!col || gfxPv) return;
    gfxPv = mk('aside', 'mx-only mx-gfx-preview');
    gfxPv.innerHTML = '<div class="mx-gfx-pv-box"><iframe scrolling="no" title="Preview"></iframe><span class="mx-gfx-pv-empty">No preview for this graphic</span></div>'
      + '<p class="mx-gfx-pv-cap">Preview of <b></b>. It shows saved changes, as the overlay in OBS does.</p>';
    col.appendChild(gfxPv);
    // Tag fields once so the two-column grid knows which rows need the full width.
    var rows = col.querySelectorAll('.gfx-scene-body > .field-row');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.querySelector('textarea') || !r.querySelector('input, select, button') || /margin-top:\s*-/.test(r.getAttribute('style') || '')) r.classList.add('mx-full');
    }
    gfxPvFit = function () {
      var box = gfxPv.querySelector('.mx-gfx-pv-box'), f = gfxPv.querySelector('iframe');
      var w = box.clientWidth; if (!w) return;
      var sc = w / 1920;
      f.style.width = '1920px'; f.style.height = '1080px'; f.style.transform = 'scale(' + sc + ')';
    };
    window.addEventListener('resize', function () { if (gfxPv && gfxPv.querySelector('iframe').src) gfxPvFit(); });
  }
  function renderGfxPreview() {
    if (!gfxPv) return;
    var url = typeof window._gfxCurrentPreviewUrl === 'function' ? (window._gfxCurrentPreviewUrl() || '') : '';
    var f = gfxPv.querySelector('iframe');
    var nameEl = $('gfx-scene-head-name');
    gfxPv.querySelector('.mx-gfx-pv-cap b').textContent = nameEl ? nameEl.textContent.trim() : '';
    gfxPv.classList.toggle('is-empty', !url);
    if (!url) { if (f.src) f.removeAttribute('src'); return; }
    if (f.getAttribute('src') !== url) { f.src = url; f.addEventListener('load', gfxPvFit, { once: true }); }
    gfxPvFit();
  }
  function unloadGfxPreview() {
    if (!gfxPv) return;
    var f = gfxPv.querySelector('iframe');
    if (f.src) f.removeAttribute('src');
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────────────────
  // Anything that opens Settings at Brand Kits lands on the Sponsors page instead.
  function hookOpenSettings() {
    var orig = window.openSettings;
    if (typeof orig !== 'function' || orig.__mx) return;
    var wrapped = function (cat) {
      if (isModern() && cat === 'brandkits') { go(ITEM.sponsors.go); return; }
      var r = orig.apply(this, arguments);
      // The remembered category may be one Modern moved out (Brand Kits): open on General instead
      // of a blank page.
      if (isModern()) {
        var act = document.querySelector('#set-rail .set-rail-btn.active');
        if (!act || act.getAttribute('data-stab') === 'brandkits') {
          var gen = document.querySelector('#set-rail .set-rail-btn[data-stab="general"]');
          if (gen) gen.click();
        }
      }
      setTimeout(refresh, 30);
      return r;
    };
    wrapped.__mx = true;
    window.openSettings = wrapped;
  }
  // Search and deep links scroll straight to a control. If it sits in a Dashboard view that is not
  // showing, switch to that view first so the scroll lands on something visible.
  function hookScrollIntoView() {
    var proto = Element.prototype;
    if (proto.scrollIntoView.__mx) return;
    var orig = proto.scrollIntoView;
    var wrapped = function () {
      if (isModern()) {
        try {
          var sec = this.closest && this.closest('#dash-grid > section, #dash-brandkit');
          if (sec) {
            var key = sec.id === 'dash-brandkit' ? 'adslots' : (sec.getAttribute('data-dash-id') || sec.id);
            var views = SECTION_VIEWS[key];
            if (views && views.indexOf(mxView) === -1) { setView(views[0], true); refresh(); }
          }
        } catch (e) { /* never break a scroll */ }
      }
      return orig.apply(this, arguments);
    };
    wrapped.__mx = true;
    proto.scrollIntoView = wrapped;
  }

  // Apply on load. The <head> script already set the attribute; this builds the shell. app.js has
  // run by now (this file loads after it), so every element Modern relies on exists.
  applyStyle(readStyle(), { noSave: true });
})();
