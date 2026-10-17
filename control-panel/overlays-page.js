/* ─── overlays-page.js — the Modern "Overlays" page + the Dashboard's "Look" preview card ───────
   Overlays page (sidebar ▸ Overlays, view "overlays"), two tabs (remembered in localStorage):
     Custom: the no-code overlay builder (overlay-builder.js mounts into #ovb-root).
     Default: the overlays that ship with the app:
     • The game HUD style in use, big, with: Show over the game · Copy OBS link · Open.
     • Every style the game has, as picture cards: one click makes it the game's style.
     • Any other game's styles (pick it from the game chips) without making that game active.
     • The over-game windows that are open, with Hide all / Close.
   Dashboard card "Brand and overlay" (ui-widgets id 'look', built in ui-style.js): this file fills
   its Overlay row (the active game's style with its thumbnail, Change style, Show over the game) and
   prompts to put the overlay over the game when the game sends live data and none is open yet.
   Thumbnails come from the server's cached /api/overlay-thumb (the same pictures Assets uses).
   Modern only. ui-style.js calls window.__mxOverlays.render(state) while the page is open. */
(function () {
  'use strict';
  var root = document.documentElement;
  var BASE = window.SCENE_BASE_URL || 'http://localhost:3000';
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isModern() { return root.getAttribute('data-ui') === 'modern'; }
  function st() { try { return (typeof currentState !== 'undefined' && currentState) || {}; } catch (e) { return {}; } }

  // ── data helpers ────────────────────────────────────────────────────────────────────────
  function themesOf(s, g) { var x = (s.games || {})[g]; return (x && Array.isArray(x.themes)) ? x.themes.filter(function (t) { return t && t.path; }) : []; }
  function currentTheme(s, g) {
    var list = themesOf(s, g); if (!list.length) return null;
    var id = (s.themesByGame || {})[g];
    return list.find(function (t) { return t.id === id; }) || list[0];
  }
  function gameName(s, g) { var x = (s.games || {})[g]; return (x && x.name) || g || ''; }
  function gameLogo(s, g) { var x = (s.games || {})[g]; return x && x.logo ? '../assets/' + x.logo : ''; }
  function file(path) { return String(path || '').split('?')[0].split('/').pop(); }
  function thumb(path) { return BASE + '/api/overlay-thumb?file=' + encodeURIComponent(file(path)); }
  function url(path) { return BASE + path; }
  // Is the game sending live data right now? (the prompt to show the overlay over the game)
  function gameLive(s, g) {
    if (g === 'rocket-league') return !!s.rlConnected;
    var m = { csgo: 'csgo', valorant: 'valorant', league: 'lol', apex: 'apex' }[g];
    return !!(m && s[m] && s[m].connected);
  }
  var overGame = [];   // open over-game windows (electronAPI)
  function overGameOpen(path) { return overGame.some(function (o) { return o.key === path || o.key === file(path) || ('/' + file(o.key)) === path; }); }
  function openOverGame(path, name, done) {
    if (!window.electronAPI || !window.electronAPI.openGameOverlay) { if (typeof showToast === 'function') showToast('Over-game windows only work in the desktop app.', '#ef4444'); return; }
    window.electronAPI.openGameOverlay({ url: url(path), path: path, name: name, nativeW: 1920, nativeH: 1080 })
      .then(function (r) {
        if (typeof showToast === 'function') showToast(r && r.ok ? name + ' is over the game. Point at a part to see through it; Ctrl+Shift+F10 hides it.' : 'Could not open the overlay window.', r && r.ok ? '#22c55e' : '#ef4444', 4500);
        if (done) done();
      }).catch(function () {});
  }
  function copy(text, btn) {
    var ok = function () { if (!btn) return; var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1200); };
    try { navigator.clipboard.writeText(text).then(ok, ok); } catch (e) { ok(); }
  }
  if (window.electronAPI && window.electronAPI.onGameOverlaysChanged) {
    window.electronAPI.onGameOverlaysChanged(function (l) { overGame = Array.isArray(l) ? l : []; renderAll(); });
    window.electronAPI.listGameOverlays().then(function (l) { overGame = Array.isArray(l) ? l : []; renderAll(); }).catch(function () {});
  }

  // ── Overlays page ───────────────────────────────────────────────────────────────────────
  var page = null, viewGame = '';
  function build() {
    if (page || !isModern()) return;
    var host = $('tab-principal-content'); if (!host) return;
    page = document.createElement('section');
    page.className = 'mx-only mx-ovp'; page.id = 'mx-overlays';
    // Two tabs. Custom: the overlay builder (overlay-builder.js). Default: the overlays that ship with
    // the app: the game HUD style picker, the over-the-game windows, and every built-in overlay.
    page.innerHTML = '<div class="mx-ovp-tabs" role="tablist" aria-label="Overlays">'
      + '<button type="button" role="tab" data-ov="tab" data-tab="custom">Custom<span>Your own designs</span></button>'
      + '<button type="button" role="tab" data-ov="tab" data-tab="default">Default<span>Built into the app</span></button></div>'
      + '<div class="mx-ovp-pane" data-pane="custom"><div id="ovb-root" class="ovb"></div></div>'
      + '<div class="mx-ovp-pane" data-pane="default">'
      +   '<div class="mx-ovp-head"><h3>Game HUD</h3><span class="mx-hint">The scoreboard the game shows. One click changes the style everywhere it is used: OBS, over the game and the previews.</span></div>'
      +   '<div class="mx-ovp-games" role="tablist" aria-label="Game"></div>'
      +   '<div class="mx-ovp-og" hidden></div>'
      +   '<div class="mx-card mx-ovp-now"></div>'
      +   '<div class="mx-ovp-grid"></div>'
      +   '<div class="mx-ovp-head mx-ovp-head--cat"><h3>All built-in overlays</h3><span class="mx-hint">Caster desks, break screens, brackets and more. Copy a link into an OBS Browser source (1920 x 1080), or start a custom one from a template on the Custom tab.</span></div>'
      +   '<div class="mx-ovp-cattools"><div class="mx-ovp-catchips"></div><input type="search" class="input-text mx-ovp-catq" placeholder="Search built-in overlays"></div>'
      +   '<div class="mx-ovp-cat"></div>'
      + '</div>';
    var cr = $('mx-cr');
    if (cr) host.insertBefore(page, cr); else host.appendChild(page);
    page.addEventListener('click', onClick);
    page.querySelector('.mx-ovp-catq').addEventListener('input', function (e) { catQ = e.target.value; renderCatalog(); });
    setTab(tab);
  }
  // ── Tabs ────────────────────────────────────────────────────────────────────────────────
  var tab = 'custom';
  try { tab = localStorage.getItem('mx.ovp.tab') === 'default' ? 'default' : 'custom'; } catch (e) {}
  function setTab(t) {
    tab = t === 'default' ? 'default' : 'custom';
    try { localStorage.setItem('mx.ovp.tab', tab); } catch (e) {}
    if (!page) return;
    [].forEach.call(page.querySelectorAll('[data-ov="tab"]'), function (b) { var on = b.getAttribute('data-tab') === tab; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
    [].forEach.call(page.querySelectorAll('.mx-ovp-pane'), function (p) { p.hidden = p.getAttribute('data-pane') !== tab; });
    if (tab === 'custom') { if (window.__ovb) window.__ovb.render(); } else { renderPage(); renderCatalog(); }
  }
  // ── Default ▸ All built-in overlays (the SCENE_SOURCES catalogue in app.js) ─────────────
  var catGroup = '', catQ = '';
  function catalog() { try { return typeof SCENE_SOURCES !== 'undefined' && Array.isArray(SCENE_SOURCES) ? SCENE_SOURCES : []; } catch (e) { return []; } }
  function renderCatalog() {
    if (!page) return;
    var groups = catalog();
    if (!catGroup && groups.length) catGroup = groups[0].group;
    var q = catQ.trim().toLowerCase();
    var chips = page.querySelector('.mx-ovp-catchips'), box = page.querySelector('.mx-ovp-cat');
    var sig = JSON.stringify([catGroup, q, overGame.length, groups.length]);
    if (box._sig === sig) return;
    box._sig = sig;
    chips.innerHTML = groups.map(function (g) {
      return '<button type="button" class="mx-ovp-chip' + (!q && g.group === catGroup ? ' is-on' : '') + '" data-ov="catg" data-g="' + esc(g.group) + '"><span>' + esc(g.group) + '</span><em>' + g.items.length + '</em></button>';
    }).join('');
    var items = [];
    groups.forEach(function (g) {
      if (!q && g.group !== catGroup) return;
      g.items.forEach(function (it) { if (!q || (it.name + ' ' + (it.desc || '')).toLowerCase().indexOf(q) >= 0) items.push(it); });
    });
    box.innerHTML = items.length ? items.map(function (it) {
      var on = overGameOpen(it.path);
      return '<div class="mx-ovp-item"><div class="mx-ovp-item-pic"><img src="' + esc(thumb(it.path)) + '" alt="" loading="lazy"></div>'
        + '<div class="mx-ovp-item-b"><b>' + esc(it.name.replace(/^★\s*/, '')) + '</b>' + (it.aspect ? '<em>' + esc(it.aspect) + '</em>' : '') + '<span>' + esc(it.desc || '') + '</span></div>'
        + '<div class="mx-ovp-item-a"><button type="button" class="mx-btn mx-btn-sm" data-ov="copy" data-path="' + esc(it.path) + '" title="Paste into an OBS Browser source">Copy OBS link</button>'
        + '<button type="button" class="mx-btn mx-btn-sm mx-btn-quiet" data-ov="open" data-path="' + esc(it.path) + '">Preview</button>'
        + (it.aspect ? '' : '<button type="button" class="mx-btn mx-btn-sm mx-btn-quiet" data-ov="over" data-path="' + esc(it.path) + '" data-name="' + esc(it.name) + '"' + (on ? ' disabled' : '') + '>' + (on ? 'Over the game now' : 'Over the game') + '</button>')
        + '</div></div>';
    }).join('') : '<p class="mx-hint">No built-in overlay matches.</p>';
  }
  function onClick(e) {
    var b = e.target.closest('[data-ov]'); if (!b) return;
    var s = st(), act = b.getAttribute('data-ov'), g = b.getAttribute('data-game') || viewGame, p = b.getAttribute('data-path');
    if (act === 'tab') setTab(b.getAttribute('data-tab'));
    else if (act === 'catg') { catGroup = b.getAttribute('data-g'); catQ = ''; page.querySelector('.mx-ovp-catq').value = ''; renderCatalog(); }
    else if (act === 'game') { viewGame = g; renderPage(); }
    else if (act === 'use') { if (typeof send === 'function') send('set_theme', { game: g, theme: b.getAttribute('data-theme') }); }
    else if (act === 'over') openOverGame(p, b.getAttribute('data-name') || 'Overlay');
    else if (act === 'copy') copy(url(p), b);
    else if (act === 'open') window.open(url(p) + (p.indexOf('?') >= 0 ? '&' : '?') + 'preview=1', '_blank');
    else if (act === 'og-hide') window.electronAPI && window.electronAPI.gameOverlayCommand(null, 'toggle-hidden');
    else if (act === 'og-close') window.electronAPI && window.electronAPI.gameOverlayCommand(null, 'close-all');
    else if (act === 'og-one') window.electronAPI && window.electronAPI.gameOverlayCommand(b.getAttribute('data-key'), 'close');
  }
  function renderPage() {
    if (!page) return;
    var s = st();
    var g = viewGame && (s.games || {})[viewGame] ? viewGame : s.activeGame;
    // Game chips: the active game first, then every game that has overlay styles.
    var ids = Object.keys(s.games || {}).filter(function (id) { return themesOf(s, id).length; });
    ids.sort(function (a, b) { return (a === s.activeGame ? -1 : b === s.activeGame ? 1 : gameName(s, a).localeCompare(gameName(s, b))); });
    var chips = page.querySelector('.mx-ovp-games');
    var csig = JSON.stringify([ids, g, s.activeGame]);
    if (chips._sig !== csig) {
      chips._sig = csig;
      chips.innerHTML = ids.map(function (id) {
        var lg = gameLogo(s, id);
        return '<button type="button" class="mx-ovp-chip' + (id === g ? ' is-on' : '') + '" data-ov="game" data-game="' + esc(id) + '" role="tab" aria-selected="' + (id === g) + '">'
          + (lg ? '<img src="' + esc(lg) + '" alt="">' : '') + '<span>' + esc(gameName(s, id)) + '</span>' + (id === s.activeGame ? '<em>Active</em>' : '') + '</button>';
      }).join('');
    }
    // Over-game windows
    var og = page.querySelector('.mx-ovp-og');
    var osig = JSON.stringify(overGame);
    if (og._sig !== osig) {
      og._sig = osig;
      og.hidden = !overGame.length;
      og.innerHTML = '<b>Over the game now</b>' + overGame.map(function (o) {
        return '<span class="mx-ovp-ogw">' + esc(o.name) + '<button type="button" class="mx-link" data-ov="og-one" data-key="' + esc(o.key) + '">Close</button></span>';
      }).join('') + '<span class="mx-ovp-sp"></span><button type="button" class="mx-btn mx-btn-sm" data-ov="og-hide">' + (overGame.some(function (o) { return o.hidden; }) ? 'Show all' : 'Hide all') + '</button>'
        + '<button type="button" class="mx-btn mx-btn-sm" data-ov="og-close">Close all</button>';
    }
    // The style in use
    var cur = currentTheme(s, g), list = themesOf(s, g);
    var now = page.querySelector('.mx-ovp-now');
    var nsig = JSON.stringify([g, cur && cur.id, overGame.length, gameLive(s, g)]);
    if (now._sig !== nsig) {
      now._sig = nsig;
      if (!cur) {
        now.innerHTML = '<div class="mx-empty-state"><b>' + esc(gameName(s, g)) + ' has no overlay styles</b><span>Its graphics are on the Graphics page.</span></div>';
      } else {
        var isOn = overGameOpen(cur.path);
        now.innerHTML = '<div class="mx-ovp-now-pic"><img src="' + esc(thumb(cur.path)) + '" alt="" loading="lazy"></div>'
          + '<div class="mx-ovp-now-txt"><span class="mx-ovp-k">' + esc(gameName(s, g)) + (g === s.activeGame ? ' · on air' : ' · not the active game') + '</span>'
          + '<h3>' + esc(cur.name) + '</h3>'
          + '<p class="mx-hint">' + (g === s.activeGame && gameLive(s, g) ? 'The game is sending live data.' : 'Shows sample data until the game sends live data.') + '</p>'
          + '<div class="mx-ovp-acts">'
          + '<button type="button" class="mx-btn mx-btn-primary" data-ov="over" data-path="' + esc(cur.path) + '" data-name="' + esc(cur.name) + '"' + (isOn ? ' disabled' : '') + '>' + (isOn ? 'Over the game now' : 'Show over the game') + '</button>'
          + '<button type="button" class="mx-btn" data-ov="copy" data-path="' + esc(cur.path) + '" title="Paste into an OBS Browser Source (1920x1080)">Copy OBS link</button>'
          + '<button type="button" class="mx-btn mx-btn-quiet" data-ov="open" data-path="' + esc(cur.path) + '">Open preview</button>'
          + '</div><code class="mx-ovp-url">' + esc(url(cur.path)) + '</code></div>';
      }
    }
    // All styles
    var grid = page.querySelector('.mx-ovp-grid');
    var gsig = JSON.stringify([g, cur && cur.id, list.map(function (t) { return t.id; })]);
    if (grid._sig !== gsig) {
      grid._sig = gsig;
      grid.innerHTML = list.map(function (t) {
        var on = cur && t.id === cur.id;
        return '<div class="mx-ovp-card' + (on ? ' is-on' : '') + '"><div class="mx-ovp-card-pic"><img src="' + esc(thumb(t.path)) + '" alt="" loading="lazy">' + (on ? '<span class="mx-ovp-badge">In use</span>' : '') + '</div>'
          + '<div class="mx-ovp-card-row"><b>' + esc(t.name) + '</b>'
          + (on ? '<button type="button" class="mx-btn mx-btn-sm" data-ov="over" data-path="' + esc(t.path) + '" data-name="' + esc(t.name) + '">Over the game</button>'
            : '<button type="button" class="mx-btn mx-btn-sm mx-btn-primary" data-ov="use" data-game="' + esc(g) + '" data-theme="' + esc(t.id) + '">Use this style</button>')
          + '</div></div>';
      }).join('') || '<p class="mx-hint">No styles for this game.</p>';
    }
  }

  // ── Dashboard: Look preview card ────────────────────────────────────────────────────────
  function renderLookPrev() {
    var card = document.getElementById('dbk-look-ov');
    if (!card || !card.offsetParent) return;
    var s = st(), g = s.activeGame;
    var cur = currentTheme(s, g);
    var live = gameLive(s, g);
    var canOver = !!(cur && window.electronAPI && window.electronAPI.openGameOverlay);
    var isOver = !!(cur && overGameOpen(cur.path));
    var sig = JSON.stringify([g, cur && cur.id, live, canOver, isOver, themesOf(s, g).length]);
    if (card._sig === sig) return;
    card._sig = sig;
    if (!cur) {
      card.innerHTML = '<div class="mx-lo is-empty"><span class="mx-lo-t"><span class="mx-lo-k">' + esc(gameName(s, g) || 'No game picked') + '</span><b>No overlay for this game</b></span>'
        + '<button type="button" class="mx-btn mx-btn-sm" data-lp="overlays">Overlays</button></div>';
      return;
    }
    var n = themesOf(s, g).length;
    card.innerHTML = '<div class="mx-lo">'
      + '<button type="button" class="mx-lo-thumb" data-lp="overlays" title="Change the overlay style"><img src="' + esc(thumb(cur.path)) + '" alt="" loading="lazy"></button>'
      + '<span class="mx-lo-t">' + (gameLogo(s, g) ? '<span class="mx-lo-k"><img alt="" src="' + esc(gameLogo(s, g)) + '">' + esc(gameName(s, g)) + ' overlay</span>' : '<span class="mx-lo-k">' + esc(gameName(s, g)) + ' overlay</span>')
      + '<b>' + esc(cur.name) + '</b>'
      + '<span class="mx-lo-acts">' + (n > 1 ? '<button type="button" class="mx-link" data-lp="overlays">Change style (' + n + ')</button>' : '<button type="button" class="mx-link" data-lp="overlays">Open Overlays</button>')
      + (canOver ? (isOver ? '<span class="mx-lo-on">Over the game</span>' : '<button type="button" class="mx-link" data-lp="over">Show over the game</button>') : '')
      + '<button type="button" class="mx-link" data-lp="settings" title="Open this game\'s settings">Game settings</button>'
      + '</span></span></div>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#dbk-look-ov [data-lp]'); if (!b) return;
    var s = st(), cur = currentTheme(s, s.activeGame);
    if (b.getAttribute('data-lp') === 'overlays') { var n = document.querySelector('.mx-nav [data-mx-item="overlays"]'); if (n) n.click(); }
    else if (b.getAttribute('data-lp') === 'over' && cur) openOverGame(cur.path, cur.name);
    else if (b.getAttribute('data-lp') === 'settings' && typeof openSettings === 'function') openSettings('games');
  });

  // A thumbnail that can't load (server still rendering it, file gone) is hidden, never a broken icon.
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && t.closest && t.closest('.mx-ovp, .dbk-look')) t.style.visibility = 'hidden';
  }, true);

  // Overlay colours in the brand bar: the same setColorMode the Match page and the old card used.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.dbk-cmode [data-cmode]'); if (!b) return;
    if (typeof setColorMode === 'function') setColorMode(b.getAttribute('data-cmode'));
    else if (typeof send === 'function') send('set_color_mode', { mode: b.getAttribute('data-cmode') });
    setTimeout(renderCmode, 80);
  });
  function renderCmode() {
    var mode = st().colorMode || 'team';
    [].forEach.call(document.querySelectorAll('.dbk-cmode [data-cmode]'), function (b) { b.classList.toggle('is-on', b.getAttribute('data-cmode') === mode); });
  }
  function renderAll() {
    renderCmode();
    if (!isModern()) return;
    if (root.getAttribute('data-mx-view') === 'overlays') { build(); if (tab === 'default') { renderPage(); renderCatalog(); } }
    renderLookPrev();
  }
  setInterval(renderAll, 1500);
  window.__mxOverlays = {
    render: function () { build(); if (tab === 'default') { renderPage(); renderCatalog(); } else if (window.__ovb) window.__ovb.render(); },
    tab: function (t) { build(); setTab(t); },
  };
})();
