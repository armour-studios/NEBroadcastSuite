// Control panel, part 13 of 17: Production deck, graphics board, run of show, flows, show pane, polls, credits.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Production Deck — a customizable Stream-Deck-style grid over the rundown action vocabulary ──
// Each button is { id, type, target, hold, label, color, hotkey }. type/target mirror rdRunSegment
// (scene/trigger/view/playout/flow/countdown) so a click — or the button's hotkey — fires the same
// send() the Run of Show would. Stored in localStorage like the rundown + hotkeys; window-shared.
const DECK_KEY = 'ne_deck_v1';
const DECK_COLORS = ['#7c5cff', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#64748b'];
function dEsc(s) { return esc(s); }   // legacy alias — canonical esc() lives at the top of the file
function deckId() { return 'd' + Math.random().toString(36).slice(2, 9); }
let _deck = (() => { try { return JSON.parse(localStorage.getItem(DECK_KEY)); } catch { return null; } })();
if (!_deck || !Array.isArray(_deck.buttons)) _deck = { cols: 4, buttons: [] };
if (!localStorage.getItem(DECK_KEY)) {
  // Seed a few universal buttons (no scene names needed) so the board isn't blank on first run.
  _deck.buttons = [
    { id: deckId(), type: 'view', target: 'hud', label: 'HUD', color: '#3b82f6' },
    { id: deckId(), type: 'view', target: 'scoreboard', label: 'Scoreboard', color: '#3b82f6' },
    { id: deckId(), type: 'trigger', target: 'breakScreen', label: 'Countdown', color: '#f59e0b' },
    { id: deckId(), type: 'trigger', target: 'winner', label: 'Winner', color: '#22c55e' },
    { id: deckId(), type: 'trigger', target: 'intro', label: 'Line-up', color: '#22c55e' },
  ];
}
window._deck = _deck;
function deckSave() { try { localStorage.setItem(DECK_KEY, JSON.stringify(_deck)); } catch {} window._deck = _deck; }

let _deckEdit = false, _deckEditingId = null, _deckEdColor = DECK_COLORS[0], _deckEdHotkey = '';

// Fire a deck button — modelled on rdRunSegment so the vocabulary stays identical.
function deckFire(b) {
  if (!b) return;
  if (b.type === 'scene') { if (b.target) send('obs_switch_scene', { sceneName: b.target }); }
  else if (b.type === 'trigger') {
    const g = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((t) => t.state === trigStateKey(b.target));
    if (g) { const live = !!(currentState[g.state] && currentState[g.state].visible); send(g.msg, live ? { visible: false } : g.show()); }
  } else if (b.type === 'view') { send(b.target === 'scoreboard' ? 'force_scoreboard' : 'force_hud'); }
  else if (b.type === 'audio') { const inp = ((currentState.obs && currentState.obs.audioInputs) || []).find((i) => i.name === b.target); send(inp && inp.muted ? 'obs_input_unmute' : 'obs_input_mute', { inputName: b.target }); }
  else if (b.type === 'source') { const parsed = bbSourceParse(b.target); if (parsed) { const src = ((currentState.obs && currentState.obs.sources) || []).find((s) => s.scene === parsed.scene && s.source === parsed.source); send(src && src.enabled ? 'obs_source_hide' : 'obs_source_show', { scene: parsed.scene, source: parsed.source }); } }
  else if (b.type === 'playout') { if (typeof playMontageById === 'function') playMontageById(b.target); }
  else if (b.type === 'flow') { const f = (currentState.flows || []).find((x) => x.id === b.target); if (f && typeof flowFire === 'function') flowFire(f); }
  else if (b.type === 'countdown') { send('set_break', { visible: true, seconds: Math.max(1, b.hold || 60), title: b.label || 'STARTING SOON' }); }
}

const DECK_ICONS = { scene: '▦', trigger: '✦', view: '▣', audio: '♪', source: '▥', playout: '▶', flow: '⚡', countdown: '⏱' };
function deckTargetLabel(b) {
  if (b.type === 'scene') return b.target || '(no scene)';
  if (b.type === 'trigger') { const m = (typeof BB_TRIGGER_LABELS !== 'undefined' && BB_TRIGGER_LABELS[b.target]) || b.target; return m; }
  if (b.type === 'view') return b.target === 'scoreboard' ? 'Scoreboard' : 'HUD';
  if (b.type === 'audio') return b.target || '(no input)';
  if (b.type === 'source') { const q = bbSourceParse(b.target); return q ? q.source : '(no source)'; }
  if (b.type === 'playout') { const m = (currentState.clips?.montages || []).find((x) => x.id === b.target); return m ? m.name : '(playlist)'; }
  if (b.type === 'flow') { const f = (currentState.flows || []).find((x) => x.id === b.target); return f ? (f.name || 'Flow') : '(flow)'; }
  if (b.type === 'countdown') return (b.hold || 60) + 's countdown';
  return '';
}
function deckAutoLabel(type, target, hold) {
  return deckTargetLabel({ type, target, hold }) || ({ scene: 'Scene', trigger: 'Trigger', view: 'View', audio: 'Audio', source: 'Source', playout: 'Playlist', flow: 'Flow', countdown: 'Countdown' }[type] || 'Button');
}

// Live-state class for a deck tile: scene/source/trigger 'on' (lit), audio 'muted' (danger).
function deckLiveClass(b) {
  const obs = currentState.obs || {};
  if (b.type === 'scene') return (obs.currentScene && obs.currentScene === b.target) ? 'on' : '';
  if (b.type === 'source') { const q = bbSourceParse(b.target); const x = q && (obs.sources || []).find((y) => y.scene === q.scene && y.source === q.source); return x && x.enabled ? 'on' : ''; }
  if (b.type === 'audio') { const a = (obs.audioInputs || []).find((y) => y.name === b.target); return a && a.muted ? 'muted' : ''; }
  if (b.type === 'trigger') { const k = trigStateKey(b.target); return (currentState[k] && currentState[k].visible) ? 'on' : ''; }
  return '';
}
// Per-tick refresh of deck live lighting without rebuilding the grid.
function refreshDeckLive() {
  if (typeof _deck === 'undefined' || !_deck) return;
  ['prod-deck-grid', 'dash-deck-grid'].forEach((gid) => {
    const g = el(gid); if (!g) return;
    (_deck.buttons || []).forEach((b) => {
      const t = g.querySelector('.deck-tile[data-id="' + b.id + '"]'); if (!t) return;
      const c = deckLiveClass(b);
      t.classList.toggle('deck-on', c === 'on');
      t.classList.toggle('deck-muted', c === 'muted');
    });
  });
}
function renderDeck() {
  const mkTile = (b, edit) => {
    const accent = b.color ? ` style="--tile-accent:${dEsc(b.color)}"` : '';
    const lc = deckLiveClass(b), liveCls = lc === 'on' ? ' deck-on' : lc === 'muted' ? ' deck-muted' : '';
    // Only show the sub-line when it adds information — hide it when it just repeats the label
    // (e.g. a "HUD" button targeting the "HUD" scene printed "HUD / HUD").
    const lbl = b.label || deckAutoLabel(b.type, b.target, b.hold);
    const sub = deckTargetLabel(b);
    const subHtml = (sub && sub.toLowerCase() !== String(lbl).toLowerCase()) ? `<span class="deck-tile-sub">${dEsc(sub)}</span>` : '';
    return `<div class="deck-tile${liveCls}" data-id="${dEsc(b.id)}"${accent}${edit ? ' draggable="true"' : ''}>`
      + `<span class="deck-tile-ico">${DECK_ICONS[b.type] || '•'}</span>`
      + `<span class="deck-tile-body"><span class="deck-tile-label">${dEsc(lbl)}</span>${subHtml}</span>`
      + (b.hotkey ? `<span class="deck-tile-key">${dEsc(b.hotkey)}</span>` : '')
      + (edit ? `<button class="deck-tile-del" title="Remove">✕</button>` : '')
      + `</div>`;
  };
  // The deck's home is the Dashboard widget now that Production dropped its Deck pane — render
  // whichever grids are actually present, all of them honouring edit mode.
  const grids = ['prod-deck-grid', 'dash-deck-grid'].map((gid) => el(gid)).filter(Boolean);
  grids.forEach((g) => {
    g.style.setProperty('--deck-cols', _deck.cols || 4);
    g.classList.toggle('deck-editing', _deckEdit);
    g.innerHTML = (_deck.buttons || []).map((b) => mkTile(b, _deckEdit)).join('');
  });
  const count = (_deck.buttons || []).length;
  const dashEmpty = el('dash-deck-empty'); if (dashEmpty) dashEmpty.style.display = count ? 'none' : '';
  const empty = el('deck-empty'); if (empty) empty.style.display = count ? 'none' : '';
  const cols = el('deck-cols'); if (cols) cols.value = String(_deck.cols || 4);
  // Audio tiles get the wheel / right-click / long-press volume ride (click still = mute via deckFire).
  grids.forEach((g) => (_deck.buttons || []).forEach((b) => {
    if (b.type !== 'audio' || !b.target) return;
    const t = g.querySelector('.deck-tile[data-id="' + b.id + '"]'); if (t) attachAudioVolume(t, b.target);
  }));
}

// Build the Target field for the editor (a select, or a seconds input for countdowns).
function deckTargetOptions(type) {
  if (type === 'scene') return ((currentState.obs && currentState.obs.availableScenes) || []).map((s) => [s, s]);
  if (type === 'trigger') return (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).map((t) => [t.state, (typeof BB_TRIGGER_LABELS !== 'undefined' && BB_TRIGGER_LABELS[t.state]) || t.state]);
  if (type === 'view') return [['hud', 'HUD'], ['scoreboard', 'Scoreboard']];
  if (type === 'audio') return ((currentState.obs && currentState.obs.audioInputs) || []).map((a) => [a.name, a.name]);
  if (type === 'source') return ((currentState.obs && currentState.obs.sources) || []).map((s) => [bbSourceKey(s.scene, s.source), s.source + '  ·  ' + s.scene]);
  if (type === 'playout') return (currentState.clips?.montages || []).map((m) => [m.id, m.name || 'Playlist']);
  if (type === 'flow') return (currentState.flows || []).map((f) => [f.id, f.name || 'Flow']);
  return [];
}
function renderDeckTargetField(type, cur) {
  const wrap = el('deck-ed-target-wrap'); if (!wrap) return;
  if (type === 'countdown') { wrap.innerHTML = `<input type="number" id="deck-ed-target" class="input-text" style="width:96px;" min="1" max="3600" value="${cur || 60}"> <span style="font-size:11px;color:var(--muted);">seconds</span>`; return; }
  const opts = deckTargetOptions(type) || [];
  wrap.innerHTML = `<select id="deck-ed-target" class="input-select">` + (opts.length ? opts.map(([v, l]) => `<option value="${dEsc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${dEsc(l)}</option>`).join('') : '<option value="">— none available —</option>') + `</select>`;
}
function renderDeckColors(cur) {
  const w = el('deck-ed-colors'); if (!w) return;
  w.innerHTML = DECK_COLORS.map((c) => `<button type="button" class="deck-sw${c === cur ? ' sel' : ''}" data-c="${c}" style="background:${c}"></button>`).join('');
}
function updateDeckHotkeyBtn(text) {
  const btn = el('deck-ed-hotkey'); if (!btn) return;
  btn.textContent = text || _deckEdHotkey || 'Set key';
  btn.style.borderColor = window.__deckCapturing ? 'var(--cp-accent)' : '';
}
function deckCaptureDone(combo) {
  if (combo) {
    // No duplicate combos across deck buttons.
    _deck.buttons.forEach((x) => { if (x.id !== _deckEditingId && x.hotkey === combo) x.hotkey = ''; });
    _deckEdHotkey = combo;
  }
  updateDeckHotkeyBtn();
}
function openDeckEditor(b) {
  _deckEditingId = b ? b.id : null;
  const dlg = el('deck-editor-dlg'); if (!dlg) return;
  const title = el('deck-ed-dlg-title'); if (title) title.textContent = b ? 'Edit button' : 'Add button';
  const type = b ? b.type : 'scene';
  if (el('deck-ed-type')) el('deck-ed-type').value = type;
  renderDeckTargetField(type, b ? (type === 'countdown' ? b.hold : b.target) : '');
  if (el('deck-ed-label')) el('deck-ed-label').value = b ? (b.label || '') : '';
  _deckEdColor = b ? (b.color || DECK_COLORS[0]) : DECK_COLORS[0];
  renderDeckColors(_deckEdColor);
  _deckEdHotkey = b ? (b.hotkey || '') : '';
  window.__deckCapturing = false; updateDeckHotkeyBtn();
  dlg.showModal();
}

// Legend on the Hotkeys tab: list every deck button that has a key bound.
function renderDeckHkLegend() {
  const w = el('prod-deck-hk-legend'); if (!w) return;
  const bound = (_deck.buttons || []).filter((b) => b.hotkey);
  w.innerHTML = bound.length
    ? bound.map((b) => `<div class="deck-hk-row"><span class="deck-hk-key">${dEsc(b.hotkey)}</span><span>${dEsc(b.label || deckAutoLabel(b.type, b.target, b.hold))}</span><span style="color:var(--muted);font-size:11px;">${dEsc(deckTargetLabel(b))}</span></div>`).join('')
    : '<p style="font-size:12px;color:var(--muted);margin:6px 0;">No deck buttons have a hotkey yet.</p>';
}

// Wiring (elements live in the static Deck pane; guarded so a missing pane is harmless).
el('deck-cols')?.addEventListener('change', function () { _deck.cols = parseInt(this.value, 10) || 4; deckSave(); renderDeck(); });
el('deck-edit-toggle')?.addEventListener('click', function () {
  _deckEdit = !_deckEdit;
  this.classList.toggle('active', _deckEdit);
  this.textContent = _deckEdit ? 'Done' : 'Edit';
  const add = el('deck-add-btn'); if (add) add.style.display = _deckEdit ? '' : 'none';
  if (!_deckEdit) { el('deck-editor-dlg')?.close(); }
  renderDeck();
});
el('deck-add-btn')?.addEventListener('click', () => openDeckEditor(null));
el('deck-ed-type')?.addEventListener('change', function () { renderDeckTargetField(this.value, ''); });
el('deck-ed-colors')?.addEventListener('click', (e) => { const sw = e.target.closest('.deck-sw'); if (!sw) return; _deckEdColor = sw.dataset.c; renderDeckColors(_deckEdColor); });
el('deck-ed-hotkey')?.addEventListener('click', function () { window.__deckCapturing = !window.__deckCapturing; updateDeckHotkeyBtn(window.__deckCapturing ? 'Press a key… (Esc)' : ''); });
el('deck-ed-hotkey-clr')?.addEventListener('click', () => { _deckEdHotkey = ''; window.__deckCapturing = false; updateDeckHotkeyBtn(); });
el('deck-ed-cancel')?.addEventListener('click', () => { window.__deckCapturing = false; el('deck-editor-dlg')?.close(); _deckEditingId = null; });
el('deck-ed-dlg-close')?.addEventListener('click', () => { window.__deckCapturing = false; el('deck-editor-dlg')?.close(); _deckEditingId = null; });
el('deck-ed-save')?.addEventListener('click', () => {
  const type = el('deck-ed-type')?.value || 'scene';
  const tEl = el('deck-ed-target');
  let target = '', hold = 0;
  if (type === 'countdown') hold = Math.max(1, parseInt(tEl?.value, 10) || 60);
  else target = tEl?.value || '';
  const label = (el('deck-ed-label')?.value || '').trim() || deckAutoLabel(type, target, hold);
  const patch = { type, target, hold, label, color: _deckEdColor, hotkey: _deckEdHotkey };
  if (_deckEditingId) { const i = _deck.buttons.findIndex((x) => x.id === _deckEditingId); if (i >= 0) _deck.buttons[i] = { ..._deck.buttons[i], ...patch }; }
  else { patch.id = deckId(); _deck.buttons.push(patch); }
  if (patch.hotkey) { const keep = _deckEditingId || patch.id; _deck.buttons.forEach((x) => { if (x.id !== keep && x.hotkey === patch.hotkey) x.hotkey = ''; }); }
  deckSave(); renderDeck(); renderDeckHkLegend();
  el('deck-editor-dlg')?.close(); _deckEditingId = null; window.__deckCapturing = false;
});

// Maps a deck button to its preview overlay URL path.
function deckDashPreviewPath(b) {
  const TRIG = { breakScreen: '/countdown.html', winner: '/winner.html', intro: '/intro.html', spotlight: '/spotlightdesk.html', veto: '/mapscreen.html' };
  if (b.type === 'trigger') return TRIG[b.target] || '/live.html';
  if (b.type === 'countdown') return '/countdown.html';
  if (b.type === 'playout') return '/replay-player.html';
  return '/live.html';
}

// Dashboard deck: arm → Take flow (no immediate fire, no edit/drag)
(function wireDashDeckGrid() {
  const grid = el('dash-deck-grid'); if (!grid) return;
  let armedId = null;

  function arm(id) {
    armedId = id;
    grid.querySelectorAll('.deck-tile').forEach((t) => t.classList.toggle('deck-armed', t.dataset.id === id));
    const take = el('dash-pv-take'); if (take) take.disabled = !id;
    const f = el('dash-pv-frame'); if (!f) return;
    if (!id) { f.src = 'http://127.0.0.1:3000/live.html'; return; }
    const b = _deck.buttons.find((x) => x.id === id);
    if (b) f.src = 'http://127.0.0.1:3000' + deckDashPreviewPath(b);
  }

  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.deck-tile'); if (!tile) return;
    const id = tile.dataset.id;
    // Edit mode (the controls the retired Production Deck pane used to own): ✕ removes a button,
    // any other click opens its editor. Nothing fires, and anything armed is stood down first.
    if (_deckEdit) {
      if (armedId) arm(null);
      if (e.target.closest('.deck-tile-del')) {
        _deck.buttons = _deck.buttons.filter((x) => x.id !== id);
        deckSave(); renderDeck(); renderDeckHkLegend(); return;
      }
      openDeckEditor(_deck.buttons.find((x) => x.id === id)); return;
    }
    if (id === armedId) {
      const b = _deck.buttons.find((x) => x.id === id);
      if (b) { deckFire(b); tile.classList.remove('deck-fire'); void tile.offsetWidth; tile.classList.add('deck-fire'); }
      arm(null);
    } else {
      arm(id);
    }
  });

  el('dash-pv-take')?.addEventListener('click', () => {
    if (!armedId) return;
    const b = _deck.buttons.find((x) => x.id === armedId);
    if (b) {
      deckFire(b);
      const tile = grid.querySelector('[data-id="' + armedId + '"]');
      if (tile) { tile.classList.remove('deck-fire'); void tile.offsetWidth; tile.classList.add('deck-fire'); }
    }
    arm(null);
    const f = el('dash-pv-frame'); if (f) setTimeout(() => { f.src = 'http://127.0.0.1:3000/live.html'; }, 800);
  });

  el('dash-pv-reload')?.addEventListener('click', () => { const f = el('dash-pv-frame'); if (f) f.src = f.src; });

  el('dash-deck-add')?.addEventListener('click', () => openDeckEditor(null));

  // Drag to reorder — edit mode only.
  let dragId = null;
  grid.addEventListener('dragstart', (e) => { const t = e.target.closest('.deck-tile'); if (!t || !_deckEdit) { e.preventDefault(); return; } dragId = t.dataset.id; t.classList.add('deck-drag'); });
  grid.addEventListener('dragend', (e) => { const t = e.target.closest('.deck-tile'); if (t) t.classList.remove('deck-drag'); dragId = null; });
  grid.addEventListener('dragover', (e) => { if (_deckEdit) e.preventDefault(); });
  grid.addEventListener('drop', (e) => {
    if (!_deckEdit || !dragId) return; e.preventDefault();
    const tgt = e.target.closest('.deck-tile'); if (!tgt) return;
    const from = _deck.buttons.findIndex((x) => x.id === dragId);
    const to = _deck.buttons.findIndex((x) => x.id === tgt.dataset.id);
    if (from < 0 || to < 0 || from === to) return;
    const [m] = _deck.buttons.splice(from, 1); _deck.buttons.splice(to, 0, m);
    deckSave(); renderDeck();
  });
})();

deckSave();   // persist the seeded defaults on first run
renderDeck();

// ── Team-name side selects: relabel the blue/orange options with the live team names ──
// Graphics like Winner / Line-up choose a "side"; producers think in team names, so the
// dropdowns show the actual names while still mapping to blue/orange under the hood.
function syncTeamSideSelects(teams) {
  teams = teams || (currentState && currentState.teams) || {};
  const bn = (teams.blue && teams.blue.name) || 'Blue team';
  const on = (teams.orange && teams.orange.name) || 'Orange team';
  // select-winner-side is fully managed by _gfxRefreshWinnerPicker — skip it here
  ['select-intro-side', 'ck-winner-side', 'ck-intro-side'].forEach((id) => {
    const sel = el(id); if (!sel) return;
    const ob = sel.querySelector('option[value="blue"]'); if (ob) ob.textContent = bn;
    const oo = sel.querySelector('option[value="orange"]'); if (oo) oo.textContent = on;
  });
}

// ── Production ▸ Graphics: board of every overlay you can push live (show / hide) ──
function gfxPathVal(obj, dotted) { return String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
// Mirrors gfxPathVal but writes — used to update currentState optimistically (see the click
// handler below) so a second rapid click reads fresh state instead of a stale pre-broadcast value.
function gfxSetPathVal(obj, dotted, val) {
  if (!obj) return;
  const parts = String(dotted).split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = val;
}
const GFX_KEY2TRIG = { break: 'breakScreen', winner: 'winner', intro: 'intro', veto: 'veto', spotlight: 'watchlist' };

el('credits-pull-shifts')?.addEventListener('click', () => {
  const chosen = el('credits-shift-event')?.value || '';
  if (!chosen) { showToast('Pick an event first.', '#fbbf24'); return; }
  const shifts = ((currentState && currentState.casters) || {}).shifts || [];
  const matching = shifts.filter((s) => (chosen === '__none__' ? !s.eventSlug : s.eventSlug === chosen));
  if (!matching.length) { showToast('No saved shifts for that event.', '#fbbf24'); return; }
  // Union every name referenced across those shifts — cam slots, host/observer, AND anyone
  // just marked "on shift" (that's how producers/admins/socials get in, since they have no cam).
  const names = new Set();
  matching.forEach((s) => {
    [1, 2, 3, 4].forEach((n) => { const v = ((s.slots && s.slots[n]) || '').trim(); if (v) names.add(v); });
    if (s.host) names.add(s.host);
    if (s.observer) names.add(s.observer);
    (s.active || []).forEach((n) => { if (n) names.add(n); });
  });
  if (!names.size) { showToast('Those shifts have no crew assigned yet.', '#fbbf24'); return; }
  const crewByName = {}; ((currentState && currentState.crew) || []).forEach((c) => { if (c && c.name) crewByName[c.name.toLowerCase()] = c; });
  const cur = ((currentState && currentState.credits) || {}).talent || [];
  const curNames = new Set(cur.map((t) => (t.name || '').toLowerCase()));
  const added = [];
  names.forEach((nm) => {
    const c = crewByName[nm.toLowerCase()];
    const display = c ? (c.handle || c.name) : nm;   // gamertag-first, same as the desk/credits bar
    if (curNames.has(display.toLowerCase())) return;
    const group = !c ? 'casters'
      : c.group === 'hosts' ? 'hosts'
      : c.group === 'observers' ? 'observers'
      : ['production', 'producer', 'admin', 'socials'].includes(c.group) ? 'production'
      : 'casters';
    added.push({ name: display, role: c ? (c.role || '') : '', group });
    curNames.add(display.toLowerCase());
  });
  if (!added.length) { showToast('Everyone from that event is already credited.', '#fbbf24'); return; }
  send('set_credits', { talent: [...cur, ...added] });
  showToast(`Added ${added.length} crew member${added.length === 1 ? '' : 's'} from that event to the credits.`, '#22c55e');
});

// Populate the credits panel's event picker from saved Show-Deck shifts AND surface the currently
// LINKED start.gg/tournament event (auto-selected) — so the credits panel reflects the live event.
// (The dropdown used to never get populated, so the linked event never showed up here.)
function syncCreditsShiftEventSelect() {
  const sel = el('credits-shift-event'); if (!sel) return;
  const s = currentState || {};
  const shifts = (s.casters && s.casters.shifts) || [];
  const active = s.activeEvent || {};
  const names = {};   // eventSlug -> friendly name
  let hasNone = false;
  shifts.forEach((sh) => {
    if (sh && sh.eventSlug) { if (!names[sh.eventSlug]) names[sh.eventSlug] = sh.eventName || sh.eventSlug; }
    else if (sh) hasNone = true;
  });
  // The currently-linked event — surface it even if no shifts are saved under it yet.
  const activeSlug = active.slug || (s.startgg && s.startgg.eventSlug) || '';
  if (activeSlug) names[activeSlug] = active.name || (s.startgg && s.startgg.selectedEvent && s.startgg.selectedEvent.name) || activeSlug;
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const slugs = Object.keys(names);
  const opts = ['<option value="">Choose an event…</option>'];
  slugs.forEach((slug) => opts.push('<option value="' + esc(slug) + '">' + esc(names[slug] + (slug === activeSlug ? '  •  linked' : '')) + '</option>'));
  if (hasNone) opts.push('<option value="__none__">Shifts with no event</option>');
  const html = opts.join('');
  if (sel.dataset.sig === html) return;
  const prev = sel.value;
  sel.dataset.sig = html;
  sel.innerHTML = html;
  if (prev && (slugs.includes(prev) || prev === '__none__')) sel.value = prev;   // keep the producer's choice
  else if (activeSlug) sel.value = activeSlug;                                    // default to the linked event
}
// Punch-up graphics: only one of these can be live at a time — showing one auto-hides whichever
// other one is live. Casters, Ticker, Sponsor Banner and Teams to Watch are NOT in this set — they
// run as independent, persistent overlays alongside whatever punch-up graphic is showing.
const GFX_ONAIR_EXCLUSIVE = new Set(['break', 'winner', 'intro', 'matchup', 'veto', 'draft', 'bracket', 'upcoming', 'standings', 'spotlight', 'teamspot', 'credits']);
// overlay/gfx.html's internal LAYER_MAP names "Upcoming Matches" scene as 'schedule', not
// 'upcoming' — set_gfx_active needs the LAYER_MAP name or gfx.html shows nothing at all even
// though this board (correctly) thinks the graphic is live.
const GFX_ONAIR_SCENE_KEY = { upcoming: 'schedule' };
function onairTrig(key) { return (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((t) => t.state === GFX_KEY2TRIG[key]); }
function onairHide(s) { const trig = onairTrig(s.key); if (trig) send(trig.msg, { visible: false }); else send(s.msg, s.hideData || { visible: false }); }
function onairShow(s) { const trig = onairTrig(s.key); if (trig) send(trig.msg, trig.show()); else send(s.msg, s.showData || { visible: true }); }
// Resolve whether a scene is currently on — prefers a custom check() over the dot-path, so scenes
// like Matchup (detected via gfxActive, not a dedicated .visible flag) work correctly.
function onairIsOn(s, state) { return s.check ? s.check(state) : !!gfxPathVal(state, s.path); }
// Auto-cut OBS — the Graphics top bar's armed "cut to this scene when a graphic goes live" switch.
// Push Live, the Go-Live triggers and the trigger gear all fire this; every on-air surface has to,
// or a graphic pushed from one board goes live on gfx.html while OBS stays on the previous scene.
function gfxAutocutOBS() {
  if (!el('gfx-autocut-on')?.checked) return;
  const sc = (el('gfx-autocut-scene')?.value || '').trim();
  if (sc) send('obs_switch_scene', { sceneName: sc });
}
// THE single "put this graphic on air / take it off" routine. Shared by the Production ▸ Graphics
// On-air board and the rail's On-Air Elements grid so those two surfaces can never disagree with
// each other or with Graphics ▸ Push Live: same exclusivity, same gfxActive layer, same OBS cut.
// `on` = the graphic's CURRENT state (true → this call takes it off air).
function onairPut(s, on) {
  if (!s) return;
  const key = s.key;
  if (!on && GFX_ONAIR_EXCLUSIVE.has(key)) {
    // Turning a punch-up graphic ON — hide every OTHER punch-up graphic that's currently live.
    // Every send() below is paired with an immediate optimistic update to currentState (not just
    // fire-and-forget) — these boards are built for rapid clicking mid-show, and without this a
    // second click before the server's broadcast round-trip landed would read stale "not live yet"
    // state for the previous graphic and skip hiding it, leaving more than one marked live at once.
    (window.ONAIR_SCENES || []).forEach((other) => {
      if (other.key === key || !GFX_ONAIR_EXCLUSIVE.has(other.key)) return;
      if (onairIsOn(other, currentState)) { onairHide(other); if (!other.check) gfxSetPathVal(currentState, other.path, false); }
    });
    const liveScene = currentState && currentState.gfxActive;
    if (liveScene && liveScene !== key) {
      const sm = (typeof window._gfxSceneMeta !== 'undefined') ? window._gfxSceneMeta : {};
      if (sm[liveScene]) gfxHide(liveScene);
    }
    const gfxKey = GFX_ONAIR_SCENE_KEY[key] || key;
    send('set_gfx_active', { scene: gfxKey });
    if (currentState) currentState.gfxActive = gfxKey;
  } else if (on && GFX_ONAIR_EXCLUSIVE.has(key)) {
    const liveScene = currentState && currentState.gfxActive;
    const gfxKey = GFX_ONAIR_SCENE_KEY[key] || key;
    if (liveScene === gfxKey) { send('set_gfx_active', { scene: null }); if (currentState) currentState.gfxActive = null; }
  }
  if (on) onairHide(s); else onairShow(s);
  // Scenes with a custom check() (matchup: on === gfxActive === 'matchup') don't have a real
  // independent .visible path — s.path there is just 'gfxActive', already correctly updated
  // above; writing through it here would clobber that string with a stray boolean.
  if (!s.check) gfxSetPathVal(currentState, s.path, !on);
  // Going on air also cuts the switcher when auto-cut is armed — this is what makes the board
  // "transition the scene" instead of only flipping a flag gfx.html may not even be on screen for.
  if (!on && GFX_ONAIR_EXCLUSIVE.has(key)) gfxAutocutOBS();
  if (typeof renderGraphicsBoard === 'function') renderGraphicsBoard();
  if (typeof syncOnAirGrid === 'function') syncOnAirGrid(currentState || {});
  if (typeof window._gfxRefreshTopBar === 'function') window._gfxRefreshTopBar();
}
window._onairPut = onairPut;

// Every real OBS scene, merged with the graphics (ONAIR_SCENES) list and deduped by name —
// shared by anything that wants a "push a graphic OR cut an OBS scene" combined list. An OBS
// scene whose name collides with a graphic's key/label (case-insensitive) is dropped from the
// scene side rather than shown twice (e.g. a leftover OBS scene literally named "Bracket" next
// to the "Bracket" graphic). Used by the qrail PUT ON AIR panel — NOT this board, which stays
// graphics-only (see below).
function onairAllItems() {
  const ov = (window.ONAIR_SCENES || []).map((s) => ({ id: 'ov:' + s.key, t: 'overlay', k: s.key, label: s.label, ref: s }));
  const taken = new Set();
  ov.forEach((it) => { taken.add(it.k.toLowerCase()); taken.add(it.label.toLowerCase()); });
  const rawScenes = (currentState && currentState.obs && Array.isArray(currentState.obs.availableScenes)) ? currentState.obs.availableScenes : [];
  const scenes = rawScenes
    .filter((name) => name && !/^═/.test(name.trim()))   // skip the generated collection's blank divider scenes
    .filter((name) => !taken.has(name.toLowerCase()))
    .map((name) => ({ id: 'scene:' + name, t: 'scene', k: name, label: name }));
  return ov.concat(scenes);
}

// Custom card order — reorderable like the Deck grid, persisted the same way.
const ONAIR_ORDER_KEY = 'ne_onair_order_v1';
function onairLoadOrder() {
  let saved = []; try { saved = JSON.parse(localStorage.getItem(ONAIR_ORDER_KEY) || '[]'); } catch (_) {}
  const keys = (window.ONAIR_SCENES || []).map((s) => s.key);
  const kept = saved.filter((k) => keys.includes(k));
  return kept.concat(keys.filter((k) => !kept.includes(k)));   // newly-added scenes land at the end
}
function onairSaveOrder() { try { localStorage.setItem(ONAIR_ORDER_KEY, JSON.stringify(_onairOrder)); } catch (_) {} }
let _onairOrder = onairLoadOrder();
let _onairEdit = false;

// Which scene editor a board card opens. The board list and the left scene picker are NOT the
// same set — the picker owns 'preshow' (Desk Show), which has no on-air card, and the board owns
// casters/watchlist/teamspot/banner, which are pure toggles edited elsewhere (Talent, Brands).
// So this resolves against the picker's real buttons at call time: a card is click-to-edit only
// when a matching editor actually exists, and a newly-added editor becomes clickable for free.
const GFX_BOARD_EDIT_ALIAS = { upcoming: 'schedule' };   // the two lists spell this one differently
function gfxBoardEditorKey(key) {
  const want = GFX_BOARD_EDIT_ALIAS[key] || key;
  return document.querySelector('.gfx-sidenav-btn[data-gfxscene="' + want + '"]') ? want : null;
}

// The live-only strip above the board. Signature-guarded so it only touches the DOM when the set
// of live graphics actually changes (this runs on every state broadcast).
function renderGraphicsLiveNow(ordered) {
  const host = el('gfx-live-now'); if (!host) return;
  const live = ordered.filter((s) => onairIsOn(s, currentState));
  const sig = live.map((s) => s.key).join(',');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  if (!live.length) {
    host.className = 'gfx-live-now is-empty';
    host.innerHTML = '<span class="gfx-live-now-empty">Nothing on air</span>';
    return;
  }
  host.className = 'gfx-live-now';
  host.innerHTML = '<span class="gfx-live-now-label">On air<span class="gfx-live-now-count">' + live.length + '</span></span>'
    + live.map((s) => '<span class="gfx-live-chip">'
        + '<span class="gfx-live-chip-dot"></span>'
        + '<span class="gfx-live-chip-name">' + dEsc(s.label) + '</span>'
        + '<button type="button" class="gfx-live-chip-hide" data-livehide="' + s.key + '" title="Take ' + dEsc(s.label) + ' off air">Hide</button>'
      + '</span>').join('');
}
el('gfx-live-now')?.addEventListener('click', (e) => {
  const key = e.target.closest('[data-livehide]')?.dataset.livehide; if (!key) return;
  const s = (window.ONAIR_SCENES || []).find((x) => x.key === key); if (!s) return;
  onairPut(s, true);   // it's in this strip because it IS live → this takes it off air
});

function renderGraphicsBoard() {
  const wrap = el('prod-graphics-board'); if (!wrap) return;
  const byKey = {}; (window.ONAIR_SCENES || []).forEach((s) => { byKey[s.key] = s; });
  const ordered = _onairOrder.map((k) => byKey[k]).filter(Boolean);
  renderGraphicsLiveNow(ordered);
  wrap.classList.toggle('gfx-board-editing', _onairEdit);
  // Only rebuild the DOM when the order or edit mode actually changes — avoids wiping toggle
  // button state/animations on every unrelated state broadcast.
  const sig = ordered.map((s) => s.key).join(',') + '|' + _onairEdit;
  if (wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    wrap.innerHTML = ordered.map((s) => {
      const editable = !_onairEdit && gfxBoardEditorKey(s.key);
      return `<div class="gfx-card${editable ? ' gfx-card-editable' : ''}" data-key="${s.key}"${_onairEdit ? ' draggable="true"' : ''}`
        + `${editable ? ` title="Edit ${dEsc(s.label)}"` : ''}>`
        + `<span class="gfx-dot"></span><span class="gfx-name">${dEsc(s.label)}</span>`
        + `<button class="btn btn-secondary btn-xs gfx-toggle" id="gfx-bt-${s.key}">Show</button></div>`;
    }).join('');
  }
  ordered.forEach((s) => {
    const on = onairIsOn(s, currentState);
    const card = wrap.querySelector('.gfx-card[data-key="' + s.key + '"]'); if (!card) return;
    card.classList.toggle('on', on);
    const bt = el('gfx-bt-' + s.key); if (bt) { bt.textContent = on ? 'Hide' : 'Show'; bt.className = 'btn btn-' + (on ? 'danger' : 'secondary') + ' btn-xs gfx-toggle'; }
  });
}
el('prod-graphics-board')?.addEventListener('click', (e) => {
  if (_onairEdit) return;   // reorder mode — drag only, toggle buttons are inert (see CSS)
  const card = e.target.closest('.gfx-card'); if (!card) return;
  const key = card.dataset.key;
  const s = (window.ONAIR_SCENES || []).find((x) => x.key === key); if (!s) return;
  // The Show/Hide button keeps doing exactly what it did; clicking the REST of the card now
  // jumps to that graphic's editor, so the card is both the on-air control and the way in.
  if (e.target.closest('.gfx-toggle')) { onairPut(s, onairIsOn(s, currentState)); return; }
  const ed = gfxBoardEditorKey(key);
  if (ed && typeof window._gfxCfgShow === 'function') window._gfxCfgShow(ed);
});
// Reorder mode — drag-and-drop, mirrors the Deck grid's edit/drag pattern.
el('onair-edit-toggle')?.addEventListener('click', function () {
  _onairEdit = !_onairEdit;
  this.classList.toggle('active', _onairEdit);
  this.textContent = _onairEdit ? 'Done' : 'Reorder';
  renderGraphicsBoard();
});
(function wireOnairBoardDrag() {
  const wrap = el('prod-graphics-board'); if (!wrap) return;
  let dragKey = null;
  wrap.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.gfx-card'); if (!t || !_onairEdit) { e.preventDefault(); return; }
    dragKey = t.dataset.key; t.classList.add('gfx-card-drag');
  });
  wrap.addEventListener('dragend', (e) => { const t = e.target.closest('.gfx-card'); if (t) t.classList.remove('gfx-card-drag'); dragKey = null; });
  wrap.addEventListener('dragover', (e) => { if (_onairEdit) e.preventDefault(); });
  wrap.addEventListener('drop', (e) => {
    if (!_onairEdit || !dragKey) return; e.preventDefault();
    const tgt = e.target.closest('.gfx-card'); if (!tgt) return;
    const from = _onairOrder.indexOf(dragKey), to = _onairOrder.indexOf(tgt.dataset.key);
    if (from < 0 || to < 0 || from === to) return;
    const [m] = _onairOrder.splice(from, 1); _onairOrder.splice(to, 0, m);
    onairSaveOrder(); renderGraphicsBoard();
  });
})();
// Live-preview reloads + jump to the full qrail Twitch panel from the Deck.
el('gfx-pv-reload')?.addEventListener('click', () => { const f = el('gfx-pv-frame'); if (f) f.src = f.src; });
el('prod-open-twitch')?.addEventListener('click', () => document.querySelector('.qrail-tab[data-qtab="twitch"]')?.click());
// Scale the live-preview iframes (1920x1080 overlays) to fit their boxes — JS scaling so it
// works regardless of CSS container-query support; re-fit on show, resize and (re)load.
function fitLivePreview(frame) {
  if (!frame) return;
  const box = frame.parentElement; if (!box) return;
  const bw = box.clientWidth; if (!bw) return;
  frame.style.transform = 'scale(' + (bw / 1920) + ')';
}
function fitLivePreviews() { document.querySelectorAll('.live-pv iframe').forEach(fitLivePreview); }
window.addEventListener('resize', () => { clearTimeout(window.__lpvTimer); window.__lpvTimer = setTimeout(fitLivePreviews, 120); });
['dash-pv-frame', 'gfx-pv-frame'].forEach((id) => { const fr = el(id); if (fr) fr.addEventListener('load', () => fitLivePreview(fr)); });
setTimeout(fitLivePreviews, 250);
// Live-preview boxes can resize without a window.resize firing — the graphics hub's own columns
// relayout when the qrail expands/collapses, and the floating OBS Program panel is user-resizable
// via drag handles. Observe both so their iframes always re-fit instead of scaling stale.
// (ResizeObserver: modern Electron/Chromium.)
try {
  if (typeof ResizeObserver === 'function') {
    const _gfxPvRO = new ResizeObserver(() => { clearTimeout(window.__gfxLpvTimer); window.__gfxLpvTimer = setTimeout(fitLivePreviews, 60); });
    const _obsPvBoxes = () => document.querySelectorAll('.gfx-popout-box .live-pv, .obs-prev-gfx .live-pv').forEach((b) => { if (b && !b.__roBound) { b.__roBound = true; _gfxPvRO.observe(b); } });
    _obsPvBoxes();
    setTimeout(_obsPvBoxes, 1200);   // catch preview boxes created after first paint (borrowed panels)
  }
} catch (_) { /* ResizeObserver unavailable — window.resize + _pdShow still cover the common cases */ }



// Flows data — synced from server state (state.flows). Kept as a module-level var so
// rundown "Run flow" segments can reference it without a full state lookup.
let _flows = [];
// _flows is only assigned inside renderFlows() (i.e. once the Flows tab has rendered) — rundown
// segments must not depend on the producer having visited that tab, so they read through this.
function rdFlows() { return (_flows && _flows.length) ? _flows : ((typeof currentState !== 'undefined' && currentState && currentState.flows) || []); }

// ── Run of Show (rundown) ─────────────────────────────────────────────────
// An ordered list of segments the producer steps through. Each segment fires an action
// (scene cut / trigger / countdown / playlist / overlay view / manual hold). Timed segments
// (hold > 0) auto-advance; hold = 0 waits for the Advance button. Stored client-side.
const RD_KEY  = 'ne_rundown_v1';   // legacy single-rundown key — migrated into RDS_KEY on first load
const RDS_KEY = 'ne_rundowns_v1';  // { activeId, rundowns: [{ id, name, segs }] }
let _rdStore = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(RDS_KEY));
    if (s && Array.isArray(s.rundowns) && s.rundowns.length) return s;
  } catch {}
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem(RD_KEY) || '[]'); } catch {}
  const first = { id: 'rd_' + Math.random().toString(36).slice(2, 8), name: 'Main Show', segs: Array.isArray(legacy) ? legacy : [] };
  return { activeId: first.id, rundowns: [first] };
})();
function rdActive() {
  let r = _rdStore.rundowns.find((x) => x.id === _rdStore.activeId);
  if (!r) { r = _rdStore.rundowns[0]; _rdStore.activeId = r.id; }
  return r;
}
let _rdSegs = rdActive().segs;
let _rdRunning = false, _rdIdx = -1, _rdTimer = null, _rdEditIdx = -1;
function rdSave() { rdActive().segs = _rdSegs; try { localStorage.setItem(RDS_KEY, JSON.stringify(_rdStore)); } catch {} }
const RD_TRIGGERS = [['breakScreen', 'Countdown'], ['winner', 'Winner'], ['intro', 'Line-up'], ['spotlight', 'Teams to Watch'], ['veto', 'Map Veto']];
function rdTargetLabel(seg) {
  if (seg.type === 'scene') return seg.target || '(no scene)';
  if (seg.type === 'trigger') return (RD_TRIGGERS.find((t) => t[0] === seg.target) || [, seg.target])[1];
  if (seg.type === 'playout') { const p = (currentState.clips?.montages || []).find((x) => x.id === seg.target); return p ? p.name : '(playlist)'; }
  if (seg.type === 'flow') { const f = rdFlows().find((x) => x.id === seg.target); return f ? f.name : '(flow)'; }
  if (seg.type === 'view') return seg.target === 'scoreboard' ? 'Scoreboard' : 'HUD';
  if (seg.type === 'countdown') return (seg.hold || 0) + 's countdown';
  if (seg.type === 'section') return seg.label || 'Section';
  return seg.label || 'Hold';
}
const RD_TYPE_LABEL = { scene: 'CUT', trigger: 'TRIG', countdown: 'TIMER', playout: 'PLAY', flow: 'FLOW', view: 'VIEW', manual: 'HOLD', section: 'SECTION' };
const RD_GFX_LABEL = { break: 'Break', winner: 'Winner', intro: 'Line-up', matchup: 'Matchup', veto: 'Map Pool', bracket: 'Bracket', standings: 'Standings', schedule: 'Schedule', spotlight: 'Spotlight', credits: 'Credits' };
// The full-width live driver at the top of Production ▸ Run of Show — ON STREAM + phase controller.
function rdRenderDriver() {
  const driver = el('rd-driver'); if (!driver) return;
  const nowEl = el('rd-now'), gfxEl = el('rd-now-gfx');
  if (nowEl) { const obs = (currentState && currentState.obs) || {}; nowEl.textContent = !obs.connected ? 'OBS not connected' : (obs.currentScene || 'No scene'); }
  if (gfxEl) {
    const g = (currentState && typeof currentState.gfxActive === 'string') ? currentState.gfxActive : '';
    const nice = g ? (RD_GFX_LABEL[g] || g) : '';
    if (nice) { gfxEl.textContent = nice; gfxEl.style.display = ''; } else { gfxEl.style.display = 'none'; }
  }
  const S = (typeof rdSummary === 'function') ? rdSummary() : null; if (!S) return;
  driver.classList.toggle('is-live', S.running);
  const posEl = el('rd-driver-pos'), curEl = el('rd-driver-cur'), nextEl = el('rd-driver-next');
  const backBtn = el('rd-driver-back'), goBtn = el('rd-driver-go'), stopBtn = el('rd-driver-stop');
  const set = (e, t) => { if (e) e.textContent = t; };
  if (!S.hasSegs) {
    set(posEl, ''); set(curEl, 'No segments yet'); set(nextEl, 'Add scenes, triggers, countdowns below');
    if (backBtn) backBtn.disabled = true;
    if (goBtn) { goBtn.textContent = 'Start'; goBtn.disabled = true; }
    if (stopBtn) stopBtn.style.display = 'none';
  } else if (!S.running) {
    set(posEl, `0 / ${S.total}`); set(curEl, 'Ready to start'); set(nextEl, S.next ? `First: ${S.next}` : '');
    if (backBtn) backBtn.disabled = true;
    if (goBtn) { goBtn.textContent = 'Start'; goBtn.disabled = false; }
    if (stopBtn) stopBtn.style.display = 'none';
  } else {
    set(posEl, `Phase ${S.pos} / ${S.total}`); set(curEl, S.current || 'Segment');
    set(nextEl, S.atEnd ? 'Last phase' : (S.next ? `Next: ${S.next}` + (S.next2 ? ` · then ${S.next2}` : '') : ''));
    if (backBtn) backBtn.disabled = !S.hasPrev;
    if (goBtn) { goBtn.textContent = S.atEnd ? 'Finish' : 'Advance'; goBtn.disabled = false; }
    if (stopBtn) stopBtn.style.display = '';
  }
}
// Driver controls (Production ▸ Run of Show).
el('rd-driver-back')?.addEventListener('click', () => { if (typeof rdPrev === 'function') rdPrev(); });
el('rd-driver-go')?.addEventListener('click', () => { if (typeof rdNext === 'function') rdNext(); });
el('rd-driver-stop')?.addEventListener('click', () => { if (typeof rdStop === 'function') rdStop(); });
// Target <select> for a segment type — shared by the add form and the per-row inline editor.
// 'playout' segments run via playMontageById(seg.target), which looks up clips.montages — the
// picker must list the SAME id space, not the old (dead) state.playouts.
function rdTargetSelectHtml(type, selected, idAttr) {
  const scenes = (currentState.obs && currentState.obs.availableScenes) || [];
  const playouts = (currentState.clips && currentState.clips.montages) || [];
  const idH = idAttr ? ` id="${idAttr}"` : '';
  const opt = (v, l) => `<option value="${poEsc(v)}"${selected === v ? ' selected' : ''}>${poEsc(l)}</option>`;
  if (type === 'scene') return `<select${idH} class="rd-target-sel input-select" style="max-width:220px;">${scenes.map((s) => opt(s, s)).join('') || '<option value="">(OBS not connected)</option>'}</select>`;
  if (type === 'trigger') return `<select${idH} class="rd-target-sel input-select" style="max-width:180px;">${RD_TRIGGERS.map((t) => opt(t[0], t[1])).join('')}</select>`;
  if (type === 'playout') return `<select${idH} class="rd-target-sel input-select" style="max-width:220px;">${playouts.map((p) => opt(p.id, p.name)).join('') || '<option value="">(no playlists)</option>'}</select>`;
  if (type === 'flow') return `<select${idH} class="rd-target-sel input-select" style="max-width:220px;">${rdFlows().map((f) => opt(f.id, f.name)).join('') || '<option value="">(no flows)</option>'}</select>`;
  if (type === 'view') return `<select${idH} class="rd-target-sel input-select" style="max-width:160px;">${opt('hud', 'HUD')}${opt('scoreboard', 'Scoreboard')}</select>`;
  return '';   // countdown uses hold as seconds; manual/section have no target
}
function renderRdAddTarget() {
  const wrap = el('rd-add-target-wrap'); if (!wrap) return;
  const existing = el('rd-add-target');
  if (existing && document.activeElement === existing) return;   // don't clobber a live selection
  const prev = existing ? existing.value : '';
  const type = el('rd-add-type')?.value || 'scene';
  wrap.innerHTML = rdTargetSelectHtml(type, prev, 'rd-add-target');
}
// Segment types offered by the inline editor (same set as the add form's dropdown).
const RD_EDIT_TYPES = [['scene', 'Cut to scene'], ['trigger', 'Trigger graphic'], ['countdown', 'Countdown'], ['playout', 'Play playlist'], ['flow', 'Run flow'], ['view', 'Overlay view'], ['manual', 'Manual hold / note'], ['section', 'Section header']];
function renderRundown() {
  if (typeof rdPublishStatus === 'function') { try { rdPublishStatus(); } catch {} }
  const list = el('rd-list'); if (!list) return;
  // An open inline editor being typed in must survive the auto-refresh pipeline's re-renders.
  if (_rdEditIdx >= 0 && list.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  rdRenderDriver();   // the live driver (ON STREAM + phase controller) supersedes the old status line
  const status = el('rd-status'); if (status) status.style.display = 'none';
  list.innerHTML = '';
  _rdSegs.forEach((seg, i) => {
    const row = document.createElement('div');
    const cur = _rdRunning && i === _rdIdx;
    const isSection = seg.type === 'section';
    // ── Inline editor for the segment being edited ──
    if (i === _rdEditIdx) {
      row.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--cp-accent);border-radius:7px;background:rgba(124,58,237,.08);';
      row.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <select class="rde-type input-select" style="max-width:170px;">${RD_EDIT_TYPES.map(([v, l]) => `<option value="${v}"${seg.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <span class="rde-target-wrap">${rdTargetSelectHtml(seg.type, seg.target)}</span>
          <label style="font-size:12px;display:flex;align-items:center;gap:5px;" title="Auto-advance after this many seconds (0 = wait for Advance)">hold <input type="number" class="rde-hold input-text" min="0" max="3600" value="${seg.hold || 0}" style="width:62px;"> s</label>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" class="rde-label input-text" placeholder="Label (optional)" value="${poEsc(seg.label || '')}" style="flex:1;min-width:120px;">
          <button type="button" class="btn btn-primary btn-xs rde-save">Save</button>
          <button type="button" class="btn btn-ghost btn-xs rde-cancel">Cancel</button>
        </div>`;
      row.querySelector('.rde-type').addEventListener('change', function () {
        row.querySelector('.rde-target-wrap').innerHTML = rdTargetSelectHtml(this.value, seg.target);
      });
      row.querySelector('.rde-save').addEventListener('click', () => {
        const tsel = row.querySelector('.rde-target-wrap select');
        seg.type = row.querySelector('.rde-type').value;
        seg.target = tsel ? tsel.value : '';
        seg.hold = Math.max(0, parseInt(row.querySelector('.rde-hold').value, 10) || 0);
        seg.label = row.querySelector('.rde-label').value.trim();
        _rdEditIdx = -1; rdSave(); renderRundown();
      });
      row.querySelector('.rde-cancel').addEventListener('click', () => { _rdEditIdx = -1; renderRundown(); });
      list.appendChild(row);
      return;
    }
    if (isSection) {
      // Section header — an organizational divider, never executed (the runner skips over it).
      row.className = 'rd-section';
      row.innerHTML = `<span class="rd-section-lbl">${poEsc(seg.label || 'Section')}</span><div class="rd-section-line"></div><span class="rd-row-acts"></span>`;
    } else {
      const bdg = RD_BADGE[seg.type] || { color: '#c4b5fd', bg: 'rgba(196,181,253,.12)' };
      const detail = seg.label ? rdTargetLabel(seg) : '';   // sub-line only when a custom label hides the target
      row.className = 'rd-row' + (cur ? ' rd-cur' : '');
      row.innerHTML = `<span class="rd-row-num">${i + 1}</span>`
        + `<span class="rd-row-badge" style="color:${bdg.color};background:${bdg.bg};">${RD_TYPE_LABEL[seg.type] || seg.type}</span>`
        + (cur ? '<span class="rd-row-live">LIVE</span>' : '')
        + `<span class="rd-row-body"><span class="rd-row-label">${poEsc(seg.label || rdTargetLabel(seg))}</span>${detail ? `<span class="rd-row-sub">${poEsc(detail)}</span>` : ''}</span>`
        + (seg.hold ? `<span class="rd-row-hold">auto ${seg.hold}s</span>` : '')
        + '<span class="rd-row-acts"></span>';
    }
    const acts = row.querySelector('.rd-row-acts');
    const mkAct = (txt, title, cls, onClick, disabled) => { const bt = document.createElement('button'); bt.className = 'rd-act' + (cls ? ' ' + cls : ''); bt.textContent = txt; bt.title = title; if (disabled) bt.disabled = true; bt.addEventListener('click', onClick); return bt; };
    if (!isSection) acts.appendChild(mkAct('▶', 'Run this segment now', 'rd-act-go', () => { _rdRunning = true; _rdIdx = i; rdRunCurrent(); }));
    acts.appendChild(mkAct('✎', 'Edit this segment', '', () => { _rdEditIdx = i; renderRundown(); const inp = el('rd-list')?.querySelector('.rde-label'); if (inp) inp.focus(); }));
    acts.appendChild(mkAct('↑', 'Move up', '', () => { [_rdSegs[i - 1], _rdSegs[i]] = [_rdSegs[i], _rdSegs[i - 1]]; _rdEditIdx = -1; rdSave(); renderRundown(); }, i === 0));
    acts.appendChild(mkAct('↓', 'Move down', '', () => { [_rdSegs[i + 1], _rdSegs[i]] = [_rdSegs[i], _rdSegs[i + 1]]; _rdEditIdx = -1; rdSave(); renderRundown(); }, i === _rdSegs.length - 1));
    acts.appendChild(mkAct('✕', 'Remove segment', 'rd-act-del', () => { _rdSegs.splice(i, 1); if (_rdEditIdx === i) _rdEditIdx = -1; rdSave(); renderRundown(); }));
    list.appendChild(row);
  });
  if (typeof renderQros === 'function') renderQros();   // keep the rail Run-of-Show panel in sync
}
function rdRunSegment(seg) {
  if (!seg) return;
  // Clear a lingering countdown overlay when moving to a non-countdown segment.
  if (seg.type !== 'countdown' && currentState.breakScreen && currentState.breakScreen.visible) send('set_break', { visible: false });
  if (seg.type === 'scene') { if (seg.target) send('obs_switch_scene', { sceneName: seg.target }); }
  else if (seg.type === 'trigger') { const g = (typeof GOLIVE_TRIGGERS !== 'undefined' ? GOLIVE_TRIGGERS : []).find((t) => t.state === trigStateKey(seg.target)); if (g) send(g.msg, g.show()); }
  else if (seg.type === 'countdown') { send('set_break', { visible: true, seconds: Math.max(1, seg.hold || 60), title: (seg.label || 'STARTING SOON') }); }
  else if (seg.type === 'playout') { playMontageById(seg.target); }
  else if (seg.type === 'flow') { const f = rdFlows().find((x) => x.id === seg.target); if (f && typeof flowFire === 'function') flowFire(f); }
  else if (seg.type === 'view') { send(seg.target === 'scoreboard' ? 'force_scoreboard' : 'force_hud'); }
  // manual: nothing — just a hold point.
}
function rdRunCurrent() {
  clearTimeout(_rdTimer); _rdTimer = null;
  const seg = _rdSegs[_rdIdx];
  if (!seg) { rdStop(); return; }
  // Section headers are dividers, not segments — running lands on the next real segment.
  if (seg.type === 'section') {
    if (_rdIdx + 1 >= _rdSegs.length) { rdStop(); } else { _rdIdx++; rdRunCurrent(); }
    return;
  }
  rdRunSegment(seg);
  renderRundown();
  if (seg.hold > 0) _rdTimer = setTimeout(() => rdNext(), seg.hold * 1000);
}
function rdStart() { if (!_rdSegs.length) return; _rdRunning = true; _rdIdx = 0; rdRunCurrent(); }
function rdNext() {
  if (!_rdRunning) { rdStart(); return; }
  clearTimeout(_rdTimer); _rdTimer = null;
  if (_rdIdx + 1 >= _rdSegs.length) { rdStop(); return; }
  _rdIdx++; rdRunCurrent();
}
// Step back to the previous real segment (section headers are skipped backwards —
// rdRunCurrent only skips them forwards, which would bounce us to where we were).
function rdPrev() {
  if (!_rdRunning) return;
  clearTimeout(_rdTimer); _rdTimer = null;
  let i = _rdIdx - 1;
  while (i >= 0 && _rdSegs[i] && _rdSegs[i].type === 'section') i--;
  if (i < 0) return;
  _rdIdx = i; rdRunCurrent();
}
function rdStop() { _rdRunning = false; _rdIdx = -1; clearTimeout(_rdTimer); _rdTimer = null; renderRundown(); if (typeof renderQros === 'function') renderQros(); }

// ── Run of Show status → server (state.rundownStatus) ──────────────────────
// The runner lives in this panel; external controllers (Stream Deck plugin) can't
// see localStorage. Publish a tiny label snapshot whenever it changes so their keys
// can display current/next, and let them drive the runner via 'rundown_control'
// (relayed back to us by the server). Signature-deduped: renderRundown() calls this
// on every repaint and full_state must never echo into another publish.
let _rdStatusSig = '';
function rdPublishStatus() {
  const lbl = (i) => (i >= 0 && i < _rdSegs.length && _rdSegs[i]) ? (_rdSegs[i].label || rdTargetLabel(_rdSegs[i])) : '';
  const fwd = (from) => { let i = from; while (i < _rdSegs.length && _rdSegs[i] && _rdSegs[i].type === 'section') i++; return i < _rdSegs.length ? i : -1; };
  const back = (from) => { let i = from; while (i >= 0 && _rdSegs[i] && _rdSegs[i].type === 'section') i--; return i; };
  const real = (upTo) => _rdSegs.slice(0, upTo).filter((s) => s && s.type !== 'section').length;
  const st = {
    running: !!_rdRunning,
    pos: _rdRunning ? real(_rdIdx + 1) : 0,
    total: real(_rdSegs.length),
    current: _rdRunning ? lbl(_rdIdx) : '',
    next: lbl(_rdRunning ? fwd(_rdIdx + 1) : fwd(0)),
    prev: _rdRunning ? lbl(back(_rdIdx - 1)) : ''
  };
  const sig = JSON.stringify(st);
  if (sig === _rdStatusSig) return;
  _rdStatusSig = sig;
  send('set_rundown_status', st);
}
// First publish after boot, once the bridge socket has had time to open.
setTimeout(() => { try { rdPublishStatus(); } catch {} }, 2500);
el('rd-add-type')?.addEventListener('change', renderRdAddTarget);
el('rd-add-btn')?.addEventListener('click', () => {
  const type = el('rd-add-type')?.value || 'scene';
  const target = el('rd-add-target')?.value || '';
  const hold = Math.max(0, parseInt(el('rd-add-hold')?.value, 10) || 0);
  const label = (el('rd-add-label')?.value || '').trim();
  _rdSegs.push({ id: 'sg_' + Math.random().toString(36).slice(2, 8), type, target, hold, label });
  rdSave(); renderRundown();
  if (el('rd-add-label')) el('rd-add-label').value = '';
});
el('rd-start')?.addEventListener('click', rdStart);
el('rd-next')?.addEventListener('click', rdNext);
el('rd-stop')?.addEventListener('click', rdStop);

// ── Multiple rundowns: picker, manage, import/export ─────────────────────────
function renderRdPicker() {
  const sel = el('rd-picker'); if (!sel) return;
  sel.innerHTML = _rdStore.rundowns.map((r) =>
    `<option value="${poEsc(r.id)}"${r.id === _rdStore.activeId ? ' selected' : ''}>${poEsc(r.name || 'Untitled')} (${(r.segs || []).length})</option>`).join('');
}
function rdSwitchTo(id) {
  if (!_rdStore.rundowns.find((r) => r.id === id)) return;
  rdStop();                       // never leave a running rundown pointing at swapped-out segments
  _rdEditIdx = -1;                // an open inline editor is index-bound to the OLD rundown
  _rdStore.activeId = id;
  _rdSegs = rdActive().segs;
  rdSave(); renderRdPicker(); renderRundown();
}
el('rd-picker')?.addEventListener('change', function () { rdSwitchTo(this.value); });
el('rd-book-new')?.addEventListener('click', async () => {
  const name = await nePrompt('Name for the new rundown:', 'New Rundown'); if (!name) return;
  const r = { id: 'rd_' + Math.random().toString(36).slice(2, 8), name, segs: [] };
  _rdStore.rundowns.push(r); rdSwitchTo(r.id);
});
el('rd-book-rename')?.addEventListener('click', async () => {
  const r = rdActive();
  const name = await nePrompt('Rename rundown:', r.name); if (!name) return;
  r.name = name; rdSave(); renderRdPicker();
});
el('rd-book-dup')?.addEventListener('click', () => {
  const src = rdActive();
  const r = {
    id: 'rd_' + Math.random().toString(36).slice(2, 8), name: (src.name || 'Rundown') + ' (copy)',
    segs: (src.segs || []).map((s) => ({ ...s, id: 'sg_' + Math.random().toString(36).slice(2, 8) })),
  };
  _rdStore.rundowns.push(r); rdSwitchTo(r.id);
});
el('rd-book-delete')?.addEventListener('click', () => {
  const r = rdActive();
  if (!confirm('Delete rundown "' + (r.name || 'Untitled') + '" (' + (r.segs || []).length + ' segments)? This cannot be undone.')) return;
  _rdStore.rundowns = _rdStore.rundowns.filter((x) => x.id !== r.id);
  if (!_rdStore.rundowns.length) _rdStore.rundowns.push({ id: 'rd_' + Math.random().toString(36).slice(2, 8), name: 'Main Show', segs: [] });
  rdSwitchTo(_rdStore.rundowns[0].id);
});
// Export carries the flow definitions the rundown references, so it's portable to another
// producer's machine — import re-creates any of those flows that don't exist there yet.
el('rd-book-export')?.addEventListener('click', () => {
  const r = rdActive();
  const flowIds = [...new Set((r.segs || []).filter((s) => s.type === 'flow' && s.target).map((s) => s.target))];
  const payload = {
    format: 'ne-rundown', version: 1, name: r.name || 'Rundown',
    segs: r.segs || [], flows: rdFlows().filter((f) => flowIds.includes(f.id)),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (payload.name).replace(/[^a-z0-9_-]/gi, '_') + '.rundown.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
el('rd-book-import')?.addEventListener('click', () => el('rd-import-file')?.click());
el('rd-import-file')?.addEventListener('change', function () {
  const file = this.files && this.files[0]; this.value = '';
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      const rawSegs = Array.isArray(d) ? d : (Array.isArray(d.segs) ? d.segs : null);
      if (!rawSegs) { alert('Not a rundown file — expected { name, segs[] } or a plain segment array.'); return; }
      const segs = rawSegs.filter((s) => s && typeof s === 'object' && s.type).map((s) => ({
        id: 'sg_' + Math.random().toString(36).slice(2, 8),
        type: String(s.type), target: String(s.target || ''),
        hold: Math.max(0, parseInt(s.hold, 10) || 0), label: String(s.label || ''),
      }));
      const have = new Set(rdFlows().map((f) => f.id));
      let flowsAdded = 0;
      (Array.isArray(d.flows) ? d.flows : []).forEach((f) => {
        if (f && f.id && f.name && Array.isArray(f.actions) && !have.has(f.id)) { send('save_flow', f); flowsAdded++; }
      });
      const name = String((d && d.name) || file.name.replace(/\.rundown\.json$|\.json$/i, '')) || 'Imported rundown';
      const r = { id: 'rd_' + Math.random().toString(36).slice(2, 8), name, segs };
      _rdStore.rundowns.push(r); rdSwitchTo(r.id);
      if (typeof showToast === 'function') showToast('Imported "' + name + '" — ' + segs.length + ' segments' + (flowsAdded ? ', ' + flowsAdded + ' flows' : ''), '#48bb78', 2600);
    } catch (e) { alert('Could not read that file: ' + e.message); }
  };
  fr.readAsText(file);
});

renderRdPicker();
renderRdAddTarget();
// Deferred: renderRundown() calls renderQros(), which reads RD_BADGE — a const declared ~1600
// lines further down. Calling it eagerly here (before that line has run) throws a TDZ
// ReferenceError that's UNCAUGHT (not inside any try/catch), which halts the rest of this
// script's top-level execution — including the _wsToken declaration and the connect() call at
// the very bottom, so the WebSocket never even opens and the Discord gate spins forever.
// setTimeout(0) defers this first paint until after the whole script has finished running.
setTimeout(renderRundown, 0);

// ── Flows: server-backed if-this-then-that automation ──────────────────────
// _flows is declared above. All persistence goes through the server (save_flow /
// delete_flow / toggle_flow WS messages). The client renders and edits; the server
// executes triggers + actions so they fire even when no browser is connected.

let _flowDraft = null;

// ── Trigger catalogue ───────────────────────────────────────────────────────
const FLOW_TRIGGER_GROUPS = [
  { label: 'Rocket League', items: [
    ['rl_goal',             'Goal scored'],
    ['rl_round_started',    'Round starts (kickoff)'],
    ['rl_match_ended',      'Match ended'],
    ['rl_overtime',         'Overtime starts'],
    ['rl_replay_start',     'Replay starts'],
    ['rl_replay_will_end',  'Replay will end (transition back)'],
    ['rl_replay_end',       'Replay ends'],
    ['rl_match_created',    'New match created'],
    ['rl_demo',             'Player demolishes'],
    ['rl_save',             'Player saves'],
  ]},
  { label: 'CS2', items: [
    ['cs2_round_start',       'Round starts'],
    ['cs2_round_end',         'Round ends'],
    ['cs2_bomb_planted',      'Bomb planted'],
    ['cs2_bomb_defused',      'Bomb defused'],
    ['cs2_bomb_exploded',     'Bomb explodes'],
    ['cs2_half_time',         'Halftime'],
    ['cs2_match_ended',       'Match ended'],
    ['cs2_kill',              'Player gets a kill'],
    ['cs2_headshot_kill',     'Player gets a headshot kill'],
    ['cs2_ace',               'Player gets an ace (5 kills)'],
    ['cs2_clutch_situation',  'Clutch situation (1vX)'],
  ]},
  { label: 'Overwatch', items: [
    ['ow_match_start',      'Match starts'],
    ['ow_round_start',      'Round starts'],
    ['ow_round_end',        'Round ends'],
    ['ow_match_end',        'Match ended'],
  ]},
  { label: 'Marvel Rivals', items: [
    ['mr_match_start',      'Match starts'],
    ['mr_round_start',      'Round starts'],
    ['mr_round_end',        'Round ends'],
    ['mr_match_end',        'Match ended'],
  ]},
  { label: 'Match / Series', items: [
    ['score_reached',       'Score reaches…'],
    ['series_ended',        'Series ends'],
    ['game_started',        'Game starts'],
  ]},
  { label: 'OBS', items: [
    ['obs_scene_changed',     'Scene changes to…'],
    ['obs_scene_dwell',       'On scene for N seconds…'],
    ['obs_stream_started',    'Stream goes live'],
    ['obs_stream_stopped',    'Stream ends'],
    ['obs_recording_started', 'Recording starts'],
    ['obs_recording_stopped', 'Recording stops'],
    ['obs_replay_saved',      'Replay buffer saved'],
    ['obs_source_shown',      'Source becomes visible'],
    ['obs_source_hidden',     'Source becomes hidden'],
    ['obs_input_muted',       'Audio input muted'],
    ['obs_input_unmuted',     'Audio input unmuted'],
    ['obs_media_started',     'Media source starts playing'],
    ['obs_media_ended',       'Media source finishes playing'],
  ]},
  { label: 'Twitch', items: [
    ['twitch_stream_online',   'Channel goes online'],
    ['twitch_stream_offline',  'Channel goes offline'],
    ['twitch_raid',            'Raid received'],
    ['twitch_sub',             'New subscriber'],
    ['twitch_bits',            'Bits cheer'],
    ['twitch_follow',          'New follower'],
    ['twitch_channel_points',  'Channel points redeemed'],
    ['twitch_hype_train',      'Hype Train starts'],
    ['twitch_poll_end',        'Poll ends'],
    ['twitch_ad_break',        'Ad break starts'],
    ['twitch_chat_command',    'Chat command (!command)'],
  ]},
  { label: 'In-App / Timer', items: [
    ['timer_countdown_end', 'Countdown timer ends'],
    ['break_shown',         'Break screen shown'],
    ['break_hidden',        'Break screen hidden'],
  ]},
  { label: 'Scheduled', items: [
    ['timer_interval',  'Every N seconds (interval)'],
    ['time_of_day',     'At a specific time (daily)'],
    ['cron_schedule',   'Cron schedule (advanced)'],
  ]},
  { label: 'System', items: [
    ['process_started',      'A program starts running'],
    ['process_stopped',      'A program stops running'],
    ['system_became_idle',   'No producer input for N minutes'],
    ['system_became_active', 'Producer input resumes'],
    ['window_focused',       'A window becomes focused'],
    ['window_unfocused',     'A window loses focus'],
  ]},
  { label: 'Manual', items: [
    ['manual', 'Manual / button'],
  ]},
];

function _flowTrigOptGroups(selected) {
  return FLOW_TRIGGER_GROUPS.map(g =>
    `<optgroup label="${g.label}">${g.items.map(([v,l]) =>
      `<option value="${v}"${selected===v?' selected':''}>${l}</option>`
    ).join('')}</optgroup>`
  ).join('');
}

const FLOW_TRIG_LABEL = Object.fromEntries(
  FLOW_TRIGGER_GROUPS.flatMap(g => g.items)
);

// Params UI for each trigger type
function flowTriggerParamsHtml(trig) {
  const p = trig.params || {};
  switch (trig.type) {
    case 'rl_goal':
      return `<select class="ft-param input-select" data-k="team" style="width:110px;">
        <option value="any"${(!p.team||p.team==='any')?' selected':''}>Either team</option>
        <option value="blue"${p.team==='blue'?' selected':''}>Blue team</option>
        <option value="orange"${p.team==='orange'?' selected':''}>Orange team</option>
      </select>`;
    case 'cs2_round_end':
      return `<select class="ft-param input-select" data-k="winner" style="width:100px;"><option value="any"${(!p.winner||p.winner==='any')?' selected':''}>Either</option><option value="CT"${p.winner==='CT'?' selected':''}>CT</option><option value="T"${p.winner==='T'?' selected':''}>T</option></select>`;
    case 'rl_demo':
    case 'rl_save':
      return `<select class="ft-param input-select" data-k="team" style="width:110px;">
        <option value="any"${(!p.team||p.team==='any')?' selected':''}>Either team</option>
        <option value="blue"${p.team==='blue'?' selected':''}>Blue team</option>
        <option value="orange"${p.team==='orange'?' selected':''}>Orange team</option>
      </select>`;
    case 'cs2_kill':
    case 'cs2_headshot_kill':
    case 'cs2_ace':
      return `<select class="ft-param input-select" data-k="team" style="width:100px;"><option value="any"${(!p.team||p.team==='any')?' selected':''}>Either side</option><option value="CT"${p.team==='CT'?' selected':''}>CT</option><option value="T"${p.team==='T'?' selected':''}>T</option></select>`;
    case 'process_started':
    case 'process_stopped':
      return `<input type="text" class="ft-param input-text" data-k="processName" placeholder="e.g. RocketLeague.exe" value="${poEsc(p.processName||'')}" style="width:180px;" title="Checked roughly every 3 seconds — not instant">`;
    case 'system_became_idle':
      return `<input type="number" class="ft-param input-text" data-k="minutes" min="1" max="600" value="${p.minutes||5}" style="width:64px;"> <span style="font-size:11px;color:var(--muted);">minutes with no mouse/keyboard input</span>`;
    case 'window_focused':
    case 'window_unfocused':
      return `<input type="text" class="ft-param input-text" data-k="titleContains" placeholder="e.g. OBS Studio" value="${poEsc(p.titleContains||'')}" style="width:180px;" title="Checked roughly every 5 seconds — not instant"> <span style="font-size:11px;color:var(--muted);">window title contains…</span>`;
    case 'obs_scene_changed':
      return (() => { const scenes=(currentState.obs&&currentState.obs.availableScenes)||[]; return `<select class="ft-param input-select" data-k="scene" style="width:160px;"><option value="">Any scene</option>${scenes.map(s=>`<option value="${poEsc(s)}"${p.scene===s?' selected':''}>${poEsc(s)}</option>`).join('')}</select>`; })();
    case 'obs_scene_dwell':
      return (() => { const scenes=(currentState.obs&&currentState.obs.availableScenes)||[]; return `<select class="ft-param input-select" data-k="scene" style="width:150px;" title="Which scene to watch (any = whatever's on program)"><option value="">Any scene</option>${scenes.map(s=>`<option value="${poEsc(s)}"${p.scene===s?' selected':''}>${poEsc(s)}</option>`).join('')}</select>
        <input type="number" class="ft-param input-text" data-k="seconds" min="1" max="7200" value="${p.seconds||30}" style="width:64px;" title="Fire after the scene has been on program this long (a scene change before then cancels it)"> <span style="font-size:11px;color:var(--muted);">sec on scene</span>`; })();
    case 'obs_source_shown':
    case 'obs_source_hidden':
      return `<input type="text" class="ft-param input-text" data-k="sourceName" placeholder="source name (blank=any)" value="${poEsc(p.sourceName||'')}" style="width:180px;">`;
    case 'obs_input_muted':
    case 'obs_input_unmuted':
    case 'obs_media_started':
    case 'obs_media_ended':
      return `<input type="text" class="ft-param input-text" data-k="inputName" placeholder="input name (blank=any)" value="${poEsc(p.inputName||'')}" style="width:180px;">`;
    case 'score_reached':
      return `<select class="ft-param input-select" data-k="team" style="width:100px;"><option value="blue"${p.team==='blue'?' selected':''}>Blue</option><option value="orange"${p.team==='orange'?' selected':''}>Orange</option></select>
        <input type="number" class="ft-param input-text" data-k="value" min="0" max="99" value="${p.value||1}" style="width:54px;" placeholder="score">`;
    case 'series_ended':
      return `<select class="ft-param input-select" data-k="winner" style="width:110px;"><option value="any"${(!p.winner||p.winner==='any')?' selected':''}>Either</option><option value="blue"${p.winner==='blue'?' selected':''}>Blue</option><option value="orange"${p.winner==='orange'?' selected':''}>Orange</option></select>`;
    case 'twitch_raid':
      return `<input type="number" class="ft-param input-text" data-k="minViewers" min="0" value="${p.minViewers||''}" placeholder="min viewers (0=any)" style="width:150px;">`;
    case 'twitch_sub':
      return `<select class="ft-param input-select" data-k="tier" style="width:110px;"><option value="any"${(!p.tier||p.tier==='any')?' selected':''}>Any tier</option><option value="1000"${p.tier==='1000'?' selected':''}>Tier 1</option><option value="2000"${p.tier==='2000'?' selected':''}>Tier 2</option><option value="3000"${p.tier==='3000'?' selected':''}>Tier 3</option></select>`;
    case 'twitch_bits':
      return `<input type="number" class="ft-param input-text" data-k="minBits" min="1" value="${p.minBits||''}" placeholder="min bits (blank=any)" style="width:150px;">`;
    case 'twitch_channel_points':
      return `<input type="text" class="ft-param input-text" data-k="rewardTitle" placeholder="reward title (blank=any)" value="${poEsc(p.rewardTitle||'')}" style="width:170px;">`;
    case 'timer_interval':
      return `<input type="number" class="ft-param input-text" data-k="seconds" min="1" value="${p.seconds||60}" style="width:72px;"> <span style="font-size:11px;color:var(--muted);">seconds</span>`;
    case 'time_of_day':
      return `<input type="time" class="ft-param input-text" data-k="time" value="${poEsc(p.time||'20:00')}" style="width:110px;">`;
    case 'twitch_chat_command':
      return `<input type="text" class="ft-param input-text" data-k="command" placeholder="!command (blank = any)" value="${poEsc((p.command||'').replace(/^!/,''))}" style="width:200px;">`;
    case 'cron_schedule':
      return `<input type="text" class="ft-param input-text" data-k="expr" placeholder="min hr day mon wday  e.g. 0 20 * * 5" value="${poEsc(p.expr||'0 20 * * *')}" style="width:220px;" title="Standard 5-field cron: minute hour day-of-month month weekday&#10;Examples:&#10;0 20 * * 5  = Fridays at 8pm&#10;30 19 * * 1,3,5 = Mon/Wed/Fri at 7:30pm&#10;0 * * * *  = every hour">`;
    default:
      return '';
  }
}

// On-demand punch-up graphics a Flow can push live — the exclusive set gfx.html single-selects
// (mirrors server.js's GFX_EXCLUSIVE_VISIBLE key set, plus 'matchup' which has no .visible flag
// of its own). 'break'/'winner' are deliberately left out here — overlay_break_show/
// overlay_countdown_start and overlay_winner already cover those with richer, purpose-built params.
const FLOW_GFX_KEYS = [
  ['intro',     'Line-up / Intro'],
  ['matchup',   'Matchup'],
  ['veto',      'Map Veto'],
  ['draft',     'Draft / Pick-Ban'],
  ['bracket',   'Bracket'],
  ['schedule',  'Schedule / Upcoming'],
  ['standings', 'Standings'],
  ['credits',   'Stream Credits'],
];
const FLOW_GFX_LABEL = Object.fromEntries(FLOW_GFX_KEYS);

// ── Action catalogue ────────────────────────────────────────────────────────
const FLOW_ACTION_GROUPS = [
  { label: 'OBS', items: [
    ['obs_scene',           'Cut to scene'],
    ['obs_scene_previous',  'Cut back to previous scene'],
    ['obs_set_transition',  'Set scene transition'],
    ['obs_start_stream',    'Start stream'],
    ['obs_stop_stream',     'Stop stream'],
    ['obs_start_record',    'Start recording'],
    ['obs_stop_record',     'Stop recording'],
    ['obs_save_replay',     'Save replay buffer'],
    ['obs_start_replay_buf','Start replay buffer'],
    ['obs_stop_replay_buf', 'Stop replay buffer'],
    ['obs_stream_marker',   'Create stream marker'],
    ['obs_source_show',     'Show source in scene'],
    ['obs_source_hide',     'Hide source in scene'],
    ['obs_input_mute',      'Mute audio input'],
    ['obs_input_unmute',    'Unmute audio input'],
    ['obs_set_volume',      'Set audio input volume (dB)'],
    ['obs_filter_enable',   'Enable source filter'],
    ['obs_filter_disable',  'Disable source filter'],
  ]},
  { label: 'vMix', items: [
    ['vmix_cut',            'Cut / transition to input'],
    ['vmix_overlay',        'Overlay channel In / Out'],
    ['vmix_fade_to_black',  'Fade to black'],
    ['vmix_start_stream',   'Start streaming'],
    ['vmix_stop_stream',    'Stop streaming'],
    ['vmix_start_record',   'Start recording'],
    ['vmix_stop_record',    'Stop recording'],
    ['vmix_replay_last',    'Play last replay'],
    ['vmix_set_text',       'Set title text'],
    ['vmix_function',       'Run vMix function (advanced)'],
  ]},
  { label: 'Twitch', items: [
    ['twitch_prediction_create',  'Create prediction'],
    ['twitch_prediction_lock',    'Lock prediction'],
    ['twitch_prediction_resolve', 'Resolve prediction (by outcome #)'],
    ['twitch_prediction_cancel',  'Cancel prediction'],
    ['twitch_announcement',       'Post chat announcement'],
    ['twitch_send_chat',          'Send chat message'],
    ['twitch_clip',               'Create clip'],
    ['twitch_channel_title',      'Update channel title'],
    ['twitch_create_poll',        'Create poll'],
    ['twitch_shoutout',           'Give shoutout'],
  ]},
  { label: 'Overlays', items: [
    ['overlay_countdown_start','Start countdown timer'],
    ['overlay_break_show',   'Show break screen'],
    ['overlay_break_hide',   'Hide break screen'],
    ['set_event_title',      'Set event title'],
    ['set_round_label',      'Set round / stage label'],
    ['set_match_label',      'Set match label'],
    ['overlay_lower_third',  'Lower third (auto-hide)'],
    ['overlay_ticker',       'Set ticker text'],
    ['overlay_ticker_hide',  'Hide ticker'],
    ['overlay_casters_show', 'Show casters overlay'],
    ['overlay_casters_hide', 'Hide casters overlay'],
    ['overlay_winner',       'Show winner graphic'],
    ['overlay_winner_hide',  'Hide winner graphic'],
    ['overlay_sponsor_show', 'Show sponsor banner'],
    ['overlay_sponsor_hide', 'Hide sponsor banner'],
    ['gfx_trigger',          'Push graphic live…'],
    ['gfx_hide',             'Hide on-air graphic'],
    ['overlay_reload',       'Reload all overlays'],
  ]},
  { label: 'Match / Series', items: [
    ['match_advance_game',     'Advance game number'],
    ['match_set_score',        'Set in-game score'],
    ['match_set_series_score', 'Set series score'],
    ['match_reset_series',     'Reset series'],
  ]},
  { label: 'OBS Media', items: [
    ['obs_playback_start', 'Play media source (restart)'],
    ['obs_playback_stop',  'Stop media source'],
    ['obs_playback_pause', 'Pause media source'],
  ]},
  { label: 'Variables', items: [
    ['set_variable',       'Set variable'],
    ['increment_variable', 'Increment variable'],
    ['cycle_variable',     'Cycle variable through list'],
    ['reset_variable',     'Reset / clear variable'],
  ]},
  { label: 'Generic', items: [
    ['wait',                 'Wait (delay)'],
    ['run_flow',             'Run another flow'],
    ['random_choice',        'Random choice (run random flow)'],
    ['stop_flow',            'Stop flow (abort remaining)'],
    ['http_webhook',         'HTTP webhook (POST)'],
    ['send_discord_webhook', 'Discord webhook (embed)'],
  ]},
];

function _flowActOptGroups(selected) {
  return FLOW_ACTION_GROUPS.map(g =>
    `<optgroup label="${g.label}">${g.items.map(([v,l]) =>
      `<option value="${v}"${selected===v?' selected':''}>${l}</option>`
    ).join('')}</optgroup>`
  ).join('');
}
function flowTriggerSummary(f) {
  const triggers = f.triggers || (f.trigger ? [f.trigger] : []);
  if (!triggers.length) return 'No trigger';
  const mode = f.triggerMode === 'sequence' ? ' → ' : ' OR ';
  return triggers.map(t => FLOW_TRIG_LABEL[t.type] || t.type).join(mode);
}

function flowActionLabel(a) {
  const p = a.params || {};
  const allActions = Object.fromEntries(FLOW_ACTION_GROUPS.flatMap(g => g.items));
  switch (a.type) {
    case 'wait': return 'Wait ' + (p.ms || 0) + 'ms';
    case 'obs_scene': return 'Cut → ' + (p.scene || '?');
    case 'obs_stream_marker': return 'Stream marker' + (p.description ? ': ' + p.description : '');
    case 'overlay_lower_third': return 'Lower third: "' + (p.text || '').slice(0, 24) + '"';
    case 'overlay_ticker': return 'Ticker: "' + (p.text || '').slice(0, 24) + '"';
    case 'overlay_countdown_start': return 'Countdown ' + (p.seconds || 300) + 's' + (p.title ? ' · ' + p.title.slice(0, 16) : '') + (p.thenScene ? ' → ' + p.thenScene : '');
    case 'set_event_title': return 'Event title: "' + (p.title || '').slice(0, 26) + '"';
    case 'set_round_label': return p.text ? ('Round: "' + p.text.slice(0, 24) + '"') : 'Clear round label';
    case 'set_match_label': return p.text ? ('Match label: "' + p.text.slice(0, 22) + '"') : 'Auto match label';
    case 'overlay_winner': return 'Winner: ' + (p.side === 'blue' ? 'Blue' : p.side === 'orange' ? 'Orange' : 'series winner');
    case 'gfx_trigger': return 'Push graphic: ' + (FLOW_GFX_LABEL[p.key] || p.key || '?');
    case 'gfx_hide': return 'Hide on-air graphic';
    case 'match_set_series_score': return `Series: Blue ${p.blue ?? '?'} – Orange ${p.orange ?? '?'}`;
    case 'twitch_prediction_create': return 'Create prediction: "' + (p.title || 'Who wins?').slice(0, 20) + '"';
    case 'twitch_prediction_resolve': return 'Resolve → outcome #' + ((p.outcomeIndex || 0) + 1);
    case 'twitch_announcement': return 'Announce: "' + (p.message || '').slice(0, 28) + '"';
    case 'twitch_channel_title': return 'Title: "' + (p.title || '').slice(0, 28) + '"';
    case 'twitch_create_poll': return 'Poll: "' + (p.title || '').slice(0, 24) + '"';
    case 'twitch_shoutout': return 'Shoutout: ' + (p.toLogin || '?');
    case 'http_webhook': return 'Webhook → ' + (p.url || '?').slice(0, 30);
    case 'obs_source_show': return 'Show "' + (p.source || '?') + '" in ' + (p.scene || '?');
    case 'obs_source_hide': return 'Hide "' + (p.source || '?') + '" in ' + (p.scene || '?');
    case 'obs_input_mute': return 'Mute: ' + (p.inputName || '?');
    case 'obs_input_unmute': return 'Unmute: ' + (p.inputName || '?');
    case 'obs_set_volume': return (p.inputName || '?') + ' → ' + (p.volumeDb != null ? p.volumeDb : -6) + ' dB';
    case 'obs_filter_enable': return 'Filter on: "' + (p.filterName || '?') + '" on ' + (p.sourceName || '?');
    case 'obs_filter_disable': return 'Filter off: "' + (p.filterName || '?') + '" on ' + (p.sourceName || '?');
    case 'obs_set_transition': return 'Transition: ' + (p.transitionName || '?') + (p.durationMs ? ' ' + p.durationMs + 'ms' : '');
    case 'match_set_score': return 'Set ' + (p.team || '?') + ' score → ' + (p.value ?? '?');
    case 'run_flow': { const tf = (_flows||[]).find(f=>f.id===p.flowId); return 'Run flow: ' + (tf ? tf.name : (p.flowId || '?')); }
    case 'set_variable':        return '{{' + (p.name||'?') + '}} = "' + (p.value||'').slice(0,20) + '"';
    case 'increment_variable':  return (p.name||'?') + ' += ' + (p.amount!=null?p.amount:1);
    case 'cycle_variable':      return 'Cycle {{' + (p.name||'?') + '}}';
    case 'reset_variable':      return 'Reset {{' + (p.name || 'all') + '}}';
    case 'stop_flow':           return 'Stop flow';
    case 'send_discord_webhook':return 'Discord: "' + (p.title||p.message||'').slice(0,24) + '"';
    case 'twitch_send_chat':    return 'Chat: "' + (p.message||'').slice(0,28) + '"';
    case 'random_choice':       return 'Random: ' + ((p.flowIds||'').split(',').filter(Boolean).length) + ' choices';
    case 'obs_playback_start':  return 'Play: "' + (p.inputName||'?') + '"';
    case 'obs_playback_stop':   return 'Stop: "' + (p.inputName||'?') + '"';
    case 'obs_playback_pause':  return 'Pause: "' + (p.inputName||'?') + '"';
    case 'vmix_cut':            return 'vMix: ' + (p.transition||'Cut') + ' → ' + (p.input||'?');
    case 'vmix_overlay':        return 'vMix Overlay ' + (p.channel||1) + ' ' + (p.action||'In');
    case 'vmix_fade_to_black':  return 'vMix: Fade to black';
    case 'vmix_start_stream':   return 'vMix: Start stream' + (p.value!==''&&p.value!=null?' ('+p.value+')':'');
    case 'vmix_stop_stream':    return 'vMix: Stop stream';
    case 'vmix_start_record':   return 'vMix: Start recording';
    case 'vmix_stop_record':    return 'vMix: Stop recording';
    case 'vmix_replay_last':    return 'vMix: Play last replay';
    case 'vmix_set_text':       return 'vMix text: ' + (p.selectedName||'?') + ' = "' + (p.value||'').slice(0,16) + '"';
    case 'vmix_function':       return 'vMix: ' + (p.function||'?') + (p.input?' ('+p.input+')':'');
    default: return allActions[a.type] || a.type;
  }
}

// Params UI for each action type
function flowActionParamsHtml(a) {
  const p = a.params || {};
  const scenes = (currentState.obs && currentState.obs.availableScenes) || [];
  switch (a.type) {
    case 'wait':
      return `<input type="number" class="fa-param input-text" data-k="ms" min="0" value="${p.ms||1000}" style="width:80px;"> <span style="font-size:11px;color:var(--muted);">ms</span>`;
    case 'obs_scene':
      return `<select class="fa-param input-select" data-k="scene" style="width:170px;">${scenes.length ? '<option value="">— pick a scene —</option>'+scenes.map(s=>`<option value="${poEsc(s)}"${p.scene===s?' selected':''}>${poEsc(s)}</option>`).join('') : '<option value="">(OBS offline — reopen once connected)</option>'}</select>`;
    case 'vmix_cut': {
      const trans = ['Cut','Fade','Merge','Wipe','Slide','Fly','CrossZoom','Cube','CubeZoom','Stinger1','Stinger2','Stinger3','Stinger4'];
      return `<input type="text" class="fa-param input-text" data-k="input" placeholder="input # / name / GUID" value="${poEsc(p.input||'')}" style="width:150px;">
        <select class="fa-param input-select" data-k="transition" style="width:110px;">${trans.map(t=>`<option value="${t}"${(p.transition||'Cut')===t?' selected':''}>${t}</option>`).join('')}</select>
        <input type="number" class="fa-param input-text" data-k="duration" min="0" placeholder="ms" value="${p.duration||''}" style="width:64px;" title="Transition duration in ms (blank = default)">`;
    }
    case 'vmix_overlay':
      return `<span style="font-size:11px;color:var(--muted);">Ch</span> <select class="fa-param input-select" data-k="channel" style="width:56px;">${[1,2,3,4].map(n=>`<option value="${n}"${String(p.channel||1)==String(n)?' selected':''}>${n}</option>`).join('')}</select>
        <select class="fa-param input-select" data-k="action" style="width:90px;">${['In','Out','Off','toggle'].map(a=>`<option value="${a}"${(p.action||'In')===a?' selected':''}>${a}</option>`).join('')}</select>
        <input type="text" class="fa-param input-text" data-k="input" placeholder="input (optional)" value="${poEsc(p.input||'')}" style="width:130px;">`;
    case 'vmix_start_stream':
    case 'vmix_stop_stream':
      return `<input type="text" class="fa-param input-text" data-k="value" placeholder="destination # (blank = all)" value="${poEsc(p.value||'')}" style="width:150px;" title="0-4 for a specific streaming destination, blank for all">`;
    case 'vmix_set_text':
      return `<input type="text" class="fa-param input-text" data-k="input" placeholder="title input # / name" value="${poEsc(p.input||'')}" style="width:130px;">
        <input type="text" class="fa-param input-text" data-k="selectedName" placeholder="field e.g. Headline.Text" value="${poEsc(p.selectedName||'')}" style="width:150px;">
        <input type="text" class="fa-param input-text" data-k="value" placeholder="text" value="${poEsc(p.value||'')}" style="width:150px;">`;
    case 'vmix_function':
      return `<input type="text" class="fa-param input-text" data-k="function" placeholder="Function name" value="${poEsc(p.function||'')}" style="width:150px;">
        <input type="text" class="fa-param input-text" data-k="input" placeholder="Input (opt)" value="${poEsc(p.input||'')}" style="width:110px;">
        <input type="text" class="fa-param input-text" data-k="value" placeholder="Value (opt)" value="${poEsc(p.value||'')}" style="width:110px;">
        <input type="number" class="fa-param input-text" data-k="duration" min="0" placeholder="ms" value="${p.duration||''}" style="width:60px;">`;
    case 'obs_stream_marker':
      return `<input type="text" class="fa-param input-text" data-k="description" placeholder="marker description" value="${poEsc(p.description||'')}" style="width:180px;">`;
    case 'overlay_lower_third':
      return `<input type="text" class="fa-param input-text" data-k="text" placeholder="text" value="${poEsc(p.text||'')}" style="width:150px;"> <input type="number" class="fa-param input-text" data-k="duration" min="0" value="${p.duration||5000}" style="width:70px;" title="auto-hide after ms"> <span style="font-size:11px;color:var(--muted);">ms</span>`;
    case 'overlay_ticker':
      return `<input type="text" class="fa-param input-text" data-k="text" placeholder="text" value="${poEsc(p.text||'')}" style="width:200px;">`;
    case 'overlay_countdown_start':
      return `<input type="number" class="fa-param input-text" data-k="seconds" min="0" value="${p.seconds||300}" style="width:64px;" title="Countdown length in seconds"> <span style="font-size:11px;color:var(--muted);">sec</span>
        <input type="text" class="fa-param input-text" data-k="title" placeholder="STARTING SOON" value="${poEsc(p.title||'')}" style="width:140px;">
        <select class="fa-param input-select" data-k="thenScene" title="OBS scene to cut to when it hits 0 (optional)" style="width:150px;"><option value="">— stay on break —</option>${scenes.map(s=>`<option value="${poEsc(s)}"${p.thenScene===s?' selected':''}>${poEsc(s)}</option>`).join('')}</select>`;
    case 'set_event_title':
      return `<input type="text" class="fa-param input-text" data-k="title" placeholder="Event title" value="${poEsc(p.title||'')}" style="width:250px;">`;
    case 'set_round_label':
      return `<input type="text" class="fa-param input-text" data-k="text" placeholder="e.g. WINNERS FINALS (blank = hide)" value="${poEsc(p.text||'')}" style="width:250px;">`;
    case 'set_match_label':
      return `<input type="text" class="fa-param input-text" data-k="text" placeholder="e.g. UPCOMING MATCH (blank = auto)" value="${poEsc(p.text||'')}" style="width:250px;">`;
    case 'overlay_winner':
      return `<select class="fa-param input-select" data-k="side" style="width:150px;" title="Auto uses the winner from the trigger (e.g. Series Ended) — pick a side to force it"><option value="auto"${(!p.side||p.side==='auto')?' selected':''}>Auto (series winner)</option><option value="blue"${p.side==='blue'?' selected':''}>Blue</option><option value="orange"${p.side==='orange'?' selected':''}>Orange</option></select>
        <input type="text" class="fa-param input-text" data-k="name" placeholder="name (auto if blank)" value="${poEsc(p.name||'')}" style="width:120px;">`;
    case 'gfx_trigger':
      return `<select class="fa-param input-select" data-k="key" style="width:170px;" title="Shows whatever content is already configured for this graphic — set it up on the Graphics tab first"><option value=""${!p.key?' selected':''}>— pick a graphic —</option>${FLOW_GFX_KEYS.map(([k,l])=>`<option value="${k}"${p.key===k?' selected':''}>${poEsc(l)}</option>`).join('')}</select>`;
    case 'twitch_prediction_create':
      return `<input type="text" class="fa-param input-text" data-k="title" placeholder="Who will win?" value="${poEsc(p.title||'')}" style="width:130px;">
        <input type="text" class="fa-param input-text" data-k="outcome1" placeholder="Option 1" value="${poEsc(p.outcome1||'')}" style="width:90px;">
        <input type="text" class="fa-param input-text" data-k="outcome2" placeholder="Option 2" value="${poEsc(p.outcome2||'')}" style="width:90px;">
        <input type="number" class="fa-param input-text" data-k="duration" min="30" max="1800" value="${p.duration||120}" style="width:56px;" title="seconds"> <span style="font-size:11px;color:var(--muted);">s</span>`;
    case 'twitch_prediction_resolve':
      return `<select class="fa-param input-select" data-k="outcomeIndex" style="width:150px;"><option value="0"${(p.outcomeIndex||0)==0?' selected':''}>Outcome 1 wins</option><option value="1"${p.outcomeIndex==1?' selected':''}>Outcome 2 wins</option></select>`;
    case 'twitch_announcement':
      return `<input type="text" class="fa-param input-text" data-k="message" placeholder="message" value="${poEsc(p.message||'')}" style="width:160px;">
        <select class="fa-param input-select" data-k="color" style="width:86px;"><option value="PRIMARY"${(!p.color||p.color==='PRIMARY')?' selected':''}>Default</option><option value="blue"${p.color==='blue'?' selected':''}>Blue</option><option value="green"${p.color==='green'?' selected':''}>Green</option><option value="orange"${p.color==='orange'?' selected':''}>Orange</option><option value="purple"${p.color==='purple'?' selected':''}>Purple</option></select>`;
    case 'twitch_channel_title':
      return `<input type="text" class="fa-param input-text" data-k="title" placeholder="new stream title" value="${poEsc(p.title||'')}" style="width:220px;">`;
    case 'twitch_create_poll':
      return `<input type="text" class="fa-param input-text" data-k="title" placeholder="Poll question" value="${poEsc(p.title||'')}" style="width:130px;">
        <input type="text" class="fa-param input-text" data-k="choice1" placeholder="Choice 1" value="${poEsc(p.choice1||'')}" style="width:80px;">
        <input type="text" class="fa-param input-text" data-k="choice2" placeholder="Choice 2" value="${poEsc(p.choice2||'')}" style="width:80px;">
        <input type="number" class="fa-param input-text" data-k="duration" min="15" max="1800" value="${p.duration||60}" style="width:52px;" title="seconds"> <span style="font-size:11px;color:var(--muted);">s</span>`;
    case 'twitch_shoutout':
      return `<input type="text" class="fa-param input-text" data-k="toLogin" placeholder="channel login" value="${poEsc(p.toLogin||'')}" style="width:160px;">`;
    case 'match_set_series_score':
      return `<span style="font-size:11px;color:var(--muted);">Blue</span> <input type="number" class="fa-param input-text" data-k="blue" min="0" max="9" value="${p.blue??0}" style="width:44px;">
        <span style="font-size:11px;color:var(--muted);">Orange</span> <input type="number" class="fa-param input-text" data-k="orange" min="0" max="9" value="${p.orange??0}" style="width:44px;">`;
    case 'http_webhook':
      return `<input type="text" class="fa-param input-text" data-k="url" placeholder="https://..." value="${poEsc(p.url||'')}" style="width:200px;">`;
    case 'obs_source_show':
    case 'obs_source_hide': {
      const sceneOpts = scenes.map(s => `<option value="${poEsc(s)}"${p.scene===s?' selected':''}>${poEsc(s)}</option>`).join('');
      return `<select class="fa-param input-select" data-k="scene" style="width:140px;">${sceneOpts || '<option value="">(OBS offline)</option>'}</select>
        <input type="text" class="fa-param input-text" data-k="source" placeholder="source name" value="${poEsc(p.source||'')}" style="width:140px;">`;
    }
    case 'obs_input_mute':
    case 'obs_input_unmute':
      return `<input type="text" class="fa-param input-text" data-k="inputName" placeholder="input name" value="${poEsc(p.inputName||'')}" style="width:200px;">`;
    case 'obs_set_volume':
      return `<input type="text" class="fa-param input-text" data-k="inputName" placeholder="input name" value="${poEsc(p.inputName||'')}" style="width:140px;">
        <input type="number" class="fa-param input-text" data-k="volumeDb" min="-100" max="26" step="0.1" value="${p.volumeDb!=null?p.volumeDb:-6}" style="width:64px;" title="Volume in dB (-100 = silent, 0 = 100%, +26 = max boost)"> <span style="font-size:11px;color:var(--muted);">dB</span>`;
    case 'obs_filter_enable':
    case 'obs_filter_disable':
      return `<input type="text" class="fa-param input-text" data-k="sourceName" placeholder="source name" value="${poEsc(p.sourceName||'')}" style="width:130px;">
        <input type="text" class="fa-param input-text" data-k="filterName" placeholder="filter name" value="${poEsc(p.filterName||'')}" style="width:130px;">`;
    case 'obs_set_transition': {
      const trans = (currentState.obs && currentState.obs.availableTransitions) || [];
      const transOpts = trans.length
        ? trans.map(t => `<option value="${poEsc(t)}"${p.transitionName===t?' selected':''}>${poEsc(t)}</option>`).join('')
        : `<option value="${poEsc(p.transitionName||'')}">— type name —</option>`;
      return `<select class="fa-param input-select" data-k="transitionName" style="width:150px;">${transOpts}</select>
        <input type="number" class="fa-param input-text" data-k="durationMs" min="0" value="${p.durationMs??300}" style="width:66px;" title="Duration ms (0 = keep current)"> <span style="font-size:11px;color:var(--muted);">ms</span>`;
    }
    case 'match_set_score':
      return `<select class="fa-param input-select" data-k="team" style="width:90px;"><option value="blue"${p.team==='blue'?' selected':''}>Blue</option><option value="orange"${p.team==='orange'?' selected':''}>Orange</option></select>
        <input type="number" class="fa-param input-text" data-k="value" min="0" max="99" value="${p.value??0}" style="width:52px;" title="New score value">`;
    case 'run_flow': {
      const flows = _flows || [];
      const opts = flows.map(f => `<option value="${poEsc(f.id)}"${p.flowId===f.id?' selected':''}>${poEsc(f.name||f.id)}</option>`).join('');
      return `<select class="fa-param input-select" data-k="flowId" style="width:200px;"><option value="">— pick a flow —</option>${opts}</select>`;
    }
    case 'set_variable':
      return `<input type="text" class="fa-param input-text" data-k="name" placeholder="var_name" value="${poEsc(p.name||'')}" style="width:120px;">
        <span style="font-size:11px;color:var(--muted);">=</span>
        <input type="text" class="fa-param input-text" data-k="value" placeholder="value (supports {{tokens}})" value="${poEsc(p.value||'')}" style="width:170px;">`;
    case 'increment_variable':
      return `<input type="text" class="fa-param input-text" data-k="name" placeholder="var_name" value="${poEsc(p.name||'')}" style="width:120px;">
        <span style="font-size:11px;color:var(--muted);">+=</span>
        <input type="number" class="fa-param input-text" data-k="amount" value="${p.amount!=null?p.amount:1}" style="width:60px;" title="Amount to add (negative to subtract)">`;
    case 'cycle_variable':
      return `<input type="text" class="fa-param input-text" data-k="name" placeholder="var_name" value="${poEsc(p.name||'')}" style="width:110px;">
        <span style="font-size:11px;color:var(--muted);">list:</span>
        <input type="text" class="fa-param input-text" data-k="list" placeholder="a,b,c (comma-separated)" value="${poEsc(p.list||'')}" style="width:200px;" title="Each fire advances to the next item, wrapping around">`;
    case 'reset_variable':
      return `<input type="text" class="fa-param input-text" data-k="name" placeholder="var_name (blank = clear all)" value="${poEsc(p.name||'')}" style="width:220px;">`;
    case 'stop_flow':
      return `<span style="font-size:11px;color:var(--muted);">Stops executing remaining actions immediately.</span>`;
    case 'twitch_send_chat':
      return `<input type="text" class="fa-param input-text" data-k="message" placeholder="chat message (supports {{tokens}})" value="${poEsc(p.message||'')}" style="width:270px;">`;
    case 'send_discord_webhook':
      return `<input type="text" class="fa-param input-text" data-k="url" placeholder="Discord webhook URL" value="${poEsc(p.url||'')}" style="width:230px;">
        <input type="text" class="fa-param input-text" data-k="title" placeholder="Embed title" value="${poEsc(p.title||'')}" style="width:150px;">
        <input type="text" class="fa-param input-text" data-k="message" placeholder="Body (supports {{tokens}})" value="${poEsc(p.message||'')}" style="width:230px;">
        <input type="text" class="fa-param input-text" data-k="color" placeholder="#rrggbb" value="${poEsc(p.color||'')}" style="width:72px;" title="Hex sidebar color">`;
    case 'random_choice': {
      const allF = _flows || [];
      const selIds = (p.flowIds||'').split(',').map(s=>s.trim()).filter(Boolean);
      const opts = allF.map(f => `<option value="${poEsc(f.id)}"${selIds.includes(f.id)?' selected':''}>${poEsc(f.name||f.id)}</option>`).join('');
      return `<select class="fa-param input-select" data-k="flowIds" multiple size="3" style="width:220px;height:64px;" title="Hold Ctrl/Cmd to select multiple flows">${opts||'<option disabled>No flows yet</option>'}</select>
        <span style="font-size:10px;color:var(--muted);display:block;margin-top:2px;">One is picked at random each fire</span>`;
    }
    case 'obs_playback_start':
    case 'obs_playback_stop':
    case 'obs_playback_pause':
      return `<input type="text" class="fa-param input-text" data-k="inputName" placeholder="media source name" value="${poEsc(p.inputName||'')}" style="width:220px;">`;
    default:
      return '';
  }
}

// ── Condition catalogue (AND guards — all must be true at fire time) ──────────
const FLOW_CONDITION_GROUPS = [
  { label: 'OBS', items: [
    ['if_obs_scene',    'Current scene is…'],
    ['if_streaming',    'Stream is live'],
    ['if_not_streaming','Stream is NOT live'],
    ['if_recording',    'Recording is active'],
    ['if_not_recording','Recording is NOT active'],
  ]},
  { label: 'Match / Series', items: [
    ['if_game_number',  'Current game number is…'],
    ['if_series_state', 'Series score state…'],
    ['if_score_diff',   'In-game score difference…'],
  ]},
  { label: 'Time', items: [
    ['if_time_range',   'Current time is between…'],
  ]},
  { label: 'Variables / Flow', items: [
    ['if_variable',        'Variable value is…'],
    ['if_flow_last_fired', 'Flow fired within last…'],
    ['flow_is_enabled',    'Another flow is enabled'],
  ]},
  { label: 'Match / Series (extended)', items: [
    ['if_match_point', 'Team is on match point'],
  ]},
  { label: 'System', items: [
    ['system_idle_for',    'No producer input for at least…'],
    ['process_running',    'A program is running'],
    ['window_is_focused',  'A window is currently focused'],
  ]},
  { label: 'Audio', items: [
    ['audio_level_above', 'Audio level above…'],
    ['audio_level_below', 'Audio level below…'],
  ]},
];
const FLOW_COND_LABEL = Object.fromEntries(FLOW_CONDITION_GROUPS.flatMap(g => g.items));

function _flowCondOptGroups(selected) {
  return FLOW_CONDITION_GROUPS.map(g =>
    `<optgroup label="${g.label}">${g.items.map(([v,l]) =>
      `<option value="${v}"${selected===v?' selected':''}>${l}</option>`
    ).join('')}</optgroup>`
  ).join('');
}

function flowConditionParamsHtml(cond) {
  const p = cond.params || {};
  const scenes = (currentState.obs && currentState.obs.availableScenes) || [];
  switch (cond.type) {
    case 'if_obs_scene':
      return `<select class="fc-param input-select" data-k="scene" style="width:160px;">${scenes.map(s=>`<option value="${poEsc(s)}"${p.scene===s?' selected':''}>${poEsc(s)}</option>`).join('')||'<option value="">(OBS offline)</option>'}</select>`;
    case 'if_game_number':
      return `<input type="number" class="fc-param input-text" data-k="value" min="1" max="9" value="${p.value||1}" style="width:52px;">`;
    case 'if_series_state':
      return `<select class="fc-param input-select" data-k="compare" style="width:150px;">
        <option value="blue_leads"${p.compare==='blue_leads'?' selected':''}>Blue is leading</option>
        <option value="orange_leads"${p.compare==='orange_leads'?' selected':''}>Orange is leading</option>
        <option value="tied"${p.compare==='tied'?' selected':''}>Series is tied</option>
      </select>`;
    case 'if_score_diff':
      return `<select class="fc-param input-select" data-k="op" style="width:80px;">
        <option value="gte"${(!p.op||p.op==='gte')?' selected':''}>≥</option>
        <option value="eq"${p.op==='eq'?' selected':''}>= exactly</option>
        <option value="lte"${p.op==='lte'?' selected':''}>≤</option>
      </select>
      <input type="number" class="fc-param input-text" data-k="value" min="0" value="${p.value||1}" style="width:48px;"> <span style="font-size:11px;color:var(--muted);">goals</span>`;
    case 'if_time_range':
      return `<input type="time" class="fc-param input-text" data-k="start" value="${poEsc(p.start||'00:00')}" style="width:100px;"> <span style="font-size:11px;color:var(--muted);">–</span>
        <input type="time" class="fc-param input-text" data-k="end" value="${poEsc(p.end||'23:59')}" style="width:100px;">`;
    case 'if_variable':
      return `<input type="text" class="fc-param input-text" data-k="name" placeholder="var_name" value="${poEsc(p.name||'')}" style="width:110px;">
        <select class="fc-param input-select" data-k="op" style="width:96px;">
          <option value="eq"${(!p.op||p.op==='eq')?' selected':''}>= equals</option>
          <option value="neq"${p.op==='neq'?' selected':''}>≠ not equals</option>
          <option value="gt"${p.op==='gt'?' selected':''}>&#62; greater</option>
          <option value="gte"${p.op==='gte'?' selected':''}>≥ greater/eq</option>
          <option value="lt"${p.op==='lt'?' selected':''}>&#60; less</option>
          <option value="lte"${p.op==='lte'?' selected':''}>≤ less/eq</option>
          <option value="contains"${p.op==='contains'?' selected':''}>contains</option>
        </select>
        <input type="text" class="fc-param input-text" data-k="value" placeholder="value" value="${poEsc(p.value||'')}" style="width:100px;">`;
    case 'if_flow_last_fired': {
      const fls = _flows || [];
      const fopts = fls.map(f => `<option value="${poEsc(f.id)}"${p.flowId===f.id?' selected':''}>${poEsc(f.name||f.id)}</option>`).join('');
      return `<select class="fc-param input-select" data-k="flowId" style="width:160px;"><option value="">— pick flow —</option>${fopts}</select>
        <span style="font-size:11px;color:var(--muted);">within last</span>
        <input type="number" class="fc-param input-text" data-k="maxAgoMs" min="100" value="${p.maxAgoMs||5000}" style="width:76px;">
        <span style="font-size:11px;color:var(--muted);">ms</span>`;
    }
    case 'if_match_point':
      return `<select class="fc-param input-select" data-k="team" style="width:120px;">
        <option value="any"${(!p.team||p.team==='any')?' selected':''}>Either team</option>
        <option value="blue"${p.team==='blue'?' selected':''}>Blue team</option>
        <option value="orange"${p.team==='orange'?' selected':''}>Orange team</option>
      </select>`;
    case 'flow_is_enabled': {
      const fls = _flows || [];
      const fopts = fls.map(f => `<option value="${poEsc(f.id)}"${p.flowId===f.id?' selected':''}>${poEsc(f.name||f.id)}</option>`).join('');
      return `<select class="fc-param input-select" data-k="flowId" style="width:180px;"><option value="">— pick flow —</option>${fopts}</select>`;
    }
    case 'system_idle_for':
      return `<input type="number" class="fc-param input-text" data-k="minutes" min="1" max="600" value="${p.minutes||5}" style="width:64px;"> <span style="font-size:11px;color:var(--muted);">minutes</span>`;
    case 'process_running':
      return `<input type="text" class="fc-param input-text" data-k="processName" placeholder="e.g. RocketLeague.exe" value="${poEsc(p.processName||'')}" style="width:180px;" title="Checked roughly every 3 seconds — not instant">`;
    case 'window_is_focused':
      return `<input type="text" class="fc-param input-text" data-k="titleContains" placeholder="e.g. OBS Studio" value="${poEsc(p.titleContains||'')}" style="width:180px;" title="Checked roughly every 5 seconds — not instant">`;
    case 'audio_level_above':
    case 'audio_level_below':
      return `<input type="text" class="fc-param input-text" data-k="sourceName" placeholder="audio source name" value="${poEsc(p.sourceName||'')}" style="width:160px;">
        <input type="number" class="fc-param input-text" data-k="thresholdDb" value="${p.thresholdDb ?? -30}" style="width:60px;" title="dB — 0 is loudest, more negative is quieter"> <span style="font-size:11px;color:var(--muted);">dB for</span>
        <input type="number" class="fc-param input-text" data-k="seconds" min="1" max="60" value="${p.seconds||3}" style="width:52px;"> <span style="font-size:11px;color:var(--muted);">sec straight</span>`;
    default:
      return '';
  }
}

// Fire a flow manually via the server (server-side execution)
function flowFire(flow) {
  if (!flow) return;
  send('fire_flow_manual', { id: flow.id });
  if (typeof showToast === 'function') showToast('▶ ' + (flow.name || 'Flow'), '#7c5cff', 1200);
}

// flowGameWatch is now a no-op — server handles all trigger detection
function flowGameWatch() {}

// Trigger category color by prefix (used in list cards)
function _flowTrigColor(type) {
  if (type.startsWith('rl_')) return '#a78bfa';
  if (type.startsWith('cs2_')) return '#f87171';
  if (type.startsWith('twitch_')) return '#c084fc';
  if (type.startsWith('obs_')) return '#60a5fa';
  if (type === 'timer_countdown_end' || type.startsWith('break_')) return '#34d399';
  if (type === 'cron_schedule' || type === 'time_of_day') return '#fbbf24';
  return '#94a3b8';
}

function _flowTimeAgo(serverMs) {
  if (!serverMs) return null;
  const sec = Math.floor((Date.now() - serverMs) / 1000);
  if (sec < 5)    return 'just fired';
  if (sec < 60)   return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  return Math.floor(sec / 3600) + 'h ago';
}

function renderFlowVars() {
  const panel = document.getElementById('flow-vars-panel');
  const list  = document.getElementById('flow-vars-list');
  if (!panel || !list) return;
  const vars = (currentState && currentState.flowVars) || {};
  const entries = Object.entries(vars);
  if (!entries.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  list.innerHTML = entries.map(([k, v]) =>
    `<span class="flow-var-chip" title="{{${poEsc(k)}}} = ${poEsc(String(v))}">
      <span class="flow-var-name">{{${poEsc(k)}}}</span><span class="flow-var-val">${poEsc(String(v))}</span>
      <button class="flow-var-rm" data-k="${poEsc(k)}" title="Reset this variable">✕</button>
    </span>`
  ).join('');
  list.querySelectorAll('.flow-var-rm').forEach(btn => {
    btn.addEventListener('click', () => send('reset_flow_var', { name: btn.dataset.k }));
  });
}

function renderFlows() {
  if (currentState && currentState.flows) _flows = currentState.flows;
  renderFlowVars();
  const list = el('flow-list'); if (!list) return;
  if (list.contains(document.activeElement)) return;
  if (!_flows.length) {
    list.innerHTML = '<div class="empty-state"><b>No automations yet</b>'
      + '<span>An automation runs a set of actions when something happens in the show (a goal, a scene cut, a timer), or when you press it.</span>'
      + '<div class="empty-state-acts"><button type="button" class="btn btn-primary btn-sm" data-empty-click="flow-new">+ New automation</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-empty-click="flow-templates">Start from a template</button></div></div>';
    return;
  }
  const fireLog = (currentState && currentState.flowFireLog) || {};
  list.innerHTML = '';
  _flows.forEach((f) => {
    const triggers = f.triggers || (f.trigger ? [f.trigger] : []);
    const actions  = f.actions  || [];
    const isSeq    = f.triggerMode === 'sequence';
    const isOn     = f.enabled !== false;
    const lastFiredMs  = (fireLog[f.id] || [])[0] || null;
    const lastFiredStr = _flowTimeAgo(lastFiredMs);

    const trigChips = triggers.map((t, ti) => {
      const lbl   = FLOW_TRIG_LABEL[t.type] || t.type;
      const color = _flowTrigColor(t.type);
      const sep   = ti > 0 ? `<span style="font-size:10px;color:var(--muted);margin:0 2px;">${isSeq?'→':'OR'}</span>` : '';
      return sep + `<span class="flow-trig-chip" style="--chip-color:${color};">${poEsc(lbl)}</span>`;
    }).join('');

    // Action summary: show first 3 then "+N more"
    const actSummary = actions.slice(0, 3).map(a => {
      const lbl = flowActionLabel(a);
      return `<span class="flow-act-chip">${poEsc(lbl)}</span>`;
    }).join('');
    const actMore = actions.length > 3 ? `<span class="flow-act-chip flow-act-more">+${actions.length-3} more</span>` : '';

    const card = document.createElement('div');
    card.className = 'flow-card' + (isOn ? '' : ' flow-card-off');
    card.dataset.name = f.name || '';
    card.dataset.search = [
      f.name, f.notes,
      ...triggers.map(t => FLOW_TRIG_LABEL[t.type] || t.type),
      ...actions.map(a => flowActionLabel(a)),
    ].filter(Boolean).join(' ').toLowerCase();
    card.innerHTML = `
      <div class="flow-card-top">
        <span class="flow-card-name">${poEsc(f.name||'Unnamed')}</span>
        <div class="flow-card-meta">
          <span class="flow-card-count">${actions.length} step${actions.length===1?'':'s'}</span>
          ${lastFiredStr ? `<span class="flow-card-fired" title="Last fired">${lastFiredStr}</span>` : ''}
          <label class="qt-toggle" style="font-size:11px;">
            <span style="color:var(--muted)">On</span>
            <span class="switch"><input type="checkbox" ${isOn?'checked':''}><span class="slider"></span></span>
          </label>
        </div>
      </div>
      <div class="flow-card-triggers">${trigChips||'<span style="font-size:11px;color:var(--muted)">No trigger set</span>'}</div>
      <div class="flow-card-actions">${actSummary}${actMore}</div>
      ${f.notes ? `<div class="flow-card-notes">${poEsc(f.notes)}</div>` : ''}
      <div class="flow-card-btns">
        <button class="fc-fire btn btn-xs" style="background:rgba(124,92,255,.18);color:#c4b5fd;border:1px solid rgba(124,92,255,.3);">Fire now</button>
        <button class="fc-test btn btn-ghost btn-xs" title="Dry-run: check conditions and preview actions without executing">Test</button>
        <button class="fc-export btn btn-ghost btn-xs" title="Export flow as JSON">Export</button>
        <button class="fc-edit btn btn-ghost btn-xs">Edit</button>
        <button class="fc-del btn btn-ghost btn-xs" style="color:#f56565;">Delete</button>
      </div>`;

    card.querySelector('input[type=checkbox]').addEventListener('change', () => send('toggle_flow', { id: f.id }));
    card.querySelector('.fc-fire').addEventListener('click', () => flowFire(f));
    card.querySelector('.fc-test').addEventListener('click', () => flowDryRun(f));
    card.querySelector('.fc-export').addEventListener('click', () => downloadFlowJson(f));
    card.querySelector('.fc-edit').addEventListener('click', () => openFlowEditor(f));
    card.querySelector('.fc-del').addEventListener('click', (e) => {
      appConfirm('Delete flow "' + (f.name||'this flow') + '"?', 'Delete').then(ok => {
        if (ok) { e.target.blur(); send('delete_flow', { id: f.id }); }
      });
    });
    list.appendChild(card);
  });
  applyFlowsFilter();
}

// Keyword filter over the rendered flow cards (pure show/hide, mirrors applyTeamsFilter).
function applyFlowsFilter() {
  const list = el('flow-list'); if (!list) return;
  const q = (el('flow-search')?.value || '').trim();
  const cards = list.querySelectorAll('.flow-card');
  // Name weighted above the trigger/action vocabulary, so searching "winner" finds the flow called
  // Winner before every flow that merely fires the winner graphic.
  const { shown } = NESearch.rankNodes(cards, q,
    (c) => [{ text: c.dataset.name || '', weight: 2 }, { text: c.dataset.search || '', bag: true }]);
  const empty = el('flow-search-empty');
  if (empty) empty.style.display = (q && cards.length && shown === 0) ? '' : 'none';
}
el('flow-search')?.addEventListener('input', applyFlowsFilter);

// Coerce a flow (possibly a legacy shape from an old export/save) into the current shape.
// Shared by the editor (openFlowEditor) and bulk import (which saves straight through without
// ever opening the editor, so it can't rely on the editor to do this normalization for it).
function normalizeFlowShape(f) {
  const d = JSON.parse(JSON.stringify(f));
  if (!d.triggers && d.trigger) {
    d.triggers = [{ id: 'tr0', type: d.trigger.type||'manual', params: {} }];
    delete d.trigger;
  }
  if (!d.triggers) d.triggers = [];
  d.actions = (d.actions||[]).map(a => {
    if (a.params) return a;
    if (a.type === 'scene') return { id: 'ac_'+Math.random().toString(36).slice(2,7), type: 'obs_scene', params: { scene: a.scene||'' } };
    if (a.type === 'wait') return { id: 'ac_'+Math.random().toString(36).slice(2,7), type: 'wait', params: { ms: (a.seconds||1)*1000 } };
    return { id: 'ac_'+Math.random().toString(36).slice(2,7), type: a.type, params: {} };
  });
  if (!d.conditions) d.conditions = [];
  if (d.repeatCount == null) d.repeatCount = 1;
  if (d.repeatDelay == null) d.repeatDelay = 0;
  return d;
}

function openFlowEditor(f) {
  _flowDraft = f
    ? normalizeFlowShape(f)
    : { id: 'fl_'+Math.random().toString(36).slice(2,9), name: '', enabled: true, triggerMode: 'any', triggers: [], conditions: [], actions: [], cooldown: 0, repeatCount: 1, repeatDelay: 0 };
  renderFlowEditor();
}

function _closeFlowModal() {
  _flowDraft = null;
  document.getElementById('_flow-modal')?.remove();
}

function renderFlowEditor() {
  // Remove old modal if it exists; we re-render from scratch each time
  const prevModal = document.getElementById('_flow-modal');
  const prevActScroll = prevModal?.querySelector('#fe-actions')?.scrollTop || 0;
  prevModal?.remove();

  const d = _flowDraft;
  if (!d) return;

  const isSeq = d.triggerMode === 'sequence';

  // ── Trigger rows ──────────────────────────────────────────────────────────
  const triggersHtml = (d.triggers||[]).map((t, i) => {
    const isFirst = i === 0, isLast = i === d.triggers.length - 1;
    const seqLabel = isSeq ? (i === 0 ? 'WHEN' : 'THEN') : (i === 0 ? 'IF' : 'OR');
    const timeoutRow = (isSeq && i > 0)
      ? `<div class="fe-timeout-row"><span class="fe-muted">wait up to</span>
          <input type="number" class="ft-timeout input-text" data-i="${i}" min="0" value="${t.timeout||0}" style="width:72px;">
          <span class="fe-muted">ms before this step</span></div>`
      : '';
    return `${timeoutRow}<div class="fe-trig-row" data-i="${i}">
      <span class="fe-step-lbl" style="color:${_flowTrigColor(t.type)};">${seqLabel}</span>
      <select class="ft-type input-select fe-sel" data-i="${i}">${_flowTrigOptGroups(t.type)}</select>
      <div class="fe-inline-params">${flowTriggerParamsHtml(t)}</div>
      <div class="fe-row-ctrl">
        <button class="ft-up fe-ctrl-btn" data-i="${i}" ${isFirst?'disabled':''} title="Move up">↑</button>
        <button class="ft-dn fe-ctrl-btn" data-i="${i}" ${isLast?'disabled':''} title="Move down">↓</button>
        <button class="ft-dup fe-ctrl-btn" data-i="${i}" title="Duplicate trigger">⧉</button>
        <button class="fe-rm-btn ft-rm" data-i="${i}" title="Remove trigger">✕</button>
      </div>
    </div>`;
  }).join('') || '<div class="fe-empty">No triggers — add one below to define when this flow fires.</div>';

  // ── Action rows (with per-action delay) ───────────────────────────────────
  const actionsHtml = (d.actions||[]).map((a, i) => {
    const isFirst = i === 0;
    const isLast  = i === d.actions.length - 1;
    const delayMs = Number(a.delay) || 0;
    return `<div class="fe-act-row" data-i="${i}">
      <span class="fe-act-num">${i + 1}</span>
      <div class="fe-act-body">
        <div class="fe-act-delay-row">
          <span class="fe-muted" style="font-size:10px;">delay</span>
          <input type="number" class="fa-delay input-text" data-i="${i}" min="0" value="${delayMs}" style="width:64px;font-size:11px;" title="Wait this many ms before running this action">
          <span class="fe-muted" style="font-size:10px;">ms then:</span>
        </div>
        <select class="fa-type input-select fe-sel" data-i="${i}">${_flowActOptGroups(a.type)}</select>
        <div class="fe-act-params">${flowActionParamsHtml(a)}</div>
      </div>
      <div class="fe-act-ctrl">
        <button class="fa-up fe-ctrl-btn" data-i="${i}" ${isFirst?'disabled':''} title="Move up">↑</button>
        <button class="fa-dn fe-ctrl-btn" data-i="${i}" ${isLast?'disabled':''} title="Move down">↓</button>
        <button class="fa-dup fe-ctrl-btn" data-i="${i}" title="Duplicate action">⧉</button>
        <button class="fa-rm fe-rm-btn" data-i="${i}" title="Remove action">✕</button>
      </div>
    </div>`;
  }).join('') || '<div class="fe-empty">No actions yet — pick one from the dropdown below.</div>';

  // ── Condition rows (AND guards) ───────────────────────────────────────────
  const conditionsHtml = (d.conditions||[]).map((c, i) => {
    const isFirst = i === 0, isLast = i === d.conditions.length - 1;
    return `<div class="fe-cond-row" data-i="${i}">
      <span class="fe-step-lbl" style="color:#34d399;">${i===0?'IF':'AND'}</span>
      <select class="fc-type input-select fe-sel" data-i="${i}">${_flowCondOptGroups(c.type)}</select>
      <div class="fe-inline-params">${flowConditionParamsHtml(c)}</div>
      <div class="fe-row-ctrl">
        <button class="fc-up fe-ctrl-btn" data-i="${i}" ${isFirst?'disabled':''} title="Move up">↑</button>
        <button class="fc-dn fe-ctrl-btn" data-i="${i}" ${isLast?'disabled':''} title="Move down">↓</button>
        <button class="fc-dup fe-ctrl-btn" data-i="${i}" title="Duplicate condition">⧉</button>
        <button class="fe-rm-btn fc-rm" data-i="${i}" title="Remove condition">✕</button>
      </div>
    </div>`;
  }).join('') || '<div class="fe-empty" style="font-size:11px;color:var(--muted);padding:8px 0;">No conditions — flow fires on any matching trigger.</div>';

  // ── Modal scaffold ────────────────────────────────────────────────────────
  const modal = document.createElement('div');
  modal.id = '_flow-modal';
  modal.className = 'fe-backdrop';
  modal.innerHTML = `
    <div class="fe-dialog" role="dialog" aria-modal="true">

      <div class="fe-header">
        <input id="fe-name" class="input-text fe-name-input" placeholder="Flow name…" value="${poEsc(d.name||'')}">
        <textarea id="fe-notes" class="input-text fe-notes-input" placeholder="Notes (optional, shown on card)…" rows="1" style="width:100%;resize:none;font-size:11px;color:var(--muted);margin-top:4px;padding:3px 6px;">${poEsc(d.notes||'')}</textarea>
        <div class="fe-header-right">
          <span class="fe-muted">Cooldown</span>
          <input id="fe-cooldown" type="number" class="input-text" min="0" value="${d.cooldown||0}" style="width:62px;" title="Minimum ms between fires">
          <span class="fe-muted">ms</span>
          <span class="fe-muted" style="margin-left:8px;">Repeat</span>
          <input id="fe-repeat-count" type="number" class="input-text" min="1" max="99" value="${d.repeatCount||1}" style="width:46px;" title="Run actions this many times">
          <span class="fe-muted">×</span>
          <input id="fe-repeat-delay" type="number" class="input-text" min="0" value="${d.repeatDelay||0}" style="width:58px;" title="ms gap between repeats">
          <span class="fe-muted">ms gap</span>
          <button id="fe-save" class="btn btn-primary btn-sm">Save</button>
          <button id="fe-cancel" class="btn btn-ghost btn-sm">Cancel</button>
        </div>
      </div>

      <div class="fe-body">

        <div class="fe-col fe-col-left">
          <div class="fe-col-hdr">
            <span>WHEN (triggers)</span>
            <div class="fe-mode-btns">
              <button id="fe-mode-any" class="btn btn-xs ${!isSeq?'btn-primary':'btn-ghost'}" title="Any trigger fires the flow">Any</button>
              <button id="fe-mode-seq" class="btn btn-xs ${isSeq?'btn-primary':'btn-ghost'}" title="Triggers must fire in this order">Sequence</button>
            </div>
          </div>
          <div id="fe-triggers" class="fe-list">${triggersHtml}</div>
          <div class="fe-add-bar">
            <select id="fe-add-trigger" class="input-select" style="width:100%;">
              <option value="">+ Add trigger…</option>${_flowTrigOptGroups('')}
            </select>
          </div>

          <div class="fe-col-hdr" style="margin-top:10px;">
            <span>AND ONLY IF (conditions)</span>
          </div>
          <div id="fe-conditions" class="fe-list">${conditionsHtml}</div>
          <div class="fe-add-bar">
            <select id="fe-add-condition" class="input-select" style="width:100%;">
              <option value="">+ Add condition…</option>${_flowCondOptGroups('')}
            </select>
          </div>
        </div>

        <div class="fe-col fe-col-right">
          <div class="fe-col-hdr"><span>THEN DO (runs top to bottom)</span></div>
          <div id="fe-actions" class="fe-list fe-actions-scroll">${actionsHtml}</div>
          <div class="fe-add-bar">
            <select id="fe-add-action" class="input-select" style="width:100%;">
              <option value="">+ Add action…</option>${_flowActOptGroups('')}
            </select>
          </div>
        </div>

      </div>
    </div>`;

  document.body.appendChild(modal);

  // Restore action scroll position after re-render
  if (prevActScroll) {
    const actList = modal.querySelector('#fe-actions');
    if (actList) actList.scrollTop = prevActScroll;
  }

  // ── Wire events ───────────────────────────────────────────────────────────
  const feid = (id) => document.getElementById(id);

  feid('fe-name').addEventListener('input', e => { d.name = e.target.value; });
  feid('fe-notes').addEventListener('input', e => { d.notes = e.target.value; });
  feid('fe-cooldown').addEventListener('input', e => { d.cooldown = Number(e.target.value)||0; });
  feid('fe-repeat-count').addEventListener('input', e => { d.repeatCount = Math.max(1, Number(e.target.value)||1); });
  feid('fe-repeat-delay').addEventListener('input', e => { d.repeatDelay = Number(e.target.value)||0; });
  feid('fe-mode-any').addEventListener('click', () => { d.triggerMode='any'; renderFlowEditor(); });
  feid('fe-mode-seq').addEventListener('click', () => { d.triggerMode='sequence'; renderFlowEditor(); });

  feid('fe-add-trigger').addEventListener('change', function() {
    if (!this.value) return;
    d.triggers.push({ id:'tr_'+Math.random().toString(36).slice(2,7), type:this.value, params:{} });
    this.value = '';
    renderFlowEditor();
  });

  feid('fe-add-condition').addEventListener('change', function() {
    if (!this.value) return;
    d.conditions.push({ id:'co_'+Math.random().toString(36).slice(2,7), type:this.value, params:{} });
    this.value = '';
    renderFlowEditor();
  });

  feid('fe-add-action').addEventListener('change', function() {
    if (!this.value) return;
    d.actions.push({ id:'ac_'+Math.random().toString(36).slice(2,7), type:this.value, params:{}, delay:0 });
    this.value = '';
    renderFlowEditor();
  });

  modal.querySelectorAll('.ft-type').forEach(sel => {
    sel.addEventListener('change', function() {
      d.triggers[+this.dataset.i] = { ...d.triggers[+this.dataset.i], type:this.value, params:{} };
      renderFlowEditor();
    });
  });

  modal.querySelectorAll('.fa-type').forEach(sel => {
    sel.addEventListener('change', function() {
      d.actions[+this.dataset.i] = { id: d.actions[+this.dataset.i].id, type:this.value, params:{} };
      renderFlowEditor();
    });
  });

  modal.querySelectorAll('.ft-param').forEach(inp => {
    const i = +inp.closest('[data-i]').dataset.i;
    const k = inp.dataset.k;
    const upd = () => { if (d.triggers[i]) d.triggers[i].params[k] = inp.type==='number'?(Number(inp.value)||0):inp.value; };
    inp.addEventListener('change', upd); inp.addEventListener('input', upd);
  });

  modal.querySelectorAll('.fa-param').forEach(inp => {
    const i = +inp.closest('[data-i]').dataset.i;
    const k = inp.dataset.k;
    const upd = () => { if (d.actions[i]) d.actions[i].params[k] = inp.type==='number'?(Number(inp.value)||0):inp.value; };
    inp.addEventListener('change', upd); inp.addEventListener('input', upd);
  });

  modal.querySelectorAll('.fa-delay').forEach(inp => {
    inp.addEventListener('input', function() {
      if (d.actions[+this.dataset.i]) d.actions[+this.dataset.i].delay = Number(this.value)||0;
    });
  });

  modal.querySelectorAll('.fc-type').forEach(sel => {
    sel.addEventListener('change', function() {
      d.conditions[+this.dataset.i] = { ...d.conditions[+this.dataset.i], type:this.value, params:{} };
      renderFlowEditor();
    });
  });

  modal.querySelectorAll('.fc-param').forEach(inp => {
    const i = +inp.closest('[data-i]').dataset.i;
    const k = inp.dataset.k;
    const upd = () => { if (d.conditions[i]) d.conditions[i].params[k] = inp.type==='number'?(Number(inp.value)||0):inp.value; };
    inp.addEventListener('change', upd); inp.addEventListener('input', upd);
  });

  modal.querySelectorAll('.fc-rm').forEach(btn => {
    btn.addEventListener('click', function() { d.conditions.splice(+this.dataset.i,1); renderFlowEditor(); });
  });

  modal.querySelectorAll('.ft-timeout').forEach(inp => {
    inp.addEventListener('input', function() {
      if (d.triggers[+this.dataset.i]) d.triggers[+this.dataset.i].timeout = Number(this.value)||0;
    });
  });

  modal.querySelectorAll('.ft-rm').forEach(btn => {
    btn.addEventListener('click', function() { d.triggers.splice(+this.dataset.i,1); renderFlowEditor(); });
  });

  modal.querySelectorAll('.fa-up').forEach(btn => {
    btn.addEventListener('click', function() {
      const i = +this.dataset.i;
      if (i > 0) { [d.actions[i-1], d.actions[i]] = [d.actions[i], d.actions[i-1]]; renderFlowEditor(); }
    });
  });

  modal.querySelectorAll('.fa-dn').forEach(btn => {
    btn.addEventListener('click', function() {
      const i = +this.dataset.i;
      if (i < d.actions.length-1) { [d.actions[i+1], d.actions[i]] = [d.actions[i], d.actions[i+1]]; renderFlowEditor(); }
    });
  });

  modal.querySelectorAll('.fa-dup').forEach(btn => {
    btn.addEventListener('click', function() {
      const i = +this.dataset.i;
      const copy = { ...JSON.parse(JSON.stringify(d.actions[i])), id: 'ac_'+Math.random().toString(36).slice(2,7) };
      d.actions.splice(i+1, 0, copy);
      renderFlowEditor();
    });
  });

  modal.querySelectorAll('.fa-rm').forEach(btn => {
    btn.addEventListener('click', function() { d.actions.splice(+this.dataset.i,1); renderFlowEditor(); });
  });

  modal.querySelectorAll('.ft-up').forEach(btn => {
    btn.addEventListener('click', function() {
      const i = +this.dataset.i;
      if (i > 0) { [d.triggers[i-1], d.triggers[i]] = [d.triggers[i], d.triggers[i-1]]; renderFlowEditor(); }
    });
  });

  modal.querySelectorAll('.ft-dn').forEach(btn => {
    btn.addEventListener('click', function() {
      const i = +this.dataset.i;
      if (i < d.triggers.length-1) { [d.triggers[i+1], d.triggers[i]] = [d.triggers[i], d.triggers[i+1]]; renderFlowEditor(); }
    });
  });

  modal.querySelectorAll('.ft-dup').forEach(btn => {
    btn.addEventListener('click', function() {
      const i = +this.dataset.i;
      const copy = { ...JSON.parse(JSON.stringify(d.triggers[i])), id: 'tr_'+Math.random().toString(36).slice(2,7) };
      d.triggers.splice(i+1, 0, copy);
      renderFlowEditor();
    });
  });

  modal.querySelectorAll('.fc-up').forEach(btn => {
    btn.addEventListener('click', function() {
      const i = +this.dataset.i;
      if (i > 0) { [d.conditions[i-1], d.conditions[i]] = [d.conditions[i], d.conditions[i-1]]; renderFlowEditor(); }
    });
  });

  modal.querySelectorAll('.fc-dn').forEach(btn => {
    btn.addEventListener('click', function() {
      const i = +this.dataset.i;
      if (i < d.conditions.length-1) { [d.conditions[i+1], d.conditions[i]] = [d.conditions[i], d.conditions[i+1]]; renderFlowEditor(); }
    });
  });

  modal.querySelectorAll('.fc-dup').forEach(btn => {
    btn.addEventListener('click', function() {
      const i = +this.dataset.i;
      const copy = { ...JSON.parse(JSON.stringify(d.conditions[i])), id: 'co_'+Math.random().toString(36).slice(2,7) };
      d.conditions.splice(i+1, 0, copy);
      renderFlowEditor();
    });
  });

  feid('fe-save').addEventListener('click', () => {
    if (!d.name.trim()) d.name = 'Flow';
    send('save_flow', d);
    _closeFlowModal();
    if (typeof showToast === 'function') showToast('Flow saved', '#10b981', 1400);
  });

  feid('fe-cancel').addEventListener('click', _closeFlowModal);

  // Backdrop click closes modal
  modal.addEventListener('click', e => { if (e.target === modal) _closeFlowModal(); });

  // Escape key closes modal
  const onKey = (e) => {
    if (e.key === 'Escape') { _closeFlowModal(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);

  // Focus name field on first open (no draft name yet)
  if (!d.name) setTimeout(() => feid('fe-name')?.focus(), 30);
}

// ── Flow utilities ────────────────────────────────────────────────────────────

function downloadFlowJson(f) {
  const json = JSON.stringify(f, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (f.name || 'flow').replace(/[^a-z0-9_-]/gi, '_') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadAllFlowsJson() {
  if (!_flows.length) { if (typeof showToast === 'function') showToast('No flows to export', '#f59e0b', 1800); return; }
  const json = JSON.stringify(_flows, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'flows-all-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  if (typeof showToast === 'function') showToast('Exported ' + _flows.length + ' flow' + (_flows.length===1?'':'s'), '#10b981', 1800);
}
el('flow-export-all')?.addEventListener('click', downloadAllFlowsJson);

function flowDryRun(f) {
  send('flow_dry_run', { id: f.id });
}

function _showDryRunModal(data) {
  const { flowName, conditions, actions, conditionsPassed } = data || {};
  let existing = document.getElementById('flow-dryrun-modal');
  if (existing) existing.remove();
  const m = document.createElement('div');
  m.id = 'flow-dryrun-modal';
  m.className = 'flow-modal-overlay';
  const condHtml = (conditions || []).map(c => {
    const icon = c.passed ? '<span style="color:#34d399;">PASS</span>' : '<span style="color:#f56565;">FAIL</span>';
    return `<div class="dryrun-row">${icon} <span class="dryrun-ctype">${poEsc(c.type||'')}</span></div>`;
  }).join('') || '<div class="dryrun-row" style="color:var(--muted);">No conditions</div>';
  const actHtml = (actions || []).map((a, i) => {
    const rp = a.resolvedParams || {};
    const preview = Object.entries(rp).slice(0,2).map(([k,v])=>`${k}: ${String(v).slice(0,40)}`).join(', ');
    return `<div class="dryrun-row"><span class="dryrun-step">${i+1}</span> <span class="dryrun-atype">${poEsc(a.type||'')}</span>${a.delay ? ` <span style="color:var(--muted);">[+${a.delay}ms]</span>` : ''}${preview ? ` — <span style="color:var(--muted);font-size:10px;">${poEsc(preview)}</span>` : ''}</div>`;
  }).join('') || '<div class="dryrun-row" style="color:var(--muted);">No actions</div>';
  const fireLabel = conditionsPassed
    ? '<span style="color:#34d399;font-weight:700;">Would FIRE</span>'
    : '<span style="color:#f56565;font-weight:700;">Would NOT fire (conditions failed)</span>';
  m.innerHTML = `
    <div class="flow-modal-dialog dryrun-dialog">
      <div class="fe-header" style="border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:10px;">
        <strong>Dry Run: ${poEsc(flowName||'Flow')}</strong>
        <span style="margin-left:12px;">${fireLabel}</span>
        <button class="btn btn-ghost btn-sm" id="dryrun-close" style="margin-left:auto;">Close</button>
      </div>
      <div style="margin-bottom:10px;">
        <div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.06em;margin-bottom:4px;">CONDITIONS</div>
        ${condHtml}
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.06em;margin-bottom:4px;">ACTIONS</div>
        ${actHtml}
      </div>
    </div>`;
  document.body.appendChild(m);
  m.querySelector('#dryrun-close').addEventListener('click', () => m.remove());
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
}

const FLOW_TEMPLATES = [
  {
    name: 'Auto-tweet on goal',
    triggers: [{ id: 'tr0', type: 'rl_goal', params: {} }],
    conditions: [],
    actions: [{ id: 'ac0', type: 'twitch_send_chat', params: { message: 'GOAL! {{blue_team}} {{blue_score}} - {{orange_score}} {{orange_team}} #RocketLeague' }, delay: 0 }],
    enabled: true
  },
  {
    name: 'Discord announce on kickoff',
    triggers: [{ id: 'tr0', type: 'rl_round_started', params: {} }],
    conditions: [],
    actions: [{ id: 'ac0', type: 'send_discord_webhook', params: { url: '', content: 'Match live: {{blue_team}} vs {{orange_team}}' }, delay: 0 }],
    enabled: true
  },
  {
    name: 'Scene cut on overtime',
    triggers: [{ id: 'tr0', type: 'rl_overtime', params: {} }],
    conditions: [],
    actions: [{ id: 'ac0', type: 'obs_scene', params: { scene: 'Overtime' }, delay: 0 }],
    enabled: true
  },
  {
    name: 'Match-point alert',
    triggers: [{ id: 'tr0', type: 'rl_goal', params: {} }],
    conditions: [{ id: 'co0', type: 'if_match_point', params: {} }],
    actions: [{ id: 'ac0', type: 'twitch_send_chat', params: { message: 'MATCH POINT!' }, delay: 0 }],
    enabled: true
  },
  {
    name: 'Hourly overlay refresh (cron)',
    triggers: [{ id: 'tr0', type: 'cron_schedule', params: { expr: '0 * * * *' } }],
    conditions: [],
    actions: [{ id: 'ac0', type: 'overlay_reload', params: {}, delay: 0 }],
    enabled: false
  },
  {
    name: 'Counter: track kills',
    triggers: [{ id: 'tr0', type: 'manual', params: {} }],
    conditions: [],
    actions: [{ id: 'ac0', type: 'increment_variable', params: { name: 'kills', amount: 1 }, delay: 0 }, { id: 'ac1', type: 'twitch_send_chat', params: { message: 'Kills: {{kills}}' }, delay: 0 }],
    enabled: true
  }
];

function _showTemplatesPicker() {
  let existing = document.getElementById('flow-tpl-modal');
  if (existing) { existing.remove(); return; }
  const m = document.createElement('div');
  m.id = 'flow-tpl-modal';
  m.className = 'flow-modal-overlay';
  const rows = FLOW_TEMPLATES.map((t, i) =>
    `<div class="tpl-row" data-i="${i}">
      <strong>${poEsc(t.name)}</strong>
      <div style="font-size:10px;color:var(--muted);">${t.triggers.map(tr=>tr.type).join(', ')} → ${t.actions.map(a=>a.type).join(', ')}</div>
    </div>`).join('');
  m.innerHTML = `
    <div class="flow-modal-dialog" style="max-width:440px;">
      <div class="fe-header" style="border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:10px;">
        <strong>Flow Templates</strong>
        <button class="btn btn-ghost btn-sm" id="tpl-close" style="margin-left:auto;">Close</button>
      </div>
      <div id="tpl-list">${rows}</div>
    </div>`;
  document.body.appendChild(m);
  const onKey = (e) => { if (e.key === 'Escape' && m.isConnected) { e.stopPropagation(); m.remove(); } if (!m.isConnected) document.removeEventListener('keydown', onKey, true); };
  document.addEventListener('keydown', onKey, true);
  m.querySelector('#tpl-close').addEventListener('click', () => m.remove());
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  m.querySelectorAll('.tpl-row').forEach(row => {
    row.addEventListener('click', () => {
      const tpl = FLOW_TEMPLATES[+row.dataset.i];
      const draft = JSON.parse(JSON.stringify(tpl));
      draft.id = 'fl_' + Math.random().toString(36).slice(2, 9);
      draft.triggers = (draft.triggers || []).map((t, i) => ({ ...t, id: 'tr_' + i }));
      draft.conditions = (draft.conditions || []).map((c, i) => ({ ...c, id: 'co_' + i }));
      draft.actions = (draft.actions || []).map((a, i) => ({ ...a, id: 'ac_' + i }));
      m.remove();
      openFlowEditor(draft);
    });
  });
}

el('flow-new')?.addEventListener('click', () => openFlowEditor(null));
el('flow-templates')?.addEventListener('click', _showTemplatesPicker);
el('flow-import-input')?.addEventListener('change', function() {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      const raw = Array.isArray(data) ? data : [data];
      const flows = raw.filter(f => f && typeof f === 'object' && f.triggers);
      if (!flows.length) { if (typeof showToast === 'function') showToast('Invalid flow JSON', '#f56565', 2000); return; }
      flows.forEach(f => { f.id = 'fl_' + Math.random().toString(36).slice(2, 9); });
      if (flows.length === 1) {
        // A single flow — open it in the editor so the producer can review/rename before it's saved.
        openFlowEditor(flows[0]);
      } else {
        // Bulk import — opening each in the modal one after another only ever leaves the LAST one
        // visible (openFlowEditor replaces the single shared draft/modal each time), silently
        // discarding the rest with no save and no way to recover them. Save them straight through instead.
        flows.forEach(f => send('save_flow', normalizeFlowShape(f)));
        if (typeof showToast === 'function') showToast('Imported ' + flows.length + ' flows', '#10b981', 2000);
      }
    } catch { if (typeof showToast === 'function') showToast('Invalid flow JSON', '#f56565', 2000); }
  };
  reader.readAsText(file);
  this.value = '';
});
// Confirmed, like every other clear-everything button: this wipes EVERY flow variable at once and
// there is no undo — a mis-click mid-show silently resets the state the running flows read from.
el('flow-vars-clear-all')?.addEventListener('click', async () => {
  const n = Object.keys((currentState && currentState.flowVars) || {}).length;
  if (!n) return;
  if (await appConfirm(`Clear all ${n} flow variable${n === 1 ? '' : 's'}? Running flows read from these, and this cannot be undone.`, 'Clear all', true)) {
    send('reset_flow_var', {});
  }
});
renderFlows();

// ── Production Show pane: OBS status bar + Quick Scenes + Predictions ────────

let _qsPinned = (() => { try { return JSON.parse(localStorage.getItem('prod_qs_pins') || '[]'); } catch(_) { return []; } })();
let _prodPredTimerHandle = null;

function savePins() {
  try { localStorage.setItem('prod_qs_pins', JSON.stringify(_qsPinned)); } catch(_) {}
}

function renderProdShow() {
  renderProdOnAir();
  renderProdQuickScenes();
  renderProdPredictions();
  renderProdPolls();
  renderProdAdBreak();
}

function renderProdOnAir() {
  const obs = currentState && currentState.obs;
  const dot = el('prod-obs-dot');
  const sceneLbl = el('prod-obs-scene');
  const badge = el('prod-stream-badge');
  if (dot && sceneLbl) {
    if (!obs || !obs.connected) {
      dot.className = 'obs-onair-dot';
      sceneLbl.textContent = 'OBS not connected';
      if (badge) badge.style.display = 'none';
    } else {
      dot.className = 'obs-onair-dot connected';
      sceneLbl.textContent = obs.currentScene || '—';
      if (badge) badge.style.display = 'none';
    }
  }
}

function renderProdQuickScenes() {
  const scenes = (currentState && currentState.obs && currentState.obs.availableScenes) || [];
  const current = (currentState && currentState.obs && currentState.obs.currentScene) || '';
  const pinnedEl = el('prod-qs-pinned');
  const allEl = el('prod-qs-all');
  if (!pinnedEl || !allEl) return;

  function makeTile(name, inPinRow) {
    const isActive = name === current;
    const isPinned = _qsPinned.includes(name);
    const tile = document.createElement('span');
    tile.className = 'qs-tile' + (isActive ? ' qs-active' : '');
    tile.title = 'Switch to ' + name;

    const pinBtn = document.createElement('button');
    pinBtn.className = 'qs-pin-btn' + (isPinned ? ' pinned' : '');
    pinBtn.textContent = isPinned ? '★' : '☆';
    pinBtn.title = isPinned ? 'Unpin' : 'Pin to top';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_qsPinned.includes(name)) _qsPinned = _qsPinned.filter(n => n !== name);
      else _qsPinned.push(name);
      savePins();
      renderProdQuickScenes();
    });

    const label = document.createElement('span');
    label.textContent = name;

    tile.appendChild(pinBtn);
    tile.appendChild(label);
    tile.addEventListener('click', () => {
      send('obs_switch_scene', { sceneName: name });
    });
    return tile;
  }

  pinnedEl.innerHTML = '';
  const pinnedScenes = _qsPinned.filter(n => scenes.includes(n));
  if (pinnedScenes.length) {
    pinnedScenes.forEach(n => pinnedEl.appendChild(makeTile(n, true)));
  } else {
    pinnedEl.innerHTML = '<span style="font-size:11px;color:var(--muted);">No pinned scenes — star a scene below to pin it here.</span>';
  }

  allEl.innerHTML = '';
  const unpinned = scenes.filter(n => !_qsPinned.includes(n));
  if (!scenes.length) {
    allEl.innerHTML = '<span style="font-size:11px;color:var(--muted);">OBS not connected or no scenes found.</span>';
  } else {
    unpinned.forEach(n => allEl.appendChild(makeTile(n, false)));
    if (!unpinned.length) allEl.innerHTML = '<span style="font-size:11px;color:var(--muted);">All scenes are pinned.</span>';
  }
}

el('prod-refresh-scenes')?.addEventListener('click', () => { send('obs_refresh_scenes', {}); });

el('prod-pred-full-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  const integTab = document.querySelector('[data-tab="integrations"]');
  if (integTab) integTab.click();
});

function renderProdPredictions() {
  const twitch = currentState && currentState.twitch;
  const pred = twitch && twitch.predictions && twitch.predictions.current;
  const liveDiv = el('prod-pred-live');
  const idlePara = el('prod-pred-idle');
  if (!liveDiv || !idlePara) return;

  if (pred) {
    liveDiv.style.display = '';
    idlePara.style.display = 'none';
    const titleEl = el('prod-pred-title');
    if (titleEl) titleEl.textContent = pred.title || '';
    const outcomesEl = el('prod-pred-outcomes');
    if (outcomesEl && pred.outcomes) {
      const total = pred.outcomes.reduce((s, o) => s + (o.votes || 0), 0);
      outcomesEl.innerHTML = pred.outcomes.map(o => {
        const pct = total > 0 ? Math.round((o.votes || 0) / total * 100) : 0;
        return `<div class="prod-pred-outcome">
          <div class="prod-pred-outcome-fill" style="width:${pct}%;"></div>
          <div class="prod-pred-outcome-inner">
            <span class="prod-pred-outcome-title">${poEsc(o.title)}</span>
            <span class="prod-pred-outcome-meta">${o.votes || 0} · ${pct}%</span>
            <button class="btn btn-xs btn-success prod-pred-win-btn" data-id="${o.id}" data-title="${poEsc(o.title)}">Win</button>
          </div>
        </div>`;
      }).join('');
      outcomesEl.querySelectorAll('.prod-pred-win-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!await appConfirm('Declare "' + btn.dataset.title + '" the winner?', 'Declare Winner', false)) return;
          await fetch('http://127.0.0.1:3000/api/twitch/prediction/resolve', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ winningOutcomeId: btn.dataset.id, predictionId: pred.id })
          });
        });
      });
    }
    clearTimeout(_prodPredTimerHandle);
    if (pred.endsAt) {
      (function tick() {
        const remaining = Math.max(0, Math.ceil((pred.endsAt - Date.now()) / 1000));
        const t = el('prod-pred-timer');
        if (t) t.textContent = remaining > 0 ? remaining + 's' : 'Locked';
        if (remaining > 0) _prodPredTimerHandle = setTimeout(tick, 500);
      })();
    }
  } else {
    liveDiv.style.display = 'none';
    idlePara.style.display = '';
    clearTimeout(_prodPredTimerHandle);
  }
  const predSection = el('prod-pred-section');
  if (predSection) predSection.style.display = (twitch && twitch.connected) ? '' : 'none';
}

el('prod-pred-new-btn')?.addEventListener('click', () => {
  const form = el('prod-pred-form');
  const btn = el('prod-pred-new-btn');
  if (form) { const show = form.style.display === 'none'; form.style.display = show ? '' : 'none'; if (btn) btn.textContent = show ? '✕ Cancel' : '+ New prediction'; }
});
el('prod-pred-form-cancel-btn')?.addEventListener('click', () => {
  const form = el('prod-pred-form'); if (form) form.style.display = 'none';
  const btn = el('prod-pred-new-btn'); if (btn) btn.textContent = '+ New prediction';
});
el('prod-pred-submit-btn')?.addEventListener('click', async () => {
  const q = el('prod-pred-q')?.value?.trim();
  const o1 = el('prod-pred-o1')?.value?.trim();
  const o2 = el('prod-pred-o2')?.value?.trim();
  const dur = el('prod-pred-dur')?.value?.trim() || '5:00';
  if (!q || !o1 || !o2) { showToast('Fill in the question and both options', '#ef4444'); return; }
  const [m, s] = dur.split(':').map(Number);
  const seconds = ((m || 5) * 60) + (s || 0);
  await fetch('http://127.0.0.1:3000/api/twitch/prediction/create', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ title: q, outcomes: [o1, o2], duration: seconds })
  });
  const form = el('prod-pred-form'); if (form) form.style.display = 'none';
  const btn = el('prod-pred-new-btn'); if (btn) btn.textContent = '+ New prediction';
});
el('prod-pred-lock-btn')?.addEventListener('click', async () => {
  const pred = currentState?.twitch?.predictions?.current;
  if (!pred) return;
  await fetch('http://127.0.0.1:3000/api/twitch/prediction/lock', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ predictionId: pred.id }) });
});
el('prod-pred-cancel-btn')?.addEventListener('click', async () => {
  const pred = currentState?.twitch?.predictions?.current;
  if (!pred) return;
  if (!await appConfirm('Cancel this prediction?', 'Cancel Prediction')) return;
  await fetch('http://127.0.0.1:3000/api/twitch/prediction/cancel', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ predictionId: pred.id }) });
});

// ── Poll quick-fire widget ────────────────────────────────────────────────────
function renderProdPolls() {
  const twitch = currentState && currentState.twitch;
  const poll = twitch && twitch.poll && twitch.poll.current;
  const section = el('prod-poll-section');
  const liveDiv = el('prod-poll-live');
  const idlePara = el('prod-poll-idle');
  const pill = el('prod-poll-pill');
  if (!section) return;

  section.style.display = (twitch && twitch.connected) ? '' : 'none';
  if (!poll) {
    if (liveDiv) liveDiv.style.display = 'none';
    if (idlePara) idlePara.style.display = '';
    if (pill) pill.style.display = 'none';
    return;
  }

  if (liveDiv) liveDiv.style.display = '';
  if (idlePara) idlePara.style.display = 'none';

  const titleEl = el('prod-poll-title');
  if (titleEl) titleEl.textContent = poll.title || '';

  const ended = poll.status !== 'ACTIVE';
  if (pill) {
    pill.style.display = '';
    pill.textContent = ended ? 'Ended' : 'Voting Open';
    pill.style.background = ended ? 'rgba(74,222,128,.14)' : 'rgba(145,70,255,.18)';
    pill.style.color = ended ? '#4ade80' : '#9146ff';
    pill.style.border = ended ? '1px solid rgba(74,222,128,.28)' : '1px solid rgba(145,70,255,.30)';
  }

  const choicesEl = el('prod-poll-choices');
  if (choicesEl && poll.choices) {
    const total = poll.total || poll.choices.reduce((s, c) => s + (c.votes || 0), 0);
    choicesEl.innerHTML = poll.choices.map(c => {
      const pct = total > 0 ? Math.round((c.votes || 0) / total * 100) : 0;
      return `<div style="display:flex;flex-direction:column;gap:4px;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px;">
          <span style="font-size:12px;font-weight:600;color:rgba(255,255,255,.80);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${poEsc(c.title)}</span>
          <span style="font-size:12px;font-weight:700;color:#9146ff;flex-shrink:0;">${pct}%</span>
          <span style="font-size:11px;color:var(--muted);flex-shrink:0;">${(c.votes || 0).toLocaleString()}</span>
        </div>
        <div style="height:5px;background:rgba(255,255,255,.07);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,rgba(145,70,255,.7),#9146ff);border-radius:3px;transition:width .6s ease;min-width:${pct > 0 ? 4 : 0}px;"></div>
        </div>
      </div>`;
    }).join('');
  }
  const footerEl = el('prod-poll-footer');
  const total = poll.total || (poll.choices || []).reduce((s, c) => s + (c.votes || 0), 0);
  if (footerEl) footerEl.textContent = total > 0 ? `${total.toLocaleString()} total votes` : 'Awaiting votes…';
}

// ── Ad break active banner ────────────────────────────────────────────────────
let _adBreakClearTimer = null;
let _adBreakCtTimer    = null;

function renderProdAdBreak() {
  const twitch = currentState && currentState.twitch;
  const ab = twitch && twitch.adBreak;
  const banner = el('prod-adbreak-banner');
  if (!banner) return;

  if (ab && ab.active) {
    // Keep top-bar chip in sync (e.g. after page reconnect when no live event fires)
    if (typeof _adState !== 'undefined' && !_adState.adBreak) {
      _adState.adBreak = true;
      _adState.adBreakEndsAt = ab.endsAt ? new Date(ab.endsAt).getTime() : 0;
      renderAdChip();
    }
    banner.style.display = 'flex';
    const msg = el('prod-adbreak-msg');
    if (msg) msg.textContent = ab.isAutomatic ? 'Automatic ad break running' : 'Manual ad break running';
    startAdBreakCountdown(ab.endsAt);
  } else {
    if (typeof _adState !== 'undefined' && _adState.adBreak) {
      _adState.adBreak = false; _adState.adBreakEndsAt = 0; renderAdChip();
    }
    banner.style.display = 'none';
    clearAdBreakCountdown();
  }
}

function startAdBreakCountdown(endsAt) {
  clearAdBreakCountdown();
  const ct = el('prod-adbreak-ct');
  if (!ct || !endsAt) return;
  const tick = () => {
    const rem = Math.max(0, Math.ceil((new Date(endsAt) - Date.now()) / 1000));
    ct.textContent = rem > 0 ? rem + 's' : '';
    if (rem > 0) _adBreakCtTimer = setTimeout(tick, 500);
  };
  tick();
}
function clearAdBreakCountdown() {
  if (_adBreakCtTimer) { clearTimeout(_adBreakCtTimer); _adBreakCtTimer = null; }
  const ct = el('prod-adbreak-ct');
  if (ct) ct.textContent = '';
}

function renderProdCredits(log) {
  // log is optional — fetched once then updated by WS events
  if (log !== undefined) renderProdCredits._log = log;
  const entries = renderProdCredits._log || [];
  const byType = {};
  for (const e of entries) { if (!byType[e.type]) byType[e.type] = 0; byType[e.type]++; }
  const follows = byType.follow || 0;
  const subs = (byType.sub || 0) + (byType.resub || 0) + (byType.gift_sub || 0);
  const raids = byType.raid || 0;
  const bits = byType.bits || 0;
  const hype = byType.hype_train || 0;
  const pts = byType.channel_points || 0;
  const setTxt = (id, v) => { const x = el(id); if (x) x.textContent = v; };
  setTxt('credits-count-follows', follows);
  setTxt('credits-count-subs', subs);
  setTxt('credits-count-raids', raids);
  setTxt('credits-count-bits', bits);
  setTxt('credits-count-hype', hype);
  setTxt('credits-count-pts', pts);
}
renderProdCredits._log = [];

(async () => {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/activity-log');
    const d = await r.json();
    renderProdCredits(d.log || []);
  } catch { /* Twitch not yet connected */ }
})();

el('btn-credits-clear')?.addEventListener('click', async () => {
  try {
    await fetch('http://127.0.0.1:3000/api/twitch/activity-log/clear', { method: 'POST' });
    renderProdCredits([]);
    showToast('Activity log cleared');
  } catch (e) {
    showToast('Failed to clear log', 'error');
  }
});

// Diagnostic: how many credited players actually have a resolvable country (start.gg location).
// Tells us instantly whether missing flags are a DATA gap or a display issue.
function renderCreditsCountryStat() {
  const box = el('credits-country-stat'); if (!box) return;
  const et = (currentState.startgg && currentState.startgg.eventTeams) || [];
  const profs = currentState.playerProfiles || {};
  let total = 0, flag = 0, nameOnly = 0;
  const unmapped = new Set();
  et.forEach((t) => (t.players || []).forEach((p) => {
    if (!p || !p.name) return;
    total++;
    const prof = profs[(p.name || '').trim().toLowerCase()] || {};
    const cc = p.countryCode || prof.countryCode;
    const cname = p.country || prof.country;
    if (cc) flag++;
    else if (cname) { nameOnly++; unmapped.add(cname); }
  }));
  if (!total) { box.textContent = 'Countries: no event roster loaded — sync the event (Events ▸ My Events).'; box.style.color = 'var(--muted)'; return; }
  let txt = `Countries: ${flag}/${total} players get a flag`;
  if (nameOnly) txt += ` · ${nameOnly} have a country start.gg couldn't map (see console)`;
  else if (flag < total) txt += ` · ${total - flag} have no country set on start.gg`;
  box.textContent = txt;
  box.style.color = flag === 0 ? '#f56565' : flag < total ? '#fbbf24' : '#9ae6b4';
  if (unmapped.size) console.log('[Credits] start.gg country names with no flag code (send these to me):', [...unmapped].sort().join(' | '));
}

// ── Credit Sponsors (dedicated big call-outs in the stream-credits roll) ─────
let _csPendingLogo = '';
function csSponsors() { return (currentState && currentState.credits && Array.isArray(currentState.credits.sponsors)) ? currentState.credits.sponsors : []; }
function csSave(list) { send('set_credits', { sponsors: list }); }
function renderCreditSponsors(data) {
  // End-card text mirrors state (don't clobber while the producer is typing).
  const et = el('credits-endtext');
  if (et && document.activeElement !== et) et.value = (data && data.credits && data.credits.endText) || '';
  const cr = (data && data.credits) || {};
  const t8 = el('credits-show-top8'); if (t8) t8.checked = cr.showTop8 !== false;
  const ac = el('credits-show-activity'); if (ac) ac.checked = cr.showActivity !== false;
  const list = el('cs-list'); if (!list) return;
  const sponsors = (data && data.credits && Array.isArray(data.credits.sponsors)) ? data.credits.sponsors : csSponsors();
  const sig = JSON.stringify(sponsors);
  if (list.dataset.sig === sig) return;   // no change → don't rebuild
  list.dataset.sig = sig;
  list.innerHTML = sponsors.length ? '' : '<div style="font-size:11px;color:var(--muted);">No credit sponsors added.</div>';
  sponsors.forEach((s, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:6px;';
    row.innerHTML =
      (s.logo ? `<img src="${s.logo}" alt="" style="height:22px;max-width:48px;object-fit:contain;flex:0 0 auto;">` : '<span style="width:22px;height:22px;flex:0 0 auto;"></span>')
      + `<span style="flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${poEsc(s.name || '(logo only)')}${s.tier ? ` <span style="color:var(--muted);font-weight:500;">· ${poEsc(s.tier)}</span>` : ''}</span>`
      + '<button class="btn btn-ghost btn-xs cs-del" style="flex:0 0 auto;">Remove</button>';
    row.querySelector('.cs-del').addEventListener('click', () => { const next = csSponsors().slice(); next.splice(i, 1); csSave(next); });
    list.appendChild(row);
  });
}
el('cs-logo-btn')?.addEventListener('click', () => el('cs-logo-file')?.click());
el('cs-logo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f) return;
  // Optimize (downscale + WebP) — this logo rides the live credits broadcast, so keep it tiny.
  try { _csPendingLogo = (await fileToBase64(f)) || ''; } catch (_) { _csPendingLogo = ''; }
  const n = el('cs-logo-name'); if (n) n.textContent = f.name;
});
el('cs-add')?.addEventListener('click', () => {
  const name = (el('cs-name')?.value || '').trim();
  const tier = (el('cs-tier')?.value || '').trim();
  if (!name && !_csPendingLogo) { showToast('Add a name or a logo', '#fbbf24'); return; }
  const next = csSponsors().slice();
  next.push({ name, tier, logo: _csPendingLogo });
  csSave(next);
  _csPendingLogo = '';
  if (el('cs-name')) el('cs-name').value = '';
  if (el('cs-tier')) el('cs-tier').value = '';
  if (el('cs-logo-name')) el('cs-logo-name').textContent = 'No logo';
  if (el('cs-logo-file')) el('cs-logo-file').value = '';
});
el('credits-show-top8')?.addEventListener('change', function () { send('set_credits', { showTop8: this.checked }); });
el('credits-show-activity')?.addEventListener('change', function () { send('set_credits', { showActivity: this.checked }); });
// End-card text — debounced live edit (blank → overlay shows "Thanks For Watching").
let _credEndT;
el('credits-endtext')?.addEventListener('input', function () {
  clearTimeout(_credEndT);
  const v = this.value;
  _credEndT = setTimeout(() => send('set_credits', { endText: v }), 300);
});
