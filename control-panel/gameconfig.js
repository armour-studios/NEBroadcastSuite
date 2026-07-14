/* ─── gameconfig.js — Game Config Builder (extend an existing game's maps/roles/characters) ──────
   Loads after leagues.js. One active config per game (state.gameConfigs, keyed by gameId); the
   bundle being edited lives entirely client-side (gcBundle) until Export/Import/Reset round-trips
   it through the server — same pattern as the League Editor holding lgLeagues locally. */

(function () {
  const GC_TABS = ['maps', 'modes', 'roles', 'characters'];
  let gcActiveTab = 'maps';
  let gcBundle = null;   // in-progress edit state for the currently-selected game

  const gcEsc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  const gcUid = (p) => (p || 'id') + Math.random().toString(36).slice(2, 9);

  function gcBlankBundle(gameId) {
    return {
      format: 'ne-game-config', version: 1,
      configId: '', author: '', gameVersion: '', exportedAt: null,
      game: gameId || '',
      maps: [], roles: [], characters: [], modes: []
    };
  }

  function gcCurrentGame() { return el('gc-game') ? el('gc-game').value : ''; }

  // Loads whichever bundle should be shown for the selected game: the active imported config if
  // one exists, otherwise a blank bundle to build from scratch. Never touches other games' configs.
  function gcLoadForGame(gameId) {
    const active = (currentState.gameConfigs || {})[gameId];
    gcBundle = active ? JSON.parse(JSON.stringify(active)) : gcBlankBundle(gameId);
    if (el('gc-author')) el('gc-author').value = gcBundle.author || '';
    if (el('gc-version')) el('gc-version').value = gcBundle.gameVersion || '';
    if (el('gc-config-id')) el('gc-config-id').value = gcBundle.configId || '';
    gcRenderStatus();
    gcRenderAll();
  }

  function gcRenderStatus() {
    const line = el('gc-status-line'); if (!line) return;
    const gameId = gcCurrentGame();
    const active = (currentState.gameConfigs || {})[gameId];
    const resetBtn = el('btn-gc-reset');
    if (active) {
      line.textContent = `Active config: ${active.configId || 'untitled'}` +
        (active.author ? ` by ${active.author}` : '') + (active.gameVersion ? ` — ${active.gameVersion}` : '');
      if (resetBtn) resetBtn.style.display = '';
    } else {
      line.textContent = 'No config active for this game — using built-in content only.';
      if (resetBtn) resetBtn.style.display = 'none';
    }
  }

  function gcRenderBadges() {
    if (!gcBundle) return;
    GC_TABS.forEach((k) => { const e = el('gc-badge-' + k); if (e) e.textContent = (gcBundle[k] || []).length; });
  }

  function gcSwitchTab(name) {
    gcActiveTab = name;
    document.querySelectorAll('#gc-tabs .lg2-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    GC_TABS.forEach((t) => { const p = el('gc-panel-' + t); if (p) p.style.display = t === name ? '' : 'none'; });
  }

  function gcRenderAll() { gcRenderMaps(); gcRenderModes(); gcRenderRoles(); gcRenderCharacters(); gcRenderBadges(); }

  // ── Maps tab ──
  function gcRenderMaps() {
    const wrap = el('gc-list-maps'); if (!wrap || !gcBundle) return;
    const rows = gcBundle.maps || [];
    if (!rows.length) { wrap.innerHTML = '<p class="empty-msg">No maps added yet — drag images in above, or Add Map.</p>'; return; }
    wrap.innerHTML = `<div class="gc-row-list">${rows.map((m, i) => `
      <div class="gc-row">
        <img class="gc-row-thumb" src="${gcEsc(m.image || '')}" alt="" onerror="this.style.visibility='hidden'">
        <div class="gc-row-fields">
          <input type="text" class="input-text gc-map-name" data-idx="${i}" value="${gcEsc(m.name)}" placeholder="Map name" style="flex:2;">
          <input type="text" class="input-text gc-map-type" data-idx="${i}" value="${gcEsc(m.type || '')}" placeholder="Type (optional)" style="flex:1;">
        </div>
        <button class="lg-del gc-map-del" data-idx="${i}" title="Remove">×</button>
      </div>`).join('')}</div>`;
    wrap.querySelectorAll('.gc-map-name').forEach((inp) => inp.addEventListener('change', () => { gcBundle.maps[Number(inp.dataset.idx)].name = inp.value; }));
    wrap.querySelectorAll('.gc-map-type').forEach((inp) => inp.addEventListener('change', () => { gcBundle.maps[Number(inp.dataset.idx)].type = inp.value; }));
    wrap.querySelectorAll('.gc-map-del').forEach((b) => b.addEventListener('click', () => { gcBundle.maps.splice(Number(b.dataset.idx), 1); gcRenderMaps(); gcRenderBadges(); }));
  }
  function gcAddMapRow(image) {
    gcBundle.maps = gcBundle.maps || [];
    gcBundle.maps.push({ id: gcUid('map'), name: '', image: image || '', type: '' });
    gcRenderMaps(); gcRenderBadges();
  }

  // ── Characters tab ──
  function gcRenderCharacters() {
    const wrap = el('gc-list-characters'); if (!wrap || !gcBundle) return;
    const rows = gcBundle.characters || [];
    if (!rows.length) { wrap.innerHTML = '<p class="empty-msg">No characters added yet — drag portraits in above, or Add Character.</p>'; return; }
    wrap.innerHTML = `<div class="gc-row-list">${rows.map((c, i) => `
      <div class="gc-row">
        <img class="gc-row-thumb" src="${gcEsc(c.image || '')}" alt="" onerror="this.style.visibility='hidden'">
        <div class="gc-row-fields">
          <input type="text" class="input-text gc-char-name" data-idx="${i}" value="${gcEsc(c.name)}" placeholder="Character name" style="flex:2;">
          <input type="text" class="input-text gc-char-role" data-idx="${i}" value="${gcEsc(c.role || '')}" placeholder="Role (optional)" style="flex:1;">
        </div>
        <button class="lg-del gc-char-del" data-idx="${i}" title="Remove">×</button>
      </div>`).join('')}</div>`;
    wrap.querySelectorAll('.gc-char-name').forEach((inp) => inp.addEventListener('change', () => { gcBundle.characters[Number(inp.dataset.idx)].name = inp.value; }));
    wrap.querySelectorAll('.gc-char-role').forEach((inp) => inp.addEventListener('change', () => { gcBundle.characters[Number(inp.dataset.idx)].role = inp.value; }));
    wrap.querySelectorAll('.gc-char-del').forEach((b) => b.addEventListener('click', () => { gcBundle.characters.splice(Number(b.dataset.idx), 1); gcRenderCharacters(); gcRenderBadges(); }));
  }
  function gcAddCharacterRow(image) {
    gcBundle.characters = gcBundle.characters || [];
    gcBundle.characters.push({ id: gcUid('char'), name: '', image: image || '', role: '' });
    gcRenderCharacters(); gcRenderBadges();
  }

  // ── Roles tab (flat string list) ──
  function gcRenderRoles() {
    const wrap = el('gc-list-roles'); if (!wrap || !gcBundle) return;
    const rows = gcBundle.roles || [];
    if (!rows.length) { wrap.innerHTML = '<p class="empty-msg">No extra roles added yet.</p>'; return; }
    wrap.innerHTML = `<div class="gc-row-list">${rows.map((r, i) => `
      <div class="gc-row"><div class="gc-row-fields"><span style="font-weight:600;">${gcEsc(r)}</span></div>
        <button class="lg-del gc-role-del" data-idx="${i}" title="Remove">×</button></div>`).join('')}</div>`;
    wrap.querySelectorAll('.gc-role-del').forEach((b) => b.addEventListener('click', () => { gcBundle.roles.splice(Number(b.dataset.idx), 1); gcRenderRoles(); gcRenderBadges(); }));
  }

  // ── Modes tab (name + description, reference only — not yet wired into game logic) ──
  function gcRenderModes() {
    const wrap = el('gc-list-modes'); if (!wrap || !gcBundle) return;
    const rows = gcBundle.modes || [];
    if (!rows.length) { wrap.innerHTML = '<p class="empty-msg">No modes added yet.</p>'; return; }
    wrap.innerHTML = `<div class="gc-row-list">${rows.map((m, i) => `
      <div class="gc-row"><div class="gc-row-fields">
          <span style="font-weight:600;">${gcEsc(m.name)}</span>
          ${m.description ? `<span style="color:var(--muted);font-size:12px;">${gcEsc(m.description)}</span>` : ''}
        </div>
        <button class="lg-del gc-mode-del" data-idx="${i}" title="Remove">×</button></div>`).join('')}</div>`;
    wrap.querySelectorAll('.gc-mode-del').forEach((b) => b.addEventListener('click', () => { gcBundle.modes.splice(Number(b.dataset.idx), 1); gcRenderModes(); gcRenderBadges(); }));
  }

  // ── Drag-and-drop (the window-wide file-drop-navigation guard is already installed once by
  // wireAssetDrop() in app.js — every dropzone in the app, including these, is covered by it). ──
  function gcWireDropzone(id, onFile) {
    const dz = el(id); if (!dz) return;
    let depth = 0;
    const show = (on) => dz.classList.toggle('drag-over', on);
    dz.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; show(true); });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    dz.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; show(false); } });
    dz.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; show(false);
      if (!gcBundle) return;
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /^image\//i.test(f.type || ''));
      for (const f of files) { const b64 = await fileToBase64(f); onFile(b64); }
    });
  }

  function gcResult(msg, ok) {
    const r = el('gc-result'); if (!r) return;
    r.textContent = msg || '';
    r.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)');
  }

  // Called from app.js's WS message handler when an import-export-result arrives with
  // context:'game-config' — keeps Game Config's status separate from Producer Profile's.
  window._gcHandleImportExportResult = function (message, ok) {
    gcResult(message, ok);
    if (ok) gcLoadForGame(gcCurrentGame());   // reflect the freshly-imported/reset active config
  };

  function gcPopulateGameSelect() {
    const sel = el('gc-game'); if (!sel) return;
    const games = currentState.games || {};
    const sig = Object.keys(games).join('|');
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    const prev = sel.value;
    sel.innerHTML = Object.keys(games).map((id) => `<option value="${id}">${gcEsc(games[id].name || id)}</option>`).join('');
    if (prev && games[prev]) sel.value = prev;
    if (!gcBundle) gcLoadForGame(sel.value);
  }

  // ── Wiring ──
  el('gc-game')?.addEventListener('change', () => gcLoadForGame(el('gc-game').value));
  el('gc-tabs')?.addEventListener('click', (e) => { const t = e.target.closest('.lg2-tab'); if (t) gcSwitchTab(t.dataset.tab); });

  el('gc-author')?.addEventListener('input', () => { if (gcBundle) gcBundle.author = el('gc-author').value; });
  el('gc-version')?.addEventListener('input', () => { if (gcBundle) gcBundle.gameVersion = el('gc-version').value; });
  el('gc-config-id')?.addEventListener('input', () => { if (gcBundle) gcBundle.configId = el('gc-config-id').value; });

  el('gc-add-map')?.addEventListener('click', () => { if (gcBundle) gcAddMapRow(''); });
  el('gc-add-character')?.addEventListener('click', () => { if (gcBundle) gcAddCharacterRow(''); });
  gcWireDropzone('gc-dropzone-maps', (b64) => gcAddMapRow(b64));
  gcWireDropzone('gc-dropzone-characters', (b64) => gcAddCharacterRow(b64));

  el('gc-add-role')?.addEventListener('click', () => {
    if (!gcBundle) return;
    const inp = el('gc-role-name'); const v = (inp.value || '').trim(); if (!v) return;
    gcBundle.roles = gcBundle.roles || [];
    if (!gcBundle.roles.some((r) => r.toLowerCase() === v.toLowerCase())) gcBundle.roles.push(v);
    inp.value = '';
    gcRenderRoles(); gcRenderBadges();
  });
  el('gc-add-mode')?.addEventListener('click', () => {
    if (!gcBundle) return;
    const nameInp = el('gc-mode-name'); const descInp = el('gc-mode-desc');
    const name = (nameInp.value || '').trim(); if (!name) return;
    gcBundle.modes = gcBundle.modes || [];
    gcBundle.modes.push({ id: gcUid('mode'), name, description: (descInp.value || '').trim() });
    nameInp.value = ''; descInp.value = '';
    gcRenderModes(); gcRenderBadges();
  });

  el('btn-gc-export')?.addEventListener('click', () => {
    if (!gcBundle || !gcBundle.game) { gcResult('Pick a game first.', false); return; }
    gcBundle.exportedAt = Date.now();
    send('export_game_config', { gameId: gcBundle.game, bundle: gcBundle });
  });
  el('btn-gc-import')?.addEventListener('click', () => send('import_game_config'));
  el('btn-gc-reset')?.addEventListener('click', () => {
    const gameId = gcCurrentGame(); if (!gameId) return;
    const gameName = (currentState.games && currentState.games[gameId] && currentState.games[gameId].name) || gameId;
    appConfirm(`Reset ${gameName} to its built-in content? This removes the active Game Config for this game.`, 'Reset').then((ok) => {
      if (ok) send('clear_game_config', { gameId });
    });
  });

  // Called from app.js's applyState on every state update.
  window._gcRefresh = function () {
    gcPopulateGameSelect();
    gcRenderStatus();
  };
})();
