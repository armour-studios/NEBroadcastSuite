/* ─── overlay-builder.js — Overlays ▸ Custom: build your own overlays, no code ────────────────
   Mounted into #ovb-root (made by overlays-page.js, the Custom tab). Two views:
     • Library: every custom overlay as a live thumbnail, filtered by scene type (In-game, Caster
       desk, Break, Lower third, Full screen) and game, with Edit / Copy OBS link / Add to OBS /
       Duplicate / Export / Delete; Import a shared .json; New from a template.
     • Editor: layers | 1920×1080 canvas | properties.
         Pieces: text, live data, image, shape, player list, camera, web page, ticker, progress bar,
         slideshow. Effects: rotation, skew, shadow, glass blur, entry animation. Show conditions:
         always, break up/down, in play, goal replay, post-game board, casters on, a graphic on air.
         Tools: multi-select (Shift-click or drag a box), align and distribute, bring to front / send
         to back, copy and paste between overlays, snap to frame and other pieces, grid, zoom,
         preview background, sample data, live camera previews, undo / redo.
         Keys: arrows nudge (Shift 10px), Ctrl+D duplicate, Ctrl+C / Ctrl+V, Ctrl+Z / Ctrl+Y,
         Ctrl+S save, Ctrl+A select all, Delete, Esc.
   Drawing is overlay/custom-render.js (window.CustomOverlay), the same file OBS loads via
   custom.html, so the canvas is exactly what airs. Saves go over the WS (custom_overlay_save); the
   server keeps data/custom-overlays.json (backend/custom-overlays.js). Layouts hold image URLs only. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cur() { try { return (typeof currentState !== 'undefined' && currentState) || {}; } catch (e) { return {}; } }
  function tx(type, data) { if (typeof send === 'function') send(type, data || {}); }
  function toast(m, c) { if (typeof showToast === 'function') showToast(m, c || '#22c55e', 4000); }
  var BASE = window.SCENE_BASE_URL || 'http://localhost:3000';
  var W = 1920, H = 1080;
  var CO = function () { return window.CustomOverlay; };
  function uid(p) { return (p || 'e') + Math.random().toString(36).slice(2, 10); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function obsUrl(id) { return BASE + '/custom.html?id=' + encodeURIComponent(id); }

  var KINDS = [['ingame', 'In-game'], ['caster', 'Caster desk'], ['break', 'Break'], ['lowerthird', 'Lower third'], ['fullscreen', 'Full screen'], ['other', 'Other']];
  var KIND_NAME = {}; KINDS.forEach(function (k) { KIND_NAME[k[0]] = k[1]; });
  var GFX_KEYS = [['standings', 'Standings'], ['schedule', 'Schedule'], ['bracket', 'Bracket'], ['matchup', 'Matchup'], ['winner', 'Winner'], ['intro', 'Intro'], ['veto', 'Map veto'], ['credits', 'Credits'], ['seriesstats', 'Series stats']];
  var TYPE_NAME = { text: 'Text', image: 'Image', shape: 'Shape', list: 'Player list', embed: 'Camera / web', ticker: 'Ticker', bar: 'Progress bar', slides: 'Slideshow' };
  var TYPE_ICON = { text: 'T', image: 'I', shape: 'S', list: 'P', embed: 'C', ticker: 'K', bar: 'B', slides: 'L' };

  // ── Templates ─────────────────────────────────────────────────────────────────────────────
  function T(type, name, x, y, w, h, extra) { return Object.assign({ id: uid(), type: type, name: name, x: x, y: y, w: w, h: h, opacity: 1, show: 'always', fx: {} }, extra || {}); }
  var TXT = function (o) { return Object.assign({ font: 'montserrat', size: 40, weight: 800, color: '#ffffff', align: 'center' }, o); };
  function scorebug() { return [
    T('shape', 'Bar', 560, 24, 800, 84, { shape: { fill: '#0b0f17', radius: 14 }, fx: { shadow: 'soft' } }),
    T('shape', 'Left colour', 560, 24, 14, 84, { shape: { fill: '#3d8bff', fillBind: 'team.blue.color' } }),
    T('shape', 'Right colour', 1346, 24, 14, 84, { shape: { fill: '#ff8a3d', fillBind: 'team.orange.color' } }),
    T('image', 'Left logo', 590, 34, 64, 64, { image: { bind: 'team.blue.logo', fit: 'contain' } }),
    T('image', 'Right logo', 1266, 34, 64, 64, { image: { bind: 'team.orange.logo', fit: 'contain' } }),
    T('text', 'Left name', 664, 34, 220, 64, { text: TXT({ bind: 'team.blue.name', size: 30, align: 'left', upper: true }) }),
    T('text', 'Right name', 1036, 34, 220, 64, { text: TXT({ bind: 'team.orange.name', size: 30, align: 'right', upper: true }) }),
    T('text', 'Series', 890, 30, 140, 50, { text: TXT({ bind: 'match.series', font: 'rajdhani', size: 44, weight: 700 }) }),
    T('text', 'Best of', 890, 78, 140, 24, { text: TXT({ bind: 'match.bestOf', font: 'inter', size: 14, weight: 700, color: '#9aa3b2', spacing: 1 }) }),
  ]; }
  var TEMPLATES = {
    blank: { name: 'Blank', kind: 'other', desc: 'An empty frame.', els: function () { return []; } },
    scorebug: { name: 'Scorebug', kind: 'ingame', desc: 'Team names, logos and the series, top centre. Any game.', els: scorebug },
    rlhud: { name: 'Rocket League HUD', kind: 'ingame', game: 'rocket-league', desc: 'Scorebug with goals and the clock, team boost lists, and the spectated player with a boost bar.', els: function () { return [
      T('shape', 'Bar', 610, 18, 700, 96, { shape: { fill: '#0b0f17', radius: 16 }, fx: { shadow: 'soft' } }),
      T('shape', 'Left colour', 610, 18, 260, 96, { shape: { fill: '#3d8bff', fillBind: 'team.blue.color', radius: 16, fill2: 'rgba(11,15,23,0)', angle: 90 } }),
      T('shape', 'Right colour', 1050, 18, 260, 96, { shape: { fill: 'rgba(11,15,23,0)', fill2: '#ff8a3d', radius: 16, angle: 90 } }),
      T('text', 'Left name', 630, 30, 200, 40, { text: TXT({ bind: 'team.blue.abbr', size: 30, align: 'left', upper: true }) }),
      T('text', 'Right name', 1090, 30, 200, 40, { text: TXT({ bind: 'team.orange.abbr', size: 30, align: 'right', upper: true }) }),
      T('text', 'Left score', 830, 22, 80, 80, { text: TXT({ bind: 'team.blue.score', font: 'rajdhani', size: 64 }) }),
      T('text', 'Right score', 1010, 22, 80, 80, { text: TXT({ bind: 'team.orange.score', font: 'rajdhani', size: 64 }) }),
      T('text', 'Clock', 905, 26, 110, 44, { text: TXT({ bind: 'match.clock', font: 'rajdhani', size: 36, weight: 700 }) }),
      T('text', 'Game', 905, 70, 110, 26, { text: TXT({ bind: 'match.game', font: 'inter', size: 15, color: '#9aa3b2', spacing: 1 }) }),
      T('text', 'Overtime', 860, 118, 200, 30, { text: TXT({ bind: 'match.ot', font: 'inter', size: 18, color: '#fbbf24', spacing: 2 }), fx: { anim: 'down' } }),
      T('list', 'Left team boost', 24, 420, 340, 190, { list: { side: 'blue', stat: 'boost', max: 3, gap: 8, radius: 10, font: 'montserrat', size: 22, weight: 700, color: '#ffffff', highlight: true, accent: true } }),
      T('list', 'Right team boost', 1556, 420, 340, 190, { list: { side: 'orange', stat: 'boost', max: 3, gap: 8, radius: 10, font: 'montserrat', size: 22, weight: 700, color: '#ffffff', highlight: true, accent: true } }),
      T('shape', 'Player card', 660, 930, 600, 110, { shape: { fill: 'rgba(11,15,23,0.88)', radius: 16 }, show: 'hud', fx: { blur: 8 } }),
      T('text', 'Player', 690, 940, 400, 50, { text: TXT({ bind: 'spec.name', size: 32, align: 'left', upper: true }), show: 'hud' }),
      T('text', 'Boost number', 1090, 940, 150, 50, { text: TXT({ bind: 'spec.boostText', font: 'rajdhani', size: 44, align: 'right', colorBind: 'spec.color' }), show: 'hud' }),
      T('bar', 'Boost bar', 690, 1000, 540, 18, { bar: { bind: 'spec.boost', max: 100, fill: '#3d8bff', fillBind: 'spec.color', radius: 999 }, show: 'hud' }),
    ]; } },
    replay: { name: 'Replay bug', kind: 'ingame', desc: 'A REPLAY tag and sponsor that show only during goal replays.', els: function () { return [
      T('shape', 'Tag', 60, 60, 260, 64, { shape: { fill: '#ef4444', radius: 10 }, show: 'replay', fx: { anim: 'left' } }),
      T('text', 'Replay', 60, 60, 260, 64, { text: TXT({ content: 'REPLAY', size: 34, spacing: 4 }), show: 'replay', fx: { anim: 'left' } }),
      T('image', 'Sponsor', 60, 134, 260, 80, { image: { bind: 'sponsor.rail', fit: 'contain' }, show: 'replay', fx: { anim: 'fade' } }),
    ]; } },
    caster2: { name: 'Caster desk, two cameras', kind: 'caster', desc: 'Two caster cameras with name plates, the event and the brand.', els: function () { return [
      T('shape', 'Background', 0, 0, 1920, 1080, { shape: { fill: '#05070c', fill2: '#121b2e', angle: 135 } }),
      T('image', 'Brand logo', 860, 50, 200, 120, { image: { bind: 'brand.logo', fit: 'contain' } }),
      T('text', 'Event', 360, 180, 1200, 56, { text: TXT({ bind: 'event.name', size: 36 }) }),
      T('embed', 'Caster 1 camera', 120, 280, 820, 462, { embed: { bind: 'caster.1.cam', radius: 18 }, fx: { shadow: 'soft' } }),
      T('embed', 'Caster 2 camera', 980, 280, 820, 462, { embed: { bind: 'caster.2.cam', radius: 18 }, fx: { shadow: 'soft' } }),
      T('text', 'Caster 1', 120, 760, 820, 60, { text: TXT({ bind: 'caster.1', size: 36, bg: '#0b0f17', bgRadius: 12, upper: true }) }),
      T('text', 'Caster 2', 980, 760, 820, 60, { text: TXT({ bind: 'caster.2', size: 36, bg: '#0b0f17', bgRadius: 12, upper: true }) }),
      T('text', 'Caster 1 social', 120, 826, 820, 34, { text: TXT({ bind: 'caster.1.social', font: 'inter', size: 22, weight: 600, color: '#9aa3b2' }) }),
      T('text', 'Caster 2 social', 980, 826, 820, 34, { text: TXT({ bind: 'caster.2.social', font: 'inter', size: 22, weight: 600, color: '#9aa3b2' }) }),
      T('slides', 'Sponsors', 760, 900, 400, 120, { slides: { source: 'sponsors', interval: 6, fit: 'contain' } }),
    ]; } },
    casterlt: { name: 'Caster lower thirds', kind: 'caster', desc: 'Name plates over the gameplay while the casters are on.', els: function () { return [
      T('shape', 'Plate 1', 120, 900, 560, 90, { shape: { fill: '#0b0f17', radius: 12 }, show: 'casters', fx: { anim: 'up', shadow: 'soft' } }),
      T('shape', 'Accent 1', 120, 900, 8, 90, { shape: { fill: '#3d8bff', fillBind: 'brand.color' }, show: 'casters', fx: { anim: 'up' } }),
      T('text', 'Caster 1', 150, 906, 520, 46, { text: TXT({ bind: 'caster.1', size: 30, align: 'left', upper: true }), show: 'casters', fx: { anim: 'up' } }),
      T('text', 'Caster 1 social', 150, 950, 520, 30, { text: TXT({ bind: 'caster.1.social', font: 'inter', size: 20, weight: 600, color: '#9aa3b2', align: 'left' }), show: 'casters', fx: { anim: 'up' } }),
      T('shape', 'Plate 2', 1240, 900, 560, 90, { shape: { fill: '#0b0f17', radius: 12 }, show: 'casters', fx: { anim: 'up', shadow: 'soft' } }),
      T('shape', 'Accent 2', 1792, 900, 8, 90, { shape: { fill: '#3d8bff', fillBind: 'brand.color' }, show: 'casters', fx: { anim: 'up' } }),
      T('text', 'Caster 2', 1250, 906, 520, 46, { text: TXT({ bind: 'caster.2', size: 30, align: 'right', upper: true }), show: 'casters', fx: { anim: 'up' } }),
      T('text', 'Caster 2 social', 1250, 950, 520, 30, { text: TXT({ bind: 'caster.2.social', font: 'inter', size: 20, weight: 600, color: '#9aa3b2', align: 'right' }), show: 'casters', fx: { anim: 'up' } }),
    ]; } },
    soon: { name: 'Starting soon', kind: 'break', desc: 'A full break screen with the countdown.', els: function () { return [
      T('shape', 'Background', 0, 0, 1920, 1080, { shape: { fill: '#05070c', fill2: '#111a2c', angle: 135 } }),
      T('image', 'Logo', 810, 230, 300, 300, { image: { bind: 'brand.logo', fit: 'contain' }, fx: { anim: 'zoom' } }),
      T('text', 'Title', 360, 570, 1200, 110, { text: TXT({ bind: 'break.title', size: 84, weight: 900, upper: true }), fx: { anim: 'up' } }),
      T('text', 'Countdown', 660, 680, 600, 140, { text: TXT({ bind: 'break.timer', font: 'rajdhani', size: 120, weight: 700, color: '#3d8bff', colorBind: 'brand.color' }) }),
      T('text', 'Event', 360, 840, 1200, 50, { text: TXT({ bind: 'event.name', font: 'inter', size: 28, weight: 600, color: '#9aa3b2' }) }),
      T('ticker', 'Ticker', 0, 1020, 1920, 60, { ticker: TXT({ source: 'show', font: 'inter', size: 26, weight: 600, speed: 90, bg: 'rgba(11,15,23,0.9)' }) }),
    ]; } },
    brb: { name: 'Be right back', kind: 'break', desc: 'A short break card over the game with the series and the countdown.', els: function () { return [
      T('shape', 'Dim', 0, 0, 1920, 1080, { shape: { fill: 'rgba(5,7,12,0.72)' }, fx: { blur: 10, anim: 'fade' } }),
      T('text', 'BRB', 460, 380, 1000, 130, { text: TXT({ content: 'BE RIGHT BACK', size: 96, weight: 900 }), fx: { anim: 'zoom' } }),
      T('text', 'Matchup', 460, 520, 1000, 60, { text: TXT({ content: '{team.blue.name}  {match.series}  {team.orange.name}', size: 40, weight: 700, upper: true }) }),
      T('text', 'Countdown', 760, 600, 400, 90, { text: TXT({ bind: 'break.timer', font: 'rajdhani', size: 72, colorBind: 'brand.color' }) }),
    ]; } },
    lowerthird: { name: 'Lower third', kind: 'lowerthird', desc: 'Event name and round, bottom left.', els: function () { return [
      T('shape', 'Plate', 80, 880, 760, 120, { shape: { fill: '#0b0f17', fill2: '#1b2333', radius: 12 }, fx: { anim: 'left', shadow: 'soft' } }),
      T('shape', 'Accent', 80, 880, 8, 120, { shape: { fill: '#3d8bff', fillBind: 'brand.color' }, fx: { anim: 'left' } }),
      T('text', 'Event', 112, 892, 700, 56, { text: TXT({ bind: 'event.name', size: 34, align: 'left' }), fx: { anim: 'left' } }),
      T('text', 'Round', 112, 948, 700, 40, { text: TXT({ content: '{match.round}  ·  {match.game}', font: 'inter', size: 22, weight: 600, color: '#9aa3b2', align: 'left' }), fx: { anim: 'left' } }),
    ]; } },
    matchup: { name: 'Matchup', kind: 'fullscreen', desc: 'Both teams, big, with the round and the series.', els: function () { return [
      T('shape', 'Background', 0, 0, 1920, 1080, { shape: { fill: '#05070c', fill2: '#111a2c', angle: 135 } }),
      T('shape', 'Left side', 0, 0, 960, 1080, { shape: { fill: '#3d8bff', fillBind: 'team.blue.color', fill2: 'rgba(5,7,12,0)', angle: 90 }, opacity: 0.35 }),
      T('shape', 'Right side', 960, 0, 960, 1080, { shape: { fill: 'rgba(5,7,12,0)', fill2: '#ff8a3d', angle: 90 }, opacity: 0.35 }),
      T('text', 'Round', 460, 120, 1000, 60, { text: TXT({ bind: 'match.round', font: 'inter', size: 34, weight: 700, color: '#cbd5e1', spacing: 4, upper: true }) }),
      T('image', 'Left logo', 300, 330, 380, 380, { image: { bind: 'team.blue.logo', fit: 'contain' }, fx: { anim: 'left' } }),
      T('image', 'Right logo', 1240, 330, 380, 380, { image: { bind: 'team.orange.logo', fit: 'contain' }, fx: { anim: 'right' } }),
      T('text', 'VS', 860, 450, 200, 140, { text: TXT({ content: 'VS', size: 110, weight: 900 }), fx: { anim: 'zoom' } }),
      T('text', 'Left name', 160, 740, 660, 80, { text: TXT({ bind: 'team.blue.name', size: 56, upper: true }) }),
      T('text', 'Right name', 1100, 740, 660, 80, { text: TXT({ bind: 'team.orange.name', size: 56, upper: true }) }),
      T('text', 'Series', 760, 840, 400, 70, { text: TXT({ content: 'SERIES {match.series}', font: 'rajdhani', size: 48 }) }),
    ]; } },
    ending: { name: 'Thanks for watching', kind: 'break', desc: 'The closing screen with the result and your sponsors.', els: function () { return [
      T('shape', 'Background', 0, 0, 1920, 1080, { shape: { fill: '#05070c', fill2: '#111a2c', angle: 135 } }),
      T('text', 'Thanks', 360, 300, 1200, 120, { text: TXT({ content: 'THANKS FOR WATCHING', size: 90, weight: 900 }), fx: { anim: 'up' } }),
      T('text', 'Result', 360, 450, 1200, 70, { text: TXT({ content: '{team.blue.name}  {match.series}  {team.orange.name}', size: 44, upper: true, color: '#cbd5e1' }) }),
      T('slides', 'Sponsors', 660, 640, 600, 200, { slides: { source: 'sponsors', interval: 4, fit: 'contain' } }),
    ]; } },
    sponsor: { name: 'Sponsor corner', kind: 'other', desc: 'Your rail sponsors taking turns, bottom right.', els: function () { return [
      T('shape', 'Card', 1560, 900, 320, 140, { shape: { fill: 'rgba(11,15,23,0.86)', radius: 14 }, fx: { blur: 8 } }),
      T('text', 'Label', 1580, 908, 280, 30, { text: TXT({ content: 'PARTNERS', font: 'inter', size: 16, color: '#9aa3b2', align: 'left', spacing: 2 }) }),
      T('slides', 'Sponsor', 1580, 940, 280, 88, { slides: { source: 'sponsors', interval: 6, fit: 'contain' } }),
    ]; } },
    tickerbar: { name: 'Ticker bar', kind: 'other', desc: 'Your ticker messages scrolling along the bottom.', els: function () { return [
      T('ticker', 'Ticker', 0, 1020, 1920, 60, { ticker: TXT({ source: 'show', font: 'inter', size: 26, weight: 600, speed: 90, bg: 'rgba(11,15,23,0.92)' }) }),
      T('shape', 'Accent', 0, 1016, 1920, 4, { shape: { fill: '#3d8bff', fillBind: 'brand.color' } }),
    ]; } },
  };

  // Sample data so an empty show still shows what the overlay will look like.
  function sampleState() {
    var s = cur();
    var pl = function (name, team, goals, boost) { return { name: name, team: team, score: goals * 120 + 80, goals: goals, assists: 1, saves: 2, shots: goals + 2, demos: 0, boost: boost }; };
    return Object.assign({}, s, {
      teams: { blue: { name: 'RIVERSIDE', abbr: 'RVS', color: '#3d8bff', logo: (s.teams && s.teams.blue && s.teams.blue.logo) || '' },
        orange: { name: 'LAKESIDE', abbr: 'LKS', color: '#ff8a3d', logo: (s.teams && s.teams.orange && s.teams.orange.logo) || '' } },
      series: { blue: 2, orange: 1 }, bestOf: 5, game: { number: 4, blueScore: 3, orangeScore: 1, time: 187, isOT: false },
      players: [pl('Ace', 0, 2, 74), pl('Bolt', 0, 1, 33), pl('Echo', 0, 0, 100), pl('Cruz', 1, 1, 12), pl('Dune', 1, 0, 58), pl('Flux', 1, 0, 90)],
      spectatedPlayer: 'Ace', view: 'hud',
      roundLabel: 'GRAND FINAL', eventName: s.eventName || 'Friday Night Cup',
      ticker: { messages: ['Welcome to the Grand Final', 'Follow @namelessesports for highlights', 'Next up: the awards'] },
      casters: Object.assign({}, s.casters || {}, { visible: true, list: (s.casters && s.casters.list && s.casters.list.length) ? s.casters.list : [{ slot: 1, name: 'Caster One', socialHandle: 'casterone' }, { slot: 2, name: 'Caster Two', socialHandle: 'castertwo' }] }),
      // The break counts as up only while editing a break overlay; otherwise in-game pieces ('in play',
      // 'no break') would all read as hidden in the samples.
      breakScreen: Object.assign({}, s.breakScreen || {}, { title: 'STARTING SOON', endsAt: Date.now() + 299000, frozenSeconds: null, visible: !!(editing && editing.kind === 'break') }),
    });
  }

  // ── State ─────────────────────────────────────────────────────────────────────────────────
  var root = null;
  var layouts = {};             // id -> full layout (from the server)
  var editing = null;           // the layout being edited (a working copy)
  var savedSig = '';
  var selIds = [];
  var hist = [], fut = [];
  var useSample = null;         // null = auto
  var livePreview = false;      // load camera / web embeds on the canvas
  var zoom = 'fit';
  var scale = 0.5;
  var saving = false;
  var clipboard = null;         // pieces copied with Ctrl+C, pasteable into any overlay
  var libFilter = { kind: '', game: '', q: '' };

  function mount() {
    var host = $('ovb-root');
    if (!host) return null;
    if (root === host) return root;
    root = host;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('dblclick', onDblClick);
    return root;
  }
  function gameName(g) { var x = (cur().games || {})[g]; return (x && x.name) || g || ''; }

  // ── Library ───────────────────────────────────────────────────────────────────────────────
  var libSig = '';
  function libraryList() {
    var all = cur().customOverlays || [];
    var q = libFilter.q.toLowerCase();
    return all.filter(function (o) {
      return (!libFilter.kind || (o.kind || 'other') === libFilter.kind) && (!libFilter.game || o.game === libFilter.game)
        && (!q || (o.name || '').toLowerCase().indexOf(q) >= 0);
    });
  }
  function renderLibrary() {
    var all = cur().customOverlays || [];
    var list = libraryList();
    var sig = JSON.stringify([all, libFilter]);
    if (root.getAttribute('data-view') === 'lib' && libSig === sig) { drawThumbs(); return; }
    libSig = sig;
    var focusQ = document.activeElement && document.activeElement.classList.contains('ovb-q');
    root.setAttribute('data-view', 'lib');
    var counts = {}; all.forEach(function (o) { counts[o.kind || 'other'] = (counts[o.kind || 'other'] || 0) + 1; });
    var games = {}; all.forEach(function (o) { if (o.game) games[o.game] = 1; });
    var tplHtml = KINDS.map(function (k) {
      return Object.keys(TEMPLATES).filter(function (id) { return TEMPLATES[id].kind === k[0]; }).map(function (id) {
        var t = TEMPLATES[id];
        return '<button type="button" class="ovb-tpl" data-ovb="new" data-tpl="' + id + '"><i>' + esc(KIND_NAME[t.kind]) + (t.game ? ' · ' + esc(gameName(t.game)) : '') + '</i><b>' + esc(t.name) + '</b><span>' + esc(t.desc) + '</span></button>';
      }).join('');
    }).join('');
    root.innerHTML = '<div class="ovb-libhead"><div><h2>Your overlays</h2><p>Design overlays for any scene without code: in-game HUDs, caster desks, break screens, lower thirds. Drop in text, images, shapes, cameras, player lists and live data; add it to OBS once and it follows the show.</p></div>'
      + '<div class="ovb-libhead-a"><button type="button" class="btn btn-ghost btn-sm" data-ovb="import" title="Load an overlay someone exported">Import</button><input type="file" class="ovb-import" accept=".json,application/json" hidden></div></div>'
      + '<details class="ovb-tpl-wrap"' + (all.length ? '' : ' open') + '><summary>Start a new overlay <span>from a template or blank</span></summary><div class="ovb-tpls">' + tplHtml + '</div></details>'
      + '<div class="ovb-libtools">'
      +   '<div class="ovb-chips">' + [['', 'All', all.length]].concat(KINDS.map(function (k) { return [k[0], k[1], counts[k[0]] || 0]; })).filter(function (c) { return !c[0] || c[2]; })
            .map(function (c) { return '<button type="button" data-ovb="kind" data-k="' + c[0] + '" class="' + (libFilter.kind === c[0] ? 'is-on' : '') + '">' + esc(c[1]) + '<em>' + c[2] + '</em></button>'; }).join('') + '</div>'
      +   (Object.keys(games).length ? '<select class="input-select ovb-gamef" data-ovbf="game"><option value="">All games</option>' + Object.keys(games).map(function (g) { return '<option value="' + esc(g) + '"' + (libFilter.game === g ? ' selected' : '') + '>' + esc(gameName(g)) + '</option>'; }).join('') + '</select>' : '')
      +   '<input type="search" class="input-text ovb-q" placeholder="Search overlays" value="' + esc(libFilter.q) + '">'
      + '</div>'
      + (list.length ? '<div class="ovb-grid">' + list.map(card).join('') + '</div>'
        : '<div class="ovb-empty">' + (all.length ? 'No overlays match. <button type="button" class="sev-link" data-ovb="clearf">Clear the filters</button>' : 'No custom overlays yet. Open "Start a new overlay" above.') + '</div>');
    if (focusQ) { var q = root.querySelector('.ovb-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
    drawThumbs();
  }
  function card(o) {
    return '<div class="ovb-card" data-id="' + esc(o.id) + '">'
      + '<button type="button" class="ovb-thumb" data-ovb="edit" data-id="' + esc(o.id) + '" title="Edit"><div class="ovb-thumb-stage" data-thumb="' + esc(o.id) + '"></div></button>'
      + '<div class="ovb-card-b"><b title="' + esc(o.name) + '">' + esc(o.name) + '</b><span>' + esc(KIND_NAME[o.kind || 'other'] || 'Other') + (o.game ? ' · ' + esc(gameName(o.game)) : '') + ' · ' + o.elements + ' piece' + (o.elements === 1 ? '' : 's') + '</span></div>'
      + '<div class="ovb-card-a"><button type="button" class="btn btn-secondary btn-sm" data-ovb="edit" data-id="' + esc(o.id) + '">Edit</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-ovb="copy" data-id="' + esc(o.id) + '" title="Copy the OBS browser source link">Copy link</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-ovb="obs" data-id="' + esc(o.id) + '" title="Add it to your OBS scene">Add to OBS</button>'
      + '<span class="ovb-more"><button type="button" class="ovb-ic" data-ovb="dupov" data-id="' + esc(o.id) + '" title="Duplicate">&#10697;</button>'
      + '<button type="button" class="ovb-ic" data-ovb="export" data-id="' + esc(o.id) + '" title="Export as a file to share">&#8615;</button>'
      + '<button type="button" class="ovb-ic ovb-ic-del" data-ovb="del" data-id="' + esc(o.id) + '" title="Delete">&times;</button></span></div></div>';
  }
  function drawThumbs() {
    var s = previewState();
    [].forEach.call(root.querySelectorAll('[data-thumb]'), function (box) {
      var id = box.getAttribute('data-thumb');
      var lay = layouts[id];
      var sum = (cur().customOverlays || []).filter(function (o) { return o.id === id; })[0];
      if (lay && sum && sum.updatedAt && lay.updatedAt && sum.updatedAt > lay.updatedAt) { delete layouts[id]; lay = null; box._asked = false; }
      if (!lay) { if (!box._asked) { box._asked = true; tx('custom_overlay_get', { id: id }); } return; }
      box.style.setProperty('--k', box.clientWidth / W);
      var inner = box.firstChild;
      if (!inner) { inner = document.createElement('div'); inner.className = 'ovb-thumb-inner'; box.appendChild(inner); }
      CO().render(inner, lay, s, { now: Date.now(), editor: true, thumb: true });   // editor mode: placeholders, never live camera/web frames
    });
  }
  function withLayout(id, fn) {
    var sum = (cur().customOverlays || []).filter(function (o) { return o.id === id; })[0];
    var have = layouts[id];
    if (have && !(sum && sum.updatedAt && have.updatedAt && sum.updatedAt > have.updatedAt)) return fn(have);
    root._pendingLayout = { id: id, fn: fn, at: Date.now() };
    tx('custom_overlay_get', { id: id });
    // No answer (deleted meanwhile, app busy): say so instead of a button that silently does nothing.
    setTimeout(function () { if (root._pendingLayout && root._pendingLayout.id === id) { root._pendingLayout = null; toast('Could not open that overlay. It may have been deleted.', '#fbbf24'); } }, 6000);
  }

  // ── Editor ────────────────────────────────────────────────────────────────────────────────
  function open(lay) {
    editing = clone(lay);
    editing.bg = editing.bg || { mode: 'checker', src: '' };
    editing.kind = editing.kind || 'other';
    savedSig = lay.id && layouts[lay.id] ? sigOf(layouts[lay.id]) : '';
    selIds = []; hist = []; fut = [];
    buildEditor();
  }
  function sigOf(o) { return JSON.stringify([o.name, o.kind, o.game, o.bg, o.grid, o.elements]); }
  function isDirty() { return !editing.id || sigOf(editing) !== savedSig; }
  function byId(id) { return editing.elements.filter(function (e) { return e.id === id; })[0] || null; }
  function sels() { return selIds.map(byId).filter(Boolean); }
  function sel() { return selIds.length === 1 ? byId(selIds[0]) : null; }
  function snapshot() { hist.push(JSON.stringify(editing.elements)); if (hist.length > 100) hist.shift(); fut = []; }
  function previewState() {
    var s = cur();
    var auto = !((s.teams && s.teams.blue && s.teams.blue.name) || (s.teams && s.teams.orange && s.teams.orange.name));
    // An in-game design (player lists, the spectated player) with no game feeding players also previews on samples.
    if (!auto && editing && !(Array.isArray(s.players) && s.players.length)) {
      auto = editing.elements.some(function (e) { var p = e[e.type] || {}; return e.type === 'list' || /^spec\./.test(p.bind || '') || /\{spec\./.test(p.content || ''); });
    }
    return (useSample == null ? auto : useSample) ? sampleState() : s;
  }
  function resetProps() { var p = root.querySelector('.ovb-props'); if (p) p._for = null; }

  function optsFor(kind) {
    var groups = {};
    CO().FIELDS.filter(function (f) { return f.kind === kind; }).forEach(function (f) { (groups[f.group] = groups[f.group] || []).push(f); });
    return Object.keys(groups).map(function (g) { return '<optgroup label="' + esc(g) + '">' + groups[g].map(function (f) { return '<option value="' + f.id + '">' + esc(f.label) + '</option>'; }).join('') + '</optgroup>'; }).join('');
  }
  var ALIGN_ICON = { left: '&#8676;', hcenter: '&#8596;', right: '&#8677;', top: '&#8673;', vcenter: '&#8597;', bottom: '&#8675;' };
  var ALIGN_TIP = { left: 'Align left', hcenter: 'Align centres', right: 'Align right', top: 'Align tops', vcenter: 'Align middles', bottom: 'Align bottoms' };
  function buildEditor() {
    root.setAttribute('data-view', 'edit');
    libSig = '';
    root._opts = { text: optsFor('text'), image: optsFor('image'), color: optsFor('color'), number: optsFor('number'), embed: optsFor('embed') };
    var addBtn = function (t, label) { return '<button type="button" data-ovb="add" data-type="' + t + '">' + label + '</button>'; };
    root.innerHTML = '<div class="ovb-bar">'
      + '<button type="button" class="btn btn-ghost btn-sm" data-ovb="back">&larr; Overlays</button>'
      + '<input class="input-text ovb-name" data-ovb-name value="' + esc(editing.name) + '" aria-label="Overlay name">'
      + '<div class="ovb-addmenu"><button type="button" class="btn btn-secondary btn-sm" data-ovb="addmenu">+ Add</button><div class="ovb-addpop" hidden>'
      +   '<div class="ovb-addgrp"><span>Basics</span>' + addBtn('text', 'Text') + addBtn('live', 'Live data') + addBtn('image', 'Image') + addBtn('shape', 'Shape') + addBtn('circle', 'Circle') + '</div>'
      +   '<div class="ovb-addgrp"><span>Show data</span>' + addBtn('list', 'Player list') + addBtn('bar', 'Progress bar') + addBtn('ticker', 'Ticker') + addBtn('slides', 'Slideshow') + '</div>'
      +   '<div class="ovb-addgrp"><span>Cameras and pages</span>' + addBtn('cam', 'Caster camera') + addBtn('web', 'Web page') + '</div>'
      + '</div></div>'
      + '<div class="ovb-alignbar" hidden>'
      +   ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'].map(function (a) { return '<button type="button" class="ovb-ic" data-ovb="align" data-a="' + a + '" title="' + ALIGN_TIP[a] + ' (one piece: to the frame)">' + ALIGN_ICON[a] + '</button>'; }).join('')
      +   '<button type="button" class="ovb-ic" data-ovb="dist" data-a="h" title="Space evenly across (3 or more)">&#8660;</button><button type="button" class="ovb-ic" data-ovb="dist" data-a="v" title="Space evenly down (3 or more)">&#8661;</button>'
      + '</div>'
      + '<div class="ovb-bar-r">'
      +   '<button type="button" class="ovb-ic" data-ovb="undo" title="Undo (Ctrl+Z)">&#8630;</button><button type="button" class="ovb-ic" data-ovb="redo" title="Redo (Ctrl+Y)">&#8631;</button>'
      +   '<select class="input-select ovb-zoom" data-ovbz title="Zoom"><option value="fit">Fit</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option></select>'
      +   '<label class="ovb-sample" title="Preview with sample teams, players and scores instead of the show that is loaded"><input type="checkbox" data-ovb-sample> Sample data</label>'
      +   '<span class="ovb-status"></span>'
      +   '<button type="button" class="btn btn-ghost btn-sm" data-ovb="copy">Copy OBS link</button>'
      +   '<button type="button" class="btn btn-ghost btn-sm" data-ovb="obs">Add to OBS</button>'
      +   '<button type="button" class="btn btn-primary btn-sm" data-ovb="save">Save</button>'
      + '</div></div>'
      + '<div class="ovb-body">'
      +   '<aside class="ovb-layers"><div class="ovb-ph">Layers <span>top first</span></div><div class="ovb-layer-list"></div></aside>'
      +   '<div class="ovb-canvas-wrap"><div class="ovb-canvas"><div class="ovb-bgimg"></div><div class="ovb-scaled"><div class="ovb-grid-lines" hidden></div><div class="ovb-stage"></div><div class="ovb-sels"></div><div class="ovb-sel" hidden>'
      +     ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(function (h) { return '<i data-h="' + h + '"></i>'; }).join('') + '</div>'
      +     '<div class="ovb-guide ovb-guide-v" hidden></div><div class="ovb-guide ovb-guide-h" hidden></div><div class="ovb-marquee" hidden></div></div></div>'
      +     '<p class="ovb-tip">Click to select, Shift-click or drag a box to pick several. Drag to move, handles to resize (Shift keeps the shape). Arrows nudge, Ctrl+C / Ctrl+V copy between overlays, Ctrl+D duplicates, hold Alt to stop snapping.</p></div>'
      +   '<aside class="ovb-props"></aside>'
      + '</div>';
    root.querySelector('[data-ovb-sample]').checked = previewState() !== cur();
    root.querySelector('[data-ovbz]').value = String(zoom);
    fit();
    drawAll();
  }
  function fit() {
    var wrap = root.querySelector('.ovb-canvas-wrap'), cv = root.querySelector('.ovb-canvas');
    if (!wrap || !cv) return;
    root.classList.toggle('is-narrow', root.clientWidth < 1250);
    var avail = Math.max(320, wrap.clientWidth - 8);
    scale = zoom === 'fit' ? avail / W : Number(zoom);
    cv.style.width = Math.round(W * scale) + 'px';
    cv.style.height = Math.round(H * scale) + 'px';
    cv.style.setProperty('--k', scale);
    wrap.classList.toggle('is-zoomed', zoom !== 'fit');
  }
  function drawAll() { drawBg(); drawCanvas(); drawLayers(); drawProps(); drawStatus(); }
  function drawBg() {
    var cv = root.querySelector('.ovb-canvas'), bgi = root.querySelector('.ovb-bgimg'), gl = root.querySelector('.ovb-grid-lines');
    if (!cv) return;
    var b = editing.bg || {};
    cv.setAttribute('data-bg', b.mode || 'checker');
    bgi.style.backgroundImage = b.mode === 'image' && b.src ? 'url("' + String(b.src).replace(/"/g, '%22') + '")' : 'none';
    var g = Number(editing.grid) || 0;
    gl.hidden = !g;
    if (g) gl.style.backgroundSize = g + 'px ' + g + 'px';
  }
  function drawCanvas() {
    var stage = root.querySelector('.ovb-stage'); if (!stage) return;
    CO().render(stage, editing, previewState(), { now: Date.now(), editor: true, livePreview: livePreview });
    drawSel();
  }
  function drawSel() {
    var box = root.querySelector('.ovb-sel'), many = root.querySelector('.ovb-sels'); if (!box) return;
    var list = sels();
    var one = list.length === 1 ? list[0] : null;
    box.hidden = !one;
    if (one) {
      box.style.left = one.x + 'px'; box.style.top = one.y + 'px'; box.style.width = one.w + 'px'; box.style.height = one.h + 'px';
      box.style.transform = one.fx && one.fx.rot ? 'rotate(' + one.fx.rot + 'deg)' : '';
      box.classList.toggle('is-locked', !!one.locked);
    }
    many.innerHTML = list.length > 1 ? list.map(function (e) { return '<div style="left:' + (Number(e.x) || 0) + 'px;top:' + (Number(e.y) || 0) + 'px;width:' + (Number(e.w) || 0) + 'px;height:' + (Number(e.h) || 0) + 'px"></div>'; }).join('') : '';
    var ab = root.querySelector('.ovb-alignbar'); if (ab) ab.hidden = !list.length;
  }
  function drawStatus() {
    var st = root.querySelector('.ovb-status'); if (!st) return;
    var d = isDirty();
    st.textContent = saving ? 'Saving...' : d ? 'Unsaved changes' : 'Saved';
    st.classList.toggle('is-dirty', d);
  }
  function condShort(w) {
    if (w.indexOf('gfx:') === 0) return w.slice(4);
    return { break: 'break', nobreak: 'no break', live: 'no break', hud: 'in play', replay: 'replay', board: 'board', casters: 'casters' }[w] || '';
  }
  function drawLayers() {
    var list = root.querySelector('.ovb-layer-list'); if (!list) return;
    var els = editing.elements.slice().reverse();
    var sig = JSON.stringify([selIds, els.map(function (e) { return [e.id, e.name, e.hidden, e.locked, e.type, e.show]; })]);
    if (list._sig === sig) return;
    list._sig = sig;
    list.innerHTML = els.length ? els.map(function (e) {
      var label = e.name || TYPE_NAME[e.type] || e.type;
      var cond = e.show && e.show !== 'always' ? '<em title="Shows only sometimes">' + esc(condShort(e.show)) + '</em>' : '';
      return '<div class="ovb-layer' + (selIds.indexOf(e.id) >= 0 ? ' is-sel' : '') + (e.hidden ? ' is-hidden' : '') + '" data-ovb="pick" data-id="' + e.id + '">'
        + '<i class="ovb-lt ovb-lt-' + esc(e.type) + '" title="' + esc(TYPE_NAME[e.type]) + '">' + esc(TYPE_ICON[e.type] || '?') + '</i><span>' + esc(label) + '</span>' + cond
        + '<button type="button" data-ovb="eye" data-id="' + e.id + '" title="' + (e.hidden ? 'Show' : 'Hide') + '">' + (e.hidden ? '&#9675;' : '&#9679;') + '</button>'
        + '<button type="button" data-ovb="lock" data-id="' + e.id + '" title="' + (e.locked ? 'Unlock' : 'Lock') + '" class="' + (e.locked ? 'is-on' : '') + '">L</button></div>';
    }).join('') : '<div class="ovb-layers-empty">Nothing here yet. Use + Add above, or paste pieces copied from another overlay (Ctrl+V).</div>';
  }

  // ── Properties ────────────────────────────────────────────────────────────────────────────
  function field(label, html, hint) { return '<label class="ovb-f"><span>' + esc(label) + '</span>' + html + (hint ? '<em>' + esc(hint) + '</em>' : '') + '</label>'; }
  function numIn(k, v, min, max, step) { return '<input type="number" class="input-text" data-p="' + k + '" value="' + esc(v) + '"' + (min != null ? ' min="' + min + '"' : '') + (max != null ? ' max="' + max + '"' : '') + ' step="' + (step || 1) + '">'; }
  function colorIn(k, v) { var hex = /^#[0-9a-f]{6}$/i.test(v || '') ? v : '#ffffff'; return '<span class="ovb-color"><input type="color" data-p="' + k + '" value="' + esc(hex) + '"><input type="text" class="input-text" data-p="' + k + '" value="' + esc(v || '') + '" placeholder="none"></span>'; }
  function selIn(k, v, opts) { return '<select class="input-select" data-p="' + k + '">' + opts.replace('value="' + v + '"', 'value="' + v + '" selected') + '</select>'; }
  function check(k, v, label) { return '<label><input type="checkbox" data-p="' + k + '"' + (v ? ' checked' : '') + '> ' + esc(label) + '</label>'; }
  function section(title, body, open) { return '<details class="ovb-sec"' + (open ? ' open' : '') + '><summary>' + esc(title) + '</summary><div class="ovb-sec-b">' + body + '</div></details>'; }
  var FONT_OPTS = '<option value="inter">Inter</option><option value="montserrat">Montserrat</option><option value="rajdhani">Rajdhani</option><option value="mono">Mono</option>';
  var WEIGHT_OPTS = '<option value="400">Regular</option><option value="500">Medium</option><option value="600">Semibold</option><option value="700">Bold</option><option value="800">Extra bold</option><option value="900">Black</option>';
  var ANIM_OPTS = '<option value="">None</option><option value="fade">Fade in</option><option value="up">Slide up</option><option value="down">Slide down</option><option value="left">Slide in from the left</option><option value="right">Slide in from the right</option><option value="zoom">Zoom in</option>';
  function textControls(prefix, t, colorOpts) {
    return '<div class="ovb-row2">' + field('Font', selIn(prefix + '.font', t.font || 'inter', FONT_OPTS)) + field('Weight', selIn(prefix + '.weight', String(t.weight || 700), WEIGHT_OPTS)) + '</div>'
      + '<div class="ovb-row2">' + field('Size', numIn(prefix + '.size', t.size || 40, 6, 600)) + field('Letter spacing', numIn(prefix + '.spacing', t.spacing || 0, -10, 40, 0.5)) + '</div>'
      + field('Colour from', selIn(prefix + '.colorBind', t.colorBind || '', '<option value="">A fixed colour</option>' + colorOpts))
      + (t.colorBind ? '' : field('Colour', colorIn(prefix + '.color', t.color || '#ffffff')))
      + '<div class="ovb-checks">' + check(prefix + '.upper', t.upper, 'Uppercase') + check(prefix + '.italic', t.italic, 'Italic') + check(prefix + '.shadow', t.shadow, 'Shadow') + '</div>'
      + '<div class="ovb-row2">' + field('Outline', numIn(prefix + '.strokeW', t.strokeW || 0, 0, 20, 0.5)) + (t.strokeW ? field('Outline colour', colorIn(prefix + '.strokeColor', t.strokeColor || '#000000')) : '<span></span>') + '</div>';
  }
  function showOpts() {
    return CO().SHOW.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join('')
      + '<optgroup label="When a graphic is on air">' + GFX_KEYS.map(function (g) { return '<option value="gfx:' + g[0] + '">' + esc(g[1]) + ' is on air</option>'; }).join('') + '</optgroup>';
  }
  function drawProps() {
    var p = root.querySelector('.ovb-props'); if (!p) return;
    var key = selIds.join(',');
    if (p.contains(document.activeElement) && p._for === key) return;   // typing: leave the fields alone
    p._for = key;
    var list = sels();
    if (!list.length) { p.innerHTML = overlayProps(); return; }
    var tools = '<button type="button" class="ovb-ic" data-ovb="front" title="Bring to front">&#8679;</button><button type="button" class="ovb-ic" data-ovb="backz" title="Send to back">&#8681;</button>'
      + '<button type="button" class="ovb-ic" data-ovb="dup" title="Duplicate (Ctrl+D)">&#10697;</button><button type="button" class="ovb-ic ovb-ic-del" data-ovb="remove" title="Delete">&times;</button>';
    if (list.length > 1) {
      p.innerHTML = '<div class="ovb-ph">' + list.length + ' pieces' + tools + '</div><div class="ovb-pbody">'
        + '<p class="ovb-note">Drag any of them to move them together. The align buttons in the bar line them up.</p>'
        + field('Show', '<select class="input-select" data-pmulti="show"><option value="">(mixed)</option>' + showOpts() + '</select>')
        + field('Entry animation', '<select class="input-select" data-pmulti="fx.anim"><option value="">(mixed)</option>' + ANIM_OPTS.replace('<option value="">None</option>', '<option value="none">None</option>') + '</select>')
        + field('Opacity', '<input type="range" min="0" max="1" step="0.05" data-pmulti="opacity" value="1">')
        + '</div>';
      return;
    }
    var e = list[0];
    var o = '<div class="ovb-ph">' + esc(TYPE_NAME[e.type]) + tools + '</div><div class="ovb-pbody">';
    o += field('Name', '<input class="input-text" data-p="name" value="' + esc(e.name || '') + '" placeholder="Shown in Layers">');
    o += '<div class="ovb-row4">' + field('X', numIn('x', e.x)) + field('Y', numIn('y', e.y)) + field('Width', numIn('w', e.w, 1)) + field('Height', numIn('h', e.h, 1)) + '</div>';
    o += typeProps(e);
    var fx = e.fx || {};
    o += section('Effects', '<div class="ovb-row2">' + field('Rotate', numIn('fx.rot', fx.rot || 0, -360, 360)) + field('Slant', numIn('fx.skew', fx.skew || 0, -45, 45)) + '</div>'
      + '<div class="ovb-row2">' + field('Shadow', selIn('fx.shadow', fx.shadow || '', '<option value="">None</option><option value="soft">Soft</option><option value="hard">Hard</option><option value="glow">Glow</option>'))
      + field('Glass blur', numIn('fx.blur', fx.blur || 0, 0, 40), 'Blurs what is behind it.') + '</div>'
      + field('Opacity', '<input type="range" min="0" max="1" step="0.05" data-p="opacity" value="' + (e.opacity == null ? 1 : e.opacity) + '">'), !!(fx.rot || fx.skew || fx.shadow || fx.blur));
    o += section('When it shows', field('Show', selIn('show', e.show || 'always', showOpts()))
      + '<div class="ovb-row2">' + field('Entry animation', selIn('fx.anim', fx.anim || '', ANIM_OPTS)) + field('Duration (ms)', numIn('fx.animMs', fx.animMs || 500, 100, 4000, 50)) + '</div>'
      + (fx.anim ? '<button type="button" class="btn btn-ghost btn-sm" data-ovb="preview-anim">Preview the animation</button>' : ''), true);
    o += '</div>';
    p.innerHTML = o;
  }
  function typeProps(e) {
    var O = root._opts, o = '';
    if (e.type === 'text') {
      var t = e.text || {};
      o += field('Live data', selIn('text.bind', t.bind || '', '<option value="">None: type it below</option>' + O.text), 'Follows the show on its own.');
      if (!t.bind) o += field('Text', '<textarea class="input-text" rows="2" data-p="text.content">' + esc(t.content || '') + '</textarea>', 'Mix in live values: {team.blue.name}, {match.series}, {match.clock}, {break.timer}...');
      o += textControls('text', t, O.color);
      o += field('Align', '<div class="ovb-seg">' + ['left', 'center', 'right'].map(function (a) { return '<button type="button" data-ovb="align-text" data-v="' + a + '" class="' + ((t.align || 'center') === a ? 'is-on' : '') + '">' + a.charAt(0).toUpperCase() + a.slice(1) + '</button>'; }).join('') + '</div>');
      o += section('Background and layout', field('Background', colorIn('text.bg', t.bg || '')) + '<div class="ovb-row2">' + field('Corner radius', numIn('text.bgRadius', t.bgRadius || 0, 0, 2000)) + field('Side padding', numIn('text.padX', t.padX || 0, 0, 400)) + '</div>'
        + '<div class="ovb-row2">' + field('Vertical', selIn('text.valign', t.valign || 'middle', '<option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option>')) + field('Line height', numIn('text.lineHeight', t.lineHeight || 1.1, 0.6, 3, 0.05)) + '</div>'
        + '<div class="ovb-checks">' + check('text.wrap', t.wrap, 'Wrap onto several lines') + '</div>', !!(t.bg || t.wrap));
    } else if (e.type === 'image') {
      var im = e.image || {};
      o += field('Live image', selIn('image.bind', im.bind || '', '<option value="">None: use a picture</option>' + O.image), 'A team logo, the brand logo or a sponsor that follows the show.');
      if (!im.bind) o += field('Picture', '<span class="ovb-pic"><input class="input-text" data-p="image.src" value="' + esc(im.src || '') + '" placeholder="https://... or pick one"><button type="button" class="btn btn-secondary btn-sm" data-ovb="lib" data-k="image.src">Library</button></span>');
      o += '<div class="ovb-row2">' + field('Fit', selIn('image.fit', im.fit || 'contain', '<option value="contain">Fit inside</option><option value="cover">Fill and crop</option><option value="fill">Stretch</option>')) + field('Corner radius', numIn('image.radius', im.radius || 0, 0, 2000)) + '</div>';
      o += '<div class="ovb-checks">' + check('image.gray', im.gray, 'Black and white') + '</div>';
    } else if (e.type === 'shape') {
      var sh = e.shape || {};
      o += field('Colour from', selIn('shape.fillBind', sh.fillBind || '', '<option value="">A fixed colour</option>' + O.color));
      if (!sh.fillBind) o += field('Fill', colorIn('shape.fill', sh.fill || '#111827'));
      o += field('Fade to (optional)', colorIn('shape.fill2', sh.fill2 || ''), 'A gradient. Clear it for a solid fill.');
      if (sh.fill2) o += field('Gradient angle', numIn('shape.angle', sh.angle == null ? 90 : sh.angle, 0, 360, 15));
      o += '<div class="ovb-row2">' + field('Corner radius', numIn('shape.radius', sh.radius || 0, 0, 2000)) + field('Border', numIn('shape.borderW', sh.borderW || 0, 0, 100)) + '</div>';
      if (sh.borderW) o += field('Border colour from', selIn('shape.borderBind', sh.borderBind || '', '<option value="">A fixed colour</option>' + O.color)) + (sh.borderBind ? '' : field('Border colour', colorIn('shape.borderColor', sh.borderColor || '#ffffff')));
      o += '<div class="ovb-checks">' + check('shape.circle', sh.circle, 'Circle / ellipse') + '</div>';
    } else if (e.type === 'list') {
      var L = e.list || {};
      o += '<div class="ovb-row2">' + field('Team', selIn('list.side', L.side || 'blue', '<option value="blue">Left team</option><option value="orange">Right team</option><option value="all">Everyone</option>'))
        + field('Rows', numIn('list.max', L.max || 3, 1, 10)) + '</div>';
      o += field('Stat beside each name', selIn('list.stat', L.stat || '', '<option value="">None</option><option value="boost">Boost bar</option><option value="score">Score</option><option value="goals">Goals</option><option value="assists">Assists</option><option value="saves">Saves</option><option value="shots">Shots</option><option value="demos">Demos</option>'), 'Rocket League sends live player stats; other games list the roster names.');
      o += '<div class="ovb-checks">' + check('list.highlight', L.highlight, 'Highlight the spectated player') + check('list.accent', L.accent, 'Team colour edge') + check('list.sort', L.sort, 'Sort by the stat') + '</div>';
      o += textControls('list', L, O.color);
      o += section('Rows', field('Row colour', colorIn('list.bg', L.bg || 'rgba(11,15,23,.82)')) + field('Highlight colour (blank = team colour)', colorIn('list.hlBg', L.hlBg || '')) + field('Stat colour (blank = team colour)', colorIn('list.statColor', L.statColor || ''))
        + '<div class="ovb-row2">' + field('Gap', numIn('list.gap', L.gap == null ? 6 : L.gap, 0, 200)) + field('Corner radius', numIn('list.radius', L.radius || 0, 0, 200)) + '</div>', false);
    } else if (e.type === 'embed') {
      var em = e.embed || {};
      o += field('Show', selIn('embed.bind', em.bind || '', '<option value="">A web page (link below)</option>' + O.embed), 'A caster camera follows whoever sits in that desk seat (Talent, Desk lineup).');
      if (!em.bind) o += field('Link', '<input class="input-text" data-p="embed.src" value="' + esc(em.src || '') + '" placeholder="https://...">', 'Any page: a VDO.Ninja view link, a chat widget, another overlay.');
      o += field('Corner radius', numIn('embed.radius', em.radius || 0, 0, 2000));
      o += '<div class="ovb-checks"><label><input type="checkbox" data-ovb-live' + (livePreview ? ' checked' : '') + '> Load cameras and pages on the canvas</label></div>';
    } else if (e.type === 'ticker') {
      var tk = e.ticker || {};
      o += field('Messages', selIn('ticker.source', tk.source || 'show', '<option value="show">The show ticker (Graphics, Ticker)</option><option value="custom">My own text</option>'));
      if (tk.source === 'custom') o += field('Text, one message per line', '<textarea class="input-text" rows="3" data-p="ticker.text">' + esc(tk.text || '') + '</textarea>');
      o += '<div class="ovb-row2">' + field('Speed (px/s)', numIn('ticker.speed', tk.speed || 90, 10, 1000, 10)) + field('Separator', '<input class="input-text" data-p="ticker.sep" value="' + esc(tk.sep == null ? '   •   ' : tk.sep) + '">') + '</div>';
      o += field('Background', colorIn('ticker.bg', tk.bg || 'rgba(11,15,23,.9)'));
      o += textControls('ticker', tk, O.color);
    } else if (e.type === 'bar') {
      var b = e.bar || {};
      o += field('Value from', selIn('bar.bind', b.bind || '', '<option value="">A fixed value</option>' + O.number));
      if (!b.bind) o += '<div class="ovb-row2">' + field('Value', numIn('bar.value', b.value == null ? 50 : b.value, 0)) + field('Out of', numIn('bar.max', b.max || 100, 1)) + '</div>';
      o += field('Direction', selIn('bar.dir', b.dir || 'h', '<option value="h">Left to right</option><option value="rtl">Right to left</option><option value="v">Bottom to top</option>'));
      o += field('Colour from', selIn('bar.fillBind', b.fillBind || '', '<option value="">A fixed colour</option>' + O.color));
      if (!b.fillBind) o += field('Fill', colorIn('bar.fill', b.fill || '#3d8bff'));
      o += field('Track', colorIn('bar.track', b.track || 'rgba(255,255,255,.12)')) + field('Corner radius', numIn('bar.radius', b.radius == null ? 999 : b.radius, 0, 2000));
    } else if (e.type === 'slides') {
      var sl = e.slides || {};
      o += field('Pictures', selIn('slides.source', sl.source || 'images', '<option value="images">My pictures</option><option value="sponsors">The brand kit rail sponsors</option>'));
      if (sl.source !== 'sponsors') {
        o += '<div class="ovb-slides">' + (sl.images || []).map(function (u, i) { return '<span class="ovb-slide"><img alt="" src="' + esc(u) + '"><button type="button" data-ovb="slide-rm" data-i="' + i + '" title="Remove">&times;</button></span>'; }).join('')
          + '<button type="button" class="btn btn-secondary btn-sm" data-ovb="lib" data-k="slides.add">+ Picture</button></div>';
      }
      o += '<div class="ovb-row2">' + field('Seconds each', numIn('slides.interval', sl.interval || 6, 1, 600)) + field('Fit', selIn('slides.fit', sl.fit || 'contain', '<option value="contain">Fit inside</option><option value="cover">Fill and crop</option>')) + '</div>';
    }
    return o;
  }
  function overlayProps() {
    var games = cur().games || {};
    var b = editing.bg || {};
    var pick = function (html, v) { return html.replace('value="' + v + '"', 'value="' + v + '" selected'); };
    return '<div class="ovb-ph">Overlay</div><div class="ovb-pbody">'
      + field('Scene type', '<select class="input-select" data-ovs="kind">' + KINDS.map(function (k) { return '<option value="' + k[0] + '"' + (editing.kind === k[0] ? ' selected' : '') + '>' + esc(k[1]) + '</option>'; }).join('') + '</select>', 'Sorts it in your library.')
      + field('Game', '<select class="input-select" data-ovs="game"><option value="">Any game</option>' + Object.keys(games).map(function (g) { return '<option value="' + esc(g) + '"' + (editing.game === g ? ' selected' : '') + '>' + esc(games[g].name || g) + '</option>'; }).join('') + '</select>')
      + field('Preview background', pick('<select class="input-select" data-ovs="bg.mode"><option value="checker">Checkerboard</option><option value="dark">Dark</option><option value="light">Light</option><option value="image">A picture (a gameplay screenshot)</option></select>', b.mode || 'checker'), 'Only in the editor. On air the overlay is see-through.')
      + (b.mode === 'image' ? field('Background picture', '<span class="ovb-pic"><input class="input-text" data-ovs="bg.src" value="' + esc(b.src || '') + '" placeholder="https://..."><button type="button" class="btn btn-secondary btn-sm" data-ovb="lib" data-k="bg.src">Library</button></span>') : '')
      + field('Grid', pick('<select class="input-select" data-ovs="grid"><option value="0">Off</option><option value="8">8 px</option><option value="16">16 px</option><option value="32">32 px</option><option value="48">48 px</option></select>', editing.grid || 0), 'Pieces snap to it while you drag.')
      + '<div class="ovb-checks"><label><input type="checkbox" data-ovb-live' + (livePreview ? ' checked' : '') + '> Load cameras and pages on the canvas</label></div>'
      + field('OBS link', '<input class="input-text" readonly value="' + esc(editing.id ? obsUrl(editing.id) : 'Save first to get a link') + '">', '1920 x 1080 browser source. It updates on stream each time you save.')
      + '<p class="ovb-note">Select a piece on the canvas or in Layers to edit it. Ctrl+A selects everything.</p></div>';
  }

  // ── Edits ─────────────────────────────────────────────────────────────────────────────────
  function setPath(o, path, v) {
    var parts = path.split('.');
    var c = o;
    for (var i = 0; i < parts.length - 1; i++) { c[parts[i]] = c[parts[i]] || {}; c = c[parts[i]]; }
    c[parts[parts.length - 1]] = v;
  }
  function addEl(kind) {
    snapshot();
    var n = editing.elements.length;
    var x = 760 + (n % 6) * 24, y = 420 + (n % 6) * 24;
    var e;
    if (kind === 'text') e = T('text', 'Text', x, y, 400, 90, { text: TXT({ content: 'Your text', size: 56 }) });
    else if (kind === 'live') e = T('text', 'Live data', x, y, 420, 90, { text: TXT({ bind: 'team.blue.name', size: 56, upper: true }) });
    else if (kind === 'image') e = T('image', 'Image', x, y, 240, 240, { image: { bind: 'team.blue.logo', fit: 'contain' } });
    else if (kind === 'shape') e = T('shape', 'Shape', x, y, 400, 120, { shape: { fill: '#0b0f17', radius: 12 } });
    else if (kind === 'circle') e = T('shape', 'Circle', x, y, 200, 200, { shape: { fill: '#3d8bff', fillBind: 'brand.color', circle: true } });
    else if (kind === 'list') e = T('list', 'Player list', 60, 420, 360, 200, { list: { side: 'blue', stat: 'boost', max: 3, gap: 8, radius: 10, font: 'montserrat', size: 22, weight: 700, color: '#ffffff', highlight: true, accent: true } });
    else if (kind === 'bar') e = T('bar', 'Progress bar', x, y, 400, 18, { bar: { bind: 'spec.boost', max: 100, fill: '#3d8bff', fillBind: 'spec.color', radius: 999 } });
    else if (kind === 'ticker') e = T('ticker', 'Ticker', 0, 1020, 1920, 60, { ticker: TXT({ source: 'show', font: 'inter', size: 26, weight: 600, speed: 90, bg: 'rgba(11,15,23,0.9)' }) });
    else if (kind === 'slides') e = T('slides', 'Slideshow', x, y, 400, 160, { slides: { source: 'sponsors', interval: 6, fit: 'contain' } });
    else if (kind === 'cam') e = T('embed', 'Caster camera', 640, 300, 640, 360, { embed: { bind: 'caster.1.cam', radius: 16 } });
    else e = T('embed', 'Web page', 640, 300, 640, 360, { embed: { src: '', radius: 0 } });
    editing.elements.push(e);
    selIds = [e.id];
    drawAll();
  }
  function reorder(dir) {
    var picked = sels(); if (!picked.length) return;
    snapshot();
    var rest = editing.elements.filter(function (e) { return picked.indexOf(e) < 0; });
    editing.elements = dir === 'front' ? rest.concat(picked) : picked.concat(rest);
    drawAll();
  }
  function align(how) {
    var list = sels(); if (!list.length) return;
    snapshot();
    var bx = list.length === 1 ? { x: 0, y: 0, r: W, b: H } : {
      x: Math.min.apply(null, list.map(function (e) { return e.x; })), y: Math.min.apply(null, list.map(function (e) { return e.y; })),
      r: Math.max.apply(null, list.map(function (e) { return e.x + e.w; })), b: Math.max.apply(null, list.map(function (e) { return e.y + e.h; })) };
    list.forEach(function (e) {
      if (e.locked) return;
      if (how === 'left') e.x = bx.x; else if (how === 'right') e.x = bx.r - e.w; else if (how === 'hcenter') e.x = Math.round((bx.x + bx.r) / 2 - e.w / 2);
      else if (how === 'top') e.y = bx.y; else if (how === 'bottom') e.y = bx.b - e.h; else if (how === 'vcenter') e.y = Math.round((bx.y + bx.b) / 2 - e.h / 2);
    });
    resetProps();
    drawAll();
  }
  function distribute(axis) {
    var list = sels().filter(function (e) { return !e.locked; });
    if (list.length < 3) { toast('Pick three or more pieces to space them evenly.', '#fbbf24'); return; }
    snapshot();
    var k = axis === 'h' ? 'x' : 'y', d = axis === 'h' ? 'w' : 'h';
    list.sort(function (a, b) { return a[k] - b[k]; });
    var start = list[0][k], end = list[list.length - 1][k] + list[list.length - 1][d];
    var total = list.reduce(function (n, e) { return n + e[d]; }, 0);
    var gap = (end - start - total) / (list.length - 1), pos = start;
    list.forEach(function (e) { e[k] = Math.round(pos); pos += e[d] + gap; });
    resetProps();
    drawAll();
  }
  function paste() {
    if (!clipboard || !clipboard.length) return;
    snapshot();
    var copies = clipboard.map(function (e) { var c = clone(e); c.id = uid(); c.x += 24; c.y += 24; return c; });
    clipboard = copies.map(clone);   // a second paste steps again
    editing.elements = editing.elements.concat(copies);
    selIds = copies.map(function (c) { return c.id; });
    drawAll();
    toast(copies.length + ' piece' + (copies.length === 1 ? '' : 's') + ' pasted.', '#3d8bff');
  }
  function dup() {
    var list = sels(); if (!list.length) return;
    snapshot();
    var copies = list.map(function (e) { var c = clone(e); c.id = uid(); c.x += 20; c.y += 20; c.name = (e.name || TYPE_NAME[e.type]) + ' copy'; return c; });
    editing.elements = editing.elements.concat(copies);
    selIds = copies.map(function (c) { return c.id; });
    drawAll();
  }
  function removeSel() { if (!selIds.length) return; snapshot(); editing.elements = editing.elements.filter(function (x) { return selIds.indexOf(x.id) < 0; }); selIds = []; drawAll(); }
  function save(then) {
    if (saving) return;
    saving = true; drawStatus();
    var reqId = uid('r');
    root._saveReq = { id: reqId, then: then, target: editing, sig: sigOf(editing) };
    tx('custom_overlay_save', { overlay: editing, reqId: reqId });
    setTimeout(function () { if (saving && root._saveReq && root._saveReq.id === reqId) { saving = false; drawStatus(); toast('The app did not answer. Is it still running?', '#fbbf24'); } }, 8000);
  }
  function copyLink(id) {
    var u = obsUrl(id);
    try { navigator.clipboard.writeText(u).then(function () { toast('OBS link copied. Add it as a Browser source, 1920 x 1080.'); }); } catch (e) { toast(u, '#3d8bff'); }
  }
  function addToObs(id, name) {
    tx('obs_add_overlay', { sourceName: 'NE Custom - ' + (name || 'Overlay'), url: obsUrl(id), width: 1920, height: 1080 });
    toast('Adding "' + (name || 'Overlay') + '" to your OBS scene...', '#3d8bff');
  }
  function withSaved(fn) {
    if (editing && editing.id && !isDirty()) return fn(editing.id, editing.name);
    if (saving) { toast('Saving... try again in a moment.', '#3d8bff'); return; }
    save(function (o) { fn(o.id, o.name); });
  }
  function exportLayout(lay) {
    var data = { format: 'ne-custom-overlay', version: 2, overlay: { name: lay.name, kind: lay.kind, game: lay.game, grid: lay.grid, elements: lay.elements } };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ((lay.name || 'overlay').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '-').toLowerCase() || 'overlay') + '.overlay.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  // An imported file is someone else's: it must not be able to put markup into the editor or point
  // a page frame at a script URL before it is saved (the server sanitises on save; the editor draws
  // it before that). Known types only, numbers as numbers, links http(s) or this app's own paths.
  var SAFE_URL = /^(https?:\/\/|\/)/i;
  function cleanUrls(o) {
    if (!o || typeof o !== 'object') return o;
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (typeof v === 'string' && /(src|url|logo)$/i.test(k) && v && !SAFE_URL.test(v.trim())) o[k] = '';
      else if (Array.isArray(v)) o[k] = v.map(function (x) { return typeof x === 'string' && k === 'images' ? (SAFE_URL.test(x.trim()) ? x : '') : x; }).filter(function (x) { return x !== ''; });
      else if (v && typeof v === 'object') cleanUrls(v);
    });
    return o;
  }
  function cleanImported(e) {
    if (!e || typeof e !== 'object' || !TYPE_NAME[e.type]) return null;
    var c = cleanUrls(clone(e));
    c.id = uid();
    ['x', 'y', 'w', 'h'].forEach(function (k) { var n = Number(c[k]); c[k] = isFinite(n) ? Math.round(n) : (k === 'w' || k === 'h' ? 100 : 0); });
    c.opacity = isFinite(Number(c.opacity)) ? Math.max(0, Math.min(1, Number(c.opacity))) : 1;
    c.name = String(c.name || '').slice(0, 60);
    c.show = typeof c.show === 'string' ? c.show.slice(0, 40) : 'always';
    return c;
  }
  function importFile(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(r.result);
        var o = d && d.overlay ? d.overlay : d;
        if (!o || !Array.isArray(o.elements)) throw new Error('That file is not an overlay.');
        var els = o.elements.map(cleanImported).filter(Boolean).slice(0, 200);
        open({ id: '', name: String(o.name || 'Imported overlay').slice(0, 80), kind: KIND_NAME[o.kind] ? o.kind : 'other', game: String(o.game || '').slice(0, 40), grid: [0, 8, 16, 32, 48].indexOf(Number(o.grid)) >= 0 ? Number(o.grid) : 0, elements: els });
        if (els.length < o.elements.length) toast((o.elements.length - els.length) + ' piece(s) in that file were not overlay pieces and were left out.', '#fbbf24');
        toast('Imported. Save it to keep it.', '#3d8bff');
      } catch (e) { toast((e && e.message) || 'Could not read that file.', '#ef4444'); }
    };
    r.readAsText(file);
  }

  function onClick(ev) {
    var b = ev.target.closest('[data-ovb]');
    if (!b) {
      var pop = root.querySelector('.ovb-addpop'); if (pop && !pop.hidden && !ev.target.closest('.ovb-addmenu')) pop.hidden = true;
      return;
    }
    var act = b.getAttribute('data-ovb'), id = b.getAttribute('data-id');
    if (act === 'new') { var t = TEMPLATES[b.getAttribute('data-tpl')] || TEMPLATES.blank; open({ id: '', name: t.name === 'Blank' ? 'Untitled overlay' : t.name, kind: t.kind, game: t.game || '', grid: 0, elements: t.els() }); }
    else if (act === 'edit') withLayout(id, open);
    else if (act === 'copy') { if (id) copyLink(id); else withSaved(copyLink); }
    else if (act === 'obs') { if (id) addToObs(id, ((cur().customOverlays || []).filter(function (o) { return o.id === id; })[0] || {}).name); else withSaved(addToObs); }
    else if (act === 'dupov') withLayout(id, function (lay) { var c = clone(lay); c.id = ''; c.name = lay.name + ' copy'; c.elements.forEach(function (e) { e.id = uid(); }); tx('custom_overlay_save', { overlay: c, reqId: uid('r') }); toast('Duplicated "' + lay.name + '".', '#3d8bff'); });
    else if (act === 'export') withLayout(id, exportLayout);
    else if (act === 'import') { var inp = root.querySelector('.ovb-import'); if (inp) { inp.value = ''; inp.onchange = function () { if (inp.files && inp.files[0]) importFile(inp.files[0]); }; inp.click(); } }
    else if (act === 'kind') { libFilter.kind = b.getAttribute('data-k') || ''; renderLibrary(); }
    else if (act === 'clearf') { libFilter = { kind: '', game: '', q: '' }; renderLibrary(); }
    else if (act === 'del') {
      var name = ((cur().customOverlays || []).filter(function (o) { return o.id === id; })[0] || {}).name || 'this overlay';
      var go = function () { tx('custom_overlay_delete', { id: id }); delete layouts[id]; };
      if (typeof customConfirm === 'function') customConfirm('Delete "' + name + '"?', 'Any OBS source showing it goes blank.', 'Delete').then(function (ok) { if (ok) go(); });
      else if (window.confirm('Delete "' + name + '"?')) go();
    }
    else if (act === 'back') {
      var leave = function () { editing = null; selIds = []; render(); };
      if (isDirty() && editing.elements.length && typeof customConfirm === 'function') customConfirm('Leave without saving?', 'Your changes to this overlay are lost.', 'Leave').then(function (ok) { if (ok) leave(); });
      else leave();
    }
    else if (act === 'addmenu') { var p2 = root.querySelector('.ovb-addpop'); p2.hidden = !p2.hidden; }
    else if (act === 'add') { root.querySelector('.ovb-addpop').hidden = true; addEl(b.getAttribute('data-type')); }
    else if (act === 'save') save();
    else if (act === 'undo') { if (hist.length) { fut.push(JSON.stringify(editing.elements)); editing.elements = JSON.parse(hist.pop()); selIds = selIds.filter(byId); resetProps(); drawAll(); } }
    else if (act === 'redo') { if (fut.length) { hist.push(JSON.stringify(editing.elements)); editing.elements = JSON.parse(fut.pop()); selIds = selIds.filter(byId); resetProps(); drawAll(); } }
    else if (act === 'pick') { if (!ev.target.closest('button')) pick(id, ev.shiftKey); }
    else if (act === 'eye' || act === 'lock') { snapshot(); var e1 = byId(id); var f = act === 'eye' ? 'hidden' : 'locked'; if (e1) { e1[f] = !e1[f]; drawAll(); } }
    else if (act === 'remove') removeSel();
    else if (act === 'dup') dup();
    else if (act === 'front') reorder('front');
    else if (act === 'backz') reorder('back');
    else if (act === 'align') align(b.getAttribute('data-a'));
    else if (act === 'dist') distribute(b.getAttribute('data-a'));
    else if (act === 'align-text') { var e2 = sel(); if (e2) { snapshot(); e2.text.align = b.getAttribute('data-v'); resetProps(); drawAll(); } }
    else if (act === 'preview-anim') { var e5 = sel(); if (e5) CO().replay(root.querySelector('.ovb-stage'), e5.id); }
    else if (act === 'slide-rm') { var e4 = sel(); if (e4) { snapshot(); e4.slides.images.splice(Number(b.getAttribute('data-i')), 1); resetProps(); drawAll(); } }
    else if (act === 'lib') {
      var k = b.getAttribute('data-k');
      if (typeof mpOpen !== 'function') return;
      mpOpen(function (u) {
        if (!u) return;
        if (k === 'bg.src') { editing.bg = editing.bg || {}; editing.bg.src = u; resetProps(); drawAll(); return; }
        var e3 = sel(); if (!e3) return;
        snapshot();
        if (k === 'slides.add') e3.slides.images = (e3.slides.images || []).concat([u]);
        else setPath(e3, k, u);
        resetProps(); drawAll();
      });
    }
  }
  function pick(id, add) {
    if (add) { var i = selIds.indexOf(id); if (i >= 0) selIds.splice(i, 1); else selIds.push(id); }
    else selIds = [id];
    drawAll();
  }
  function onDblClick(ev) {
    // Double-click a text piece on the canvas: jump to its text box.
    if (!editing || !ev.target.closest('.ovb-canvas')) return;
    var e = sel(); if (!e || e.type !== 'text') return;
    var ta = root.querySelector('[data-p="text.content"]');
    if (ta) { ta.focus(); ta.select(); }
  }
  var typingSnap = null;
  function onInput(ev) {
    var t = ev.target;
    if (t.classList && t.classList.contains('ovb-q')) { libFilter.q = t.value; renderLibrary(); return; }
    if (t.getAttribute && t.getAttribute('data-ovbf') === 'game') { libFilter.game = t.value; renderLibrary(); return; }
    if (!editing) return;
    if (t.hasAttribute('data-ovb-name')) { editing.name = t.value; drawStatus(); return; }
    if (t.hasAttribute('data-ovb-sample')) { useSample = t.checked; drawCanvas(); return; }
    if (t.hasAttribute('data-ovb-live')) { livePreview = t.checked; drawCanvas(); return; }
    if (t.hasAttribute('data-ovbz')) { zoom = t.value === 'fit' ? 'fit' : Number(t.value); fit(); drawCanvas(); return; }
    var ovs = t.getAttribute('data-ovs');
    if (ovs) {
      setPath(editing, ovs, ovs === 'grid' ? Number(t.value) : t.value);
      if (ev.type === 'change') { resetProps(); drawProps(); }
      drawBg(); drawStatus(); return;
    }
    var pm = t.getAttribute('data-pmulti');
    if (pm) {
      if (t.value === '' && t.tagName === 'SELECT') return;
      if (typingSnap !== 'multi' + pm) { snapshot(); typingSnap = 'multi' + pm; }
      var mv = t.type === 'range' ? Number(t.value) : t.value === 'none' ? '' : t.value;
      sels().forEach(function (e) { setPath(e, pm, mv); });
      drawCanvas(); drawLayers(); drawStatus(); return;
    }
    var k = t.getAttribute('data-p'); if (!k) return;
    var e = sel(); if (!e) return;
    if (typingSnap !== selIds[0] + k) { snapshot(); typingSnap = selIds[0] + k; }
    var v = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' ? Number(t.value) : t.value;
    if (/\.weight$/.test(k)) v = Number(v);
    setPath(e, k, v);
    // A paired colour picker and text box stay in step.
    if (t.type === 'color' || (t.type === 'text' && /^#[0-9a-f]{6}$/i.test(t.value))) {
      [].forEach.call(root.querySelectorAll('[data-p="' + k + '"]'), function (o) { if (o !== t && (o.type === 'color' || o.type === 'text')) o.value = t.value; });
    }
    drawCanvas(); drawLayers(); drawStatus();
    // Some choices change which fields make sense: redraw the panel on change, not on every key.
    if (ev.type === 'change' && /bind|Bind|borderW|strokeW|fill2|source|\.anim$|\.bg$|\.wrap$/.test(k)) { resetProps(); drawProps(); }
  }

  // ── Drag, resize, marquee, snap ───────────────────────────────────────────────────────────
  var drag = null;
  function toCanvas(ev) {
    var r = root.querySelector('.ovb-canvas').getBoundingClientRect();
    return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale };
  }
  function hitTest(p) {
    for (var i = editing.elements.length - 1; i >= 0; i--) {
      var e = editing.elements[i];
      if (!e.hidden && p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h) return e;
    }
    return null;
  }
  function onPointerDown(ev) {
    if (!editing || ev.button !== 0) return;
    var cv = root.querySelector('.ovb-canvas'); if (!cv || !cv.contains(ev.target)) return;
    var handle = ev.target.closest('.ovb-sel i');
    var p = toCanvas(ev);
    if (!handle) {
      var hit = hitTest(p);
      if (!hit) {
        // Empty frame: drag a box to select several.
        if (!ev.shiftKey) selIds = [];
        drag = { marquee: true, start: p, base: selIds.slice() };
        drawAll();
        ev.preventDefault();
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp, { once: true });
        return;
      }
      if (ev.shiftKey) { pick(hit.id, true); return; }
      if (selIds.indexOf(hit.id) < 0) { selIds = [hit.id]; drawAll(); }
    }
    var moving = sels().filter(function (e) { return !e.locked; });
    if (!moving.length) return;
    ev.preventDefault();
    snapshot();
    drag = { h: handle ? handle.getAttribute('data-h') : '', start: p, items: moving.map(function (e) { return { el: e, x: e.x, y: e.y, w: e.w, h: e.h }; }) };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }
  function snapAxis(edges, targets, tol) {
    var best = null;
    edges.forEach(function (ed) { targets.forEach(function (t) { var d = Math.abs(ed - t); if (d <= tol && (!best || d < best.d)) best = { d: d, shift: t - ed, at: t }; }); });
    return best;
  }
  function onPointerMove(ev) {
    if (!drag) return;
    var p = toCanvas(ev);
    if (drag.marquee) {
      var x1 = Math.min(p.x, drag.start.x), y1 = Math.min(p.y, drag.start.y), x2 = Math.max(p.x, drag.start.x), y2 = Math.max(p.y, drag.start.y);
      var mq = root.querySelector('.ovb-marquee');
      mq.hidden = false; mq.style.left = x1 + 'px'; mq.style.top = y1 + 'px'; mq.style.width = (x2 - x1) + 'px'; mq.style.height = (y2 - y1) + 'px';
      var inside = editing.elements.filter(function (e) { return !e.hidden && e.x < x2 && e.x + e.w > x1 && e.y < y2 && e.y + e.h > y1; }).map(function (e) { return e.id; });
      selIds = drag.base.concat(inside.filter(function (id) { return drag.base.indexOf(id) < 0; }));
      drawSel(); drawLayers();
      return;
    }
    var dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    var g = Number(editing.grid) || 0;
    var tol = 6 / Math.max(scale, 0.2);
    var gv = null, gh = null;
    if (!drag.h) {
      // Move every selected piece; snap the group's box to the grid, or to the frame and other pieces.
      var b0x = Math.min.apply(null, drag.items.map(function (i) { return i.x; })), b0y = Math.min.apply(null, drag.items.map(function (i) { return i.y; }));
      var bw = Math.max.apply(null, drag.items.map(function (i) { return i.x + i.w; })) - b0x, bh = Math.max.apply(null, drag.items.map(function (i) { return i.y + i.h; })) - b0y;
      var nx = b0x + dx, ny = b0y + dy;
      if (!ev.altKey) {
        if (g) { nx = Math.round(nx / g) * g; ny = Math.round(ny / g) * g; }
        else {
          var tX = [0, W / 2, W], tY = [0, H / 2, H];
          editing.elements.forEach(function (e) { if (selIds.indexOf(e.id) < 0 && !e.hidden) { tX.push(e.x, e.x + e.w / 2, e.x + e.w); tY.push(e.y, e.y + e.h / 2, e.y + e.h); } });
          var sx = snapAxis([nx, nx + bw / 2, nx + bw], tX, tol);
          var sy = snapAxis([ny, ny + bh / 2, ny + bh], tY, tol);
          if (sx) { nx += sx.shift; gv = sx.at; }
          if (sy) { ny += sy.shift; gh = sy.at; }
        }
      }
      var ox = Math.round(nx - b0x), oy = Math.round(ny - b0y);
      drag.items.forEach(function (i) { i.el.x = i.x + ox; i.el.y = i.y + oy; });
    } else {
      var o = drag.items[0], e = o.el, h = drag.h, x = o.x, y = o.y, w = o.w, hh = o.h;
      if (h.indexOf('e') >= 0) w = Math.max(4, o.w + dx);
      if (h.indexOf('s') >= 0) hh = Math.max(4, o.h + dy);
      if (h.indexOf('w') >= 0) { w = Math.max(4, o.w - dx); x = o.x + (o.w - w); }
      if (h.indexOf('n') >= 0) { hh = Math.max(4, o.h - dy); y = o.y + (o.h - hh); }
      if (ev.shiftKey && h.length === 2) { var r = o.w / o.h; if (w / hh > r) w = hh * r; else hh = w / r; if (h.indexOf('w') >= 0) x = o.x + (o.w - w); if (h.indexOf('n') >= 0) y = o.y + (o.h - hh); }
      if (g && !ev.altKey) { w = Math.max(g, Math.round(w / g) * g); hh = Math.max(g, Math.round(hh / g) * g); }
      e.x = Math.round(x); e.y = Math.round(y); e.w = Math.round(w); e.h = Math.round(hh);
    }
    var gV = root.querySelector('.ovb-guide-v'), gH = root.querySelector('.ovb-guide-h');
    gV.hidden = gv == null; if (gv != null) gV.style.left = gv + 'px';
    gH.hidden = gh == null; if (gh != null) gH.style.top = gh + 'px';
    drawCanvas();
  }
  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove);
    if (drag && drag.marquee) { root.querySelector('.ovb-marquee').hidden = true; drag = null; drawAll(); return; }
    var moved = drag && drag.items.some(function (i) { return i.el.x !== i.x || i.el.y !== i.y || i.el.w !== i.w || i.el.h !== i.h; });
    if (drag && !moved) hist.pop();   // a click is not an edit
    drag = null;
    root.querySelector('.ovb-guide-v').hidden = true; root.querySelector('.ovb-guide-h').hidden = true;
    resetProps();
    drawAll();
  }
  document.addEventListener('keydown', function (ev) {
    if (!editing || !root || root.getAttribute('data-view') !== 'edit' || !root.offsetParent) return;
    if (ev.defaultPrevented || (ev.target && ev.target.isContentEditable)) return;
    // A dialog or picker on top (confirm, media library, Settings): the keys are its, not the canvas's.
    if (document.querySelector('.modal-overlay.open, .custom-modal.open, .mp-modal.open, #tab-ajustes-content.open, [role="dialog"][open], dialog[open]')) return;
    if (ev.target && ev.target !== document && ev.target !== document.body && !root.contains(ev.target)) return;
    var typing = /input|textarea|select/i.test((ev.target && ev.target.tagName) || '');
    var mod = ev.ctrlKey || ev.metaKey, key = (ev.key || '').toLowerCase();
    if (mod && key === 's') { ev.preventDefault(); save(); return; }
    if (typing) return;
    if (mod && key === 'z') { ev.preventDefault(); root.querySelector('[data-ovb="' + (ev.shiftKey ? 'redo' : 'undo') + '"]').click(); return; }
    if (mod && key === 'y') { ev.preventDefault(); root.querySelector('[data-ovb="redo"]').click(); return; }
    if (mod && key === 'a') { ev.preventDefault(); selIds = editing.elements.filter(function (e) { return !e.hidden; }).map(function (e) { return e.id; }); drawAll(); return; }
    if (mod && key === 'c') { if (selIds.length) { ev.preventDefault(); clipboard = sels().map(clone); toast(clipboard.length + ' piece' + (clipboard.length === 1 ? '' : 's') + ' copied. Paste with Ctrl+V, here or in another overlay.', '#3d8bff'); } return; }
    if (mod && key === 'v') { if (clipboard) { ev.preventDefault(); paste(); } return; }
    if (!selIds.length) return;
    if (mod && key === 'd') { ev.preventDefault(); dup(); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeSel(); return; }
    if (ev.key === 'Escape') { selIds = []; drawAll(); return; }
    var d = ev.shiftKey ? 10 : 1;
    var mv = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[ev.key];
    if (mv) { ev.preventDefault(); if (!ev.repeat) snapshot(); sels().forEach(function (e) { if (!e.locked) { e.x += mv[0]; e.y += mv[1]; } }); resetProps(); drawAll(); }
  });
  window.addEventListener('resize', function () { if (editing && root && root.getAttribute('data-view') === 'edit') { fit(); drawCanvas(); } });

  // ── Server replies (app.js forwards custom-overlay / custom-overlay-saved) ─────────────────
  function onMsg(type, d) {
    d = d || {};
    if (type === 'custom-overlay' && d.ok && d.overlay) {
      layouts[d.overlay.id] = d.overlay;
      if (root && root._pendingLayout && root._pendingLayout.id === d.overlay.id) { var pl = root._pendingLayout; root._pendingLayout = null; pl.fn(d.overlay); return; }
      if (root && root.getAttribute('data-view') === 'lib') drawThumbs();
    } else if (type === 'custom-overlay-saved') {
      if (!root || !root._saveReq || root._saveReq.id !== d.reqId) { if (d.ok && d.overlay) layouts[d.overlay.id] = d.overlay; return; }   // a library duplicate, not this editor's save
      saving = false;
      if (!d.ok) { toast(d.error || 'Could not save.', '#ef4444'); drawStatus(); return; }
      layouts[d.overlay.id] = d.overlay;
      // Only the overlay that was saved, and only if nothing was edited while the save was out:
      // otherwise keep the newer edits (still unsaved) and just learn the id.
      var req = root._saveReq;
      if (editing && editing === req.target) {
        editing.id = d.overlay.id;
        if (sigOf(editing) === req.sig) { savedSig = sigOf(d.overlay); editing.elements = clone(d.overlay.elements); editing.bg = clone(d.overlay.bg); editing.grid = d.overlay.grid; editing.kind = d.overlay.kind; editing.game = d.overlay.game; editing.name = d.overlay.name; }
        else savedSig = sigOf(d.overlay);
      }
      drawStatus();
      resetProps(); drawProps();
      var then = root._saveReq.then;
      root._saveReq = null;
      if (then) then(d.overlay); else toast('Saved. Any OBS source showing it updates now.');
    }
  }

  // ── Render loop (only while the Custom tab is on screen) ───────────────────────────────────
  function render() {
    if (!mount() || !window.CustomOverlay) return;
    if (editing) {
      if (root.getAttribute('data-view') !== 'edit') buildEditor();
      else { drawCanvas(); drawStatus(); }
    } else renderLibrary();
  }
  setInterval(function () {
    if (root && root.offsetParent) {
      if (editing && root.getAttribute('data-view') === 'edit') { if (!drag) { drawCanvas(); drawLayers(); } }
      else if (!editing) renderLibrary();
    }
  }, 600);

  window.__ovb = { render: render, onMsg: onMsg, templates: TEMPLATES };
})();
