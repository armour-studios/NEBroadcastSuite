// Control panel, part 3 of 17: Quick rail, popouts, Discord sign-in and roles, bug report, updates, rendering, Liquipedia, bottom bar, status bar.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Qrail consolidation: Triggers→Graphics, Checklist→Notes, Stream→Twitch (re-parent content) ──
(function consolidateQrail() {
  const panel = (q) => document.querySelector('.qrail-panel[data-qpanel="' + q + '"]');
  const qtab = (q) => document.querySelector('.qrail-tab[data-qtab="' + q + '"]');
  const sepEl = () => { const s = document.createElement('div'); s.style.cssText = 'border-top:1px solid var(--border);margin:12px 0 2px;'; return s; };
  const move = (from, to) => { if (from && to) while (from.firstChild) to.appendChild(from.firstChild); };

  // 1) Triggers (golive) → Graphics
  const graphics = panel('graphics'), golive = panel('golive');
  if (graphics && golive) { graphics.appendChild(sepEl()); move(golive, graphics); golive.remove(); }
  const goliveTab = qtab('golive'), graphicsTab = qtab('graphics');
  if (goliveTab) { const dot = document.getElementById('qrail-golive-dot'); if (dot && graphicsTab) graphicsTab.appendChild(dot); goliveTab.remove(); }
  if (graphicsTab) { const lbl = graphicsTab.querySelector('.qrail-tab-label'); if (lbl) lbl.textContent = 'Graphics'; graphicsTab.title = 'Graphics — overlays & triggers'; }

  // 2) Checklist tab removed from right-rail — Run-of-Show now lives in Settings.
  const checklistPanel = panel('checklist'); if (checklistPanel) checklistPanel.remove();
  const checklistTab = qtab('checklist'); if (checklistTab) checklistTab.remove();

  // 3) Stream (workflow) → Twitch, as a 4th sub-tab. The Stream button gets its handler from the
  //    Twitch sub-nav wiring later in the file (which runs after this and picks up all #tw-subnav buttons).
  const twitch = panel('twitch'), workflow = panel('workflow'), subnav = document.getElementById('tw-subnav');
  if (twitch && workflow) {
    const wrap = document.createElement('div'); wrap.className = 'tw-sub'; wrap.dataset.twpanel = 'stream'; wrap.style.display = 'none';
    move(workflow, wrap); twitch.appendChild(wrap); workflow.remove();
    // "Channel": announcement, shoutout, chat modes, raid. (The stream title/category moved to On Air, below.)
    if (subnav) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ev-subnav-btn'; b.dataset.tw = 'stream'; b.textContent = 'Channel'; subnav.appendChild(b); }
  }
  const workflowTab = qtab('workflow'); if (workflowTab) workflowTab.remove();

  // 4) Aggressive 7-tab rethink (QUICK · RUNDOWN · QUEUE · FLOWS · TALENT · AI · STREAM):
  //    Graphics' function (overlay toggles + triggers) now lives in the QUICK cockpit, so hide its
  //    tab but KEEP the panel DOM as the hidden backing store — the cockpit chips reuse its
  //    ck-*-toggle buttons and the trigger-config gear clones its option controls.
  const gTab = qtab('graphics');
  if (gTab) {
    const gdot = document.getElementById('qrail-golive-dot'), qTab = qtab('quick');
    if (gdot && qTab) qTab.appendChild(gdot);   // keep the trigger live-dot on the Quick tab
    gTab.style.display = 'none';
  }
  // 5) NEXT = Rundown + Queue — fold the Start.gg queue panel into the Run-of-Show panel.
  const rosP = panel('ros'), sggP = panel('startgg');
  if (rosP && sggP) { rosP.appendChild(sepEl()); move(sggP, rosP); sggP.remove(); }
  const sggTab = qtab('startgg'), rosTab0 = qtab('ros');
  if (sggTab) { const sdot = document.getElementById('qrail-sgg-dot'); if (sdot && rosTab0) rosTab0.appendChild(sdot); sggTab.remove(); }

  // 6) AUTO = Flows + Neural AI — fold the AI panel into the Flows panel.
  const flowsP = panel('flows'), aiP = panel('ai');
  if (flowsP && aiP) { flowsP.appendChild(sepEl()); move(aiP, flowsP); aiP.remove(); }
  const aiTab = qtab('ai'), flowsTab0 = qtab('flows');
  if (aiTab) { const adot = document.getElementById('qrail-ai-dot'); if (adot && flowsTab0) flowsTab0.appendChild(adot); aiTab.remove(); }

  // 7) Final tab identity: AIR · NEXT · TALENT · AUTO · REPLAY · STREAM · NOTES.
  //    Icon strip; each tab gets a persistent caption under its icon (not hover-only —
  //    icon-only nav was confusing for new users).
  const setLabel = (t, txt, title) => {
    const b = qtab(t); if (!b) return;
    let l = b.querySelector('.qrail-tab-label');
    if (!l) { l = document.createElement('span'); l.className = 'qrail-tab-label'; b.appendChild(l); }
    l.textContent = txt; if (title) b.title = title;
  };
  // Names describe what is INSIDE each tab (2026-09-17 rethink with the producer):
  //   On Air     — what viewers see: stream status + title, put graphics on air, program feed
  //   Up Next    — what is coming: run of show + the match queue
  //   Talent     — casters and players: cams, mics, listen-in
  //   Replay     — replay buffer, clips, playlists
  //   Chat       — chat, activity, Q&A, predictions, channel tools
  //   Automation — flows, AI shield, auto-director, auto-clipping
  setLabel('controls', 'Controls', 'Controls — score, break timer, graphics, scenes and automation in one place');
  setLabel('show',   'Show',       'Show — next matches, run of show, replay and the stream title');
  setLabel('quick',  'On Air',     'On Air — what viewers see: stream status and title, put graphics on air, program feed');
  setLabel('ros',    'Up Next',    'Up Next — the run of show and the match queue');
  setLabel('talent', 'Talent',     'Talent — casters and players: cams, mics and listen-in');
  setLabel('replay', 'Replay',     'Replay — replay buffer, clips and playlists');
  setLabel('twitch', 'Chat',       'Chat — chat, activity, Q&A, predictions and channel tools');
  setLabel('flows',  'Automation', 'Automation — flows, AI shield, auto-director and auto-clipping');
  setLabel('notes',  'Notes',      'Notes — producer notes');

  // Order by how often a producer reaches for each during a show.
  const tabsStrip = document.getElementById('qrail-tabs'), spacer = tabsStrip && tabsStrip.querySelector('.qrail-tab-spacer');
  if (tabsStrip && spacer) ['quick', 'ros', 'talent', 'replay', 'twitch', 'flows'].forEach((t) => { const b = qtab(t); if (b) tabsStrip.insertBefore(b, spacer); });

  // Stream title + category belong with the ON STREAM status, not under chat. Moved (not cloned)
  // so every existing handler on #flows-stream-title / #btn-flows-update-channel keeps working.
  const streamGroup = document.getElementById('flows-stream-title')?.closest('.qrail-group');
  const cockpit = document.getElementById('qk-cockpit');
  if (streamGroup && cockpit && cockpit.parentNode) {
    streamGroup.classList.add('qk-stream-info');
    cockpit.parentNode.insertBefore(streamGroup, cockpit.nextSibling);
    const lbl = streamGroup.querySelector('.qrail-label > span');
    if (lbl) lbl.textContent = 'Stream title';
  }

  // Pin Notes to the bottom of the strip (by the popout), off the main tab list.
  const nTab = qtab('notes'), tabsEl = document.getElementById('qrail-tabs'), popBtn = document.getElementById('qrail-popout-btn');
  if (nTab && tabsEl && popBtn) tabsEl.insertBefore(nTab, popBtn);
})();

// Empty states offer the next step as a button that presses the page's real control
// (data-empty-click="<id>"), so they keep working however that control is wired.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-empty-click]');
  if (!b) return;
  const target = document.getElementById(b.getAttribute('data-empty-click'));
  if (target && !target.disabled) target.click();
});

// ── Sidebar collapse ────────────────────────────────────────────────────────
function toggleSidebar() {
  const shell = el('app-shell');
  const collapsed = shell.classList.toggle('collapsed');
  document.documentElement.style.setProperty('--sidebar-w', collapsed ? '66px' : '236px');
  const btn = el('sidebar-collapse'); if (btn) btn.textContent = collapsed ? '›' : '‹';
}
el('sidebar-collapse')?.addEventListener('click', toggleSidebar);

// ── Mobile off-canvas nav drawer ─────────────────────────────────────────────
// Below 900px the sidebar slides over the content (with a backdrop) instead of
// taking a fixed column. The hamburger / brand icon open it; tapping a nav item,
// the backdrop, or Escape closes it; growing the viewport resets it.
function isMobileNav() { return window.matchMedia('(max-width: 900px)').matches; }
function setMobileNav(open) { document.body.classList.toggle('nav-open', !!open); }
function toggleMobileNav() { setMobileNav(!document.body.classList.contains('nav-open')); }
el('nav-hamburger')?.addEventListener('click', () => { isMobileNav() ? toggleMobileNav() : toggleSidebar(); });
el('nav-backdrop')?.addEventListener('click', () => setMobileNav(false));
el('brand-icon-btn')?.addEventListener('click', () => {
  if (isMobileNav()) { toggleMobileNav(); return; }
  if (el('app-shell').classList.contains('collapsed')) toggleSidebar();
});
document.querySelectorAll('.sidebar-nav .nav-item, .sidebar-foot .sidebar-link').forEach((b) =>
  b.addEventListener('click', () => { if (isMobileNav()) setMobileNav(false); }));
window.addEventListener('resize', () => { if (!isMobileNav()) setMobileNav(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setMobileNav(false); });

// ── Popout system ─────────────────────────────────────────────────────────────
const PAGE_LABELS = {
  principal: 'Dashboard', events: 'Events', produccion: 'Production',
  director: 'Director', replays: 'Replays', scenes: 'Overlays',
  equipos: 'Talent', facecams: 'Cameras', brands: 'Profiles',
  media: 'Assets', integrations: 'Marketplace', stats: 'Analytics',
  ajustes: 'Settings', roles: 'Roles',
  graphics: 'Graphics', social: 'Social',
};

function openPopout(page) {
  if (window.electronAPI?.openPopout) {
    window.electronAPI.openPopout(page);
  } else {
    window.open(window.location.pathname + '?page=' + encodeURIComponent(page),
      'popout_' + page, 'width=1280,height=900,resizable=yes');
  }
}
// Graphics is a Production sub-tab, not a sidebar data-tab item, so it doesn't pick up the
// hover-icon injected onto every .tab-btn[data-tab] below — it gets its own trigger on the
// Graphics top bar instead. See the '?page=graphics' handling further down for the popout side.
el('gfx-top-popout')?.addEventListener('click', () => openPopout('graphics'));

// Inject popout icon into each sidebar nav item (wraps button, adds sibling icon)
document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
  const page = btn.dataset.tab;
  const label = PAGE_LABELS[page] || page;
  const wrap = document.createElement('div');
  wrap.className = 'nav-item-wrap';
  btn.parentNode.insertBefore(wrap, btn);
  wrap.appendChild(btn);
  const po = document.createElement('button');
  po.className = 'nav-popout';
  po.title = 'Pop out ' + label;
  po.type = 'button';
  po.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
  po.addEventListener('click', (e) => { e.stopPropagation(); openPopout(page); });
  wrap.appendChild(po);
});
// Roles is reachable from the user dropdown, so hide its sidebar row (keep the button in the DOM
// so the dropdown's tab-roles.click() still works).
(function hideRolesNav() {
  const rb = document.getElementById('tab-roles');
  if (rb) (rb.closest('.nav-item-wrap') || rb).style.display = 'none';
})();

// Pages no longer carry a header or an inline pop-out button — pop-out lives on the
// sidebar nav items (hover icon + right-click menu) only.

// Right-click context menu on sidebar nav items
(function() {
  const ctxMenu = el('tab-ctx-menu');
  const ctxBtn  = el('tab-ctx-popout');
  if (!ctxMenu || !ctxBtn) return;
  let _ctxPage = null;

  document.querySelector('.sidebar-nav')?.addEventListener('contextmenu', (e) => {
    const wrap = e.target.closest('.nav-item-wrap');
    if (!wrap) return;
    const tabBtn = wrap.querySelector('.tab-btn[data-tab]');
    if (!tabBtn) return;
    e.preventDefault();
    _ctxPage = tabBtn.dataset.tab;
    ctxBtn.textContent = '↗  Pop out ' + (PAGE_LABELS[_ctxPage] || _ctxPage);
    ctxMenu.removeAttribute('hidden');
    const x = Math.min(e.clientX + 4, window.innerWidth  - 180);
    const y = Math.min(e.clientY,     window.innerHeight - 60);
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top  = y + 'px';
  });
  ctxBtn.addEventListener('click', () => {
    ctxMenu.setAttribute('hidden', '');
    if (_ctxPage) { openPopout(_ctxPage); _ctxPage = null; }
  });
  document.addEventListener('click',       () => ctxMenu.setAttribute('hidden', ''));
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.sidebar-nav')) ctxMenu.setAttribute('hidden', '');
  });
})();

// Detect ?page= and enter popout mode
const _popoutPage = new URLSearchParams(window.location.search).get('page');
if (_popoutPage === 'triggers') {
  // Special popout: just the Go Live trigger bar (the qrail "golive" panel), full window.
  document.body.classList.add('popout-mode', 'popout-triggers');
  const _pb = el('popout-bar');
  if (_pb) {
    const _pbt = _pb.querySelector('.popout-bar-title');
    if (_pbt) _pbt.textContent = 'Triggers';
    _pb.removeAttribute('hidden');
  }
  requestAnimationFrame(() => {
    // Triggers merged into the AIR cockpit (golive tab removed) — open AIR.
    const tab = document.querySelector('.qrail-tab[data-qtab="quick"]');
    if (tab) tab.click();
  });
} else if (_popoutPage === 'timer') {
  // Special popout: the producer / countdown timer, full window (drag to a second monitor).
  document.body.classList.add('popout-mode', 'popout-timer');
  const _pb = el('popout-bar');
  if (_pb) {
    const _pbt = _pb.querySelector('.popout-bar-title');
    if (_pbt) _pbt.textContent = 'Countdown Timer';
    _pb.removeAttribute('hidden');
  }
  requestAnimationFrame(() => { const pop = el('ptimer-pop'); if (pop) pop.style.display = 'block'; });
} else if (_popoutPage === 'dcc') {
  // Special popout: Director Control Center full-window.
  document.body.classList.add('popout-mode', 'popout-dcc');
  const _pb = el('popout-bar');
  if (_pb) {
    const _pbt = _pb.querySelector('.popout-bar-title');
    if (_pbt) _pbt.textContent = 'Director Control Center';
    _pb.removeAttribute('hidden');
  }
} else if (_popoutPage === 'match') {
  // Special popout: the Match — Teams card full-window.
  document.body.classList.add('popout-mode', 'popout-match');
  const _pb = el('popout-bar');
  if (_pb) {
    const _pbt = _pb.querySelector('.popout-bar-title');
    if (_pbt) _pbt.textContent = 'Match — Teams';
    _pb.removeAttribute('hidden');
  }
  requestAnimationFrame(() => { const sec = el('match-teams-section'), host = el('tab-principal-content'); if (sec && host) host.appendChild(sec); });
} else if (_popoutPage && PAGE_LABELS[_popoutPage]) {
  document.body.classList.add('popout-mode');
  const _pb = el('popout-bar');
  if (_pb) {
    const _pbt = _pb.querySelector('.popout-bar-title');
    if (_pbt) _pbt.textContent = PAGE_LABELS[_popoutPage];
    _pb.removeAttribute('hidden');
  }
  // Activate the target tab after all listeners are set up. Merged pages redirect to their host:
  // Director and Cameras are Production panes, and Graphics is a Dashboard section now.
  requestAnimationFrame(() => {
    const HOST = { director: 'produccion', facecams: 'produccion', graphics: 'principal', brands: 'ajustes', scenes: 'media' };
    const target = HOST[_popoutPage] || _popoutPage;
    const btn = document.querySelector('.tab-btn[data-tab="' + target + '"]');
    if (btn) btn.click();
    if (_popoutPage === 'director' && typeof window._pdShow === 'function') window._pdShow('director');
    if (_popoutPage === 'facecams' && typeof window._pdShow === 'function') window._pdShow('cameras');
    if (_popoutPage === 'scenes' && typeof window._assetsShow === 'function') window._assetsShow('overlays');
    if (_popoutPage === 'brands' && typeof openSettings === 'function') openSettings('brandkits');
  });
} else {
  // Normal window: reopen the page the producer was last on (survives refresh / relaunch).
  requestAnimationFrame(() => {
    let saved; try { saved = localStorage.getItem('ne_active_tab'); } catch {}
    const wasScenes = saved === 'scenes';   // Overlays merged into Assets ▸ Overlays
    const wasBrands = saved === 'brands';   // Profiles now in Settings ▸ Brand Kits
    if (wasScenes) saved = 'media';
    if (wasBrands) saved = 'ajustes';
    // Switcher page is hidden from nav (laggy screenshot multiview) — its button is display:none,
    // but .click() still fires on a hidden element, so a stale saved tab would silently reopen it
    // (and re-arm its OBS Studio-Mode auto-enable) on the next launch without this guard.
    if (saved === 'switcher') saved = 'produccion';
    // Social is org owner/admin-only and the cloud session hasn't landed yet at this point, so
    // there's no role to check against — same hidden-button-still-clicks problem as Switcher
    // above. Fall back to the Dashboard; the producer can re-open Social once the gate reveals it.
    if (saved === 'ajustes') saved = 'principal';   // Settings is a modal now — never auto-open it on launch
    if (saved && saved !== 'principal') {
      const btn = document.querySelector('.tab-btn[data-tab="' + saved + '"]');
      if (btn) btn.click();
      if (wasScenes && typeof window._assetsShow === 'function') window._assetsShow('overlays');
      if (wasBrands && typeof openSettings === 'function') openSettings('brandkits');
    } else if (typeof placeShowDeck === 'function') {
      // Dashboard is the active tab on load but no tab-button click fires for it — park the Show
      // Deck in the DCC's Show Deck tab now so it's there on first paint.
      placeShowDeck('principal');
    }
  });
}

// ── Right quick-actions rail: icon-only tabs, click-to-toggle panel, popout ──
const QRAIL_W_KEY = 'ne_qrail_w';
const QRAIL_W_MIN = 190, QRAIL_W_MAX = 680, QRAIL_W_DEFAULT = 360;   // 320 left ~230px of content — names/phases truncated
function qrailExpandedW() {
  const v = parseInt(localStorage.getItem(QRAIL_W_KEY) || '', 10);
  // Old saved values were 366+ (included 170px label column); clamp to new range.
  return (v >= QRAIL_W_MIN && v <= QRAIL_W_MAX) ? v : QRAIL_W_DEFAULT;
}
function setQrailExpandedW(px, persist) {
  const w = Math.max(QRAIL_W_MIN, Math.min(QRAIL_W_MAX, Math.round(px)));
  document.documentElement.style.setProperty('--qrail-w', w + 'px');
  if (persist) { try { localStorage.setItem(QRAIL_W_KEY, String(w)); } catch {} }
  return w;
}

// Collapse panel (keep icon strip visible).
function qrailCollapse() {
  const shell = el('app-shell');
  shell.classList.add('qrail-collapsed');
  document.documentElement.style.setProperty('--qrail-w', '58px');
  // Clear active tab highlight — no panel is open.
  document.querySelectorAll('#qrail-tabs .qrail-tab').forEach((b) => b.classList.remove('active'));
}
// Open (or switch to) a panel.
function qrailExpand(tab) {
  const shell = el('app-shell');
  shell.classList.remove('qrail-collapsed');
  setQrailExpandedW(qrailExpandedW(), false);
}

const QRAIL_TAB_TITLES = {
  // Match the tab captions (On Air·Up Next·Talent·Replay·Chat·Automation·Notes). Keys stay the
  // panels' data-qpanel names.
  controls: 'Controls', show: 'Show', quick: 'On Air', ros: 'Up Next', flows: 'Automation', talent: 'Talent',
  replay: 'Replay', twitch: 'Chat', notes: 'Notes',
  // legacy keys — their panels are merged away, kept so any direct caller still titles correctly.
  startgg: 'Up Next', graphics: 'On Air', golive: 'On Air', ai: 'Automation',
  workflow: 'Chat', checklist: 'Up Next',
};
function qrailShowTab(tab) {
  document.querySelectorAll('#qrail-tabs .qrail-tab').forEach((b) => b.classList.toggle('active', b.dataset.qtab === tab));
  document.querySelectorAll('.qrail-body .qrail-panel').forEach((p) => p.classList.toggle('active', p.dataset.qpanel === tab));
  const titleText = QRAIL_TAB_TITLES[tab] || '';
  const title = el('qrail-paneltitle'); if (title) title.textContent = titleText;
  // Live sections refresh as their tab opens (queue now lives under NEXT, AI under AUTO).
  if ((tab === 'ros' || tab === 'flows' || tab === 'talent') && typeof renderQrailLive === 'function') renderQrailLive();
  if (tab === 'show') { if (typeof renderQrailReplay === 'function') renderQrailReplay(currentState); if (typeof qrScanFolder === 'function') qrScanFolder(); if (typeof window._dockShowRender === 'function') window._dockShowRender(); }
  if (tab === 'replay' && typeof renderQrailReplay === 'function') { renderQrailReplay(currentState); if (typeof qrScanFolder === 'function') qrScanFolder(); }
  if (tab === 'talent' && typeof cfTalentAutoOpen === 'function') cfTalentAutoOpen();
  if (tab === 'twitch') setTimeout(() => { const c = el('twitch-chat'); if (c) c.scrollTop = c.scrollHeight; }, 100);
  qrailExpand(tab);
}

// Tab clicks: clicking the already-active tab collapses; clicking another switches.
document.querySelectorAll('#qrail-tabs .qrail-tab').forEach((b) => {
  if (!b.dataset.qtab) return;   // skip spacer/popout buttons
  b.addEventListener('click', () => {
    const shell = el('app-shell');
    const collapsed = shell.classList.contains('qrail-collapsed');
    // A popped-out dock window IS the dock: collapsing it would leave an empty window.
    if (!collapsed && b.classList.contains('active') && !document.body.classList.contains('popout-qrail')) {
      qrailCollapse();   // toggle off
    } else {
      qrailShowTab(b.dataset.qtab);
    }
  });
});

// Collapse button in panel header closes the panel.
el('qrail-collapse')?.addEventListener('click', qrailCollapse);

// Drag-to-resize the rail from its inner edge.
(function initQrailResize() {
  const handle = el('qrail-resize'); if (!handle) return;
  let dragging = false, startX = 0, startW = 0;
  const onMove = (e) => {
    if (!dragging) return;
    const swapped = document.body.classList.contains('sides-swapped');
    const delta = swapped ? (e.clientX - startX) : (startX - e.clientX);
    setQrailExpandedW(startW + delta, false);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    setQrailExpandedW(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--qrail-w'), 10) || QRAIL_W_DEFAULT, true);
    window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
  };
  handle.addEventListener('mousedown', (e) => {
    if (el('app-shell')?.classList.contains('qrail-collapsed')) return;
    dragging = true; startX = e.clientX;
    startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--qrail-w'), 10) || qrailExpandedW();
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
})();

// Apply saved rail width on load.
if (!el('app-shell')?.classList.contains('qrail-collapsed')) setQrailExpandedW(qrailExpandedW(), false);

// ── Popout: open the qrail in a separate window, hide it from the main app ──
const QRAIL_POPPED_KEY = 'ne_qrail_popped';
let _qrailPopup = null;
let _qrailPollInterval = null;

function qrailSetPopped(popped) {
  const shell = el('app-shell');
  const strip = el('qrail-popout-strip');
  if (shell) shell.classList.toggle('qrail-popped', popped);
  if (strip) strip.style.display = popped ? '' : 'none';
}

function qrailPopout() {
  if (_qrailPopup && !_qrailPopup.closed) { _qrailPopup.focus(); return; }
  const w = screen.width >= 1400 ? 400 : 360, h = Math.min(screen.height - 80, 900);
  const left = screen.width - w - 20, top = 40;
  _qrailPopup = window.open(
    'index.html?page=qrail-popout',
    'ne-qrail-popout',
    `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=no`
  );
  if (!_qrailPopup) return;   // blocked by browser
  qrailSetPopped(true);
  try { localStorage.setItem(QRAIL_POPPED_KEY, '1'); } catch {}
  // Poll until the popup closes, then restore the rail.
  _qrailPollInterval = setInterval(() => {
    if (_qrailPopup && _qrailPopup.closed) {
      clearInterval(_qrailPollInterval);
      _qrailPopup = null;
      qrailSetPopped(false);
      try { localStorage.removeItem(QRAIL_POPPED_KEY); } catch {}
    }
  }, 800);
}

function qrailReclaim() {
  if (_qrailPopup && !_qrailPopup.closed) _qrailPopup.close();
  clearInterval(_qrailPollInterval);
  _qrailPopup = null;
  qrailSetPopped(false);
  try { localStorage.removeItem(QRAIL_POPPED_KEY); } catch {}
}

el('qrail-popout-btn')?.addEventListener('click', qrailPopout);
el('qrail-reclaim')?.addEventListener('click', qrailReclaim);

// Popout window mode: hide everything else, make qrail full-screen.
const _qrailPopoutMode = new URLSearchParams(window.location.search).get('page') === 'qrail-popout';
if (_qrailPopoutMode) {
  document.body.classList.add('popout-qrail');
  // Show return button, hide popout button.
  const retBtn = el('qrail-return'); if (retBtn) retBtn.style.display = '';
  const popBtn = el('qrail-popout-btn'); if (popBtn) popBtn.style.display = 'none';
  // Make sure first tab is open.
  requestAnimationFrame(() => {
    // The strip's first button is the hidden Graphics storage tab; open On Air (or the last-used tab).
    let last = null; try { last = localStorage.getItem('ne_mx_dock'); } catch (e) {}
    const firstTab = (last && document.querySelector('#qrail-tabs .qrail-tab[data-qtab="' + last + '"]'))
      || document.querySelector('#qrail-tabs .qrail-tab[data-qtab="controls"]')
      || document.querySelector('#qrail-tabs .qrail-tab[data-qtab]');
    if (firstTab && !firstTab.classList.contains('active')) firstTab.click();
    else if (firstTab && typeof qrailShowTab === 'function') qrailShowTab(firstTab.dataset.qtab);
  });
}
// Return button (inside popout window) closes the popup.
el('qrail-return')?.addEventListener('click', () => window.close());

// Header Settings gear → open the Settings tab (its sidebar nav item is hidden).
el('btn-header-settings')?.addEventListener('click', () => document.getElementById('tab-ajustes')?.click());
el('topbar-update-chip')?.addEventListener('click', () => document.getElementById('tab-ajustes')?.click());

// ── Discord OAuth & Roles ─────────────────────────────────────────────────────

let _discordDropdownOpen = false;
let _rolesPendingTeamId = null;   // which team the add-member modal targets
let _authInitialized = false;     // true after first state arrival — guards bloom vs instant-hide

// Pop-out windows (opened from the already-signed-in main window) carry a ?page= param —
// they must NEVER show the auth gate, or it flashes on every pop-out.
const _isPopout = new URLSearchParams(location.search).has('page');

// Require Discord sign-in: the studio is gated behind the login/loading screen until the user is
// signed in. Set false to make login optional (the header chip still offers it).
const REQUIRE_DISCORD_LOGIN = true;

// Swap the gate between LOGIN (logo + Discord button), LOADING (splash: breathing logo +
// scan bar) and CONTRACT (license e-sign) sub-screens. ag-loading drives the animations.
function authGateMode(mode, msg) {
  const login = el('auth-gate-login'), loading = el('auth-gate-loading'), contract = el('auth-gate-contract');
  if (login) login.style.display = mode === 'login' ? '' : 'none';
  if (loading) loading.style.display = mode === 'loading' ? '' : 'none';
  if (contract) contract.style.display = mode === 'contract' ? '' : 'none';
  const gate = el('auth-gate');
  if (gate) {
    gate.classList.toggle('ag-loading', mode === 'loading');
    const card = gate.querySelector('.auth-gate-card');
    if (card) card.classList.toggle('contract-mode', mode === 'contract');
  }
  if (mode === 'loading' && msg) { const m = el('auth-gate-loading-msg'); if (m) m.textContent = msg; }
}

// First sign-in after approval: the backend wants the license signed — show it in the gate.
function gateEnterContract() {
  fetch(`${DISCORD_API_BASE}/api/cloud/contract`)
    .then(r => r.json())
    .then(d => {
      if (!d || !d.pending) { authGateMode('login'); return; }
      const lic = d.license || {};
      const title = el('gate-lic-title'); if (title) title.textContent = lic.title || 'License Agreement';
      const box = el('gate-lic-box');
      if (box) {
        box.textContent = '';
        if (lic.preamble) { const p = document.createElement('p'); p.textContent = lic.preamble; box.appendChild(p); }
        (lic.sections || []).forEach(sec => {
          const h = document.createElement('h3'); h.textContent = sec.title; box.appendChild(h);
          (sec.clauses || []).forEach(c => { const cp = document.createElement('p'); cp.textContent = c; box.appendChild(cp); });
        });
      }
      const n = el('gate-lic-note'); if (n) n.textContent = '';
      authGateMode('contract');
    })
    .catch(() => authGateMode('login'));
}
el('gate-lic-accept')?.addEventListener('click', async () => {
  const name = (el('gate-lic-name')?.value || '').trim();
  const n = el('gate-lic-note');
  if (name.length < 3) { if (n) { n.style.color = '#f87171'; n.textContent = 'Type your full legal name to sign the agreement.'; } return; }
  const btn = el('gate-lic-accept'); if (btn) btn.disabled = true;
  if (n) { n.style.color = ''; n.textContent = 'Recording your signature…'; }
  try {
    const r = await fetch(`${DISCORD_API_BASE}/api/cloud/contract/accept`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signatureName: name })
    });
    const d = await r.json();
    if (d && d.ok) {
      // Signed in — the full_state broadcast takes it from here (load animation + bloom).
      authGateMode('loading', 'Loading your studio…');
    } else if (n) { n.style.color = '#f87171'; n.textContent = (d && d.message) || 'Could not record the signature — try again.'; }
  } catch (e) {
    if (n) { n.style.color = '#f87171'; n.textContent = 'Could not reach the app server — try again.'; }
  } finally { if (btn) btn.disabled = false; }
});

// Splash-style reveal: hold the loading screen so the scan animation reads, then bloom into the app.
// Re-entrant-safe: every full_state broadcast lands here while the gate is still visible.
function gateBloomOut(gate, holdMs) {
  if (gate._blooming) return;
  gate._blooming = true;
  setTimeout(() => {
    gate.classList.add('gate-expanding');
    setTimeout(() => gate.classList.add('gate-hiding'), 200);
    setTimeout(() => {
      gate.style.display = 'none';
      gate.classList.remove('gate-expanding', 'gate-hiding');
      gate._blooming = false;
      authGateMode('login');
    }, 600);
  }, holdMs);
}

// The gate is visible (LOADING) from the very first paint — it IS the splash screen now
// (the old splash.html window is gone). Resolve the session: signed in → applyDiscordState
// blooms into the app; not signed in → switch to the login screen. If the status check
// fails, fall back to the login screen so they can still sign in.
(function checkDiscordSession() {
  if (_isPopout || !REQUIRE_DISCORD_LOGIN) {
    // Pop-out, or login-optional build → never gate (markup defaults visible; hide it now).
    const g = el('auth-gate'); if (g) g.style.display = 'none';
    return;
  }
  const gate = el('auth-gate');
  if (gate) { gate.style.display = ''; authGateMode('loading', 'Loading…'); }
  const toLogin = () => authGateMode('login');
  const fallback = setTimeout(toLogin, 3500);
  fetch('http://127.0.0.1:3000/api/oauth/discord/status')
    .then(r => r.json())
    .then(d => { clearTimeout(fallback); if (!d.connected) toLogin(); })   // signed in → gate hides via applyDiscordState
    .catch(() => { clearTimeout(fallback); toLogin(); });
})();

function applyDiscordState(discord) {
  if (!discord) return;
  const loggedIn = !!discord.connected;

  // Auth gate — only bloom on active login; instant-hide if already logged in on open
  const gate = el('auth-gate');
  if (gate) {
    if (_isPopout) {
      gate.style.display = 'none';   // pop-out windows never gate (inherit the main session)
    } else if (loggedIn && gate.style.display !== 'none') {
      if (!_authInitialized) {
        // App opened while already signed in — let the splash animation play a beat, then bloom.
        authGateMode('loading', 'Loading your studio…');
        gateBloomOut(gate, 900);
      } else {
        // User just signed in this session → brief "Loading your studio…", then bloom into the app.
        authGateMode('loading', 'Loading your studio…');
        gateBloomOut(gate, 1400);
      }
    } else if (!loggedIn) {
      gate.classList.remove('gate-expanding', 'gate-hiding');
      if (REQUIRE_DISCORD_LOGIN) {
        gate.style.display = '';
        authGateMode('login');
        // Forced sign-out (e.g. access revoked server-side) — show the reason, linkified.
        const n = el('auth-gate-note');
        if (n && discord.lastError) n.innerHTML = linkifyAuthMsg(discord.lastError);
      }
      else gate.style.display = 'none';
    }
  }
  _authInitialized = true;

  const loginBtn  = el('btn-discord-login');
  const avatarBtn = el('btn-discord-avatar');
  const avatarImg = el('discord-avatar-img');
  const profile   = el('ddd-profile');
  const dddAvatar = el('ddd-avatar');
  const dddName   = el('ddd-name');
  const dddTag    = el('ddd-tag');
  const logoutSep = el('ddd-sep-logout');
  const logoutBtn = el('ddd-logout');

  // Logged out → show the Discord login chip (with the Discord logo); logged in → show the avatar.
  if (loginBtn) loginBtn.style.display  = loggedIn ? 'none' : '';
  if (avatarBtn) avatarBtn.style.display = loggedIn ? '' : 'none';

  if (loggedIn) {
    const url = discord.avatarUrl || '';
    if (avatarImg) avatarImg.src = url;
    if (dddAvatar) dddAvatar.src = url;
    if (dddName) dddName.textContent = discord.globalName || discord.username || '';
    const tag = discord.discriminator && discord.discriminator !== '0'
      ? `@${discord.username}#${discord.discriminator}`
      : `@${discord.username}`;
    if (dddTag) dddTag.textContent = tag;
    if (profile) profile.style.display = '';
    if (logoutSep) logoutSep.style.display = '';
    if (logoutBtn) logoutBtn.style.display = '';

    // Mirror into Roles page profile
    const rAvatar = el('roles-profile-avatar');
    const rName   = el('roles-profile-name');
    const rTag    = el('roles-profile-tag');
    if (rAvatar) rAvatar.src = url;
    if (rName) rName.textContent = discord.globalName || discord.username || '';
    if (rTag) rTag.textContent = tag;
  } else {
    if (profile) profile.style.display = 'none';
    if (logoutSep) logoutSep.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }

  // Roles page: show main or login prompt
  const prompt = el('roles-login-prompt');
  const main   = el('roles-main');
  if (prompt) prompt.style.display = loggedIn ? 'none' : '';
  if (main) main.style.display = loggedIn ? '' : 'none';
}

function toggleDiscordDropdown(force) {
  const dd = el('discord-dropdown');
  if (!dd) return;
  _discordDropdownOpen = force !== undefined ? force : !_discordDropdownOpen;
  dd.style.display = _discordDropdownOpen ? '' : 'none';
}

const DISCORD_API_BASE = 'http://127.0.0.1:3000';

async function discordLogin() {
  try {
    const r = await fetch(`${DISCORD_API_BASE}/api/oauth/discord/init`, { method: 'POST' });
    const data = await r.json();
    if (data.error) { showToast('Discord login error: ' + data.error, '#c53030', 5000); return; }
    if (window.electronAPI?.openDiscordOAuth) {
      window.electronAPI.openDiscordOAuth(data.url);
    } else {
      window.open(data.url, '_blank');
    }
    pollDiscordLogin();   // don't rely on a single WS broadcast — poll status until the server confirms
  } catch (err) {
    showToast('Could not start Discord login: ' + err.message, '#c53030', 5000);
  }
}

// After starting OAuth, poll the server for the resulting session so the app signs in the moment
// the callback completes — even if the one-shot WS broadcast is missed (auth happened in a separate
// window/browser, WS was mid-reconnect, etc.). Stops on success or after ~3 min.
let _discordPollTimer = null;
// Auth errors from the Nameless backend can point at the studio site ("apply at
// https://studio.namelessesports.com") — render those URLs as real links. Everything
// is escaped first; target=_blank routes through the window-open handler, which
// opens the system browser.
function linkifyAuthMsg(text) {
  const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc.replace(/https:\/\/[^\s<>"]*[^\s<>".,)!?]/g, (url) =>
    `<a href="${url}" target="_blank" rel="noopener" style="color:#7dd3fc; text-decoration:underline;">${url.replace(/^https:\/\//, '')}</a>`);
}
function pollDiscordLogin() {
  if (_discordPollTimer) return;
  const startedAt = Date.now();
  const backToLogin = (note) => {   // return the gate to the login screen (so the user can retry)
    if (typeof authGateMode === 'function') authGateMode('login');
    const n = el('auth-gate-note'); if (n && note) n.innerHTML = linkifyAuthMsg(note);
  };
  _discordPollTimer = setInterval(async () => {
    if (Date.now() - startedAt > 180000) { clearInterval(_discordPollTimer); _discordPollTimer = null; backToLogin('Login timed out — try again.'); return; }
    try {
      const s = await (await fetch(`${DISCORD_API_BASE}/api/oauth/discord/status`)).json();
      if (s && s.connected) {
        clearInterval(_discordPollTimer); _discordPollTimer = null;
        if (currentState) currentState.discord = { ...(currentState.discord || {}), ...s };
        applyDiscordState(s);
        showToast('Signed in as ' + (s.globalName || s.username || 'Discord user'), '#22c55e');
      } else if (s && s.needsContract) {
        // Approved, license unsigned — collect the e-signature right here in the gate.
        clearInterval(_discordPollTimer); _discordPollTimer = null;
        const gate = el('auth-gate'); if (gate) gate.style.display = '';
        gateEnterContract();
      } else if (s && s.lastError) {
        // The callback ran but the code exchange failed — stop polling, say why, back to login.
        clearInterval(_discordPollTimer); _discordPollTimer = null;
        showToast('Discord login failed: ' + s.lastError, '#c53030', 8000);
        backToLogin(s.lastError);
      }
    } catch (e) { /* server momentarily unreachable — keep polling */ }
  }, 1500);
}

async function discordLogout() {
  try {
    await fetch(`${DISCORD_API_BASE}/api/oauth/discord/logout`, { method: 'POST' });
    toggleDiscordDropdown(false);
  } catch (err) {
    console.error('[Discord] Logout failed:', err.message);
  }
}

// Auth gate button
el('auth-gate-btn')?.addEventListener('click', async () => {
  const note = el('auth-gate-note');
  if (note) note.textContent = '';
  await discordLogin();
  // Show the loading spinner while the browser window completes the login; applyDiscordState swaps to
  // "Loading your studio…" on success, and pollDiscordLogin flips back to the login screen if it fails.
  authGateMode('loading', 'Waiting for Discord… finish in the window that opened.');
});

// Dropdown toggle
el('btn-discord-login')?.addEventListener('click', discordLogin);
el('btn-discord-avatar')?.addEventListener('click', (e) => { e.stopPropagation(); toggleDiscordDropdown(); });
document.addEventListener('click', (e) => {
  if (_discordDropdownOpen && !el('discord-user-area')?.contains(e.target)) toggleDiscordDropdown(false);
});

// Dropdown item actions
el('ddd-settings')?.addEventListener('click', () => {
  toggleDiscordDropdown(false);
  document.getElementById('tab-ajustes')?.click();
});
el('ddd-bug')?.addEventListener('click', () => {
  toggleDiscordDropdown(false);
  el('btn-bug-report')?.click();
});
el('ddd-feature')?.addEventListener('click', () => {
  toggleDiscordDropdown(false);
  // trigger feature mode directly
  if (typeof setBugMode === 'function') setBugMode('feature');
  el('btn-bug-report')?.click();
});
el('ddd-roles')?.addEventListener('click', () => {
  toggleDiscordDropdown(false);
  document.getElementById('tab-roles')?.click();
});
el('ddd-logout')?.addEventListener('click', async () => {
  const ok = await appConfirm('Sign out of Discord? Signing back in is required before the app is usable again, including mid-broadcast.', 'Sign Out');
  if (ok) discordLogout();
});

// Roles page login button mirrors header login
el('roles-discord-login-btn')?.addEventListener('click', discordLogin);
// Website email/password login — same shared Nameless account database.
el('cloud-login-btn')?.addEventListener('click', () => {
  const email = (el('cloud-login-email')?.value || '').trim();
  const pass = el('cloud-login-pass')?.value || '';
  if (!email || !pass) { showToast('Enter your email and password.', '#fbbf24'); return; }
  const st = el('cloud-login-status');
  if (st) { st.style.display = ''; st.style.color = 'var(--muted)'; st.textContent = 'Signing in…'; }
  send('cloud_email_login', { email, password: pass });
});
el('cloud-login-pass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('cloud-login-btn')?.click(); });

// ── Roles / Teams ─────────────────────────────────────────────────────────────

let _rolesData = { teams: [] };

async function loadRoles() {
  try {
    const r = await fetch(`${DISCORD_API_BASE}/api/roles`);
    _rolesData = await r.json();
    renderRoles();
  } catch (err) {
    console.error('[Roles] load failed', err.message);
  }
}

function renderRoles() {
  const list = el('roles-teams-list');
  if (!list) return;
  if (!_rolesData.teams || !_rolesData.teams.length) {
    list.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0">No teams yet — create one above.</p>';
    return;
  }
  list.innerHTML = _rolesData.teams.map((team) => `
    <div class="roles-team-card" data-team-id="${team.id}">
      <div class="roles-team-header">
        <input class="roles-team-name" data-team-id="${team.id}" value="${escHtml(team.name)}" title="Click to rename">
        <div class="roles-team-actions">
          <button class="btn btn-secondary btn-sm roles-add-member-btn" data-team-id="${team.id}">+ Member</button>
          <button class="btn btn-danger btn-sm roles-del-team-btn" data-team-id="${team.id}">Delete</button>
        </div>
      </div>
      <div class="roles-member-list">
        ${(team.members || []).length === 0
          ? '<span style="font-size:12px;color:var(--muted)">No members yet.</span>'
          : (team.members || []).map((m) => `
            <div class="roles-member-row">
              ${m.avatarUrl ? `<img src="${escHtml(m.avatarUrl)}" style="width:22px;height:22px;border-radius:50%;flex-shrink:0" alt="">` : ''}
              <span class="roles-member-tag">${escHtml(m.globalName || m.username)}</span>
              <span class="roles-member-role">${escHtml(m.role)}</span>
              <button class="roles-member-del" data-team-id="${team.id}" data-member-username="${escHtml(m.username)}" title="Remove">&#215;</button>
            </div>`).join('')
        }
      </div>
    </div>`).join('');

  // Wire rename
  list.querySelectorAll('.roles-team-name').forEach((inp) => inp.addEventListener('change', async () => {
    const tid = inp.dataset.teamId;
    const team = _rolesData.teams.find((t) => t.id === tid);
    if (!team || !inp.value.trim()) return;
    await fetch(`${DISCORD_API_BASE}/api/roles/teams/${tid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: inp.value.trim() }) });
    await loadRoles();
  }));

  // Wire delete team
  list.querySelectorAll('.roles-del-team-btn').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await appConfirm('Delete this team?', 'Delete')) return;
    await fetch(`${DISCORD_API_BASE}/api/roles/teams/${btn.dataset.teamId}`, { method: 'DELETE' });
    await loadRoles();
  }));

  // Wire add member
  list.querySelectorAll('.roles-add-member-btn').forEach((btn) => btn.addEventListener('click', () => {
    _rolesPendingTeamId = btn.dataset.teamId;
    openAddMemberModal();
  }));

  // Wire remove member
  list.querySelectorAll('.roles-member-del').forEach((btn) => btn.addEventListener('click', async () => {
    const tid = btn.dataset.teamId;
    const team = _rolesData.teams.find((t) => t.id === tid);
    if (!team) return;
    team.members = (team.members || []).filter((m) => m.username !== btn.dataset.memberUsername);
    await fetch(`${DISCORD_API_BASE}/api/roles/teams/${tid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ members: team.members }) });
    await loadRoles();
  }));
}

// ── Add Member modal — with user search ───────────────────────────────────────
let _pendingMember = null;   // { discordId, username, globalName, avatarUrl } from search result
let _searchTimer   = null;

function openAddMemberModal() {
  _pendingMember = null;
  const modal = el('roles-add-member-modal');
  const inp   = el('roles-member-search');
  const sel   = el('roles-member-selected');
  const res   = el('roles-user-results');
  if (inp)  { inp.value = ''; }
  if (sel)  { sel.style.display = 'none'; }
  if (res)  { res.style.display = 'none'; res.innerHTML = ''; }
  if (modal) modal.style.display = '';
  if (inp)   inp.focus();
}

async function searchUsers(q) {
  const res = el('roles-user-results');
  if (!res) return;
  if (!q || q.length < 2) { res.style.display = 'none'; res.innerHTML = ''; return; }
  try {
    const r = await fetch(`${DISCORD_API_BASE}/api/broadcast-users/search?q=${encodeURIComponent(q)}`);
    const data = await r.json();
    const users = data.users || [];
    if (!users.length) {
      res.innerHTML = `<div class="roles-user-no-results">No registered users found for "${escHtml(q)}"</div>`;
    } else {
      res.innerHTML = users.map(u => `
        <div class="roles-user-result-item" data-discord-id="${escHtml(u.discord_id)}"
             data-username="${escHtml(u.username)}" data-global-name="${escHtml(u.global_name || u.username)}"
             data-avatar-url="${escHtml(u.avatar_url || '')}">
          <img src="${escHtml(u.avatar_url || '')}" alt="" onerror="this.style.display='none'">
          <div>
            <div class="roles-user-result-name">${escHtml(u.global_name || u.username)}</div>
            <div class="roles-user-result-tag">@${escHtml(u.username)}</div>
          </div>
        </div>`).join('');
      res.querySelectorAll('.roles-user-result-item').forEach(item => {
        item.addEventListener('click', () => selectMember({
          discordId:  item.dataset.discordId,
          username:   item.dataset.username,
          globalName: item.dataset.globalName,
          avatarUrl:  item.dataset.avatarUrl,
        }));
      });
    }
    res.style.display = '';
  } catch (e) {
    res.innerHTML = `<div class="roles-user-no-results">Search unavailable</div>`;
    res.style.display = '';
  }
}

function selectMember(user) {
  _pendingMember = user;
  const inp  = el('roles-member-search');
  const res  = el('roles-user-results');
  const sel  = el('roles-member-selected');
  const name = el('roles-sel-name');
  const tag  = el('roles-sel-tag');
  const av   = el('roles-sel-avatar');
  if (inp) inp.value = '';
  if (res) { res.style.display = 'none'; res.innerHTML = ''; }
  if (av)   av.src = user.avatarUrl || '';
  if (name) name.textContent = user.globalName || user.username;
  if (tag)  tag.textContent  = '@' + user.username;
  if (sel)  sel.style.display = '';
}

el('roles-member-search')?.addEventListener('input', function () {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => searchUsers(this.value.trim()), 250);
});
el('roles-member-search')?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { const r = el('roles-user-results'); if (r) { r.style.display = 'none'; r.innerHTML = ''; } }
});
// Up/Down/Enter to pick a user without leaving the keyboard.
NESearch.bindListNav(el('roles-member-search'), el('roles-user-results'), '.roles-user-result-item');
// Close results when clicking outside
document.addEventListener('click', (e) => {
  const wrap = el('roles-add-member-modal');
  const res  = el('roles-user-results');
  if (res && wrap && !wrap.contains(e.target)) { res.style.display = 'none'; }
});
el('roles-sel-clear')?.addEventListener('click', () => {
  _pendingMember = null;
  const sel = el('roles-member-selected');
  const inp = el('roles-member-search');
  if (sel) sel.style.display = 'none';
  if (inp) { inp.value = ''; inp.focus(); }
});

// New team form
el('roles-new-team-btn')?.addEventListener('click', () => {
  const form = el('roles-new-team-form');
  if (form) { form.style.display = ''; el('roles-new-team-name')?.focus(); }
});
el('roles-new-team-cancel')?.addEventListener('click', () => {
  const form = el('roles-new-team-form');
  if (form) form.style.display = 'none';
});
el('roles-new-team-save')?.addEventListener('click', async () => {
  const inp = el('roles-new-team-name');
  if (!inp || !inp.value.trim()) return;
  await fetch(`${DISCORD_API_BASE}/api/roles/teams`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: inp.value.trim() }) });
  inp.value = '';
  el('roles-new-team-form').style.display = 'none';
  await loadRoles();
});

el('roles-add-member-cancel')?.addEventListener('click', () => {
  const modal = el('roles-add-member-modal');
  if (modal) modal.style.display = 'none';
  _rolesPendingTeamId = null;
  _pendingMember = null;
});
el('roles-add-member-save')?.addEventListener('click', async () => {
  if (!_rolesPendingTeamId || !_pendingMember) return;
  const role = el('roles-member-role')?.value || 'Producer';
  const team = _rolesData.teams.find((t) => t.id === _rolesPendingTeamId);
  if (!team) return;
  const newMember = {
    discordId:  _pendingMember.discordId,
    username:   _pendingMember.username,
    globalName: _pendingMember.globalName,
    avatarUrl:  _pendingMember.avatarUrl,
    role,
  };
  const members = [...(team.members || []), newMember];
  await fetch(`${DISCORD_API_BASE}/api/roles/teams/${_rolesPendingTeamId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ members }) });
  el('roles-add-member-modal').style.display = 'none';
  _rolesPendingTeamId = null;
  _pendingMember = null;
  await loadRoles();
});

// Load roles when the tab becomes active
document.getElementById('tab-roles')?.addEventListener('click', loadRoles);

// Helper
function escHtml(s) { return esc(s); }   // legacy alias — canonical esc() lives at the top of the file

// ── Bug report / Feature request → Discord webhook (via the server) ──
function bugStatus(msg, ok) { const s = el('bug-status'); if (s) { s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)'); } }

let _bugMode = 'bug'; // 'bug' | 'feature'
function setBugMode(mode) {
  _bugMode = mode;
  const isBug = mode === 'bug';
  const titleText = el('bug-modal-title-text');
  if (titleText) titleText.textContent = isBug ? 'Report a bug' : 'Feature Request';
  const titleIcon = el('bug-modal-icon');
  if (titleIcon) titleIcon.style.display = isBug ? '' : 'none';
  el('bug-title-label').textContent  = isBug ? 'Title' : 'Feature title';
  el('bug-desc-label').textContent   = isBug ? 'What happened?' : 'Describe the feature';
  el('bug-desc').placeholder         = isBug
    ? 'Steps to reproduce, what you expected, what actually happened…'
    : 'What would it do? What problem does it solve for you?';
  el('bug-severity-row').style.display  = isBug ? '' : 'none';
  el('bug-priority-row').style.display  = isBug ? 'none' : '';
  el('bug-image-row').style.display     = isBug ? '' : 'none';
  el('bug-send').textContent            = isBug ? 'Send report' : 'Submit request';
  const tabBug = el('bug-tab-bug'), tabFeat = el('bug-tab-feature');
  const accent = 'var(--cp-accent)';
  tabBug.style.cssText  = isBug  ? `background:${accent};color:#fff;border-color:${accent}` : '';
  tabFeat.style.cssText = !isBug ? `background:${accent};color:#fff;border-color:${accent}` : '';
  if (!isBug) { tabFeat.className = 'btn btn-sm'; tabBug.className = 'btn btn-ghost btn-sm'; }
  else        { tabBug.className  = 'btn btn-sm'; tabFeat.className = 'btn btn-ghost btn-sm'; }
}
el('bug-tab-bug')?.addEventListener('click', () => setBugMode('bug'));
el('bug-tab-feature')?.addEventListener('click', () => setBugMode('feature'));

el('btn-bug-report')?.addEventListener('click', () => {
  const m = el('bug-report-modal');
  if (m) {
    m.style.display = 'flex';
    bugStatus('');
    setBugMode('bug');
    if (typeof setBugImage === 'function') setBugImage(null);
    const sb = el('bug-send'); if (sb) sb.disabled = false;
    const ghRow = el('bug-github-link-row'); if (ghRow) ghRow.style.display = 'none';
    const cp = el('bug-console-preview'); if (cp) cp.style.display = 'none';
    const cpBtn = el('bug-console-preview-btn'); if (cpBtn) cpBtn.textContent = 'Preview';
    setTimeout(() => el('bug-title')?.focus(), 0);
  }
});
el('bug-close')?.addEventListener('click', () => { const m = el('bug-report-modal'); if (m) m.style.display = 'none'; });
el('bug-report-modal')?.addEventListener('click', (e) => { if (e.target === el('bug-report-modal')) el('bug-report-modal').style.display = 'none'; });

// Optional screenshot (data URL) attached to the report.
let _bugImage = null;
function setBugImage(dataUrl) {
  _bugImage = dataUrl || null;
  const prev = el('bug-image-preview'), name = el('bug-image-name'), clr = el('bug-image-clear');
  if (_bugImage) {
    if (prev) { prev.src = _bugImage; prev.style.display = 'block'; }
    if (name) name.textContent = 'Image attached';
    if (clr) clr.style.display = '';
  } else {
    if (prev) { prev.src = ''; prev.style.display = 'none'; }
    if (name) name.textContent = 'No image';
    if (clr) clr.style.display = 'none';
    const f = el('bug-image-file'); if (f) f.value = '';
  }
}
function loadBugImageFile(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  if (file.size > 8 * 1024 * 1024) { bugStatus('Image too large (max 8 MB).', false); return; }
  const reader = new FileReader();
  reader.onload = () => setBugImage(reader.result);
  reader.readAsDataURL(file);
}
el('bug-image-file')?.addEventListener('change', function () { loadBugImageFile(this.files && this.files[0]); });
el('bug-image-clear')?.addEventListener('click', () => setBugImage(null));
// Paste a screenshot straight into the modal (Ctrl+V).
el('bug-report-modal')?.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items; if (!items) return;
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) { loadBugImageFile(f); e.preventDefault(); break; } }
  }
});
// Let the reporter see exactly what console output would be attached before sending it.
el('bug-console-preview-btn')?.addEventListener('click', function () {
  const ta = el('bug-console-preview'); if (!ta) return;
  const show = ta.style.display === 'none';
  if (show) ta.value = getConsoleBufferText() || '(no console output captured yet)';
  ta.style.display = show ? '' : 'none';
  this.textContent = show ? 'Hide' : 'Preview';
});

el('bug-send')?.addEventListener('click', async () => {
  const title = (el('bug-title')?.value || '').trim();
  const description = (el('bug-desc')?.value || '').trim();
  if (!title && !description) { bugStatus('Add a title or a description first.', false); return; }
  const gameId = currentState.activeGame;
  const gameName = (currentState.games && gameId && currentState.games[gameId] && currentState.games[gameId].name) || gameId || '';
  const activeTabBtn = document.querySelector('.tab-btn.active');
  const page = activeTabBtn ? (activeTabBtn.querySelector('.nav-label')?.textContent || activeTabBtn.dataset.tab) : '';
  const btn = el('bug-send'); btn.disabled = true; bugStatus('Sending…');
  // Hard timeout so a slow/unreachable server can never freeze the button on "Sending…".
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch('http://127.0.0.1:3000/api/bug-report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({
        type: _bugMode,
        title, description,
        category: el('bug-category')?.value || '',
        severity: el('bug-severity')?.value || 'medium',
        priority: el('bug-priority')?.value || '',
        reporter: (el('bug-reporter')?.value || '').trim(),
        image: _bugMode === 'bug' ? (_bugImage || undefined) : undefined,
        consoleLog: el('bug-include-console')?.checked ? (getConsoleBufferText() || undefined) : undefined,
        context: { game: gameName, page, app: 'NE Broadcast Suite' }
      })
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      // Partial failure (e.g. Discord sent but GitHub rejected it, or vice versa) still counts as
      // an overall success — surface the detail rather than hiding it behind a plain "Sent".
      bugStatus(d.message ? `Sent (${d.message})` : 'Sent — thanks!', true);
      el('bug-title').value = ''; el('bug-desc').value = ''; setBugImage(null);
      const ghRow = el('bug-github-link-row'), ghLink = el('bug-github-link');
      if (d.githubUrl && ghRow && ghLink) {
        ghLink.href = d.githubUrl;
        ghRow.style.display = '';
      } else {
        setTimeout(() => { el('bug-report-modal').style.display = 'none'; }, 1100);
      }
    } else { bugStatus(d.message || 'Failed to send.', false); }
  } catch (e) {
    bugStatus(e.name === 'AbortError' ? 'Timed out reaching the server — is it running?' : ('Could not reach the server: ' + e.message), false);
  } finally { clearTimeout(timer); btn.disabled = false; }
});

// ── Software updates (electron-updater in main.js, driven over the WS bridge) ──
function renderUpdateStatus(s) {
  s = s || {};
  syncGateUpdateStatus(s);
  const status = el("upd-status"), prog = el("upd-progress"), fill = el("upd-progress-fill"), notes = el("upd-notes");
  const bCheck = el("upd-check"), bInst = el("upd-install");
  const badge = el('upd-badge');
  const cur = el('upd-current'); if (cur && s.currentVersion) cur.textContent = 'v' + s.currentVersion;
  const show = (e, on) => { if (e) e.style.display = on ? '' : 'none'; };
  show(prog, false); show(bInst, false);
  if (bCheck) bCheck.disabled = false;
  if (notes) { notes.style.display = 'none'; notes.textContent = ''; }
  const msg = (t, color) => { if (status) { status.textContent = t; status.style.color = color || 'var(--muted)'; } };
  // Actionable update → show the topbar chip (the gear icon is hidden now) + dropdown dot
  const hasBadge = s.state === 'available' || s.state === 'downloading' || s.state === 'downloaded';
  show(badge, hasBadge);
  const chip = el('topbar-update-chip'), chipTxt = el('topbar-update-txt');
  if (chip) {
    chip.style.display = hasBadge ? '' : 'none';
    if (chipTxt) chipTxt.textContent =
      s.state === 'downloading' ? ('Downloading ' + (s.percent || 0) + '%')
      : s.state === 'downloaded' ? 'Update ready — restart'
      : 'Update available';
  }
  const dddBadge = el('upd-badge-ddd');
  if (dddBadge) dddBadge.style.display = hasBadge ? '' : 'none';
  switch (s.state) {
    case 'checking': msg('Checking for updates…'); if (bCheck) bCheck.disabled = true; break;
    case 'up-to-date': msg("You're on the latest version.", 'var(--good,#48bb78)'); break;
    case 'available':
      msg('Update available: v' + s.version + ' — downloading…', 'var(--cp-accent,#7C3AED)');
      if (bCheck) bCheck.disabled = true;
      if (notes && s.notes) { notes.textContent = s.notes; notes.style.display = ''; }
      break;
    case 'downloading':
      msg('Downloading update… ' + (s.percent || 0) + '%');
      show(prog, true); if (fill) fill.style.width = (s.percent || 0) + '%';
      if (bCheck) bCheck.disabled = true;
      break;
    case 'downloaded': msg('Update v' + s.version + ' ready to install.', 'var(--good,#48bb78)'); show(bInst, true); break;
    case 'error': msg('Update error: ' + (s.message || 'unknown'), '#f56565'); break;
    case 'dev': msg('Updates run only in the installed build (you\'re running from source).'); if (bCheck) bCheck.disabled = true; break;
    default: msg('Click "Check for updates" to look for a new version.');
  }
}
el('upd-check')?.addEventListener('click', () => { renderUpdateStatus({ state: 'checking', currentVersion: currentState && currentState.version }); send('check_for_update'); });
el('upd-install')?.addEventListener('click', () => send('install_update'));

// Gate "Check for Updates" — called from onclick attribute on the button (guaranteed to fire)
function gateCheckUpdates() {
  const btn = el('auth-gate-upd-btn');
  const status = el('auth-gate-upd-status');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Checking for updates…';
  send('check_for_update');
  // If WS is not yet connected, show a fallback immediately so the user sees feedback
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (status) status.textContent = 'Not connected yet — try again in a moment.';
    if (btn) btn.disabled = false;
  }
}

function syncGateUpdateStatus(s) {
  const btn = el('auth-gate-upd-btn');
  const status = el('auth-gate-upd-status');
  if (!btn && !status) return;
  if (btn) btn.disabled = s.state === 'checking' || s.state === 'downloading';
  if (!status) return;
  switch (s.state) {
    case 'checking':    status.textContent = 'Checking for updates…'; break;
    case 'up-to-date':  status.textContent = `You're on the latest version (v${s.currentVersion || ''}).`; break;
    case 'available':   status.textContent = `Update available: v${s.version} — downloading…`; break;
    case 'downloading': status.textContent = `Downloading… ${s.percent || 0}%`; break;
    case 'downloaded':  status.textContent = `v${s.version} ready — sign in to install.`; break;
    case 'error':       status.textContent = `Update error: ${s.message || 'unknown'}`; break;
    case 'dev':         status.textContent = 'Update checks run in packaged builds only.'; break;
    default:            status.textContent = '';
  }
}

// ── Game performance mode — while an RL match is live the server flags perfMode.active;
// the panel pauses its own paint load (previews, animations) so borderless gameplay on the
// same PC stays smooth. Broadcast overlays in OBS are untouched. ──
let _perfShed = false, _perfNoPrev = false;
function applyPerfMode(data) {
  const pm = (data && data.perfMode) || {};
  // Sync the Settings controls (unless the producer is mid-click on one).
  const syncCb = (id, val) => { const c = el(id); if (c && document.activeElement !== c) c.checked = !!val; };
  syncCb('check-perf-mode', pm.enabled !== false);
  syncCb('check-perf-always', pm.always);
  syncCb('check-perf-noanim', pm.reduceAnimations);
  syncCb('check-perf-noprev', pm.pausePreviews);
  syncCb('check-perf-reswarn', pm.resourceWarnings !== false);
  const rate = el('sel-perf-rate');
  if (rate && document.activeElement !== rate) rate.value = pm.broadcastRate || 'smooth';

  const shed = !!((pm.active && pm.enabled !== false) || pm.always);
  const noAnim = shed || !!pm.reduceAnimations;
  const noPrev = shed || !!pm.pausePreviews;
  document.body.classList.toggle('perf-noanim', noAnim);

  if (noPrev !== _perfNoPrev) {
    _perfNoPrev = noPrev;
    // Floating OBS panel's GFX-mode iframe: unload (it runs a full overlay page) — the inline
    // scene preview this used to also target was removed once GFX mode covered that job.
    const pv = el('obs-prev-gfx-iframe');
    if (pv) {
      if (noPrev) { if (pv.src && pv.src !== 'about:blank') pv.dataset.perfSrc = pv.src; pv.src = 'about:blank'; }
      else if (pv.dataset.perfSrc) { pv.src = pv.dataset.perfSrc; delete pv.dataset.perfSrc; }
    }
    // OBS program preview camera: stop decoding.
    const v = el('obs-prev-video');
    if (v) { try { if (noPrev) v.pause(); else if (v.srcObject) v.play().catch(() => {}); } catch (_) {} }
  }

  if (shed !== _perfShed) {
    _perfShed = shed;
    document.body.classList.toggle('perf-live', shed);
    let chip = el('perf-live-chip');
    if (shed) {
      if (!chip) {
        chip = document.createElement('div');
        chip.id = 'perf-live-chip';
        document.body.appendChild(chip);
      }
      chip.textContent = pm.always
        ? 'LEAN MODE — app running light (always-on, Settings ▸ Performance)'
        : 'PERFORMANCE MODE — previews paused while the match is live';
    } else if (chip) chip.remove();
  }
}
function sendPerfPrefs() {
  send('set_perf_mode', {
    enabled: !!el('check-perf-mode')?.checked,
    always: !!el('check-perf-always')?.checked,
    reduceAnimations: !!el('check-perf-noanim')?.checked,
    pausePreviews: !!el('check-perf-noprev')?.checked,
    resourceWarnings: !!el('check-perf-reswarn')?.checked,
    broadcastRate: el('sel-perf-rate')?.value || 'smooth'
  });
}
['check-perf-mode', 'check-perf-always', 'check-perf-noanim', 'check-perf-noprev', 'check-perf-reswarn', 'sel-perf-rate']
  .forEach((id) => el(id)?.addEventListener('change', sendPerfPrefs));

// ── GPU vs CPU rendering. Chromium fixes this at process start, so it lives in a tiny file main.js
// reads before app-ready — not in server state — and a change only lands on the next launch. ──
(function wireRenderMode() {
  const cb = el('check-render-gpu'), note = el('render-gpu-note');
  if (!cb || !window.electronAPI?.getRenderMode) { if (cb) cb.closest('label')?.style.setProperty('display', 'none'); return; }
  let saved = 'gpu';
  window.electronAPI.getRenderMode().then((m) => { saved = m === 'cpu' ? 'cpu' : 'gpu'; cb.checked = saved === 'gpu'; }).catch(() => {});
  cb.addEventListener('change', async () => {
    const mode = cb.checked ? 'gpu' : 'cpu';
    const r = await window.electronAPI.setRenderMode(mode).catch(() => null);
    if (!r || !r.ok) {
      cb.checked = saved === 'gpu';
      if (typeof showToast === 'function') showToast('Could not save the rendering setting.', '#ef4444');
      return;
    }
    if (note) {
      note.textContent = r.restartRequired
        ? `Saved — ${mode === 'gpu' ? 'GPU' : 'CPU'} rendering starts when you fully quit and reopen the app.`
        : 'Applies when the app next starts.';
      note.style.color = r.restartRequired ? 'var(--warn, #f59e0b)' : '';
    }
    if (r.restartRequired && typeof showToast === 'function') showToast('Saved — relaunch the app to apply.', '#f59e0b', 6000);
  });
})();


// ── Liquipedia (LPDB v3) ─────────────────────────────────────────────────────
// Every call here is producer-initiated. The API allows 60 requests per HOUR for the whole key,
// so there is no polling and no overlay-triggered fetch — the budget chip shows what is left.
function lpSend(extra) {
  send('set_liquipedia_settings', Object.assign({
    enabled: !!el('check-liquipedia-enabled')?.checked,
    wiki: el('input-liquipedia-wiki')?.value || '',
    contact: el('input-liquipedia-contact')?.value || ''
  }, extra || {}));
}
el('btn-liquipedia-save')?.addEventListener('click', () => {
  const key = el('input-liquipedia-key')?.value || '';
  lpSend(key.trim() ? { apiKey: key.trim() } : {});
  const k = el('input-liquipedia-key'); if (k) k.value = '';   // never keep the secret in the DOM
});
el('check-liquipedia-enabled')?.addEventListener('change', () => lpSend());
el('btn-liquipedia-change-key')?.addEventListener('click', () => {
  const k = el('input-liquipedia-key'); if (k) { k.value = ''; k.focus(); }
});
const _lpPage = () => (el('input-liquipedia-page')?.value || '').trim();
// force:true = the producer explicitly asked for fresh data; the server still refuses if the
// hourly budget is gone, and falls back to cache rather than blanking a graphic.
el('btn-lp-fetch-standings')?.addEventListener('click', () => send('liquipedia_fetch', { kind: 'standings', page: _lpPage(), force: true }));
el('btn-lp-fetch-rankings')?.addEventListener('click', () => send('liquipedia_fetch', { kind: 'rankings', force: true }));
el('btn-lp-fetch-squad')?.addEventListener('click', () => send('liquipedia_fetch', { kind: 'squad', page: _lpPage(), force: true }));
el('btn-lp-fetch-tournament')?.addEventListener('click', () => send('liquipedia_fetch', { kind: 'tournament', page: _lpPage(), force: true }));
el('btn-lp-apply-standings')?.addEventListener('click', () => send('liquipedia_apply_standings', {}));

function applyLiquipediaState(data) {
  const lp = (data && data.liquipedia) || {};
  const en = el('check-liquipedia-enabled');
  if (en && document.activeElement !== en) en.checked = !!lp.enabled;
  const wiki = el('input-liquipedia-wiki');
  if (wiki && document.activeElement !== wiki) wiki.value = lp.wiki || '';
  const contact = el('input-liquipedia-contact');
  if (contact && document.activeElement !== contact) contact.value = lp.contact || '';
  const keyInp = el('input-liquipedia-key'), changeBtn = el('btn-liquipedia-change-key');
  if (keyInp && changeBtn) {
    keyInp.placeholder = lp.hasKey ? 'Key saved — paste a new one to replace it' : 'Paste your Liquipedia API key';
    changeBtn.style.display = lp.hasKey ? '' : 'none';
  }
  // Budget chip: the single most useful number during a show.
  const chip = el('liquipedia-budget');
  if (chip) {
    if (!lp.enabled || !lp.hasKey) { chip.textContent = lp.hasKey ? 'Off' : 'No key'; chip.dataset.st = 'off'; }
    else {
      const left = lp.budgetRemaining != null ? lp.budgetRemaining : '—';
      const mins = lp.budgetResetInMs ? Math.ceil(lp.budgetResetInMs / 60000) : 0;
      chip.textContent = left + ' left this hour' + (mins ? ' · +1 in ' + mins + 'm' : '');
      chip.dataset.st = (Number(left) > 5) ? 'on' : 'warn';
    }
  }
  // Show what is pulled and ready to push onto a graphic (counts only — the rows themselves
  // stay server-side rather than riding every broadcast).
  const applyBtn = el('btn-lp-apply-standings');
  if (applyBtn) {
    const n = (lp.counts && lp.counts.standings) || 0;
    applyBtn.disabled = !n;
    applyBtn.textContent = n ? '→ Standings graphic (' + n + ')' : '→ Standings graphic';
  }
  const card = document.querySelector('.int-card[data-card="liquipedia"] .int-card-status');
  if (card) { card.textContent = lp.hasKey ? (lp.enabled ? 'Connected' : 'Key saved') : 'No key'; card.dataset.st = lp.hasKey && lp.enabled ? 'on' : 'off'; }
  if (lp.lastError) {
    const r = el('liquipedia-result');
    if (r && !r.dataset.fresh) { r.textContent = lp.lastError; r.style.color = '#f56565'; }
  }
}

// -- Riot Games API ---------------------------------------------------------
// Producer's own key from developer.riotgames.com. Nothing polls - Riot's per-key limits are
// small - so Test and Look up are the only things that ever call out.
// The platform (na1/kr/...) and the routing region (americas/europe/...) are two different Riot
// routings; the platform picker moves the region with it because a mismatch answers 404.
const RIOT_PLATFORM_REGION = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea', th2: 'sea', ph2: 'sea'
};
function riotSend(extra) {
  send('set_riot_settings', Object.assign({
    platform: el('select-riot-platform')?.value || 'na1',
    region: el('select-riot-region')?.value || 'americas'
  }, extra || {}));
}
el('select-riot-platform')?.addEventListener('change', () => {
  const reg = RIOT_PLATFORM_REGION[el('select-riot-platform').value];
  const rSel = el('select-riot-region');
  if (reg && rSel) rSel.value = reg;
  riotSend();
});
el('select-riot-region')?.addEventListener('change', () => riotSend());
el('btn-riot-save')?.addEventListener('click', () => {
  const key = el('input-riot-key')?.value || '';
  riotSend(key.trim() ? { apiKey: key.trim() } : {});
  const k = el('input-riot-key'); if (k) k.value = '';   // never keep the secret in the DOM
});
el('btn-riot-change-key')?.addEventListener('click', () => {
  const k = el('input-riot-key'); if (k) { k.value = ''; k.focus(); }
});
el('btn-riot-test')?.addEventListener('click', () => {
  // Save first if something is typed, so Test never checks a key the server hasn't got yet.
  const key = el('input-riot-key')?.value || '';
  if (key.trim()) { riotSend({ apiKey: key.trim() }); el('input-riot-key').value = ''; }
  const r = el('riot-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Checking with Riot...'; }
  send('riot_test', {});
});
el('btn-riot-lookup')?.addEventListener('click', () => {
  const r = el('riot-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Looking up...'; }
  send('riot_lookup', { riotId: el('input-riot-riotid')?.value || '' });
});
el('input-riot-riotid')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('btn-riot-lookup')?.click(); });

function applyRiotState(data) {
  const rt = (data && data.riot) || {};
  const plat = el('select-riot-platform');
  if (plat && document.activeElement !== plat && rt.platform) plat.value = rt.platform;
  const reg = el('select-riot-region');
  if (reg && document.activeElement !== reg && rt.region) reg.value = rt.region;
  const keyInp = el('input-riot-key'), changeBtn = el('btn-riot-change-key');
  if (keyInp && changeBtn) {
    keyInp.placeholder = rt.hasKey ? 'Key saved - paste a new one to replace it' : 'RGAPI-...';
    changeBtn.style.display = rt.hasKey ? '' : 'none';
  }
  // The chip carries the one fact that explains most failures: a development key is a 24-hour key.
  const chip = el('riot-key-chip');
  if (chip) {
    if (!rt.hasKey) { chip.textContent = 'No key'; chip.dataset.st = 'off'; }
    else if (rt.lastError) { chip.textContent = 'Key rejected'; chip.dataset.st = 'warn'; }
    else { chip.textContent = rt.keyKind === 'development' ? 'Dev key (24h)' : 'Key saved'; chip.dataset.st = 'on'; }
  }
  const card = document.querySelector('.int-card[data-card="riot"] .int-card-status');
  if (card) { card.textContent = rt.hasKey ? (rt.lastError ? 'Key rejected' : 'Key saved') : 'No key'; card.dataset.st = rt.hasKey && !rt.lastError ? 'on' : 'off'; }
  if (rt.lastError) {
    const r = el('riot-result');
    if (r && !r.dataset.fresh) { r.textContent = rt.lastError; r.style.color = '#f56565'; }
  }
}

// ── Org-seat role UX: talent/analyst run the app VIEW-ONLY (server enforces it —
// every mutating control message is rejected); this just makes it visible and
// hides the two pages that are all credentials (Settings / Marketplace). ──
let _cloudRoleShown = null;
function applyCloudRole(role) {
  role = role || null;
  if (role === _cloudRoleShown) return;
  _cloudRoleShown = role;
  const viewOnly = role === 'talent' || role === 'analyst';
  document.body.classList.toggle('role-viewonly', viewOnly);
  let chip = el('role-chip');
  if (role && role !== 'owner' && role !== 'admin' && role !== 'producer') {
    if (!chip) {
      chip = document.createElement('span');
      chip.id = 'role-chip';
      const host = el('discord-user-area');
      if (host && host.parentNode) host.parentNode.insertBefore(chip, host);
      else document.querySelector('.topbar-right')?.appendChild(chip);
    }
    chip.textContent = viewOnly ? ('VIEW-ONLY · ' + role.toUpperCase()) : role.toUpperCase();
    chip.title = viewOnly
      ? 'Your org seat role is ' + role + ' — the app is read-only for you (scores, scenes and settings are producer-controlled).'
      : 'Your org seat role is ' + role + ' — credential and license settings are locked.';
  } else if (chip) { chip.remove(); }
}

// ── Swap sidebar sides (nav ↔ quick-actions rail), persisted per machine ──
const SWAP_SIDES_KEY = 'ne_sides_swapped';
function applySwapSides(on) {
  document.body.classList.toggle('sides-swapped', !!on);
  const cb = el('check-swap-sides'); if (cb) cb.checked = !!on;
}
try { applySwapSides(localStorage.getItem(SWAP_SIDES_KEY) === '1'); } catch {}
el('check-swap-sides')?.addEventListener('change', function () {
  try { localStorage.setItem(SWAP_SIDES_KEY, this.checked ? '1' : '0'); } catch {}
  applySwapSides(this.checked);
});

// ── Bottom-bar customize: pin any scene / overlay / trigger as a quick button ──
// Pinned model: [{ t:'scene'|'overlay'|'trigger', k }]. Old string arrays migrate to scenes.
const BB_PINNED_KEY = 'ne_bb_pinned_v2';
const BB_TRIGGER_LABELS = { breakScreen: 'Countdown', winner: 'Winner', intro: 'Line-up', watchlist: 'Teams to Watch', spotlight: 'Teams to Watch', veto: 'Map Veto' };
// The Teams-to-Watch trigger used to be keyed 'spotlight'; saved pins / rundown segments still carry it.
const trigStateKey = (k) => (k === 'spotlight' ? 'watchlist' : k);
function bbPinned() {
  try {
    return (JSON.parse(localStorage.getItem(BB_PINNED_KEY) || '[]'))
      .map((x) => (typeof x === 'string' ? { t: 'scene', k: x } : x))
      .filter((x) => x && x.t && x.k != null);
  } catch { return []; }
}
function bbSetPinned(list) { try { localStorage.setItem(BB_PINNED_KEY, JSON.stringify(list)); } catch {} }
function bbIsPinned(t, k) { return bbPinned().some((p) => p.t === t && p.k === k); }
function bbTogglePin(t, k, on) {
  const list = bbPinned().filter((p) => !(p.t === t && p.k === k));
  if (on) list.push({ t, k });
  bbSetPinned(list);
}
// Unified transport-bar order: a list of button tokens (`m:<moment>` for a mapped OBS moment,
// or `<t>:<k>` for a pin). Position in this list IS the hotkey (1st button = key 1), so dragging
// a button to a new spot re-binds its key. Unknown tokens (new moments/pins) append in default order.
const BB_ORDER_KEY = 'ne_bb_order_v1';
function bbOrder() { try { return (JSON.parse(localStorage.getItem(BB_ORDER_KEY) || '[]') || []).filter((x) => typeof x === 'string'); } catch { return []; } }
function bbSetOrder(a) { try { localStorage.setItem(BB_ORDER_KEY, JSON.stringify(a)); } catch {} }
const BB_EXPAND_KEY = 'ne_bb_expanded';
function bbExpanded() { try { return localStorage.getItem(BB_EXPAND_KEY) === '1'; } catch { return false; } }
function bbSetExpanded(on) { try { localStorage.setItem(BB_EXPAND_KEY, on ? '1' : '0'); } catch {} }
// Resolve a pinned descriptor → { label, live, run } against current state.
function bbActionInfo(p) {
  const obs = currentState.obs || {};
  if (p.t === 'scene') return { label: p.k, live: (obs.currentScene || '') === p.k, run: () => send('obs_switch_scene', { sceneName: p.k }) };
  if (p.t === 'overlay') {
    const o = (typeof ONAIR_SCENES !== 'undefined' ? ONAIR_SCENES : []).find((x) => x.key === p.k); if (!o) return null;
    const on = !!getPath(currentState, o.path);
    return { label: o.label, live: on, run: () => send(o.msg, { visible: !on }) };
  }
  if (p.t === 'trigger') {
    const g = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((x) => x.state === trigStateKey(p.k)); if (!g) return null;
    const live = !!(currentState[g.state] && currentState[g.state].visible);
    return { label: BB_TRIGGER_LABELS[p.k] || p.k, live, run: () => send(g.msg, live ? { visible: false } : g.show()) };
  }
  // OBS audio input — pill lights when MUTED (danger). Wheel/long-press rides volume (see the toolbar).
  if (p.t === 'audio') {
    const inp = (obs.audioInputs || []).find((i) => i.name === p.k); if (!inp) return null;
    return { label: p.k, live: !!inp.muted, kind: 'audio', inputName: p.k, volumeDb: inp.volumeDb,
      run: () => send(inp.muted ? 'obs_input_unmute' : 'obs_input_mute', { inputName: p.k }) };
  }
  // OBS source (scene item) — k is a base64 [scene, source] pair. Pill lights when SHOWN.
  if (p.t === 'source') {
    const parsed = bbSourceParse(p.k); if (!parsed) return null;
    const { scene, source } = parsed;
    const src = (obs.sources || []).find((s) => s.scene === scene && s.source === source); if (!src) return null;
    return { label: source, live: !!src.enabled, kind: 'source', scene, source,
      run: () => send(src.enabled ? 'obs_source_hide' : 'obs_source_show', { scene, source }) };
  }
  return null;
}
// Source pin key = base64 of [scene, source] — collision-free + safe in data attributes / localStorage.
function bbSourceKey(scene, source) { try { return btoa(unescape(encodeURIComponent(JSON.stringify([scene, source])))); } catch { return ''; } }
function bbSourceParse(k) { try { const a = JSON.parse(decodeURIComponent(escape(atob(String(k))))); return Array.isArray(a) ? { scene: a[0], source: a[1] } : null; } catch { return null; } }
function bbRenderCustomizeList() {
  const list = el('bb-cz-list'); if (!list) return;
  const obs = currentState.obs || {};
  const mapped = new Set(Object.values(obs.scenes || {}).filter(Boolean));
  const scenes = Array.isArray(obs.availableScenes) ? obs.availableScenes : [];
  // Redesigned: searchable chip grid, auto-reflects the live OBS scenes + overlay/trigger registries.
  const ov = (typeof ONAIR_SCENES !== 'undefined' ? ONAIR_SCENES : []);
  const tr = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []);
  const q = (el('bb-cz-search') && el('bb-cz-search').value || '').trim();
  const hit = (label) => NESearch.matches(q, [String(label == null ? '' : label)]);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const ico = { casters: 'mic', break: 'clock', winner: 'trophy', intro: 'users', veto: 'flag', bracket: 'trending', upcoming: 'clock', standings: 'trending', ticker: 'chat', spotlight: 'star', watchlist: 'star', banner: 'handshake' };
  const chip = (t, k, label, icon, opt) => {
    opt = opt || {}; const pinned = !!opt.pinned, locked = !!opt.locked;
    return `<button type="button" class="bb-cz-chip${pinned ? ' is-pinned' : ''}${locked ? ' is-locked' : ''}" data-t="${t}" data-k="${esc(k).replace(/"/g, '&quot;')}"${locked ? ' disabled title="Mapped under Apps > Streaming software. Always on the bar"' : ''} aria-pressed="${pinned}">`
      + svgIcon(icon || 'film') + `<span class="bb-cz-cname">${esc(label)}</span>`
      + (opt.live ? '<span class="bb-cz-live" title="On air"></span>' : '')
      + (locked ? '<span class="bb-cz-ctag">auto</span>' : `<span class="bb-cz-pin">${svgIcon(pinned ? 'check' : 'plus')}</span>`)
      + `</button>`;
  };
  const grp = (title, total, chips, empty) =>
    `<div class="bb-cz-sec"><div class="bb-cz-grouplabel">${title}<span class="bb-cz-count">${total}</span></div><div class="bb-cz-chips">${chips || `<div class="bb-cz-empty">${empty || 'Nothing matches.'}</div>`}</div></div>`;
  const sceneChips = scenes.filter(hit).map((s) => chip('scene', s, s, 'film', { pinned: bbIsPinned('scene', s) || mapped.has(s), locked: mapped.has(s), live: (obs.currentScene || '') === s })).join('');
  const ovChips = ov.filter((o) => hit(o.label)).map((o) => chip('overlay', o.key, o.label, ico[o.key] || 'sparkles', { pinned: bbIsPinned('overlay', o.key), live: !!getPath(currentState, o.path) })).join('');
  const trChips = tr.filter((g) => hit(BB_TRIGGER_LABELS[g.state] || g.state)).map((g) => chip('trigger', g.state, BB_TRIGGER_LABELS[g.state] || g.state, 'zap', { pinned: bbIsPinned('trigger', g.state), live: !!(currentState[g.state] && currentState[g.state].visible) })).join('');
  // OBS audio inputs (pin = a mute+volume pill) and scene sources (pin = a show/hide pill).
  const auds = Array.isArray(obs.audioInputs) ? obs.audioInputs : [];
  const srcs = Array.isArray(obs.sources) ? obs.sources : [];
  const audChips = auds.filter((a) => hit(a.name)).map((a) => chip('audio', a.name, a.name, 'volume', { pinned: bbIsPinned('audio', a.name), live: !!a.muted })).join('');
  const srcChips = srcs.filter((s) => hit(s.source) || hit(s.scene)).map((s) => { const k = bbSourceKey(s.scene, s.source); return chip('source', k, s.source + '  ·  ' + s.scene, 'layers', { pinned: bbIsPinned('source', k), live: !!s.enabled }); }).join('');
  list.innerHTML = grp('OBS Scenes', scenes.length, sceneChips, obs.connected ? 'No scenes in OBS.' : 'Connect OBS to list scenes.')
    + grp('Overlays', ov.length, ovChips) + grp('Triggers', tr.length, trChips)
    + grp('Audio', auds.length, audChips, obs.connected ? 'No audio inputs in OBS.' : 'Connect OBS to list audio.')
    + grp('Sources', srcs.length, srcChips, obs.connected ? 'No sources in OBS.' : 'Connect OBS to list sources.');
  const pc = el('bb-cz-pincount'); if (pc) { const n = bbPinned().length; pc.textContent = n ? n + ' pinned' : ''; }
  list.querySelectorAll('.bb-cz-chip:not(.is-locked)').forEach((c) => c.addEventListener('click', () => {
    bbTogglePin(c.dataset.t, c.dataset.k, !bbIsPinned(c.dataset.t, c.dataset.k));
    _qtSceneSig = '';
    if (currentState && typeof renderQuickToolbar === 'function') renderQuickToolbar(currentState);
    bbRenderCustomizeList();
  }));
}
el('btn-bb-clip')?.addEventListener('click', () => {
  const btn = el('btn-bb-clip');
  if (btn.disabled) return;
  if (btn.dataset.mode === 'startbuf') {
    if (typeof rbOffInObs === 'function' && rbOffInObs(currentState && currentState.obs)) { showToast(RB_OFF_HINT, '#fbbf24', 9000); return; }
    send('obs_toggle_replay_buffer');
    showToast('Starting the OBS replay buffer…', '#fbbf24');
    return;
  }
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;vertical-align:middle;"><path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.845v6.31a1 1 0 0 1-1.447.894L15 14M3 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z"/></svg> Clipping…';

  fetch('http://127.0.0.1:3000/api/twitch/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  .then(r => r.json())
  .then(data => {
    if (data.obs || data.twitch) {
      const parts = [];
      if (data.obs)    parts.push('OBS ✓');
      if (data.twitch) parts.push('Twitch ✓');
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;vertical-align:middle;"><polyline points="20 6 9 17 4 12"/></svg> ${parts.join(' · ')}`;
      if (data.editUrl) showToast(`Twitch clip ready — <a href="${data.editUrl}" target="_blank" style="color:#9146ff;text-decoration:underline;">Edit clip</a>`, '#22c55e', 7000);
      if (Array.isArray(data.errors) && data.errors.length) showToast('Partly saved: ' + data.errors.join(' / '), '#fbbf24', 7000);
    } else {
      const err = data.errors?.[0] || 'Failed';
      btn.innerHTML = `✗ ${err}`;
    }
    setTimeout(() => { btn.innerHTML = origHTML; btn.disabled = false; }, 3500);
  })
  .catch(() => {
    btn.innerHTML = '✗ Error';
    setTimeout(() => { btn.innerHTML = origHTML; btn.disabled = false; }, 2500);
  });
});

let _bbCzOpen = false;
el('btn-bottom-customize')?.addEventListener('click', () => {
  const pop = el('bb-customize-pop'); if (!pop) return;
  _bbCzOpen = pop.style.display === 'none';
  pop.style.display = _bbCzOpen ? 'block' : 'none';
  if (_bbCzOpen) { bbRenderCustomizeList(); const s = el('bb-cz-search'); if (s) { s.value = ''; setTimeout(() => s.focus(), 30); } }
});
el('bb-cz-close')?.addEventListener('click', () => { _bbCzOpen = false; const p = el('bb-customize-pop'); if (p) p.style.display = 'none'; });
function bbCloseCustomize() { const p = el('bb-customize-pop'); if (p && p.style.display !== 'none') { p.style.display = 'none'; _bbCzOpen = false; } }
document.addEventListener('mousedown', (e) => {
  if (!_bbCzOpen) return;
  if (e.target.closest('#bb-customize-pop, #btn-bottom-customize')) return;
  bbCloseCustomize();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _bbCzOpen) bbCloseCustomize(); });
// Live search + auto-refresh: as OBS scenes / overlay states change, the open panel restays current.
el('bb-cz-search')?.addEventListener('input', () => { if (_bbCzOpen) bbRenderCustomizeList(); });

// ── Trigger config popover: set team/player/countdown before a pinned trigger goes live ──
// Maps each trigger to the rail control(s) it reuses (so options stay in sync).
const BB_TRIG_FIELDS = {
  breakScreen: [
    { el: 'ck-break-title', kind: 'select', label: 'Title' },
    { el: 'ck-break-time', kind: 'time', label: 'Countdown' },
    { el: 'ck-break-thenscene', kind: 'select', label: 'When timer ends' }
  ],
  winner:      [{ el: 'ck-winner-side', kind: 'select', label: 'Team' }],
  intro:       [{ el: 'ck-intro-side', kind: 'select', label: 'Team' }],
  spotlight:   [{ el: 'ck-spotlight-player', kind: 'select', label: 'Player' }],
  veto:        []
};
function bbHasTriggerConfig(stateKey) { return (BB_TRIG_FIELDS[stateKey] || []).length > 0; }
function bbOpenTriggerConfig(stateKey, btn) {
  const g = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((x) => x.state === stateKey);
  const pop = el('bb-trigger-pop'); const body = el('bb-trigger-fields');
  if (!g || !pop || !body) return;
  // Pressing the same gear while its panel is open toggles it closed.
  if (pop.style.display !== 'none' && pop.dataset.state === stateKey) { pop.style.display = 'none'; return; }
  const live = !!(currentState[stateKey] && currentState[stateKey].visible);
  el('bb-trigger-title').textContent = BB_TRIGGER_LABELS[stateKey] || stateKey;
  body.innerHTML = '';
  (BB_TRIG_FIELDS[stateKey] || []).forEach((f) => {
    const row = document.createElement('div'); row.className = 'bb-tf-row';
    const lab = document.createElement('label'); lab.className = 'field-label'; lab.textContent = f.label; row.appendChild(lab);
    if (f.kind === 'select') {
      const src = el(f.el);
      const sel = document.createElement('select'); sel.className = 'input-select'; sel.dataset.target = f.el;
      sel.innerHTML = src ? src.innerHTML : '';
      if (src) sel.value = src.value;
      row.appendChild(sel);
    } else if (f.kind === 'time') {
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'input-text'; inp.dataset.target = f.el; inp.dataset.kind = 'time';
      inp.value = el('ck-break-time') ? el('ck-break-time').textContent.trim() : '05:00';
      row.appendChild(inp);
    }
    body.appendChild(row);
  });
  el('bb-trigger-go').textContent = live ? 'Update' : 'Push Live';
  el('bb-trigger-hide').style.display = live ? '' : 'none';
  pop.dataset.state = stateKey;
  // Measure hidden, then place: prefer ABOVE the chip, flip BELOW when the popover
  // would poke into the titlebar strip — the window controls (min/max/close) are an
  // OS overlay that paints over the page, so no z-index can save us up there.
  pop.style.visibility = 'hidden';
  pop.style.display = 'block';
  const r = btn.getBoundingClientRect();
  const W = pop.offsetWidth, H = pop.offsetHeight;
  const SAFE_TOP = 64;   // topbar + window-controls overlay
  pop.style.left = Math.max(8, Math.min(window.innerWidth - W - 8, r.left - (W - r.width) / 2)) + 'px';
  if (r.top - 8 - H >= SAFE_TOP) {
    pop.style.top = '';
    pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  } else {
    pop.style.bottom = '';
    pop.style.top = Math.max(SAFE_TOP, Math.min(window.innerHeight - H - 8, r.bottom + 8)) + 'px';
  }
  pop.style.visibility = '';
}
el('bb-trigger-close')?.addEventListener('click', () => { el('bb-trigger-pop').style.display = 'none'; });
// Keep an OPEN popover honest: the Go button label and the Hide button reflect the
// trigger's CURRENT on-air state, not the state at open time — turning the graphic
// off from the chip, another panel, or an automation updates the panel in place.
function bbSyncTriggerPop() {
  const pop = el('bb-trigger-pop');
  if (!pop || pop.style.display === 'none') return;
  const stateKey = pop.dataset.state;
  if (!stateKey) return;
  const live = !!(currentState && currentState[stateKey] && currentState[stateKey].visible);
  const go = el('bb-trigger-go'); if (go) go.textContent = live ? 'Update' : 'Push Live';
  const hide = el('bb-trigger-hide'); if (hide) hide.style.display = live ? '' : 'none';
}
// Click-away / Escape close the popover — a floating "put on air" panel must never linger.
document.addEventListener('mousedown', (e) => {
  const pop = el('bb-trigger-pop');
  if (!pop || pop.style.display === 'none') return;
  if (e.target.closest('#bb-trigger-pop')) return;
  // Clicks on any trigger chip/gear re-open with fresh fields; don't fight that handler.
  if (e.target.closest('.qk-chip, .qt-act-btn, .bb-action-btn, .gl-row')) return;
  pop.style.display = 'none';
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const pop = el('bb-trigger-pop');
  if (pop && pop.style.display !== 'none') pop.style.display = 'none';
});
el('bb-trigger-go')?.addEventListener('click', () => {
  const stateKey = el('bb-trigger-pop').dataset.state;
  const g = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((x) => x.state === stateKey); if (!g) return;
  // Write chosen values back to the rail controls so g.show() picks them up.
  el('bb-trigger-fields').querySelectorAll('[data-target]').forEach((inp) => {
    if (inp.dataset.kind === 'time') { const s = parseTimeInput(inp.value); if (s != null) setTimerSecs(s); }
    else { const tgt = el(inp.dataset.target); if (tgt) tgt.value = inp.value; }
  });
  // Choosing a team in the Winner gear is a deliberate override — stop auto-pointing at the leader.
  if (stateKey === 'winner') window._qkWinnerAuto = false;
  // Feed the gfx.html layer too — this path only sent the trigger message, so gear
  // chips (Line-up, Break, Winner) showed on standalone pages but never on the
  // unified gfx.html source. Mirrors the plain toggle path exactly.
  const prevScene = currentState && currentState.gfxActive;
  if (prevScene && prevScene !== g.sceneKey && window._gfxSceneMeta && window._gfxSceneMeta[prevScene]) {
    gfxHide(prevScene);
  }
  send(g.msg, g.show());
  if (g.sceneKey) {
    send('set_gfx_active', { scene: g.sceneKey });
    if (currentState) currentState.gfxActive = g.sceneKey;
    if (window._gfxRefreshTopBar) window._gfxRefreshTopBar();
  }
  if (el('gfx-autocut-on')?.checked) {
    const sc = (el('gfx-autocut-scene')?.value || '').trim();
    if (sc) send('obs_switch_scene', { sceneName: sc });
  }
  el('bb-trigger-pop').style.display = 'none';
});
el('bb-trigger-hide')?.addEventListener('click', () => {
  const stateKey = el('bb-trigger-pop').dataset.state;
  const g = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((x) => x.state === stateKey);
  if (g) {
    send(g.msg, { visible: false });
    // Clear the gfx.html layer too when this scene is the one on it.
    if (g.sceneKey && currentState && currentState.gfxActive === g.sceneKey) {
      send('set_gfx_active', { scene: '' });
      currentState.gfxActive = '';
      if (window._gfxRefreshTopBar) window._gfxRefreshTopBar();
    }
  }
  el('bb-trigger-pop').style.display = 'none';
});
// Workflow tab "Reset broadcast" mirrors the header Reset.
el('btn-reset-all-wf')?.addEventListener('click', () => el('btn-reset-all')?.click());

// ══════════════════════════════════════════════════════════════════════════════
// Twitch Flows sidebar panel
// ══════════════════════════════════════════════════════════════════════════════
(function initFlows() {
  // ── Stream info ────────────────────────────────────────────────────────────
  async function refreshStreamInfo() {
    try {
      const r = await fetch('http://127.0.0.1:3000/api/twitch/stream');
      if (!r.ok) return;
      const d = await r.json();
      const pill  = el('flows-live-pill');
      const views = el('flows-viewer-count');
      const game  = el('flows-game-name');
      if (pill) {
        pill.style.display = '';
        if (d.live) {
          pill.textContent = 'LIVE';
          pill.style.background = 'rgba(74,222,128,.15)';
          pill.style.color = '#4ade80';
          pill.style.borderColor = 'rgba(74,222,128,.3)';
        } else {
          pill.textContent = 'OFFLINE';
          pill.style.background = 'rgba(239,68,68,.15)';
          pill.style.color = '#ef4444';
          pill.style.borderColor = 'rgba(239,68,68,.3)';
        }
      }
      if (views) views.textContent = d.live ? `${d.viewerCount?.toLocaleString() ?? 0} viewers` : 'Offline';
      if (game)  game.textContent  = d.gameName || '';
      if (el('flows-stream-title') && !el('flows-stream-title').matches(':focus') && d.title)
        el('flows-stream-title').value = d.title;
    } catch (_) {}
  }

  el('btn-flows-refresh-stream')?.addEventListener('click', refreshStreamInfo);

  // Refresh stream info when the STREAM tab opens (stream panel merged into Twitch/Stream).
  document.querySelectorAll('.qrail-tab[data-qtab="twitch"]').forEach(tab => {
    tab.addEventListener('click', refreshStreamInfo);
  });

  // ── Game search ────────────────────────────────────────────────────────────
  let _gameSearchTimer = null;
  el('flows-game-search')?.addEventListener('input', () => {
    clearTimeout(_gameSearchTimer);
    const q = el('flows-game-search')?.value?.trim();
    if (!q || q.length < 2) { const b = el('flows-game-results'); if (b) b.style.display = 'none'; return; }
    _gameSearchTimer = setTimeout(doGameSearch, 350);
  });
  // Up/Down/Enter through the results — it was mouse-only, which is an odd thing to demand of
  // someone already typing in the box. Bound BEFORE the plain Enter handler below so that Enter
  // takes the highlighted result instead of re-running the search.
  NESearch.bindListNav(el('flows-game-search'), el('flows-game-results'), '.game-result-row',
    { onEscape: () => { const b = el('flows-game-results'); if (b) b.style.display = 'none'; } });
  el('flows-game-search')?.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(_gameSearchTimer); doGameSearch(); } });

  async function doGameSearch() {
    const q = el('flows-game-search')?.value?.trim();
    if (!q) return;
    const box = el('flows-game-results');
    if (!box) return;
    box.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--muted);">Searching…</div>';
    box.style.display = '';
    try {
      const r = await fetch(`http://127.0.0.1:3000/api/twitch/games/search?q=${encodeURIComponent(q)}`);
      const games = await r.json();
      if (!games.length) { box.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--muted);">No results</div>'; return; }
      // Re-rank Helix's order against what was actually typed before cutting to 8 — searching
      // "rocket league" was returning spin-offs above the game itself.
      const ranked = NESearch.filter(games, q, (g) => [g.name]);
      box.innerHTML = (ranked.length ? ranked : games).slice(0, 8).map(g => {
        const art = g.box_art_url ? g.box_art_url.replace('{width}','52').replace('{height}','70') : '';
        return `<div class="game-result-row" data-id="${escapeHtml(g.id)}" data-name="${escapeHtml(g.name)}">
          ${art ? `<img src="${art}" alt="">` : ''}
          <span>${escapeHtml(g.name)}</span>
        </div>`;
      }).join('');
      box.querySelectorAll('.game-result-row').forEach(row => {
        row.addEventListener('click', () => {
          el('flows-game-id').value    = row.dataset.id;
          el('flows-game-search').value = row.dataset.name;
          box.style.display = 'none';
        });
      });
    } catch (_) {
      box.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:#f87171;">Search failed</div>';
    }
  }

  // Dismiss game results on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#flows-game-results') && !e.target.closest('#flows-game-search'))
      el('flows-game-results') && (el('flows-game-results').style.display = 'none');
  });

  // ── Update channel ─────────────────────────────────────────────────────────
  el('btn-flows-update-channel')?.addEventListener('click', async () => {
    const btn = el('btn-flows-update-channel');
    const title  = el('flows-stream-title')?.value?.trim();
    const gameId = el('flows-game-id')?.value?.trim();
    const gameName = el('flows-game-search')?.value?.trim();
    if (!title && !gameId && !gameName) return;
    const orig = btn.textContent;
    btn.textContent = 'Updating…'; btn.disabled = true;
    try {
      const body = {};
      if (title) body.title = title;
      if (gameId) body.gameId = gameId;
      else if (gameName) body.gameName = gameName;
      const r = await fetch('http://127.0.0.1:3000/api/twitch/channel', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      btn.textContent = r.ok ? 'Updated ✓' : 'Failed ✗';
    } catch (_) { btn.textContent = 'Error ✗'; }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
  });

  // ── Announcement ───────────────────────────────────────────────────────────
  el('btn-flows-announce')?.addEventListener('click', async () => {
    const btn = el('btn-flows-announce');
    const fb  = el('flows-announce-feedback');
    const message = el('flows-announce-text')?.value?.trim();
    const color   = el('flows-announce-color')?.value || 'PRIMARY';
    if (!message) return;
    const orig = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    if (fb) { fb.textContent = ''; fb.style.color = 'var(--muted)'; }
    try {
      const r = await fetch('http://127.0.0.1:3000/api/twitch/announcement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, color }) });
      if (r.ok) {
        btn.textContent = 'Sent ✓';
        el('flows-announce-text').value = '';
        if (fb) { fb.textContent = 'Announcement sent'; fb.style.color = '#4ade80'; }
      } else {
        const d = await r.json().catch(() => ({}));
        btn.textContent = 'Failed ✗';
        if (fb) { fb.textContent = d.error || 'Failed — check Twitch connection'; fb.style.color = '#f87171'; }
      }
    } catch (_) {
      btn.textContent = 'Error ✗';
      if (fb) { fb.textContent = 'Network error'; fb.style.color = '#f87171'; }
    }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
  });

  // ── Shoutout ───────────────────────────────────────────────────────────────
  el('btn-flows-shoutout')?.addEventListener('click', async () => {
    const btn = el('btn-flows-shoutout');
    const fb  = el('flows-shoutout-feedback');
    const username = el('flows-shoutout-user')?.value?.trim().replace(/^@/, '');
    if (!username) return;
    const orig = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    if (fb) { fb.textContent = ''; fb.style.color = 'var(--muted)'; }
    try {
      const r = await fetch('http://127.0.0.1:3000/api/twitch/shoutout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: username }) });
      if (r.ok) {
        btn.textContent = '/so ✓';
        if (fb) { fb.textContent = `Shoutout sent to @${username}`; fb.style.color = '#4ade80'; }
        el('flows-shoutout-user').value = '';
      } else {
        const d = await r.json().catch(() => ({}));
        btn.textContent = 'Failed ✗';
        if (fb) { fb.textContent = d.error || 'Failed'; fb.style.color = '#f87171'; }
      }
    } catch (_) {
      btn.textContent = 'Error ✗';
      if (fb) { fb.textContent = 'Network error'; fb.style.color = '#f87171'; }
    }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
  });

  // ── Chat mode toggles ──────────────────────────────────────────────────────
  const chatModeMap = {
    'flows-toggle-sub':      (on) => ({ subOnly: on }),
    'flows-toggle-emote':    (on) => ({ emoteOnly: on }),
    'flows-toggle-follower': (on) => ({ followerOnly: on }),
    'flows-toggle-slow':     (on) => ({ slowMode: on, slowModeSeconds: on ? 30 : 0 }),
  };
  Object.entries(chatModeMap).forEach(([id, buildBody]) => {
    el(id)?.addEventListener('change', async function () {
      try {
        await fetch('http://127.0.0.1:3000/api/twitch/chat/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(this.checked)) });
      } catch (_) {}
    });
  });

  // Shield mode (separate endpoint)
  el('flows-toggle-shield')?.addEventListener('change', async function () {
    try {
      await fetch('http://127.0.0.1:3000/api/twitch/chat/shield', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: this.checked }) });
    } catch (_) {}
  });

  // ── Raid ───────────────────────────────────────────────────────────────────
  let _raidCountdownTimer = null;

  function startRaidCountdown(targetLogin, displayName) {
    let secs = 90;
    const form   = el('flows-raid-form');
    const active = el('flows-raid-active');
    const nameEl = el('flows-raid-target-name');
    const viewEl = el('flows-raid-target-viewers');
    const cdEl   = el('flows-raid-countdown');

    if (form)   form.style.display   = 'none';
    if (active) active.style.display = '';
    if (nameEl) nameEl.textContent   = displayName || targetLogin;
    if (viewEl) viewEl.textContent   = 'Fetching viewer count…';
    if (cdEl)   cdEl.textContent     = secs;

    // Fetch target's viewer count
    fetch(`http://127.0.0.1:3000/api/twitch/games/search?q=${encodeURIComponent(targetLogin)}`)
      .catch(() => null);
    fetch(`http://127.0.0.1:3000/api/twitch/stream/viewers`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
    // Fetch the target's stream info via a generic lookup
    fetch(`http://127.0.0.1:3000/api/twitch/raid/target?login=${encodeURIComponent(targetLogin)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && viewEl) viewEl.textContent = d.isLive ? `${(d.viewers || 0).toLocaleString()} viewers` : 'Offline'; })
      .catch(() => { if (viewEl) viewEl.textContent = ''; });

    clearInterval(_raidCountdownTimer);
    _raidCountdownTimer = setInterval(() => {
      secs--;
      if (cdEl) cdEl.textContent = secs;
      if (secs <= 0) {
        clearInterval(_raidCountdownTimer);
        _raidCountdownTimer = null;
        resetRaidUI();
      }
    }, 1000);
  }

  function resetRaidUI() {
    clearInterval(_raidCountdownTimer);
    _raidCountdownTimer = null;
    const form   = el('flows-raid-form');
    const active = el('flows-raid-active');
    if (form)   form.style.display   = '';
    if (active) active.style.display = 'none';
    const inp = el('flows-raid-user');
    if (inp) inp.value = '';
  }

  el('btn-flows-raid')?.addEventListener('click', async () => {
    const btn = el('btn-flows-raid');
    const fb  = el('flows-raid-feedback');
    const username = el('flows-raid-user')?.value?.trim().replace(/^@/, '');
    if (!username) return;
    const orig = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    if (fb) { fb.textContent = ''; fb.style.color = 'var(--muted)'; }
    try {
      const r = await fetch('http://127.0.0.1:3000/api/twitch/raid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: username }) });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        startRaidCountdown(username, d.displayName || username);
      } else {
        const d = await r.json().catch(() => ({}));
        btn.textContent = 'Failed ✗';
        if (fb) { fb.textContent = d.error || 'Failed'; fb.style.color = '#f87171'; }
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
      }
    } catch (_) {
      btn.textContent = 'Error ✗';
      if (fb) { fb.textContent = 'Network error'; fb.style.color = '#f87171'; }
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
    }
    // Re-enable button (form will be hidden on success anyway)
    setTimeout(() => { if (btn) { btn.textContent = orig; btn.disabled = false; } }, 2000);
  });

  el('btn-flows-cancel-raid')?.addEventListener('click', async () => {
    const btn = el('btn-flows-cancel-raid');
    const orig = btn.textContent;
    btn.textContent = 'Cancelling…'; btn.disabled = true;
    try {
      const r = await fetch('http://127.0.0.1:3000/api/twitch/raid', { method: 'DELETE' });
      if (r.ok) {
        resetRaidUI();
      } else {
        btn.textContent = 'Failed ✗';
        btn.disabled = false;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
      }
    } catch (_) { btn.textContent = 'Error ✗'; btn.disabled = false; }
  });
})();

// ── Responsive auto-collapse: sidebar below 920px, qrail below 1260px ────────
// data-auto-sidebar / data-auto-qrail tracks whether WE collapsed it (vs the user),
// so we restore panels when the window grows back but never fight a manual toggle.
(function () {
  const BREAK_QRAIL   = 1260;
  const BREAK_SIDEBAR = 920;

  // When the user manually clicks a toggle, clear the auto-flag so resize
  // doesn't fight their choice (capture phase fires before the toggle handler).
  document.getElementById('sidebar-collapse')?.addEventListener('click', () => {
    const s = document.getElementById('app-shell'); if (s) delete s.dataset.autoSidebar;
  }, true);
  document.getElementById('brand-icon-btn')?.addEventListener('click', () => {
    const s = document.getElementById('app-shell'); if (s) delete s.dataset.autoSidebar;
  }, true);
  document.getElementById('qrail-collapse')?.addEventListener('click', () => {
    const s = document.getElementById('app-shell'); if (s) delete s.dataset.autoQrail;
  }, true);

  function applyResponsive() {
    const shell = document.getElementById('app-shell');
    if (!shell) return;
    const w = window.innerWidth;

    // ── Quick-actions rail ──────────────────────────────────────────────
    if (w <= BREAK_QRAIL) {
      if (!shell.classList.contains('qrail-collapsed')) {
        shell.classList.add('qrail-collapsed');
        shell.dataset.autoQrail = '1';
      }
      // Fully hide (0px), not the icon-rail 44px the user toggle uses
      document.documentElement.style.setProperty('--qrail-w', '0px');
    } else if (shell.dataset.autoQrail) {
      shell.classList.remove('qrail-collapsed');
      delete shell.dataset.autoQrail;
      document.documentElement.style.setProperty('--qrail-w', (typeof qrailExpandedW === 'function' ? qrailExpandedW() : 366) + 'px');
      const btn = document.getElementById('qrail-collapse');
      if (btn) btn.textContent = '›';
    }

    // ── Sidebar ─────────────────────────────────────────────────────────
    if (w <= BREAK_SIDEBAR) {
      if (!shell.classList.contains('collapsed')) {
        shell.classList.add('collapsed');
        shell.dataset.autoSidebar = '1';
      }
      document.documentElement.style.setProperty('--sidebar-w', '66px');
    } else if (shell.dataset.autoSidebar) {
      shell.classList.remove('collapsed');
      delete shell.dataset.autoSidebar;
      document.documentElement.style.setProperty('--sidebar-w', '236px');
      const btn = document.getElementById('sidebar-collapse');
      if (btn) btn.textContent = '‹';
    }
  }

  applyResponsive();
  window.addEventListener('resize', applyResponsive, { passive: true });
})();

// ── Status bar ────────────────────────────────────────────────────────────
function setStatus(connected) {
  const dot  = el('status-dot');
  const text = el('status-text');
  if (dot)  dot.classList.toggle('ok', connected);
  if (text) text.textContent = connected ? 'Connected to server' : 'No connection to server';
  const srv = el('ck-chip-server');
  if (srv) { srv.textContent = connected ? 'Server' : 'Server: offline'; srv.classList.toggle('ok', connected); srv.classList.toggle('bad', !connected); }
  // Signal widget: go dark when server drops
  if (!connected) {
    const sig = el('conn-signal'); if (sig) sig.dataset.level = '0';
    const tr = el('conn-tooltip-rows');
    if (tr) tr.innerHTML = '<div class="conn-tooltip-row"><div class="conn-dot bad"></div><span class="conn-tooltip-label">Server</span><span class="conn-tooltip-status bad">offline</span></div>';
  }
}
