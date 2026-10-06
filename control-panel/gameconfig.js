/* ─── gameconfig.js — Game Config Builder (extend an existing game's maps/roles/characters) ──────
   Loads after leagues.js. One active config per game (state.gameConfigs, keyed by gameId); the
   bundle being edited lives entirely client-side (gcBundle) until Save / Import / Reset round-trips
   it through the server — same pattern as the League Editor holding lgLeagues locally.

   Save & apply makes the bundle live (server normalises ids — see backend/game-config.js); Export
   only writes a shareable .zip. Rows whose id matches a built-in item are OVERRIDES: they replace
   that item's image / name / type without duplicating it. */

(function () {
  const GC_TABS = ['maps', 'modes', 'roles', 'characters'];
  // Longest side an upload is downscaled to before it becomes base64 in state.
  const GC_MAX_DIM = { maps: 1280, characters: 320, roles: 128 };
  let gcActiveTab = 'maps';
  let gcBundle = null;      // in-progress edit state for the currently-selected game
  let gcDirty = false;      // unsaved edits — never overwritten by an incoming state update
  let gcReloadPending = false;

  const gcEsc = (s) => esc(s);
  const gcUid = (p) => (p || 'id') + Math.random().toString(36).slice(2, 9);
  // Built-in content is served by the app (/assets/…); the panel itself is a file:// page.
  const gcImg = (src) => (src && src.charAt(0) === '/') ? 'http://localhost:3000' + src : (src || '');
  const gcNameFromFile = (f) => String((f && f.name) || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  function gcBlankBundle(gameId) {
    return {
      format: 'ne-game-config', version: 1,
      configId: '', author: '', gameVersion: '', exportedAt: null,
      game: gameId || '',
      maps: [], roles: [], roleIcons: {}, characters: [], modes: []
    };
  }

  function gcCurrentGame() { return el('gc-game') ? el('gc-game').value : ''; }

  // What the app currently serves for this game (built-in + active config, merged server-side).
  function gcLiveList(kind) {
    const game = gcBundle && gcBundle.game;
    const src = kind === 'maps' ? currentState.vetoPools : currentState.draftRosters;
    return (src && src[game]) || [];
  }
  function gcBuiltinRoles() {
    const game = gcBundle && gcBundle.game;
    return (typeof ROLES_BY_GAME !== 'undefined' && ROLES_BY_GAME[game]) || [];
  }
  function gcAllRoles() {
    const seen = new Set(); const out = [];
    gcBuiltinRoles().concat(gcBundle.roles || []).forEach((r) => { const k = String(r).toLowerCase(); if (r && !seen.has(k)) { seen.add(k); out.push(r); } });
    return out;
  }

  function gcMarkDirty() { gcDirty = true; gcRenderStatus(); }

  // Loads whichever bundle should be shown for the selected game: the active config if one
  // exists, otherwise a blank bundle to build from scratch. Never touches other games' configs.
  function gcLoadForGame(gameId) {
    const active = (currentState.gameConfigs || {})[gameId];
    gcBundle = active ? Object.assign(gcBlankBundle(gameId), JSON.parse(JSON.stringify(active))) : gcBlankBundle(gameId);
    gcDirty = false; gcReloadPending = false;
    // A saved override only stores what it changes — show the built-in's name/type for the rest.
    ['maps', 'characters'].forEach((kind) => {
      const extra = GC_KIND[kind].extra;
      const liveById = {}; gcLiveList(kind).forEach((x) => { liveById[x.id] = x; });
      gcBundle[kind] = (gcBundle[kind] || []).map((r) => {
        const b = liveById[r.id] || {};
        return { id: r.id, name: r.name || b.name || '', image: r.image || '', [extra]: r[extra] || b[extra] || '' };
      });
    });
    if (el('gc-author')) el('gc-author').value = gcBundle.author || '';
    if (el('gc-version')) el('gc-version').value = gcBundle.gameVersion || '';
    if (el('gc-config-id')) el('gc-config-id').value = gcBundle.configId || '';
    gcRenderStatus();
    gcRenderAll();
  }

  function gcRenderStatus() {
    const line = el('gc-status-line'); if (!line) return;
    const active = (currentState.gameConfigs || {})[gcCurrentGame()];
    const resetBtn = el('btn-gc-reset');
    const hasContent = active && ((active.maps || []).length || (active.characters || []).length
      || (active.roles || []).length || Object.keys(active.roleIcons || {}).length || (active.modes || []).length);
    if (hasContent) {
      const n = (k, word) => { const c = (active[k] || []).length; return c ? `${c} ${word}${c === 1 ? '' : 's'}` : ''; };
      line.textContent = 'Custom content is live: ' + ([n('maps', 'map'), n('characters', 'character'), n('roles', 'role'), n('modes', 'mode')].filter(Boolean).join(', ') || 'role icons')
        + (active.configId ? ` — ${active.configId}` : '') + (active.author ? ` by ${active.author}` : '') + (active.gameVersion ? ` (${active.gameVersion})` : '');
    } else {
      line.textContent = 'No custom content active for this game — using built-in content only.';
    }
    if (resetBtn) resetBtn.style.display = active ? '' : 'none';
    const dirty = el('gc-dirty'); if (dirty) dirty.style.display = gcDirty ? '' : 'none';
  }

  function gcRenderBadges() {
    if (!gcBundle) return;
    const counts = {
      maps: (gcBundle.maps || []).length, modes: (gcBundle.modes || []).length, characters: (gcBundle.characters || []).length,
      roles: (gcBundle.roles || []).length + Object.keys(gcBundle.roleIcons || {}).length
    };
    GC_TABS.forEach((k) => { const e = el('gc-badge-' + k); if (e) e.textContent = counts[k]; });
  }

  function gcSwitchTab(name) {
    gcActiveTab = name;
    document.querySelectorAll('#gc-tabs .lg2-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    GC_TABS.forEach((t) => { const p = el('gc-panel-' + t); if (p) p.style.display = t === name ? '' : 'none'; });
  }

  function gcRenderAll() { gcRenderItems('maps'); gcRenderItems('characters'); gcRenderModes(); gcRenderRoles(); gcRenderBadges(); }

  // ── Image picking — one hidden <input type=file> shared by every upload button ──
  let gcPickTarget = null;   // (files) => void
  function gcPickImages(multiple, onFiles) {
    const inp = el('gc-file'); if (!inp) return;
    gcPickTarget = onFiles; inp.multiple = !!multiple; inp.value = ''; inp.click();
  }
  async function gcReadImage(file, kind) {
    const raw = await new Promise((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(file);
    });
    return downscaleDataUrl(raw, file.type, GC_MAX_DIM[kind]);
  }
  const gcImageFiles = (list) => Array.from(list || []).filter((f) => /^image\//i.test(f.type || ''));

  // ── Maps + Characters (same row shape: thumb · name · type|role) ──
  const GC_KIND = {
    maps:       { noun: 'map',       extra: 'type', extraPh: 'Mode / type', uid: 'map' },
    characters: { noun: 'character', extra: 'role', extraPh: 'Role',        uid: 'char' }
  };
  function gcExtraOptions(kind) {
    if (kind === 'characters') return gcAllRoles();
    const game = gcBundle.game;
    const meta = (currentState.vetoMeta || {})[game] || {};
    const seen = new Set(); const out = [];
    (meta.modes || []).concat(gcLiveList('maps').map((m) => m.type || m.tier || '')).concat((gcBundle.modes || []).map((m) => m.name))
      .forEach((t) => { if (t && !seen.has(t)) { seen.add(t); out.push(t); } });
    return out;
  }

  function gcRenderItems(kind) {
    const wrap = el('gc-list-' + kind); if (!wrap || !gcBundle) return;
    const K = GC_KIND[kind];
    const rows = gcBundle[kind] || [];
    const live = gcLiveList(kind);
    const liveById = {}; live.forEach((x) => { if (!x.custom) liveById[x.id] = x; });   // built-ins only
    const mine = new Set(rows.map((r) => r.id));
    const builtin = live.filter((x) => !mine.has(x.id));
    const dlId = 'gc-dl-' + kind;

    const rowHtml = rows.map((m, i) => {
      const base = liveById[m.id];
      const img = gcImg(m.image || (base && base.image) || '');
      return `<div class="gc-row" data-idx="${i}">
        <button type="button" class="gc-thumb${img ? '' : ' is-empty'}" data-act="img" title="${m.image ? 'Replace image' : 'Upload image'}">
          ${img ? `<img src="${gcEsc(img)}" alt="" onerror="this.remove()">` : ''}<span class="gc-thumb-plus">+</span>
        </button>
        <div class="gc-row-fields">
          <input type="text" class="input-text" data-f="name" value="${gcEsc(m.name || '')}" placeholder="${K.noun.charAt(0).toUpperCase() + K.noun.slice(1)} name" style="flex:2;">
          <input type="text" class="input-text" data-f="${K.extra}" list="${dlId}" value="${gcEsc(m[K.extra] || '')}" placeholder="${K.extraPh}" style="flex:1;">
          ${base ? '<span class="gc-chip" title="Replaces a built-in item of the same name">Override</span>' : (m.image ? '' : '<span class="gc-chip gc-chip-warn">No image</span>')}
        </div>
        <button type="button" class="lg-del" data-act="del" title="Remove">×</button>
      </div>`;
    }).join('');

    wrap.innerHTML =
      `<datalist id="${dlId}">${gcExtraOptions(kind).map((t) => `<option value="${gcEsc(t)}">`).join('')}</datalist>`
      + (rows.length ? `<div class="gc-row-list">${rowHtml}</div>`
        : `<p class="empty-msg">Nothing added yet — upload ${K.noun} images above. File names become the ${K.noun} names.</p>`)
      + (builtin.length ? `<details class="gc-builtin"${wrap.dataset.open === '1' ? ' open' : ''}>
          <summary>Already in the app (${builtin.length}) — click one to replace its image or rename it</summary>
          <div class="gc-builtin-grid">${builtin.map((b) => `<button type="button" class="gc-builtin-item" data-id="${gcEsc(b.id)}" title="Override ${gcEsc(b.name)}">
            <img src="${gcEsc(gcImg(b.image))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><span>${gcEsc(b.name)}</span></button>`).join('')}</div>
        </details>` : '');

    const det = wrap.querySelector('.gc-builtin');
    if (det) det.addEventListener('toggle', () => { wrap.dataset.open = det.open ? '1' : ''; });
  }

  // Delegated — the lists re-render often, so one listener per container instead of per row.
  function gcWireList(kind) {
    const wrap = el('gc-list-' + kind); if (!wrap) return;
    const K = GC_KIND[kind];
    const rowOf = (t) => { const r = t.closest('.gc-row'); return r ? Number(r.dataset.idx) : -1; };
    const setImage = async (idx, file) => {
      const row = gcBundle[kind][idx]; if (!row || !file) return;
      row.image = await gcReadImage(file, kind);
      if (!row.name) row.name = gcNameFromFile(file);
      gcMarkDirty(); gcRenderItems(kind);
    };
    wrap.addEventListener('click', (e) => {
      if (!gcBundle) return;
      const b = e.target.closest('.gc-builtin-item');
      if (b) {
        const src = gcLiveList(kind).find((x) => x.id === b.dataset.id); if (!src) return;
        gcBundle[kind].push({ id: src.id, name: src.name || '', image: '', [K.extra]: src[K.extra] || '' });
        gcMarkDirty(); gcRenderItems(kind); gcRenderBadges();
        return;
      }
      const act = e.target.closest('[data-act]'); if (!act) return;
      const idx = rowOf(act); if (idx < 0) return;
      if (act.dataset.act === 'del') { gcBundle[kind].splice(idx, 1); gcMarkDirty(); gcRenderItems(kind); gcRenderBadges(); }
      else if (act.dataset.act === 'img') gcPickImages(false, (files) => setImage(idx, files[0]));
    });
    wrap.addEventListener('change', (e) => {
      const f = e.target.dataset && e.target.dataset.f; if (!f || !gcBundle) return;
      const idx = rowOf(e.target); if (idx < 0) return;
      gcBundle[kind][idx][f] = e.target.value.trim(); gcMarkDirty();
    });
    // Dropping an image straight onto a row replaces that row's image.
    wrap.addEventListener('dragover', (e) => { if (e.target.closest('.gc-row')) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } });
    wrap.addEventListener('drop', (e) => {
      const idx = rowOf(e.target); if (idx < 0) return;
      e.preventDefault();
      const f = gcImageFiles(e.dataTransfer && e.dataTransfer.files)[0]; if (f) setImage(idx, f);
    });
  }

  async function gcAddFiles(kind, files) {
    if (!gcBundle) return;
    const K = GC_KIND[kind];
    const imgs = gcImageFiles(files);
    if (!imgs.length) { gcResult('Those files are not images — use PNG, JPG, WebP or SVG.', false); return; }
    const live = gcLiveList(kind);
    for (const f of imgs) {
      const name = gcNameFromFile(f);
      const image = await gcReadImage(f, kind);
      // A file named after something that already exists updates that item instead of duplicating it.
      const mine = gcBundle[kind].find((r) => (r.name || '').toLowerCase() === name.toLowerCase());
      if (mine) { mine.image = image; continue; }
      const base = live.find((x) => !x.custom && (x.name || '').toLowerCase() === name.toLowerCase());
      gcBundle[kind].push(base ? { id: base.id, name: base.name, image, [K.extra]: base[K.extra] || '' }
        : { id: gcUid(K.uid), name, image, [K.extra]: '' });
    }
    gcMarkDirty(); gcRenderItems(kind); gcRenderBadges(); gcResult('');
  }
  function gcAddBlank(kind) {
    if (!gcBundle) return;
    const K = GC_KIND[kind];
    gcBundle[kind].push({ id: gcUid(K.uid), name: '', image: '', [K.extra]: '' });
    gcMarkDirty(); gcRenderItems(kind); gcRenderBadges();
    const last = el('gc-list-' + kind).querySelector('.gc-row:last-child input[data-f="name"]'); if (last) last.focus();
  }

  // ── Roles tab — the game's built-in roles plus extras, each with an optional icon ──
  function gcRoleIcon(role) {
    const own = (gcBundle.roleIcons || {})[String(role).toLowerCase()];
    if (own) return own;
    const active = (currentState.gameConfigs || {})[gcBundle.game];
    // roleIconUrl() resolves the ACTIVE config first; skip that so a removed icon reads as removed.
    if (active && active.roleIcons && active.roleIcons[String(role).toLowerCase()]) return '';
    return typeof roleIconUrl === 'function' ? roleIconUrl(gcBundle.game, role) : '';
  }
  function gcRenderRoles() {
    const wrap = el('gc-list-roles'); if (!wrap || !gcBundle) return;
    const builtin = new Set(gcBuiltinRoles().map((r) => r.toLowerCase()));
    const rows = gcAllRoles();
    if (!rows.length) { wrap.innerHTML = '<p class="empty-msg">This game has no preset roles — add one above.</p>'; return; }
    wrap.innerHTML = `<div class="gc-row-list">${rows.map((r) => {
      const key = r.toLowerCase();
      const own = !!(gcBundle.roleIcons || {})[key];
      const img = gcRoleIcon(r);
      return `<div class="gc-row" data-role="${gcEsc(r)}">
        <button type="button" class="gc-thumb gc-thumb-icon${img ? '' : ' is-empty'}" data-act="img" title="${img ? 'Replace icon' : 'Upload icon'}">
          ${img ? `<img src="${gcEsc(img)}" alt="" onerror="this.remove()">` : ''}<span class="gc-thumb-plus">+</span>
        </button>
        <div class="gc-row-fields">
          <span style="font-weight:600;">${gcEsc(r)}</span>
          ${builtin.has(key) ? '<span class="gc-chip">Built-in</span>' : ''}
          ${own ? '<button type="button" class="btn btn-ghost btn-sm" data-act="clear-icon">Remove custom icon</button>' : ''}
        </div>
        ${builtin.has(key) ? '' : '<button type="button" class="lg-del" data-act="del" title="Remove role">×</button>'}
      </div>`;
    }).join('')}</div>`;
  }
  function gcWireRoles() {
    const wrap = el('gc-list-roles'); if (!wrap) return;
    const setIcon = async (role, file) => {
      if (!file) return;
      gcBundle.roleIcons = gcBundle.roleIcons || {};
      gcBundle.roleIcons[role.toLowerCase()] = await gcReadImage(file, 'roles');
      gcMarkDirty(); gcRenderRoles(); gcRenderBadges();
    };
    wrap.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]'); if (!act || !gcBundle) return;
      const role = act.closest('.gc-row').dataset.role; const key = role.toLowerCase();
      if (act.dataset.act === 'img') { gcPickImages(false, (files) => setIcon(role, files[0])); return; }
      if (act.dataset.act === 'clear-icon') delete gcBundle.roleIcons[key];
      if (act.dataset.act === 'del') {
        gcBundle.roles = (gcBundle.roles || []).filter((r) => r.toLowerCase() !== key);
        if (gcBundle.roleIcons) delete gcBundle.roleIcons[key];
      }
      gcMarkDirty(); gcRenderRoles(); gcRenderBadges();
    });
    wrap.addEventListener('dragover', (e) => { if (e.target.closest('.gc-row')) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } });
    wrap.addEventListener('drop', (e) => {
      const row = e.target.closest('.gc-row'); if (!row) return;
      e.preventDefault();
      setIcon(row.dataset.role, gcImageFiles(e.dataTransfer && e.dataTransfer.files)[0]);
    });
  }

  // ── Modes tab (name + description; mode names feed the map "type" suggestions) ──
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
    wrap.querySelectorAll('.gc-mode-del').forEach((b) => b.addEventListener('click', () => {
      gcBundle.modes.splice(Number(b.dataset.idx), 1); gcMarkDirty(); gcRenderModes(); gcRenderBadges();
    }));
  }

  // ── Drag-and-drop (the window-wide file-drop-navigation guard is already installed once by
  // wireAssetDrop() in app.js — every dropzone in the app, including these, is covered by it). ──
  function gcWireDropzone(id, kind) {
    const dz = el(id); if (!dz) return;
    let depth = 0;
    const show = (on) => dz.classList.toggle('drag-over', on);
    dz.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; show(true); });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    dz.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; show(false); } });
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; show(false);
      gcAddFiles(kind, e.dataTransfer && e.dataTransfer.files);
    });
  }

  function gcResult(msg, ok) {
    const r = el('gc-result'); if (!r) return;
    r.textContent = msg || '';
    r.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)');
  }

  // Called from app.js's WS message handler when an import-export-result arrives with
  // context:'game-config' — keeps Game Config's status separate from Producer Profile's.
  // The state broadcast carrying the new config is coalesced and can land AFTER this result, so
  // the reload waits for it (gcReloadPending → _gcRefresh) with a timer as the fallback.
  window._gcHandleImportExportResult = function (message, ok) {
    gcResult(message, ok);
    if (!ok || /exported/i.test(message || '')) return;   // an export changes nothing server-side
    gcDirty = false; gcReloadPending = true;
    setTimeout(() => { if (gcReloadPending) gcLoadForGame(gcCurrentGame()); }, 500);
  };

  function gcPopulateGameSelect() {
    const sel = el('gc-game'); if (!sel) return;
    const games = currentState.games || {};
    const sig = Object.keys(games).join('|');
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    const prev = sel.value;
    sel.innerHTML = Object.keys(games).map((id) => `<option value="${gcEsc(id)}">${gcEsc(games[id].name || id)}</option>`).join('');
    if (prev && games[prev]) sel.value = prev;
    if (!gcBundle) gcLoadForGame(sel.value);
  }

  // Switching game (the Games hub does this as you browse) parks unsaved edits per game instead
  // of discarding them, and restores them when you come back.
  const gcDrafts = {};
  let gcLoadedGame = '';
  function gcOnGameChange() {
    const next = el('gc-game').value;
    if (gcBundle && gcDirty && gcLoadedGame && gcLoadedGame !== next) gcDrafts[gcLoadedGame] = gcBundle;
    gcLoadedGame = next;
    gcLoadForGame(next);
    if (gcDrafts[next]) { gcBundle = gcDrafts[next]; delete gcDrafts[next]; gcDirty = true; gcRenderStatus(); gcRenderAll(); }
    gcResult('');
  }

  // ── Wiring ──
  el('gc-game')?.addEventListener('change', gcOnGameChange);
  el('gc-tabs')?.addEventListener('click', (e) => { const t = e.target.closest('.lg2-tab'); if (t) gcSwitchTab(t.dataset.tab); });

  [['gc-author', 'author'], ['gc-version', 'gameVersion'], ['gc-config-id', 'configId']].forEach(([id, key]) => {
    el(id)?.addEventListener('input', () => { if (gcBundle) { gcBundle[key] = el(id).value; gcMarkDirty(); } });
  });

  el('gc-file')?.addEventListener('change', () => {
    const files = gcImageFiles(el('gc-file').files); const cb = gcPickTarget; gcPickTarget = null;
    if (cb && files.length) cb(files);
  });
  ['maps', 'characters'].forEach((kind) => {
    gcWireDropzone('gc-dropzone-' + kind, kind);
    gcWireList(kind);
    el('gc-upload-' + kind)?.addEventListener('click', () => gcPickImages(true, (files) => gcAddFiles(kind, files)));
    el('gc-add-' + kind)?.addEventListener('click', () => gcAddBlank(kind));
  });
  gcWireRoles();

  el('gc-add-role')?.addEventListener('click', () => {
    if (!gcBundle) return;
    const inp = el('gc-role-name'); const v = (inp.value || '').trim(); if (!v) return;
    if (!gcAllRoles().some((r) => r.toLowerCase() === v.toLowerCase())) { gcBundle.roles.push(v); gcMarkDirty(); }
    inp.value = '';
    gcRenderRoles(); gcRenderBadges();
  });
  el('gc-role-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('gc-add-role').click(); });
  el('gc-add-mode')?.addEventListener('click', () => {
    if (!gcBundle) return;
    const nameInp = el('gc-mode-name'); const descInp = el('gc-mode-desc');
    const name = (nameInp.value || '').trim(); if (!name) return;
    gcBundle.modes.push({ id: gcUid('mode'), name, description: (descInp.value || '').trim() });
    nameInp.value = ''; descInp.value = '';
    gcMarkDirty(); gcRenderModes(); gcRenderBadges();
  });

  const gcReady = () => {
    if (gcBundle && gcBundle.game) return true;
    gcResult('Pick a game first.', false); return false;
  };
  el('btn-gc-save')?.addEventListener('click', () => {
    if (!gcReady()) return;
    const unnamed = ['maps', 'characters'].reduce((n, k) => n + gcBundle[k].filter((r) => !(r.name || '').trim()).length, 0);
    if (unnamed) { gcResult(`${unnamed} row(s) have no name — name or remove them before saving.`, false); return; }
    send('save_game_config', { bundle: gcBundle });
  });
  el('btn-gc-export')?.addEventListener('click', () => {
    if (!gcReady()) return;
    gcBundle.exportedAt = Date.now();
    send('export_game_config', { gameId: gcBundle.game, bundle: gcBundle });
  });
  el('btn-gc-import')?.addEventListener('click', () => {
    const go = () => send('import_game_config');
    if (!gcDirty) { go(); return; }
    appConfirm('Importing replaces the content you are editing. Continue?', 'Import').then((ok) => { if (ok) go(); });
  });
  el('btn-gc-reset')?.addEventListener('click', () => {
    const gameId = gcCurrentGame(); if (!gameId) return;
    const gameName = (currentState.games && currentState.games[gameId] && currentState.games[gameId].name) || gameId;
    appConfirm(`Reset ${gameName} to its built-in content? This removes all custom content for this game.`, 'Reset').then((ok) => {
      if (ok) send('clear_game_config', { gameId });
    });
  });

  // Called from app.js's applyState on every state update.
  window._gcRefresh = function () {
    gcPopulateGameSelect();
    if (!gcLoadedGame) gcLoadedGame = gcCurrentGame();
    if (gcReloadPending) { gcLoadForGame(gcCurrentGame()); return; }
    gcRenderStatus();
  };
})();
