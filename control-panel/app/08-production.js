// Control panel, part 8 of 17: Production: veto, drafts, hero bans, scenes cockpit, scene wash and editor, what is armed.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

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
let _casterLibSearch = '';

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

  // Fixed CASTER 1–4 slots. Each slot keeps its own dedicated webcam link; change the caster
  // (name/social) on a slot to swap who's on that cam. Empty slots simply don't air.
  for (let slot = 1; slot <= 4; slot++) {
    let c = castersDraft.find((x) => Number(x.slot) === slot);
    if (!c) { c = { id: makeCasterId(), name: '', handle: '', camUrl: '', slot, social: 'none' }; castersDraft.push(c); }

    const card = document.createElement('div');
    card.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:10px;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;';
    const title = document.createElement('span');
    title.textContent = 'CASTER ' + slot;
    title.style.cssText = 'font-size:12px; font-weight:800; letter-spacing:.08em; color:var(--cp-accent);';
    const tools = document.createElement('div');
    tools.style.cssText = 'display:flex; gap:6px; align-items:center;';
    // Load a saved caster into this slot.
    const lib = (currentState.casters && currentState.casters.library) || [];
    const loadSel = document.createElement('select');
    loadSel.className = 'input-select'; loadSel.style.cssText = 'font-size:11px; padding:3px 6px; max-width:150px;';
    loadSel.innerHTML = '<option value="">Load saved…</option>' +
      lib.map((p) => `<option value="${p.id}">${(p.name || p.handle || 'caster').replace(/</g, '&lt;')}</option>`).join('');
    loadSel.addEventListener('change', () => {
      const p = lib.find((x) => x.id === loadSel.value); loadSel.value = '';
      if (!p) return;
      c.name = p.name || ''; c.handle = p.handle || ''; c.social = p.social || 'none';
      if (p.camUrl) c.camUrl = p.camUrl;
      renderCasterRows(); saveCasters();
    });
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-ghost btn-xs'; saveBtn.innerHTML = '<svg class="svg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Save'; saveBtn.title = 'Save this caster to the library for reuse';
    saveBtn.addEventListener('click', () => {
      if (!(c.name || c.handle || c.camUrl)) return;
      send('save_caster_to_library', { name: c.name, handle: c.handle, social: c.social, camUrl: c.camUrl, slot: c.slot });
    });
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-ghost btn-xs';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Empty this slot';
    clearBtn.addEventListener('click', () => { c.name = ''; c.handle = ''; c.camUrl = ''; c.social = 'none'; renderCasterRows(); saveCasters(); });
    tools.append(loadSel, saveBtn, clearBtn);
    head.appendChild(title); head.appendChild(tools);

    // Dedicated webcam link for this slot (add it as its OWN OBS browser source for per-caster audio).
    const camRow = document.createElement('div');
    camRow.style.cssText = 'margin-bottom:8px;';
    const camLbl = document.createElement('label');
    camLbl.className = 'field-label'; camLbl.style.cssText = 'display:block; margin-bottom:3px;';
    camLbl.textContent = 'Dedicated webcam link (its own OBS source → per-caster audio)';
    const camWrap = document.createElement('div'); camWrap.style.cssText = 'display:flex; gap:5px;';
    const camInp = document.createElement('input');
    camInp.type = 'text'; camInp.className = 'input-text'; camInp.style.flex = '1';
    camInp.placeholder = 'vdo.ninja / browser-source URL for this slot';
    camInp.value = c.camUrl || '';
    camInp.addEventListener('input', () => { c.camUrl = camInp.value; });
    camInp.addEventListener('change', saveCasters);   // tie the link to this slot the moment it's set
    const camCopy = document.createElement('button');
    camCopy.className = 'btn btn-ghost btn-xs'; camCopy.textContent = 'Copy'; camCopy.title = 'Copy this cam URL to add as its own OBS browser source';
    camCopy.addEventListener('click', () => { if (c.camUrl) copyText(c.camUrl, camCopy); });
    camWrap.append(camInp, camCopy);
    camRow.appendChild(camLbl); camRow.appendChild(camWrap);

    // Who's on this cam — name + social + handle.
    const line = document.createElement('div');
    line.style.cssText = 'display:grid; grid-template-columns:1fr 150px 1fr; gap:8px; align-items:center;';
    const nameInp = document.createElement('input');
    nameInp.type = 'text'; nameInp.className = 'input-text'; nameInp.placeholder = 'Caster name'; nameInp.maxLength = 40;
    nameInp.value = c.name || '';
    nameInp.addEventListener('input', () => { c.name = nameInp.value; });
    nameInp.addEventListener('change', saveCasters);
    const socialSel = document.createElement('select');
    socialSel.className = 'input-select';
    CASTER_SOCIAL_OPTIONS.forEach((opt) => { const o = document.createElement('option'); o.value = opt.value; o.textContent = opt.label; socialSel.appendChild(o); });
    socialSel.value = c.social || 'none';
    socialSel.addEventListener('change', () => { c.social = socialSel.value; saveCasters(); });
    const handleInp = document.createElement('input');
    handleInp.type = 'text'; handleInp.className = 'input-text'; handleInp.placeholder = 'Handle (optional)'; handleInp.maxLength = 80;
    handleInp.value = c.handle || '';
    handleInp.addEventListener('input', () => { c.handle = handleInp.value; });
    handleInp.addEventListener('change', saveCasters);
    line.appendChild(nameInp); line.appendChild(socialSel); line.appendChild(handleInp);

    card.appendChild(head); card.appendChild(camRow); card.appendChild(line);
    wrap.appendChild(card);
  }

  const addBtn = el('btn-add-caster');
  if (addBtn) addBtn.style.display = 'none';   // fixed 4 slots — no add/remove
}

// Caster library — searchable compact list. Each entry shows name, handle, saved slot, and load/delete actions.
function renderCasterLibrary(library) {
  const wrap = el('casters-library');
  const box = el('casters-library-wrap');
  const labelEl = el('casters-library-label');
  if (!wrap || !box) return;
  library = Array.isArray(library) ? library : [];
  box.style.display = library.length ? '' : 'none';
  if (!library.length) return;

  const filtered = NESearch.filter(library, _casterLibSearch.trim(), (p) => [
    { text: p.name, weight: 2 }, { text: p.handle, weight: 1.5 }, p.role, p.kind, p.country
  ]);

  if (labelEl) labelEl.textContent = `Caster Library (${library.length})`;

  wrap.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No casters match "' + _casterLibSearch + '".';
    empty.style.cssText = 'font-size:12px; color:var(--muted); margin:4px 0;';
    wrap.appendChild(empty);
    return;
  }

  const PLATFORM_LABELS = { x: 'X/Twitter', twitch: 'Twitch', youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', discord: 'Discord', facebook: 'Facebook', kick: 'Kick', other: 'Link' };

  filtered.forEach(p => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 8px; background:var(--surface2); border:1px solid var(--border); border-radius:6px;';

    // Name + handle + platform
    const info = document.createElement('div');
    info.style.cssText = 'flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;';
    const nameStr = (p.name || p.handle || 'Caster').replace(/</g, '&lt;');
    const sub = [p.handle, p.social && p.social !== 'none' ? PLATFORM_LABELS[p.social] || p.social : ''].filter(Boolean).join(' · ');
    info.innerHTML = `<span style="font-size:12px; font-weight:700; color:#fff;">${nameStr}</span>`
      + (sub ? `<span style="font-size:11px; color:var(--muted); margin-left:6px;">${sub.replace(/</g, '&lt;')}</span>` : '');

    // Slot badge
    const savedSlot = Number(p.slot);
    if (savedSlot >= 1 && savedSlot <= 4) {
      const badge = document.createElement('span');
      badge.textContent = 'Slot ' + savedSlot;
      badge.style.cssText = 'font-size:10px; font-weight:700; padding:2px 7px; background:rgba(232,58,139,.15); color:var(--cp-accent); border-radius:10px; flex:0 0 auto;';
      row.appendChild(info);
      row.appendChild(badge);
    } else {
      row.appendChild(info);
    }

    // Load button — goes to saved slot or first available
    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn btn-ghost btn-xs';
    loadBtn.textContent = savedSlot >= 1 ? `→ Slot ${savedSlot}` : 'Load';
    loadBtn.title = savedSlot >= 1 ? `Load into Slot ${savedSlot}` : 'Load into first available slot';
    loadBtn.addEventListener('click', () => {
      const targetSlot = (savedSlot >= 1 && savedSlot <= 4) ? savedSlot : nextCasterSlot();
      let c = castersDraft.find(x => Number(x.slot) === targetSlot);
      if (!c) { c = { id: makeCasterId(), name: '', handle: '', camUrl: '', slot: targetSlot, social: 'none' }; castersDraft.push(c); }
      c.name = p.name || '';
      c.handle = p.handle || '';
      c.social = p.social || 'none';
      if (p.camUrl) c.camUrl = p.camUrl;
      renderCasterRows();
      saveCasters();
    });

    // Delete
    const del = document.createElement('button');
    del.textContent = '✕'; del.title = 'Remove from library';
    del.style.cssText = 'border:0; background:none; color:#f56565; cursor:pointer; font-size:13px; padding:0 2px; flex:0 0 auto;';
    del.addEventListener('click', () => {
      appConfirm(`Remove ${p.name || 'this caster'} from the library?`, 'Remove', true).then((ok) => {
        if (ok) send('delete_caster_from_library', { id: p.id });
      });
    });

    row.appendChild(loadBtn);
    row.appendChild(del);
    wrap.appendChild(row);
  });
}

// Debounced: this re-renders the whole library on every keystroke.
NESearch.bindBox(el('caster-lib-search'), (q) => {
  _casterLibSearch = q;
  renderCasterLibrary((currentState.casters && currentState.casters.library) || []);
});

el('btn-add-caster')?.addEventListener('click', () => {
  if (castersDraft.length >= 4) return;
  castersDraft.push({
    id: makeCasterId(), name: '', handle: '', camUrl: '',
    slot: nextCasterSlot(), social: 'none'
  });
  renderCasterRows();
});

function saveCasters() {
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
}
el('btn-apply-casters')?.addEventListener('click', saveCasters);
// The desk footer's Apply sets ONLY the lower-third text; the casters on the desk come from Talent.
el('btn-apply-casters-footer')?.addEventListener('click', () => {
  send('set_casters', { lowerThird: (el('input-caster-lower-third')?.value || castersLowerThirdDraft || '').trim() });
});

// Dashboard ▸ Game Settings is driven by games-hub.js (GamesHub.onState).

el('check-casters-visible')?.addEventListener('change', function() {
  send('set_casters_visibility', { visible: this.checked });
});

// ── Production: Break / Starting Soon ───────────────────────────────────────
// Fill a <select> with OBS scene names (first option = "none"). Skips rebuilds when nothing
// changed and never clobbers the dropdown while the producer is mid-selection.
function fillSceneSelect(sel, scenes, current, firstLabel) {
  if (!sel || document.activeElement === sel) return;
  firstLabel = firstLabel || '— None —';   // callers without a label used to hit the (shadowing) OBS variant, which showed this
  const cur = current || '';
  const sig = (scenes || []).join('|') + '||' + cur + '||' + firstLabel;
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  sel.innerHTML = `<option value="">${esc(firstLabel)}</option>` +
    (scenes || []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  sel.value = cur;
}
function getBreakTitle() {
  const preset = el('select-break-preset')?.value || 'STARTING SOON';
  if (preset === '__none__') return '';   // explicit blank → overlay shows the timer with no top text
  if (preset === '__custom__') {
    return (el('input-break-title')?.value || '').trim() || 'STARTING SOON';
  }
  return preset;
}

el('select-break-preset')?.addEventListener('change', function() {
  const customRow = el('break-custom-title-row');
  if (customRow) customRow.style.display = this.value === '__custom__' ? '' : 'none';
});

gfxAction('show', 'break', () => {
  send('set_break', {
    visible: true,
    title: getBreakTitle(),
    message: (el('input-break-message')?.value || '').trim(),
    // minutes -> seconds; 0 = no live countdown (title/message only)
    seconds: Math.round((parseFloat(el('input-break-minutes')?.value) || 0) * 60),
    thenScene: el('select-break-thenscene')?.value || ''
  });
}, 'btn-show-break');

el('btn-update-break')?.addEventListener('click', () => {
  // Update text without touching the running countdown
  send('set_break', {
    title: getBreakTitle(),
    message: (el('input-break-message')?.value || '').trim()
  });
});

gfxAction('hide', 'break', () => {
  send('set_break', { visible: false });
}, 'btn-hide-break');

// ── Production: Winner / Post-match ─────────────────────────────────────────
el('select-winner-side')?.addEventListener('change', function() {
  if (window._winnerAuto) window._winnerAuto.sideManual = true;   // producer chose a side → stop auto-picking the winner
  const row = el('winner-custom-row');
  if (row) row.style.display = this.value === '__custom__' ? '' : 'none';
  // (the live preview push is wired on this same change event inside the Graphics block)
});
function winnerPayload(visible) {
  const sel = el('select-winner-side')?.value || 'blue';
  const isSide = sel === 'blue' || sel === 'orange';
  // Fall back to the auto-suggested series score if the producer left the subtitle empty.
  const subtitle = (el('input-winner-subtitle')?.value || '').trim()
    || (window._winnerSeriesScore ? window._winnerSeriesScore(currentState, isSide ? sel : '') : '');
  if (isSide) return { visible, side: sel, name: '', subtitle };
  return { visible, side: '', name: window._winnerNameFromSel ? window._winnerNameFromSel(sel) : '', subtitle };
}
gfxAction('show', 'winner', () => send('set_winner', winnerPayload(true)), 'btn-show-winner');
gfxAction('hide', 'winner', () => {
  if (window._winnerAuto) window._winnerAuto = { sideManual: false, subTouched: false, lastScore: '' };   // re-arm for next match
  send('set_winner', { visible: false });
}, 'btn-hide-winner');

// ── Production: Stream Credits — no config, just visibility ─────────────────
gfxAction('show', 'credits', () => send('set_credits', { visible: true }), 'btn-show-credits');
gfxAction('hide', 'credits', () => send('set_credits', { visible: false }), 'btn-hide-credits');

// ── Production: Team Line-up / Intro ────────────────────────────────────────
function introPayload(visible) {
  return {
    visible,
    side: el('select-intro-side')?.value || 'blue',
    title: (el('input-intro-title')?.value || '').trim(),
    showFooter: el('check-intro-footer') ? !!el('check-intro-footer').checked : false,
    showRealName: el('check-intro-realname') ? !!el('check-intro-realname').checked : false,
    showBench: el('check-intro-bench') ? !!el('check-intro-bench').checked : true
  };
}
gfxAction('show', 'intro', () => send('set_intro', introPayload(true)), 'btn-show-intro');
gfxAction('hide', 'intro', () => send('set_intro', { visible: false }), 'btn-hide-intro');

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
// Which stage tier each game's veto strikes from, once the producer has picked one. Kept here
// rather than on the <select> because that element is rebuilt on every game change.
const _vetoTierPick = {};
el('btn-veto-start')?.addEventListener('click', () => {
  send('veto_start', {
    game: el('veto-game')?.value || '',
    bestOf: Number(el('veto-bestof')?.value || 3),
    teamStart: el('veto-start')?.value || 'a',
    // '' / 'all' = strike the whole pool. Which stages a ruleset strikes from differs event to
    // event, so this rides with the veto rather than being fixed per game.
    strikeFrom: el('veto-tier')?.value || '',
    visible: true
  });
});
el('veto-game')?.addEventListener('change', () => renderVetoManager(currentState));
el('veto-tier')?.addEventListener('change', function () {
  // Keyed by game so a Smash strike set never carries onto another game's pool.
  const g = el('veto-game')?.value || (currentState && currentState.activeGame) || '';
  if (g) _vetoTierPick[g] = this.value;
  renderVetoManager(currentState);
});
el('btn-veto-undo')?.addEventListener('click', () => send('veto_undo', {}));
el('btn-veto-reset')?.addEventListener('click', () => {
  appConfirm('Reset the map veto? Every pick and ban made so far will be wiped and cannot be recovered.', 'Reset', true).then((ok) => {
    if (ok) send('veto_reset', {});
  });
});
el('btn-veto-show')?.addEventListener('click', () => send('veto_visible', { visible: true }));
el('btn-veto-hide2')?.addEventListener('click', () => send('veto_visible', { visible: false }));

// Import a played veto from a FACEIT room or HLTV match link: fetch → preview → apply. The
// preview is shown before anything changes so a wrong link never overwrites the board.
let _vetoImport = null;
const VETO_API_BASE = location.protocol === 'file:' ? 'http://127.0.0.1:3000' : '';
async function vetoImportFetch() {
  const url = (el('veto-import-url')?.value || '').trim();
  const box = el('veto-import-preview'); if (!box) return;
  const h = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  box.hidden = false;
  if (!url) { box.innerHTML = '<span class="vm-imp-err">Paste a FACEIT room or HLTV match link first.</span>'; return; }
  box.textContent = /^https?:\/\//i.test(url) || /faceit\.com|hltv\.org/i.test(url) ? 'Fetching the match…' : 'Reading the veto…';
  try {
    const r = await fetch(`${VETO_API_BASE}/api/veto/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const j = await r.json();
    if (!j.ok) {
      // HLTV: the page cannot be fetched from here, so hand the producer the page to copy from.
      box.innerHTML = `<span class="vm-imp-err">${h(j.error || 'Import failed')}</span>` + (j.openUrl ? ` <a href="${h(j.openUrl)}" target="_blank" rel="noopener" class="btn btn-ghost btn-xs" style="margin-left:8px;">Open the HLTV page</a>` : '');
      return;
    }
    _vetoImport = j;
    const word = { ban: 'banned', pick: 'picked' };
    const teams = Array.isArray(j.teams) ? j.teams : [];
    box.innerHTML = `<div class="vm-imp-head"><b>${h(teams.map((tm) => tm.name || '?').join(' vs '))}</b><span>Best of ${h(j.bestOf)} · ${j.source === 'hltv' ? 'HLTV' : j.source === 'pasted' ? 'pasted veto' : 'FACEIT'}${j.results && j.results.length ? ' · ' + j.results.length + ' map result' + (j.results.length === 1 ? '' : 's') : ''}</span></div>
      <ol class="vm-imp-steps">${j.steps.map((s) => `<li>${s.action === 'decider' ? h(s.map) + ' left over' : h((teams[s.by] || {}).name || '?') + ' ' + (word[s.action] || s.action) + ' ' + h(s.map)}</li>`).join('')}</ol>
      <div class="vm-actions">
        <button class="btn btn-primary btn-sm" data-vimp="teams" title="Set the match teams, best-of and the veto board">Apply teams and veto</button>
        <button class="btn btn-secondary btn-sm" data-vimp="veto" title="Load only the veto board, keep the current teams">Veto only</button>
        <button class="btn btn-ghost btn-sm" data-vimp="cancel">Cancel</button>
      </div>`;
  } catch (e) { box.innerHTML = `<span class="vm-imp-err">${h(e.message || e)}</span>`; }
}
el('btn-veto-import')?.addEventListener('click', vetoImportFetch);
el('veto-import-url')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); vetoImportFetch(); } });
el('veto-import-preview')?.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-vimp]'); if (!b) return;
  const box = el('veto-import-preview');
  if (b.dataset.vimp === 'cancel') { box.hidden = true; _vetoImport = null; return; }
  if (!_vetoImport) return;
  b.disabled = true;
  try {
    const r = await fetch(`${VETO_API_BASE}/api/veto/import/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ import: _vetoImport, applyTeams: b.dataset.vimp === 'teams' }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Apply failed');
    box.hidden = true; _vetoImport = null;
    const inp = el('veto-import-url'); if (inp) inp.value = '';
    if (typeof showToast === 'function') showToast('Veto imported' + (b.dataset.vimp === 'teams' ? ' with the teams' : '') + '.', '#22c55e', 2500);
  } catch (err) { b.disabled = false; if (typeof showToast === 'function') showToast(String(err.message || err), '#f59e0b', 3500); }
});

// Game-mode icons — m.mode carries the pool entry's type (Overwatch: Control/Hybrid/Escort/Push/
// Flashpoint/Clash; Rocket League: Standard/Hoops/Dropshot/Snow Day/Rumble/Heatseeker/Spike Rush).
// Other games' mode strings have no matching icon, so no badge shows for them.
// Same table the mapscreen overlay uses (overlay/mapscreen.html MODE_IMG) — keep them in sync.
// 'soccar' stays mapped alongside 'standard': it's the mode's in-game file name, so it can still
// arrive from a board saved before the rename or an imported Game Config.
const VM_MODE_IMG = {
  control: '/assets/overwatch/modes/Control.webp', hybrid: '/assets/overwatch/modes/Hybrid.webp',
  escort: '/assets/overwatch/modes/Escort.webp', push: '/assets/overwatch/modes/Push.webp',
  flashpoint: '/assets/overwatch/modes/Flashpoint.webp', clash: '/assets/overwatch/modes/Clash.webp',
  assault: '/assets/overwatch/modes/Assault.webp',
  standard: '/assets/rocket-league/modes/soccar.svg', soccar: '/assets/rocket-league/modes/soccar.svg',
  hoops: '/assets/rocket-league/modes/hoops.svg',
  dropshot: '/assets/rocket-league/modes/dropshot.svg', 'snow day': '/assets/rocket-league/modes/snow-day.svg',
  rumble: '/assets/rocket-league/modes/rumble.svg', heatseeker: '/assets/rocket-league/modes/heatseeker.svg',
  'spike rush': '/assets/rocket-league/modes/spike-rush.svg'
};
// Reachable from the Map Pool editor IIFE (which is defined earlier in the file).
window._vmModeImg = VM_MODE_IMG;
// Panel runs from file://, so a root-absolute '/assets/…' resolves to C:\assets and 404s forever.
// Same base the Map Pool editor uses (MP_ASSET_BASE).
const VM_ASSET_BASE = location.protocol === 'file:' ? 'http://127.0.0.1:3000' : '';
const vmAsset = (p) => (p && p.startsWith('/') ? VM_ASSET_BASE + p : p || '');

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
  // "Strike from" — only shown when the selected game's pool actually defines tiers (Smash's
  // Starter/Counterpick). Every event runs a different ruleset, so the default from VETO_META is
  // just the pre-selection; an event with no ban phase simply never starts a veto at all.
  const tierSel = el('veto-tier');
  if (tierSel) {
    const tiers = [];
    (pools[selGame] || []).forEach((m) => { if (m && m.tier && !tiers.includes(m.tier)) tiers.push(m.tier); });
    const unit = ((data.vetoMeta || {})[selGame] || {}).unit || 'map';
    const sig = selGame + '|' + tiers.join(',');
    if (tierSel.dataset.sig !== sig) {
      tierSel.dataset.sig = sig;
      // The pick is remembered per GAME in _vetoTierPick, never read back off the select: the
      // element is rebuilt whenever the game changes, so switching to a game with no tiers and
      // back left it holding that game's lone "All" option — silently turning a deliberate
      // "Counterpicks only" into a strike through the whole pool.
      const chosen = _vetoTierPick[selGame] || '';
      // "Starters only" / "Reserves only" — but "Active Duty only", not "Active Dutys".
      tierSel.innerHTML = tiers.map((t) => `<option value="${tlEsc(t)}">${tlEsc(t)}${/y$/i.test(t) ? '' : 's'} only</option>`).join('')
        + `<option value="all">All ${tlEsc(unit)}s</option>`;
      const dflt = ((data.vetoMeta || {})[selGame] || {}).strikeFrom || 'all';
      const has = (v) => !!v && [...tierSel.options].some((o) => o.value === v);
      tierSel.value = has(chosen) ? chosen : (has(dflt) ? dflt : 'all');
    }
    tierSel.title = 'Which ' + unit + 's this veto ' + (((data.vetoMeta || {})[selGame] || {}).banWord || 'Ban').toLowerCase() + 's from';
    tierSel.style.display = tiers.length ? '' : 'none';
  }
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

  // No guided sequence running → pull in whatever's already been entered on the Map Pool front
  // card (or the manual text box) so opening this popup doesn't just show a blank prompt and
  // hide the producer's work. These cards are read-only (no ban/pick sequence to click through);
  // Start Veto still runs a fresh guided board on top if that's what's actually wanted.
  if (!Array.isArray(v.pool) || !v.pool.length) {
    const manualMaps = Array.isArray(v.maps) ? v.maps.filter((m) => m && m.name) : [];
    if (manualMaps.length) {
      if (turnEl) turnEl.innerHTML = 'Showing the maps entered on the <b>Map Pool</b> front card. Edit them there, or click <b>Start Veto</b> above to run a fresh guided ban/pick instead.';
      // Signature-guarded like the guided-veto grid below: this branch used to tear down and
      // rebuild every card (and every <img> inside it) on EVERY full_state, which reloaded the
      // map/mode images continuously and kept the renderer thrashing for a whole show.
      if (grid) {
        const msig = JSON.stringify(manualMaps.map(m => [m.name, m.image, m.mode, m.by, m.action, m.score && m.score.a, m.score && m.score.b]))
          + '|' + blue + '|' + orange;
        if (grid.dataset.sig !== msig) {
          grid.dataset.sig = msig;
          grid.innerHTML = '';
          manualMaps.forEach((m) => {
          const card = document.createElement('div');
          card.className = 'vm-map' + (m.action === 'decider' ? ' decider' : ' picked');
          card.style.cursor = 'default';
          if (m.image) { const img = document.createElement('img'); img.src = vmAsset(m.image); img.alt = ''; card.appendChild(img); }
          const modeIcon = VM_MODE_IMG[(m.mode || '').toLowerCase().trim()];
          if (modeIcon) {
            const badge = document.createElement('span'); badge.className = 'vm-mode'; badge.title = m.mode;
            const mi = document.createElement('img'); mi.src = vmAsset(modeIcon); mi.alt = m.mode;
            mi.onerror = () => badge.remove();
            badge.appendChild(mi); card.appendChild(badge);
          }
          if (m.by && m.action !== 'decider') {
            const by = document.createElement('span'); by.className = 'vm-by';
            by.textContent = sideName(m.by); by.style.background = sideColor(m.by); by.style.color = teamInk(sideColor(m.by)); card.appendChild(by);
          }
          const lbl = document.createElement('div'); lbl.className = 'vm-label';
          const extra = m.action === 'decider' ? ' · DECIDER' : (m.score && (m.score.a || m.score.b)) ? ` · ${m.score.a}-${m.score.b}` : '';
          lbl.textContent = m.name + extra;
          card.appendChild(lbl);
          grid.appendChild(card);
          });
        }
      }
    } else {
      if (turnEl) turnEl.textContent = 'Choose a game + best-of, then Start Veto.';
      if (grid) grid.innerHTML = '';
    }
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
        if (m.image) { const img = document.createElement('img'); img.src = vmAsset(m.image); img.alt = ''; card.appendChild(img); }
        const modeIcon = VM_MODE_IMG[(m.mode || '').toLowerCase().trim()];
        if (modeIcon) {
          const badge = document.createElement('span'); badge.className = 'vm-mode'; badge.title = m.mode;
          const mi = document.createElement('img'); mi.src = vmAsset(modeIcon); mi.alt = m.mode;
          mi.onerror = () => badge.remove();
          badge.appendChild(mi); card.appendChild(badge);
        }
        if (m.by && (m.action === 'pick' || m.action === 'ban')) {
          const by = document.createElement('span'); by.className = 'vm-by';
          by.textContent = sideName(m.by); by.style.background = sideColor(m.by); by.style.color = teamInk(sideColor(m.by)); card.appendChild(by);
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

// ── Guided champion/hero Pick & Ban draft manager ────────────────────────────

function submitDraftPick(inputId) {
  const inp = el(inputId || 'draft-input'); if (!inp) return;
  const name = (inp.value || '').trim(); if (!name) return;
  send('draft_action', { name }); inp.value = '';
}
el('btn-draft-start')?.addEventListener('click', () => {
  send('draft_start', { game: el('draft-game')?.value || '', teamStart: el('draft-start')?.value || 'a', visible: true });
  // draft_start only sets state.draft — gfx.html's layer-switcher only ever looks at gfxActive,
  // so without this the board fills in live but never actually appears on the pushed output.
  window._gfxDoPush && window._gfxDoPush('draft');
});
el('btn-draft-submit')?.addEventListener('click', () => submitDraftPick('draft-input'));
el('draft-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitDraftPick('draft-input'); } });
el('btn-draft-front-submit')?.addEventListener('click', () => submitDraftPick('draft-front-input'));
el('draft-front-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitDraftPick('draft-front-input'); } });
el('btn-draft-front-open')?.addEventListener('click', () => window._gfxOpenPopout && window._gfxOpenPopout('draft'));
el('btn-draft-front-undo')?.addEventListener('click', () => send('draft_undo', {}));
el('btn-draft-front-reset')?.addEventListener('click', () => {
  // Nothing to lose yet — just re-apply the settings, no confirm.
  if (!(currentState?.draft?.ops || []).length) { send('draft_reset', {}); return; }
  appConfirm('Reset pick / ban? Every pick and ban made on this map will be cleared.', 'Reset', true)
    .then((ok) => { if (ok) send('draft_reset', {}); });
});
// Front-card scene title / subtext — live-edit the draft overlay's header without a restart.
let _draftMetaT;
function _sendDraftMeta() {
  clearTimeout(_draftMetaT);
  _draftMetaT = setTimeout(() => send('set_draft_meta', {
    title: el('draft-front-title')?.value || '', subtitle: el('draft-front-subtitle')?.value || ''
  }), 300);
}
el('draft-front-title')?.addEventListener('input', _sendDraftMeta);
el('draft-front-subtitle')?.addEventListener('input', _sendDraftMeta);
// Overwatch hero-ban count — applies at once if no ban has been made yet; mid-draft it takes
// effect on Reset / the next Start Draft (the server rebuilds the ban slots then).
el('draft-front-owbans')?.addEventListener('change', () => send('set_draft_meta', { owBanCount: Number(el('draft-front-owbans')?.value) || 2 }));
el('btn-draft-undo')?.addEventListener('click', () => send('draft_undo', {}));
el('btn-draft-reset')?.addEventListener('click', () => {
  appConfirm('Reset the draft board? Every pick and ban made so far will be wiped and cannot be recovered.', 'Reset', true).then((ok) => {
    if (ok) send('draft_reset', {});
  });
});
// Hero bans on ANY map of the series (the map pool + HUD read owMatch.bansByMap, not just the live map).
function owSeriesHasBans(data) {
  return ((data && data.owMatch && data.owMatch.bansByMap) || []).some((entry) => {
    if (!entry) return false;
    return ['a', 'b'].some((side) => {
      const v = entry[side];
      return Array.isArray(v) ? v.some((x) => x && x.hero) : !!(v && v.hero);
    });
  });
}
// Clears hero bans on every map of the series — the map pool and HUD follow.
el('btn-draft-front-clear-all')?.addEventListener('click', () => {
  if (!owSeriesHasBans(currentState)) return;
  appConfirm('Clear the hero bans on every map of this series? The map pool and the HUD will be emptied too.', 'Clear all maps', true).then((ok) => {
    if (ok) send('draft_clear_all', {});
  });
});
el('btn-draft-show')?.addEventListener('click', () => send('draft_visible', { visible: true }));
el('btn-draft-hide')?.addEventListener('click', () => send('draft_visible', { visible: false }));
el('draft-game')?.addEventListener('change', () => renderDraftManager(currentState));
el('draft-auto')?.addEventListener('change', function () { send('lol_draft_auto', { enabled: this.checked }); });
// LoL champ-select automation status (off | no-client | connected | idle | drafting | error).
function draftAutoStatusText(status, detail) {
  const map = { off: '', 'no-client': '⚠ League client not detected', connected: 'Client connected', idle: 'Connected — waiting for champ select…', drafting: '● Drafting live', error: '⚠ Connection error' };
  const base = (map[status] != null) ? map[status] : (status || '');
  return base ? (detail ? base + ' · ' + detail : base) : '';
}
// Hero/champion filter. Fuzzy and ranked — mid-draft nobody has time to spell "Kai'Sa" or
// "Cho'Gath" exactly, and the best match belongs in the top-left cell, not wherever the roster
// order left it.
el('draft-search')?.addEventListener('input', function () {
  NESearch.rankNodes(document.querySelectorAll('#draft-grid .dm-hero'), this.value.trim(),
    (cell) => [cell.dataset.name || '']);
});

function renderDraftManager(data) {
  const sel = el('draft-game'); if (!sel) return;
  const dGames = data.draftGames || [];
  const games = data.games || {};

  // Populate game dropdown once — locked to the event's active game when it has a draft
  // format, so this popup only ever shows THAT game's board, not a pick-any-of-7-games menu.
  const locked = dGames.includes(data.activeGame);
  const _dgSig = dGames.join(',') + '::' + (locked ? data.activeGame : '');
  if (dGames.length && sel.dataset.draftGamesSig !== _dgSig) {
    const prev = sel.value;
    sel.innerHTML = '';
    const opts = locked ? [data.activeGame] : dGames;
    opts.forEach(g => { const o = document.createElement('option'); o.value = g; o.textContent = (games[g] && games[g].name) || g; sel.appendChild(o); });
    sel.disabled = locked;
    sel.title = locked ? "Locked to this event's active game" : 'Game (auto-follows app game)';
    sel.dataset.draftGamesSig = _dgSig;
    if (!locked && prev && dGames.includes(prev)) sel.value = prev;
  }

  const d = data.draft || {};
  const draftActive = Array.isArray(d.sequence) && d.sequence.length > 0;

  // Auto-follow active game when no draft is running
  if (!draftActive && dGames.includes(data.activeGame)) sel.value = data.activeGame;

  const selGame = sel.value || dGames[0] || '';

  // LoL champ-select automation toggle — only shown for League.
  const isLeague = selGame === 'league';
  const autoWrap = el('draft-auto-wrap'), autoChk = el('draft-auto'), autoStat = el('draft-auto-status');
  const auto = d.auto || {};
  if (autoWrap) autoWrap.style.display = isLeague ? '' : 'none';
  if (autoStat) autoStat.style.display = isLeague ? '' : 'none';
  if (autoChk && document.activeElement !== autoChk) autoChk.checked = !!auto.enabled;
  if (autoStat) autoStat.textContent = isLeague && auto.enabled ? draftAutoStatusText(auto.status, auto.statusDetail) : '';

  const blueColor   = (data.teams?.blue?.color)   || '#2f8dff';
  const orangeColor = (data.teams?.orange?.color)  || '#f0444e';
  const blueTeam    = (data.teams?.blue?.name)     || 'Blue';
  const orangeTeam  = (data.teams?.orange?.name)   || 'Orange';
  const sideColor   = (s) => s === 'b' ? orangeColor : blueColor;
  const sideName    = (s) => s === 'b' ? orangeTeam  : blueTeam;

  // Column headers
  const colAName = el('dm-col-a-name'); const colBName = el('dm-col-b-name');
  if (colAName) { colAName.textContent = blueTeam;   colAName.style.color = blueColor; }
  if (colBName) { colBName.textContent = orangeTeam; colBName.style.color = orangeColor; }

  // Side select labels
  const startSel = el('draft-start');
  if (startSel && startSel.options.length >= 2) {
    startSel.options[0].textContent = blueTeam   + ' goes first';
    startSel.options[1].textContent = orangeTeam + ' goes first';
    if (document.activeElement !== startSel) startSel.value = d.teamStart || 'a';
  }

  // Front card: scene title / subtext mirror state (don't clobber while typing).
  const dfTitle = el('draft-front-title'); if (dfTitle && document.activeElement !== dfTitle) dfTitle.value = d.title || '';
  const dfSub   = el('draft-front-subtitle'); if (dfSub && document.activeElement !== dfSub) dfSub.value = d.subtitle || '';

  // Overwatch-only hero-ban count selector (2 = one per team, 4 = two per team).
  const owBansRow = el('draft-front-owbans-row'), owBansSel = el('draft-front-owbans');
  const isOw = selGame === 'overwatch';
  if (owBansRow) owBansRow.style.display = isOw ? 'flex' : 'none';
  if (owBansSel && document.activeElement !== owBansSel) owBansSel.value = String(d.owBanCount === 4 ? 4 : 2);
  el('draft-front-owbans-seg')?.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('is-on', b.dataset.v === String(d.owBanCount === 4 ? 4 : 2)));

  // Board look. Ban-only games (Overwatch, Marvel Rivals) always use their own ban board, so the layout
  // choice is hidden there; the strip edge only matters when the strip is what goes on air.
  const lookLayout = ['strip', 'board'].includes(d.layout) ? d.layout : 'auto';
  const banOnlyGame = selGame === 'overwatch' || selGame === 'marvel-rivals';
  const stripOnAir = !banOnlyGame && (lookLayout === 'strip' || (lookLayout === 'auto' && ['dota2', 'mobile-legends', 'honor-of-kings'].includes(selGame)));
  const layoutRow = el('draft-front-layout-row'); if (layoutRow) layoutRow.style.display = banOnlyGame ? 'none' : '';
  const posRow = el('draft-front-pos-row'); if (posRow) posRow.style.display = stripOnAir ? '' : 'none';
  el('draft-front-layout-seg')?.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('is-on', b.dataset.v === lookLayout));
  el('draft-front-pos-seg')?.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('is-on', b.dataset.v === (d.stripPos === 'bottom' ? 'bottom' : 'top')));
  const clockSel = el('draft-front-clock');
  if (clockSel && document.activeElement !== clockSel) clockSel.value = String([0, 15, 20, 30, 45, 60, -1].includes(Number(d.turnSeconds)) ? Number(d.turnSeconds) : 0);

  // Typeahead datalist
  const dl = el('draft-champs');
  if (dl && dl.dataset.game !== selGame) {
    dl.dataset.game = selGame; dl.innerHTML = '';
    ((data.draftRosters && data.draftRosters[selGame]) || []).forEach(c => { const o = document.createElement('option'); o.value = c.name; dl.appendChild(o); });
  }

  // Turn banner
  const turnDot = el('draft-turn-dot'); const turnLbl = el('draft-turn');
  if (turnLbl) {
    if (!draftActive) {
      turnLbl.textContent = 'Choose a game and click Start Draft.';
      if (turnDot) turnDot.style.background = '#555';
    } else if (d.turn && d.turn.team) {
      const a = d.turn.action;
      const n = (d.ops || []).filter(o => o.by === d.turn.team && o.action === a).length + 1;
      const c = sideColor(d.turn.team);
      if (turnDot) turnDot.style.background = c;
      turnLbl.innerHTML = `<b style="color:${c}">${sideName(d.turn.team)}</b> to <span class="act-${a}">${a.toUpperCase()}</span> (${a} ${n})`;
    } else {
      if (turnDot) turnDot.style.background = '#ffd34d';
      turnLbl.innerHTML = '<span class="act-done">Draft complete!</span>';
    }
  }

  const inp = el('draft-input');
  if (inp) inp.disabled = !draftActive || !d.turn;

  // Active column highlight
  const colA = el('dm-col-a'); const colB = el('dm-col-b');
  if (colA) colA.classList.toggle('active-col', !!(draftActive && d.turn && d.turn.team === 'a'));
  if (colB) colB.classList.toggle('active-col', !!(draftActive && d.turn && d.turn.team === 'b'));

  // Board slots — rebuild when sequence/ops/turn/game changes
  const board = el('draft-board');
  if (board) {
    const sig = JSON.stringify({ seq: (d.sequence || []).map(s => s.by + s.action), ops: d.ops, turn: d.turn, game: selGame });
    if (board.dataset.sig !== sig) {
      board.dataset.sig = sig;
      ['a', 'b'].forEach(side => {
        const bansEl  = el('dm-bans-'  + side);
        const picksEl = el('dm-picks-' + side);
        if (!bansEl || !picksEl) return;
        const color     = sideColor(side);
        const banOps    = (d.ops || []).filter(o => o.by === side && o.action === 'ban');
        const pickOps   = (d.ops || []).filter(o => o.by === side && o.action === 'pick');
        const banTotal  = (d.sequence || []).filter(s => s.by === side && s.action === 'ban').length;
        const pickTotal = (d.sequence || []).filter(s => s.by === side && s.action === 'pick').length;
        const turnHere  = draftActive && d.turn && d.turn.team === side;

        // Ban row (thumbnail squares with greyscale + red tint when filled)
        bansEl.innerHTML = '';
        for (let i = 0; i < banTotal; i++) {
          const op = banOps[i];
          const isActive = turnHere && d.turn.action === 'ban' && i === banOps.length;
          const slot = document.createElement('div');
          slot.className = 'dm-ban-slot' + (op ? ' filled' : '') + (isActive ? ' slot-active' : '');
          slot.title = op ? op.name : '';
          if (op && op.image) { const img = document.createElement('img'); img.src = 'http://127.0.0.1:3000' + op.image; img.alt = op.name; slot.appendChild(img); }
          bansEl.appendChild(slot);
        }

        // Pick column (portrait rows with team colour accent)
        picksEl.innerHTML = '';
        for (let i = 0; i < pickTotal; i++) {
          const op = pickOps[i];
          const isActive = turnHere && d.turn.action === 'pick' && i === pickOps.length;
          const slot = document.createElement('div');
          slot.className = 'dm-pick-slot' + (op ? '' : ' empty') + (isActive ? ' slot-active' : '');
          const accent = document.createElement('div'); accent.className = 'dm-pick-accent'; accent.style.background = op ? color : 'transparent';
          slot.appendChild(accent);
          if (op && op.image) { const img = document.createElement('img'); img.src = 'http://127.0.0.1:3000' + op.image; img.alt = op.name || ''; slot.appendChild(img); }
          const nm = document.createElement('div'); nm.className = 'dp-name'; nm.textContent = op ? op.name : (isActive ? 'selecting…' : '');
          slot.appendChild(nm);
          picksEl.appendChild(slot);
        }
      });
    }
  }

  renderDraftGrid(data, selGame, d, draftActive);
}

function renderDraftGrid(data, selGame, d, active) {
  const grid = el('draft-grid'); if (!grid) return;
  const roster = (data.draftRosters && data.draftRosters[selGame]) || [];
  const search = el('draft-search');
  if (grid.dataset.game !== selGame) {
    grid.dataset.game = selGame; grid.innerHTML = '';
    roster.forEach((c) => {
      const cell = document.createElement('div');
      cell.className = 'dm-hero' + (c.image ? '' : ' no-img');
      cell.dataset.name = c.name.toLowerCase(); cell.title = c.name;
      if (c.image) { const img = document.createElement('img'); img.src = 'http://127.0.0.1:3000' + c.image; img.alt = ''; img.loading = 'lazy'; cell.appendChild(img); }
      const nm = document.createElement('div'); nm.className = 'dm-hero-nm'; nm.textContent = c.name; cell.appendChild(nm);
      cell.addEventListener('click', () => { if (!cell.classList.contains('used') && !grid.classList.contains('disabled')) send('draft_action', { name: c.name }); });
      grid.appendChild(cell);
    });
    if (search) search.value = '';
  }
  if (search) search.style.display = roster.length ? '' : 'none';
  const used = new Set((d.ops || []).map((o) => (o.name || '').toLowerCase()));
  grid.querySelectorAll('.dm-hero').forEach((cell) => cell.classList.toggle('used', used.has(cell.dataset.name)));
  grid.classList.toggle('disabled', !(active && d.turn));
}

// Overwatch front-card ban board — the 4-slot snake order (A,B,B,A) + type-to-ban, live on the
// main Graphics panel so a producer never has to open the full popout just to run hero bans.
function renderOwFrontBoard(data, d) {
  const blueColor = (data.teams?.blue?.color) || '#2f8dff';
  const orangeColor = (data.teams?.orange?.color) || '#f0444e';
  const blueTeam = (data.teams?.blue?.name) || 'Blue';
  const orangeTeam = (data.teams?.orange?.name) || 'Orange';
  const sideColor = (s) => s === 'b' ? orangeColor : blueColor;
  const sideName = (s) => s === 'b' ? orangeTeam : blueTeam;

  const turnEl = el('dm-front-ow-turn');
  if (turnEl) {
    if (d.turn && d.turn.team) {
      const c = sideColor(d.turn.team);
      turnEl.className = 'dm-front-ow-turn is-live';
      turnEl.style.setProperty('--tc', c);
      turnEl.innerHTML = `<span class="pb-turn-dot"></span><b>${tlEsc(sideName(d.turn.team))}</b> is banning`;
    } else {
      turnEl.className = 'dm-front-ow-turn is-done';
      turnEl.style.removeProperty('--tc');
      turnEl.innerHTML = 'Bans locked in';
    }
  }

  // Two team columns (blue left, orange right), each listing that team's ban slots in order.
  // ops[i] fills sequence[i], so the index is carried through to find each slot's hero.
  const slotsEl = el('dm-front-ow-slots');
  if (slotsEl) {
    const sig = JSON.stringify({ seq: (d.sequence || []).map((s) => s.by + s.action), ops: d.ops, turn: d.turn, n: [blueTeam, orangeTeam, blueColor, orangeColor] });
    if (slotsEl.dataset.sig !== sig) {
      slotsEl.dataset.sig = sig;
      const ops = d.ops || [];
      const col = (side) => {
        const steps = (d.sequence || []).map((step, i) => ({ step, i })).filter((x) => x.step.by === side);
        const slots = steps.map(({ i }, k) => {
          const op = ops[i];
          const isActive = !op && !!d.turn && ops.length === i;
          const img = op && op.image ? `<img src="http://127.0.0.1:3000${tlEsc(op.image)}" alt="" onerror="this.style.visibility='hidden'">` : '<span class="pb-slot-ph"></span>';
          const name = op ? tlEsc(op.name) : (isActive ? 'Banning…' : (steps.length > 1 ? 'Ban ' + (k + 1) : 'Ban'));
          const role = op && op.role ? `<span class="pb-slot-role">${tlEsc(op.role)}</span>` : '';
          return `<div class="pb-slot${op ? ' filled' : ''}${isActive ? ' active' : ''}">${img}<span class="pb-slot-txt"><span class="pb-slot-nm">${name}</span>${role}</span></div>`;
        }).join('');
        return `<div class="pb-team pb-team-${side}" style="--sc:${sideColor(side)}"><div class="pb-team-hd">${tlEsc(sideName(side))}</div>${slots}</div>`;
      };
      slotsEl.innerHTML = col('a') + col('b');
    }
  }

  // Nothing left to ban — drop the search row instead of leaving a dead, disabled input.
  const inpRow = el('dm-front-ow-input'); if (inpRow) inpRow.style.display = d.turn ? '' : 'none';
  const inp = el('draft-front-input');
  if (inp) inp.disabled = !d.turn;

  // Roster cache for the rich typeahead (portrait + name + role) below.
  if (data.draftRosters && Array.isArray(data.draftRosters.overwatch) && data.draftRosters.overwatch.length) {
    window._dmFrontHeroes = data.draftRosters.overwatch;
  }
}

// ── Hero search typeahead: portrait + name + role, keyword-filtered ──
(function wireDraftFrontTypeahead() {
  const inp = el('draft-front-input'), dd = el('draft-front-dd');
  if (!inp || !dd) return;
  const hide = () => { dd.classList.remove('show'); dd.innerHTML = ''; };
  const render = () => {
    const q = inp.value.trim().toLowerCase();
    const all = window._dmFrontHeroes || [];
    if (!q || !all.length) { hide(); return; }
    // Keyword match on the hero name OR role ("tank" lists every tank).
    const hits = NESearch.filter(all, q, (h) => [{ text: h.name, weight: 2 }, h.role], { limit: 12 }).slice(0, 12);
    if (!hits.length) { hide(); return; }
    // .team-dd is position:fixed (so card overflow can't clip it) — anchor it to the
    // input on every open, exactly like the Match — Teams search does.
    const r = inp.getBoundingClientRect();
    dd.style.left = r.left + 'px';
    dd.style.width = r.width + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 260 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
    dd.innerHTML = hits.map((h) =>
      '<div class="team-dd-item" role="option" data-name="' + tlEsc(h.name) + '">'
      + (h.image ? '<img class="team-dd-logo" src="http://127.0.0.1:3000' + tlEsc(h.image) + '" alt="" style="object-fit:cover;border-radius:4px;" onerror="this.style.visibility=\'hidden\'">' : '')
      + '<span class="team-dd-name">' + tlEsc(h.name) + '</span>'
      + (h.role ? '<span style="margin-left:auto;font-size:9px;font-weight:800;letter-spacing:.08em;opacity:.5;text-transform:uppercase;">' + tlEsc(h.role) + '</span>' : '')
      + '</div>').join('');
    dd.classList.add('show');
  };
  inp.addEventListener('input', render);
  inp.addEventListener('focus', render);
  inp.addEventListener('blur', () => setTimeout(hide, 150));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  dd.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.team-dd-item'); if (!it) return;
    e.preventDefault();
    inp.value = it.dataset.name;
    hide();
    inp.focus();
  });
})();

// ── Overwatch 2 match manager (mode, map results, attack side) ───────────────
// Hero bans used to be entered here too; they now live only on Graphics > Pick / Ban (state.draft,
// mirrored per map into owMatch.bansByMap), so there is one place to run them.
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

function renderOwBanManager(data) {
  var section = el('section-ow-bans');
  if (!section) return;
  var ow    = data.owMatch || {};
  var hasOW = data.activeGame === 'overwatch';   // only show when Overwatch is the active game
  section.style.display = hasOW ? '' : 'none';
  if (!hasOW) return;
  var teams = data.teams  || {};
  var nameA = (teams.blue   && teams.blue.name)   || 'Team A';
  var nameB = (teams.orange && teams.orange.name) || 'Team B';


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

}

// ── Marvel Rivals hero ban manager ──────────────────────────────────────────
const MR_HEROES_BY_ROLE = {
  vanguard:   ['Captain America','Doctor Strange','Emma Frost','Groot','Hulk','Magneto','Mister Fantastic','Peni Parker','Thor','Venom'],
  duelist:    ['Black Panther','Black Widow','Hawkeye','Hela','Human Torch','Iron Fist','Iron Man','Magik','Moon Knight','Namor','Psylocke','Scarlet Witch','Spider-Man','Squirrel Girl','Star-Lord','Storm','The Punisher','Winter Soldier','Wolverine'],
  strategist: ['Adam Warlock','Cloak & Dagger','Invisible Woman','Jeff the Land Shark','Loki','Luna Snow','Mantis','Rocket Raccoon']
};

const MR_ALL_HEROES = (function() {
  var out = [];
  Object.keys(MR_HEROES_BY_ROLE).forEach(function(role) {
    MR_HEROES_BY_ROLE[role].forEach(function(name) {
      var slug = name.toLowerCase()
        .replace(/[&]/g,'').replace(/[.']/g,'').replace(/:\s*/g,'-')
        .replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
      out.push({ name: name, role: role, slug: slug, img: 'http://127.0.0.1:3000/assets/heroes/marvel-rivals/' + slug + '.png' });
    });
  });
  return out;
}());

var MR_CDN_SLUG_CP = { 'the-punisher':'punisher','cloak-dagger':'cloak-and-dagger','jeff-the-land-shark':'jeff-the-land-shark' };
function mrHeroSlug(n) {
  return (n||'').toLowerCase()
    .replace(/[&]/g,'').replace(/[.']/g,'').replace(/:\s*/g,'-')
    .replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
}
function mrHeroImgUrl(n) {
  var s = mrHeroSlug(n);
  return s ? 'http://127.0.0.1:3000/assets/heroes/marvel-rivals/' + s + '.png' : '';
}
function mrHeroCdnUrl(n) {
  var s = mrHeroSlug(n); if (!s) return '';
  var cs = MR_CDN_SLUG_CP[s] || s;
  return 'https://rivalskins.com/wp-content/uploads/marvel-assets/ui/heroes/avatar/' + cs + '_avatar.png';
}

var _mrCurMapIdx = 0;

function mrSetBanFromSearch(sid, hero) {
  var side = sid[0];
  var slot = parseInt(sid[1], 10);
  send('mr_ban_hero', { mapIdx: _mrCurMapIdx, side: side, slot: slot, hero: hero, role: '' });
  mrUpdateSearchPreview(sid, hero);
  var inp = el('mr-ban-input-' + sid);
  if (inp) inp.value = hero;
  mrCloseDropdown(sid);
}

var MR_ROLE_COLORS = { vanguard: 'rgba(77,196,255,.45)', duelist: 'rgba(255,80,80,.45)', strategist: 'rgba(74,223,136,.45)' };

function mrUpdateSearchPreview(sid, hero) {
  var prev = el('mr-ban-preview-' + sid);
  if (!prev) return;
  if (!hero) { prev.innerHTML = ''; prev.style.background = ''; return; }
  var found = MR_ALL_HEROES.find(function(h){ return h.name === hero; });
  var bg = MR_ROLE_COLORS[found && found.role] || 'rgba(255,255,255,.15)';
  prev.style.background = '';
  var cdnUrl = mrHeroCdnUrl(hero).replace(/'/g, "\\'");
  prev.innerHTML = '<img src="' + mrHeroImgUrl(hero) + '" alt="' + hero + '"'
    + ' style="width:100%;height:100%;object-fit:cover;object-position:center top;display:block"'
    + ' onerror="if(this.src!==\'' + cdnUrl + '\'){this.src=\'' + cdnUrl + '\';}else{this.style.display=\'none\';this.parentNode.style.background=\'' + bg + '\';}">';
}

function mrCloseDropdown(sid) {
  var dd = el('mr-ban-dropdown-' + sid);
  if (dd) dd.classList.remove('open');
}

function mrOpenDropdown(sid, query) {
  var dd = el('mr-ban-dropdown-' + sid);
  if (!dd) return;
  // Fuzzy + ranked, and the role is searchable so "duelist" lists every duelist.
  var q = (query || '').trim();
  var matches = NESearch.filter(MR_ALL_HEROES, q, function (h) { return [{ text: h.name, weight: 2 }, h.role]; });
  if (!matches.length) { dd.classList.remove('open'); return; }
  var _rcMap = { vanguard: '#4dc4ff', duelist: '#ff5050', strategist: '#4adf88' };
  dd.innerHTML = matches.map(function(h) {
    var rc = _rcMap[h.role] || '#888';
    var cdn = mrHeroCdnUrl(h.name).replace(/'/g, "\\'");
    var badge = '<div style="width:26px;height:33px;border-radius:3px;flex-shrink:0;background:'
      + rc + '22;border:1px solid ' + rc + '55;display:flex;align-items:center;justify-content:center;overflow:hidden">'
      + '<img src="' + h.img + '" alt="" style="width:100%;height:100%;object-fit:cover;object-position:center top"'
      + ' onerror="if(this.src!==\'' + cdn + '\'){this.src=\'' + cdn + '\';}else{this.style.display=\'none\';}">'
      + '</div>';
    return '<div class="ow-hero-option" data-hero="' + h.name.replace(/"/g,'&quot;') + '" data-sid="' + sid + '">'
         + badge
         + '<span class="ow-hero-option-name">' + h.name + '</span>'
         + '<span class="ow-hero-option-role">' + h.role + '</span>'
         + '</div>';
  }).join('');
  dd.querySelectorAll('.ow-hero-option').forEach(function(opt) {
    opt.addEventListener('mousedown', function(e) {
      e.preventDefault();
      mrSetBanFromSearch(this.dataset.sid, this.dataset.hero);
    });
  });
  dd.classList.add('open');
}

function mrInitSearch(sid) {
  var inp = el('mr-ban-input-' + sid);
  if (!inp) return;
  inp.addEventListener('focus', function() { mrOpenDropdown(sid, this.value); });
  inp.addEventListener('input', function() { mrOpenDropdown(sid, this.value); });
  inp.addEventListener('blur',  function() { setTimeout(function() { mrCloseDropdown(sid); }, 150); });
}
['a0','a1','a2','a3','b0','b1','b2','b3'].forEach(mrInitSearch);

function mrClearBan(sid) {
  var side = sid[0];
  var slot = parseInt(sid[1], 10);
  send('mr_ban_hero', { mapIdx: _mrCurMapIdx, side: side, slot: slot, hero: '', role: '' });
  mrUpdateSearchPreview(sid, '');
  var inp = el('mr-ban-input-' + sid); if (inp) inp.value = '';
}

var MR_MODES = ['convergence','domination','convoy'];
MR_MODES.forEach(function(mode) {
  var btn = el('btn-mr-mode-' + mode);
  if (btn) btn.addEventListener('click', function() { send('mr_set_game_mode', { mode: mode }); });
});

var mrMapLabelsToggle = el('mr-map-labels-toggle');
if (mrMapLabelsToggle) {
  mrMapLabelsToggle.addEventListener('change', function() {
    send('mr_set_map_labels', { show: this.checked });
  });
}

(function() {
  var mrResults = el('mr-map-results-rows');
  if (!mrResults) return;
  mrResults.addEventListener('click', function(e) {
    var btn = e.target.closest('button[data-map-idx]');
    if (!btn) return;
    var idx = parseInt(btn.dataset.mapIdx, 10);
    if (isNaN(idx)) return;
    if ('mode' in btn.dataset) {
      send('mr_set_map_mode', { mapIdx: idx, mode: btn.dataset.mode });
    } else if ('winner' in btn.dataset) {
      send('mr_set_map_winner', { mapIdx: idx, winner: btn.dataset.winner || null });
    }
  });
})();

['a0','a1','a2','a3','b0','b1','b2','b3'].forEach(function(sid) {
  var btn = el('btn-mr-ban-' + sid + '-clear');
  if (btn) btn.addEventListener('click', function() { mrClearBan(sid); });
});
el('btn-mr-show')?.addEventListener('click', () => send('mr_visible', { visible: true }));
el('btn-mr-hide')?.addEventListener('click', () => send('mr_visible', { visible: false }));

function mrGetBanArr(bansByMap, idx, side) {
  var entry = (Array.isArray(bansByMap) ? bansByMap[idx] : null) || {};
  var v = entry[side];
  if (Array.isArray(v)) return [0,1,2,3].map(function(i){ return v[i] && v[i].hero || ''; });
  return ['','','',''];
}

function mrRenderRosterTable(gep, nameA, nameB) {
  var container = el('mr-roster-live');
  if (!container) return;
  var roster = Array.isArray(gep.roster) ? gep.roster : [];
  if (!roster.length) { container.innerHTML = ''; return; }

  var teamA = roster.filter(function(p){ return String(p.team) === '0'; }).slice(0, 6);
  var teamB = roster.filter(function(p){ return String(p.team) === '1'; }).slice(0, 6);

  function mkRow(p) {
    if (!p) return '<tr><td colspan="4" style="padding:1px 4px;font-size:10px;opacity:.22">—</td></tr>';
    var ult = Math.min(100, Math.max(0, Number(p.ult_charge) || 0));
    var dead = p.is_alive === false;
    var ultFill = 'height:100%;width:' + ult + '%;border-radius:2px;background:' + (ult >= 100 ? 'linear-gradient(90deg,#9e20ff,#d870ff);box-shadow:0 0 4px rgba(175,70,255,.6)' : 'rgba(155,60,255,.6)');
    var ultBar = '<div style="height:3px;background:rgba(255,255,255,.1);border-radius:2px;overflow:hidden"><div style="' + ultFill + '"></div></div>';
    return '<tr style="' + (dead ? 'opacity:.38;' : '') + '">' +
      '<td style="padding:1px 4px;font-size:10px;font-weight:600;color:#d0d0f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:72px">' + (dead ? '<svg class="svg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 20v2h8v-2"/><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/></svg> ' : '') + (p.name || '—') + '</td>' +
      '<td style="padding:1px 4px;font-size:9px;color:rgba(200,210,255,.65);white-space:nowrap">' + (p.character_name || '—') + '</td>' +
      '<td style="padding:1px 4px;font-size:9px;color:rgba(255,255,255,.4);text-align:right;white-space:nowrap">' + (p.kills||0) + '/' + (p.deaths||0) + '/' + (p.assists||0) + '</td>' +
      '<td style="padding:1px 6px;min-width:58px">' + ultBar + '<span style="font-size:8px;color:rgba(255,255,255,.3)">' + ult + '%</span></td>' +
      '</tr>';
  }

  var teamHdr = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.3);margin-bottom:3px;padding:0 4px';
  var html = '<div style="border-top:1px solid rgba(255,255,255,.07);padding-top:10px;margin-bottom:14px;display:flex;gap:10px;">';
  html += '<div style="flex:1;min-width:0"><div style="' + teamHdr + '">' + nameA + '</div><table style="width:100%;border-collapse:collapse">';
  for (var i = 0; i < 6; i++) html += mkRow(teamA[i] || null);
  html += '</table></div>';
  html += '<div style="flex:1;min-width:0"><div style="' + teamHdr + '">' + nameB + '</div><table style="width:100%;border-collapse:collapse">';
  for (var j = 0; j < 6; j++) html += mkRow(teamB[j] || null);
  html += '</table></div></div>';
  container.innerHTML = html;
}

function renderMrBanManager(data) {
  var section = el('section-mr-bans');
  if (!section) return;
  var mr    = data.mrMatch || {};
  var hasMR = data.activeGame === 'marvel-rivals';   // only show when Marvel Rivals is the active game
  section.style.display = hasMR ? '' : 'none';
  if (!hasMR) return;

  var teams  = data.teams  || {};
  var game   = data.game   || {};
  var nameA  = (teams.blue   && teams.blue.name)   || 'Team A';
  var nameB  = (teams.orange && teams.orange.name) || 'Team B';

  _mrCurMapIdx = Math.max(0, (game.number || 1) - 1);

  var lblA = el('mr-ban-label-a'); if (lblA) lblA.textContent = nameA + ' — Hero Bans (Game ' + (game.number || 1) + ')';
  var lblB = el('mr-ban-label-b'); if (lblB) lblB.textContent = nameB + ' — Hero Bans (Game ' + (game.number || 1) + ')';

  // Game mode button highlight
  var curMode = mr.gameMode || 'convergence';
  MR_MODES.forEach(function(mode) {
    var btn = el('btn-mr-mode-' + mode);
    if (btn) btn.className = 'btn btn-sm' + (mode === curMode ? ' btn-primary' : ' btn-secondary');
  });

  // Map labels toggle
  var chkLabels = el('mr-map-labels-toggle');
  if (chkLabels) { var wantLabels = mr.showMapLabels !== false; if (chkLabels.checked !== wantLabels) chkLabels.checked = wantLabels; }

  // Map Results
  var bestOf     = data.bestOf || 5;
  var totalMaps  = Math.ceil(bestOf / 2) * 2 - 1;
  var mapWinners = Array.isArray(mr.mapWinners) ? mr.mapWinners : [];
  var mapModes   = Array.isArray(mr.mapModes)   ? mr.mapModes   : [];
  for (var mi = 0; mi < 7; mi++) {
    var grRow = el('mr-gr-' + mi);
    if (!grRow) continue;
    grRow.style.display = mi < totalMaps ? '' : 'none';
    var winner     = mapWinners[mi] || null;
    var activeMode = mapModes[mi]   || null;
    var grA = el('mr-gr-' + mi + '-a');
    var grB = el('mr-gr-' + mi + '-b');
    if (grA) { grA.textContent = winner === 'a' ? '✓ ' + nameA : nameA; grA.className = 'mr-win-btn' + (winner === 'a' ? ' winner-a' : ''); }
    if (grB) { grB.textContent = winner === 'b' ? '✓ ' + nameB : nameB; grB.className = 'mr-win-btn' + (winner === 'b' ? ' winner-b' : ''); }
    MR_MODES.forEach(function(mode) {
      var mb = grRow.querySelector('[data-mode="' + mode + '"]');
      if (mb) mb.className = 'mr-mode-sel' + (activeMode === mode ? ' active' : '');
    });
  }

  // GEP status indicator
  var gep     = mr.gepData || {};
  var gepAlive = gep.gepConnected && gep.lastSeen && (Date.now() - gep.lastSeen < 45000);
  var gepDot  = el('mr-gep-dot-cp');
  var gepLbl  = el('mr-gep-label');
  if (gepDot) gepDot.style.background = gepAlive ? '#4adf88' : 'rgba(255,255,255,.2)';
  if (gepLbl) gepLbl.textContent = gepAlive ? ('GEP Live' + (gep.map ? ' · ' + gep.map : '')) : 'GEP Offline';

  // Live roster table (appears when GEP pushes roster data)
  mrRenderRosterTable(gepAlive ? gep : {}, nameA, nameB);

  // Ban pickers
  var bansByMap = Array.isArray(mr.bansByMap) ? mr.bansByMap : [];
  ['a', 'b'].forEach(function(side) {
    var heroes = mrGetBanArr(bansByMap, _mrCurMapIdx, side);
    [0, 1, 2, 3].forEach(function(slot) {
      var sid  = side + slot;
      var hero = heroes[slot] || '';
      mrUpdateSearchPreview(sid, hero);
      var inp = el('mr-ban-input-' + sid);
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
  { key: 'winner',    label: 'Winner',            msg: 'set_winner',            path: 'winner.visible' },
  { key: 'intro',     label: 'Team Intro',        msg: 'set_intro',             path: 'intro.visible' },
  // Matchup has no independent visible flag — it's active when gfxActive === 'matchup'.
  // check() is used for on-detection; showData/hideData carry the correct WS payload.
  { key: 'matchup',   label: 'Matchup',           msg: 'set_gfx_active',        path: 'gfxActive',
    check: (s) => !!(s && s.gfxActive === 'matchup'),
    showData: { scene: 'matchup' }, hideData: { scene: null } },
  { key: 'veto',      label: 'Map Pool / Series', msg: 'set_veto',              path: 'veto.visible' },
  { key: 'draft',     label: 'Pick / Ban',        msg: 'draft_visible',         path: 'draft.visible' },
  { key: 'seriesstats', label: 'Series Stats',    msg: 'set_series_stats',      path: 'seriesStats.visible' },
  { key: 'bracket',   label: 'Bracket',           msg: 'set_bracket_settings',  path: 'bracket.visible' },
  { key: 'upcoming',  label: 'Schedule',          msg: 'set_upcoming',          path: 'upcoming.visible' },
  { key: 'standings', label: 'Standings',         msg: 'set_standings',         path: 'standings.visible' },
  { key: 'ticker',    label: 'Ticker',            msg: 'set_ticker',            path: 'ticker.visible' },
  { key: 'spotlight', label: 'Player Spotlight',  msg: 'set_spotlight',         path: 'spotlight.visible' },
  { key: 'watchlist', label: 'Teams to Watch',    msg: 'set_watchlist',         path: 'watchlist.visible' },
  { key: 'teamspot',  label: 'Team Spotlight',    msg: 'set_team_spotlight',    path: 'teamSpotlight.visible' },
  { key: 'banner',    label: 'Sponsor Banner',    msg: 'set_banner_visibility', path: 'banner.visible' },
  { key: 'credits',   label: 'Stream Credits',    msg: 'set_credits',          path: 'credits.visible' }
];
window.ONAIR_SCENES = ONAIR_SCENES;   // TDZ-safe handle for early-init render hooks

// Camera layers on the in-game HUD (the RL and CS2 HUDs draw player webcams). Not graphics: they
// are never part of Hide all, graphic exclusivity, the deck or the rundown, but they are switched
// wherever the producer turns things on and off (the Control room's Live now card, the dock's On
// screen card, search). Same shape as ONAIR_SCENES (msg / path / check / showData / hideData);
// games = where it does anything; setup = the game settings tab that configures it.
const HUD_LAYERS = [
  { key: 'facecams', label: 'Player webcams', hint: 'Every player cam on the in-game HUD',
    msg: 'set_facecams_enabled', path: 'facecamsEnabled', check: (s) => !!s && s.facecamsEnabled !== false,
    showData: { enabled: true }, hideData: { enabled: false }, games: ['rocket-league', 'csgo'], setup: 'cameras' },
  { key: 'replaycams', label: 'Webcams during replays', hint: 'The full cam grid while a goal replay plays',
    msg: 'set_replay_cams', path: 'replayCams', check: (s) => !!s && s.replayCams !== false,
    showData: { enabled: true }, hideData: { enabled: false }, games: ['rocket-league'], setup: 'cameras' }
];
window.HUD_LAYERS = HUD_LAYERS;
// The layers that apply to the game being produced.
function hudLayersFor(game) { return HUD_LAYERS.filter((l) => !l.games || l.games.includes(game)); }
window.hudLayersFor = hudLayersFor;

// Inline SVG icon set (Lucide-style stroke icons) — no emojis.
const ICON_SVG = {
  gamepad: '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  sparkles: '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>',
  handshake: '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  userplus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  gem: '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
  train: '<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/><path d="m9 15-1-1"/><path d="m15 15 1-1"/><path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/><path d="m8 19-2 3"/><path d="m16 19 2 3"/>',
  trending: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1v-7a9 9 0 0 1 18 0v7a1 1 0 0 1-1 1h-2a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  chevup: '<path d="m18 15-6-6-6 6"/>',
  chevdown: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  x:        '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  layout:   '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  monitor:  '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  list:     '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
  grid:     '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
};
function svgIcon(key, cls) {
  return `<svg class="svg-ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_SVG[key] || ''}</svg>`;
}

// All overlay browser sources, grouped. `live` = a dotted state path that, when
// truthy, marks the scene ON AIR ('always' = persistent HUD, no toggle). `desc`
// shows under the name. The standalone launcher (scenes.html) mirrors this list.
const SCENE_SOURCES = [
  { group: 'In-Game HUD', icon: 'gamepad', items: [
    { name: 'Smash Scoreboard', path: '/smash.html', live: 'always', desc: 'Super Smash Bros. 1v1 — players, flags, fighters, stocks (lives) + set score. Stocks/characters set in Match ▸ Teams ▸ Smash.' },
    { name: 'Brawlhalla Scoreboard', path: '/brawlhalla.html', live: 'always', desc: 'Brawlhalla 1v1 / 2v2 — players, legends, stocks + set score, with live rank/ELO chips from the official stats API. Stocks and legends are set in Match ▸ Teams ▸ Brawlhalla (the game has no live feed).' },
    { name: 'Smash Team Scoreboard', path: '/smash-team.html', live: 'always', desc: 'Super Smash Bros. crew battle — teams, logos, aggregate team stocks + set score / Best-of. Team mode in Match ▸ Teams ▸ Smash.' },
    { name: 'RL HUD (Modern)', path: '/rl-hud.html', live: 'always', desc: 'Modern Rocket League scorebar + boost/stat HUD.' },
    { name: 'RL Player HUD', path: '/rl-player.html', live: 'always', desc: 'For playing on this PC: follows YOUR car (boost, stats). Best popped out over the game.' },
    { name: 'RL Worlds HUD', path: '/rl-worlds.html', live: 'always', desc: 'RLCS Worlds-style Rocket League HUD: stats sidebar, scores ticker, title sponsor.' },
    { name: 'RL Series Stats', path: '/rl-series-stats.html', live: null, desc: 'Rocket League stats for the whole series so far: per-player goals, assists, saves, shots and score.' },
    { name: '★ Live HUD (active game)', path: '/live.html', live: 'always', desc: 'The scoreboard source to use: shows the HUD of the game and layout set in the app, and follows it when you change game. Pair it with Graphics (gfx.html) on top.' },
    { name: 'CS2 / CS:GO HUD', path: '/csgo.html', live: 'always', desc: 'GSI scorebar, players, radar, bomb, economy.' },
    { name: 'CS2 Pro HUD', path: '/cs2-pro.html', live: 'always', desc: 'Second CS2 layout: player photo cards, team utility bars, auto K/D/A scoreboard in freezetime + timeouts, timeout banner, radar.' },
    { name: 'Valorant HUD', path: '/valorant.html', live: 'always', desc: 'Round scorebar, agents, spike + economy.' },
    { name: 'Overwatch 2 HUD', path: '/overwatch.html', live: 'always', desc: 'Hero line-up, objective + score HUD.' },
    { name: 'Marvel Rivals HUD', path: '/marvel-rivals.html', live: 'always', desc: 'Hero roster + objective scorebar.' },
    { name: 'THE FINALS Broadcast Bar', path: '/the-finals.html', live: 'always', desc: 'Bottom bar under the in-game spectator HUD — event, series score, round, observed player + scores ticker. ?ticker=0 hides the ticker.' },
    { name: 'LoL HUD', path: '/lol-hud.html', live: 'always', desc: 'Team gold estimate + player loadouts, auto champ-select fill.' },
    { name: 'Apex Observer', path: '/apex-observer.html?live=1', live: 'always', desc: 'ALGS-style full-observer: side standings (rank/logo/legends/pts), map badge, squads/players remaining. LiveAPI + scoring.' },
    { name: 'Apex HUD', path: '/apex.html?live=1', live: 'always', desc: 'Apex spectated-player card, kill feed + squad standings from LiveAPI.' },
    { name: 'Overwatch HUD', path: '/ow-hud.html', live: 'owMatch.visible', desc: 'In-game HUD from the Overwolf relay — live heroes, K/D/A, damage & healing per player.' },
    { name: 'Series Scoreboard', path: '/series.html', live: 'always', desc: 'Standalone series / match scoreboard banner.' },
    { name: 'Mini Station', path: '/ministation.html', live: 'always', desc: 'Compact mini-HUD for split-screen / B-feeds.' },
    { name: 'Director Preview', path: '/director-preview.html', live: 'always', desc: 'Producer-only director bug — add ?director=1.' },
  ]},
  { group: 'Fighting Games (FGC)', icon: 'gamepad', items: [
    { name: 'Marvel Tokon Scoreboard', path: '/tokon.html', live: 'always', desc: 'Built around the Tokon HUD — players, flags, set score, round + "Best of 3 · Game 2 of 3" top middle; event title, casters and rotating sponsors under the super meters. Set in Match ▸ Teams ▸ Marvel Tokon.' },
    { name: 'Tekken 8 Scoreboard (Blue)', path: '/fgc/tekken8-blue/template.html', live: 'always', desc: 'FGCaster lower-third — fed by Match ▸ Teams (player names, series score, casters).' },
    { name: 'Tekken 8 Scoreboard (Red)', path: '/fgc/tekken8-red/template.html', live: 'always', desc: 'Red variant of the Tekken 8 scoreboard.' },
    { name: 'Street Fighter 6 Scoreboard', path: '/fgc/sf6/template.html', live: 'always', desc: 'SF6-styled 1v1 scoreboard — names, clan tags, series score, casters.' },
    { name: 'Guilty Gear Strive Scoreboard', path: '/fgc/ggstrive/template.html', live: 'always', desc: 'Guilty Gear -Strive- styled 1v1 scoreboard.' },
    { name: '2XKO Scoreboard (tag)', path: '/fgc/2xko/template.html', live: 'always', desc: '2XKO tag scoreboard — two players per side (first two roster slots).' },
    { name: 'Generic FGC Scoreboard', path: '/fgc/default/template.html', live: 'always', desc: 'Game-agnostic FGC lower-third for any 1v1 fighting game.' },
    { name: 'Generic FGC Scoreboard (image)', path: '/fgc/default-img/template.html', live: 'always', desc: 'Image-based variant of the generic FGC scoreboard.' },
  ]},
  { group: 'Casters & Desk', icon: 'mic', items: [
    { name: 'Casters (grid)', path: '/casters.html', live: 'casters.visible', desc: 'Up to 4 commentators — auto cam holes + name plates.' },
    { name: 'Single Cam', path: '/singlecam.html', live: 'casters.visible', desc: 'Solo caster — one big cam + scorebar, sponsor under the cam.' },
    { name: 'Duo Row', path: '/duorow.html', live: 'casters.visible', desc: '2 caster cams in a row + scorebar + footer.' },
    { name: 'Duo Row — No Scorebar', path: '/duorow-noscore.html', live: 'casters.visible', desc: '2 caster cams, no match scorebar — podcasts/panels. Event title + lower third only.' },
    { name: 'Trio Row', path: '/triorow.html', live: 'casters.visible', desc: '3 caster cams in a row + scorebar + footer.' },
    { name: 'Duo (single cam)', path: '/duosinglecam.html', live: 'casters.visible', desc: '2 casters sharing one wide camera.' },
    { name: 'Analyst Desk', path: '/analystspecial.html', live: 'casters.visible', desc: 'Featured host + analyst cams.' },
    { name: 'Cam Over Game (PiP)', path: '/campip.html', live: 'casters.visible', desc: 'Caster cam(s) in a corner over gameplay. ?pos=br|bl|tr|tl.' },
    { name: 'Talent Bar (lower third)', path: '/talentbar.html', live: 'casters.visible', desc: 'Slim bottom strip of caster cams + names over gameplay/replay.' },
    { name: 'Interview / Head-to-head', path: '/interview.html', live: 'casters.visible', desc: 'Two big cams side by side with a VS medallion.' },
    { name: 'Quad Desk (2×2)', path: '/quaddesk.html', live: 'casters.visible', desc: 'Four-person panel — 2×2 framed cams + scorebar.' },
    { name: 'Quad Desk — No Scorebar', path: '/quaddesk-noscore.html', live: 'casters.visible', desc: 'Four-person panel, no match scorebar — bigger 2×2 cams for podcasts/panels.' },
    { name: 'Desk Show', path: '/preshow.html', live: 'casters.visible', desc: '2 caster cams + discussion-topics rail + kickoff countdown + first-up match-up.' },
    { name: 'Player Spotlight Desk', path: '/spotlightdesk.html', live: 'casters.visible', desc: 'Analyst cam + featured player card with live stats.' },
    { name: 'Vertical (9:16)', path: '/vertical.html', live: 'casters.visible', desc: 'Vertical co-stream — set the OBS source to 1080×1920.', aspect: '1080 × 1920' },
    { name: 'Vertical Casters (9:16)', path: '/vertical-casters.html', live: 'casters.visible', desc: 'TikTok / Shorts caster desk — cams stacked full-frame, scorebar on top, inside the phone-UI safe area. ?count=1|2|3, ?score=off, ?safe=0, ?guides=1.', aspect: '1080 × 1920' },
    { name: 'Listen In (player mic + captions)', path: '/listen-in.html', live: 'listenIn.active', desc: 'Live team/player mic + captions on stream (VDO).' },
    { name: 'Chat Highlight (lower third)', path: '/chat-highlight.html', live: 'chatHighlight.visible', desc: 'Featured chat message — click any message in the rail’s Twitch chat to put it on stream.' },
    { name: 'Interview Desk', path: '/interview-desk.html', live: 'casters.visible', desc: 'Host and guest interview layout with a header bar.' },
    { name: 'Caster Cam Feed (single)', path: '/castercam.html', live: null, desc: 'One caster camera, full frame. ?slot=1-4 picks the desk seat, 5 = the player cam. Shows the brand logo when the seat is empty.' },
    { name: 'Interviewee Feed', path: '/int-cam.html', live: null, desc: 'The interview guest camera as one full-frame transparent source, to lay over any scene.' },
  ]},
  { group: 'Pre / Post / Breaks', icon: 'clock', items: [
    { name: '★ Graphics (all-in-one)', path: '/gfx.html', live: null, desc: 'The source behind the Graphics page: every graphic you Show there appears on this one layer. Put it on top of your main scenes.' },
    { name: '★ Trigger Graphics (all-in-one)', path: '/triggers.html', live: null, desc: 'ONE source for every triggered graphic — countdown, winner, intro, veto, draft, bracket, upcoming, standings. Add it to any scene; the qrail Triggers/Overlays buttons pop the right one over it.' },
    { name: 'Countdown / Starting Soon', path: '/countdown.html', live: 'breakScreen.visible', desc: 'Break standby timer with movie-countdown finish.' },
    { name: 'Starting Soon — Timer only', path: '/countdown.html?timer=1', live: 'breakScreen.visible', desc: 'Countdown with no background — overlay on b-roll.' },
    { name: 'Countdown Bar', path: '/countdown-bar.html', live: 'breakScreen.visible', aspect: '1920 × 132', desc: 'Segmented "back in" strip — brand, next-up teams, clock, headline and rotating sponsors. Its own bar-sized source, driven by the same producer timer as the break screen. Params: ?h=132 ?alpha=0.82 ?rotate=6 ?teams=0 ?sponsor=0 ?align=top' },
    { name: 'Replay Desk — Topics', path: '/replay-desk.html', live: 'breakScreen.visible', desc: 'Desk Show layout with the caster cams replaced by ONE 16:9 stage for a replay / highlight reel, and the discussion-topics rail alongside it. The stage is a transparent hole — put the media source behind it (?cams=off&guide=1 prints its exact rectangle), or use ?media=player to embed the built-in replay player.' },
    { name: 'Replay Desk — Match Board', path: '/replay-desk.html?rail=matches', live: 'breakScreen.visible', desc: 'Same 16:9 replay stage, but the rail carries live / upcoming / recent results from the start.gg feed — what the ticker shows, laid out as a readable board that pages through. Use ?rail=auto to fall back to Topics when the feed is empty.' },
    { name: 'Intermission Card', path: '/intermission.html', live: 'breakScreen.visible', desc: 'Centered card: brand logo + event title + countdown. Layer over a map or b-roll in OBS.' },
    { name: 'Intermission — Full Screen', path: '/intermission2.html', live: 'breakScreen.visible', desc: 'RLCS-style full-screen intermission: brand panel, STARTING SOON, giant outline countdown. Layer over b-roll.' },
    { name: 'Vertical Break (9:16)', path: '/vertical-break.html', live: 'breakScreen.visible', desc: 'TikTok / Shorts break card — brand logo, event title, countdown + message, inside the phone-UI safe area. ?fill=1 for a branded backdrop, ?safe=0, ?guides=1.', aspect: '1080 × 1920' },
    { name: 'Winner', path: '/winner.html', live: 'winner.visible', desc: 'Champion screen — team logo, name, subtitle.' },
    { name: 'Team Line-up', path: '/intro.html', live: 'intro.visible', desc: 'Animated roster cards. Add ?side=blue|orange.' },
    { name: 'Matchup (pre-game)', path: '/matchup.html', live: null, desc: 'Cinematic split-screen — team color washes, large watermark logos, VS pillar, series pips.' },
    { name: 'Draft Screen', path: '/draft.html', live: null, desc: 'Animated pick/ban draft for character / agent select.' },
    { name: 'Ticker', path: '/ticker.html', live: 'ticker.visible', desc: 'Scrolling lower-third — manual messages or live start.gg scores.' },
    { name: 'Stream Credits', path: '/stream-credits.html', live: null, desc: 'End-of-show credits: talent bar, movie-style staff roll, supporters and sponsors.' },
  ]},
  { group: 'Battle Royale', icon: 'trophy', items: [
    { name: 'BR Leaderboard', path: '/br-leaderboard.html', live: null, desc: 'Full lobby standings table: placement and elimination points per team.' },
    { name: 'BR Rail', path: '/br-rail.html', live: null, desc: 'Side rail of the lobby standings that pages through the field during a game.' },
    { name: 'BR Match Result', path: '/br-match.html', live: null, desc: 'End-of-game result with the winning team plate.' },
    { name: 'Drop Map', path: '/fn-dropmap.html', live: null, desc: 'Where each team lands on the Fortnite map.' },
    { name: 'Team Comparison', path: '/fn-compare.html', live: null, desc: 'Two teams side by side with their lobby stats.' },
    { name: 'Victory Royale', path: '/fn-victory.html', live: null, desc: 'Fortnite game-winner screen.' },
  ]},
  { group: 'Multiview & Whip-around', icon: 'film', items: [
    { name: 'Grid Wall (2/3/4/6-up)', path: '/grid.html', live: null, desc: 'GRID-style multiview wall — every org producer publishing their match becomes a tile: their feed, their Twitch handle and the series score. Auto-sizes as producers come online; brand-kit colours, logo, sponsors and the app ticker throughout. Pin a layout with ?tiles=2|3|4|6. Each producer must turn on Settings ▸ Broadcast ▸ Grid Multiview — with nobody publishing the wall shows STANDBY, never placeholder matches.' },
    { name: 'Grid Wall — 4-up', path: '/grid.html?tiles=4', live: null, desc: 'The wall pinned to a 2×2 — the layout never changes when a producer joins or drops.' },
    { name: 'Grid Wall — 2-up', path: '/grid.html?tiles=2', live: null, desc: 'The wall pinned to a side-by-side pair.' },
    { name: 'Grid Bars (overlay only)', path: '/grid-bars.html', live: null, desc: 'The same wall with the video left out — transparent, so you lay your OWN OBS sources (capture, NDI, Twitch) in the tile rectangles. Add ?guides=1 to print each tile’s OBS transform numbers, then drop it for air.' },
    { name: 'Pulse (auto-switching)', path: '/pulse.html', live: null, desc: 'Whip-around single-feed multiview — cuts to whichever published match just scored, with a live scores rail and ticker alongside.' },
  ]},
  { group: 'Bracket & Veto', icon: 'trophy', items: [
    { name: 'Bracket', path: '/bracket.html', live: 'bracket.visible', desc: 'Live bracket — elim columns or standings table.' },
    { name: 'Standings', path: '/standings.html', live: 'standings.visible', desc: 'Dedicated standings board (auto from bracket, league or manual) — podium leaderboard, or top-8 placement cards with character art for Smash.' },
    { name: 'Schedule', path: '/schedule.html', live: 'upcoming.visible', desc: 'Next matches from start.gg stream queue or manual entry.' },
    { name: 'Map Veto', path: '/mapscreen.html', live: 'veto.visible', desc: 'Pick/ban board for CS2 / Valorant-style series.' },
    { name: 'League Leaderboard', path: '/league-leaderboard.html', live: null, desc: 'Season standings for the active league.' },
    { name: 'League Stats', path: '/league-stats.html', live: null, desc: 'Season stat leaders for the active league.' },
  ]},
  { group: 'Replays', icon: 'film', items: [
    { name: 'Replay / Montage Player', path: '/replay-player.html', live: null, desc: 'Full-screen OBS replay buffer + montage playout.' },
  ]},
  { group: 'Spotlight', icon: 'star', items: [
    { name: 'Team Spotlight', path: '/team-spotlight.html', live: null, desc: 'Single-team deep dive — seed, placement, record, recent form, next match, roster.' },
    { name: 'Teams to Watch', path: '/watchlist.html', live: null, desc: 'Multi-team grid/podium overlay with custom fields + roster.' },
  ]},
  { group: 'Background & Ambient', icon: 'sparkles', items: [
    { name: 'Background', path: '/background.html', live: 'always', desc: 'OBS background layer — solid, gradient or image (Settings ▸ Background).' },
  ]},
  { group: 'Twitch Interactions', icon: 'chat', items: [
    { name: 'Twitch Alerts', path: '/twitch-alerts.html', live: null, desc: 'Follower, sub and donation alerts overlay.' },
    { name: 'Predictions', path: '/twitch-predictions.html', live: null, desc: 'Channel-point prediction tracker with hide timer.' },
    { name: 'Giveaway Wheel', path: '/twitch-wheel.html', live: null, desc: 'On-screen spin wheel for chat giveaways.' },
    { name: 'Mini-Games', path: '/twitch-minigames.html', live: null, desc: 'Interactive Twitch chat mini-games overlay.' },
    { name: 'Polls', path: '/twitch-polls.html', live: null, desc: 'Channel-point poll tracker overlay.' },
    { name: 'Marble Race', path: '/marble-race.html', live: null, desc: 'Every viewer\'s marble races a real 3D obstacle course — enter with !play (Twitch, Kick, YouTube).' },
  ]},
  { group: 'Stingers & Transitions', icon: 'sparkles', items: [
    { name: 'Transition (accent)', path: '/transition.html', live: null, desc: 'Brand wipe with centre logo. ?team=blue|orange.' },
    { name: 'Transition (solid)', path: '/transitionbgg.html', live: null, desc: 'Solid-fill wipe — dark panel behind the logo.' },
    { name: 'Replay Wipe', path: '/replay.html', live: null, desc: '"REPLAY" plate slide-in. ?label=, ?team=.' },
  ]},
  { group: 'Sponsors & Branding', icon: 'handshake', items: [
    { name: 'Sponsor Rail', path: '/sponsor-rail.html', live: null, desc: 'Horizontal logo rail — cycles or shows all rail sponsors. ?mode=cycle|static, ?height=80, ?label=1, ?interval=N.' },
    { name: 'Sponsor Rail (static)', path: '/sponsor-rail.html?mode=static', live: null, desc: 'All rail sponsor logos displayed at once.' },
    { name: 'Sponsor Banner (Main)', path: '/sponsor-banner.html?src=main', live: 'banner.visible', desc: 'Rotating sponsor strip driven by the Main banner.' },
    { name: 'Sponsor Banner (Active brand)', path: '/sponsor-banner.html?src=brand', live: 'banner.visible', desc: 'Sponsor strip driven by the active client brand kit.' },
  ]},
];

// Which games an overlay is for. Untagged overlays suit every game. Feature tags (fgc, vetoes,
// draft, battle-royale) follow the game registry's `features`, so a new game that shares the
// feature picks the overlay up without editing this list.
const SCENE_GAME_TAGS = {
  '/smash.html': ['smash'], '/smash-team.html': ['smash'], '/brawlhalla.html': ['brawlhalla'],
  '/rl-hud.html': ['rocket-league'], '/rl-player.html': ['rocket-league'], '/rl-worlds.html': ['rocket-league'], '/rl-series-stats.html': ['rocket-league'],
  '/csgo.html': ['csgo'], '/cs2-pro.html': ['csgo'], '/valorant.html': ['valorant'],
  '/overwatch.html': ['overwatch'], '/ow-hud.html': ['overwatch'], '/marvel-rivals.html': ['marvel-rivals'],
  '/the-finals.html': ['the-finals'], '/lol-hud.html': ['league'],
  '/apex-observer.html': ['apex'], '/apex.html': ['apex'], '/tokon.html': ['marvel-tokon'],
  '/fgc/tekken8-blue/template.html': ['tekken8'], '/fgc/tekken8-red/template.html': ['tekken8'],
  '/fgc/sf6/template.html': ['sf6'], '/fgc/ggstrive/template.html': ['ggstrive'], '/fgc/2xko/template.html': ['2xko'],
  '/fn-dropmap.html': ['fortnite'], '/fn-compare.html': ['fortnite'], '/fn-victory.html': ['fortnite'],
};
const SCENE_FEATURE_TAGS = {
  '/fgc/default/template.html': ['fgc'], '/fgc/default-img/template.html': ['fgc'],
  '/mapscreen.html': ['vetoes'], '/draft.html': ['draft', 'heroes', 'agents'],
  // The BR boards read the lobby board (state.br), which only lobby games fill (BR_LOBBY_GAMES in
  // server.js). Apex scores through its own feed and has its own overlays, so they are not offered there.
  '/br-leaderboard.html': ['lobby'], '/br-rail.html': ['lobby'], '/br-match.html': ['lobby'],
};
// Head-to-head only: one team against another. A free-for-all game (format 'ffa': 20 squads in a
// lobby) has nothing to put in them.
const SCENE_H2H_ONLY = new Set(['/series.html', '/matchup.html']);
function sceneBasePath(p) { return String(p || '').split('?')[0]; }
function sceneFitsGame(path, st) {
  const p = sceneBasePath(path);
  const games = SCENE_GAME_TAGS[p], feats = SCENE_FEATURE_TAGS[p];
  const gid = st && st.activeGame;
  if (gid && SCENE_H2H_ONLY.has(p)) return (((st.games || {})[gid]) || {}).format !== 'ffa';
  if (!games && !feats) return true;
  if (!gid) return true;
  if (games && games.includes(gid)) return true;
  const f = ((((st.games || {})[gid]) || {}).features) || [];
  return !!feats && feats.some((x) => f.includes(x));
}
// "Start here": the sources almost every show needs. live.html shows the HUD of the game + layout
// set in the app (so it never needs swapping), gfx.html carries every graphic pushed from the
// Graphics panel (countdown, winner, bracket...). The desk and replay player are full scenes of
// their own. Adding gfx.html's graphics as separate sources would show them twice.
function sceneStartPaths() {
  return ['/live.html', '/gfx.html', '/duorow.html', '/replay-player.html'];
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function buildOnAirGrid() {
  const grid = el('onair-grid');
  if (!grid || grid.dataset.built) return;
  grid.dataset.built = '1';
  // These have full Trigger rows (with options like team/title/player) below — don't duplicate
  // them as bare show/hide toggles up here, which fire without options and look broken.
  const TRIGGER_COVERED = new Set(['break', 'winner', 'intro', 'veto', 'spotlight']);
  ONAIR_SCENES.filter((s) => !TRIGGER_COVERED.has(s.key)).forEach((s) => {
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
    // Route through the SAME push routine as the Production ▸ Graphics On-air board: these
    // switches used to send a bare visibility flag, which never set the gfx.html layer, never
    // cleared the graphic already live, and never cut OBS — so flipping one here looked like
    // nothing happened. The switch is a view of the shared state, not its own control path.
    card.querySelector('#air-' + s.key).addEventListener('change', function () {
      onairPut(s, onairIsOn(s, currentState));     // pass the CURRENT state — onairPut flips it
                                                   // (it repaints the grid from the updated state)
    });
  });
}

let _sceneFilterGroup = '__start';   // active category chip
let _sceneFilterText = '';           // search box text (lowercased)
let _sceneGameSig = '';              // active game + layout the filter last ran for
// Hide overlays built for other games (on by default; remembered per machine).
let _sceneGameOnly = (() => { try { return localStorage.getItem('ne_scene_game_only') !== '0'; } catch { return true; } })();

const SCENE_DEFAULT_ASPECT = '1920 × 1080';

// ── Per-scene background wash (colour + opacity %), persisted in localStorage ──
function sceneBgKey(path) { return 'ne_scene_bg_' + path.split('?')[0]; }
function loadSceneBg(path) { try { return JSON.parse(localStorage.getItem(sceneBgKey(path))) || {}; } catch { return {}; } }
function saveSceneBg(path, v) { try { localStorage.setItem(sceneBgKey(path), JSON.stringify(v)); } catch {} }
function sceneBgParams(bg) {
  if (!bg || !bg.on) return '';
  const hex = (bg.color || '#000000').replace('#', '');
  const op = Math.max(1, Math.min(100, bg.op == null ? 50 : bg.op));
  return 'bg=' + hex + '&bgop=' + op;
}
function withParam(url, extra) { return extra ? url + (url.includes('?') ? '&' : '?') + extra : url; }
function prettySceneName(file) {
  return file.replace(/\.html$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Merge curated SCENE_SOURCES with overlay HTML found on disk so newly-added scenes
// appear automatically (uncurated files land in an "Other Overlays" group).
function mergeSceneGroups(discovered) {
  const groups = SCENE_SOURCES.map((g) => ({ group: g.group, icon: g.icon, items: g.items.slice() }));
  const curated = new Set();
  groups.forEach((g) => g.items.forEach((it) => curated.add(it.path.split('?')[0].replace(/^\//, '').toLowerCase())));
  const extra = (discovered || []).filter((o) => o.file && !curated.has(o.file.toLowerCase()));
  if (extra.length) {
    groups.push({ group: 'Other Overlays', icon: 'film',
      items: extra.map((o) => ({ name: prettySceneName(o.file), path: o.path, live: null, desc: o.desc || 'Auto-discovered overlay.' })) });
  }
  return groups;
}

// One scene card: preview thumbnail only — name caption + hover icon actions
// (open / copy / settings) live ON the thumbnail; the per-graphic background-fill
// settings panel (colour + opacity %, off by default) drops below it when opened.
function buildSceneCard(it, groupName) {
  const base = SCENE_BASE_URL + it.path;
  const aspect = it.aspect || SCENE_DEFAULT_ASPECT;
  const _am = String(aspect).match(/(\d+)\s*[×x]\s*(\d+)/);
  const nativeW = _am ? +_am[1] : 1920, nativeH = _am ? +_am[2] : 1080;
  let bg = loadSceneBg(it.path);
  const liveUrl  = () => withParam(base, sceneBgParams(bg));
  const fullPrev = () => withParam(base + (base.includes('?') ? '&' : '?') + 'preview=1', sceneBgParams(bg));
  const thumbUrl = () => withParam(base + (base.includes('?') ? '&' : '?') + 'preview=1&thumb=1', sceneBgParams(bg));

  const card = document.createElement('div');
  card.className = 'scene-card';
  card.dataset.name = it.name || '';
  // Path included so a producer who knows the overlay's file (rl-hud.html) can search for it.
  card.dataset.search = (it.name + ' ' + (it.desc || '') + ' ' + groupName + ' ' + (it.path || '')).toLowerCase();
  card.dataset.live = it.live || '';
  card.dataset.path = sceneBasePath(it.path);
  // The browser-source URL, for one-click "Add to OBS" (Modern interface style reads it).
  card.dataset.url = liveUrl();
  const tip = String(it.desc || it.name).replace(/"/g, '&quot;');
  card.innerHTML = `
    <div class="scene-thumb" title="${tip}"><img class="scene-thumb-img" alt="" draggable="false" data-src="${SCENE_BASE_URL}/api/overlay-thumb?file=${encodeURIComponent(String(it.path || '').split('?')[0].split('/').pop())}"><iframe class="scene-thumb-frame" loading="lazy" scrolling="no" data-nw="${nativeW}" data-nh="${nativeH}" data-src="${thumbUrl()}"></iframe><span class="scene-thumb-block"></span><span class="scene-onair-pill" hidden>ON AIR</span><span class="scene-aspect">${aspect}</span><span class="scene-thumb-name">${it.name}</span>
      <div class="scene-thumb-acts">
        <button class="scene-thumb-btn ss-obs" title="Add to OBS (top layer of your current scene) or vMix (a Web Browser input), whichever is your switcher">${svgIcon('plus')}</button>
        <button class="scene-thumb-btn ss-open" title="Open in new window">${svgIcon('external')}</button>
        ${window.electronAPI?.openGameOverlay ? `<button class="scene-thumb-btn ss-game" title="Pop out over the game: transparent, always on top, click-through">${svgIcon('monitor')}</button>` : ''}
        <button class="scene-thumb-btn ss-copy" title="Copy browser-source URL">${svgIcon('copy')}</button>
        <button class="scene-thumb-btn ss-settings" title="Settings — background fill (colour + opacity) and Edit HTML">${svgIcon('gear')}</button>
      </div>
    </div>
    <div class="scene-bg-panel" hidden>
        <button class="btn btn-secondary btn-xs ss-edit scene-set-edit">Edit HTML</button>
        <label class="scene-bg-toggle"><input type="checkbox" class="ss-bg-on"><span>Background fill</span></label>
        <div class="scene-bg-controls">
          <input type="color" class="ss-bg-color" value="${bg.color || '#000000'}" title="Colour">
          <input type="range" class="ss-bg-op" min="1" max="100" value="${bg.op == null ? 50 : bg.op}" title="Opacity">
          <span class="ss-bg-op-val">${bg.op == null ? 50 : bg.op}%</span>
        </div>
        <div class="scene-bg-hint">Background fill updates live in OBS. Re-copy the URL only when adding this overlay as a new browser source.</div>
      </div>`;

  const thumb   = card.querySelector('.scene-thumb-frame');
  const bgBtn   = card.querySelector('.ss-settings');
  const panel   = card.querySelector('.scene-bg-panel');
  const onChk   = card.querySelector('.ss-bg-on');
  const colorIn = card.querySelector('.ss-bg-color');
  const opIn    = card.querySelector('.ss-bg-op');
  const opVal   = card.querySelector('.ss-bg-op-val');

  onChk.checked = !!bg.on;
  const reflect = () => bgBtn.classList.toggle('on', !!bg.on);
  reflect();
  function refreshThumb() {
    const src = thumbUrl();
    if (thumb.src) {
      thumb.addEventListener('load', function onl() { thumb.removeEventListener('load', onl); if (typeof _scaleThumb === 'function') _scaleThumb(thumb); }, { once: true });
      thumb.src = src;
    } else { thumb.dataset.src = src; }
  }
  function persist() { saveSceneBg(it.path, bg); send('set_scene_bg', { path: it.path, bg }); reflect(); refreshThumb(); }

  bgBtn.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; });
  onChk.addEventListener('change', () => { bg.on = onChk.checked; persist(); });
  colorIn.addEventListener('input', () => { bg.color = colorIn.value; persist(); });
  opIn.addEventListener('input', () => { bg.op = parseInt(opIn.value, 10); opVal.textContent = bg.op + '%'; persist(); });

  card.querySelector('.ss-obs').addEventListener('click', (e) => {
    e.stopPropagation();
    const sw = activeSwitcher();
    if (!sw.ready) {
      showToast(`Connect ${sw.name} first (Apps > ${sw.vmix ? 'vMix' : 'OBS Studio'}), then add overlays in one click.`, '#f59e0b', 5000);
      return;
    }
    const label = String(it.name || 'Overlay').replace(/[★]/g, '').trim();
    send('obs_add_overlay', { sourceName: 'NE ' + label, url: liveUrl(), width: nativeW, height: nativeH });
  });
  card.querySelector('.ss-open').addEventListener('click', (e) => { e.stopPropagation(); window.open(liveUrl(), '_blank'); });
  card.querySelector('.ss-game')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.electronAPI.openGameOverlay({ url: liveUrl(), path: it.path, name: it.name, nativeW, nativeH })
      .then((r) => { if (!r || !r.ok) showToast('Could not open the overlay window.', '#ef4444'); })
      .catch(() => showToast('Could not open the overlay window.', '#ef4444'));
  });
  card.querySelector('.ss-edit').addEventListener('click', () => openSceneEditor(it.path, it.name));
  card.querySelector('.scene-thumb').addEventListener('click', () => window.open(fullPrev(), '_blank'));
  // The live overlay only runs while the pointer rests on the card; the cached picture does the rest.
  (function hoverLive() {
    const box = card.querySelector('.scene-thumb');
    let onT = null, offT = null;
    box.addEventListener('mouseenter', () => {
      clearTimeout(offT);
      onT = setTimeout(() => {
        onT = null;
        if (!thumb.src) { thumb.addEventListener('load', function () { _scaleThumb(thumb); box.classList.add('is-live'); }, { once: true }); thumb.src = thumb.dataset.src; }
        else box.classList.add('is-live');
      }, 350);
    });
    box.addEventListener('mouseleave', () => {
      clearTimeout(onT); onT = null;
      offT = setTimeout(() => { box.classList.remove('is-live'); if (thumb.src) thumb.removeAttribute('src'); }, 1200);
    });
  })();
  const copyBtn = card.querySelector('.ss-copy');
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const url = liveUrl();
    const done = () => { copyBtn.innerHTML = svgIcon('check'); copyBtn.classList.add('ok'); setTimeout(() => { copyBtn.innerHTML = svgIcon('copy'); copyBtn.classList.remove('ok'); }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done).catch(() => customPrompt('Copy link', 'Select the link and copy it.', url, 'Done'));
    else customPrompt('Copy link', 'Select the link and copy it.', url, 'Done');
  });
  return card;
}

// Overlays popped out over the game (backend/game-overlay-windows.js). Listed above the scene
// cards while any are open, so a producer can lock/unlock or close one without hunting for it
// on screen. Electron-only: browser/pop-out panels have no electronAPI and never show this.
function renderGameOverlayMgr(list) {
  const box = el('game-overlay-mgr');
  if (!box) return;
  list = Array.isArray(list) ? list : [];
  box.hidden = !list.length;
  if (!list.length) { box.innerHTML = ''; return; }
  const hidden = list.some((o) => o.hidden);
  box.innerHTML = `
    <div class="go-mgr-head">
      <span class="go-mgr-title">Over-game overlays</span>
      <span class="go-mgr-keys">Ctrl+Shift+F9 lock / unlock all &middot; Ctrl+Shift+F10 hide / show all</span>
      <button class="btn btn-ghost btn-xs" data-go-all="toggle-hidden">${hidden ? 'Show all' : 'Hide all'}</button>
      <button class="btn btn-ghost btn-xs" data-go-all="close-all">Close all</button>
    </div>
    ${list.map((o) => `
      <div class="go-mgr-row" data-key="${tlEsc(o.key)}">
        <span class="go-mgr-name">${tlEsc(o.name)}</span>
        <span class="go-mgr-state ${o.locked ? 'locked' : 'edit'}">${o.locked ? 'Locked' : 'Editing'}</span>
        <span class="go-mgr-meta">${o.scale}% &middot; ${o.opacity}% opacity</span>
        <button class="btn btn-ghost btn-xs" data-go="next-screen" title="Move to the next monitor and fill it">Next screen</button>
        <button class="btn btn-secondary btn-xs" data-go="toggle-lock">${o.locked ? 'Edit position' : 'Lock'}</button>
        <button class="btn btn-ghost btn-xs" data-go="close">Close</button>
      </div>`).join('')}`;
}
if (window.electronAPI?.onGameOverlaysChanged) {
  window.electronAPI.onGameOverlaysChanged(renderGameOverlayMgr);
  window.electronAPI.listGameOverlays().then(renderGameOverlayMgr).catch(() => {});
  document.addEventListener('click', (e) => {
    const all = e.target.closest('#game-overlay-mgr [data-go-all]');
    if (all) { window.electronAPI.gameOverlayCommand(null, all.dataset.goAll); return; }
    const b = e.target.closest('#game-overlay-mgr [data-go]');
    if (!b) return;
    const row = b.closest('.go-mgr-row');
    if (row) window.electronAPI.gameOverlayCommand(row.dataset.key, b.dataset.go);
  });
}

async function buildSceneSourceList() {
  const wrap = el('scene-source-list');
  if (!wrap || wrap.dataset.built) return;
  wrap.dataset.built = '1';

  let discovered = [];
  try { const r = await fetch(SCENE_BASE_URL + '/api/overlays'); const j = await r.json(); discovered = (j && j.overlays) || []; } catch {}
  const groups = mergeSceneGroups(discovered);
  const totalScenes = groups.reduce((n, g) => n + g.items.length, 0);

  // ── Top bar: search ───────────────────────────────────────────────────────
  const topbar = document.createElement('div');
  topbar.className = 'scene-topbar';
  topbar.innerHTML = `
    <div class="scene-search">
      <span class="scene-search-ico">${svgIcon('search')}</span>
      <input type="text" id="scene-search-input" placeholder="Search ${totalScenes} overlays…" autocomplete="off" spellcheck="false">
      <button class="scene-search-clear" id="scene-search-clear" title="Clear" hidden>×</button>
    </div>
    <label class="scene-game-only" title="Hide HUDs and boards made for other games">
      <input type="checkbox" id="scene-game-only"${_sceneGameOnly ? ' checked' : ''}>
      <span id="scene-game-only-label">Only this game</span>
    </label>`;
  wrap.appendChild(topbar);
  topbar.querySelector('#scene-game-only').addEventListener('change', (e) => {
    _sceneGameOnly = e.target.checked;
    try { localStorage.setItem('ne_scene_game_only', _sceneGameOnly ? '1' : '0'); } catch {}
    applySceneFilter();
  });

  // ── Two-column layout: sidebar nav + groups area ─────────────────────────
  const layout = document.createElement('div');
  layout.className = 'scene-layout';
  wrap.appendChild(layout);

  const nav = document.createElement('nav');
  nav.className = 'scene-nav';
  nav.id = 'scene-nav';
  layout.appendChild(nav);

  const main = document.createElement('div');
  main.className = 'scene-groups-area';
  main.id = 'scene-groups-area';
  layout.appendChild(main);
  const startNote = document.createElement('div');
  startNote.className = 'scene-start-note';
  startNote.id = 'scene-start-note';
  startNote.innerHTML = '<div><strong>The sources most shows need.</strong> <strong>Live HUD</strong> shows the HUD of the game set in the app; <strong>Graphics</strong> shows everything you put on air from the Graphics panel (countdown, winner, bracket and the rest), so keep it on top and do not add those graphics separately. Press <span class="scene-start-plus">+</span> on a card to add it to OBS (top layer of your current scene) or vMix (a Web Browser input).</div>'
    + '<div class="scene-start-build">Starting from scratch? <button type="button" class="btn btn-secondary btn-xs" id="scene-build-scenes">Build show scenes</button> sets up OBS scenes or vMix inputs around these two sources and wires the automatic cuts.</div>';
  main.appendChild(startNote);
  startNote.querySelector('#scene-build-scenes').addEventListener('click', () => buildObsShowScenes());

  // ── Sidebar nav items ─────────────────────────────────────────────────────
  const mkNavItem = (key, label, iconHtml, count) => {
    const b = document.createElement('button');
    b.className = 'scene-nav-item' + (key === _sceneFilterGroup ? ' active' : '');
    b.dataset.group = key;
    b.innerHTML = (iconHtml ? `<span class="scene-nav-ico">${iconHtml}</span>` : '') + `<span class="scene-nav-label">${label}</span><span class="scene-nav-count">${count}</span>`;
    b.addEventListener('click', () => { _sceneFilterGroup = key; applySceneFilter(); });
    return b;
  };
  nav.appendChild(mkNavItem('__start', 'Start here', svgIcon('star'), 0));
  nav.appendChild(mkNavItem('all', 'All', '', totalScenes));
  const onAirItem = mkNavItem('__onair', 'On Air', '<span class="scene-chip-dot"></span>', 0);
  onAirItem.id = 'scene-nav-onair';
  nav.appendChild(onAirItem);
  const navSep = document.createElement('div');
  navSep.className = 'scene-nav-sep';
  nav.appendChild(navSep);
  groups.forEach((g) => nav.appendChild(mkNavItem(g.group, g.group, svgIcon(g.icon), g.items.length)));

  // ── Groups: grid of preview cards ─────────────────────────────────────────
  groups.forEach((g) => {
    const section = document.createElement('div');
    section.className = 'scene-group';
    section.dataset.group = g.group;
    const head = document.createElement('div');
    head.className = 'scene-group-head';
    head.innerHTML = `<span class="scene-group-ico">${svgIcon(g.icon)}</span><span class="scene-group-name">${g.group}</span><span class="scene-group-count">${g.items.length}</span>`;
    section.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'scene-card-grid';
    g.items.forEach((it) => grid.appendChild(buildSceneCard(it, g.group)));
    section.appendChild(grid);
    main.appendChild(section);
  });

  // ── Search ────────────────────────────────────────────────────────────────
  const search = topbar.querySelector('#scene-search-input');
  const clearBtn = topbar.querySelector('#scene-search-clear');
  NESearch.bindBox(search, (q) => {
    _sceneFilterText = q;
    clearBtn.hidden = !_sceneFilterText;
    applySceneFilter();
  });
  clearBtn.addEventListener('click', () => { search.value = ''; _sceneFilterText = ''; clearBtn.hidden = true; applySceneFilter(); });

  applySceneFilter();
  refreshSceneOnAir(currentState);
  if (el('tab-media-content')?.classList.contains('active') && _assetsTab === 'overlays' && typeof loadScenePreviews === 'function') loadScenePreviews();
}

function applySceneFilter() {
  const wrap = el('scene-source-list');
  if (!wrap) return;
  document.querySelectorAll('#scene-nav .scene-nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.group === _sceneFilterGroup));
  // When a keyword search is active, flatten the group sections into one dense grid
  // (CSS .searching) so matches don't scatter across stacked headers → far less scrolling.
  const area = el('scene-groups-area');
  const st = currentState || {};
  // Start here = one card per starter source, in whichever group it lives. Searching always
  // looks through everything, so a typed name is never hidden by the short list.
  const starting = _sceneFilterGroup === '__start' && !_sceneFilterText;
  const startSet = new Set(sceneStartPaths(st));
  const seenStart = new Set();
  wrap.querySelectorAll('.scene-card').forEach((c) => {
    const p = c.dataset.path || '';
    const isStart = startSet.has(p) && !seenStart.has(p);
    if (isStart) seenStart.add(p);
    c.classList.toggle('is-start', isStart);
  });
  if (area) {
    area.classList.toggle('searching', !!_sceneFilterText || starting);
    area.classList.toggle('starting', starting);
  }
  const gameName = (((st.games || {})[st.activeGame]) || {}).name;
  const gLabel = el('scene-game-only-label');
  if (gLabel) gLabel.textContent = gameName ? 'Only ' + gameName : 'Only this game';
  const gameOk = (item) => !_sceneGameOnly || sceneFitsGame(item.dataset.path, st);
  // Rank across ALL groups at once: while searching, the sections collapse to `display: contents`
  // and every card becomes a direct grid item, so the best match genuinely lands top-left instead
  // of wherever its group happened to sit.
  const groupOk = (item) => {
    if (starting) return item.classList.contains('is-start');
    if (!gameOk(item)) return false;
    if (_sceneFilterGroup === '__onair') return item.classList.contains('is-onair');
    if (_sceneFilterGroup === 'all' || _sceneFilterGroup === '__start') return true;
    const sec = item.closest('.scene-group');
    return !!sec && sec.dataset.group === _sceneFilterGroup;
  };
  // Nav counts follow the game filter, and a group with nothing for this game is hidden.
  let allCount = 0;
  wrap.querySelectorAll('.scene-group').forEach((section) => {
    const n = Array.prototype.filter.call(section.querySelectorAll('.scene-card'), gameOk).length;
    allCount += n;
    const navItem = Array.prototype.find.call(document.querySelectorAll('#scene-nav .scene-nav-item'), (b) => b.dataset.group === section.dataset.group);
    if (navItem) {
      const c = navItem.querySelector('.scene-nav-count'); if (c) c.textContent = n;
      navItem.hidden = !n;
    }
  });
  document.querySelectorAll('#scene-nav .scene-nav-item').forEach((b) => {
    const c = b.querySelector('.scene-nav-count');
    if (!c) return;
    if (b.dataset.group === 'all') c.textContent = allCount;
    if (b.dataset.group === '__start') c.textContent = seenStart.size;
  });
  const activeNav = Array.prototype.find.call(document.querySelectorAll('#scene-nav .scene-nav-item'), (b) => b.dataset.group === _sceneFilterGroup);
  if (activeNav && activeNav.hidden) { _sceneFilterGroup = 'all'; applySceneFilter(); return; }
  const searchIn = el('scene-search-input');
  if (searchIn) searchIn.placeholder = `Search ${allCount} overlays…`;
  const note = el('scene-start-note');
  if (note) note.hidden = !starting;
  const totalShown = NESearch.rankNodes(
    wrap.querySelectorAll('.scene-card'),
    _sceneFilterText,
    (item) => [{ text: item.dataset.name || '', weight: 2 }, { text: item.dataset.search || '', bag: true }],
    { extra: groupOk }
  ).shown;
  // A section with nothing left is hidden so its header doesn't float over an empty row.
  wrap.querySelectorAll('.scene-group').forEach((section) => {
    const anyShown = Array.prototype.some.call(
      section.querySelectorAll('.scene-card'), (c) => c.style.display !== 'none');
    section.style.display = anyShown ? '' : 'none';
  });
  let empty = el('scene-empty');
  if (!empty) {
    empty = document.createElement('div');
    empty.id = 'scene-empty';
    empty.className = 'scene-empty';
    empty.textContent = 'No overlays match your search.';
    const groupsArea = el('scene-groups-area');
    if (groupsArea) groupsArea.appendChild(empty);
    else wrap.appendChild(empty);
  }
  empty.style.display = totalShown ? 'none' : '';
}

// Light up the ON AIR pill on any scene whose `live` state path is currently truthy.
function refreshSceneOnAir(state) {
  const wrap = el('scene-source-list');
  if (!wrap || !wrap.dataset.built) return;
  if (!el('tab-media-content')?.classList.contains('active')) return;   // nothing to light up while hidden
  let liveCount = 0;
  wrap.querySelectorAll('.scene-card').forEach((card) => {
    const key = card.dataset.live;
    let on = false;
    if (key && key !== 'always') on = !!getPath(state || {}, key);
    card.classList.toggle('is-onair', on);
    const pill = card.querySelector('.scene-onair-pill');
    if (pill) pill.hidden = !on;
    if (on) liveCount++;
  });
  const navOnAir = el('scene-nav-onair');
  if (navOnAir) { const c = navOnAir.querySelector('.scene-nav-count'); if (c) c.textContent = liveCount; }
  const badge = el('scene-onair-count');
  if (badge) { badge.textContent = liveCount ? `${liveCount} on air` : ''; badge.style.display = liveCount ? '' : 'none'; }
  const cs = currentState || {};
  const gameSig = (cs.activeGame || '') + '|' + (cs.activeOverlay || '') + '|' + !!(cs.games && cs.games[cs.activeGame]);
  if (_sceneFilterGroup === '__onair' || gameSig !== _sceneGameSig) { _sceneGameSig = gameSig; applySceneFilter(); }
}

// Scene preview iframes each load a full overlay (WebSocket + animation loops),
// so we only let them run while the Scenes tab is open. Loading is staggered to
// avoid a burst locking up the main thread. After each frame loads we inject
// body.style.zoom so the 1920×1080 scene scales to fit the thumbnail box.
let _scenePreviewTimer = null;
// Scale the whole iframe (rendered at the scene's native size) down to fit its thumbnail box.
// Works regardless of how the overlay scales itself internally.
function _scaleThumb(f) {
  try {
    const box = f.parentElement; if (!box) return;
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    const nw = parseInt(f.dataset.nw, 10) || 1920;
    const nh = parseInt(f.dataset.nh, 10) || 1080;
    f.style.width = nw + 'px';
    f.style.height = nh + 'px';
    const s = Math.min(bw / nw, bh / nh);
    f.style.transform = `translate(${(bw - nw * s) / 2}px, ${(bh - nh * s) / 2}px) scale(${s})`;
  } catch (e) {}
}
// Keep all visible thumbs correctly scaled when the window/grid resizes.
let _thumbResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_thumbResizeTimer);
  _thumbResizeTimer = setTimeout(() => { document.querySelectorAll('.scene-thumb-frame[src]').forEach(_scaleThumb); }, 150);
});
// Each scene preview is a FULL live overlay page (its own WS connection + animation loop, some with
// three.js). Running one per thumbnail all at once — dozens of them, with GPU accel off — pegged the
// CPU and made the whole app lag. Only run the previews actually ON SCREEN: an IntersectionObserver
// loads a thumb's iframe when it scrolls into view and frees it (drops src → kills its WS + animation)
// when it leaves. Keeps the live-iframe count to the handful that are visible instead of all of them.
let _sceneIO = null;
function loadScenePreviews() {
  if (_scenePreviewTimer) { clearTimeout(_scenePreviewTimer); _scenePreviewTimer = null; }
  if (_sceneIO) { _sceneIO.disconnect(); _sceneIO = null; }
  // Cards show a cached picture (/api/overlay-thumb) as they scroll into view; it stays loaded, so
  // coming back to the page is instant. The live overlay itself only runs on hover (see hoverLive).
  const imgs = Array.from(document.querySelectorAll('.scene-thumb-img[data-src]'));
  if (!imgs.length) return;
  const scrollRoot = document.getElementById('tab-scroll') || null;   // the app's main scroll container
  const loadImg = (im) => {
    if (im.src || im._retry) return;
    im.onerror = () => {   // 202 = still being captured; ask again shortly, a few times
      im.removeAttribute('src');
      im._tries = (im._tries || 0) + 1;
      if (im._tries > 12) return;
      im._retry = setTimeout(() => { im._retry = null; loadImg(im); }, 4000 + im._tries * 1000);
    };
    im.onload = () => { im.classList.add('is-ready'); };
    im.src = im.dataset.src + (im._tries ? '&r=' + im._tries : '');
  };
  _sceneIO = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) loadImg(en.target); });
  }, { root: scrollRoot, rootMargin: '400px', threshold: 0.01 });
  imgs.forEach((im) => _sceneIO.observe(im));
}
function unloadScenePreviews() {
  if (_scenePreviewTimer) { clearTimeout(_scenePreviewTimer); _scenePreviewTimer = null; }
  if (_sceneIO) { _sceneIO.disconnect(); _sceneIO = null; }
  document.querySelectorAll('.scene-thumb-frame').forEach((f) => {
    if (f._loadT) { clearTimeout(f._loadT); f._loadT = null; }   // cancel a deferred load in flight
    if (f.src) f.removeAttribute('src');
  });
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
  // The source file is the same regardless of any ?query params on the URL (e.g. ?src=main).
  path = String(path).split('?')[0];
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
  if (!_seScene) return;
  if (!await appConfirm('Remove your override and restore the original scene?', 'Restore Original')) return;
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

function renderWatchlistInfo(data) {
  const infoEl = el('ck-watchlist-info'); if (!infoEl) return;
  const teams = (data.watchlist && data.watchlist.teams) || [];
  if (!teams.length) {
    infoEl.textContent = 'No teams — star teams on Events tab';
  } else {
    infoEl.textContent = teams.map((t) => t.name || '').filter(Boolean).join(', ');
  }
}

// Reflect live visibility into the toggles + card highlight.
function renderScenePresets(data) {
  const presets = data.scenePresets || {};
  document.querySelectorAll('.gfx-cust-bar[data-scene]').forEach((bar) => {
    const key = bar.dataset.scene;
    const sp = presets[key] || { active: 'Default', presets: {} };
    const active = sp.active || 'Default';
    // 'Default' is a sentinel meaning "no override, use the brand kit's theme" — it's never a
    // selectable option (the "Reset" button below activates it directly); the dropdown only
    // ever lists real saved presets.
    const names = Object.keys(sp.presets || {}).filter((n) => n !== 'Default' && n !== '__preview__');
    const sig = active + '|' + names.join(',');

    const sel  = bar.querySelector(`[data-cust-sel="${key}"]`);
    const lbl  = bar.querySelector(`[data-cust-active="${key}"]`);
    if (sel && sel.dataset.rspSig !== sig) {
      sel.innerHTML = names.map((n) => `<option value="${n}"${n === active ? ' selected' : ''}>${n}</option>`).join('');
      sel.dataset.rspSig = sig;
    }
    if (lbl) lbl.textContent = active === 'Default' ? 'Brand theme' : active;

    // Update color pickers and font selector from the active preset's config (skip __preview__).
    if (active === '__preview__') return;
    const cfg = ((sp.presets || {})[active] || {}).config || {};
    const c1  = bar.querySelector(`[data-cust-c1="${key}"]`);
    const c2  = bar.querySelector(`[data-cust-c2="${key}"]`);
    const fnt = bar.querySelector(`[data-cust-font="${key}"]`);
    const GFX_DA  = '#e83a8b';
    const GFX_DA2 = '#8b5cf6';
    if (c1)  c1.value  = cfg.accent  || GFX_DA;
    if (c2)  c2.value  = cfg.accent2 || GFX_DA2;
    if (fnt) fnt.value = cfg.font    || '';
  });
}

// ── What's Armed — every automation that can act on its own + the unified activity log ──
let _armedSig = '', _autoLogSig = '';
function renderWhatsArmed(data) {
  const list = el('armed-list');
  if (list) {
    const items = [];
    const add = (kind, text, warn) => items.push({ kind, text, warn: !!warn });
    if (data.ai && data.ai.shield) add('SHIELD', 'AI Shield ENGAGED — all scene automation paused', true);
    const obs = data.obs || {};
    if (obs.kickoff && obs.kickoff.enabled && obs.kickoff.scene) add('RL', `Kickoff → cut to "${obs.kickoff.scene}"`);
    if (obs.postGame && obs.postGame.enabled && obs.postGame.scene) add('RL', `Post-game → "${obs.postGame.scene}" after ${obs.postGame.delaySec || 20}s`);
    const bs = data.breakScreen || {};
    if (bs.visible && bs.endsAt && bs.thenScene) add('BREAK', `Countdown ends → cut to "${bs.thenScene}"`);
    (data.flows || []).forEach((f) => {
      if (!f.enabled) return;
      (f.triggers || []).forEach((t) => {
        if (t.type === 'obs_scene_dwell') {
          const p = t.params || {};
          add('FLOW', `${f.name || 'Flow'}: after ${p.seconds || 30}s on ${p.scene ? `"${p.scene}"` : 'any scene'}`);
        }
      });
      if ((f.actions || []).some((a) => a.type === 'obs_scene' || a.type === 'obs_scene_previous')) {
        const trigs = (f.triggers || []).map((t) => t.type).filter((t) => t !== 'manual' && t !== 'obs_scene_dwell');
        if (trigs.length) add('FLOW', `${f.name || 'Flow'}: scene cut on ${trigs.join(' / ').replace(/_/g, ' ')}`);
      }
    });
    const dir = data.director || {};
    if (dir.enabled && dir.autoSwitch) add('AI', 'CS2 auto-spectate — observer keys on game events');
    const clips = data.clips || {};
    if (clips.autoCapture !== false && (clips.captureMode || 'auto') === 'auto') add('CLIPS', 'Auto-clipping game moments (silent)');
    const sg = data.startgg || {};
    if (sg.autoFollow && sg.queueEnabled) add('QUEUE', 'Auto-follow — live start.gg set replaces the scoreboard');
    // Topbar ON AIR strip — ARMED chip mirrors this list so the producer sees the count
    // without opening the panel. Click-through wired once, here, because this renderer is
    // the single owner of the armed-items computation.
    const armedChip = el('ck-chip-armed');
    if (armedChip) {
      armedChip.textContent = 'ARMED: ' + items.length;
      armedChip.classList.toggle('is-on', items.length > 0);
      armedChip.classList.toggle('is-warn', items.some((i) => i.warn));
      if (!armedChip._wired) {
        armedChip._wired = true;
        armedChip.addEventListener('click', () => {
          document.querySelector('.tab-btn[data-tab="principal"]')?.click();
          setTimeout(() => el('whats-armed')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
        });
      }
    }
    const sig = JSON.stringify(items);
    if (sig !== _armedSig) {
      _armedSig = sig;
      list.innerHTML = items.length ? items.map((i) =>
        `<div style="display:flex; align-items:center; gap:8px; padding:7px 10px; background:${i.warn ? 'rgba(251,191,36,.08)' : 'rgba(255,255,255,.03)'}; border:1px solid ${i.warn ? 'rgba(251,191,36,.35)' : 'var(--border)'}; border-radius:8px;">
          <span style="flex:0 0 auto; font-size:9px; font-weight:800; letter-spacing:.08em; padding:2px 7px; border-radius:99px; background:rgba(139,92,246,.16); color:#c4b5fd;">${tlEsc(i.kind)}</span>
          <span style="font-size:12px; color:${i.warn ? '#fbbf24' : 'var(--text,#e8eaf0)'};">${tlEsc(i.text)}</span>
        </div>`).join('')
        : '<div style="font-size:12px; color:var(--muted); padding:6px 2px;">Nothing armed — every scene change is manual right now.</div>';
    }
  }
  const logEl = el('auto-log');
  if (logEl) {
    const log = data.autoLog || [];
    const sig = log.length ? log[0].ts + ':' + log.length : '0';
    if (sig !== _autoLogSig) {
      _autoLogSig = sig;
      logEl.innerHTML = log.length ? log.map((e) => {
        const t = new Date(e.ts);
        const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
        return `<div style="display:flex; gap:8px; align-items:baseline; padding:3px 0; border-bottom:1px solid rgba(255,255,255,.04);">
          <span style="flex:0 0 auto; font-family:monospace; font-size:10px; color:var(--muted);">${hh}</span>
          <span style="flex:0 0 auto; font-size:9px; font-weight:800; letter-spacing:.06em; color:#8b93a8; text-transform:uppercase;">${tlEsc(e.kind)}</span>
          <span style="min-width:0; color:var(--text,#e8eaf0);">${tlEsc(e.message)}</span>
        </div>`;
      }).join('')
      : '<div style="font-size:12px; color:var(--muted);">No automated actions yet this session.</div>';
    }
  }
}

// Paint the On-Air Elements grid from state. Uses onairIsOn (not a raw path read) so Matchup —
// whose "path" is the shared gfxActive string — doesn't read as SHOWN whenever ANY graphic is live.
function syncOnAirGrid(data) {
  let liveHere = 0;
  ONAIR_SCENES.forEach((s) => {
    const on = (typeof onairIsOn === 'function') ? onairIsOn(s, data) : !!getPath(data, s.path);
    const cb = el('air-' + s.key);
    if (cb) cb.checked = on;
    const card = el('air-card-' + s.key);
    if (card) { card.classList.toggle('live', on); if (on) liveHere++; }   // only cards that exist here
    const st = el('air-state-' + s.key);
    if (st) st.textContent = on ? 'SHOWN' : 'HIDDEN';
  });
  const countEl = el('qrail-onair-count');
  if (countEl) {
    countEl.textContent = String(liveHere);
    countEl.classList.toggle('is-zero', liveHere === 0);
    countEl.title = liveHere ? liveHere + ' of these overlays on air' : 'No overlays from this group on air';
  }
}

function applyScenesCockpit(data) {
  renderCockpitStatus(data);
  renderWatchlistInfo(data);
  syncOnAirGrid(data);
}

document.querySelectorAll('.js-cut-all').forEach((btn) => {
  btn.addEventListener('click', () => {
    ONAIR_SCENES.forEach((s) => send(s.msg, s.hideData || { visible: false }));
    // Drop the gfx.html layer too — hiding every overlay flag while gfxActive still named one left
    // the top bar (and the boards) reading ON AIR for a graphic nothing was showing anymore.
    send('set_gfx_active', { scene: null });
    if (currentState) currentState.gfxActive = null;
    if (typeof window._gfxRefreshTopBar === 'function') window._gfxRefreshTopBar();
  });
});

// ── "Go Live" triggers — one toggle per graphic that reflects what's ON AIR ──
// Each button shows the graphic's live state (green "On Air" when visible) and a
// single click flips it: live → hide, off → show with the row's current options.
const GOLIVE_TRIGGERS = [
  { toggle: 'ck-break-toggle',    state: 'breakScreen', sceneKey: 'break',    msg: 'set_break',    show: () => startBreakFromRail() },
  { toggle: 'ck-matchup-toggle',  state: 'matchup',     sceneKey: 'matchup',  pushOnly: true },
  { toggle: 'ck-winner-toggle',   state: 'winner',      sceneKey: 'winner',   msg: 'set_winner',   show: () => ({ visible: true, side: ((window._qkWinnerAuto !== false) && window._winnerLeadingSide && window._winnerLeadingSide(currentState)) || el('ck-winner-side')?.value || 'blue' }) },
  { toggle: 'ck-intro-toggle',    state: 'intro',       sceneKey: 'intro',    msg: 'set_intro',    show: () => ({ visible: true, side: el('ck-intro-side')?.value || 'blue' }) },
  { toggle: 'ck-veto-toggle',     state: 'veto',        sceneKey: 'veto',     msg: 'set_veto',     show: () => ({ visible: true }) },
  { toggle: 'ck-spotlight-toggle',state: 'watchlist',   sceneKey: 'spotlight',msg: 'set_watchlist',show: () => ({ visible: true }) },
  { toggle: 'ck-schedule-toggle', state: 'upcoming',    sceneKey: 'upcoming', msg: 'set_upcoming', show: () => ({ visible: true }) },
];
GOLIVE_TRIGGERS.forEach((t) => {
  el(t.toggle)?.addEventListener('click', () => {
    const gfxLive = !!(currentState && currentState.gfxActive === t.sceneKey);
    const overlayLive = !!(currentState && currentState[t.state] && currentState[t.state].visible);
    const live = gfxLive || overlayLive;
    if (live) {
      if (!t.pushOnly) send(t.msg, { visible: false });
      send('set_gfx_active', { scene: '' });
      if (currentState) currentState.gfxActive = '';
      if (window._gfxRefreshTopBar) window._gfxRefreshTopBar();
    } else {
      // Clear whichever GFX scene is currently active before pushing ours.
      const prev = currentState && currentState.gfxActive;
      if (prev && prev !== t.sceneKey && window._gfxSceneMeta && window._gfxSceneMeta[prev]) {
        gfxHide(prev);
      }
      if (!t.pushOnly) send(t.msg, t.show());
      send('set_gfx_active', { scene: t.sceneKey });
      if (currentState) currentState.gfxActive = t.sceneKey;
      if (window._gfxRefreshTopBar) window._gfxRefreshTopBar();
      if (el('gfx-autocut-on')?.checked) {
        const sc = (el('gfx-autocut-scene')?.value || '').trim();
        if (sc) send('obs_switch_scene', { sceneName: sc });
      }
    }
  });
});
// All trigger graphics share one browser source (overlay/triggers.html).
el('btn-copy-triggers-url')?.addEventListener('click', (e) => {
  const url = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000') + '/triggers.html';
  if (typeof copyText === 'function') copyText(url, e.currentTarget);
  else if (navigator.clipboard) navigator.clipboard.writeText(url);
});
// Copy the standalone countdown overlay URL from the rail Countdown trigger.
el('ck-break-copy')?.addEventListener('click', (e) => {
  const url = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://localhost:3000') + '/countdown.html';
  if (typeof copyText === 'function') copyText(url, e.currentTarget);
  else if (navigator.clipboard) navigator.clipboard.writeText(url);
});
// Pop the whole Go Live trigger bar out into its own window.
el('gl-popout')?.addEventListener('click', () => openPopout('triggers'));

function renderGoLive(data) {
  let liveCount = 0;
  GOLIVE_TRIGGERS.forEach((t) => {
    const btn = el(t.toggle); if (!btn) return;
    const live = !!(data[t.state] && data[t.state].visible) || data.gfxActive === t.sceneKey;
    if (live) liveCount++;
    const row = btn.closest('.gl-row');
    if (row) row.classList.toggle('live', live);
    btn.textContent = live ? '● On Air' : 'Push Live';
    btn.title = live ? 'Click to take off air' : 'Push this graphic live';
  });
  const count = el('gl-live-count');
  if (count) count.textContent = liveCount ? `${liveCount} live` : '';
  const dot = el('qrail-golive-dot');
  // Surface the on-air summary (every overlay, not just the trigger-bar subset) on the AIR tab's
  // dot — a count badge when more than one thing is live, a hover tooltip either way. Not a second
  // topbar pill: a prior GFX topbar pill was intentionally removed per user request, and this
  // doesn't reopen that — it lives on the rail tab itself.
  const summary = (typeof onAirSummary === 'function') ? onAirSummary(data) : null;
  const anyLive = liveCount > 0 || (summary && summary.count > 0);
  if (dot) {
    dot.classList.toggle('on', anyLive);
    dot.classList.toggle('has-count', !!(summary && summary.count > 1));
    dot.textContent = (summary && summary.count > 1) ? String(summary.count) : '';
    if (summary) dot.title = summary.label;
  }
  if (summary) {
    const airTab = document.querySelector('.qrail-tab[data-qtab="quick"]');
    if (airTab) airTab.title = 'Air — scenes, overlays & triggers · ' + summary.label;
  }
  const view = data.view || 'hud';
  document.querySelectorAll('#gl-view-seg .gl-seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
}
el('ck-view-scoreboard')?.addEventListener('click', () => send('force_scoreboard'));
el('ck-view-hud')?.addEventListener('click', () => send('force_hud'));

// (Events domain lives in events.js)

// (Spotlight domain + shared event helpers live in spotlight.js)

// (Leagues domain lives in leagues.js)

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
  const hasRL  = feats.includes('stats-api');
  const hasGSI = feats.includes('gsi');
  if (hasRL)  chip('ck-chip-rl', 'RL API', !!data.rlConnected);
  if (hasGSI) chip('ck-chip-cs2', 'CS2', !!(data.csgo && data.csgo.connected));
  const obs = data.obs || {};
  chip('ck-chip-obs', 'OBS', obs.connected ? true : (obs.enabled ? null : false));
  const vdoReady = !!(data.casters && data.casters.vdo && data.casters.vdo.room) ||
    ['blue', 'orange'].some((s) => data.teams && data.teams[s] && data.teams[s].vdo && data.teams[s].vdo.room);
  chip('ck-chip-vdo', vdoReady ? 'VDO' : 'VDO: not set up', vdoReady ? true : null);
  const tw = data.twitch || currentState.twitch || {};
  chip('ck-chip-twitch', tw.connected ? 'Twitch' : 'Twitch: off', tw.connected ? true : false);
  const sg = data.startgg || {};
  const sgOn = sg.enabled || sg.queueEnabled;
  chip('ck-chip-startgg', sg.connected ? 'start.gg' : (sgOn ? 'start.gg: syncing' : 'start.gg: off'),
    sg.connected ? true : (sgOn && sg.hasToken ? null : false));
  const ev = el('ck-chip-event');
  if (ev) {
    const hasEvent = !!data.eventName;
    const evText = el('ck-chip-event-text');
    if (evText) evText.textContent = hasEvent ? data.eventName : 'No event';
    else ev.textContent = hasEvent ? data.eventName : 'No event';
    ev.style.display = hasEvent ? '' : 'none';
    const evLogo = el('ck-chip-event-logo');
    if (evLogo) {
      // Event's own platform logo first, then the in-app league feeding the broadcast, then the brand kit.
      const _lid = data.competition && data.competition.leagueId;
      const _lg = _lid && (data.leagues || []).find((l) => l && l.id === _lid);
      const logo = (data.activeEvent && data.activeEvent.logo) || (_lg && _lg.logo) || (data.brand && data.brand.logo) || '';
      if (logo) { if (evLogo.getAttribute('src') !== logo) evLogo.src = logo; evLogo.style.display = 'block'; }
      else evLogo.style.display = 'none';
    }
  }

  // ── 3-bar connection signal widget ──────────────────────────────────────────
  const signal = el('conn-signal');
  const tooltipRows = el('conn-tooltip-rows');
  if (signal && tooltipRows) {
    // Gather per-service states: { label, ok: true/false/null }
    const _sw = activeSwitcher(), _swS = _sw.vmix ? (data.vmix || {}) : obs;
    const services = [
      { label: 'Server',   ok: true },
      { label: _sw.name, ok: _swS.connected ? true : (_swS.enabled ? null : false),
        status: _swS.connected ? (_swS.currentScene || 'connected') : (_swS.enabled ? 'connecting…' : 'off') },
      { label: 'Twitch',   ok: tw.connected ? true : false,
        status: tw.connected ? (tw.username || 'connected') : 'not connected' },
      { label: 'start.gg', ok: sg.connected ? true : (sgOn && sg.hasToken ? null : false),
        status: sg.connected ? 'connected' : (sgOn && sg.hasToken ? 'syncing…' : 'off') },
      { label: 'VDO',      ok: vdoReady ? true : null,
        status: vdoReady ? 'rooms ready' : 'not configured' }
    ];
    if (hasRL)  services.push({ label: 'RL API', ok: !!data.rlConnected, status: data.rlConnected ? 'connected' : 'not connected' });
    if (hasGSI) services.push({ label: 'CS2 GSI', ok: !!(data.csgo && data.csgo.connected), status: (data.csgo && data.csgo.connected) ? 'connected' : 'not connected' });

    // Signal level: 3 = OBS + ≥2 others; 2 = OBS OR ≥2 others; 1 = server only
    const obsOk = !!obs.connected;
    const othersOk = [tw.connected, sg.connected, vdoReady].filter(Boolean).length;
    let level = 1;
    if (obsOk && othersOk >= 1) level = 3;
    else if (obsOk || othersOk >= 2) level = 2;
    signal.dataset.level = level;

    tooltipRows.innerHTML = '';
    services.forEach(({ label, ok, status }) => {
      const dotClass = ok === true ? 'ok' : ok === false ? 'bad' : 'warn';
      const stClass  = ok === true ? 'ok' : ok === false ? 'bad' : 'warn';
      const stText   = status || (ok === true ? 'connected' : ok === false ? 'disconnected' : 'standby');
      tooltipRows.insertAdjacentHTML('beforeend',
        `<div class="conn-tooltip-row">
           <div class="conn-dot ${dotClass}"></div>
           <span class="conn-tooltip-label">${label}</span>
           <span class="conn-tooltip-status ${stClass}">${stText}</span>
         </div>`);
    });
  }
  // PROGRAM = the live OBS program scene (what viewers actually see). Honest when OBS is down.
  if (typeof window._obsPreviewUpdateScene === 'function') {
    window._obsPreviewUpdateScene(obs.connected ? (obs.currentScene || '') : '');
  }
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
  // GFX = the graphic live on the gfx.html layer. Together with PROGRAM (and ARMED, updated by
  // renderWhatsArmed) this topbar strip is THE single answer to "what is on air right now".
  const gfxChip = el('ck-chip-gfx');
  if (gfxChip) {
    const key = data.gfxActive || null;
    const name = key ? (typeof window._gfxSceneName === 'function' ? window._gfxSceneName(key) : key) : null;
    gfxChip.textContent = 'GFX: ' + (name || '—');
    gfxChip.classList.toggle('live', !!key);
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
