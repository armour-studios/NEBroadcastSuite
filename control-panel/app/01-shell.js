// Control panel, part 1 of 17: Shell: dashboard, sidebar, settings, talent and crew pages, player cams, hosts grid.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

/* ─── Control Panel Logic ────────────────────────────────────────────────────
   The shared foundation (console capture, WS globals, send/el/esc/_editingInside,
   image pipeline, dialog helpers) lives in core.js, loaded before this file.
   This file carries the feature domains; they extract to per-domain files next. */

// Shared state read by code in THIS file but written/managed by camera-feeds.js (which
// loads after us). Declared here so load-time paths in app.js (DCC status renderers,
// qrail talent) never hit a cross-script TDZ — a `let` in a later script does not exist
// until that script runs, and referencing it during our load blanked the whole panel.
const VDO_API = 'http://127.0.0.1:3000';
let _vdoLinks = null;              // cached VDO links for facecam auto-fill
let _cfDirectorData = null;        // DCC: latest /api/vdo/director payload
let _directorOn = false;           // DCC: monitoring toggle
let _connectedStreams = new Set(); // stream IDs present in any room
let _videoStreams = new Set();     // stream IDs whose camera is live (sending video)


// ── Dashboard: small dismissible Nameless Esports promo banner (✕ retires it for good) ──
(function () {
  const banner = el('dash-nameless-cta');
  if (!banner) return;
  let dismissed = false;
  try { dismissed = !!localStorage.getItem('ne_nameless_banner_dismissed'); } catch (_) {}
  banner.style.display = dismissed ? 'none' : '';
  el('dash-nameless-cta-x')?.addEventListener('click', () => {
    try { localStorage.setItem('ne_nameless_banner_dismissed', '1'); } catch (_) {}
    banner.style.display = 'none';
  });
})();

// Settings opens as an OBS-style MODAL overlay (not an inline page) in the main window; in a popped-
// out window (?page=…) it renders as a normal full page instead. Computed once here so the tab
// handler below can special-case it. openSettingsModal/closeSettingsModal are defined further down.
const SETTINGS_AS_MODAL = !(new URLSearchParams(location.search).get('page'));

// ── Sidebar tab switching ───────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    // Settings is a modal overlay — open it OVER the current page instead of switching pages.
    if (tab === 'ajustes' && SETTINGS_AS_MODAL) { openSettingsModal(); return; }
    try { localStorage.setItem('ne_active_tab', tab); } catch {}   // remember the page across refreshes
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.id === `tab-${tab}-content`);
    });
    const scroll = el('tab-scroll'); if (scroll) scroll.scrollTop = 0;  // back to top on switch
    if (tab === 'media' && _assetsTab === 'media' && typeof mdLoad === 'function') mdLoad();   // lazy-load media on open
    if (tab === 'events' && typeof evAutoLoad === 'function') evAutoLoad();   // auto-pull in-house tournaments
    if (tab === 'replays' && !_stagingLoading) scanStagingArea();   // auto-scan the OBS folder
    // Scene previews are live overlays — only run them while Assets ▸ Overlays is open.
    if (tab === 'media' && _assetsTab === 'overlays') { if (typeof loadScenePreviews === 'function') loadScenePreviews(); }
    else if (typeof unloadScenePreviews === 'function') unloadScenePreviews();
    // The single Match — Teams card is a Dashboard widget (data-dash-id="teams") that lives in the
    // customizable #dash-grid; lend it to the Production page while that page is open, then return it
    // to the grid (NOT the page root) so it stays draggable/reorderable in the customize system.
    const mt = el('match-teams-section');
    if (mt) {
      if (tab === 'produccion') el('teams-match-slot')?.appendChild(mt);
      else if (mt.parentElement && mt.parentElement.id !== 'dash-grid') {
        const g = el('dash-grid');
        if (g) { g.appendChild(mt); if (typeof applyDashLayout === 'function') applyDashLayout(); }
        else el('tab-principal-content')?.appendChild(mt);
      }
    }
    // On Air + Graphics are Dashboard sections full-time now — Production dropped its Graphics
    // pane, so they are never lent back out.
    _borrowGraphicsToDash();
    // Show Deck: ONE element with two homes - the DCC's Show Deck tab on the Dashboard and the
    // Talent page's Desk lineup tab. placeShowDeck moves it; it is never cloned.
    placeShowDeck(tab);
    if (tab === 'ajustes') setApplySettingsCat();   // ensure the settings rail shows the right category
  });
});

// ── Settings page: OBS-style category rail (left nav + filtered sections) ─────
// The Settings page is one page of many `<section data-setcat="...">` blocks. The left rail filters
// which category's sections are visible, so the long scroll becomes a tabbed, OBS-style dialog.
function setSwitchSettingsCat(cat) {
  cat = cat || 'general';
  const rail = el('set-rail'); if (!rail) return;
  rail.querySelectorAll('.set-rail-btn').forEach(b => b.classList.toggle('active', b.dataset.stab === cat));
  let first = true;
  document.querySelectorAll('#set-content > .section').forEach(s => {
    const on = s.dataset.setcat === cat;
    s.style.display = on ? '' : 'none';
    s.classList.toggle('set-first', on && first);   // no divider above the first visible block
    if (on) first = false;
  });
  const scroll = el('tab-scroll'); if (scroll) scroll.scrollTop = 0;
  if (cat === 'games') _settingsSelectActiveGame();   // per-game browser opens on the active game
  try { localStorage.setItem('ne_settings_cat', cat); } catch (e) {}
}
// Per-game browser: when the Games category opens it shows the game on air (games-hub.js).
function _settingsSelectActiveGame() {
  if (window.GamesHub) window.GamesHub.followActive();
}
function _settingsCat() { try { return localStorage.getItem('ne_settings_cat') || 'general'; } catch (e) { return 'general'; } }
function setApplySettingsCat() { setSwitchSettingsCat(_settingsCat()); }
el('set-rail')?.addEventListener('click', (e) => {
  const b = e.target.closest('.set-rail-btn'); if (b) setSwitchSettingsCat(b.dataset.stab);
});
// Settings as an OBS-style modal overlay. openSettingsModal shows the fixed overlay over the current
// page; closeSettingsModal hides it. In a popped-out window these are unused (settings is a page there).
function openSettingsModal(cat) {
  const m = el('tab-ajustes-content'); if (!m) return;
  m.classList.add('open');
  setSwitchSettingsCat(cat || _settingsCat());
}
function closeSettingsModal() { el('tab-ajustes-content')?.classList.remove('open'); }
// Deep-link from anywhere: open Settings at a specific category (cockpit RL "Settings" button, the
// replay-editor gear, etc.). Opens the modal in the main window; falls back to the page in a popout.
function openSettings(cat) {
  if (SETTINGS_AS_MODAL) { openSettingsModal(cat); return; }
  el('tab-ajustes')?.click(); setSwitchSettingsCat(cat || _settingsCat());
}
window.openSettings = openSettings;
// Jump links from feature panels into the right Settings category (cockpit RL strip, replay editor…).
document.addEventListener('click', (e) => {
  const j = e.target.closest('.js-open-rl-settings');
  if (j) { e.preventDefault(); openSettings('games'); document.querySelector('#integration-games .game-tab-btn[data-game="rl"]')?.click(); }
});
// Wire the modal chrome (main window only). Backdrop click, ✕, Esc all close it; "Pop out" detaches
// Settings to its own OS window via the shared popout system, then closes the modal.
if (SETTINGS_AS_MODAL) {
  el('tab-ajustes-content')?.classList.add('as-modal');
  el('btn-settings-close')?.addEventListener('click', closeSettingsModal);
  el('tab-ajustes-content')?.addEventListener('click', (e) => { if (e.target === el('tab-ajustes-content')) closeSettingsModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el('tab-ajustes-content')?.classList.contains('open')) closeSettingsModal(); });
  el('btn-settings-popout')?.addEventListener('click', () => { closeSettingsModal(); if (typeof openPopout === 'function') openPopout('ajustes'); });
}
// Esc closes the topmost .mp-modal pop-up (brand kit editor, scene editor, bug report, Map Pool
// picker, clip editor) through its own Close button, so each one's cleanup still runs. Capture
// phase, so the Settings handler above does not close Settings underneath an open pop-up.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (document.querySelector('.app-prompt-overlay, dialog[open]')) return;
  // An open dropdown inside the pop-up takes the first Esc.
  if ([...document.querySelectorAll('.team-dd, .mp-ipick-dd')].some((d) => d.offsetParent)) return;
  const open = [...document.querySelectorAll('.mp-modal')].filter((m) => m.style.display && m.style.display !== 'none');
  const m = open[open.length - 1];
  if (!m) return;
  const btn = m.querySelector('#brand-editor-close, #se-close, #bug-close, #mp-close, #qr-edit-close, .mp-head [title="Close"]');
  if (!btn) return;
  e.stopPropagation();
  btn.click();
}, true);
// Apply the saved/default category once at startup so the page isn't a full scroll on first open.
setApplySettingsCat();

// The Show Deck (#talent-deck) is ONE element with two homes: the DCC's Show Deck tab on the
// Dashboard (#dcc-showdeck-home, the DCC widget rides the dashboard grid) and the Talent page's
// first tab (#talent-showdeck-home). It is MOVED between them, never cloned — two live copies wired
// to the same ids is exactly why it used to visibly jump between homes. It is also deliberately NOT
// its own dashboard widget, for the same reason.
//
// Lend it to the Talent page while that page is open AND its Show Deck tab is selected; return it
// to the DCC otherwise, so the Dashboard's tab is never left showing an empty pane.
function placeShowDeck(tab) {
  const sd = el('talent-deck'); if (!sd) return;
  // Lent to a Modern drawer: leave it there until the drawer closes (it restores the deck itself).
  if (sd.closest && sd.closest('.mx-drawer')) return;
  // 'equipos' is the Talent page (historic key — the nav label reads 'Talent').
  const wantTalent = (tab === 'equipos')
    && !!document.querySelector('#talent-page-nav .talent-page-btn.active[data-talentpage="showdeck"]');
  const home = wantTalent ? el('talent-showdeck-home') : el('dcc-showdeck-home');
  if (home && sd.parentElement !== home) home.appendChild(sd);
  // The retired 'showdeck' dashboard widget could have stamped hide/reorder inline styles — clear
  // them so the deck always shows in whichever home it's parked in.
  sd.style.display = ''; sd.style.order = '';
}
// Which top-level page is open right now. The Talent sub-nav switches without the page changing,
// so its handler has no `tab` argument to hand placeShowDeck.
function _activePageTab() {
  // 'active' is toggled on .tab-btn (the nav buttons carry both classes).
  const on = document.querySelector('.tab-btn.active[data-tab]');
  return (on && on.dataset.tab) || '';
}

// ── DCC: Director Control Center — role tabs (Show Deck | Players | Monitor) ──
(function initDCC() {
  const dcc = document.getElementById('cf-director-center');
  if (!dcc) return;

  const tabs         = dcc.querySelectorAll('.dcc-role-tab');
  const dbPanes      = dcc.querySelectorAll('.dcc-db-pane');
  const monitorView  = document.getElementById('dcc-monitor-view');
  const databaseView = document.getElementById('dcc-database-view');

  let role = 'showdeck';

  function updateMonDot() {
    const dot = document.getElementById('dcc-mon-status-dot');
    if (!dot) return;
    // _directorOn / _cfDirectorData are declared far below; this can run at init while
    // they are still in their temporal dead zone, where even `typeof` throws — guard it.
    let on = false, data = false;
    try { on   = typeof _directorOn !== 'undefined' && _directorOn; } catch (_) {}
    try { data = typeof _cfDirectorData !== 'undefined' && _cfDirectorData; } catch (_) {}
    const hasRooms = data && (
      (data.teams && (data.teams.blue || data.teams.orange)) ||
      (data.groups && Object.values(data.groups).some((g) => g && g.room))
    );
    dot.classList.toggle('live',  on);
    dot.classList.toggle('ready', !on && !!hasRooms);
    dot.title = on ? 'Monitoring active' : hasRooms ? 'Rooms ready — monitoring paused' : 'No active rooms';
  }

  function loadDbRole(r) {
    if (r === 'players') {
      if (typeof cfLoadGroups === 'function') cfLoadGroups().then(() => renderDccAll()).catch(() => renderDccAll());
      else renderDccAll();
    } else if (r === 'hosts') {
      if (typeof cfLoadGroups === 'function') cfLoadGroups().then(() => renderDccHostsGrid()).catch(() => renderDccHostsGrid());
      else renderDccHostsGrid();
    } else if (r === 'staging') {
      const doRender = () => { renderDccHostsPane(); if (typeof renderDccTeamsPane === 'function') renderDccTeamsPane(); };
      if (typeof cfLoadGroups === 'function') cfLoadGroups().then(doRender).catch(doRender);
      else doRender();
    } else if (r === 'lobby') {
      if (typeof renderDccLobbyPane === 'function') renderDccLobbyPane();
    } else if (r === 'showdeck') {
      if (typeof window.renderTalentDeck === 'function' && typeof currentState !== 'undefined' && currentState) window.renderTalentDeck(currentState);
    }
  }

  function switchRole(r) {
    role = r;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.dcrole === r));
    const isMonitor = r === 'monitor';
    if (monitorView)  monitorView.style.display  = isMonitor ? '' : 'none';
    if (databaseView) databaseView.style.display = isMonitor ? 'none' : '';
    if (isMonitor) {
      if (typeof cfTalentAutoOpen === 'function') cfTalentAutoOpen();
      // Website station rooms mount as console tabs — pick up any that appeared since.
      if (typeof cfSyncDirectorConsoles === 'function') cfSyncDirectorConsoles();
    } else {
      dbPanes.forEach((p) => {
        const show = p.dataset.role === r;
        p.classList.toggle('active', show);
        p.style.display = show ? '' : 'none';
      });
      loadDbRole(r);
      // Players pane carries the In-Game Player Cams mapping — refresh it on entry.
      if (r === 'players') setTimeout(() => { if (typeof renderPlayerCamMounts === 'function') renderPlayerCamMounts(); }, 0);
      // Show Deck pane: pull the deck element in (it may be sitting on the Talent page) + render.
      if (r === 'showdeck') {
        placeShowDeck('facecams');
        if (typeof window.renderTalentDeck === 'function' && typeof currentState !== 'undefined' && currentState) window.renderTalentDeck(currentState);
      }
    }
    updateMonDot();
  }

  tabs.forEach((t) => t.addEventListener('click', () => switchRole(t.dataset.dcrole)));

  // Start on the Show Deck tab. Deferred to a macrotask: this IIFE runs synchronously near the TOP of
  // app.js (well before later `let`/`const` declarations — e.g. VDO_API — are reached), and
  // switchRole('monitor') cascades into cfTalentAutoOpen(), which references those. Calling it
  // synchronously here throws "Cannot access before initialization" and — because it's an uncaught
  // top-level exception — HALTS the rest of app.js from executing at all (nothing past this point
  // in the file ever runs: no WS/state wiring, no nav, nothing). setTimeout(...,0) waits until the
  // whole script has finished running once, so every module-level variable is initialized by then.
  setTimeout(() => switchRole('showdeck'), 0);

  // Keep the whole panel auto-refreshing so player/crew connection statuses stay current without a
  // manual reload. Skips when the panel is hidden, or the user is mid-edit inside it.
  setInterval(() => {
    if (!dcc.offsetParent) return;
    const ae = document.activeElement;
    if (ae && dcc.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    try {
      if (role === 'monitor') {
        if (typeof cfTalentAutoOpen === 'function') cfTalentAutoOpen();  // refresh + keep monitoring alive
      } else {
        loadDbRole(role);
      }
      updateMonDot();
      if (typeof cfUpdateConnStatus === 'function') cfUpdateConnStatus();
    } catch (_) {}
  }, 8000);

  window._dccSetRole = switchRole;
  window._dccSetMode = (db) => switchRole(db ? 'players' : 'monitor'); // legacy compat
  window._dccUpdateMonDot = updateMonDot;
})();

// ── Talent page sub-nav: SHOW DECK | TEAMS | CREW ──
(function initTalentPages() {
  const nav = document.getElementById('talent-page-nav'); if (!nav) return;
  const panels = { showdeck: el('talent-showdeck-home'), teams: el('talent-panel-teams'), crew: el('talent-panel-crew') };

  function showPage(page) {
    nav.querySelectorAll('.talent-page-btn').forEach((b) => b.classList.toggle('active', b.dataset.talentpage === page));
    Object.entries(panels).forEach(([k, p]) => { if (p) p.style.display = k === page ? '' : 'none'; });
    // Exactly ONE action group ever sits in the topbar. The Event group (Save All / Clear)
    // belongs to the Teams > Event sub-tab only — it used to stay behind on the Crew page
    // (nothing hid it here), and with two groups both claiming margin-left:auto the first
    // one landed stranded in the middle of the bar.
    const acts     = document.getElementById('talent-topbar-teams-actions');
    const evActs   = document.getElementById('talent-topbar-event-actions');
    const crewActs = document.getElementById('talent-topbar-crew-actions');
    const onEventTab = !!document.querySelector('#teams-sub-nav .talent-page-btn.active[data-teamstab="event"]');
    if (acts)     acts.style.display     = (page === 'teams' && !onEventTab) ? '' : 'none';
    if (evActs)   evActs.style.display   = (page === 'teams' &&  onEventTab) ? '' : 'none';
    if (crewActs) crewActs.style.display = page === 'crew' ? '' : 'none';
    if (page === 'crew') renderCrewList();
    // Move the one real deck element in or out as this tab is entered / left.
    if (typeof placeShowDeck === 'function') placeShowDeck(_activePageTab());
    try { localStorage.setItem('talent_active_page', page); } catch (_) {}
  }

  nav.querySelectorAll('.talent-page-btn').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.talentpage)));
  window._talentShowPage = showPage;
  // Reopen whichever Talent sub-page (Teams/Crew) the producer was last on — survives refresh.
  // Deferred to a macrotask: this IIFE runs very early in the file (near the top), and showPage()
  // reaches into renderCrewList() — calling that synchronously this early risks the same TDZ crash
  // documented for switchRole('monitor')/loadScenePreviews if it touches any `let`/`const` declared
  // further down. setTimeout(...,0) waits for the whole script to finish once first — cheap
  // insurance, no visible delay.
  setTimeout(() => {
    let savedTalentPage; try { savedTalentPage = localStorage.getItem('talent_active_page'); } catch (_) {}
    // showdeck is the new first tab and the markup marks it active, but showPage() has never run,
    // so the deck has not been moved in yet — call it either way.
    showPage((savedTalentPage && panels[savedTalentPage]) ? savedTalentPage : 'showdeck');
  }, 0);
})();

// ── Crew page: unified talent profile manager ──
(function initCrewPage() {
  const addBtn  = el('crew-add-btn');
  const dlg     = el('crew-edit-dlg');
  const saveBtn = el('crew-f-save'), cancelBtn = el('crew-f-cancel');
  if (!addBtn) return;

  let editId     = null;
  let _fromLibId = null; // set when opened from the Hosts grid edit button
  let _crewCountry = ''; // ISO alpha-2 code from the flag picker (shared with player country storage)

  // Mount the searchable flag-thumbnail country picker (same widget the player editor uses) into the
  // dialog so you get flags-while-searching. It stores the lowercase ISO code in _crewCountry.
  function mountCountryPicker(code) {
    const mount = el('crew-f-country-mount'); if (!mount) return;
    _crewCountry = (code || '').toLowerCase();
    mount.innerHTML = '';
    if (typeof buildCountryControl === 'function') {
      mount.appendChild(buildCountryControl(_crewCountry, (c) => { _crewCountry = (c || '').toLowerCase(); }));
    }
  }

  function clearForm() {
    editId = null;
    _fromLibId = null;
    ['crew-f-name','crew-f-handle','crew-f-role','crew-f-social-handle','crew-f-paypal','crew-f-vdo'].forEach((id) => { const e = el(id); if (e) e.value = ''; });
    const notes = el('crew-f-notes'); if (notes) notes.value = '';
    const g = el('crew-f-group'); if (g) g.value = 'casters';
    const s = el('crew-f-social'); if (s) s.value = 'none';
    const dc = el('crew-f-default-cam'); if (dc) dc.innerHTML = dccCamOptionsHtml('', '— None —');
    const ds = el('crew-f-desk-slot'); if (ds) ds.value = '0';
    mountCountryPicker('');
    const titleEl = el('crew-edit-dlg-title'); if (titleEl) titleEl.textContent = 'Add Crew Member';
    if (saveBtn) saveBtn.textContent = 'Save';
  }

  function openCrewEdit(d, fromLibId) {
    // Resolve the caster-library twin NOW (by the pre-edit name/handle) so a rename
    // updates that entry in place. Without the id, the server dedupes by the NEW
    // name/handle, finds nothing, and forks a duplicate "ghost" that keeps the old
    // name on the desk overlay.
    _fromLibId = fromLibId || crewLibraryId(d) || null;
    editId = d.id || null;
    const set = (id, v) => { const e = el(id); if (e) e.value = v || ''; };
    set('crew-f-name', d.name); set('crew-f-handle', d.handle); set('crew-f-role', d.role);
    set('crew-f-social-handle', d.socialHandle); set('crew-f-paypal', d.paypal); set('crew-f-vdo', d.camUrl);
    mountCountryPicker(d.country);
    const notes = el('crew-f-notes'); if (notes) notes.value = d.notes || '';
    const g = el('crew-f-group'); if (g) g.value = d.group || 'casters';
    const s = el('crew-f-social'); if (s) s.value = d.social || 'none';
    const dc = el('crew-f-default-cam'); if (dc) dc.innerHTML = dccCamOptionsHtml(d.defaultCam || '', '— None —');
    const ds = el('crew-f-desk-slot'); if (ds) ds.value = String(crewDeskSlot(d));
    const titleEl = el('crew-edit-dlg-title');
    if (titleEl) titleEl.textContent = d.id ? 'Edit ' + (d.name || 'Crew Member') : 'Add Crew Member';
    if (saveBtn) saveBtn.textContent = d.id ? 'Update' : 'Save';
    if (dlg) { dlg.showModal(); setTimeout(() => el('crew-f-name')?.focus(), 50); }
  }

  addBtn.addEventListener('click', () => { clearForm(); if (dlg) dlg.showModal(); setTimeout(() => el('crew-f-name')?.focus(), 50); });
  // Open the SAME full add form from anywhere (e.g. the Camera Feeds group "+ Add"), preset to a group,
  // so hosts/casters/observers are all added with one identical question set (incl. country autofill).
  window.openCrewAdd = function (group) {
    clearForm();
    const g = el('crew-f-group'); if (g && group) g.value = group;
    if (dlg) dlg.showModal();
    setTimeout(() => el('crew-f-name')?.focus(), 50);
  };
  if (cancelBtn) cancelBtn.addEventListener('click', () => { if (dlg) dlg.close(); });
  const closeBtn = el('crew-edit-dlg-close'); if (closeBtn) closeBtn.addEventListener('click', () => { if (dlg) dlg.close(); });
  if (dlg) dlg.addEventListener('close', clearForm);

  if (saveBtn) saveBtn.addEventListener('click', () => {
    const name         = el('crew-f-name')?.value.trim();
    const handle       = (el('crew-f-handle')?.value.trim() || '').replace(/^@+/, '');
    const role         = el('crew-f-role')?.value.trim();
    const group        = el('crew-f-group')?.value || 'casters';
    const social       = el('crew-f-social')?.value || 'none';
    const socialHandle = el('crew-f-social-handle')?.value.trim();
    const defaultCam   = el('crew-f-default-cam')?.value || '';
    const country      = _crewCountry;
    const paypal       = el('crew-f-paypal')?.value.trim();
    const camUrl       = el('crew-f-vdo')?.value.trim() || '';
    const notes        = el('crew-f-notes')?.value.trim();
    if (!name) { el('crew-f-name')?.focus(); return; }
    const payload = { name, handle, role, group, social, socialHandle, defaultCam, country, paypal, camUrl, notes };
    if (editId) payload.id = editId;
    send(editId ? 'update_crew_member' : 'add_crew_member', payload);
    // Keep the caster-library profile — what the desk overlay reads through the lineup — in sync with
    // this crew profile on BOTH add and edit. Carry social + default cam so the overlay nameplate can
    // show the handle AND the right social icon (the old code dropped social entirely, and skipped the
    // library on a plain edit — so name/social never reached the scene). The overlay shows the social
    // handle, falling back to the gamertag. No id ⇒ the server dedupes by name/handle.
    const groupToKind = { casters: 'caster', observers: 'observer', hosts: 'host', guests: 'host' };
    const kind = groupToKind[group] || 'caster';
    const deskSlot = parseInt(el('crew-f-desk-slot')?.value || '0', 10) || 0;
    const libPayload = { kind, name, handle: socialHandle || handle, role, social, country, notes, camUrl, camSlot: defaultCam, deskSlot };
    if (_fromLibId) libPayload.id = _fromLibId;
    // Only on-camera people go to the caster library. Producers, admins and socials used to land
    // there as "casters" and filled the talent lists with people who never go on air (unless they
    // are being put on the desk, or were already in the library).
    if (groupToKind[group] || deskSlot || _fromLibId) send('save_caster_to_library', libPayload);
    setTimeout(() => { if (typeof renderDccAll === 'function') renderDccAll(); if (typeof renderDccHostsGrid === 'function') renderDccHostsGrid(); }, 350);
    if (dlg) dlg.close();
    setTimeout(renderCrewList, 300);
  });

  // Search + filter
  const search = el('crew-search'), filterGroup = el('crew-filter-group');
  if (search) search.addEventListener('input', renderCrewList);
  if (filterGroup) filterGroup.addEventListener('change', renderCrewList);

  // Show-country-on-desk toggle (mirrors the caster-desk slot-labels bar; same server state)
  const crewShowCountry = el('crew-show-country');
  if (crewShowCountry) crewShowCountry.addEventListener('change', () => send('set_casters_show_country', { showCountry: crewShowCountry.checked }));
  // Gamertag-vs-name display on the desk overlays (server casters.nameMode; gamertag is default)
  const crewNameMode = el('crew-name-gamertag');
  if (crewNameMode) crewNameMode.addEventListener('change', () => send('set_casters_name_mode', { mode: crewNameMode.checked ? 'gamertag' : 'name' }));

  // ── Show Deck: per-slot talent allocation strip (Talent page, all sub-tabs) ────────────
  // Caster slots go through save_caster_to_library's deskSlot (same swap/bump plumbing the
  // Casters lineup uses, so the desk + DCC follow automatically); Host/Observer are show
  // roles. "Current shift" is the desk lineup itself — no separate manual on-shift list —
  // crew.active/workedEvent are set automatically by the desk-slot and show-role handlers
  // server-side (save_caster_to_library / set_show_roles) purely so credits (workedEvent
  // sticks even after someone rolls off) and Save Preset (active = who's on the desk right
  // now) keep working; nothing here reads or renders them directly any more.
  // Off-Air Event Staff — anyone credited who isn't in the desk lineup: producers, tournament ops,
  // socials, or a caster who isn't on the live desk right now. No camera slot, but they worked the
  // event so they're credited. Keep in sync with the #td-support-role-sel options in index.html.
  const TD_SUPPORT_LABEL = { caster: 'Caster', producer: 'Producer', admin: 'Tournament Admin', coordinator: 'Coordinator', replay: 'Replay Op', stats: 'Statistician', moderator: 'Moderator', graphics: 'Graphics', flex: 'Flex', socials: 'Social' };
  const TD_SUPPORT_GROUPS = Object.keys(TD_SUPPORT_LABEL);
  window._tdSig = '';
  window.renderTalentDeck = function renderTalentDeck(data) {
    const wrap = el('td-slots');
    if (!wrap || !data) return;
    if (typeof _editingInside === 'function' && _editingInside(wrap)) return;
    const crew = data.crew || [];
    const lib = (data.casters && data.casters.library) || [];
    const lineup = (data.casters && data.casters.lineup) || [];
    const labels = (data.casters && data.casters.slotLabels) || {};
    const roles = (data.casters && data.casters.showRoles) || {};
    const byId = {}; lib.forEach((l) => { if (l && l.id) byId[l.id] = l; });
    const slotName = (n) => { const e = lineup.find((x) => Number(x.slot) === n); const p = e && byId[e.libraryId]; return (p && p.name) || ''; };
    const shifts = (data.casters && data.casters.shifts) || [];
    const supportList = (data.casters && Array.isArray(data.casters.support)) ? data.casters.support : [];
    const stationRooms = (window._cfStationDetail && window._cfStationDetail.rooms) || [];
    const sig = JSON.stringify({ c: crew.map((c) => [c.id, c.name, c.handle, c.group, c.country || '']), s: [1, 2, 3, 4].map(slotName), sid: ((data.casters && data.casters.list) || []).map((x) => x.slot + ':' + x.streamId), r: roles, l: labels, sh: shifts.map((s) => s.id + s.name), sup: supportList.map((s) => s.crewId + (s.role || '')), rm: stationRooms.map((r) => r.id + r.connected + '/' + r.slots) });
    if (sig === window._tdSig) return;
    window._tdSig = sig;
    const disp = (c) => c.handle || c.name;   // gamertag-first, matching the desk
    // Every slot searches the WHOLE crew. Assigning someone to a spot is what gives them the role,
    // so there's no reason to pre-filter by group — and pre-filtering hid anyone already sitting in a
    // slot who wasn't classified under that group, so the slot showed blank and they couldn't be found
    // or cleared even though the desk still had them.
    // Placeholder says "Search crew…", so a partial name has to resolve — an exact-equality test
    // rejected everything short of the full string and wiped the field.
    const tdMatch = (typed) => {
      const r = crewResolve(typed, crew);
      return r.member || null;
    };
    // Type-to-search text input instead of a plain <select> — a long crew roster was impossible to
    // search, and there was no way to add someone new without leaving the deck. The suggestion list
    // is our own dropdown (mountCrewTypeahead), not a native <datalist>: that one came out as an
    // unstyled system popup listing crew in roster order instead of A–Z.
    // Each seat's stream id (what the desk overlay views), for the camera-connected dot.
    const deskList = (data.casters && Array.isArray(data.casters.list)) ? data.casters.list : [];
    const sidOf = (n) => { const e = deskList.find((x) => Number(x.slot) === n); return e ? (e.streamId || '') : ''; };
    const cell = (label, id, cur, variant, slot) => {
      const curC = crew.find((c) => c.name === cur);
      // Fall back to the raw slot name when the occupant isn't a crew record (e.g. added straight to
      // the desk) so the slot still SHOWS who's in it — a blank slot you can't clear was the bug.
      return `<div class="td-slot td-slot--${variant}"><span class="td-slot-lbl">${esc(label)}</span>
        <input type="text" class="input-text td-sel" id="${id}" value="${esc(curC ? disp(curC) : (cur || ''))}" placeholder="Search crew…" autocomplete="off">
        ${slot && cur ? `<div class="td-cam">${sidOf(slot) ? `<span class="cf-ln-conn td-cam-dot" data-stream="${esc(sidOf(slot))}" data-conn="0" title="Start monitoring (Live monitor) to see whether their camera is connected"></span>` : ''}<button type="button" class="td-cam-btn" data-tdcam="copy" data-slot="${slot}" title="Copy the camera link: it opens ${esc(cur)}'s camera and mic straight into this desk seat">Cam link</button><button type="button" class="td-cam-btn" data-tdcam="watch" data-slot="${slot}" title="Watch this seat's camera feed in a window">Watch</button></div>` : ''}</div>`;
    };
    wrap.innerHTML =
      cell('Host', 'td-host', roles.host || '', 'host')
      + [1, 2, 3, 4].map((n) => cell(labels[n] || ('Caster ' + n), 'td-c' + n, slotName(n), 'caster', n)).join('')
      + cell('Observer', 'td-obs', roles.observer || '', 'obs');
    if (typeof cfUpdateConnStatus === 'function') cfUpdateConnStatus();
    // Camera buttons on a filled seat: the join link is asked for on demand (it carries the room
    // password, so it never rides the state broadcast). Delegated once on the wrapper.
    if (!wrap._tdCamWired) {
      wrap._tdCamWired = true;
      wrap.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tdcam]'); if (!b) return;
        window._tdCamWant = b.getAttribute('data-tdcam');
        send('desk_cam_link', { slot: Number(b.getAttribute('data-slot')) });
      });
    }
    // The slots are re-rendered from scratch on every state change, so the dropdown is re-mounted
    // each time (the mount is idempotent per element via its own data flag).
    ['td-host', 'td-c1', 'td-c2', 'td-c3', 'td-c4', 'td-obs'].forEach((id) => {
      const i = el(id); if (i && window.mountCrewTypeahead) window.mountCrewTypeahead(i, () => crew);
    });
    // Caster slot labels ("Caster 1" -> "Play-by-play") are renamed here: double-click the label.
    // set_slot_label used to be reachable only from the retired Staging pane.
    [1, 2, 3, 4].forEach((n) => {
      const lbl = el('td-c' + n)?.closest('.td-slot')?.querySelector('.td-slot-lbl');
      if (!lbl) return;
      lbl.title = 'Double-click to rename this slot';
      lbl.style.cursor = 'text';
      lbl.addEventListener('dblclick', async () => {
        const cur = labels[n] || ('Caster ' + n);
        // Electron does not implement window.prompt(); use the app's own prompt dialog.
        const next = await customPrompt('Rename desk slot', 'Name for desk slot ' + n, cur, 'Save');
        if (next == null) return;
        send('set_slot_label', { slot: n, label: next.trim().slice(0, 40) });
      });
    });
    [1, 2, 3, 4].forEach((n) => {
      el('td-c' + n)?.addEventListener('change', function () {
        const typed = this.value.trim();
        if (!typed) {
          const cur = slotName(n);
          if (cur) send('save_caster_to_library', { name: cur, kind: 'caster', deskSlot: 0 });
          return;
        }
        const m = tdMatch(typed);
        if (!m) { this.value = ''; showToast(`No crew member named "${typed}" — use + Add Crew above to create them first.`, '#fbbf24'); return; }
        this.value = disp(m);
        send('save_caster_to_library', { name: m.name, kind: 'caster', social: m.social, socialHandle: m.socialHandle, country: m.country, deskSlot: n });
      });
    });
    const sendRoles = () => {
      const hostInp = el('td-host'), obsInp = el('td-obs');
      const hostTyped = (hostInp?.value || '').trim(), obsTyped = (obsInp?.value || '').trim();
      const hostM = tdMatch(hostTyped), obsM = tdMatch(obsTyped);
      if (hostTyped && !hostM) { if (hostInp) hostInp.value = ''; showToast(`No crew member named "${hostTyped}" — use + Add Crew above to create them first.`, '#fbbf24'); }
      else if (hostInp && hostM) hostInp.value = disp(hostM);
      if (obsTyped && !obsM) { if (obsInp) obsInp.value = ''; showToast(`No crew member named "${obsTyped}" — use + Add Crew above to create them first.`, '#fbbf24'); }
      else if (obsInp && obsM) obsInp.value = disp(obsM);
      send('set_show_roles', { host: hostM ? hostM.name : '', observer: obsM ? obsM.name : '' });
    };
    el('td-host')?.addEventListener('change', sendRoles);
    el('td-obs')?.addEventListener('change', sendRoles);
    // Off-Air Event Staff — producers / tournament-ops / socials / off-desk casters. EVENT-scoped
    // (state.casters.support): adding/removing here only changes tonight's deck — the crew
    // record and its group on the Crew page are never touched.
    const supportWrap = el('td-support-list');
    if (supportWrap) {
      const crewById = {}; crew.forEach((c) => { if (c && c.id) crewById[c.id] = c; });
      const support = supportList.map((s) => ({ s, c: crewById[s.crewId] })).filter((x) => x.c);
      supportWrap.innerHTML = support.length ? support.map(({ s, c }) =>
        `<span class="dcc-support-chip" data-id="${esc(c.id)}">`
        + `<span class="nm">${esc(disp(c))}</span>`
        + `<span class="rl">${esc(s.role || c.role || TD_SUPPORT_LABEL[c.group] || '')}</span>`
        + `<button type="button" class="rm" data-support-rm="${esc(c.id)}" title="Remove from the credits screen — their profile stays in Crew">&times;</button></span>`
      ).join('') : '<span class="dcc-support-empty">No off-air staff added yet.</span>';
    }
    // Off-air staff search box uses the same A–Z dropdown as the slots; mount it here too in case
    // the deck was moved into this page after the one-time mount below ran (placeShowDeck).
    { const i = el('td-support-search'); if (i && window.mountCrewTypeahead) window.mountCrewTypeahead(i, () => crew); }
    // Website station rooms — the deck IS the director surface now (DCC merged in): monitor &
    // adjust the room the casters actually joined, copy its invite, jump into talkback. The
    // monitor iframe is lazy (only loads when toggled) and survives re-renders via its src.
    const roomsSection = el('td-station-rooms');
    const roomsList = el('td-station-rooms-list');
    if (roomsSection && roomsList) {
      roomsSection.style.display = stationRooms.length ? '' : 'none';
      const detailName = (window._cfStationDetail && window._cfStationDetail.stationName) || '';
      roomsList.innerHTML = stationRooms.map((r, i) =>
        `<span class="td-chip" style="display:inline-flex; align-items:center; gap:6px;" title="${tlEsc(detailName)} — ${tlEsc(r.name)}">
          <span style="font-size:9px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:${r.kind === 'observer' ? '#2dd4bf' : '#8b5cf6'};">${r.kind === 'observer' ? 'OBS' : 'CAST'}</span>
          <span style="font-weight:700;">${tlEsc(r.name)}</span>
          <span style="color:${r.connected ? '#22c55e' : 'var(--muted)'}; font-size:11px;">${r.connected}/${r.slots}</span>
          <button type="button" class="btn btn-ghost btn-xs td-room-monitor" data-ri="${i}" title="Open the director console for this room — mute, adjust and manage everyone in it">Monitor</button>
          <button type="button" class="btn btn-ghost btn-xs td-room-invite" data-ri="${i}" title="Copy the check-in link">Invite</button>
          <a class="btn btn-ghost btn-xs" href="${tlEsc(r.talkbackUrl)}" target="_blank" rel="noreferrer" title="Join this room yourself (talkback) — no placement taken">Talk</a>
        </span>`).join('');
      roomsList.querySelectorAll('.td-room-monitor').forEach((btn) => btn.addEventListener('click', () => {
        const r = stationRooms[Number(btn.dataset.ri)]; if (!r || !r.monitorUrl) return;
        const wrapEl = el('td-station-monitor-wrap'); const frame = el('td-station-monitor');
        if (!wrapEl || !frame) return;
        if (wrapEl.style.display !== 'none' && frame.dataset.roomId === r.id) {
          wrapEl.style.display = 'none'; frame.src = 'about:blank'; frame.dataset.roomId = '';
        } else {
          frame.src = r.monitorUrl; frame.dataset.roomId = r.id; wrapEl.style.display = '';
        }
      }));
      roomsList.querySelectorAll('.td-room-invite').forEach((btn) => btn.addEventListener('click', () => {
        const r = stationRooms[Number(btn.dataset.ri)];
        if (r && navigator.clipboard) navigator.clipboard.writeText(r.inviteUrl).then(() => showToast('Invite link copied.', '#22c55e', 2000));
      }));
    }
    // Saved shifts — click applies (slots + roles + on-shift marks + display options), × deletes.
    const shiftWrap = el('td-shift-chips');
    if (shiftWrap) {
      shiftWrap.innerHTML = '';
      if (!shifts.length) shiftWrap.innerHTML = '<span class="field-hint" style="margin:0;">No saved presets yet — set up the desk, then Save preset.</span>';
      const activeShiftId = (data.casters && data.casters.activeShiftId) || '';
      shifts.forEach((s) => {
        const isLoaded = s.id === activeShiftId;
        const chip = document.createElement('span');
        chip.className = 'td-chip td-shift-chip' + (isLoaded ? ' is-active' : '');
        chip.title = (isLoaded ? 'Currently loaded. ' : '') + 'Apply preset "' + (s.name || '') + '" — sets the desk slots, roles, on-shift marks and display options';
        chip.innerHTML = `<button type="button" class="td-shift-apply">${isLoaded ? '● ' : ''}${esc(s.name || 'Preset')}</button><button type="button" class="td-shift-del" title="Delete this preset">×</button>`;
        chip.querySelector('.td-shift-apply').addEventListener('click', () => {
          send('apply_shift', { id: s.id });
          showToast('Preset applied: ' + (s.name || 'Preset'), '#22c55e');
        });
        chip.querySelector('.td-shift-del').addEventListener('click', async () => {
          if (await appConfirm(`Delete the preset "${s.name}"? The current allocation is not affected.`, 'Delete')) send('delete_shift', { id: s.id });
        });
        shiftWrap.appendChild(chip);
      });
    }
  };
  el('td-add-crew')?.addEventListener('click', () => { if (typeof window.openCrewAdd === 'function') window.openCrewAdd(); });
  // Resolve a typed name/handle to a crew member (shared by the Support adder).
  el('td-support-assign')?.addEventListener('click', () => {
    const inp = el('td-support-search'); const typed = (inp?.value || '').trim();
    if (!typed) { showToast('Search for an existing crew member first.', '#fbbf24'); return; }
    const r = crewResolve(typed);
    if (r.ambiguous) {
      showToast(`"${typed}" matches ${r.ambiguous.map((c) => c.handle || c.name).join(', ')} — type more to pick one.`, '#fbbf24');
      return;
    }
    const m = r.member;
    if (!m) { showToast(`No crew member matching "${typed}" — use + Add Crew to create them first.`, '#fbbf24'); return; }
    const group = el('td-support-role-sel')?.value || 'producer';
    // Event-scoped add: lands on tonight's deck (and credits them via workedEvent server-side)
    // WITHOUT touching the crew record's group — the deck is per-show, the Crew page is forever.
    send('td_support_add', { crewId: m.id, role: TD_SUPPORT_LABEL[group] || group });
    if (inp) inp.value = '';
    showToast(`${m.handle || m.name} added to the credits screen`, '#22c55e');
  });
  el('td-support-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-support-rm]'); if (!btn) return;
    // Deck-only removal — the crew record (group, credit history, everything) is untouched.
    send('td_support_remove', { crewId: btn.dataset.supportRm });
  });
  // ── Shift handover ────────────────────────────────────────────────────────
  // "Next shift" is the crew changeover, not a preset browser: the people currently on the desk
  // have finished their stint, so they move to Off-Air Event Staff (which is what feeds the
  // credits screen) and the desk empties for the incoming lineup. If a saved preset follows the
  // loaded one the server seats it; otherwise you type the new lineup in.
  // "Prev shift" undoes the last handover — that crew go back on the desk and come off the
  // off-air list, since it's explicitly for people who AREN'T on camera.
  el('td-shift-next')?.addEventListener('click', async () => {
    const cs = (currentState && currentState.casters) || {};
    const lib = cs.library || [];
    const names = [];
    [1, 2, 3, 4].forEach((n) => {
      const e = (cs.lineup || []).find((x) => Number(x.slot) === n);
      const p = e && lib.find((l) => l && l.id === e.libraryId);
      if (p && p.name) names.push(p.name);
    });
    const roles = cs.showRoles || {};
    if (roles.host) names.push(roles.host);
    if (roles.observer) names.push(roles.observer);
    if (!names.length) { showToast('Nobody on the desk to hand over — fill the lineup first.', '#fbbf24'); return; }
    if (!await appConfirm(
      `Hand over the desk? ${names.join(', ')} move to Off-Air Event Staff (staying on the credits screen) and the desk clears for the next lineup.`,
      'Hand over')) return;
    send('shift_handover', {});
  });
  el('td-shift-prev')?.addEventListener('click', () => send('shift_restore', {}));

  el('td-shift-save')?.addEventListener('click', async () => {
    const name = await customPrompt('Save preset', 'Name this desk preset — saves the current slots, roles, on-shift marks and display options so you can re-apply them in one click.', '', 'Save');
    if (name) send('save_shift', { name });
  });
  el('td-shift-clear')?.addEventListener('click', async () => {
    if (await appConfirm('Clear the whole Show Deck — desk slots, show roles, credits and off-air event staff? Nobody is deleted: every crew profile stays in Crew, and saved presets are untouched.', 'Clear')) send('clear_shift');
  });

  // Group filter pills → sync hidden select + re-render
  const crewGroupNav = el('crew-group-nav');
  if (crewGroupNav) {
    crewGroupNav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-group]');
      if (!btn) return;
      crewGroupNav.querySelectorAll('.talent-page-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (filterGroup) { filterGroup.value = btn.dataset.group; filterGroup.dispatchEvent(new Event('change')); }
    });
  }

  // Delegate delete + edit clicks on the crew list
  const list = el('crew-list');
  if (list) list.addEventListener('click', (e) => {
    const del  = e.target.closest('[data-crew-del]');
    const edit = e.target.closest('[data-crew-edit]');
    if (del) {
      // Inline 2-step confirm (same pattern as the CF caster cards): first click arms,
      // second click within 3s deletes. Deleting is destructive — it also removes the
      // caster's library profile and frees their desk slot server-side.
      if (del.dataset.armed) {
        send('delete_crew_member', { id: del.dataset.crewDel });
        setTimeout(renderCrewList, 300);
      } else {
        del.dataset.armed = '1';
        del.textContent = 'Sure?';
        del.style.color = '#f56565';
        setTimeout(() => {
          if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Del'; del.style.color = ''; }
        }, 3000);
      }
    }
    if (edit) {
      const card = edit.closest('[data-crew-id]'); if (!card) return;
      openCrewEdit(JSON.parse(card.dataset.crewData || '{}'));
    }
  });

  // Import
  const importBtn = el('crew-import-btn');
  const importFile = el('crew-import-file');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', () => {
      const file = importFile.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          const entries = Array.isArray(data) ? data : (Array.isArray(data.crew) ? data.crew : []);
          entries.forEach((m) => {
            send('add_crew_member', { name: m.name, handle: m.handle, role: m.role, group: m.group,
              social: m.social, socialHandle: m.socialHandle, defaultCam: m.defaultCam,
              country: m.country, paypal: m.paypal, notes: m.notes });
          });
          setTimeout(renderCrewList, 500);
        } catch (e) { alert('Invalid JSON file'); }
        importFile.value = '';
      };
      reader.readAsText(file);
    });
  }

  // Export
  const exportBtn = el('crew-export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const members = (typeof currentState !== 'undefined' && currentState.crew) ? currentState.crew : [];
      const json = JSON.stringify(members, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'crew-library.json';
      a.click();
    });
  }

  // Sort A-Z
  const sortBtn = el('crew-sort-btn');
  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      const members = (typeof currentState !== 'undefined' && currentState.crew) ? [...currentState.crew] : [];
      if (!members.length) return;   // library tier not loaded yet — nothing to sort
      members.sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
      send('update_crew_order', { crew: members });
      setTimeout(renderCrewList, 300);
    });
  }

  // Delete All
  const deleteAllBtn = el('crew-delete-all-btn');
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', async () => {
      const members = (typeof currentState !== 'undefined' && currentState.crew) ? currentState.crew : [];
      if (!members.length) return;
      if (!(await appConfirm(`Delete all ${members.length} crew member${members.length === 1 ? '' : 's'}? This cannot be undone.`, 'Delete'))) return;
      send('delete_all_crew', {});
      setTimeout(renderCrewList, 300);
    });
  }

  // Called from the Hosts grid edit button — bridges library entry to crew profile form
  window._openCrewFormEdit = function(libId) {
    const lib  = (currentState && currentState.casters && currentState.casters.library) || [];
    const crew = (currentState && currentState.crew) || [];
    const libEntry = lib.find((e) => e.id === libId);
    if (!libEntry) return;
    const kindToGroup = { caster: 'casters', observer: 'observers', host: 'hosts' };
    const nm = (libEntry.name || '').toLowerCase();
    const hd = (libEntry.handle || '').toLowerCase();
    const crewEntry = crew.find((c) =>
      (nm && c.name && c.name.toLowerCase() === nm) ||
      (hd && c.handle && c.handle.toLowerCase() === hd)
    );
    const libCamUrl = libEntry.camUrl || '';
    if (crewEntry) {
      openCrewEdit({ ...crewEntry, camUrl: libCamUrl }, libId);
    } else {
      openCrewEdit({
        id: null, name: libEntry.name || '', handle: libEntry.handle || '',
        role: libEntry.role || '', group: kindToGroup[libEntry.kind] || 'casters',
        social: 'none', socialHandle: '', country: libEntry.country || '',
        defaultCam: '', paypal: '', camUrl: libCamUrl, notes: libEntry.notes || '',
      }, libId);
    }
  };
})();

// A crew member's caster-library twin, resolved by name/handle (the same match the
// server dedupes on). Used to carry the library id through edits so renames update
// the existing entry instead of forking a duplicate.
function crewLibraryEntry(d) {
  const cast = (typeof currentState !== 'undefined' && currentState.casters) || {};
  const lib = cast.library || [];
  const nm = (d.name || '').toLowerCase(), hd = (d.socialHandle || d.handle || '').toLowerCase();
  return lib.find((c) => nm && (c.name || '').toLowerCase() === nm)
      || (hd && lib.find((c) => (c.handle || '').toLowerCase() === hd))
      || null;
}
function crewLibraryId(d) {
  const prof = crewLibraryEntry(d);
  return prof ? prof.id : null;
}
// A crew member's current desk-lineup slot (0 = off desk). The lineup keys on the caster-library id.
function crewDeskSlot(d) {
  const cast = (typeof currentState !== 'undefined' && currentState.casters) || {};
  const lineup = cast.lineup || [];
  const prof = crewLibraryEntry(d);
  if (!prof) return 0;
  const e = lineup.find((x) => x.libraryId === prof.id);
  return e ? (Number(e.slot) || 0) : 0;
}

// ── In-Game Player Cams (HUD facecams) ──────────────────────────────────────
// Maps in-game player names → a person's cam feed and saves them as facecam
// entries ({name, platformId, link}) which the game HUD overlays (RL statcard /
// replay grid) resolve by in-game name or platform id. Names auto-pull from the
// live game feed (RL Stats API / CS2 GSI) and fall back to the match rosters.
let _pcamVdoCache = null;
async function _pcamVdoLinks(force) {
  if (_pcamVdoCache && !force) return _pcamVdoCache;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/vdo/links');
    _pcamVdoCache = await r.json();
  } catch (e) { _pcamVdoCache = null; }
  return _pcamVdoCache;
}
// Website-hosted camera-session feeds (masked VDO links from studio.namelessesports.com/cameras/[token]).
// Populated async via the cloud_list_camera_feeds WS round-trip (see applyCloudStatus + the
// 'cloud_camera_feeds' message handler below) since only server.js holds cloud credentials.
let _pcamCloudFeedsCache = [];
// Every linkable cam feed: match-team players (VDO room feeds), team library, crew cams, cloud feeds.
function _pcamSources(vdo) {
  const out = [], seen = new Set();
  const push = (person, label, url, group) => {
    const u = (url || '').toString().trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ person: (person || '').toLowerCase(), label, url: u, group });
  };
  if (vdo && vdo.teams) ['blue', 'orange'].forEach((side) => {
    const t = vdo.teams[side]; if (!t) return;
    (t.players || []).forEach((p) => push(p.name, `${p.name} — ${t.name || side}`, p.obsUrl, 'Talent Rooms: this match'));
  });
  ((vdo && vdo.allTeams) || []).forEach((t) => (t.players || []).forEach((p) =>
    push(p.name, `${p.name} — ${t.name}`, p.obsUrl, 'Talent Rooms: saved teams')));
  ((currentState?.casters?.library) || []).forEach((c) =>
    push(c.name || c.handle, `${c.name || c.handle} — crew`, c.vdoOverride || c.camUrl, 'Crew'));
  (((currentState && currentState.lanSeats && currentState.lanSeats.enabled && currentState.lanSeats.seats) || [])).forEach((x) =>
    push('', `${_lanSideName(x.side)}, ${x.label}`, x.link, 'LAN seats'));
  (_pcamCloudFeedsCache || []).forEach((f) =>
    push(f.personName, `${f.personName}${f.teamName ? ' — ' + f.teamName : ''} (cloud)`, f.obsViewUrl, 'Cloud cameras'));
  return out;
}

// Website-hosted Stations caster/observer feeds (see /studio/access/stations). Populated async via
// the cloud_list_station_feeds WS round-trip (see applyCloudStatus + the 'cloud_station_feeds'
// message handler below). A caster feed becomes a normal Caster Library entry with one click,
// landing in the SAME numbered slot they claimed on the website — openCrewDialog's existing slot
// picker handles everything else from there, exactly like a manually-added caster.
let _cfStationsCache = [];
function renderCfStations() {
  const section = el('cf-cloudstations-section');
  const wrap = el('cf-cloudstations-list');
  const status = el('cf-cloudstations-status');
  if (!section || !wrap) return;
  // Auto-fill toggle mirrors server state (default on; wired once).
  const af = el('cf-cloudstations-autofill');
  if (af) {
    af.checked = !(currentState && currentState.casters && currentState.casters.autoFillFromStations === false);
    if (!af._wired) { af._wired = true; af.addEventListener('change', () => send('set_station_autofill', { on: af.checked })); }
  }
  // Station binding picker — which website station THIS app follows ('' = all).
  const bindSel = el('cf-cloudstations-binding');
  const binding = (currentState && currentState.casters && currentState.casters.stationId) || '';
  if (bindSel) {
    const stations = window._cfStationsIndex || [];
    const opts = ['<option value="">All stations</option>']
      .concat(stations.map((s) => `<option value="${tlEsc(s.id)}"${s.id === binding ? ' selected' : ''}>${tlEsc(s.name)}</option>`));
    // Keep an unknown-but-bound station selectable so the choice is visible even before the list loads.
    if (binding && !stations.some((s) => s.id === binding)) opts.push(`<option value="${tlEsc(binding)}" selected>(bound station)</option>`);
    bindSel.innerHTML = opts.join('');
    bindSel.value = binding;
    if (!bindSel._wired) {
      bindSel._wired = true;
      bindSel.addEventListener('change', () => {
        send('set_station_binding', { stationId: bindSel.value });
        // Refresh the invite-link cockpit for the newly bound station.
        if (window._cloudWorkspaceId) setTimeout(() => send('cloud_list_stations', { orgId: window._cloudWorkspaceId }), 400);
      });
    }
  }
  // The bound station's invite-link cockpit — caster/observer room invites, producer talkback,
  // player-camera links and team-match links, all copyable HERE (no website tab mid-show).
  const detail = window._cfStationDetail || null;
  const _kindColor = { observer: '#2dd4bf', camera: '#f59e0b', match: '#60a5fa' };
  const _linkRow = (kind, badge, name, sub, buttons) =>
    `<div class="pcam-row" style="display:flex;align-items:center;gap:10px;padding:3px 0;">
      <span style="flex:0 0 auto;font-size:9px;font-weight:800;letter-spacing:.08em;color:${_kindColor[kind] || '#8b5cf6'};text-transform:uppercase;">${tlEsc(badge)}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:700;color:#e8eaf0;">${tlEsc(name)}
        ${sub ? `<span style="margin-left:6px;font-size:10px;font-weight:500;color:#9090a8;">${tlEsc(sub)}</span>` : ''}
      </span>${buttons}</div>`;
  const _copyBtn = (url, label, title) => `<button class="btn btn-secondary btn-xs cf-station-copylink" data-url="${tlEsc(url)}" title="${tlEsc(title || url)}">${tlEsc(label)}</button>`;
  let detailHtml = '';
  if (detail) {
    const rows = [];
    (detail.rooms || []).forEach((r) => rows.push(_linkRow(r.kind, r.kind === 'observer' ? 'Observer' : 'Casters', r.name, `${r.connected}/${r.slots} connected`,
      _copyBtn(r.inviteUrl, 'Copy invite', 'The one link casters/observers use to check in')
      + (r.kind === 'caster' ? ' ' + _copyBtn(r.talkbackUrl, 'Talkback', 'Join this room yourself without taking a placement') : ''))));
    (detail.cameras || []).forEach((c) => rows.push(_linkRow('camera', 'Players', c.name, `${c.slots} slots`,
      _copyBtn(c.shareUrl, 'Copy player link', 'Players claim their camera slot on this link'))));
    (detail.matches || []).forEach((m) => rows.push(_linkRow('match', 'Match', m.label, '',
      _copyBtn(m.joinUrl, 'Copy join', 'One link for both teams') + ' ' + _copyBtn(m.matchUrl, 'Monitor', 'Producer monitor + slot assignments'))));
    if (rows.length) {
      detailHtml = `<div style="margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#9090a8;margin-bottom:2px;">${tlEsc(detail.stationName || 'Station')} — invite links</div>
        ${rows.join('')}</div>`;
    }
  }
  const _wireCopyLinks = () => wrap.querySelectorAll('.cf-station-copylink').forEach((btn) => btn.addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(btn.dataset.url).then(() => showToast('Link copied.', '#22c55e', 2000));
  }));
  // Bound station → only ITS feeds show/fill here; the section stays visible while bound
  // (even with zero feeds yet) so the binding is never invisible.
  const allFeeds = _cfStationsCache || [];
  const feeds = binding ? allFeeds.filter((f) => f && f.stationId === binding) : allFeeds;
  // Show for any org-connected app (even with zero feeds) so the "+ … link" generators are reachable.
  const isOrgConnected = !!(window._cloudWorkspaceId && !String(window._cloudWorkspaceId).startsWith('user:'));
  section.style.display = (feeds.length || binding || isOrgConnected || (window._cfStationsIndex || []).length) ? '' : 'none';
  // Unbound + several active stations = auto-fill deliberately paused (isolation between desks).
  const multiUnbound = !binding && (window._cfStationsIndex || []).length > 1;
  if (!feeds.length) {
    wrap.innerHTML = detailHtml;
    _wireCopyLinks();
    if (status) status.textContent = multiUnbound
      ? 'Multiple stations are active in your org — pick which station THIS app follows (Station picker above). Auto-fill is paused until you choose, so desks never interfere.'
      : (binding ? 'No one from this station has checked in yet — feeds appear here (and auto-fill the desk) as casters claim their slots.' : '');
    return;
  }
  if (status && multiUnbound) status.textContent = 'Multiple stations are active — pick which station THIS app follows (Station picker above). Auto-fill is paused until you choose.';

  const lib = (currentState && currentState.casters && currentState.casters.library) || [];
  const lineup = (currentState && currentState.casters && currentState.casters.lineup) || [];
  const slotLabels = (currentState && currentState.casters && currentState.casters.slotLabels) || {};
  const inLibrary = (url) => lib.some((c) => (c.camUrl || c.vdoOverride) === url);

  wrap.innerHTML = detailHtml + feeds.map((f, i) => {
    const already = inLibrary(f.obsViewUrl);
    const kindLabel = f.kind === 'caster' ? 'Caster' : 'Observer';
    return `<div class="pcam-row" style="display:flex;align-items:center;gap:10px;padding:3px 0;">
      <span style="flex:0 0 auto;font-size:9px;font-weight:800;letter-spacing:.08em;color:#8b5cf6;text-transform:uppercase;">${tlEsc(kindLabel)}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:700;color:#e8eaf0;" title="${tlEsc(f.stationName)} — ${tlEsc(f.roomName)}">${tlEsc(f.personName)}
        <span style="margin-left:6px;font-size:10px;font-weight:500;color:#9090a8;">${tlEsc(f.stationName)}</span>
      </span>
      ${f.kind === 'caster'
        ? (already
            ? '<span style="font-size:10px;font-weight:700;color:#22c55e;">In library</span>'
            : `<button class="btn btn-secondary btn-xs cf-station-add-caster" data-idx="${i}">+ Add to Caster Library</button>`)
        : `<button class="btn btn-secondary btn-xs cf-station-copy" data-idx="${i}">Copy OBS URL</button>`}
    </div>`;
  }).join('');

  wrap.querySelectorAll('.cf-station-add-caster').forEach((btn) => btn.addEventListener('click', async () => {
    const f = feeds[Number(btn.dataset.idx)];
    if (!f) return;
    // Only offer to auto-assign the lineup slot when it's free — never bump whoever's already
    // on air. Going live is the one part of this action that needs an explicit yes: adding to
    // the library is just data entry, but this slot being free means clicking through puts
    // someone on the broadcast immediately with no other cue that just happened.
    const targetSlot = (Number(f.idx) || 0) + 1;
    const occupied = lineup.some((l) => l.slot === targetSlot);
    const canGoLive = !occupied && targetSlot >= 1 && targetSlot <= 4;
    if (canGoLive) {
      const ok = await appConfirm(`Put ${f.personName} on air now as ${slotLabels[targetSlot] || ('Caster ' + targetSlot)}?`, 'Go Live', false);
      if (!ok) return;
    }
    const id = 'cs_' + Math.random().toString(36).slice(2, 11);
    // Auto-link to the crew database: the join page offers crew profiles by name, so a match
    // here means "that crew member checked in" → put them on shift. No match = a new face →
    // create their crew profile so credits/Show Deck pick them up without manual entry.
    const crewList = (currentState && currentState.crew) || [];
    const nm = (f.personName || '').trim().toLowerCase();
    const cm = nm ? crewList.find((c) => c && ((c.name || '').toLowerCase() === nm || (c.handle || '').toLowerCase() === nm)) : null;
    // active means ON THE DESK RIGHT NOW, and nothing ever clears it — so only set it when this
    // pull-in actually seats them. Pulling a checked-in caster into the library is not the same as
    // putting them on air; latching the flag here left people marked on-shift (and, until the
    // credits stopped reading it, rolling in the credits) who never took a slot.
    if (cm) { if (canGoLive) send('update_crew_member', { id: cm.id, active: true }); }
    else if (nm) send('add_crew_member', { name: f.personName.trim(), group: 'casters', active: canGoLive });
    send('save_caster_to_library', { id, name: f.personName, kind: 'caster', camUrl: f.obsViewUrl,
      ...(cm ? { social: cm.social, socialHandle: cm.socialHandle, country: cm.country } : {}) });
    if (canGoLive) {
      const newLineup = lineup.map((x) => ({ ...x }));
      newLineup.push({ libraryId: id, slot: targetSlot, roomId: '', streamId: id });
      send('set_caster_lineup', { lineup: newLineup });
      showToast(`Added ${f.personName} — on air as ${slotLabels[targetSlot] || ('Caster ' + targetSlot)}.`, '#22c55e', 3000);
    } else {
      showToast(`Added ${f.personName} to the Caster Library — assign a slot from Camera Feeds → Talent Rooms.`, '#22c55e', 3800);
    }
  }));
  wrap.querySelectorAll('.cf-station-copy').forEach((btn) => btn.addEventListener('click', () => {
    const f = feeds[Number(btn.dataset.idx)];
    if (f && navigator.clipboard) navigator.clipboard.writeText(f.obsViewUrl).then(() => showToast('OBS URL copied.', '#22c55e', 2000));
  }));
  _wireCopyLinks();
}
// Player cams: one row per in-game player, each linked to a camera feed. The HUD shows the cam of
// whoever is being spectated, matching the same way _pcamFind does here.
// A real account id, or '' for the placeholders RL / CS2 send for bots and hidden accounts.
function _pcamId(raw) { const s = (raw == null ? '' : String(raw)).trim(); return (!s || /^0*$/.test(s) || /^unknown$/i.test(s)) ? '' : s; }
function _pcamKey(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function _pcamFind(facecams, row) {
  const id = _pcamId(row.pid);
  return (id && facecams.find((f) => f.platformId && String(f.platformId) === id))
    || facecams.find((f) => f.name === row.name)
    || facecams.find((f) => _pcamKey(f.name) === _pcamKey(row.name)) || null;
}
// LAN seat cameras (backend/lan-seats.js): one permanent link per seat, and each match the producer
// says who is sitting where (or each seat's helper reports it). Shared by every Player cams mount.
// The name for a side of seats: the team whose in-game players are seated there, else the loaded
// team for that side (Team 1 side = blue, Team 2 side = orange).
function _lanSideName(sd) {
  const st = currentState || {};
  const ls = st.lanSeats || {};
  const players = Array.isArray(st.players) ? st.players : [];
  const votes = [0, 0];
  (ls.seats || []).filter((x) => x.side === sd && x.player).forEach((x) => {
    const p = players.find((pl) => _pcamKey(pl.name) === _pcamKey(x.player));
    if (p) votes[Number(p.team) === 1 ? 1 : 0]++;
  });
  const t = votes[0] || votes[1] ? (votes[1] > votes[0] ? 1 : 0) : (sd === 'b' ? 1 : 0);
  const team = st.teams && st.teams[t ? 'orange' : 'blue'];
  return (team && team.name) || (sd === 'b' ? 'Team 2' : 'Team 1');
}
function _lanAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago';
}
function _pcamSeatsHtml(rows) {
  const ls = (currentState && currentState.lanSeats) || {};
  const mode = `<div class="pcam-mode" role="group" aria-label="How cameras are set up">
      <span>Cameras</span>
      <button type="button" data-lanmode="player" class="${ls.enabled ? '' : 'is-on'}" title="Remote: every player has their own camera link that follows them">Each player's own link</button>
      <button type="button" data-lanmode="seat" class="${ls.enabled ? 'is-on' : ''}" title="LAN: a camera at every seat with a permanent link; say who is sitting where each match">LAN seats</button>
    </div>`;
  if (!ls.enabled) return mode;
  const seats = ls.seats || [];
  const ag = ls.agent || {};
  const seen = ls.seen || {};
  const live = rows.filter((r) => r.live);
  const opts = (cur) => {
    const names = live.map((r) => r.name);
    if (cur && !names.some((n) => _pcamKey(n) === _pcamKey(cur))) names.push(cur);
    const team = (n) => { const r = live.find((x) => x.name === n); return r ? _lanTeamName(r.team) : 'Not in the lobby'; };
    const groups = {};
    names.forEach((n) => { (groups[team(n)] = groups[team(n)] || []).push(n); });
    return '<option value="">Empty seat</option>' + Object.keys(groups).map((g) => `<optgroup label="${tlEsc(g)}">` + groups[g].map((n) =>
      `<option value="${tlEsc(n)}"${_pcamKey(n) === _pcamKey(cur) ? ' selected' : ''}>${tlEsc(n)}</option>`).join('') + '</optgroup>').join('');
  };
  const helperLine = (s) => {
    if (!ag.enabled) return '';
    const h = seen[s.id];
    const fresh = h && Date.now() - h.at < 60000;
    return `<div class="lan-helper${fresh ? ' is-live' : ''}">${h ? (fresh ? 'Helper sees ' : 'Helper last saw ') + tlEsc(h.name) + ' · ' + _lanAgo(h.at) : 'No helper reporting from this seat yet'}
      <button type="button" class="lan-helper-dl" title="Download this seat's helper: run it on the PC at this seat and leave it open">Get helper</button></div>`;
  };
  const side = (sd) => `<div class="lan-side lan-side-${sd}"><div class="lan-side-head">${tlEsc(_lanSideName(sd))}<small>${sd === 'b' ? 'Side 2' : 'Side 1'}</small></div>${seats.filter((s) => s.side === sd).map((s) => `
      <div class="lan-seat${s.player ? ' is-filled' : ''}" data-seat="${tlEsc(s.id)}">
        <div class="lan-seat-row">
          <button type="button" class="lan-seat-name lan-rename" title="Rename this seat (e.g. PC 4)">${tlEsc(s.label)}</button>
          <select class="input-select lan-seat-sel" data-seat="${tlEsc(s.id)}" title="Who is sitting here this match">${opts(s.player)}</select>
          <button type="button" class="btn btn-ghost btn-xs lan-copy" title="Copy this seat's camera link (open it on the seat PC once; it never changes)"${s.joinUrl ? '' : ' disabled'}>Copy link</button>
          <button type="button" class="btn btn-ghost btn-xs lan-custom${s.custom ? ' is-on' : ''}" title="${s.custom ? 'Using your own camera link. Click to change or clear it' : 'Use your own camera link for this seat (capture card, other service)'}">${s.custom ? 'Own link' : '…'}</button>
        </div>
        ${helperLine(s)}
      </div>`).join('')}</div>`;
  const filled = seats.filter((s) => s.player).length;
  return mode + `<div class="lan-panel">
      <div class="lan-tools">
        <span class="lan-count">${filled} of ${seats.length} seats filled</span>
        <label class="lan-per">Seats per side
          <select class="input-select lan-per-sel">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${n === ls.perSide ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <span style="flex:1"></span>
        <button type="button" class="btn btn-ghost btn-sm lan-copyall">Copy all seat links</button>
        <button type="button" class="btn btn-ghost btn-sm lan-autoseat" title="Put players back in the seat they used last time (empty seats only)">Seat returning players</button>
        <button type="button" class="btn btn-secondary btn-sm lan-clear" title="Empty every seat for the next match (the links stay)">Next match: clear seats</button>
      </div>
      <div class="lan-auto">
        <label class="qt-toggle" title="A small helper on each seat PC reads that PC's own Rocket League and tells this app who is playing there">
          <span>Seat PCs report who is playing</span>
          <span class="switch"><input type="checkbox" class="lan-agent-toggle"${ag.enabled ? ' checked' : ''}><span class="slider"></span></span>
        </label>
        <span class="lan-auto-note">${ag.enabled
          ? (ls.agentError ? '<b class="lan-err">' + tlEsc(ls.agentError) + '</b>' : 'Listening on port ' + tlEsc(ag.port) + '. Run each seat\'s helper on that seat\'s PC (Rocket League Stats API on there too). Windows may ask to allow the app on your network the first time: allow it on private networks.')
          : 'Off: you pick who sits where. Returning players are still seated automatically.'}</span>
      </div>
      <div class="lan-sides">${side('a')}${side('b')}</div>
      <p class="lan-hint">Open each seat's camera link once on that seat's PC (it stays the same all event). <button type="button" class="lan-newlinks">New links</button></p>
    </div>`;
}
// "Frost Esports" for an in-game team number, from the loaded teams.
function _lanTeamName(team) {
  const t = currentState && currentState.teams && currentState.teams[Number(team) === 1 ? 'orange' : 'blue'];
  return (t && t.name) || (Number(team) === 1 ? 'Orange' : 'Blue');
}
function _pcamSeatClick(e) {
  const t = e.target;
  const ls = (currentState && currentState.lanSeats) || {};
  const seatEl = t.closest('.lan-seat');
  const seat = seatEl ? (ls.seats || []).find((s) => s.id === seatEl.dataset.seat) : null;
  const copy = (txt, msg) => { if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => showToast(msg, '#22c55e', 2000)).catch(() => customPrompt('Copy link', 'Select the link and copy it.', txt, 'Done')); };
  const mode = t.closest('[data-lanmode]');
  if (mode) { send('lan_seats_set', { enabled: mode.dataset.lanmode === 'seat' }); return true; }
  if (t.closest('.lan-copy') && seat) { copy(seat.joinUrl, `${_lanSideName(seat.side)} ${seat.label} link copied.`); return true; }
  if (t.closest('.lan-helper-dl') && seat) {
    fetch('http://127.0.0.1:3000/api/lan-seats/helper?seat=' + encodeURIComponent(seat.id))
      .then((r) => r.ok ? r.blob() : Promise.reject(new Error('Turn on seat helpers first.')))
      .then((b) => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'seat-helper-' + seat.id + '.cmd';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        showToast('Saved the helper for ' + seat.label + '. Copy it to that seat PC and double-click it.', '#22c55e', 4500);
      })
      .catch((err) => showToast(err.message, '#c53030', 3000));
    return true;
  }
  if (t.closest('.lan-copyall')) { copy((ls.seats || []).map((s) => `${_lanSideName(s.side)}, ${s.label}: ${s.joinUrl}`).join('\n'), 'All seat links copied.'); return true; }
  if (t.closest('.lan-clear')) { send('lan_seats_clear', {}); showToast('Seats cleared for the next match.', '#22c55e', 2000); return true; }
  if (t.closest('.lan-autoseat')) { send('lan_seats_autoseat', {}); return true; }
  if (t.closest('.lan-rename') && seat) {
    customPrompt('Rename seat', `${_lanSideName(seat.side)}. For example: PC 4, Station B2.`, seat.label, 'Rename').then((v) => { if (v != null) send('lan_seats_set', { names: { [seat.id]: v } }); });
    return true;
  }
  if (t.closest('.lan-custom') && seat) {
    const ask = () => customPrompt('Seat camera link', `${_lanSideName(seat.side)}, ${seat.label}. Paste a link to use instead of the seat's own VDO.ninja link (a capture card page, another service).`, seat.custom ? seat.link : '', 'Save')
      .then((v) => { if (v) send('lan_seat_link', { seatId: seat.id, link: v }); });
    // The dialog treats an empty box as Cancel, so going back to the seat's own link is its own question.
    if (seat.custom) appConfirm("Go back to this seat's own VDO.ninja link?", 'Use seat link', false).then((ok) => { if (ok) send('lan_seat_link', { seatId: seat.id, link: '' }); else ask(); });
    else ask();
    return true;
  }
  if (t.closest('.lan-newlinks')) {
    appConfirm('Make new links for every seat? The old seat links stop working, so each seat PC needs its new link.', 'New links', true).then((ok) => { if (ok) send('lan_seats_new_rooms', {}); });
    return true;
  }
  return false;
}
function _pcamSeatChange(e) {
  const sel = e.target.closest('.lan-seat-sel');
  if (sel) { send('lan_seat_assign', { seatId: sel.dataset.seat, name: sel.value }); return true; }
  const ag = e.target.closest('.lan-agent-toggle');
  if (ag) { send('lan_seats_agent', { enabled: ag.checked }); return true; }
  const per = e.target.closest('.lan-per-sel');
  if (per) { send('lan_seats_set', { perSide: Number(per.value) }); return true; }
  return false;
}
// In-game names: live RL feed → live CS2 feed → match rosters as a fallback.
function _pcamRows() {
  const st = currentState || {};
  const rl = Array.isArray(st.players) ? st.players : [];
  const cs = (st.csgo && Array.isArray(st.csgo.players)) ? st.csgo.players : [];
  if (rl.length) return rl.map((p) => ({ name: p.name || '', pid: _pcamId(p.primaryid ? String(p.primaryid).split('|')[1] : ''), team: Number(p.team) === 1 ? 1 : 0, live: true })).filter((r) => r.name && r.name !== '?');
  if (cs.length) return cs.map((p) => ({ name: p.name || '', pid: _pcamId(p.steamid), team: /^t$/i.test(p.team || '') ? 1 : 0, live: true })).filter((r) => r.name);
  const rows = [];
  ['blue', 'orange'].forEach((side, ti) => ((st.teams?.[side]?.players) || []).forEach((p) => {
    const n = p.gamertag || p.name;
    if (n) rows.push({ name: n, pid: '', team: ti, live: false });
  }));
  return rows;
}
const _PCAM_MOUNTS = [
  { rows: 'msp-playercams-rows', status: 'msp-playercams-status' },
  { rows: 'dcc-playercams-rows', status: 'dcc-playercams-status' },
  { rows: 'cfp-playercams-rows', status: 'cfp-playercams-status' },
];
// Renders the msp/dcc/cfp player-cam mapping mounts. Named distinctly from the Dashboard's
// renderPlayerCams — the two used to share a name and this (earlier) declaration was silently
// shadowed by the later one, leaving these mounts permanently empty.
async function renderPlayerCamMounts(forceVdo) {
  const mounts = _PCAM_MOUNTS.map((m) => ({ rows: el(m.rows), status: el(m.status) })).filter((m) => m.rows);
  if (!mounts.length) return;
  const vdo = await _pcamVdoLinks(forceVdo);
  const sources = _pcamSources(vdo);
  const facecams = (currentState && currentState.facecams) || [];
  const rows = _pcamRows();
  const st = currentState || {};
  const anyLive = rows.some((r) => r.live);
  const groups = {};
  sources.forEach((s) => { (groups[s.group] = groups[s.group] || []).push(s); });
  const linked = rows.filter((r) => { const fc = _pcamFind(facecams, r); return fc && fc.link; }).length;
  const rowHtml = (r) => {
    const fc = _pcamFind(facecams, r);
    const cur = (fc && fc.link) || '';
    const inSources = sources.some((s) => s.url === cur);
    const opts = ['<option value="">No camera</option>'];
    Object.keys(groups).forEach((g) => {
      opts.push(`<optgroup label="${tlEsc(g)}">` + groups[g].map((s) =>
        `<option value="${tlEsc(s.url)}"${s.url === cur ? ' selected' : ''}>${tlEsc(s.label)}</option>`).join('') + '</optgroup>');
    });
    if (cur && !inSources) opts.push(`<option value="${tlEsc(cur)}" selected>Pasted link</option>`);
    opts.push('<option value="__custom__">Paste a camera link…</option>');
    return `<div class="pcam-row${cur ? ' has-cam' : ''}">
      <span class="pcam-dot" title="${cur ? 'Has a camera' : 'No camera yet'}"></span>
      <span class="pcam-name" title="${tlEsc(r.name)}">${tlEsc(r.name)}</span>
      <select class="input-select pcam-sel" data-pcam="${tlEsc(r.name)}" data-pid="${tlEsc(r.pid)}">${opts.join('')}</select>
    </div>`;
  };
  const teamName = (i) => { const t = st.teams && st.teams[i ? 'orange' : 'blue']; return (t && t.name) || (i ? 'Orange' : 'Blue'); };
  const html = rows.length ? [0, 1].map((ti) => {
    const list = rows.filter((r) => r.team === ti);
    if (!list.length) return '';
    return `<div class="pcam-team pcam-team-${ti ? 'orange' : 'blue'}"><div class="pcam-team-head">${tlEsc(teamName(ti))}</div>${list.map(rowHtml).join('')}</div>`;
  }).join('') : '';
  // In-game players who aren't on their team's roster have no Talent Rooms camera link of their own.
  const missing = _pcamMissingFromRoster(rows);
  const callout = missing.length
    ? `<div class="pcam-callout"><span>${missing.length === 1 ? tlEsc(missing[0].name) + ' is' : missing.length + ' players are'} not on the team roster yet, so Talent Rooms has no camera link for ${missing.length === 1 ? 'them' : 'them'}. Add them and each player gets their own link, already linked here.</span><button type="button" class="btn btn-primary btn-sm pcam-addroster">Add to rosters</button></div>`
    : '';
  const isRL = (st.activeGame || '') === 'rocket-league' || st.rlConnected;
  let statusText;
  if (!rows.length) {
    statusText = isRL && st.rlConnected
      ? 'Rocket League is connected. Join or spectate the match and the players show up here.'
      : 'No players yet. Open the game and spectate the match (or load the two teams on the Match page), then press Refresh.';
  } else if (anyLive) {
    statusText = `${linked} of ${rows.length} players have a camera. Names come straight from the game, so the HUD will find them.`;
  } else {
    statusText = `Showing roster names: ${isRL ? 'Rocket League' : 'the game'} isn't sending player data yet, and in-game names can differ. Spectate the match and press Refresh to get the exact names.`;
  }
  const off = st.facecamsEnabled === false;
  if (off) statusText = 'Player cams are switched off, so the HUD shows no cameras. Turn on Show on HUD. ' + statusText;
  mounts.forEach((m) => {
    // Don't rebuild a grid the user is actively picking in — a state-driven re-render would
    // otherwise reset the open dropdown mid-selection (why the DCC "wouldn't let me assign").
    if (m.rows.contains(document.activeElement)) return;
    m.rows.innerHTML = _pcamSeatsHtml(rows) + ((st.lanSeats && st.lanSeats.enabled) ? '' : callout) + html;
    m.rows.classList.add('pcam-list');
    if (m.status) { m.status.textContent = statusText; m.status.classList.toggle('pcam-warn', off || (!!rows.length && !anyLive)); }
  });
}
// Live in-game players with no roster entry (by in-game name or gamertag) on their side's team.
function _pcamMissingFromRoster(rows) {
  const st = currentState || {};
  return rows.filter((r) => r.live).filter((r) => {
    const roster = (st.teams && st.teams[r.team ? 'orange' : 'blue'] && st.teams[r.team ? 'orange' : 'blue'].players) || [];
    return !roster.some((p) => _pcamKey(p.gamertag || '') === _pcamKey(r.name) || _pcamKey(p.name) === _pcamKey(r.name));
  });
}
// Put the missing in-game players on their team's roster (exact in-game name, account id), then link
// each one to the Talent Rooms camera link that creates for them.
function _pcamAddToRosters() {
  const missing = _pcamMissingFromRoster(_pcamRows());
  if (!missing.length) return;
  missing.forEach((r) => send('add_player', { side: r.team ? 'orange' : 'blue', player: { name: r.name, primaryid: r.pid || '' } }));
  showToast(`Added ${missing.length} player${missing.length === 1 ? '' : 's'} to the rosters. Send each one their invite link from Talent Rooms.`, '#22c55e', 4500);
  setTimeout(() => _pcamAutoMatch(true), 900);
}
function _pcamAutoMatch(forceVdo) {
  (async () => {
    const vdo = await _pcamVdoLinks(forceVdo === true);
    const sources = _pcamSources(vdo);
    const facecams = (currentState && currentState.facecams) || [];
    let linked = 0;
    _pcamRows().forEach((r) => {
      const have = _pcamFind(facecams, r); if (have && have.link) return;   // already mapped
      const hit = sources.find((s) => _pcamKey(s.person) === _pcamKey(r.name));
      if (hit) { send('save_facecam', { name: r.name, platformId: r.pid, link: hit.url }); linked++; }
    });
    showToast(linked ? `Auto-linked ${linked} player cam${linked !== 1 ? 's' : ''}` : 'No name matches found — link them with the dropdowns', linked ? '#22c55e' : '#fbbf24');
    setTimeout(() => renderPlayerCamMounts(), 400);
  })();
}
;(function wirePlayerCams() {
  _PCAM_MOUNTS.forEach((m) => {
    const rowsEl = el(m.rows); if (!rowsEl) return;
    rowsEl.addEventListener('click', (e) => { if (_pcamSeatClick(e)) return; if (e.target.closest('.pcam-addroster')) _pcamAddToRosters(); });
    rowsEl.addEventListener('change', async (e) => {
      if (_pcamSeatChange(e)) return;
      const sel = e.target.closest('[data-pcam]'); if (!sel) return;
      const name = sel.dataset.pcam, pid = sel.dataset.pid || '';
      let link = sel.value;
      if (link === '__custom__') {
        // window.prompt() does nothing in Electron, so this used to silently drop the link.
        link = (await customPrompt(`Camera for ${name}`, 'Paste the camera link: a VDO.ninja view link, or any page that shows the camera.', '', 'Link camera')) || '';
        if (!link.trim()) { renderPlayerCamMounts(); return; }
      }
      // A cam saved under another spelling of this name ("zen" for "Zen") is replaced, not kept as a duplicate.
      const old = _pcamFind((currentState && currentState.facecams) || [], { name, pid });
      if (old && old.name !== name) send('delete_facecam', { name: old.name });
      if (!link) { send('delete_facecam', { name }); showToast(`Camera removed for ${name}`, '#fbbf24'); }
      else { send('save_facecam', { name, platformId: pid, link: link.trim() }); showToast(`Camera linked to ${name}`, '#22c55e'); }
      setTimeout(() => renderPlayerCamMounts(), 400);
    });
  });
  // Players join the lobby through the game feed, not through full_state: re-render a visible
  // panel when the names, teams, cams or the RL connection change.
  let sig = '';
  setInterval(() => {
    if (!_PCAM_MOUNTS.some((m) => { const e = el(m.rows); return e && e.offsetParent; })) return;
    const st = currentState || {};
    const next = JSON.stringify([_pcamRows(), (st.facecams || []).map((f) => f.name + '|' + f.link), !!st.rlConnected, st.facecamsEnabled !== false, st.lanSeats && [st.lanSeats.enabled, st.lanSeats.perSide, (st.lanSeats.seats || []).map((x) => x.id + x.label + x.player + x.link), st.lanSeats.agent, st.lanSeats.agentError, st.lanSeats.seen], st.teams && [st.teams.blue && st.teams.blue.name, st.teams.orange && st.teams.orange.name]]);
    if (next !== sig) { sig = next; renderPlayerCamMounts(); }
  }, 1500);
  [['btn-playercams-automatch', _pcamAutoMatch], ['dcc-playercams-automatch', _pcamAutoMatch], ['cfp-playercams-automatch', _pcamAutoMatch],
   ['btn-playercams-refresh', () => renderPlayerCamMounts(true)], ['dcc-playercams-refresh', () => renderPlayerCamMounts(true)], ['cfp-playercams-refresh', () => renderPlayerCamMounts(true)]]
    .forEach(([id, fn]) => { const b = el(id); if (b) b.addEventListener('click', fn); });
})();

/* Resolve typed text to one crew member.
 *
 * The Support adders are labelled "Search existing crew…" but were backed by an exact
 * case-insensitive equality test, so typing a partial name — the whole point of a search box —
 * failed with "No crew member named X" even though the person was right there. This resolves
 * properly: exact wins outright, otherwise the best ranked match, and a genuine tie reports the
 * candidates instead of silently picking whichever the array order happened to put first (adding
 * the wrong person to a credits screen is not a mistake worth guessing on).
 *
 * Returns { member } | { ambiguous: [..] } | { none: true }.
 */
function crewResolve(typed, crewList) {
  const raw = (typed || '').trim();
  if (!raw) return { none: true };
  // Callers rendering from a pushed state pass their own list so a resolve can't disagree with
  // the roster the producer is actually looking at.
  const list = crewList || (currentState && currentState.crew) || [];
  const disp = (c) => c.handle || c.name || '';
  const low = raw.toLowerCase();
  const exact = list.find((c) => disp(c).toLowerCase() === low)
    || list.find((c) => (c.name || '').toLowerCase() === low);
  if (exact) return { member: exact };

  const scored = list.map((c) => ({
    c, s: NESearch.score(raw, [{ text: c.name, weight: 2 }, { text: c.handle, weight: 2 }, c.role])
  })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return { none: true };
  // A clear winner is one that outscores the runner-up by a comfortable margin; anything closer
  // is a real ambiguity ("jo" over Joker and Johnson) and the producer should pick.
  if (scored.length === 1 || scored[0].s >= scored[1].s * 1.35) return { member: scored[0].c };
  return { ambiguous: scored.slice(0, 4).map((x) => x.c) };
}

function renderCrewList() {
  const list = el('crew-list'); if (!list) return;
  const q   = (el('crew-search')?.value || '').trim();
  const grp = el('crew-filter-group')?.value || '';
  const members = (typeof currentState !== 'undefined' && currentState.crew) ? currentState.crew : [];
  // Country, social handle and notes are searchable too — "who's the German observer" is a real
  // question, and the old name/handle/role trio couldn't answer it. Results come back ranked.
  const filtered = NESearch.filter(
    members.filter((m) => !grp || m.group === grp),
    q,
    (m) => [
      { text: m.name, weight: 2 }, { text: m.handle, weight: 1.5 },
      m.role, m.socialHandle, m.country, m.notes
    ]
  );
  const GROUP_LABEL = { casters: 'Casters', hosts: 'Hosts', guests: 'Guests', observers: 'Observers', producer: 'Producer', admin: 'Tournament Admin', socials: 'Social Media' };
  const GROUP_COLOR = { casters: '#e83a8b', hosts: '#a855f7', guests: '#3b82f6', observers: '#2dd4bf', producer: '#f59e0b', admin: '#ef4444', socials: '#22c55e' };
  // Per-group counts ON the filter pills. Crew skews hard into one or two groups (a real roster
  // was 26 Casters + 1 Producer), so five of the eight pills led to the same blank page — which
  // reads as "the crew list is broken", not as "nobody is a Guest". The count is the whole answer.
  const counts = {};
  members.forEach((m) => { const g = (m && m.group) || ''; counts[g] = (counts[g] || 0) + 1; });
  document.querySelectorAll('#crew-group-nav [data-group]').forEach((btn) => {
    const g = btn.dataset.group;
    const n = g ? (counts[g] || 0) : members.length;
    let c = btn.querySelector('.crew-pill-count');
    if (!c) { c = document.createElement('span'); c.className = 'crew-pill-count'; btn.appendChild(c); }
    c.textContent = n;
    btn.classList.toggle('is-empty', !n);
  });
  // The header count has to describe what is ON SCREEN. It read the unfiltered total, so an empty
  // group showed "Crew (27)" directly above "No crew members found" — the page contradicting itself.
  const countEl = el('crew-count');
  if (countEl) {
    countEl.textContent = !members.length ? ''
      : (filtered.length === members.length ? `(${members.length})` : `(${filtered.length} of ${members.length})`);
  }
  if (!filtered.length) {
    const label = GROUP_LABEL[grp] || '';
    let why;
    if (!members.length) why = 'No crew yet — use <b>+ Add Crew</b> to create a profile.';
    else if (q && grp) why = `No one in ${tlEsc(label)} matches “${tlEsc(q)}”.`;
    else if (q) why = `No crew matches “${tlEsc(q)}”.`;
    else why = `Nobody is filed under ${tlEsc(label)}. All ${members.length} crew members are in other groups — pick <b>All</b>, or set someone's group when you edit them.`;
    list.innerHTML = `<p class="empty-msg" style="grid-column:1/-1;">${why}</p>`;
    return;
  }
  list.innerHTML = filtered.map((m) => {
    const color = GROUP_COLOR[m.group] || '#888';
    const label = GROUP_LABEL[m.group] || m.group || '';
    const initials = (m.name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    const slot = crewDeskSlot(m);
    const slotBadge = slot ? `<span style="display:inline-block;margin:4px 0 0 6px;background:#22c55e22;color:#22c55e;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:700;">DESK ${slot}</span>` : '';
    const metaLine = [m.handle ? `@${m.handle}` : null, m.role || null].filter(Boolean).join(' · ');
    const dataAttr = JSON.stringify(m).replace(/'/g, "&#39;");
    return `<div class="tc-card" data-crew-id="${m.id}" data-crew-data='${dataAttr}'>
      <div class="tc-card-accent" style="background:${color};"></div>
      <div class="tc-card-body">
        <div class="tc-card-avatar" style="background:${color}33;color:${color};">${tlEsc(initials)}</div>
        <div class="tc-card-info">
          <div class="tc-card-name">${tlEsc(m.name)}</div>
          <div class="tc-card-meta">${metaLine ? tlEsc(metaLine) : ''}</div>
          <span style="display:inline-block;margin-top:4px;background:${color}22;color:${color};padding:1px 7px;border-radius:99px;font-size:10px;font-weight:700;">${tlEsc(label)}</span>${slotBadge}
        </div>
      </div>
      <div class="tc-card-footer">
        <button class="tc-edit" data-crew-edit="${m.id}" title="Edit">Edit</button>
        <button class="tc-del" data-crew-del="${m.id}" title="Delete">Del</button>
      </div>
    </div>`;
  }).join('');
}

// ── DCC Database: per-group section renderers (source = state.casters.library / CF system) ──
const _CAM_SLOTS = ['','CAM1','CAM2','CAM3','CAM4','CAM5','CAM6','LAPTOP1','LAPTOP2','PC1','PC2','CAPTURE1','CAPTURE2','PHONE1','PHONE2'];
const _CAM_LABELS = {'':'No cam','CAM1':'CAM 1','CAM2':'CAM 2','CAM3':'CAM 3','CAM4':'CAM 4','CAM5':'CAM 5','CAM6':'CAM 6','LAPTOP1':'Laptop 1','LAPTOP2':'Laptop 2','PC1':'PC 1','PC2':'PC 2','CAPTURE1':'Capture 1','CAPTURE2':'Capture 2','PHONE1':'Phone 1','PHONE2':'Phone 2'};
function _camSelectHtml(current, attrs) {
  const opts = _CAM_SLOTS.map((v) => `<option value="${v}"${v === (current||'') ? ' selected' : ''}>${tlEsc(_CAM_LABELS[v] || v || '-- No cam --')}</option>`).join('');
  return `<select class="dcc-cam-select" ${attrs}>${opts}</select>`;
}
// Single source of truth for the camera slots — shared by the DCC cam dropdowns AND the
// Add-Crew "Default Cam" field so they're always the same list (a crew member's defaultCam IS
// their DCC/show-roster cam slot → OBS source). Keep in sync with the per-show camera setup.
const DCC_CAM_OPTIONS = ['', 'CAM1', 'CAM2', 'CAM3', 'CAM4', 'CAM5', 'CAM6'];
function dccCamOptionsHtml(current, emptyLabel) {
  return DCC_CAM_OPTIONS.map((v) => `<option value="${v}"${v === (current || '') ? ' selected' : ''}>${v ? 'CAM ' + v.slice(3) : (emptyLabel || '— No cam —')}</option>`).join('');
}
// groupKey → CF group name + library kind for filtering
const _DCC_SECTION_META = {
  casters:   { label: 'CASTERS',   color: '#e83a8b', cfGroup: 'casters',   kind: 'caster'   },
  guests:    { label: 'LOBBY',     color: '#a855f7', cfGroup: 'guests',    kind: 'host'     },
  observers: { label: 'OBSERVERS', color: '#2dd4bf', cfGroup: 'observers', kind: 'observer' },
};
const _DCC_CREW_SECTIONS = ['casters', 'guests', 'observers'];

// Unified crew list — renders all library members (casters + observers + lobby) in one searchable list
function renderDccHostsPane() {
  const list = el('dcc-crew-list'); if (!list) return;
  const kindToGroup = { caster: 'casters', host: 'guests', observer: 'observers' };
  const kindLabel   = { caster: 'CASTER', host: 'LOBBY', observer: 'OBS' };
  const kindColor   = { caster: '#e83a8b', host: '#a855f7', observer: '#2dd4bf' };
  const lib       = (currentState && currentState.casters && currentState.casters.library) || [];
  const connected = typeof _connectedStreams !== 'undefined' ? _connectedStreams : new Set();
  const lineup    = (currentState && currentState.casters && currentState.casters.lineup) || [];
  const cfGroups  = (_cfDirectorData && _cfDirectorData.groups) || {};
  // Merge each library entry with live VDO data
  const allMembers = lib.map((libEntry) => {
    const cfGroup = kindToGroup[libEntry.kind] || 'casters';
    const merged  = (typeof cfGroupMembersFor === 'function') ? cfGroupMembersFor(cfGroup, cfGroups[cfGroup]) : [];
    const m = merged.find((x) => x.libraryId === libEntry.id) || {};
    return { ...libEntry, ...m, libraryId: libEntry.id, _cfGroup: cfGroup, _lib: libEntry };
  });
  // Apply filter + search
  const filtersRoot  = el('stg-filters') || document;
  const activeFilter = filtersRoot.querySelector('.dcc-crew-filter.active');
  const kindFilter = activeFilter ? activeFilter.dataset.filter : 'all';
  const query = ((el('stg-search') && el('stg-search').value) || '').trim();
  let members = allMembers;
  if (kindFilter !== 'all') members = members.filter((m) => m.kind === kindFilter);
  members = NESearch.filter(members, query, (m) => [
    { text: m.name, weight: 2 }, { text: m.handle, weight: 1.5 }, m.role, m.country, m.kind
  ]);
  if (!members.length) {
    list.innerHTML = `<div class="roster-empty">${query || kindFilter !== 'all'
      ? 'No matches. <button class="btn btn-ghost btn-xs" id="dcc-crew-clear-filter" style="margin-left:4px;">Clear filter</button>'
      : 'No crew in library yet. Click <b>+ Add</b> to get started.'}</div>`;
    return;
  }
  list.innerHTML = members.map((m) => {
    const isConn    = !!(m.streamId && connected.has(m.streamId));
    const joinUrl   = m.joinUrl  || '';
    const obsUrl    = m.obsUrl   || '';
    const customUrl = m._lib.camUrl  || '';
    const camSlot   = m._lib.camSlot || '';
    const activeUrl = customUrl || joinUrl;
    const handle    = m.handle ? '@' + m.handle : '';
    const sub       = [handle, m.role].filter(Boolean).join(' · ');
    const badge     = `<span class="dcc-kind-badge" style="background:${kindColor[m.kind]||'#6b7280'};">${kindLabel[m.kind]||'CREW'}</span>`;
    let slotSelHtml = '';
    if (m.kind === 'caster') {
      const lineupEnt = lineup.find((e) => e.libraryId === m.libraryId);
      const curSlot   = lineupEnt ? (lineupEnt.slot || 0) : 0;
      const slotLabels = (currentState.casters && currentState.casters.slotLabels) || {};
      const slotOpts  = [['0','Off air'],['1',slotLabels[1]||'Caster 1'],['2',slotLabels[2]||'Caster 2'],['3',slotLabels[3]||'Caster 3'],['4',slotLabels[4]||'Caster 4']]
        .map(([v, lbl]) => `<option value="${v}"${Number(v) === curSlot ? ' selected' : ''}>${lbl}</option>`).join('');
      slotSelHtml = `<select class="dcc-cam-select dcc-overlay-slot" title="Overlay slot" style="max-width:92px;">${slotOpts}</select>`;
    }
    return `<div class="talent-row mc-player dcc-lib-row dcc-crew-card-${m.kind||''}" data-libid="${tlEsc(m.libraryId||'')}" data-stream="${tlEsc(m.streamId||'')}" data-kind="${tlEsc(m.kind||'')}">
      <div class="mc-p-line">
        <span class="mc-stats">
          <span class="mc-stat mc-stat-conn" data-conn="${isConn?1:0}" title="VDO connection"></span>
          <span class="mc-stat mc-stat-cam">${svgIcon('camera')}</span>
        </span>
        ${badge}
        <span class="mc-p-name">${tlEsc(m.name||'—')}</span>
        ${sub ? `<span class="cf-grp-sub">${tlEsc(sub)}</span>` : ''}
        <span class="mc-p-quick">
          ${slotSelHtml}
          <button class="cf-ico-btn" data-copy-url="${tlEsc(joinUrl)}" title="Copy invite link"${joinUrl?'':' disabled'}>${svgIcon('userplus')}</button>
          <button class="cf-ico-btn" data-copy-url="${tlEsc(obsUrl||activeUrl)}" title="Copy OBS view link"${(obsUrl||activeUrl)?'':' disabled'}>${svgIcon('copy')}</button>
          <button class="cf-ico-btn" data-obs-push-url="${tlEsc(activeUrl)}" data-obs-cam="${tlEsc(camSlot)}" title="${activeUrl&&camSlot?'Push to OBS: '+camSlot:'Set a cam slot to enable'}"${activeUrl&&camSlot?'':' disabled'}>${svgIcon('external')}</button>
          <button class="cf-ico-btn" data-edit-lib="${tlEsc(m.libraryId||'')}" title="Edit">${svgIcon('pencil')}</button>
          <button class="cf-ico-btn mc-expand" title="Custom URL · VDO room · remove">${svgIcon('chevdown')}</button>
        </span>
      </div>
      <div class="mc-p-body" hidden>
        <div class="gm-sect">
          <div class="gm-sect-row">
            <span class="gm-sect-lbl">Custom URL</span>
            <input class="input-text gm-e-cam" placeholder="Override auto-generated VDO link…" value="${tlEsc(customUrl)}" data-cvdo-id="${tlEsc(m.libraryId||'')}" maxlength="1000" spellcheck="false">
            <button class="btn btn-secondary btn-xs" data-obs-id="${tlEsc(m.libraryId||'')}" data-obs-cam="${tlEsc(camSlot)}">&#x2192;&nbsp;OBS</button>
          </div>
          <div class="gm-sect-row" style="margin-top:4px;">
            ${activeUrl
              ? `<button class="btn btn-ghost btn-xs" data-regen-cfgroup="${tlEsc(m._cfGroup)}">&#x21BA; New room</button>`
              : `<button class="btn btn-secondary btn-xs" data-gen-cfgroup="${tlEsc(m._cfGroup)}">Generate VDO room</button>`}
            <button class="btn btn-ghost btn-xs cf-ico-del" style="margin-left:auto;color:#f56565;" data-rem-lib="${tlEsc(m.libraryId||'')}">${svgIcon('trash')} Remove</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// renderDccPicker was removed — DCC now uses the CF library directly (no separate show-roster picker)

function renderDccTeamSection(side) {
  const rosterDiv = el(`dcc-roster-team-${side}`); if (!rosterDiv) return;
  const team      = (currentState && currentState.teams && currentState.teams[side]) || {};
  const teamColor = team.color || (side === 'blue' ? '#3b82f6' : '#f97316');
  const players   = team.players || [];
  const connected = typeof _connectedStreams !== 'undefined' ? _connectedStreams : new Set();

  const labelEl = el(`dcc-label-team-${side}`);
  if (labelEl && team.name) labelEl.textContent = team.name;
  const badgeEl = el(`dcc-badge-team-${side}`);
  if (badgeEl) { badgeEl.textContent = (team.name || (side === 'blue' ? 'BLUE' : 'ORANGE')).toUpperCase().slice(0, 12); badgeEl.style.background = teamColor; badgeEl.style.color = teamInk(teamColor); }

  const roomEl = el(`dcc-room-team-${side}`);
  if (roomEl) {
    if (!team.vdo || !team.vdo.room) {
      roomEl.textContent = players.length ? 'No VDO room yet — click the lightning icon to generate' : '';
      roomEl.style.color = players.length ? '#f59e0b' : '';
    } else {
      roomEl.textContent = 'Room: ' + team.vdo.room;
      roomEl.style.color = '';
    }
  }

  const vdoTeam = (typeof _cfDirectorData !== 'undefined' && _cfDirectorData && _cfDirectorData.teams && _cfDirectorData.teams[side]) || {};
  const vByPid  = {};
  (vdoTeam.players || []).forEach((vp) => { vByPid[String(vp.playerId)] = vp; });

  if (!players.length) {
    rosterDiv.innerHTML = `<div class="roster-empty">No ${team.name || side} players yet. Go to <b>Talent &rarr; Teams</b> to build the roster.</div>`;
    return;
  }

  // Don't rebuild the roster while the producer is mid-selection in one of its dropdowns —
  // a state-driven re-render would otherwise reset the open <select>.
  if (rosterDiv.contains(document.activeElement)) return;

  // Live in-game players (RL) for the "link camera to in-game player" dropdown — grouped by side.
  const ingamePlayers = ((currentState && currentState.players) || []).filter((pl) => pl && pl.name);
  const facecams = (currentState && currentState.facecams) || [];
  const igBlue = ingamePlayers.filter((pl) => Number(pl.team) !== 1);
  const igOrange = ingamePlayers.filter((pl) => Number(pl.team) === 1);

  rosterDiv.innerHTML = players.map((p) => {
    const vp      = vByPid[String(p.id)] || {};
    const isConn  = !!(vp.streamId && connected.has(vp.streamId));
    const joinUrl = vp.joinUrl || '';
    const obsUrl  = vp.obsUrl  || '';
    const camSlotSel = `<select class="dcc-cam-select" title="Overlay cam slot" data-pcam-side="${tlEsc(side)}" data-pcam-id="${tlEsc(String(p.id))}" style="max-width:96px;">${dccCamOptionsHtml(p.camSlot, 'Off air')}</select>`;
    // Which in-game player currently uses THIS player's cam feed (so we can pre-select it).
    const linkedName = obsUrl ? ((facecams.find((f) => f && f.link && f.link === obsUrl) || {}).name || '') : '';
    const igOpt = (pl) => `<option value="${tlEsc(pl.name)}"${linkedName && pl.name.toLowerCase() === linkedName.toLowerCase() ? ' selected' : ''}>${tlEsc(pl.name)}</option>`;
    const igOpts = (igBlue.length && igOrange.length)
      ? `<optgroup label="Blue">${igBlue.map(igOpt).join('')}</optgroup><optgroup label="Orange">${igOrange.map(igOpt).join('')}</optgroup>`
      : ingamePlayers.map(igOpt).join('');
    const ingameSel = `<select class="dcc-cam-select dcc-ingame-sel" title="Link this player's camera to an in-game player — shows on their HUD statcard" data-obs="${tlEsc(obsUrl)}" data-prev="${tlEsc(linkedName)}" style="max-width:150px;"><option value="">Link to in-game…</option>${igOpts}</select>`;
    return `<div class="talent-row mc-player dcc-lib-row" data-pside="${tlEsc(side)}" data-pid="${tlEsc(String(p.id))}">
      <div class="mc-p-line">
        <span class="mc-stats">
          <span class="mc-stat mc-stat-conn" data-conn="${isConn ? 1 : 0}" title="VDO connection status"></span>
          <span class="mc-stat mc-stat-cam" title="Camera active">${svgIcon('camera')}</span>
        </span>
        <span class="mc-p-name">${tlEsc(p.name || '—')}</span>
        <span class="cf-grp-sub" style="color:${teamColor};">${tlEsc(team.name || side)}</span>
        <span class="mc-p-quick">
          <span class="dcc-camset" title="Shows this player's camera on the in-game RL HUD statcard">
            <span class="dcc-camset-lbl">In-game HUD</span>
            ${ingameSel}
          </span>
          <span class="dcc-camset" title="Places this player's feed into a cam slot on the desk / talent OBS scenes">
            <span class="dcc-camset-lbl">Desk cam</span>
            ${camSlotSel}
          </span>
          <button class="cf-ico-btn" data-copy-url="${tlEsc(joinUrl)}" title="Copy invite / join link"${joinUrl ? '' : ' disabled'}>${svgIcon('userplus')}</button>
          <button class="cf-ico-btn" data-copy-url="${tlEsc(obsUrl)}" title="Copy OBS view link"${obsUrl ? '' : ' disabled'}>${svgIcon('copy')}</button>
          ${!joinUrl ? `<button class="cf-ico-btn" data-pgen-side="${tlEsc(side)}" data-pgen-id="${tlEsc(String(p.id))}" title="Generate VDO link for this player">${svgIcon('zap')}</button>` : ''}
        </span>
      </div>
    </div>`;
  }).join('');
}
// Link a roster player's camera to an in-game player (writes a facecam: in-game name → this cam).
;(function wireDccIngameLink() {
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('.dcc-ingame-sel'); if (!sel) return;
    const obs = sel.dataset.obs || '', name = sel.value, prev = sel.dataset.prev || '';
    if (name && !obs) { if (typeof showToast === 'function') showToast("Generate this player's VDO link first (Generate button)", '#fbbf24'); sel.value = prev; return; }
    if (prev && prev !== name) send('delete_facecam', { name: prev });   // free the old in-game mapping
    if (name) {
      const ig = ((currentState && currentState.players) || []).find((pl) => pl && pl.name && pl.name.toLowerCase() === name.toLowerCase());
      const pid = ig && ig.primaryid ? (String(ig.primaryid).split('|')[1] || null) : null;
      send('save_facecam', { name, platformId: pid, link: obs });
      if (typeof showToast === 'function') showToast(`Cam linked to ${name}`, '#22c55e');
    } else if (prev) {
      if (typeof showToast === 'function') showToast(`Cam unlinked from ${prev}`, '#fbbf24');
    }
    sel.dataset.prev = name;
  });
})();

// Producers / tournament admins / social media — backend crew with no camera, so they sit in a
// plain list under the 3 camera columns rather than needing a VDO-room "kind" of their own.
function renderDccSupportCrew() {
  const wrap = el('dcc-support-list'); if (!wrap) return;
  const crew = (currentState && currentState.crew) || [];
  const members = crew.filter((c) => c && ['producer', 'admin', 'socials'].includes(c.group));
  const countEl = el('dcc-support-count'); if (countEl) countEl.textContent = members.length;
  const LABEL = { producer: 'Producer', admin: 'Admin', socials: 'Social' };
  wrap.innerHTML = members.length ? members.map((c) => {
    const disp = c.handle || c.name;
    return `<span class="dcc-support-chip" data-id="${tlEsc(c.id)}">`
      + `<span class="nm">${tlEsc(disp)}</span>`
      + `<span class="rl">${tlEsc(c.role || LABEL[c.group] || '')}</span>`
      + `<button type="button" class="rm" data-support-rm="${tlEsc(c.id)}" title="Remove from crew">&times;</button></span>`;
  }).join('') : '<span class="dcc-support-empty">No producers, admins or socials added yet.</span>';
  { const i = el('dcc-support-search'); if (i && window.mountCrewTypeahead) window.mountCrewTypeahead(i, () => (currentState && currentState.crew) || []); }
}
el('dcc-support-assign')?.addEventListener('click', () => {
  const inp = el('dcc-support-search'); const typed = (inp?.value || '').trim();
  if (!typed) { showToast('Search for an existing crew member first.', '#fbbf24'); return; }
  const disp = (c) => c.handle || c.name;
  const r = crewResolve(typed);
  if (r.ambiguous) {
    showToast(`"${typed}" matches ${r.ambiguous.map(disp).join(', ')} — type more to pick one.`, '#fbbf24');
    return;
  }
  const m = r.member;
  if (!m) { showToast(`No crew member matching "${typed}" — add them on the Crew tab first.`, '#fbbf24'); return; }
  const group = el('dcc-support-role-sel')?.value || 'producer';
  send('update_crew_member', { id: m.id, group });
  if (inp) inp.value = '';
  showToast(`${disp(m)} added to Support Crew`, '#22c55e');
});
el('dcc-support-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-support-rm]'); if (!btn) return;
  send('update_crew_member', { id: btn.dataset.supportRm, group: '' });
});

function renderDccAll() {
  renderDccTeamSection('blue');
  renderDccTeamSection('orange');
  renderDccHostsPane();
  renderDccSupportCrew();
  // The DCC hosts the In-Game Player Cams grid (#dcc-playercams-rows) too — render it here so it
  // populates whenever the DCC is shown, not only after opening the Match-Teams gear / Players tab
  // (which left it empty on the DCC, so there was nothing to assign cams to).
  if (typeof renderPlayerCamMounts === 'function') renderPlayerCamMounts();
}

function renderDccTeamsPane() {
  const wrap = el('dcc-teams-list'); if (!wrap) return;
  const query = ((el('stg-search') && el('stg-search').value) || '').trim();
  // One box drives both this pane and the crew pane — it used to search crew by name/handle/role
  // but teams by name only, so the same query silently meant two different things. Rosters are
  // searchable here too.
  const saved = NESearch.filter((currentState && currentState.savedTeams) || [], query, (t) => [
    { text: t.name, weight: 2 },
    { text: (t.players || []).map((p) => (typeof p === 'string' ? p : ((p && (p.name || p.gamertag)) || ''))).join(' '), bag: true }
  ]);

  if (!saved.length) {
    wrap.innerHTML = `<div class="roster-empty">No teams yet. Add teams in <b>Talent &rarr; Teams</b> or click <b>+ Add</b>.</div>`;
    return;
  }
  wrap.innerHTML = saved.map((t, idx) => {
    const color   = t.color || '#6b7280';
    const players = t.players || [];
    const playerRows = players.map((p) => `<div class="dcc-team-player">
      <span class="mc-stat mc-stat-conn" data-conn="0"></span>
      <span class="dcc-team-player-name">${tlEsc(p.name || '—')}</span>
    </div>`).join('');
    return `<div class="dcc-team-card" data-tidx="${idx}">
      <div class="dcc-team-card-main">
        <div class="dcc-team-swatch" style="background:${color}"></div>
        <div class="dcc-team-info">
          <span class="dcc-team-name">${tlEsc(t.name || 'Unnamed')}</span>
          <span class="dcc-team-meta">${players.length} player${players.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="dcc-team-actions">
          <button class="cf-ico-btn mc-expand" title="Show players">${svgIcon('chevdown')}</button>
        </div>
      </div>
      <div class="mc-p-body" hidden>
        <div class="dcc-team-roster">
          ${players.length ? playerRows : '<span class="dcc-empty-note">No players on this team.</span>'}
          <button class="btn btn-ghost btn-xs" data-edit-team-idx="${idx}" style="margin-top:6px;">${svgIcon('pencil')} Edit</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderDccLobbyPane() {
  const roster = el('dcc-lobby-roster');
  const copyJoin = el('dcc-lobby-copy-join');
  const copyObs  = el('dcc-lobby-copy-obs');
  const urlRow   = el('dcc-lobby-url-row');
  const urlText  = el('dcc-lobby-url-text');

  const data  = typeof _cfDirectorData !== 'undefined' ? _cfDirectorData : null;
  const grp   = data && data.groups && data.groups.guests;
  const room  = grp && grp.room;
  const joinUrl = room && room.viewLink;
  const obsUrl  = room && room.obsUrl;

  if (urlText) urlText.textContent = joinUrl || '';
  if (urlRow)  urlRow.style.display = joinUrl ? '' : 'none';
  if (copyJoin) { copyJoin.disabled = !joinUrl; if (joinUrl) copyJoin.dataset.url = joinUrl; }
  if (copyObs)  { copyObs.disabled  = !obsUrl;  if (obsUrl)  copyObs.dataset.url  = obsUrl; }

  if (!roster) return;
  const members = (grp && grp.members) || [];
  if (!members.length) {
    roster.innerHTML = `<div class="roster-empty">No guests yet. Generate a room and share the invite link — people who join will appear here.</div>`;
    return;
  }
  roster.innerHTML = members.map((m) => {
    const name   = tlEsc(m.name || m.handle || 'Unknown');
    // Group membership is keyed by the library entry id + its `kind` (caster/observer), so emit the
    // library id here — NOT the VDO streamId — and the target kind directly.
    const libId  = m.libraryId || m.id || '';
    return `<div class="mc-player talent-row" style="display:flex;align-items:center;gap:8px;padding:6px 10px;">
      <span style="flex:1;font-size:12px;font-weight:600;">${name}</span>
      <button class="btn btn-ghost btn-xs" data-assign-lobby="${libId}" data-assign-group="caster">→ Casters</button>
      <button class="btn btn-ghost btn-xs" data-assign-lobby="${libId}" data-assign-group="observer">→ Obs</button>
    </div>`;
  }).join('');
}

function renderDccHostsGrid() {
  const lib       = (currentState && currentState.casters && currentState.casters.library) || [];
  const lineup    = (currentState && currentState.casters && currentState.casters.lineup)  || [];
  const connected = typeof _connectedStreams !== 'undefined' ? _connectedStreams : new Set();
  const cfGroups  = (typeof _cfDirectorData !== 'undefined' && _cfDirectorData && _cfDirectorData.groups) || {};
  const kindToGroup = { caster: 'casters', host: 'guests', observer: 'observers' };
  const SLOT_LABELS = { 1: 'CASTER 1', 2: 'CASTER 2', 3: 'CASTER 3', 4: 'CASTER 4' };
  const EMPTY_LABEL = { caster: 'hosts', observer: 'observers', host: 'guests' };

  ['caster', 'observer', 'host'].forEach((kind) => {
    const drop = el(`dcc-hosts-drop-${kind}`);
    if (!drop) return;

    const members = lib
      .filter((e) => (e.kind || 'caster') === kind)
      .map((e) => {
        const cfGroup = kindToGroup[kind];
        const merged  = typeof cfGroupMembersFor === 'function' ? cfGroupMembersFor(cfGroup, cfGroups[cfGroup]) : [];
        const m = merged.find((x) => x.libraryId === e.id) || {};
        return { ...e, ...m, libraryId: e.id, _cfGroup: cfGroup, _lib: e };
      });

    // Update column member count
    const col = drop.closest('.dcc-hosts-col');
    const countEl = col && col.querySelector('.dcc-hosts-col-count');
    if (countEl) countEl.textContent = members.length;

    // Inject a "+ Add" button into the column header (once) — opens the crew-database search popover.
    const hd = col && col.querySelector('.dcc-hosts-col-hd');
    if (hd && !hd.querySelector('.dcc-hosts-add')) {
      const b = document.createElement('button');
      b.className = 'dcc-hosts-add'; b.type = 'button'; b.dataset.addKind = kind;
      b.textContent = '+ Add'; b.title = 'Add a crew member to this column (search the crew database)';
      hd.appendChild(b);
    }

    // Room indicator — everyone in this column is SUPPOSED to share one VDO room; show it so a
    // mismatch (e.g. after a mid-show "New room" regen, or a Custom URL override on one member)
    // is visible instead of only surfacing as "they can't hear each other" during a live test.
    const roomEl = el(`dcc-hosts-col-room-${kind}`);
    if (roomEl) {
      const grp = cfGroups[kindToGroup[kind]];
      const overrideCount = members.filter((m) => m._lib && m._lib.camUrl).length;
      const warnColor = '#f59e0b';
      if (!grp || !grp.room) {
        roomEl.textContent = members.length ? 'No VDO room yet — click "Generate room" below' : '';
        roomEl.style.color = members.length ? warnColor : '';
      } else {
        roomEl.textContent = 'Room: ' + grp.room + (overrideCount ? ` (${overrideCount} on a custom URL, not this room)` : '');
        roomEl.style.color = overrideCount > 0 ? warnColor : '';
      }
    }

    if (!members.length) {
      drop.innerHTML = `<div class="roster-empty" style="padding:28px 12px; text-align:center; font-size:11px; color:var(--muted);">No ${EMPTY_LABEL[kind]} yet<br><span style="opacity:.6;">Drag cards here or add from Staging</span></div>`;
      return;
    }

    drop.innerHTML = members.map((m) => {
      const e         = m._lib;
      const isConn    = !!(m.streamId && connected.has(m.streamId));
      const joinUrl   = m.joinUrl  || '';
      const obsUrl    = m.obsUrl   || '';
      const customUrl = e.camUrl   || '';
      const activeUrl = customUrl  || joinUrl;
      const handle    = e.handle ? '@' + e.handle : '';
      const sub       = [handle, e.role].filter(Boolean).join(' · ');
      const lu        = lineup.find((l) => l.libraryId === e.id);
      const slot      = lu ? lu.slot : (e.slot || 0);
      const slotBadge = slot ? `<span class="dcc-host-slot-badge">${SLOT_LABELS[slot] || 'Slot ' + slot}</span>` : '';

      return `<div class="talent-row mc-player dcc-host-card" draggable="true"
            data-lib-id="${tlEsc(e.id)}" data-libid="${tlEsc(m.libraryId||'')}"
            data-stream="${tlEsc(m.streamId||'')}" data-kind="${kind}">
          <div class="mc-p-line">
            <span class="mc-drag-handle" title="Drag to reassign">⠿</span>
            <span class="mc-stats">
              <span class="mc-stat mc-stat-conn" data-conn="${isConn?1:0}" title="VDO status"></span>
              <span class="mc-stat mc-stat-cam">${svgIcon('camera')}</span>
            </span>
            <span class="mc-p-name">${tlEsc(e.name || '—')}</span>
            ${sub ? `<span class="cf-grp-sub">${tlEsc(sub)}</span>` : ''}
            ${slotBadge}
            <span class="mc-p-quick">
              <button class="cf-ico-btn" data-copy-url="${tlEsc(joinUrl)}" title="Copy invite link"${joinUrl?'':' disabled'}>${svgIcon('userplus')}</button>
              <button class="cf-ico-btn" data-copy-url="${tlEsc(obsUrl||activeUrl)}" title="Copy OBS view URL"${(obsUrl||activeUrl)?'':' disabled'}>${svgIcon('copy')}</button>
              <button class="cf-ico-btn" data-edit-lib="${tlEsc(e.id)}" title="Edit">${svgIcon('pencil')}</button>
              <button class="cf-ico-btn mc-expand" title="Details">${svgIcon('chevdown')}</button>
            </span>
          </div>
          <div class="mc-p-body" hidden>
            <div class="gm-sect">
              <div class="gm-sect-row">
                <span class="gm-sect-lbl">Custom URL</span>
                <input class="input-text gm-e-cam" placeholder="Override auto-generated link…"
                  value="${tlEsc(customUrl)}" data-cvdo-id="${tlEsc(e.id)}" maxlength="1000" spellcheck="false">
              </div>
              ${e.country ? `<div class="gm-sect-row"><span class="gm-sect-lbl">Country</span><span>${tlEsc(e.country)}</span></div>` : ''}
              ${e.notes   ? `<div class="gm-sect-row"><span class="gm-sect-lbl">Notes</span><span style="white-space:pre-wrap;">${tlEsc(e.notes)}</span></div>` : ''}
              <div class="gm-sect-row" style="margin-top:6px;">
                ${activeUrl
                  ? `<button class="btn btn-ghost btn-xs" data-regen-cfgroup="${tlEsc(m._cfGroup)}">&#x21BA; New room</button>`
                  : `<button class="btn btn-secondary btn-xs" data-gen-cfgroup="${tlEsc(m._cfGroup)}">Generate room</button>`}
                <button class="btn btn-ghost btn-xs" style="margin-left:auto;color:#f56565;" data-rem-lib="${tlEsc(e.id)}">${svgIcon('trash')} Remove</button>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');
  });
}

// ── Hosts grid: drag-drop + card events ──────────────────────────────────────
(function initHostsGrid() {
  const pane = el('dcc-db-hosts');
  if (!pane) return;

  const doRefresh = () => {
    if (typeof cfLoadGroups === 'function') cfLoadGroups().then(() => renderDccHostsGrid()).catch(() => renderDccHostsGrid());
    else renderDccHostsGrid();
  };

  pane.addEventListener('click', (e) => {
    // Expand / collapse body
    const exp = e.target.closest('.mc-expand');
    if (exp) {
      const card = exp.closest('.mc-player');
      const body = card && card.querySelector('.mc-p-body');
      if (body) {
        const hidden = body.hasAttribute('hidden');
        if (hidden) { body.removeAttribute('hidden'); exp.style.transform = 'rotate(180deg)'; }
        else        { body.setAttribute('hidden', ''); exp.style.transform = ''; }
      }
      return;
    }
    // "+ Add" in a column header → open the crew-database search popover for that column's kind.
    const addBtn = e.target.closest('.dcc-hosts-add');
    if (addBtn) { e.stopPropagation(); dccHostsAddOpen(addBtn.dataset.addKind, addBtn, doRefresh); return; }
    // Copy URL to clipboard
    const copyBtn = e.target.closest('[data-copy-url]');
    if (copyBtn) {
      const u = copyBtn.dataset.copyUrl;
      if (u) navigator.clipboard?.writeText(u).catch(() => {});
      showToast('Copied!', '#22c55e');
      return;
    }
    // Edit
    const edit = e.target.closest('[data-edit-lib]');
    if (edit && typeof window._openCrewFormEdit === 'function') { window._openCrewFormEdit(edit.dataset.editLib); return; }
    // Generate room
    const gen = e.target.closest('[data-gen-cfgroup]');
    if (gen) {
      (async () => {
        if (!await customConfirm('New room', 'Generate a new room? Every link already sent to talent in this group stops working, and they will need the new one.', 'Generate new room')) return;
        send('regenerate_group_room', { group: gen.dataset.genCfgroup }); setTimeout(doRefresh, 700);
      })();
      return;
    }
    const regen = e.target.closest('[data-regen-cfgroup]');
    if (regen) {
      // This resets the ONE shared room every member of the group is in — anyone who already
      // joined with the old link gets silently stranded there and won't hear/see the rest
      // (this is exactly how two casters end up unable to hear each other mid-show).
      appConfirm("Get a new room for this whole group? Anyone already connected with the current link will be cut off from the rest — they'll need the new invite link to rejoin.", 'New room', true).then((ok) => {
        if (!ok) return;
        send('regenerate_group_room', { group: regen.dataset.regenCfgroup });
        setTimeout(doRefresh, 700);
      });
      return;
    }
    // Remove
    const rem = e.target.closest('[data-rem-lib]');
    if (rem) {
      appConfirm('Remove this crew member from the library?', 'Remove', true).then((ok) => {
        if (!ok) return;
        send('delete_caster_from_library', { id: rem.dataset.remLib });
        setTimeout(doRefresh, 350);
      });
    }
  });

  // Save custom VDO URL on input blur
  pane.addEventListener('change', (e) => {
    const inp = e.target.closest('[data-cvdo-id]');
    if (inp) send('save_caster_to_library', { id: inp.dataset.cvdoId, camUrl: inp.value.trim() });
  });

  // Drag to reassign category
  pane.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.dcc-host-card');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.libId);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => card.classList.add('dragging'), 0);
  });
  pane.addEventListener('dragend', (e) => {
    const card = e.target.closest('.dcc-host-card');
    if (card) card.classList.remove('dragging');
    pane.querySelectorAll('.dcc-hosts-drop').forEach((d) => d.classList.remove('drag-over'));
  });
  pane.addEventListener('dragover', (e) => {
    const drop = e.target.closest('.dcc-hosts-drop');
    if (!drop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    pane.querySelectorAll('.dcc-hosts-drop').forEach((d) => d.classList.remove('drag-over'));
    drop.classList.add('drag-over');
  });
  pane.addEventListener('dragleave', (e) => {
    const drop = e.target.closest('.dcc-hosts-drop');
    if (drop && !drop.contains(e.relatedTarget)) drop.classList.remove('drag-over');
  });
  pane.addEventListener('drop', (e) => {
    const drop = e.target.closest('.dcc-hosts-drop');
    if (!drop) return;
    e.preventDefault();
    drop.classList.remove('drag-over');
    const libId   = e.dataTransfer.getData('text/plain');
    const newKind = drop.dataset.dropKind;
    if (libId && newKind) {
      send('save_caster_to_library', { id: libId, kind: newKind });
      setTimeout(doRefresh, 350);
    }
  });

  // ── Crew-database search popover (opened by the "+ Add" button on each column) ──
  // Lets a producer search existing crew (state.crew + casters.library) and add/move one into
  // this column instead of re-typing a new crew member each time; "Create new" opens the full form.
  let _dccAddPop = null;
  function dccHostsAddClose() { if (_dccAddPop) { _dccAddPop.remove(); _dccAddPop = null; } }
  function dccHostsAddOpen(kind, anchor, onDone) {
    dccHostsAddClose();
    const K = { caster: 'On-Air Talent', observer: 'Observers', host: 'Guests' };
    const groupOf = { caster: 'casters', observer: 'observers', host: 'hosts' };
    const pop = document.createElement('div');
    pop.className = 'dcc-add-pop';
    pop.innerHTML =
      `<div class="dcc-add-pop-hd">Add to ${K[kind] || kind}</div>`
      + `<input type="text" class="dcc-add-search input-text" placeholder="Search crew database…" spellcheck="false">`
      + `<div class="dcc-add-list"></div>`
      + `<button class="btn btn-ghost btn-sm dcc-add-new" type="button" style="width:100%;">+ Create new crew member</button>`;
    document.body.appendChild(pop);
    _dccAddPop = pop;
    const r = anchor.getBoundingClientRect();
    pop.style.top  = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 360)) + 'px';
    pop.style.left = Math.max(8, Math.min(r.right - 280, window.innerWidth - 292)) + 'px';

    const search = pop.querySelector('.dcc-add-search');
    const list = pop.querySelector('.dcc-add-list');
    const keyOf = (n, h) => (n || '').toLowerCase() + '|' + (h || '').toLowerCase();
    const build = () => {
      const q = (search.value || '').trim().toLowerCase();
      const crew = (currentState && currentState.crew) || [];
      const lib  = (currentState && currentState.casters && currentState.casters.library) || [];
      const byKey = new Map();
      crew.forEach((c) => { if (c && c.name) byKey.set(keyOf(c.name, c.socialHandle || c.handle), { name: c.name, handle: c.socialHandle || c.handle || '', role: c.role || '', social: c.social || 'none', country: c.country || '' }); });
      lib.forEach((e2) => { if (e2 && e2.name) { const k = keyOf(e2.name, e2.handle); const cur = byKey.get(k) || { name: e2.name, handle: e2.handle || '', role: e2.role || '', social: e2.social || 'none', country: e2.country || '' }; cur._libKind = e2.kind || 'caster'; cur._libId = e2.id; byKey.set(k, cur); } });
      let items = [...byKey.values()];
      items.sort((a, b) => a.name.localeCompare(b.name));
      // Fields kept separate rather than joined into one string: joined, "caster jstn" failed
      // while "jstn caster" worked, because a substring test can't match words out of order.
      items = NESearch.filter(items, q, (x) => [
        { text: x.name, weight: 2 }, { text: x.handle, weight: 1.5 }, x.role, x.country
      ]);
      list._items = items;
      list.innerHTML = items.length ? items.map((x, i) => {
        const here = x._libKind === kind;
        const elsewhere = x._libKind && x._libKind !== kind ? (K[x._libKind] || x._libKind) : '';
        return `<button class="dcc-add-item${here ? ' is-here' : ''}" type="button" data-i="${i}"${here ? ' disabled' : ''}>`
          + `<span class="dcc-add-item-name">${poEsc(x.name)}${x.role ? `<span class="dcc-add-item-role"> · ${poEsc(x.role)}</span>` : ''}</span>`
          + `<span class="dcc-add-item-tag">${here ? 'here' : (elsewhere ? 'move from ' + elsewhere : 'add')}</span></button>`;
      }).join('') : `<div class="dcc-add-empty">No crew match${q ? ' "' + poEsc(search.value.trim()) + '"' : ''}. Create a new one below.</div>`;
    };
    build();
    search.addEventListener('input', build);
    setTimeout(() => search.focus(), 30);
    list.addEventListener('click', (e2) => {
      const btn = e2.target.closest('.dcc-add-item'); if (!btn || btn.disabled) return;
      const x = list._items[+btn.dataset.i]; if (!x) return;
      const payload = { name: x.name, handle: x.handle || '', role: x.role || '', social: x.social || 'none', country: x.country || '', kind };
      if (x._libId) payload.id = x._libId;   // update the existing library entry in place (moves its column)
      send('save_caster_to_library', payload);
      showToast(`${x.name} added to ${K[kind] || kind}`, '#22c55e');
      dccHostsAddClose();
      if (typeof onDone === 'function') setTimeout(onDone, 300);
    });
    pop.querySelector('.dcc-add-new').addEventListener('click', () => {
      dccHostsAddClose();
      if (typeof openCrewAdd === 'function') openCrewAdd(groupOf[kind] || 'casters');
    });
  }
  document.addEventListener('click', (e) => { if (_dccAddPop && !e.target.closest('.dcc-add-pop') && !e.target.closest('.dcc-hosts-add')) dccHostsAddClose(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _dccAddPop) dccHostsAddClose(); });
})();

(function initDccSections() {
  const refresh = () => { if (typeof cfLoadGroups === 'function') cfLoadGroups().then(() => renderDccAll()).catch(() => renderDccAll()); else renderDccAll(); };

  // ── Crew add/edit dialog ─────────────────────────────────────────────────
  const crewDlg = el('crew-add-dlg');
  // Reset a <dialog> back to CSS-centered each open; make it draggable by its header.
  function resetDialogPos(dlg) { if (!dlg) return; dlg.style.left=''; dlg.style.top=''; dlg.style.margin=''; dlg.style.inset=''; dlg.style.position=''; }
  function makeDialogDraggable(dlg, handle) {
    if (!dlg || !handle || dlg._dragInit) return; dlg._dragInit = true;
    handle.style.cursor = 'move'; handle.style.userSelect = 'none';
    let drag=false, sx=0, sy=0, ox=0, oy=0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, input, select, textarea')) return;
      const r = dlg.getBoundingClientRect();
      dlg.style.margin='0'; dlg.style.inset='auto'; dlg.style.position='fixed';
      dlg.style.left=r.left+'px'; dlg.style.top=r.top+'px';
      drag=true; sx=e.clientX; sy=e.clientY; ox=r.left; oy=r.top; e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => { if(!drag) return; dlg.style.left=(ox+e.clientX-sx)+'px'; dlg.style.top=(oy+e.clientY-sy)+'px'; });
    window.addEventListener('mouseup', () => { drag=false; });
  }
  if (crewDlg) makeDialogDraggable(crewDlg, crewDlg.querySelector('.crew-dlg-hd'));
  let _crewDlgEditId = null;

  function openCrewDialog(libId) {
    if (!crewDlg) return;
    _crewDlgEditId = libId || null;
    const lib    = (currentState && currentState.casters && currentState.casters.library) || [];
    const lineup = (currentState && currentState.casters && currentState.casters.lineup)  || [];
    const entry  = libId ? lib.find((e) => e.id === libId) : null;
    el('crew-dlg-title').textContent = entry ? 'Edit ' + (entry.name || 'Crew Member') : 'Add Crew Member';
    el('cdlg-name').value    = entry ? (entry.name    || '') : '';
    el('cdlg-handle').value  = entry ? (entry.handle  || '') : '';
    el('cdlg-social').value  = entry ? (entry.social  || 'none') : 'none';
    el('cdlg-role').value    = entry ? (entry.role    || '') : '';
    el('cdlg-kind').value    = entry ? (entry.kind    || 'caster') : 'caster';
    el('cdlg-country').value = entry ? (entry.country || '') : '';
    el('cdlg-notes').value   = entry ? (entry.notes   || '') : '';
    el('cdlg-vdo').value     = entry ? (entry.camUrl  || '') : '';
    // Slot: check lineup first (authoritative), fall back to library entry
    const slotSel = el('cdlg-slot');
    if (slotSel) {
      const lu = libId ? lineup.find((l) => l.libraryId === libId) : null;
      const currentSlot = lu ? (lu.slot || 0) : (entry ? (entry.slot || 0) : 0);
      slotSel.value = String(currentSlot);
    }
    el('cdlg-save').textContent = entry ? 'Save Changes' : 'Add to Library';
    resetDialogPos(crewDlg);
    crewDlg.showModal();
    // Focus VDO URL field when editing (most likely thing they want to change)
    setTimeout(() => {
      const focusEl = entry ? el('cdlg-vdo') : el('cdlg-name');
      if (focusEl) focusEl.focus();
    }, 50);
  }
  window._openCrewDialog = openCrewDialog;

  if (crewDlg) {
    el('crew-dlg-close')?.addEventListener('click', () => crewDlg.close());
    el('cdlg-cancel')?.addEventListener('click',    () => crewDlg.close());
    el('cdlg-save')?.addEventListener('click', () => {
      const name = el('cdlg-name').value.trim();
      if (!name) { el('cdlg-name').focus(); return; }
      const newSlot = parseInt((el('cdlg-slot') && el('cdlg-slot').value) || '0', 10) || 0;
      const payload = {
        name,
        handle:  el('cdlg-handle').value.trim(),
        social:  el('cdlg-social').value || 'none',
        role:    el('cdlg-role').value.trim(),
        kind:    el('cdlg-kind').value || 'caster',
        slot:    newSlot,
        country: el('cdlg-country').value.trim(),
        notes:   el('cdlg-notes').value.trim(),
        camUrl:  el('cdlg-vdo').value.trim(),
      };
      if (_crewDlgEditId) payload.id = _crewDlgEditId;
      send('save_caster_to_library', payload);

      // Also sync the lineup so overlay slots update live
      if (_crewDlgEditId) {
        let newLineup = ((currentState.casters && currentState.casters.lineup) || []).map((x) => ({ ...x }));
        if (newSlot === 0) {
          newLineup = newLineup.filter((x) => x.libraryId !== _crewDlgEditId);
        } else {
          // Bump whoever was in this slot to the old slot (or off air)
          const occ  = newLineup.find((x) => x.slot === newSlot && x.libraryId !== _crewDlgEditId);
          let   mine = newLineup.find((x) => x.libraryId === _crewDlgEditId);
          const oldSlot = mine ? mine.slot : 0;
          if (mine) { mine.slot = newSlot; }
          else      { newLineup.push({ libraryId: _crewDlgEditId, slot: newSlot, roomId: '', streamId: _crewDlgEditId }); }
          if (occ)  { if (oldSlot) occ.slot = oldSlot; else newLineup = newLineup.filter((x) => x !== occ); }
        }
        send('set_caster_lineup', { lineup: newLineup });
      }

      crewDlg.close();
      setTimeout(() => { refresh(); renderDccHostsGrid(); }, 400);
    });
    // Enter in any single-line text field submits
    crewDlg.querySelectorAll('input[type="text"]').forEach((inp) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('cdlg-save').click(); });
    });
  }

  // ── Crew toolbar: + Add button ───────────────────────────────────────────
  const crewAddBtn = el('dcc-crew-add');
  if (crewAddBtn) crewAddBtn.addEventListener('click', () => { if (typeof window.openCrewAdd === 'function') window.openCrewAdd('casters'); });

  // ── Crew toolbar: filter chips ───────────────────────────────────────────

  // ── Crew CSV import ──────────────────────────────────────────────────────
  // Format: name,handle,role,kind,camSlot  (header row ignored; # = comment)
  // kind values: caster | observer | lobby/guest/host
  const crewCsv = el('dcc-crew-csv');
  if (crewCsv) {
    crewCsv.addEventListener('change', () => {
      const file = crewCsv.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const lines = (evt.target.result || '').split('\n').map((l) => l.trim()).filter(Boolean);
        let count = 0;
        lines.forEach((line) => {
          if (line.startsWith('#') || /^name[,;]/i.test(line)) return;
          const cols = line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
          if (!cols[0]) return;
          const rawKind = (cols[3] || '').toLowerCase();
          const kind = rawKind === 'observer' ? 'observer' : (rawKind === 'lobby' || rawKind === 'guest' || rawKind === 'host') ? 'host' : 'caster';
          send('save_caster_to_library', { name: cols[0], handle: (cols[1]||'').replace(/^@+/,''), role: cols[2]||'', kind, camSlot: cols[4]||'' });
          count++;
        });
        crewCsv.value = '';
        showToast(`Imported ${count} crew member${count !== 1 ? 's' : ''}`, '#22c55e');
        setTimeout(refresh, 600);
      };
      reader.readAsText(file);
    });
  }

  // ── Crew list event delegation ───────────────────────────────────────────
  const crewList = el('dcc-crew-list');
  if (crewList) {
    crewList.addEventListener('click', (e) => {
      const rem     = e.target.closest('[data-rem-lib]');
      const regen   = e.target.closest('[data-regen-cfgroup]');
      const gen     = e.target.closest('[data-gen-cfgroup]');
      const copy    = e.target.closest('[data-copy-url]');
      const obsPush = e.target.closest('[data-obs-push-url]');
      const obs     = e.target.closest('[data-obs-id]');
      const edit    = e.target.closest('[data-edit-lib]');
      if (rem)    {
        appConfirm('Remove this crew member from the library?', 'Remove', true).then((ok) => {
          if (!ok) return;
          send('delete_caster_from_library', { id: rem.dataset.remLib });
          setTimeout(refresh, 350);
        });
        return;
      }
      if (regen)  {
        // Resets the ONE shared room for the whole group — anyone already connected with the
        // current link gets silently stranded there (this is how two casters end up unable to
        // hear each other mid-show).
        appConfirm("Get a new room for this whole group? Anyone already connected with the current link will be cut off from the rest — they'll need the new invite link to rejoin.", 'New room', true).then((ok) => {
          if (!ok) return;
          send('regenerate_group_room', { group: regen.dataset.regenCfgroup });
          setTimeout(refresh, 400);
        });
        return;
      }
      if (gen)    { send('regenerate_group_room', { group: gen.dataset.genCfgroup }); setTimeout(refresh, 400); return; }
      if (copy)   { const u = copy.dataset.copyUrl; if (u) navigator.clipboard?.writeText(u).catch(() => {}); return; }
      if (edit)   { if (typeof window._openCrewFormEdit === 'function') window._openCrewFormEdit(edit.dataset.editLib); return; }
      if (obsPush) {
        const url = obsPush.dataset.obsPushUrl || '';
        const cam = obsPush.dataset.obsCam     || '';
        if (url && cam) send('push_to_obs_source', { url, sourceName: cam });
        return;
      }
      if (obs) {
        const row     = obs.closest('.mc-player');
        const inp     = row && row.querySelector('[data-cvdo-id]');
        const url     = inp ? inp.value.trim() : '';
        const cam     = obs.dataset.obsCam || '';
        send('save_caster_to_library', { id: obs.dataset.obsId, camUrl: url });
        const pushUrl = url || (row && row.querySelector('[data-obs-push-url]') && row.querySelector('[data-obs-push-url]').dataset.obsPushUrl) || '';
        if (pushUrl && cam) send('push_to_obs_source', { url: pushUrl, sourceName: cam });
        setTimeout(refresh, 400);
      }
    });
    crewList.addEventListener('change', (e) => {
      const slotSel = e.target.closest('.dcc-overlay-slot');
      if (slotSel) {
        const row = e.target.closest('.mc-player'); const id = row && row.dataset.libid; if (!id) return;
        const newSlot = parseInt(slotSel.value, 10) || 0;
        let newLineup = ((currentState.casters && currentState.casters.lineup) || []).map((x) => ({ ...x }));
        if (newSlot === 0) {
          newLineup = newLineup.filter((x) => x.libraryId !== id);
        } else {
          const occ = newLineup.find((x) => x.slot === newSlot && x.libraryId !== id);
          let mine  = newLineup.find((x) => x.libraryId === id);
          const oldSlot = mine ? mine.slot : 0;
          if (mine) { mine.slot = newSlot; }
          else { newLineup.push({ libraryId: id, slot: newSlot, roomId: '', streamId: row.dataset.stream || '' }); }
          if (occ) { if (oldSlot) occ.slot = oldSlot; else newLineup = newLineup.filter((x) => x !== occ); }
        }
        send('set_caster_lineup', { lineup: newLineup });
        return;
      }
      const camSel = e.target.closest('[data-lcam-id]');
      if (camSel) {
        send('set_library_cam_slot', { id: camSel.dataset.lcamId, camSlot: camSel.value });
        const row = camSel.closest('.mc-player');
        if (row) {
          const obsBody = row.querySelector('[data-obs-id]');
          const obsIcon = row.querySelector('[data-obs-push-url]');
          if (obsBody) obsBody.dataset.obsCam = camSel.value;
          if (obsIcon) {
            obsIcon.dataset.obsCam = camSel.value;
            obsIcon.disabled = !(obsIcon.dataset.obsPushUrl && camSel.value);
            obsIcon.title = obsIcon.dataset.obsPushUrl && camSel.value ? 'Push to OBS: ' + camSel.value : 'Set a cam slot to enable';
          }
        }
      }
    });
  }

  // ── Slot label renaming ──────────────────────────────────────────────────
  const slotLabelsBar = el('dcc-slot-labels');
  if (slotLabelsBar) {
    slotLabelsBar.addEventListener('change', (e) => {
      const inp = e.target.closest('[data-slot-label]');
      if (!inp) return;
      const slot = parseInt(inp.dataset.slotLabel, 10);
      if (slot >= 1 && slot <= 4) {
        send('set_slot_label', { slot, label: inp.value.trim() });
        renderDccHostsPane();
      }
    });
    slotLabelsBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    });
  }
  const showCountryCb = el('dcc-show-country');
  if (showCountryCb) showCountryCb.addEventListener('change', () => send('set_casters_show_country', { showCountry: showCountryCb.checked }));

  // ── Players pane: team rosters ───────────────────────────────────────────
  ['blue', 'orange'].forEach((side) => {
    const regenBtn   = el(`dcc-regen-team-${side}`);
    const roster     = el(`dcc-roster-team-${side}`);
    const refreshSide = () => { if (typeof cfLoadGroups === 'function') cfLoadGroups().then(() => renderDccTeamSection(side)); else renderDccTeamSection(side); };
    if (regenBtn) regenBtn.addEventListener('click', async () => {
      // The tooltip promised a refresh; without `regenerate` the server did nothing once a room existed.
      const has = !!(currentState && currentState.teams && currentState.teams[side] && currentState.teams[side].vdo && currentState.teams[side].vdo.room);
      if (has && !(await appConfirm('Make a new room for this team? Everyone in the old room has to rejoin with the new link.', 'New room'))) return;
      send('generate_team_vdo', { side, regenerate: has });
      setTimeout(refreshSide, 700);
    });
    if (roster) {
      roster.addEventListener('click', (e) => {
        const copy = e.target.closest('[data-copy-url]');
        const pgen = e.target.closest('[data-pgen-side]');
        if (copy) { const u = copy.dataset.copyUrl; if (u) navigator.clipboard?.writeText(u).catch(() => {}); }
        if (pgen) { send('generate_team_vdo', { side: pgen.dataset.pgenSide }); setTimeout(refreshSide, 700); }
      });
      roster.addEventListener('change', (e) => {
        const cam = e.target.closest('[data-pcam-side]');
        if (!cam) return;
        send('set_player_cam_slot', { side: cam.dataset.pcamSide, playerId: cam.dataset.pcamId, camSlot: cam.value.trim() });
      });
    }
  });


  // Teams CSV import: name,color,player1,player2,…
  const teamsCsv = el('dcc-teams-csv');
  if (teamsCsv) {
    teamsCsv.addEventListener('change', () => {
      const file = teamsCsv.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const lines = (evt.target.result || '').split('\n').map((l) => l.trim()).filter(Boolean);
        let count = 0;
        lines.forEach((line) => {
          if (line.startsWith('#') || /^name[,;]/i.test(line)) return;
          const cols = line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
          if (!cols[0]) return;
          const name    = cols[0];
          const color   = /^#[0-9a-f]{3,6}$/i.test(cols[1] || '') ? cols[1] : '';
          const players = cols.slice(2).filter(Boolean).map((n) => ({ id: Date.now() + Math.random(), name: n, platform: '', platformId: '', camSlot: '' }));
          send('save_team', { oldName: '', name, color, logo: '', players, merge: true });
          count++;
        });
        teamsCsv.value = '';
        showToast(`Imported ${count} team${count !== 1 ? 's' : ''}`, '#22c55e');
      };
      reader.readAsText(file);
    });
  }

  const teamsList = el('dcc-teams-list');
  if (teamsList) {
    teamsList.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-edit-team-idx]');
      if (editBtn) {
        const teamsTab    = document.querySelector('[data-tab="talent"]') || document.querySelector('[href="#talent"]');
        if (teamsTab) teamsTab.click();
        const teamsSubTab = document.querySelector('[data-ev-sub="teams"], [data-tl-sub="teams"]');
        if (teamsSubTab) setTimeout(() => teamsSubTab.click(), 150);
      }
    });
  }

  // ── Staging: unified segment switcher + shared search + filter chips + Add ──
  const stgSeg    = el('stg-seg');
  const stgSearch = el('stg-search');
  const stgAdd    = el('stg-add');
  const stgFilters = el('stg-filters');

  let _stgTab = 'teams';

  function _stgSwitch(tab) {
    _stgTab = tab;
    stgSeg && stgSeg.querySelectorAll('.stg-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.stab === tab));
    document.querySelectorAll('#dcc-db-staging .dcc-stab-pane').forEach((p) => { p.style.display = 'none'; });
    const pane = el(`dcc-stab-${tab}`);
    if (pane) pane.style.display = '';
    if (stgFilters) stgFilters.style.display = tab === 'hosts' ? '' : 'none';
    if (stgSearch)  stgSearch.placeholder = tab === 'teams' ? 'Search teams…' : 'Search crew…';
    if (stgSearch)  stgSearch.value = '';
    if (tab === 'hosts') renderDccHostsPane();
    else renderDccTeamsPane();
  }

  if (stgSeg) {
    stgSeg.querySelectorAll('.stg-seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => _stgSwitch(btn.dataset.stab));
    });
  }
  if (stgSearch) stgSearch.addEventListener('input', () => {
    if (_stgTab === 'hosts') renderDccHostsPane(); else renderDccTeamsPane();
  });
  if (stgFilters) {
    stgFilters.querySelectorAll('.dcc-crew-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        stgFilters.querySelectorAll('.dcc-crew-filter').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderDccHostsPane();
      });
    });
  }
  if (stgAdd) {
    stgAdd.addEventListener('click', () => {
      if (_stgTab === 'hosts') {
        if (typeof window.openCrewAdd === 'function') window.openCrewAdd('hosts');
      } else {
        document.querySelector('[data-tab="talent"]')?.click();
        setTimeout(() => {
          document.querySelector('[data-talentpage="teams"]')?.click();
          el('te-new')?.click();
          el('te-name')?.focus();
        }, 180);
      }
    });
  }

  // ── Lobby pane ───────────────────────────────────────────────────────────
  const lobbyGenBtn   = el('dcc-lobby-gen');
  const lobbyCopyJoin = el('dcc-lobby-copy-join');
  const lobbyCopyObs  = el('dcc-lobby-copy-obs');
  const lobbyAddBtn   = el('dcc-lobby-add');

  if (lobbyGenBtn) {
    lobbyGenBtn.addEventListener('click', async () => {
      // This one button handles both first-time creation AND regeneration — only warn when a
      // room already exists, since regenerating strands anyone already connected with the old link.
      const hasRoom = !!(currentState.casters && currentState.casters.guestsVdo && currentState.casters.guestsVdo.room);
      if (hasRoom) {
        const ok = await appConfirm("Get a new lobby room? Anyone already connected with the current link will be cut off — they'll need the new invite link to rejoin.", 'New room', true);
        if (!ok) return;
      }
      send('regenerate_group_room', { group: 'guests' });
      showToast('Generating lobby room…', '#8b5cf6');
      setTimeout(() => {
        if (typeof cfLoadGroups === 'function') cfLoadGroups().then(() => renderDccLobbyPane()).catch(() => renderDccLobbyPane());
        else renderDccLobbyPane();
      }, 800);
    });
  }
  if (lobbyCopyJoin) {
    lobbyCopyJoin.addEventListener('click', () => {
      const u = lobbyCopyJoin.dataset.url; if (u) navigator.clipboard?.writeText(u).catch(() => {});
      showToast('Invite link copied!', '#8b5cf6');
    });
  }
  if (lobbyCopyObs) {
    lobbyCopyObs.addEventListener('click', () => {
      const u = lobbyCopyObs.dataset.url; if (u) navigator.clipboard?.writeText(u).catch(() => {});
      showToast('OBS URL copied!', '#22c55e');
    });
  }
  if (lobbyAddBtn) lobbyAddBtn.addEventListener('click', () => { if (typeof window.openCrewAdd === 'function') window.openCrewAdd('guests'); });

  const lobbyRoster = el('dcc-lobby-roster');
  if (lobbyRoster) {
    lobbyRoster.addEventListener('click', (e) => {
      const assignBtn = e.target.closest('[data-assign-lobby]');
      if (!assignBtn) return;
      const libraryId = assignBtn.dataset.assignLobby;   // library entry id (not the VDO stream slug)
      const kind      = assignBtn.dataset.assignGroup;    // 'caster' | 'observer'
      if (libraryId && kind) {
        send('save_caster_to_library', { id: libraryId, kind });
        showToast(`Moving to ${kind === 'observer' ? 'observers' : 'casters'}…`, '#22c55e');
        setTimeout(() => {
          if (typeof cfLoadGroups === 'function') cfLoadGroups().then(() => renderDccLobbyPane()).catch(() => renderDccLobbyPane());
          else renderDccLobbyPane();
        }, 700);
      }
    });
  }
})();

// ── On Air / Graphics dashboard borrow/return ─────────────────────────────────────────────────────
// The On Air board and Graphics hub are dashboard sections (data-dash-id="onair"/"graphics") that
// live in #dash-grid. When Production tab is active they move into #prod-graphics-tab so they
// appear in the Graphics sub-pane. When any other tab (Dashboard etc.) is active they return.
function _borrowGraphicsToDash() {
  const src = el('prod-graphics-tab');
  const dst1 = el('dash-section-onair');
  const dst2 = el('dash-section-graphics');
  if (!src || !dst1 || !dst2 || !src.firstChild) return;
  const onairEl = src.querySelector('.gfx-onair');
  if (onairEl) dst1.appendChild(onairEl);
  while (src.firstChild) dst2.appendChild(src.firstChild);
  // Defer applyDashLayout: DASH_WIDGETS is a const (TDZ until line ~16431) so calling
  // applyDashLayout synchronously from the startup IIFE would throw a ReferenceError.
  if (typeof applyDashLayout === 'function') setTimeout(applyDashLayout, 0);
  // Moving the iframe just reloaded it — re-point the preview at the current scene.
  setTimeout(() => { if (typeof window._gfxReapplyPreview === 'function') window._gfxReapplyPreview(); }, 60);
}
// #prod-graphics-tab is only the static HOME of this markup — the Dashboard is where it lives and
// is shown, so move it out once at boot and hide the empty husk that is left behind.
(function () {
  _borrowGraphicsToDash();
  const husk = el('prod-graphics-tab'); if (husk) husk.style.display = 'none';
})();

// ── Production page: one flat sub-nav (Cameras | Rundown | Flows | Hotkeys | NEURAL AI) ──
// Director ("NEURAL AI") and the whole Cameras page are pulled in as panes. Deck and Graphics left
// this page — both live on the Dashboard (the deck grid with its live preview, and the On Air /
// Graphics sections) — so Production is camera feeds, run of show, automation and hotkeys.
(function mergeProductionDirector() {
  const prodTab = document.getElementById('tab-produccion-content');
  const dirTab = document.getElementById('tab-director-content');
  if (!prodTab || !dirTab) return;
  const camTab = document.getElementById('tab-facecams-content');
  const panes = {
    cameras:  camTab,
    rundown:  document.getElementById('prod-rundown-content'),
    flows:    document.getElementById('prod-flows-content'),
    hotkeys:  document.getElementById('prod-hotkeys-tab'),
    director: dirTab,
  };
  const TABS = [['cameras', 'Cameras'], ['rundown', 'Rundown'], ['flows', 'Flows'], ['hotkeys', 'Hotkeys'], ['director', 'NEURAL AI']];
  const sub = document.createElement('div');
  sub.id = 'pd-subnav'; sub.className = 'ev-subnav';
  sub.innerHTML = TABS.map(([k, l], i) => `<button type="button" class="ev-subnav-btn${i === 0 ? ' active' : ''}" data-pd="${k}">${l}</button>`).join('');
  // Director and Cameras were their own top-level tabs — demote both to panes here. Their ids stay
  // put, so every #tab-facecams-content / #cf-subnav selector in camera-feeds.js keeps working.
  [dirTab, camTab].forEach((t) => {
    if (!t) return;
    t.classList.remove('tab-content', 'active'); t.style.display = 'none';
    const h = t.querySelector('.page-head'); if (h) h.style.display = 'none';
  });
  // Detach every pane, then re-append sub-nav + panes in tab order (keeps the .page-head on top).
  Object.values(panes).forEach((p) => { if (p && p.parentNode) p.parentNode.removeChild(p); });
  prodTab.appendChild(sub);
  TABS.forEach(([k]) => { if (panes[k]) { panes[k].classList.add('pd-pane'); prodTab.appendChild(panes[k]); } });
  window._pdShow = function (which) {
    // A retired key ('deck' / 'graphics' from an old deep link) matched no pane and hid them ALL,
    // leaving a blank page — land on Cameras instead.
    if (!TABS.some(([k]) => k === which)) which = 'cameras';
    sub.querySelectorAll('.ev-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.pd === which));
    TABS.forEach(([k]) => { if (panes[k]) panes[k].style.display = (k === which) ? '' : 'none'; });
    try {
      if (which === 'flows' && typeof renderFlows === 'function') renderFlows();
      if (which === 'hotkeys' && typeof renderDeckHkLegend === 'function' && window._deck) renderDeckHkLegend();
      // Cameras: re-pull VDO links for whichever camera sub-tab is active on entry.
      if (which === 'cameras' && typeof cfShowSubtab === 'function') {
        const active = document.querySelector('#cf-subnav .cf-tab.active');
        cfShowSubtab((active && active.dataset.cf) || 'talent');
      }
    } catch (_) {}
    try { localStorage.setItem('prod_active_tab', which); } catch (_) {}
  };
  sub.querySelectorAll('.ev-subnav-btn').forEach((b) => b.addEventListener('click', () => window._pdShow(b.dataset.pd)));
  let saved = (() => { try { return localStorage.getItem('prod_active_tab'); } catch (_) { return null; } })();
  // Migrate retired values: the old combined scroll, plus Deck/Graphics now that both live on the
  // Dashboard — anyone parked on one of those lands on Cameras instead of a blank page.
  if (saved === 'production' || saved === 'deck' || saved === 'graphics') saved = 'cameras';
  const initialPdTab = (saved && ['cameras', 'rundown', 'flows', 'hotkeys', 'director'].includes(saved)) ? saved : 'cameras';
  // Deferred: _pdShow('cameras') calls cfShowSubtab, which lives in camera-feeds.js (loaded after
  // this file) and reaches for VDO_API, a const declared further down it. A macrotask lets both
  // scripts finish first; calling it synchronously hits the TDZ crash camera-feeds.js documents.
  setTimeout(() => window._pdShow(initialPdTab), 0);
  try { if (localStorage.getItem('ne_active_tab') === 'director') localStorage.setItem('ne_active_tab', 'produccion'); } catch (_) {}
})();

// ── Re-home the Settings "Keyboard Shortcuts" panel into the Production ▸ Hotkeys pane ──
(function moveHotkeysToProduction() {
  const sec = document.getElementById('hk-section');
  const host = document.getElementById('prod-hk-host');
  if (sec && host && sec.parentNode !== host) host.appendChild(sec);
})();

// ── Redesign the Teams library: a search-first toolbar + a card grid of saved teams, with the
// editor and start.gg import moved into modal pop-ups. Re-parents existing nodes (IDs/handlers
// untouched) so render functions keep working. Runs after the panel exists in the DOM.
(function redesignTeamsLibrary() {
  const panel = document.getElementById('teams-panel-library');
  if (!panel || panel.dataset.redesigned) return;

  const editorSection = document.getElementById('te-title')?.closest('section');
  const pullSection   = document.getElementById('btn-teams-startgg-pull')?.closest('section');
  const savedSection  = document.getElementById('teams-list')?.closest('section');
  const sggEventSec   = document.getElementById('sgg-event-teams-section');
  const importSection = document.getElementById('startgg-section');
  if (!editorSection || !savedSection) return;

  // ── Search-first toolbar (relocate the existing count / search / sort controls into it) ──
  const bar = document.createElement('div'); bar.className = 'tl-toolbar';
  const title = document.createElement('div'); title.className = 'tl-toolbar-title'; title.textContent = 'Saved Teams';
  const count = document.getElementById('teams-count'); if (count) { count.className = 'tl-count'; title.appendChild(count); }
  const searchWrap = document.createElement('div'); searchWrap.className = 'tl-toolbar-search';
  const search = document.getElementById('teams-search');
  if (search) { search.placeholder = 'Search saved teams…'; searchWrap.appendChild(search); }
  const sort = document.getElementById('btn-sort-teams-abc');
  const newBtn = document.createElement('button'); newBtn.type = 'button'; newBtn.id = 'tl-new-team'; newBtn.className = 'btn btn-primary btn-sm'; newBtn.textContent = '+ New Team';
  const impBtn = document.createElement('button'); impBtn.type = 'button'; impBtn.id = 'tl-import-toggle'; impBtn.className = 'btn btn-secondary btn-sm'; impBtn.textContent = 'Import from start.gg';
  bar.append(title, searchWrap);
  if (sort) bar.appendChild(sort);
  bar.append(newBtn, impBtn);

  // ── Modal pop-up helper (overlay + card; closes on backdrop / × / Esc) ──
  function makeModal(id, titleText) {
    const ov = document.createElement('div'); ov.id = id; ov.className = 'tl-modal-overlay';
    ov.innerHTML = `<div class="tl-modal-card"><div class="tl-modal-head"><h3>${titleText}</h3>`
      + `<button type="button" class="tl-modal-close" aria-label="Close">&times;</button></div>`
      + `<div class="tl-modal-body"></div></div>`;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.classList.remove('show'); });
    ov.querySelector('.tl-modal-close').addEventListener('click', () => ov.classList.remove('show'));
    document.body.appendChild(ov);
    return { ov, body: ov.querySelector('.tl-modal-body') };
  }
  function closeAllTlModals() { document.querySelectorAll('.tl-modal-overlay.show').forEach((m) => m.classList.remove('show')); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllTlModals(); });

  // ── Editor → modal pop-up ──
  const edModal = makeModal('te-editor-modal', 'Add / Edit Team');
  editorSection.classList.add('tl-modal-section');
  edModal.body.appendChild(editorSection);
  window._tlOpenEditor = function () { edModal.ov.classList.add('show'); document.getElementById('te-name')?.focus(); };
  window._tlCloseEditor = function () { edModal.ov.classList.remove('show'); };

  // ── start.gg import → modal pop-up: auto-detected event (top) + paste-link / search (below) ──
  const imModal = makeModal('tl-import-modal', 'Import from start.gg');
  const detect = document.createElement('div'); detect.id = 'tl-import-detect'; detect.className = 'tl-detect';
  imModal.body.appendChild(detect);
  // Primary: paste an event link. Then the pulled teams. Verbose name-search is tucked away.
  if (pullSection) { pullSection.classList.add('tl-modal-section'); imModal.body.appendChild(pullSection); }
  if (sggEventSec) { sggEventSec.classList.add('tl-modal-section'); imModal.body.appendChild(sggEventSec); }
  if (importSection) {
    const more = document.createElement('details'); more.className = 'tl-more';
    more.innerHTML = '<summary class="tl-more-sum">Search start.gg by name (teams &amp; tournaments)</summary>';
    importSection.classList.add('tl-modal-section');
    more.appendChild(importSection);
    imModal.body.appendChild(more);
  }
  function refreshDetect() {
    const sg = (typeof currentState !== 'undefined' && currentState.startgg) || {};
    const ev = sg.selectedEvent || null;
    const n = (sg.eventTeams || []).length;
    const name = ev && (ev.name || ev.tournamentName);
    if (name) {
      detect.innerHTML = `<div class="tl-detect-row"><span class="tl-detect-dot"></span>`
        + `<div><div class="tl-detect-name">${(name + '').replace(/</g, '&lt;')}</div>`
        + `<div class="tl-detect-sub">${n ? n + ' team' + (n === 1 ? '' : 's') + ' detected from your active event' : 'Active broadcast event'}</div></div>`
        + `<button type="button" class="btn btn-primary btn-sm" id="tl-detect-save">Save all to library</button></div>`;
      detect.style.display = '';
      const sv = document.getElementById('tl-detect-save');
      if (sv) sv.addEventListener('click', () => document.getElementById('btn-save-all-sgg-teams')?.click());
    } else {
      detect.innerHTML = '<div class="tl-detect-empty">No active event detected — paste an event link or search below.</div>';
      detect.style.display = '';
    }
  }
  window._tlOpenImport = function () { refreshDetect(); imModal.ov.classList.add('show'); };

  // Hide the now-redundant Saved Teams header (its title/search/sort moved to the toolbar).
  const savedHeader = savedSection.firstElementChild;
  if (savedHeader && savedHeader.querySelector('.section-title')) savedHeader.style.display = 'none';
  savedSection.classList.add('tl-teams-section');
  document.getElementById('teams-list')?.classList.add('teams-grid');
  document.getElementById('startgg-teams-list')?.classList.add('teams-grid');

  // The Teams tab is now just toolbar + the saved-teams grid.
  [bar, savedSection].forEach((n) => panel.appendChild(n));

  newBtn.addEventListener('click', () => { if (typeof teLoad === 'function') teLoad({}); window._tlOpenEditor(); });
  impBtn.addEventListener('click', () => window._tlOpenImport());

  panel.dataset.redesigned = '1';
})();

// Both team modals live inside #tab-equipos-content in the HTML, which can be display:none when
// another tab is active — that would trap position:fixed children. Move them to document.body once
// so they always render over the full viewport regardless of which tab is open.
['te-editor-modal', 'teams-import-modal'].forEach(function(id) {
  const m = document.getElementById(id);
  if (m && m.parentElement !== document.body) document.body.appendChild(m);
});

// ── Move the tournament / bracket graphics from Production → Competitions (Events) tab ──
// Relocates the DOM nodes (IDs unchanged, so every existing handler keeps working) into a new
// "Brackets & Graphics" sub-tab under Competitions. Runs before the #ev-subnav click handler binds.
(function moveBracketsToCompetitions() {
  const events = document.getElementById('tab-events-content');
  const subnav = document.getElementById('ev-subnav');
  if (!events || !subnav) return;
  // Each anchor child ID → its containing <section>; array order = display order.
  const anchorIds = ['input-bracket-slug', 'input-upcoming-title', 'input-standings-title', 'bb-phases'];
  const sections = anchorIds
    .map((id) => document.getElementById(id))
    .filter(Boolean)
    .map((elm) => elm.closest('section.section'))
    .filter(Boolean);
  if (!sections.length) return;
  const panel = document.createElement('div');
  panel.id = 'ev-brackets-panel';
  panel.style.display = 'none';
  sections.forEach((s) => panel.appendChild(s));
  events.appendChild(panel);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'ev-subnav-btn'; btn.dataset.evtab = 'brackets';
  btn.textContent = 'Brackets & Graphics';
  subnav.appendChild(btn);
})();
