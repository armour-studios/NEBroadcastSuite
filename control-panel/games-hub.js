/* ─── games-hub.js — one way to browse and set up games ───────────────────────
   Two surfaces share the same pieces:
     • Settings ▸ Games (#integration-games): one-time setup. Picker → header card → standard tabs
       Connection · Overlay · Automation · Scoring · Teams · Options · Custom content.
     • Dashboard ▸ Game Settings (#game-settings-section): per-match choices (Look · Sponsors ·
       Players · Format) PLUS every setup tab above, so a game can be fully set up without Settings.
   The setup tabs are ONE element (.gh-body) with two homes: it is MOVED (never cloned) into the
   Dashboard while a setup tab is picked there, and back into Settings whenever Settings ▸ Games shows.
   Both open on the active game; picking another game only VIEWS it (Make active switches the show).
   Markup: each Settings game is a .game-section of .gh-pane[data-gtab] blocks (index.html); the
   Dashboard panes are .gs-pane[data-gspane]. Tabs only appear when a game has something in them. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = () => (typeof currentState !== 'undefined' && currentState) || {};
  const STALE_MS = 45000;

  // Registry id -> Settings section key (games-section-<key>). Order = picker order after the active game.
  const SECTION = { 'rocket-league': 'rl', csgo: 'cs2', valorant: 'valorant', league: 'league', apex: 'apex',
    fortnite: 'fortnite', rainbow6: 'rainbow6', bedwars: 'bedwars' };
  const FROM_SECTION = Object.fromEntries(Object.entries(SECTION).map(([k, v]) => [v, k]));
  const FEED = { 'rocket-league': 'Stats API', csgo: 'Game State Integration', valorant: 'Local client API',
    league: 'Live Client Data API', apex: 'LiveAPI', fortnite: 'Manual scoring', rainbow6: 'Overwolf relay', bedwars: 'Server plugin' };
  const SHORT = { csgo: 'CS2', league: 'League', rainbow6: 'Rainbow Six', bedwars: 'Bedwars', 'marvel-rivals': 'Rivals',
    'mobile-legends': 'MLBB', 'honor-of-kings': 'HoK', overwatch: 'Overwatch', ggstrive: 'GG Strive', 'marvel-tokon': 'Tokon',
    'the-finals': 'The Finals', sf6: 'SF6', eafc: 'EA FC', smash: 'Smash', brawlhalla: 'Brawlhalla' };
  // Browser sources = every overlay LAYOUT the server registers for the game (games[id].themes, from
  // OVERLAY_LAYOUTS in server.js) plus the sources below that aren't layouts. It used to be a second
  // hand-kept list, and the RL Worlds HUD was added to the layouts but never here, so it had no row.
  const EXTRA_SOURCES = {
    'rocket-league': [['/rl-hud.html?only=scoreboard', 'Post-game scoreboard only']],
    apex: [['/apex.html?live=1', 'Observer HUD']],
    fortnite: [['/br-leaderboard.html', 'Leaderboard'], ['/br-rail.html', 'Standings rail'], ['/br-match.html', 'Match results']],
  };
  // Friendlier row labels where the layout name is terse.
  const SOURCE_LABEL = { '/rl-player.html': 'Player HUD (playing on this PC)' };
  function sourcesFor(d, id) {
    const g = games(d)[id] || {};
    const seen = new Set(), out = [];
    const add = (path, label) => { if (!path || seen.has(path)) return; seen.add(path); out.push([path, SOURCE_LABEL[path] || label]); };
    (Array.isArray(g.themes) ? g.themes : []).forEach((t) => add(t && t.path, (t && t.name) || 'Overlay'));
    (EXTRA_SOURCES[id] || []).forEach(([path, label]) => add(path, label));
    if (!out.length && g.overlay) add(g.overlay, 'Scoreboard');
    return out;
  }
  const SET_TABS = [['connection', 'Connection'], ['overlay', 'Overlay'], ['automation', 'Automation'], ['scoring', 'Scoring'],
    ['teams', 'Teams'], ['options', 'Options'], ['content', 'Custom content']];
  // Dashboard: [tab, label, pane]. Standard vocabulary, fixed order.
  const DASH_TABS = {
    'rocket-league': [['look', 'Look', 'look'], ['sponsors', 'Sponsors', 'sponsors'], ['players', 'Players', 'playercams']],
    csgo: [['players', 'Players', 'playercams']],
    smash: [['players', 'Players', 'smash']],
    brawlhalla: [['players', 'Players', 'brawlhalla']],
    'marvel-tokon': [['format', 'Format', 'tokon']],
  };

  const games = (d) => d.games || {};
  const nameOf = (d, id) => (games(d)[id] && games(d)[id].name) || id;
  const logoOf = (d, id) => { const g = games(d)[id]; return g && g.logo ? '../assets/' + g.logo : ''; };

  function status(id, d) {
    const on = (t) => ({ st: 'on', text: t }), off = (t) => ({ st: 'off', text: t });
    const fresh = (x) => !!(x && x.lastSeen && Date.now() - x.lastSeen < STALE_MS);
    switch (id) {
      case 'rocket-league': return d.rlConnected ? on('Connected') : off('Waiting for game');
      case 'csgo': return (d.csgo && d.csgo.connected) ? on('Connected') : off('Waiting for game');
      case 'valorant': return (d.valorant && d.valorant.connected) ? on('Connected') : off('Waiting for game');
      case 'league': return (d.lol && d.lol.connected) ? on('Connected') : off('Waiting for game');
      case 'apex': return (d.apex && d.apex.connected) ? on('Connected') : off(d.activeGame === 'apex' ? 'Waiting for game' : 'Server off');
      case 'rainbow6': { const g = d.r6 && d.r6.gepData; return (g && g.gepConnected && fresh(g)) ? on('Relay connected') : off('Relay not connected'); }
      case 'bedwars': { const b = d.bedwars && d.bedwars.data; return (b && b.connected && fresh(b)) ? on('Server connected') : off('No server data'); }
      case 'fortnite': return { st: 'none', text: 'Manual scoring' };
      default: return { st: 'none', text: 'No live data' };
    }
  }

  function orderedIds(d) {
    const g = games(d), active = d.activeGame;
    const live = Object.keys(SECTION).filter((id) => g[id] && id !== active);
    const rest = Object.keys(g).filter((id) => id !== active && !SECTION[id])
      .sort((a, b) => nameOf(d, a).localeCompare(nameOf(d, b)));
    return (g[active] ? [active] : []).concat(live, rest);
  }

  // ── Picker ─────────────────────────────────────────────────────────────────
  // Chips for the active game + every game with a live-data setup (+ the one being viewed), and an
  // "All games" popover with search for the rest.
  function renderPicker(host, selected, onSelect) {
    if (!host) return;
    const d = S(), active = d.activeGame;
    const ids = orderedIds(d);
    const chips = ids.filter((id) => id === active || SECTION[id] || id === selected);
    const sig = JSON.stringify([selected, active, chips.map((id) => [id, status(id, d).st]), ids.length]);
    if (host.dataset.sig === sig) return;
    if (host.querySelector('.gp-pop:not([hidden])')) return;   // don't rebuild under an open popover
    host.dataset.sig = sig;
    host._onSelect = onSelect;
    host.innerHTML = '<div class="gp-bar"><div class="gp-row">' + chips.map((id) => {
      const st = status(id, d), logo = logoOf(d, id);
      return `<button type="button" class="gp-chip${id === selected ? ' is-sel' : ''}${id === active ? ' is-active' : ''}" data-game="${esc(id)}" title="${esc(nameOf(d, id))}: ${esc(st.text)}">`
        + (logo ? `<img class="gp-logo" src="${esc(logo)}" alt="">` : '')
        + `<span class="gp-name">${esc(SHORT[id] || nameOf(d, id))}</span>`
        + (st.st !== 'none' ? `<span class="gp-dot" data-st="${st.st}"></span>` : '')
        + (id === active ? '<span class="gp-live">Active</span>' : '')
        + '</button>';
    }).join('') + '</div>'
      + `<button type="button" class="gp-more" aria-haspopup="true">All games <span>${ids.length}</span></button></div>`
      + '<div class="gp-pop" hidden><input type="text" class="input-text gp-search" placeholder="Search games"><div class="gp-list"></div></div>';
    if (!host._wired) {
      host._wired = true;
      host.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-game]');
        if (chip) { closePop(host); host._onSelect && host._onSelect(chip.dataset.game); return; }
        if (e.target.closest('.gp-more')) {
          const pop = host.querySelector('.gp-pop');
          if (pop.hidden) { pop.hidden = false; fillPop(host, ''); const s = pop.querySelector('.gp-search'); s.value = ''; s.focus(); }
          else closePop(host);
        }
      });
      host.addEventListener('input', (e) => { if (e.target.classList.contains('gp-search')) fillPop(host, e.target.value); });
      host.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(host); });
      document.addEventListener('click', (e) => { if (!host.contains(e.target)) closePop(host); });
    }
  }
  // Settings variant: a full-height list down the left side (search + Live data / Other games),
  // so every game is one click away and nothing scrolls sideways.
  function renderSideList(host, selected, onSelect) {
    if (!host) return;
    const d = S(), active = d.activeGame;
    const ids = orderedIds(d);
    const sig = JSON.stringify([selected, active, ids.map((id) => [id, status(id, d).st])]);
    host._onSelect = onSelect;
    if (!host._wired) {
      host._wired = true;
      host.innerHTML = '<input type="search" class="input-text ghl-search" placeholder="Search games" aria-label="Search games"><div class="ghl-list" role="listbox"></div>';
      host.addEventListener('click', (e) => { const r = e.target.closest('[data-game]'); if (r) host._onSelect && host._onSelect(r.dataset.game); });
      host.querySelector('.ghl-search').addEventListener('input', () => { host.dataset.sig = ''; renderSideList(host, host._sel, host._onSelect); });
    }
    host._sel = selected;
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    const needle = host.querySelector('.ghl-search').value.trim().toLowerCase();
    const match = (id) => !needle || nameOf(d, id).toLowerCase().includes(needle) || id.includes(needle);
    const row = (id) => {
      const st = status(id, d), logo = logoOf(d, id);
      return `<button type="button" class="ghl-item${id === selected ? ' is-sel' : ''}" data-game="${esc(id)}" role="option" aria-selected="${id === selected}" title="${esc(nameOf(d, id))}: ${esc(st.text)}">`
        + (logo ? `<img class="ghl-logo" src="${esc(logo)}" alt="">` : '<span class="ghl-logo"></span>')
        + `<span class="ghl-name">${esc(nameOf(d, id))}</span>`
        + (id === active ? '<span class="ghl-active">Active</span>' : '')
        + (st.st !== 'none' ? `<span class="ghl-dot" data-st="${st.st}"></span>` : '')
        + '</button>';
    };
    const live = ids.filter((id) => (SECTION[id] || id === active) && match(id));
    const other = ids.filter((id) => !SECTION[id] && id !== active && match(id));
    host.querySelector('.ghl-list').innerHTML =
      (live.length ? '<div class="ghl-group">Live data</div>' + live.map(row).join('') : '')
      + (other.length ? '<div class="ghl-group">Other games</div>' + other.map(row).join('') : '')
      + (!live.length && !other.length ? '<div class="ghl-empty">No games match.</div>' : '');
  }

  function closePop(host) { const p = host.querySelector('.gp-pop'); if (p && !p.hidden) { p.hidden = true; host.dataset.sig = ''; } }
  function fillPop(host, q) {
    const d = S(), active = d.activeGame, needle = String(q || '').trim().toLowerCase();
    const ids = orderedIds(d).filter((id) => !needle || nameOf(d, id).toLowerCase().includes(needle) || id.includes(needle));
    const row = (id) => {
      const st = status(id, d), logo = logoOf(d, id);
      return `<button type="button" class="gp-item" data-game="${esc(id)}">`
        + (logo ? `<img class="gp-logo" src="${esc(logo)}" alt="">` : '<span class="gp-logo"></span>')
        + `<span class="gp-item-name">${esc(nameOf(d, id))}</span>`
        + (id === active ? '<span class="gp-live">Active</span>' : `<span class="gp-item-st" data-st="${st.st}">${esc(st.text)}</span>`)
        + '</button>';
    };
    const liveIds = ids.filter((id) => SECTION[id] || id === active), other = ids.filter((id) => !SECTION[id] && id !== active);
    host.querySelector('.gp-list').innerHTML =
      (liveIds.length ? '<div class="gp-group">Live data</div>' + liveIds.map(row).join('') : '')
      + (other.length ? '<div class="gp-group">Other games</div>' + other.map(row).join('') : '')
      + (!ids.length ? '<div class="gp-empty">No games match.</div>' : '');
  }

  function makeActive(id) {
    if (typeof onGameSelectChange === 'function') onGameSelectChange(id);
    else if (typeof send === 'function') send('set_active_game', { game: id });
  }

  function paintHead(ids, id, d) {
    const logo = $(ids.logo), src = logoOf(d, id);
    if (logo) { logo.hidden = !src; if (src && logo.getAttribute('src') !== src) logo.src = src; }
    const nm = $(ids.name); if (nm) nm.textContent = nameOf(d, id);
    const st = status(id, d), chip = $(ids.status);
    if (chip) { chip.dataset.st = st.st; chip.textContent = st.text; }
    const isActive = id === d.activeGame;
    const badge = $(ids.badge); if (badge) badge.hidden = !isActive;
    const btn = $(ids.make); if (btn) { btn.hidden = isActive; btn.onclick = () => makeActive(id); }
    return isActive;
  }

  // ── Settings ▸ Games ──────────────────────────────────────────────────────
  let sView = null, sTab = 'connection';

  function settingsTabsFor(key) {
    const sec = $('games-section-' + key);
    const have = new Set(['connection', 'overlay', 'content']);
    if (sec) sec.querySelectorAll('.gh-pane[data-gtab]').forEach((p) => have.add(p.dataset.gtab));
    return SET_TABS.filter(([k]) => have.has(k));
  }

  function renderSettings() {
    const root = $('integration-games'); if (!root) return;
    const d = S(); const g = games(d);
    if (!Object.keys(g).length) return;
    const id = (sView && g[sView]) ? sView : (g[d.activeGame] ? d.activeGame : Object.keys(g)[0]);
    const key = SECTION[id] || 'generic';
    renderSideList($('gh-picker'), id, (gid) => { sView = gid; renderSettings(); });
    const isActive = paintHead({ logo: 'gh-logo', name: 'gh-name', status: 'gh-status', badge: 'gh-active-badge', make: 'gh-make-active' }, id, d);
    const sub = $('gh-sub'); if (sub) sub.textContent = FEED[id] || 'No live data feed';

    const tabs = settingsTabsFor(key);
    if (!tabs.some(([k]) => k === sTab)) sTab = 'connection';
    const bar = $('gh-tabs');
    const tsig = key + '|' + tabs.map((t) => t[0]).join(',') + '|' + sTab;
    if (bar && bar.dataset.sig !== tsig) {
      bar.dataset.sig = tsig;
      bar.innerHTML = tabs.map(([k, label]) => `<button type="button" class="ev-subnav-btn${k === sTab ? ' active' : ''}" data-gtab="${k}">${label}</button>`).join('');
    }

    // Settings takes the setup body back whenever it is on screen; otherwise the Dashboard may hold it.
    if (settingsOnGames()) {
      const b = claimBody(root.querySelector('.gh-card'));
      if (b) renderBody(b, id, key, sTab, isActive, d);
    }
  }

  // ── Shared setup body (.gh-body) ──────────────────────────────────────────
  let body = null, bodyGame = null;
  const getBody = () => body || (body = document.querySelector('#integration-games .gh-body'));
  const settingsOnGames = () => { const n = $('set-sec-gamesetup'); return !!(n && n.getClientRects().length); };
  function claimBody(host) {
    const b = getBody(); if (!b || !host) return null;
    if (b.parentElement !== host) host.appendChild(b);
    return b;
  }

  // Show one game's panes for one tab inside the body, wherever it currently lives.
  function renderBody(b, id, key, tab, isActive, d) {
    const g = games(d);
    if (bodyGame !== id) {
      bodyGame = id;
      b.querySelectorAll('.game-section').forEach((s) => s.classList.toggle('active', s.id === 'games-section-' + key));
      document.querySelectorAll('#integration-games .game-tab-btn').forEach((x) => x.classList.toggle('active', x.dataset.game === key));
      const lead = $('gh-generic-lead');
      if (lead) lead.textContent = nameOf(d, id) + ' has no live data feed to set up. Teams, scores and the series run from the Dashboard, and its browser sources are on the Overlay tab.';
      if (key === 'apex' && typeof loadApexSetup === 'function') loadApexSetup();
      syncConfigBuilder(id);
    }
    b.querySelectorAll('.game-section.active .gh-pane').forEach((p) => { p.hidden = p.dataset.gtab !== tab; });
    b.querySelectorAll('.gh-shared').forEach((p) => { p.hidden = p.dataset.gtab !== tab; });

    // Overlay tab: the active game uses the shared picker (#select-design, kept in sync with the
    // header/dashboard copies). Any other game gets its own picker, so its layout can be chosen
    // ahead of time instead of being gated behind "make it active first".
    const layout = $('gh-layout-slot'), hint = $('gh-layout-inactive');
    if (layout) layout.hidden = !isActive;
    if (hint) {
      const themes = (g[id] && g[id].themes) || [];
      hint.hidden = isActive || !themes.length;
      if (!isActive && themes.length) {
        let sel = $('gh-layout-other');
        if (!sel) {
          hint.textContent = '';
          sel = document.createElement('select');
          sel.id = 'gh-layout-other'; sel.className = 'input-select';
          sel.addEventListener('change', () => { if (typeof send === 'function') send('set_theme', { game: sel.dataset.game, theme: sel.value }); });
          hint.appendChild(sel);
        }
        const cur = ((d.themesByGame || {})[id]) || (themes[0] && themes[0].id) || '';
        const k = JSON.stringify([id, themes.map((t) => t.id)]);
        if (sel.dataset.key !== k) {
          sel.dataset.key = k; sel.dataset.game = id;
          sel.innerHTML = themes.map((t) => '<option value="' + esc(t.id) + '">' + esc(t.name || t.id) + '</option>').join('');
        }
        if (document.activeElement !== sel) sel.value = cur;
      }
    }
    const srcs = sourcesFor(d, id);
    const grp = $('gh-sources-group'), list = $('gh-sources');
    if (grp) grp.hidden = !srcs.length;
    if (list) {
      const ssig = JSON.stringify(srcs);
      if (list.dataset.sig !== ssig) {
        list.dataset.sig = ssig;
        list.innerHTML = srcs.map(([path, label]) => {
          const url = 'http://localhost:3000' + path;
          return `<div class="gh-src"><span class="gh-src-name">${esc(label)}</span><code class="gh-src-url">${esc(url)}</code>`
            + `<button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(url)}">Copy</button>`
            + `<a class="btn btn-ghost btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Open</a>`
            // Not for ?only=scoreboard: that source is cut to in OBS and always shows the board, so over a
            // game it just sits there. The main HUD already raises and drops the board on its own.
            + (window.electronAPI && window.electronAPI.openGameOverlay && !/only=scoreboard/.test(path)
              ? `<button type="button" class="btn btn-ghost btn-sm" data-over-game="${esc(path)}" data-label="${esc(nameOf(d, id) + ' ' + label)}" title="Pop out over your game: transparent, always on top, click-through">Over game</button>` : '')
            + '</div>';
        }).join('');
      }
    }
  }

  function syncConfigBuilder(id) {
    const sel = $('gc-game'); if (!sel || sel.value === id) return;
    if (![].some.call(sel.options, (o) => o.value === id)) return;
    sel.value = id; sel.dispatchEvent(new Event('change'));
  }

  // ── Dashboard ▸ Game Settings ─────────────────────────────────────────────
  let dView = null, dActiveSeen = null;
  const D_TAB_KEY = 'ne_gs_tab_v2';
  const savedTabs = () => { try { return JSON.parse(localStorage.getItem(D_TAB_KEY)) || {}; } catch (_) { return {}; } };

  function renderDash() {
    const sec = $('game-settings-section'); if (!sec) return;
    const d = S(); const g = games(d);
    if (d.activeGame !== dActiveSeen) { dActiveSeen = d.activeGame; dView = null; }   // switching the show resets the view
    const id = (dView && g[dView]) ? dView : (d.activeGame || '');
    renderPicker($('gs-picker'), id, (gid) => { dView = gid === d.activeGame ? null : gid; renderDash(); });
    const isActive = paintHead({ logo: 'gs-logo', name: 'gs-game-name', status: 'gs-status', badge: 'gs-active-badge', make: 'gs-make-active' }, id, d);
    sec.classList.toggle('gs-not-active', !isActive);
    sec.dataset.game = id;   // CSS gates game-specific rows (e.g. .gs-rl-only)
    const key = SECTION[id] || 'generic';
    // Per-match tabs first, then this game's setup tabs (the same ones Settings ▸ Games shows).
    const match = DASH_TABS[id] || [];
    const tabs = id ? match.concat(settingsTabsFor(key).map(([k, label]) => ['set-' + k, label, 'setup'])) : [];
    const saved = savedTabs()[id];
    const cur = tabs.find((t) => t[0] === (sec.dataset.tab || saved)) ? (sec.dataset.tab || saved) : (tabs[0] && tabs[0][0]);
    const bar = $('gs-tabs');
    const tsig = id + '|' + tabs.map((t) => t[0]).join(',') + '|' + cur;
    if (bar && bar.dataset.sig !== tsig) {
      bar.dataset.sig = tsig;
      const btn = ([k, label]) => `<button type="button" class="ev-subnav-btn${k === cur ? ' active' : ''}" data-gstab="${k}">${label}</button>`;
      bar.innerHTML = match.map(btn).join('')
        + (match.length ? '<span class="gs-tab-sep" aria-hidden="true">Setup</span>' : '')
        + tabs.slice(match.length).map(btn).join('');
      bar.hidden = tabs.length < 2;
    }
    const pane = (tabs.find((t) => t[0] === cur) || [])[2];
    const notice = $('gs-notice');
    if (notice) { notice.hidden = isActive || pane === 'setup' || !match.length; notice.textContent = nameOf(d, id) + ' is not on air. Changes here are saved and used when you make it the active game.'; }
    sec.querySelectorAll('.gs-pane').forEach((p) => { p.hidden = p.dataset.gspane !== pane; });
    if (pane === 'setup' && !settingsOnGames()) {
      const b = claimBody($('gs-setup-slot'));
      if (b) renderBody(b, id, key, cur.slice(4), isActive, d);
    }
    const empty = $('gs-empty');
    if (empty) {
      empty.hidden = tabs.length > 0;
      empty.textContent = !id ? 'Pick a game to see its settings.'
        : 'Nothing to set up for ' + nameOf(d, id) + '.';
    }
    const pc = $('msp-playercams'), pcNote = $('gs-pc-off');
    if (pcNote) pcNote.hidden = !(pc && pc.style.display === 'none');
  }

  function openSetup(id, tab) {
    // openSettings('games') snaps the view back to the active game, so pick the game AFTER it.
    if (typeof openSettings === 'function') openSettings('games');
    sView = id; if (tab) sTab = tab;
    renderSettings();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  function init() {
    // Layout picker lives in the Overlay tab now; the old "Active game" block is retired (its
    // #select-game stays in the DOM, hidden, because the shared game-select wiring still fills it).
    const slot = $('gh-layout-slot');
    ['select-design', 'game-overlay-note'].forEach((x) => { const n = $(x); if (n && slot && n.parentElement !== slot) slot.appendChild(n); });
    const act = $('set-sec-activegame');
    if (act) { act.removeAttribute('data-setcat'); act.style.display = 'none'; act.hidden = true; }
    // Custom content (Config Builder) -> its own tab, always open, following the viewed game.
    const gc = $('section-game-config'), gcSlot = $('gh-content-slot');
    if (gc && gcSlot && gc.parentElement !== gcSlot) {
      gc.removeAttribute('data-setcat'); gc.style.display = ''; gcSlot.appendChild(gc);
      const fold = $('gc-fold'); if (fold) fold.open = true;
      const gsel = $('gc-game'); const wrap = gsel && gsel.closest('.field-row'); if (wrap) wrap.style.display = 'none';
    }
    // Rocket League scene automation -> RL Automation tab.
    const rl = $('set-sec-rl'), rlSlot = $('gh-rl-automation');
    if (rl && rlSlot && rl.parentElement !== rlSlot) { rl.removeAttribute('data-setcat'); rl.style.display = ''; rlSlot.appendChild(rl); }
    // The header status chip replaces the per-game connection lines.
    ['r6-conn-dot', 'bedwars-conn-dot'].forEach((x) => { const r = $(x) && $(x).closest('.field-row'); if (r) r.style.display = 'none'; });

    $('gh-tabs')?.addEventListener('click', (e) => { const b = e.target.closest('[data-gtab]'); if (b) { sTab = b.dataset.gtab; renderSettings(); } });
    $('gh-sources')?.addEventListener('click', (e) => {
      const og = e.target.closest('[data-over-game]');
      if (og) {
        const path = og.dataset.overGame;
        window.electronAPI.openGameOverlay({ url: 'http://localhost:3000' + path, path, name: og.dataset.label, nativeW: 1920, nativeH: 1080 })
          .then((r) => { if ((!r || !r.ok) && typeof showToast === 'function') showToast('Could not open the overlay window.', '#ef4444'); })
          .catch(() => { if (typeof showToast === 'function') showToast('Could not open the overlay window.', '#ef4444'); });
        return;
      }
      const b = e.target.closest('[data-copy]'); if (!b) return;
      const done = () => { const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1200); };
      try { navigator.clipboard.writeText(b.dataset.copy).then(done, done); } catch (_) { done(); }
    });
    // Legacy deep links click the hidden .game-tab-btn[data-game=<section key>].
    document.querySelectorAll('#integration-games .game-tab-btn').forEach((b) => b.addEventListener('click', () => {
      const id = FROM_SECTION[b.dataset.game]; if (id) { sView = id; renderSettings(); }
    }));
    $('gs-tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gstab]'); if (!b) return;
      const sec = $('game-settings-section'); const id = dView || S().activeGame;
      sec.dataset.tab = b.dataset.gstab;
      const m = savedTabs(); m[id] = b.dataset.gstab; try { localStorage.setItem(D_TAB_KEY, JSON.stringify(m)); } catch (_) {}
      renderDash();
    });
    // The Dashboard remembers a tab per game; drop the in-memory choice when the viewed game changes.
    $('gs-picker')?.addEventListener('click', (e) => { if (e.target.closest('[data-game]')) delete $('game-settings-section').dataset.tab; }, true);
    // Settings opening/closing (modal class, page display, category switch) decides who holds the body.
    const mo = new MutationObserver(() => { renderSettings(); renderDash(); });
    ['tab-ajustes-content', 'set-sec-gamesetup'].forEach((x) => { const n = $(x); if (n) mo.observe(n, { attributes: true, attributeFilter: ['class', 'style'] }); });
  }

  window.GamesHub = {
    onState() { renderSettings(); renderDash(); },
    followActive() { sView = null; renderSettings(); },
    openSetup,
  };
  // Nav search / deep links: "rocket-league" or "rocket-league:automation".
  window._ghOpen = (spec) => { const [id, tab] = String(spec).split(':'); openSetup(id, tab); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
