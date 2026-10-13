// Control panel, part 9 of 17: Cockpit: customize mode, mini panels, toolbar, audio, right rail, timers, preview dock.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ══════════════════════════════════ CUSTOMISABLE DASHBOARD ══════════════════════════════════════════
const DASH_CFG_KEY = 'ne_dash_v2';

// Widget registry — panels the user can show/hide and reorder on the Dashboard.
// auto-only panels (data-dash-auto) are not in this list; their visibility is managed by game logic.
const DASH_WIDGETS = [
  { id: 'event',    title: 'Event',          icon: 'calendar',   desc: 'Tournament name, start.gg event and status',        sel: '[data-dash-id="event"]',    defaultOn: true,  span: 'full' },
  { id: 'deck',     title: 'Deck',           icon: 'layout',     desc: 'Scene switcher, preview and hotkey buttons',        sel: '[data-dash-id="deck"]',     defaultOn: true,  span: 'full' },
  { id: 'teams',    title: 'Teams',          icon: 'users',      desc: 'Team names, rosters, scores and side swap',         sel: '[data-dash-id="teams"]',    defaultOn: true,  span: 'full' },
  { id: 'graphics', title: 'Graphics',       icon: 'sparkles',   desc: 'Full graphics hub — scenes, preview and settings',  sel: '[data-dash-id="graphics"]', defaultOn: true,  span: 'full', fixedSpan: 'full' },
  { id: 'onair',    title: 'On Air',         icon: 'zap',        desc: 'Quick-toggle card grid for all overlays',           sel: '[data-dash-id="onair"]',    defaultOn: false, span: 'full' },
  { id: 'gamesettings', title: 'Game Settings', icon: 'gamepad', desc: 'Settings for the active game — look, sponsor slots, player cams, stocks', sel: '[data-dash-id="gamesettings"]', defaultOn: true, span: 'full' },
  { id: 'adslots',  title: 'Sponsors',       icon: 'film',       desc: 'Desk footer text, footer logos and the active brand', sel: '[data-dash-id="adslots"]',  defaultOn: true,  span: 'full' },
  // 'showdeck' retired as a standalone widget — the Show Deck lives INSIDE the Talent Monitor
  // (DCC ▸ Show Deck tab) now; see placeShowDeck. Old saved configs may still carry a 'showdeck'
  // panel entry; getDashPanel() returns undefined for it and applyDashLayout skips it.
  { id: 'director', title: 'Talent Monitor', icon: 'zap',        desc: 'Live VDO talent monitor — Show Deck lineup, players, room monitoring (the AI director lives in Production, NEURAL AI)', sel: '[data-dash-id="director"]', defaultOn: true,  span: 'full' },
  { id: 'series',   title: 'Series',         icon: 'trophy',     desc: 'Best-of series scoreboard and match history',     sel: '[data-dash-id="series"]',   defaultOn: false, span: '1'    },
  { id: 'talent',   title: 'Talent',         icon: 'mic',        desc: 'On-air talent, camera feeds and VDO rooms',      sel: '[data-dash-id="talent"]',   defaultOn: false, span: '1'    },
  { id: 'casters',  title: 'Caster Desk',    icon: 'headphones', desc: 'Caster names, social handles and desk layout',   sel: '[data-dash-id="casters"]',  defaultOn: false, span: '1'    },
  { id: 'queue',    title: 'Stream Queue',   icon: 'list',       desc: 'Upcoming matches auto-loaded from the bracket',  sel: '#dash-mini-queue',          defaultOn: false, span: '1'    },
  { id: 'twitch',   title: 'Twitch Live',    icon: 'chat',       desc: 'Live viewer count and stream status',            sel: '#dash-mini-twitch',         defaultOn: false, span: '1'    },
  { id: 'obs',      title: 'OBS Status',     icon: 'monitor',    desc: 'Active OBS scene and recording status',          sel: '#dash-mini-obs',            defaultOn: false, span: '1'    },
];

function getDashCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(DASH_CFG_KEY));
    if (!c || !Array.isArray(c.panels)) return null;
    return c;
  } catch { return null; }
}
function setDashCfg(cfg) { try { localStorage.setItem(DASH_CFG_KEY, JSON.stringify(cfg)); } catch {} }
function defaultDashCfg() {
  return {
    cols: 1,
    panels: DASH_WIDGETS.map((w) => ({ id: w.id, on: w.defaultOn, span: w.span }))
  };
}
function getDashPanel(id) { return DASH_WIDGETS.find((w) => w.id === id); }

// Apply config: set order, display, span, and column count on every widget section.
function applyDashLayout() {
  const grid = el('dash-grid'); if (!grid) return;
  let cfg = getDashCfg() || defaultDashCfg();
  // One-time migration: old configs had onair before graphics and defaulted it on.
  // Flip onair off and move graphics in front so the full hub is the default graphics surface.
  if (!cfg._gfxMigrated) {
    const op = cfg.panels.find((p) => p.id === 'onair');
    const gp = cfg.panels.find((p) => p.id === 'graphics');
    if (op && op.on && gp) {
      op.on = false;
      // Move graphics immediately before onair in the order array.
      cfg.panels = cfg.panels.filter((p) => p.id !== 'graphics');
      const oi = cfg.panels.findIndex((p) => p.id === 'onair');
      cfg.panels.splice(oi, 0, gp);
    }
    cfg._gfxMigrated = true;
    setDashCfg(cfg);
  }

  // Grid column count
  grid.dataset.cols = cfg.cols || 1;

  // User-managed panels: apply order + display + span from config.
  const panels = cfg.panels || DASH_WIDGETS.map((w) => ({ id: w.id, on: w.defaultOn, span: w.span }));
  // Fill in any widget added after the user last saved their config (keeps them visible at the end).
  DASH_WIDGETS.forEach((w) => {
    if (panels.find((p) => p.id === w.id)) return;
    // Game Settings took over controls that used to sit inside Teams — place it right after Teams
    // rather than at the bottom of an existing layout.
    const after = w.id === 'gamesettings' ? panels.findIndex((p) => p.id === 'teams') : -1;
    if (after >= 0) panels.splice(after + 1, 0, { id: w.id, on: w.defaultOn, span: w.span });
    else panels.push({ id: w.id, on: w.defaultOn, span: w.span });
  });
  panels.forEach((p, i) => {
    const w = getDashPanel(p.id); if (!w) return;
    const section = grid.querySelector(w.sel);
    if (!section) return;
    section.style.order = i;
    section.style.display = p.on ? '' : 'none';
    // fixedSpan overrides any user-set span (e.g. Graphics is always full-width).
    section.dataset.dashSpan = w.fixedSpan || p.span || w.span || '1';
  });

  // Keep column picker buttons in sync
  document.querySelectorAll('.dcb-col-btn').forEach((b) => {
    b.classList.toggle('active', String(b.dataset.cols) === String(cfg.cols || 1));
  });
}

// ── Customize mode ──────────────────────────────────────────────────────────
let _dashEditing = false;

function setDashEditing(on) {
  _dashEditing = on;
  const grid = el('dash-grid');
  const controls = document.querySelector('.dcb-controls');
  const btn = el('dash-customize-btn');
  if (!grid) return;
  grid.classList.toggle('dash-editing', on);
  if (controls) controls.style.display = on ? '' : 'none';
  if (btn) btn.classList.toggle('active', on);
  if (on) {
    addDashHandles();
    wireDashGridDrag();
    renderDashCatalog();
  } else {
    removeDashHandles();
  }
}

// Width-button SVGs for the 3-state panel width selector.
const _DASH_W_SVG = {
  '1':    '<svg viewBox="0 0 20 14" width="18" height="12" fill="currentColor"><rect x="3" y="1" width="14" height="12" rx="2"/></svg>',
  '2':    '<svg viewBox="0 0 20 14" width="18" height="12" fill="currentColor"><rect x="1" y="1" width="7" height="12" rx="2"/><rect x="12" y="1" width="7" height="12" rx="2"/></svg>',
  'full': '<svg viewBox="0 0 20 14" width="18" height="12" fill="currentColor"><rect x="1" y="1" width="18" height="12" rx="2"/></svg>',
};
const _DASH_W_TITLES = { '1': '1 column', '2': '2 columns', 'full': 'Full width' };

// Inject drag-handle bars into each user-managed panel.
function addDashHandles() {
  const grid = el('dash-grid'); if (!grid) return;
  const cfg = getDashCfg() || defaultDashCfg();
  const cols = cfg.cols || 1;

  DASH_WIDGETS.forEach((w) => {
    const section = grid.querySelector(w.sel); if (!section) return;
    if (section.dataset.dashAuto) return;
    if (section.querySelector('.dash-handle')) return;
    const p = cfg.panels.find((x) => x.id === w.id) || { span: w.span };
    const curSpan = p.span || w.span || '1';

    const widthBtnsHtml = (cols > 1 && !w.fixedSpan)
      ? `<div class="dash-handle-widths">${['1','2','full'].map((s) =>
          `<button class="dash-handle-w${curSpan === s ? ' active' : ''}" data-span="${s}" title="${_DASH_W_TITLES[s]}">${_DASH_W_SVG[s]}</button>`
        ).join('')}</div>`
      : '';

    const handle = document.createElement('div');
    handle.className = 'dash-handle';
    handle.draggable = true;
    handle.dataset.dashHandle = w.id;
    handle.innerHTML =
      `<span class="dash-handle-grip">${svgIcon('grip')}</span>`
      + `<span class="dash-handle-title">${w.title}</span>`
      + widthBtnsHtml
      + `<button class="dash-handle-hide" title="Hide panel">${svgIcon('x')}</button>`;

    handle.querySelectorAll('.dash-handle-w').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = getDashCfg() || defaultDashCfg();
        let pp = c.panels.find((x) => x.id === w.id);
        if (!pp) { pp = { id: w.id, on: w.defaultOn, span: w.span }; c.panels.push(pp); }
        pp.span = btn.dataset.span;
        setDashCfg(c);
        applyDashLayout();
        removeDashHandles();
        addDashHandles();
      });
    });

    handle.querySelector('.dash-handle-hide')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = getDashCfg() || defaultDashCfg();
      let pp = c.panels.find((x) => x.id === w.id);
      if (!pp) { pp = { id: w.id, on: w.defaultOn, span: w.span }; c.panels.push(pp); }
      pp.on = false;
      setDashCfg(c);
      applyDashLayout();
      removeDashHandles();
      addDashHandles();
      renderDashCatalog();
    });

    section.insertBefore(handle, section.firstChild);
  });
}

function removeDashHandles() {
  document.querySelectorAll('.dash-handle').forEach((h) => h.remove());
}

// Catalog: card grid showing all panels so users can toggle visibility.
function renderDashCatalog() {
  const cat = el('dcb-catalog'); if (!cat) return;
  const cfg = getDashCfg() || defaultDashCfg();
  cat.innerHTML = '<div class="dcb-catalog-hdr">Panels</div>';

  DASH_WIDGETS.forEach((w) => {
    const p = cfg.panels.find((x) => x.id === w.id);
    const on = p ? p.on : w.defaultOn;

    const card = document.createElement('button');
    card.className = 'dcb-card' + (on ? ' on' : '');
    card.title = on ? 'Click to hide this panel' : 'Click to show this panel';
    card.innerHTML =
      `<div class="dcb-card-top">`
      + `<span class="dcb-card-icon">${svgIcon(w.icon || 'grip')}</span>`
      + `<span class="dcb-card-badge">${on ? 'Visible' : 'Hidden'}</span>`
      + `</div>`
      + `<div class="dcb-card-name">${w.title}</div>`
      + `<div class="dcb-card-desc">${w.desc || ''}</div>`;

    card.addEventListener('click', () => {
      const c = getDashCfg() || defaultDashCfg();
      let pp = c.panels.find((x) => x.id === w.id);
      if (!pp) { pp = { id: w.id, on: !on, span: w.span }; c.panels.push(pp); }
      else pp.on = !pp.on;
      setDashCfg(c);
      applyDashLayout();
      removeDashHandles();
      addDashHandles();
      renderDashCatalog();
    });

    cat.appendChild(card);
  });
}

// Drag-to-reorder panels in edit mode.
// Left/right 25% edge = side-by-side (half-width). Top/bottom centre = own row (full-width).
let _dashDragId = null;
let _dashScrollRaf = null;

function _dashScrollStop() {
  if (_dashScrollRaf) { cancelAnimationFrame(_dashScrollRaf); _dashScrollRaf = null; }
}

function _dashClearDragCls(grid) {
  grid.querySelectorAll('.dash-dragging, .dash-insert-top, .dash-insert-bot, .dash-insert-left, .dash-insert-right').forEach((x) => {
    x.classList.remove('dash-dragging', 'dash-insert-top', 'dash-insert-bot', 'dash-insert-left', 'dash-insert-right');
  });
}

function wireDashGridDrag() {
  const grid = el('dash-grid'); if (!grid || grid._dragWired) return;
  grid._dragWired = true;

  grid.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('[data-dash-handle]'); if (!handle) return;
    _dashDragId = handle.dataset.dashHandle;
    handle.closest('[data-dash-id]')?.classList.add('dash-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  grid.addEventListener('dragover', (e) => {
    if (!_dashDragId) return;
    const target = e.target.closest('[data-dash-id]');
    if (!target || target.dataset.dashId === _dashDragId) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    grid.querySelectorAll('.dash-insert-top, .dash-insert-bot, .dash-insert-left, .dash-insert-right').forEach((x) => {
      x.classList.remove('dash-insert-top', 'dash-insert-bot', 'dash-insert-left', 'dash-insert-right');
    });
    const rect = target.getBoundingClientRect();
    const cols = parseInt(grid.dataset.cols, 10) || 1;
    const pctX = (e.clientX - rect.left) / rect.width;
    const pctY = (e.clientY - rect.top)  / rect.height;
    if (cols > 1 && pctX < 0.25)      target.classList.add('dash-insert-left');
    else if (cols > 1 && pctX > 0.75) target.classList.add('dash-insert-right');
    else                               target.classList.add(pctY < 0.5 ? 'dash-insert-top' : 'dash-insert-bot');

    // Auto-scroll when cursor is near the top or bottom of the scroll container.
    _dashScrollStop();
    const scroll = el('tab-scroll');
    if (scroll) {
      const sr = scroll.getBoundingClientRect();
      const ZONE = 80, SPEED = 10;
      if (e.clientY < sr.top + ZONE) {
        const rate = SPEED * (1 - (e.clientY - sr.top) / ZONE);
        const step = () => { scroll.scrollTop -= rate; _dashScrollRaf = requestAnimationFrame(step); };
        _dashScrollRaf = requestAnimationFrame(step);
      } else if (e.clientY > sr.bottom - ZONE) {
        const rate = SPEED * ((e.clientY - (sr.bottom - ZONE)) / ZONE);
        const step = () => { scroll.scrollTop += rate; _dashScrollRaf = requestAnimationFrame(step); };
        _dashScrollRaf = requestAnimationFrame(step);
      }
    }
  });

  grid.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !grid.contains(e.relatedTarget)) {
      _dashScrollStop();
      grid.querySelectorAll('.dash-insert-top, .dash-insert-bot, .dash-insert-left, .dash-insert-right').forEach((x) => {
        x.classList.remove('dash-insert-top', 'dash-insert-bot', 'dash-insert-left', 'dash-insert-right');
      });
    }
  });

  grid.addEventListener('drop', (e) => {
    _dashScrollStop();
    if (!_dashDragId) return;
    const target = e.target.closest('[data-dash-id]');
    if (!target || target.dataset.dashId === _dashDragId) { _dashDragId = null; _dashClearDragCls(grid); return; }
    e.preventDefault();
    const isLeft  = target.classList.contains('dash-insert-left');
    const isRight = target.classList.contains('dash-insert-right');
    const cfg = getDashCfg() || defaultDashCfg();
    // Ensure src + tgt are in config (may be missing if config was saved before these widgets existed).
    [_dashDragId, target.dataset.dashId].forEach((id) => {
      if (!cfg.panels.find((p) => p.id === id)) {
        const w = getDashPanel(id); if (w) cfg.panels.push({ id, on: w.defaultOn, span: w.span });
      }
    });
    const srcIdx = cfg.panels.findIndex((p) => p.id === _dashDragId);
    if (srcIdx < 0) { _dashDragId = null; _dashClearDragCls(grid); return; }
    const [item] = cfg.panels.splice(srcIdx, 1);
    const tgtIdx = cfg.panels.findIndex((p) => p.id === target.dataset.dashId);
    cfg.panels.splice(tgtIdx < 0 ? cfg.panels.length : (isRight ? tgtIdx + 1 : tgtIdx), 0, item);
    const srcWidget = getDashPanel(item.id);
    const tgtWidget = getDashPanel(target.dataset.dashId);
    if (isLeft || isRight) {
      if (!srcWidget?.fixedSpan) item.span = '1';
      const tgtPanel = cfg.panels.find((p) => p.id === target.dataset.dashId);
      if (tgtPanel && !tgtWidget?.fixedSpan) tgtPanel.span = '1';
    } else {
      if (!srcWidget?.fixedSpan) item.span = 'full';
    }
    setDashCfg(cfg);
    applyDashLayout();
    removeDashHandles();
    addDashHandles();
    _dashDragId = null;
    _dashClearDragCls(grid);
  });

  grid.addEventListener('dragend', () => {
    _dashScrollStop();
    _dashDragId = null;
    _dashClearDragCls(grid);
  });
}

// Wiring — runs once on page load
(function wireDashCustomize() {
  el('dash-customize-btn')?.addEventListener('click', (e) => { e.stopPropagation(); setDashEditing(!_dashEditing); });
  el('dcb-done')?.addEventListener('click', () => setDashEditing(false));

  // Column picker — re-render handles and catalog since width options change with col count
  document.querySelectorAll('.dcb-col-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cfg = getDashCfg() || defaultDashCfg();
      cfg.cols = Number(btn.dataset.cols) || 1;
      setDashCfg(cfg);
      applyDashLayout();
      removeDashHandles();
      addDashHandles();
      renderDashCatalog();
    });
  });

  // Apply initial layout from saved config
  applyDashLayout();
})();

// ── Mini panels: render from live state ─────────────────────────────────────
function renderDashMiniPanels(data) {
  // Stream Queue mini
  const queueEl = el('dash-mini-queue-content');
  if (queueEl && el('dash-mini-queue')?.style.display !== 'none') {
    const queue = (data.startgg && data.startgg.queue) || [];
    if (!queue.length) {
      queueEl.innerHTML = '<p class="dash-mini-empty">No matches in stream queue.</p>';
    } else {
      queueEl.innerHTML = queue.slice(0, 6).map((m) => {
        const live = m.live ? '<span class="dash-mini-queue-live">LIVE</span>' : '';
        return `<div class="dash-mini-queue-item">${live}<span class="dash-mini-queue-vs">${dEsc(m.teamA||'TBD')} vs ${dEsc(m.teamB||'TBD')}</span><span class="dash-mini-queue-round">${dEsc(m.round||'')}</span></div>`;
      }).join('');
    }
  }

  // Twitch Live mini
  if (el('dash-mini-twitch')?.style.display !== 'none') {
    const tw = data.twitch || {};
    const viewers = el('dmtw-viewers'); if (viewers) viewers.textContent = tw.viewerCount != null ? Number(tw.viewerCount).toLocaleString() : '—';
    const follows = el('dmtw-followers'); if (follows) follows.textContent = tw.followerCount != null ? Number(tw.followerCount).toLocaleString() : '—';
    const status = el('dmtw-status-val');
    if (status) { status.textContent = tw.isLive ? 'Live' : tw.connected ? 'Connected' : 'Offline'; status.style.color = tw.isLive ? '#22c55e' : ''; }
    const game = el('dmtw-game-val'); if (game) game.textContent = tw.gameName || tw.channelGame || '—';
  }

  // OBS Status mini
  if (el('dash-mini-obs')?.style.display !== 'none') {
    const obs = data.obs || {};
    const sceneEl = el('dmobs-scene'); if (sceneEl) sceneEl.textContent = obs.currentScene || (obs.connected ? 'Unknown' : 'Disconnected');
    const streamPill = el('dmobs-stream');
    if (streamPill) { streamPill.textContent = obs.streaming ? 'Streaming' : 'Stream Off'; streamPill.classList.toggle('on', !!obs.streaming); }
    const recPill = el('dmobs-record');
    if (recPill) { recPill.textContent = obs.recording ? 'Recording' : 'Record Off'; recPill.classList.toggle('on', !!obs.recording); }
    const bufPill = el('dmobs-replay');
    rbPill(bufPill, obs);
    const scenesList = el('dmobs-scenes-list');
    if (scenesList) {
      // Skip the collection's blank "═══ DIVIDER ═══" separator scenes — clicking one cuts
      // program to black, and they'd eat most of this widget's 10 slots.
      const scenes = (obs.availableScenes || []).filter((s) => !/^═/.test(s));
      const current = obs.currentScene || '';
      scenesList.innerHTML = scenes.slice(0, 10).map((s) => `<button class="dmobs-scene-btn${s === current ? ' on' : ''}" data-scene="${dEsc(s)}">${dEsc(s)}</button>`).join('');
      scenesList.querySelectorAll('.dmobs-scene-btn').forEach((b) => {
        b.addEventListener('click', () => send('obs_switch_scene', { sceneName: b.dataset.scene }));
      });
    }
  }
}

// ── Global quick-action toolbar (fixed bottom bar) ──────────────────────────
// ── OBS audio volume ride — shared by the on-air pills AND the Production Deck tiles ──
function obsVolNow(inputName) { const inp = ((currentState.obs && currentState.obs.audioInputs) || []).find((i) => i.name === inputName); return inp ? (inp.volumeDb || 0) : 0; }
let _obsVolSendT = null, _obsVolSendAt = 0;
function obsSetVolume(inputName, db) {
  db = Math.max(-60, Math.min(0, Math.round(db)));
  const inp = ((currentState.obs && currentState.obs.audioInputs) || []).find((i) => i.name === inputName);
  if (inp) inp.volumeDb = db;   // optimistic — the server echoes back via InputVolumeChanged
  const fire = () => { _obsVolSendAt = Date.now(); send('obs_set_volume', { inputName, volumeDb: db }); };
  const now = Date.now();
  if (now - _obsVolSendAt > 80) fire();
  else { clearTimeout(_obsVolSendT); _obsVolSendT = setTimeout(fire, 80); }
  return db;
}
let _obsVolPop = null;
function closeObsVolPop() { if (_obsVolPop) { _obsVolPop.remove(); _obsVolPop = null; document.removeEventListener('pointerdown', _obsVolPopAway, true); } }
function _obsVolPopAway(e) { if (_obsVolPop && !_obsVolPop.contains(e.target)) closeObsVolPop(); }
function obsVolPopover(inputName, anchor) {
  closeObsVolPop();
  const pop = document.createElement('div'); pop.className = 'qt-vol-pop';
  const db = obsVolNow(inputName);
  pop.innerHTML = `<span class="qt-vol-name"></span><input type="range" min="-60" max="0" step="1" value="${db}"><span class="qt-vol-db"></span>`;
  pop.querySelector('.qt-vol-name').textContent = inputName;
  pop.querySelector('.qt-vol-db').textContent = db + ' dB';
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + 'px';
  const range = pop.querySelector('input'), dbl = pop.querySelector('.qt-vol-db');
  range.addEventListener('input', () => { dbl.textContent = obsSetVolume(inputName, Number(range.value)) + ' dB'; });
  range.addEventListener('wheel', (e) => { e.preventDefault(); range.value = String(obsSetVolume(inputName, Number(range.value) + (e.deltaY < 0 ? 3 : -3))); dbl.textContent = range.value + ' dB'; }, { passive: false });
  requestAnimationFrame(() => range.focus());
  _obsVolPop = pop;
  setTimeout(() => document.addEventListener('pointerdown', _obsVolPopAway, true), 0);
}
// Wire wheel + right-click + long-press volume onto any audio button/tile (click stays = mute).
function attachAudioVolume(btn, inputName) {
  btn.addEventListener('wheel', (e) => { e.preventDefault(); obsSetVolume(inputName, obsVolNow(inputName) + (e.deltaY < 0 ? 3 : -3)); }, { passive: false });
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); obsVolPopover(inputName, btn); });
  let lpT = null, lpFired = false;
  btn.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; lpFired = false; lpT = setTimeout(() => { lpFired = true; obsVolPopover(inputName, btn); }, 450); });
  const cancel = () => { if (lpT) { clearTimeout(lpT); lpT = null; } };
  btn.addEventListener('pointerup', cancel); btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('click', (e) => { if (lpFired) { e.stopImmediatePropagation(); e.preventDefault(); lpFired = false; } }, true);
}

let _qtSceneSig = '';
function renderQuickToolbar(data) {
  const obs = data.obs || {};

  const at = el('qt-autoswitch');
  if (at && document.activeElement !== at) { at.checked = obs.autoSwitch !== false; at.disabled = !obs.enabled; }

  const wrap = el('qt-obs-scenes');
  const scenes = obs.scenes || {};
  const connected = !!obs.connected;
  const pins = (typeof bbPinned === 'function') ? bbPinned() : [];
  // Pinned overlay/trigger live-states go in the sig so the bar rebuilds when they change.
  const pinState = pins.map((p) => { const i = (typeof bbActionInfo === 'function') ? bbActionInfo(p) : null; return i ? `${p.t}:${p.k}:${i.live ? 1 : 0}` : ''; });
  const sig = JSON.stringify({ scenes, connected, enabled: !!obs.enabled, pins, pinState, ord: bbOrder(), prog: obs.currentScene || '' });
  if (wrap && sig !== _qtSceneSig) {
    _qtSceneSig = sig;
    wrap.innerHTML = '';
    const hintEl = (txt) => { const h = document.createElement('span'); h.className = 'qt-hint'; h.textContent = txt; wrap.appendChild(h); };
    const mkBadge = (hk) => hk != null ? `<kbd class="qt-key">${hk}</kbd>` : '';
    const sceneBtn = (sn, label, hk, token) => {
      const b = document.createElement('button');
      b.className = 'qt-scene-btn';
      b.innerHTML = mkBadge(hk) + `<span class="qt-act-lbl"></span>`;
      b.querySelector('.qt-act-lbl').textContent = label;
      b.title = `Cut to "${sn}"` + (hk != null ? `  ·  hotkey ${hk}` : '') + '  ·  drag to reorder / rebind';
      b.dataset.scene = sn; b.dataset.bbtoken = token; if (hk != null) b.dataset.hk = hk;
      b.draggable = true;
      b.addEventListener('click', () => send('obs_switch_scene', { sceneName: sn }));
      return b;
    };
    const actionBtn = (p, info, hk, token) => {
      const b = document.createElement('button');
      b.className = `qt-scene-btn qt-act-btn qt-act-${p.t}` + (info.live ? ' live' : '');
      b.innerHTML = mkBadge(hk) + `<span class="qt-act-lbl"></span>`;
      b.querySelector('.qt-act-lbl').textContent = info.label;
      b.title = (p.t === 'overlay' ? 'Toggle overlay · ' : 'Set options & go live · ') + info.label + (hk != null ? `  ·  hotkey ${hk}` : '') + '  ·  drag to reorder / rebind';
      b.dataset.bbtoken = token; if (hk != null) b.dataset.hk = hk;
      b.draggable = true;
      b.addEventListener('click', () => {
        // Triggers with options (team/player/countdown) open a config popover; everything else runs.
        if (p.t === 'trigger' && !info.live && typeof bbHasTriggerConfig === 'function' && bbHasTriggerConfig(p.k)) { bbOpenTriggerConfig(p.k, b); return; }
        const fresh = bbActionInfo(p); if (fresh) fresh.run();
      });
      // Audio pill: mute on click; wheel / right-click / long-press rides volume.
      if (info.kind === 'audio') {
        b.title = `${info.label}  ·  ${info.live ? 'MUTED' : (info.volumeDb ?? 0) + ' dB'}  ·  click = mute · wheel / right-click = volume`;
        attachAudioVolume(b, info.inputName);
      } else if (info.kind === 'source') {
        b.title = `Show / hide "${info.label}"  ·  ${info.live ? 'shown' : 'hidden'}  ·  drag to reorder`;
      }
      return b;
    };
    // One unified, reorderable button list: mapped OBS moments + pins, deduped by resolved identity.
    const descriptors = [];
    const seenScene = new Set(), seenAct = new Set();
    if (obs.enabled && connected) {
      SCENE_CONTROL_MOMENTS.forEach((m) => {
        const sn = scenes[m.key]; if (!sn || seenScene.has(sn)) return;
        seenScene.add(sn);
        descriptors.push({ token: 'm:' + m.key, make: (hk) => sceneBtn(sn, m.label, hk, 'm:' + m.key) });
      });
    }
    pins.forEach((p) => {
      if (p.t === 'scene') {
        if (!obs.enabled || !connected || seenScene.has(p.k)) return;
        seenScene.add(p.k);
        descriptors.push({ token: 'scene:' + p.k, make: (hk) => sceneBtn(p.k, p.k, hk, 'scene:' + p.k) });
      } else {
        const key = p.t + ':' + p.k;
        if (seenAct.has(key)) return;
        const info = bbActionInfo(p); if (!info) return;
        seenAct.add(key);
        descriptors.push({ token: key, make: (hk) => actionBtn(p, info, hk, key) });
      }
    });
    // Order by the saved bar order; known tokens first (in saved order), unknowns keep default order.
    const order = bbOrder();
    const rankOf = (tok) => { const i = order.indexOf(tok); return i < 0 ? Infinity : i; };
    descriptors.sort((a, b) => { const ra = rankOf(a.token), rb = rankOf(b.token); return ra === rb ? 0 : ra - rb; });
    // Render — the first 9 buttons in the row get hotkeys 1..9 (position = key).
    descriptors.forEach((d, i) => wrap.appendChild(d.make(i < 9 ? i + 1 : null)));
    if (!wrap.children.length) hintEl(obs.enabled ? (connected ? 'No scenes mapped — use Customize' : 'OBS not connected') : 'OBS off. Turn it on under Apps > Streaming software');
    if (typeof bbUpdateExpandToggle === 'function') requestAnimationFrame(bbUpdateExpandToggle);
  }
  // Highlight the SCENE button matching the live program scene (per tick, no rebuild).
  if (wrap) {
    const live = connected ? (obs.currentScene || '') : '';
    wrap.querySelectorAll('.qt-scene-btn[data-scene]').forEach((b) => {
      b.classList.toggle('live', !!live && b.dataset.scene === live);
    });
  }
  // Clip button status dot: green = replay buffer + twitch both active; orange = one; red = neither.
  (function updateClipBtnDot() {
    const btn = el('btn-bb-clip'); if (!btn) return;
    const bufActive = !!(data.obs && data.obs.replayBufferActive);
    const twitchOn = !!(data.twitch && data.twitch.connected);
    const cls = bufActive && twitchOn ? 'green' : bufActive || twitchOn ? 'orange' : 'red';
    let dot = btn.querySelector('.bb-clip-dot');
    if (!dot) { dot = document.createElement('span'); dot.className = 'bb-clip-dot'; btn.insertBefore(dot, btn.firstChild); }
    dot.dataset.status = cls;
    // OBS connected but buffer off -> nothing to clip; the button's real job is
    // starting the buffer. Label + click mode follow (see the click handler).
    const wantStart = !!(data.obs && data.obs.connected) && !bufActive;
    if (!btn.disabled) {
      btn.dataset.mode = wantStart ? 'startbuf' : 'clip';
      const lbl = btn.querySelector('.bb-clip-lbl');
      const offInObs = rbOffInObs(data.obs);
      if (lbl) lbl.textContent = offInObs ? 'Replay Buffer off in OBS' : wantStart ? 'Start Replay Buffer' : 'Clip';
      btn.title = offInObs ? RB_OFF_HINT
        : wantStart ? 'OBS replay buffer is OFF — click to start it so clips can capture'
        : 'Save OBS replay buffer + create Twitch clip (channel must be live for Twitch clip)';
    }
  })();
}
// Drag ANY bar button (scene / overlay / trigger) to a new spot. Because position = hotkey,
// reordering IS rebinding — the saved bar order persists the full token order.
(function wireBbSceneDrag() {
  const wrap = el('qt-obs-scenes'); if (!wrap) return;
  let dragSrc = null;
  const tokenOf = (e) => { const b = e.target.closest('[data-bbtoken]'); return b ? b.dataset.bbtoken : null; };
  wrap.addEventListener('dragstart', (e) => {
    const btn = e.target.closest('[data-bbtoken]'); if (!btn) return;
    dragSrc = btn.dataset.bbtoken;
    e.dataTransfer.effectAllowed = 'move';
    btn.classList.add('qt-drag-src');
  });
  wrap.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    const tok = tokenOf(e); if (!tok || tok === dragSrc) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    wrap.querySelectorAll('.qt-drag-over').forEach((b) => b.classList.remove('qt-drag-over'));
    e.target.closest('[data-bbtoken]').classList.add('qt-drag-over');
  });
  wrap.addEventListener('dragleave', (e) => {
    const btn = e.target.closest('[data-bbtoken]'); if (btn) btn.classList.remove('qt-drag-over');
  });
  wrap.addEventListener('drop', (e) => {
    if (!dragSrc) return;
    const tgt = tokenOf(e);
    if (!tgt || tgt === dragSrc) { dragSrc = null; return; }
    e.preventDefault();
    // Persist the FULL visible token order with the dragged item moved before the target.
    const tokens = [...wrap.querySelectorAll('[data-bbtoken]')].map((b) => b.dataset.bbtoken);
    const from = tokens.indexOf(dragSrc), to = tokens.indexOf(tgt);
    if (from >= 0 && to >= 0) { const [item] = tokens.splice(from, 1); tokens.splice(to, 0, item); bbSetOrder(tokens); _qtSceneSig = ''; renderQuickToolbar(currentState); }
    dragSrc = null;
  });
  wrap.addEventListener('dragend', () => {
    dragSrc = null;
    wrap.querySelectorAll('.qt-drag-src, .qt-drag-over').forEach((b) => b.classList.remove('qt-drag-src', 'qt-drag-over'));
  });
})();
// Expandable second row: collapsed clips the bar to one row; the chevron reveals the rest.
// The chevron only appears when the buttons actually overflow onto a second row.
// Show Deck option pills: lit while their switch is on, and the whole pill toggles it
// (styles.css used .td-opt:has(input:checked), which Electron 18 does not support).
function tdOptSync() { document.querySelectorAll('.td-opt').forEach((o) => { const i = o.querySelector('input[type="checkbox"]'); o.classList.toggle('is-on', !!(i && i.checked)); }); }
document.addEventListener('change', (e) => { if (e.target && e.target.closest && e.target.closest('.td-opt')) tdOptSync(); });
document.addEventListener('click', (e) => {
  const o = e.target && e.target.closest && e.target.closest('.td-opt');
  if (!o || e.target.closest('label, input')) return;
  const i = o.querySelector('input[type="checkbox"]'); if (!i) return;
  i.checked = !i.checked; i.dispatchEvent(new Event('change', { bubbles: true }));
});
setTimeout(tdOptSync, 0);
function bbUpdateExpandToggle() {
  const bar = el('bottom-bar'), wrap = el('qt-obs-scenes'), tog = el('bb-expand-toggle');
  if (!bar || !wrap || !tog) return;
  bar.classList.toggle('bb-expanded', bbExpanded());
  // Measure overflow against a single collapsed row (temporarily force-collapse to read it).
  const wasExpanded = bar.classList.contains('bb-expanded');
  bar.classList.remove('bb-expanded');
  const overflowing = wrap.scrollHeight > wrap.clientHeight + 3;
  if (wasExpanded) bar.classList.add('bb-expanded');
  // The page pads its bottom by this class (Electron 18 has no :has() for body:has(.bb-expanded)).
  document.body.classList.toggle('bb-is-expanded', wasExpanded);
  tog.style.display = overflowing ? '' : 'none';
  tog.classList.toggle('is-open', wasExpanded && overflowing);
  const rows = overflowing && !wasExpanded ? ' — more below' : '';
  tog.title = (wasExpanded ? 'Collapse the transport bar' : 'Show the rest of the bar') + rows;
}
el('bb-expand-toggle')?.addEventListener('click', () => {
  bbSetExpanded(!bbExpanded());
  bbUpdateExpandToggle();
});
window.addEventListener('resize', () => { if (typeof bbUpdateExpandToggle === 'function') bbUpdateExpandToggle(); });
el('qt-view-scoreboard')?.addEventListener('click', () => send('force_scoreboard'));
el('qt-view-hud')?.addEventListener('click', () => send('force_hud'));
el('qt-autoswitch')?.addEventListener('change', function () {
  const cb = el('check-obs-autoswitch'); if (cb) cb.checked = this.checked;
  send('set_obs_autoswitch', { autoSwitch: this.checked });
});

// ── Right rail: live OBS scene list (auto-detected from the connected profile) ──
// Lists EVERY scene in the active OBS scene collection as a one-click program cut,
// auto-updating whenever you add/rename/swap scenes or collections in OBS itself.
let _qrailSceneSig = '';
// ── Program list order + visibility — PANEL ONLY, never touches OBS ────────────
// Producers cut in show order, which is rarely the order scenes happen to sit in the OBS
// collection; and a real collection carries staging/nested scenes that never go on air.
// Both the custom order and the hidden set live in localStorage, so re-sorting the rail
// leaves the OBS scene collection exactly as it is.
const PROG_ORDER_KEY = 'ne_prog_order_v1';
const PROG_HIDE_KEY = 'ne_prog_hidden_v1';
function progLoadArr(key) { try { const a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
let _progOrder = progLoadArr(PROG_ORDER_KEY);
let _progHidden = new Set(progLoadArr(PROG_HIDE_KEY));
let _progEdit = false;
function progSave() {
  try {
    localStorage.setItem(PROG_ORDER_KEY, JSON.stringify(_progOrder));
    localStorage.setItem(PROG_HIDE_KEY, JSON.stringify(Array.from(_progHidden)));
  } catch (_) {}
}
function progSetEdit(on) {
  _progEdit = !!on;
  const link = el('qprog-reorder');
  if (link) { link.textContent = _progEdit ? 'done' : 'reorder'; link.classList.toggle('active', _progEdit); }
  _qrailSceneSig = '';                       // force a rebuild — edit mode changes every row
  renderQrailScenes(currentState || {});
}
el('qprog-reorder')?.addEventListener('click', (e) => { e.preventDefault(); progSetEdit(!_progEdit); });
function renderQrailScenes(data) {
  const wrap = el('qrail-scenes'); if (!wrap) return;
  const sub = el('qrail-scenes-sub');

  // vMix backend — the Program grid is the vMix input list; cutting sends the input number
  // (routed through the switcher server-side). Overlay toggles above stay backend-agnostic.
  if ((data.switcher && data.switcher.target) === 'vmix') {
    const v = data.vmix || {};
    const inputs = Array.isArray(v.inputs) ? v.inputs : [];
    if (sub) sub.textContent = v.connected ? String(inputs.length) : '';
    const sig = JSON.stringify({ vmix: 1, c: v.connected, en: v.enabled, n: inputs.map((i) => i.number + ':' + i.title) });
    if (sig !== _qrailSceneSig) {
      _qrailSceneSig = sig;
      wrap.innerHTML = '';
      const hint = (t) => { const h = document.createElement('div'); h.className = 'qrail-scenes-hint'; h.textContent = t; wrap.appendChild(h); };
      if (!v.enabled) hint('vMix off — enable in Settings → vMix');
      else if (!v.connected) hint('Connecting to vMix… inputs appear here automatically');
      else if (!inputs.length) hint('No inputs found in vMix');
      else inputs.forEach((inp) => {
        const b = document.createElement('button');
        b.className = 'qrail-scene-btn';
        b.dataset.vnum = String(inp.number);
        b.innerHTML = '<span class="qt-key qt-key-blank"></span><span class="qss-name"></span>';
        b.querySelector('.qss-name').textContent = inp.title || ('Input ' + inp.number);
        b.title = `Cut program to "${inp.title || inp.number}"`;
        b.addEventListener('click', () => send('obs_switch_scene', { sceneName: String(inp.number) }));
        wrap.appendChild(b);
      });
    }
    const active = v.connected && v.active != null ? String(v.active) : '';
    wrap.querySelectorAll('.qrail-scene-btn').forEach((b) => b.classList.toggle('live', !!active && b.dataset.vnum === active));
    return;
  }

  // OBS backend
  const obs = data.obs || {};
  const list = Array.isArray(obs.availableScenes) ? obs.availableScenes : [];
  const connected = !!obs.connected;
  const enabled = !!obs.enabled;
  const live = connected ? (obs.currentScene || '') : '';
  // Moment mapping by scene name: the hotkey number (1..9) and the moment's producer-facing
  // name, so a scene called "IG_final_v3" still reads as "In-Game" on the rail.
  const momentByScene = {};
  SCENE_CONTROL_MOMENTS.forEach((m, i) => {
    const sn = (obs.scenes || {})[m.key];
    if (sn && !momentByScene[sn]) momentByScene[sn] = { label: m.label, hk: i + 1 };
  });
  // Header sub shows WHAT'S ON PROGRAM — far more useful mid-show than a scene count.
  if (sub) { sub.textContent = connected ? (live || String(list.length)) : ''; sub.classList.toggle('live', !!live); }
  const reorderLink = el('qprog-reorder');
  if (reorderLink) reorderLink.style.display = (enabled && connected && list.length) ? '' : 'none';

  // Reconcile the saved order against the live scene list: keep the producer's order for scenes
  // that still exist, append anything new. New scenes sort mapped moments first (their hotkey
  // order), then whatever order OBS reports — the same default the old two-group rail had.
  const known = _progOrder.filter((n) => list.includes(n));
  const fresh = list.filter((n) => !known.includes(n))
    .sort((a, b) => ((momentByScene[a] ? momentByScene[a].hk : 99) - (momentByScene[b] ? momentByScene[b].hk : 99)));
  const ordered = known.concat(fresh);
  if (ordered.length !== _progOrder.length || ordered.some((n, i) => _progOrder[i] !== n)) { _progOrder = ordered; progSave(); }
  const hiddenCount = ordered.filter((n) => _progHidden.has(n)).length;
  // Hidden scenes stay visible (dimmed) while reordering so they can be brought back.
  const shown = _progEdit ? ordered : ordered.filter((n) => !_progHidden.has(n));

  const sig = JSON.stringify({ shown, connected, enabled, edit: _progEdit, hid: Array.from(_progHidden), m: momentByScene, n: list.length });
  if (sig !== _qrailSceneSig) {
    _qrailSceneSig = sig;
    wrap.innerHTML = '';
    wrap.classList.toggle('qrail-scenes-editing', _progEdit);
    const hint = (t) => { const h = document.createElement('div'); h.className = 'qrail-scenes-hint'; h.textContent = t; wrap.appendChild(h); };
    if (!enabled) hint('OBS off. Turn it on under Apps > Streaming software');
    else if (!connected) hint('Connecting to OBS… scenes appear here automatically');
    else if (!list.length) hint('No scenes found in this OBS profile');
    else {
      if (_progEdit) hint('Drag to set your show order; the eye hides a scene from this rail. OBS is not changed.');
      // Same chip language as the Put On Air rail above (.qk-chip): 2-up grid, dot + label, green
      // when it's the one on program. Scene chips carry their hotkey number instead of the gear.
      const grid = document.createElement('div');
      grid.className = 'qk-put qps-grid' + (_progEdit ? ' qps-editing' : '');
      shown.forEach((name) => {
        const mo = momentByScene[name];
        const isHidden = _progHidden.has(name);
        const chip = document.createElement('div');
        chip.className = 'qk-chip qk-chip--scene qps-chip' + (isHidden ? ' qps-hidden' : '');
        chip.dataset.scene = name;
        if (_progEdit) chip.draggable = true;

        const b = document.createElement('button');
        b.className = 'qk-chip-main';
        b.textContent = mo ? mo.label : name;
        b.title = mo ? `Cut program to "${name}"  ·  ${mo.label} moment · hotkey ${mo.hk}` : `Cut program to "${name}"`;
        b.addEventListener('click', () => { if (!_progEdit) send('obs_switch_scene', { sceneName: name }); });
        chip.appendChild(b);

        // Hotkey key-cap (mapped moments only) sits where the SCN tag would — one per chip.
        if (mo) {
          const k = document.createElement('kbd');
          k.className = 'qps-hk';
          k.textContent = String(mo.hk);
          chip.appendChild(k);
        } else {
          chip.classList.add('qps-nohk');
        }

        if (_progEdit) {
          const eye = document.createElement('button');
          eye.className = 'qk-chip-gear qps-eye';
          eye.title = isHidden ? 'Show this scene on the rail' : 'Hide this scene from the rail (stays in OBS)';
          eye.innerHTML = isHidden
            ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/></svg>'
            : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
          eye.addEventListener('click', (e) => {
            e.stopPropagation();
            if (_progHidden.has(name)) _progHidden.delete(name); else _progHidden.add(name);
            progSave(); _qrailSceneSig = ''; renderQrailScenes(currentState || {});
          });
          chip.appendChild(eye);
        }
        grid.appendChild(chip);
      });
      wrap.appendChild(grid);
      if (!_progEdit && hiddenCount) {
        const f = document.createElement('div');
        f.className = 'qrail-scenes-hint qps-hiddenfoot';
        f.innerHTML = `${hiddenCount} scene${hiddenCount > 1 ? 's' : ''} hidden · <a href="#">show</a>`;
        f.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); progSetEdit(true); });
        wrap.appendChild(f);
      }
    }
  }
  // Highlight the live program scene every tick (no rebuild) — same green .on as the chips above.
  wrap.querySelectorAll('.qps-chip').forEach((c) => c.classList.toggle('on', !!live && c.dataset.scene === live));
}
// Drag-to-reorder the Program rail (edit mode only) — order is panel-local, OBS untouched.
(function wireProgDrag() {
  const wrap = el('qrail-scenes'); if (!wrap) return;
  let dragName = null;
  wrap.addEventListener('dragstart', (e) => {
    const r = e.target.closest('.qps-chip');
    if (!r || !_progEdit) { e.preventDefault(); return; }
    dragName = r.dataset.scene; r.classList.add('qps-drag');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragName); } catch (_) {}
  });
  wrap.addEventListener('dragend', () => {
    wrap.querySelectorAll('.qps-drag, .qps-over').forEach((n) => n.classList.remove('qps-drag', 'qps-over'));
    dragName = null;
  });
  wrap.addEventListener('dragover', (e) => {
    if (!_progEdit || !dragName) return;
    e.preventDefault();
    const r = e.target.closest('.qps-chip');
    wrap.querySelectorAll('.qps-over').forEach((n) => { if (n !== r) n.classList.remove('qps-over'); });
    if (r && r.dataset.scene !== dragName) r.classList.add('qps-over');
  });
  wrap.addEventListener('drop', (e) => {
    if (!_progEdit || !dragName) return;
    e.preventDefault();
    const tgt = e.target.closest('.qps-chip'); if (!tgt) return;
    const from = _progOrder.indexOf(dragName), to = _progOrder.indexOf(tgt.dataset.scene);
    if (from < 0 || to < 0 || from === to) return;
    const [m] = _progOrder.splice(from, 1); _progOrder.splice(to, 0, m);
    progSave(); _qrailSceneSig = ''; renderQrailScenes(currentState || {});
  });
})();

// ── Quick panel cockpit: Now/Next + "Put On Air" chips (reuse the golive toggles + config gear) ──
// trig entries drive the existing GOLIVE_TRIGGERS toggle buttons + trigger-config popover; ov
// entries are plain overlay show/hide via bbActionInfo. cfg=true means a gear opens its options.
// gfx: <key> = a real gfx.html layer (LAYER_MAP in overlay/gfx.html) — pushing/clearing it MUST
// go through window._gfxDoPush / set_gfx_active so gfx.html's layer-switcher actually shows it.
// Bracket and Standings used to be wired as plain `ov` (direct visibility-flag) chips, same as
// Ticker/Sponsor/Desk below — but unlike those three, gfx.html owns bracket/standings as
// mutually-exclusive layers, so toggling only their own .visible flag left the outer gfx-layer
// never marked .active: the state changed but nothing ever appeared on gfx.html. Ticker/Sponsor/
// Desk are correctly NOT gfx.html layers (they're meant to be persistent, independently-added
// sources, not part of the exclusive scene-switcher), so they stay on the direct `ov` path.
const QK_PUT = [
  { label: 'Break',     trig: 'breakScreen', toggle: 'ck-break-toggle',     scene: 'break',    cfg: true },
  { label: 'Matchup',   trig: 'matchup',     toggle: 'ck-matchup-toggle',   scene: 'matchup' },
  { label: 'Winner',    trig: 'winner',      toggle: 'ck-winner-toggle',    scene: 'winner',   cfg: true, sideSel: 'ck-winner-side' },
  { label: 'Line-up',   trig: 'intro',       toggle: 'ck-intro-toggle',     scene: 'intro',    cfg: true, sideSel: 'ck-intro-side' },
  { label: 'Map Pool',  trig: 'veto',        toggle: 'ck-veto-toggle',      scene: 'veto' },
  { label: 'Teams',     trig: 'watchlist',   toggle: 'ck-spotlight-toggle', scene: 'spotlight' },
  { label: 'Schedule',  trig: 'upcoming',    toggle: 'ck-schedule-toggle',  scene: 'schedule' },
  { label: 'Bracket',   gfx: 'bracket' },
  { label: 'Standings', gfx: 'standings' },
  { label: 'Credits',   gfx: 'credits' },
  { label: 'Ticker',    ov: 'ticker' },
  { label: 'Sponsor',   ov: 'banner' },
  { label: 'Desk',      ov: 'casters' },
];
function _qkIsLive(item) {
  const s = currentState || {};
  if (item.gfx) return s.gfxActive === item.gfx;
  if (item.ov) { const info = bbActionInfo({ t: 'overlay', k: item.ov }); return !!(info && info.live); }
  return (s.gfxActive === item.scene) || !!(s[item.trig] && s[item.trig].visible);
}
// Push/clear a gfx.html-layer chip — mirrors doPush()'s "clear previous, push this, set
// gfxActive" sequence (app.js ~1952) using the same SCENE_META push/clear button ids, so this
// chip and the real Graphics ▸ Push Live button for the same scene can never fight.
function _qkGfxToggle(key) {
  const live = currentState && currentState.gfxActive === key;
  if (live) {
    gfxHide(key);
    send('set_gfx_active', { scene: null });
    if (currentState) currentState.gfxActive = null;
    if (typeof window._gfxRefreshTopBar === 'function') window._gfxRefreshTopBar();
  } else if (typeof window._gfxDoPush === 'function') {
    window._gfxDoPush(key);
  }
}
// Stable id per QK_PUT entry (gfx/ov/trig key — whichever it has) so drag order survives even
// if the array itself is edited later.
function qkItemKey(item) { return item.gfx || item.ov || item.trig; }
// Just the QK_PUT graphic chips — no longer merged with OBS scenes. Scenes used to be appended
// here too (deduped by name against the graphic labels), but the separate "Program" group below
// already lists every OBS scene on its own — the merge meant nearly every scene rendered as a
// clickable button in BOTH groups at once (producer feedback: the rail reads as "overwhelming,
// too many buttons"). Put On Air is now purely the fixed graphics catalog; Program is the one
// place for scene cuts.
function _qkCat(item) {
  if (item.gfx) return 'layer';
  if (item.ov) return 'overlay';
  return 'moment';
}
const QK_CAT_LABEL = { moment: 'Match graphics', layer: 'Boards', overlay: 'Overlays' };
function qkAllItems() {
  return QK_PUT.map((item) => ({ id: 'qk:' + qkItemKey(item), t: 'qk', item, label: item.label, cat: _qkCat(item) }));
}
// Custom chip order — reorderable via the "reorder" link, persisted the same way as the on-air
// board and Deck grid.
const QK_ORDER_KEY = 'ne_qk_order_v1';
function qkLoadOrder() { try { return JSON.parse(localStorage.getItem(QK_ORDER_KEY) || '[]'); } catch (_) { return []; } }
function qkSaveOrder() { try { localStorage.setItem(QK_ORDER_KEY, JSON.stringify(_qkOrder)); } catch (_) {} }
let _qkOrder = qkLoadOrder();
let _qkEdit = false;
function qkRenderPut() {
  const wrap = el('qk-put'); if (!wrap) return;
  const items = qkAllItems();
  const byId = {}; items.forEach((it) => { byId[it.id] = it; });
  // Reconcile saved order against the live item set — keep known order, append anything new (an
  // OBS scene just created) at the end. Self-healing since the OBS scene list can change anytime.
  const known = _qkOrder.filter((id) => byId[id]);
  const extraIds = items.map((it) => it.id).filter((id) => !known.includes(id));
  const orderedIds = known.concat(extraIds);
  if (extraIds.length || orderedIds.length !== _qkOrder.length) { _qkOrder = orderedIds; qkSaveOrder(); }
  const ordered = orderedIds.map((id) => byId[id]).filter(Boolean);
  wrap.classList.toggle('qk-put-editing', _qkEdit);
  const sig = ordered.map((it) => it.id).join(',') + '|' + _qkEdit;
  if (wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    // Category headers (Match graphics / Boards / Overlays) break up the flat chip wall — inserted
    // wherever the category changes as chips are walked in their current (possibly custom-dragged)
    // order, so producer reordering never leaves a header pointing at the wrong run of chips. Headers
    // aren't chips (no data-id), so the drag/drop code below — which only ever targets `.qk-chip` —
    // treats them as inert: they can't be dragged and dropping onto one is a no-op.
    let lastCat = null;
    wrap.innerHTML = ordered.map((it) => {
      let header = '';
      if (it.cat !== lastCat) {
        header = `<div class="qk-put-cat">${dEsc(QK_CAT_LABEL[it.cat] || it.cat)}</div>`;
        lastCat = it.cat;
      }
      if (it.t === 'scene') {
        return header + `<div class="qk-chip qk-chip--scene" data-id="${dEsc(it.id)}"${_qkEdit ? ' draggable="true"' : ''}><button class="qk-chip-main" title="Cut to ${dEsc(it.label)}">${dEsc(it.label)}</button></div>`;
      }
      const item = it.item;
      return header + `<div class="qk-chip" data-id="${dEsc(it.id)}"${_qkEdit ? ' draggable="true"' : ''}>`
        + `<button class="qk-chip-main" title="Put ${dEsc(item.label)} on air">${dEsc(item.label)}</button>`
        + (item.cfg ? `<button class="qk-chip-gear" title="${dEsc(item.label)} options"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>` : '')
        + `</div>`;
    }).join('');
    Array.from(wrap.children).forEach((chip) => {
      const it = byId[chip.dataset.id]; if (!it) return;
      chip.querySelector('.qk-chip-main')?.addEventListener('click', () => {
        if (_qkEdit) return;
        if (it.t === 'scene') {
          send('obs_switch_scene', { sceneName: it.k });
          if (currentState && currentState.obs) currentState.obs.currentScene = it.k;   // optimistic
          qkRenderPut();
          return;
        }
        const item = it.item;
        if (item.gfx) { _qkGfxToggle(item.gfx); return; }
        if (item.ov) { const info = bbActionInfo({ t: 'overlay', k: item.ov }); if (info) info.run(); return; }
        // trigger: if it has options and isn't live yet, open the config gear to set them first
        // Team graphics (Winner, Line-up) have their side chosen by the Team-graphics bar, so a click
        // FIRES them for that team directly. Only config-only chips (Break: title/timer) open the gear
        // first; the per-chip gear button still overrides a team pill's side.
        if (item.cfg && !item.sideSel && !_qkIsLive(item) && typeof bbOpenTriggerConfig === 'function') { bbOpenTriggerConfig(item.trig, chip); return; }
        el(item.toggle)?.click();
      });
      const gear = chip.querySelector('.qk-chip-gear');
      if (gear) gear.addEventListener('click', (e) => { e.stopPropagation(); if (typeof bbOpenTriggerConfig === 'function') bbOpenTriggerConfig(it.item.trig, chip); });
    });
  }
  Array.from(wrap.children).forEach((chip) => {
    const it = byId[chip.dataset.id]; if (!it) return;
    const on = it.t === 'scene'
      ? !!(currentState && currentState.obs && currentState.obs.currentScene === it.k)
      : _qkIsLive(it.item);
    chip.classList.toggle('on', on);
    // Team-dependent chips (Line-up, Winner) get a team-colored dot mirroring the target set in the
    // Team-graphics bar above — the full name lives there, so the chip only needs a colour cue.
    if (it.item && it.item.sideSel) {
      const side = (el(it.item.sideSel)?.value === 'orange') ? 'orange' : 'blue';
      const t = (currentState && currentState.teams && currentState.teams[side]) || {};
      const color = t.color || (side === 'blue' ? '#3b82f6' : '#e97139');
      let badge = chip.querySelector('.qk-chip-team');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'qk-chip-team';
        chip.appendChild(badge);
      }
      badge.title = (t.name || (side === 'blue' ? 'Blue' : 'Orange')) + ' — set the team in the bar above';
      badge.style.background = color;
    }
  });
  qkRenderTeamTarget();
}
// ── Team-graphics target bar (drives Winner + Line-up side at once) ─────────────
const QK_TEAM_MSG = { winner: 'set_winner', intro: 'set_intro' };
function qkRenderTeamTarget() {
  const bar = el('qk-teamtarget'); if (!bar) return;
  const teams = (currentState && currentState.teams) || {};
  // The Winner side auto-points at the series leader (same as the Graphics ▸ Winner card) until the
  // producer picks a team by hand; re-armed on a fresh match. This only steers the Winner graphic —
  // the Line-up side is unaffected.
  const series = (currentState && currentState.series) || {};
  if (((Number(series.blue) || 0) + (Number(series.orange) || 0)) === 0) window._qkWinnerAuto = true;
  const lead = ((window._qkWinnerAuto !== false) && window._winnerLeadingSide) ? window._winnerLeadingSide(currentState) : '';
  // Write the leader into ck-winner-side so EVERY winner UI reflects the champion — the chip, the
  // gear popover's Team field (cloned from this select), and any re-fire — instead of prompting.
  if (lead) { const ws = el('ck-winner-side'); if (ws && ws.value !== lead) ws.value = lead; }
  const cur = lead || ((el('ck-winner-side') && el('ck-winner-side').value === 'orange') ? 'orange' : 'blue');
  ['blue', 'orange'].forEach((side) => {
    const btn = bar.querySelector(`[data-ttside="${side}"]`); if (!btn) return;
    const t = teams[side] || {};
    const color = t.color || (side === 'blue' ? '#3b82f6' : '#e97139');
    const name = (t.name || (side === 'blue' ? 'Blue' : 'Orange')).toString();
    const nameEl = btn.querySelector('.qk-tt-name'); if (nameEl && nameEl.textContent !== name) nameEl.textContent = name;
    // Team logo when we have one (falls back to the colour dot otherwise) so producers recognize the
    // team at a glance instead of reading a truncated name in the narrow rail.
    const logo = btn.querySelector('.qk-tt-logo'), dot = btn.querySelector('.qk-tt-dot');
    const src = t.logo || '';
    if (logo) { if (src) { if (logo.getAttribute('src') !== src) logo.src = src; logo.style.display = ''; } else { logo.style.display = 'none'; logo.removeAttribute('src'); } }
    if (dot) { dot.style.background = color; dot.style.display = src ? 'none' : ''; }
    btn.style.setProperty('--tt-color', color);
    btn.classList.toggle('active', side === cur);
  });
}
// Set which side the team graphics fill; re-fire any that are already live so on-air updates instantly.
function qkSetTeamTarget(side) {
  side = side === 'orange' ? 'orange' : 'blue';
  window._qkWinnerAuto = false;   // explicit producer pick — stop auto-pointing the Winner at the series leader
  ['ck-winner-side', 'ck-intro-side'].forEach((id) => { const s = el(id); if (s) s.value = side; });
  QK_PUT.filter((it) => it.sideSel).forEach((it) => {
    if (_qkIsLive(it) && QK_TEAM_MSG[it.trig]) send(QK_TEAM_MSG[it.trig], { visible: true, side });
  });
  qkRenderTeamTarget();
  qkRenderPut();
}
el('qk-teamtarget')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ttside]'); if (!btn) return;
  qkSetTeamTarget(btn.dataset.ttside);
});
el('qk-put-reorder')?.addEventListener('click', (e) => {
  e.preventDefault();
  _qkEdit = !_qkEdit;
  e.currentTarget.classList.toggle('active', _qkEdit);
  e.currentTarget.textContent = _qkEdit ? 'done' : 'reorder';
  qkRenderPut();
});
(function wireQkPutDrag() {
  const wrap = el('qk-put'); if (!wrap) return;
  let dragId = null;
  wrap.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.qk-chip'); if (!t || !_qkEdit) { e.preventDefault(); return; }
    dragId = t.dataset.id; t.classList.add('qk-chip-drag');
  });
  wrap.addEventListener('dragend', (e) => { const t = e.target.closest('.qk-chip'); if (t) t.classList.remove('qk-chip-drag'); dragId = null; });
  wrap.addEventListener('dragover', (e) => { if (_qkEdit) e.preventDefault(); });
  wrap.addEventListener('drop', (e) => {
    if (!_qkEdit || !dragId) return; e.preventDefault();
    const tgt = e.target.closest('.qk-chip'); if (!tgt) return;
    const from = _qkOrder.indexOf(dragId), to = _qkOrder.indexOf(tgt.dataset.id);
    if (from < 0 || to < 0 || from === to) return;
    const [m] = _qkOrder.splice(from, 1); _qkOrder.splice(to, 0, m);
    qkSaveOrder(); qkRenderPut();
  });
})();
function renderQuickPanel(data) {
  data = data || {};
  const obs = data.obs || {};
  // NOW = live program scene (OBS) or program input (vMix), whichever backend is active
  const nowEl = el('qk-now');
  if (nowEl) {
    if ((data.switcher && data.switcher.target) === 'vmix') {
      const v = data.vmix || {};
      const act = (v.inputs || []).find((i) => i.number === v.active);
      nowEl.textContent = (v.connected && v.active != null) ? (act ? (act.title || ('Input ' + v.active)) : ('Input ' + v.active)) : '—';
    } else {
      nowEl.textContent = (obs.connected && obs.currentScene) ? obs.currentScene : '—';
    }
  }
  // The live graphic punched up on stream (shown next to the OBS scene) — "what's on stream" is
  // the scene PLUS whatever graphic is live over it.
  const gfxEl = el('qk-now-gfx');
  if (gfxEl) {
    const g = (data.gfxActive && typeof data.gfxActive === 'string') ? data.gfxActive : '';
    const nice = g ? (({ break: 'Break', winner: 'Winner', intro: 'Line-up', matchup: 'Matchup', veto: 'Map Pool', bracket: 'Bracket', standings: 'Standings', schedule: 'Schedule', spotlight: 'Spotlight', credits: 'Credits' })[g] || g) : '';
    if (nice) { gfxEl.textContent = nice; gfxEl.style.display = ''; } else { gfxEl.style.display = 'none'; }
  }
  // Run of Show cockpit — the production phase controller: what phase we're on, next, and back.
  const S = (typeof rdSummary === 'function') ? rdSummary() : null;
  const posEl = el('qk-ros-pos'), curEl = el('qk-ros-cur-lbl');
  const backBtn = el('qk-ros-back'), goBtn = el('qk-ros-fwd');
  // The up-next row: tag + segment + what follows it + how it advances. Hidden outright when
  // there is nothing coming, rather than left showing a stale phase.
  const nextRow = el('qk-ros-next');
  const showNext = (tag, label, then, first) => {
    if (!nextRow) return;
    if (!label) { nextRow.style.display = 'none'; return; }
    nextRow.style.display = '';
    nextRow.classList.toggle('is-first', !!first);
    const t = el('qk-ros-next-tag'), l = el('qk-ros-next-lbl'),
          th = el('qk-ros-next-then'), m = el('qk-ros-next-meta');
    if (t) t.textContent = tag;
    if (l) { l.textContent = label; l.title = label; }
    if (th) { th.textContent = then ? 'then ' + then : ''; th.style.display = then ? '' : 'none'; }
    if (m) {
      // A 600s hold is a ten-minute countdown; printing the raw seconds makes the producer
      // do the arithmetic mid-show.
      const hold = S.nextHold >= 120 ? Math.round(S.nextHold / 60) + 'm' : S.nextHold + 's';
      const bits = [S.nextKind, S.nextHold ? 'auto ' + hold : ''].filter(Boolean);
      m.textContent = bits.join(' · ');
      m.style.display = bits.length ? '' : 'none';
      m.title = S.nextHold ? 'Advances itself after ' + S.nextHold + 's' : 'Waits for Go';
    }
  };
  if (S) {
    if (!S.hasSegs) {
      if (posEl) posEl.textContent = '';
      if (curEl) curEl.textContent = 'No rundown built';
      showNext('', '', '', false);
      if (backBtn) backBtn.disabled = true;
      if (goBtn) { goBtn.textContent = 'Build'; goBtn.dataset.mode = 'build'; goBtn.classList.remove('is-run'); }
    } else if (!S.running) {
      if (posEl) posEl.textContent = `0 / ${S.total}`;
      if (curEl) curEl.textContent = 'Ready to start';
      showNext('FIRST', S.next, S.next2, true);
      if (backBtn) backBtn.disabled = true;
      if (goBtn) { goBtn.textContent = 'Start'; goBtn.dataset.mode = 'run'; goBtn.classList.add('is-run'); }
    } else {
      if (posEl) posEl.textContent = `${S.pos} / ${S.total}`;
      if (curEl) curEl.textContent = S.current || 'Segment';
      if (S.atEnd) showNext('END', 'Last phase — Finish to end the show', '', false);
      else         showNext('NEXT', S.next, S.next2, false);
      if (backBtn) backBtn.disabled = !S.hasPrev;
      if (goBtn) { goBtn.textContent = S.atEnd ? 'Finish' : 'Go'; goBtn.dataset.mode = 'run'; goBtn.classList.add('is-run'); }
    }
  }
  // Put-on-air chips (graphics + every real OBS scene, deduped, drag-reorderable) — see qkRenderPut.
  qkRenderPut();
}
// Rundown phase summary for the cockpit (current/next/prev labels + position) — mirrors the
// section-skipping logic in rdPublishStatus so external Stream-Deck keys and this panel agree.
function rdSummary() {
  const segs = (typeof _rdSegs !== 'undefined' && Array.isArray(_rdSegs)) ? _rdSegs : [];
  const running = (typeof _rdRunning !== 'undefined') && _rdRunning;
  const idx = (typeof _rdIdx !== 'undefined') ? _rdIdx : -1;
  const lbl = (i) => (i >= 0 && i < segs.length && segs[i]) ? (segs[i].label || (typeof rdTargetLabel === 'function' ? rdTargetLabel(segs[i]) : '') || 'Segment') : '';
  const fwd = (from) => { let i = from; while (i < segs.length && segs[i] && segs[i].type === 'section') i++; return i < segs.length ? i : -1; };
  const back = (from) => { let i = from; while (i >= 0 && segs[i] && segs[i].type === 'section') i--; return i; };
  const real = (upTo) => segs.slice(0, upTo).filter((s) => s && s.type !== 'section').length;
  const nextIdx = running ? fwd(idx + 1) : fwd(0);
  const prevIdx = running ? back(idx - 1) : -1;
  // The one after next. A 54-segment rundown is unreadable if the cockpit only ever admits to one
  // step ahead — knowing what follows is how a producer decides whether they have time to talk.
  const next2Idx = nextIdx >= 0 ? fwd(nextIdx + 1) : -1;
  const nextSeg = nextIdx >= 0 ? segs[nextIdx] : null;
  return {
    hasSegs: segs.length > 0, running,
    pos: running ? real(idx + 1) : 0, total: real(segs.length),
    current: running ? lbl(idx) : '', next: nextIdx >= 0 ? lbl(nextIdx) : '', prev: prevIdx >= 0 ? lbl(prevIdx) : '',
    next2: next2Idx >= 0 ? lbl(next2Idx) : '',
    // What KIND the next segment is, and whether it drives itself. "auto 30s" vs nothing is the
    // difference between a producer watching for a cue and one waiting to press Go.
    nextKind: nextSeg ? ((typeof RD_TYPE_LABEL !== 'undefined' && RD_TYPE_LABEL[nextSeg.type]) || '') : '',
    nextHold: nextSeg ? (Number(nextSeg.hold) || 0) : 0,
    hasPrev: prevIdx >= 0, atEnd: running && nextIdx < 0,
  };
}
// Cockpit run-of-show controls.
el('qk-ros-back')?.addEventListener('click', () => { if (typeof rdPrev === 'function') rdPrev(); renderQuickPanel(currentState); });
el('qk-ros-fwd')?.addEventListener('click', () => {
  const btn = el('qk-ros-fwd');
  if (btn && btn.dataset.mode === 'build') { document.querySelector('.qrail-tab[data-qtab="ros"]')?.click(); return; }
  if (typeof rdNext === 'function') rdNext();   // Start from idle, advance while running, finish at the end
  renderQuickPanel(currentState);
});
el('qk-ros-edit')?.addEventListener('click', (e) => { e.preventDefault(); document.querySelector('.qrail-tab[data-qtab="ros"]')?.click(); });
// Static cockpit actions. (The run-of-show back/advance/edit buttons are wired above, next to rdSummary.)
el('qk-clear-all')?.addEventListener('click', (e) => { e.preventDefault(); el('gfx-top-clear')?.click(); });

// ── Bottom bar: "Up Next" from the start.gg stream queue ────────────────────
function renderUpNext(data) {
  const box = el('bb-upnext'), txt = el('bb-upnext-text');
  if (!box || !txt) return;
  const sg = data.startgg || {};
  const queue = Array.isArray(sg.queue) ? sg.queue : [];
  const hideWf = () => { const wf = el('wf-upnext'); if (wf) wf.style.display = 'none'; };
  if (!sg.queueEnabled || !queue.length) { box.style.display = 'none'; hideWf(); return; }
  // Prefer the next not-yet-finished set that isn't already live; else the live one.
  const next = queue.find((q) => !q.live && q.state !== 3) || queue.find((q) => q.live) || queue[0];
  if (!next) { box.style.display = 'none'; hideWf(); return; }
  const round = next.round ? next.round + ' · ' : '';
  const label = `${round}${next.teamA || 'TBD'} vs ${next.teamB || 'TBD'}`;
  txt.textContent = label;
  box.style.display = '';
  // Mirror into the rail Workflow tab.
  const wfBox = el('wf-upnext'), wfTxt = el('wf-upnext-text');
  if (wfBox && wfTxt) { wfTxt.textContent = label; wfBox.style.display = ''; }
}

// ── Producer notes (local scratchpad, persisted in localStorage) ────────────
const NOTES_KEY = 'ne_notes';
let _notesSaveT = null;
el('btn-notes')?.addEventListener('click', () => {
  const pop = el('notes-pop'); if (!pop) return;
  const open = pop.style.display === 'none';
  pop.style.display = open ? 'block' : 'none';
  if (open) { const ta = el('notes-text'); if (ta) { try { ta.value = localStorage.getItem(NOTES_KEY) || ''; } catch {} ta.focus(); } }
});
el('notes-close')?.addEventListener('click', () => { const p = el('notes-pop'); if (p) p.style.display = 'none'; });
el('notes-text')?.addEventListener('input', function () {
  const saved = el('notes-saved');
  if (saved) saved.textContent = 'Saving…';
  clearTimeout(_notesSaveT);
  _notesSaveT = setTimeout(() => { try { localStorage.setItem(NOTES_KEY, this.value); } catch {} if (saved) saved.textContent = 'Saved locally'; }, 350);
});
// Notes now live in a rail tab (always present) — load the saved scratchpad on startup.
(() => { const ta = el('notes-text'); if (ta) { try { ta.value = localStorage.getItem(NOTES_KEY) || ''; } catch {} } })();

// ── Producer segment timer — also drives the overlay countdown (countdown.html)
//    and the sidebar Break countdown display (ck-break-time) shows it live. ──
// endsAt (epoch ms) = the live break-countdown target. When set, the widget DERIVES its remaining
// from wall-clock time (like the overlay) instead of decrementing a local counter — so a throttled
// background setInterval (control-panel window not focused) can't drift from the overlay's countdown.
const _timer = { secs: 300, base: 300, running: false, handle: null, endsAt: null };
let _timerEditing = false;
// When the producer last acted on the timer. Broadcasts are COALESCED server-side (40-250ms) and
// arrive after a round-trip, so a broadcast queued BEFORE a click lands AFTER it and carries the
// pre-click timer. applyProductionState would mirror that stale state back over the new intent —
// Pause got forced back to running, Reset got forced back to Pause — and the button visibly
// flip-flopped until the producer's own change finally round-tripped. Local intent wins briefly.
let _timerLocalAt = 0;
const TIMER_LOCAL_MS = 1000;
// Break/countdown payload that mirrors the timer's value AND running state.
function breakPayloadFromTimer(extra) {
  const base = _timer.running ? { seconds: _timer.secs } : { frozenSeconds: _timer.secs };
  return Object.assign(base, extra || {});
}
// Go-live payload for the rail/topbar Countdown trigger. Unlike a bare mirror, this STARTS the
// producer timer so the overlay actually ticks down (it was sending a frozen value before, which
// is why "trigger the countdown" showed a static number). Carries title + auto-switch scene.
function startBreakFromRail() {
  if (_timer.secs === 0) { _timer.secs = _timer.base || 300; }
  if (!_timer.running) {
    _timer.running = true;
    if (!_timer.handle) _timer.handle = setInterval(tickTimer, 1000);
    paintTimer();
  }
  // The rail title <select> uses an empty value for "— No title —"; send it through verbatim.
  const titleSel = el('ck-break-title');
  const title = titleSel ? titleSel.value : 'STARTING SOON';
  return { visible: true, seconds: _timer.secs, title, thenScene: el('ck-break-thenscene')?.value || '' };
}
// Push the timer to the overlay countdown (the sidebar countdown display updates in paintTimer).
function syncTimerToOverlay() {
  _timerLocalAt = Date.now();   // producer intent — ignore mirrored state until this round-trips
  send('set_break', breakPayloadFromTimer());
}
// MM:SS, widening to H:MM:SS only once there's an hour on the clock — so a normal break still
// reads "05:00" and never gains a permanent "00:" column, but an hour-long pre-show is no longer
// shown as "60:00".
function fmtTimer(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = String(m).padStart(2, '0'), sss = String(ss).padStart(2, '0');
  return h ? h + ':' + mm + ':' + sss : mm + ':' + sss;
}
function paintTimer() {
  const txt = fmtTimer(_timer.secs);
  // Green > 1:00, yellow ≤ 1:00, red ≤ 0:30.
  const color = _timer.secs <= 30 ? '#f56565' : (_timer.secs <= 60 ? '#fbbf24' : '#4ade80');
  const d = el('ptimer-display'); if (d) { if (!_timerEditing) d.textContent = txt; d.style.color = color; }
  const bt = el('ck-break-time'); if (bt) { if (!_timerEditing) bt.textContent = txt; bt.style.color = color; }   // live sidebar countdown
  // Same _timerEditing guard as the other two displays — without it the tick overwrites whatever
  // is being typed into the big display.
  const pd = el('ptp-display'); if (pd) { if (!_timerEditing) pd.textContent = txt; pd.style.color = color; }
  const box = el('prod-timer');
  if (box) { box.classList.toggle('running', _timer.running && _timer.secs > 10);
             box.classList.toggle('ending', _timer.running && _timer.secs <= 10); }
  const label = _timer.running ? 'Pause' : (_timer.secs === 0 ? 'Reset' : 'Start');
  const t = el('ptimer-toggle'); if (t) t.textContent = label;
  const pt = el('ptp-toggle'); if (pt) pt.textContent = label;
  paintTimerStatus();
}
/* The popover's status line. The clock alone answered neither "is it counting?" nor "what time
   does it land on?" — the second is the one a producer actually needs mid-show ("are we back
   before the top of the hour?") and was being worked out by hand. Also surfaces whether the
   countdown GRAPHIC is on air, which is a different fact from the clock running: Start arms a
   segment clock without putting anything on the stream (see the break-timer arming rules). */
function paintTimerStatus() {
  const box = el('ptp-status'), txt = el('ptp-status-txt');
  if (box && txt) {
    const onAir = !!(typeof currentState !== 'undefined' && currentState.breakScreen && currentState.breakScreen.visible);
    box.classList.toggle('is-running', _timer.running && _timer.secs > 0);
    box.classList.toggle('is-paused', !_timer.running && _timer.secs > 0);
    box.classList.toggle('is-done', _timer.secs === 0);
    // The dot already says running (green, pulsing) / paused (amber) / done (red), so the words
    // only carry what it cannot: the wall-clock time this lands on. Short enough that the LIVE
    // chip stays on the same line in a 190px column instead of wrapping under it.
    let s;
    if (_timer.secs === 0) s = 'At zero';
    else if (_timer.running) {
      const end = new Date(Date.now() + _timer.secs * 1000);
      s = 'Ends ' + end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else s = 'Paused';
    txt.textContent = s;
    let chip = box.querySelector('.ptp-onair');
    // "Live", not "On air" — the section heading below is already ON AIR (the Show/Hide controls),
    // and the same words in a heading and a state chip read as the same thing.
    if (onAir && !chip) { chip = document.createElement('span'); chip.className = 'ptp-onair'; chip.textContent = 'Live'; box.appendChild(chip); }
    else if (!onAir && chip) chip.remove();
  }
  // Light the preset that matches the current length, so the panel states what it is set to.
  document.querySelectorAll('.ptp-preset').forEach((b) => {
    b.classList.toggle('is-on', Number(b.dataset.set) === (_timer.running ? _timer.base : _timer.secs));
  });
}
function tickTimer() {
  if (!_timer.running) return;
  if (_timer.endsAt) {
    // Wall-clock authoritative (matches overlay/countdown.html's round((endsAt-now)/1000)), so even
    // if this interval is throttled while the window is in the background, the number stays correct.
    _timer.secs = Math.max(0, Math.round((_timer.endsAt - Date.now()) / 1000));
    if (_timer.secs === 0) { _timer.running = false; _timer.endsAt = null; clearInterval(_timer.handle); _timer.handle = null; }
  } else {
    _timer.secs = Math.max(0, _timer.secs - 1);
    if (_timer.secs === 0) { _timer.running = false; clearInterval(_timer.handle); _timer.handle = null; }
  }
  paintTimer();
}
function adjustTimer(delta) {                 // ±seconds; works running or stopped
  _timer.endsAt = null;                       // manual override → local value until the server round-trips a fresh endsAt
  _timer.secs = Math.max(0, Math.min(359999, _timer.secs + delta));
  if (!_timer.running) _timer.base = _timer.secs;
  paintTimer(); syncTimerToOverlay();
}
// Setting a new value KEEPS RUNNING if it was running — typing 10m mid-countdown means "make it
// ten minutes from now", not "stop and wait for me to press Start again". syncTimerToOverlay()
// sends { seconds } while running, so the server re-anchors endsAt and every overlay follows.
function setTimerSecs(secs) {
  _timer.endsAt = null;                       // manual set → local value until the server round-trips a fresh endsAt
  _timer.secs = Math.max(0, Math.min(359999, Math.round(secs)));
  _timer.base = _timer.secs;
  // A running timer that's been re-set to 0 has nothing left to count, so stop it rather than
  // leaving a live interval spinning on zero.
  if (_timer.running && _timer.secs === 0) {
    _timer.running = false;
    if (_timer.handle) { clearInterval(_timer.handle); _timer.handle = null; }
  } else if (_timer.running && !_timer.handle) {
    _timer.handle = setInterval(tickTimer, 1000);
  }
  paintTimer(); syncTimerToOverlay();
}
function toggleTimer() {
  if (_timer.secs === 0 && !_timer.running) { _timer.secs = _timer.base || 300; paintTimer(); syncTimerToOverlay(); return; }
  _timer.running = !_timer.running;
  if (_timer.running) { _timer.handle = setInterval(tickTimer, 1000); }
  else if (_timer.handle) { clearInterval(_timer.handle); _timer.handle = null; }
  paintTimer(); syncTimerToOverlay();
}
// Parse "M:SS", "MM:SS", or a plain number of seconds.
// Broadcast-clock entry: bare digits fill in from the RIGHT, so a time can be typed without ever
// reaching for the colon. Each extra digit shifts the previous ones left:
//     1 -> 0:01      10 -> 0:10      130 -> 1:30
//  1000 -> 10:00   10000 -> 1:00:00
// An explicit colon form is taken as written and now understands hours too — the old parser split
// on one colon only, so "1:00:00" came out as 1 minute.
//
// NOTE this changes what a bare number means: "450" used to be 450 seconds, and is now 4:50.
// That's the requested behaviour and matches how hardware clocks and other broadcast tools read
// a typed duration.
function parseTimeInput(v) {
  v = String(v == null ? '' : v).trim();
  if (!v) return null;
  if (v.includes(':')) {
    const parts = v.split(':').map((x) => parseInt(x, 10) || 0);
    const [h, m, s] = parts.length >= 3 ? parts : [0, parts[0] || 0, parts[1] || 0];
    return h * 3600 + m * 60 + s;
  }
  const digits = v.replace(/\D/g, '');
  if (!digits) return null;
  // Right-aligned HHMMSS. Over-60 values in a column just roll up (typing 9999 = 99m 99s), which
  // is well defined for a DURATION and saves rejecting a fast-typed number.
  const d = digits.slice(-6).padStart(6, '0');
  return parseInt(d.slice(0, 2), 10) * 3600 + parseInt(d.slice(2, 4), 10) * 60 + parseInt(d.slice(4, 6), 10);
}
// ── Count down TO a wall-clock time ────────────────────────────────────────
// The TARGET is resolved server-side (resolveClockTarget) so every overlay lands on the same
// epoch regardless of the panel's own clock/timezone; we only mirror the resulting seconds into
// the local widget so the top-bar number matches straight away.
function startCountdownUntil(hhmm) {
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*$/.exec(String(hhmm || ''));
  const hint = el('ptp-until-hint');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    if (hint) { hint.textContent = 'Enter a time as HH:MM — e.g. 23:00'; hint.style.color = '#f56565'; }
    return false;
  }
  const target = new Date();
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (target.getTime() < Date.now()) target.setDate(target.getDate() + 1);
  const secs = Math.max(0, Math.round((target.getTime() - Date.now()) / 1000));
  _timerLocalAt = Date.now();   // producer intent — see syncTimerToOverlay
  _timer.endsAt = target.getTime();
  _timer.secs = secs;
  _timer.base = secs;
  _timer.running = true;
  if (!_timer.handle) _timer.handle = setInterval(tickTimer, 1000);
  paintTimer();
  send('set_break', { until: m[1].padStart(2, '0') + ':' + m[2] });
  if (hint) {
    const h = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60);
    hint.style.color = '';
    hint.textContent = 'Counting down to ' + target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      + ' — ' + (h ? h + 'h ' : '') + mm + 'm away.';
  }
  return true;
}
el('ptp-untilbtn')?.addEventListener('click', () => startCountdownUntil(el('ptp-until')?.value));
el('ptp-until')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startCountdownUntil(e.currentTarget.value); }
});
el('ptimer-toggle')?.addEventListener('click', toggleTimer);
el('ptp-toggle')?.addEventListener('click', toggleTimer);
el('ptp-reset')?.addEventListener('click', () => setTimerSecs(_timer.base || 300));
// Topbar timer → full countdown: show it on the overlay with title + auto-switch scene, and run
// the timer so it ticks down. (The segment timer alone never set visible, so nothing appeared.)
el('ptp-show')?.addEventListener('click', () => {
  if (_timer.secs === 0) { _timer.secs = _timer.base || 300; }
  if (!_timer.running) { _timer.running = true; if (!_timer.handle) _timer.handle = setInterval(tickTimer, 1000); }
  paintTimer();
  send('set_break', {
    visible: true,
    seconds: _timer.secs,
    title: el('ptp-break-title') ? el('ptp-break-title').value : 'STARTING SOON',
    thenScene: el('ptp-break-thenscene')?.value || ''
  });
});
el('ptp-hide')?.addEventListener('click', () => send('set_break', { visible: false }));
// After-countdown scene/playlist dropdowns apply IMMEDIATELY — they were only read by the
// Show button, and every broadcast re-synced them back to the stored value, so picking a
// scene mid-countdown silently reverted and the cut never happened. The server preserves
// the rest of the break state and reschedules the auto-switch on every set_break.
// Title dropdowns have the exact same bug (reported directly: picking a new title does nothing
// until "Show countdown" is clicked again) — same fix, same reasoning, just a different field.
[['ptp-break-thenscene', 'thenScene'], ['select-break-thenscene', 'thenScene'], ['ck-break-thenscene', 'thenScene'], ['ptp-break-title', 'title'], ['ck-break-title', 'title']].forEach(([id, key]) => {
  el(id)?.addEventListener('change', function () { send('set_break', { [key]: this.value || '' }); });
});
// Title-only: draw the countdown label with no clock beside it. Sent on its own so it never
// disturbs the running/frozen value the timer controls own.
el('ptp-title-only')?.addEventListener('change', function () { send('set_break', { titleOnly: this.checked }); });
el('ptimer-open')?.addEventListener('click', () => {
  const pop = el('ptimer-pop');
  const btn = el('ptimer-open');
  if (!pop) return;
  const opening = pop.style.display === 'none';
  pop.style.display = opening ? 'block' : 'none';
  if (btn) btn.textContent = opening ? '▴' : '▾';
});
// Up-arrow in the popover header — same collapse, discoverable from the panel itself.
el('ptp-close')?.addEventListener('click', () => {
  const pop = el('ptimer-pop');
  if (pop) pop.style.display = 'none';
  const btn = el('ptimer-open');
  if (btn) btn.textContent = '▾';
});
// Popover window actions: pop out into a separate (timer-sized) window + copy the overlay link.
el('ptp-popout')?.addEventListener('click', () => openPopout('timer'));
el('dcc-popout-btn')?.addEventListener('click', () => openPopout('dcc'));
el('dcc-refresh-btn')?.addEventListener('click', (e) => { if (typeof cfTalentRefresh === 'function') cfTalentRefresh(e.currentTarget); });
el('ptp-copy')?.addEventListener('click', (e) => {
  const url = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000') + '/countdown.html';
  if (typeof copyText === 'function') copyText(url, e.currentTarget);
  else if (navigator.clipboard) navigator.clipboard.writeText(url);
});
// Make the in-app timer popover draggable by its header. Disabled in the popped-out window
// (there you drag the OS window itself).
(function makeTimerPopDraggable() {
  const pop = el('ptimer-pop'), handle = el('ptp-head');
  if (!pop || !handle) return;
  let dragging = false, offX = 0, offY = 0;
  handle.addEventListener('mousedown', (e) => {
    if (document.body.classList.contains('popout-timer')) return;   // OS window drags itself
    if (e.target.closest('.ptp-head-btn')) return;                  // let the buttons click
    dragging = true;
    const r = pop.getBoundingClientRect();
    offX = e.clientX - r.left; offY = e.clientY - r.top;
    pop.style.left = r.left + 'px';
    pop.style.top = r.top + 'px';
    pop.style.transform = 'none';   // drop the translateX(-50%) centring so left/top are absolute
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const x = Math.max(4, Math.min(window.innerWidth - w - 4, e.clientX - offX));
    const y = Math.max(4, Math.min(window.innerHeight - h - 4, e.clientY - offY));
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
})();
document.querySelectorAll('.ptp-adj').forEach((b) => b.addEventListener('click', () => adjustTimer(parseInt(b.dataset.adj))));
document.querySelectorAll('.ptp-preset').forEach((b) => b.addEventListener('click', () => setTimerSecs(parseInt(b.dataset.set))));
el('ptp-setbtn')?.addEventListener('click', () => { const s = parseTimeInput(el('ptp-set')?.value); if (s != null) { setTimerSecs(s); el('ptp-set').value = ''; } });
el('ptp-set')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('ptp-setbtn').click(); });

// Click-to-type editing for any timer display (bottom transport + sidebar countdown).
// Typing seconds or M:SS auto-formats to M:SS via parseTimeInput → setTimerSecs.
// Click-to-type on a timer display, with broadcast-clock digit entry: keystrokes go into a digit
// BUFFER rather than into the element's text, and the element re-renders the formatted time after
// each one. Doing it this way (instead of letting contentEditable hold the raw characters) is what
// makes "type 1, 3, 0 and watch it become 1:30" possible — reformatting text under a live caret
// would otherwise fight the caret on every keystroke.
function attachTimerEdit(displayEl) {
  if (!displayEl) return;
  displayEl.style.cursor = 'text';
  let editOrig = '';
  let buf = '';        // digits typed so far, most recent on the right
  const render = () => { displayEl.textContent = buf ? fmtTimer(parseTimeInput(buf) || 0) : '00:00'; };
  const commit = () => {
    _timerEditing = false;
    const s = buf ? parseTimeInput(buf) : null;
    if (s != null && fmtTimer(s) !== editOrig) setTimerSecs(s);   // apply only on an actual change
    else paintTimer();
  };
  const beginEdit = () => {
    if (_timerEditing) return;
    _timerEditing = true;
    editOrig = (displayEl.textContent || '').trim();
    buf = '';                       // start empty: the first digit typed is seconds, as asked
    displayEl.contentEditable = 'true';
    displayEl.focus();
    const r = document.createRange(); r.selectNodeContents(displayEl);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  };
  displayEl.addEventListener('click', beginEdit);
  displayEl.addEventListener('keydown', (e) => {
    // Focused but not yet editing: Enter/Space opens it for typing, so the field is reachable
    // without a mouse (it carries tabindex="0").
    if (!_timerEditing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); beginEdit(); return; }
    if (!_timerEditing) return;
    if (e.key === 'Enter') { e.preventDefault(); displayEl.blur(); return; }
    if (e.key === 'Escape') { e.preventDefault(); _timerEditing = false; buf = ''; displayEl.blur(); paintTimer(); return; }
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      buf = (buf + e.key).replace(/^0+(?=\d)/, '').slice(-6);   // 6 digits = HHMMSS is the ceiling
      render();
      return;
    }
    if (e.key === 'Backspace') { e.preventDefault(); buf = buf.slice(0, -1); render(); return; }
    // Anything else (letters, colons, arrows) is not part of digit entry — swallow it so the
    // display can never end up holding text that isn't a time.
    if (e.key.length === 1) e.preventDefault();
  });
  // Paste a time from elsewhere ("7:30", "450") — keep it, but normalise through the same parser.
  displayEl.addEventListener('paste', (e) => {
    if (!_timerEditing) return;
    e.preventDefault();
    const txt = (e.clipboardData || window.clipboardData).getData('text') || '';
    const s = parseTimeInput(txt);
    if (s == null) return;
    buf = String(Math.floor(s / 3600)).padStart(2, '0')
        + String(Math.floor((s % 3600) / 60)).padStart(2, '0')
        + String(s % 60).padStart(2, '0');
    buf = buf.replace(/^0+(?=\d)/, '');
    render();
  });
  displayEl.addEventListener('blur', () => { displayEl.contentEditable = 'false'; if (_timerEditing) commit(); });
}
attachTimerEdit(el('ptimer-display'));
attachTimerEdit(el('ck-break-time'));
// The BIG countdown in the timer panel is the number a producer actually looks at, so it's the
// one they reach for to set a custom time. It was display-only — the custom entry lived in the
// small "M:SS or sec" box further down, which reads as a secondary control. Now it takes a click
// and a typed value like the other two.
attachTimerEdit(el('ptp-display'));
paintTimer();
// When a minimized/background window regains focus, its throttled tick may be up to a tick stale —
// recompute the endsAt-derived countdown immediately so it snaps to the correct time on return.
document.addEventListener('visibilitychange', () => { if (!document.hidden && _timer.running && _timer.endsAt) tickTimer(); });
window.addEventListener('focus', () => { if (_timer.running && _timer.endsAt) tickTimer(); });

// ── Commercial: cut to the dedicated Commercial OBS scene (no overlay graphic),
//    auto-returning to program when the ad video ends. Click again to return now.
el('btn-ad-break')?.addEventListener('click', () => {
  const obs = currentState.obs || {};
  if (!obs.connected) { flashHotkeyHint('Connect OBS first (Integrations).'); return; }
  const scenes = obs.scenes || {};
  if (!(scenes.commercial || scenes.break) && !(currentState.commercial && currentState.commercial.active)) {
    flashHotkeyHint('Map a Commercial scene under Apps > Streaming software.');
    document.querySelector('.tab-btn[data-tab="integrations"]')?.click();
    return;
  }
  send('obs_toggle_commercial');
});
// Reflect commercial state on the button.
function applyCommercialState(data) {
  const btn = el('btn-ad-break'); if (!btn) return;
  const on = !!(data.commercial && data.commercial.active);
  btn.classList.toggle('btn-danger', on);
  btn.classList.toggle('btn-secondary', !on);
  btn.textContent = on ? 'End Commercial' : 'Run Commercial';
}

// ── Run-of-Show checklist (Settings page, persisted in localStorage) ─────────
const REM_KEY = 'ne_reminders';
function loadReminders() { try { return JSON.parse(localStorage.getItem(REM_KEY) || '[]'); } catch { return []; } }
function saveReminders(list) { try { localStorage.setItem(REM_KEY, JSON.stringify(list)); } catch {} }
function renderReminders() {
  const wrap = el('reminders-list'); if (!wrap) return;
  const list = loadReminders();
  wrap.innerHTML = '';
  if (!list.length) { wrap.innerHTML = '<div class="reminders-empty">No steps yet — add your run-of-show checklist above.</div>'; return; }
  list.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'reminder-item' + (r.done ? ' done' : '');
    row.innerHTML = '<input type="checkbox"><span class="rem-text"></span><button class="rem-del" title="Remove">✕</button>';
    row.querySelector('input').checked = !!r.done;
    row.querySelector('.rem-text').textContent = r.text;
    row.querySelector('input').addEventListener('change', function () { const l = loadReminders(); l[i].done = this.checked; saveReminders(l); renderReminders(); });
    row.querySelector('.rem-del').addEventListener('click', () => { const l = loadReminders(); l.splice(i, 1); saveReminders(l); renderReminders(); });
    wrap.appendChild(row);
  });
}
function addReminder() {
  const inp = el('reminders-input'); if (!inp) return;
  const text = inp.value.trim(); if (!text) return;
  const l = loadReminders(); l.push({ text, done: false }); saveReminders(l); inp.value = ''; renderReminders();
}
el('reminders-add-btn')?.addEventListener('click', addReminder);
el('reminders-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addReminder(); });
el('ros-reset-all')?.addEventListener('click', () => { const l = loadReminders().map((r) => ({ ...r, done: false })); saveReminders(l); renderReminders(); });
el('ros-clear-all')?.addEventListener('click', async () => { if (!loadReminders().length || await appConfirm('Clear all run-of-show steps?', 'Clear')) { saveReminders([]); renderReminders(); } });

el('ros-export')?.addEventListener('click', () => {
  const list = loadReminders();
  const payload = JSON.stringify({ name: 'Run-of-Show', version: 1, steps: list.map(r => ({ text: r.text })) }, null, 2);
  const a = document.createElement('a');
  a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(payload);
  a.download = 'run-of-show.json';
  a.click();
});

el('ros-import-file')?.addEventListener('change', function () {
  const file = this.files && this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      const steps = Array.isArray(data.steps) ? data.steps : (Array.isArray(data) ? data : null);
      if (!steps) { alert('Unrecognised format — expected { steps: [...] }.'); return; }
      const list = steps.map(s => ({ text: (typeof s === 'string' ? s : s.text || '').trim(), done: false })).filter(s => s.text);
      if (!list.length) { alert('No steps found in file.'); return; }
      const existing = loadReminders();
      if (existing.length && !(await appConfirm(`Replace ${existing.length} existing step(s) with ${list.length} imported step(s)?`, 'Replace'))) return;
      saveReminders(list); renderReminders();
    } catch { alert('Could not read file — make sure it is a valid Run-of-Show JSON.'); }
  };
  reader.readAsText(file);
  this.value = '';
});

renderReminders();

// ── Preview dock — renders overlay scenes directly (no OBS WebSocket needed) ─
const PV_SIZES = [480, 640, 820];
let _pvSizeIdx = 0;
function pvBaseUrl() { return 'http://127.0.0.1:3000'; }
function pvBuildOptions() {
  const sel = el('pv-scene'); if (!sel || sel.dataset.built) return;
  sel.dataset.built = '1';
  // First option = the live OBS PROGRAM (screenshot poll); the rest render overlays directly.
  sel.innerHTML = '<optgroup label="OBS"><option value="__obs__">◉ OBS Program (live)</option></optgroup>' +
    SCENE_SOURCES.map((g) =>
      `<optgroup label="${g.group}">` + g.items.map((it) => `<option value="${it.path}">${it.name}</option>`).join('') + '</optgroup>'
    ).join('');
}
let _pvObsTimer = null, _pvObsStream = null;
// Screenshot resolution follows the current (resizable) stage width, so it stays sharp when enlarged.
function pvStageW() { const s = el('pv-stage'); return s ? Math.min(960, Math.max(160, Math.round(s.clientWidth))) : (PV_SIZES[_pvSizeIdx] || 480); }
function pvObsStartScreenshots() {
  if (_pvObsTimer || _pvObsStream) return;   // don't poll while the smooth feed is live
  const poll = () => send('obs_screenshot', { width: pvStageW() });
  poll();
  _pvObsTimer = setInterval(poll, 800);
}
// Full stop — used when leaving OBS mode / closing the dock.
function pvStopObs() {
  if (_pvObsTimer) { clearInterval(_pvObsTimer); _pvObsTimer = null; }
  if (_pvObsStream) { _pvObsStream.getTracks().forEach((t) => t.stop()); _pvObsStream = null; }
  const v = el('pv-obs-video'); if (v) { v.srcObject = null; v.style.display = 'none'; }
  const lb = el('pv-obs-live'); if (lb) { lb.classList.remove('on'); lb.style.display = 'none'; }
}
// Both were deleted with the old switcher panel while their callers stayed: swBackend's callers are
// typeof-guarded, so vMix producers were silently checked against OBS; SW_VCAM_RE threw outright,
// so the live OBS preview never found the virtual camera.
function swBackend(data) { return (data && data.switcher && data.switcher.target) === 'vmix' ? 'vmix' : 'obs'; }
const SW_VCAM_RE = /obs\s*virtual|obs-camera|obs cam|vmix|virtual cam/i;
// Smooth live OBS feed via the Virtual Camera (getUserMedia). Auto-starts OBS's virtual cam first.
async function pvObsLiveStart(silent) {
  const lb = el('pv-obs-live'), v = el('pv-obs-video'), img = el('pv-obs-img'), msg = el('pv-obs-msg');
  try {
    send('obs_virtualcam', { on: true });   // make sure OBS's virtual camera is running
    let cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (!cams.some((d) => d.label)) {
      if (silent) return false;   // labels hidden until permission granted — never prompt silently
      const unlock = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      unlock.getTracks().forEach((t) => t.stop());
      cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    }
    let vcam = cams.find((d) => SW_VCAM_RE.test(d.label || ''));
    if (!vcam && !silent) {   // OBS may have just started the vcam — give the device a beat to appear
      await new Promise((r) => setTimeout(r, 900));
      cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      vcam = cams.find((d) => SW_VCAM_RE.test(d.label || ''));
    }
    if (!vcam) { if (!silent && msg) { msg.textContent = 'Starting OBS Virtual Camera — give it a second, then click Smooth again.'; msg.style.display = 'flex'; } return false; }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: vcam.deviceId } }, audio: false });
    _pvObsStream = stream;
    if (_pvObsTimer) { clearInterval(_pvObsTimer); _pvObsTimer = null; }   // stop screenshot polling
    if (v) { v.srcObject = stream; v.style.display = ''; }
    if (img) img.style.display = 'none';
    if (msg) msg.style.display = 'none';
    if (lb) lb.classList.add('on');
    return true;
  } catch (e) {
    if (!silent && msg) { msg.textContent = 'Live feed error: ' + (e.name || e.message); msg.style.display = 'flex'; }
    pvObsLiveStop();
    return false;
  }
}
function pvObsLiveStop() {
  if (_pvObsStream) { _pvObsStream.getTracks().forEach((t) => t.stop()); _pvObsStream = null; }
  const v = el('pv-obs-video'); if (v) { v.srcObject = null; v.style.display = 'none'; }
  const lb = el('pv-obs-live'); if (lb) lb.classList.remove('on');
  if (el('pv-scene')?.value === '__obs__') pvObsStartScreenshots();   // fall back to screenshots
}
function pvLoad() {
  const sel = el('pv-scene'), frame = el('pv-frame'), img = el('pv-obs-img'), msg = el('pv-obs-msg');
  if (!sel || !frame) return;
  if (sel.value === '__obs__') {
    // OBS Program mode — start OBS's Virtual Camera, poll a JPEG of the live program (works with no
    // camera permission), and offer the "Smooth" button for a low-latency getUserMedia feed.
    pvStopObs();   // clean slate: clears any prior timer/stream and hides the video + button
    frame.style.display = 'none';
    if (img) img.style.display = '';
    const lb = el('pv-obs-live'); if (lb) { lb.style.display = ''; lb.classList.remove('on'); }
    send('obs_virtualcam', { on: true });   // START VIRTUAL CAM WHEN NOT ACTIVE
    pvObsStartScreenshots();
    if (typeof showToast === 'function') showToast('OBS Program preview — Virtual Camera started. Click "Smooth" for a live feed.', '#22c55e', 2600);
    return;
  }
  pvStopObs();
  if (img) img.style.display = 'none';
  if (msg) msg.style.display = 'none';
  frame.style.display = '';
  let url = pvBaseUrl() + (sel.value || '/');
  if (el('pv-sample')?.checked) url += (url.includes('?') ? '&' : '?') + 'preview=1';
  frame.src = url;
}
function applyObsScreenshot(d) {
  if (el('pv-scene')?.value !== '__obs__' || _pvObsStream) return;   // ignore while the smooth feed is live
  const img = el('pv-obs-img'), msg = el('pv-obs-msg');
  if (d && d.ok && d.img) {
    if (img) { img.src = d.img; img.style.display = ''; }
    if (msg) msg.style.display = 'none';
  } else {
    if (img) img.style.display = 'none';
    if (msg) { msg.textContent = (d && d.reason) === 'OBS not connected' ? 'OBS is not connected. Connect it under Apps > Streaming software, then reopen this preview.' : ((d && d.reason) || 'OBS not connected'); msg.style.display = 'flex'; }
  }
}
el('btn-preview')?.addEventListener('click', () => {
  const dock = el('preview-dock'); if (!dock) return;
  const show = dock.style.display === 'none';
  dock.style.display = show ? 'block' : 'none';
  if (show) { pvBuildOptions(); if (!el('pv-frame').src && el('pv-scene')?.value !== '__obs__') pvLoad(); }
  else { pvStopObs(); const f = el('pv-frame'); if (f && f.src) f.removeAttribute('src'); }   // stop the background overlay too
});
el('pv-close')?.addEventListener('click', () => { el('preview-dock').style.display = 'none'; pvStopObs(); const f = el('pv-frame'); if (f && f.src) f.removeAttribute('src'); });
el('pv-scene')?.addEventListener('change', pvLoad);
el('pv-sample')?.addEventListener('change', pvLoad);
el('pv-reload')?.addEventListener('click', pvLoad);
el('pv-popout')?.addEventListener('click', () => {
  const sel = el('pv-scene');
  // resizable=yes → the popped-out preview window can be dragged to any size.
  window.open(pvBaseUrl() + (sel?.value || '/'), 'ne-preview', 'width=960,height=540,resizable=yes,scrollbars=no');
});
el('pv-obs-live')?.addEventListener('click', () => { if (_pvObsStream) pvObsLiveStop(); else pvObsLiveStart(false); });
el('pv-size')?.addEventListener('click', () => {
  _pvSizeIdx = (_pvSizeIdx + 1) % PV_SIZES.length;
  const stage = el('pv-stage'); if (stage) stage.style.width = PV_SIZES[_pvSizeIdx] + 'px';   // inline so it cooperates with drag-resize
  document.documentElement.style.setProperty('--pv-w', PV_SIZES[_pvSizeIdx] + 'px');
});
// Drag-to-resize the stage (CSS resize:horizontal) → keep the scaled iframe/screenshot in sync.
(function pvWireResize() {
  const stage = el('pv-stage'); if (!stage || typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => {
    const w = Math.round(stage.clientWidth); if (w > 0) document.documentElement.style.setProperty('--pv-w', w + 'px');
  });
  ro.observe(stage);
})();

// ── Dashboard: Player Cams (link a cam URL to each active player) ───────────
let _playerCamsSig = '';
function renderPlayerCams(data) {
  const wrap = el('player-cams-rows');
  if (!wrap) return;
  const teams = data.teams || {};
  const colorOf = (s) => (teams[s] && teams[s].color) || (s === 'blue' ? '#055fdb' : '#e97139');

  // Roster (start.gg names) by side — used to label live players + as the pre-game fallback.
  const roster = [];
  ['blue', 'orange'].forEach((side) => {
    ((teams[side] && teams[side].players) || []).forEach((p) => {
      if (p && p.name) roster.push({ side, name: p.name, id: p.platformId || p.primaryid || null });
    });
  });

  // Live in-game players — the actual lineup, WITH their side. Only these get cam rows during a match.
  const live = [];
  (data.players || []).forEach((p) => { if (p && p.name) live.push({ name: p.name, id: p.primaryid || null, side: Number(p.team) === 1 ? 'orange' : 'blue' }); });
  ((data.csgo && data.csgo.players) || []).forEach((p) => { if (p && p.name) live.push({ name: p.name, id: p.steamid || null, side: p.team === 'T' ? 'orange' : 'blue' }); });

  // Facecam lookups (the shared store — same as the Facecams tab).
  const camByName = {}, camById = {};
  (data.facecams || []).forEach((f) => { if (!f) return; if (f.name) camByName[f.name.toLowerCase()] = f.link || ''; if (f.platformId) camById[String(f.platformId)] = f.link || ''; });
  const camFor = (name, id) => (id && camById[String(id)]) || (name && camByName[name.toLowerCase()]) || '';

  const fuzzy = (a, b) => { a = (a || '').toLowerCase(); b = (b || '').toLowerCase(); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };
  // Reverse-match a live player to a roster (start.gg) name for context.
  const startggFor = (lp) =>
    (roster.find((r) => r.id && lp.id && String(r.id) === String(lp.id))
      || roster.find((r) => r.name.toLowerCase() === lp.name.toLowerCase())
      || roster.find((r) => fuzzy(r.name, lp.name)) || {}).name || '';

  const liveMode = live.length > 0;
  // Rows = the in-game lineup (per side) when a match is live; otherwise the roster (pre-game setup).
  const rows = liveMode
    ? live.map((lp) => ({ ingame: lp.name, startgg: startggFor(lp), side: lp.side, id: lp.id }))
    : roster.map((r) => ({ ingame: '', startgg: r.name, side: r.side, id: r.id }));

  const teamSig = ['blue', 'orange'].map((s) => (teams[s] && (teams[s].name + '|' + teams[s].color)) || '');
  const sig = JSON.stringify({ rows, camByName, camById, liveMode, teamSig });
  if (sig === _playerCamsSig) return;
  if (wrap.contains(document.activeElement)) return;   // don't clobber a field being edited
  _playerCamsSig = sig;
  wrap.innerHTML = '';

  if (liveMode) {
    const ref = document.createElement('div');
    ref.className = 'pcam-live-ref';
    ref.innerHTML = '<span class="pcam-live-label">In game now</span>';
    live.forEach((l) => { const c = document.createElement('span'); c.className = 'pcam-live-chip'; c.style.borderLeft = `3px solid ${colorOf(l.side)}`; c.textContent = l.name; ref.appendChild(c); });
    wrap.appendChild(ref);
    const dl = document.createElement('datalist'); dl.id = 'pcam-live-list';
    live.forEach((l) => { const o = document.createElement('option'); o.value = l.name; dl.appendChild(o); });
    wrap.appendChild(dl);
  }

  if (!rows.length) {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:12px; color:var(--muted);';
    p.textContent = 'Add teams & players first (Teams tab) — active players appear here.';
    wrap.appendChild(p);
    return;
  }

  // Team names/labels for the group headers (real team name → game side label → generic).
  const g = (data.games && data.activeGame) ? data.games[data.activeGame] : null;
  const sideLabels = (g && g.teamLabels) || { a: 'Blue', b: 'Orange' };
  const teamNameOf = (side) => (teams[side] && (teams[side].name || '').trim())
    || (side === 'blue' ? sideLabels.a : sideLabels.b)
    || (side === 'blue' ? 'Blue Team' : 'Orange Team');

  function makeCamRow(row) {
    const key = row.ingame || row.startgg;
    const existing = camFor(key, row.id) || (row.startgg && camByName[row.startgg.toLowerCase()]) || '';

    const div = document.createElement('div');
    div.className = 'pcam-row';
    div.innerHTML = `
      <span class="pcam-side"></span>
      <div class="pcam-names">
        <span class="pcam-name"></span>
        ${liveMode
          ? '<span class="pcam-sub"></span>'
          : '<input type="text" class="input-text pcam-ingame" list="pcam-live-list" autocomplete="off" placeholder="in-game name" title="The name the overlay matches this cam to">'}
      </div>
      <input type="text" class="input-text pcam-url" placeholder="https://vdo.ninja/?view=…">
      <button class="btn btn-secondary btn-sm pcam-apply">Apply</button>`;
    div.querySelector('.pcam-side').style.background = colorOf(row.side);
    div.querySelector('.pcam-name').textContent = liveMode ? row.ingame : row.startgg;
    const urlInput = div.querySelector('.pcam-url');
    urlInput.value = existing;

    if (liveMode) {
      const sub = div.querySelector('.pcam-sub');
      if (sub) sub.textContent = row.startgg ? `start.gg: ${row.startgg}` : 'no start.gg match';
    } else {
      // Pre-game: editable in-game name; picking/typing one that has a saved cam fills the URL.
      const ig = div.querySelector('.pcam-ingame');
      ig.addEventListener('input', () => { const u = camFor(ig.value.trim(), row.id); if (u) urlInput.value = u; });
    }

    const btn = div.querySelector('.pcam-apply');
    btn.addEventListener('click', () => {
      const camKey = liveMode ? row.ingame : (div.querySelector('.pcam-ingame')?.value.trim() || row.startgg);
      send('save_facecam', { name: camKey, platform: 'bot', platformId: row.id || null, link: urlInput.value.trim() });
      btn.textContent = 'Saved'; setTimeout(() => { btn.textContent = 'Apply'; }, 1000);
    });
    return div;
  }

  // Group rows under a team header (team name in the team's colour) instead of a bare blue/orange bar.
  ['blue', 'orange'].forEach((side) => {
    const sideRows = rows.filter((r) => r.side === side);
    if (!sideRows.length) return;
    const color = colorOf(side);
    const head = document.createElement('div');
    head.className = 'pcam-team-head';
    head.style.borderLeft = `4px solid ${color}`;
    head.innerHTML = `<span class="pcam-team-dot"></span><span class="pcam-team-name"></span><span class="pcam-team-count"></span>`;
    head.querySelector('.pcam-team-dot').style.background = color;
    head.querySelector('.pcam-team-name').textContent = teamNameOf(side);
    head.querySelector('.pcam-team-name').style.color = color;
    head.querySelector('.pcam-team-count').textContent = `${sideRows.length} ${sideRows.length === 1 ? 'player' : 'players'}`;
    wrap.appendChild(head);
    sideRows.forEach((row) => wrap.appendChild(makeCamRow(row)));
  });
}
document.querySelectorAll('.js-goto-facecams').forEach((b) => b.addEventListener('click', () => {
  document.querySelector('.tab-btn[data-tab="produccion"]')?.click();
  if (typeof window._pdShow === 'function') window._pdShow('cameras');
}));
document.querySelectorAll('.js-goto-scenes').forEach((b) => b.addEventListener('click', () => {
  document.querySelector('.tab-btn[data-tab="media"]')?.click();
  if (typeof window._assetsShow === 'function') window._assetsShow('overlays');
}));

// ── Camera Feeds / VDO talent domain (cf*, vdo*) — extracted to camera-feeds.js ──
function tlEsc(s) { return esc(s); }   // legacy alias — canonical esc() lives in core.js; kept in app.js (used across app.js + spotlight.js)
