/* ─── gameconfig.js — Custom game content (Settings > Games > <game> > Custom content) ──────────
   Shows EVERYTHING the app knows for a game (built-in + the producer's own) as a picture grid.
   Click a card to change its picture, name or role; Add creates a new one; pictures dropped on
   the list are added in bulk. Every change saves itself (save_game_config, debounced), so there is
   no Save button to forget.

   Data model is unchanged: one config bundle per game (state.gameConfigs[gameId]) holding only the
   producer's rows. A row whose id is a built-in item is an EDIT of it (the server stores only the
   fields that differ, see backend/game-config.js); any other row is an ADDED item. The server
   merges them into currentState.draftRosters / vetoPools, which is what this page reads. Modes
   are kept in the bundle untouched (they have no UI and no game logic). */

(function () {
  const GC_MAX_DIM = { maps: 1280, characters: 320, roles: 128 };
  const KIND = {
    characters: { noun: 'character', extra: 'role', extraLabel: 'Role', uid: 'char', src: 'draftRosters' },
    maps:       { noun: 'map',       extra: 'type', extraLabel: 'Mode', uid: 'map',  src: 'vetoPools' },
  };
  const SAVE_DELAY_MS = 500;

  let gcBundle = null;        // the producer's rows for the selected game (working copy)
  let gcTab = 'characters';
  let gcQuery = '';
  let gcEdit = null;          // { kind, id | null (new), draft: {name, image, extra} }
  let gcSaveTimer = null, gcSaving = false, gcSaveAgain = false, gcReloadPending = false;
  let gcLoadedGame = '';
  let gcRenderSig = '';

  const gcEsc = (s) => esc(s);
  const gcUid = (p) => (p || 'id') + Math.random().toString(36).slice(2, 9);
  // Built-in content is served by the app (/assets/…); the panel itself is a file:// page.
  const gcImg = (src) => (src && src.charAt(0) === '/') ? 'http://localhost:3000' + src : (src || '');
  const gcNameFromFile = (f) => String((f && f.name) || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const lc = (s) => String(s || '').trim().toLowerCase();
  const gcImageFiles = (list) => Array.from(list || []).filter((f) => /^image\//i.test(f.type || ''));

  function gcBlankBundle(gameId) {
    return { format: 'ne-game-config', version: 1, configId: '', author: '', gameVersion: '', exportedAt: null,
      game: gameId || '', maps: [], roles: [], roleIcons: {}, characters: [], modes: [] };
  }
  function gcCurrentGame() { return el('gc-game') ? el('gc-game').value : ''; }
  function gcGameName() { const g = (currentState.games || {})[gcCurrentGame()]; return (g && g.name) || gcCurrentGame(); }
  function gcActive() { return (currentState.gameConfigs || {})[gcCurrentGame()] || null; }
  // A config can exist only to hold drop-map POIs; "changes" means custom content.
  function gcHasChanges(cfg) {
    cfg = cfg || {};
    return ['maps', 'characters', 'roles', 'modes'].some((k) => (cfg[k] || []).length > 0) || Object.keys(cfg.roleIcons || {}).length > 0;
  }
  function gcVersions() { return (currentState.gameConfigVersions || {})[gcCurrentGame()] || []; }
  function gcFrom() { return (currentState.gameConfigFrom || {})[gcCurrentGame()] || null; }
  // What is in use right now: a saved version's name, '__unsaved' (changes not saved as a
  // version) or '__original' (the content the app ships with).
  function gcCurrentVersion() {
    const from = gcFrom();
    if (from && from.name && gcVersions().some((v) => v.name === from.name)) return from.name;
    return gcHasChanges(gcActive()) ? '__unsaved' : '__original';
  }

  // What the app serves right now (built-in merged with the SAVED config). undefined = this game
  // has no characters / maps at all (no draft or veto support), as opposed to an empty list.
  function gcLive(kind) {
    if (!KIND[kind]) return undefined;
    const src = currentState[KIND[kind].src];
    return src ? src[gcCurrentGame()] : undefined;
  }
  function gcSupports(kind) { return Array.isArray(gcLive(kind)) || ((gcBundle && gcBundle[kind]) || []).length > 0; }

  function gcBuiltinRoles() { return (typeof ROLES_BY_GAME !== 'undefined' && ROLES_BY_GAME[gcCurrentGame()]) || []; }
  function gcAllRoles() {
    const seen = new Set(); const out = [];
    gcBuiltinRoles().concat((gcBundle && gcBundle.roles) || []).forEach((r) => { const k = lc(r); if (r && !seen.has(k)) { seen.add(k); out.push(r); } });
    return out;
  }
  // Roles a character can have: the roles the game's characters already use (Overwatch's heroes
  // say "Damage" while its player roles say "DPS"), then the game's roles and the producer's own.
  function gcCharacterRoleOptions() {
    const seen = new Set(); const out = [];
    (gcLive('characters') || []).map((c) => c.role || '').concat(gcAllRoles())
      .forEach((r) => { if (r && !seen.has(lc(r))) { seen.add(lc(r)); out.push(r); } });
    return out;
  }
  function gcModeOptions() {
    const meta = (currentState.vetoMeta || {})[gcCurrentGame()] || {};
    const seen = new Set(); const out = [];
    (meta.modes || []).concat((gcLive('maps') || []).map((m) => m.type || m.tier || ''))
      .forEach((t) => { if (t && !seen.has(lc(t))) { seen.add(lc(t)); out.push(t); } });
    return out;
  }

  // ── The merged view: live list with unsaved local edits on top ─────────────────────────────
  // Each entry: { id, name, image, extra, state: 'builtin' | 'edited' | 'added', row }.
  function gcView(kind) {
    const K = KIND[kind];
    const live = gcLive(kind) || [];
    const rows = (gcBundle && gcBundle[kind]) || [];
    const rowById = {}; rows.forEach((r) => { rowById[r.id] = r; });
    const rowByName = {}; rows.forEach((r) => { if (r.name) rowByName[lc(r.name)] = r; });
    const used = new Set();
    const out = [];
    live.forEach((x) => {
      let row = rowById[x.id];
      if (!row && x.custom) row = rowByName[lc(x.name)];   // a new row saved under its normalised id
      if (x.custom && !row) return;                         // removed locally, save on its way
      if (row) used.add(row);
      out.push({
        id: x.id,
        name: (row && row.name) || x.name || '',
        image: (row && row.image) || x.image || '',
        extra: (row && row[K.extra]) || x[K.extra] || x.tier || '',
        state: x.custom ? 'added' : (row ? 'edited' : 'builtin'),
        row: row || null,
      });
    });
    rows.forEach((r) => {
      if (used.has(r)) return;
      out.push({ id: r.id, name: r.name || '', image: r.image || '', extra: r[K.extra] || '', state: 'added', row: r });
    });
    return out;
  }

  // ── Loading / saving ───────────────────────────────────────────────────────────────────────
  function gcLoadForGame(gameId) {
    const active = (currentState.gameConfigs || {})[gameId];
    gcBundle = active ? Object.assign(gcBlankBundle(gameId), JSON.parse(JSON.stringify(active))) : gcBlankBundle(gameId);
    gcBundle.game = gameId;
    ['maps', 'characters', 'roles', 'modes'].forEach((k) => { if (!Array.isArray(gcBundle[k])) gcBundle[k] = []; });
    if (!gcBundle.roleIcons || typeof gcBundle.roleIcons !== 'object') gcBundle.roleIcons = {};
    gcReloadPending = false;
    if (el('gc-author')) el('gc-author').value = gcBundle.author || '';
    if (el('gc-version')) el('gc-version').value = gcBundle.gameVersion || '';
    if (el('gc-config-id')) el('gc-config-id').value = gcBundle.configId || '';
    if (gcTab !== 'roles' && !gcSupports(gcTab)) gcTab = gcSupports('characters') ? 'characters' : gcSupports('maps') ? 'maps' : 'roles';
    gcRenderSig = '';
    gcRender();
  }

  function gcStatus(text, tone) {
    const s = el('gcb-status'); if (!s) return;
    s.textContent = text || '';
    s.dataset.tone = tone || '';
  }

  function gcQueueSave() {
    gcStatus('Saving…');
    clearTimeout(gcSaveTimer);
    gcSaveTimer = setTimeout(gcSaveNow, SAVE_DELAY_MS);
  }
  function gcSaveNow() {
    gcSaveTimer = null;
    if (!gcBundle || !gcBundle.game) return;
    if (gcSaving) { gcSaveAgain = true; return; }
    gcSaving = true;
    send('save_game_config', { bundle: gcBundle });
  }

  function gcResult(msg, ok) {
    const r = el('gc-result'); if (!r) return;
    r.textContent = msg || '';
    r.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)');
  }

  // app.js routes import-export-result messages with context 'game-config' here. A result for one
  // of our own autosaves goes to the quiet status line; import / export / reset results are shown.
  // The state broadcast carrying the change is coalesced and can land AFTER this result, so the
  // reload waits for it (gcReloadPending → _gcRefresh), with a timer as the fallback.
  window._gcHandleImportExportResult = function (message, ok) {
    if (gcSaving) {
      gcSaving = false;
      if (!ok) { gcStatus(message || 'Could not save', 'bad'); return; }
      if (gcSaveAgain || gcSaveTimer) { gcSaveAgain = false; gcSaveNow(); return; }
      gcStatus('Saved', 'good');
      setTimeout(() => { const s = el('gcb-status'); if (s && s.textContent === 'Saved') gcStatus(''); }, 2500);
    } else {
      gcResult(message, ok);
      if (!ok || /exported/i.test(message || '')) return;   // an export changes nothing server-side
    }
    gcReloadPending = true;
    setTimeout(() => { if (gcReloadPending && !gcEdit && !gcSaveTimer && !gcSaving) gcLoadForGame(gcCurrentGame()); }, 600);
  };

  // ── Rendering ──────────────────────────────────────────────────────────────────────────────
  function gcRender() {
    if (!gcBundle) return;
    const name = gcGameName();
    const intro = el('gcb-intro');
    if (intro) intro.textContent = `Everything this app knows for ${name}. Click a card to change its picture, name or role, or add a new one. Changes apply straight away.`;
    // Tabs: only what this game actually has.
    const support = { characters: gcSupports('characters'), maps: gcSupports('maps'), roles: true };
    document.querySelectorAll('#gc-tabs .lg2-tab').forEach((b) => {
      const t = b.dataset.tab;
      b.hidden = !support[t];
      b.classList.toggle('active', t === gcTab);
    });
    const counts = { characters: gcView('characters').length, maps: gcView('maps').length, roles: gcAllRoles().length };
    Object.keys(counts).forEach((k) => { const e = el('gc-badge-' + k); if (e) e.textContent = counts[k]; });

    const isRoles = gcTab === 'roles';
    const add = el('gcb-add'), up = el('gcb-upload'), search = el('gcb-search'), hint = el('gcb-drop-hint');
    if (add) add.textContent = isRoles ? 'Add role' : 'Add ' + KIND[gcTab].noun;
    if (up) up.hidden = isRoles;
    if (search) { search.hidden = isRoles; if (search.value !== gcQuery) search.value = gcQuery; }
    if (hint) hint.hidden = isRoles;
    const reset = el('btn-gc-reset'); if (reset) reset.style.display = gcHasChanges(gcActive()) ? '' : 'none';

    gcRenderVersions();
    gcRenderEditor();
    if (isRoles) gcRenderRoles(); else gcRenderGrid(gcTab);
  }

  function gcRenderGrid(kind) {
    const body = el('gcb-body'); if (!body) return;
    const K = KIND[kind];
    const all = gcView(kind);
    const q = lc(gcQuery);
    const items = q ? all.filter((x) => lc(x.name).includes(q) || lc(x.extra).includes(q)) : all;
    const label = { edited: 'Changed', added: 'Added by you' };
    if (!all.length) {
      body.innerHTML = `<div class="gcb-empty">No ${K.noun}s for ${gcEsc(gcGameName())} yet.<br>Press <b>Add ${K.noun}</b>, or drop pictures here.</div>`;
      return;
    }
    if (!items.length) { body.innerHTML = `<div class="gcb-empty">Nothing matches "${gcEsc(gcQuery)}".</div>`; return; }
    body.innerHTML = `<div class="gcb-grid gcb-grid-${kind}">${items.map((x) => {
      const img = gcImg(x.image);
      return `<button type="button" class="gcb-card${gcEdit && gcEdit.kind === kind && gcEdit.id === x.id ? ' is-open' : ''}" data-id="${gcEsc(x.id)}" title="Edit ${gcEsc(x.name)}">
        <span class="gcb-pic">${img ? `<img src="${gcEsc(img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="gcb-nopic">No picture</span></span>
        <span class="gcb-name">${gcEsc(x.name || 'Unnamed')}</span>
        <span class="gcb-meta">${x.extra ? gcEsc(x.extra) : '&nbsp;'}</span>
        ${label[x.state] ? `<span class="gcb-badge gcb-badge-${x.state}">${label[x.state]}</span>` : ''}
      </button>`;
    }).join('')}</div>`;
  }

  function gcRoleIcon(role) {
    const own = (gcBundle.roleIcons || {})[lc(role)];
    if (own) return own;
    const active = gcActive();
    // roleIconUrl() resolves the SAVED config first; skip that so a removed icon reads as removed.
    if (active && active.roleIcons && active.roleIcons[lc(role)]) return '';
    return typeof roleIconUrl === 'function' ? roleIconUrl(gcCurrentGame(), role) : '';
  }
  function gcRenderRoles() {
    const body = el('gcb-body'); if (!body) return;
    const builtin = new Set(gcBuiltinRoles().map(lc));
    const roles = gcAllRoles();
    body.innerHTML = (roles.length ? `<div class="gcb-roles">${roles.map((r) => {
      const img = gcRoleIcon(r);
      const own = !!(gcBundle.roleIcons || {})[lc(r)];
      return `<div class="gcb-role" data-role="${gcEsc(r)}">
        <button type="button" class="gcb-role-icon${img ? '' : ' is-empty'}" data-act="icon" title="${img ? 'Change icon' : 'Add an icon'}">${img ? `<img src="${gcEsc(gcImg(img))}" alt="" onerror="this.remove()">` : '<span>+</span>'}</button>
        <span class="gcb-role-name">${gcEsc(r)}</span>
        ${own ? '<button type="button" class="btn btn-ghost btn-xs" data-act="clear-icon">Remove icon</button>' : ''}
        ${builtin.has(lc(r)) ? '' : '<button type="button" class="btn btn-ghost btn-xs gcb-danger" data-act="del">Delete</button>'}
      </div>`;
    }).join('')}</div>` : `<div class="gcb-empty">${gcEsc(gcGameName())} has no roles yet. Press <b>Add role</b>.</div>`)
      + '<p class="gcb-note">Click an icon box to add or change the icon. A light icon on a clear background reads best. Icons show in the player role picker and on overlays that print a role.</p>';
  }

  // ── Versions bar ───────────────────────────────────────────────────────────────────────────
  function gcRenderVersions() {
    const sel = el('gcb-version-sel'); if (!sel) return;
    const vs = gcVersions();
    const from = gcFrom();
    const cur = gcCurrentVersion();
    const has = gcHasChanges(gcActive());
    const day = (t) => { try { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; } };
    sel.innerHTML = (cur === '__unsaved' ? '<option value="__unsaved">My changes (not saved as a version)</option>' : '')
      + '<option value="__original">Original (as the app ships it)</option>'
      + vs.map((v) => `<option value="${gcEsc(v.name)}">${gcEsc(v.name)} · saved ${gcEsc(day(v.savedAt))}</option>`).join('');
    sel.value = cur;
    const isVersion = cur !== '__unsaved' && cur !== '__original';
    const changed = isVersion && from && !from.clean;
    const st = el('gcb-version-state');
    if (st) {
      st.textContent = changed ? 'Changed since you saved it'
        : cur === '__unsaved' ? 'Save these as a version to keep them, then build on them later'
        : cur === '__original' && vs.length ? 'Pick a saved version to go back to it'
        : 'Your edits can be saved as a named version, like "Season 20", to switch back to later';
      st.dataset.tone = changed || cur === '__unsaved' ? 'warn' : '';
    }
    const upd = el('gcb-version-update');
    if (upd) { upd.hidden = !changed; upd.textContent = `Update "${cur}"`; }
    const nu = el('gcb-version-new'); if (nu) nu.hidden = !has;
    const del = el('gcb-version-del'); if (del) del.hidden = !isVersion;
  }
  // Send any pending autosave now, so a version captures the latest edits (the socket keeps order).
  function gcFlushSave() {
    if (!gcSaveTimer) return;
    clearTimeout(gcSaveTimer); gcSaveTimer = null;
    if (gcBundle && gcBundle.game) { gcSaving = true; send('save_game_config', { bundle: gcBundle }); }
  }
  function gcDropPendingSave() { clearTimeout(gcSaveTimer); gcSaveTimer = null; gcSaveAgain = false; gcStatus(''); }

  el('gcb-version-sel')?.addEventListener('change', (e) => {
    const v = e.target.value;
    const cur = gcCurrentVersion();
    if (v === cur || v === '__unsaved') return;
    const from = gcFrom();
    const unsaved = cur === '__unsaved' || (from && !from.clean && cur !== '__original');
    const go = () => {
      gcDropPendingSave(); gcEdit = null;
      send('game_config_version_load', { gameId: gcCurrentGame(), name: v === '__original' ? '' : v });
    };
    if (!unsaved && !gcSaveTimer) { go(); return; }
    const label = v === '__original' ? 'the original content' : `"${v}"`;
    appConfirm(`Your latest changes are not saved as a version. Switch to ${label} and lose them?`, 'Switch', true)
      .then((ok) => { if (ok) go(); else gcRenderVersions(); });
  });
  el('gcb-version-new')?.addEventListener('click', () => {
    const suggest = (gcBundle && gcBundle.gameVersion) || '';
    customPrompt('Save as a version', `Name this version of your ${gcGameName()} content, for example "Season 20". You can switch back to it, or start from it, any time.`, suggest, 'Save')
      .then((name) => {
        name = String(name || '').trim(); if (!name) return;
        const exists = gcVersions().some((v) => v.name.toLowerCase() === name.toLowerCase());
        const save = () => { gcFlushSave(); send('game_config_version_save', { gameId: gcCurrentGame(), name }); };
        if (!exists) { save(); return; }
        appConfirm(`There is already a version called "${name}". Replace it with what you have now?`, 'Replace').then((ok) => { if (ok) save(); });
      });
  });
  el('gcb-version-update')?.addEventListener('click', () => {
    const name = gcCurrentVersion();
    appConfirm(`Replace "${name}" with what you have now?`, 'Update').then((ok) => {
      if (ok) { gcFlushSave(); send('game_config_version_save', { gameId: gcCurrentGame(), name }); }
    });
  });
  el('gcb-version-del')?.addEventListener('click', () => {
    const name = gcCurrentVersion();
    appConfirm(`Delete the saved version "${name}"? What you are using now stays as it is.`, 'Delete', true).then((ok) => {
      if (ok) send('game_config_version_delete', { gameId: gcCurrentGame(), name });
    });
  });

  // ── Editor (one card at a time, opens above the grid) ──────────────────────────────────────
  function gcOpenEditor(kind, id) {
    const K = KIND[kind];
    if (id == null) {
      gcEdit = { kind, id: null, draft: { name: '', image: '', extra: '' } };
    } else {
      const x = gcView(kind).find((v) => v.id === id); if (!x) return;
      gcEdit = { kind, id, state: x.state, draft: { name: x.name, image: x.image, extra: x.extra }, orig: { name: x.name, image: x.image, extra: x.extra } };
    }
    gcRender();
    const box = el('gcb-editor');
    if (box) { box.scrollIntoView({ block: 'nearest' }); const n = box.querySelector('[data-f="name"]'); if (n && id == null) n.focus(); }
    void K;
  }
  function gcCloseEditor() {
    gcEdit = null;
    if (gcReloadPending && !gcSaveTimer && !gcSaving) { gcLoadForGame(gcCurrentGame()); return; }
    gcRender();
  }

  function gcRenderEditor() {
    const box = el('gcb-editor'); if (!box) return;
    if (!gcEdit || gcEdit.kind !== gcTab) { box.hidden = true; box.innerHTML = ''; return; }
    const K = KIND[gcEdit.kind];
    const d = gcEdit.draft;
    const isNew = gcEdit.id == null;
    const opts = gcEdit.kind === 'characters' ? gcCharacterRoleOptions() : gcModeOptions();
    const known = !d.extra || opts.some((o) => lc(o) === lc(d.extra));
    const img = gcImg(d.image);
    box.hidden = false;
    box.innerHTML = `
      <div class="gcb-ed-head">${isNew ? 'New ' + K.noun : 'Edit ' + gcEsc(gcEdit.orig.name || K.noun)}${gcEdit.state === 'edited' ? '<span class="gcb-badge gcb-badge-edited">Changed</span>' : ''}</div>
      <div class="gcb-ed-body">
        <button type="button" class="gcb-ed-pic gcb-grid-${gcEdit.kind}${img ? '' : ' is-empty'}" data-act="pick" title="Choose a picture, or drop one here">
          ${img ? `<img src="${gcEsc(img)}" alt="">` : ''}<span>${img ? 'Change picture' : 'Add a picture'}</span>
        </button>
        <div class="gcb-ed-fields">
          <div class="field-row"><label class="field-label">Name</label>
            <input type="text" class="input-text" data-f="name" value="${gcEsc(d.name)}" placeholder="${K.noun.charAt(0).toUpperCase() + K.noun.slice(1)} name" maxlength="60"></div>
          <div class="field-row"><label class="field-label">${K.extraLabel}</label>
            <select class="input-select" data-f="extra-sel">
              <option value="">None</option>
              ${opts.map((o) => `<option value="${gcEsc(o)}"${lc(o) === lc(d.extra) ? ' selected' : ''}>${gcEsc(o)}</option>`).join('')}
              <option value="__other"${known ? '' : ' selected'}>Other…</option>
            </select>
            <input type="text" class="input-text gcb-ed-other" data-f="extra-other" value="${known ? '' : gcEsc(d.extra)}" placeholder="Type the ${K.extraLabel.toLowerCase()}"${known ? ' hidden' : ''}></div>
          <p class="gcb-ed-err" data-f="err"></p>
        </div>
      </div>
      <div class="gcb-ed-actions">
        <button type="button" class="btn btn-primary btn-sm" data-act="done">${isNew ? 'Add ' + K.noun : 'Done'}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button>
        <span style="flex:1;"></span>
        ${gcEdit.state === 'edited' ? '<button type="button" class="btn btn-ghost btn-sm" data-act="restore">Restore original</button>' : ''}
        ${gcEdit.state === 'added' ? `<button type="button" class="btn btn-ghost btn-sm gcb-danger" data-act="delete">Delete ${K.noun}</button>` : ''}
      </div>`;
  }

  function gcEditorCommit() {
    const box = el('gcb-editor'); if (!gcEdit || !box) return;
    const K = KIND[gcEdit.kind];
    const d = gcEdit.draft;
    d.name = (box.querySelector('[data-f="name"]').value || '').trim();
    const sel = box.querySelector('[data-f="extra-sel"]').value;
    d.extra = sel === '__other' ? (box.querySelector('[data-f="extra-other"]').value || '').trim() : sel;
    const err = box.querySelector('[data-f="err"]');
    if (!d.name) { err.textContent = 'Give it a name first.'; box.querySelector('[data-f="name"]').focus(); return; }
    const rows = gcBundle[gcEdit.kind];
    const clash = gcView(gcEdit.kind).find((x) => lc(x.name) === lc(d.name) && x.id !== gcEdit.id);
    if (clash) { err.textContent = `There is already a ${K.noun} called ${clash.name}. Click its card to change it instead.`; return; }
    if (gcEdit.id == null) {
      rows.push({ id: gcUid(K.uid), name: d.name, image: d.image || '', [K.extra]: d.extra || '' });
    } else {
      const o = gcEdit.orig;
      if (d.name === o.name && d.image === o.image && d.extra === o.extra) { gcCloseEditor(); return; }
      let row = rows.find((r) => r.id === gcEdit.id) || rows.find((r) => lc(r.name) === lc(o.name));
      if (!row) { row = { id: gcEdit.id }; rows.push(row); }
      row.name = d.name;
      if (d.image !== o.image || row.image) row.image = d.image;
      row[K.extra] = d.extra;
    }
    if (d.extra && gcEdit.kind === 'characters' && !gcAllRoles().some((r) => lc(r) === lc(d.extra))) gcBundle.roles.push(d.extra);
    gcEdit = null;
    gcQueueSave();
    gcRender();
  }
  function gcEditorRemoveRow() {
    if (!gcEdit) return;
    const o = gcEdit.orig || {};
    gcBundle[gcEdit.kind] = gcBundle[gcEdit.kind].filter((r) => r.id !== gcEdit.id && !(o.name && lc(r.name) === lc(o.name)));
    gcEdit = null;
    gcQueueSave();
    gcRender();
  }

  // ── Pictures ───────────────────────────────────────────────────────────────────────────────
  let gcPickTarget = null;
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
  async function gcSetEditorImage(file) {
    if (!gcEdit || !file) return;
    gcEdit.draft.image = await gcReadImage(file, gcEdit.kind);
    // Keep whatever was typed while the picture loaded.
    const box = el('gcb-editor');
    if (box) {
      const n = box.querySelector('[data-f="name"]'); if (n) gcEdit.draft.name = n.value;
      if (!gcEdit.draft.name) gcEdit.draft.name = gcNameFromFile(file);
    }
    gcRenderEditor();
  }
  // Bulk: each file becomes a card; a file named after an existing card replaces its picture.
  async function gcAddFiles(kind, files) {
    if (!gcBundle || !KIND[kind]) return;
    const K = KIND[kind];
    const imgs = gcImageFiles(files);
    if (!imgs.length) { gcResult('Those files are not pictures. Use PNG, JPG, WebP or SVG.', false); return; }
    let added = 0, replaced = 0;
    for (const f of imgs) {
      const name = gcNameFromFile(f);
      const image = await gcReadImage(f, kind);
      const view = gcView(kind).find((x) => lc(x.name) === lc(name));
      if (view) {
        let row = gcBundle[kind].find((r) => r.id === view.id) || gcBundle[kind].find((r) => lc(r.name) === lc(name));
        if (!row) { row = { id: view.id, name: view.name, [K.extra]: view.extra || '' }; gcBundle[kind].push(row); }
        row.image = image; replaced++;
      } else {
        gcBundle[kind].push({ id: gcUid(K.uid), name, image, [K.extra]: '' }); added++;
      }
    }
    gcResult([added ? `Added ${added} ${K.noun}${added === 1 ? '' : 's'}` : '', replaced ? `updated ${replaced} picture${replaced === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')
      + (added && kind === 'characters' ? '. Click a new card to set its role.' : '.'), true);
    gcQueueSave();
    gcRender();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────────────────────
  el('gc-game')?.addEventListener('change', () => {
    gcLoadedGame = gcCurrentGame();
    gcEdit = null; gcQuery = '';
    gcResult('');
    gcLoadForGame(gcLoadedGame);
  });
  el('gc-tabs')?.addEventListener('click', (e) => {
    const t = e.target.closest('.lg2-tab'); if (!t) return;
    gcTab = t.dataset.tab; gcEdit = null; gcQuery = ''; gcResult('');
    gcRender();
  });
  el('gcb-search')?.addEventListener('input', (e) => { gcQuery = e.target.value; if (gcTab !== 'roles') gcRenderGrid(gcTab); });
  el('gcb-add')?.addEventListener('click', () => {
    if (!gcBundle) return;
    if (gcTab === 'roles') { gcAddRole(); return; }
    gcOpenEditor(gcTab, null);
  });
  el('gcb-upload')?.addEventListener('click', () => { const kind = gcTab; gcPickImages(true, (files) => gcAddFiles(kind, files)); });
  el('gc-file')?.addEventListener('change', () => {
    const files = gcImageFiles(el('gc-file').files); const cb = gcPickTarget; gcPickTarget = null;
    if (cb && files.length) cb(files);
  });

  el('gcb-body')?.addEventListener('click', (e) => {
    if (!gcBundle) return;
    const card = e.target.closest('.gcb-card');
    if (card) { gcOpenEditor(gcTab, card.dataset.id); return; }
    const act = e.target.closest('[data-act]'); if (!act) return;
    const role = act.closest('.gcb-role') && act.closest('.gcb-role').dataset.role; if (!role) return;
    const key = lc(role);
    if (act.dataset.act === 'icon') {
      gcPickImages(false, async (files) => {
        gcBundle.roleIcons[key] = await gcReadImage(files[0], 'roles');
        gcQueueSave(); gcRender();
      });
      return;
    }
    if (act.dataset.act === 'clear-icon') delete gcBundle.roleIcons[key];
    if (act.dataset.act === 'del') {
      gcBundle.roles = gcBundle.roles.filter((r) => lc(r) !== key);
      delete gcBundle.roleIcons[key];
    }
    gcQueueSave(); gcRender();
  });

  function gcAddRole() {
    const body = el('gcb-body'); if (!body || body.querySelector('.gcb-role-new')) { const i = body && body.querySelector('.gcb-role-new input'); if (i) i.focus(); return; }
    const row = document.createElement('div');
    row.className = 'gcb-role-new';
    row.innerHTML = '<input type="text" class="input-text" placeholder="Role name, e.g. Flex" maxlength="40"><button type="button" class="btn btn-primary btn-sm">Add</button><button type="button" class="btn btn-ghost btn-sm">Cancel</button>';
    body.prepend(row);
    const inp = row.querySelector('input');
    const [ok, cancel] = row.querySelectorAll('button');
    const commit = () => {
      const v = (inp.value || '').trim(); if (!v) { inp.focus(); return; }
      if (!gcAllRoles().some((r) => lc(r) === lc(v))) { gcBundle.roles.push(v); gcQueueSave(); }
      gcRender();
    };
    ok.addEventListener('click', commit);
    cancel.addEventListener('click', () => row.remove());
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') row.remove(); });
    inp.focus();
  }

  el('gcb-editor')?.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]'); if (!act || !gcEdit) return;
    const a = act.dataset.act;
    if (a === 'pick') gcPickImages(false, (files) => gcSetEditorImage(files[0]));
    else if (a === 'done') gcEditorCommit();
    else if (a === 'cancel') gcCloseEditor();
    else if (a === 'restore' || a === 'delete') {
      const what = a === 'restore' ? `Put ${gcEdit.orig.name} back to how it came with the app?` : `Delete ${gcEdit.orig.name}?`;
      appConfirm(what, a === 'restore' ? 'Restore' : 'Delete').then((ok) => { if (ok) gcEditorRemoveRow(); });
    }
  });
  el('gcb-editor')?.addEventListener('change', (e) => {
    if (e.target.dataset.f !== 'extra-sel') return;
    const other = el('gcb-editor').querySelector('[data-f="extra-other"]');
    if (other) { other.hidden = e.target.value !== '__other'; if (!other.hidden) other.focus(); }
  });
  el('gcb-editor')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); gcEditorCommit(); }
    if (e.key === 'Escape') gcCloseEditor();
  });

  // Drag pictures onto the list (bulk add) or onto the open editor's picture (replace it). The
  // window-wide file-drop-navigation guard is installed once by wireAssetDrop() in app.js.
  (function wireDrops() {
    const zone = el('gcb-body'), ed = el('gcb-editor');
    if (zone) {
      let depth = 0;
      const show = (on) => zone.classList.toggle('drag-over', on);
      zone.addEventListener('dragenter', (e) => { if (gcTab === 'roles') return; e.preventDefault(); depth++; show(true); });
      zone.addEventListener('dragover', (e) => { if (gcTab === 'roles') return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
      zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; show(false); } });
      zone.addEventListener('drop', (e) => {
        if (gcTab === 'roles') return;
        e.preventDefault(); depth = 0; show(false);
        gcAddFiles(gcTab, e.dataTransfer && e.dataTransfer.files);
      });
    }
    if (ed) {
      ed.addEventListener('dragover', (e) => { if (gcEdit) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } });
      ed.addEventListener('drop', (e) => {
        if (!gcEdit) return;
        e.preventDefault();
        gcSetEditorImage(gcImageFiles(e.dataTransfer && e.dataTransfer.files)[0]);
      });
    }
  })();

  // Share / reset
  [['gc-author', 'author'], ['gc-version', 'gameVersion'], ['gc-config-id', 'configId']].forEach(([id, key]) => {
    el(id)?.addEventListener('change', () => { if (gcBundle) { gcBundle[key] = el(id).value.trim(); gcQueueSave(); } });
  });
  el('btn-gc-export')?.addEventListener('click', () => {
    if (!gcBundle || !gcBundle.game) return;
    gcBundle.exportedAt = Date.now();
    send('export_game_config', { gameId: gcBundle.game, bundle: gcBundle });
  });
  el('btn-gc-import')?.addEventListener('click', () => {
    const go = () => send('import_game_config');
    if (!gcHasChanges(gcActive())) { go(); return; }
    appConfirm(`Importing replaces what you are using now for ${gcGameName()}. Saved versions are kept. Continue?`, 'Import').then((ok) => { if (ok) go(); });
  });
  el('btn-gc-reset')?.addEventListener('click', () => {
    const gameId = gcCurrentGame(); if (!gameId) return;
    appConfirm(`Go back to the original ${gcGameName()} content? Characters, maps and roles you added are removed and every picture goes back to the original. Saved versions are kept, so you can switch back to one later.`, 'Undo all').then((ok) => {
      if (ok) { gcEdit = null; send('clear_game_config', { gameId }); }
    });
  });

  function gcPopulateGameSelect() {
    const sel = el('gc-game'); if (!sel) return;
    const games = currentState.games || {};
    const sig = Object.keys(games).join('|');
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    const prev = sel.value;
    sel.innerHTML = Object.keys(games).map((id) => `<option value="${gcEsc(id)}">${gcEsc(games[id].name || id)}</option>`).join('');
    if (prev && games[prev]) sel.value = prev;
    if (!gcBundle) { gcLoadedGame = sel.value; gcLoadForGame(sel.value); }
  }

  // Cheap fingerprint of what this page shows, so a state update only re-renders when it changed.
  function gcSig() {
    const g = gcCurrentGame();
    const part = (list) => (list || []).map((x) => x.id + ':' + (x.name || '') + ':' + String(x.image || '').length + ':' + (x.role || x.type || '')).join(',');
    const a = (currentState.gameConfigs || {})[g];
    return g + '|' + part((currentState.draftRosters || {})[g]) + '|' + part((currentState.vetoPools || {})[g])
      + '|' + (a ? JSON.stringify(a.roles || []) + Object.keys(a.roleIcons || {}).join(',') : '') + '|' + JSON.stringify(gcBuiltinRoles())
      + '|' + JSON.stringify(gcFrom()) + '|' + gcVersions().map((v) => v.name + '@' + v.savedAt).join(',');
  }

  // Called from app.js's applyState on every state update.
  window._gcRefresh = function () {
    gcPopulateGameSelect();
    if (!gcBundle) return;
    if (gcReloadPending && !gcEdit && !gcSaveTimer && !gcSaving) { gcLoadForGame(gcCurrentGame()); return; }
    const sec = el('section-game-config');
    if (!sec || !sec.offsetParent) return;   // not on screen: nothing to repaint
    const sig = gcSig();
    if (sig === gcRenderSig) return;
    gcRenderSig = sig;
    if (!gcEdit) gcRender();
  };
})();
