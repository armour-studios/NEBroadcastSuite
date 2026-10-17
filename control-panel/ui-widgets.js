/* ─── ui-widgets.js — the Modern Dashboard as a customizable grid ─────────────────────────────
   Loads after ui-style.js. The Dashboard's cards (Match, Deck, Up next, Live now, Look, Series) and
   six extra widgets (Clock, Rundown, Stream health, Notes, Program, Overlay preview) sit on ONE grid:
     • Columns: 1 to 4, all the same width, rows equal height (no more 7/5 splits).
     • Each card is 1 column, 2 columns or the full row wide.
     • Customize: drag cards by their grip (SortableJS), set widths, hide/show, pick a preset
       (Producer, Show caller, Stream ops, Multiview) or reset. Remembered per PC (localStorage).
   The grid drops columns by itself on a narrow window (3+ needs ~1100px, 2 needs ~760px).

   ui-style.js keeps rendering the original cards: it finds them by class inside #mx-cr, and moving
   them into the grid keeps them inside #mx-cr. This file only owns the grid, edit mode and the
   extra widgets. Classic is untouched (everything here is Modern-only and .mx-only). */
(function () {
  var root = document.documentElement;
  function isModern() { return root.getAttribute('data-ui') === 'modern'; }
  function $(id) { return document.getElementById(id); }
  function st() { try { return (typeof currentState !== 'undefined' && currentState) || null; } catch (e) { return null; } }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var BASE = window.SCENE_BASE_URL || 'http://localhost:3000';

  var KEY = 'ne_mx_dash_v1';
  var OLD_KEY = 'ne_mx_cr_widgets';
  var META = {
    setup: { title: 'Get set up', fixed: true, w: 'full' }, hero: { title: 'Match', fixed: true, w: 'full' },
    deck: { title: 'Deck', w: 'full' }, next: { title: 'Up next' }, live: { title: 'Live now' }, look: { title: 'Brand and overlay', retired: true }, /* merged into the brand bar at the top of the Dashboard (2026-10); kept so ui-style's renderer still has its node */ series: { title: 'Series' },
    clock: { title: 'Clock and timers', desc: 'Local time, how long you have been live and the break countdown.' },
    rundown: { title: 'Rundown', desc: 'What is on now and what comes next. Start, skip or stop from here.' },
    stream: { title: 'Stream health', desc: 'Viewers, bitrate, dropped frames and encoder load.' },
    notes: { title: 'Notes', desc: 'Your scratchpad. The same notes are in the Live dock.' },
    program: { title: 'Program', desc: 'What is going out right now, from OBS (about one frame a second).' },
    overlay: { title: 'Overlay preview', desc: 'The live in-game overlay, exactly as OBS draws it.' }
  };
  var IDS = Object.keys(META);
  var SEL = { setup: '.mx-setup', hero: '.mx-hero', deck: '.mx-deck-card', next: '.mx-next', live: '.mx-livecard', look: '.mx-look', series: '.mx-series' };
  var EXTRA = ['clock', 'rundown', 'stream', 'notes', 'program', 'overlay'];

  // Presets: column count, card order, which are shown, and widths ('full' or 1/2).
  var PRESETS = {
    // The house layout everyone runs; new installs and Reset start here.
    producer: { name: 'Producer', cols: 2, show: ['setup', 'hero', 'clock', 'next', 'deck', 'live', 'series'], w: {} },
    caller: { name: 'Show caller', cols: 3, show: ['hero', 'rundown', 'clock', 'next', 'live', 'series', 'notes', 'deck'], w: { notes: 1 } },
    ops: { name: 'Stream ops', cols: 3, show: ['hero', 'program', 'stream', 'clock', 'live', 'next', 'series'], w: { program: 2 } },
    multiview: { name: 'Multiview', cols: 2, show: ['program', 'overlay', 'hero', 'live', 'next'], w: { hero: 'full' } }
  };
  function fromPreset(id) {
    var p = PRESETS[id] || PRESETS.producer;
    var order = p.show.slice();
    IDS.forEach(function (x) { if (order.indexOf(x) < 0) order.push(x); });
    var hidden = IDS.filter(function (x) { return p.show.indexOf(x) < 0 && !META[x].fixed; });
    return { cols: p.cols, preset: id, order: order, hidden: hidden, w: Object.assign({}, p.w) };
  }
  function load() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && Array.isArray(v.order)) {
        // 'lookprev' (Brand and overlay) merged into 'look' (2026-10): the Look card takes its place
        // and is shown if either one was.
        if (v.order.indexOf('lookprev') >= 0) {
          var lpShown = (v.hidden || []).indexOf('lookprev') < 0;
          var lookShown = (v.hidden || []).indexOf('look') < 0;
          v.order = v.order.filter(function (id) { return id !== 'look'; }).map(function (id) { return id === 'lookprev' ? 'look' : id; });
          v.hidden = (v.hidden || []).filter(function (id) { return id !== 'lookprev' && !(id === 'look' && (lpShown || lookShown)); });
          if (v.w && v.w.lookprev && !v.w.look) v.w.look = v.w.lookprev;
        }
        var order = v.order.filter(function (id) { return META[id]; });
        // Cards added in an update show at the TOP of a saved layout the first time (SHOW_NEW);
        // other new cards join hidden, ready to add from Edit layout.
        var SHOW_NEW = [];
        var fresh = IDS.filter(function (id) { return order.indexOf(id) < 0; });
        fresh.filter(function (id) { return SHOW_NEW.indexOf(id) >= 0; }).reverse().forEach(function (id) { order.unshift(id); });
        fresh.filter(function (id) { return SHOW_NEW.indexOf(id) < 0; }).forEach(function (id) { order.push(id); });
        return { cols: Math.max(1, Math.min(4, Number(v.cols) || 2)), preset: v.preset || '', order: order,
          hidden: (v.hidden || []).filter(function (id) { return META[id] && !META[id].fixed; }).concat(EXTRA.filter(function (id) { return (v.order || []).indexOf(id) < 0 && SHOW_NEW.indexOf(id) < 0; })),
          w: v.w || {} };
      }
      // Carry the old layout over: same order and hidden cards; the old 12-column spans become
      // full (12) or one column (anything less), so pairs end up even.
      var o = JSON.parse(localStorage.getItem(OLD_KEY) || 'null');
      if (o && Array.isArray(o.order)) {
        var c = fromPreset('producer');
        c.preset = '';
        c.order = o.order.filter(function (id) { return META[id]; });
        IDS.forEach(function (id) { if (c.order.indexOf(id) < 0) c.order.push(id); });
        c.hidden = (o.hidden || []).filter(function (id) { return META[id] && !META[id].fixed; }).concat(['program', 'overlay']);
        Object.keys(o.span || {}).forEach(function (id) { if (META[id]) c.w[id] = o.span[id] >= 12 ? 'full' : 1; });
        return c;
      }
    } catch (e) {}
    return fromPreset('producer');
  }
  var cfg = load(), built = false, grid = null, bar = null, cr = null, sortable = null;
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} }
  function wOf(id) { var w = cfg.w[id] != null ? cfg.w[id] : (META[id].w || 1); return w === 'full' ? 'full' : Math.max(1, Math.min(4, Number(w) || 1)); }
  function widget(id) { return grid ? grid.querySelector(':scope > [data-widget="' + id + '"]') : null; }
  // Columns actually used: the chosen count, capped by the width the grid has.
  function effCols() {
    var wpx = grid ? grid.clientWidth : 1400;
    var cap = wpx >= 1100 ? 4 : wpx >= 760 ? 2 : 1;
    return Math.max(1, Math.min(cfg.cols, cap));
  }

  var GRIP = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

  function build() {
    if (built || !isModern()) return;
    cr = $('mx-cr');
    var run = cr && cr.querySelector('.mx-run');
    if (!run) return;
    for (var k in SEL) if (!cr.querySelector(SEL[k])) return;   // the Dashboard is not built yet
    built = true;
    grid = document.createElement('div');
    grid.className = 'mx-widgets';
    Object.keys(SEL).forEach(function (k) { var n = cr.querySelector(SEL[k]); n.setAttribute('data-widget', k); grid.appendChild(n); });
    EXTRA.forEach(function (k) {
      var n = document.createElement('div');
      n.className = 'mx-card mx-w mx-w-' + k;
      n.setAttribute('data-widget', k);
      n.innerHTML = '<div class="mx-card-head"><span class="mx-card-title">' + esc(META[k].title) + '</span></div><div class="mx-w-body"></div>';
      grid.appendChild(n);
    });
    var old = run.querySelector('.mx-cr-grid'); if (old) old.remove();
    run.appendChild(grid);
    // Handles (shown only while customizing): grip to drag, width, hide.
    grid.querySelectorAll(':scope > [data-widget]').forEach(function (n) {
      var id = n.getAttribute('data-widget');
      var h = document.createElement('div');
      h.className = 'mx-w-handle';
      h.innerHTML = '<span class="mx-w-grip" title="Drag to move">' + GRIP + '<span class="mx-w-name">' + esc(META[id].title) + '</span></span>'
        + '<span class="mx-w-size" role="group" aria-label="Width">'
        + '<button type="button" data-w="w" data-v="1" title="One column">1</button>'
        + '<button type="button" data-w="w" data-v="2" title="Two columns">2</button>'
        + '<button type="button" data-w="w" data-v="full" title="The whole row">Full</button></span>'
        + (META[id].fixed ? '' : '<button type="button" class="mx-w-x" data-w="hide" title="Hide this card">&#215;</button>');
      n.appendChild(h);
    });
    bar = document.createElement('div');
    bar.className = 'mx-wbar';
    bar.hidden = true;
    bar.innerHTML = '<div class="mx-wbar-row">'
      + '<label class="mx-wbar-field"><span>Layout</span><select class="mx-wbar-preset">'
      + Object.keys(PRESETS).map(function (p) { return '<option value="' + p + '">' + esc(PRESETS[p].name) + '</option>'; }).join('')
      + '<option value="">Custom</option></select></label>'
      + '<div class="mx-wbar-field"><span>Columns</span><div class="mx-seg mx-wbar-cols">'
      + [1, 2, 3, 4].map(function (n) { return '<button type="button" data-w="cols" data-v="' + n + '">' + n + '</button>'; }).join('')
      + '</div></div>'
      + '<span class="mx-wbar-t">Drag a card by its grip. Set each card to 1 or 2 columns, or the full row.</span>'
      + '<button type="button" class="mx-btn mx-btn-sm" data-w="reset">Reset</button>'
      + '<button type="button" class="mx-btn mx-btn-sm mx-btn-primary" data-w="done">Done</button>'
      + '</div><div class="mx-wbar-add"></div>';
    run.insertBefore(bar, grid);
    bar.querySelector('.mx-wbar-preset').addEventListener('change', function (e) {
      if (!e.target.value) return;
      cfg = fromPreset(e.target.value); apply();
    });
    var modes = cr.querySelector('.mx-modes');
    // "Edit layout": a quiet link at the far right of the Set up / Run row, not a third tab.
    if (modes) {
      var row = document.createElement('div');
      row.className = 'mx-modes-row';
      modes.parentNode.insertBefore(row, modes);
      row.appendChild(modes);
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'mx-modes-custom'; b.setAttribute('data-w', 'edit'); b.title = 'Choose which cards show on the Dashboard, how many columns, and where';
      b.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>Edit layout</span>';
      row.appendChild(b);
    }
    cr.addEventListener('click', onClick);
    // The brand kit bar is the first thing on the Dashboard: above the welcome / promo banners.
    var bk = $('dash-brandkit');
    var first = ['dash-tour-cta', 'dash-nameless-cta'].map($).filter(function (n) { return n && n.parentNode === (bk && bk.parentNode); })
      .sort(function (a, b) { return a.compareDocumentPosition(b) & 4 ? -1 : 1; })[0];
    if (bk && first && (first.compareDocumentPosition(bk) & 4)) bk.parentNode.insertBefore(bk, first);
    initNotes();
    // Re-pack when the window width crosses a column threshold (next frame: never inside the observer).
    var lastCols = 0;
    if (typeof ResizeObserver === 'function') new ResizeObserver(function () {
      requestAnimationFrame(function () { var c = effCols(); if (c !== lastCols) { lastCols = c; layout(); } });
    }).observe(grid);
    apply();
  }

  // Order, visibility and widths. Order is the DOM order, so drag-and-drop and the saved order agree.
  function apply() {
    if (!grid) return;
    cfg.order.forEach(function (id) {
      var n = widget(id); if (!n) return;
      grid.appendChild(n);
      n.classList.toggle('mx-w-off', cfg.hidden.indexOf(id) >= 0);
    });
    layout();
    if (bar) {
      var add = bar.querySelector('.mx-wbar-add');
      add.textContent = '';
      cfg.hidden.filter(function (id) { return !(META[id] && META[id].retired); }).forEach(function (id) {
        var b = document.createElement('button');
        b.type = 'button'; b.setAttribute('data-w', 'show'); b.setAttribute('data-id', id);
        b.textContent = '+ ' + META[id].title;
        if (META[id].desc) b.title = META[id].desc;
        add.appendChild(b);
      });
      if (!cfg.hidden.length) add.innerHTML = '<span class="mx-hint">Every card is showing.</span>';
      var sel = bar.querySelector('.mx-wbar-preset'); if (sel) sel.value = cfg.preset || '';
      bar.querySelectorAll('[data-w="cols"]').forEach(function (b) { b.classList.toggle('is-on', Number(b.getAttribute('data-v')) === cfg.cols); });
    }
    save();
  }
  // Widths, packed in rows: a card that would leave a gap at the end of its row (the row breaks or
  // the cards run out) stretches to fill it, so every row spans the full width.
  function layout() {
    if (!grid) return;
    var cols = effCols();
    grid.style.setProperty('--cols', String(cols));
    var row = [], used = 0;
    function close() {
      if (row.length && used < cols) row[row.length - 1].span += cols - used;
      row.forEach(function (r) { r.n.style.gridColumn = r.span >= cols ? '1 / -1' : 'span ' + r.span; });
      row = []; used = 0;
    }
    grid.querySelectorAll(':scope > [data-widget]').forEach(function (n) {
      var id = n.getAttribute('data-widget');
      var w = wOf(id);
      n.querySelectorAll('.mx-w-size [data-v]').forEach(function (b) { b.classList.toggle('is-on', String(b.getAttribute('data-v')) === String(w)); });
      if (n.classList.contains('mx-w-off')) { n.style.gridColumn = ''; return; }
      var span = w === 'full' ? cols : Math.min(w, cols);
      if (used + span > cols) close();
      row.push({ n: n, span: span }); used += span;
      if (used >= cols) close();
    });
    close();
  }
  function custom() { cfg.preset = ''; }
  function setEditing(on) {
    if (!grid) return;
    grid.classList.toggle('is-editing', on);
    if (bar) bar.hidden = !on;
    var b = cr.querySelector('.mx-modes-custom'); if (b) b.classList.toggle('is-on', on);
    if (on && !sortable && typeof Sortable !== 'undefined') {
      sortable = Sortable.create(grid, {
        handle: '.mx-w-grip', draggable: '[data-widget]', animation: 160, ghostClass: 'mx-w-ghost', chosenClass: 'mx-w-chosen',
        filter: '.mx-w-off',
        onEnd: function () {
          var seen = [].map.call(grid.querySelectorAll(':scope > [data-widget]'), function (n) { return n.getAttribute('data-widget'); });
          cfg.order = seen; custom(); apply();
        }
      });
    }
    if (sortable) sortable.option('disabled', !on);
  }
  function onClick(e) {
    var b = e.target.closest('[data-w]');
    if (!b) return;
    var w = b.getAttribute('data-w');
    var host = b.closest('[data-widget]');
    var id = host ? host.getAttribute('data-widget') : b.getAttribute('data-id');
    if (w === 'edit') setEditing(!grid.classList.contains('is-editing'));
    else if (w === 'done') setEditing(false);
    else if (w === 'reset') { cfg = fromPreset(cfg.preset || 'producer'); apply(); }
    else if (w === 'cols') { cfg.cols = Number(b.getAttribute('data-v')) || 2; custom(); apply(); }
    else if (w === 'w') { var v = b.getAttribute('data-v'); cfg.w[id] = v === 'full' ? 'full' : Number(v); custom(); apply(); }
    else if (w === 'hide') { if (cfg.hidden.indexOf(id) < 0) cfg.hidden.push(id); custom(); apply(); }
    else if (w === 'show') { cfg.hidden = cfg.hidden.filter(function (x) { return x !== id; }); custom(); apply(); }
    else if (w === 'rd-go') { var g = $('rd-driver-go'); if (g) g.click(); }
    else if (w === 'rd-back') { var bk = $('rd-driver-back'); if (bk) bk.click(); }
    else if (w === 'rd-stop') { var sp = $('rd-driver-stop'); if (sp) sp.click(); }
    else if (w === 'rd-open') { if (typeof window.__mxOpenDrawer === 'function') window.__mxOpenDrawer('rundown'); }
    else return;
    e.stopPropagation();
  }

  // ── The four new widgets ──────────────────────────────────────────────────────────────────
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hms(ms) { var s = Math.max(0, Math.floor(ms / 1000)); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + ':' + pad(m) : m) + ':' + pad(s % 60); }
  function body(id) { var n = widget(id); return n ? n.querySelector('.mx-w-body') : null; }
  function visible(id) { var n = widget(id); return !!(n && n.offsetParent && cfg.hidden.indexOf(id) < 0); }

  function renderClock(s) {
    var h = body('clock'); if (!h) return;
    var obs = (s && s.obs) || {}, br = (s && s.breakScreen) || {};
    var now = new Date();
    var live = obs.streaming && obs.streamStartedAt ? hms(Date.now() - obs.streamStartedAt) : '';
    var rec = obs.recording && obs.recordStartedAt ? hms(Date.now() - obs.recordStartedAt) : '';
    var brk = (br.visible && br.endsAt) ? hms(br.endsAt - Date.now()) : '';
    h.innerHTML = '<div class="mx-w-clock-now">' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + '<small>:' + pad(now.getSeconds()) + '</small></div>'
      + '<div class="mx-w-stats">'
      + '<div class="mx-w-stat' + (live ? ' is-live' : '') + '"><b>' + (live || 'Off') + '</b><span>' + (live ? 'Live for' : 'Not streaming') + '</span></div>'
      + '<div class="mx-w-stat"><b>' + (rec || 'Off') + '</b><span>' + (rec ? 'Recording for' : 'Not recording') + '</span></div>'
      + '<div class="mx-w-stat"><b>' + (brk || '—') + '</b><span>' + (brk ? 'Break ends in' : 'No break timer') + '</span></div>'
      + '</div>';
  }
  function renderRundown() {
    var h = body('rundown'); if (!h) return;
    var S = null; try { S = (typeof rdSummary === 'function') ? rdSummary() : null; } catch (e) {}
    if (!S || !S.hasSegs) {
      h.innerHTML = '<div class="mx-empty-state"><b>No rundown yet</b><span>Plan tonight as segments and run them from here.</span><button type="button" class="mx-btn" data-w="rd-open">Open the rundown</button></div>';
      return;
    }
    var cur = S.current || '';
    var next = S.next || '';
    var next2 = S.next2 || '';
    var pos = S.total ? (S.pos || 0) + ' / ' + S.total : '';
    var sig = [S.running, cur, next, next2, pos].join('|');
    if (h._sig === sig) return;
    h._sig = sig;
    h.innerHTML = '<div class="mx-w-rd-cur' + (S.running ? ' is-live' : '') + '"><div class="mx-w-rd-k">' + (S.running ? 'On now' + (pos ? ' · ' + esc(pos) : '') : 'Ready') + '</div><div class="mx-w-rd-v">' + esc(S.running ? (cur || 'Segment') : 'Not started') + '</div></div>'
      + (next ? '<div class="mx-w-rd-next"><div class="mx-w-rd-k">Next</div><div class="mx-w-rd-v">' + esc(next) + '</div>' + (next2 ? '<div class="mx-hint">then ' + esc(next2) + '</div>' : '') + '</div>' : '')
      + '<div class="mx-w-rd-act">'
      + (S.running ? '<button type="button" class="mx-btn mx-btn-sm" data-w="rd-back">Back</button>' : '')
      + '<button type="button" class="mx-btn mx-btn-sm mx-btn-primary" data-w="rd-go">' + (S.running ? 'Next segment' : 'Start the show') + '</button>'
      + (S.running ? '<button type="button" class="mx-btn mx-btn-sm" data-w="rd-stop">Stop</button>' : '')
      + '</div>';
  }
  function renderStream(s) {
    var h = body('stream'); if (!h) return;
    var obs = (s && s.obs) || {}, hl = obs.health || null;
    var viewers = 0; try { viewers = (typeof _viewerCount !== 'undefined' && _viewerCount) || 0; } catch (e) {}
    var drop = hl ? hl.outputDropPct : null;
    var sig = JSON.stringify([obs.connected, obs.streaming, viewers, hl && hl.bitrateKbps, drop, hl && hl.fps, hl && hl.cpu]);
    if (h._sig === sig) return;
    h._sig = sig;
    if (!obs.connected) { h.innerHTML = '<div class="mx-empty-state"><b>OBS is not connected</b><span>Stream health reads from OBS once it is.</span></div>'; return; }
    var tone = drop == null ? '' : (drop > 2 ? ' is-bad' : (drop > 0.5 ? ' is-warn' : ' is-ok'));
    h.innerHTML = '<div class="mx-w-stats">'
      + '<div class="mx-w-stat' + (obs.streaming ? ' is-live' : '') + '"><b>' + (viewers ? Number(viewers).toLocaleString() : (obs.streaming ? '0' : '—')) + '</b><span>' + (obs.streaming ? 'Viewers now' : 'Not streaming') + '</span></div>'
      + '<div class="mx-w-stat"><b>' + (hl && hl.bitrateKbps ? Math.round(hl.bitrateKbps / 100) / 10 + ' Mb/s' : '—') + '</b><span>Bitrate</span></div>'
      + '<div class="mx-w-stat' + tone + '"><b>' + (drop == null ? '—' : drop + '%') + '</b><span>Dropped frames</span></div>'
      + '<div class="mx-w-stat"><b>' + (hl && hl.fps ? hl.fps : '—') + '</b><span>Render FPS</span></div>'
      + '<div class="mx-w-stat"><b>' + (hl && hl.cpu != null ? hl.cpu + '%' : '—') + '</b><span>OBS CPU</span></div>'
      + '</div>';
  }
  var NOTES_KEY = 'ne_notes';
  function initNotes() {
    var h = body('notes'); if (!h) return;
    var ta = document.createElement('textarea');
    ta.placeholder = 'Talking points, reminders, who to thank...';
    ta.spellcheck = false;
    try { ta.value = localStorage.getItem(NOTES_KEY) || ''; } catch (e) {}
    var t = null;
    ta.addEventListener('input', function () {
      clearTimeout(t);
      var v = ta.value;
      t = setTimeout(function () {
        try { localStorage.setItem(NOTES_KEY, v); } catch (e) {}
        var dock = $('notes-text'); if (dock && dock.value !== v) dock.value = v;
      }, 300);
    });
    h.appendChild(ta);
    // Typed in the dock instead: mirror it here when this card is not focused.
    var dock = $('notes-text');
    if (dock) dock.addEventListener('input', function () { if (document.activeElement !== ta) ta.value = dock.value; });
  }


  // ── Multiview widgets: Program (OBS) and Overlay preview ──────────────────────────────────
  // Program pulls one OBS screenshot at a time (the next only after the last has loaded), so a slow
  // OBS never piles up requests. Overlay preview is the live overlay router (live.html) in a 1920x1080
  // frame scaled to the card.
  function renderProgram(s) {
    var h = body('program'); if (!h) return;
    var obs = (s && s.obs) || {};
    if (!obs.connected) {
      if (h._mode !== 'off') { h._mode = 'off'; h.innerHTML = '<div class="mx-w-frame is-empty"><span>OBS is not connected</span></div>'; }
      return;
    }
    if (h._mode !== 'on') {
      h._mode = 'on';
      h.innerHTML = '<div class="mx-w-frame"><img alt="Program output"><span class="mx-w-tag">' + (obs.streaming ? 'LIVE' : 'PROGRAM') + '</span></div>';
      var img = h.querySelector('img');
      img.onload = img.onerror = function () { img._busy = false; };
    }
    var im = h.querySelector('img');
    var tag = h.querySelector('.mx-w-tag'); if (tag) { tag.textContent = obs.streaming ? 'LIVE' : 'PROGRAM'; tag.classList.toggle('is-live', !!obs.streaming); }
    if (im && !im._busy) { im._busy = true; im.src = BASE + '/api/obs/screenshot?w=640&t=' + Date.now(); }
  }
  function renderOverlay() {
    var h = body('overlay'); if (!h) return;
    if (!h._built) {
      h._built = true;
      h.innerHTML = '<div class="mx-w-frame mx-w-ov"><iframe title="Overlay preview" src="' + BASE + '/live.html" scrolling="no" tabindex="-1"></iframe><span class="mx-w-tag">OVERLAY</span></div>';
    }
    var f = h.querySelector('.mx-w-ov'), ifr = f && f.querySelector('iframe');
    if (f && ifr) { var sc = f.clientWidth / 1920; if (sc > 0 && ifr._sc !== sc) { ifr._sc = sc; ifr.style.transform = 'scale(' + sc + ')'; } }
  }

  function tick() {
    if (!isModern()) return;
    if (!built) { build(); if (!built) return; }
    if (!grid.offsetParent) return;
    var s = st();
    if (visible('clock')) renderClock(s);
    if (visible('rundown')) renderRundown();
    if (visible('stream')) renderStream(s);
    if (visible('program')) renderProgram(s);
    if (visible('overlay')) renderOverlay();
  }
  setInterval(tick, 1000);
  document.addEventListener('DOMContentLoaded', function () { setTimeout(tick, 1500); });
  window.__mxWidgets = { rebuild: function () { built = false; grid = null; bar = null; sortable = null; build(); }, presets: PRESETS, config: function () { return JSON.parse(JSON.stringify(cfg)); } };
})();
