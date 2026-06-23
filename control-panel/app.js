/* ─── Control Panel Logic ────────────────────────────────────────────────── */

const WS_URL = 'ws://localhost:3001';
let ws;
let _hbTimer = null, _lastRx = 0;   // WebSocket heartbeat (half-open detection)
let currentState = {};
let pendingLogoBlue   = null;  // base64 data URL
let pendingLogoOrange = null;
let _autofillPending  = false; // awaiting an "Auto-fill from stream" result
let _lastPlayerKey    = '';    // guard to avoid unnecessary select rebuilds

// ── Helpers ───────────────────────────────────────────────────────────────
function send(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data: data || {} }));
  }
}

function el(id) { return document.getElementById(id); }

// Default team logo for the active game (used when a team has no custom logo).
function gameLogo() {
  const g = (currentState.games && currentState.games[currentState.activeGame]) || null;
  return g && g.logo ? `../assets/${g.logo}` : '../assets/rl.png';
}

// Set a team-card logo preview to the team's own logo, or the active game's logo as a fallback.
// Game-logo fallbacks get .game-logo-white so they render white (visible on the dark UI); a real
// team logo keeps its own colours.
function setSideLogo(side, teamLogo) {
  const img = document.getElementById(`preview-logo-${side}`);
  if (!img) return;
  img.src = teamLogo || gameLogo();
  img.classList.toggle('game-logo-white', !teamLogo);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Custom Modal ──────────────────────────────────────────────────────────
let modalResolve = null;

function customConfirm(title, message, confirmText = 'Confirm') {
  el('modal-title').textContent = title;
  el('modal-message').textContent = message;
  el('modal-btn-confirm').textContent = confirmText;
  el('modal-container').classList.add('active');
  
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(result) {
  el('modal-container').classList.remove('active');
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}

el('modal-btn-confirm').addEventListener('click', () => closeModal(true));
el('modal-btn-cancel').addEventListener('click', () => closeModal(false));
el('modal-btn-close').addEventListener('click', () => closeModal(false));

// ── Sidebar tab switching ───────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.id === `tab-${tab}-content`);
    });
    const scroll = el('tab-scroll'); if (scroll) scroll.scrollTop = 0;  // back to top on switch
    if (tab === 'media' && typeof mdLoad === 'function') mdLoad();   // lazy-load media on open
    if (tab === 'replays' && !_stagingLoading) scanStagingArea();   // auto-scan the OBS folder
    // Scene previews are live overlays — only run them while the Scenes tab is open.
    if (tab === 'scenes') { if (typeof loadScenePreviews === 'function') loadScenePreviews(); }
    else if (typeof unloadScenePreviews === 'function') unloadScenePreviews();
    // Show the single Match — Teams card on the Teams tab too (move it, don't duplicate IDs).
    const mt = el('match-teams-section');
    if (mt) {
      if (tab === 'equipos') el('teams-match-slot')?.appendChild(mt);
      else if (mt.parentElement && mt.parentElement.id !== 'tab-principal-content') el('tab-principal-content')?.appendChild(mt);
    }
  });
});

// ── Sidebar collapse ────────────────────────────────────────────────────────
function toggleSidebar() {
  const shell = el('app-shell');
  const collapsed = shell.classList.toggle('collapsed');
  document.documentElement.style.setProperty('--sidebar-w', collapsed ? '66px' : '236px');
  const btn = el('sidebar-collapse'); if (btn) btn.textContent = collapsed ? '›' : '‹';
}
el('sidebar-collapse')?.addEventListener('click', toggleSidebar);
el('brand-icon-btn')?.addEventListener('click', () => {
  if (el('app-shell').classList.contains('collapsed')) toggleSidebar();
});
// Right-rail width is user-resizable (drag the inner edge) and persisted.
const QRAIL_W_KEY = 'ne_qrail_w';
const QRAIL_W_MIN = 190, QRAIL_W_MAX = 680, QRAIL_W_DEFAULT = 366;
const QRAIL_MINI_KEY = 'ne_qrail_mini';
const QRAIL_MINI_DELTA = 118;   // label-width difference between full (170px) and icon-only (52px) tabs
function qrailExpandedW() {
  const v = parseInt(localStorage.getItem(QRAIL_W_KEY) || '', 10);
  return (v >= QRAIL_W_MIN && v <= QRAIL_W_MAX) ? v : QRAIL_W_DEFAULT;
}
function setQrailExpandedW(px, persist) {
  const w = Math.max(QRAIL_W_MIN, Math.min(QRAIL_W_MAX, Math.round(px)));
  document.documentElement.style.setProperty('--qrail-w', w + 'px');
  if (persist) { try { localStorage.setItem(QRAIL_W_KEY, String(w)); } catch {} }
  return w;
}
el('qrail-collapse')?.addEventListener('click', () => {
  const shell = el('app-shell');
  const collapsed = shell.classList.toggle('qrail-collapsed');
  document.documentElement.style.setProperty('--qrail-w', collapsed ? '52px' : (qrailExpandedW() + 'px'));
  const btn = el('qrail-collapse'); if (btn) btn.textContent = collapsed ? '‹' : '›';
});
// Drag-to-resize the rail from its inner edge.
(function initQrailResize() {
  const handle = el('qrail-resize'); if (!handle) return;
  let dragging = false, startX = 0, startW = 0;
  const onMove = (e) => {
    if (!dragging) return;
    const swapped = document.body.classList.contains('sides-swapped');
    const delta = swapped ? (e.clientX - startX) : (startX - e.clientX);   // drag inward = wider
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
    if (el('app-shell')?.classList.contains('qrail-collapsed')) return;   // expand first
    dragging = true; startX = e.clientX;
    startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--qrail-w'), 10) || qrailExpandedW();
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
})();
// Icons-only toggle for the quick-actions tabs (labels hide, tab column shrinks, rail narrows).
function setQrailMini(on, shiftWidth) {
  const shell = el('app-shell'); if (!shell) return;
  const was = shell.classList.contains('qrail-mini');
  shell.classList.toggle('qrail-mini', on);
  try { localStorage.setItem(QRAIL_MINI_KEY, on ? '1' : '0'); } catch {}
  // Narrow/widen the whole rail by the label width so minimizing actually frees screen space.
  if (shiftWidth && was !== on && !shell.classList.contains('qrail-collapsed')) {
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--qrail-w'), 10) || qrailExpandedW();
    setQrailExpandedW(cur + (on ? -QRAIL_MINI_DELTA : QRAIL_MINI_DELTA), true);
  }
}
el('qrail-iconly')?.addEventListener('click', () => setQrailMini(!el('app-shell')?.classList.contains('qrail-mini'), true));
// Restore the saved icons-only preference on load.
try { if (localStorage.getItem(QRAIL_MINI_KEY) === '1') el('app-shell')?.classList.add('qrail-mini'); } catch {}
// Apply the saved rail width on load (when the rail is expanded).
if (!el('app-shell')?.classList.contains('qrail-collapsed')) setQrailExpandedW(qrailExpandedW(), false);

// ── Right-rail tabs (Quick / Overlays / Trigger / Notes / Checklist / Workflow) ──
const QRAIL_TAB_TITLES = { quick: 'Quick Actions', graphics: 'Overlays', golive: 'Trigger Graphics', notes: 'Producer Notes', checklist: 'Run-of-Show', workflow: 'Production Workflow' };
function qrailShowTab(tab) {
  document.querySelectorAll('#qrail-tabs .qrail-tab').forEach((b) => b.classList.toggle('active', b.dataset.qtab === tab));
  document.querySelectorAll('.qrail-body .qrail-panel').forEach((p) => p.classList.toggle('active', p.dataset.qpanel === tab));
  const title = el('qrail-paneltitle'); if (title) title.textContent = QRAIL_TAB_TITLES[tab] || '';
  // Expand the rail if collapsed when a tab is picked.
  const shell = el('app-shell');
  if (shell && shell.classList.contains('qrail-collapsed')) {
    shell.classList.remove('qrail-collapsed');
    document.documentElement.style.setProperty('--qrail-w', qrailExpandedW() + 'px');
    const cb = el('qrail-collapse'); if (cb) cb.textContent = '›';
  }
}
document.querySelectorAll('#qrail-tabs .qrail-tab').forEach((b) => b.addEventListener('click', () => qrailShowTab(b.dataset.qtab)));

// Header Settings gear → open the Settings tab (its sidebar nav item is hidden).
el('btn-header-settings')?.addEventListener('click', () => document.getElementById('tab-ajustes')?.click());

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
  el('bug-send').textContent            = isBug ? 'Send to Discord' : 'Submit request';
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
    const r = await fetch('http://localhost:3000/api/bug-report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({
        type: _bugMode,
        title, description,
        category: el('bug-category')?.value || '',
        severity: el('bug-severity')?.value || 'medium',
        priority: el('bug-priority')?.value || '',
        reporter: (el('bug-reporter')?.value || '').trim(),
        image: _bugMode === 'bug' ? (_bugImage || undefined) : undefined,
        context: { game: gameName, page, app: 'NE Broadcast Suite' }
      })
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      bugStatus('Sent — thanks!', true);
      el('bug-title').value = ''; el('bug-desc').value = ''; setBugImage(null);
      setTimeout(() => { el('bug-report-modal').style.display = 'none'; }, 1100);
    } else { bugStatus(d.message || 'Failed to send.', false); }
  } catch (e) {
    bugStatus(e.name === 'AbortError' ? 'Timed out reaching the server — is it running?' : ('Could not reach the server: ' + e.message), false);
  } finally { clearTimeout(timer); btn.disabled = false; }
});

// ── Software updates (electron-updater in main.js, driven over the WS bridge) ──
function renderUpdateStatus(s) {
  s = s || {};
  const status = el("upd-status"), prog = el("upd-progress"), fill = el("upd-progress-fill"), notes = el("upd-notes");
  const bCheck = el("upd-check"), bDl = el("upd-download"), bInst = el("upd-install");
  const badge = el('upd-badge');
  const cur = el('upd-current'); if (cur && s.currentVersion) cur.textContent = 'v' + s.currentVersion;
  const show = (e, on) => { if (e) e.style.display = on ? '' : 'none'; };
  show(prog, false); show(bDl, false); show(bInst, false);
  if (bCheck) bCheck.disabled = false;
  if (notes) { notes.style.display = 'none'; notes.textContent = ''; }
  const msg = (t, color) => { if (status) { status.textContent = t; status.style.color = color || 'var(--muted)'; } };
  // Show pink dot on settings gear whenever there's an actionable update
  const hasBadge = s.state === 'available' || s.state === 'downloading' || s.state === 'downloaded';
  show(badge, hasBadge);
  switch (s.state) {
    case 'checking': msg('Checking for updates…'); if (bCheck) bCheck.disabled = true; break;
    case 'up-to-date': msg("You're on the latest version.", 'var(--good,#48bb78)'); break;
    case 'available':
      msg('Update available: v' + s.version + ' — downloading…', 'var(--cp-accent,#ec4899)');
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
const BB_TRIGGER_LABELS = { breakScreen: 'Countdown', winner: 'Winner', intro: 'Line-up', spotlight: 'Spotlight', veto: 'Map Veto' };
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
    const g = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((x) => x.state === p.k); if (!g) return null;
    const live = !!(currentState[g.state] && currentState[g.state].visible);
    return { label: BB_TRIGGER_LABELS[p.k] || p.k, live, run: () => send(g.msg, live ? { visible: false } : g.show()) };
  }
  return null;
}
function bbRenderCustomizeList() {
  const list = el('bb-cz-list'); if (!list) return;
  const obs = currentState.obs || {};
  const mapped = new Set(Object.values(obs.scenes || {}).filter(Boolean));
  const scenes = Array.isArray(obs.availableScenes) ? obs.availableScenes : [];
  const itemRow = (t, k, label, checked, disabled, tag) =>
    `<label class="bb-cz-item${disabled ? ' mapped' : ''}">
      <input type="checkbox" data-t="${t}" data-k="${String(k).replace(/"/g, '&quot;')}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="bb-cz-name">${String(label).replace(/</g, '&lt;')}</span>${tag ? `<span class="bb-cz-tag">${tag}</span>` : ''}
    </label>`;
  const section = (title, rows, empty) =>
    `<div class="bb-cz-grouplabel">${title}</div>${rows || `<div class="bb-cz-empty">${empty || '—'}</div>`}`;
  const sceneRows = scenes.map((s) => itemRow('scene', s, s, bbIsPinned('scene', s) || mapped.has(s), mapped.has(s), mapped.has(s) ? 'mapped' : '')).join('');
  const overlayRows = (typeof ONAIR_SCENES !== 'undefined' ? ONAIR_SCENES : []).map((o) => itemRow('overlay', o.key, o.label, bbIsPinned('overlay', o.key))).join('');
  const triggerRows = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).map((g) => itemRow('trigger', g.state, BB_TRIGGER_LABELS[g.state] || g.state, bbIsPinned('trigger', g.state))).join('');
  list.innerHTML = section('OBS Scenes', sceneRows, obs.connected ? 'No scenes in OBS.' : 'Connect OBS to list scenes.')
    + section('Overlays', overlayRows) + section('Triggers', triggerRows);
  list.querySelectorAll('input[data-t]').forEach((cb) => cb.addEventListener('change', () => {
    bbTogglePin(cb.dataset.t, cb.dataset.k, cb.checked);
    _qtSceneSig = '';
    if (currentState && typeof renderQuickToolbar === 'function') renderQuickToolbar(currentState);
  }));
}
el('btn-bb-clip')?.addEventListener('click', () => {
  const btn = el('btn-bb-clip');
  if (btn.disabled) return;
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;vertical-align:middle;"><path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.845v6.31a1 1 0 0 1-1.447.894L15 14M3 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z"/></svg> Clipping…';

  fetch('http://localhost:3000/api/twitch/clip', {
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

el('btn-bottom-customize')?.addEventListener('click', () => {
  const pop = el('bb-customize-pop'); if (!pop) return;
  const open = pop.style.display === 'none';
  pop.style.display = open ? 'block' : 'none';
  if (open) bbRenderCustomizeList();
});
el('bb-cz-close')?.addEventListener('click', () => { const p = el('bb-customize-pop'); if (p) p.style.display = 'none'; });

// ── Trigger config popover: set team/player/countdown before a pinned trigger goes live ──
// Maps each trigger to the rail control(s) it reuses (so options stay in sync).
const BB_TRIG_FIELDS = {
  breakScreen: [{ el: 'ck-break-title', kind: 'select', label: 'Title' }, { el: 'ck-break-time', kind: 'time', label: 'Countdown' }],
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
  el('bb-trigger-go').textContent = live ? 'Update' : 'Go Live';
  el('bb-trigger-hide').style.display = live ? '' : 'none';
  pop.dataset.state = stateKey;
  pop.style.display = 'block';
  // Anchor above the clicked button.
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
  pop.style.bottom = (window.innerHeight - r.top + 8) + 'px';
}
el('bb-trigger-close')?.addEventListener('click', () => { el('bb-trigger-pop').style.display = 'none'; });
el('bb-trigger-go')?.addEventListener('click', () => {
  const stateKey = el('bb-trigger-pop').dataset.state;
  const g = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((x) => x.state === stateKey); if (!g) return;
  // Write chosen values back to the rail controls so g.show() picks them up.
  el('bb-trigger-fields').querySelectorAll('[data-target]').forEach((inp) => {
    if (inp.dataset.kind === 'time') { const s = parseTimeInput(inp.value); if (s != null) setTimerSecs(s); }
    else { const tgt = el(inp.dataset.target); if (tgt) tgt.value = inp.value; }
  });
  send(g.msg, g.show());
  el('bb-trigger-pop').style.display = 'none';
});
el('bb-trigger-hide')?.addEventListener('click', () => {
  const stateKey = el('bb-trigger-pop').dataset.state;
  const g = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((x) => x.state === stateKey);
  if (g) send(g.msg, { visible: false });
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
      const r = await fetch('/api/twitch/stream');
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

  // Refresh when the Flows panel opens
  document.querySelectorAll('.qrail-tab[data-qtab="workflow"]').forEach(tab => {
    tab.addEventListener('click', refreshStreamInfo);
  });

  // ── Game search ────────────────────────────────────────────────────────────
  let _gameSearchTimer = null;
  el('btn-flows-game-search')?.addEventListener('click', doGameSearch);
  el('flows-game-search')?.addEventListener('keydown', e => { if (e.key === 'Enter') doGameSearch(); });

  async function doGameSearch() {
    const q = el('flows-game-search')?.value?.trim();
    if (!q) return;
    const box = el('flows-game-results');
    if (!box) return;
    box.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--muted);">Searching…</div>';
    box.style.display = '';
    try {
      const r = await fetch(`/api/twitch/games/search?q=${encodeURIComponent(q)}`);
      const games = await r.json();
      if (!games.length) { box.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--muted);">No results</div>'; return; }
      box.innerHTML = games.slice(0, 8).map(g => {
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
    if (!e.target.closest('#flows-game-results') && !e.target.closest('#flows-game-search') && !e.target.closest('#btn-flows-game-search'))
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
      const r = await fetch('/api/twitch/channel', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      btn.textContent = r.ok ? 'Updated ✓' : 'Failed ✗';
    } catch (_) { btn.textContent = 'Error ✗'; }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
  });

  // ── Announcement ───────────────────────────────────────────────────────────
  el('btn-flows-announce')?.addEventListener('click', async () => {
    const btn = el('btn-flows-announce');
    const message = el('flows-announce-text')?.value?.trim();
    const color   = el('flows-announce-color')?.value || 'PRIMARY';
    if (!message) return;
    const orig = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    try {
      const r = await fetch('/api/twitch/announcement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, color }) });
      if (r.ok) { btn.textContent = 'Sent ✓'; el('flows-announce-text').value = ''; }
      else btn.textContent = 'Failed ✗';
    } catch (_) { btn.textContent = 'Error ✗'; }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
  });

  // ── Shoutout ───────────────────────────────────────────────────────────────
  el('btn-flows-shoutout')?.addEventListener('click', async () => {
    const btn = el('btn-flows-shoutout');
    const username = el('flows-shoutout-user')?.value?.trim().replace(/^@/, '');
    if (!username) return;
    const orig = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    const fb = el('flows-shoutout-feedback');
    try {
      const r = await fetch('/api/twitch/shoutout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: username }) });
      if (r.ok) { btn.textContent = '/so ✓'; if (fb) fb.textContent = `Shoutout sent to @${username}`; el('flows-shoutout-user').value = ''; }
      else { const d = await r.json(); btn.textContent = 'Failed ✗'; if (fb) fb.textContent = d.error || 'Failed'; }
    } catch (_) { btn.textContent = 'Error ✗'; }
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
        await fetch('/api/twitch/chat/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(this.checked)) });
      } catch (_) {}
    });
  });

  // Shield mode (separate endpoint)
  el('flows-toggle-shield')?.addEventListener('change', async function () {
    try {
      await fetch('/api/twitch/chat/shield', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: this.checked }) });
    } catch (_) {}
  });

  // ── Raid ───────────────────────────────────────────────────────────────────
  let _raidActive = false;

  el('btn-flows-raid')?.addEventListener('click', async () => {
    const btn = el('btn-flows-raid');
    const username = el('flows-raid-user')?.value?.trim().replace(/^@/, '');
    if (!username) return;
    const orig = btn.textContent;
    btn.textContent = '…'; btn.disabled = true;
    const fb = el('flows-raid-feedback');
    try {
      const r = await fetch('/api/twitch/raid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: username }) });
      if (r.ok) {
        _raidActive = true;
        btn.textContent = 'Raiding ✓';
        if (fb) fb.textContent = `Raid to @${username} started`;
        const cancelBtn = el('btn-flows-cancel-raid');
        if (cancelBtn) cancelBtn.style.display = '';
      } else {
        const d = await r.json();
        btn.textContent = 'Failed ✗';
        if (fb) fb.textContent = d.error || 'Failed';
      }
    } catch (_) { btn.textContent = 'Error ✗'; }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
  });

  el('btn-flows-cancel-raid')?.addEventListener('click', async () => {
    const btn = el('btn-flows-cancel-raid');
    const orig = btn.textContent;
    btn.textContent = 'Cancelling…'; btn.disabled = true;
    const fb = el('flows-raid-feedback');
    try {
      const r = await fetch('/api/twitch/raid', { method: 'DELETE' });
      if (r.ok) { btn.style.display = 'none'; _raidActive = false; if (fb) fb.textContent = 'Raid cancelled'; }
      else { btn.textContent = 'Failed ✗'; btn.disabled = false; }
    } catch (_) { btn.textContent = 'Error ✗'; btn.disabled = false; }
    setTimeout(() => { if (btn.textContent !== 'Cancel Raid') { btn.textContent = orig; } }, 2500);
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
  // New top-bar server pill
  const srv = el('ck-chip-server');
  if (srv) { srv.textContent = connected ? 'Server' : 'Server: offline'; srv.classList.toggle('ok', connected); srv.classList.toggle('bad', !connected); }
}

// ── Apply full state from server ──────────────────────────────────────────
function applyState(data) {
  // The server keeps live broadcasts tiny by OMITTING big control-panel-only blobs
  // (savedTeams, brandKits — base64 logos — and the static draftChampions list); it only
  // ships them on connect and when they change. Backfill them from cache so the rest of the
  // UI always sees a complete state. Mutating `data` in place also feeds the render functions
  // that run after applyState() in the message handler.
  if (data && currentState) {
    for (const k of ['savedTeams', 'brandKits', 'draftChampions', 'brand', 'banner', 'mainBanner']) {
      if (data[k] === undefined && currentState[k] !== undefined) data[k] = currentState[k];
    }
  }
  // Don't let a state payload that omits colorMode (older server / partial state) reset the
  // selected colour mode back to 'team'.
  if (data && data.colorMode == null && currentState && currentState.colorMode) data.colorMode = currentState.colorMode;
  currentState = data;

  // Event name
  const evEl = el('input-event');
  if (evEl && document.activeElement !== evEl) evEl.value = data.eventName || '';

  // Overtime ad slot
  const ot = data.overtime || {};
  const otl = el('input-ot-label');
  if (otl && document.activeElement !== otl) otl.value = ot.label ?? 'OVERTIME';
  const otBg = el('input-ot-bg'); if (otBg) otBg.value = ot.bg || '#e0202a';
  const otCol = el('input-ot-color'); if (otCol) otCol.value = ot.color || '#ffffff';
  const otPrev = el('preview-ot-logo');
  if (otPrev) { otPrev.src = ot.logo || ''; otPrev.style.display = ot.logo ? 'block' : 'none'; }

  // Replay ad slot
  const rp = data.replay || {};
  const rpl = el('input-replay-label');
  if (rpl && document.activeElement !== rpl) rpl.value = rp.label ?? 'REPLAY';
  const rpColor = el('select-replay-color');
  if (rpColor && document.activeElement !== rpColor) rpColor.value = rp.colorMode || 'team';
  const rpPrev = el('preview-replay-logo');
  if (rpPrev) { rpPrev.src = rp.logo || ''; rpPrev.style.display = rp.logo ? 'block' : 'none'; }
  const rpOutroPrev = el('preview-replay-outro');
  if (rpOutroPrev) { rpOutroPrev.src = rp.outroLogo || ''; rpOutroPrev.style.display = rp.outroLogo ? 'block' : 'none'; }

  // Scoreboard ad slot
  const sbad = data.scoreboardAd || {};
  const sbadl = el('input-sbad-label');
  if (sbadl && document.activeElement !== sbadl) sbadl.value = sbad.label ?? 'PRESENTED BY';
  const sbadPrev = el('preview-sbad-logo');
  if (sbadPrev) { sbadPrev.src = sbad.logo || ''; sbadPrev.style.display = sbad.logo ? 'block' : 'none'; }
  const sbadBgPrev = el('preview-sbad-bg');
  if (sbadBgPrev) { sbadBgPrev.src = sbad.background || ''; sbadBgPrev.style.display = sbad.background ? 'block' : 'none'; }

  // Teams
  const teams = data.teams || {};
  syncTeamCard('blue',   teams.blue);
  syncTeamCard('orange', teams.orange);

  renderVetoManager(data);
  renderDraftManager(data);
  renderOwBanManager(data);
  renderMatchPlayers('blue',   teams.blue && teams.blue.players);
  renderMatchPlayers('orange', teams.orange && teams.orange.players);
  renderSeriesPanel(data.match, teams);
  updateFacecamTeamHeaders(teams, data);
  if (typeof applyCommercialState === 'function') applyCommercialState(data);
  if (typeof lgHydrate === 'function') lgHydrate(data.leagues);

  // Confirm an "Auto-fill from stream" once the resulting teams arrive.
  if (_autofillPending) {
    _autofillPending = false;
    const stEl = el('autofill-stream-status');
    if (stEl) {
      const err = data.startgg && data.startgg.lastError;
      if (err && /stream|queue|match/i.test(err)) { stEl.textContent = err; stEl.className = 'ev-status ev-err'; }
      else {
        const rosters = (teams.blue?.players?.length || 0) + (teams.orange?.players?.length || 0);
        stEl.textContent = `Filled from stream: ${teams.blue?.name || '?'} vs ${teams.orange?.name || '?'}`
          + (rosters ? ` — ${rosters} players loaded for facecams.` : '.');
        stEl.className = 'ev-status ev-ok';
      }
    }
  }

  // Series (Caster Desk scorecard)
  syncSeriesDeskUI(data);

  // Multi-game side labels (Blue/Orange → CT/T, A/B, …) + team-colour headers
  relabelTeamSides(data);

  // Colour mode (Team / Brand / Game) — reflect the active segment + lock the pickers.
  // The server computes the effective side colours; the client just mirrors the mode.
  if (typeof renderColorMode === 'function') renderColorMode();

  // Camera count: limit facecam modes to the active game's roster size
  syncFacecamModeOptions();

  // Saved teams dropdowns + list (picker = saved library + seeded start.gg event teams)
  populateSavedTeamsDropdowns();
  renderTeamsList(data.savedTeams || []);
  tmHydrate(data.savedTeams || []);

  // start.gg event teams (transient)
  renderStartggTeams(data.startgg?.eventTeams || [], data.startgg?.selectedEvent || null);

  // reflect selected event in dash label (if present on reload)
  const dl = el('dash-selected-sgg-event');
  const se = data.startgg && data.startgg.selectedEvent;
  if (dl && se && (se.name || se.tournamentName)) {
    dl.textContent = `✓ Selected: ${se.name || se.tournamentName}`;
  }

  syncFacecamRows(data.players || [], data.facecams || [], true);
  renderSavedFacecams(data.facecams || []);

  // RL status (legacy top-bar element — kept null-safe; new pills via renderCockpitStatus)
  const rlStatusEl = el('rl-status');
  if (rlStatusEl) rlStatusEl.textContent = data.rlConnected ? 'RL: Connected' : 'RL: Disconnected';

  // Facecams enabled (Settings + the mirrored Camera Feeds toggle)
  const cbFacecams = el('check-facecams-enabled');
  if (cbFacecams) cbFacecams.checked = data.facecamsEnabled !== false;
  const cbFacecamsCf = el('cf-facecams-enabled');
  if (cbFacecamsCf) cbFacecamsCf.checked = data.facecamsEnabled !== false;
  const cbReplayCams = el('check-replay-cams');
  if (cbReplayCams) cbReplayCams.checked = data.replayCams !== false;

  const facecamsWarning = el('facecams-disabled-warning');
  if (facecamsWarning) {
    facecamsWarning.style.display = (data.facecamsEnabled === false) ? 'flex' : 'none';
  }

  // Font family
  if (data.fontFamily) {
    const fontSelect = el('select-font');
    if (fontSelect && document.activeElement !== fontSelect) {
      let exists = false;
      for(let i = 0; i < fontSelect.options.length; i++) {
        if (fontSelect.options[i].value === data.fontFamily) { exists = true; break; }
      }
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = data.fontFamily;
        opt.textContent = data.fontFamily;
        fontSelect.appendChild(opt);
      }
      fontSelect.value = data.fontFamily;
    }
  }

  // Main Banner (global fallback — uses data.mainBanner, not the kit-aware data.banner)
  const mainBanner = data.mainBanner || data.banner;
  if (mainBanner) {
    const cbVisible = el('check-banner-visible');
    if (cbVisible && document.activeElement !== cbVisible) cbVisible.checked = !!mainBanner.visible;

    const intervalInput = el('input-banner-interval');
    if (intervalInput && document.activeElement !== intervalInput) {
      intervalInput.value = mainBanner.interval || 10;
    }

    const slantSel = el('select-banner-slant');
    if (slantSel && document.activeElement !== slantSel) slantSel.value = mainBanner.slant || 'right';

    const headerInput = el('input-banner-header');
    if (headerInput && document.activeElement !== headerInput) headerInput.value = mainBanner.header || '';

    const imagesList = el('banner-images-list');
    // Only skip the rebuild while a caption INPUT is being typed — not when a delete button is
    // focused (that would block the post-delete re-render and make deletes look like they fail).
    const ae = document.activeElement;
    const typingCaption = ae && ae.tagName === 'INPUT' && imagesList && imagesList.contains(ae);
    if (imagesList && !typingCaption) {
      imagesList.innerHTML = '';
      const own = mainBanner.images || [];
      own.forEach((src, idx) => {
        const item = document.createElement('div');
        item.style = 'position: relative; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; align-items: center; gap: 10px; transition: transform 0.2s, background 0.2s;';
        
        item.onmouseenter = () => { item.style.background = 'rgba(0,0,0,0.5)'; item.style.borderColor = 'rgba(255,255,255,0.3)'; };
        item.onmouseleave = () => { item.style.background = 'rgba(0,0,0,0.3)'; item.style.borderColor = 'rgba(255,255,255,0.1)'; };

        const img = document.createElement('img');
        img.src = src;
        img.style = 'height: 60px; width: 100%; object-fit: contain; border-radius: 4px;';

        const cap = document.createElement('input');
        cap.type = 'text'; cap.className = 'input-text';
        cap.placeholder = 'Optional text — e.g. USE CODE *NAMELESS*';
        cap.title = 'Text shown beside this banner. Wrap a word in *asterisks* for italic; use new lines for multiple lines.';
        cap.style = 'width: 100%; padding: 5px 8px; font-size: 11px;';
        cap.value = (mainBanner.captions && mainBanner.captions[idx]) || '';
        if (document.activeElement !== cap) cap.value = (mainBanner.captions && mainBanner.captions[idx]) || '';
        cap.addEventListener('change', () => send('set_banner_caption', { index: idx, text: cap.value }));
        cap.addEventListener('keydown', (e) => { if (e.key === 'Enter') cap.blur(); });

        const btn = document.createElement('button');
        btn.className = 'btn btn-danger btn-sm';
        btn.style = 'width: 100%; padding: 4px; font-size: 12px; margin-top: auto; display: flex; align-items: center; justify-content: center; gap: 4px; border-radius: 4px; cursor: pointer; border: none; font-weight: 600; color: white; background: #c53030;';
        btn.innerHTML = 'Remove';
        btn.onmouseenter = () => { btn.style.background = '#e53e3e'; };
        btn.onmouseleave = () => { btn.style.background = '#c53030'; };
        btn.addEventListener('click', () => send('remove_banner_image', { index: idx }));

        item.appendChild(img);
        item.appendChild(cap);
        item.appendChild(btn);
        imagesList.appendChild(item);
      });
    }
  }
  // Production tab (casters + break)
  applyProductionState(data);

  // Ticker
  applyTickerState(data);

  // Player spotlight + live status
  applySpotlightState(data);
  applyProdStatus(data);

  // Bracket
  applyBracketState(data);

  // Game / design / presets / custom overlays
  applyGameDesignState(data);
  renderPresets(data.presets);
  renderCustomOverlayManager(data);
  renderBrands(data);
  renderCasterDeskSponsors(data);
  renderAdSponsorPickers(data);
  applyCsgoState(data);
  applyValorantState(data);

  // OBS settings
  applyObsState(data);

  // Version
  if (data.version) {
    const verEl = el('app-version');
    if (verEl) verEl.textContent = data.version;
  }

  // Start.gg settings
  const startgg = data.startgg || {};
  const cbStartgg = el('check-startgg-enabled');
  if (cbStartgg) cbStartgg.checked = !!startgg.enabled;

  const tournamentEl = el('input-startgg-tournament');
  if (tournamentEl && document.activeElement !== tournamentEl) tournamentEl.value = startgg.tournamentSlug || '';

  const eventEl = el('input-startgg-event');
  if (eventEl && document.activeElement !== eventEl) eventEl.value = startgg.eventSlug || '';

  const setIdEl = el('input-startgg-setid');
  if (setIdEl && document.activeElement !== setIdEl) setIdEl.value = startgg.setId || '';

  const tokenEl = el('input-startgg-token');
  const tokenIndicator = el('startgg-token-indicator');
  const tokenChangeBtn = el('btn-startgg-change-token');
  if (tokenEl && !tokenEl._lockListenerAdded) {
    tokenEl._lockListenerAdded = true;
    // Nothing extra needed — Change button handles unlock
  }
  if (tokenEl) {
    if (startgg.hasToken && !tokenEl.value) {
      // Token is saved — lock the field
      tokenEl.readOnly = true;
      tokenEl.value = '';
      tokenEl.placeholder = '••••••••••••••••••••';
      tokenEl.style.opacity = '0.5';
      tokenEl.style.cursor = 'default';
      if (tokenChangeBtn) tokenChangeBtn.style.display = '';
      if (tokenIndicator) {
        tokenIndicator.style.display = 'block';
        if (startgg.connected) {
          tokenIndicator.textContent = '✓ Connected';
          tokenIndicator.style.background = 'rgba(74, 222, 128, 0.2)';
          tokenIndicator.style.borderColor = '#4ade80';
          tokenIndicator.style.color = '#86efac';
        } else {
          tokenIndicator.textContent = '✓ Saved';
          tokenIndicator.style.background = 'rgba(107, 114, 128, 0.2)';
          tokenIndicator.style.borderColor = 'rgba(107,114,128,0.5)';
          tokenIndicator.style.color = '#d1d5db';
        }
      }
    } else if (!startgg.hasToken) {
      // No token — show empty unlocked field
      tokenEl.readOnly = false;
      tokenEl.style.opacity = '';
      tokenEl.style.cursor = '';
      if (tokenChangeBtn) tokenChangeBtn.style.display = 'none';
      if (tokenIndicator) tokenIndicator.style.display = 'none';
      tokenEl.placeholder = 'Paste your start.gg API token';
    }
    // If user is actively editing (tokenEl.value has content), leave field as-is
  }

  const startggResult = el('startgg-result');
  if (startggResult) {
    if (startgg.lastError) {
      startggResult.textContent = `Last error: ${startgg.lastError}`;
      startggResult.style.color = '#f56565';
    } else if (startgg.lastSyncAt) {
      startggResult.textContent = `Last sync: ${new Date(startgg.lastSyncAt).toLocaleString()}`;
      startggResult.style.color = '#9ae6b4';
    } else {
      startggResult.textContent = '';
    }
  }

  // Update start.gg status in header
  const startggStatusEl = el('startgg-status');
  if (startggStatusEl) {
    if (startgg.enabled && startgg.hasToken) {
      startggStatusEl.style.display = 'flex';
      const icon = startggStatusEl.querySelector('.status-icon');
      if (icon) {
        icon.classList.toggle('connected', startgg.connected);
      }
    } else {
      startggStatusEl.style.display = 'none';
    }
  }

  renderStreamQueue(data);
}

function getStartggPayload() {
  const tokenInput = el('input-startgg-token');
  const token = tokenInput ? tokenInput.value.trim() : '';
  const payload = {
    enabled: !!el('check-startgg-enabled')?.checked,
    tournamentSlug: el('input-startgg-tournament')?.value.trim() || '',
    eventSlug: el('input-startgg-event')?.value.trim() || '',
    setId: el('input-startgg-setid')?.value.trim() || ''
  };
  // Only include apiToken if it's non-empty (empty means "keep current token")
  if (token) {
    payload.apiToken = token;
  }
  return payload;
}

// Relabel the two team "sides" per the active game (RL Blue/Orange, CS2 CT/T, …)
// and tint the card headers + series labels with each team's own colour.
function relabelTeamSides(data) {
  const g = (data.games && data.games[data.activeGame]) || null;
  const labels = (g && g.teamLabels) || { a: 'Blue', b: 'Orange' };
  const teams = data.teams || {};
  const blueColor = (teams.blue && teams.blue.color) || '#055fdb';
  const orangeColor = (teams.orange && teams.orange.color) || '#e97139';
  const setHdr = (id, label, color) => {
    const e = el(id); if (!e) return;
    e.textContent = (label || '').toUpperCase();
    e.style.background = color;
  };
  setHdr('team-header-blue', labels.a, blueColor);
  setHdr('team-header-orange', labels.b, orangeColor);
  const sb = el('series-label-blue-desk'); if (sb) sb.textContent = (labels.a || 'A').toUpperCase();
  const so = el('series-label-orange-desk'); if (so) so.textContent = (labels.b || 'B').toUpperCase();
  // Apply buttons: label + tint to the team's own colour (not hardcoded blue/orange)
  const ab = el('btn-apply-blue');
  if (ab) { ab.textContent = `Apply ${labels.a}`; ab.style.background = blueColor; ab.style.borderColor = blueColor; }
  const ao = el('btn-apply-orange');
  if (ao) { ao.textContent = `Apply ${labels.b}`; ao.style.background = orangeColor; ao.style.borderColor = orangeColor; }
  // Cockpit side selectors (Winner / Line-up) follow the same labels.
  [el('ck-winner-side'), el('ck-intro-side')].forEach((sel) => {
    if (!sel || sel.options.length < 2) return;
    sel.options[0].textContent = labels.a + ' team';
    sel.options[1].textContent = labels.b + ' team';
  });
}

function syncTeamCard(side, teamData) {
  if (!teamData) return;
  const nameEl  = el(`input-name-${side}`);
  const logoImg = el(`preview-logo-${side}`);
  const colorEl = el(`input-color-${side}`);
  if (nameEl && document.activeElement !== nameEl) nameEl.value = teamData.name || '';
  if (logoImg) setSideLogo(side, teamData.logo);
  if (colorEl && document.activeElement !== colorEl) {
    const displayColor = teamData.ownColor || teamData.color;
    if (displayColor) colorEl.value = displayColor;
  }
  if (side === 'blue'   && !pendingLogoBlue)   pendingLogoBlue   = teamData.logo;
  if (side === 'orange' && !pendingLogoOrange) pendingLogoOrange = teamData.logo;
}

// ── Saved teams dropdowns ─────────────────────────────────────────────────
// Every team the Match picker can choose: saved library + seeded start.gg event teams,
// deduped by name (saved wins). Used for the dropdown, the type-to-search datalist, and badges.
function allMatchTeams() {
  const saved = (currentState.savedTeams || []).map(t => ({ name: t.name, logo: t.logo, color: t.color || null, players: t.players || [], source: 'saved' }));
  const seen = new Set(saved.map(t => (t.name || '').toLowerCase()));
  const event = ((currentState.startgg && currentState.startgg.eventTeams) || [])
    .filter(t => t && t.name && !seen.has(t.name.toLowerCase()))
    .map(t => ({ name: t.name, logo: t.logo, color: t.color || null, players: t.players || [], source: 'event' }));
  return saved.concat(event).sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
}
function findTeam(name) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  return allMatchTeams().find(t => (t.name || '').toLowerCase() === n) || null;
}

function populateSavedTeamsDropdowns() {
  const teams = allMatchTeams();
  ['blue', 'orange'].forEach(side => {
    const sel = el(`select-saved-${side}`);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Manual —</option>';
    teams.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name.toUpperCase() + (t.source === 'event' ? '  · event' : '');
      sel.appendChild(opt);
    });
    sel.value = cur;
  });
  // Type-to-search source for the Name fields (native combobox — handles hundreds of teams).
  const dl = el('saved-teams-datalist');
  if (dl) {
    dl.innerHTML = '';
    teams.forEach(t => { const o = document.createElement('option'); o.value = t.name; dl.appendChild(o); });
  }
  updateTeamSavedBadge('blue');
  updateTeamSavedBadge('orange');
}

// Common player roles per game (dropdown options). Games without a fixed role set fall back
// to a free-text field. A "Custom…" entry lets producers type anything not listed.
const ROLES_BY_GAME = {
  valorant:        ['Duelist', 'Initiator', 'Controller', 'Sentinel', 'Flex', 'IGL'],
  overwatch:       ['Tank', 'DPS', 'Support', 'Flex'],
  league:          ['Top', 'Jungle', 'Mid', 'Bot (ADC)', 'Support'],
  dota2:           ['Carry', 'Mid', 'Offlane', 'Soft Support', 'Hard Support'],
  csgo:            ['IGL', 'Entry', 'AWPer', 'Lurker', 'Support', 'Rifler'],
  rainbow6:        ['Entry', 'Support', 'Flex', 'Anchor', 'IGL'],
  'rocket-league': ['Striker', 'Midfield', 'Defender', 'Flex'],
  'marvel-rivals': ['Vanguard', 'Duelist', 'Strategist', 'Flex'],
  'mobile-legends':['Gold', 'EXP', 'Mid', 'Jungle', 'Roam'],
  'honor-of-kings':['Clear', 'Mid', 'Farm', 'Roam', 'Support'],
  cod:             ['Slayer', 'Objective', 'Anchor', 'Flex', 'IGL']
};
function rolesForActiveGame() { return ROLES_BY_GAME[currentState.activeGame] || []; }

// A role control: a dropdown of the game's preset roles (+ a Custom… → free-text), or a plain
// text field for games with no fixed roles. onPick(value) fires when the role changes.
function buildRoleControl(role, presets, onPick) {
  if (!presets || !presets.length) {
    const inp = document.createElement('input');
    inp.className = 'input-text tp-role'; inp.value = role || ''; inp.placeholder = 'Role';
    inp.addEventListener('change', () => onPick(inp.value.trim()));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    return inp;
  }
  const wrap = document.createElement('div'); wrap.className = 'tp-role-wrap';
  const sel = document.createElement('select'); sel.className = 'input-select tp-role';
  const isCustom = role && !presets.includes(role);
  sel.innerHTML = '<option value="">Role</option>'
    + presets.map((r) => `<option value="${r}">${r}</option>`).join('')
    + (isCustom ? `<option value="${role.replace(/"/g, '&quot;')}">${role.replace(/</g, '&lt;')}</option>` : '')
    + '<option value="__custom__">Custom…</option>';
  sel.value = role || '';
  const toCustom = (preset) => {
    const inp = document.createElement('input');
    inp.className = 'input-text tp-role'; inp.placeholder = 'Custom role'; inp.value = preset || '';
    inp.addEventListener('change', () => onPick(inp.value.trim()));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    wrap.replaceChild(inp, sel); inp.focus();
  };
  sel.addEventListener('change', () => { if (sel.value === '__custom__') toCustom(''); else onPick(sel.value); });
  wrap.appendChild(sel);
  return wrap;
}

// ── Generic searchable picker (type to filter, optional thumbnail per item) ────────
// Used for both the country picker (flag + name) and the hero picker (portrait + name).
// One global handler closes whichever picker is open (no per-row listener leaks).
let _spOpen = null;
function _spInstallGlobal() {
  if (_spInstallGlobal._done) return; _spInstallGlobal._done = true;
  document.addEventListener('mousedown', (e) => { if (_spOpen && !_spOpen.wrap.contains(e.target)) _spOpen.close(); });
  window.addEventListener('scroll', () => { if (_spOpen) _spOpen.close(); }, true);
  window.addEventListener('resize', () => { if (_spOpen) _spOpen.close(); });
}
function _spEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
// opts: { items:[{value,label,img}], value, placeholder, emptyLabel, className, onPick }
function buildSearchPicker(opts) {
  _spInstallGlobal();
  const items = opts.items || [];
  const wrap = document.createElement('div'); wrap.className = 'sp-wrap ' + (opts.className || '');
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'sp-btn';
  const dd = document.createElement('div'); dd.className = 'sp-dd';
  const search = document.createElement('input'); search.className = 'sp-search'; search.placeholder = 'Search…';
  const list = document.createElement('div'); list.className = 'sp-list';
  dd.append(search, list); wrap.append(btn, dd);

  let cur = opts.value || '';
  let filtered = items.slice();
  let active = -1;
  let open = false;
  const find = (v) => items.find((it) => it.value === v);

  const paintBtn = () => {
    const it = find(cur);
    if (it) btn.innerHTML = `${it.img ? `<img class="sp-img" src="${_spEsc(it.img)}" onerror="this.style.visibility='hidden'">` : ''}<span class="sp-label">${_spEsc(it.label)}</span><span class="sp-caret">▾</span>`;
    else btn.innerHTML = `<span class="sp-label sp-ph">${_spEsc(opts.placeholder || 'Select…')}</span><span class="sp-caret">▾</span>`;
  };
  const renderList = () => {
    const rows = [`<div class="sp-item sp-clear" data-v="">${_spEsc(opts.emptyLabel || '— None —')}</div>`];
    filtered.forEach((it, i) => {
      rows.push(`<div class="sp-item${i === active ? ' active' : ''}" data-v="${_spEsc(it.value)}">${it.img ? `<img class="sp-img" loading="lazy" src="${_spEsc(it.img)}" onerror="this.style.visibility='hidden'">` : ''}<span class="sp-label">${_spEsc(it.label)}</span></div>`);
    });
    list.innerHTML = rows.join('') + (filtered.length ? '' : '<div class="sp-none">No matches</div>');
    const act = list.querySelector('.sp-item.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  };
  const position = () => {
    const r = btn.getBoundingClientRect();
    dd.style.left = r.left + 'px';
    dd.style.width = Math.max(r.width, 190) + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 260 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
  };
  const close = () => { dd.classList.remove('show'); open = false; if (_spOpen && _spOpen.wrap === wrap) _spOpen = null; };
  const show = () => {
    if (_spOpen && _spOpen.wrap !== wrap) _spOpen.close();
    filtered = items.slice(); active = -1; search.value = ''; renderList(); position();
    dd.classList.add('show'); open = true; _spOpen = { wrap, close };
    setTimeout(() => search.focus(), 0);
  };
  const choose = (v) => { cur = v; paintBtn(); close(); opts.onPick(v); };

  btn.addEventListener('click', (e) => { e.preventDefault(); if (open) close(); else show(); });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    filtered = q ? items.filter((it) => it.label.toLowerCase().includes(q)) : items.slice();
    active = -1; renderList(); position();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(filtered.length - 1, active + 1); renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderList(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && filtered[active]) choose(filtered[active].value); else if (filtered.length === 1) choose(filtered[0].value); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
  });
  list.addEventListener('mousedown', (e) => { const it = e.target.closest('.sp-item'); if (!it) return; e.preventDefault(); choose(it.dataset.v); });

  paintBtn();
  return wrap;
}

// Country picker — searchable, flag thumbnails. Stores the lowercase ISO alpha-2 code.
function buildCountryControl(code, onPick) {
  const list = (typeof COUNTRIES !== 'undefined' ? COUNTRIES : []).map((c) => ({
    value: c.c, label: c.n, img: typeof flagSrc === 'function' ? flagSrc(c.c) : ''
  }));
  return buildSearchPicker({
    items: list, value: (code || '').toLowerCase(), placeholder: 'Country', emptyLabel: '— No country —',
    className: 'tp-country', onPick
  });
}

// Per-game hero list for the active game (from the generated heroes-data.js).
function heroesForActiveGame() {
  if (typeof HEROES_BY_GAME === 'undefined') return [];
  return HEROES_BY_GAME[currentState.activeGame] || [];
}
function heroImgSrc(game, imgSlug) { return imgSlug ? `../assets/heroes/${game}/${imgSlug}.png` : ''; }
// Hero/agent/operator picker — autocompletes from the game's roster, with portraits where we have them.
function buildHeroControl(hero, onPick) {
  const game = currentState.activeGame;
  const list = heroesForActiveGame().map((h) => ({ value: h.n, label: h.n, img: heroImgSrc(game, h.img) }));
  return buildSearchPicker({
    items: list, value: hero || '', placeholder: 'Hero / agent', emptyLabel: '— No hero —',
    className: 'tp-hero-pick', onPick
  });
}

// Inline roster on the Match team card — view + rename + add/remove. Renaming here flows
// to the overlay players and the facecam rows (server edit_player keeps savedTeams in sync).
// (Named distinctly from the Teams-page `renderTeamPlayers` to avoid the hoisting collision.)
function renderMatchPlayers(side, players) {
  const wrap = el(`team-players-${side}`);
  if (!wrap) return;
  players = Array.isArray(players) ? players : [];
  const cams = currentState.facecams || currentState.savedFacecams || [];
  const camKey = cams.map(c => c.name).join(',');
  // Does the active game use heroes/agents/operators? Show a Hero field if so.
  const gameId = currentState.activeGame;
  const gameCfg = (currentState.games && currentState.games[gameId]) || null;
  const heroFeatures = ['heroes', 'agents', 'operators', 'legends', 'draft'];
  const usesHeroes = !!(gameCfg && (gameCfg.features || []).some(f => heroFeatures.includes(f)));
  const sig = JSON.stringify(players.map(p => [p.id, p.name, p.assignedCamera || '', p.hero || '', p.role || '', p.country || '', p.info || ''])) + '|' + camKey + '|' + usesHeroes + '|' + currentState.activeGame;
  if (wrap.dataset.sig === sig) return;
  if (wrap.contains(document.activeElement)) return;   // don't clobber a field being edited
  wrap.dataset.sig = sig;
  wrap.innerHTML = '';
  if (!players.length) {
    wrap.innerHTML = '<div class="tp-empty">No players yet — pick a team or add one.</div>';
    return;
  }
  players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'tp-row';

    const inp = document.createElement('input');
    inp.className = 'input-text tp-name';
    inp.value = p.name || '';
    inp.placeholder = 'Player name';
    inp.addEventListener('change', () => {
      if (p.id) send('edit_player', { side, playerId: p.id, playerData: { name: inp.value.trim() } });
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });

    // Assign a camera (saved facecam) to this player.
    const cam = document.createElement('select');
    cam.className = 'input-select tp-cam';
    cam.title = 'Assign a camera to this player';
    cam.innerHTML = '<option value="">No camera</option>'
      + cams.map(c => `<option value="${c.name}">${c.nickname || c.name}</option>`).join('');
    cam.value = p.assignedCamera || '';
    cam.addEventListener('change', () => {
      if (p.id) send('edit_player', { side, playerId: p.id, playerData: { assignedCamera: cam.value || null } });
    });

    const del = document.createElement('button');
    del.className = 'tp-del'; del.textContent = '×'; del.title = 'Remove player';
    del.addEventListener('click', () => { if (p.id) send('delete_player', { side, playerId: p.id }); });

    row.appendChild(inp); row.appendChild(cam); row.appendChild(del);
    wrap.appendChild(row);

    // Second line: hero/agent (if the game uses them) + role + free-text info.
    const meta = document.createElement('div');
    meta.className = 'tp-meta-row';
    if (usesHeroes) {
      const hero = buildHeroControl(p.hero || '', (val) => {
        if (p.id) send('edit_player', { side, playerId: p.id, playerData: { hero: val } });
      });
      meta.appendChild(hero);
    }
    const role = buildRoleControl(p.role || '', rolesForActiveGame(), (val) => {
      if (p.id) send('edit_player', { side, playerId: p.id, playerData: { role: val } });
    });
    const country = buildCountryControl(p.country || '', (code) => {
      if (p.id) send('edit_player', { side, playerId: p.id, playerData: { country: code } });
    });
    const info = document.createElement('input');
    info.className = 'input-text tp-info';
    info.value = p.info || ''; info.placeholder = 'IGN / info';
    info.addEventListener('change', () => { if (p.id) send('edit_player', { side, playerId: p.id, playerData: { info: info.value.trim() } }); });
    info.addEventListener('keydown', (e) => { if (e.key === 'Enter') info.blur(); });
    meta.appendChild(role); meta.appendChild(country); meta.appendChild(info);
    wrap.appendChild(meta);
  });
}
['blue', 'orange'].forEach((side) => {
  el(`btn-add-player-${side}`)?.addEventListener('click', () => {
    send('add_player', { side, player: { name: '' } });
  });
});

// ── Series / match editor (format · division · per-map results) ────────────
let _seriesMaps = [];   // local working copy of the per-map results
const FORMAT_MAPS = { bo1: 1, bo3: 3, bo5: 5, bo7: 7 };

function collectSeriesMaps() {
  const wrap = el('series-maps'); if (!wrap) return _seriesMaps;
  return [...wrap.querySelectorAll('.sr-map')].map((row) => ({
    name: row.querySelector('.sr-map-name')?.value || '',
    scoreA: Number(row.querySelector('.sr-map-a')?.value) || 0,
    scoreB: Number(row.querySelector('.sr-map-b')?.value) || 0,
    played: !!row.querySelector('.sr-map-played')?.checked
  }));
}
function pushSeriesMaps() { send('set_match', { maps: collectSeriesMaps() }); }

function renderSeriesPanel(match, teams) {
  match = match || { format: '', division: '', maps: [] };
  teams = teams || {};
  const fmtEl = el('sel-series-format');
  const numEl = el('num-series-maps');
  const divEl = el('input-series-division');
  const wrap = el('series-maps');
  if (!wrap) return;

  // Don't clobber fields the producer is actively editing.
  const editing = document.activeElement;
  const focusedInPanel = editing && (editing === fmtEl || editing === numEl || editing === divEl || wrap.contains(editing));

  if (fmtEl && editing !== fmtEl) fmtEl.value = match.format || '';
  const mapCount = (match.maps && match.maps.length) || FORMAT_MAPS[match.format] || 5;
  if (numEl && editing !== numEl) numEl.value = mapCount;
  if (divEl && editing !== divEl) divEl.value = match.division || '';

  _seriesMaps = match.maps || [];
  const aLabel = (teams.blue && teams.blue.name) || 'Team A';
  const bLabel = (teams.orange && teams.orange.name) || 'Team B';
  const aColor = (teams.blue && teams.blue.color) || '#055fdb';
  const bColor = (teams.orange && teams.orange.color) || '#e97139';

  const sig = JSON.stringify({ m: _seriesMaps, a: aLabel, b: bLabel, aColor, bColor });
  if (!focusedInPanel && wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    const count = Math.max(1, Math.min(9, Number(numEl?.value) || mapCount));
    let rows = '';
    for (let i = 0; i < count; i++) {
      const m = _seriesMaps[i] || { name: '', scoreA: 0, scoreB: 0, played: false };
      rows += `<div class="sr-map${m.played ? ' is-played' : ''}">
        <span class="sr-map-num">M${i + 1}</span>
        <input type="text" class="input-text sr-map-name" placeholder="Map / TBA" value="${(m.name || '').replace(/"/g, '&quot;')}">
        <span class="sr-map-team" style="color:${aColor}" title="${aLabel.replace(/"/g, '&quot;')}">${aLabel.slice(0, 3).toUpperCase()}</span>
        <input type="number" class="input-text sr-map-a" min="0" value="${m.scoreA || 0}">
        <span class="sr-map-dash">–</span>
        <input type="number" class="input-text sr-map-b" min="0" value="${m.scoreB || 0}">
        <span class="sr-map-team" style="color:${bColor}" title="${bLabel.replace(/"/g, '&quot;')}">${bLabel.slice(0, 3).toUpperCase()}</span>
        <label class="qt-toggle sr-map-toggle" title="Mark this map as played"><span>Played</span><span class="switch"><input type="checkbox" class="sr-map-played" ${m.played ? 'checked' : ''}><span class="slider"></span></span></label>
      </div>`;
    }
    wrap.innerHTML = rows;
    wrap.querySelectorAll('.sr-map-name, .sr-map-a, .sr-map-b').forEach((inp) => {
      inp.addEventListener('change', pushSeriesMaps);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    });
    wrap.querySelectorAll('.sr-map-played').forEach((cb) => cb.addEventListener('change', pushSeriesMaps));
  }

  // Summary: maps played + map wins per team.
  const summary = el('series-summary');
  if (summary) {
    const played = (_seriesMaps || []).filter((m) => m.played);
    let aw = 0, bw = 0;
    played.forEach((m) => { if (m.scoreA > m.scoreB) aw++; else if (m.scoreB > m.scoreA) bw++; });
    summary.textContent = played.length ? `${aLabel} ${aw} — ${bw} ${bLabel} · ${played.length}/${count2(match)} maps` : '';
  }
}
function count2(match) { return (match.maps && match.maps.length) || FORMAT_MAPS[match.format] || 5; }

// Format / maps-count / division controls.
el('sel-series-format')?.addEventListener('change', function () {
  const bo = FORMAT_MAPS[this.value];
  // Resize the working map list to the format's map count, preserving existing results.
  const maps = collectSeriesMaps();
  if (bo) { while (maps.length < bo) maps.push({ name: '', scoreA: 0, scoreB: 0, played: false }); maps.length = bo; }
  send('set_match', { format: this.value, maps });
});
el('num-series-maps')?.addEventListener('change', function () {
  const n = Math.max(1, Math.min(9, Number(this.value) || 5));
  this.value = n;
  const maps = collectSeriesMaps();
  while (maps.length < n) maps.push({ name: '', scoreA: 0, scoreB: 0, played: false });
  maps.length = n;
  send('set_match', { maps });
});
el('input-series-division')?.addEventListener('change', function () { send('set_match', { division: this.value.trim() }); });
el('input-series-division')?.addEventListener('keydown', function (e) { if (e.key === 'Enter') this.blur(); });

// ── Media library ─────────────────────────────────────────────────────────
const MD_API = 'http://localhost:3000/api/media';
const mdState = { path: '', album: 'local', view: 'grid', search: '', files: [], folders: [] };

function mdSetStatus(msg, ok) {
  const el2 = el('md-status'); if (!el2) return;
  el2.textContent = msg || ''; el2.style.color = ok === false ? '#f56565' : (ok ? 'var(--good, #48bb78)' : 'var(--muted)');
}
async function mdLoad() {
  const grid = el('md-grid'); if (!grid) return;
  try {
    const r = await fetch(`${MD_API}/list?path=${encodeURIComponent(mdState.path)}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'List failed');
    mdState.folders = data.folders || [];
    mdState.files = data.files || [];
    mdRender();
  } catch (e) {
    grid.innerHTML = `<div class="rp-empty">Could not load media — is the server running? (${e.message})</div>`;
  }
}
function mdCrumbs() {
  const wrap = el('md-crumbs'); if (!wrap) return;
  const parts = mdState.path ? mdState.path.split('/').filter(Boolean) : [];
  let acc = '';
  const links = ['<a href="#" data-md-path="">Root</a>'].concat(parts.map((p) => {
    acc = acc ? acc + '/' + p : p;
    return `<span class="md-crumb-sep">›</span><a href="#" data-md-path="${acc}">${p}</a>`;
  }));
  wrap.innerHTML = links.join('');
  wrap.querySelectorAll('a[data-md-path]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); mdState.path = a.dataset.mdPath; mdLoad();
  }));
}
function mdRender() {
  const grid = el('md-grid'); if (!grid) return;
  mdCrumbs();
  grid.className = mdState.view === 'list' ? 'md-grid md-list' : 'md-grid';
  const q = mdState.search.trim().toLowerCase();
  const folders = mdState.folders.filter((f) => !q || f.name.toLowerCase().includes(q));
  const files = mdState.files.filter((f) => !q || f.name.toLowerCase().includes(q));
  let html = `<button class="md-tile md-newfolder" id="md-newfolder">
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
    <span>Create Folder</span></button>`;
  html += folders.map((f) => `<div class="md-tile md-folder" data-folder="${f.path}">
    <button class="md-del" data-del="${f.path}" title="Delete folder"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6"/></svg></button>
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    <span class="md-name">${f.name}</span></div>`).join('');
  html += files.map((f) => `<div class="md-tile md-file" data-url="${f.url}" data-path="${f.path}" title="${f.name}">
    <button class="md-del" data-del="${f.path}" title="Delete"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6"/></svg></button>
    <div class="md-thumb"><img src="http://localhost:3000${f.url}" alt="" loading="lazy"></div>
    <span class="md-name">${f.name}</span></div>`).join('');
  grid.innerHTML = html;

  el('md-newfolder')?.addEventListener('click', async () => {
    const name = prompt('New folder name:');
    if (!name) return;
    const r = await fetch(`${MD_API}/folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: mdState.path, name }) });
    const d = await r.json(); if (d.ok) mdLoad(); else mdSetStatus(d.error || 'Folder failed', false);
  });
  grid.querySelectorAll('.md-folder').forEach((t) => t.addEventListener('click', (e) => {
    if (e.target.closest('.md-del')) return;
    mdState.path = t.dataset.folder; mdLoad();
  }));
  grid.querySelectorAll('.md-file').forEach((t) => t.addEventListener('click', (e) => {
    if (e.target.closest('.md-del')) return;
    navigator.clipboard?.writeText('http://localhost:3000' + t.dataset.url).then(() => mdSetStatus('Copied URL: ' + t.dataset.url, true), () => {});
  }));
  grid.querySelectorAll('.md-del').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete "' + b.dataset.del + '"?')) return;
    const r = await fetch(`${MD_API}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: b.dataset.del }) });
    const d = await r.json(); if (d.ok) mdLoad(); else mdSetStatus(d.error || 'Delete failed', false);
  }));
}
function mdUploadFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  let done = 0;
  files.forEach((file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await fetch(`${MD_API}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: mdState.path, name: file.name, dataUrl: reader.result }) });
        const d = await r.json();
        if (!d.ok) mdSetStatus(d.error || 'Upload failed', false);
      } catch (e) { mdSetStatus(e.message, false); }
      if (++done === files.length) { mdSetStatus(`Uploaded ${done} file(s).`, true); mdLoad(); }
    };
    reader.readAsDataURL(file);
  });
}
el('md-upload-input')?.addEventListener('change', function () { mdUploadFiles(this.files); this.value = ''; });
el('md-search')?.addEventListener('input', function () { mdState.search = this.value; mdRender(); });
el('md-album-seg')?.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', function () {
  if (this.disabled) return;
  el('md-album-seg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  this.classList.add('active');
  mdState.album = this.dataset.album;
  const webBar = el('md-web-bar'); if (webBar) webBar.style.display = mdState.album === 'web' ? 'flex' : 'none';
}));
el('md-view-seg')?.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', function () {
  el('md-view-seg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  this.classList.add('active');
  mdState.view = this.dataset.view; mdRender();
}));
el('md-web-add')?.addEventListener('click', async () => {
  const url = el('md-web-url')?.value.trim();
  let name = el('md-web-name')?.value.trim();
  if (!url) return mdSetStatus('Paste an image URL first.', false);
  if (!name) name = url.split('/').pop().split('?')[0] || 'web-image';
  const r = await fetch(`${MD_API}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: mdState.path, name, url }) });
  const d = await r.json();
  if (d.ok) { el('md-web-url').value = ''; el('md-web-name').value = ''; mdSetStatus('Saved web reference.', true); mdLoad(); }
  else mdSetStatus(d.error || 'Failed', false);
});

// ── Reusable media picker modal (pulls from the Media library) ────────────
const MP = { path: '', search: '', cb: null };
function mpOpen(onPick) {
  MP.cb = onPick; MP.path = ''; MP.search = '';
  const s = el('mp-search'); if (s) s.value = '';
  const modal = el('mp-modal'); if (modal) modal.style.display = 'flex';
  mpLoad();
}
function mpClose() { const m = el('mp-modal'); if (m) m.style.display = 'none'; MP.cb = null; }
async function mpLoad() {
  const grid = el('mp-grid'); if (!grid) return;
  try {
    const r = await fetch(`${MD_API}/list?path=${encodeURIComponent(MP.path)}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'List failed');
    MP._folders = data.folders || []; MP._files = data.files || [];
    mpRender();
  } catch (e) { grid.innerHTML = `<div class="rp-empty">Could not load media (${e.message})</div>`; }
}
function mpRender() {
  const grid = el('mp-grid'); if (!grid) return;
  // crumbs
  const wrap = el('mp-crumbs');
  if (wrap) {
    const parts = MP.path ? MP.path.split('/').filter(Boolean) : [];
    let acc = '';
    wrap.innerHTML = ['<a href="#" data-mp-path="">Root</a>'].concat(parts.map((p) => { acc = acc ? acc + '/' + p : p; return `<span class="md-crumb-sep">›</span><a href="#" data-mp-path="${acc}">${p}</a>`; })).join('');
    wrap.querySelectorAll('a[data-mp-path]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); MP.path = a.dataset.mpPath; mpLoad(); }));
  }
  const q = MP.search.trim().toLowerCase();
  const folders = (MP._folders || []).filter((f) => !q || f.name.toLowerCase().includes(q));
  const files = (MP._files || []).filter((f) => !q || f.name.toLowerCase().includes(q));
  grid.innerHTML = folders.map((f) => `<div class="md-tile md-folder" data-folder="${f.path}">
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    <span class="md-name">${f.name}</span></div>`).join('')
    + files.map((f) => `<div class="md-tile md-file" data-url="${f.url}" title="${f.name}">
      <div class="md-thumb"><img src="http://localhost:3000${f.url}" alt="" loading="lazy"></div>
      <span class="md-name">${f.name}</span></div>`).join('');
  grid.querySelectorAll('.md-folder').forEach((t) => t.addEventListener('click', () => { MP.path = t.dataset.folder; mpLoad(); }));
  grid.querySelectorAll('.md-file').forEach((t) => t.addEventListener('click', () => {
    const abs = 'http://localhost:3000' + t.dataset.url;
    if (MP.cb) MP.cb(abs);
    mpClose();
  }));
}
el('mp-close')?.addEventListener('click', mpClose);
el('mp-modal')?.addEventListener('click', (e) => { if (e.target === el('mp-modal')) mpClose(); });
el('mp-search')?.addEventListener('input', function () { MP.search = this.value; mpRender(); });
el('mp-upload-input')?.addEventListener('change', function () {
  const file = this.files && this.files[0]; this.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const r = await fetch(`${MD_API}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: MP.path, name: file.name, dataUrl: reader.result }) });
    const d = await r.json();
    const st = el('mp-status'); if (st) { st.textContent = d.ok ? 'Uploaded.' : (d.error || 'Upload failed'); st.style.color = d.ok ? 'var(--good,#48bb78)' : '#f56565'; }
    mpLoad();
  };
  reader.readAsDataURL(file);
});
// Wire the "Library" buttons next to logo fields.
el('btn-lib-logo-blue')?.addEventListener('click', () => mpOpen((url) => { pendingLogoBlue = url; const p = el('preview-logo-blue'); if (p) p.src = url; }));
el('btn-lib-logo-orange')?.addEventListener('click', () => mpOpen((url) => { pendingLogoOrange = url; const p = el('preview-logo-orange'); if (p) p.src = url; }));
el('btn-lib-brand-logo')?.addEventListener('click', () => mpOpen((url) => { pendingBrandLogo = url; const prev = el('brand-logo-preview'); if (prev) { prev.src = url; prev.style.display = ''; } }));
el('btn-lib-sponsor-logo')?.addEventListener('click', () => mpOpen((url) => {
  pendingSponsorLogo = url;
  const st = el('brand-status') || el('clips-status');
  // small visual cue: reflect the chosen file name on the sponsor name placeholder area
  const s = el('mp-status'); if (s) s.textContent = '';
}));

// ── Bracket builder (manual; feeds bracket.html) ──────────────────────────
// bbModel rounds: { name, sets: [{ a:{name,score}, b:{name,score} }] }
// Elim uses winners/losers/finals; Round Robin & Swiss use rounds[] + roster[] + auto standings.
// bbModel = the live working copy of the ACTIVE phase. Multi-phase events (Day 1
// double-elim → Day 2 single-elim/swiss) keep one entry per phase in bbPhases.
const bbModel = { type: 'single', size: 8, rosterCount: 8, swissRounds: 5, winners: [], losers: [], finals: [], rounds: [], roster: [] };
const bbIsTable = () => bbModel.type === 'roundrobin' || bbModel.type === 'swiss';
let bbPhases = [];        // [{ id, name, type, size, swissRounds, winners, losers, finals, rounds, roster }]
let bbActiveId = null;
let _bbPhaseSeq = 0;
let _bbHydrated = false;
let _bbSaveTimer = null;

const BB_FIELDS = ['type', 'size', 'swissRounds', 'winners', 'losers', 'finals', 'rounds', 'roster'];
function bbNewPhase(name, type) {
  return { id: 'ph' + (++_bbPhaseSeq), name: name || ('Phase ' + (bbPhases.length + 1)), type: type || 'single', size: 8, swissRounds: 5, winners: [], losers: [], finals: [], rounds: [], roster: [] };
}
function bbActivePhase() { return bbPhases.find((p) => p.id === bbActiveId) || null; }
function bbEnsurePhase() {
  if (!bbPhases.length) { const p = bbNewPhase('Phase 1', bbModel.type); bbPhases.push(p); bbActiveId = p.id; }
  if (!bbActiveId) bbActiveId = bbPhases[0].id;
}
// Copy bbModel ↔ the active phase object.
function bbCommit() { const ph = bbActivePhase(); if (ph) BB_FIELDS.forEach((k) => { ph[k] = bbModel[k]; }); }
function bbLoadPhase(id) {
  bbActiveId = id;
  const ph = bbActivePhase(); if (!ph) return;
  BB_FIELDS.forEach((k) => { bbModel[k] = ph[k] !== undefined ? ph[k] : bbModel[k]; });
  // reflect type/size/rounds in the toolbar
  const seg = el('bb-type-seg'); if (seg) seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.type === bbModel.type));
  const sz = el('bb-size'); if (sz) sz.value = bbModel.size;
  const rn = el('bb-rounds-num'); if (rn) rn.value = bbModel.swissRounds;
  bbSyncTypeUi();
  bbRender();
}

function bbRoundName(matchCount, section, isLast) {
  if (section === 'finals') return 'Grand Final';
  if (section === 'losers') return isLast ? "Losers' Final" : 'Losers Round';
  if (isLast) return section === 'winners' && bbModel.type === 'double' ? "Winners' Final" : 'Final';
  if (matchCount >= 8) return 'Round of ' + (matchCount * 2);
  if (matchCount === 4) return 'Quarterfinals';
  if (matchCount === 2) return 'Semifinals';
  return 'Final';
}
function bbEmptySet() { return { a: { name: '', score: 0 }, b: { name: '', score: 0 } }; }
function bbMakeRounds(counts, section) {
  return counts.map((cnt, idx) => ({
    name: bbRoundName(cnt, section, idx === counts.length - 1),
    sets: Array.from({ length: cnt }, bbEmptySet)
  }));
}
// Single round-robin schedule (circle method). n must be even.
function bbRoundRobinPairs(n) {
  const idx = [...Array(n).keys()];
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const matches = [];
    for (let i = 0; i < n / 2; i++) matches.push([idx[i], idx[n - 1 - i]]);
    rounds.push(matches);
    idx.splice(1, 0, idx.pop());   // rotate, fixing idx[0]
  }
  return rounds;
}
function bbGenerate() {
  bbEnsurePhase();
  const size = bbModel.size;
  if (bbModel.type === 'single' || bbModel.type === 'double') {
    const p2 = 1 << Math.ceil(Math.log2(size));   // snap to a power of two (byes if needed)
    const winCounts = [];
    for (let m = p2 / 2; m >= 1; m = Math.floor(m / 2)) winCounts.push(m);
    bbModel.winners = bbMakeRounds(winCounts, 'winners');
    if (bbModel.type === 'double') {
      const loseCounts = [];
      for (let m = p2 / 4; m >= 1; m = Math.floor(m / 2)) { loseCounts.push(m); loseCounts.push(m); }
      bbModel.losers = bbMakeRounds(loseCounts, 'losers');
      bbModel.finals = bbMakeRounds([1], 'finals');
    } else { bbModel.losers = []; bbModel.finals = []; }
    bbModel.rounds = [];
  } else {
    // Round Robin / Swiss — build a roster, then a schedule of rounds.
    const n = bbModel.size;
    if (bbModel.roster.length < n) while (bbModel.roster.length < n) bbModel.roster.push('');
    bbModel.roster.length = n;
    bbModel.winners = []; bbModel.losers = []; bbModel.finals = [];
    if (bbModel.type === 'roundrobin') {
      const pairs = bbRoundRobinPairs(n % 2 === 0 ? n : n + 1);
      bbModel.rounds = pairs.map((matches, ri) => ({
        name: 'Round ' + (ri + 1),
        sets: matches.filter(([a, b]) => a < n && b < n).map(([a, b]) => ({
          a: { name: bbModel.roster[a] || '', score: 0 }, b: { name: bbModel.roster[b] || '', score: 0 }
        }))
      }));
    } else {
      const rc = Math.max(1, Math.min(12, bbModel.swissRounds || Math.ceil(Math.log2(n))));
      bbModel.rounds = Array.from({ length: rc }, (_, ri) => ({
        name: 'Round ' + (ri + 1),
        sets: Array.from({ length: Math.floor(n / 2) }, (_, mi) => {
          // Round 1 seeds sequentially from the roster; later rounds are filled by the producer.
          const a = ri === 0 ? bbModel.roster[mi * 2] || '' : '';
          const b = ri === 0 ? bbModel.roster[mi * 2 + 1] || '' : '';
          return { a: { name: a, score: 0 }, b: { name: b, score: 0 } };
        })
      }));
    }
  }
  bbRender();
  bbAutosave();
}
// Auto-compute W/L standings from every played match in the schedule.
function bbComputeStandings(rounds, roster) {
  rounds = rounds || bbModel.rounds; roster = roster || bbModel.roster;
  const tally = {};
  const seed = (name) => { if (name && !tally[name]) tally[name] = { name, wins: 0, losses: 0 }; };
  roster.forEach(seed);
  rounds.forEach((round) => round.sets.forEach((set) => {
    seed(set.a.name); seed(set.b.name);
    const w = bbWinnerOf(set);
    if (!w || !set.a.name || !set.b.name) return;
    if (w === 'a') { tally[set.a.name].wins++; tally[set.b.name].losses++; }
    else { tally[set.b.name].wins++; tally[set.a.name].losses++; }
  }));
  return Object.values(tally)
    .filter((t) => t.name)
    .sort((x, y) => (y.wins - y.losses) - (x.wins - x.losses) || y.wins - x.wins || x.name.localeCompare(y.name))
    .map((t, i) => ({ placement: i + 1, name: t.name, wins: t.wins, losses: t.losses }));
}
function bbTeamsDatalist() {
  const dl = el('bb-teams-datalist'); if (!dl) return;
  dl.innerHTML = allMatchTeams().map((t) => `<option value="${(t.name || '').replace(/"/g, '&quot;')}">`).join('');
}
function bbWinnerOf(set) {
  const a = Number(set.a.score) || 0, b = Number(set.b.score) || 0;
  if (a === b) return null;
  return a > b ? 'a' : 'b';
}
// Advance the winner of (section, roundIdx, setIdx) into the structurally next slot.
function bbAdvance(section, ri, si) {
  const arr = bbModel[section];
  const set = arr[ri] && arr[ri].sets[si]; if (!set) return;
  const w = bbWinnerOf(set); if (!w) { bbStatus('Enter scores first to pick a winner.', false); return; }
  const team = set[w];
  let target, slot;
  if (section === 'winners' && ri < arr.length - 1) { target = arr[ri + 1].sets[Math.floor(si / 2)]; slot = si % 2 === 0 ? 'a' : 'b'; }
  else if (section === 'winners' && bbModel.type === 'double') { target = bbModel.finals[0] && bbModel.finals[0].sets[0]; slot = 'a'; }
  else if (section === 'losers' && ri < arr.length - 1) { target = arr[ri + 1].sets[Math.floor(si / 2)]; slot = si % 2 === 0 ? 'a' : 'b'; }
  else if (section === 'losers') { target = bbModel.finals[0] && bbModel.finals[0].sets[0]; slot = 'b'; }
  if (target) { target[slot] = { name: team.name, score: 0 }; bbRender(); bbAutosave(); bbStatus('Advanced ' + (team.name || 'winner') + '.', true); }
}
function bbStatus(msg, ok) {
  const s = el('bb-status'); if (!s) return;
  s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good, #48bb78)' : 'var(--muted)');
}
function bbSectionHtml(section, label) {
  const arr = bbModel[section];
  if (!arr || !arr.length) return '';
  const cols = arr.map((round, ri) => {
    const sets = round.sets.map((set, si) => {
      const w = bbWinnerOf(set);
      return `<div class="bb-set">
        <div class="bb-slot${w === 'a' ? ' win' : ''}">
          <input class="input-text bb-name" list="bb-teams-datalist" data-sec="${section}" data-r="${ri}" data-s="${si}" data-side="a" value="${(set.a.name || '').replace(/"/g, '&quot;')}" placeholder="TBA">
          <input type="number" class="input-text bb-score" min="0" data-sec="${section}" data-r="${ri}" data-s="${si}" data-side="a" value="${set.a.score || 0}">
        </div>
        <div class="bb-slot${w === 'b' ? ' win' : ''}">
          <input class="input-text bb-name" list="bb-teams-datalist" data-sec="${section}" data-r="${ri}" data-s="${si}" data-side="b" value="${(set.b.name || '').replace(/"/g, '&quot;')}" placeholder="TBA">
          <input type="number" class="input-text bb-score" min="0" data-sec="${section}" data-r="${ri}" data-s="${si}" data-side="b" value="${set.b.score || 0}">
        </div>
        ${section === 'rounds' ? '' : `<button class="bb-adv" data-sec="${section}" data-r="${ri}" data-s="${si}" title="Advance winner">→</button>`}
        <button class="bb-live" data-sec="${section}" data-r="${ri}" data-s="${si}" title="Push this matchup live to the overlay (Blue vs Orange)">LIVE</button>
      </div>`;
    }).join('');
    return `<div class="bb-round">
      <input class="bb-round-name" data-sec="${section}" data-r="${ri}" value="${(round.name || '').replace(/"/g, '&quot;')}">
      <div class="bb-round-sets">${sets}</div>
    </div>`;
  }).join('');
  return `<div class="bb-section"><div class="bb-section-label">${label}</div><div class="bb-cols">${cols}</div></div>`;
}
function bbRenderRoster() {
  const wrap = el('bb-roster'); if (!wrap) return;
  if (!bbIsTable()) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  wrap.innerHTML = '<div class="bb-roster-label">Tournament teams</div><div class="bb-roster-grid">'
    + bbModel.roster.map((nm, i) => `<input class="input-text bb-roster-name" data-i="${i}" list="bb-teams-datalist" value="${(nm || '').replace(/"/g, '&quot;')}" placeholder="Team ${i + 1}">`).join('')
    + '</div>';
  wrap.querySelectorAll('.bb-roster-name').forEach((inp) => {
    inp.addEventListener('change', () => { bbModel.roster[+inp.dataset.i] = inp.value.trim(); bbAutosave(); bbRenderStandings(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
}
function bbRenderStandings() {
  const wrap = el('bb-standings'); if (!wrap) return;
  if (!bbIsTable()) { wrap.style.display = 'none'; return; }
  const rows = bbComputeStandings();
  wrap.style.display = 'block';
  wrap.innerHTML = '<div class="bb-standings-label">Standings (auto from scores)</div>'
    + '<div class="bb-standings-table"><div class="bb-st-row bb-st-head"><span>#</span><span>Team</span><span>W</span><span>L</span></div>'
    + rows.map((s) => `<div class="bb-st-row"><span>${s.placement}</span><span class="bb-st-name">${(s.name || '').replace(/</g, '&lt;')}</span><span>${s.wins}</span><span>${s.losses}</span></div>`).join('')
    + '</div>';
}
function bbRender() {
  const board = el('bb-board'); if (!board) return;
  bbTeamsDatalist();
  bbRenderPhases();
  bbRenderRoster();
  const hasElim = bbModel.winners.length || bbModel.losers.length;
  const hasTable = bbModel.rounds.length;
  if (!hasElim && !hasTable) {
    board.innerHTML = '<div class="rp-empty">Pick a size + type and hit Generate to build a bracket.</div>';
    bbRenderStandings();
    return;
  }
  if (bbIsTable()) {
    board.innerHTML = bbSectionHtml('rounds', bbModel.type === 'swiss' ? 'Swiss Rounds' : 'Round-Robin Schedule');
  } else {
    board.innerHTML = bbSectionHtml('winners', bbModel.type === 'double' ? 'Winners Bracket' : 'Bracket')
      + bbSectionHtml('losers', 'Losers Bracket')
      + bbSectionHtml('finals', 'Grand Final');
  }
  board.querySelectorAll('.bb-name').forEach((inp) => {
    inp.addEventListener('change', () => { bbModel[inp.dataset.sec][inp.dataset.r].sets[inp.dataset.s][inp.dataset.side].name = inp.value.trim(); bbAutosave(); if (bbIsTable()) bbRenderStandings(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
  board.querySelectorAll('.bb-score').forEach((inp) => {
    inp.addEventListener('change', () => { bbModel[inp.dataset.sec][inp.dataset.r].sets[inp.dataset.s][inp.dataset.side].score = Number(inp.value) || 0; bbRender(); bbAutosave(); });
  });
  board.querySelectorAll('.bb-round-name').forEach((inp) => {
    inp.addEventListener('change', () => { bbModel[inp.dataset.sec][inp.dataset.r].name = inp.value.trim(); bbAutosave(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
  board.querySelectorAll('.bb-adv').forEach((b) => b.addEventListener('click', () => bbAdvance(b.dataset.sec, +b.dataset.r, +b.dataset.s)));
  board.querySelectorAll('.bb-live').forEach((b) => b.addEventListener('click', () => bbPushMatch(b.dataset.sec, +b.dataset.r, +b.dataset.s)));
  bbRenderStandings();
}
// Push a bracket matchup live: load both teams (name + logo + roster) into Blue/Orange and reset the series.
function bbPushMatch(section, ri, si) {
  const set = bbModel[section] && bbModel[section][ri] && bbModel[section][ri].sets[si];
  if (!set) return;
  const a = (set.a.name || '').trim(), b = (set.b.name || '').trim();
  if (!a || !b) { bbStatus('Both slots need a team before going live.', false); return; }
  const ta = findTeam(a), tb = findTeam(b);
  send('set_team', { side: 'blue', name: a, logo: (ta && ta.logo) || null, color: (ta && ta.color) || undefined, players: (ta && ta.players) || [] });
  send('set_team', { side: 'orange', name: b, logo: (tb && tb.logo) || null, color: (tb && tb.color) || undefined, players: (tb && tb.players) || [] });
  send('reset_series');
  bbStatus(`${a} vs ${b} pushed to the overlay.`, true);
}
// Convert one phase → the overlay-ready shape (winners/losers/finals or standings).
function bbPhaseToPayload(ph) {
  const conv = (arr) => (arr || []).map((round, ri) => ({
    name: round.name, round: ri + 1,
    sets: round.sets.map((set) => {
      const w = bbWinnerOf(set);
      return {
        a: { name: set.a.name || 'TBD', score: Number(set.a.score) || 0, winner: w === 'a' },
        b: { name: set.b.name || 'TBD', score: Number(set.b.score) || 0, winner: w === 'b' }
      };
    })
  }));
  const TYPE = { single: 'SINGLE_ELIMINATION', double: 'DOUBLE_ELIMINATION', roundrobin: 'ROUND_ROBIN', swiss: 'SWISS' };
  const table = ph.type === 'roundrobin' || ph.type === 'swiss';
  const base = { id: ph.id, name: ph.name, type: TYPE[ph.type] || 'SINGLE_ELIMINATION' };
  if (table) Object.assign(base, { winners: [], losers: [], finals: [], standings: bbComputeStandings(ph.rounds || [], ph.roster || []), schedule: ph.rounds || [], roster: ph.roster || [] });
  else Object.assign(base, { winners: conv(ph.winners), losers: conv(ph.losers), finals: conv(ph.finals), standings: [], schedule: [], roster: [] });
  return base;
}
// Commit the live phase, then push ALL phases + the active id to the overlay.
function bbSendPhases(extra) {
  bbEnsurePhase(); bbCommit();
  const teams = allMatchTeams().filter((t) => t.logo).map((t) => ({ name: t.name, logo: t.logo }));
  send('set_bracket_phases', Object.assign({
    phases: bbPhases.map(bbPhaseToPayload),
    activePhaseId: bbActiveId,
    title: (currentState.bracket && currentState.bracket.title) || 'Bracket',
    teams
  }, extra || {}));
}
function bbAutosave() {
  if (!el('bb-autosave') || !el('bb-autosave').checked) return;
  clearTimeout(_bbSaveTimer);
  _bbSaveTimer = setTimeout(() => bbSendPhases(), 500);
}
// ── Phase tabs (Day 1 / Day 2 …) ──────────────────────────────────────────
function bbRenderPhases() {
  const wrap = el('bb-phases'); if (!wrap) return;
  if (!bbPhases.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = bbPhases.map((p) =>
    `<div class="bb-phase-tab${p.id === bbActiveId ? ' active' : ''}" data-pid="${p.id}" title="Double-click to rename">
       <span class="bb-phase-name">${(p.name || 'Phase').replace(/</g, '&lt;')}</span>
       ${bbPhases.length > 1 ? `<button class="bb-phase-del" data-del="${p.id}" title="Delete phase">×</button>` : ''}
     </div>`).join('') + '<button class="bb-phase-add" id="bb-phase-add" title="Add a phase (e.g. Day 2)">+ Phase</button>';
  wrap.querySelectorAll('.bb-phase-tab').forEach((t) => {
    t.addEventListener('click', (e) => { if (e.target.closest('.bb-phase-del')) return; if (t.dataset.pid !== bbActiveId) bbSelectPhase(t.dataset.pid); });
    t.addEventListener('dblclick', () => bbRenamePhase(t.dataset.pid));
  });
  wrap.querySelectorAll('.bb-phase-del').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); bbDeletePhase(b.dataset.del); }));
  el('bb-phase-add')?.addEventListener('click', bbAddPhase);
}
function bbSelectPhase(id) { bbCommit(); bbLoadPhase(id); bbRenderPhases(); bbAutosave(); }
function bbAddPhase() {
  bbCommit();
  const p = bbNewPhase('Phase ' + (bbPhases.length + 1), 'single');
  bbPhases.push(p);
  bbLoadPhase(p.id); bbRenderPhases(); bbSendPhases();
}
function bbRenamePhase(id) {
  const ph = bbPhases.find((x) => x.id === id); if (!ph) return;
  const name = prompt('Phase name:', ph.name); if (name == null) return;
  ph.name = name.trim() || ph.name; bbRenderPhases(); bbSendPhases();
}
function bbDeletePhase(id) {
  if (bbPhases.length <= 1) return;
  if (!confirm('Delete this phase?')) return;
  bbPhases = bbPhases.filter((x) => x.id !== id);
  if (bbActiveId === id) { bbActiveId = bbPhases[0].id; bbLoadPhase(bbActiveId); }
  bbRenderPhases(); bbSendPhases();
}
function bbSyncTypeUi() {
  document.querySelectorAll('.bb-rounds-field').forEach((e) => { e.style.display = bbModel.type === 'swiss' ? '' : 'none'; });
  document.querySelectorAll('.bb-swiss-only').forEach((e) => { e.style.display = bbModel.type === 'swiss' ? '' : 'none'; });
}
// Seed empty slots from the saved/seeded team list.
function bbSeedTeams() {
  const names = allMatchTeams().map((t) => t.name).filter(Boolean);
  if (!names.length) { bbStatus('No saved teams to seed from.', false); return; }
  if (bbIsTable()) {
    for (let i = 0; i < bbModel.roster.length; i++) if (!bbModel.roster[i]) bbModel.roster[i] = names[i] || '';
    if (bbModel.type === 'roundrobin') bbGenerate();        // reflow the schedule with seeded names
    else { (bbModel.rounds[0]?.sets || []).forEach((set, mi) => { if (!set.a.name) set.a.name = bbModel.roster[mi * 2] || ''; if (!set.b.name) set.b.name = bbModel.roster[mi * 2 + 1] || ''; }); bbRender(); bbAutosave(); }
  } else if (bbModel.winners[0]) {
    let k = 0;
    bbModel.winners[0].sets.forEach((set) => { if (!set.a.name) set.a.name = names[k++] || ''; if (!set.b.name) set.b.name = names[k++] || ''; });
    bbRender(); bbAutosave();
  }
  bbStatus('Seeded from team list.', true);
}
// Swiss: fill empty matches by pairing teams in current-standings order.
function bbSwissPair() {
  const standings = bbComputeStandings().map((s) => s.name);
  const pool = standings.length ? standings : bbModel.roster.filter(Boolean);
  bbModel.rounds.forEach((round) => {
    const used = new Set();
    round.sets.forEach((set) => { if (set.a.name) used.add(set.a.name); if (set.b.name) used.add(set.b.name); });
    const avail = pool.filter((n) => !used.has(n));
    round.sets.forEach((set) => {
      if (!set.a.name && avail.length) set.a.name = avail.shift();
      if (!set.b.name && avail.length) set.b.name = avail.shift();
    });
  });
  bbRender(); bbAutosave(); bbStatus('Paired empty Swiss matches by standings.', true);
}
el('bb-type-seg') && el('bb-type-seg').querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', function () {
  el('bb-type-seg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  this.classList.add('active'); bbModel.type = this.dataset.type; bbSyncTypeUi();
}));
el('bb-size')?.addEventListener('change', function () { bbModel.size = Number(this.value) || 8; });
el('bb-rounds-num')?.addEventListener('change', function () { bbModel.swissRounds = Math.max(1, Math.min(12, Number(this.value) || 5)); });
el('bb-seed')?.addEventListener('click', bbSeedTeams);
el('bb-swiss-pair')?.addEventListener('click', bbSwissPair);
el('bb-generate')?.addEventListener('click', bbGenerate);
el('bb-save')?.addEventListener('click', () => { bbSendPhases(); bbStatus('Bracket saved & pushed.', true); });
el('bb-clear')?.addEventListener('click', () => {
  if (!confirm('Clear this phase?')) return;
  bbModel.winners = []; bbModel.losers = []; bbModel.finals = []; bbModel.rounds = []; bbModel.roster = [];
  bbRender(); bbSendPhases({ visible: false });
  const v = el('bb-visible'); if (v) v.checked = false;
});
el('bb-visible')?.addEventListener('change', function () { bbSendPhases({ visible: this.checked }); });

// One overlay phase → a builder phase (editable fields).
function bbPhaseFromOverlay(op) {
  const TYPE = { SINGLE_ELIMINATION: 'single', DOUBLE_ELIMINATION: 'double', ROUND_ROBIN: 'roundrobin', SWISS: 'swiss' };
  const fromOverlay = (arr) => (arr || []).map((round) => ({
    name: round.name || '',
    sets: (round.sets || []).map((s) => ({
      a: { name: s.a && s.a.name === 'TBD' ? '' : ((s.a && s.a.name) || ''), score: (s.a && s.a.score) || 0 },
      b: { name: s.b && s.b.name === 'TBD' ? '' : ((s.b && s.b.name) || ''), score: (s.b && s.b.score) || 0 }
    }))
  }));
  const type = TYPE[op.type] || ((op.standings && op.standings.length) ? 'roundrobin' : 'single');
  const ph = bbNewPhase(op.name || 'Bracket', type);
  if (op.id) ph.id = op.id;
  if (type === 'roundrobin' || type === 'swiss') {
    ph.roster = Array.isArray(op.roster) && op.roster.length ? op.roster.slice() : (op.standings || []).map((s) => s.name).filter(Boolean);
    ph.rounds = Array.isArray(op.schedule) ? op.schedule : [];
    ph.size = ph.roster.length || 8;
  } else {
    ph.winners = fromOverlay(op.winners); ph.losers = fromOverlay(op.losers); ph.finals = fromOverlay(op.finals);
  }
  return ph;
}
// Hydrate the builder from a saved/imported bracket (once). Handles phases + legacy flat.
function bbHydrate(bracket) {
  if (_bbHydrated || !bracket) return;
  const phases = Array.isArray(bracket.phases) ? bracket.phases : [];
  const hasFlat = (bracket.winners && bracket.winners.length) || (bracket.standings && bracket.standings.length);
  if (phases.length) {
    bbPhases = phases.map(bbPhaseFromOverlay);
    _bbPhaseSeq = bbPhases.length;
    bbActiveId = phases.some((p) => p.id === bracket.activePhaseId) ? bracket.activePhaseId : bbPhases[0].id;
    const vis = el('bb-visible'); if (vis) vis.checked = !!bracket.visible;
    bbLoadPhase(bbActiveId);
    bbRenderPhases();
  } else if (hasFlat) {
    bbPhases = [bbPhaseFromOverlay(bracket)];
    bbActiveId = bbPhases[0].id; _bbPhaseSeq = 1;
    const vis = el('bb-visible'); if (vis) vis.checked = !!bracket.visible;
    bbLoadPhase(bbActiveId);
    bbRenderPhases();
  }
  _bbHydrated = true;
}

// Badge: ✓ Saved (in library) · Event (seeded, not yet saved) · Not saved (manual/new).
function updateTeamSavedBadge(side) {
  const input = el(`input-name-${side}`);
  const badge = el(`team-saved-${side}`);
  if (!input || !badge) return;
  const name = input.value.trim();
  const t = name ? findTeam(name) : null;
  if (!name) { badge.textContent = ''; badge.className = 'team-saved-badge'; }
  else if (t && t.source === 'saved') { badge.textContent = '✓ Saved'; badge.className = 'team-saved-badge is-saved'; }
  else if (t && t.source === 'event') { badge.textContent = 'Event'; badge.className = 'team-saved-badge is-event'; }
  else { badge.textContent = 'Not saved'; badge.className = 'team-saved-badge is-unsaved'; }
  const saveBtn = el(`btn-quick-save-${side}`);
  if (saveBtn) saveBtn.textContent = (t && t.source === 'saved') ? 'Update' : 'Save';
}

// ── Team list (Equipos tab) ───────────────────────────────────────────────
let _teamsListSig = '';
function renderTeamsList(teams) {
  teams = teams || [];
  const list = el('teams-list');
  if (!list) return;

  const countEl = el('teams-count');
  if (countEl) countEl.textContent = teams.length ? '(' + teams.length + ')' : '';

  // Only rebuild the DOM when the data actually changes — this list can hold hundreds of
  // start.gg-imported teams, and rebuilding it on every full_state was the freeze. Use a CHEAP
  // signature (name + logo length) so we never re-stringify big base64 logo data URLs.
  const sig = teams.map((t) => (t.name || '') + '|' + (t.logo ? t.logo.length : 0)).join('~');
  if (sig === _teamsListSig) return;
  _teamsListSig = sig;

  list.querySelectorAll('.team-list-item').forEach((i) => i.remove());

  const frag = document.createDocumentFragment();
  teams.forEach((t) => {
    const item = document.createElement('div');
    item.className = 'team-list-item';
    item.dataset.name = t.name;
    item.dataset.search = (t.name || '').toLowerCase();

    const handle = document.createElement('div'); handle.className = 'drag-handle'; handle.textContent = '⋮⋮'; handle.title = 'Drag to reorder';
    const logo = document.createElement('img'); logo.className = 'team-list-logo'; logo.loading = 'lazy'; logo.src = t.logo || '../assets/rl.png';
    const name = document.createElement('div'); name.className = 'team-list-name'; name.textContent = t.name;
    const actions = document.createElement('div'); actions.className = 'team-list-actions';
    const editBtn = document.createElement('button'); editBtn.className = 'btn btn-secondary'; editBtn.textContent = 'Edit'; editBtn.addEventListener('click', () => startEditTeam(t));
    const delBtn = document.createElement('button'); delBtn.className = 'btn btn-danger'; delBtn.textContent = 'Delete'; delBtn.addEventListener('click', () => deleteTeam(t.name));
    actions.append(editBtn, delBtn);
    item.append(handle, logo, name, actions);
    frag.appendChild(item);
  });
  list.appendChild(frag);

  // (Re)init drag-sort only when the list actually rebuilt.
  if (window.Sortable && list.querySelectorAll('.team-list-item').length > 1) {
    if (list._sortable) list._sortable.destroy();
    list._sortable = Sortable.create(list, {
      handle: '.drag-handle', animation: 150, ghostClass: 'sortable-ghost',
      onEnd: () => {
        const names = Array.from(list.querySelectorAll('.team-list-item')).map((e) => e.dataset.name);
        const reordered = names.map((nm) => (currentState.savedTeams || []).find((st) => st.name === nm)).filter(Boolean);
        send('update_teams_order', { teams: reordered });
      }
    });
  }
  applyTeamsFilter();
}

// Keyword filter over the saved-teams list (pure show/hide — no re-render).
function applyTeamsFilter() {
  const list = el('teams-list'); if (!list) return;
  const q = (el('teams-search')?.value || '').trim().toLowerCase();
  const items = list.querySelectorAll('.team-list-item');
  let shown = 0;
  items.forEach((item) => { const m = !q || (item.dataset.search || '').includes(q); item.style.display = m ? '' : 'none'; if (m) shown++; });
  const empty = el('teams-empty');
  if (empty) {
    if (items.length === 0) { empty.textContent = 'No saved teams yet — create one in the editor above.'; empty.style.display = ''; }
    else if (q && shown === 0) { empty.textContent = 'No teams match your search.'; empty.style.display = ''; }
    else { empty.style.display = 'none'; }
  }
}
el('teams-search')?.addEventListener('input', applyTeamsFilter);

let _sggTeamsSig = '';
function renderStartggTeams(teams = [], selectedEvent = null) {
  const list = el('startgg-teams-list');
  const empty = el('sgg-teams-empty');
  const countEl = el('sgg-teams-count');
  const labelEl = el('sgg-selected-event-label');
  if (!list || !empty) return;

  // Skip the full rebuild when nothing changed (event imports can be large). Cheap sig — no base64.
  const evName = selectedEvent && (selectedEvent.name || selectedEvent.tournamentName) || '';
  const sig = evName + '::' + teams.map((t) => (t.name || '') + '|' + (t.logo ? t.logo.length : 0)).join('~');
  if (sig === _sggTeamsSig) return;
  _sggTeamsSig = sig;

  list.querySelectorAll('.team-list-item').forEach(i => i.remove());

  const count = teams.length;
  if (countEl) countEl.textContent = count ? `(${count})` : '';

  if (labelEl) {
    if (selectedEvent && (selectedEvent.name || selectedEvent.tournamentName)) {
      const nm = selectedEvent.name || selectedEvent.tournamentName;
      labelEl.textContent = `From: ${nm}`;
    } else {
      labelEl.textContent = '';
    }
  }

  empty.style.display = count === 0 ? '' : 'none';

  teams.forEach(t => {
    const item = document.createElement('div');
    item.className = 'team-list-item';
    item.dataset.name = t.name;
    item.style.borderLeft = '3px solid #3b82f6'; // visual hint it's from sgg

    const logo = document.createElement('img');
    logo.className = 'team-list-logo';
    logo.src = t.logo || '../assets/rl.png';

    const name = document.createElement('div');
    name.className = 'team-list-name';
    name.textContent = t.name;

    const meta = document.createElement('div');
    meta.style.fontSize = '10px';
    meta.style.color = 'var(--muted)';
    meta.style.marginLeft = '6px';
    meta.textContent = `${(t.players || []).length} players`;

    const actions = document.createElement('div');
    actions.className = 'team-list-actions';

    const applyBlue = document.createElement('button');
    applyBlue.className = 'btn btn-blue btn-sm';
    applyBlue.textContent = 'Blue';
    applyBlue.title = 'Apply to Blue team on Dashboard';
    applyBlue.addEventListener('click', () => {
      send('set_team', { side: 'blue', name: t.name, logo: t.logo || null, color: t.color || undefined });
      // Also push players if present
      if (t.players && t.players.length) {
        // crude: overwrite current blue players (client will reflect)
        currentState.teams = currentState.teams || {};
        currentState.teams.blue = currentState.teams.blue || {};
        currentState.teams.blue.players = JSON.parse(JSON.stringify(t.players));
      }
    });

    const applyOrange = document.createElement('button');
    applyOrange.className = 'btn btn-orange btn-sm';
    applyOrange.textContent = 'Orange';
    applyOrange.title = 'Apply to Orange team on Dashboard';
    applyOrange.addEventListener('click', () => {
      send('set_team', { side: 'orange', name: t.name, logo: t.logo || null, color: t.color || undefined });
      if (t.players && t.players.length) {
        currentState.teams = currentState.teams || {};
        currentState.teams.orange = currentState.teams.orange || {};
        currentState.teams.orange.players = JSON.parse(JSON.stringify(t.players));
      }
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save';
    saveBtn.title = 'Mark as Saved Team (kept week to week)';
    saveBtn.addEventListener('click', () => {
      send('save_startgg_team', { name: t.name });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove from this event’s teams';
    delBtn.addEventListener('click', () => {
      send('delete_startgg_team', { name: t.name });
    });

    actions.appendChild(applyBlue);
    actions.appendChild(applyOrange);
    actions.appendChild(saveBtn);
    actions.appendChild(delBtn);

    item.appendChild(logo);
    item.appendChild(name);
    item.appendChild(meta);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

el('btn-sort-teams-abc').addEventListener('click', () => {
  if (!currentState.savedTeams || currentState.savedTeams.length <= 1) return;
  const sorted = [...currentState.savedTeams].sort((a, b) => a.name.localeCompare(b.name));
  send('update_teams_order', { teams: sorted });
});

// Teams page sub-tabs: Match (live card + scorecard) vs All Teams (saved library + start.gg).
function teamsShowTab(tab) {
  document.querySelectorAll('#teams-subnav .ev-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.teamtab === tab));
  const match = el('teams-panel-match'), lib = el('teams-panel-library');
  if (match) match.style.display = tab === 'match' ? '' : 'none';
  if (lib) lib.style.display = tab === 'library' ? '' : 'none';
}
document.querySelectorAll('#teams-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', () => teamsShowTab(b.dataset.teamtab)));

function startEditTeam(t) {
  document.querySelector('[data-tab="equipos"]').click();
  if (typeof teamsShowTab === 'function') teamsShowTab('library');   // editor lives on All Teams
  teLoad({ oldName: t.name, name: t.name, logo: t.logo, color: t.color, players: t.players });
  el('te-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el('te-name')?.focus();
}

async function deleteTeam(name) {
  const ok = await customConfirm('Delete Team', `Are you sure you want to delete the team "${name}"?`, 'Delete');
  if (ok) {
    send('delete_team', { name });
  }
}

// ── Manage Team panel (Teams page) — edit name/logo/colour + roster inline ──
let tmModel = null;   // { oldName, name, logo, color, players:[{id,name,role}] }
const tmUid = () => 'p' + Math.random().toString(36).slice(2, 9);

function tmHydrate(savedTeams) {
  const sel = el('tm-team-select'); if (!sel) return;
  if (document.activeElement === sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select a team —</option>'
    + (savedTeams || []).map((t) => `<option value="${(t.name || '').replace(/"/g, '&quot;')}">${(t.name || '').replace(/</g, '&lt;')}</option>`).join('');
  if (prev && (savedTeams || []).some((t) => t.name === prev)) sel.value = prev;
  // If the team being edited changed on the server, refresh the editor (unless focused).
  if (tmModel && tmModel.oldName && !el('tm-editor').contains(document.activeElement)) {
    const fresh = (savedTeams || []).find((t) => t.name === tmModel.oldName);
    if (fresh) tmLoad(fresh);
  }
}
function tmShowEditor(show) {
  el('tm-editor').style.display = show ? '' : 'none';
  el('tm-empty').style.display = show ? 'none' : '';
}
function tmLoad(team) {
  tmModel = {
    oldName: team.name || '',
    name: team.name || '',
    logo: team.logo || null,
    color: team.color || '#055fdb',
    players: (team.players || []).map((p) => ({ id: p.id || tmUid(), name: p.name || '', role: p.role || '' }))
  };
  el('tm-name').value = tmModel.name;
  el('tm-color').value = /^#[0-9a-f]{6}$/i.test(tmModel.color) ? tmModel.color : '#055fdb';
  el('tm-logo-preview').src = tmModel.logo || '../assets/rl.png';
  tmRenderPlayers();
  tmShowEditor(true);
}
function tmRenderPlayers() {
  const wrap = el('tm-players'); if (!wrap || !tmModel) return;
  wrap.innerHTML = '';
  if (!tmModel.players.length) { wrap.innerHTML = '<div class="tp-empty">No players — add some.</div>'; return; }
  tmModel.players.forEach((p) => {
    const row = document.createElement('div'); row.className = 'tp-row';
    const nm = document.createElement('input'); nm.className = 'input-text tp-name'; nm.value = p.name; nm.placeholder = 'Player name';
    nm.addEventListener('input', () => { p.name = nm.value; });
    const role = document.createElement('input'); role.className = 'input-text tp-role'; role.value = p.role; role.placeholder = 'Role';
    role.addEventListener('input', () => { p.role = role.value; });
    const del = document.createElement('button'); del.className = 'tp-del'; del.textContent = '×'; del.title = 'Remove';
    del.addEventListener('click', () => { tmModel.players = tmModel.players.filter((x) => x !== p); tmRenderPlayers(); });
    row.appendChild(nm); row.appendChild(role); row.appendChild(del);
    wrap.appendChild(row);
  });
}
function tmStatus(msg, ok) { const s = el('tm-status'); if (s) { s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)'); } }

el('tm-team-select')?.addEventListener('change', function () {
  const name = this.value;
  if (!name) { tmShowEditor(false); tmModel = null; return; }
  const t = (currentState.savedTeams || []).find((x) => x.name === name);
  if (t) tmLoad(t);
});
el('tm-new')?.addEventListener('click', () => { el('tm-team-select').value = ''; tmLoad({ name: '', logo: null, color: '#055fdb', players: [] }); el('tm-name').focus(); });
el('tm-name')?.addEventListener('input', function () { if (tmModel) tmModel.name = this.value; });
el('tm-color')?.addEventListener('input', function () { if (tmModel) tmModel.color = this.value; });
el('tm-add-player')?.addEventListener('click', () => { if (tmModel) { tmModel.players.push({ id: tmUid(), name: '', role: '' }); tmRenderPlayers(); } });
el('tm-logo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f || !tmModel) return;
  tmModel.logo = await fileToBase64(f); el('tm-logo-preview').src = tmModel.logo;
});
el('tm-logo-lib')?.addEventListener('click', () => { if (typeof mpOpen === 'function') mpOpen((url) => { if (tmModel) { tmModel.logo = url; el('tm-logo-preview').src = url; } }); });
el('tm-save')?.addEventListener('click', () => {
  if (!tmModel) return;
  const name = (tmModel.name || '').trim();
  if (!name) { tmStatus('Team needs a name.', false); return; }
  send('save_team', {
    oldName: tmModel.oldName || null, name, logo: tmModel.logo || null, color: tmModel.color || null,
    players: tmModel.players.map((p) => ({ id: p.id, name: (p.name || '').trim(), role: (p.role || '').trim() })).filter((p) => p.name)
  });
  tmModel.oldName = name;
  el('tm-team-select').value = name;
  tmStatus('Saved.', true);
});
el('tm-delete')?.addEventListener('click', async () => {
  if (!tmModel || !tmModel.oldName) { tmShowEditor(false); tmModel = null; return; }
  const ok = await customConfirm('Delete Team', `Delete "${tmModel.oldName}"?`, 'Delete');
  if (ok) { send('delete_team', { name: tmModel.oldName }); tmShowEditor(false); tmModel = null; el('tm-team-select').value = ''; }
});

// Camera Feeds → Players: show the real team name + colour on each column header
// instead of the static "Blue Team" / "Orange Team".
function updateFacecamTeamHeaders(teams, data) {
  teams = teams || {};
  const g = (data && data.games && data.activeGame) ? data.games[data.activeGame] : null;
  const labels = (g && g.teamLabels) || { a: 'Blue', b: 'Orange' };
  [['blue', labels.a, '#055fdb'], ['orange', labels.b, '#e97139']].forEach(([side, label, fallbackColor]) => {
    const head = el('fc-team-head-' + side);
    if (!head) return;
    const t = teams[side] || {};
    head.textContent = (t.name && t.name.trim()) || label || (side === 'blue' ? 'Blue Team' : 'Orange Team');
    const color = t.color || fallbackColor;
    const fg = contrastText(color);
    // Use !important so the static .blue-header/.orange-header class can't win.
    head.style.setProperty('background', color, 'important');
    head.style.setProperty('color', fg, 'important');
    // Tint this column's Apply buttons to the team colour too (they're hardcoded btn-blue/btn-orange).
    const col = head.closest('.facecam-col');
    if (col) col.querySelectorAll('.facecam-row .btn').forEach((b) => {
      b.style.setProperty('background', color, 'important');
      b.style.setProperty('border-color', color, 'important');
      b.style.setProperty('color', fg, 'important');
    });
  });
}
// Pick black or white text for a given hex background.
function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * gg + 0.114 * b) / 255;
  return lum > 0.6 ? '#10121a' : '#ffffff';
}

function renderSavedFacecams(facecams) {
  const list = el('facecams-list');
  const emptyMsg = el('facecams-empty');
  if (!list || !emptyMsg) return;

  const items = list.querySelectorAll('.facecam-list-item');
  items.forEach(it => it.remove());

  emptyMsg.style.display = facecams.length === 0 ? '' : 'none';

  facecams.forEach(fc => {
    const item = document.createElement('div');
    item.className = 'facecam-list-item';

    // 1st Row: [Logo] NICKNAME [Delete]
    const row1 = document.createElement('div');
    row1.className = 'facecam-top-row';
    row1.style.marginBottom = '4px';

    const leftGroup = document.createElement('div');
    leftGroup.style.display = 'flex';
    leftGroup.style.alignItems = 'center';
    leftGroup.style.gap = '8px';
    leftGroup.style.flex = '1';
    leftGroup.style.minWidth = '0';

    const platImg = document.createElement('img');
    platImg.className = 'facecam-platform-logo';
    const isBot = !fc.platform || fc.platform === 'none' || fc.platform === 'bot';
    platImg.src = isBot ? '../assets/rl.png' : `../assets/platforms/${fc.platform}.png`;
    platImg.onerror = () => { platImg.src = '../assets/rl.png'; }; // fallback

    const nickInput = document.createElement('input');
    nickInput.type = 'text';
    nickInput.className = 'input-text';
    nickInput.style.flex = '1';
    nickInput.style.minWidth = '0';
    nickInput.style.fontSize = '12px';
    nickInput.style.height = '28px';
    nickInput.style.fontWeight = '700';
    nickInput.style.background = 'transparent';
    nickInput.style.border = 'none';
    nickInput.style.padding = '0';
    nickInput.value = fc.nickname || fc.name;
    nickInput.placeholder = 'NICKNAME...';

    leftGroup.appendChild(platImg);
    leftGroup.appendChild(nickInput);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.style.padding = '4px 8px';
    delBtn.style.flexShrink = '0';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.title = 'Delete facecam';
    delBtn.addEventListener('click', async () => {
      const ok = await customConfirm('Delete Facecam', `Delete saved configuration for "${fc.name}"?`, 'Delete');
      if (ok) send('delete_facecam', { name: fc.name });
    });

    row1.appendChild(leftGroup);
    row1.appendChild(delBtn);

    // 2nd Row: Name/ID info
    const row2 = document.createElement('div');
    row2.className = 'facecam-list-steam-id';
    row2.style.marginBottom = '8px';
    row2.style.opacity = '0.5';
    row2.textContent = (fc.platformId && fc.platformId !== fc.name) 
      ? `${fc.name} (${fc.platformId})` 
      : fc.name;

    // 3rd Row: URL [Save]
    const row3 = document.createElement('div');
    row3.className = 'facecam-middle-row';
    row3.style.gap = '6px';

    const urlInp = document.createElement('input');
    urlInp.type = 'text';
    urlInp.className = 'input-text';
    urlInp.style.flex = '1';
    urlInp.style.fontSize = '11px';
    urlInp.style.height = '32px';
    urlInp.value = fc.link || '';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-secondary btn-sm';
    saveBtn.textContent = 'Save';
    saveBtn.title = 'Save changes';
    saveBtn.addEventListener('click', () => {
      const newLink = urlInp.value.trim();
      const newNick = nickInput.value.trim();
      send('save_facecam', {
        name: fc.name,
        platform: fc.platform,
        platformId: fc.platformId,
        link: newLink,
        nickname: newNick
      });
    });

    row3.appendChild(urlInp);
    row3.appendChild(saveBtn);

    item.appendChild(row1);
    item.appendChild(row2);
    item.appendChild(row3);
    list.appendChild(item);
  });
}

// ── Event: Event name ─────────────────────────────────────────────────────
el('input-event').addEventListener('input', function() {
  send('set_event_name', { name: this.value });
});

// ── Overtime ad slot (sellable sponsor slot) ──────────────────────────────
el('input-ot-label').addEventListener('input', function() {
  send('set_overtime', { label: this.value });
});
el('input-ot-bg').addEventListener('input', function() {
  send('set_overtime', { bg: this.value });
});
el('input-ot-color').addEventListener('input', function() {
  send('set_overtime', { color: this.value });
});
el('input-ot-logo').addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_overtime', { logo: b64 });
});
el('btn-ot-logo-clear').addEventListener('click', function() {
  const f = el('input-ot-logo'); if (f) f.value = '';
  send('set_overtime', { logo: null });
});

// ── Ad-slot sponsor pickers — pull logos from the ACTIVE BRAND's sponsor set ──
// Single source of truth: sponsor logos are uploaded per client in the Brands tab;
// each Dashboard ad slot just *picks which* brand sponsor fills it (or "Upload custom").
const AD_PICKERS = [
  { pick: 'pick-ot-logo',     custom: 'custom-ot-logo',     slot: 'overtime',     field: 'logo',      msg: 'set_overtime' },
  { pick: 'pick-replay-logo', custom: 'custom-replay-logo', slot: 'replay',       field: 'logo',      msg: 'set_replay' },
  { pick: 'pick-replay-outro',custom: 'custom-replay-outro',slot: 'replay',       field: 'outroLogo', msg: 'set_replay' },
  { pick: 'pick-sbad-logo',   custom: 'custom-sbad-logo',   slot: 'scoreboardAd', field: 'logo',      msg: 'set_scoreboard_ad' },
];
function brandSponsorsWithLogos(data) {
  const list = (data && data.brand && Array.isArray(data.brand.sponsors)) ? data.brand.sponsors : [];
  return list.filter((s) => s && s.logo);
}
function renderAdSponsorPickers(data) {
  const sponsors = brandSponsorsWithLogos(data);
  const optSig = JSON.stringify(sponsors.map((s) => [s.id, s.name]));
  AD_PICKERS.forEach((p) => {
    const sel = el(p.pick); if (!sel) return;
    if (sel.dataset.sig !== optSig) {
      sel.dataset.sig = optSig;
      sel.innerHTML = '';
      const add = (val, text) => { const o = document.createElement('option'); o.value = val; o.textContent = text; sel.appendChild(o); };
      add('', sponsors.length ? '— None —' : '— No sponsors on this brand —');
      sponsors.forEach((s) => add('id:' + s.id, s.name || 'Sponsor'));
      add('__custom', 'Upload custom…');
    }
    // Reflect the slot's current logo: match a brand sponsor, else it's a custom upload.
    const slotObj = (data && data[p.slot]) || {};
    const cur = slotObj[p.field] || '';
    let val = '';
    if (cur) { const m = sponsors.find((s) => s.logo === cur); val = m ? 'id:' + m.id : '__custom'; }
    if (document.activeElement !== sel) sel.value = val;
    const box = el(p.custom); if (box) box.style.display = (sel.value === '__custom') ? 'block' : 'none';
  });
}
AD_PICKERS.forEach((p) => {
  const sel = el(p.pick); if (!sel) return;
  sel.addEventListener('change', function () {
    const box = el(p.custom);
    if (this.value === '__custom') { if (box) box.style.display = 'block'; return; }
    if (box) box.style.display = 'none';
    if (!this.value) { send(p.msg, { [p.field]: null }); return; }
    const id = this.value.slice(3); // strip "id:"
    const sp = brandSponsorsWithLogos(currentState).find((s) => s.id === id);
    send(p.msg, { [p.field]: sp ? sp.logo : null });
  });
});

// ── Replay ad slot (sponsor logo in the replay transition + tag) ──────────
el('input-replay-label').addEventListener('input', function() {
  send('set_replay', { label: this.value });
});
el('select-replay-color').addEventListener('change', function() {
  send('set_replay', { colorMode: this.value });
});
el('input-replay-logo').addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_replay', { logo: b64 });
});
el('btn-replay-logo-clear').addEventListener('click', function() {
  const f = el('input-replay-logo'); if (f) f.value = '';
  send('set_replay', { logo: null });
});
el('input-replay-outro').addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_replay', { outroLogo: b64 });
});
el('btn-replay-outro-clear').addEventListener('click', function() {
  const f = el('input-replay-outro'); if (f) f.value = '';
  send('set_replay', { outroLogo: null });
});

// ── Scoreboard ad slot (sponsor logo on the end-of-match scorecard) ───────
el('input-sbad-label').addEventListener('input', function() {
  send('set_scoreboard_ad', { label: this.value });
});
el('input-sbad-logo').addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_scoreboard_ad', { logo: b64 });
});
el('btn-sbad-logo-clear').addEventListener('click', function() {
  const f = el('input-sbad-logo'); if (f) f.value = '';
  send('set_scoreboard_ad', { logo: null });
});
el('input-sbad-bg').addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_scoreboard_ad', { background: b64 });
});
el('btn-sbad-bg-clear').addEventListener('click', function() {
  const f = el('input-sbad-bg'); if (f) f.value = '';
  send('set_scoreboard_ad', { background: null });
});

// ── Event: Team logo file inputs ──────────────────────────────────────────
async function handleLogoInput(side, file) {
  if (!file) return;
  const b64 = await fileToBase64(file);
  if (side === 'blue') {
    pendingLogoBlue = b64;
    el('preview-logo-blue').src = b64;
  } else {
    pendingLogoOrange = b64;
    el('preview-logo-orange').src = b64;
  }
}

el('input-logo-blue').addEventListener('change', e => handleLogoInput('blue', e.target.files[0]));
el('input-logo-orange').addEventListener('change', e => handleLogoInput('orange', e.target.files[0]));

// ── Event: Saved team dropdowns (legacy <select> removed; guard if absent) ──
['blue', 'orange'].forEach(side => {
  el(`select-saved-${side}`)?.addEventListener('change', function() {
    const name = this.value;
    if (!name) {
      // Reset to manual/default
      if (side === 'blue') { pendingLogoBlue = null; setSideLogo('blue', null); }
      else { pendingLogoOrange = null; setSideLogo('orange', null); }
      return;
    }
    const t = findTeam(name);
    if (!t) return;
    el(`input-name-${side}`).value = t.name;
    if (side === 'blue') { pendingLogoBlue = t.logo; setSideLogo('blue', t.logo); }
    else { pendingLogoOrange = t.logo; setSideLogo('orange', t.logo); }
    updateTeamSavedBadge(side);
    // Auto-apply (carries the roster for facecams when the team has one)
    applyTeam(side);
  });
});

function applyTeam(side) {
  const name = el(`input-name-${side}`).value.trim().toUpperCase();
  if (!name) return;
  const t = findTeam(name);
  const logo = (side === 'blue' ? pendingLogoBlue : pendingLogoOrange) || (t && t.logo) || null;
  const payload = { side, name, logo };
  if (t && Array.isArray(t.players) && t.players.length) payload.players = t.players;
  if (t && t.color) payload.color = t.color;   // carry the saved team's own colour → Team colour-mode
  send('set_team', payload);
}

el('btn-apply-blue').addEventListener('click', () => applyTeam('blue'));
el('btn-apply-orange').addEventListener('click', () => applyTeam('orange'));

['blue', 'orange'].forEach(side => {
  const c = el(`input-color-${side}`);
  if (c) c.addEventListener('input', function() { send('set_team_color', { side, color: this.value }); });
});

['blue', 'orange'].forEach(side => {
  el(`input-name-${side}`).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTeam(side);
  });
  // Typeahead: update the saved badge and, when the typed name matches a saved team,
  // auto-load that team's logo so picking from the autocomplete fills the card.
  el(`input-name-${side}`).addEventListener('input', function () {
    updateTeamSavedBadge(side);
    const t = findTeam(this.value);
    if (t) {
      if (side === 'blue') { pendingLogoBlue = t.logo; setSideLogo('blue', t.logo); }
      else { pendingLogoOrange = t.logo; setSideLogo('orange', t.logo); }
      // Exact match (e.g. picked from the autocomplete) → apply now so its roster
      // auto-populates the Players section + facecams without needing to click Apply.
      applyTeam(side);
    }
  });
});

// Custom team-name autocomplete: shows each team's logo + ALL-CAPS name (a native <datalist>
// can render neither). Picking an item fills the input and dispatches 'input' so the existing
// exact-match handler applies the team (logo, roster, colour) just as before.
function setupTeamTypeahead(side) {
  const input = el(`input-name-${side}`);
  const dd = el(`team-dd-${side}`);
  if (!input || !dd) return;
  let items = [];
  let active = -1;
  let open = false;

  const filtered = (q) => {
    q = (q || '').trim().toLowerCase();
    const list = allMatchTeams();
    return (q ? list.filter((t) => (t.name || '').toLowerCase().includes(q)) : list).slice(0, 60);
  };
  const close = () => { dd.classList.remove('show'); open = false; active = -1; };
  const position = () => {
    const r = input.getBoundingClientRect();
    dd.style.left = r.left + 'px';
    dd.style.width = r.width + 'px';
    // Open downward, but flip above the input if there isn't room below.
    const below = window.innerHeight - r.bottom;
    if (below < 200 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
  };
  const render = () => {
    if (!items.length) { close(); return; }
    dd.innerHTML = items.map((t, i) => {
      const logo = t.logo || gameLogo();
      const nm = (t.name || '').toUpperCase().replace(/</g, '&lt;');
      const tag = t.source === 'event' ? '<span class="team-dd-tag">EVENT</span>' : '';
      return `<div class="team-dd-item${i === active ? ' active' : ''}" data-i="${i}" role="option">
        <img class="team-dd-logo${t.logo ? '' : ' game-logo-white'}" src="${logo}" alt="" onerror="this.style.visibility='hidden'">
        <span class="team-dd-name">${nm}</span>${tag}</div>`;
    }).join('');
    position();
    dd.classList.add('show');
    open = true;
    const act = dd.querySelector('.team-dd-item.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  };
  const refresh = () => { items = filtered(input.value); active = -1; render(); };

  input.addEventListener('focus', refresh);
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (!open && e.key === 'ArrowDown') { refresh(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); input.value = (items[active].name || '').toUpperCase(); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); input.value = (items[active].name || '').toUpperCase(); render(); }
    else if (e.key === 'Enter') { close(); }            // value already set; existing Enter handler applies it
    else if (e.key === 'Escape') { close(); }
  });
  // mousedown (not click) so selection wins the race against the input's blur.
  dd.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.team-dd-item'); if (!it) return;
    e.preventDefault();
    const t = items[Number(it.dataset.i)]; if (!t) return;
    input.value = (t.name || '').toUpperCase();
    input.dispatchEvent(new Event('input'));            // → exact-match → applyTeam
    close();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  // The dropdown is position:fixed, so close it if the page scrolls/resizes under it.
  window.addEventListener('scroll', () => { if (open) close(); }, true);
  window.addEventListener('resize', () => { if (open) close(); });
}
['blue', 'orange'].forEach(setupTeamTypeahead);

// Auto-fill both teams from the team currently live on the start.gg stream queue (+ rosters → facecams).
el('btn-autofill-stream')?.addEventListener('click', () => {
  const st = el('autofill-stream-status');
  const q = (currentState.startgg && currentState.startgg.queue) || [];
  if (!q.length) {
    if (st) { st.textContent = 'No stream queue loaded — turn on the start.gg queue (Dashboard / Settings) first.'; st.className = 'ev-status ev-err'; }
    return;
  }
  if (st) { st.textContent = 'Pulling the live match from start.gg…'; st.className = 'ev-status'; }
  _autofillPending = true;
  send('autofill_stream_teams');
});

// ── Event: Quick save team buttons ────────────────────────────────────────
// Save the team's OWN colour (not the effective brand/game colour shown while those modes are on).
function teamOwnColor(side) {
  const t = currentState && currentState.teams && currentState.teams[side];
  return (t && (t.ownColor || t.color)) || el('input-color-' + side)?.value || null;
}
el('btn-quick-save-blue').addEventListener('click', () => {
  const name = el('input-name-blue').value.trim().toUpperCase();
  if (!name) { alert('Enter team name.'); return; }
  send('save_team', { name, logo: pendingLogoBlue || null, color: teamOwnColor('blue') });
});

el('btn-quick-save-orange').addEventListener('click', () => {
  const name = el('input-name-orange').value.trim().toUpperCase();
  if (!name) { alert('Enter team name.'); return; }
  send('save_team', { name, logo: pendingLogoOrange || null, color: teamOwnColor('orange') });
});

// ── Scorecard (reusable: rendered below Match-Teams on Dashboard + on Teams tab)
function scorecardHTML(sfx) {
  const bo = [1, 3, 5, 7].map((v) => `<label class="bo-opt"><input type="radio" name="bestof-${sfx}" value="${v}">${v}</label>`).join('');
  return `<div class="scorecard">
    <div class="sc-side">
      <span class="series-label" id="series-label-blue-${sfx}">BLUE</span>
      <div class="series-counter">
        <button class="btn-counter" data-sc="series" data-side="blue" data-delta="-1">−</button>
        <span class="series-value" id="val-series-blue-${sfx}">0</span>
        <button class="btn-counter" data-sc="series" data-side="blue" data-delta="1">+</button>
      </div>
    </div>
    <div class="sc-mid">
      <span class="series-label">BEST OF</span>
      <div class="best-of-options">${bo}</div>
      <div class="sc-game">
        <span class="series-label">CURRENT GAME</span>
        <div class="series-counter">
          <button class="btn-counter" data-sc="game" data-delta="-1">−</button>
          <span class="series-value" id="val-game-number-${sfx}">1</span>
          <button class="btn-counter" data-sc="game" data-delta="1">+</button>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" data-sc="reset">Reset series</button>
    </div>
    <div class="sc-side">
      <span class="series-label" id="series-label-orange-${sfx}">ORANGE</span>
      <div class="series-counter">
        <button class="btn-counter" data-sc="series" data-side="orange" data-delta="-1">−</button>
        <span class="series-value" id="val-series-orange-${sfx}">0</span>
        <button class="btn-counter" data-sc="series" data-side="orange" data-delta="1">+</button>
      </div>
    </div>
  </div>
  <p class="sc-note">Adding a series win auto-advances the current game — no need to bump both.</p>`;
}
function wireScorecard(containerId, sfx) {
  const c = el(containerId); if (!c) return;
  c.innerHTML = scorecardHTML(sfx);
  c.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sc]'); if (!b) return;
    const kind = b.dataset.sc;
    if (kind === 'series') send('adjust_series', { side: b.dataset.side, delta: parseInt(b.dataset.delta, 10) });
    else if (kind === 'game') send('adjust_game_number', { delta: parseInt(b.dataset.delta, 10) });
    else if (kind === 'reset') send('reset_series');
  });
  c.addEventListener('change', (e) => {
    if (e.target.name === `bestof-${sfx}` && e.target.checked) send('set_best_of', { value: parseInt(e.target.value, 10) });
  });
}
wireScorecard('scorecard-dash', 'dash');
wireScorecard('scorecard-teams', 'teams');

function syncSeriesDeskUI(data) {
  const g = (data.games && data.games[data.activeGame]) || null;
  const labels = (g && g.teamLabels) || { a: 'Blue', b: 'Orange' };
  const teams = data.teams || {};
  const blueColor = (teams.blue && teams.blue.color) || '#055fdb';
  const orangeColor = (teams.orange && teams.orange.color) || '#e97139';
  const bo = data.bestOf || 5;
  ['dash', 'teams'].forEach((sfx) => {
    const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };
    set(`val-series-blue-${sfx}`, data.series?.blue ?? 0);
    set(`val-series-orange-${sfx}`, data.series?.orange ?? 0);
    set(`val-game-number-${sfx}`, data.game?.number ?? 1);
    const lb = el(`series-label-blue-${sfx}`); if (lb) { lb.textContent = (labels.a || 'A').toUpperCase(); lb.style.color = blueColor; }
    const lo = el(`series-label-orange-${sfx}`); if (lo) { lo.textContent = (labels.b || 'B').toUpperCase(); lo.style.color = orangeColor; }
    document.querySelectorAll(`input[name="bestof-${sfx}"]`).forEach((r) => { if (document.activeElement !== r) r.checked = parseInt(r.value, 10) === bo; });
  });
}

// ── Event: Pull Team Names from RL API (legacy API buttons removed; guard) ──
el('btn-pull-name-blue')?.addEventListener('click', () => {
  const name = currentState.gameTeams?.blue;
  if (name) {
    el('input-name-blue').value = name.toUpperCase();
    // Trigger input event to sync with server if needed
    el('input-name-blue').dispatchEvent(new Event('input'));
  }
});

el('btn-pull-name-orange')?.addEventListener('click', () => {
  const name = currentState.gameTeams?.orange;
  if (name) {
    el('input-name-orange').value = name.toUpperCase();
    // Trigger input event to sync with server if needed
    el('input-name-orange').dispatchEvent(new Event('input'));
  }
});

// ── Caster Desk: Best-of ──────────────────────────────────────────────────
document.querySelectorAll('input[name="bestof-desk"]').forEach(r => {
  r.addEventListener('change', function() {
    if (this.checked) send('set_best_of', { value: parseInt(this.value, 10) });
  });
});

// ── Event: View controls ──────────────────────────────────────────────────
el('btn-force-scoreboard')?.addEventListener('click', () => send('force_scoreboard'));
el('btn-force-hud')?.addEventListener('click',        () => send('force_hud'));

el('btn-swap-teams').addEventListener('click', () => {
  // Optimistic swap of the visible top-level fields → instant feedback (server confirms).
  const swapVal = (a, b) => { const ea = el(a), eb = el(b); if (ea && eb) { const t = ea.value; ea.value = eb.value; eb.value = t; } };
  swapVal('input-name-blue', 'input-name-orange');
  swapVal('input-color-blue', 'input-color-orange');
  const lb = el('preview-logo-blue'), lo = el('preview-logo-orange');
  if (lb && lo) { const t = lb.src; lb.src = lo.src; lo.src = t; }
  const pl = pendingLogoBlue; pendingLogoBlue = pendingLogoOrange; pendingLogoOrange = pl;
  send('swap_teams');
});

el('btn-reset-all').addEventListener('click', async () => {
  const ok = await customConfirm('Reset Data', 'Are you sure you want to reset ALL match data? This cannot be undone.', 'Reset All');
  if (ok) {
    send('reset_all');
  }
});

el('btn-default-logo-blue').addEventListener('click', () => {
  pendingLogoBlue = null;
  setSideLogo('blue', null);
});

el('btn-default-logo-orange').addEventListener('click', () => {
  pendingLogoOrange = null;
  setSideLogo('orange', null);
});

// ── Colour mode: Team / Brand / Game (mutually exclusive) ──
// The server owns the mode (`state.colorMode`) and computes the effective side colours,
// NON-DESTRUCTIVELY — each source keeps its own colours:
//   team  → each team's own colour (edited in the pickers / saved-team library)
//   brand → the active brand kit's colours (edited in Brand settings)
//   game  → the active game's default side colours (per-game, automatic)
// Switching modes never overwrites the others, so toggling is fully reversible.
function colorModeNow() {
  return (currentState && currentState.colorMode) || 'team';
}
function renderColorMode() {
  const mode = colorModeNow();
  document.querySelectorAll('#color-mode-seg .cms-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const lock = mode !== 'team';
  var teams = (currentState && currentState.teams) || {};
  [['blue', 'input-color-blue', 'eff-swatch-blue'], ['orange', 'input-color-orange', 'eff-swatch-orange']].forEach(function(row) {
    var side = row[0], inputId = row[1], swatchId = row[2];
    var c = el(inputId), sw = el(swatchId);
    if (c) {
      c.disabled = lock; c.style.opacity = lock ? '0.45' : '1';
      c.title = mode === 'brand' ? 'Team colour (overlay using brand colour — see swatch →)'
              : mode === 'default' ? 'Team colour (overlay using game defaults — see swatch →)' : '';
    }
    if (sw) {
      var effColor = teams[side] && teams[side].color;
      if (lock && effColor) {
        sw.style.display = '';
        sw.style.background = effColor;
        sw.title = 'Overlay is using: ' + effColor + ' (' + mode + ' mode)';
      } else {
        sw.style.display = 'none';
      }
    }
  });
}
function setColorMode(mode) {
  if (mode !== 'team' && mode !== 'brand' && mode !== 'default') return;
  send('set_color_mode', { mode });
  if (currentState) currentState.colorMode = mode;   // optimistic so the segment reflects instantly
  renderColorMode();
}
document.querySelectorAll('#color-mode-seg .cms-btn').forEach((b) => b.addEventListener('click', () => setColorMode(b.dataset.mode)));

// ── Match — Teams: show/hide players + game-default colours ──
// Per-team Hide/Show players (the button next to "+ Add"). The top "Players"
// toggle is just a MASTER that flips both teams at once. Both hide the player
// LIST only, keeping each card's "PLAYERS" bar (and its Hide button) in place.
function applyTeamPlayersHidden(side, hidden) {
  const wrap = el('team-players-' + side); if (wrap) wrap.style.display = hidden ? 'none' : '';
  const btn = document.querySelector(`.tp-hide-btn[data-side="${side}"]`); if (btn) btn.textContent = hidden ? 'Show' : 'Hide';
  try { localStorage.setItem('ne_hide_players_' + side, hidden ? '1' : '0'); } catch {}
  syncMasterPlayersToggle();
}
function syncMasterPlayersToggle() {
  const cb = el('check-show-players'); if (!cb) return;
  cb.checked = ['blue', 'orange'].some((s) => { const w = el('team-players-' + s); return w && w.style.display !== 'none'; });
}
['blue', 'orange'].forEach((side) => { try { applyTeamPlayersHidden(side, localStorage.getItem('ne_hide_players_' + side) === '1'); } catch {} });
document.querySelectorAll('.tp-hide-btn').forEach((btn) => btn.addEventListener('click', () => {
  const side = btn.dataset.side;
  applyTeamPlayersHidden(side, el('team-players-' + side)?.style.display !== 'none');
}));
// Top toggle = master for both teams.
el('check-show-players')?.addEventListener('change', function () {
  const show = this.checked;
  ['blue', 'orange'].forEach((side) => applyTeamPlayersHidden(side, !show));
});

// Minimize / expand the whole Match — Teams card (so the Scorecard/Series sit higher).
function applyMtCollapsed(on) {
  const sec = el('match-teams-section'); if (sec) sec.classList.toggle('mt-collapsed', !!on);
}
try { applyMtCollapsed(localStorage.getItem('ne_mt_collapsed') === '1'); } catch {}
el('btn-mt-collapse')?.addEventListener('click', () => {
  const sec = el('match-teams-section'); if (!sec) return;
  const on = !sec.classList.contains('mt-collapsed');
  try { localStorage.setItem('ne_mt_collapsed', on ? '1' : '0'); } catch {}
  applyMtCollapsed(on);
});

// Player Hero · Role · Country · Info fields are always shown now (no toggle). Clear any
// stale "roles-hidden" state a previous build may have left applied.
(function () {
  const sec = el('match-teams-section'); if (sec) sec.classList.remove('roles-hidden');
  try { localStorage.removeItem('ne_show_roles'); } catch {}
})();

// (Per-game default colours now live server-side; the client only sends the active mode.)

// ── Add team logo ─────────────────────────────────────────────────────────
// ── Team editor (create / edit a saved team: logo, name, colour, roster) ──────
// The colour is saved on the team and applied to the live match (and thus the overlays)
// whenever the team is loaded — see set_team / save_team `color`.
let teModel = { oldName: null, name: '', logo: null, color: '#055fdb', players: [] };
const teUid = () => 'p' + Math.random().toString(36).slice(2, 9);
function teStatus(msg, ok) { const s = el('te-status'); if (s) { s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)'); } }
function teRenderPlayers() {
  const wrap = el('te-players-list'); if (!wrap) return;
  wrap.innerHTML = '';
  if (!teModel.players.length) { wrap.innerHTML = '<div class="tp-empty">No players yet — add your roster.</div>'; return; }
  teModel.players.forEach((p) => {
    const row = document.createElement('div'); row.className = 'te-player-row';
    const name = document.createElement('input'); name.className = 'input-text te-pname'; name.placeholder = 'Player name'; name.value = p.name || '';
    name.addEventListener('input', () => { p.name = name.value; });
    const role = buildRoleControl(p.role || '', rolesForActiveGame(), (val) => { p.role = val; });
    const country = buildCountryControl(p.country || '', (code) => { p.country = code; });
    const del = document.createElement('button'); del.className = 'btn btn-ghost btn-sm te-del'; del.textContent = '✕'; del.title = 'Remove player';
    del.addEventListener('click', () => { teModel.players = teModel.players.filter((x) => x !== p); teRenderPlayers(); });
    row.append(name, role, country, del);
    wrap.appendChild(row);
  });
}
function teRender() {
  if (el('te-name')) el('te-name').value = teModel.name || '';
  if (el('te-color')) el('te-color').value = /^#[0-9a-f]{6}$/i.test(teModel.color) ? teModel.color : '#055fdb';
  if (el('te-logo-preview')) {
    const teImg = el('te-logo-preview');
    teImg.src = teModel.logo || (typeof gameLogo === 'function' ? gameLogo() : '../assets/rl.png');
    teImg.classList.toggle('game-logo-white', !teModel.logo);   // game fallback → white
  }
  if (el('te-title')) el('te-title').textContent = teModel.oldName ? 'Edit Team' : 'Create Team';
  if (el('te-save')) el('te-save').textContent = teModel.oldName ? 'Update Team' : 'Save Team';
  teRenderPlayers();
}
function teLoad(team) {
  team = team || {};
  teModel = {
    oldName: team.oldName || null,
    name: team.name || '',
    logo: team.logo || null,
    color: team.color || '#055fdb',
    players: (team.players || []).map((p) => ({ id: p.id || teUid(), name: p.name || '', role: p.role || '', country: p.country || '' }))
  };
  teStatus('');
  teRender();
}
el('te-name')?.addEventListener('input', function () { teModel.name = this.value; });
el('te-color')?.addEventListener('input', function () { teModel.color = this.value; });
el('te-add-player')?.addEventListener('click', () => {
  teModel.players.push({ id: teUid(), name: '', role: '', country: '' });
  teRenderPlayers();
  const rows = el('te-players-list')?.querySelectorAll('.te-player-row .te-pname');
  if (rows && rows.length) rows[rows.length - 1].focus();
});
el('te-logo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f) return;
  teModel.logo = await fileToBase64(f);
  if (el('te-logo-preview')) el('te-logo-preview').src = teModel.logo;
});
el('te-logo-lib')?.addEventListener('click', () => {
  if (typeof mpOpen === 'function') mpOpen((url) => { teModel.logo = url; if (el('te-logo-preview')) el('te-logo-preview').src = url; });
});
el('te-new')?.addEventListener('click', () => { teLoad({}); el('te-name')?.focus(); });
el('te-clear')?.addEventListener('click', () => teLoad({}));
el('te-save')?.addEventListener('click', () => {
  const name = (teModel.name || '').trim();
  if (!name) { teStatus('Enter a team name.', false); return; }
  send('save_team', {
    oldName: teModel.oldName || null,
    name,
    logo: teModel.logo || null,
    color: teModel.color || null,
    players: teModel.players.map((p) => ({ id: p.id, name: (p.name || '').trim(), role: (p.role || '').trim(), country: (p.country || '').toLowerCase() })).filter((p) => p.name)
  });
  teModel.oldName = name;   // now editing the saved record
  if (el('te-title')) el('te-title').textContent = 'Edit Team';
  if (el('te-save')) el('te-save').textContent = 'Update Team';
  teStatus('Saved.', true);
});
teRenderPlayers();   // initial empty state

// ── Player Management ──────────────────────────────────────────────────────
let editingPlayerId = null;
let editingPlayerSide = null;

function openPlayerModal(side, playerId = null) {
  const modal = el('player-modal-overlay');
  const player = playerId ? currentState.teams?.[side]?.players?.find(p => p.id === playerId) : null;

  editingPlayerSide = side;
  editingPlayerId = playerId;

  el('player-name').value = player?.name || '';
  el('player-platform').value = player?.platform || 'steam';
  el('player-platform-id').value = player?.platformId || '';
  el('player-camera').value = player?.assignedCamera || '';
  el('player-create-camera').checked = false;
  el('player-new-camera-form').style.display = 'none';

  syncPlayerCameraDropdown();
  modal.classList.add('show');
}

function closePlayerModal() {
  const modal = el('player-modal-overlay');
  modal.classList.remove('show');
  editingPlayerId = null;
  editingPlayerSide = null;
}

function syncPlayerCameraDropdown() {
  const select = el('player-camera');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '<option value="">-- No Camera --</option>';
  (currentState.facecams || currentState.savedFacecams || []).forEach(fc => {
    const opt = document.createElement('option');
    opt.value = fc.name;
    opt.textContent = `${fc.nickname || fc.name}`;
    select.appendChild(opt);
  });
  select.value = currentValue;
}

function savePlayer() {
  if (!editingPlayerSide) return;
  const name = el('player-name').value?.trim();
  if (!name) {
    alert('Player name is required');
    return;
  }

  const playerData = {
    name,
    platform: el('player-platform').value,
    platformId: el('player-platform-id').value?.trim() || '',
    assignedCamera: el('player-camera').value || null
  };

  const createCamera = el('player-create-camera').checked;
  if (createCamera) {
    const cameraUrl = el('player-camera-url').value?.trim();
    const cameraPlatform = el('player-camera-platform').value;
    if (!cameraUrl) {
      alert('Camera URL is required');
      return;
    }
    const cameraName = `${editingPlayerSide}-${name}-camera`;
    send('save_facecam', {
      name: cameraName,
      platform: cameraPlatform,
      platformId: name,
      link: cameraUrl,
      nickname: `${name}'s Camera`
    });
    playerData.assignedCamera = cameraName;
  }

  if (editingPlayerId) {
    send('edit_player', { side: editingPlayerSide, playerId: editingPlayerId, playerData });
  } else {
    send('add_player', { side: editingPlayerSide, player: playerData });
  }

  closePlayerModal();
}

function deletePlayer(side, playerId) {
  if (confirm('Delete this player?')) {
    send('delete_player', { side, playerId });
  }
}

function renderTeamPlayers(side, players = []) {
  const teamItem = document.querySelector(`.team-list-item[data-name="${currentState.teams?.[side]?.name}"]`);
  if (!teamItem) return;

  let playersList = teamItem.querySelector('.players-list');
  if (!playersList) {
    playersList = document.createElement('div');
    playersList.className = 'players-list';
    teamItem.appendChild(playersList);
  }

  playersList.innerHTML = `
    <div class="players-list-header">
      <h4>Players (${players.length})</h4>
      <button class="btn btn-sm btn-primary" data-side="${side}">+ Add</button>
    </div>
    <div class="players-container"></div>
  `;

  const container = playersList.querySelector('.players-container');
  const addBtn = playersList.querySelector('button');
  addBtn.addEventListener('click', () => openPlayerModal(side));

  players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'player-card';
    const deviceSvg = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
    const camSvg = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
    const cameraFacecam = (currentState.facecams || currentState.savedFacecams)?.find(fc => fc.name === p.assignedCamera);

    card.innerHTML = `
      <div class="player-info">
        <span class="player-platform-icon">${deviceSvg}</span>
        <span class="player-name">${p.name}</span>
        ${cameraFacecam ? `<span class="player-camera-badge">${camSvg} ${cameraFacecam.nickname || cameraFacecam.name}</span>` : ''}
      </div>
      <div class="player-actions">
        <button class="btn btn-secondary btn-sm" data-action="edit">Edit</button>
        <button class="btn btn-danger btn-sm" data-action="delete"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
    `;

    const editBtn = card.querySelector('[data-action="edit"]');
    const delBtn = card.querySelector('[data-action="delete"]');
    editBtn.addEventListener('click', () => openPlayerModal(side, p.id));
    delBtn.addEventListener('click', () => deletePlayer(side, p.id));

    container.appendChild(card);
  });
}

// ── Font settings ─────────────────────────────────────────────────────────
async function loadSystemFonts() {
  const select = el('select-font');
  if (!select) return;

  try {
    const availableFonts = await window.queryLocalFonts();
    const fonts = [...new Set(availableFonts.map(f => f.family))].sort();
    
    // Clear and populate
    select.innerHTML = '';
    fonts.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      select.appendChild(opt);
    });
    
    // Check if Bourgeois exists, we add it explicitly if needed (handled below or just selected)
    if (currentState.fontFamily) {
      // If it doesn't exist in the list, add it
      let exists = fonts.includes(currentState.fontFamily);
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = currentState.fontFamily;
        opt.textContent = currentState.fontFamily;
        select.prepend(opt);
      }
      select.value = currentState.fontFamily;
    }
  } catch (err) {
    console.warn('System fonts API not available or permission denied.', err);
    // Add default fallback options if API fails
    if (select.options.length <= 1) {
      select.innerHTML = '<option value="Bourgeois">Bourgeois</option><option value="Arial">Arial</option><option value="Impact">Impact</option><option value="Verdana">Verdana</option>';
      if (currentState.fontFamily) select.value = currentState.fontFamily;
    }
  }
}

el('tab-ajustes').addEventListener('click', async () => {
  await loadSystemFonts();
});

el('select-font').addEventListener('change', function() {
  send('set_font_family', { fontFamily: this.value });
});

el('cf-facecams-enabled')?.addEventListener('change', function () {
  send('set_facecams_enabled', { enabled: this.checked });
});
el('check-facecams-enabled').addEventListener('change', function() {
  send('set_facecams_enabled', { enabled: this.checked });
});
const _cbReplayCams = el('check-replay-cams');
if (_cbReplayCams) _cbReplayCams.addEventListener('change', function() {
  send('set_replay_cams', { enabled: this.checked });
});

// ── Banner Settings ───────────────────────────────────────────────────────
el('check-banner-visible').addEventListener('change', function() {
  send('set_banner_visibility', { visible: this.checked });
});

el('input-banner-interval').addEventListener('change', function() {
  send('set_banner_interval', { interval: parseInt(this.value) || 10 });
});

el('select-banner-slant')?.addEventListener('change', function() {
  send('set_banner_slant', { slant: this.value });
});

el('input-banner-header')?.addEventListener('change', function() {
  send('set_banner_header', { header: this.value });
});

el('input-banner-image').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('add_banner_image', { image: b64 });
  // clear input so we can select same file again if needed
  e.target.value = '';
});

// ── Import and Export Data ───────────────────────────────────────────────────────
el('btn-export-data').addEventListener('click', () => {
  send('export_data');
});

el('btn-import-data').addEventListener('change', () => {
  const file = el('btn-import-data').files[0];
  if (!file) return;
  const filePath = file.path;
  send('import_data', { path: filePath });
  el('btn-import-data').value = '';
});


// ── Start.gg settings ─────────────────────────────────────────────────────
el('btn-startgg-change-token')?.addEventListener('click', () => {
  const confirmed = confirm(
    'A start.gg API token is already saved.\n\n' +
    'Do you want to replace it? You will need to paste the full token again.\n\n' +
    'You can find or generate tokens at: start.gg → your profile → Developer Settings → API Tokens.'
  );
  if (!confirmed) return;
  const tokenEl = el('input-startgg-token');
  const tokenChangeBtn = el('btn-startgg-change-token');
  const tokenIndicator = el('startgg-token-indicator');
  tokenEl.readOnly = false;
  tokenEl.value = '';
  tokenEl.placeholder = 'Paste your new start.gg API token';
  tokenEl.style.opacity = '';
  tokenEl.style.cursor = '';
  if (tokenChangeBtn) tokenChangeBtn.style.display = 'none';
  if (tokenIndicator) tokenIndicator.style.display = 'none';
  tokenEl.focus();
});

el('btn-startgg-save').addEventListener('click', () => {
  send('set_startgg_settings', getStartggPayload());
});

el('btn-startgg-test').addEventListener('click', () => {
  send('set_startgg_settings', getStartggPayload());
  send('startgg_test_connection');
});

el('btn-startgg-sync').addEventListener('click', () => {
  send('set_startgg_settings', getStartggPayload());
  send('startgg_sync_set', { setId: el('input-startgg-setid')?.value.trim() || '' });
});

// ── Facecams: mode selector & grid logic ─────────────────────────────────
let facecamMode = 3; // default 3v3
const FC_MAX = 5;    // camera rows available in the Facecams tab (per side)

// Per-team camera count for the active game (drives the mode cap). Games with a
// bigger roster (e.g. Marvel Rivals 6) use the Dashboard "Player Cams" for the rest.
function gameRoster() {
  const g = (currentState.games && currentState.games[currentState.activeGame]) || null;
  return Math.min(FC_MAX, Math.max(1, (g && g.rosterSize) || 4));
}
// Show only the mode buttons valid for this game's roster size.
function syncFacecamModeOptions() {
  const max = gameRoster();
  document.querySelectorAll('input[name="fcmode"]').forEach((r) => {
    const opt = r.closest('.bo-opt') || r.parentElement;
    if (opt) opt.style.display = parseInt(r.value) <= max ? '' : 'none';
  });
  if (facecamMode > max) {
    facecamMode = max;
    document.querySelectorAll('input[name="fcmode"]').forEach((r) => { r.checked = parseInt(r.value) === facecamMode; });
    updateFacecamRows(facecamMode);
  }
}

const PLATFORMS = [
  { key: 'steam',       label: 'Steam'       },
  { key: 'epic',        label: 'Epic'        },
  { key: 'playstation', label: 'PlayStation' },
  { key: 'xbox',        label: 'Xbox'        },
  { key: 'nintendo',    label: 'Nintendo'    }
];

const fcHiddenSlots = new Set();   // slot indexes hidden on BOTH columns (keeps them aligned)
function updateFacecamRows(mode) {
  ['blue', 'orange'].forEach(side => {
    for (let i = 0; i < FC_MAX; i++) {
      const row = el(`fcrow-${side}-${i}`);
      if (row) row.style.display = (i < mode && !fcHiddenSlots.has(i)) ? '' : 'none';
    }
  });
}

// Inject a per-slot hide toggle into each row; hiding mirrors to the other team so
// the two columns always have the same number of visible rows (Apply buttons stay aligned).
function initFacecamRowToggles() {
  const eye = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeOff = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  for (let i = 0; i < FC_MAX; i++) {
    ['blue', 'orange'].forEach((side) => {
      const row = el(`fcrow-${side}-${i}`);
      if (!row || row.querySelector('.fc-row-hide')) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'fc-row-hide'; b.dataset.slot = i;
      b.title = 'Hide this slot on both teams';
      b.innerHTML = eye;
      b.addEventListener('click', () => {
        if (fcHiddenSlots.has(i)) fcHiddenSlots.delete(i); else fcHiddenSlots.add(i);
        updateFacecamRows(facecamMode);
        // reflect icon on both columns' buttons for this slot
        document.querySelectorAll(`.fc-row-hide[data-slot="${i}"]`).forEach((x) => { x.innerHTML = fcHiddenSlots.has(i) ? eyeOff : eye; });
      });
      row.appendChild(b);
    });
  }
}
initFacecamRowToggles();

document.querySelectorAll('input[name="fcmode"]').forEach(r => {
  r.addEventListener('change', function() {
    if (this.checked) {
      facecamMode = parseInt(this.value);
      updateFacecamRows(facecamMode);
    }
  });
});

function updateFacecamDropdowns(players) {
  // Between matches players = [] — keep existing dropdown state, don't wipe it
  if (!players || players.length === 0) return;

  const blue   = players.filter(p => p.team === 0).sort((a,b) => a.name.localeCompare(b.name));
  const orange = players.filter(p => p.team === 1).sort((a,b) => a.name.localeCompare(b.name));

  // ── Guard: skip DOM rebuild if player list hasn't changed (prevents focus loss)
  const newKey = [...blue, ...orange].map(p => p.name).join('|');
  const needsRebuild = newKey !== _lastPlayerKey;
  _lastPlayerKey = newKey;

  // Auto-detect mode from active player count
  const detected = Math.min(Math.max(blue.length, orange.length, 1), gameRoster());
  if ((blue.length > 0 || orange.length > 0) && detected !== facecamMode) {
    facecamMode = detected;
    document.querySelectorAll('input[name="fcmode"]').forEach(r => {
      r.checked = parseInt(r.value) === facecamMode;
    });
    updateFacecamRows(facecamMode);
  }

  if (!needsRebuild) return false; // Don't touch the DOM if nothing changed

  function populateSide(side, list) {
    for (let i = 0; i < FC_MAX; i++) {
      const sel = el(`fc-${side}-${i}-name`);
      if (!sel || document.activeElement === sel) continue; // never rebuild focused select
      const current = sel.value;
      sel.innerHTML = '<option value="">— Select —</option>';
      list.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
      if (current && list.find(p => p.name === current)) sel.value = current;
    }
  }

  populateSide('blue', blue);
  populateSide('orange', orange);
  return true;
}

function syncFacecamRows(players, savedFacecams, forceSync = false) {
  const playersChanged = updateFacecamDropdowns(players);
  
  // If players haven't changed and we are not forcing sync (e.g. initial load or after save),
  // do NOT touch the inputs. This prevents clearing fields while the user is typing.
  if (!playersChanged && !forceSync) return;

  const blue   = players.filter(p => p.team === 0).sort((a,b) => a.name.localeCompare(b.name));
  const orange = players.filter(p => p.team === 1).sort((a,b) => a.name.localeCompare(b.name));

  function syncSide(side, list) {
    list.forEach((p, i) => {
      if (i >= 4) return;
      const rawId = p.primaryid ? String(p.primaryid).split('|')[1] || '' : '';
      
      // Prioritize ID lookup, fallback to Name
      let saved = null;
      if (rawId) saved = savedFacecams.find(fc => fc.platformId && fc.platformId === rawId);
      if (!saved) saved = savedFacecams.find(fc => fc.name === p.name);

      // Player name dropdown
      const sel = el(`fc-${side}-${i}-name`);
      if (sel && p.name && document.activeElement !== sel) sel.value = p.name;

      // Always set ID and URL — clear them if no saved facecam for this player
      const idEl = el(`fc-${side}-${i}-id`);
      if (idEl && document.activeElement !== idEl)
        idEl.value = saved ? (saved.platformId || '') : '';

      const urlEl = el(`fc-${side}-${i}-url`);
      if (urlEl && document.activeElement !== urlEl)
        urlEl.value = saved ? (saved.link || '') : '';

      // Platform picker — reset to steam if no saved facecam
      const platform = (saved && saved.platform) ? saved.platform : 'steam';
      const picker = el(`fc-${side}-${i}-platform`);
      if (picker) {
        picker.querySelectorAll('.plat-icon').forEach(icon => {
          icon.classList.toggle('selected', icon.dataset.platform === platform);
        });
        picker.dataset.value = platform;
      }

      // Update preview
      const previewWrap   = el(`fc-${side}-${i}-preview-wrap`);
      const previewIframe = el(`fc-${side}-${i}-preview`);
      const previewToggle = el(`fc-${side}-${i}-preview-toggle`);
      
      if (previewWrap && previewIframe && previewToggle) {
        if (saved && saved.link) {
          // Store the URL for lazy loading
          previewIframe.dataset.src = saved.link;
          previewToggle.style.display = '';
          
          // If it's already open, sync the src
          if (previewWrap.classList.contains('open') && previewIframe.src !== saved.link) {
            previewIframe.src = saved.link;
          }
        } else {
          previewIframe.src = 'about:blank';
          previewIframe.dataset.src = '';
          previewToggle.style.display = 'none';
          previewWrap.classList.remove('open');
          previewToggle.classList.remove('open');
        }
      }
    });
  }

  syncSide('blue', blue);
  syncSide('orange', orange);
}

// ── Facecams: manual add ──────────────────────────────────────────────────
el('btn-add-facecam-manual').addEventListener('click', () => {
  const name     = el('add-fc-name').value.trim();
  const platform = el('add-fc-platform').value;
  const link     = el('add-fc-url').value.trim();
  
  if (!name || !link) {
    alert('Please enter both a Name/ID and a URL.');
    return;
  }

  send('save_facecam', {
    name,
    platform,
    platformId: name, // Default platformId to name for manual entries
    link
  });

  // Clear inputs
  el('add-fc-name').value = '';
  el('add-fc-url').value = '';
});


function applyFacecamRow(side, idx) {
  const nameEl     = el(`fc-${side}-${idx}-name`);
  const platformEl = el(`fc-${side}-${idx}-platform`);
  const idEl       = el(`fc-${side}-${idx}-id`);
  const urlEl      = el(`fc-${side}-${idx}-url`);
  const name       = nameEl     ? nameEl.value.trim()                    : '';
  const platform   = platformEl ? (platformEl.dataset.value || 'steam')  : 'steam';
  const platformId = idEl       ? idEl.value.trim()                      : '';
  const link       = urlEl      ? urlEl.value.trim()                     : '';
  if (!name && !platformId) { alert('Select a player or enter a Primary ID.'); return; }
  if (!link) { alert('Enter the facecam URL.'); return; }
  const key = name || platformId;
  send('save_facecam', { name: key, platform, platformId: platformId || null, link });
  
  // Refresh preview immediately and open it
  const previewWrap   = el(`fc-${side}-${idx}-preview-wrap`);
  const previewIframe = el(`fc-${side}-${idx}-preview`);
  const previewToggle = el(`fc-${side}-${idx}-preview-toggle`);
  
  if (previewWrap && previewIframe && previewToggle) {
    previewIframe.dataset.src = link;
    previewIframe.src = link;
    previewToggle.style.display = '';
    previewToggle.classList.add('open');
    previewWrap.classList.add('open');
    const span = previewToggle.querySelector('span');
    if (span) span.textContent = 'Hide Preview';
  }
}

function deleteFacecamRow(side, idx) {
  const nameEl     = el(`fc-${side}-${idx}-name`);
  const idEl       = el(`fc-${side}-${idx}-id`);
  const urlEl      = el(`fc-${side}-${idx}-url`);
  const name       = nameEl ? nameEl.value.trim() : '';
  const platformId = idEl   ? idEl.value.trim()   : '';
  
  const key = name || platformId;
  if (key) {
    send('delete_facecam', { name: key });
  }

  // Clear fields
  if (urlEl) urlEl.value = '';
  if (idEl && !name) idEl.value = ''; // only clear ID if not selected via name

  // Hide preview
  const previewWrap   = el(`fc-${side}-${idx}-preview-wrap`);
  const previewIframe = el(`fc-${side}-${idx}-preview`);
  const previewToggle = el(`fc-${side}-${idx}-preview-toggle`);
  if (previewWrap && previewIframe && previewToggle) {
    previewIframe.src = 'about:blank';
    previewIframe.dataset.src = '';
    previewToggle.style.display = 'none';
    previewWrap.classList.remove('open');
    previewToggle.classList.remove('open');
  }
}


// ── Platform pickers (generated via JS to avoid repeating HTML 8 times) ──────
function initPlatformPickers() {
  ['blue', 'orange'].forEach(side => {
    for (let i = 0; i < FC_MAX; i++) {
      const idInput = el(`fc-${side}-${i}-id`);
      if (!idInput) continue;
      const fieldRow = idInput.closest('.field-row');
      if (!fieldRow) continue;

      // Update label
      const lbl = fieldRow.querySelector('.field-label');
      if (lbl) lbl.innerHTML = 'Platform & Primary ID <span style="opacity:0.45;font-weight:400;">(optional)</span>';

      // Build picker
      const picker = document.createElement('div');
      picker.className = 'platform-picker';
      picker.id = `fc-${side}-${i}-platform`;
      picker.dataset.value = 'steam';
      PLATFORMS.forEach((p, pi) => {
        const img = document.createElement('img');
        img.src = `../assets/platforms/${p.key}.png`;
        img.className = 'plat-icon' + (pi === 0 ? ' selected' : '');
        img.title = p.label;
        img.dataset.platform = p.key;
        img.addEventListener('click', () => {
          picker.querySelectorAll('.plat-icon').forEach(ic => ic.classList.remove('selected'));
          img.classList.add('selected');
          picker.dataset.value = p.key;
        });
        picker.appendChild(img);
      });

      // Wrap picker + input side-by-side
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex; gap:6px; align-items:center;';
      fieldRow.removeChild(idInput);
      idInput.style.flex = '1';
      wrapper.appendChild(picker);
      wrapper.appendChild(idInput);
      fieldRow.appendChild(wrapper);
    }
  });
}

// ── Facecam live previews ────────────────────────────────────────────
function initFacecamPreviews() {
  ['blue', 'orange'].forEach(side => {
    for (let i = 0; i < FC_MAX; i++) {
      const row = el(`fcrow-${side}-${i}`);
      if (!row) continue;
      const btn = row.querySelector('.btn');
      if (!btn) continue;

      // Create toggle
      const toggle = document.createElement('div');
      toggle.className = 'fc-preview-toggle';
      toggle.id = `fc-${side}-${i}-preview-toggle`;
      toggle.innerHTML = '<span>Show Preview</span>';
      toggle.style.display = 'none';

      // Create wrap
      const wrap = document.createElement('div');
      wrap.className = 'fc-preview-wrap';
      wrap.id = `fc-${side}-${i}-preview-wrap`;

      const iframe = document.createElement('iframe');
      iframe.id = `fc-${side}-${i}-preview`;
      iframe.className = 'fc-preview-iframe';
      iframe.frameBorder = '0';
      iframe.allow = 'autoplay; encrypted-media';
      iframe.loading = 'lazy';
      iframe.referrerPolicy = 'no-referrer';
      iframe.src = 'about:blank';

      wrap.appendChild(iframe);

      // Toggle logic
      toggle.addEventListener('click', () => {
        const isOpen = wrap.classList.toggle('open');
        toggle.classList.toggle('open', isOpen);
        toggle.querySelector('span').textContent = isOpen ? 'Hide Preview' : 'Show Preview';
        
        // Lazy load src on open
        if (isOpen && (iframe.src === 'about:blank' || iframe.src === '')) {
          const urlVal = el(`fc-${side}-${i}-url`).value.trim();
          const target = iframe.dataset.src || urlVal;
          if (target) iframe.src = target;
        }
      });

      // ── Add Delete Button next to URL input
      const urlInput = el(`fc-${side}-${i}-url`);
      if (urlInput) {
        const urlRow = urlInput.parentElement;
        if (urlRow && urlRow.classList.contains('field-row')) {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'display:flex; gap:6px; align-items:center;';
          urlRow.removeChild(urlInput);
          urlInput.style.flex = '1';
          
          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-danger btn-sm';
          delBtn.style.padding = '4px 8px';
          delBtn.style.flexShrink = '0';
          delBtn.style.width = 'auto';
          delBtn.style.minWidth = '32px';
          delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
          delBtn.title = 'Delete Facecam';
          delBtn.addEventListener('click', () => deleteFacecamRow(side, i));
          
          wrapper.appendChild(urlInput);
          wrapper.appendChild(delBtn);
          urlRow.appendChild(wrapper);
        }
      }

      // Rearrange: Insert toggle and wrap before the button
      // This puts the button at the very bottom of the row
      btn.insertAdjacentElement('beforebegin', toggle);
      btn.insertAdjacentElement('beforebegin', wrap);
      
      // Add a bit of margin to the button to separate it from the preview
      btn.style.marginTop = '10px';
    }
  });
}

// Initialise on load
updateFacecamRows(facecamMode);
initPlatformPickers();
initFacecamPreviews();

// ── Apply All Facecams ────────────────────────────────────────────────────
el('btn-apply-all-facecams').addEventListener('click', () => {
  let saved = 0;
  ['blue', 'orange'].forEach(side => {
    for (let i = 0; i < facecamMode; i++) {
      const nameEl = el(`fc-${side}-${i}-name`);
      const idEl   = el(`fc-${side}-${i}-id`);
      const urlEl  = el(`fc-${side}-${i}-url`);
      const name       = nameEl ? nameEl.value.trim() : '';
      const platformId = idEl   ? idEl.value.trim()   : '';
      const link       = urlEl  ? urlEl.value.trim()   : '';
      if ((name || platformId) && link) {
        applyFacecamRow(side, i);
        saved++;
      }
    }
  });
  if (saved === 0) alert('No facecams to apply — fill in at least one URL.');
});

// ── Player Modal Events ────────────────────────────────────────────────────
el('btn-cancel-player').addEventListener('click', closePlayerModal);
el('btn-close-player-modal').addEventListener('click', closePlayerModal);
el('btn-save-player').addEventListener('click', savePlayer);
el('player-create-camera').addEventListener('change', function() {
  el('player-new-camera-form').style.display = this.checked ? 'block' : 'none';
});

el('player-modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closePlayerModal();
});

// ── Start.gg Search & Import ───────────────────────────────────────────────
el('btn-search-startgg-teams').addEventListener('click', async () => {
  const query = el('startgg-team-search').value.trim();
  if (!query) {
    alert('Enter a team name to search');
    return;
  }

  if (!currentState.startgg?.hasToken) {
    alert('Please enter your Start.gg API token in Settings first');
    return;
  }

  const resultsDiv = el('startgg-search-results');
  resultsDiv.innerHTML = '<p style="color: var(--muted); font-size: 12px;">Searching...</p>';

  try {
    const tokenInput = el('input-startgg-token');
    const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
    const response = await fetch('http://localhost:3000/api/startgg/search-teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, apiToken: token })
    });

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      resultsDiv.innerHTML = '<p style="color: #ef4444; font-size: 12px;">API Error: Invalid response. Check your API token or try again.</p>';
      return;
    }

    if (!response.ok) {
      resultsDiv.innerHTML = `<p style="color: #ef4444; font-size: 12px;">Error: ${data.error || 'Unknown error'}</p>`;
      return;
    }

    if (!data.teams || data.teams.length === 0) {
      resultsDiv.innerHTML = '<p style="color: var(--muted); font-size: 12px;">No teams found.</p>';
      return;
    }

    resultsDiv.innerHTML = '';
    data.teams.forEach(team => {
      const result = document.createElement('div');
      result.className = 'startgg-team-result';
      result.innerHTML = `
        <div class="startgg-team-result-name">${team.name}</div>
        <div class="startgg-team-result-meta">${team.playerCount || 0} players • ${team.state || 'Unknown'}</div>
      `;
      result.style.cursor = 'pointer';
      result.addEventListener('click', () => {
        importStartggTeam(team);
      });
      resultsDiv.appendChild(result);
    });
  } catch (err) {
    resultsDiv.innerHTML = `<p style="color: #ef4444; font-size: 12px;">Error: ${err.message}</p>`;
  }
});

// ── Start.gg Tournament Search ──────────────────────────────────────────────
el('btn-search-startgg-tournaments').addEventListener('click', async () => {
  const query = el('startgg-tournament-search').value.trim();
  if (!query) {
    alert('Enter a tournament name to search');
    return;
  }

  if (!currentState.startgg?.hasToken) {
    alert('Please enter your Start.gg API token in Settings first');
    return;
  }

  const resultsDiv = el('startgg-tournament-search-results');
  resultsDiv.innerHTML = '<div style="padding: 16px; text-align: center;"><span style="color: var(--muted); font-size: 12px;"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Searching tournaments...</span></div>';

  try {
    // First test if the token is valid
    const tokenInput2 = el('input-startgg-token');
    const t2 = (tokenInput2 && tokenInput2.value.trim()) || currentState.startgg?.apiToken || '';
    const tokenResponse = await fetch('http://localhost:3000/api/startgg/test-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiToken: t2 })
    });
    const tokenData = await tokenResponse.json();

    if (!tokenData.valid) {
      resultsDiv.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 12px; text-align: center;">Invalid API Token<br><small>Go to Settings and verify your Start.gg token</small></div>`;
      return;
    }

    // Token is valid, proceed with search
    const tokenInput = el('input-startgg-token');
    const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
    const response = await fetch('http://localhost:3000/api/startgg/search-tournaments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, apiToken: token })
    });

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      resultsDiv.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 12px; text-align: center;">API Error: Invalid response</div>`;
      return;
    }

    if (!response.ok) {
      resultsDiv.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 12px; text-align: center;">${data.error || 'Search failed'}</div>`;
      return;
    }

    if (!data.tournaments || data.tournaments.length === 0) {
      resultsDiv.innerHTML = '<div style="padding: 16px; color: var(--muted); font-size: 12px; text-align: center;">No tournaments found for "${query}"</div>';
      return;
    }

    resultsDiv.innerHTML = '';
    data.tournaments.forEach(tournament => {
      const startDate = tournament.startAt ? new Date(tournament.startAt * 1000).toLocaleDateString() : 'TBA';
      const result = document.createElement('div');
      result.className = 'startgg-tournament-preview';

      if (tournament.image) {
        result.innerHTML = `
          <div class="tournament-preview-image">
            <img src="${tournament.image}" alt="${tournament.name}" onerror="this.src='../assets/rl.png'">
          </div>
          <div class="tournament-preview-content">
            <div class="tournament-preview-name">${tournament.name}</div>
            <div class="tournament-preview-date">${startDate}</div>
            <div class="tournament-preview-slug">Slug: ${tournament.slug}</div>
          </div>
        `;
      } else {
        result.innerHTML = `
          <div class="tournament-preview-placeholder">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><rect x="2" y="6" width="20" height="12" rx="6"/></svg>
          </div>
          <div class="tournament-preview-content">
            <div class="tournament-preview-name">${tournament.name}</div>
            <div class="tournament-preview-date">${startDate}</div>
            <div class="tournament-preview-slug">Slug: ${tournament.slug}</div>
          </div>
        `;
      }

      result.style.cursor = 'pointer';
      result.addEventListener('click', () => {
        selectStartggTournament(tournament, true);
      });
      resultsDiv.appendChild(result);
    });
  } catch (err) {
    resultsDiv.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 12px; text-align: center;">Error: ${err.message}</div>`;
  }
});

function selectStartggTournament(tournament, autoLoadTeams = false) {
  // Update manual slug fields if present (teams tab)
  const tSlugEl = el('startgg-tournament-slug');
  const eSlugEl = el('startgg-event-slug');
  if (tSlugEl) tSlugEl.value = tournament.slug || '';
  if (eSlugEl) eSlugEl.value = '';

  const resultsDiv = el('startgg-tournament-search-results');
  if (resultsDiv) resultsDiv.innerHTML = `<p style="color: #86efac; font-size: 12px;">✓ Selected: ${tournament.name}</p>`;

  // Global selection for event + stats
  const payload = {
    tournamentSlug: tournament.slug,
    eventSlug: '', // will let user load specific or default to tournament slug for entrants
    name: tournament.name,
    tournamentName: tournament.name
  };
  send('select_startgg_event', payload);

  // Sync the queue tournament field (Dashboard) so stream queue can use the same
  const queueInput = el('sgg-tournament');
  if (queueInput) queueInput.value = tournament.slug || '';

  // Update selected pill (new design)
  const selDiv = el('dash-selected-sgg-event');
  const selText = el('ev-selected-text');
  if (selDiv && selText) {
    selText.textContent = tournament.name + (tournament.slug ? ` · ${tournament.slug}` : '');
    selDiv.style.display = 'flex';
  }

  if (autoLoadTeams) {
    loadStartggTeamsForSelection(tournament.slug, '');
  }
}

async function loadStartggTeamsForSelection(tournamentSlug, eventSlug) {
  if (!currentState.startgg?.hasToken) {
    alert('Please enter your Start.gg API token in Settings first');
    return;
  }
  const statusTarget = el('dash-selected-sgg-event') || el('startgg-import-status');
  if (statusTarget) statusTarget.textContent = 'Loading teams from event...';

  try {
    const tokenInput = el('input-startgg-token');
    const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
    // Prefer the dedicated endpoint (server will also call load + broadcast)
    const resp = await fetch('http://localhost:3000/api/startgg/event-teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentSlug: tournamentSlug || '',
        eventSlug: eventSlug || '',
        apiToken: token
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');

    if (statusTarget) statusTarget.textContent = `✓ Loaded ${data.teamsLoaded || 0} teams`;
    // state will arrive via WS broadcast shortly; render will update
  } catch (e) {
    // Fallback: use WS message directly
    send('load_startgg_event_teams', { tournamentSlug, eventSlug });
    if (statusTarget) statusTarget.textContent = 'Loading... (via WS)';
  }
}

function clearStartggTeams() {
  send('clear_startgg_teams', {});
  const selDiv = el('dash-selected-sgg-event');
  if (selDiv) selDiv.style.display = 'none';
  const searchInput = el('sgg-event-search');
  if (searchInput) { searchInput.value = ''; }
  if (el('ev-search-clear')) el('ev-search-clear').style.display = 'none';
  _evMyTourneys = null; // force re-fetch next time
}

el('btn-import-tournament-roster').addEventListener('click', async () => {
  const tournamentSlug = el('startgg-tournament-slug').value.trim();
  const eventSlug = el('startgg-event-slug').value.trim();

  if (!tournamentSlug || !eventSlug) {
    alert('Enter both tournament and event slugs');
    return;
  }

  const statusDiv = el('startgg-import-status');
  statusDiv.innerHTML = '<p style="color: var(--muted);">Importing...</p>';

  try {
    const tokenInput = el('input-startgg-token');
    const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
    const response = await fetch('http://localhost:3000/api/startgg/import-tournament', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentSlug,
        eventSlug,
        apiToken: token
      })
    });
    const data = await response.json();

    if (!response.ok) {
      statusDiv.innerHTML = `<p style="color: #ef4444;">Error: ${data.error || 'Unknown error'}</p>`;
      return;
    }

    statusDiv.innerHTML = `<p style="color: #86efac;">✓ Imported ${data.teamsAdded || 0} teams with ${data.playersAdded || 0} players</p>`;
  } catch (err) {
    statusDiv.innerHTML = `<p style="color: #ef4444;">Error: ${err.message}</p>`;
  }
});

function importStartggTeam(teamData) {
  alert(`Importing ${teamData.name} from Start.gg. This feature will add the team and its players to your setup.`);
}

// ── Dashboard: start.gg Event / Tournament picker wiring ─────────────────────
let _evMyTourneys = null;   // cached admin tournament list; null = not yet fetched
let _evSearchTimer = null;

function wireSggEventPicker() {
  const searchInput = el('sgg-event-search');
  const resultsDiv  = el('dash-sgg-tournament-results');
  const clearBtn    = el('ev-search-clear');

  if (searchInput && resultsDiv) {
    // Auto-load admin tournaments on first focus
    searchInput.addEventListener('focus', async () => {
      if (!currentState.startgg?.hasToken) {
        resultsDiv.innerHTML = '<div class="ev-dropdown-msg" style="color:#f59e0b;">⚠ Add a start.gg API token in Settings → Integrations first.</div>';
        resultsDiv.style.display = 'block';
        return;
      }
      if (_evMyTourneys !== null) {
        renderEvDropdownResults(_evMyTourneys, searchInput.value.trim().toLowerCase());
        resultsDiv.style.display = 'block';
        return;
      }
      resultsDiv.innerHTML = '<div class="ev-dropdown-msg">Loading your tournaments…</div>';
      resultsDiv.style.display = 'block';
      const token = (el('input-startgg-token')?.value.trim()) || currentState.startgg?.apiToken || '';
      try {
        const resp = await fetch('http://localhost:3000/api/startgg/my-tournaments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiToken: token })
        });
        const data = await resp.json();
        _evMyTourneys = resp.ok ? (data.tournaments || []) : [];
        renderEvDropdownResults(_evMyTourneys, searchInput.value.trim().toLowerCase());
      } catch (err) {
        _evMyTourneys = [];
        resultsDiv.innerHTML = `<div class="ev-dropdown-msg" style="color:#ef4444;">Error: ${err.message}</div>`;
      }
    });

    // Live keyword filter (client-side from cached list)
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
      clearTimeout(_evSearchTimer);
      _evSearchTimer = setTimeout(() => {
        if (_evMyTourneys !== null) {
          renderEvDropdownResults(_evMyTourneys, q.toLowerCase());
          resultsDiv.style.display = 'block';
        }
      }, 60);
    });

    // Enter → global start.gg search fallback
    searchInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { resultsDiv.style.display = 'none'; return; }
      if (e.key !== 'Enter') return;
      const q = searchInput.value.trim();
      if (!q || !currentState.startgg?.hasToken) return;
      resultsDiv.innerHTML = '<div class="ev-dropdown-msg">Searching all of start.gg…</div>';
      resultsDiv.style.display = 'block';
      await searchTournamentsInto(q, resultsDiv);
    });

    // X button clears the input and resets dropdown
    if (clearBtn) clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      if (_evMyTourneys !== null) {
        renderEvDropdownResults(_evMyTourneys, '');
        resultsDiv.style.display = 'block';
      } else {
        resultsDiv.style.display = 'none';
      }
      searchInput.focus();
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ev-search-wrap') && !e.target.closest('#dash-sgg-tournament-results')) {
        resultsDiv.style.display = 'none';
      }
    }, true);
  }

  // Deselect pill button
  const pillClear = el('ev-pill-clear');
  if (pillClear) pillClear.addEventListener('click', () => {
    const selDiv = el('dash-selected-sgg-event');
    if (selDiv) selDiv.style.display = 'none';
  });

  // Load / clear
  const loadDash = el('btn-load-sgg-teams-dash');
  if (loadDash) loadDash.addEventListener('click', () => {
    const t = (el('sgg-tournament')?.value || currentState.startgg?.tournamentSlug || '').trim();
    const e = (el('startgg-event-slug')?.value || currentState.startgg?.eventSlug || '').trim() || t;
    if (!t && !e) { alert('Select a tournament first — click one from the search above'); return; }
    loadStartggTeamsForSelection(t, e);
  });

  const clearDash = el('btn-clear-sgg-teams-dash');
  if (clearDash) clearDash.addEventListener('click', () => clearStartggTeams());

  // Teams tab bulk actions
  const saveAll = el('btn-save-all-sgg-teams');
  if (saveAll) saveAll.addEventListener('click', () => {
    const teams = currentState.startgg?.eventTeams || [];
    if (!teams.length) return alert('No event teams to save.');
    if (!confirm(`Save all ${teams.length} start.gg teams into Saved Teams?`)) return;
    send('save_startgg_teams_bulk', { names: teams.map(t => t.name) });
  });

  const massDel = el('btn-mass-delete-sgg-teams');
  if (massDel) massDel.addEventListener('click', () => {
    const teams = currentState.startgg?.eventTeams || [];
    if (!teams.length) return;
    if (!confirm(`Delete all ${teams.length} start.gg event teams? (Saved teams are unaffected)`)) return;
    send('mass_delete_startgg_teams', {});
  });
}

function renderEvDropdownResults(tournaments, filterQuery) {
  const container = el('dash-sgg-tournament-results');
  if (!container) return;

  const nowSec = Date.now() / 1000;
  const sorted = [...tournaments].sort((a, b) => {
    const aUp = (a.startAt || 0) >= nowSec;
    const bUp = (b.startAt || 0) >= nowSec;
    if (aUp && !bUp) return -1;
    if (!aUp && bUp) return 1;
    if (aUp && bUp) return (a.startAt || 0) - (b.startAt || 0); // nearest upcoming first
    return (b.startAt || 0) - (a.startAt || 0);                  // most recent past first
  });

  const filtered = filterQuery
    ? sorted.filter(t =>
        t.name.toLowerCase().includes(filterQuery) ||
        (t.slug || '').toLowerCase().includes(filterQuery))
    : sorted;

  if (!filtered.length) {
    container.innerHTML = filterQuery
      ? `<div class="ev-dropdown-msg">No match for "<strong>${filterQuery}</strong>" — press Enter to search all of start.gg</div>`
      : '<div class="ev-dropdown-msg">No admin tournaments found. Press Enter to search start.gg.</div>';
    return;
  }

  container.innerHTML = '';
  if (!filterQuery) {
    const hdr = document.createElement('div');
    hdr.className = 'ev-dropdown-section-hdr';
    hdr.textContent = 'My Admin Tournaments';
    container.appendChild(hdr);
  }

  filtered.forEach(t => {
    const row = document.createElement('div');
    row.className = 'ev-dropdown-row';
    const date = t.startAt ? new Date(t.startAt * 1000).toLocaleDateString() : '';
    const logoUrl = t.images?.[0]?.url || t.image || '';
    const logoHtml = logoUrl
      ? `<img class="ev-dropdown-logo" src="${logoUrl}" alt="" onerror="this.style.display='none'">`
      : `<div class="ev-dropdown-logo-ph"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2L3 7v11h5v-5h4v5h5V7L10 2z"/></svg></div>`;
    row.innerHTML = `${logoHtml}
      <div class="ev-dropdown-info">
        <div class="ev-dropdown-name">${t.name}</div>
        <div class="ev-dropdown-meta">${[date, t.slug].filter(Boolean).join(' · ')}</div>
      </div>
      <span class="ev-dropdown-badge">Admin</span>`;
    row.addEventListener('click', () => {
      const searchInput = el('sgg-event-search');
      if (searchInput) searchInput.value = t.name;
      if (el('ev-search-clear')) el('ev-search-clear').style.display = 'block';
      container.style.display = 'none';
      selectStartggTournament(t, true);
    });
    container.appendChild(row);
  });
}

// Fetch and display "My Admin Tournaments" into a results container
async function showMyTournaments(container) {
  if (!container) return;
  if (!currentState.startgg?.hasToken) {
    container.innerHTML = '<div style="color:#ef4444;font-size:12px">Add API token in Settings first.</div>';
    return;
  }
  container.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--muted)">Loading your tournaments…</div>';
  const tokenInput = el('input-startgg-token');
  const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
  try {
    const resp = await fetch('http://localhost:3000/api/startgg/my-tournaments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiToken: token })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    container.innerHTML = '';
    if (!data.tournaments || !data.tournaments.length) {
      container.innerHTML = '<div style="font-size:12px;color:var(--muted)">No tournaments found for this token (you may need search instead).</div>';
      return;
    }
    data.tournaments.forEach(t => {
      const div = document.createElement('div');
      div.className = 'startgg-tournament-preview';
      div.style.cursor = 'pointer';
      const date = t.startAt ? new Date(t.startAt * 1000).toLocaleDateString() : '';
      div.innerHTML = `
        <div class="tournament-preview-content" style="padding:6px 8px;">
          <div class="tournament-preview-name">${t.name}</div>
          <div class="tournament-preview-date" style="font-size:10px;">${date} • Slug: ${t.slug}</div>
        </div>
      `;
      div.addEventListener('click', () => {
        selectStartggTournament(t, true); // auto load teams on pick
      });
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = `<div style="color:#ef4444;font-size:12px">Error: ${err.message}</div>`;
  }
}

// Generic search tournaments into container (global start.gg search, shared by dashboard + Events tab)
async function searchTournamentsInto(query, container) {
  if (!container) return;
  if (!currentState.startgg?.hasToken) {
    container.innerHTML = '<div class="ev-dropdown-msg" style="color:#f59e0b;">⚠ Add API token in Settings → Integrations first.</div>';
    return;
  }
  container.innerHTML = '<div class="ev-dropdown-msg">Searching…</div>';
  const token = (el('input-startgg-token')?.value.trim()) || currentState.startgg?.apiToken || '';
  try {
    const resp = await fetch('http://localhost:3000/api/startgg/search-tournaments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, apiToken: token })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    container.innerHTML = '';
    if (!data.tournaments || !data.tournaments.length) {
      container.innerHTML = '<div class="ev-dropdown-msg">No results found.</div>';
      return;
    }
    const hdr = document.createElement('div');
    hdr.className = 'ev-dropdown-section-hdr';
    hdr.textContent = `Search results for "${query}"`;
    container.appendChild(hdr);
    data.tournaments.forEach(t => {
      const row = document.createElement('div');
      row.className = 'ev-dropdown-row';
      const date = t.startAt ? new Date(t.startAt * 1000).toLocaleDateString() : '';
      const logoUrl = t.image || '';
      const logoHtml = logoUrl
        ? `<img class="ev-dropdown-logo" src="${logoUrl}" alt="" onerror="this.style.display='none'">`
        : `<div class="ev-dropdown-logo-ph"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2L3 7v11h5v-5h4v5h5V7L10 2z"/></svg></div>`;
      row.innerHTML = `${logoHtml}
        <div class="ev-dropdown-info">
          <div class="ev-dropdown-name">${t.name}</div>
          <div class="ev-dropdown-meta">${[date, t.slug].filter(Boolean).join(' · ')}</div>
        </div>`;
      row.addEventListener('click', () => {
        const searchInput = el('sgg-event-search');
        if (searchInput) searchInput.value = t.name;
        if (el('ev-search-clear')) el('ev-search-clear').style.display = 'block';
        container.style.display = 'none';
        selectStartggTournament(t, true);
      });
      container.appendChild(row);
    });
  } catch (err) {
    container.innerHTML = `<div class="ev-dropdown-msg" style="color:#ef4444;">Error: ${err.message}</div>`;
  }
}

// Wire once
wireSggEventPicker();

// ── Production: Casters ─────────────────────────────────────────────────────
const CASTER_SOCIAL_OPTIONS = [
  { value: 'none', label: 'No social' },
  { value: 'x', label: 'X (Twitter)' },
  { value: 'twitch', label: 'Twitch' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'discord', label: 'Discord' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'kick', label: 'Kick' },
  { value: 'other', label: 'Other / link' }
];

let castersDraft = [];          // [{ id, name, handle, camUrl, slot, social }]
let castersLowerThirdDraft = '';
let _castersInited = false;

function makeCasterId() {
  return Math.random().toString(36).slice(2, 11);
}

function nextCasterSlot() {
  const used = new Set(castersDraft.map(c => Number(c.slot)).filter(n => n >= 1 && n <= 4));
  for (let i = 1; i <= 4; i++) if (!used.has(i)) return i;
  return Math.min(4, castersDraft.length + 1);
}

function renderCasterRows() {
  const wrap = el('casters-rows');
  if (!wrap) return;
  wrap.innerHTML = '';

  castersDraft.forEach((c, idx) => {
    const card = document.createElement('div');
    card.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:10px; margin-bottom:10px;';

    const line1 = document.createElement('div');
    line1.style.cssText = 'display:grid; grid-template-columns:120px 1fr 1fr auto; gap:8px; align-items:center; margin-bottom:8px;';

    const slotSel = document.createElement('select');
    slotSel.className = 'input-select';
    for (let s = 1; s <= 4; s++) {
      const opt = document.createElement('option');
      opt.value = String(s);
      opt.textContent = `Caster ${s}`;
      slotSel.appendChild(opt);
    }
    slotSel.value = String(c.slot || idx + 1);
    slotSel.addEventListener('change', () => { castersDraft[idx].slot = Number(slotSel.value); });

    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.className = 'input-text';
    nameInp.placeholder = 'Caster name';
    nameInp.maxLength = 40;
    nameInp.value = c.name || '';
    nameInp.addEventListener('input', () => { castersDraft[idx].name = nameInp.value; });

    const handleInp = document.createElement('input');
    handleInp.type = 'text';
    handleInp.className = 'input-text';
    handleInp.placeholder = 'Handle or URL';
    handleInp.maxLength = 80;
    handleInp.value = c.handle || '';
    handleInp.addEventListener('input', () => { castersDraft[idx].handle = handleInp.value; });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.style.flexShrink = '0';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.title = 'Remove caster';
    delBtn.addEventListener('click', () => {
      castersDraft.splice(idx, 1);
      renderCasterRows();
    });

    line1.appendChild(slotSel);
    line1.appendChild(nameInp);
    line1.appendChild(handleInp);
    line1.appendChild(delBtn);

    const line2 = document.createElement('div');
    line2.style.cssText = 'display:grid; grid-template-columns:160px 1fr; gap:8px; align-items:center;';

    const socialSel = document.createElement('select');
    socialSel.className = 'input-select';
    CASTER_SOCIAL_OPTIONS.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      socialSel.appendChild(o);
    });
    socialSel.value = c.social || 'none';
    socialSel.addEventListener('change', () => { castersDraft[idx].social = socialSel.value; });

    const camInp = document.createElement('input');
    camInp.type = 'text';
    camInp.className = 'input-text';
    camInp.placeholder = 'Webcam URL (vdo.ninja) — optional';
    camInp.value = c.camUrl || '';
    camInp.addEventListener('input', () => { castersDraft[idx].camUrl = camInp.value; });

    line2.appendChild(socialSel);
    line2.appendChild(camInp);

    card.appendChild(line1);
    card.appendChild(line2);
    wrap.appendChild(card);
  });

  const addBtn = el('btn-add-caster');
  if (addBtn) addBtn.style.display = castersDraft.length >= 4 ? 'none' : '';
}

el('btn-add-caster').addEventListener('click', () => {
  if (castersDraft.length >= 4) return;
  castersDraft.push({
    id: makeCasterId(), name: '', handle: '', camUrl: '',
    slot: nextCasterSlot(), social: 'none'
  });
  renderCasterRows();
});

el('btn-apply-casters').addEventListener('click', () => {
  const list = castersDraft
    .map((c, idx) => ({
      id: c.id || makeCasterId(),
      name: (c.name || '').trim(),
      handle: (c.handle || '').trim(),
      camUrl: (c.camUrl || '').trim(),
      slot: Number(c.slot) >= 1 && Number(c.slot) <= 4 ? Number(c.slot) : idx + 1,
      social: c.social || 'none'
    }))
    .filter(c => c.name || c.handle || c.camUrl);
  send('set_casters', {
    list,
    lowerThird: (el('input-caster-lower-third')?.value || castersLowerThirdDraft || '').trim()
  });
});

el('check-casters-visible').addEventListener('change', function() {
  send('set_casters_visibility', { visible: this.checked });
});

// ── Production: Break / Starting Soon ───────────────────────────────────────
function getBreakTitle() {
  const preset = el('select-break-preset')?.value || 'STARTING SOON';
  if (preset === '__custom__') {
    return (el('input-break-title')?.value || '').trim() || 'STARTING SOON';
  }
  return preset;
}

el('select-break-preset').addEventListener('change', function() {
  const customRow = el('break-custom-title-row');
  if (customRow) customRow.style.display = this.value === '__custom__' ? '' : 'none';
});

el('btn-show-break').addEventListener('click', () => {
  send('set_break', {
    visible: true,
    title: getBreakTitle(),
    message: (el('input-break-message')?.value || '').trim(),
    // minutes -> seconds; 0 = no live countdown (title/message only)
    seconds: Math.round((parseFloat(el('input-break-minutes')?.value) || 0) * 60)
  });
});

el('btn-update-break').addEventListener('click', () => {
  // Update text without touching the running countdown
  send('set_break', {
    title: getBreakTitle(),
    message: (el('input-break-message')?.value || '').trim()
  });
});

el('btn-hide-break').addEventListener('click', () => {
  send('set_break', { visible: false });
});

// ── Production: Winner / Post-match ─────────────────────────────────────────
el('select-winner-side')?.addEventListener('change', function() {
  const row = el('winner-custom-row');
  if (row) row.style.display = this.value === '__custom__' ? '' : 'none';
});
function winnerPayload(visible) {
  const sel = el('select-winner-side')?.value || 'blue';
  const subtitle = (el('input-winner-subtitle')?.value || '').trim();
  if (sel === '__custom__') {
    return { visible, side: '', name: (el('input-winner-name')?.value || '').trim(), subtitle };
  }
  return { visible, side: sel, name: '', subtitle };
}
el('btn-show-winner')?.addEventListener('click', () => send('set_winner', winnerPayload(true)));
el('btn-hide-winner')?.addEventListener('click', () => send('set_winner', { visible: false }));

// ── Production: Team Line-up / Intro ────────────────────────────────────────
function introPayload(visible) {
  return {
    visible,
    side: el('select-intro-side')?.value || 'blue',
    title: (el('input-intro-title')?.value || '').trim()
  };
}
el('btn-show-intro')?.addEventListener('click', () => send('set_intro', introPayload(true)));
el('btn-hide-intro')?.addEventListener('click', () => send('set_intro', { visible: false }));

// ── Production: Map Veto board ──────────────────────────────────────────────
// Parse "Map | action | team | mode" lines into veto map objects.
function parseVetoMaps() {
  const lines = (el('input-veto-maps')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  const sideToAB = { blue: 'a', orange: 'b', a: 'a', b: 'b' };
  return lines.slice(0, 7).map((line) => {
    const [name = '', action = '', team = '', mode = ''] = line.split('|').map(s => s.trim());
    const act = action.toLowerCase();
    return {
      name,
      mode,
      action: ['ban', 'pick', 'decider'].includes(act) ? act : '',
      by: sideToAB[team.toLowerCase()] || ''
    };
  });
}
function vetoPayload(visible) {
  return { visible, title: (el('input-veto-title')?.value || '').trim(), maps: parseVetoMaps() };
}
el('btn-show-veto')?.addEventListener('click', () => send('set_veto', vetoPayload(true)));
el('btn-update-veto')?.addEventListener('click', () => send('set_veto', { title: (el('input-veto-title')?.value || '').trim(), maps: parseVetoMaps() }));
el('btn-hide-veto')?.addEventListener('click', () => send('set_veto', { visible: false }));

// ── Guided veto manager ─────────────────────────────────────────────────────
let _vetoGameInit = false;
el('btn-veto-start')?.addEventListener('click', () => {
  send('veto_start', {
    game: el('veto-game')?.value || '',
    bestOf: Number(el('veto-bestof')?.value || 3),
    teamStart: el('veto-start')?.value || 'a',
    visible: true
  });
});
el('veto-game')?.addEventListener('change', () => renderVetoManager(currentState));
el('btn-veto-undo')?.addEventListener('click', () => send('veto_undo', {}));
el('btn-veto-reset')?.addEventListener('click', () => send('veto_reset', {}));
el('btn-veto-show')?.addEventListener('click', () => send('veto_visible', { visible: true }));
el('btn-veto-hide2')?.addEventListener('click', () => send('veto_visible', { visible: false }));

function renderVetoManager(data) {
  const sel = el('veto-game'); if (!sel) return;
  const pools = data.vetoPools || {};
  const games = data.games || {};
  // Populate the game dropdown once (games that have a map pool), default to active game.
  const poolGames = Object.keys(pools).filter(g => (pools[g] || []).length);
  if (!_vetoGameInit && poolGames.length) {
    sel.innerHTML = '';
    poolGames.forEach(g => {
      const o = document.createElement('option'); o.value = g;
      o.textContent = (games[g] && games[g].name) || g; sel.appendChild(o);
    });
    if (poolGames.includes(data.activeGame)) sel.value = data.activeGame;
    _vetoGameInit = true;
  }
  // Per-game terminology (map/stage, Ban/Strike) for the SELECTED game in the dropdown.
  const selGame = sel.value || data.activeGame;
  const selMeta = (data.vetoMeta && data.vetoMeta[selGame]) || { banWord: 'Ban', unit: 'map' };
  // Side labels follow the team names.
  const blue = (data.teams && data.teams.blue && data.teams.blue.name) || 'Blue';
  const orange = (data.teams && data.teams.orange && data.teams.orange.name) || 'Orange';
  const startSel = el('veto-start');
  if (startSel) {
    const first = selMeta.banWord.toLowerCase() + 's first';
    startSel.options[0].textContent = blue + ' ' + first; startSel.options[1].textContent = orange + ' ' + first;
  }
  const sideName = (s) => s === 'b' ? orange : blue;
  const sideColor = (s) => (s === 'b'
    ? (data.teams?.orange?.color || '#e97139')
    : (data.teams?.blue?.color || '#055fdb'));

  const v = data.veto || {};
  const turnEl = el('veto-turn'); const grid = el('veto-grid');

  // Not started yet → clear the board, prompt to start.
  if (!Array.isArray(v.pool) || !v.pool.length) {
    if (turnEl) turnEl.textContent = 'Choose a game + best-of, then Start Veto.';
    if (grid) grid.innerHTML = '';
    return;
  }

  // Active-veto terminology comes from the running veto (falls back to selected game's).
  const banWord = ((v.banWord || selMeta.banWord || 'Ban')).toUpperCase();   // BAN for maps, STRIKE for stages
  const unit = v.unit || selMeta.unit || 'map';
  const deciderWord = unit === 'stage' ? 'STAGE' : 'DECIDER';
  const actionWord = (a) => a === 'ban' ? banWord : a.toUpperCase();

  // Turn prompt
  if (turnEl) {
    if (v.turn && v.turn.team) {
      const a = v.turn.action;
      turnEl.innerHTML = `<b style="color:${sideColor(v.turn.team)}">${sideName(v.turn.team)}</b> to <span class="${a}">${actionWord(a)}</span>`;
    } else {
      turnEl.innerHTML = `<span class="done">Complete</span> — ${(v.maps || []).filter(m => m.action === 'pick' || m.action === 'decider').length} ${unit}(s) set`;
    }
  }

  // Map grid (signature-guarded so we don't rebuild every full_state)
  if (grid) {
    const sig = JSON.stringify((v.maps || []).map(m => [m._id, m.action, m.by]));
    if (grid.dataset.sig !== sig) {
      grid.dataset.sig = sig;
      grid.innerHTML = '';
      (v.maps || []).forEach(m => {
        const card = document.createElement('div');
        card.className = 'vm-map' + (m.action === 'ban' ? ' banned' : '') + (m.action === 'pick' ? ' picked' : '') + (m.action === 'decider' ? ' decider' : '');
        if (m.action === 'ban') card.dataset.x = banWord;            // banned-card label = BAN / STRIKE
        if (m.action === 'pick') { card.style.borderColor = sideColor(m.by); }
        if (m.image) { const img = document.createElement('img'); img.src = m.image; img.alt = ''; card.appendChild(img); }
        if (m.by && (m.action === 'pick' || m.action === 'ban')) {
          const by = document.createElement('span'); by.className = 'vm-by';
          by.textContent = sideName(m.by); by.style.background = sideColor(m.by); card.appendChild(by);
        }
        const lbl = document.createElement('div'); lbl.className = 'vm-label';
        lbl.textContent = m.name + (m.action === 'decider' ? ' · ' + deciderWord : ''); card.appendChild(lbl);
        // Clicking an undecided map applies the current step.
        if (!m.action && v.turn) card.addEventListener('click', () => send('veto_action', { mapId: m._id }));
        else card.style.cursor = 'default';
        grid.appendChild(card);
      });
    }
  }
}

// ── Guided champion draft manager ───────────────────────────────────────────
let _draftGameInit = false;
function submitDraftPick() {
  const inp = el('draft-input'); if (!inp) return;
  const name = (inp.value || '').trim(); if (!name) return;
  send('draft_action', { name }); inp.value = '';
}
el('btn-draft-start')?.addEventListener('click', () => {
  send('draft_start', { game: el('draft-game')?.value || '', teamStart: el('draft-start')?.value || 'a', visible: true });
});
el('btn-draft-submit')?.addEventListener('click', submitDraftPick);
el('draft-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitDraftPick(); } });
el('btn-draft-undo')?.addEventListener('click', () => send('draft_undo', {}));
el('btn-draft-reset')?.addEventListener('click', () => send('draft_reset', {}));
el('btn-draft-show')?.addEventListener('click', () => send('draft_visible', { visible: true }));
el('btn-draft-hide')?.addEventListener('click', () => send('draft_visible', { visible: false }));
el('draft-game')?.addEventListener('change', () => renderDraftManager(currentState));

function renderDraftManager(data) {
  const sel = el('draft-game'); if (!sel) return;
  const dGames = data.draftGames || [];
  const games = data.games || {};
  if (!_draftGameInit && dGames.length) {
    sel.innerHTML = '';
    dGames.forEach(g => { const o = document.createElement('option'); o.value = g; o.textContent = (games[g] && games[g].name) || g; sel.appendChild(o); });
    if (dGames.includes(data.activeGame)) sel.value = data.activeGame;
    _draftGameInit = true;
  }
  const selGame = sel.value || dGames[0] || '';
  const blue = (data.teams?.blue?.name) || 'Blue';
  const orange = (data.teams?.orange?.name) || 'Orange';
  const sideName = (s) => s === 'b' ? orange : blue;
  const sideColor = (s) => s === 'b' ? (data.teams?.orange?.color || '#e97139') : (data.teams?.blue?.color || '#055fdb');
  const startSel = el('draft-start');
  if (startSel) { startSel.options[0].textContent = 'Blue side: ' + blue; startSel.options[1].textContent = 'Blue side: ' + orange; }

  // Typeahead champion list for the selected game.
  const dl = el('draft-champs');
  if (dl && dl.dataset.game !== selGame) {
    dl.dataset.game = selGame;
    dl.innerHTML = '';
    ((data.draftChampions && data.draftChampions[selGame]) || []).forEach(n => { const o = document.createElement('option'); o.value = n; dl.appendChild(o); });
  }

  const d = data.draft || {};
  const turnEl = el('draft-turn'); const board = el('draft-board'); const inp = el('draft-input');
  const active = Array.isArray(d.sequence) && d.sequence.length;

  if (turnEl) {
    if (!active) turnEl.textContent = 'Choose a game, then Start Draft.';
    else if (d.turn && d.turn.team) {
      const a = d.turn.action; const n = (d.ops || []).filter(o => o.by === d.turn.team && o.action === a).length + 1;
      turnEl.innerHTML = `<b style="color:${sideColor(d.turn.team)}">${sideName(d.turn.team)}</b> to <span class="${a}">${a.toUpperCase()}</span> (${a} ${n})`;
    } else turnEl.innerHTML = `<span class="done">Draft complete</span>`;
  }
  if (inp) inp.disabled = !active || !d.turn;

  if (board) {
    const sig = JSON.stringify({ ops: d.ops, turn: d.turn });
    if (board.dataset.sig !== sig) {
      board.dataset.sig = sig;
      board.innerHTML = '';
      ['a', 'b'].forEach(side => {
        const ops = (d.ops || []).filter(o => o.by === side);
        const bans = ops.filter(o => o.action === 'ban').map(o => o.name);
        const picks = ops.filter(o => o.action === 'pick').map(o => o.name);
        const turnAct = d.turn && d.turn.team === side ? d.turn.action : '';
        const col = document.createElement('div'); col.className = 'dm-side' + (side === 'b' ? ' red' : '');
        const rows = (label, arr, count, cls, act) => {
          let html = `<div style="color:${sideColor(side)}; font-weight:800; font-size:11px; letter-spacing:1px;">${label}</div><div class="dm-rows">`;
          for (let i = 0; i < count; i++) {
            const isActive = turnAct === act && i === arr.length;
            const txt = arr[i] || (isActive ? '▸ …' : '—');
            html += `<div class="${arr[i] ? cls : 'empty'}${isActive ? ' slot-active' : ''}">${txt}</div>`;
          }
          return html + '</div>';
        };
        col.innerHTML = `<h4 style="color:${sideColor(side)}">${sideName(side)}</h4>`
          + rows('Bans', bans, 5, 'b', 'ban') + '<div style="height:8px"></div>' + rows('Picks', picks, 5, '', 'pick');
        board.appendChild(col);
      });
    }
  }
}

// ── Overwatch 2 hero ban manager ────────────────────────────────────────────
const OW_HEROES_BY_ROLE = {
  tank:    ['D.Va','Doomfist','Hazard','Junker Queen','Mauga','Orisa','Ramattra','Reinhardt','Roadhog','Sigma','Winston','Wrecking Ball','Zarya'],
  damage:  ['Ashe','Bastion','Cassidy','Echo','Freja','Genji','Hanzo','Junkrat','Mei','Pharah','Reaper','Sojourn','Soldier: 76','Sombra','Symmetra','Torbjörn','Tracer','Venture','Widowmaker'],
  support: ['Ana','Baptiste','Brigitte','Illari','Juno','Kiriko','Lifeweaver','Lúcio','Mercy','Moira','Zenyatta']
};

// Flat list for searching: [{name, role, slug, img}]
const OW_ALL_HEROES = (function() {
  var out = [];
  Object.keys(OW_HEROES_BY_ROLE).forEach(function(role) {
    OW_HEROES_BY_ROLE[role].forEach(function(name) {
      var slug = name.toLowerCase()
        .replace(/ö/g,'o').replace(/ú/g,'u')
        .replace(/[.']/g,'').replace(/:\s*/g,'-')
        .replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
      out.push({ name: name, role: role, slug: slug, img: 'http://localhost:3000/assets/overwatch/heroes/' + slug + '.png' });
    });
  });
  return out;
}());

function owHeroSlug(n) {
  return (n||'').toLowerCase()
    .replace(/ö/g,'o').replace(/ú/g,'u')
    .replace(/[.']/g,'').replace(/:\s*/g,'-')
    .replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
}
function owHeroImgUrl(n) {
  var s = owHeroSlug(n);
  return s ? 'http://localhost:3000/assets/overwatch/heroes/' + s + '.png' : '';
}

// Current OW map index tracked from state (game.number - 1)
var _owCurMapIdx = 0;

// sid = 'a0','a1','b0','b1'
function owSetBanFromSearch(sid, hero) {
  var side = sid[0];
  var slot = parseInt(sid[1], 10);
  send('ow_ban_hero', { mapIdx: _owCurMapIdx, side: side, slot: slot, hero: hero, role: '' });
  owUpdateSearchPreview(sid, hero);
  var inp = el('ow-ban-input-' + sid);
  if (inp) inp.value = hero;
  owCloseDropdown(sid);
}

function owUpdateSearchPreview(sid, hero) {
  var prev = el('ow-ban-preview-' + sid);
  if (!prev) return;
  prev.innerHTML = hero ? '<img src="' + owHeroImgUrl(hero) + '" alt="' + hero + '">' : '';
}

function owCloseDropdown(sid) {
  var dd = el('ow-ban-dropdown-' + sid);
  if (dd) dd.classList.remove('open');
}

function owOpenDropdown(sid, query) {
  var dd = el('ow-ban-dropdown-' + sid);
  if (!dd) return;
  var q = (query || '').toLowerCase().trim();
  var matches = q ? OW_ALL_HEROES.filter(function(h) { return h.name.toLowerCase().includes(q); })
                  : OW_ALL_HEROES;
  if (!matches.length) { dd.classList.remove('open'); return; }
  dd.innerHTML = matches.map(function(h) {
    return '<div class="ow-hero-option" data-hero="' + h.name.replace(/"/g,'&quot;') + '" data-sid="' + sid + '">'
         + '<img src="' + h.img + '" alt="' + h.name + '" loading="lazy">'
         + '<span class="ow-hero-option-name">' + h.name + '</span>'
         + '<span class="ow-hero-option-role">' + h.role + '</span>'
         + '</div>';
  }).join('');
  dd.querySelectorAll('.ow-hero-option').forEach(function(opt) {
    opt.addEventListener('mousedown', function(e) {
      e.preventDefault();
      owSetBanFromSearch(this.dataset.sid, this.dataset.hero);
    });
  });
  dd.classList.add('open');
}

function owInitSearch(sid) {
  var inp = el('ow-ban-input-' + sid);
  if (!inp) return;
  inp.addEventListener('focus', function() { owOpenDropdown(sid, this.value); });
  inp.addEventListener('input', function() { owOpenDropdown(sid, this.value); });
  inp.addEventListener('blur',  function() { setTimeout(function() { owCloseDropdown(sid); }, 150); });
}
owInitSearch('a0');
owInitSearch('a1');
owInitSearch('b0');
owInitSearch('b1');

function owClearBan(sid) {
  var side = sid[0];
  var slot = parseInt(sid[1], 10);
  send('ow_ban_hero', { mapIdx: _owCurMapIdx, side: side, slot: slot, hero: '', role: '' });
  owUpdateSearchPreview(sid, '');
  var inp = el('ow-ban-input-' + sid); if (inp) inp.value = '';
}

// Game mode buttons
var OW_MODES = ['escort','hybrid','control','push','flashpoint','clash'];
OW_MODES.forEach(function(mode) {
  var btn = el('btn-ow-mode-' + mode);
  if (btn) btn.addEventListener('click', function() { send('ow_set_game_mode', { mode: mode }); });
});

var owMapLabelsToggle = el('ow-map-labels-toggle');
if (owMapLabelsToggle) {
  owMapLabelsToggle.addEventListener('change', function() {
    send('ow_set_map_labels', { show: this.checked });
  });
}

var OW_MODE_KEYS = ['escort','hybrid','control','push','flashpoint','clash'];

// Map Results — single delegated listener on the container; data-* attributes carry intent
(function() {
  var owResults = el('ow-map-results-rows');
  if (!owResults) return;
  owResults.addEventListener('click', function(e) {
    var btn = e.target.closest('button[data-map-idx]');
    if (!btn) return;
    var idx = parseInt(btn.dataset.mapIdx, 10);
    if (isNaN(idx)) return;
    if ('mode' in btn.dataset) {
      send('ow_set_map_mode', { mapIdx: idx, mode: btn.dataset.mode });
    } else if ('winner' in btn.dataset) {
      send('ow_set_map_winner', { mapIdx: idx, winner: btn.dataset.winner || null });
    }
  });
})();

el('btn-ow-ban-a0-clear')?.addEventListener('click', () => owClearBan('a0'));
el('btn-ow-ban-a1-clear')?.addEventListener('click', () => owClearBan('a1'));
el('btn-ow-ban-b0-clear')?.addEventListener('click', () => owClearBan('b0'));
el('btn-ow-ban-b1-clear')?.addEventListener('click', () => owClearBan('b1'));
el('btn-ow-show')?.addEventListener('click', () => send('ow_visible', { visible: true }));
el('btn-ow-hide')?.addEventListener('click', () => send('ow_visible', { visible: false }));
el('btn-ow-atk-a')?.addEventListener('click', () => send('ow_set_attack', { side: 'a' }));
el('btn-ow-atk-b')?.addEventListener('click', () => send('ow_set_attack', { side: 'b' }));
el('btn-ow-atk-clear')?.addEventListener('click', () => send('ow_set_attack', { side: null }));
el('ow-show-attack')?.addEventListener('change', function() {
  send('ow_show_attack', { visible: this.checked });
  var ctrl = el('ow-attack-controls');
  if (ctrl) { ctrl.style.opacity = this.checked ? '1' : '.35'; ctrl.style.pointerEvents = this.checked ? '' : 'none'; }
});

function owGetBanArr(bansByMap, idx, side) {
  var entry = (Array.isArray(bansByMap) ? bansByMap[idx] : null) || {};
  var v = entry[side];
  if (Array.isArray(v)) return [v[0] && v[0].hero || '', v[1] && v[1].hero || ''];
  if (v && v.hero) return [v.hero, ''];
  return ['', ''];
}

function renderOwBanManager(data) {
  var section = el('section-ow-bans');
  if (!section) return;
  var ow    = data.owMatch || {};
  var hasOW = !!(ow.visible || data.activeGame === 'overwatch');
  section.style.display = hasOW ? '' : 'none';
  if (!hasOW) return;
  var teams = data.teams  || {};
  var game  = data.game   || {};
  var nameA = (teams.blue   && teams.blue.name)   || 'Team A';
  var nameB = (teams.orange && teams.orange.name) || 'Team B';

  _owCurMapIdx = Math.max(0, (game.number || 1) - 1);

  var lblA = el('ow-ban-label-a'); if (lblA) lblA.textContent = nameA + ' — Hero Bans (Game ' + (game.number || 1) + ')';
  var lblB = el('ow-ban-label-b'); if (lblB) lblB.textContent = nameB + ' — Hero Bans (Game ' + (game.number || 1) + ')';

  // Game mode button highlight
  var curMode = ow.gameMode || 'control';
  OW_MODES.forEach(function(mode) {
    var btn = el('btn-ow-mode-' + mode);
    if (btn) btn.className = 'btn btn-sm' + (mode === curMode ? ' btn-primary' : ' btn-secondary');
  });

  // Map labels toggle
  var chkLabels = el('ow-map-labels-toggle');
  if (chkLabels) { var wantLabels = ow.showMapLabels !== false; if (chkLabels.checked !== wantLabels) chkLabels.checked = wantLabels; }

  // Map Results — sync winner buttons + mode icon active states
  var bestOf = data.bestOf || 5;
  var totalMaps = Math.ceil(bestOf / 2) * 2 - 1;
  var mapWinners = Array.isArray(ow.mapWinners) ? ow.mapWinners : [];
  var mapModes   = Array.isArray(ow.mapModes)   ? ow.mapModes   : [];
  for (var mi = 0; mi < 7; mi++) {
    var grRow = el('ow-gr-' + mi);
    if (!grRow) continue;
    grRow.style.display = mi < totalMaps ? '' : 'none';
    var winner   = mapWinners[mi] || null;
    var activeMode = mapModes[mi] || null;
    var grA = el('ow-gr-' + mi + '-a');
    var grB = el('ow-gr-' + mi + '-b');
    if (grA) { grA.textContent = winner === 'a' ? '✓ ' + nameA : nameA; grA.className = 'ow-win-btn' + (winner === 'a' ? ' winner-a' : ''); }
    if (grB) { grB.textContent = winner === 'b' ? '✓ ' + nameB : nameB; grB.className = 'ow-win-btn' + (winner === 'b' ? ' winner-b' : ''); }
    // Mode selectors — find by data attributes within this row
    var grEl = el('ow-gr-' + mi);
    if (grEl) {
      OW_MODE_KEYS.forEach(function(mode) {
        var mb = grEl.querySelector('[data-mode="' + mode + '"]');
        if (mb) mb.className = 'ow-mode-sel' + (activeMode === mode ? ' active' : '');
      });
    }
  }

  // Attack/defense toggle + button labels + highlight
  var showAtk = !!ow.showAttack;
  var chkAtk = el('ow-show-attack'); if (chkAtk && chkAtk.checked !== showAtk) chkAtk.checked = showAtk;
  var ctrl = el('ow-attack-controls');
  if (ctrl) { ctrl.style.opacity = showAtk ? '1' : '.35'; ctrl.style.pointerEvents = showAtk ? '' : 'none'; }
  var atkLblA = el('ow-atk-label-a'); if (atkLblA) atkLblA.textContent = nameA;
  var atkLblB = el('ow-atk-label-b'); if (atkLblB) atkLblB.textContent = nameB;
  var atkSide = ow.attackSide || null;
  var btnAtkA = el('btn-ow-atk-a'), btnAtkB = el('btn-ow-atk-b');
  if (btnAtkA) { btnAtkA.className = 'btn btn-sm' + (atkSide === 'a' ? ' btn-primary' : ''); }
  if (btnAtkB) { btnAtkB.className = 'btn btn-sm' + (atkSide === 'b' ? ' btn-primary' : ''); }

  var bansByMap = Array.isArray(ow.bansByMap) ? ow.bansByMap : [];
  ['a', 'b'].forEach(function(side) {
    var heroes = owGetBanArr(bansByMap, _owCurMapIdx, side);
    [0, 1].forEach(function(slot) {
      var sid = side + slot;
      var hero = heroes[slot] || '';
      owUpdateSearchPreview(sid, hero);
      var inp = el('ow-ban-input-' + sid);
      if (inp && document.activeElement !== inp) inp.value = hero;
    });
  });
}

// ── Scenes cockpit: On-Air control + source launcher ────────────────────────
const SCENE_BASE_URL = 'http://localhost:3000';

// Copy text to the clipboard with a brief "Copied!" flash on the button.
function copyText(text, btn) {
  const done = () => { if (btn) { const o = btn.dataset._o || btn.textContent; btn.dataset._o = o; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = o; }, 1200); } };
  const fallback = () => { try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); } catch (e) {} };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
  else fallback();
}
// Any button with data-copy="<input id>" copies that input's value.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]'); if (!btn) return;
  const input = el(btn.dataset.copy); if (!input) return;
  copyText(input.value, btn);
});

// Toggleable scenes: each drives a visibility flag in full_state via `msg`.
const ONAIR_SCENES = [
  { key: 'casters',   label: 'Casters / Desk',   msg: 'set_casters_visibility', path: 'casters.visible' },
  { key: 'break',     label: 'Break / Countdown', msg: 'set_break',             path: 'breakScreen.visible' },
  { key: 'winner',    label: 'Winner',           msg: 'set_winner',             path: 'winner.visible' },
  { key: 'intro',     label: 'Team Line-up',     msg: 'set_intro',              path: 'intro.visible' },
  { key: 'veto',      label: 'Map Veto',         msg: 'set_veto',               path: 'veto.visible' },
  { key: 'bracket',   label: 'Bracket',          msg: 'set_bracket_settings',   path: 'bracket.visible' },
  { key: 'ticker',    label: 'Ticker',           msg: 'set_ticker',             path: 'ticker.visible' },
  { key: 'spotlight', label: 'Player Spotlight', msg: 'set_spotlight',          path: 'spotlight.visible' },
  { key: 'banner',    label: 'Sponsor Banner',   msg: 'set_banner_visibility',  path: 'banner.visible' }
];

// All overlay browser sources, grouped (mirrors scenes.html).
const SCENE_SOURCES = [
  { group: 'In-Game HUD', items: [
    { name: 'Main Overlay (RL)', path: '/' },
    { name: 'RL HUD (Modern)', path: '/rl-hud.html' },
    { name: 'Live HUD (auto-game)', path: '/live.html' },
    { name: 'CS2 / CS:GO HUD', path: '/csgo.html' },
    { name: 'Series Scoreboard', path: '/series.html' },
    { name: 'Mini Station', path: '/ministation.html' },
    { name: 'Director Preview', path: '/director-preview.html' },
  ]},
  { group: 'Casters & Desk', items: [
    { name: 'Casters (grid)', path: '/casters.html' },
    { name: 'Duo Row', path: '/duorow.html' },
    { name: 'Trio Row', path: '/triorow.html' },
    { name: 'Duo (single cam)', path: '/duosinglecam.html' },
    { name: 'Trio Cam', path: '/triocam.html' },
    { name: 'Away / Full', path: '/awayfull.html' },
    { name: 'Analyst Desk', path: '/analystspecial.html' },
  ]},
  { group: 'Pre / Post / Breaks', items: [
    { name: 'Countdown', path: '/countdown.html' },
    { name: 'Winner', path: '/winner.html' },
    { name: 'Team Line-up', path: '/intro.html' },
    { name: 'Draft Screen', path: '/draft.html' },
  ]},
  { group: 'Bracket & Veto', items: [
    { name: 'Bracket', path: '/bracket.html' },
    { name: 'Map Veto', path: '/mapscreen.html' },
  ]},
  { group: 'Replays', items: [
    { name: 'Replay / Montage Player', path: '/replay-player.html' },
  ]},
  { group: 'Twitch Interactions', items: [
    { name: 'Twitch Alerts', path: '/twitch-alerts.html' },
    { name: 'Predictions', path: '/twitch-predictions.html' },
    { name: 'Giveaway Wheel', path: '/twitch-wheel.html' },
    { name: 'Mini-Games', path: '/twitch-minigames.html' },
  ]},
  { group: 'Stingers & Transitions', items: [
    { name: 'Transition (accent)', path: '/transition.html' },
    { name: 'Transition (solid)', path: '/transitionbgg.html' },
    { name: 'Replay Wipe', path: '/replay.html' },
  ]},
];

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function buildOnAirGrid() {
  const grid = el('onair-grid');
  if (!grid || grid.dataset.built) return;
  grid.dataset.built = '1';
  ONAIR_SCENES.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'onair-card';
    card.id = 'air-card-' + s.key;
    card.innerHTML = `
      <div>
        <div class="oc-label">${s.label}</div>
        <div class="oc-state" id="air-state-${s.key}">HIDDEN</div>
      </div>
      <label class="switch"><input type="checkbox" id="air-${s.key}"><span class="slider"></span></label>`;
    grid.appendChild(card);
    card.querySelector('#air-' + s.key).addEventListener('change', function () {
      send(s.msg, { visible: this.checked });
    });
  });
}

function buildSceneSourceList() {
  const wrap = el('scene-source-list');
  if (!wrap || wrap.dataset.built) return;
  wrap.dataset.built = '1';
  SCENE_SOURCES.forEach((g) => {
    const lbl = document.createElement('div');
    lbl.className = 'scene-src-group-label';
    lbl.textContent = g.group;
    wrap.appendChild(lbl);
    const grid = document.createElement('div');
    grid.className = 'scene-card-grid';
    g.items.forEach((it) => {
      const url = SCENE_BASE_URL + it.path;
      const previewUrl = url + (url.includes('?') ? '&' : '?') + 'preview=1&thumb=1';
      const card = document.createElement('div');
      card.className = 'scene-card';
      card.innerHTML = `
        <div class="scene-thumb"><iframe class="scene-thumb-frame" loading="lazy" scrolling="no" data-src="${previewUrl}"></iframe><span class="scene-thumb-block"></span></div>
        <div class="scene-card-body">
          <div class="scene-card-name">${it.name}</div>
          <div class="scene-card-acts">
            <button class="btn btn-primary btn-xs ss-edit">Edit HTML</button>
            <button class="btn btn-secondary btn-xs ss-open">Open</button>
            <button class="btn btn-ghost btn-xs ss-copy">Copy</button>
          </div>
        </div>`;
      card.querySelector('.ss-open').addEventListener('click', () => window.open(url, '_blank'));
      card.querySelector('.ss-edit').addEventListener('click', () => openSceneEditor(it.path, it.name));
      // Clicking the thumbnail opens a full preview in a new window.
      card.querySelector('.scene-thumb').addEventListener('click', () => window.open(previewUrl, '_blank'));
      const copyBtn = card.querySelector('.ss-copy');
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const done = () => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200); };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(done).catch(() => prompt('Copy URL:', url));
        else prompt('Copy URL:', url);
      });
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
  });
}

// Scene preview iframes each load a full overlay (WebSocket + animation loops),
// so we only let them run while the Scenes tab is open. Loading is staggered to
// avoid a burst locking up the main thread. After each frame loads we inject
// body.style.zoom so the 1920×1080 scene scales to fit the thumbnail box.
let _scenePreviewTimer = null;
function _injectThumbZoom(f) {
  try {
    var doc = f.contentDocument;
    if (!doc || !doc.body) return;
    var w = f.offsetWidth || f.parentElement && f.parentElement.offsetWidth || 320;
    doc.body.style.zoom = (w / 1920);
    doc.documentElement.style.overflow = 'hidden';
  } catch (e) {}
}
function loadScenePreviews() {
  if (_scenePreviewTimer) { clearTimeout(_scenePreviewTimer); _scenePreviewTimer = null; }
  const frames = Array.from(document.querySelectorAll('.scene-thumb-frame[data-src]'));
  let i = 0;
  const step = () => {
    if (i >= frames.length) { _scenePreviewTimer = null; return; }
    const f = frames[i++];
    if (!f.src) {
      f.addEventListener('load', function () { _injectThumbZoom(f); }, { once: true });
      f.src = f.dataset.src;
    }
    _scenePreviewTimer = setTimeout(step, 120);
  };
  step();
}
function unloadScenePreviews() {
  if (_scenePreviewTimer) { clearTimeout(_scenePreviewTimer); _scenePreviewTimer = null; }
  document.querySelectorAll('.scene-thumb-frame').forEach((f) => { if (f.src) f.removeAttribute('src'); });
}

// ── Scene HTML editor (code + live preview, backed by /api/overlay/*) ───────
let _seScene = null;        // { path, name }
let _seTimer = null;
function seStatus(msg, ok) { const s = el('se-status'); if (s) { s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)'); } }
// Render the edited HTML in the preview iframe. Inject a <base> so the scene's
// relative assets (scene.css, app.js, images) still resolve to the server.
function seRenderPreview() {
  const frame = el('se-preview'); const code = el('se-code');
  if (!frame || !code) return;
  let html = code.value;
  const baseTag = `<base href="${SCENE_BASE_URL}/">`;
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  else html = baseTag + html;
  frame.srcdoc = html;
}
async function openSceneEditor(path, name) {
  _seScene = { path, name };
  el('se-title').textContent = name || path;
  el('se-code').value = '';
  seStatus('Loading…');
  el('scene-editor-modal').style.display = 'flex';
  try {
    const r = await fetch(`${SCENE_BASE_URL}/api/overlay/source?path=${encodeURIComponent(path)}`);
    const d = await r.json();
    if (!d.ok) throw new Error(d.message || 'Load failed');
    el('se-code').value = d.content || '';
    seStatus(d.isOverride ? 'Editing your saved override.' : '');
    seRenderPreview();
  } catch (e) { seStatus(e.message || 'Could not load source.', false); }
}
function seClose() { el('scene-editor-modal').style.display = 'none'; _seScene = null; }
el('se-close')?.addEventListener('click', seClose);
el('se-refresh')?.addEventListener('click', seRenderPreview);
el('se-code')?.addEventListener('input', () => { clearTimeout(_seTimer); _seTimer = setTimeout(seRenderPreview, 500); });
el('se-save')?.addEventListener('click', async () => {
  if (!_seScene) return;
  seStatus('Saving…');
  try {
    const r = await fetch(`${SCENE_BASE_URL}/api/overlay/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: _seScene.path, content: el('se-code').value }) });
    const d = await r.json();
    if (!d.ok) throw new Error(d.message || 'Save failed');
    seStatus('Saved — the live browser source now uses your version.', true);
  } catch (e) { seStatus(e.message || 'Save failed.', false); }
});
el('se-revert')?.addEventListener('click', async () => {
  if (!_seScene || !confirm('Remove your override and restore the original scene?')) return;
  seStatus('Reverting…');
  try {
    const r = await fetch(`${SCENE_BASE_URL}/api/overlay/revert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: _seScene.path }) });
    const d = await r.json();
    if (!d.ok) throw new Error(d.message || 'Revert failed');
    // revert doesn't return the source — re-fetch the original to reload the editor.
    const sr = await fetch(`${SCENE_BASE_URL}/api/overlay/source?path=${encodeURIComponent(_seScene.path)}`);
    const sd = await sr.json();
    if (sd.ok) el('se-code').value = sd.content || '';
    seStatus('Reverted to the original.', true);
    seRenderPreview();
  } catch (e) { seStatus(e.message || 'Revert failed.', false); }
});

// Reflect live visibility into the toggles + card highlight.
function applyScenesCockpit(data) {
  renderCockpitStatus(data);
  populateCockpitSpotlight(data);
  ONAIR_SCENES.forEach((s) => {
    const on = !!getPath(data, s.path);
    const cb = el('air-' + s.key);
    if (cb && document.activeElement !== cb) cb.checked = on;
    const card = el('air-card-' + s.key);
    if (card) card.classList.toggle('live', on);
    const st = el('air-state-' + s.key);
    if (st) st.textContent = on ? 'SHOWN' : 'HIDDEN';
  });
}

document.querySelectorAll('.js-cut-all').forEach((btn) => {
  btn.addEventListener('click', () => ONAIR_SCENES.forEach((s) => send(s.msg, { visible: false })));
});

// ── "Go Live" triggers — one toggle per graphic that reflects what's ON AIR ──
// Each button shows the graphic's live state (green "On Air" when visible) and a
// single click flips it: live → hide, off → show with the row's current options.
const GOLIVE_TRIGGERS = [
  { toggle: 'ck-break-toggle',     state: 'breakScreen', msg: 'set_break',     show: () => breakPayloadFromTimer({ visible: true, title: el('ck-break-title')?.value || 'STARTING SOON' }) },
  { toggle: 'ck-winner-toggle',    state: 'winner',      msg: 'set_winner',    show: () => ({ visible: true, side: el('ck-winner-side')?.value || 'blue' }) },
  { toggle: 'ck-intro-toggle',     state: 'intro',       msg: 'set_intro',     show: () => ({ visible: true, side: el('ck-intro-side')?.value || 'blue' }) },
  { toggle: 'ck-spotlight-toggle', state: 'spotlight',   msg: 'set_spotlight', show: () => ({ visible: true, playerName: el('ck-spotlight-player')?.value || '' }) },
  { toggle: 'ck-veto-toggle',      state: 'veto',        msg: 'set_veto',      show: () => ({ visible: true }) },
];
GOLIVE_TRIGGERS.forEach((t) => {
  el(t.toggle)?.addEventListener('click', () => {
    const live = !!(currentState[t.state] && currentState[t.state].visible);
    send(t.msg, live ? { visible: false } : t.show());
  });
});
function renderGoLive(data) {
  let liveCount = 0;
  GOLIVE_TRIGGERS.forEach((t) => {
    const btn = el(t.toggle); if (!btn) return;
    const live = !!(data[t.state] && data[t.state].visible);
    if (live) liveCount++;
    const row = btn.closest('.gl-row');
    if (row) row.classList.toggle('live', live);
    btn.textContent = live ? '● On Air' : 'Go Live';
    btn.title = live ? 'Click to take off air' : 'Show this graphic';
  });
  const count = el('gl-live-count');
  if (count) count.textContent = liveCount ? `${liveCount} live` : '';
  const dot = el('qrail-golive-dot');
  if (dot) dot.classList.toggle('on', liveCount > 0);   // live indicator on the Go Live rail tab
  const view = data.view || 'hud';
  document.querySelectorAll('#gl-view-seg .gl-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
}
el('ck-view-scoreboard')?.addEventListener('click', () => send('force_scoreboard'));
el('ck-view-hud')?.addEventListener('click', () => send('force_hud'));

// ══════════════ Events tab — start.gg admin tournaments + sponsorship data ══════════════
const EV_API = 'http://localhost:3000/api/startgg';
let _evDetail = null;
let _evTournaments = [];
let _evFilter = 'upcoming';   // 'upcoming' | 'past' | 'all'
let _evSearch = '';
let _evMode = 'mine';         // 'mine' = my admin tournaments | 'search' = global start.gg search

function evStatus(msg, kind) {
  const s = el('ev-status'); if (!s) return;
  s.textContent = msg || '';
  s.className = 'ev-status' + (kind ? ' ev-' + kind : '');
}
function fmtEvDate(ts) {
  if (!ts) return '';
  try { return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; }
}
async function evPost(path, body) {
  const r = await fetch(EV_API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
async function evLoadTournaments() {
  const btn = el('ev-load'); if (btn) btn.disabled = true;
  evStatus('Loading your tournaments…');
  try {
    const data = await evPost('/my-tournaments', {});
    _evTournaments = data.tournaments || [];
    _evSearch = (el('ev-search')?.value || '').trim();   // box filters the loaded list in mine mode
    const toolbar = el('ev-toolbar'); if (toolbar) toolbar.style.display = '';
    applyEventsView();
    evStatus(_evTournaments.length ? '' : 'No tournaments found for this token — confirm you admin/staff events and your token is set in Settings → start.gg.');
  } catch (e) {
    evStatus(e.message || 'Failed to load. Check your start.gg token in Settings.', 'err');
  } finally { if (btn) btn.disabled = false; }
}
// Filter (upcoming/past/all) + name search + sort, then render. Default: upcoming,
// soonest tournament first → farthest. Past: most recent first.
function evStartTs(t) { return t.startAt || t.endAt || 0; }
function evIsUpcoming(t, now) { return (t.endAt || t.startAt || 0) >= now; }
function applyEventsView() {
  const now = Date.now() / 1000;
  const q = _evSearch.trim().toLowerCase();
  let list = _evTournaments.slice();
  if (q) list = list.filter((t) => (t.name || '').toLowerCase().includes(q) || (t.slug || '').toLowerCase().includes(q));

  const upAsc = (a, b) => (evStartTs(a) || Infinity) - (evStartTs(b) || Infinity);   // soonest first
  const pastDesc = (a, b) => evStartTs(b) - evStartTs(a);                             // most recent first
  if (_evFilter === 'upcoming') list = list.filter((t) => evIsUpcoming(t, now)).sort(upAsc);
  else if (_evFilter === 'past') list = list.filter((t) => !evIsUpcoming(t, now)).sort(pastDesc);
  else list = list.filter((t) => evIsUpcoming(t, now)).sort(upAsc)
    .concat(list.filter((t) => !evIsUpcoming(t, now)).sort(pastDesc));

  const cnt = el('ev-count');
  if (cnt) cnt.textContent = list.length + (list.length === 1 ? ' tournament' : ' tournaments');
  renderEventsGrid(list, now);
}
function evRelDate(ts, now) {
  if (!ts) return '';
  const days = Math.round((ts - now) / 86400);
  if (days === 0) return 'today';
  if (days > 0) return days === 1 ? 'tomorrow' : (days < 14 ? `in ${days} days` : (days < 60 ? `in ${Math.round(days / 7)} weeks` : `in ${Math.round(days / 30)} months`));
  const ago = -days;
  return ago === 1 ? 'yesterday' : (ago < 14 ? `${ago} days ago` : (ago < 60 ? `${Math.round(ago / 7)} weeks ago` : `${Math.round(ago / 30)} months ago`));
}
function renderEventsGrid(list, now) {
  const grid = el('ev-grid'); if (!grid) return;
  now = now || Date.now() / 1000;
  const sec = el('ev-detail-section'); if (sec) sec.style.display = 'none';
  grid.style.display = '';
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = `<div class="ev-empty" style="grid-column:1/-1;">${_evSearch ? 'No tournaments match your search.' : 'No ' + (_evFilter === 'all' ? '' : _evFilter + ' ') + 'tournaments.'}</div>`;
    return;
  }
  list.forEach((t) => {
    const past = !evIsUpcoming(t, now);
    const card = document.createElement('button');
    card.className = 'ev-card' + (past ? ' ev-card-past' : '');
    card.innerHTML = `<div class="ev-card-img"></div><div class="ev-card-body">
      <div class="ev-card-name"></div><div class="ev-card-meta"></div>
      <div class="ev-card-stats"><span class="ev-pill"></span><span class="ev-pill"></span></div></div>`;
    const img = card.querySelector('.ev-card-img');
    if (t.image) { const i = document.createElement('img'); i.src = t.image; i.alt = ''; img.appendChild(i); }
    else img.textContent = (t.name || '?').slice(0, 1).toUpperCase();
    card.querySelector('.ev-card-name').textContent = t.name || '(untitled)';
    const rel = evRelDate(evStartTs(t), now);
    card.querySelector('.ev-card-meta').textContent = [fmtEvDate(t.startAt), rel, [t.city, t.countryCode].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    const pills = card.querySelectorAll('.ev-pill');
    pills[0].textContent = (t.numAttendees || 0) + ' entrants';
    pills[1].textContent = (t.eventCount || 0) + ' events';
    card.addEventListener('click', () => evOpenDetail(t.slug));
    grid.appendChild(card);
  });
}
async function evOpenDetail(slug) {
  evStatus('Loading tournament…');
  try {
    const data = await evPost('/tournament-detail', { slug });
    _evDetail = data.detail;
    renderEventDetail(data.detail);
    evStatus('');
  } catch (e) { evStatus(e.message || 'Failed to load tournament.', 'err'); }
}
function renderEventDetail(d) {
  const grid = el('ev-grid'); if (grid) grid.style.display = 'none';
  const sec = el('ev-detail-section'); if (sec) sec.style.display = '';
  el('ev-detail-name').textContent = d.name || '';
  const s = d.summary || {};
  const dateRange = [fmtEvDate(s.startAt), fmtEvDate(s.endAt)].filter(Boolean);
  const stats = [
    ['Attendees', s.attendees || 0], ['Events', s.eventCount || 0],
    ['Total entrants', s.totalEntrants || 0], ['Players', s.uniquePlayers || 0],
    ['Games', s.gameCount || 0], ['Dates', dateRange.length ? dateRange.join(' – ') : '—'],
  ];
  const sg = el('ev-stat-grid'); sg.innerHTML = '';
  stats.forEach(([k, v]) => {
    const cell = document.createElement('div'); cell.className = 'ev-stat';
    cell.innerHTML = '<div class="ev-stat-v"></div><div class="ev-stat-k"></div>';
    cell.querySelector('.ev-stat-v').textContent = v;
    cell.querySelector('.ev-stat-k').textContent = k;
    sg.appendChild(cell);
  });
  el('ev-events-count').textContent = (d.events || []).length;
  const ev = el('ev-events-list'); ev.innerHTML = '';
  (d.events || []).forEach((e) => {
    const row = document.createElement('div'); row.className = 'ev-event-row';
    row.innerHTML = '<div class="ev-event-info"><div class="ev-event-name"></div><div class="ev-event-sub"></div></div>'
      + '<div class="ev-event-acts"><button class="btn btn-ghost btn-sm ev-teams-only" title="Import this event\'s teams into your library only">Teams only</button>'
      + '<button class="btn btn-primary btn-sm ev-activate" title="Import all teams + load the bracket and make this the live broadcast event">Set as broadcast event</button></div>';
    row.querySelector('.ev-event-name').textContent = e.name;
    row.querySelector('.ev-event-sub').textContent = [e.game, (e.numEntrants || 0) + ' entrants'].filter(Boolean).join(' · ');
    row.querySelector('.ev-activate').addEventListener('click', () => evActivateEvent(d, e));
    row.querySelector('.ev-teams-only').addEventListener('click', () => { send('import_startgg_teams', { eventSlug: e.slug }); evStatus(`Importing "${e.name}" teams into your library…`); });
    ev.appendChild(row);
  });
  renderEvPlayers(d.players || []);
  el('ev-sponsor-text').textContent = buildSponsorSummary(d);
}
function renderEvPlayers(players, filter) {
  el('ev-players-count').textContent = players.length;
  const list = el('ev-players-list'); list.innerHTML = '';
  const f = (filter || '').trim().toLowerCase();
  const shown = f ? players.filter((p) => (p.tag || '').toLowerCase().includes(f) || (p.name || '').toLowerCase().includes(f)) : players;
  if (!shown.length) { list.innerHTML = '<div class="ev-empty">No players</div>'; return; }
  shown.slice(0, 600).forEach((p) => {
    const row = document.createElement('div'); row.className = 'ev-player-row';
    row.textContent = p.tag || p.name || '(unknown)';
    list.appendChild(row);
  });
}
function buildSponsorSummary(d) {
  const s = d.summary || {};
  return [
    d.name,
    d.location ? 'Location: ' + d.location : null,
    'Dates: ' + ([fmtEvDate(s.startAt), fmtEvDate(s.endAt)].filter(Boolean).join(' – ') || '—'),
    'Attendees: ' + (s.attendees || 0),
    'Events: ' + (s.eventCount || 0) + ' (' + (s.totalEntrants || 0) + ' total entrants)',
    'Unique players listed: ' + (s.uniquePlayers || 0),
    'Games: ' + ((s.games || []).join(', ') || '—'),
    'start.gg: https://www.start.gg/' + (d.slug || ''),
  ].filter((x) => x != null).join('\n');
}
function evActivateEvent(d, e) {
  send('activate_startgg_event', { tournamentSlug: d.slug, eventSlug: e.slug, name: e.name, tournamentName: d.name });
  evStatus(`Activating "${e.name}" — importing teams + bracket and making it the live event…`, 'ok');
}
// Teams page — pull rosters straight from a start.gg event into the library.
el('btn-teams-startgg-pull')?.addEventListener('click', () => {
  const slug = (el('teams-startgg-slug')?.value || '').trim();
  const st = el('teams-startgg-status');
  if (!slug) { if (st) { st.textContent = 'Paste a start.gg event URL or slug first.'; st.style.color = '#f56565'; } return; }
  send('import_startgg_teams', { eventSlug: slug });
  if (st) { st.textContent = 'Importing teams from start.gg…'; st.style.color = 'var(--muted)'; }
});

// ── Events sub-nav (start.gg | Leagues) ───────────────────────────────────
document.querySelectorAll('#ev-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', function () {
  document.querySelectorAll('#ev-subnav .ev-subnav-btn').forEach((x) => x.classList.toggle('active', x === this));
  const t = this.dataset.evtab;
  const sg = el('ev-startgg-panel'), lg = el('ev-leagues-panel');
  if (sg) sg.style.display = t === 'startgg' ? '' : 'none';
  if (lg) lg.style.display = t === 'leagues' ? '' : 'none';
  if (t === 'leagues') lgRender();
}));

// ── Leagues (manual: team / free-agent / salary) ──────────────────────────
let lgLeagues = [];
let lgActiveId = null;
let _lgSaveTimer = null;
let _lgSig = '';
const lgUid = (p) => (p || 'id') + Math.random().toString(36).slice(2, 9);

function lgActive() { return lgLeagues.find((l) => l.id === lgActiveId) || null; }
function lgStatus(msg, ok) { const s = el('lg-status'); if (s) { s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)'); } }
function lgSave() { clearTimeout(_lgSaveTimer); _lgSaveTimer = setTimeout(() => send('set_leagues', { leagues: lgLeagues }), 400); }

function lgHydrate(leagues) {
  const incoming = Array.isArray(leagues) ? leagues : [];
  const sig = JSON.stringify(incoming);
  if (sig === _lgSig) return;                       // no change
  const panel = el('ev-leagues-panel');
  if (panel && panel.contains(document.activeElement)) return;   // don't clobber active edits
  _lgSig = sig;
  lgLeagues = incoming;
  if (lgActiveId && !lgLeagues.some((l) => l.id === lgActiveId)) lgActiveId = null;
  if (el('ev-leagues-panel') && el('ev-leagues-panel').style.display !== 'none') lgRender();
}
function lgGameOptions(sel) {
  const games = currentState.games || {};
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Game —</option>' + Object.keys(games).map((id) => `<option value="${id}">${games[id].name || id}</option>`).join('');
  if (cur) sel.value = cur;
}
function lgNewPlayer() { return { id: lgUid('pl'), name: '', role: '', salary: 0, stats: '' }; }
function lgNewTeam() { return { id: lgUid('tm'), name: '', logo: null, players: [] }; }
function lgNewLeague() {
  return { id: lgUid('lg'), name: 'New League', game: currentState.activeGame || '', type: 'team', season: '', salaryCap: 0, teams: [], freeAgents: [], standings: [], schedule: [] };
}

function lgRenderList() {
  const wrap = el('lg-list'); if (!wrap) return;
  wrap.innerHTML = lgLeagues.length
    ? lgLeagues.map((l) => `<button class="lg-list-item${l.id === lgActiveId ? ' active' : ''}" data-id="${l.id}">
        <span class="lg-list-name">${(l.name || 'League').replace(/</g, '&lt;')}</span>
        <span class="lg-list-sub">${l.type} · ${(l.teams || []).length} teams</span></button>`).join('')
    : '<div class="lg-empty" style="padding:14px;">No leagues yet.</div>';
  wrap.querySelectorAll('.lg-list-item').forEach((b) => b.addEventListener('click', () => { lgActiveId = b.dataset.id; lgRender(); }));
}
function lgRenderTeams() {
  const wrap = el('lg-teams'); const lg = lgActive(); if (!wrap || !lg) return;
  const isSalary = lg.type === 'salary';
  wrap.innerHTML = (lg.teams || []).map((tm) => `<div class="lg-team" data-tid="${tm.id}">
    <div class="lg-team-head">
      <input class="input-text lg-team-name" data-tid="${tm.id}" value="${(tm.name || '').replace(/"/g, '&quot;')}" placeholder="Team name">
      <button class="btn btn-ghost btn-xs lg-team-live" data-tid="${tm.id}" data-side="blue" title="Push to Blue">→ Blue</button>
      <button class="btn btn-ghost btn-xs lg-team-live" data-tid="${tm.id}" data-side="orange" title="Push to Orange">→ Orange</button>
      <button class="btn btn-ghost btn-xs lg-team-addpl" data-tid="${tm.id}">+ Player</button>
      <button class="lg-del lg-team-del" data-tid="${tm.id}" title="Remove team">×</button>
    </div>
    <div class="lg-players">${(tm.players || []).map((p) => `<div class="lg-player" data-pid="${p.id}">
      <input class="input-text lg-pl-name" data-tid="${tm.id}" data-pid="${p.id}" value="${(p.name || '').replace(/"/g, '&quot;')}" placeholder="Player">
      <input class="input-text lg-pl-role" data-tid="${tm.id}" data-pid="${p.id}" value="${(p.role || '').replace(/"/g, '&quot;')}" placeholder="Role">
      ${isSalary ? `<input type="number" class="input-text lg-pl-salary" data-tid="${tm.id}" data-pid="${p.id}" value="${p.salary || 0}" placeholder="Salary" style="width:90px;">` : ''}
      <input class="input-text lg-pl-stats" data-tid="${tm.id}" data-pid="${p.id}" value="${(p.stats || '').replace(/"/g, '&quot;')}" placeholder="Stats / notes">
      <button class="lg-del lg-pl-del" data-tid="${tm.id}" data-pid="${p.id}" title="Remove player">×</button>
    </div>`).join('')}</div>
  </div>`).join('') || '<div class="lg-empty">No teams yet.</div>';

  const onField = (cls, key, num) => wrap.querySelectorAll(cls).forEach((inp) => inp.addEventListener('change', () => {
    const tm = lg.teams.find((t) => t.id === inp.dataset.tid); if (!tm) return;
    if (inp.dataset.pid) { const p = tm.players.find((x) => x.id === inp.dataset.pid); if (p) p[key] = num ? (Number(inp.value) || 0) : inp.value.trim(); }
    else tm[key] = num ? (Number(inp.value) || 0) : inp.value.trim();
    lgSave(); if (key === 'salary') lgRenderStandings();
  }));
  onField('.lg-team-name', 'name');
  onField('.lg-pl-name', 'name'); onField('.lg-pl-role', 'role'); onField('.lg-pl-salary', 'salary', true); onField('.lg-pl-stats', 'stats');
  wrap.querySelectorAll('.lg-team-addpl').forEach((b) => b.addEventListener('click', () => { const tm = lg.teams.find((t) => t.id === b.dataset.tid); if (tm) { tm.players.push(lgNewPlayer()); lgRenderTeams(); lgSave(); } }));
  wrap.querySelectorAll('.lg-team-del').forEach((b) => b.addEventListener('click', () => { lg.teams = lg.teams.filter((t) => t.id !== b.dataset.tid); lgRenderTeams(); lgRenderStandings(); lgSave(); }));
  wrap.querySelectorAll('.lg-pl-del').forEach((b) => b.addEventListener('click', () => { const tm = lg.teams.find((t) => t.id === b.dataset.tid); if (tm) { tm.players = tm.players.filter((p) => p.id !== b.dataset.pid); lgRenderTeams(); lgSave(); } }));
  wrap.querySelectorAll('.lg-team-live').forEach((b) => b.addEventListener('click', () => {
    const tm = lg.teams.find((t) => t.id === b.dataset.tid); if (!tm) return;
    send('set_team', { side: b.dataset.side, name: tm.name || 'Team', logo: tm.logo || null, players: (tm.players || []).map((p) => ({ name: p.name, role: p.role })) });
    lgStatus(`${tm.name || 'Team'} → ${b.dataset.side}.`, true);
  }));
}
function lgRenderFreeAgents() {
  const sec = el('lg-fa-section'); const wrap = el('lg-freeagents'); const lg = lgActive(); if (!sec || !wrap || !lg) return;
  sec.style.display = (lg.type === 'freeagent') ? '' : 'none';
  if (lg.type !== 'freeagent') return;
  const isSalary = lg.type === 'salary';
  wrap.innerHTML = (lg.freeAgents || []).map((p) => `<div class="lg-player" data-pid="${p.id}">
    <input class="input-text lg-fa-name" data-pid="${p.id}" value="${(p.name || '').replace(/"/g, '&quot;')}" placeholder="Free agent">
    <input class="input-text lg-fa-role" data-pid="${p.id}" value="${(p.role || '').replace(/"/g, '&quot;')}" placeholder="Role">
    <input type="number" class="input-text lg-fa-salary" data-pid="${p.id}" value="${p.salary || 0}" placeholder="Asking" style="width:90px;">
    <input class="input-text lg-fa-stats" data-pid="${p.id}" value="${(p.stats || '').replace(/"/g, '&quot;')}" placeholder="Stats / notes">
    <button class="lg-del lg-fa-del" data-pid="${p.id}" title="Remove">×</button>
  </div>`).join('') || '<div class="lg-empty">No free agents listed.</div>';
  const bind = (cls, key, num) => wrap.querySelectorAll(cls).forEach((inp) => inp.addEventListener('change', () => { const p = lg.freeAgents.find((x) => x.id === inp.dataset.pid); if (p) { p[key] = num ? (Number(inp.value) || 0) : inp.value.trim(); lgSave(); } }));
  bind('.lg-fa-name', 'name'); bind('.lg-fa-role', 'role'); bind('.lg-fa-salary', 'salary', true); bind('.lg-fa-stats', 'stats');
  wrap.querySelectorAll('.lg-fa-del').forEach((b) => b.addEventListener('click', () => { lg.freeAgents = lg.freeAgents.filter((p) => p.id !== b.dataset.pid); lgRenderFreeAgents(); lgSave(); }));
}
function lgRenderStandings() {
  const wrap = el('lg-standings'); const lg = lgActive(); if (!wrap || !lg) return;
  // Standings rows mirror the team list; W/L are editable and persisted in standings[].
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  wrap.innerHTML = (lg.teams || []).length ? '<div class="lg-st-row lg-st-head"><span>Team</span><span>W</span><span>L</span><span>Pts</span></div>'
    + lg.teams.map((tm) => { const s = byId[tm.id] || { w: 0, l: 0, pts: 0 }; return `<div class="lg-st-row" data-tid="${tm.id}">
      <span class="lg-st-name">${(tm.name || 'Team').replace(/</g, '&lt;')}</span>
      <input type="number" class="input-text lg-st-w" data-tid="${tm.id}" value="${s.w || 0}" min="0">
      <input type="number" class="input-text lg-st-l" data-tid="${tm.id}" value="${s.l || 0}" min="0">
      <input type="number" class="input-text lg-st-pts" data-tid="${tm.id}" value="${s.pts || 0}">
    </div>`; }).join('') : '<div class="lg-empty">Add teams to track standings.</div>';
  const upd = (cls, key) => wrap.querySelectorAll(cls).forEach((inp) => inp.addEventListener('change', () => {
    let s = (lg.standings || []).find((x) => x.teamId === inp.dataset.tid);
    if (!s) { s = { teamId: inp.dataset.tid, w: 0, l: 0, pts: 0 }; lg.standings = lg.standings || []; lg.standings.push(s); }
    s[key] = Number(inp.value) || 0; lgSave();
  }));
  upd('.lg-st-w', 'w'); upd('.lg-st-l', 'l'); upd('.lg-st-pts', 'pts');
  // Salary-cap usage readout.
  const capEl = el('lg-cap-used');
  if (capEl) {
    if (lg.type === 'salary' && lg.salaryCap) {
      const used = (lg.teams || []).reduce((sum, tm) => sum + (tm.players || []).reduce((a, p) => a + (Number(p.salary) || 0), 0), 0);
      capEl.textContent = `Cap used: ${used.toLocaleString()} / ${Number(lg.salaryCap).toLocaleString()}`;
      capEl.style.color = used > lg.salaryCap ? '#f56565' : 'var(--muted)';
    } else capEl.textContent = '';
  }
}
function lgRender() {
  lgRenderList();
  const lg = lgActive();
  const empty = el('lg-empty'), detail = el('lg-detail');
  if (!lg) { if (empty) empty.style.display = ''; if (detail) detail.style.display = 'none'; return; }
  if (empty) empty.style.display = 'none'; if (detail) detail.style.display = '';
  const nameEl = el('lg-name'); if (nameEl && document.activeElement !== nameEl) nameEl.value = lg.name || '';
  const typeEl = el('lg-type'); if (typeEl) typeEl.value = lg.type || 'team';
  const gameEl = el('lg-game'); if (gameEl) { lgGameOptions(gameEl); gameEl.value = lg.game || ''; }
  const seasonEl = el('lg-season'); if (seasonEl && document.activeElement !== seasonEl) seasonEl.value = lg.season || '';
  const capWrap = document.querySelector('.lg-salary-field'); if (capWrap) capWrap.style.display = lg.type === 'salary' ? '' : 'none';
  const capEl = el('lg-cap'); if (capEl && document.activeElement !== capEl) capEl.value = lg.salaryCap || 0;
  lgRenderTeams(); lgRenderFreeAgents(); lgRenderStandings();
}

el('lg-new')?.addEventListener('click', () => { const l = lgNewLeague(); lgLeagues.push(l); lgActiveId = l.id; lgRender(); lgSave(); });
el('lg-delete')?.addEventListener('click', () => { const lg = lgActive(); if (!lg || !confirm('Delete this league?')) return; lgLeagues = lgLeagues.filter((l) => l.id !== lg.id); lgActiveId = null; lgRender(); lgSave(); });
el('lg-name')?.addEventListener('input', function () { const lg = lgActive(); if (lg) { lg.name = this.value; lgRenderList(); lgSave(); } });
el('lg-type')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.type = this.value; lgRender(); lgSave(); } });
el('lg-game')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.game = this.value; lgSave(); } });
el('lg-season')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.season = this.value.trim(); lgSave(); } });
el('lg-cap')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.salaryCap = Number(this.value) || 0; lgRenderStandings(); lgSave(); } });
el('lg-add-team')?.addEventListener('click', () => { const lg = lgActive(); if (lg) { lg.teams.push(lgNewTeam()); lgRenderTeams(); lgRenderStandings(); lgSave(); } });
el('lg-add-fa')?.addEventListener('click', () => { const lg = lgActive(); if (lg) { lg.freeAgents.push(lgNewPlayer()); lgRenderFreeAgents(); lgSave(); } });
el('lg-push-standings')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  const rows = (lg.teams || []).map((tm) => { const s = byId[tm.id] || { w: 0, l: 0 }; return { name: tm.name || 'Team', wins: s.w || 0, losses: s.l || 0 }; })
    .sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses) || b.wins - a.wins)
    .map((r, i) => ({ placement: i + 1, name: r.name, wins: r.wins, losses: r.losses }));
  send('set_manual_bracket', { type: 'ROUND_ROBIN', title: lg.name || 'Standings', standings: rows, visible: true });
  lgStatus('Standings pushed to the bracket overlay.', true);
});

function evSetMode(label) { const m = el('ev-mode'); if (m) m.textContent = label || ''; }
// Global search of ANY start.gg tournament (not just yours).
async function evSearchTournaments() {
  const q = (el('ev-search')?.value || '').trim();
  if (q.length < 2) { evStatus('Type at least 2 characters to search.', 'err'); return; }
  const btn = el('ev-search-btn'); if (btn) btn.disabled = true;
  evStatus('Searching start.gg…');
  try {
    const data = await evPost('/search-tournaments', { query: q, filter: _evFilter });
    _evMode = 'search';
    _evSearch = '';   // results already match the query — don't re-filter them by the same text
    _evTournaments = data.tournaments || [];
    el('ev-toolbar').style.display = '';
    evSetMode(`Search: "${q}"`);
    applyEventsView();
    evStatus(_evTournaments.length ? '' : `No tournaments matched "${q}".`);
  } catch (e) {
    evStatus(e.message || 'Search failed. Check your start.gg token in Settings.', 'err');
  } finally { if (btn) btn.disabled = false; }
}

el('ev-load')?.addEventListener('click', () => { _evMode = 'mine'; evSetMode('My tournaments'); evLoadTournaments(); });
el('ev-search-btn')?.addEventListener('click', evSearchTournaments);
el('ev-search')?.addEventListener('input', function () {
  // In "my tournaments" mode the box filters the loaded list live; in search mode it's the query (submit to search).
  if (_evMode === 'mine') { _evSearch = this.value; applyEventsView(); }
});
el('ev-search')?.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); evSearchTournaments(); } });
document.querySelectorAll('#ev-filter-seg .ev-seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    _evFilter = b.dataset.filter;
    document.querySelectorAll('#ev-filter-seg .ev-seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    // Re-query in search mode so the server date window matches; just re-filter in mine mode.
    if (_evMode === 'search' && _evTournaments.length) evSearchTournaments();
    else applyEventsView();
  });
});
el('ev-back')?.addEventListener('click', () => { _evDetail = null; const sec = el('ev-detail-section'); if (sec) sec.style.display = 'none'; const g = el('ev-grid'); if (g) g.style.display = ''; });
el('ev-players-filter')?.addEventListener('input', function () { if (_evDetail) renderEvPlayers(_evDetail.players || [], this.value); });
el('ev-copy-summary')?.addEventListener('click', () => {
  const txt = el('ev-sponsor-text')?.textContent || '';
  if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => evStatus('Summary copied.', 'ok')).catch(() => {});
});
document.querySelectorAll('.js-goto-settings').forEach((b) => b.addEventListener('click', () => document.querySelector('.tab-btn[data-tab="ajustes"]')?.click()));

// ── Cockpit status strip ────────────────────────────────────────────────────
function chip(id, label, ok) {
  const c = el(id); if (!c) return;
  c.textContent = label;
  c.classList.toggle('ok', ok === true);
  c.classList.toggle('bad', ok === false);
}

function activeGameFeatures(data) {
  const g = (data.games && data.games[data.activeGame]) || {};
  return g.features || [];
}

function onAirSummary(data) {
  const live = ONAIR_SCENES.filter((s) => !!getPath(data, s.path));
  if (!live.length) return { count: 0, label: 'On air: 0' };
  if (live.length === 1) return { count: 1, label: 'On air: ' + live[0].label };
  return { count: live.length, label: 'On air: ' + live.length };
}

function renderCockpitStatus(data) {
  chip('ck-chip-server', 'Server', true);  // we only get here via a live WS message
  const feats = activeGameFeatures(data);
  const rlChip = el('ck-chip-rl');
  if (rlChip) {
    const show = feats.includes('stats-api');
    rlChip.style.display = show ? '' : 'none';
    if (show) chip('ck-chip-rl', 'RL API', !!data.rlConnected);
  }
  const cs2Chip = el('ck-chip-cs2');
  if (cs2Chip) {
    const show = feats.includes('gsi');
    cs2Chip.style.display = show ? '' : 'none';
    if (show) chip('ck-chip-cs2', 'CS2', !!(data.csgo && data.csgo.connected));
  }
  const obs = data.obs || {};
  chip('ck-chip-obs', 'OBS', obs.connected ? true : (obs.enabled ? null : false));
  const sg = data.startgg || {};
  const sgOn = sg.enabled || sg.queueEnabled;
  chip('ck-chip-startgg', sg.connected ? 'start.gg' : (sgOn ? 'start.gg' : 'start.gg: off'),
    sg.connected ? true : (sgOn && sg.hasToken ? null : false));
  const ev = el('ck-chip-event'); if (ev) ev.textContent = data.eventName ? data.eventName.slice(0, 44) : 'No event';
  // PROGRAM = the live OBS program scene (what viewers actually see). Honest when OBS is down.
  const prog = el('ck-chip-program');
  if (prog) {
    let label, ok = false;
    if (obs.connected) { const s = obs.currentScene || ''; label = 'PROGRAM: ' + (s || '—'); ok = !!s; }
    else { label = obs.enabled ? 'PROGRAM: connecting…' : 'PROGRAM: OBS off'; }
    prog.textContent = label;
    prog.classList.toggle('ok', ok);
    prog.classList.toggle('live', ok);
    prog.title = obs.connected
      ? 'Live OBS program scene — what viewers see'
      : 'OBS not connected — program scene unknown. Overlay graphics only reach air via the OBS scene.';
  }

  const rlConn = el('rl-stats-conn');
  if (rlConn) {
    rlConn.textContent = data.rlConnected ? 'RL API: connected' : 'RL API: disconnected';
    rlConn.className = 'prod-chip' + (data.rlConnected ? ' ok' : ' bad');
  }
}

// Populate the cockpit spotlight player list (mirrors the Production spotlight select).
let _ckSpotKey = '';
function populateCockpitSpotlight(data) {
  const sel = el('ck-spotlight-player');
  if (!sel || document.activeElement === sel) return;
  const players = (data.players || []).map((p) => p.name).filter(Boolean);
  const key = players.join('|');
  if (key === _ckSpotKey) return;
  _ckSpotKey = key;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select player —</option>' +
    players.map((n) => `<option value="${n}">${n}</option>`).join('');
  if (players.includes(cur)) sel.value = cur;
}

// ── Global quick-action toolbar (fixed bottom bar) ──────────────────────────
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
  const sig = JSON.stringify({ scenes, connected, enabled: !!obs.enabled, pins, pinState, prog: obs.currentScene || '' });
  if (wrap && sig !== _qtSceneSig) {
    _qtSceneSig = sig;
    wrap.innerHTML = '';
    const hintEl = (txt) => { const h = document.createElement('span'); h.className = 'qt-hint'; h.textContent = txt; wrap.appendChild(h); };
    const sceneBtn = (sn, label, key) => {
      const b = document.createElement('button');
      b.className = 'qt-scene-btn';
      b.innerHTML = (key != null ? `<kbd class="qt-key">${key}</kbd>` : '') + label;
      b.title = `Cut to "${sn}"` + (key != null ? `  ·  hotkey ${key}` : '');
      b.dataset.scene = sn;
      b.addEventListener('click', () => send('obs_switch_scene', { sceneName: sn }));
      wrap.appendChild(b);
    };
    const actionBtn = (p, info) => {
      const b = document.createElement('button');
      b.className = `qt-scene-btn qt-act-btn qt-act-${p.t}` + (info.live ? ' live' : '');
      b.textContent = info.label;
      b.title = (p.t === 'overlay' ? 'Toggle overlay · ' : 'Set options & go live · ') + info.label;
      b.addEventListener('click', () => {
        // Triggers with options (team/player/countdown) open a config popover; everything else runs.
        if (p.t === 'trigger' && !info.live && typeof bbHasTriggerConfig === 'function' && bbHasTriggerConfig(p.k)) { bbOpenTriggerConfig(p.k, b); return; }
        const fresh = bbActionInfo(p); if (fresh) fresh.run();
      });
      wrap.appendChild(b);
    };
    const shown = new Set();
    let n = 0;
    if (obs.enabled && connected) {
      SCENE_CONTROL_MOMENTS.forEach((m) => {
        const sn = scenes[m.key]; if (!sn || shown.has('s:' + sn)) return;
        shown.add('s:' + sn); sceneBtn(sn, m.label, ++n);
      });
    }
    // Pinned actions (scenes + overlays + triggers).
    pins.forEach((p) => {
      if (p.t === 'scene') {
        if (!obs.enabled || !connected || shown.has('s:' + p.k)) return;
        shown.add('s:' + p.k); sceneBtn(p.k, p.k, ++n);
      } else {
        const info = bbActionInfo(p); if (!info || shown.has(p.t + ':' + p.k)) return;
        shown.add(p.t + ':' + p.k); actionBtn(p, info);
      }
    });
    if (!wrap.children.length) hintEl(obs.enabled ? (connected ? 'No scenes mapped — use ⚙ Customize' : 'OBS not connected') : 'OBS off — enable in Integrations → OBS');
  }
  // Highlight the SCENE button matching the live program scene (per tick, no rebuild).
  if (wrap) {
    const live = connected ? (obs.currentScene || '') : '';
    wrap.querySelectorAll('.qt-scene-btn[data-scene]').forEach((b) => {
      b.classList.toggle('live', !!live && b.dataset.scene === live);
    });
  }
}
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
function renderQrailScenes(data) {
  const wrap = el('qrail-scenes'); if (!wrap) return;
  const obs = data.obs || {};
  const list = Array.isArray(obs.availableScenes) ? obs.availableScenes : [];
  const connected = !!obs.connected;
  const enabled = !!obs.enabled;
  // Which scenes are mapped to a moment hotkey (1..9), so we can badge them.
  const hotkeyByScene = {};
  SCENE_CONTROL_MOMENTS.forEach((m, i) => { const sn = (obs.scenes || {})[m.key]; if (sn) hotkeyByScene[sn] = i + 1; });
  const sub = el('qrail-scenes-sub');
  if (sub) sub.textContent = connected ? String(list.length) : '';

  const sig = JSON.stringify({ list, connected, enabled, hk: hotkeyByScene });
  if (sig !== _qrailSceneSig) {
    _qrailSceneSig = sig;
    wrap.innerHTML = '';
    const hint = (t) => { const h = document.createElement('div'); h.className = 'qrail-scenes-hint'; h.textContent = t; wrap.appendChild(h); };
    if (!enabled) hint('OBS off — enable in Settings → OBS');
    else if (!connected) hint('Connecting to OBS… scenes appear here automatically');
    else if (!list.length) hint('No scenes found in this OBS profile');
    else list.forEach((name) => {
      const b = document.createElement('button');
      b.className = 'qrail-scene-btn';
      b.dataset.scene = name;
      const hk = hotkeyByScene[name];
      b.innerHTML = (hk ? `<kbd class="qt-key">${hk}</kbd>` : '<span class="qt-key qt-key-blank"></span>') +
        `<span class="qss-name"></span>`;
      b.querySelector('.qss-name').textContent = name;
      b.title = `Cut program to "${name}"`;
      b.addEventListener('click', () => send('obs_switch_scene', { sceneName: name }));
      wrap.appendChild(b);
    });
  }
  // Highlight the live program scene every tick (no rebuild).
  const live = connected ? (obs.currentScene || '') : '';
  wrap.querySelectorAll('.qrail-scene-btn').forEach((b) => b.classList.toggle('live', !!live && b.dataset.scene === live));
}

// ── Bottom bar: "Up Next" from the start.gg stream queue ────────────────────
function renderUpNext(data) {
  const box = el('bb-upnext'), txt = el('bb-upnext-text');
  if (!box || !txt) return;
  const sg = data.startgg || {};
  const queue = Array.isArray(sg.queue) ? sg.queue : [];
  if (!sg.queueEnabled || !queue.length) { box.style.display = 'none'; return; }
  // Prefer the next not-yet-finished set that isn't already live; else the live one.
  const next = queue.find((q) => !q.live && q.state !== 3) || queue.find((q) => q.live) || queue[0];
  if (!next) { box.style.display = 'none'; return; }
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
const _timer = { secs: 300, base: 300, running: false, handle: null };
let _timerEditing = false;
// Break/countdown payload that mirrors the timer's value AND running state.
function breakPayloadFromTimer(extra) {
  const base = _timer.running ? { seconds: _timer.secs } : { frozenSeconds: _timer.secs };
  return Object.assign(base, extra || {});
}
// Push the timer to the overlay countdown (the sidebar countdown display updates in paintTimer).
function syncTimerToOverlay() {
  send('set_break', breakPayloadFromTimer());
}
function fmtTimer(s) { const m = Math.floor(s / 60), ss = s % 60; return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'); }
function paintTimer() {
  const txt = fmtTimer(_timer.secs);
  // Green > 1:00, yellow ≤ 1:00, red ≤ 0:30.
  const color = _timer.secs <= 30 ? '#f56565' : (_timer.secs <= 60 ? '#fbbf24' : '#4ade80');
  const d = el('ptimer-display'); if (d) { if (!_timerEditing) d.textContent = txt; d.style.color = color; }
  const bt = el('ck-break-time'); if (bt) { if (!_timerEditing) bt.textContent = txt; bt.style.color = color; }   // live sidebar countdown
  const pd = el('ptp-display'); if (pd) { pd.textContent = txt; pd.style.color = color; }
  const box = el('prod-timer');
  if (box) { box.classList.toggle('running', _timer.running && _timer.secs > 10);
             box.classList.toggle('ending', _timer.running && _timer.secs <= 10); }
  const label = _timer.running ? 'Pause' : (_timer.secs === 0 ? 'Reset' : 'Start');
  const t = el('ptimer-toggle'); if (t) t.textContent = label;
  const pt = el('ptp-toggle'); if (pt) pt.textContent = label;
}
function tickTimer() {
  if (!_timer.running) return;
  _timer.secs = Math.max(0, _timer.secs - 1);
  if (_timer.secs === 0) { _timer.running = false; clearInterval(_timer.handle); _timer.handle = null; }
  paintTimer();
}
function adjustTimer(delta) {                 // ±seconds; works running or stopped
  _timer.secs = Math.max(0, Math.min(99 * 60 + 59, _timer.secs + delta));
  if (!_timer.running) _timer.base = _timer.secs;
  paintTimer(); syncTimerToOverlay();
}
function setTimerSecs(secs) {
  _timer.secs = Math.max(0, Math.min(99 * 60 + 59, Math.round(secs)));
  _timer.base = _timer.secs;
  if (_timer.running) { _timer.running = false; clearInterval(_timer.handle); _timer.handle = null; }
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
function parseTimeInput(v) {
  v = (v || '').trim(); if (!v) return null;
  if (v.includes(':')) { const [m, s] = v.split(':'); return (parseInt(m) || 0) * 60 + (parseInt(s) || 0); }
  const n = parseInt(v); return isNaN(n) ? null : n;
}
el('ptimer-toggle')?.addEventListener('click', toggleTimer);
el('ptp-toggle')?.addEventListener('click', toggleTimer);
el('ptp-reset')?.addEventListener('click', () => setTimerSecs(_timer.base || 300));
el('ptimer-open')?.addEventListener('click', () => {
  const pop = el('ptimer-pop'); if (!pop) return;
  pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
});
document.querySelectorAll('.ptp-adj').forEach((b) => b.addEventListener('click', () => adjustTimer(parseInt(b.dataset.adj))));
document.querySelectorAll('.ptp-preset').forEach((b) => b.addEventListener('click', () => setTimerSecs(parseInt(b.dataset.set))));
el('ptp-setbtn')?.addEventListener('click', () => { const s = parseTimeInput(el('ptp-set')?.value); if (s != null) { setTimerSecs(s); el('ptp-set').value = ''; } });
el('ptp-set')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('ptp-setbtn').click(); });

// Click-to-type editing for any timer display (bottom transport + sidebar countdown).
// Typing seconds or M:SS auto-formats to M:SS via parseTimeInput → setTimerSecs.
function attachTimerEdit(displayEl) {
  if (!displayEl) return;
  displayEl.style.cursor = 'text';
  let editOrig = '';
  const commit = () => {
    _timerEditing = false;
    const txt = (displayEl.textContent || '').trim();
    const s = parseTimeInput(txt);
    if (s != null && txt !== editOrig) setTimerSecs(s);   // apply only on an actual change
    else paintTimer();
  };
  displayEl.addEventListener('click', () => {
    if (_timerEditing) return;
    _timerEditing = true;
    editOrig = (displayEl.textContent || '').trim();
    displayEl.contentEditable = 'true';
    displayEl.focus();
    const r = document.createRange(); r.selectNodeContents(displayEl);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  });
  displayEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); displayEl.blur(); }
    else if (e.key === 'Escape') { _timerEditing = false; displayEl.blur(); paintTimer(); }
  });
  displayEl.addEventListener('blur', () => { displayEl.contentEditable = 'false'; if (_timerEditing) commit(); });
}
attachTimerEdit(el('ptimer-display'));
attachTimerEdit(el('ck-break-time'));
paintTimer();

// ── Commercial: cut to the dedicated Commercial OBS scene (no overlay graphic),
//    auto-returning to program when the ad video ends. Click again to return now.
el('btn-ad-break')?.addEventListener('click', () => {
  const obs = currentState.obs || {};
  if (!obs.connected) { flashHotkeyHint('Connect OBS first (Integrations).'); return; }
  const scenes = obs.scenes || {};
  if (!(scenes.commercial || scenes.break) && !(currentState.commercial && currentState.commercial.active)) {
    flashHotkeyHint('Map a Commercial scene in Integrations → OBS.');
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
  btn.textContent = on ? '■ End Commercial' : '⏸ Commercial';
}

// ── Reminders / run-of-show checklist (local, persisted in localStorage) ────
const REM_KEY = 'ne_reminders';
function loadReminders() { try { return JSON.parse(localStorage.getItem(REM_KEY) || '[]'); } catch { return []; } }
function saveReminders(list) { try { localStorage.setItem(REM_KEY, JSON.stringify(list)); } catch {} }
function renderReminders() {
  const wrap = el('reminders-list'); if (!wrap) return;
  const list = loadReminders();
  wrap.innerHTML = '';
  if (!list.length) { wrap.innerHTML = '<div class="reminders-empty">No reminders yet — add your run-of-show steps.</div>'; return; }
  list.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'reminder-item' + (r.done ? ' done' : '');
    row.innerHTML = '<input type="checkbox"><span></span><button title="Remove">✕</button>';
    row.querySelector('input').checked = !!r.done;
    row.querySelector('span').textContent = r.text;
    row.querySelector('input').addEventListener('change', function () { const l = loadReminders(); l[i].done = this.checked; saveReminders(l); renderReminders(); });
    row.querySelector('button').addEventListener('click', () => { const l = loadReminders(); l.splice(i, 1); saveReminders(l); renderReminders(); });
    wrap.appendChild(row);
  });
}
function addReminder() {
  const inp = el('reminders-input'); if (!inp) return;
  const text = inp.value.trim(); if (!text) return;
  const l = loadReminders(); l.push({ text, done: false }); saveReminders(l); inp.value = ''; renderReminders();
}
el('btn-reminders')?.addEventListener('click', () => {
  const pop = el('reminders-pop'); if (!pop) return;
  pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
  if (pop.style.display === 'block') renderReminders();
});
el('reminders-close')?.addEventListener('click', () => { const p = el('reminders-pop'); if (p) p.style.display = 'none'; });
el('reminders-add-btn')?.addEventListener('click', addReminder);
el('reminders-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addReminder(); });
// Checklist now lives in a rail tab (always present) — render the saved list on startup.
renderReminders();

// ── Preview dock — renders overlay scenes directly (no OBS WebSocket needed) ─
const PV_SIZES = [480, 640, 820];
let _pvSizeIdx = 0;
function pvBaseUrl() { return 'http://localhost:3000'; }
function pvBuildOptions() {
  const sel = el('pv-scene'); if (!sel || sel.dataset.built) return;
  sel.dataset.built = '1';
  // First option = the live OBS PROGRAM (screenshot poll); the rest render overlays directly.
  sel.innerHTML = '<optgroup label="OBS"><option value="__obs__">◉ OBS Program (live)</option></optgroup>' +
    SCENE_SOURCES.map((g) =>
      `<optgroup label="${g.group}">` + g.items.map((it) => `<option value="${it.path}">${it.name}</option>`).join('') + '</optgroup>'
    ).join('');
}
let _pvObsTimer = null;
function pvStopObs() { if (_pvObsTimer) { clearInterval(_pvObsTimer); _pvObsTimer = null; } }
function pvLoad() {
  const sel = el('pv-scene'), frame = el('pv-frame'), img = el('pv-obs-img'), msg = el('pv-obs-msg');
  if (!sel || !frame) return;
  if (sel.value === '__obs__') {
    // OBS program screenshot mode — poll a JPEG of the live program scene.
    frame.style.display = 'none';
    if (img) img.style.display = '';
    pvStopObs();
    const poll = () => send('obs_screenshot', { width: PV_SIZES[_pvSizeIdx] || 480 });
    poll();
    _pvObsTimer = setInterval(poll, 800);
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
  if (el('pv-scene')?.value !== '__obs__') return;
  const img = el('pv-obs-img'), msg = el('pv-obs-msg');
  if (d && d.ok && d.img) {
    if (img) { img.src = d.img; img.style.display = ''; }
    if (msg) msg.style.display = 'none';
  } else {
    if (img) img.style.display = 'none';
    if (msg) { msg.textContent = (d && d.reason) || 'OBS not connected'; msg.style.display = 'flex'; }
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
  window.open(pvBaseUrl() + (sel?.value || '/'), 'ne-preview', 'width=960,height=540');
});
el('pv-size')?.addEventListener('click', () => {
  _pvSizeIdx = (_pvSizeIdx + 1) % PV_SIZES.length;
  document.documentElement.style.setProperty('--pv-w', PV_SIZES[_pvSizeIdx] + 'px');
});

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
document.querySelectorAll('.js-goto-facecams').forEach((b) => b.addEventListener('click', () => document.querySelector('.tab-btn[data-tab="facecams"]')?.click()));

// ══════════════ Camera Feeds tab — Players / Casters / Gameplay / Settings ══════════════
const CF_OVERLAY_BASE = 'http://localhost:3000';
document.querySelectorAll('#cf-subnav .cf-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const cf = btn.dataset.cf;
    document.querySelectorAll('#cf-subnav .cf-tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#tab-facecams-content .cf-panel').forEach((p) => p.classList.toggle('active', p.id === 'cf-panel-' + cf));
    if (cf === 'settings') cfLoadVdoSettings();
  });
});

// ── VDO.ninja settings (localStorage; feeds every link the page builds) ──
const CF_VDO_KEY = 'ne_vdo_settings';
const CF_VDO_DEFAULTS = { base: 'https://vdo.ninja', room: '', viewParams: '', pushParams: '', cleanOutput: true, transparent: false, cover: true, volume: 100, bitrate: '', codec: '', buffer: '' };
function cfVdo() {
  try { return Object.assign({}, CF_VDO_DEFAULTS, JSON.parse(localStorage.getItem(CF_VDO_KEY) || '{}')); }
  catch { return Object.assign({}, CF_VDO_DEFAULTS); }
}
function cfLoadVdoSettings() {
  const v = cfVdo();
  const set = (id, val) => { const e = el(id); if (e && e.type !== 'checkbox') e.value = val; };
  set('cf-vdo-base', v.base); set('cf-vdo-room', v.room); set('cf-vdo-params', v.viewParams); set('cf-vdo-push', v.pushParams);
  if (el('cf-vdo-clean')) el('cf-vdo-clean').checked = v.cleanOutput !== false;
  if (el('cf-vdo-transparent')) el('cf-vdo-transparent').checked = !!v.transparent;
  if (el('cf-vdo-cover')) el('cf-vdo-cover').checked = v.cover !== false;
  if (el('cf-vdo-volume')) { el('cf-vdo-volume').value = v.volume ?? 100; const lab = el('cf-vdo-volume-val'); if (lab) lab.textContent = v.volume ?? 100; }
  set('cf-vdo-bitrate', v.bitrate || ''); set('cf-vdo-buffer', v.buffer || '');
  if (el('cf-vdo-codec')) el('cf-vdo-codec').value = v.codec || '';
}
el('cf-vdo-volume')?.addEventListener('input', function () { const lab = el('cf-vdo-volume-val'); if (lab) lab.textContent = this.value; });
el('cf-vdo-save')?.addEventListener('click', () => {
  const v = {
    base: (el('cf-vdo-base').value || 'https://vdo.ninja').trim().replace(/\/+$/, ''),
    room: el('cf-vdo-room').value.trim(),
    viewParams: el('cf-vdo-params').value.trim(),
    pushParams: el('cf-vdo-push').value.trim(),
    cleanOutput: !!el('cf-vdo-clean')?.checked,
    transparent: !!el('cf-vdo-transparent')?.checked,
    cover: !!el('cf-vdo-cover')?.checked,
    volume: parseInt(el('cf-vdo-volume')?.value, 10) || 0,
    bitrate: (el('cf-vdo-bitrate')?.value || '').trim(),
    codec: el('cf-vdo-codec')?.value || '',
    buffer: (el('cf-vdo-buffer')?.value || '').trim(),
  };
  try { localStorage.setItem(CF_VDO_KEY, JSON.stringify(v)); } catch {}
  const s = el('cf-vdo-status'); if (s) { s.textContent = 'Saved. New caster/share links will use these settings.'; s.className = 'ev-status ev-ok'; }
  renderCfShares();
  renderCfCasters(currentState);  // rebuild caster URLs with the new settings
});

// Build a clean VDO.ninja VIEW url from a stream id (or pass a full URL through unchanged).
function buildVdoView(idOrUrl, opts) {
  opts = opts || {};
  const v = cfVdo();
  let s = (idOrUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    // Pasted full URL → keep it, but still ensure it fills the frame + autoplays.
    if (v.cover !== false && !/[?&]cover\b/i.test(s)) s += '&cover';
    if (!/[?&]autostart\b/i.test(s)) s += '&autostart';
    return s;
  }
  const room = (opts.room || '').trim() || v.room;
  let url = `${v.base}/?view=${encodeURIComponent(s)}`;
  if (room) url += `&room=${encodeURIComponent(room)}`;
  if (v.cleanOutput !== false) url += '&cleanoutput';
  if (v.transparent) url += '&transparent';
  if (v.cover !== false) url += '&cover';   // fill the frame (crop to edges, no letterbox)
  url += '&autostart';                       // play immediately, no click needed
  const vol = (opts.volume != null && opts.volume !== '') ? opts.volume : v.volume;
  if (vol != null && vol !== '') url += `&volume=${Math.max(0, Math.min(100, parseInt(vol, 10) || 0))}`;
  if (v.codec) url += `&codec=${v.codec}`;
  if (v.bitrate) url += `&bitrate=${parseInt(v.bitrate, 10) || 0}`;
  if (v.buffer) url += `&buffer=${parseInt(v.buffer, 10) || 0}`;
  if (v.viewParams) url += (v.viewParams[0] === '&' ? '' : '&') + v.viewParams.replace(/^&/, '');
  return url;
}

// ── Casters: VDO links that feed the caster HTML scenes (shared via set_casters) ──
const CF_CASTER_SCENES = [
  { name: 'Casters', path: '/casters.html' }, { name: 'Duo Row', path: '/duorow.html' },
  { name: 'Trio Row', path: '/triorow.html' }, { name: 'Duo SingleCam', path: '/duosinglecam.html' },
  { name: 'Trio Cam', path: '/triocam.html' }, { name: 'Analyst Desk', path: '/analystspecial.html' },
  { name: 'Away / Standby', path: '/awayfull.html' },
];
function buildCfCasterScenes() {
  const grid = el('cf-caster-scenes'); if (!grid || grid.dataset.built) return;
  grid.dataset.built = '1';
  CF_CASTER_SCENES.forEach((s) => {
    const url = CF_OVERLAY_BASE + s.path;
    const card = document.createElement('div'); card.className = 'cf-scene-card';
    card.innerHTML = '<span class="cf-scene-name"></span><div class="cf-scene-acts"><button class="btn btn-secondary btn-sm">Open ↗</button><button class="btn btn-ghost btn-sm">Copy URL</button></div>';
    card.querySelector('.cf-scene-name').textContent = s.name;
    const [openBtn, copyBtn] = card.querySelectorAll('button');
    openBtn.addEventListener('click', () => window.open(url, '_blank'));
    copyBtn.addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(url); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 900); });
    grid.appendChild(card);
  });
}
const CF_SOCIALS = [['none', '— none —'], ['x', 'X / Twitter'], ['twitch', 'Twitch'], ['youtube', 'YouTube'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['kick', 'Kick'], ['discord', 'Discord'], ['facebook', 'Facebook'], ['other', 'Other / link']];
function cfCasterRow(c) {
  c = c || {};
  const row = document.createElement('div'); row.className = 'cf-caster-row';
  row.innerHTML = `
    <div class="cf-caster-line">
      <input type="text" class="input-text cf-c-name" placeholder="Caster name">
      <select class="input-select cf-c-social" title="Social platform shown on the caster card">${CF_SOCIALS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <input type="text" class="input-text cf-c-handle" placeholder="@handle (shown on card)">
    </div>
    <div class="cf-caster-line">
      <input type="text" class="input-text cf-c-id" placeholder="VDO stream ID (or paste full view URL)">
      <input type="text" class="input-text cf-c-room" placeholder="room (optional)">
      <label class="cf-c-vol" title="Audio volume for this caster (0–100)">vol<input type="number" class="input-text" min="0" max="100" step="5"></label>
      <button class="tp-del cf-c-del" title="Remove">×</button>
    </div>`;
  row.querySelector('.cf-c-name').value = c.name || '';
  row.querySelector('.cf-c-social').value = c.social || 'none';
  row.querySelector('.cf-c-handle').value = c.handle || '';
  // Prefer the stored stream id; fall back to a pasted full camUrl.
  row.querySelector('.cf-c-id').value = c.streamId || c.camUrl || '';
  row.querySelector('.cf-c-room').value = c.room || '';
  row.querySelector('.cf-c-vol input').value = (c.volume != null ? c.volume : 100);
  row.querySelector('.cf-c-del').addEventListener('click', () => row.remove());
  return row;
}
let _cfCastersSig = '';
function renderCfCasters(data) {
  const wrap = el('cf-casters-rows'); if (!wrap) return;
  const list = (data.casters && data.casters.list) || [];
  const v = cfVdo();
  const sig = JSON.stringify({ list: list.map((c) => [c.name, c.streamId, c.camUrl, c.room, c.volume, c.social, c.handle]), v });
  if (sig === _cfCastersSig) return;
  if (wrap.contains(document.activeElement)) return;
  _cfCastersSig = sig;
  wrap.innerHTML = '';
  (list.length ? list : [{}, {}]).forEach((c) => wrap.appendChild(cfCasterRow(c)));
}
el('cf-caster-add')?.addEventListener('click', () => { const w = el('cf-casters-rows'); if (w) w.appendChild(cfCasterRow({})); });
el('cf-casters-apply')?.addEventListener('click', () => {
  const existing = (currentState.casters && currentState.casters.list) || [];
  const rows = [...document.querySelectorAll('#cf-casters-rows .cf-caster-row')];
  const list = rows.map((r, i) => {
    const streamId = r.querySelector('.cf-c-id').value.trim();
    const room = r.querySelector('.cf-c-room').value.trim();
    const volume = Math.max(0, Math.min(100, parseInt(r.querySelector('.cf-c-vol input').value, 10) || 0));
    return {
      id: existing[i] && existing[i].id,
      name: r.querySelector('.cf-c-name').value.trim(),
      streamId, room, volume,
      camUrl: buildVdoView(streamId, { room, volume }),   // the clean view URL the scene embeds
      handle: r.querySelector('.cf-c-handle').value.trim(),
      social: r.querySelector('.cf-c-social').value || 'none',
      slot: i + 1,
    };
  }).filter((c) => c.name || c.streamId);
  send('set_casters', { list });   // server reads msg.data.list
  _cfCastersSig = '';
  const apply = el('cf-casters-apply'); if (apply) { apply.textContent = 'Applied ✓'; setTimeout(() => { apply.textContent = 'Apply to overlay'; }, 1100); }
});

// ── Gameplay: screenshare / observer push links ──
const CF_SHARES_KEY = 'ne_cf_shares';
function cfShares() { try { return JSON.parse(localStorage.getItem(CF_SHARES_KEY) || '[]'); } catch { return []; } }
function cfSaveShares(l) { try { localStorage.setItem(CF_SHARES_KEY, JSON.stringify(l)); } catch {} }
function cfSlug(s) { return ((s || 'feed').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12)) || 'feed'; }
function renderCfShares() {
  const wrap = el('cf-share-list'); if (!wrap) return;
  const v = cfVdo(); const list = cfShares();
  wrap.innerHTML = '';
  if (!list.length) { wrap.innerHTML = '<div class="ev-empty">No share links yet — create one above and send it to the player / observer.</div>'; return; }
  list.forEach((sh, idx) => {
    const room = v.room ? `&room=${encodeURIComponent(v.room)}` : '';
    let pushUrl = `${v.base}/?push=${sh.streamId}${room}&${sh.screen ? 'screenshare' : 'webcam'}`;
    if (v.codec) pushUrl += `&codec=${v.codec}`;
    if (v.bitrate) pushUrl += `&bitrate=${parseInt(v.bitrate, 10) || 0}`;
    if (v.pushParams) pushUrl += (v.pushParams[0] === '&' ? '' : '&') + v.pushParams.replace(/^&/, '');
    const viewUrl = buildVdoView(sh.streamId, {});
    const card = document.createElement('div'); card.className = 'cf-share-card';
    card.innerHTML = `<div class="cf-share-head"><span class="cf-share-label"></span><span class="cf-share-tag"></span><button class="tp-del" title="Remove">×</button></div>
      <div class="cf-share-line"><span>Send to them</span><input class="input-text" readonly><button class="btn btn-secondary btn-sm">Copy</button></div>
      <div class="cf-share-line"><span>OBS view</span><input class="input-text" readonly><button class="btn btn-secondary btn-sm">Copy</button></div>`;
    card.querySelector('.cf-share-label').textContent = sh.label || 'Feed';
    card.querySelector('.cf-share-tag').textContent = sh.screen ? 'screen' : 'cam';
    const lines = card.querySelectorAll('.cf-share-line');
    lines[0].querySelector('input').value = pushUrl;
    lines[1].querySelector('input').value = viewUrl;
    lines[0].querySelector('button').addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(pushUrl); });
    lines[1].querySelector('button').addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(viewUrl); });
    card.querySelector('.tp-del').addEventListener('click', () => { const l = cfShares(); l.splice(idx, 1); cfSaveShares(l); renderCfShares(); });
    wrap.appendChild(card);
  });
}
el('cf-share-create')?.addEventListener('click', () => {
  const label = (el('cf-share-label').value || '').trim();
  const screen = !!el('cf-share-screen').checked;
  const streamId = 'ne' + cfSlug(label) + Math.floor(Math.random() * 9000 + 1000);
  const l = cfShares(); l.unshift({ id: streamId, label, screen, streamId }); cfSaveShares(l);
  el('cf-share-label').value = '';
  renderCfShares();
});

// ── Gameplay: stream stations (start.gg) + station mini-HUD links ──
let _cfStationsSig = '';
function renderCfStations(data) {
  const wrap = el('cf-stations'); if (!wrap) return;
  const sg = data.startgg || {};
  const streams = sg.streams || [];
  const queue = sg.queue || [];
  const sub = el('cf-stations-sub'); if (sub) sub.textContent = streams.length ? String(streams.length) : '';
  const sig = JSON.stringify({ streams, q: queue.map((x) => [x.stream, x.teamA, x.teamB, x.live, x.scoreA, x.scoreB, x.round]) });
  if (sig === _cfStationsSig) return;
  _cfStationsSig = sig;
  wrap.innerHTML = '';
  if (!streams.length) { wrap.innerHTML = '<div class="ev-empty">No stream stations — enable the start.gg stream queue (Settings / Dashboard) to pull them.</div>'; return; }
  streams.forEach((name) => {
    const onIt = queue.filter((q) => q.stream === name);
    const liveSet = onIt.find((q) => q.live) || onIt[0];
    const hudUrl = `${CF_OVERLAY_BASE}/ministation.html?stream=${encodeURIComponent(name)}`;
    const card = document.createElement('div'); card.className = 'cf-station-card';
    card.innerHTML = `<div class="cf-station-head"><span class="cf-station-name"></span><span class="cf-station-live"></span></div>
      <div class="cf-station-match"></div>
      <div class="cf-station-acts"><button class="btn btn-secondary btn-sm">Open mini-HUD ↗</button><button class="btn btn-ghost btn-sm">Copy URL</button></div>`;
    card.querySelector('.cf-station-name').textContent = name;
    const liveTag = card.querySelector('.cf-station-live');
    if (liveSet && liveSet.live) { liveTag.textContent = 'LIVE'; liveTag.className = 'cf-station-live on'; }
    card.querySelector('.cf-station-match').textContent = liveSet
      ? `${liveSet.teamA || 'TBD'} vs ${liveSet.teamB || 'TBD'}` + ((liveSet.scoreA != null && liveSet.scoreB != null) ? `  (${liveSet.scoreA}–${liveSet.scoreB})` : '') + (liveSet.round ? '  · ' + liveSet.round : '')
      : 'No match queued';
    const [openBtn, copyBtn] = card.querySelectorAll('.cf-station-acts button');
    openBtn.addEventListener('click', () => window.open(hudUrl, '_blank'));
    copyBtn.addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(hudUrl); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 900); });
    wrap.appendChild(card);
  });
}

buildCfCasterScenes();
cfLoadVdoSettings();
renderCfShares();

// ── Dashboard: start.gg stream queue ────────────────────────────────────────
let _sggQueueSig = '';
function renderStreamQueue(data) {
  const sg = data.startgg || {};
  const tEl = el('sgg-tournament');
  if (tEl && document.activeElement !== tEl) {
    tEl.value = sg.tournamentSlug || el('input-startgg-tournament')?.value || '';
  }
  const qOn = el('sgg-queue-enabled');
  if (qOn && document.activeElement !== qOn) qOn.checked = !!sg.queueEnabled;
  const af = el('sgg-autofollow'); if (af && document.activeElement !== af) af.checked = !!sg.autoFollow;
  const status = el('sgg-status');
  if (status) {
    if (sg.connected && sg.queueFetchedAt) {
      status.textContent = `Connected · ${(sg.queue || []).length} queued set(s) · updated ${new Date(sg.queueFetchedAt).toLocaleTimeString()}`;
      status.style.color = '#9ae6b4';
    } else if (sg.lastError) {
      status.textContent = sg.lastError;
      status.style.color = '#f56565';
    } else if (sg.queueEnabled) {
      status.textContent = 'Polling stream queue…';
      status.style.color = 'var(--muted)';
    } else {
      status.textContent = 'Stream queue off — enable in Settings (token + tournament slug) then toggle on.';
      status.style.color = 'var(--muted)';
    }
  }

  const streams = sg.streams || [];
  const streamRow = el('sgg-stream-row');
  const streamSel = el('sgg-stream');
  if (streamRow) streamRow.style.display = streams.length > 1 ? '' : 'none';

  const queue = sg.queue || [];
  const sig = JSON.stringify({ queue, streams, sel: streamSel && streamSel.value, pushed: sg.lastPushedSetId });
  if (sig === _sggQueueSig) return;
  _sggQueueSig = sig;

  if (streamSel) {
    const cur = streamSel.value;
    streamSel.innerHTML = streams.map((s) => `<option value="${s}">${s}</option>`).join('');
    if (streams.includes(cur)) streamSel.value = cur;
    else if (sg.streamName && streams.includes(sg.streamName)) streamSel.value = sg.streamName;
  }
  const wantStream = (streamSel && streamSel.value) || '';
  const wrap = el('sgg-queue'); if (!wrap) return;
  const rows = queue.filter((s) => streams.length <= 1 || !wantStream || s.stream === wantStream);
  wrap.innerHTML = '';
  rows.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'sgg-row' + (s.live ? ' live' : '');
    const badge = s.live ? 'LIVE' : (s.state === 3 ? 'DONE' : 'NEXT');
    const onOverlay = s.setId === sg.lastPushedSetId;
    row.innerHTML = `
      <span class="sgg-badge">${badge}</span>
      <span class="sgg-match"><b></b> <span class="sgg-vs">vs</span> <b></b><span class="sgg-round"></span></span>
      <button class="btn btn-secondary btn-sm sgg-push"></button>`;
    const bolds = row.querySelectorAll('.sgg-match b');
    bolds[0].textContent = s.teamA; bolds[1].textContent = s.teamB;
    row.querySelector('.sgg-round').textContent = s.round || '';
    const btn = row.querySelector('.sgg-push');
    btn.textContent = onOverlay ? 'On overlay' : 'Push';
    btn.addEventListener('click', () => send('startgg_push_set', { setId: s.setId }));
    wrap.appendChild(row);
  });
}
el('sgg-load')?.addEventListener('click', () => send('startgg_fetch_queue', { tournamentSlug: (el('sgg-tournament')?.value || '').trim() }));
el('sgg-queue-enabled')?.addEventListener('change', function () {
  send('startgg_set_queue', { enabled: this.checked });
});
el('sgg-autofollow')?.addEventListener('change', function () {
  send('startgg_set_autofollow', { enabled: this.checked, streamName: el('sgg-stream')?.value || '' });
});
el('sgg-stream')?.addEventListener('change', function () {
  _sggQueueSig = '';
  if (el('sgg-autofollow')?.checked) send('startgg_set_autofollow', { enabled: true, streamName: this.value });
});

const CASTER_DESK_LAYOUTS = [
  { name: 'Casters (grid)', path: '/casters.html', desc: 'Flexible 1–4 cam grid' },
  { name: 'Duo Row', path: '/duorow.html', desc: '2 cams + scorebar' },
  { name: 'Trio Row', path: '/triorow.html', desc: '3 cams + scorebar' },
  { name: 'Duo (single cam)', path: '/duosinglecam.html', desc: '2 casters, 1 cam' },
  { name: 'Trio Cam', path: '/triocam.html', desc: '3 cams, cam-focused' },
  { name: 'Away / Full', path: '/awayfull.html', desc: 'Standby + cams' },
  { name: 'Analyst Desk', path: '/analystspecial.html', desc: 'Analyst layout' }
];

function renderCasterDeskSponsors(data) {
  const override = (data.deskFooter && Array.isArray(data.deskFooter.logos)) ? data.deskFooter.logos.filter(Boolean) : [];
  // "What airs" preview = override logos if any, else the active brand's desk sponsors.
  const wrap = el('caster-desk-sponsors');
  if (wrap) {
    wrap.innerHTML = '';
    const effective = override.length
      ? override.map(l => ({ logo: l, name: '' }))
      : ((data.brand && (data.brand.deskSponsors || data.brand.sponsors)) || []).filter(s => s && s.logo);
    if (!effective.length) {
      wrap.innerHTML = '<span class="field-hint">No desk logos yet — tag sponsors as “desk” on the active brand, or add override logos below.</span>';
    } else {
      effective.forEach(s => {
        const img = document.createElement('img');
        img.className = 'caster-sponsor-thumb'; img.src = s.logo; img.alt = s.name || 'Sponsor'; img.title = s.name || '';
        wrap.appendChild(img);
      });
    }
  }
  // Override management (remove individual logos).
  const ov = el('desk-footer-override');
  const badge = el('desk-footer-ov-badge');
  if (badge) badge.style.display = override.length ? '' : 'none';
  if (ov) {
    ov.innerHTML = '';
    if (!override.length) {
      ov.innerHTML = '<span class="field-hint" style="font-size:11px;">No override — using the active brand\'s desk sponsors.</span>';
    } else {
      override.forEach((logo, i) => {
        const cell = document.createElement('div'); cell.className = 'desk-ov-cell';
        const img = document.createElement('img'); img.className = 'caster-sponsor-thumb'; img.src = logo; img.alt = '';
        const del = document.createElement('button'); del.className = 'desk-ov-del'; del.type = 'button'; del.textContent = '×'; del.title = 'Remove logo';
        del.addEventListener('click', () => { const next = override.slice(); next.splice(i, 1); send('set_desk_footer', { logos: next }); });
        cell.appendChild(img); cell.appendChild(del); ov.appendChild(cell);
      });
    }
  }
}
el('input-desk-footer-logo')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f) return;
  const b64 = await fileToBase64(f); this.value = '';
  const cur = (currentState.deskFooter && currentState.deskFooter.logos) || [];
  send('set_desk_footer', { logos: cur.concat([b64]) });
});
el('btn-desk-footer-clear')?.addEventListener('click', () => send('set_desk_footer', { logos: [] }));

function buildCasterDeskLayouts() {
  const wrap = el('caster-desk-layouts');
  if (!wrap || wrap.dataset.built) return;
  wrap.dataset.built = '1';
  CASTER_DESK_LAYOUTS.forEach((it) => {
    const url = SCENE_BASE_URL + it.path;
    const row = document.createElement('div');
    row.className = 'caster-desk-layout-row';
    row.innerHTML = `
      <div class="cdl-info">
        <span class="cdl-name">${it.name}</span>
        <span class="cdl-desc">${it.desc}</span>
      </div>
      <span class="cdl-actions">
        <button type="button" class="btn btn-secondary btn-sm cdl-copy">Copy</button>
        <button type="button" class="btn btn-secondary btn-sm cdl-preview">Preview</button>
        <button type="button" class="btn btn-blue btn-sm cdl-open">Open</button>
      </span>`;
    row.querySelector('.cdl-open').addEventListener('click', () => window.open(url, '_blank'));
    row.querySelector('.cdl-preview').addEventListener('click', () => window.open(url + '?preview=1', '_blank'));
    const copyBtn = row.querySelector('.cdl-copy');
    copyBtn.addEventListener('click', () => {
      const done = () => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done).catch(() => prompt('Copy URL:', url));
      else prompt('Copy URL:', url);
    });
    wrap.appendChild(row);
  });
}

document.querySelectorAll('#btn-goto-brands, .js-goto-brands').forEach((b) => {
  b.addEventListener('click', () => document.querySelector('.tab-btn[data-tab="brands"]')?.click());
});

buildOnAirGrid();
buildSceneSourceList();
buildCasterDeskLayouts();

// ── Production: Player Spotlight ────────────────────────────────────────────
let _lastSpotlightPlayers = '';

function applySpotlightState(data) {
  const sp = data.spotlight || {};
  const cb = el('check-spotlight-visible');
  if (cb) cb.checked = !!sp.visible;

  const sel = el('select-spotlight-player');
  if (!sel) return;

  // Rebuild the player list only when it changes (keep the operator's choice)
  const players = (data.players || []).map(p => p.name).filter(Boolean);
  const key = players.join('|');
  if (key !== _lastSpotlightPlayers && document.activeElement !== sel) {
    _lastSpotlightPlayers = key;
    const current = sel.value || sp.playerName || '';
    sel.innerHTML = '<option value="">— Select player —</option>';
    players.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    if (current && players.includes(current)) sel.value = current;
    else if (sp.playerName) {
      // keep a chosen-but-offline player selectable
      const opt = document.createElement('option');
      opt.value = sp.playerName;
      opt.textContent = `${sp.playerName} (offline)`;
      sel.appendChild(opt);
      sel.value = sp.playerName;
    }
  }
}

el('btn-spotlight-apply').addEventListener('click', () => {
  send('set_spotlight', { visible: true, playerName: el('select-spotlight-player')?.value || '' });
  const cb = el('check-spotlight-visible');
  if (cb) cb.checked = true;
});

el('check-spotlight-visible').addEventListener('change', function() {
  send('set_spotlight', { visible: this.checked, playerName: el('select-spotlight-player')?.value || '' });
});

// ── Production: live status chips ───────────────────────────────────────────
function applyProdStatus(data) {
  const obs = data.obs || {};
  const bracket = data.bracket || {};

  const chipObs = el('chip-obs');
  if (chipObs) {
    const on = obs.enabled && obs.connected;
    chipObs.textContent = obs.enabled ? (on ? 'OBS: connected' : 'OBS: disconnected') : 'OBS: off';
    chipObs.className = 'prod-chip' + (on ? ' ok' : (obs.enabled ? ' warn' : ''));
  }

  const chipEvent = el('chip-event');
  if (chipEvent) {
    chipEvent.textContent = bracket.title ? `Event: ${bracket.title}` : 'No event loaded';
    chipEvent.className = 'prod-chip' + (bracket.title ? ' ok' : '');
  }

  const chipAir = el('chip-onair');
  if (chipAir) {
    let air = 'Game';
    if (data.breakScreen && data.breakScreen.visible) air = 'Break';
    else if (data.bracket && data.bracket.visible) air = 'Bracket';
    else if (data.casters && data.casters.visible) air = 'Casters';
    else if (data.view === 'scoreboard') air = 'Post-game';
    chipAir.textContent = `On air: ${air}`;
    chipAir.className = 'prod-chip';
  }
}

// ── Production: Ticker ──────────────────────────────────────────────────────
function getTickerMessages() {
  return (el('input-ticker-messages')?.value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

el('btn-ticker-apply').addEventListener('click', () => {
  send('set_ticker', {
    visible: !!el('check-ticker-visible')?.checked,
    messages: getTickerMessages(),
    speed: parseInt(el('input-ticker-speed')?.value) || 40
  });
});

el('check-ticker-visible').addEventListener('change', function() {
  send('set_ticker', { visible: this.checked });
});

function applyTickerState(data) {
  const ticker = data.ticker || {};
  const cb = el('check-ticker-visible');
  if (cb) cb.checked = !!ticker.visible;

  const msgEl = el('input-ticker-messages');
  if (msgEl && document.activeElement !== msgEl) {
    msgEl.value = (ticker.messages || []).join('\n');
  }
  const speedEl = el('input-ticker-speed');
  if (speedEl && document.activeElement !== speedEl) {
    speedEl.value = ticker.speed || 40;
  }
}

// ── Production: Bracket (Start.gg) ──────────────────────────────────────────
el('btn-load-event').addEventListener('click', () => {
  const slug = (el('input-bracket-slug')?.value || '').trim();
  if (!slug) { alert('Paste the Start.gg event URL or slug first.'); return; }
  send('set_bracket_settings', { eventSlug: slug });
  // Unified: import teams + bracket, set it active, and auto-open the Events tab on it.
  send('activate_startgg_event', { eventSlug: slug, tournamentSlug: slug.replace(/\/event\/.*$/, '') });
  const statusEl = el('bracket-status');
  if (statusEl) { statusEl.textContent = 'Loading event from Start.gg (teams, players, bracket)…'; statusEl.style.color = 'var(--muted)'; }
});

el('btn-bracket-fetch').addEventListener('click', () => {
  const slug = (el('input-bracket-slug')?.value || '').trim();
  send('set_bracket_settings', { eventSlug: slug });
  send('fetch_bracket', { eventSlug: slug });
  const statusEl = el('bracket-status');
  if (statusEl) { statusEl.textContent = 'Refreshing bracket from Start.gg…'; statusEl.style.color = 'var(--muted)'; }
});

el('btn-bracket-save').addEventListener('click', () => {
  send('set_bracket_settings', { eventSlug: (el('input-bracket-slug')?.value || '').trim() });
});

el('check-bracket-visible').addEventListener('change', function() {
  send('set_bracket_settings', { visible: this.checked });
});

el('btn-push-match').addEventListener('click', () => {
  const setId = el('select-current-match')?.value;
  if (!setId) { alert('Select a match first.'); return; }
  send('select_match', { setId });
});

let _lastMatchSig = '';
function populateMatchPicker(matches) {
  const wrap = el('match-picker-wrap');
  const sel = el('select-current-match');
  if (!wrap || !sel) return;

  const list = Array.isArray(matches) ? matches : [];
  wrap.style.display = list.length ? 'block' : 'none';

  // Only rebuild when the match list changes (avoids resetting the dropdown)
  const sig = JSON.stringify(list);
  if (sig === _lastMatchSig) return;
  _lastMatchSig = sig;

  const current = sel.value;
  const stateLabel = { 2: '● LIVE', 1: '○', 3: '✓' };
  sel.innerHTML = '<option value="">— Select match —</option>';
  list.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const flag = stateLabel[m.state] || '';
    opt.textContent = `${flag ? flag + ' ' : ''}${m.round}:  ${m.a}  vs  ${m.b}`;
    sel.appendChild(opt);
  });
  if (current && list.some((m) => m.id === current)) sel.value = current;
}

function applyBracketState(data) {
  const bracket = data.bracket || {};
  bbHydrate(bracket);   // restore a manual bracket into the builder once

  const slugEl = el('input-bracket-slug');
  if (slugEl && document.activeElement !== slugEl) slugEl.value = bracket.eventSlug || '';

  const cbVisible = el('check-bracket-visible');
  if (cbVisible) cbVisible.checked = !!bracket.visible;

  populateMatchPicker(bracket.matches);

  const statusEl = el('bracket-status');
  if (statusEl) {
    if (bracket.lastError) {
      statusEl.textContent = `Last error: ${bracket.lastError}`;
      statusEl.style.color = '#f56565';
    } else if (bracket.lastFetchAt) {
      const typeLabel = bracket.type ? bracket.type.replace(/_/g, ' ').toLowerCase() : 'bracket';
      const roundCount = (bracket.winners || []).length + (bracket.losers || []).length + (bracket.finals || []).length;
      const detail = (bracket.standings || []).length && !roundCount
        ? `${bracket.standings.length} team(s)`
        : `${roundCount} round(s)`;
      statusEl.textContent = `${bracket.title || 'Bracket'} (${typeLabel}) — ${detail}, updated ${new Date(bracket.lastFetchAt).toLocaleTimeString()}`;
      statusEl.style.color = '#9ae6b4';
    } else {
      statusEl.textContent = '';
    }
  }
}

function applyProductionState(data) {
  // Casters: only rebuild the editing buffer if the user isn't mid-edit on these rows
  const castersWrap = el('casters-rows');
  const editingCasters = castersWrap && castersWrap.contains(document.activeElement);
  if (!editingCasters) {
    castersDraft = (data.casters?.list || []).map((c, idx) => ({
      id: c.id || makeCasterId(),
      name: c.name || '',
      handle: c.handle || '',
      camUrl: c.camUrl || '',
      slot: Number(c.slot) >= 1 && Number(c.slot) <= 4 ? Number(c.slot) : idx + 1,
      social: c.social || 'none'
    }));
    if (castersDraft.length === 0 && !_castersInited) {
      castersDraft = [{ id: makeCasterId(), name: '', handle: '', camUrl: '', slot: 1, social: 'none' }];
    }
    renderCasterRows();
  }
  _castersInited = true;

  const ltInp = el('input-caster-lower-third');
  if (ltInp && document.activeElement !== ltInp) {
    castersLowerThirdDraft = data.casters?.lowerThird || '';
    ltInp.value = castersLowerThirdDraft;
  }

  const cbCasters = el('check-casters-visible');
  if (cbCasters) cbCasters.checked = !!data.casters?.visible;

  // Break
  const brk = data.breakScreen || {};
  const presetSel = el('select-break-preset');
  const titleInput = el('input-break-title');
  const msgInput = el('input-break-message');
  if (presetSel && document.activeElement !== presetSel &&
      titleInput && document.activeElement !== titleInput) {
    const presets = Array.from(presetSel.options).map(o => o.value);
    if (brk.title && presets.includes(brk.title)) {
      presetSel.value = brk.title;
      el('break-custom-title-row').style.display = 'none';
    } else if (brk.title) {
      presetSel.value = '__custom__';
      el('break-custom-title-row').style.display = '';
      titleInput.value = brk.title;
    }
  }
  if (msgInput && document.activeElement !== msgInput) {
    msgInput.value = brk.message || '';
  }

  const statusEl = el('break-status');
  if (statusEl) {
    if (brk.visible) {
      let txt = `● LIVE — "${brk.title || ''}"`;
      if (brk.endsAt) {
        const remaining = Math.max(0, Math.round((brk.endsAt - Date.now()) / 1000));
        txt += ` · countdown ~${Math.ceil(remaining / 60)} min`;
      }
      statusEl.textContent = txt;
      statusEl.style.color = '#f56565';
    } else {
      statusEl.textContent = 'Break is hidden.';
      statusEl.style.color = 'var(--muted)';
    }
  }
}

// ── Game & overlay design ───────────────────────────────────────────────────
let _lastGamesSig = '';

function fillGameSelect(sel, games) {
  if (!sel) return;
  sel.innerHTML = '';
  Object.values(games).forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name + (g.comingSoon ? ' (preview)' : '');
    sel.appendChild(opt);
  });
}

// Header game picker is a custom dropdown (native <select> can't show logos).
function gameLogoSrc(g) { return g && g.logo ? `../assets/${g.logo}` : '../assets/rl.png'; }
function renderGameHeaderDD(games, activeId) {
  const trig = el('game-dd-trigger'), menu = el('game-dd-menu');
  if (!trig || !menu) return;
  const active = games[activeId];
  const tLogo = el('game-dd-logo'), tName = el('game-dd-name');
  if (tLogo) tLogo.src = gameLogoSrc(active);
  if (tName) tName.textContent = active ? (active.name + (active.comingSoon ? ' (preview)' : '')) : '—';
  const sig = JSON.stringify([Object.keys(games), activeId]);   // rebuild list only when it changes
  if (menu.dataset.sig === sig) return;
  menu.dataset.sig = sig;
  menu.innerHTML = '';
  Object.values(games).forEach((g) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'game-dd-item' + (g.id === activeId ? ' active' : '');
    item.dataset.gameId = g.id;
    item.setAttribute('role', 'option');
    item.innerHTML = `<img class="game-dd-logo" src="${gameLogoSrc(g)}" alt=""><span>${g.name}${g.comingSoon ? ' (preview)' : ''}</span>`;
    item.addEventListener('click', () => { closeGameHeaderDD(); if (g.id !== currentState.activeGame) onGameSelectChange(g.id); });
    menu.appendChild(item);
  });
}
function openGameHeaderDD() { const m = el('game-dd-menu'); if (!m) return; m.hidden = false; el('game-dd-trigger')?.setAttribute('aria-expanded', 'true'); el('game-header-dd')?.classList.add('open'); }
function closeGameHeaderDD() { const m = el('game-dd-menu'); if (!m) return; m.hidden = true; el('game-dd-trigger')?.setAttribute('aria-expanded', 'false'); el('game-header-dd')?.classList.remove('open'); }
el('game-dd-trigger')?.addEventListener('click', (e) => { e.stopPropagation(); const m = el('game-dd-menu'); if (m && m.hidden) openGameHeaderDD(); else closeGameHeaderDD(); });
document.addEventListener('click', (e) => { if (!el('game-header-dd')?.contains(e.target)) closeGameHeaderDD(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGameHeaderDD(); });

function fillDesignSelect(sel, designs, themeId) {
  if (!sel) return;
  sel.innerHTML = '';
  designs.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });
  if (document.activeElement !== sel) sel.value = themeId || 'default';
}

function renderGameSwitcher(data) {
  const grid = el('game-switcher-grid');
  if (!grid) return;
  const games = data.games || {};
  const sig = JSON.stringify([Object.keys(games), data.activeGame]);
  if (grid.dataset.sig === sig) {
    grid.querySelectorAll('.game-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.gameId === data.activeGame);
    });
    return;
  }
  grid.dataset.sig = sig;
  grid.innerHTML = '';
  Object.values(games).forEach((g) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'game-card' + (g.id === data.activeGame ? ' active' : '');
    card.dataset.gameId = g.id;
    card.title = g.name;                       // name lives in the tooltip — logos only on the card
    const logo = g.logo ? `../assets/${g.logo}` : '../assets/rl.png';
    card.innerHTML = `<img src="${logo}" alt="${g.name}">`;
    card.addEventListener('click', () => {
      if (g.id !== currentState.activeGame) send('set_active_game', { game: g.id });
    });
    grid.appendChild(card);
  });

  const active = games[data.activeGame];
  const feedNote = el('dash-game-feed-note');
  if (feedNote) {
    const layout = data.overlayLayout;
    const layoutName = layout && layout.name ? layout.name : '';
    const path = data.activeOverlay != null ? data.activeOverlay : '';
    const feats = (active && active.features) || [];
    const parts = [];
    if (layoutName) parts.push('HUD: ' + layoutName);
    if (path) parts.push('http://localhost:3000' + (path === '/' ? '' : path));
    if (feats.includes('stats-api')) parts.push('RL Stats API :49123');
    if (feats.includes('gsi')) parts.push('CS2 GSI');
    if (feats.includes('director')) parts.push('AI Director');
    feedNote.textContent = parts.join(' · ');
  }
  const dashLink = el('dash-overlay-link');
  if (dashLink) {
    const path = data.activeOverlay != null ? data.activeOverlay : (active && active.overlay) || '/';
    dashLink.href = 'http://localhost:3000' + (path === '/' ? '' : path);
  }
}

function applyGameDesignState(data) {
  const games = data.games || {};
  const gameSel = el('select-game');
  const designSel = el('select-design');
  const gameHeader = el('select-game-header');
  const designHeader = el('select-design-header');
  const gameDash = el('select-game-dashboard');
  const designDash = el('select-design-dashboard');

  const sig = JSON.stringify(Object.keys(games));
  if (sig !== _lastGamesSig) {
    _lastGamesSig = sig;
    [gameSel, gameHeader, gameDash].forEach((s) => fillGameSelect(s, games));
  }

  const activeId = data.activeGame || 'rocket-league';
  [gameSel, gameHeader, gameDash].forEach((s) => {
    if (s && document.activeElement !== s) s.value = activeId;
  });

  renderGameHeaderDD(games, activeId);

  const active = games[activeId];
  const designs = (active && active.themes) || [];
  const theme = data.theme || 'default';
  const designKey = JSON.stringify([activeId, designs.map((t) => t.id), theme]);

  [designSel, designHeader, designDash].forEach((s) => {
    if (!s) return;
    if (s.dataset.key !== designKey) {
      s.dataset.key = designKey;
      fillDesignSelect(s, designs, theme);
    } else if (document.activeElement !== s) {
      s.value = theme;
    }
  });

  const note = el('game-overlay-note');
  if (note) {
    const layout = data.overlayLayout;
    const path = data.activeOverlay != null ? data.activeOverlay : (layout && layout.path) || (active && active.overlay) || '';
    if (path) {
      note.textContent = `OBS browser source: http://localhost:3000${path === '/' ? '' : path}` +
        (layout && layout.name ? ` (${layout.name})` : '');
    } else {
      note.textContent = 'No dedicated in-game HUD yet — use Production browser sources (countdown, casters, bracket).';
    }
  }

  renderGameSwitcher(data);
}

function onGameSelectChange(gameId) {
  send('set_active_game', { game: gameId });
  ['select-game', 'select-game-header', 'select-game-dashboard'].forEach((id) => {
    const s = el(id);
    if (s && s.value !== gameId) s.value = gameId;
  });
}

function onDesignSelectChange(themeId) {
  send('set_theme', { theme: themeId });
  ['select-design', 'select-design-header', 'select-design-dashboard'].forEach((id) => {
    const s = el(id);
    if (s && s.value !== themeId) s.value = themeId;
  });
}

['select-game', 'select-game-header', 'select-game-dashboard'].forEach((id) => {
  el(id)?.addEventListener('change', function() { onGameSelectChange(this.value); });
});
['select-design', 'select-design-header', 'select-design-dashboard'].forEach((id) => {
  el(id)?.addEventListener('change', function() { onDesignSelectChange(this.value); });
});

// ── Custom overlay URL manager ──────────────────────────────────────────────
let _customOlGamesFilled = false;
function renderCustomOverlayManager(data) {
  const games = data.games || {};

  // Populate the game selector once
  const gameSel = el('custom-ol-game');
  if (gameSel && !_customOlGamesFilled) {
    _customOlGamesFilled = true;
    Object.values(games).sort((a, b) => a.name.localeCompare(b.name)).forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id; o.textContent = g.name;
      gameSel.appendChild(o);
    });
  }

  const list = el('custom-overlays-list');
  const empty = el('custom-overlays-empty');
  if (!list) return;

  const customLayouts = data.customOverlayLayouts || {};
  const items = [];
  Object.keys(customLayouts).forEach((gameId) => {
    (customLayouts[gameId] || []).forEach((ol) => {
      items.push({ ...ol, gameId, gameName: (games[gameId] || {}).name || gameId });
    });
  });

  const sig = items.map((i) => i.id + '|' + i.name + '|' + i.path).join('~');
  if (list.dataset.cosig === sig) return;
  list.dataset.cosig = sig;
  list.querySelectorAll('.custom-ol-item').forEach((i) => i.remove());
  if (empty) empty.style.display = items.length ? 'none' : '';

  items.forEach((ol) => {
    const item = document.createElement('div');
    item.className = 'custom-ol-item preset-item';

    const label = document.createElement('div');
    label.className = 'preset-name';
    label.textContent = `${ol.gameName} — ${ol.name}`;
    const sub = document.createElement('span');
    sub.style.cssText = 'font-size:11px;color:var(--muted);display:block;margin-top:2px;';
    sub.textContent = ol.path;
    label.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const renBtn = document.createElement('button');
    renBtn.className = 'btn btn-secondary btn-sm';
    renBtn.textContent = 'Rename';
    renBtn.addEventListener('click', () => {
      const n = window.prompt('New name for this overlay:', ol.name);
      if (n && n.trim()) send('manage_custom_overlay', { action: 'rename', gameId: ol.gameId, overlayId: ol.id, name: n.trim() });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.title = 'Remove overlay';
    delBtn.addEventListener('click', async () => {
      const ok = await customConfirm('Remove Overlay', `Remove "${ol.name}" (${ol.gameName})?`, 'Remove');
      if (ok) send('manage_custom_overlay', { action: 'remove', gameId: ol.gameId, overlayId: ol.id });
    });

    actions.append(renBtn, delBtn);
    item.append(label, actions);
    list.appendChild(item);
  });
}

el('btn-custom-ol-add')?.addEventListener('click', () => {
  const gameId = el('custom-ol-game')?.value?.trim();
  const name   = el('custom-ol-name')?.value?.trim();
  const path   = el('custom-ol-path')?.value?.trim();
  if (!gameId || !name || !path) return;
  send('manage_custom_overlay', { action: 'add', gameId, name, path });
  el('custom-ol-name').value = '';
  el('custom-ol-path').value = '';
});

// ── Config presets ──────────────────────────────────────────────────────────
function renderPresets(presets) {
  const list = el('presets-list');
  const empty = el('presets-empty');
  if (!list) return;
  const arr = presets || [];
  const sig = arr.map((p) => p.id + '|' + p.name + '|' + (p.game || '')).join('~');
  if (list.dataset.psig === sig) return;   // unchanged → skip rebuild
  list.dataset.psig = sig;
  list.querySelectorAll('.preset-item').forEach((i) => i.remove());
  if (empty) empty.style.display = arr.length ? 'none' : '';

  arr.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'preset-item';

    const label = document.createElement('div');
    label.className = 'preset-name';
    label.textContent = p.name + (p.game ? `  ·  ${p.game.replace('-', ' ')}` : '');

    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn btn-primary btn-sm';
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', () => send('load_preset', { id: p.id }));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.title = 'Delete preset';
    delBtn.addEventListener('click', async () => {
      const ok = await customConfirm('Delete Preset', `Delete preset "${p.name}"?`, 'Delete');
      if (ok) send('delete_preset', { id: p.id });
    });

    actions.appendChild(loadBtn);
    actions.appendChild(delBtn);
    item.appendChild(label);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

el('btn-save-preset').addEventListener('click', () => {
  const name = (el('input-preset-name')?.value || '').trim();
  if (!name) { alert('Enter a preset name.'); return; }
  send('save_preset', { name });
  el('input-preset-name').value = '';
});

// ── Brand kits (client identities + sponsor sets) ────────────────────────────
let editingBrandId = null;
let editingBrandThemes = {};      // preserve per-game theme prefs not edited here
let pendingBrandLogo = null;      // base64 data URL or existing URL
let brandSponsors = [];           // [{ id?, name, logo, tier }]
let pendingSponsorLogo = null;
let brandBannerImages = [];       // base64 images for this kit's banner
let brandBannerCaptions = [];     // optional per-image text, parallel to brandBannerImages

function resetBrandForm() {
  editingBrandId = null;
  editingBrandThemes = {};
  pendingBrandLogo = null;
  brandSponsors = [];
  pendingSponsorLogo = null;
  brandBannerImages = [];
  brandBannerCaptions = [];
  el('brand-editor-title').textContent = 'New Brand Kit';
  el('input-brand-name').value = '';
  el('input-brand-sponsor-label').value = '';
  el('input-brand-color').value = '#055fdb';
  el('input-brand-accent').value = '#e97139';
  el('input-brand-interval').value = '6';
  el('input-brand-banner-interval').value = '10';
  if (el('select-brand-banner-slant')) el('select-brand-banner-slant').value = 'right';
  if (el('input-brand-banner-header')) el('input-brand-banner-header').value = '';
  el('input-brand-logo').value = '';
  el('input-sponsor-name').value = '';
  el('input-sponsor-logo').value = '';
  el('select-brand-theme').value = '';
  const prev = el('brand-logo-preview'); prev.style.display = 'none'; prev.removeAttribute('src');
  renderBrandSponsors();
  renderKitBannerImages();
}

// Spots a sponsor logo can be assigned to (checkmarks in the brand editor).
const SPONSOR_SPOTS_UI = [
  { key: 'rail',        label: 'Rail',        multi: true },
  { key: 'desk',        label: 'Caster Desk', multi: true },
  { key: 'banner',      label: 'Banner',      multi: true },
  { key: 'overtime',    label: 'Overtime',    multi: false },
  { key: 'replayGoal',  label: 'Replay',      multi: false },
  { key: 'replayOutro', label: 'Replay Outro',multi: false },
  { key: 'scoreboard',  label: 'Scoreboard',  multi: false },
];
function defaultPlacements() {
  return { rail: true, desk: false, banner: false, overtime: false, replayGoal: false, replayOutro: false, scoreboard: false };
}
function ensurePlacements(s) {
  if (!s.placements || typeof s.placements !== 'object') s.placements = defaultPlacements();
  SPONSOR_SPOTS_UI.forEach((sp) => { if (typeof s.placements[sp.key] !== 'boolean') s.placements[sp.key] = false; });
  return s.placements;
}

function renderBrandSponsors() {
  const list = el('sponsors-list'); const empty = el('sponsors-empty');
  if (!list) return;
  list.querySelectorAll('.sponsor-row').forEach((i) => i.remove());
  if (empty) empty.style.display = brandSponsors.length ? 'none' : '';
  brandSponsors.forEach((s, idx) => {
    ensurePlacements(s);
    const row = document.createElement('div'); row.className = 'sponsor-row preset-item';

    const head = document.createElement('div'); head.className = 'sponsor-row-head';
    const thumb = document.createElement('div'); thumb.className = 'sponsor-row-thumb';
    if (s.logo) { const img = document.createElement('img'); img.src = s.logo; thumb.appendChild(img); }
    else { thumb.textContent = 'TXT'; }
    const name = document.createElement('div'); name.className = 'sponsor-row-name';
    name.textContent = s.name || '(logo only)';
    const del = document.createElement('button'); del.className = 'btn btn-danger btn-sm'; del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    del.title = 'Remove sponsor';
    del.addEventListener('click', () => { brandSponsors.splice(idx, 1); renderBrandSponsors(); });
    head.appendChild(thumb); head.appendChild(name); head.appendChild(del);

    const spots = document.createElement('div'); spots.className = 'sponsor-placements';
    SPONSOR_SPOTS_UI.forEach((sp) => {
      const lab = document.createElement('label'); lab.className = 'sponsor-spot' + (sp.multi ? '' : ' sponsor-spot-single');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!s.placements[sp.key];
      cb.title = sp.multi ? `Show on ${sp.label} (multiple sponsors allowed)` : `Fill the ${sp.label} slot (one sponsor)`;
      cb.addEventListener('change', function () {
        s.placements[sp.key] = this.checked;
        // Single-logo slots hold one sponsor: claiming it clears the others.
        if (!sp.multi && this.checked) {
          brandSponsors.forEach((o) => { if (o !== s) { ensurePlacements(o); o.placements[sp.key] = false; } });
          renderBrandSponsors();
        }
      });
      lab.appendChild(cb); lab.appendChild(document.createTextNode(sp.label));
      spots.appendChild(lab);
    });

    row.appendChild(head); row.appendChild(spots); list.appendChild(row);
  });
}

function renderBrandThemeOptions(data) {
  const sel = el('select-brand-theme'); if (!sel) return;
  const game = (data.games && data.games[data.activeGame]) || null;
  const themes = (game && game.themes) || [];
  const cur = sel.value;
  sel.innerHTML = '<option value="">— no preference —</option>' +
    themes.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  if (cur) sel.value = cur;
}

function renderBrands(data) {
  const kits = data.brandKits || [];
  renderBrandThemeOptions(data);   // depends on active game/theme — always refresh (cheap)

  // Skip the select + list rebuild when the brand library and active kit are unchanged.
  const sig = (data.activeBrandKitId || '') + '::' + kits.map((k) => k.id + '|' + k.name + '|' + ((k.sponsors || []).length)).join('~');
  if (renderBrands._sig === sig) return;
  renderBrands._sig = sig;

  const opts = '<option value="">No client (event branding)</option>' +
    kits.map((k) => `<option value="${k.id}">${k.name}</option>`).join('');
  ['select-active-brand', 'select-active-brand-main'].forEach((sid) => {
    const sel = el(sid);
    if (!sel) return;
    sel.innerHTML = opts;
    if (document.activeElement !== sel) sel.value = data.activeBrandKitId || '';
  });
  const chip = el('active-brand-chip');
  if (chip) {
    const activeKit = kits.find((k) => k.id === data.activeBrandKitId);
    chip.textContent = activeKit ? activeKit.name : 'No client';
    chip.classList.toggle('ok', !!activeKit);
  }

  const list = el('brands-list'); const empty = el('brands-empty');
  if (!list) return;
  list.querySelectorAll('.preset-item').forEach((i) => i.remove());
  if (empty) empty.style.display = kits.length ? 'none' : '';
  kits.forEach((k) => {
    const isActive = k.id === data.activeBrandKitId;
    const nSp = (k.sponsors || []).length;
    const item = document.createElement('div'); item.className = 'preset-item';
    const label = document.createElement('div'); label.className = 'preset-name';
    label.textContent = (isActive ? '● ' : '') + k.name + `  ·  ${nSp} sponsor${nSp === 1 ? '' : 's'}`;
    const actions = document.createElement('div'); actions.className = 'preset-actions';
    const actBtn = document.createElement('button');
    actBtn.className = 'btn btn-primary btn-sm'; actBtn.textContent = isActive ? 'Active' : 'Activate';
    actBtn.disabled = isActive;
    actBtn.addEventListener('click', () => send('activate_brand_kit', { id: k.id }));
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-ghost btn-sm'; editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => { loadBrandIntoForm(k); openBrandEditor(); });
    const urlBtn = document.createElement('button');
    urlBtn.className = 'btn btn-ghost btn-sm'; urlBtn.textContent = 'Banner URL';
    urlBtn.title = "Copy this brand's standalone banner OBS browser-source URL";
    urlBtn.addEventListener('click', () => copyText(`${SCENE_BASE_URL}/sponsor-banner.html?brand=${encodeURIComponent(k.id)}`, urlBtn));
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm'; delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.addEventListener('click', async () => {
      const ok = await customConfirm('Delete Brand Kit', `Delete "${k.name}"?`, 'Delete');
      if (ok) send('delete_brand_kit', { id: k.id });
    });
    actions.appendChild(actBtn); actions.appendChild(editBtn); actions.appendChild(urlBtn); actions.appendChild(delBtn);
    item.appendChild(label); item.appendChild(actions); list.appendChild(item);
  });
}

function loadBrandIntoForm(k) {
  editingBrandId = k.id;
  editingBrandThemes = (k.themes && typeof k.themes === 'object') ? { ...k.themes } : {};
  pendingBrandLogo = k.logo || null;
  brandSponsors = (k.sponsors || []).map((s) => ({ ...s, placements: { ...(s.placements || {}) } }));
  brandBannerImages = Array.isArray(k.bannerImages) ? [...k.bannerImages] : [];
  brandBannerCaptions = Array.isArray(k.bannerCaptions) ? [...k.bannerCaptions] : [];
  el('brand-editor-title').textContent = 'Edit: ' + k.name;
  el('input-brand-name').value = k.name || '';
  el('input-brand-sponsor-label').value = k.sponsorLabel || '';
  el('input-brand-color').value = k.color || '#055fdb';
  el('input-brand-accent').value = k.accent || '#e97139';
  el('input-brand-interval').value = k.sponsorInterval || 6;
  el('input-brand-banner-interval').value = k.bannerInterval || 10;
  if (el('select-brand-banner-slant')) el('select-brand-banner-slant').value = k.bannerSlant || 'right';
  if (el('input-brand-banner-header')) el('input-brand-banner-header').value = k.bannerHeader || '';
  const themeSel = el('select-brand-theme');
  if (themeSel) themeSel.value = (currentState.activeGame && editingBrandThemes[currentState.activeGame]) || '';
  const prev = el('brand-logo-preview');
  if (pendingBrandLogo) { prev.src = pendingBrandLogo; prev.style.display = ''; }
  else { prev.style.display = 'none'; prev.removeAttribute('src'); }
  renderBrandSponsors();
  renderKitBannerImages();
  el('input-brand-name').scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}

function renderKitBannerImages() {
  const list = el('brand-banner-images-list');
  if (!list) return;
  list.innerHTML = '';
  if (!brandBannerImages.length) return;
  brandBannerImages.forEach((src, idx) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;background:rgba(255,255,255,0.05);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:6px;';
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'width:100%;height:72px;object-fit:contain;border-radius:4px;display:block;';
    const cap = document.createElement('input');
    cap.type = 'text'; cap.className = 'input-text';
    cap.placeholder = 'Optional text — USE CODE *NAME*';
    cap.title = 'Text shown beside this banner. Wrap a word in *asterisks* for italic; new lines for multiple lines.';
    cap.style.cssText = 'width:100%;padding:5px 8px;font-size:11px;';
    cap.value = brandBannerCaptions[idx] || '';
    cap.addEventListener('input', () => { brandBannerCaptions[idx] = cap.value; });
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = '×';
    btn.style.cssText = 'position:absolute;top:4px;right:4px;padding:0 6px;font-size:16px;line-height:1.4;';
    btn.addEventListener('click', () => { brandBannerImages.splice(idx, 1); brandBannerCaptions.splice(idx, 1); renderKitBannerImages(); });
    wrap.appendChild(img); wrap.appendChild(cap); wrap.appendChild(btn);
    list.appendChild(wrap);
  });
}

el('input-brand-banner-image').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  brandBannerImages.push(await fileToBase64(f));
  brandBannerCaptions.push('');
  e.target.value = '';
  renderKitBannerImages();
});

el('input-brand-logo').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingBrandLogo = await fileToBase64(f);
  const prev = el('brand-logo-preview'); prev.src = pendingBrandLogo; prev.style.display = '';
});
el('btn-clear-brand-logo')?.addEventListener('click', () => {
  pendingBrandLogo = null;
  const f = el('input-brand-logo'); if (f) f.value = '';
  const prev = el('brand-logo-preview'); if (prev) { prev.style.display = 'none'; prev.removeAttribute('src'); }
});

el('input-sponsor-logo').addEventListener('change', async (e) => {
  const f = e.target.files[0]; pendingSponsorLogo = f ? await fileToBase64(f) : null;
});

el('btn-add-sponsor').addEventListener('click', () => {
  const name = (el('input-sponsor-name').value || '').trim();
  if (!name && !pendingSponsorLogo) { alert('Enter a sponsor name or pick a logo.'); return; }
  brandSponsors.push({ name, logo: pendingSponsorLogo || null, tier: 'partner', placements: defaultPlacements() });
  pendingSponsorLogo = null;
  el('input-sponsor-name').value = '';
  el('input-sponsor-logo').value = '';
  renderBrandSponsors();
});

el('btn-save-brand').addEventListener('click', () => {
  const name = (el('input-brand-name').value || '').trim();
  if (!name) { alert('Enter a client / brand name.'); return; }
  const themes = { ...editingBrandThemes };
  const t = el('select-brand-theme').value;
  if (currentState.activeGame) {
    if (t) themes[currentState.activeGame] = t;
    else delete themes[currentState.activeGame];
  }
  send('save_brand_kit', {
    id: editingBrandId || undefined,
    name,
    logo: pendingBrandLogo || null,
    color: el('input-brand-color').value,
    accent: el('input-brand-accent').value,
    sponsorLabel: (el('input-brand-sponsor-label').value || 'PARTNERS').trim(),
    sponsorInterval: Number(el('input-brand-interval').value) || 6,
    sponsors: brandSponsors,
    themes,
    bannerImages: brandBannerImages,
    bannerCaptions: brandBannerCaptions,
    bannerInterval: Number(el('input-brand-banner-interval').value) || 10,
    bannerSlant: el('select-brand-banner-slant')?.value || 'right',
    bannerHeader: el('input-brand-banner-header')?.value || ''
  });
  resetBrandForm();
  closeBrandEditor();
});

// Brand editor modal — opened by "+ New Brand Kit" and each kit's Edit button.
function openBrandEditor() { const m = el('brand-editor-modal'); if (m) m.style.display = 'flex'; }
function closeBrandEditor() { const m = el('brand-editor-modal'); if (m) m.style.display = 'none'; }
el('btn-open-new-brand')?.addEventListener('click', () => { resetBrandForm(); openBrandEditor(); });
el('brand-editor-close')?.addEventListener('click', closeBrandEditor);
el('brand-editor-modal')?.addEventListener('click', (e) => { if (e.target === el('brand-editor-modal')) closeBrandEditor(); });
el('btn-new-brand').addEventListener('click', () => { resetBrandForm(); closeBrandEditor(); });

['select-active-brand', 'select-active-brand-main'].forEach((sid) => {
  const sel = el(sid);
  if (sel) sel.addEventListener('change', (e) => send('activate_brand_kit', { id: e.target.value || null }));
});

// ── CS2 Game State Integration ──────────────────────────────────────────────
el('btn-csgo-install').addEventListener('click', () => {
  const p = (el('input-csgo-path')?.value || '').trim();
  if (!p) { alert('Enter your CS2 install or cfg folder path.'); return; }
  send('install_csgo_gsi', { path: p });
});

el('btn-csgo-spectator')?.addEventListener('click', () => {
  // Reuses the same folder path as the GSI install (server falls back to the saved path).
  send('install_spectator_cfg', { path: (el('input-csgo-path')?.value || '').trim() });
});

el('check-csgo-history')?.addEventListener('change', (e) => {
  send('csgo_show_history', { visible: !!e.target.checked });
});

el('check-csgo-builtin-radar')?.addEventListener('change', (e) => {
  send('csgo_radar_mode', { builtin: !!e.target.checked });
});

function applyRlSpectatorUi(data) {
  const ui = data.rlSpectatorUi || {};
  const setChk = (id, val) => {
    const n = el(id);
    if (n && document.activeElement !== n) n.checked = !!val;
  };
  const setVal = (id, val) => {
    const n = el(id);
    if (n && document.activeElement !== n && val != null) n.value = val;
  };
  setChk('check-rl-ui-hide-enabled', ui.enabled !== false);
  setChk('check-rl-ui-auto-match', ui.autoOnMatch !== false);
  setChk('check-rl-ui-focus', ui.focusWindow !== false);
  setVal('input-rl-ui-key', ui.key || 'h');
  setVal('input-rl-ui-presses', ui.presses ?? 2);
  setVal('input-rl-ui-gap', ui.gapMs ?? 250);
  setVal('input-rl-ui-hotkey', ui.hotkey || 'F9');
}

function sendRlSpectatorUiPatch(patch) {
  send('set_rl_spectator_ui', patch);
}

el('check-rl-ui-hide-enabled')?.addEventListener('change', function() {
  sendRlSpectatorUiPatch({ enabled: this.checked });
});
el('check-rl-ui-auto-match')?.addEventListener('change', function() {
  sendRlSpectatorUiPatch({ autoOnMatch: this.checked });
});
el('check-rl-ui-focus')?.addEventListener('change', function() {
  sendRlSpectatorUiPatch({ focusWindow: this.checked });
});
el('input-rl-ui-key')?.addEventListener('change', function() {
  sendRlSpectatorUiPatch({ key: this.value.trim() || 'h' });
});
el('input-rl-ui-presses')?.addEventListener('change', function() {
  sendRlSpectatorUiPatch({ presses: Math.max(1, Math.min(4, Number(this.value) || 2)) });
});
el('input-rl-ui-gap')?.addEventListener('change', function() {
  sendRlSpectatorUiPatch({ gapMs: Math.max(50, Number(this.value) || 250) });
});
el('input-rl-ui-hotkey')?.addEventListener('change', function() {
  sendRlSpectatorUiPatch({ hotkey: this.value.trim() || 'F9' });
});
el('btn-rl-ui-hide-now')?.addEventListener('click', () => {
  send('rl_hide_native_ui');
  const st = el('rl-ui-hide-status');
  if (st) st.textContent = 'Sending to Rocket League…';
});

function applyValorantState(data) {
  const val = data.valorant || {};
  const conn = el('val-conn');
  if (conn) {
    const connected = !!val.connected;
    conn.textContent = connected ? 'Valorant: connected' : 'Valorant: waiting';
    conn.className = 'prod-chip' + (connected ? ' ok' : '');
  }
}

function applyCsgoState(data) {
  const cs = data.csgo || {};
  const pathEl = el('input-csgo-path');
  if (pathEl && document.activeElement !== pathEl && cs.cfgPath) pathEl.value = cs.cfgPath;

  const conn = el('csgo-conn');
  if (conn) {
    conn.textContent = cs.connected ? 'CS2: connected' : 'CS2: waiting';
    conn.className = 'prod-chip' + (cs.connected ? ' ok' : '');
  }

  const histEl = el('check-csgo-history');
  if (histEl && document.activeElement !== histEl) histEl.checked = !!cs.showHistory;

  const radarEl = el('check-csgo-builtin-radar');
  if (radarEl && document.activeElement !== radarEl) radarEl.checked = !!cs.builtinRadar;
}

// ── OBS settings ────────────────────────────────────────────────────────────
const OBS_SCENE_KEYS = ['inGame', 'replay', 'postGame', 'break', 'commercial', 'casters'];
let _lastObsSceneSig = '';

function getObsPayload() {
  const scenes = {};
  OBS_SCENE_KEYS.forEach(k => {
    const sel = el(`select-obs-scene-${k}`);
    scenes[k] = sel ? sel.value : '';
  });
  const payload = {
    enabled: !!el('check-obs-enabled')?.checked,
    url: (() => {
      const ip   = (el('input-obs-ip')?.value.trim()   || '127.0.0.1').replace(/^wss?:\/\//i, '');
      const port = (el('input-obs-port')?.value.trim() || '4455');
      return `ws://${ip}:${port}`;
    })(),
    autoSwitch: !!el('check-obs-autoswitch')?.checked,
    autoReplayOnGoal: !!el('check-obs-autoreplay')?.checked,
    postGameToCastersSec: Math.max(0, parseInt(el('input-obs-postgame-casters')?.value, 10) || 0),
    scenes
  };
  const pw = el('input-obs-password')?.value.trim();
  if (pw) payload.password = pw;          // non-empty → update stored password
  else if (el('btn-obs-clear-password')?.dataset.clearing === '1') payload.clearPassword = true;
  return payload;
}

function populateObsSceneSelects(available, mapping) {
  // Only rebuild when the live scene list or saved mapping changes, so an
  // unsaved selection isn't wiped by an unrelated full_state broadcast.
  const sig = JSON.stringify({ available, mapping });
  if (sig === _lastObsSceneSig) return;
  _lastObsSceneSig = sig;

  OBS_SCENE_KEYS.forEach(k => {
    const sel = el(`select-obs-scene-${k}`);
    if (!sel) return;
    const current = (mapping && mapping[k]) || '';
    const list = Array.isArray(available) ? available.slice() : [];
    if (current && !list.includes(current)) list.push(current);  // keep stale mapping selectable
    sel.innerHTML = '<option value="">— None —</option>';
    list.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.value = current;
  });
}

const SCENE_CONTROL_MOMENTS = [
  { key: 'inGame', label: 'In-Game' },
  { key: 'replay', label: 'Replay' },
  { key: 'postGame', label: 'Post-Game' },
  { key: 'break', label: 'Commercial' },
  { key: 'casters', label: 'Casters' },
  { key: 'bracket', label: 'Bracket' }
];
let _lastSceneCtrlSig = '';

// ── OBS scene hotkeys: number keys 1..N cut to the mapped OBS scenes ─────────
function obsSceneHotkey(idx) {
  const m = SCENE_CONTROL_MOMENTS[idx]; if (!m) return;
  const obs = currentState.obs || {};
  const sceneName = (obs.scenes || {})[m.key];
  if (sceneName && obs.connected) {
    send('obs_switch_scene', { sceneName });
    flashHotkeyHint(`Cut → ${m.label}`);
  } else {
    flashHotkeyHint(obs.connected ? `${m.label}: no scene mapped` : 'OBS not connected');
  }
}
function flashHotkeyHint(text) {
  let h = el('hotkey-flash');
  if (!h) { h = document.createElement('div'); h.id = 'hotkey-flash'; h.className = 'hotkey-flash'; document.body.appendChild(h); }
  h.textContent = text; h.classList.add('show');
  clearTimeout(flashHotkeyHint._t);
  flashHotkeyHint._t = setTimeout(() => h.classList.remove('show'), 1100);
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key, 10) - 1;
    if (idx < SCENE_CONTROL_MOMENTS.length) { obsSceneHotkey(idx); e.preventDefault(); }
  }
});

function applySceneControl(obs) {
  const section = el('scene-control-section');
  const btnWrap = el('scene-control-buttons');
  const hint = el('scene-control-hint');
  if (!section || !btnWrap) return;

  section.style.display = obs.enabled ? 'block' : 'none';
  if (!obs.enabled) return;

  const scenes = obs.scenes || {};
  const connected = !!obs.connected;
  const sig = JSON.stringify({ scenes, connected });
  if (sig === _lastSceneCtrlSig) return;
  _lastSceneCtrlSig = sig;

  btnWrap.innerHTML = '';
  let anyMapped = false;
  SCENE_CONTROL_MOMENTS.forEach((m, i) => {
    const sceneName = scenes[m.key];
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm';
    btn.innerHTML = `<kbd class="qt-key">${i + 1}</kbd>${m.label}`;
    if (sceneName && connected) {
      anyMapped = true;
      btn.title = `Cut to "${sceneName}"  ·  hotkey ${i + 1}`;
      btn.addEventListener('click', () => send('obs_switch_scene', { sceneName }));
    } else {
      btn.disabled = true;
      btn.style.opacity = '0.45';
      btn.title = sceneName ? 'Connect to OBS to use' : 'No scene mapped (Settings → OBS)';
    }
    btnWrap.appendChild(btn);
  });

  // Replay-buffer buttons share the same connection gate
  ['btn-obs-save-replay', 'btn-obs-toggle-buffer'].forEach((id) => {
    const b = el(id);
    if (b) {
      b.disabled = !connected;
      b.style.opacity = connected ? '1' : '0.45';
    }
  });

  if (hint) {
    hint.textContent = !connected
      ? 'Not connected to OBS — connect in Settings → OBS.'
      : (anyMapped ? '' : 'No scenes mapped yet — set them in Settings → OBS.');
  }
}

el('btn-obs-save-replay')?.addEventListener('click', () => send('obs_save_replay'));
el('btn-obs-toggle-buffer')?.addEventListener('click', () => send('obs_toggle_replay_buffer'));

function applyObsState(data) {
  const obs = data.obs || {};
  applySceneControl(obs);

  const cbEnabled = el('check-obs-enabled');
  if (cbEnabled) cbEnabled.checked = !!obs.enabled;

  const cbAuto = el('check-obs-autoswitch');
  if (cbAuto) cbAuto.checked = obs.autoSwitch !== false;

  const cbReplay = el('check-obs-autoreplay');
  if (cbReplay) cbReplay.checked = !!obs.autoReplayOnGoal;
  const cbComm = el('check-commercial-auto-return');
  if (cbComm) cbComm.checked = obs.commercialAutoReturn !== false;
  const pgc = el('input-obs-postgame-casters');
  if (pgc && document.activeElement !== pgc) pgc.value = obs.postGameToCastersSec || 0;

  const ipEl   = el('input-obs-ip');
  const portEl = el('input-obs-port');
  if (ipEl || portEl) {
    // Parse saved URL (ws://ip:port) back into separate fields
    const saved = obs.url || 'ws://127.0.0.1:4455';
    const m = saved.match(/^wss?:\/\/([^:/]+)(?::(\d+))?/i);
    const savedIp   = m ? m[1] : '127.0.0.1';
    const savedPort = m && m[2] ? m[2] : '4455';
    if (ipEl   && document.activeElement !== ipEl)   ipEl.value   = savedIp;
    if (portEl && document.activeElement !== portEl) portEl.value = savedPort;
  }

  const pwEl = el('input-obs-password');
  const pwInd = el('obs-password-indicator');
  const pwClear = el('btn-obs-clear-password');
  if (pwEl && pwInd) {
    const hasSaved = obs.hasPassword && !pwEl.value;
    pwInd.style.display = hasSaved ? 'block' : 'none';
    pwEl.placeholder = hasSaved ? '••••••••••••' : 'OBS WebSocket password';
    if (pwClear) pwClear.style.display = hasSaved ? 'inline-block' : 'none';
  }

  populateObsSceneSelects(obs.availableScenes || [], obs.scenes || {});
  if (typeof syncReplayProgramScene === 'function') syncReplayProgramScene(obs);

  // Status bar pill
  const obsStatusEl = el('obs-status');
  if (obsStatusEl) {
    if (obs.enabled) {
      obsStatusEl.style.display = 'flex';
      const icon = obsStatusEl.querySelector('.status-icon');
      if (icon) icon.classList.toggle('connected', !!obs.connected);
    } else {
      obsStatusEl.style.display = 'none';
    }
  }

  // Status line
  const resultEl = el('obs-result');
  if (resultEl) {
    if (obs.connected) {
      resultEl.textContent = `● Connected to OBS — ${(obs.availableScenes || []).length} scene(s) available.`;
      resultEl.style.color = '#9ae6b4';
    } else if (obs.lastError) {
      resultEl.textContent = `Last error: ${obs.lastError}`;
      resultEl.style.color = '#f56565';
    } else if (obs.enabled) {
      resultEl.textContent = 'Enabled — connecting…';
      resultEl.style.color = 'var(--muted)';
    } else {
      resultEl.textContent = '';
    }
  }
}

el('btn-obs-save').addEventListener('click', () => {
  send('set_obs_settings', getObsPayload());
});
el('input-obs-postgame-casters')?.addEventListener('change', () => send('set_obs_settings', getObsPayload()));
el('check-commercial-auto-return')?.addEventListener('change', function () { send('set_commercial_auto_return', { enabled: this.checked }); });

el('btn-obs-test').addEventListener('click', () => {
  send('set_obs_settings', getObsPayload());
  send('obs_test_connection');
  const resultEl = el('obs-result');
  if (resultEl) { resultEl.textContent = 'Testing connection…'; resultEl.style.color = 'var(--muted)'; }
});

el('btn-obs-refresh-scenes').addEventListener('click', () => {
  send('obs_refresh_scenes');
});

el('btn-obs-clear-password')?.addEventListener('click', () => {
  const btn = el('btn-obs-clear-password');
  const pwEl = el('input-obs-password');
  if (pwEl) pwEl.value = '';
  btn.dataset.clearing = '1';
  send('set_obs_settings', getObsPayload());
  delete btn.dataset.clearing;
  btn.style.display = 'none';
  el('obs-password-indicator').style.display = 'none';
  const pwInd = el('obs-password-indicator');
  if (pwInd) pwInd.style.display = 'none';
  if (pwEl) pwEl.placeholder = 'OBS WebSocket password';
});

el('btn-obs-download-collection')?.addEventListener('click', async () => {
  const btn = el('btn-obs-download-collection');
  const statusEl = btn.nextElementSibling?.classList.contains('obs-collection-status') ? btn.nextElementSibling : null;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  statusEl.textContent = '';
  try {
    const res = await fetch('http://localhost:3000/api/obs/install-collection', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    btn.textContent = '✓ Installed';
    statusEl.textContent = data.message || 'Done.';
    statusEl.style.color = 'var(--good, #48bb78)';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; statusEl.textContent = ''; }, 4000);
  } catch (e) {
    btn.textContent = '✗ Failed';
    btn.disabled = false;
    statusEl.textContent = e.message;
    statusEl.style.color = '#f56565';
    setTimeout(() => { btn.textContent = orig; statusEl.textContent = ''; }, 5000);
    console.error('[OBS] install-collection failed:', e);
  }
});

// ── RL status ─────────────────────────────────────────────────────────────
// (Updated via full_state)

// ── AI Director & Clips ───────────────────────────────────────────────────
let selectedClipIds = new Set();
let selectedClipId = null;   // the clip currently loaded in the REPLAYS editor

function gameHasDirector() {
  const g = (currentState.games && currentState.games[currentState.activeGame]) || null;
  return !!(g && g.features && g.features.includes('director'));
}

function renderDirectorLocalStack(data) {
  const strip = el('director-local-stack');
  if (strip) strip.style.display = gameHasDirector() ? '' : 'none';
  if (!strip || strip.style.display === 'none') return;

  const feats = activeGameFeatures(data);
  const rlChip = el('dir-chip-rl');
  if (rlChip) {
    const show = feats.includes('stats-api');
    rlChip.style.display = show ? '' : 'none';
    if (show) chip('dir-chip-rl', data.rlConnected ? 'RL API' : 'RL API: offline', !!data.rlConnected);
  }

  const obs = data.obs || {};
  chip('dir-chip-obs', obs.connected ? 'OBS' : (obs.enabled ? 'OBS: offline' : 'OBS: off'),
    obs.connected ? true : (obs.enabled ? null : false));
}

function applyDirectorState(d) {
  const section = el('director-section');
  if (section) section.style.display = gameHasDirector() ? '' : 'none';
  renderDirectorLocalStack(currentState);
  if (!d) return;

  const enabled = el('check-director-enabled');
  if (enabled && document.activeElement !== enabled) enabled.checked = d.enabled !== false;

  const sens = el('range-director-sensitivity');
  const sensVal = el('director-sens-val');
  const pct = Math.round((d.sensitivity ?? 0.5) * 100);
  if (sens && document.activeElement !== sens) sens.value = pct;
  if (sensVal) sensVal.textContent = pct + '%';

  const conf = el('director-confidence');
  const target = el('director-target');
  const reason = el('director-reason');
  const meta = el('director-meta');
  if (d.primary) {
    if (conf) conf.textContent = (d.confidence || d.primary.confidence || 0) + '%';
    if (target) target.textContent = d.primary.name || d.primary.target?.name || '—';
    if (reason) reason.textContent = d.primary.reason || '';
    if (meta) meta.textContent = [d.primary.type, d.primary.gameTime].filter(Boolean).join(' · ');
  } else {
    if (conf) conf.textContent = '—';
    if (target) target.textContent = d.enabled ? 'Analyzing…' : 'Director disabled';
    if (reason) reason.textContent = d.enabled ? 'Waiting for broadcast-worthy moment' : 'Enable director to get suggestions';
    if (meta) meta.textContent = '';
  }

  const altWrap = el('director-alternates-wrap');
  const altList = el('director-alternates');
  const alts = d.alternates || [];
  if (altWrap) altWrap.style.display = alts.length ? '' : 'none';
  if (altList) {
    altList.innerHTML = alts.map((a, i) =>
      `<div class="director-alt-item" data-alt-idx="${i}" data-target-id="${(a.target && a.target.id) || ''}">
        <span><strong>${a.name}</strong> — ${a.reason || a.type}</span>
        <span style="color:var(--muted)">${a.confidence || 0}%</span>
      </div>`
    ).join('');
    altList.querySelectorAll('.director-alt-item').forEach((node) => {
      node.addEventListener('click', () => {
        const idx = Number(node.dataset.altIdx);
        const alt = alts[idx];
        if (alt) {
          send('set_director', { lockTarget: alt.target?.id || alt.name });
          send('director_feedback', { action: 'overridden', eventType: alt.type, targetId: alt.target?.id });
        }
      });
    });
  }

  const feed = el('director-feed');
  if (feed) {
    const items = (d.feed || []).slice(0, 20);
    feed.innerHTML = items.length ? items.map((f) => {
      const time = f.gameTime || (f.ts ? new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
      return `<div class="director-feed-item" data-feed-id="${f.id || ''}" title="Save replay clip + train AI on this moment">
        <span class="director-feed-type">${f.type}</span>
        <span>${f.target || ''} — ${f.reason || ''}${time ? ` <span style="color:var(--muted)">(${time})</span>` : ''}</span>
        <span class="feed-save-hint">Save clip</span>
      </div>`;
    }).join('') : '<div style="color:var(--muted);font-size:12px;">No events yet</div>';
    feed.querySelectorAll('.director-feed-item[data-feed-id]').forEach((node) => {
      node.addEventListener('click', () => {
        const id = node.dataset.feedId;
        if (!id) return;
        send('director_feed_action', { feedId: id, action: 'both' });
        const st = el('clips-status');
        if (st) { st.textContent = 'Saving replay clip from feed…'; st.style.color = 'var(--muted)'; }
      });
    });
  }

  const autoSw = el('check-director-autoswitch');
  if (autoSw && document.activeElement !== autoSw) autoSw.checked = !!d.autoSwitch;

  const asHint = el('director-autoswitch-hint');
  if (asHint) {
    const game = currentState.activeGame;
    asHint.textContent = game === 'csgo'
      ? 'CS2: sends observer slot hotkeys 1–0 to the focused game window on this PC.'
      : 'Available for CS2 (observer keys). Rocket League camera control is not automated.';
  }

  const asStatus = el('director-autoswitch-status');
  if (asStatus) {
    const las = d.lastAutoSwitch;
    asStatus.textContent = las
      ? `Last auto-switch: ${las.target}${las.key ? ` (key ${las.key})` : ''}`
      : (d.autoSwitch ? 'Auto-switch armed — CS2 observer keys' : '');
  }

  const learn = el('director-learning');
  if (learn && d.learning) {
    learn.textContent = `Learning: ${d.learning.totalFeedback || 0} feedback events · ${d.learning.accuracy || 0}% accepted · improves with every show`;
  }
}

let activeDirectorPanel = 'live';
function switchDirectorPanel(name) {
  activeDirectorPanel = name;
  document.querySelectorAll('.director-subnav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.directorPanel === name);
  });
  document.querySelectorAll('.director-panel').forEach((p) => {
    p.classList.toggle('active', p.dataset.panel === name);
  });
}

document.querySelectorAll('.director-subnav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchDirectorPanel(btn.dataset.directorPanel));
});

// ═══════════════════════════════════════════════════════════════════════════
//  REPLAYS — Clip Library, Visual Trim Bar, Playlist, OBS Folder Scan
// ═══════════════════════════════════════════════════════════════════════════

const _thumbCache = new Map();

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

async function getClipThumbnail(clip) {
  if (_thumbCache.has(clip.id)) return _thumbCache.get(clip.id);
  const url = clipUrl(clip);
  if (!url) return null;
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'metadata'; v.src = url;
    const cleanup = () => { v.src = ''; };
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(v.duration * 0.15, 3); });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = 160; c.height = 90;
        c.getContext('2d').drawImage(v, 0, 0, 160, 90);
        const u = c.toDataURL('image/jpeg', 0.75);
        _thumbCache.set(clip.id, u); cleanup(); resolve(u);
      } catch { cleanup(); resolve(null); }
    });
    v.addEventListener('error', () => { cleanup(); resolve(null); });
    setTimeout(() => { cleanup(); resolve(null); }, 8000);
  });
}

function generateFilmstrip(videoEl) {
  const strip = el('rp-trim-filmstrip');
  if (!strip || !videoEl) return;
  strip.innerHTML = '';
  const dur = videoEl.duration;
  if (!isFinite(dur) || dur <= 0) return;
  const trackW = el('rp-trim-track')?.offsetWidth || 300;
  const frameH = 52; const frameW = Math.round(frameH * (16 / 9));
  const count = Math.max(3, Math.min(20, Math.floor(trackW / frameW)));
  let i = 0;
  function paintFrame() {
    if (i >= count) return;
    const c = document.createElement('canvas');
    c.width = frameW; c.height = frameH;
    strip.appendChild(c);
    const sv = document.createElement('video');
    sv.crossOrigin = 'anonymous'; sv.muted = true; sv.src = videoEl.src;
    sv.addEventListener('loadedmetadata', () => { sv.currentTime = (dur / count) * (i + 0.5); });
    sv.addEventListener('seeked', () => {
      try { c.getContext('2d').drawImage(sv, 0, 0, frameW, frameH); } catch {}
      sv.src = ''; i++; setTimeout(paintFrame, 80);
    });
    sv.addEventListener('error', () => { sv.src = ''; i++; setTimeout(paintFrame, 80); });
  }
  paintFrame();
}

// ── Staging Area (OBS replay folder — column 1) ───────────────────────────
let _stagingFiles = [];          // { name, path, size, mtimeMs, imported, importedId }
let _stagingFilter = '';
let _stagingLoading = false;
let _stagingSelectedPath = null;
let _stagingAutoTimer = null;

function fileUrl(rawPath) {
  return 'http://localhost:3000/api/clips/file?path=' + encodeURIComponent(rawPath);
}
function thumbUrl(rawPath) {
  return 'http://localhost:3000/api/clips/thumb?path=' + encodeURIComponent(rawPath);
}

function cleanFileName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/-(\d{2})-(\d{2})$/, ' $1:$2');
}

async function scanStagingArea(quiet = false) {
  if (_stagingLoading) return;
  _stagingLoading = true;
  const btn = el('rp-scan-folder');
  const statusEl = el('clips-status');
  if (!quiet) {
    if (btn) btn.textContent = '⟳ Scanning…';
    if (statusEl) { statusEl.textContent = 'Scanning OBS replay folder…'; statusEl.style.color = ''; }
  }
  let scanOk = false;
  try {
    const res = await fetch('http://localhost:3000/api/clips/scan-folder');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { files, folder } = await res.json();
    _stagingFiles = files || [];

    const folderBar = el('rp-staging-folder-bar');
    if (folderBar) {
      if (folder) { folderBar.textContent = folder; folderBar.style.display = ''; }
      else folderBar.style.display = 'none';
    }
    const cntEl = el('rp-staging-count');
    if (cntEl) cntEl.textContent = _stagingFiles.length ? String(_stagingFiles.length) : '';
    scanOk = true;
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Scan failed: ' + err.message; statusEl.style.color = '#f56565'; }
  } finally {
    _stagingLoading = false;
    if (btn) btn.textContent = '⟳ Refresh';
  }
  if (!scanOk) return;
  // Render outside the fetch try-catch so rendering bugs surface as console errors, not "Scan failed"
  refreshStagingImportedFlags();
  renderStagingList();
  if (statusEl) {
    statusEl.textContent = _stagingFiles.length
      ? `${_stagingFiles.length} clip${_stagingFiles.length === 1 ? '' : 's'} in OBS folder`
      : 'No clips found — check OBS replay/output folder in Capture settings below';
    statusEl.style.color = '';
  }
}

function refreshStagingImportedFlags() {
  const lib = currentState.clips?.library || [];
  const normalize = p => (p || '').replace(/\\/g, '/');
  _stagingFiles.forEach(f => {
    const match = lib.find(cl => cl.sourceFile && normalize(cl.sourceFile) === normalize(f.path));
    f.imported = !!match;
    f.importedId = match?.id || null;
  });
}

function renderStagingList() {
  const list = el('rp-staging-list');
  if (!list) return;
  const q = _stagingFilter.toLowerCase();
  const files = q ? _stagingFiles.filter(f => f.name.toLowerCase().includes(q)) : _stagingFiles;

  if (!files.length) {
    list.innerHTML = `<div class="rp-empty" style="padding:28px 14px;text-align:center;font-size:12px;">${
      !_stagingFiles.length
        ? 'No clips in OBS folder.<br><span style="font-size:11px;color:var(--muted)">Set the folder path in Capture settings below.</span>'
        : `No clips match "${_stagingFilter.replace(/</g, '&lt;')}"`
    }</div>`;
    return;
  }

  list.innerHTML = '';
  files.forEach(f => {
    const card = document.createElement('div');
    card.className = 'rp-stage-card' + (f.path === _stagingSelectedPath ? ' active' : '') + (_stagingSelected.has(f.path) ? ' checked' : '');
    card.dataset.path = f.path;

    const mb = (f.size / 1024 / 1024).toFixed(1);
    const when = f.mtimeMs
      ? new Date(f.mtimeMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const label = cleanFileName(f.name);

    card.innerHTML = `
      <label class="rp-sc-check" title="Select for bulk delete"><input type="checkbox" ${_stagingSelected.has(f.path) ? 'checked' : ''}></label>
      <div class="rp-sc-thumb">
        <svg class="rp-sc-thumb-icon" viewBox="0 0 24 24" width="18" height="18" fill="rgba(255,255,255,0.25)"><path d="M8 5v14l11-7z"/></svg>
        <img class="rp-sc-thumb-img" alt="" loading="lazy" src="${thumbUrl(f.path)}">
      </div>
      <div class="rp-sc-body">
        <div class="rp-sc-name" title="${f.name.replace(/"/g, '&quot;')}">${label.replace(/</g, '&lt;')}</div>
        <div class="rp-sc-meta">${mb} MB${when ? ' · ' + when : ''}${f.imported ? ' <span class="rp-sc-lib-badge">IN LIB</span>' : ''}</div>
      </div>
      <div class="rp-sc-acts">
        <button class="btn btn-secondary btn-xs rp-sc-addpl" title="${f.imported ? 'Add to playlist' : 'Import &amp; add to playlist'}">+ PL</button>
        <button class="rp-vi-del rp-sc-ren" title="Rename file">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325"/></svg>
        </button>
        <button class="rp-vi-del rp-sc-del" title="Delete from OBS folder">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1zm1.958 1-.846 10.58a1 1 0 0 1-.997.92h-6.23a1 1 0 0 1-.997-.92L3.042 3.5zm-7.487 1a.5.5 0 0 1 .528.47l.5 8.5a.5.5 0 0 1-.998.06L5 5.03a.5.5 0 0 1 .47-.53zm5.058 0a.5.5 0 0 1 .47.53l-.5 8.5a.5.5 0 1 1-.998-.06l.5-8.5a.5.5 0 0 1 .528-.47M8 4.5a.5.5 0 0 1 .5.5v8.5a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5"/></svg>
        </button>
      </div>`;

    const thumbImg = card.querySelector('.rp-sc-thumb-img');
    if (thumbImg) {
      thumbImg.addEventListener('load', () => { thumbImg.classList.add('loaded'); });   // fades in over the icon
      thumbImg.addEventListener('error', () => { thumbImg.remove(); });                 // leave the play icon
    }

    // Inline rename of the file on disk.
    card.querySelector('.rp-sc-ren')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const body = card.querySelector('.rp-sc-body'); if (!body) return;
      if (body.querySelector('.rp-sc-rename-input')) return;   // already editing
      const ext = (f.name.match(/\.[^.]+$/) || [''])[0];
      const base = f.name.replace(/\.[^.]+$/, '');
      const inp = document.createElement('input');
      inp.className = 'input-text rp-sc-rename-input';
      inp.value = base; inp.style.cssText = 'width:100%;padding:3px 6px;font-size:12px;';
      const nameEl = body.querySelector('.rp-sc-name');
      const prevHTML = body.innerHTML;
      body.innerHTML = ''; body.appendChild(inp);
      inp.focus(); inp.select();
      let committed = false;
      const restore = () => { if (!committed) body.innerHTML = prevHTML; };
      const commit = async () => {
        if (committed) return; committed = true;
        const nn = inp.value.trim();
        if (!nn || nn === base) { body.innerHTML = prevHTML; return; }
        try {
          const r = await fetch('http://localhost:3000/api/clips/rename-staged', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: f.path, newName: nn })
          });
          const d = await r.json().catch(() => ({}));
          if (d.ok) {
            // Update local model + selection so the rename reflects immediately.
            if (_stagingSelectedPath === f.path) _stagingSelectedPath = d.path || f.path;
            if (_stagingSelected.has(f.path)) { _stagingSelected.delete(f.path); _stagingSelected.add(d.path || f.path); }
            const sf = _stagingFiles.find(x => x.path === f.path);
            if (sf) { sf.path = d.path || f.path; sf.name = d.name || (nn + ext); }
            renderStagingList();
          } else {
            committed = false; const st = el('clips-status'); if (st) { st.textContent = d.message || 'Rename failed.'; st.style.color = '#f56565'; }
            body.innerHTML = prevHTML;
          }
        } catch (err) { committed = false; body.innerHTML = prevHTML; }
      };
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); else if (ev.key === 'Escape') { committed = true; body.innerHTML = prevHTML; } });
      inp.addEventListener('blur', commit);
    });

    const pushToEditor = () => {
      _stagingSelectedPath = f.path;
      list.querySelectorAll('.rp-stage-card').forEach(c2 => c2.classList.toggle('active', c2.dataset.path === f.path));
      loadClipPreview({ rawPath: f.path, name: label, rawName: f.name, trimIn: 0, trimOut: null });
    };
    card.addEventListener('click', e => {
      if (e.target.closest('.rp-sc-addpl') || e.target.closest('.rp-sc-del') || e.target.closest('.rp-sc-check') || e.target.closest('.rp-sc-ren') || e.target.closest('.rp-sc-rename-input')) return;
      pushToEditor();
    });
    card.querySelector('.rp-sc-check input')?.addEventListener('change', function () {
      if (this.checked) _stagingSelected.add(f.path); else _stagingSelected.delete(f.path);
      card.classList.toggle('checked', this.checked);
      updateStagingBulkBar();
    });

    card.querySelector('.rp-sc-addpl')?.addEventListener('click', e => {
      e.stopPropagation();
      addStagingClipToPlaylist(f, e.currentTarget);
    });

    card.querySelector('.rp-sc-del')?.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${f.name}" from OBS folder?`)) return;
      try {
        const r = await fetch('http://localhost:3000/api/clips/delete-staged', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: f.path })
        });
        if (r.ok) {
          _stagingFiles = _stagingFiles.filter(sf => sf.path !== f.path);
          if (_stagingSelectedPath === f.path) _stagingSelectedPath = null;
          renderStagingList();
        }
      } catch {}
    });

    list.appendChild(card);
  });

  // Thumbnails are server-rendered JPEGs loaded via native loading="lazy" — the browser
  // fetches them as they near the viewport (no observer needed), and they're cached
  // server-side so they never block the editor's video.
  if (typeof updateStagingBulkBar === 'function') updateStagingBulkBar();
}

// ── Staging multi-select (bulk delete) ──
const _stagingSelected = new Set();
function updateStagingBulkBar() {
  const bar = el('rp-stage-bulk'); if (!bar) return;
  // Drop selections for files no longer present.
  const present = new Set(_stagingFiles.map((f) => f.path));
  [..._stagingSelected].forEach((p) => { if (!present.has(p)) _stagingSelected.delete(p); });
  const n = _stagingSelected.size;
  bar.style.display = n ? 'flex' : 'none';
  const cnt = el('rp-stage-bulk-count'); if (cnt) cnt.textContent = n + ' selected';
}
el('rp-stage-bulk-clear')?.addEventListener('click', () => {
  _stagingSelected.clear();
  document.querySelectorAll('#rp-staging-list .rp-stage-card.checked').forEach((c) => { c.classList.remove('checked'); const cb = c.querySelector('.rp-sc-check input'); if (cb) cb.checked = false; });
  updateStagingBulkBar();
});
el('rp-stage-bulk-del')?.addEventListener('click', async () => {
  const paths = [..._stagingSelected];
  if (!paths.length) return;
  const ok = await customConfirm('Delete clips', `Delete ${paths.length} selected clip${paths.length === 1 ? '' : 's'} from the OBS folder? This cannot be undone.`, 'Delete');
  if (!ok) return;
  const btn = el('rp-stage-bulk-del'); if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  let done = 0;
  for (const p of paths) {
    try {
      const r = await fetch('http://localhost:3000/api/clips/delete-staged', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: p })
      });
      if (r.ok) { _stagingFiles = _stagingFiles.filter((sf) => sf.path !== p); _stagingSelected.delete(p); if (_stagingSelectedPath === p) _stagingSelectedPath = null; done++; }
    } catch {}
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Delete selected'; }
  const cnt = el('rp-staging-count'); if (cnt) cnt.textContent = _stagingFiles.length ? String(_stagingFiles.length) : '';
  renderStagingList();
  updateStagingBulkBar();
});

let _pendingNewMontage = false;

async function addStagingClipToPlaylist(f, btn) {
  if (f.imported && f.importedId) {
    const clip = (currentState.clips?.library || []).find(cl => cl.id === f.importedId);
    if (clip) { addClipToPlaylist(clip, currentState.clips); return; }
  }
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const statusEl = el('clips-status');
  try {
    const resp = await fetch('http://localhost:3000/api/clips/import-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: f.path, label: cleanFileName(f.name) })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || 'Import failed');
    f.imported = true; f.importedId = data.clip?.id || null;
    if (data.clip) addClipToPlaylist(data.clip, currentState.clips);
    renderStagingList();
    if (statusEl) { statusEl.textContent = `Imported: ${cleanFileName(f.name)}`; statusEl.style.color = 'var(--good,#48bb78)'; }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '+ PL'; }
    if (statusEl) { statusEl.textContent = 'Import failed: ' + err.message; statusEl.style.color = '#f56565'; }
  }
}

// ── Hover preview ──────────────────────────────────────────────────────────
let _hoverTimer = null;
function showHoverPreview(clip, anchorEl) {
  clearTimeout(_hoverTimer);
  _hoverTimer = setTimeout(() => {
    const pop = el('rp-hover-preview'); if (!pop) return;
    const hv = el('rp-hover-video'); if (!hv) return;
    const url = clipUrl(clip); if (!url) return;
    hv.src = url; hv.currentTime = clip.trimIn || 0;
    hv.play().catch(() => {});
    const rect = anchorEl.getBoundingClientRect();
    pop.style.left = Math.min(rect.right + 10, window.innerWidth - 240) + 'px';
    pop.style.top = Math.max(rect.top, 10) + 'px';
    pop.style.display = 'block';
    requestAnimationFrame(() => pop.classList.add('visible'));
  }, 600);
}
function hideHoverPreview() {
  clearTimeout(_hoverTimer);
  const pop = el('rp-hover-preview'); if (!pop) return;
  pop.classList.remove('visible');
  const hv = el('rp-hover-video'); if (hv) { hv.pause(); hv.src = ''; }
  setTimeout(() => { if (!pop.classList.contains('visible')) pop.style.display = 'none'; }, 130);
}

// ── Playlist pane ──────────────────────────────────────────────────────────
let timelineSortable = null;

function renderPlaylistPane(c) {
  const selEdit  = el('select-montage-edit');
  const selAdd   = el('rp-add-to-playlist-sel');
  const timeline = el('montage-timeline');
  const totalEl  = el('rp-pl-total');
  if (!selEdit || !timeline) return;
  const montages = c.montages || [];
  const prevId = selEdit.value;
  const opts = '<option value="">— New playlist —</option>' +
    montages.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  selEdit.innerHTML = opts;
  if (selAdd) selAdd.innerHTML = opts;
  if (_pendingNewMontage && montages.length) {
    _pendingNewMontage = false;
    selEdit.value = montages[0].id;
    if (selAdd) selAdd.value = montages[0].id;
  } else if (prevId && montages.some((m) => m.id === prevId)) {
    selEdit.value = prevId;
    if (selAdd) selAdd.value = prevId;
  }
  const mId = selEdit.value;
  const m = montages.find((x) => x.id === mId);
  const lib = c.library || [];

  // Vertical playlist picker (click a row to select; the hidden <select> stays the source of truth).
  const listV = el('rp-playlist-list');
  if (listV) {
    const sig = JSON.stringify(montages.map((x) => [x.id, x.name, (x.clipIds || []).length])) + '|' + mId;
    if (listV.dataset.sig !== sig) {
      listV.dataset.sig = sig;
      listV.innerHTML = montages.length ? montages.map((x) => {
        const n = (x.clipIds || []).length;
        return `<div class="rp-pl-row${x.id === mId ? ' active' : ''}" data-mid="${x.id}">
          <span class="rp-pl-row-name">${(x.name || 'Playlist').replace(/</g, '&lt;')}</span>
          <span class="rp-pl-row-count">${n} clip${n === 1 ? '' : 's'}</span>
          <button class="rp-pl-row-del" data-mid="${x.id}" title="Delete this playlist">✕</button>
        </div>`;
      }).join('') : '<div class="rp-empty" style="padding:12px 6px;">No playlists yet — hit <b>+ New</b> or add a clip from the editor.</div>';
      listV.querySelectorAll('.rp-pl-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.rp-pl-row-del')) return;
          selEdit.value = row.dataset.mid;
          if (selAdd) selAdd.value = row.dataset.mid;
          renderPlaylistPane(currentState.clips || {});
        });
      });
      listV.querySelectorAll('.rp-pl-row-del').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const pl = montages.find((x) => x.id === btn.dataset.mid);
          const ok = await customConfirm('Delete Playlist', `Delete the playlist "${pl ? pl.name : ''}"? (Clips stay in your library.)`, 'Delete');
          if (!ok) return;
          if (selEdit.value === btn.dataset.mid) { selEdit.value = ''; if (selAdd) selAdd.value = ''; }
          send('montage_delete', { montageId: btn.dataset.mid });
        });
      });
    }
  }
  const nameRow = el('rp-pl-name-row');
  if (nameRow) nameRow.style.display = m ? '' : 'none';

  if (!m) {
    timeline.innerHTML = '<div class="rp-empty">Select a playlist above to edit its clips.</div>';
    if (totalEl) totalEl.textContent = '';
    return;
  }
  const nameEl = el('rp-playlist-name');
  if (nameEl && document.activeElement !== nameEl) nameEl.value = m.name || '';
  const clips = (m.clipIds || []).map((id) => lib.find((cl) => cl.id === id)).filter(Boolean);
  let totalSec = 0;
  clips.forEach((cl) => { totalSec += cl.trimOut != null ? cl.trimOut - (cl.trimIn || 0) : (cl.duration || 0); });
  timeline.innerHTML = clips.length ? clips.map((clip, i) => {
    const inPt  = clip.trimIn || 0;
    const outPt = clip.trimOut != null ? clip.trimOut : (clip.duration || 0);
    const len   = clip.trimOut != null ? clip.trimOut - inPt : (clip.duration || 0);
    const splitInfo = clip.trimOut != null || inPt > 0
      ? `<span style="color:var(--cp-accent,#ec4899)">${fmtTime(inPt)} → ${fmtTime(outPt)}</span> · ${fmtTime(len)}`
      : fmtTime(len) || '—';
    const plUrl = clipUrl(clip);
    return `<div class="rp-pl-item" data-clip-id="${clip.id}">
      <span class="rp-pl-num">${i + 1}</span>
      <div class="rp-pl-thumb">${plUrl
        ? `<video muted playsinline preload="metadata" src="${plUrl}" style="width:100%;height:100%;object-fit:cover;display:none;" data-plthumb></video><svg viewBox="0 0 24 24" width="12" height="12" fill="rgba(255,255,255,0.3)"><path d="M8 5v14l11-7z"/></svg>`
        : `<svg viewBox="0 0 24 24" width="12" height="12" fill="rgba(255,255,255,0.3)"><path d="M8 5v14l11-7z"/></svg>`}</div>
      <div class="rp-pl-body">
        <div class="rp-pl-name">${(clip.name || 'Clip').replace(/</g, '&lt;')}</div>
        <div class="rp-pl-meta">${splitInfo}</div>
      </div>
      <button class="rp-pl-del" data-mid="${mId}" data-cid="${clip.id}">✕</button>
    </div>`;
  }).join('') : '<div class="rp-empty">Playlist is empty — add clips from the library or staging area</div>';
  if (totalEl) totalEl.textContent = clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${fmtTime(totalSec)}` : '';
  timeline.querySelectorAll('video[data-plthumb]').forEach((v) => {
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(v.duration * 0.15, 3); });
    v.addEventListener('seeked', () => {
      v.style.display = 'block';
      v.parentElement?.querySelectorAll('svg').forEach(s => s.remove());
    });
  });
  timeline.querySelectorAll('.rp-pl-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const order = clips.map((cl) => cl.id).filter((id) => id !== btn.dataset.cid);
      send('montage_reorder', { montageId: btn.dataset.mid, clipIds: order });
    });
  });
  // Click a playlist clip → load it into the editor (with its saved trim) to adjust.
  timeline.querySelectorAll('.rp-pl-item').forEach((item) => {
    item.title = 'Click to open in the editor';
    item.addEventListener('click', (e) => {
      if (e.target.closest('.rp-pl-del')) return;
      const clip = clips.find((cl) => cl.id === item.dataset.clipId);
      if (clip) loadClipPreview(clip);
    });
  });
  if (timelineSortable) { timelineSortable.destroy(); timelineSortable = null; }
  if (clips.length > 1 && typeof Sortable !== 'undefined') {
    timelineSortable = Sortable.create(timeline, {
      animation: 150, draggable: '.rp-pl-item',
      onEnd: () => {
        const order = [...timeline.querySelectorAll('.rp-pl-item')].map((n) => n.dataset.clipId);
        send('montage_reorder', { montageId: mId, clipIds: order });
      }
    });
  }
}

function addClipToPlaylist(clip, c) {
  const sel = el('rp-add-to-playlist-sel') || el('select-montage-edit');
  const mId = sel?.value;
  const montages = (c || currentState.clips)?.montages || [];
  const m = montages.find((x) => x.id === mId);
  if (m) {
    const order = [...(m.clipIds || [])];
    if (!order.includes(clip.id)) order.push(clip.id);
    send('montage_reorder', { montageId: m.id, clipIds: order });
  } else {
    const name = el('rp-playlist-name')?.value?.trim() || ('Playlist ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    _pendingNewMontage = true;
    send('montage_create', { name, clipIds: [clip.id], template: el('select-montage-template')?.value || 'highlights' });
  }
}

// ── Staging area event wiring ──────────────────────────────────────────────
el('tab-replays')?.addEventListener('click', () => {
  if (!_stagingFiles.length && !_stagingLoading) scanStagingArea();
});
el('rp-scan-folder')?.addEventListener('click', () => scanStagingArea());
el('rp-clip-search')?.addEventListener('input', function () {
  _stagingFilter = this.value; renderStagingList();
});
_stagingAutoTimer = setInterval(() => {
  if (document.querySelector('#tab-replays-content.active') && !_stagingLoading) scanStagingArea(true);
}, 20000);

// ── Push playlist live ─────────────────────────────────────────────────────
let _plLiveIdx = 0;
let _plLiveItems = [];
let _plLiveActive = false;
function pushPlaylistLive() {
  const mId = el('select-montage-edit')?.value; if (!mId) return;
  const m = (currentState.clips?.montages || []).find((x) => x.id === mId); if (!m) return;
  const lib = currentState.clips?.library || [];
  _plLiveItems = (m.clipIds || []).map((id) => lib.find((cl) => cl.id === id)).filter(Boolean);
  if (!_plLiveItems.length) return;
  beginReplayProgram();          // remember the scene we came from + switch to the program scene
  _plLiveActive = true;
  _plLiveIdx = 0; playNextLive();
}
function playNextLive() {
  const clip = _plLiveItems[_plLiveIdx]; if (!clip) return;
  const url = clipUrl(clip); if (!url) { _plLiveIdx++; playNextLive(); return; }
  const t = liveTransitionOpts();   // ease between clips (cut / fade / logo) on the overlay
  send('replay_play', { bus: 'program', url, name: clip.name || 'Clip', loop: false,
    trimIn: clip.trimIn || 0, trimOut: clip.trimOut ?? undefined, transition: t.transition, transitionLogo: t.transitionLogo });
  const st = el('rp-screen-status');
  if (st) { st.textContent = `ON AIR [${_plLiveIdx + 1}/${_plLiveItems.length}] ${clip.name || 'Clip'}`; st.title = st.textContent; st.style.color = 'var(--good, #48bb78)'; }
  const dur = (clip.trimOut ?? clip.duration ?? 10) - (clip.trimIn || 0);
  setTimeout(() => {
    _plLiveIdx++;
    if (_plLiveActive && _plLiveIdx < _plLiveItems.length) playNextLive();
    else if (_plLiveActive) {
      const s = el('rp-screen-status');
      if (s) { s.textContent = 'Playlist finished'; s.style.color = 'var(--muted)'; }
      _plLiveActive = false;
      endReplayProgram();   // seamless return to the prior scene (unless looping/disabled)
    }
  }, dur * 1000 + 500);
}
el('rp-playlist-push-live')?.addEventListener('click', pushPlaylistLive);

// ── Live transitions, scene-return + time-remaining ────────────────────────
let _replayOrigin = '';     // the OBS scene that was live before the replay started
let _replayActive = false;
let _replayFallbackTimer = null;   // safety net for the return-to-scene if the player misses 'ended'
let _lastProgressRx = 0;           // last time the OBS overlay reported playback position
function liveTransitionOpts() {
  const transition = el('rp-transition')?.value || 'cut';
  const transitionLogo = transition === 'logo'
    ? (_transitionLogo || (currentState.brand && currentState.brand.logo) || '')
    : '';
  return { transition, transitionLogo };
}
// Capture the scene we're leaving (once per replay), then switch to the program scene.
function beginReplayProgram() {
  if (!_replayActive) _replayOrigin = (currentState.obs && currentState.obs.currentScene) || '';
  _replayActive = true;
  clearTimeout(_replayFallbackTimer);
  replaySwitchProgramScene();
}
// Called when a non-looping replay finishes (or air is cleared): go back where we came from.
function endReplayProgram(silent) {
  if (!_replayActive) return;
  _replayActive = false;
  clearTimeout(_replayFallbackTimer);
  stopReplayCountdown();
  const ret = el('rp-return-scene');
  if (!silent && ret && ret.checked && _replayOrigin) {
    send('replay_stop', { bus: 'program' });
    send('obs_switch_scene', { sceneName: _replayOrigin });
    const st = el('rp-screen-status'); if (st) { st.textContent = 'Returned to ' + _replayOrigin; st.style.color = 'var(--muted)'; }
  }
  _replayOrigin = '';
}

// Time-remaining readout, driven by the overlay's playback reports.
function fmtClock(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
function playlistRemainingAfterCurrent() {
  let s = 0;
  if (_plLiveActive) {
    for (let i = _plLiveIdx + 1; i < _plLiveItems.length; i++) {
      const c = _plLiveItems[i];
      s += Math.max(0, (c.trimOut ?? c.duration ?? 10) - (c.trimIn || 0));
    }
  }
  return s;
}
function showReplayCountdown(remaining) {
  const total = remaining + playlistRemainingAfterCurrent();
  const txt = fmtClock(total);
  const elT = el('rp-time-left');
  if (elT) {
    elT.textContent = txt;
    elT.classList.add('live');
    elT.classList.toggle('ending', total <= 5 && total > 0 && !_plLiveActive);
  }
  const mon = el('rp-mon-timer'); if (mon) mon.textContent = txt;
}
function stopReplayCountdown() {
  const elT = el('rp-time-left');
  if (elT) { elT.textContent = '--:--'; elT.classList.remove('live', 'ending'); }
  const mon = el('rp-mon-timer'); if (mon) mon.textContent = '';
}

// PVW / PGM confidence monitors — mirror the two replay buses as muted in-panel video so
// the producer sees what's cued vs. live without an OBS multiview.
function applyReplayMonitors(replay) {
  replay = replay || {};
  setReplayMonitor('rp-mon-pvw', 'rp-mon-pvw-cell', replay.preview);
  setReplayMonitor('rp-mon-pgm', 'rp-mon-pgm-cell', replay.program);
}
function setReplayMonitor(vidId, cellId, bus) {
  const v = el(vidId); const cell = el(cellId); if (!v || !cell) return;
  const live = !!(bus && bus.playing && bus.url);
  if (live) {
    // Mirror the producer's trim so the monitor shows exactly what airs.
    v._trimIn = (typeof bus.trimIn === 'number' && bus.trimIn > 0) ? bus.trimIn : 0;
    v._trimOut = (typeof bus.trimOut === 'number' && bus.trimOut > v._trimIn) ? bus.trimOut : null;
    v._trimLoop = !!bus.loop;
    wireMonitorTrim(v);
    if (v.dataset.src !== bus.url) {
      v.dataset.src = bus.url; v.src = bus.url; v.loop = false;
      v.muted = true;            // monitors are silent; OBS carries the real audio
      const p = v.play(); if (p && p.catch) p.catch(() => {});
    }
    cell.classList.add('live');
  } else {
    if (v.dataset.src) { v.dataset.src = ''; v.pause(); v.removeAttribute('src'); v.load(); }
    cell.classList.remove('live');
  }
}
// Seek a monitor to its in-point and loop/hold at its out-point (matching the on-air player).
function wireMonitorTrim(v) {
  if (v._trimWired) return; v._trimWired = true;
  v.addEventListener('loadedmetadata', () => {
    if (v._trimIn > 0 && v.currentTime < v._trimIn - 0.05) { try { v.currentTime = v._trimIn; } catch (e) {} }
  });
  v.addEventListener('timeupdate', () => {
    if (v._trimOut != null && v.currentTime >= v._trimOut - 0.02) {
      if (v._trimLoop) { try { v.currentTime = v._trimIn || 0; } catch (e) {} }
      else v.pause();   // hold on the last frame, just like the program output
    }
  });
  v.addEventListener('ended', () => {
    if (v._trimLoop) { try { v.currentTime = v._trimIn || 0; } catch (e) {} const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  });
}

// Prompt-mode pop-up: "Clip this highlight?" → accept sends clip_prompt_accept.
function showClipPrompt(p) {
  const wrap = el('clip-prompts'); if (!wrap || !p) return;
  const card = document.createElement('div');
  card.className = 'clip-prompt';
  card.innerHTML = `
    <div class="cp-body"><span class="cp-dot"></span>
      <div><div class="cp-title"></div><div class="cp-sub">Clip this?</div></div></div>
    <div class="cp-actions">
      <button class="btn btn-primary btn-sm cp-yes">Clip it</button>
      <button class="btn btn-ghost btn-sm cp-no">Dismiss</button>
    </div>`;
  card.querySelector('.cp-title').textContent = (p.label || 'Highlight') + (p.player ? ' · ' + p.player : '');
  const remove = () => { card.classList.add('out'); setTimeout(() => card.remove(), 200); };
  card.querySelector('.cp-yes').addEventListener('click', () => { send('clip_prompt_accept', { meta: p.meta }); remove(); });
  card.querySelector('.cp-no').addEventListener('click', remove);
  setTimeout(remove, 12000);  // auto-dismiss (replay buffer window)
  wrap.appendChild(card);
  while (wrap.children.length > 4) wrap.firstChild.remove();
}

function applyClipsState(c) {
  if (!c) return;
  const folder = el('input-replay-folder');
  if (folder && document.activeElement !== folder) folder.value = c.replayFolder || '';

  const mode = c.captureMode || 'auto';
  document.querySelectorAll('#clip-mode-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const am = el('check-auto-montage'); if (am && document.activeElement !== am) am.checked = !!c.autoMontage;
  const desc = el('clip-mode-desc');
  if (desc) desc.textContent = {
    auto: 'Highlights are clipped automatically as they happen.',
    prompt: 'When a highlight happens, a pop-up asks if you want to clip it.',
    manual: 'Nothing is clipped automatically — use "Capture now".'
  }[mode] || '';
  const rules = c.captureRules || {};
  [['goal', 'check-capture-goal'], ['ace', 'check-capture-ace'], ['clutch', 'check-capture-clutch'], ['save', 'check-capture-save'], ['demo', 'check-capture-demo'], ['shot', 'check-capture-shot']].forEach(([k, id]) => {
    const cb = el(id); if (cb) cb.checked = rules[k] !== false;
  });

  refreshStagingImportedFlags();
  renderStagingList();

  const montageListEl = el('montage-list');
  if (montageListEl) {
    const exps = (c.montages || []).filter((m) => m.outputPath);   // only encoded exports
    montageListEl.innerHTML = exps.length ? exps.map((m) =>
      `<div class="montage-card">
        <div style="min-width:0;"><strong>${(m.name || 'Montage').replace(/</g, '&lt;')}</strong><div style="font-size:11px;color:var(--muted)">${(m.clipIds || []).length} clips · exported</div></div>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="btn btn-danger btn-sm btn-montage-screen" data-mid="${m.id}" title="Play this export on Program">To air</button>
          <button class="rp-vi-del btn-montage-delx" data-mid="${m.id}" title="Delete this encoded file (the playlist stays)">✕</button>
        </div>
      </div>`
    ).join('') : '<div style="color:var(--muted);font-size:12px;">No exports yet — encode a playlist to create one.</div>';
    montageListEl.querySelectorAll('.btn-montage-screen').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = (c.montages || []).find((x) => x.id === btn.dataset.mid);
        const url = montageUrl(m); if (!url) return;
        beginReplayProgram();   // exported montages already have transitions baked in
        send('replay_play', { bus: 'program', url, name: m.name || 'Montage', loop: !!el('rp-screen-loop')?.checked });
        const st = el('rp-screen-status'); if (st) { st.textContent = 'ON AIR: ' + (m.name || 'Montage'); st.style.color = 'var(--good, #48bb78)'; }
      });
    });
    montageListEl.querySelectorAll('.btn-montage-delx').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await customConfirm('Delete Export', 'Delete this encoded file? The playlist stays and can be re-encoded.', 'Delete');
        if (ok) send('montage_delete_export', { montageId: btn.dataset.mid });
      });
    });
  }

  renderPlaylistPane(c);
}

// ── Clip preview + visual trim bar ─────────────────────────────────────────
let _previewClip = null;
function clipUrl(clip) {
  if (!clip) return '';
  if (clip._url) return clip._url;
  if (clip.rawPath) return fileUrl(clip.rawPath);
  if (!clip.path) return '';
  return 'http://localhost:3000/data/clips/' + clip.path.split(/[\\/]/).pop();
}

function updateTrimBar() {
  if (!_previewClip) return;
  const track = el('rp-trim-track'); if (!track) return;
  const v = el('clip-preview-video');
  const dur = v?.duration || 0;
  if (dur <= 0) return;
  const W = track.offsetWidth;
  const inPct  = ((_previewClip.trimIn || 0) / dur) * 100;
  const outPct = (_previewClip.trimOut != null ? _previewClip.trimOut : dur) / dur * 100;
  const nowPct = ((v?.currentTime || 0) / dur) * 100;

  const region = el('rp-trim-region');
  if (region) { region.style.left = inPct + '%'; region.style.width = (outPct - inPct) + '%'; }

  const hIn = el('rp-trim-handle-in');
  if (hIn) hIn.style.left = inPct + '%';

  const hOut = el('rp-trim-handle-out');
  if (hOut) hOut.style.right = (100 - outPct) + '%';

  const ph = el('rp-trim-playhead');
  if (ph) ph.style.left = nowPct + '%';

  const inVal  = el('clip-trim-in-val');
  const outVal = el('clip-trim-out-val');
  if (inVal)  inVal.textContent  = fmtTime(_previewClip.trimIn || 0);
  if (outVal) outVal.textContent = _previewClip.trimOut != null ? fmtTime(_previewClip.trimOut) : 'end';

  const durEl = el('rp-trim-dur');
  const effectiveDur = (_previewClip.trimOut ?? dur) - (_previewClip.trimIn || 0);
  if (durEl) durEl.textContent = fmtTime(effectiveDur);
}

function initTrimBar() {
  const track = el('rp-trim-track'); if (!track) return;
  const v = el('clip-preview-video'); if (!v) return;
  v.addEventListener('timeupdate', updateTrimBar);
  v.addEventListener('loadedmetadata', () => {
    const t0 = el('rp-trim-t0'); if (t0) t0.textContent = '0:00.0';
    const dur = el('rp-trim-dur'); if (dur) dur.textContent = fmtTime(v.duration);
    updateTrimBar();
    generateFilmstrip(v);
  });
  function timeFromX(clientX) {
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (v.duration || 0);
  }
  let dragTarget = null;
  function onPointerMove(e) {
    if (!dragTarget) return;
    const t = timeFromX(e.clientX);
    if (dragTarget === 'in') {
      _previewClip.trimIn = Math.min(t, _previewClip.trimOut != null ? _previewClip.trimOut - 0.1 : (v.duration || 0));
      v.currentTime = _previewClip.trimIn;
    } else if (dragTarget === 'out') {
      _previewClip.trimOut = Math.max(t, (_previewClip.trimIn || 0) + 0.1);
      v.currentTime = _previewClip.trimOut;
    } else {
      v.currentTime = t;
    }
    updateTrimBar();
    const tip = el('rp-trim-time-cur');
    if (tip) { tip.textContent = fmtTime(t); tip.style.left = Math.min(95, ((t / (v.duration || 1)) * 100)) + '%'; tip.style.opacity = '1'; }
  }
  function onPointerUp() {
    dragTarget = null;
    const tip = el('rp-trim-time-cur'); if (tip) tip.style.opacity = '0';
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }
  el('rp-trim-handle-in')?.addEventListener('pointerdown', (e) => {
    if (!_previewClip) return; e.preventDefault(); dragTarget = 'in';
    document.addEventListener('pointermove', onPointerMove); document.addEventListener('pointerup', onPointerUp);
  });
  el('rp-trim-handle-out')?.addEventListener('pointerdown', (e) => {
    if (!_previewClip) return; e.preventDefault(); dragTarget = 'out';
    document.addEventListener('pointermove', onPointerMove); document.addEventListener('pointerup', onPointerUp);
  });
  track.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.rp-trim-handle')) return;
    if (!_previewClip) return; e.preventDefault(); dragTarget = 'seek';
    v.currentTime = timeFromX(e.clientX); updateTrimBar();
    document.addEventListener('pointermove', onPointerMove); document.addEventListener('pointerup', onPointerUp);
  });
}

function loadClipPreview(clip) {
  const url = clipUrl(clip);
  _previewClip = {
    id: clip.id || null,
    rawPath: clip.rawPath || null,
    path: clip.path || null,
    name: clip.name || 'Clip',
    trimIn: clip.trimIn || 0,
    trimOut: clip.trimOut != null ? clip.trimOut : null,
    _url: url
  };
  selectedClipId = clip.id || null;
  const v = el('clip-preview-video');
  if (v) { v.src = url; v.load(); const sp = el('rp-speed'); v.playbackRate = sp ? Number(sp.value) || 1 : 1; }
  const nm = el('clip-preview-name'); if (nm) nm.textContent = clip.name || 'Clip';
  const t = el('rp-title'); if (t) t.value = clip.name || '';
  const d = el('rp-desc'); if (d) d.value = clip.description || '';
  const mp = el('rp-map'); if (mp) mp.value = clip.map || '';
  updateTrimBar();
}

initTrimBar();
// Surface a genuine video-load failure in the editor instead of spinning forever.
el('clip-preview-video')?.addEventListener('error', function () {
  const nm = el('clip-preview-name');
  if (nm) { nm.textContent = 'Could not load this video (format or file access).'; nm.style.color = '#f56565'; }
});

// Keyboard shortcuts for the video editor
document.addEventListener('keydown', (e) => {
  const v = el('clip-preview-video');
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
  if (!v || !_previewClip) return;
  const dur = v.duration || 0;
  const fps = 30;
  if (e.code === 'Space') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  else if (e.code === 'KeyI') { _previewClip.trimIn = Math.round(v.currentTime * 10) / 10; updateTrimBar(); }
  else if (e.code === 'KeyO') { _previewClip.trimOut = Math.round(v.currentTime * 10) / 10; updateTrimBar(); }
  else if (e.code === 'KeyC') { _previewClip.trimIn = 0; _previewClip.trimOut = null; updateTrimBar(); }
  else if (e.code === 'KeyJ') { v.currentTime = Math.max(0, v.currentTime - 2); }
  else if (e.code === 'KeyL') { v.currentTime = Math.min(dur, v.currentTime + 2); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 1 / fps); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); v.currentTime = Math.min(dur, v.currentTime + 1 / fps); }
});

el('clip-set-in')?.addEventListener('click', () => {
  const v = el('clip-preview-video'); if (!v || !_previewClip) return;
  _previewClip.trimIn = Math.round(v.currentTime * 10) / 10;
  if (_previewClip.trimOut != null && _previewClip.trimOut <= _previewClip.trimIn) _previewClip.trimOut = null;
  updateTrimBar();
});
el('clip-set-out')?.addEventListener('click', () => {
  const v = el('clip-preview-video'); if (!v || !_previewClip) return;
  const t = Math.round(v.currentTime * 10) / 10;
  _previewClip.trimOut = t > (_previewClip.trimIn || 0) ? t : null;
  updateTrimBar();
});
el('clip-go-in')?.addEventListener('click', () => { const v = el('clip-preview-video'); if (v && _previewClip) v.currentTime = _previewClip.trimIn || 0; });
el('clip-go-out')?.addEventListener('click', () => { const v = el('clip-preview-video'); if (v && _previewClip && _previewClip.trimOut != null) v.currentTime = _previewClip.trimOut; });
el('clip-trim-clear')?.addEventListener('click', () => { if (_previewClip) { _previewClip.trimIn = 0; _previewClip.trimOut = null; updateTrimBar(); } });
el('clip-trim-save')?.addEventListener('click', async () => {
  if (!_previewClip) return;
  const st = el('clips-status');
  // Raw staging file — import first, then save trim
  if (!_previewClip.id && _previewClip.rawPath) {
    if (st) { st.textContent = 'Importing before save…'; st.style.color = ''; }
    try {
      const resp = await fetch('http://localhost:3000/api/clips/import-file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: _previewClip.rawPath, label: el('rp-title')?.value || _previewClip.name })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Import failed');
      _previewClip.id = data.clip?.id;
      // fall through to save trim
    } catch (err) {
      if (st) { st.textContent = 'Import failed: ' + err.message; st.style.color = '#f56565'; }
      return;
    }
  }
  send('clip_update', {
    id: _previewClip.id,
    name: el('rp-title')?.value ?? _previewClip.name,
    description: el('rp-desc')?.value || '',
    map: el('rp-map')?.value || '',
    trimIn: _previewClip.trimIn || 0,
    trimOut: _previewClip.trimOut
  });
  if (st) { st.textContent = 'Saved.'; st.style.color = 'var(--good, #48bb78)'; }
});
el('rp-speed')?.addEventListener('change', function () {
  const v = el('clip-preview-video'); if (v) v.playbackRate = Number(this.value) || 1;
});

// ── REPLAYS: buffer + send-to-screen (program / preview buses) ────────────
function montageUrl(m) {
  if (!m || !m.outputPath) return '';
  return 'http://localhost:3000/data/clips/exports/' + m.outputPath.split(/[\\/]/).pop();
}
// Resolve the URL + label for whatever the editor currently has loaded.
function currentEditorClip() {
  if (!_previewClip) return null;
  const url = _previewClip._url || clipUrl(_previewClip);
  return { url, name: el('rp-title')?.value || _previewClip.name || 'Replay' };
}
// When pushing to Program, optionally switch OBS to the scene the producer picked on this page.
const RP_PROGRAM_SCENE_KEY = 'ne_replay_program_scene';
function replaySwitchProgramScene() {
  const sc = el('rp-program-scene')?.value;
  if (sc) send('obs_switch_scene', { sceneName: sc });
}
function syncReplayProgramScene(obs) {
  const sel = el('rp-program-scene'); if (!sel) return;
  const scenes = Array.isArray(obs && obs.availableScenes) ? obs.availableScenes : [];
  const saved = (() => { try { return localStorage.getItem(RP_PROGRAM_SCENE_KEY) || ''; } catch { return ''; } })();
  const want = sel.value || saved;
  const sig = JSON.stringify(scenes);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '<option value="">OBS scene: none</option>' +
      scenes.map((s) => `<option value="${String(s).replace(/"/g, '&quot;')}">${String(s).replace(/</g, '&lt;')}</option>`).join('');
  }
  if (want && scenes.includes(want) && document.activeElement !== sel) sel.value = want;
}
el('rp-program-scene')?.addEventListener('change', function () {
  try { localStorage.setItem(RP_PROGRAM_SCENE_KEY, this.value || ''); } catch {}
});

function sendToScreen(bus) {
  const sel = currentEditorClip();
  if (!sel || !sel.url) {
    const st = el('rp-screen-status'); if (st) { st.textContent = 'Load a clip first.'; st.style.color = '#f56565'; }
    return;
  }
  const loop = !!el('rp-screen-loop')?.checked;
  if (bus === 'program') beginReplayProgram();
  const t = liveTransitionOpts();
  send('replay_play', {
    bus, url: sel.url, name: sel.name, loop,
    trimIn: _previewClip.trimIn || 0,
    trimOut: _previewClip.trimOut ?? null,
    transition: t.transition, transitionLogo: t.transitionLogo
  });
  const st = el('rp-screen-status');
  if (st) { st.textContent = (bus === 'preview' ? 'Preview: ' : 'ON AIR: ') + sel.name + (loop ? ' (loop)' : ''); st.style.color = bus === 'preview' ? 'var(--muted)' : 'var(--good, #48bb78)'; }
  // Safety net: return to the prior scene even if the player's 'ended' report is missed.
  clearTimeout(_replayFallbackTimer);
  if (bus === 'program' && !loop) {
    const d = (_previewClip.trimOut ?? _previewClip.duration ?? 0) - (_previewClip.trimIn || 0);
    if (d > 0) _replayFallbackTimer = setTimeout(() => { if (_replayActive && !_plLiveActive) endReplayProgram(); }, d * 1000 + 1500);
  }
}
el('rp-buffer-toggle')?.addEventListener('click', () => send('obs_toggle_replay_buffer'));
el('rp-buffer-save')?.addEventListener('click', () => send('obs_save_replay'));
el('rp-to-program')?.addEventListener('click', () => sendToScreen('program'));
el('rp-to-preview')?.addEventListener('click', () => sendToScreen('preview'));
el('rp-screen-clear')?.addEventListener('click', () => {
  _plLiveActive = false;
  send('replay_stop', { bus: 'program' });
  endReplayProgram(true);   // manual clear — just reset, don't auto-switch scenes
  const st = el('rp-screen-status'); if (st) { st.textContent = 'Program cleared.'; st.style.color = 'var(--muted)'; }
});
el('rp-screen-open')?.addEventListener('click', () => window.open('http://localhost:3000/replay-player.html', '_blank', 'noopener'));
function takeToProgram() {
  // Nothing cued? Tell the producer instead of taking black to air.
  if (!(currentState.replay && currentState.replay.preview && currentState.replay.preview.playing && currentState.replay.preview.url)) {
    const st = el('rp-screen-status'); if (st) { st.textContent = 'Nothing in Preview to take.'; st.style.color = '#f56565'; }
    return;
  }
  beginReplayProgram();
  const t = liveTransitionOpts();
  send('replay_take', { transition: t.transition, transitionLogo: t.transitionLogo });
  const st = el('rp-screen-status'); if (st) { st.textContent = 'Preview taken to Program.'; st.title = st.textContent; st.style.color = 'var(--good, #48bb78)'; }
}
el('rp-take')?.addEventListener('click', takeToProgram);
el('rp-mv-take')?.addEventListener('click', takeToProgram);
// Fallback countdown source: if the OBS overlay isn't open/reporting, drive the timer from
// the in-panel PROGRAM monitor instead so producers always see time remaining.
el('rp-mon-pgm')?.addEventListener('timeupdate', function () {
  if (!this.dataset.src || Date.now() - _lastProgressRx < 1500) return;
  const dur = this.duration || 0;
  showReplayCountdown(Math.max(0, dur - (this.currentTime || 0)));
});
el('rp-settings-toggle')?.addEventListener('click', () => { const m = el('rp-capture-modal'); if (m) m.style.display = 'flex'; });
el('rp-capture-close')?.addEventListener('click', () => { const m = el('rp-capture-modal'); if (m) m.style.display = 'none'; });
el('rp-capture-modal')?.addEventListener('click', (e) => { if (e.target === el('rp-capture-modal')) el('rp-capture-modal').style.display = 'none'; });

// ── REPLAYS: playlist actions ──────────────────────────────────────────────
el('rp-save-playlist')?.addEventListener('click', async () => {
  if (!_previewClip) { const st = el('clips-status'); if (st) { st.textContent = 'Load a clip first.'; st.style.color = '#f56565'; } return; }
  // If this is a raw staging file (no library ID), import it first
  if (!_previewClip.id && _previewClip.rawPath) {
    const stagingFile = _stagingFiles.find(f => f.path === _previewClip.rawPath);
    if (stagingFile) { await addStagingClipToPlaylist(stagingFile, null); return; }
  }
  const clip = (currentState.clips?.library || []).find((x) => x.id === _previewClip.id) || _previewClip;
  addClipToPlaylist(clip, currentState.clips);
});
el('rp-new-playlist')?.addEventListener('click', () => {
  const n = ((currentState.clips && currentState.clips.montages) || []).length + 1;
  _pendingNewMontage = true;   // auto-select the new playlist when it comes back
  send('montage_create', { name: 'Playlist ' + n, clipIds: [], template: el('select-montage-template')?.value || 'highlights' });
});
el('rp-rename-playlist')?.addEventListener('click', () => {
  const mId = el('select-montage-edit')?.value; if (!mId) return;
  const name = el('rp-playlist-name')?.value?.trim(); if (!name) return;
  send('montage_rename', { montageId: mId, name });
});
el('rp-process')?.addEventListener('click', () => {
  const mId = el('select-montage-edit')?.value;
  if (!mId) {
    const rpWrap = el('rp-encode-progress'); const rpLabel = el('rp-encode-label');
    if (rpWrap && rpLabel) { rpWrap.style.display = 'flex'; rpLabel.textContent = 'Select a playlist first.'; rpLabel.style.color = '#f56565'; setTimeout(() => { rpWrap.style.display = 'none'; rpLabel.style.color = ''; }, 3000); }
    return;
  }
  // Show progress bar immediately (server will push updates)
  const rpWrap = el('rp-encode-progress'); const rpLabel = el('rp-encode-label');
  const rpFill = el('rp-encode-fill'); const rpPct = el('rp-encode-pct');
  if (rpWrap) { rpWrap.style.display = 'flex'; if (rpLabel) { rpLabel.textContent = 'Queued…'; rpLabel.style.color = ''; } if (rpFill) rpFill.style.width = '0%'; if (rpPct) rpPct.textContent = '0%'; }
  el('rp-process').disabled = true;
  const transition = el('rp-transition')?.value || 'cut';
  send('montage_encode', {
    montageId: mId,
    opts: {
      quality: el('rp-quality')?.value || 'medium',
      gpu: !!el('rp-gpu')?.checked,
      format: el('rp-format')?.value || '.mp4',
      transition,
      // Logo transition uses a picked image, falling back to the active brand logo.
      transitionLogo: transition === 'logo' ? (_transitionLogo || (currentState.brand && currentState.brand.logo) || null) : undefined
    }
  });
});
// Logo-transition picker (shown only when transition = Logo).
let _transitionLogo = null;
function updateTransLogoRow() {
  const sel = el('rp-transition'); const row = el('rp-translogo-row');
  if (row) row.style.display = (sel && sel.value === 'logo') ? 'flex' : 'none';
  const prev = el('rp-translogo-preview');
  if (prev) prev.src = _transitionLogo || (currentState.brand && currentState.brand.logo) || '';
}
el('rp-transition')?.addEventListener('change', updateTransLogoRow);
el('rp-translogo-file')?.addEventListener('change', function () {
  const f = this.files && this.files[0]; if (!f || !f.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => { _transitionLogo = reader.result; updateTransLogoRow(); };
  reader.readAsDataURL(f);
});
el('rp-clear-playlist')?.addEventListener('click', () => {
  const mId = el('select-montage-edit')?.value;
  if (mId) send('montage_reorder', { montageId: mId, clipIds: [] });
});

function applyEncodeProgress(enc) {
  const active = enc && enc.active;
  const isEncoding = active && (active.status === 'encoding' || active.status === 'queued');
  const isDone     = active && active.status === 'done';
  const pct  = isEncoding ? (active.progress || 0) : isDone ? 100 : 0;
  const name = isDone ? '✓ Done' : (active?.name || 'Encoding…');

  // Global header bar
  const wrap  = el('qt-encode-wrap');
  const label = el('qt-encode-label');
  const fill  = el('qt-encode-fill');
  const pctEl = el('qt-encode-pct');
  if (wrap) {
    if (isEncoding || isDone) {
      wrap.style.display = 'flex';
      if (label) label.textContent = name;
      if (fill) fill.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
      if (isDone) setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 4000);
    } else { wrap.style.display = 'none'; }
  }

  // Inline progress bar in the playlist pane
  const rpWrap  = el('rp-encode-progress');
  const rpLabel = el('rp-encode-label');
  const rpFill  = el('rp-encode-fill');
  const rpPct   = el('rp-encode-pct');
  const rpEnc   = el('rp-process');
  if (rpWrap) {
    if (isEncoding || isDone) {
      rpWrap.style.display = 'flex';
      if (rpLabel) rpLabel.textContent = name;
      if (rpFill)  rpFill.style.width  = pct + '%';
      if (rpPct)   rpPct.textContent   = pct + '%';
      if (rpEnc)   rpEnc.disabled = isEncoding;
      if (isDone)  setTimeout(() => { if (rpWrap) rpWrap.style.display = 'none'; if (rpEnc) rpEnc.disabled = false; }, 4000);
    } else {
      rpWrap.style.display = 'none';
      if (rpEnc) rpEnc.disabled = false;
    }
  }
}

function applyTwitchState(twitch) {
  if (!twitch) return;

  // Update connection status and UI
  const statusEl = el('twitch-status');
  const loginPanel = el('twitch-login-panel');
  const tokenDisplay = el('twitch-token-display');
  const userDisplay = el('twitch-user-display');

  // Update integration store card regardless of view
  const cardBadge     = el('twitch-status-badge');
  const cardBtn       = el('twitch-card-btn');
  const cardName      = el('twitch-card-name');
  const cardIcon      = el('twitch-card-icon');
  const cardAvatar    = el('twitch-card-avatar');
  const cardLogoBadge = el('twitch-card-logo-badge');
  if (twitch.connected && twitch.displayName) {
    if (cardBadge)  { cardBadge.textContent = 'Connected'; cardBadge.style.color = '#4ade80'; cardBadge.style.background = 'rgba(74,222,128,0.1)'; }
    if (cardBtn)    { cardBtn.textContent = 'Settings'; cardBtn.className = 'btn btn-sm btn-secondary'; }
    if (cardName)   cardName.textContent = twitch.displayName;
    if (twitch.profilePicture) {
      if (cardIcon)      cardIcon.style.display = 'none';
      if (cardAvatar)    { cardAvatar.src = twitch.profilePicture; cardAvatar.style.display = 'block'; }
      if (cardLogoBadge) cardLogoBadge.style.display = 'block';
    }
  } else {
    if (cardBadge)     { cardBadge.textContent = 'Not Connected'; cardBadge.style.color = '#9146ff'; cardBadge.style.background = 'rgba(145,70,255,0.2)'; }
    if (cardBtn)       { cardBtn.textContent = 'Connect'; cardBtn.className = 'btn btn-sm btn-primary'; }
    if (cardName)      cardName.textContent = 'Twitch';
    if (cardIcon)      cardIcon.style.display = '';
    if (cardAvatar)    cardAvatar.style.display = 'none';
    if (cardLogoBadge) cardLogoBadge.style.display = 'none';
  }

  if (twitch.connected && twitch.displayName) {
    // Logged in
    if (statusEl) statusEl.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" style="vertical-align:middle"><circle cx="12" cy="12" r="12" fill="#4ade80"/></svg> Connected';
    if (loginPanel) loginPanel.style.display = 'none';
    if (tokenDisplay) tokenDisplay.style.display = 'block';
    if (userDisplay) userDisplay.textContent = twitch.displayName;

    // Display profile picture if available
    const avatarImg = el('twitch-user-avatar');
    const avatarFallback = el('twitch-user-avatar-fallback');
    if (twitch.profilePicture && avatarImg) {
      avatarImg.src = twitch.profilePicture;
      avatarImg.style.display = 'block';
      if (avatarFallback) avatarFallback.style.display = 'none';
    }

    // Display channel ID
    const channelIdEl = el('twitch-channel-id');
    if (channelIdEl && twitch.channelId) {
      channelIdEl.textContent = `Channel ID: ${twitch.channelId}`;
    }

    // Show connected sections
    ['twitch-eventsub-section', 'twitch-chat-section', 'twitch-stream-section'].forEach(id => {
      const s = el(id); if (s) s.style.display = 'block';
    });

    // Sidebar chat status — sync from state so it's correct even if we missed the one-shot event
    const sidebarChatStatus  = el('chat-connection-status');
    const sidebarChatLoading = el('chat-loading');
    if (twitch.chatConnected) {
      if (sidebarChatStatus)  { sidebarChatStatus.style.display = 'inline'; sidebarChatStatus.textContent = `🟢 #${twitch.chatChannel || 'connected'}`; }
      if (sidebarChatLoading) sidebarChatLoading.style.display = 'none';
    } else {
      if (sidebarChatStatus)  sidebarChatStatus.style.display = 'none';
      if (sidebarChatLoading) { sidebarChatLoading.style.display = 'inline'; sidebarChatLoading.textContent = 'Connecting to chat…'; sidebarChatLoading.style.color = '#888'; }
    }

    // Stream state — fetch and populate
    fetchAndRenderStreamState();
    startStreamStatePolling();
    loadChatAutomations();
    updateChatStatus();
  } else {
    // Not connected
    if (statusEl) statusEl.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" style="vertical-align:middle"><circle cx="12" cy="12" r="12" fill="#f56565"/></svg> Not Connected';
    if (loginPanel) loginPanel.style.display = 'block';
    if (tokenDisplay) tokenDisplay.style.display = 'none';

    ['twitch-eventsub-section', 'twitch-chat-section', 'twitch-stream-section'].forEach(id => {
      const s = el(id); if (s) s.style.display = 'none';
    });
    stopStreamStatePolling();
  }

  // Update prediction display
  const predDisplay = el('active-prediction-display');
  const predStatus = el('prediction-status');

  if (twitch.predictions?.current) {
    const pred = twitch.predictions.current;

    if (predDisplay) predDisplay.style.display = 'block';

    const titleEl = el('pred-title-display');
    if (titleEl) titleEl.textContent = pred.title;

    const outcomesEl = el('pred-outcomes-display');
    if (outcomesEl && pred.outcomes) {
      const totalVotes = pred.outcomes.reduce((sum, o) => sum + (o.votes || 0), 0);
      outcomesEl.innerHTML = pred.outcomes.map(outcome => {
        const pct = totalVotes > 0 ? Math.round((outcome.votes || 0) / totalVotes * 100) : 0;
        return `<div style="background:rgba(255,255,255,0.04);border-radius:6px;padding:10px 12px;position:relative;overflow:hidden;">
          <div style="position:absolute;top:0;left:0;height:100%;width:${pct}%;background:rgba(145,70,255,0.18);transition:width 0.4s;"></div>
          <div style="position:relative;display:flex;align-items:center;gap:8px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(outcome.title)}</div>
              <div style="font-size:11px;color:var(--muted);">${outcome.votes || 0} votes · ${pct}%</div>
            </div>
            <button class="btn btn-xs btn-success pred-declare-winner-btn" style="font-size:11px;flex-shrink:0;padding:4px 10px;"
              data-outcome-id="${outcome.id}" data-outcome-title="${escapeHtml(outcome.title)}">Declare Winner</button>
          </div>
        </div>`;
      }).join('');
    }

    // Countdown timer
    _startPredCountdown(pred.endsAt);

    if (predStatus) {
      predStatus.textContent = `Active: ${pred.title}`;
      predStatus.style.color = '#9146ff';
    }
  } else {
    if (predDisplay) predDisplay.style.display = 'none';
    _stopPredCountdown();
    if (predStatus) {
      predStatus.textContent = 'No active prediction';
      predStatus.style.color = 'var(--muted)';
    }
  }

  // Update wheel display
  if (twitch.wheel) {
    const wheelStatus = el('wheel-status');
    if (wheelStatus) {
      const participants = twitch.wheel.participants?.length || 0;
      const spins = twitch.wheel.history?.length || 0;
      wheelStatus.textContent = `${participants} participants • ${spins} spins`;
      wheelStatus.style.color = participants > 0 ? '#4ECDC4' : 'var(--muted)';
    }
  }

  // Update minigame display and settings
  if (twitch.minigame) {
    const gameStatus = el('minigame-status');
    const autoStartCheck = el('minigame-auto-start');
    const autoTypeSelect = el('minigame-auto-type');

    if (gameStatus) {
      if (twitch.minigame.current && twitch.minigame.current.state === 'active') {
        const game = twitch.minigame.current;
        gameStatus.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><rect x="2" y="6" width="20" height="12" rx="6"/></svg> <strong>${game.type.toUpperCase()}</strong> active ·
          ${(game.responses && Object.keys(game.responses).length) ||
            (game.entries && game.entries.length) ||
            (game.options && game.options.reduce((s, o) => s + (o.votes || 0), 0)) || 0}
          participating
        `;
        gameStatus.style.color = '#FFE66D';
      } else {
        gameStatus.textContent = 'No active game';
        gameStatus.style.color = 'var(--muted)';
      }
    }

    // Update settings UI (legacy inline — full populate done below)
    if (autoStartCheck) {
      autoStartCheck.checked = twitch.minigame.settings?.enabled !== false;
    }
    if (autoTypeSelect) {
      autoTypeSelect.value = twitch.minigame.settings?.breakScreenGameType || 'trivia';
    }
  }

  // Populate all settings panels (predictions/wheel/minigame) from state
  populateTwitchGameSettings(twitch);
}

el('check-director-enabled')?.addEventListener('change', function() {
  send('set_director', { enabled: this.checked });
});
el('range-director-sensitivity')?.addEventListener('input', function() {
  const v = el('director-sens-val');
  if (v) v.textContent = this.value + '%';
});
el('range-director-sensitivity')?.addEventListener('change', function() {
  send('set_director', { sensitivity: Number(this.value) / 100 });
});
el('btn-director-accept')?.addEventListener('click', () => send('director_accept'));
el('btn-director-lock')?.addEventListener('click', () => {
  const p = currentState.director?.primary;
  if (p) send('set_director', { lockTarget: p.target?.id || p.name });
});
el('btn-director-unlock')?.addEventListener('click', () => {
  send('set_director', { lockTarget: null });
  send('director_feedback', { action: 'overridden' });
});
el('check-director-autoswitch')?.addEventListener('change', function() {
  send('set_director', { autoSwitch: this.checked });
});

el('select-montage-edit')?.addEventListener('change', () => {
  if (currentState.clips) renderPlaylistPane(currentState.clips);
});

el('input-replay-folder')?.addEventListener('change', function() {
  send('set_clips', { replayFolder: this.value.trim() });
});
document.querySelectorAll('#clip-mode-seg .seg-btn').forEach((b) => {
  b.addEventListener('click', () => send('set_clips', { captureMode: b.dataset.mode }));
});
el('check-auto-montage')?.addEventListener('change', function() {
  send('set_clips', { autoMontage: this.checked });
});
['goal', 'ace', 'clutch', 'save', 'demo', 'shot'].forEach((type) => {
  el(`check-capture-${type}`)?.addEventListener('change', function() {
    send('set_clips', { captureRules: { [type]: this.checked } });
  });
});
el('btn-clip-capture')?.addEventListener('click', () => {
  const p = currentState.director?.primary;
  send('clip_capture_manual', {
    player: p?.name || '',
    label: p ? `Manual — ${p.name}` : 'Manual clip',
    reason: 'Producer manual capture'
  });
});
el('btn-montage-create')?.addEventListener('click', () => {
  const ids = [...selectedClipIds];
  if (!ids.length) {
    const status = el('clips-status');
    if (status) { status.textContent = 'Select at least one clip first.'; status.style.color = '#f56565'; }
    return;
  }
  const tpl = el('select-montage-template')?.value || 'highlights';
  const tplNames = { highlights: 'Highlights', brb: 'BRB Reel', postgame: 'Post-Game' };
  const name = (tplNames[tpl] || 'Reel') + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  send('montage_create', { name, clipIds: ids, template: tpl });
  selectedClipIds.clear();
});

// ── System toast (resource warnings, crash alerts) ────────────────────────
function showToast(message, bg, autoDismissMs) {
  const toast = el('resource-warning-toast');
  const txt = el('resource-warning-text');
  if (!toast || !txt) return;
  txt.textContent = message;
  toast.style.background = bg || '#c53030';
  toast.style.display = 'flex';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = autoDismissMs > 0
    ? setTimeout(() => { toast.style.display = 'none'; }, autoDismissMs)
    : null;
}

// ── WebSocket ─────────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus(true);
    send('request_state');
    // Heartbeat: prove the RECEIVE direction is alive. A half-open socket can still send
    // (so overlays/commands appear to work) while broadcasts silently stop arriving — which
    // froze the panel. Any inbound message refreshes _lastRx; if none for 25s, force-reconnect.
    _lastRx = Date.now();
    clearInterval(_hbTimer);
    _hbTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - _lastRx > 25000) { try { ws.close(); } catch {} return; }
      send('ping');
    }, 10000);
  };

  ws.onmessage = ({ data }) => {
    _lastRx = Date.now();   // any inbound traffic proves we're still receiving
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'pong') return;   // heartbeat reply — nothing else to do

    if (msg.type === 'full_state') {
      applyState(msg.data);
      applyRlSpectatorUi(msg.data);
      applyScenesCockpit(msg.data);
      renderQuickToolbar(msg.data);
      renderQrailScenes(msg.data);
      renderGoLive(msg.data);
      renderUpNext(msg.data);
      renderPlayerCams(msg.data);
      renderStreamQueue(msg.data);
      renderCfCasters(msg.data);
      renderCfStations(msg.data);
      applyDirectorState(msg.data.director);
      applyClipsState(msg.data.clips);
      applyEncodeProgress(msg.data.encode);
      applyTwitchState(msg.data.twitch);
      applyReplayMonitors(msg.data.replay);
    } else if (msg.type === 'director_update') {
      if (!currentState.director) currentState.director = {};
      Object.assign(currentState.director, msg.data);
      applyDirectorState(currentState.director);
    } else if (msg.type === 'clips_update') {
      currentState.clips = msg.data;
      applyClipsState(msg.data);
    } else if (msg.type === 'replay_progress') {
      // The on-air player reports its position → drive the producer time-remaining readout.
      if ((msg.data?.bus || 'program') === 'program') { _lastProgressRx = Date.now(); showReplayCountdown(msg.data?.remaining || 0); }
    } else if (msg.type === 'replay_ended') {
      // A non-looping replay finished. For a playlist the sequencer handles the return; for a
      // single clip/montage, go back to the scene we came from now.
      if ((msg.data?.bus || 'program') === 'program' && !_plLiveActive) endReplayProgram();
      else stopReplayCountdown();
    } else if (msg.type === 'clip_prompt') {
      showClipPrompt(msg.data);
    } else if (msg.type === 'encode_progress') {
      currentState.encode = msg.data;
      applyEncodeProgress(msg.data);
    } else if (msg.type === 'clips-result') {
      const st = el('clips-status');
      if (st) { st.textContent = msg.data.message || ''; st.style.color = msg.data.ok ? '#9ae6b4' : '#f56565'; }
    } else if (msg.type === 'state_update') {
      // Sync facecam grid live as players join — skip when between matches (empty array)
      if (msg.data.players && msg.data.players.length > 0) {
        syncFacecamRows(msg.data.players, msg.data.facecams || []);
        applySpotlightState({ players: msg.data.players, spotlight: currentState.spotlight || {} });
      }
    } else if (msg.type === 'rl_status') {
      const rlIcon = el('rl-status')?.querySelector('.status-icon');
      if (rlIcon) {
        rlIcon.classList.toggle('connected', msg.data.connected);
      }
    } else if (msg.type === 'import-export-result') {
      el('import-export-result').textContent = msg.data.message;
      el('import-export-result').style.color = msg.data.result ? 'green' : 'red';
    } else if (msg.type === 'startgg-result') {
      ['startgg-result', 'sgg-status'].forEach((id) => {
        const r = el(id);
        if (r) { r.textContent = msg.data.message || ''; r.style.color = msg.data.ok ? '#9ae6b4' : '#f56565'; }
      });
    } else if (msg.type === 'obs-screenshot') {
      applyObsScreenshot(msg.data);
    } else if (msg.type === 'obs-result') {
      const color = msg.data.ok ? '#9ae6b4' : '#f56565';
      ['obs-result', 'replay-status'].forEach((id) => {
        const elx = el(id);
        if (elx) { elx.textContent = msg.data.message || ''; elx.style.color = color; }
      });
    } else if (msg.type === 'rl-ui-result') {
      const st = el('rl-ui-hide-status');
      if (st) {
        st.textContent = (msg.data.auto ? 'Auto: ' : '') + (msg.data.message || '');
        st.style.color = msg.data.ok ? '#9ae6b4' : '#f56565';
      }
    } else if (msg.type === 'bracket-result' || msg.type === 'event-result') {
      const resultEl = el('bracket-status');
      if (resultEl) {
        resultEl.textContent = msg.data.message || '';
        resultEl.style.color = msg.data.ok ? '#9ae6b4' : '#f56565';
      }
      // Surface the same message on the Events + Teams status lines if present.
      [el('ev-status'), el('teams-startgg-status')].forEach((s) => {
        if (s) { s.textContent = msg.data.message || ''; s.style.color = msg.data.ok ? 'var(--good,#48bb78)' : '#f56565'; }
      });
      // First-use automation: when an event is activated, open the Events tab on it.
      if (msg.data.ok && msg.data.activated && msg.data.tournamentSlug) {
        document.querySelector('.tab-btn[data-tab="events"]')?.click();
        if (typeof evOpenDetail === 'function') evOpenDetail(msg.data.tournamentSlug);
      }
    } else if (msg.type === 'csgo-result') {
      const resultEl = el('csgo-result');
      if (resultEl) {
        resultEl.textContent = msg.data.message || '';
        resultEl.style.color = msg.data.ok ? '#9ae6b4' : '#f56565';
      }
    } else if (msg.type === 'csgo_update') {
      const conn = el('csgo-conn');
      if (conn) {
        conn.textContent = msg.data && msg.data.connected ? 'CS2: connected' : 'CS2: waiting';
        conn.className = 'prod-chip' + (msg.data && msg.data.connected ? ' ok' : '');
      }
    } else if (msg.type === 'resource_warning') {
      showToast(`High resource usage — CPU ${msg.data.cpu}% · RAM ${msg.data.ramMb} MB`, '#c53030', 30000);
    } else if (msg.type === 'crash_alert') {
      showToast(`App error: ${msg.data.message}`, '#7b2020', 0);
    } else if (msg.type === 'update_status') {
      if (typeof renderUpdateStatus === 'function') renderUpdateStatus(msg.data);
      if (msg.data && msg.data.state === 'downloaded') showToast(`Update v${msg.data.version} ready — install it in Settings → Software Updates.`, '#7c3aed', 0);
    } else if (msg.type === 'twitch_chat_message') {
      addChatMessage(msg.data.username, msg.data.message, msg.data.color || '');
    } else if (msg.type === 'twitch_chat_connected') {
      const st = el('chat-connection-status');
      const ld = el('chat-loading');
      if (st) { st.style.display = 'inline'; st.textContent = `🟢 #${msg.data?.channel || 'connected'}`; }
      if (ld) ld.style.display = 'none';
    } else if (msg.type === 'twitch_chat_disconnected') {
      const st = el('chat-connection-status');
      const ld = el('chat-loading');
      if (st) st.style.display = 'none';
      if (ld) { ld.style.display = 'inline'; ld.textContent = 'Disconnected'; }
    } else if (msg.type === 'twitch_follow') {
      addActivityItem('follow', msg.data.user, 'Followed the channel', '🎉');
    } else if (msg.type === 'twitch_subscribe') {
      addActivityItem('subscribe', msg.data.user, `Subscribed · Tier ${msg.data.tier || 1}`, '⭐');
    } else if (msg.type === 'twitch_raid') {
      addActivityItem('raid', msg.data.from, `Raided with ${msg.data.viewers} viewers`, '🎬');
    } else if (msg.type === 'twitch_channel_points') {
      addActivityItem('channel_points', msg.data.user, `Redeemed: ${msg.data.reward}`, '💎');
    } else if (msg.type === 'twitch_hype_train_begin') {
      addActivityItem('hype_train', 'Hype Train', 'Started!', '🚂');
    } else if (msg.type === 'twitch_hype_train_progress') {
      addActivityItem('hype_train', 'Hype Train', `Level ${msg.data.level}`, '📈');
    } else if (msg.type === 'twitch_hype_train_end') {
      addActivityItem('hype_train', 'Hype Train', `Ended at level ${msg.data.level}`, '🏁');
    }
  };

  ws.onclose = () => {
    setStatus(false);
    clearInterval(_hbTimer);
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();
}

// ── INTEGRATIONS TAB ──────────────────────────────────────────────────────
el('tab-integrations')?.addEventListener('click', () => {
  switchTab('integrations');
});

// Integration sub-tab switching
document.querySelectorAll('.integration-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const integration = btn.dataset.integration;

    // Hide all panels
    document.querySelectorAll('.integration-panel').forEach(p => p.style.display = 'none');
    // Show selected (the Streaming/Twitch tab shows the connect panel + the games panel)
    const panel = el(`integration-${integration}`);
    if (panel) panel.style.display = 'block';
    if (integration === 'twitch') { const tg = el('integration-twitchgames'); if (tg) tg.style.display = 'block'; }

    // Update button state
    document.querySelectorAll('.integration-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Twitch OAuth Configuration
const TWITCH_CLIENT_ID = 't4vpvwcxaxk4vil453fmf3kuahbs5e';

// In Electron app, always use localhost (broadcast app server)
const OAUTH_BASE_URL = 'http://localhost:3000';
const TWITCH_REDIRECT_URI = `${OAUTH_BASE_URL}/api/oauth/twitch/callback`;

console.log('[OAuth] Base URL:', OAUTH_BASE_URL);

const TWITCH_SCOPES = [
  // Channel management
  'channel:manage:broadcast',       // update stream title, game, tags
  'channel:manage:polls',           // create & end polls
  'channel:manage:predictions',     // create, resolve, cancel predictions
  'channel:manage:redemptions',     // manage channel point rewards
  'channel:manage:raids',           // trigger raids to other channels
  'channel:manage:moderators',      // add/remove moderators
  'channel:manage:vips',            // add/remove VIPs
  'channel:manage:ads',             // snooze/trigger mid-roll ads
  'channel:manage:schedule',        // manage stream schedule
  // Channel reading
  'channel:read:subscriptions',     // subscriber list & events
  'channel:read:stream_key',        // stream key
  'channel:read:polls',             // poll results
  'channel:read:predictions',       // prediction results
  'channel:read:redemptions',       // channel point redemption queue
  'channel:read:hype_train',        // hype train progress & events
  'channel:read:goals',             // creator goals
  'channel:read:ads',               // ad schedule & snooze info
  'channel:read:editors',           // editors list
  // Clips
  'clips:edit',                     // create & edit clips
  // Moderation
  'moderator:read:followers',       // follower count & list (modern API)
  'moderator:manage:announcements', // post announcements to chat
  'moderator:manage:banned_users',  // ban/unban/timeout users
  'moderator:manage:chat_messages', // delete chat messages
  'moderator:manage:chat_settings', // slow/sub-only/emote-only/R9K mode
  'moderator:manage:shoutouts',     // send shoutouts via API
  'moderator:manage:shield_mode',   // activate/deactivate shield mode
  'moderator:read:chatters',        // who is currently in chat
  'moderator:read:shield_mode',     // read shield mode status
  // Chat (IRC + new Chat API)
  'chat:edit',                      // send messages via IRC
  'chat:read',                      // read messages via IRC
  'user:write:chat',                // send messages via new Chat API
  // Bits & economy
  'bits:read',                      // bits events & leaderboard
];

el('btn-twitch-login')?.addEventListener('click', () => {
  if (TWITCH_CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
    alert('Twitch Client ID not configured.\n\n1. Go to https://dev.twitch.tv/console/apps\n2. Create an application (Confidential Client)\n3. Set OAuth Redirect URL to: https://namelessesports.com/api/oauth/twitch/callback\n4. Copy your Client ID and Client Secret\n5. Set them in the app.js file');
    return;
  }

  try {
    // Use a temporary session ID immediately - don't wait for server init
    const sessionId = 'temp-' + Math.random().toString(36).substring(7);
    console.log('[OAuth] Using session ID:', sessionId);

    // Build Twitch auth URL
    const authUrl = `https://id.twitch.tv/oauth2/authorize?` +
      `client_id=${TWITCH_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&` +
      `response_type=code&` +
      `scope=${TWITCH_SCOPES.join('%20')}&` +
      `state=${sessionId}&` +
      `force_verify=true`;

    // Open Twitch login window IMMEDIATELY
    console.log('[OAuth] Opening Twitch authorization window...');
    const oauthWindow = window.open(authUrl, 'twitch_oauth', 'width=600,height=700');

    // Initialize session in the background (fire and forget)
    fetch(`${OAUTH_BASE_URL}/api/oauth/twitch/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).then(r => r.json()).then(data => {
      console.log('[OAuth] Persistent session created:', data.sessionId);
    }).catch(err => {
      console.warn('[OAuth] Persistent session init failed, continuing with temp session:', err.message);
    });

    // Step 4: Check if window opened successfully
    if (!oauthWindow) {
      console.error('[OAuth] Failed to open OAuth window - popup may be blocked');
      return;
    }

    // Poll for token every 1 second
    console.log('[OAuth] Polling for token...');
    let pollInterval = setInterval(async () => {
      // Stop polling if OAuth window is closed
      if (oauthWindow.closed) {
        console.log('[OAuth] OAuth window closed');
        clearInterval(pollInterval);
        return;
      }

      try {
        const tokenRes = await fetch(`${OAUTH_BASE_URL}/api/oauth/twitch/token/${sessionId}`);

        if (tokenRes.status === 200) {
          // Token is ready!
          const { accessToken, displayName, channelId, profilePicture } = await tokenRes.json();
          console.log('[OAuth] Token received:', displayName);
          clearInterval(pollInterval);
          oauthWindow?.close();

          // Send token to local broadcast server
          try {
            const setTokenRes = await fetch('http://localhost:3000/api/twitch/set-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                apiToken: accessToken,
                displayName,
                channelId,
                profilePicture
              })
            });

            if (!setTokenRes.ok) {
              throw new Error(`Failed to set token: ${setTokenRes.status}`);
            }

            console.log('[OAuth] Token sent to broadcast server');
            send('request_state');
          } catch (err) {
            console.error('[OAuth] Error sending token to server:', err);
          }
        } else if (tokenRes.status === 401) {
          // Session expired
          console.log('[OAuth] Session expired');
          clearInterval(pollInterval);
          oauthWindow?.close();
        }
        // 202 = pending, keep polling
      } catch (err) {
        console.error('[OAuth] Poll error:', err);
      }
    }, 1000);

    // Timeout after 10 minutes
    setTimeout(() => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
      if (oauthWindow && !oauthWindow.closed) {
        oauthWindow.close();
      }
    }, 600000);

  } catch (err) {
    console.error('[OAuth] Error:', err);
    alert('OAuth error: ' + err.message);
  }
});

el('btn-twitch-token-manual')?.addEventListener('click', () => {
  const token = prompt('Paste your Twitch OAuth token:\n\n(You can get one at twitchtokengenerator.com with Channel Points scopes)');
  if (!token) return;

  fetch('http://localhost:3000/api/twitch/set-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiToken: token })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) {
      alert('Error: ' + data.error);
    } else {
      alert('✅ Token saved! Reconnecting...');
      send('request_state');
    }
  })
  .catch(e => alert('Error: ' + e.message));
});

el('btn-twitch-test')?.addEventListener('click', () => {
  const resultEl = el('twitch-test-result');
  const btn = el('btn-twitch-test');
  if (!btn || !resultEl) return;
  btn.disabled = true;
  btn.textContent = 'Testing…';
  resultEl.style.display = 'none';
  fetch('http://localhost:3000/api/twitch/test')
    .then(r => r.json())
    .then(data => {
      resultEl.style.display = 'block';
      if (data.ok) {
        resultEl.style.background = 'rgba(74,222,128,0.1)';
        resultEl.style.color = '#4ade80';
        resultEl.style.border = '1px solid rgba(74,222,128,0.3)';
        resultEl.textContent = `✓ Token valid — ${data.displayName} · expires in ${data.expiresIn} · scopes: ${(data.scopes || []).length}`;
      } else {
        resultEl.style.background = 'rgba(239,68,68,0.1)';
        resultEl.style.color = '#f87171';
        resultEl.style.border = '1px solid rgba(239,68,68,0.3)';
        resultEl.textContent = `✗ ${data.error || 'Connection failed'}`;
      }
    })
    .catch(() => {
      resultEl.style.display = 'block';
      resultEl.style.background = 'rgba(239,68,68,0.1)';
      resultEl.style.color = '#f87171';
      resultEl.style.border = '1px solid rgba(239,68,68,0.3)';
      resultEl.textContent = '✗ Could not reach server';
    })
    .finally(() => { btn.disabled = false; btn.textContent = 'Test Connection'; });
});

el('btn-twitch-logout')?.addEventListener('click', () => {
  fetch('http://localhost:3000/api/twitch/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  .then(r => r.json())
  .then(data => {
    send('request_state');
  })
  .catch(e => console.error('Error disconnecting:', e.message));
});

function parseMmss(str) {
  str = (str || '').trim();
  if (!str) return 300;
  if (str.includes(':')) {
    const [m, s] = str.split(':').map(Number);
    return ((isNaN(m) ? 0 : m) * 60) + (isNaN(s) ? 0 : s);
  }
  const n = parseInt(str, 10);
  return isNaN(n) ? 300 : n;
}

function formatMmss(totalSecs) {
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

el('btn-create-prediction')?.addEventListener('click', () => {
  const title    = (el('pred-title')?.value    || '').trim();
  const outcome1 = (el('pred-outcome1')?.value || '').trim();
  const outcome2 = (el('pred-outcome2')?.value || '').trim();
  const duration = parseMmss(el('pred-duration')?.value);

  if (!title)    { el('pred-title')?.focus();    return; }
  if (!outcome1) { el('pred-outcome1')?.focus(); return; }
  if (!outcome2) { el('pred-outcome2')?.focus(); return; }

  const btn = el('btn-create-prediction');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Creating…';

  fetch('http://localhost:3000/api/twitch/prediction/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, outcomes: [outcome1, outcome2], duration })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) {
      btn.textContent = '✗ ' + data.error;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
    } else {
      btn.textContent = '✓ Created!';
      if (el('pred-title'))    el('pred-title').value    = '';
      if (el('pred-outcome1')) el('pred-outcome1').value = '';
      if (el('pred-outcome2')) el('pred-outcome2').value = '';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
  })
  .catch(e => {
    btn.textContent = '✗ ' + e.message;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
  });
});

// ── Prediction countdown timer ──────────────────────────────────────────────
let _predCountdownTimer = null;

function _stopPredCountdown() {
  if (_predCountdownTimer) { clearInterval(_predCountdownTimer); _predCountdownTimer = null; }
  const el2 = el('pred-countdown');
  if (el2) el2.textContent = '';
}

function _startPredCountdown(endsAt) {
  _stopPredCountdown();
  if (!endsAt) return;
  const tick = () => {
    const remaining = Math.max(0, new Date(endsAt) - Date.now());
    const countEl = el('pred-countdown');
    if (!countEl) return;
    if (remaining === 0) {
      countEl.textContent = 'Voting ended';
      _stopPredCountdown();
    } else {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      countEl.textContent = `${m}:${s.toString().padStart(2, '0')} remaining`;
    }
  };
  tick();
  _predCountdownTimer = setInterval(tick, 1000);
}

// ── Declare Winner (two-click confirm, no alert/confirm dialogs) ────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('.pred-declare-winner-btn');
  if (!btn) return;

  if (btn.dataset.confirming) {
    btn.textContent = 'Resolving…';
    btn.disabled = true;
    fetch('http://localhost:3000/api/twitch/prediction/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcomeId: btn.dataset.outcomeId })
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        btn.textContent = '✗ ' + data.error;
        btn.disabled = false;
        delete btn.dataset.confirming;
        setTimeout(() => { btn.textContent = 'Declare Winner'; }, 3000);
      }
      // On success the WS full_state update clears the display automatically
    })
    .catch(() => {
      btn.textContent = '✗ Error';
      btn.disabled = false;
      delete btn.dataset.confirming;
      setTimeout(() => { btn.textContent = 'Declare Winner'; }, 2000);
    });
  } else {
    // First click — show inline confirmation
    const title = btn.dataset.outcomeTitle || 'this outcome';
    btn.dataset.confirming = '1';
    const orig = btn.textContent;
    btn.textContent = `"${title}" wins — confirm?`;
    btn.style.background = '#22c55e';
    btn.style.color = '#000';
    setTimeout(() => {
      if (btn.dataset.confirming) {
        delete btn.dataset.confirming;
        btn.textContent = orig;
        btn.style.background = '';
        btn.style.color = '';
      }
    }, 4000);
  }
});

// ── Cancel prediction (two-click confirm) ───────────────────────────────────
el('btn-cancel-prediction')?.addEventListener('click', function() {
  const btn = this;
  if (btn.dataset.confirming) {
    btn.textContent = 'Cancelling…';
    btn.disabled = true;
    fetch('http://localhost:3000/api/twitch/prediction/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        btn.textContent = '✗ ' + data.error;
        btn.disabled = false;
        delete btn.dataset.confirming;
        setTimeout(() => { btn.textContent = 'Cancel Prediction'; btn.style.cssText = ''; }, 3000);
      }
      // On success the WS update will hide the panel
    })
    .catch(() => {
      btn.textContent = '✗ Error';
      btn.disabled = false;
      delete btn.dataset.confirming;
      setTimeout(() => { btn.textContent = 'Cancel Prediction'; btn.style.cssText = ''; }, 2000);
    });
  } else {
    btn.dataset.confirming = '1';
    btn.textContent = 'Confirm cancel?';
    btn.style.background = 'rgba(239,68,68,0.2)';
    btn.style.color = '#ef4444';
    btn.style.border = '1px solid rgba(239,68,68,0.4)';
    setTimeout(() => {
      if (btn.dataset.confirming) {
        delete btn.dataset.confirming;
        btn.textContent = 'Cancel Prediction';
        btn.style.cssText = '';
      }
    }, 4000);
  }
});

el('btn-spin-wheel')?.addEventListener('click', () => {
  if (!currentState.twitch?.wheel?.participants || currentState.twitch.wheel.participants.length === 0) {
    alert('No participants yet. Wait for followers/subscribers or use chat integration.');
    return;
  }

  if (confirm(`Spin wheel with ${currentState.twitch.wheel.participants.length} participants?`)) {
    fetch('http://localhost:3000/api/twitch/wheel/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        alert('Error: ' + data.error);
      } else {
        alert('Spinning...');
      }
    })
    .catch(e => alert('Error: ' + e.message));
  }
});

el('btn-clear-wheel')?.addEventListener('click', () => {
  if (confirm('Clear all participants from wheel?')) {
    fetch('http://localhost:3000/api/twitch/wheel/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        alert('Error: ' + data.error);
      } else {
        alert('Participants cleared!');
      }
    })
    .catch(e => alert('Error: ' + e.message));
  }
});

// Mini-game auto-start settings
el('minigame-auto-start')?.addEventListener('change', function() {
  fetch('http://localhost:3000/api/twitch/minigame/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: this.checked })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) console.error('Settings error:', data.error);
  })
  .catch(e => console.error('Error:', e.message));
});

el('minigame-auto-type')?.addEventListener('change', function() {
  fetch('http://localhost:3000/api/twitch/minigame/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ breakScreenGameType: this.value })
  })
  .then(r => r.json())
  .catch(e => console.error('Error:', e.message));
});

// ── Auto-prediction settings ────────────────────────────────────────────────
el('btn-save-pred-settings')?.addEventListener('click', () => {
  const autoCreate = el('pred-auto-create')?.checked ?? false;
  const template   = el('pred-auto-template')?.value || 'teams';
  const cooldown   = parseMmss(el('pred-auto-cooldown')?.value) * 1000; // MM:SS → ms
  const btn = el('btn-save-pred-settings');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  fetch('http://localhost:3000/api/twitch/prediction/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoCreate, template, cooldown })
  })
  .then(r => r.json())
  .then(d => {
    btn.textContent = d.error ? '✗ Error' : '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  })
  .catch(() => { btn.textContent = '✗ Failed'; btn.disabled = false; });
});

// ── Prediction overlay display settings ─────────────────────────────────────
function updatePredDisplayLabels() {
  const isLoop = el('pred-display-loop')?.checked;
  const loopLabel  = el('pred-display-loop-label');
  const constLabel = el('pred-display-const-label');
  const durRow     = el('pred-loop-duration-row');
  if (loopLabel)  loopLabel.style.borderColor  = isLoop  ? '#9146ff' : 'rgba(255,255,255,0.12)';
  if (constLabel) constLabel.style.borderColor = !isLoop ? '#9146ff' : 'rgba(255,255,255,0.12)';
  if (durRow)     durRow.style.display          = isLoop  ? 'flex'   : 'none';
}

document.querySelectorAll('input[name="pred-display-mode"]').forEach(r =>
  r.addEventListener('change', updatePredDisplayLabels)
);

el('btn-save-pred-display')?.addEventListener('click', () => {
  const isLoop   = el('pred-display-loop')?.checked;
  const loopSecs = isLoop ? Math.max(5, parseInt(el('pred-loop-secs')?.value || '30', 10)) : 0;
  const btn = el('btn-save-pred-display');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  fetch('http://localhost:3000/api/twitch/prediction/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overlayLoop: loopSecs })
  })
  .then(r => r.json())
  .then(d => {
    btn.textContent = d.error ? '✗ Error' : '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  })
  .catch(() => { btn.textContent = '✗ Failed'; btn.disabled = false; });
});

// ── Wheel prize list UI ─────────────────────────────────────────────────────
let wheelPrizes = [];

function renderWheelPrizes() {
  const list = el('wheel-prizes-list');
  if (!list) return;
  if (wheelPrizes.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:4px 0;">No prizes added yet.</div>';
    return;
  }
  list.innerHTML = wheelPrizes.map((p, i) => `
    <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:rgba(0,0,0,0.2);border-radius:4px;">
      <span style="width:14px;height:14px;border-radius:50%;background:${p.color};flex-shrink:0;display:inline-block;"></span>
      <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</span>
      <span style="font-size:10px;color:var(--muted);flex-shrink:0;">&#xD7;${p.weight || 1}</span>
      <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px;flex-shrink:0;color:#ef4444;" data-remove-prize="${i}" title="Remove">&#x2715;</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-remove-prize]').forEach(rmBtn => {
    rmBtn.addEventListener('click', () => {
      wheelPrizes.splice(parseInt(rmBtn.dataset.removePrize, 10), 1);
      renderWheelPrizes();
    });
  });
}

el('btn-wheel-add-prize')?.addEventListener('click', () => {
  const name   = el('wheel-new-prize-name')?.value.trim();
  const color  = el('wheel-new-prize-color')?.value || '#6441a5';
  const weight = parseInt(el('wheel-new-prize-weight')?.value || '1', 10);
  if (!name) return;
  wheelPrizes.push({ name, color, weight: isNaN(weight) || weight < 1 ? 1 : weight });
  renderWheelPrizes();
  if (el('wheel-new-prize-name')) el('wheel-new-prize-name').value = '';
});

el('btn-save-wheel-settings')?.addEventListener('click', () => {
  const entryMethod = el('wheel-entry-method')?.value || 'chat';
  const duration    = parseInt(el('wheel-spin-duration')?.value || '8', 10) * 1000; // UI seconds → ms
  const btn = el('btn-save-wheel-settings');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  fetch('http://localhost:3000/api/twitch/wheel/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prizes: wheelPrizes, entryMethod, duration })
  })
  .then(r => r.json())
  .then(d => {
    btn.textContent = d.error ? '✗ Error' : '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  })
  .catch(() => { btn.textContent = '✗ Failed'; btn.disabled = false; });
});

// ── Minigame settings save ──────────────────────────────────────────────────
el('btn-save-minigame-settings')?.addEventListener('click', () => {
  const enabled             = el('minigame-auto-start')?.checked ?? true;
  const breakScreenGameType = el('minigame-auto-type')?.value || 'trivia';
  const defaultDuration     = parseInt(el('minigame-duration')?.value || '60', 10) * 1000; // UI seconds → ms
  const prRaw               = el('minigame-point-reward')?.value.trim();
  const pointReward         = prRaw ? (isNaN(Number(prRaw)) ? prRaw : Number(prRaw)) : null;
  const btn = el('btn-save-minigame-settings');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  fetch('http://localhost:3000/api/twitch/minigame/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, breakScreenGameType, defaultDuration, pointReward })
  })
  .then(r => r.json())
  .then(d => {
    btn.textContent = d.error ? '✗ Error' : '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  })
  .catch(() => { btn.textContent = '✗ Failed'; btn.disabled = false; });
});

// ── Populate Twitch Games settings from state ───────────────────────────────
function populateTwitchGameSettings(twitch) {
  const ps = twitch?.predictions?.settings || {};
  if (el('pred-auto-create'))    el('pred-auto-create').checked  = !!ps.autoCreate;
  if (el('pred-auto-template'))  el('pred-auto-template').value  = ps.template  || 'teams';
  if (el('pred-auto-cooldown'))  el('pred-auto-cooldown').value  = formatMmss(Math.round((ps.cooldown ?? 300000) / 1000));
  const loopSecs = ps.overlayLoop ?? 30;
  const isLoop = loopSecs > 0;
  if (el('pred-display-loop'))  el('pred-display-loop').checked  = isLoop;
  if (el('pred-display-const')) el('pred-display-const').checked = !isLoop;
  if (el('pred-loop-secs'))     el('pred-loop-secs').value       = isLoop ? loopSecs : 30;
  const durRow = el('pred-loop-duration-row');
  if (durRow) durRow.style.display = isLoop ? 'flex' : 'none';
  updatePredDisplayLabels();

  const ws = twitch?.wheel || {};
  if (el('wheel-entry-method'))  el('wheel-entry-method').value  = ws.settings?.entryMethod || ws.entryMethod || 'chat';
  // duration stored as ms; UI shows seconds
  if (el('wheel-spin-duration')) el('wheel-spin-duration').value = Math.round((ws.settings?.duration ?? 8000) / 1000);
  if (Array.isArray(ws.prizes)) { wheelPrizes = ws.prizes.map(p => ({ ...p })); renderWheelPrizes(); }

  const mset = twitch?.minigame?.settings || {};
  if (el('minigame-auto-start'))   el('minigame-auto-start').checked = mset.enabled !== false;
  if (el('minigame-auto-type'))    el('minigame-auto-type').value    = mset.breakScreenGameType || 'trivia';
  // defaultDuration stored as ms; UI shows seconds
  if (el('minigame-duration'))     el('minigame-duration').value     = Math.round((mset.defaultDuration ?? 60000) / 1000);
  // pointReward is a point cost number; show it in the field
  if (el('minigame-point-reward')) el('minigame-point-reward').value = mset.pointReward ? String(mset.pointReward) : '';
}

// Mini-game type selection
let selectedGameType = null;
document.querySelectorAll('.game-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedGameType = btn.dataset.type;

    // Update button state
    document.querySelectorAll('.game-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Show/hide setup panels
    document.getElementById('trivia-setup').style.display = selectedGameType === 'trivia' ? 'block' : 'none';
    document.getElementById('vote-setup').style.display = (selectedGameType === 'prediction' || selectedGameType === 'vote') ? 'block' : 'none';
    document.getElementById('spin-setup').style.display = selectedGameType === 'spin' ? 'block' : 'none';
  });
});

el('btn-start-minigame')?.addEventListener('click', () => {
  if (!selectedGameType) {
    alert('Select a game type first');
    return;
  }

  let gameData = { type: selectedGameType };

  if (selectedGameType === 'trivia') {
    const q = el('trivia-question')?.value;
    const answers = [
      el('trivia-a')?.value,
      el('trivia-b')?.value,
      el('trivia-c')?.value,
      el('trivia-d')?.value
    ].filter(Boolean);

    if (!q || answers.length < 2) {
      alert('Enter question and at least 2 answers');
      return;
    }
    gameData.question = q;
    gameData.answers = answers;
  } else if (selectedGameType === 'prediction' || selectedGameType === 'vote') {
    const q = el('vote-question')?.value;
    const options = [
      el('vote-opt1')?.value,
      el('vote-opt2')?.value,
      el('vote-opt3')?.value,
      el('vote-opt4')?.value
    ].filter(Boolean);

    if (!q || options.length < 2) {
      alert('Enter question and at least 2 options');
      return;
    }
    gameData.question = q;
    gameData.options = options;
  } else if (selectedGameType === 'spin') {
    const prizes = el('spin-prizes')?.value.split('\n').map(p => p.trim()).filter(Boolean) || [];
    if (prizes.length < 2) {
      alert('Enter at least 2 prizes');
      return;
    }
    gameData.prizes = prizes.map(p => ({ name: p, color: '#' + Math.floor(Math.random()*16777215).toString(16) }));
  }

  fetch('http://localhost:3000/api/twitch/minigame/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gameData)
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) {
      alert('Error: ' + data.error);
    } else {
      alert('Game started!');
    }
  })
  .catch(e => alert('Error: ' + e.message));
});

connect();

// ── Stats Tab ─────────────────────────────────────────────────────────────────

let _statsOffset = 0;
const _statsPageSize = 20;

function fmtDuration(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function loadStatsAggregate() {
  try {
    const r = await fetch('http://localhost:3000/api/stats/aggregate');
    const d = await r.json();
    if (!d.ok) return;
    const el2 = el('stats-aggregate');
    if (!el2) return;
    const chip = (label, val) =>
      `<div style="background:rgba(255,255,255,.06);border-radius:8px;padding:10px 16px;min-width:100px;">
        <div style="font-size:11px;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;">${label}</div>
        <div style="font-size:22px;font-weight:700;color:#e0e0e0;margin-top:2px;">${val}</div>
      </div>`;
    el2.innerHTML =
      chip('Matches', d.matchCount) +
      chip('Games', d.gameCount) +
      chip('Avg Game', fmtDuration(d.avgDurationSec)) +
      (d.topScorer ? chip('Top Scorer', `${d.topScorer.player_name} (${d.topScorer.total_goals}g)`) : '');
  } catch (_) {}
}

async function loadStatsMatches(reset) {
  if (reset) _statsOffset = 0;
  try {
    const r = await fetch(`http://localhost:3000/api/stats/matches?limit=${_statsPageSize + 1}`);
    const d = await r.json();
    if (!d.ok) return;
    const matches = d.matches.slice(0, _statsPageSize);
    const hasMore = d.matches.length > _statsPageSize;
    const listEl = el('stats-matches-list');
    if (!listEl) return;

    if (reset) listEl.innerHTML = '';
    if (!matches.length && reset) {
      listEl.innerHTML = '<p style="color:var(--muted,#888);font-size:13px;padding:12px 0;">No matches recorded yet. Data is captured automatically from live RL and CS2 games.</p>';
    }

    matches.forEach(m => {
      const div = document.createElement('div');
      div.style = 'background:rgba(255,255,255,.05);border-radius:8px;padding:12px 16px;margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;';
      div.innerHTML = `
        <div>
          <div style="font-weight:600;color:#e0e0e0;font-size:13px;">${m.team_a || '—'} vs ${m.team_b || '—'}</div>
          <div style="font-size:11px;color:var(--muted,#888);margin-top:2px;">${m.game_type?.toUpperCase()} · Bo${m.best_of} · ${fmtDate(m.started_at)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:18px;font-weight:700;color:#e0e0e0;">${m.score_a ?? '?'} – ${m.score_b ?? '?'}</div>
          <div style="font-size:11px;color:var(--muted,#888);">${m.game_count} game${m.game_count !== 1 ? 's' : ''}</div>
        </div>`;
      div.addEventListener('click', () => openStatsDetail(m.id));
      listEl.appendChild(div);
    });

    const moreBtn = el('stats-load-more');
    if (moreBtn) moreBtn.style.display = hasMore ? '' : 'none';
    _statsOffset += matches.length;
  } catch (_) {}
}

async function openStatsDetail(matchId) {
  const modal = el('stats-detail-modal');
  const body = el('stats-detail-body');
  const title = el('stats-detail-title');
  if (!modal || !body) return;
  body.innerHTML = '<p style="color:#888;padding:20px 0;">Loading…</p>';
  modal.style.display = 'block';
  try {
    const r = await fetch(`http://localhost:3000/api/stats/matches/${matchId}`);
    const d = await r.json();
    if (!d.ok || !d.match) { body.innerHTML = '<p style="color:#f56565;">Error loading match.</p>'; return; }
    const m = d.match;
    title.textContent = `${m.team_a || '—'} vs ${m.team_b || '—'} · ${fmtDate(m.started_at)}`;
    let html = `<div style="display:flex;gap:20px;margin-bottom:16px;flex-wrap:wrap;">
      <span style="color:#888;font-size:12px;">${m.game_type?.toUpperCase()} · Bo${m.best_of}</span>
      <span style="color:#888;font-size:12px;">Series: ${m.score_a} – ${m.score_b}</span>
      ${m.tournament ? `<span style="color:#888;font-size:12px;">${m.tournament}</span>` : ''}
    </div>`;
    (m.games || []).forEach(g => {
      const mapLabel = g.map ? ` · ${g.map}` : '';
      const otLabel  = g.overtime ? ' (OT)' : '';
      html += `<div style="background:rgba(255,255,255,.04);border-radius:8px;padding:14px;margin-bottom:12px;">
        <div style="font-weight:600;font-size:13px;color:#e0e0e0;margin-bottom:10px;">Game ${g.game_number}${mapLabel} — ${g.score_a ?? '?'}–${g.score_b ?? '?'}${otLabel} · ${fmtDuration(g.duration_sec)}</div>`;
      if (g.game_type === 'rl' && g.players?.length) {
        html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="color:#888;text-align:left;">
            <th style="padding:4px 6px;">Player</th><th style="padding:4px 6px;">Team</th>
            <th style="padding:4px 6px;text-align:center;">G</th><th style="padding:4px 6px;text-align:center;">A</th>
            <th style="padding:4px 6px;text-align:center;">Sv</th><th style="padding:4px 6px;text-align:center;">Sh</th>
            <th style="padding:4px 6px;text-align:center;">Demo</th><th style="padding:4px 6px;text-align:center;">Score</th>
          </tr></thead><tbody>`;
        g.players.forEach(p => {
          const teamLabel = p.team === 'a' ? (m.team_a || 'Blue') : (m.team_b || 'Orange');
          html += `<tr style="border-top:1px solid rgba(255,255,255,.06);">
            <td style="padding:5px 6px;color:#e0e0e0;">${p.player_name}</td>
            <td style="padding:5px 6px;color:#888;">${teamLabel}</td>
            <td style="padding:5px 6px;text-align:center;">${p.goals}</td>
            <td style="padding:5px 6px;text-align:center;">${p.assists}</td>
            <td style="padding:5px 6px;text-align:center;">${p.saves}</td>
            <td style="padding:5px 6px;text-align:center;">${p.shots}</td>
            <td style="padding:5px 6px;text-align:center;">${p.demos}</td>
            <td style="padding:5px 6px;text-align:center;font-weight:600;">${p.score}</td>
          </tr>`;
        });
        html += '</tbody></table>';
      } else if (g.game_type === 'cs2' && g.players?.length) {
        html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="color:#888;text-align:left;">
            <th style="padding:4px 6px;">Player</th><th style="padding:4px 6px;">Team</th>
            <th style="padding:4px 6px;text-align:center;">K</th><th style="padding:4px 6px;text-align:center;">D</th>
            <th style="padding:4px 6px;text-align:center;">A</th><th style="padding:4px 6px;text-align:center;">MVPs</th>
            <th style="padding:4px 6px;text-align:center;">Score</th>
          </tr></thead><tbody>`;
        g.players.forEach(p => {
          const teamLabel = p.team === 'a' ? (m.team_a || 'CT') : (m.team_b || 'T');
          html += `<tr style="border-top:1px solid rgba(255,255,255,.06);">
            <td style="padding:5px 6px;color:#e0e0e0;">${p.player_name}</td>
            <td style="padding:5px 6px;color:#888;">${teamLabel}</td>
            <td style="padding:5px 6px;text-align:center;color:#9ae6b4;">${p.kills}</td>
            <td style="padding:5px 6px;text-align:center;color:#f56565;">${p.deaths}</td>
            <td style="padding:5px 6px;text-align:center;">${p.assists}</td>
            <td style="padding:5px 6px;text-align:center;">${p.mvps}</td>
            <td style="padding:5px 6px;text-align:center;font-weight:600;">${p.score}</td>
          </tr>`;
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    });
    body.innerHTML = html;
  } catch (e) { body.innerHTML = `<p style="color:#f56565;">Error: ${e.message}</p>`; }
}

function closeStatsDetail() {
  const m = el('stats-detail-modal');
  if (m) m.style.display = 'none';
}

// Player search
el('stats-player-search-btn')?.addEventListener('click', async () => {
  const name = el('stats-player-search')?.value?.trim();
  const resultsEl = el('stats-player-results');
  if (!name || !resultsEl) return;
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<p style="color:#888;font-size:13px;">Searching…</p>';
  try {
    const r = await fetch(`http://localhost:3000/api/stats/players?name=${encodeURIComponent(name)}`);
    const d = await r.json();
    if (!d.ok || !d.history?.length) { resultsEl.innerHTML = '<p style="color:#888;font-size:13px;">No results.</p>'; return; }
    let html = `<p style="font-size:12px;color:#888;margin-bottom:8px;">${d.history.length} game(s) found for <strong style="color:#e0e0e0;">${name}</strong></p>`;
    html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="color:#888;"><th style="padding:4px 8px;text-align:left;">Date</th><th>vs</th><th>G</th><th>A</th><th>Sv</th><th>Score</th></tr></thead><tbody>`;
    d.history.forEach(row => {
      html += `<tr style="border-top:1px solid rgba(255,255,255,.06);">
        <td style="padding:5px 8px;color:#888;">${fmtDate(row.game_at)}</td>
        <td style="padding:5px 8px;color:#e0e0e0;">${row.team_a} vs ${row.team_b}</td>
        <td style="padding:5px 8px;text-align:center;">${row.goals}</td>
        <td style="padding:5px 8px;text-align:center;">${row.assists}</td>
        <td style="padding:5px 8px;text-align:center;">${row.saves}</td>
        <td style="padding:5px 8px;text-align:center;font-weight:600;">${row.score}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    resultsEl.innerHTML = html;
  } catch (e) { resultsEl.innerHTML = `<p style="color:#f56565;">Error: ${e.message}</p>`; }
});

el('stats-load-more')?.addEventListener('click', () => loadStatsMatches(false));

// ── Stats deep analytics (leaderboards / team records / head-to-head) ───────
const STATS_API = 'http://localhost:3000/api/stats';
let _statsTab = 'overview';
function statsShowTab(tab) {
  _statsTab = tab;
  document.querySelectorAll('#stats-subnav .ev-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.stab === tab));
  ['overview', 'players', 'teams', 'h2h'].forEach((t) => { const p = el('stats-panel-' + t); if (p) p.style.display = t === tab ? '' : 'none'; });
  if (tab === 'players') loadStatsLeaders();
  else if (tab === 'teams') loadStatsTeams();
}
function statTable(cols, rows, rowFn) {
  return `<table class="stats-table"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map(rowFn).join('') || `<tr><td colspan="${cols.length}" class="stats-empty">No data yet — broadcast some games first.</td></tr>`}</tbody></table>`;
}
async function loadStatsLeaders() {
  const wrap = el('stats-leaders'); if (!wrap) return;
  wrap.innerHTML = '<p class="section-desc">Loading…</p>';
  try {
    const d = await (await fetch(`${STATS_API}/leaders`)).json();
    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    const rl = statTable(['#', 'Player', 'G', 'A', 'Sv', 'Sh', 'Score', 'GP'], d.rl || [],
      (p, i) => `<tr><td>${i + 1}</td><td class="st-name">${esc(p.player)}</td><td class="st-hi">${p.goals}</td><td>${p.assists}</td><td>${p.saves}</td><td>${p.shots}</td><td>${p.score}</td><td>${p.games}</td></tr>`);
    const cs2 = statTable(['#', 'Player', 'K', 'D', 'A', 'HS', 'MVP', 'Score', 'GP'], d.cs2 || [],
      (p, i) => `<tr><td>${i + 1}</td><td class="st-name">${esc(p.player)}</td><td class="st-hi">${p.kills}</td><td>${p.deaths}</td><td>${p.assists}</td><td>${p.hs}</td><td>${p.mvps}</td><td>${p.score}</td><td>${p.games}</td></tr>`);
    wrap.innerHTML = `<h4 class="stats-sub">Rocket League — by goals</h4>${rl}<h4 class="stats-sub" style="margin-top:18px;">CS2 — by kills</h4>${cs2}`;
  } catch (e) { wrap.innerHTML = `<p style="color:#f56565;">Error: ${e.message}</p>`; }
}
async function loadStatsTeams() {
  const wrap = el('stats-teams'); if (!wrap) return;
  wrap.innerHTML = '<p class="section-desc">Loading…</p>';
  try {
    const d = await (await fetch(`${STATS_API}/teams`)).json();
    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    wrap.innerHTML = statTable(['#', 'Team', 'W', 'L', 'Matches', 'Win %'], d.teams || [],
      (t, i) => `<tr><td>${i + 1}</td><td class="st-name">${esc(t.team)}</td><td class="st-hi">${t.wins}</td><td>${t.losses}</td><td>${t.matches}</td><td>${t.winPct}%</td></tr>`);
  } catch (e) { wrap.innerHTML = `<p style="color:#f56565;">Error: ${e.message}</p>`; }
}
async function loadStatsH2H() {
  const a = (el('stats-h2h-a')?.value || '').trim(), b = (el('stats-h2h-b')?.value || '').trim();
  const wrap = el('stats-h2h-result'); if (!wrap) return;
  if (!a || !b) { wrap.innerHTML = '<p class="section-desc">Enter two team names.</p>'; return; }
  wrap.innerHTML = '<p class="section-desc">Loading…</p>';
  try {
    const d = await (await fetch(`${STATS_API}/h2h?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)).json();
    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    const total = d.aWins + d.bWins;
    const head = `<div class="h2h-score"><span class="h2h-team">${esc(d.a)}</span><span class="h2h-num">${d.aWins}</span><span class="h2h-dash">—</span><span class="h2h-num">${d.bWins}</span><span class="h2h-team">${esc(d.b)}</span></div>
      <div class="section-desc" style="text-align:center;margin-bottom:12px;">${total} completed match${total === 1 ? '' : 'es'}</div>`;
    const rows = (d.matches || []).map((m) => `<tr><td>${m.team_a ? esc(m.team_a) : ''} ${m.score_a ?? ''}–${m.score_b ?? ''} ${m.team_b ? esc(m.team_b) : ''}</td><td>${m.tournament ? esc(m.tournament) : '—'}</td><td>${m.started_at ? new Date(m.started_at).toLocaleDateString() : ''}</td></tr>`).join('');
    wrap.innerHTML = head + statTable(['Match', 'Event', 'Date'], d.matches || [], () => '').replace(/<tbody>.*<\/tbody>/s, `<tbody>${rows || '<tr><td colspan="3" class="stats-empty">No matches between these teams.</td></tr>'}</tbody>`);
  } catch (e) { wrap.innerHTML = `<p style="color:#f56565;">Error: ${e.message}</p>`; }
}
document.querySelectorAll('#stats-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', () => statsShowTab(b.dataset.stab)));
el('stats-h2h-go')?.addEventListener('click', loadStatsH2H);

// Load stats when the tab is opened
el('tab-stats')?.addEventListener('click', () => {
  loadStatsAggregate();
  loadStatsMatches(true);
  if (_statsTab === 'players') loadStatsLeaders();
  else if (_statsTab === 'teams') loadStatsTeams();
});

// ─── EventSub Real-Time Events ──────────────────────────────────────────────
el('btn-eventsub-subscribe')?.addEventListener('click', async () => {
  if (!state.twitch?.channelId) {
    alert('Please connect to Twitch first');
    return;
  }

  try {
    const res = await fetch('http://localhost:3000/api/twitch/eventsub/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: state.twitch.channelId
      })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Subscription failed');
    }

    const data = await res.json();
    alert(`✅ EventSub subscribed! ${data.subscriptions.filter(s => s.success).length} events enabled.`);
    updateEventSubStatus();
  } catch (err) {
    console.error('[EventSub]', err);
    alert('Error subscribing to events: ' + err.message);
  }
});

el('btn-eventsub-status')?.addEventListener('click', updateEventSubStatus);

async function updateEventSubStatus() {
  try {
    const res = await fetch('http://localhost:3000/api/twitch/eventsub/status');
    if (!res.ok) throw new Error('Failed to fetch status');

    const status = await res.json();
    const costEl = el('eventsub-cost');
    const statusPanel = el('eventsub-status-panel');
    const listEl = el('eventsub-subscriptions-list');

    if (costEl) costEl.textContent = status.totalCost;

    if (statusPanel && listEl) {
      statusPanel.style.display = 'block';
      let html = '';
      for (const [eventType, sub] of Object.entries(status.subscriptions)) {
        html += `<div style="margin-bottom:6px; padding:6px; background:rgba(0,0,0,0.2); border-radius:3px;">
          <div style="font-size:11px; color:#aaa;">${eventType}</div>
          <div style="font-size:10px; color:#666;">ID: ${sub.id?.substring(0, 12)}...</div>
          <div style="font-size:10px; color:#666;">Status: ${sub.status}</div>
        </div>`;
      }
      listEl.innerHTML = html || '<div style="color:#666;">No active subscriptions</div>';
    }
  } catch (err) {
    console.error('[EventSub Status]', err);
    alert('Error fetching status: ' + err.message);
  }
}

// Update EventSub status on Twitch connect
window.addEventListener('message', (e) => {
  if (e.data.type === 'twitch_connected') {
    setTimeout(updateEventSubStatus, 1000);
  }
});

// ─── Right Rail Chat & Activity ─────────────────────────────────────────────

// Chat messages storage
const chatMessages = [];
const maxChatMessages = 100;

// Function to add message to chat
function addChatMessage(username, message, color = '') {
  const chatEl = el('twitch-chat');
  if (!chatEl) return;

  // Remove the placeholder if still present
  const placeholder = chatEl.querySelector('[data-placeholder]');
  if (placeholder) placeholder.remove();

  chatMessages.push({ username, message, timestamp: new Date() });
  if (chatMessages.length > maxChatMessages) {
    chatMessages.shift();
    if (chatEl.firstChild) chatEl.removeChild(chatEl.firstChild);
  }

  const nameColor = color || '#9146ff';
  const msgEl = document.createElement('div');
  msgEl.style.cssText = 'padding:5px 6px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:12px; word-wrap:break-word; line-height:1.4;';
  msgEl.innerHTML = `<span style="color:${nameColor}; font-weight:700;">${escapeHtml(username)}</span><span style="color:rgba(255,255,255,0.4);">: </span><span style="color:#ddd;">${escapeHtml(message)}</span>`;

  chatEl.appendChild(msgEl);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Activity feed items
const activityItems = [];
const maxActivityItems = 50;

// Function to add activity item
function addActivityItem(type, user, detail, icon) {
  const activityEl = el('twitch-activity');
  if (!activityEl) return;

  activityItems.push({ type, user, detail, timestamp: new Date() });
  if (activityItems.length > maxActivityItems) {
    activityEl.removeChild(activityEl.firstChild);
    activityItems.shift();
  }

  const colors = {
    'follow': '#86efac',
    'subscribe': '#4ade80',
    'raid': '#60a5fa',
    'channel_points': '#fbbf24',
    'hype_train': '#f472b6'
  };

  const itemEl = document.createElement('div');
  itemEl.style.cssText = `padding:8px; background:rgba(255,255,255,0.03); border-left:3px solid ${colors[type] || '#888'}; border-radius:2px; font-size:11px;`;
  itemEl.innerHTML = `
    <div style="color:${colors[type] || '#ccc'}; font-weight:600;">${icon} ${user}</div>
    <div style="color:#aaa; font-size:10px; margin-top:2px;">${detail}</div>
  `;

  activityEl.insertBefore(itemEl, activityEl.firstChild);
}


// Right-rail tab switching
document.querySelectorAll('.qrail-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const qtab = btn.dataset.qtab;

    // Update button state
    document.querySelectorAll('.qrail-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Show/hide panels
    document.querySelectorAll('.qrail-panel').forEach(p => p.classList.remove('active'));
    const panel = document.querySelector(`.qrail-panel[data-qpanel="${qtab}"]`);
    if (panel) panel.classList.add('active');

    // Update title
    const titleEl = el('qrail-paneltitle');
    if (titleEl) {
      const titles = {
        'quick': 'Quick Actions',
        'graphics': 'Overlays',
        'golive': 'Trigger Graphics',
        'notes': 'Producer Notes',
        'checklist': 'Run-of-Show',
        'workflow': 'Production Workflow',
        'chat': 'Twitch Chat',
        'activity': 'Twitch Activity'
      };
      titleEl.textContent = titles[qtab] || 'Panel';
    }

    // Scroll chat to bottom when switching to chat tab
    if (qtab === 'chat') {
      setTimeout(() => {
        const chatEl = el('twitch-chat');
        if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
      }, 100);
    }
  });
});

// ─── Stream State Polling (Viewer Count & Ad Timer) ──────────────────────────

let streamPollInterval = null;
const streamPollIntervalMs = 30 * 1000; // Poll every 30 seconds

function startStreamStatePolling() {
  if (streamPollInterval) return;

  const pollStreamState = async () => {
    if (!state.twitch?.connected) return;

    try {
      // Fetch stream state
      const res = await fetch('http://localhost:3000/api/twitch/stream/viewers');
      if (!res.ok) return;

      const data = await res.json();
      const viewersEl = el('tb-viewers');
      const viewersNEl = el('tb-viewers-n');

      if (viewersEl && viewersNEl) {
        viewersNEl.textContent = data.viewers.toLocaleString();
        viewersEl.style.opacity = data.isLive ? '1' : '0.6';
      }

      // Fetch ad countdown
      const adRes = await fetch('http://localhost:3000/api/twitch/ads/countdown');
      if (!adRes.ok) return;

      const adData = await adRes.json();
      const adTimerEl = el('tb-adtimer');
      const adTimerNEl = el('tb-adtimer-n');

      if (adTimerEl && adTimerNEl && adData.secondsUntilAd !== null) {
        const mins = Math.floor(adData.secondsUntilAd / 60);
        const secs = adData.secondsUntilAd % 60;
        adTimerNEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        adTimerEl.style.opacity = adData.secondsUntilAd > 0 ? '1' : '0.6';
      }
    } catch (err) {
      console.error('[Stream State]', err);
    }
  };

  // Poll immediately and then on interval
  pollStreamState();
  streamPollInterval = setInterval(pollStreamState, streamPollIntervalMs);
}

function stopStreamStatePolling() {
  if (streamPollInterval) {
    clearInterval(streamPollInterval);
    streamPollInterval = null;
  }
  const viewersEl = el('tb-viewers');
  const adTimerEl = el('tb-adtimer');
  if (viewersEl) viewersEl.style.opacity = '0.6';
  if (adTimerEl) adTimerEl.style.opacity = '0.6';
}

// WebSocket listener for real-time stream state updates
socket.addEventListener('message', (evt) => {
  const msg = JSON.parse(evt.data);

  if (msg.type === 'twitch_stream_state') {
    const viewersEl = el('tb-viewers');
    const viewersNEl = el('tb-viewers-n');

    if (viewersEl && viewersNEl) {
      viewersNEl.textContent = msg.data.stream.viewerCount.toLocaleString();
      viewersEl.style.opacity = msg.data.stream.isLive ? '1' : '0.6';
    }

    const adTimerEl = el('tb-adtimer');
    const adTimerNEl = el('tb-adtimer-n');

    if (adTimerEl && adTimerNEl) {
      const countdown = Math.ceil((new Date(msg.data.ads.nextAdAt).getTime() - new Date().getTime()) / 1000);
      if (countdown > 0) {
        const mins = Math.floor(countdown / 60);
        const secs = countdown % 60;
        adTimerNEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        adTimerEl.style.opacity = '1';
      } else {
        adTimerEl.style.opacity = '0.6';
      }
    }
  }
});

// ─── Twitch Chat Automations ─────────────────────────────────────────────────

async function fetchAndRenderStreamState() {
  try {
    const res = await fetch('http://localhost:3000/api/twitch/stream/viewers');
    if (!res.ok) return;
    const data = await res.json();

    const badge = el('twitch-live-badge');
    const viewers = el('twitch-viewer-count');
    const titleEl = el('twitch-stream-title');
    const gameEl = el('twitch-stream-game');

    if (badge) {
      badge.textContent = data.isLive ? 'LIVE' : 'OFFLINE';
      badge.style.background = data.isLive ? '#ef4444' : '#374151';
      badge.style.color = data.isLive ? '#fff' : '#9ca3af';
    }
    if (viewers) viewers.textContent = (data.viewers || 0).toLocaleString();
    if (titleEl) titleEl.textContent = data.title || '—';
    if (gameEl) gameEl.textContent = data.game || '—';

    // Ad countdown
    try {
      const adRes = await fetch('http://localhost:3000/api/twitch/ads/countdown');
      if (adRes.ok) {
        const adData = await adRes.json();
        const adEl = el('twitch-ad-countdown');
        const adTime = el('twitch-ad-time');
        if (adEl && adData.secondsUntilAd > 0) {
          const m = Math.floor(adData.secondsUntilAd / 60);
          const s = adData.secondsUntilAd % 60;
          if (adTime) adTime.textContent = `${m}:${s.toString().padStart(2,'0')}`;
          adEl.style.display = 'inline';
        } else if (adEl) {
          adEl.style.display = 'none';
        }
      }
    } catch (_) {}
  } catch (err) {
    console.error('[Stream State]', err);
  }
}

el('btn-twitch-refresh-stream')?.addEventListener('click', fetchAndRenderStreamState);

// Load current automation settings
async function loadChatAutomations() {
  try {
    const res = await fetch('http://localhost:3000/api/twitch/chat/status');
    if (!res.ok) return;

    const status = await res.json();
    const enabledEl = el('chat-automations-enabled');
    const followEl = el('chat-follow-msg');
    const subEl = el('chat-sub-msg');
    const raidEl = el('chat-raid-msg');

    if (enabledEl) enabledEl.checked = status.autoGreetings.enabled;
    if (followEl) followEl.value = status.autoGreetings.followMessage;
    if (subEl) subEl.value = status.autoGreetings.subscribeMessage;
    if (raidEl) raidEl.value = status.autoGreetings.raidMessage;

    updateChatStatus();
  } catch (err) {
    console.error('[Chat Load]', err);
  }
}

// Update chat connection status
async function updateChatStatus() {
  try {
    const res = await fetch('http://localhost:3000/api/twitch/chat/status');
    if (!res.ok) return;

    const status = await res.json();
    const statusEl = el('chat-status');

    if (statusEl) {
      if (status.connected) {
        statusEl.innerHTML = `🟢 <span style="color:#86efac;">Connected to #${status.channel}</span>`;
      } else {
        statusEl.innerHTML = `🔴 <span style="color:#f56565;">Not connected</span>`;
      }
    }
  } catch (err) {
    console.error('[Chat Status]', err);
  }
}

// Save automation settings
el('btn-save-automations')?.addEventListener('click', async () => {
  const enabled = el('chat-automations-enabled')?.checked || false;
  const followMessage = el('chat-follow-msg')?.value || '';
  const subscribeMessage = el('chat-sub-msg')?.value || '';
  const raidMessage = el('chat-raid-msg')?.value || '';

  try {
    const res = await fetch('http://localhost:3000/api/twitch/chat/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        followMessage,
        subscribeMessage,
        raidMessage
      })
    });

    if (!res.ok) throw new Error('Failed to save');

    alert('✅ Auto-greeting settings saved!');
  } catch (err) {
    alert('Error saving settings: ' + err.message);
  }
});

// Send chat message
el('btn-chat-send')?.addEventListener('click', async () => {
  const msgEl = el('chat-send-msg');
  const message = msgEl?.value?.trim();

  if (!message) {
    alert('Please type a message');
    return;
  }

  try {
    const res = await fetch('http://localhost:3000/api/twitch/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to send');
    }

    if (msgEl) msgEl.value = '';
    console.log('[Chat] Message sent:', message);
  } catch (err) {
    alert('Error sending message: ' + err.message);
  }
});


