// Control panel, part 5 of 17: Media library, assets, team list and vault, battle royale series, ad slots, scorecard, match teams.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Media library ─────────────────────────────────────────────────────────
const MD_API = 'http://127.0.0.1:3000/api/media';
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
  const q = mdState.search.trim();
  // Path is searchable as well as the filename, so "logos/tsm" finds it from anywhere in the tree.
  const folders = NESearch.filter(mdState.folders, q, (f) => [{ text: f.name, weight: 2 }, f.path]);
  const files = NESearch.filter(mdState.files, q, (f) => [{ text: f.name, weight: 2 }, f.path]);
  let html = `<button class="md-tile md-newfolder" id="md-newfolder">
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
    <span>Create Folder</span></button>`;
  html += folders.map((f) => `<div class="md-tile md-folder" data-folder="${f.path}">
    <button class="md-del" data-del="${f.path}" title="Delete folder"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6"/></svg></button>
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    <span class="md-name">${f.name}</span></div>`).join('');
  html += files.map((f) => `<div class="md-tile md-file" data-url="${f.url}" data-path="${f.path}" title="${f.name}">
    <button class="md-del" data-del="${f.path}" title="Delete"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6"/></svg></button>
    <div class="md-thumb"><img src="http://127.0.0.1:3000${f.url}" alt="" loading="lazy"></div>
    <span class="md-name">${f.name}</span></div>`).join('');
  grid.innerHTML = html;

  el('md-newfolder')?.addEventListener('click', async () => {
    const name = await nePrompt('New folder name:');
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
    if (!await appConfirm('Delete "' + b.dataset.del + '"?', 'Delete')) return;
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

// Electron's renderer does not implement window.prompt() — it silently returns undefined.
// nePrompt() is a small Promise-based replacement used wherever we need a text value.
function nePrompt(message, def = '') {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'ne-prompt-overlay';
    ov.innerHTML = '<div class="ne-prompt"><div class="ne-prompt-msg"></div>'
      + '<input class="input-text ne-prompt-input" type="text">'
      + '<div class="ne-prompt-actions"><button type="button" class="btn btn-ghost btn-sm ne-prompt-cancel">Cancel</button>'
      + '<button type="button" class="btn btn-blue btn-sm ne-prompt-ok">OK</button></div></div>';
    ov.querySelector('.ne-prompt-msg').textContent = message;
    const input = ov.querySelector('.ne-prompt-input');
    input.value = def;
    document.body.appendChild(ov);
    const done = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('.ne-prompt-ok').addEventListener('click', () => done(input.value.trim() || null));
    ov.querySelector('.ne-prompt-cancel').addEventListener('click', () => done(null));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// ── Assets page: top tabs (Assets | Overlays | Profiles) ─────────────────
// The Profiles (brand kits) page is re-parented into Assets ▸ Profiles below — moving the
// nodes (not cloning) keeps every brand element ID and handler intact.
(function mergeProfilesIntoSettings() {
  // Brand Kits editor is authored as its own #tab-brands-content page, then re-parented (not cloned,
  // so every element ID + handler stays intact) into Settings ▸ Brand Kits. Was Assets ▸ Profiles.
  const src = el('tab-brands-content'), dest = el('set-sec-brandkits');
  if (!src || !dest || dest.dataset.merged) return;
  const head = src.querySelector('.page-head'); if (head) head.remove();   // the settings rail already labels it
  while (src.firstChild) dest.appendChild(src.firstChild);
  src.remove();   // drop the now-empty .tab-content shell
  dest.dataset.merged = '1';
})();

// Features: re-parent the Twitch Games & Features panel out of Integrations into Settings ▸ Features
// (predictions / giveaway wheel / chat minigames). Handlers are bare-id/delegated so they survive the
// move; _intShowTab no longer lists it (it stayed only under the Twitch integration before).
(function moveFeaturesIntoSettings() {
  const p = el('integration-twitchgames'), dest = el('set-sec-features');
  if (p && dest && !dest.dataset.merged) {
    dest.appendChild(p);
    p.style.display = '';                 // always visible inside its settings section
    p.style.borderTop = 'none'; p.style.paddingTop = '0'; p.style.marginTop = '0';   // drop the in-Integrations separator
    dest.dataset.merged = '1';
  }
})();

// Games: fold the per-game setup panel (Stats API / GSI, HUD/overlay per game) out of Integrations
// into Settings ▸ Games. It keeps its own game-tab selector (the per-game browser). The Integrations
// store cards + subnav that pointed at it now deep-link to Settings (see the card handler + subnav).
(function moveGamesSetupIntoSettings() {
  const p = el('integration-games'), dest = el('set-sec-gamesetup');
  if (p && dest && !dest.dataset.merged) {
    dest.appendChild(p);
    p.style.display = '';
    dest.dataset.merged = '1';
  }
  // games-hub.js then folds the rest in: the layout picker (Overlay tab), RL scene automation
  // (RL Automation tab) and the Config Builder (Custom content tab).
})();

let _assetsTab = 'media';
function _assetsShow(which) {
  _assetsTab = (which === 'overlays') ? which : 'media';   // Profiles moved to Settings ▸ Brand Kits
  document.querySelectorAll('#assets-subnav .ev-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.assettab === _assetsTab));
  const mp = el('assets-panel-media'), op = el('assets-panel-overlays'), pp = el('assets-panel-profiles');
  if (mp) mp.style.display = _assetsTab === 'media' ? '' : 'none';
  if (op) op.style.display = _assetsTab === 'overlays' ? '' : 'none';
  if (pp) pp.style.display = _assetsTab === 'profiles' ? '' : 'none';
  if (_assetsTab === 'overlays') {
    if (typeof loadScenePreviews === 'function') loadScenePreviews();
    // The list can be built before state arrives; filter for the game that is active now.
    if (el('scene-source-list')?.dataset.built && typeof applySceneFilter === 'function') applySceneFilter();
  }
  else { if (typeof unloadScenePreviews === 'function') unloadScenePreviews(); if (_assetsTab === 'media' && typeof mdLoad === 'function') mdLoad(); }
  try { localStorage.setItem('assets_active_tab', _assetsTab); } catch (_) {}
}
window._assetsShow = _assetsShow;
document.querySelectorAll('#assets-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', function () { _assetsShow(this.dataset.assettab); }));
// Reopen whichever Assets sub-tab (Assets/Overlays/Profiles) the producer was last on — survives
// refresh. Deferred to a macrotask: _assetsShow() reaches into loadScenePreviews()/
// unloadScenePreviews(), which reference `_scenePreviewTimer`, a `let` declared thousands of
// lines further down — calling this synchronously here throws the same TDZ crash documented for
// the old switchRole('monitor') bug (and, uncaught at top level, HALTS the rest of the script from
// ever running — confirmed live via CDP debugging). setTimeout(...,0) waits for the full script.
setTimeout(() => {
  let saved; try { saved = localStorage.getItem('assets_active_tab'); } catch (_) {}
  if (saved === 'overlays' || saved === 'profiles') _assetsShow(saved);
}, 0);

// Toolbar "+ Folder" — same as the in-grid Create Folder tile.
el('md-newfolder-btn')?.addEventListener('click', async () => {
  const name = await nePrompt('New folder name:');
  if (!name) return;
  const r = await fetch(`${MD_API}/folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: mdState.path, name }) });
  const d = await r.json(); if (d.ok) mdLoad(); else mdSetStatus(d.error || 'Folder failed', false);
});

// ── Drag & drop: multiple images and whole folder trees into the current path ──
(function wireAssetDrop() {
  const dz = el('md-dropzone'); if (!dz) return;
  const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
  // Electron/Chromium navigates the window to a dropped file unless default is prevented.
  // Guard FILE drags window-wide (internal element drags don't carry a 'Files' type, so the
  // seed/Director reorder DnD is untouched); the dropzone runs the actual upload below.
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e) && !e.target.closest('#md-dropzone')) e.preventDefault(); });
  let depth = 0;
  const show = (on) => dz.classList.toggle('drag-over', on);
  dz.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; show(true); });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  dz.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) { depth = 0; show(false); } });
  dz.addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; show(false);
    const dt = e.dataTransfer; if (!dt) return;
    const uploads = [];
    const items = dt.items;
    // webkitGetAsEntry preserves folder structure (drag a folder in); fall back to flat files.
    if (items && items.length && items[0].webkitGetAsEntry) {
      const entries = [];
      for (const it of items) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) entries.push(en); }
      for (const en of entries) await walkEntry(en, mdState.path, uploads);
    } else {
      for (const f of dt.files) if (IMG_RE.test(f.name)) uploads.push({ path: mdState.path, file: f });
    }
    if (!uploads.length) { mdSetStatus('No images found in the drop. (Images only — png, jpg, svg, webp, gif.)', false); return; }
    await runUploads(uploads);
  });

  async function walkEntry(entry, destPath, out) {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (file && IMG_RE.test(file.name)) out.push({ path: destPath, file });
    } else if (entry.isDirectory) {
      const newPath = destPath ? destPath + '/' + entry.name : entry.name;
      try { await fetch(`${MD_API}/folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: destPath, name: entry.name }) }); } catch (_) {}
      const kids = await readAll(entry.createReader());
      for (const k of kids) await walkEntry(k, newPath, out);
    }
  }
  // readEntries returns batches — keep calling until it returns empty.
  function readAll(reader) {
    return new Promise((res) => {
      const all = [];
      (function more() { reader.readEntries((batch) => { if (!batch.length) return res(all); all.push(...batch); more(); }, () => res(all)); })();
    });
  }
  async function runUploads(list) {
    mdSetStatus(`Uploading ${list.length} image(s)…`);
    let done = 0, failed = 0;
    for (const u of list) {
      try {
        const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(u.file); });
        const r = await fetch(`${MD_API}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: u.path, name: u.file.name, dataUrl }) });
        const d = await r.json(); if (!d.ok) failed++;
      } catch (_) { failed++; }
      done++;
    }
    mdSetStatus(`Uploaded ${done - failed} image(s)${failed ? `, ${failed} failed` : ''}.`, failed ? false : true);
    mdLoad();
  }
})();

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
  const q = MP.search.trim();
  const folders = NESearch.filter(MP._folders || [], q, (f) => [{ text: f.name, weight: 2 }, f.path]);
  const files = NESearch.filter(MP._files || [], q, (f) => [{ text: f.name, weight: 2 }, f.path]);
  grid.innerHTML = folders.map((f) => `<div class="md-tile md-folder" data-folder="${f.path}">
    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    <span class="md-name">${f.name}</span></div>`).join('')
    + files.map((f) => `<div class="md-tile md-file" data-url="${f.url}" title="${f.name}">
      <div class="md-thumb"><img src="http://127.0.0.1:3000${f.url}" alt="" loading="lazy"></div>
      <span class="md-name">${f.name}</span></div>`).join('');
  grid.querySelectorAll('.md-folder').forEach((t) => t.addEventListener('click', () => { MP.path = t.dataset.folder; mpLoad(); }));
  grid.querySelectorAll('.md-file').forEach((t) => t.addEventListener('click', () => {
    const abs = 'http://127.0.0.1:3000' + t.dataset.url;
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
el('btn-lib-logo-blue')?.addEventListener('click', () => mpOpen((url) => { pendingLogoBlue = url; _logoDirty.blue = true; setSideLogo('blue', url); }));
el('btn-lib-logo-orange')?.addEventListener('click', () => mpOpen((url) => { pendingLogoOrange = url; _logoDirty.orange = true; setSideLogo('orange', url); }));
el('btn-lib-brand-logo')?.addEventListener('click', () => mpOpen((url) => { pendingBrandLogo = url; setBrandLogoPreview(url); }));
el('btn-lib-sponsor-logo')?.addEventListener('click', () => mpOpen((url) => {
  pendingSponsorLogo = url;
  setSponsorLogoPreview(url);   // show the picked logo so it's clear it's ready to add
}));

// (Bracket builder domain lives in bracket-builder.js)

// Badge: ✓ Saved (in library) · Event (seeded, not yet saved) · Not saved (manual/new).
function updateTeamSavedBadge(side) {
  const input = el(`input-name-${side}`);
  const badge = el(`team-saved-${side}`);
  if (!input || !badge) return;
  const name = input.value.trim();
  const t = name ? findTeam(name) : null;
  if (!name) { badge.textContent = ''; badge.className = 'team-saved-badge'; }
  else if (isTbdName(name)) { badge.textContent = 'Placeholder'; badge.className = 'team-saved-badge is-event'; }
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

  const countEl = el('teams-tab-count');
  if (countEl) countEl.textContent = teams.length ? '(' + teams.length + ')' : '';

  // Only rebuild the DOM when the data actually changes — this list can hold hundreds of
  // start.gg-imported teams, and rebuilding it on every full_state was the freeze. Use a CHEAP
  // Include favorite in the signature so cards re-render when fav status changes.
  const sig = teams.map((t) => (t.name || '') + '|' + (t.logo ? t.logo.length : 0) + '|' + (t.favorite ? '1' : '0') + '|' + (t.color || '') + '|' + (t._org ? 'o' : '') + '|' + (t.vaultId || '') + '|' + (t.players || []).length).join('~');
  if (sig === _teamsListSig) return;
  _teamsListSig = sig;

  list.querySelectorAll('.tc-card').forEach((i) => i.remove());

  const frag = document.createDocumentFragment();
  teams.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'tc-card' + (t.favorite ? ' is-fav' : '') + (t._org ? ' is-org' : '');
    card.dataset.name = t.name;
    card.dataset.origin = t._org ? 'org' : 'mine';
    // Search text carries the org owner (so "From organization" teams surface by their producer)
    // AND the roster — a producer far more often remembers a gamertag than which team it plays for.
    card.dataset.search = [
      t.name || '',
      t._org ? ('org ' + (t._orgOwner || '')) : '',
      (t.players || []).map((p) => (typeof p === 'string' ? p : ((p && (p.name || p.gamertag)) || ''))).join(' ')
    ].join(' ').toLowerCase();
    card.style.setProperty('--team-accent', t.color || '#055fdb');

    const accent = document.createElement('div'); accent.className = 'tc-card-accent';
    const body = document.createElement('div'); body.className = 'tc-card-body';
    const logo = document.createElement('img'); logo.className = 'tc-card-logo'; logo.loading = 'lazy'; logo.src = t.logo || teePlaceholder(t.name, t.color);
    const info = document.createElement('div'); info.className = 'tc-card-info';
    const nameEl = document.createElement('div'); nameEl.className = 'tc-card-name'; nameEl.textContent = t.name;
    if (t._org) { const b = document.createElement('span'); b.className = 'tc-org-badge'; b.textContent = 'ORG'; b.title = 'From organization' + (t._orgOwner ? ' · ' + t._orgOwner : ''); nameEl.appendChild(b); }
    // Banked in the team vault: this team's branding is re-applied automatically at future events,
    // even if the org renames or start.gg ships no crest. Without the badge there is nothing on
    // screen telling a producer which of their teams have that protection.
    if (t.vaultId) {
      const b = document.createElement('span'); b.className = 'tv-badge sgg'; b.textContent = 'VAULT';
      b.title = 'In the team vault' + (t.startggSlug ? ' · start.gg/team/' + t.startggSlug : '') + ' — open the Vault tab to edit the permanent record';
      nameEl.appendChild(b);
    }
    const meta = document.createElement('div'); meta.className = 'tc-card-meta';
    const np = (t.players || []).filter((p) => p && (p.name || '').trim()).length;
    meta.textContent = (t._org ? 'From ' + (t._orgOwner || 'organization') + ' · ' : '') + (np ? np + (np === 1 ? ' player' : ' players') : 'No roster');
    info.append(nameEl, meta);
    body.append(logo, info);

    const footer = document.createElement('div'); footer.className = 'tc-card-footer';
    const favBtn = document.createElement('button'); favBtn.className = 'tc-fav' + (t.favorite ? ' is-fav' : ''); favBtn.title = t.favorite ? 'Unfavorite' : 'Favorite'; favBtn.textContent = '★';
    favBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleTeamFavorite(t); });
    if (t._org) {
      // Org teams are read-only mirrors: you can adopt one into your own library (editing it saves a
      // local copy the next pull won't wipe), but you can't delete another producer's team here.
      const adoptBtn = document.createElement('button'); adoptBtn.className = 'tc-edit'; adoptBtn.title = 'Copy into my teams (makes it editable and yours)'; adoptBtn.textContent = 'Add to mine';
      adoptBtn.addEventListener('click', (e) => { e.stopPropagation(); send('save_team', { oldName: '', name: t.name, color: t.color || '', logo: t.logo || '', players: t.players || [] }); showToast('“' + t.name + '” copied into your teams.', '#22c55e', 2500); });
      footer.append(favBtn, adoptBtn);
    } else {
      const editBtn = document.createElement('button'); editBtn.className = 'tc-edit'; editBtn.title = 'Edit team'; editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); startEditTeam(t); });
      const delBtn = document.createElement('button'); delBtn.className = 'tc-del'; delBtn.title = t.favorite ? 'Favorited — cannot delete' : 'Delete team'; delBtn.textContent = 'Del';
      if (t.favorite) delBtn.disabled = true;
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); if (!t.favorite) deleteTeam(t.name); });
      footer.append(favBtn, editBtn, delBtn);
    }

    card.append(accent, body, footer);
    card.addEventListener('click', () => { if (t._org) return; startEditTeam(t); });
    frag.appendChild(card);
  });
  list.appendChild(frag);
  applyTeamsFilter();
}

// Keyword filter over the saved-teams list (pure show/hide — no re-render). Also honors the
// origin chip (all / mine / org) so the From-organization teams can be shown on their own.
let _teamsOriginFilter = 'all';
function applyTeamsFilter() {
  const list = el('teams-list'); if (!list) return;
  const q = (el('teams-search')?.value || '').trim();
  const items = list.querySelectorAll('.tc-card');
  let orgCount = 0;
  items.forEach((item) => { if (item.dataset.origin === 'org') orgCount++; });
  // data-search carries the team name AND its roster, so a gamertag finds the team it plays for.
  // rankNodes also orders the survivors best-first — with a big library the strongest match used
  // to end up wherever the alphabet left it.
  const { shown } = NESearch.rankNodes(items, q,
    (n) => [{ text: n.dataset.name || '', weight: 2 }, { text: n.dataset.search || '', bag: true }],
    { extra: (n) => {
      const isOrg = n.dataset.origin === 'org';
      return _teamsOriginFilter === 'all' || (_teamsOriginFilter === 'org' ? isOrg : !isOrg);
    } });
  // The origin chips only make sense once org teams exist — keep the row hidden for solo producers.
  const chips = el('teams-origin-chips'); if (chips) chips.style.display = orgCount ? '' : 'none';
  const empty = el('teams-empty');
  if (empty) {
    if (items.length === 0) { empty.textContent = 'No saved teams yet — click “+ New Team” to add one, or import from start.gg.'; empty.style.display = ''; }
    else if (shown === 0) { empty.textContent = q ? 'No teams match your search.' : 'No teams in this view.'; empty.style.display = ''; }
    else { empty.style.display = 'none'; }
  }
}
// Origin chip clicks (delegated; the chip row is injected next to the search box in index.html).
document.getElementById('teams-origin-chips')?.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-teamorigin]'); if (!chip) return;
  _teamsOriginFilter = chip.dataset.teamorigin || 'all';
  document.querySelectorAll('#teams-origin-chips [data-teamorigin]').forEach((c) => c.classList.toggle('active', c === chip));
  applyTeamsFilter();
});
el('teams-search')?.addEventListener('input', applyTeamsFilter);

let _sggTeamsSig = '';
let _sggTeamsFilter = '';
// Filter the Event Teams list by name (show/hide existing rows, so it survives the sig-gated rebuild).
function applySggTeamsFilter() {
  const list = el('startgg-teams-list');
  if (!list) return;
  const q = _sggTeamsFilter.trim();
  const items = list.querySelectorAll('.team-list-item');
  const { shown } = NESearch.rankNodes(items, q, (it) => [it.dataset.name || '']);
  const empty   = el('sgg-teams-empty');
  const nomatch = el('sgg-teams-nomatch');
  const total   = items.length;
  if (empty)   empty.style.display   = total === 0 ? '' : 'none';
  if (nomatch) nomatch.style.display = (total > 0 && shown === 0) ? '' : 'none';
  const countEl = el('sgg-teams-count');
  if (countEl && total) countEl.textContent = (q && shown !== total) ? `(${shown}/${total})` : `(${total})`;
  const clearBtn = el('sgg-teams-search-clear');
  if (clearBtn) clearBtn.style.display = q ? '' : 'none';
}
(function wireSggTeamsSearch() {
  const input = el('sgg-teams-search');
  const clear = el('sgg-teams-search-clear');
  if (input && !input._wired) {
    input._wired = true;
    input.addEventListener('input', () => { _sggTeamsFilter = input.value || ''; applySggTeamsFilter(); });
  }
  if (clear && !clear._wired) {
    clear._wired = true;
    clear.addEventListener('click', () => { _sggTeamsFilter = ''; if (input) input.value = ''; applySggTeamsFilter(); if (input) input.focus(); });
  }
})();
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
      // Send the team's roster (empty included) so a rosterless team clears the previous players.
      send('set_team', { side: 'blue', name: t.name, logo: t.logo || null, color: t.color || undefined, players: t.players || [] });
    });

    const applyOrange = document.createElement('button');
    applyOrange.className = 'btn btn-orange btn-sm';
    applyOrange.textContent = 'Orange';
    applyOrange.title = 'Apply to Orange team on Dashboard';
    applyOrange.addEventListener('click', () => {
      send('set_team', { side: 'orange', name: t.name, logo: t.logo || null, color: t.color || undefined, players: t.players || [] });
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

  // Re-apply the active search filter to the freshly-built rows (and refresh the count/empty states).
  applySggTeamsFilter();
}

let _eventTeamsSig = '';
function renderEventTeamsPanel(data) {
  const list = el('event-teams-list');
  if (!list) return;

  const sggTeams  = (data.startgg?.eventTeams  || []).map(t => ({ ...t, _plat: 'start.gg' }));
  const challTeams = (data.challonge?.eventTeams || []).map(t => ({ ...t, _plat: 'challonge' }));
  const nxgenTeams = (data.nxgen?.eventTeams    || []).map(t => ({ ...t, _plat: 'nxgen' }));
  const faceitTeams = (data.faceit?.eventTeams  || []).map(t => ({ ...t, _plat: 'faceit' }));
  const all = [...sggTeams, ...challTeams, ...nxgenTeams, ...faceitTeams];

  // A card's logo/color prefer the matching Team Library entry (if the producer has edited+saved
  // this event team) over the raw import — editing a team writes to savedTeams only (save_team/
  // save_startgg_team never touch startgg.eventTeams itself), so without this the grid would keep
  // showing the original unedited import forever, and the signature below wouldn't even notice a
  // savedTeams-only change happened.
  const _tn = (s) => (s || '').trim().toLowerCase();
  const savedByName = {};
  (data.savedTeams || []).forEach(s => { if (s && s.name) savedByName[_tn(s.name)] = s; });

  const evName = data.startgg?.selectedEvent?.name || data.startgg?.selectedEvent?.tournamentName || '';
  const sig = evName + '::' + all.map(t => {
    const saved = savedByName[_tn(t.name)];
    return t.name + '|' + (t.logo ? t.logo.length : 0) + '|' + (saved && saved.logo ? saved.logo.length : 0) + '|' + t._plat;
  }).join('~');
  if (sig === _eventTeamsSig) return;
  _eventTeamsSig = sig;

  const tabCount = el('event-tab-count');
  if (tabCount) tabCount.textContent = all.length ? '(' + all.length + ')' : '';
  const srcEl = el('event-teams-source');
  if (srcEl) srcEl.textContent = evName ? 'From: ' + evName : '';

  list.querySelectorAll('.tc-card, .event-teams-empty').forEach(c => c.remove());
  if (!all.length) {
    const msg = document.createElement('p');
    msg.className = 'event-teams-empty';
    msg.style.cssText = 'color:var(--muted); font-size:13px; margin:0; padding:4px 0;';
    msg.textContent = 'No event teams loaded. Import a tournament from the Events tab to populate this list.';
    list.appendChild(msg);
    return;
  }

  const frag = document.createDocumentFragment();
  all.forEach(t => {
    const existingSaved = savedByName[_tn(t.name)];
    const dispLogo = (existingSaved && existingSaved.logo) || t.logo;
    const dispColor = (existingSaved && existingSaved.color) || t.color;

    const card = document.createElement('div');
    card.className = 'tc-card';
    card.dataset.name = t.name || '';
    // Roster included so an entrant's gamertag finds their team in the event list too.
    card.dataset.search = ((t.name || '') + ' ' +
      (t.players || []).map((p) => (typeof p === 'string' ? p : ((p && (p.name || p.gamertag)) || ''))).join(' ')
    ).toLowerCase();
    card.style.setProperty('--team-accent', dispColor || '#3b82f6');

    const accent = document.createElement('div'); accent.className = 'tc-card-accent';
    const body   = document.createElement('div'); body.className   = 'tc-card-body';
    const logo   = document.createElement('img'); logo.className   = 'tc-card-logo'; logo.loading = 'lazy';
    logo.src = dispLogo || teePlaceholder(t.name, dispColor);
    const info   = document.createElement('div'); info.className   = 'tc-card-info';
    const nameEl = document.createElement('div'); nameEl.className = 'tc-card-name'; nameEl.textContent = t.name;
    const meta   = document.createElement('div'); meta.className   = 'tc-card-meta';
    const np = (t.players || []).filter(p => p && (p.name || '').trim()).length;
    meta.textContent = (np ? np + (np === 1 ? ' player' : ' players') : 'No roster') + ' · ' + t._plat;
    info.append(nameEl, meta);
    body.append(logo, info);

    const footer  = document.createElement('div'); footer.className = 'tc-card-footer';

    const editBtn = document.createElement('button');
    editBtn.className = 'tc-edit tc-edit-primary'; editBtn.title = 'Edit players and data'; editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      // Prefer the saved team's own data — a previous edit+save only wrote to savedTeams (never
      // back onto the raw import), so re-loading from `t` here would silently discard it.
      teLoad({
        oldName: existingSaved ? existingSaved.name : null,
        name: t.name,
        logo: dispLogo || null,
        color: dispColor || '#055fdb',
        players: (existingSaved && existingSaved.players && existingSaved.players.length ? existingSaved.players : (t.players || [])).map(p => ({ ...p, photo: p.photo || p.image || '' }))
      });
      openTeamEditor();
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'tc-edit'; saveBtn.title = 'Save to team library (quick)'; saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (t._plat === 'start.gg') {
        send('save_startgg_team', { name: t.name });
      } else {
        // Challonge/NXGEN event-team objects never carry a players field — sending players:[]
        // unconditionally told the server "here's the new roster: empty", wiping out whatever
        // full roster (photos, camera slots, socials) was already saved for this team. Only
        // include players when there's an actual roster to apply; omitting the key lets the
        // server's own "preserve existing roster unless an explicit array was sent" fallback do
        // the right thing (matches how save_startgg_team already handles this).
        const payload = { name: t.name, logo: t.logo || null, color: t.color || '#055fdb' };
        if (t.players && t.players.length) payload.players = t.players;
        send('save_team', payload);
      }
      saveBtn.textContent = 'Saved!';
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 2000);
    });

    footer.append(editBtn, saveBtn);
    card.append(accent, body, footer);
    frag.appendChild(card);
  });
  list.appendChild(frag);
  applyEventTeamsFilter();
}

// Keyword filter over the Event Teams list (pure show/hide — no re-render), mirroring applyTeamsFilter().
function applyEventTeamsFilter() {
  const list = el('event-teams-list'); if (!list) return;
  const q = (el('event-teams-search')?.value || '').trim();
  const items = list.querySelectorAll('.tc-card');
  const { shown } = NESearch.rankNodes(items, q,
    (n) => [{ text: n.dataset.name || '', weight: 2 }, { text: n.dataset.search || '', bag: true }]);
  const nomatch = el('event-teams-nomatch');
  if (nomatch) nomatch.style.display = (items.length > 0 && q && shown === 0) ? '' : 'none';
}
el('event-teams-search')?.addEventListener('input', applyEventTeamsFilter);

el('btn-save-all-event-teams')?.addEventListener('click', () => {
  send('save_startgg_teams_bulk', {});
});
el('btn-clear-event-teams')?.addEventListener('click', async () => {
  if (!(await appConfirm('Remove all event teams from this session?', 'Remove'))) return;
  send('mass_delete_startgg_teams', {});
});

function switchTeamsTab(tab) {
  const savedPanel = el('teams-panel-saved');
  const eventPanel = el('teams-panel-event');
  const vaultPanel = el('teams-panel-vault');
  const savedActions = el('talent-topbar-teams-actions');
  const eventActions = el('talent-topbar-event-actions');
  if (savedPanel) savedPanel.style.display = tab === 'saved' ? '' : 'none';
  if (eventPanel) eventPanel.style.display = tab === 'event'  ? '' : 'none';
  if (vaultPanel) vaultPanel.style.display = tab === 'vault'  ? '' : 'none';
  // Never light up a Teams action group while the Crew page is the one on screen.
  const onTeamsPage = (el('talent-panel-teams')?.style.display !== 'none');
  if (savedActions) savedActions.style.display = (onTeamsPage && tab === 'saved') ? '' : 'none';
  if (eventActions) eventActions.style.display = (onTeamsPage && tab === 'event') ? '' : 'none';
  document.querySelectorAll('#teams-sub-nav .talent-page-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.teamstab === tab);
  });
  if (tab === 'vault') tvFetch();
}

// ── Team Vault ─────────────────────────────────────────────────────────────
// The permanent team database. Deliberately NOT carried in the broadcast state — records hold
// base64 logos and full roster history, and state ships to every overlay on every change — so it
// is fetched over /api/teamdb and re-fetched when state.teamVault.ver bumps.
// Absolute URL: the control panel is a file:// page, so a relative fetch resolves to disk.
const TV_API = 'http://127.0.0.1:3000/api/teamdb';
let _tvTeams = [];
let _tvVer = -1;
let _tvLoading = false;
let _tvDetail = null;   // the record currently open in the detail modal
let _tvPending = 0;     // banked teams the background start.gg sweep still wants to read

// The automatic status line. Driven straight off state (not the /api/teamdb fetch) so a sweep's
// progress ticks live — the record list only re-fetches when the vault's `ver` changes, which
// happens once at the END of a sweep.
function tvRenderAuto(data) {
  const line = el('tv-auto-line'); if (!line) return;
  const v = (data && data.teamVault) || {};
  const dot = el('tv-auto-dot');
  const title = el('tv-auto-title');
  const en = v.enrich || {};

  if (v.enabled === false) {
    if (dot) dot.className = 'tv-auto-dot off';
    if (title) title.textContent = 'Vault off';
    line.textContent = 'Imports behave exactly as they did before — teams are matched by name only, and nothing is banked.';
    return;
  }
  if (en.running) {
    if (dot) dot.className = 'tv-auto-dot busy';
    if (title) title.textContent = 'Reading start.gg team pages…';
    line.textContent = `${en.done || 0} of ${en.total || 0} done. Crests and full rosters are being filled in — you can carry on working.`;
    return;
  }
  if (dot) dot.className = 'tv-auto-dot';
  if (title) title.textContent = 'Teams bank themselves';
  const bits = ['Import an event and every entrant is matched, banked and looked up on start.gg automatically — crest, full roster and alumni.'];
  const lm = v.lastMatch;
  if (lm && lm.total) {
    bits.push(`Last import: ${lm.matched} of ${lm.total} recognised from a previous event`
      + (lm.logosRestored ? `, ${lm.logosRestored} crest${lm.logosRestored === 1 ? '' : 's'} restored from your own branding` : '') + '.');
  }
  if (_tvPending) bits.push(`${_tvPending} team${_tvPending === 1 ? '' : 's'} queued for a start.gg lookup.`);
  else if (en.lastAt) bits.push(`Everything up to date (last checked ${new Date(en.lastAt).toLocaleTimeString()}).`);
  if (v.autoEnrich === false) bits.push('Automatic lookups are off — use Refresh.');
  line.textContent = bits.join(' ');
}

// Read a vault API response WITHOUT assuming it is JSON. Every call here used to do a bare
// `await r.json()`, so an HTML reply — which is what you get when the running app predates the
// route, the commonest case since server.js only reloads on a full app restart — surfaced as the
// unusable "Unexpected token < in JSON at position 0" with no clue which call failed or why.
async function tvJson(r, what) {
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = null; }
  if (data === null) {
    if (r.status === 404) {
      throw new Error('The Team Vault API isn\'t in the running app yet — fully quit and relaunch '
        + 'Broadcast Studio so it picks up the new server.');
    }
    throw new Error((what || 'Request') + ' failed: the server replied with '
      + (r.status || '?') + ' ' + (r.statusText || '') + ' instead of data.');
  }
  if (!r.ok) throw new Error(data.error || data.message || ((what || 'Request') + ' failed (' + r.status + ')'));
  return data;
}

function tvStatus(msg, ok) {
  const e = el('tv-pull-status'); if (!e) return;
  e.textContent = msg || '';
  e.className = 'tv-status' + (ok === true ? ' ok' : ok === false ? ' err' : '');
}

async function tvFetch(force) {
  if (_tvLoading) return;
  const ver = (currentState && currentState.teamVault && currentState.teamVault.ver) || 0;
  if (!force && ver === _tvVer && _tvTeams.length) { tvRender(); return; }
  _tvLoading = true;
  try {
    const r = await fetch(TV_API + '?limit=1000');
    const d = await tvJson(r, 'Loading the vault');
    _tvTeams = d.teams || [];
    _tvVer = ver;
    const st = d.stats || {};
    const line = el('tv-stats');
    if (line) line.textContent = _tvTeams.length
      ? st.teams + ' teams · ' + st.linked + ' linked to start.gg · ' + st.withLogo + ' with a logo · ' + st.active + '/' + st.players + ' players active'
      : '';
    const cfg = d.settings || {};
    if (el('tv-enabled'))    el('tv-enabled').checked    = cfg.enabled !== false;
    if (el('tv-autolink'))   el('tv-autolink').checked   = cfg.autoLink !== false;
    if (el('tv-autoenrich')) el('tv-autoenrich').checked = cfg.autoEnrich !== false;
    _tvPending = d.pending || 0;
    tvRenderAuto(currentState);
  } catch (e) {
    // A TypeError here is a genuine connection failure; anything else already carries a real
    // message from tvJson and must not be relabelled as "can't reach the server".
    tvStatus(e instanceof TypeError ? 'Could not reach the suite on localhost:3000 — is it running?' : e.message, false);
  } finally {
    _tvLoading = false;
  }
  tvRender();
}

function tvRender() {
  const list = el('tv-list'); if (!list) return;
  const q = (el('tv-search')?.value || '').trim().toLowerCase();
  const rows = q
    ? _tvTeams.filter(t =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.aliases || []).some(a => a.includes(q)) ||
        (t.roster || []).some(p => (p.name || '').toLowerCase().includes(q)))
    : _tvTeams;

  const cnt = el('vault-tab-count');
  if (cnt) cnt.textContent = _tvTeams.length ? '(' + _tvTeams.length + ')' : '';
  const empty = el('tv-empty');
  if (empty) {
    empty.style.display = rows.length ? 'none' : '';
    if (!rows.length && _tvTeams.length) empty.textContent = 'No vault teams match your search.';
  }

  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  rows.forEach(t => {
    const active = (t.roster || []).filter(p => p.rosterStatus !== 'inactive').length;
    const total  = (t.roster || []).length;
    const card = document.createElement('div');
    card.className = 'tc-card';
    card.style.setProperty('--team-accent', t.color || '#3b82f6');

    const accent = document.createElement('div'); accent.className = 'tc-card-accent';
    const body   = document.createElement('div'); body.className = 'tc-card-body';
    const logo   = document.createElement('img'); logo.className = 'tc-card-logo'; logo.loading = 'lazy';
    logo.src = t.logo || teePlaceholder(t.name, t.color);
    const info   = document.createElement('div'); info.className = 'tc-card-info';
    const nameEl = document.createElement('div'); nameEl.className = 'tc-card-name';
    nameEl.appendChild(document.createTextNode(t.name || ''));
    // Badges say WHY this record will be found again: a start.gg link is exact, a pin means the
    // producer's branding is protected from the next import.
    if (t.startggTeamId || t.startggSlug) {
      const b = document.createElement('span'); b.className = 'tv-badge sgg';
      b.textContent = 'START.GG'; b.title = 'Linked to start.gg team ' + (t.startggSlug || t.startggTeamId);
      nameEl.appendChild(b);
    }
    if (t.pins && (t.pins.logo || t.pins.name)) {
      const b = document.createElement('span'); b.className = 'tv-badge pin';
      b.textContent = 'PINNED'; b.title = 'Your branding here overrides whatever start.gg sends';
      nameEl.appendChild(b);
    }
    const meta = document.createElement('div'); meta.className = 'tc-card-meta';
    const bits = [total ? (active + '/' + total + ' active') : 'No roster'];
    if ((t.aliases || []).length) bits.push(t.aliases.length + ' past name' + (t.aliases.length === 1 ? '' : 's'));
    if ((t.events  || []).length) bits.push(t.events.length + ' event' + (t.events.length === 1 ? '' : 's'));
    meta.textContent = bits.join(' · ');
    info.append(nameEl, meta);
    body.append(logo, info);

    const footer = document.createElement('div'); footer.className = 'tc-card-footer';
    const editBtn = document.createElement('button');
    editBtn.className = 'tc-edit tc-edit-primary'; editBtn.textContent = 'Open';
    editBtn.addEventListener('click', e => { e.stopPropagation(); tvOpen(t.id); });
    const useBtn = document.createElement('button');
    useBtn.className = 'tc-edit'; useBtn.textContent = 'Use'; useBtn.title = 'Copy into the working team library';
    useBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const prev = useBtn.textContent;
      try {
        await tvJson(await fetch(TV_API + '/' + t.id + '/apply', { method: 'POST' }), 'Sending to the team library');
        useBtn.textContent = 'Added';
      } catch (err) {
        useBtn.textContent = 'Failed';
        tvStatus(err.message, false);   // the button has no room for the reason; the status line does
      }
      setTimeout(() => { useBtn.textContent = prev; }, 1800);
    });
    footer.append(editBtn, useBtn);

    card.append(accent, body, footer);
    card.addEventListener('click', () => tvOpen(t.id));
    frag.appendChild(card);
  });
  list.appendChild(frag);
}

// ── Vault detail modal ─────────────────────────────────────────────────────

function tvDetailStatus(msg, ok) {
  const e = el('tv-detail-status'); if (!e) return;
  e.textContent = msg || '';
  e.style.color = ok === true ? '#22c55e' : ok === false ? '#f56565' : '';
}

async function tvOpen(id) {
  let rec = _tvTeams.find(t => t.id === id);
  if (!rec) return;
  // The list payload deliberately omits brandHistory and startggLogo (base64 blobs across up to
  // 500 cards), so the detail view reads the full record. If that call fails the modal still opens
  // on the list copy — minus the history, which is better than not opening at all.
  try {
    const full = await (await fetch(TV_API + '/' + id)).json();
    if (full && full.team) rec = full.team;
  } catch (_) {}
  _tvDetail = JSON.parse(JSON.stringify(rec));
  // What the record wore when the modal opened, so swapping away from it offers it straight back
  // without waiting for a save round-trip.
  _tvDetail._openLogo = rec.logo || null;
  el('tv-detail-title').textContent = rec.name || 'Team';
  el('tv-detail-name').value  = rec.name || '';
  el('tv-detail-abbr').value  = rec.abbr || '';
  el('tv-detail-color').value = rec.color || '#055fdb';
  el('tv-detail-slug').value  = rec.startggSlug || '';
  const img = el('tv-detail-logo');
  img.src = rec.logo || teePlaceholder(rec.name, rec.color);
  img.classList.remove('game-logo-white');
  const parts = [];
  if (rec.startggTeamId) parts.push('start.gg team #' + rec.startggTeamId);
  // Past names in the casing they actually competed under. `aliases` is the normalised matching
  // key ('clrty esports') and reads as a typo in a UI, so it is only the fallback for records
  // banked before nameHistory existed.
  const pastNames = (rec.nameHistory || []).map(h => h.name).filter(Boolean);
  const shown = pastNames.length ? pastNames : (rec.aliases || []);
  if (shown.length) parts.push('Previously: ' + shown.join(', '));
  el('tv-detail-known').textContent = parts.join(' · ');
  tvDetailStatus('');
  tvRenderBrand();
  tvRenderRoster();
  tvRenderEvents();
  el('tv-detail-modal')?.classList.add('show');
}

function tvCloseDetail() { el('tv-detail-modal')?.classList.remove('show'); _tvDetail = null; }

// Logo history: every crest this team has worn that ISN'T the one showing, plus start.gg's current
// one when it differs. Clicking a tile stages it exactly like Upload/Library do — Save is still
// what commits, and the server banks the crest being replaced.
function tvRenderBrand() {
  const wrap = el('tv-brand-strip'); if (!wrap || !_tvDetail) return;
  wrap.innerHTML = '';
  const cur = _tvDetail.logo || null;
  const tiles = [];

  if (_tvDetail.startggLogo && _tvDetail.startggLogo !== cur) {
    tiles.push({
      logo: _tvDetail.startggLogo, kind: 'sgg', label: 'start.gg',
      sub: _tvDetail.startggLogoAt ? new Date(_tvDetail.startggLogoAt).toLocaleDateString() : 'current crest',
      title: 'The crest start.gg is serving for this team right now — click to use it',
    });
  }
  // A crest staged away from this session is revertable before it has ever reached the server.
  if (_tvDetail._openLogo && _tvDetail._openLogo !== cur &&
      !(_tvDetail.brandHistory || []).some(h => h.logo === _tvDetail._openLogo)) {
    tiles.push({
      logo: _tvDetail._openLogo, kind: 'staged', label: 'Current',
      sub: 'not saved yet', title: 'The crest this team had when you opened it — click to put it back',
    });
  }
  (_tvDetail.brandHistory || []).forEach(h => {
    if (!h.logo || h.logo === cur) return;
    tiles.push({
      logo: h.logo, kind: 'past', forget: h.logo,
      label: h.name || 'Older',
      sub: h.at ? new Date(h.at).toLocaleDateString() : '',
      title: 'Worn as "' + (h.name || 'unknown') + '"' + (h.eventSlug ? ', replaced at ' + h.eventSlug : '') + ' — click to use it again',
    });
  });

  if (!tiles.length) {
    wrap.innerHTML = '<p class="tv-hint" style="margin:0;">Only one crest on record. Past logos appear here as soon as this team rebrands or you replace the image.</p>';
    return;
  }

  tiles.forEach(t => {
    const tile = document.createElement('div');
    tile.className = 'tv-btile' + (t.kind === 'sgg' ? ' is-sgg' : '');

    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'tv-btile-btn'; btn.title = t.title;
    const img = document.createElement('img');
    img.className = 'tv-btile-img'; img.src = t.logo; img.alt = '';
    const lbl = document.createElement('span'); lbl.className = 'tv-btile-lbl'; lbl.textContent = t.label;
    const sub = document.createElement('span'); sub.className = 'tv-btile-sub'; sub.textContent = t.sub || '';
    btn.append(img, lbl, sub);
    btn.addEventListener('click', () => {
      _tvDetail.logo = t.logo;
      const main = el('tv-detail-logo');
      if (main) { main.src = t.logo; main.classList.remove('game-logo-white'); }
      tvRenderBrand();
      tvDetailStatus('Crest staged — Save to pin it against future start.gg imports.', true);
    });
    tile.appendChild(btn);

    if (t.forget) {
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'tv-btile-x'; x.textContent = '\u00d7';
      x.title = 'Forget this crest permanently';
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await appConfirm('Forget this retired crest for ' + _tvDetail.name + '? It cannot be restored.', 'Forget', true))) return;
        try {
          await tvJson(await fetch(TV_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: _tvDetail.id, forgetBrandLogo: t.forget }),
          }), 'Forget');
          _tvDetail.brandHistory = (_tvDetail.brandHistory || []).filter(h => h.logo !== t.forget);
          tvRenderBrand();
        } catch (err) { tvDetailStatus(err.message, false); }
      });
      tile.appendChild(x);
    }
    wrap.appendChild(tile);
  });
}

// Re-read this one team's start.gg page on demand. Reports what it found either way — a silent
// no-op reads as a broken button when the crest is simply already current.
async function tvCheckStartgg() {
  if (!_tvDetail) return;
  const btn = el('tv-detail-checkgg');
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Checking…'; btn.disabled = true; }
  try {
    const r = await tvJson(await fetch(TV_API + '/' + _tvDetail.id + '/refresh-startgg', { method: 'POST' }), 'Check start.gg');
    const staged = _tvDetail.logo;
    const open = _tvDetail._openLogo;
    _tvDetail = JSON.parse(JSON.stringify(r.team || _tvDetail));
    _tvDetail._openLogo = open;
    // A crest the producer staged but hasn't saved outranks whatever came back.
    if (staged && staged !== open) _tvDetail.logo = staged;
    const main = el('tv-detail-logo');
    if (main && _tvDetail.logo) { main.src = _tvDetail.logo; main.classList.remove('game-logo-white'); }
    tvRenderBrand();
    tvRenderRoster();
    tvRenderEvents();
    if (r.logoChanged)            tvDetailStatus('start.gg had a newer crest — applied, and the old one is in the history below.', true);
    else if (r.startggLogoDiffers) tvDetailStatus(r.pinned
      ? 'start.gg is serving a different crest. Yours is pinned, so nothing changed — take it from the start.gg tile if you want it.'
      : 'start.gg is serving a different crest — take it from the tile below.', true);
    else                           tvDetailStatus('Already matching the crest on start.gg.', true);
    await tvFetch(true);
  } catch (e) { tvDetailStatus(e.message, false); }
  if (btn) { btn.textContent = prev; btn.disabled = false; }
}

function tvRenderRoster() {
  const wrap = el('tv-detail-roster'); if (!wrap || !_tvDetail) return;
  wrap.innerHTML = '';
  const roster = _tvDetail.roster || [];
  if (!roster.length) {
    wrap.innerHTML = '<p class="tv-hint" style="margin:0;">No players recorded yet. Pull the team from start.gg, or save it from an event import.</p>';
    return;
  }
  // Active first, then alumni — a producer reads the current line-up far more often than history.
  [...roster].sort((a, b) => (a.rosterStatus === 'inactive') - (b.rosterStatus === 'inactive'))
    .forEach(p => {
      const inactive = p.rosterStatus === 'inactive';
      const row = document.createElement('div');
      row.className = 'tv-prow' + (inactive ? ' is-inactive' : '');

      const name = document.createElement('div'); name.className = 'tv-prow-name';
      name.appendChild(document.createTextNode(p.name || '(unnamed)'));
      const subBits = [];
      if (p.role) subBits.push(p.role);
      if (p.realName) subBits.push(p.realName);
      if (p.lastEvent) subBits.push('last seen ' + String(p.lastEvent).split('/').pop());
      if (subBits.length) {
        const sub = document.createElement('span');
        sub.className = 'tv-prow-sub';
        sub.textContent = '  ' + subBits.join(' · ');
        name.appendChild(sub);
      }

      const actions = document.createElement('div'); actions.className = 'tv-prow-actions';
      const toggle = document.createElement('button');
      toggle.className = 'tv-chip' + (inactive ? '' : ' on');
      toggle.textContent = inactive ? 'Inactive' : 'Active';
      toggle.title = 'Only active players reach the overlays and event imports';
      toggle.addEventListener('click', () => tvSetRoster(p, { rosterStatus: inactive ? 'active' : 'inactive' }));

      const pin = document.createElement('button');
      pin.className = 'tv-chip' + (p.pinned ? ' pinned' : '');
      pin.textContent = 'Pin';
      pin.title = p.pinned
        ? 'Pinned — start.gg imports will not change this status'
        : 'Pin so an import can never flip this player active/inactive';
      pin.addEventListener('click', () => tvSetRoster(p, { pinned: !p.pinned, rosterStatus: p.rosterStatus }));

      const del = document.createElement('button');
      del.className = 'tv-chip danger'; del.textContent = 'Remove';
      del.title = 'Erase this player from the record entirely';
      del.addEventListener('click', async () => {
        const who = p.name || 'this player';
        if (!(await appConfirm('Remove ' + who + ' from ' + _tvDetail.name + '? Their roster history here is lost.', 'Remove', true))) return;
        tvSetRoster(p, { remove: true });
      });

      actions.append(toggle, pin, del);
      row.append(name, actions);
      wrap.appendChild(row);
    });
}

async function tvSetRoster(player, patch) {
  if (!_tvDetail) return;
  try {
    const r = await fetch(TV_API + '/' + _tvDetail.id + '/roster', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: player.id, ...patch })
    });
    const d = await tvJson(r, 'Updating the roster');
    _tvDetail = d.team;
    const i = _tvTeams.findIndex(t => t.id === d.team.id);
    if (i >= 0) _tvTeams[i] = d.team;
    tvRenderRoster();
    tvRender();
  } catch (e) { tvDetailStatus(e.message, false); }
}

function tvRenderEvents() {
  const wrap = el('tv-detail-events'); if (!wrap || !_tvDetail) return;
  const evs = _tvDetail.events || [];
  if (!evs.length) { wrap.innerHTML = '<p class="tv-hint" style="margin:0;">No events recorded yet.</p>'; return; }
  wrap.innerHTML = '';
  evs.forEach(ev => {
    const row = document.createElement('div'); row.className = 'tv-erow';
    const a = document.createElement('span');
    a.textContent = ev.name || String(ev.slug || '').split('/').slice(-1)[0] || ev.slug || '';
    a.title = ev.slug || '';
    const b = document.createElement('span');
    // "Entered as" is the useful bit: it is the evidence for why this record matched at all.
    b.textContent = (ev.enteredAs && ev.enteredAs !== _tvDetail.name ? 'as ' + ev.enteredAs + ' · ' : '')
      + (ev.at ? new Date(ev.at).toLocaleDateString() : '');
    row.append(a, b);
    wrap.appendChild(row);
  });
}

el('tv-detail-close')?.addEventListener('click', tvCloseDetail);
el('tv-detail-modal')?.addEventListener('click', e => { if (e.target.id === 'tv-detail-modal') tvCloseDetail(); });

el('tv-detail-logo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f || !_tvDetail) return;
  _tvDetail.logo = await fileToBase64(f);
  const img = el('tv-detail-logo'); img.src = _tvDetail.logo; img.classList.remove('game-logo-white');
  tvRenderBrand();
  this.value = '';
});
el('tv-detail-checkgg')?.addEventListener('click', tvCheckStartgg);

el('tv-detail-logo-lib')?.addEventListener('click', () => {
  if (typeof mpOpen !== 'function' || !_tvDetail) return;
  mpOpen(url => { _tvDetail.logo = url; const img = el('tv-detail-logo'); img.src = url; img.classList.remove('game-logo-white'); tvRenderBrand(); });
});

el('tv-detail-save')?.addEventListener('click', async () => {
  if (!_tvDetail) return;
  const name = (el('tv-detail-name').value || '').trim();
  if (!name) { tvDetailStatus('Enter a team name.', false); return; }
  try {
    const r = await fetch(TV_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: _tvDetail.id, name,
        abbr: (el('tv-detail-abbr').value || '').trim().toUpperCase().slice(0, 6) || null,
        color: el('tv-detail-color').value || null,
        logo: _tvDetail.logo || null,
        startggSlug: (el('tv-detail-slug').value || '').trim() || null,
      })
    });
    await tvJson(r, 'Save');
    tvDetailStatus('Saved — this branding now wins over start.gg at every future event.', true);
    await tvFetch(true);
    setTimeout(tvCloseDetail, 900);
  } catch (e) { tvDetailStatus(e.message, false); }
});

el('tv-detail-apply')?.addEventListener('click', async () => {
  if (!_tvDetail) return;
  try {
    const r = await fetch(TV_API + '/' + _tvDetail.id + '/apply', { method: 'POST' });
    await tvJson(r, 'Sending to the team library');
    tvDetailStatus('Added to the team library.', true);
  } catch (e) { tvDetailStatus(e.message, false); }
});

el('tv-detail-delete')?.addEventListener('click', async () => {
  if (!_tvDetail) return;
  const msg = 'Delete "' + _tvDetail.name + '" from the vault? Its logo, past names and roster history are lost — teams already in your library are left alone.';
  if (!(await appConfirm(msg, 'Delete', true))) return;
  try {
    const r = await fetch(TV_API + '/' + _tvDetail.id, { method: 'DELETE' });
    await tvJson(r, 'Delete');
    tvCloseDetail();
    tvFetch(true);
  } catch (e) { tvDetailStatus(e.message, false); }
});

// Merge is the escape hatch for when the matching cascade produced two records for one org — most
// likely an ad-hoc entrant that shared too few players to be recognised.
el('tv-detail-merge')?.addEventListener('click', async () => {
  if (!_tvDetail) return;
  const others = _tvTeams.filter(t => t.id !== _tvDetail.id);
  if (!others.length) { tvDetailStatus('Nothing else in the vault to merge in.', false); return; }
  const pick = window.prompt(
    'Fold another team INTO "' + _tvDetail.name + '" — its roster history, past names and start.gg link move across, then it is deleted.\n\nType the team name exactly:\n\n' +
    others.slice(0, 40).map(t => '- ' + t.name).join('\n'));
  if (!pick) return;
  const from = others.find(t => (t.name || '').toLowerCase() === pick.trim().toLowerCase());
  if (!from) { tvDetailStatus('No vault team named "' + pick.trim() + '".', false); return; }
  try {
    const r = await fetch(TV_API + '/merge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into: _tvDetail.id, from: from.id })
    });
    const d = await tvJson(r, 'Merge');
    await tvFetch(true);
    tvOpen(d.team.id);
    tvDetailStatus('Merged "' + from.name + '" in.', true);
  } catch (e) { tvDetailStatus(e.message, false); }
});

// ── Vault toolbar ──────────────────────────────────────────────────────────

el('tv-search')?.addEventListener('input', tvRender);

el('tv-pull')?.addEventListener('click', async () => {
  const slug = (el('tv-slug')?.value || '').trim();
  if (!slug) { tvStatus('Paste a start.gg team URL or slug first.', false); return; }
  const btn = el('tv-pull');
  btn.disabled = true; btn.textContent = 'Pulling…';
  tvStatus('Asking start.gg…');
  try {
    const r = await fetch(TV_API + '/pull-startgg', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, alsoLibrary: true })
    });
    const d = await tvJson(r, 'Pull');
    const x = d.result;
    tvStatus((x.created ? 'Saved' : 'Updated') + ' "' + x.name + '" — ' + x.active + ' current member' + (x.active === 1 ? '' : 's')
      + (x.inactive ? ', ' + x.inactive + ' alumni' : '')
      + (x.logo ? ', crest included' : ', no crest on start.gg — add one below')
      + '. It will be recognised automatically at every future event.', true);
    if (el('tv-slug')) el('tv-slug').value = '';
    await tvFetch(true);
  } catch (e) {
    tvStatus(e.message, false);
  } finally { btn.disabled = false; btn.textContent = 'Pull team'; }
});
el('tv-slug')?.addEventListener('keydown', e => { if (e.key === 'Enter') el('tv-pull')?.click(); });

el('tv-import-library')?.addEventListener('click', async () => {
  const n = ((currentState && currentState.savedTeams) || []).length;
  if (!n) { tvStatus('Your team library is empty.', false); return; }
  const msg = 'Create a vault record for each of your ' + n + ' saved teams? Existing vault entries are matched and updated, not duplicated.';
  if (!(await appConfirm(msg, 'Import'))) return;
  try {
    const r = await fetch(TV_API + '/import-library', { method: 'POST' });
    const d = await tvJson(r, 'Import');
    tvStatus('Imported — ' + d.created + ' new, ' + d.updated + ' matched to an existing record. ' + d.total + ' teams banked.', true);
    await tvFetch(true);
  } catch (e) { tvStatus(e.message, false); }
});

el('tv-delete-all')?.addEventListener('click', async () => {
  const n = _tvTeams.length;
  if (!n) { tvStatus('The vault is already empty.', null); return; }
  const msg = 'Delete all ' + n + ' team' + (n === 1 ? '' : 's') + ' from the vault? Logos, past names and roster history stored here are lost. Teams in your library are left alone.';
  if (!(await appConfirm(msg, 'Delete all', true))) return;
  try {
    const r = await fetch(TV_API, { method: 'DELETE' });
    const d = await tvJson(r, 'Delete all');
    tvStatus('Deleted ' + (d.removed || 0) + ' team' + (d.removed === 1 ? '' : 's') + ' from the vault.', true);
    await tvFetch(true);
  } catch (e) { tvStatus(e.message, false); }
});

el('tv-refresh')?.addEventListener('click', async () => {
  const btn = el('tv-refresh');
  btn.disabled = true; btn.textContent = 'Refreshing…';
  // Nothing queued means everything is inside the weekly re-read window — the producer pressing
  // Refresh anyway wants it read NOW, so force it rather than reporting "0 updated".
  const force = _tvPending === 0;
  tvStatus('Reading start.gg team pages…');
  try {
    const r = await fetch(TV_API + '/enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force })
    });
    const d = await tvJson(r, 'Refresh');
    const x = d.result || {};
    if (x.skipped) tvStatus('Skipped — ' + x.skipped + '.', false);
    else if (!x.total) tvStatus('Nothing to refresh — no banked team is linked to a start.gg team page yet.', null);
    else tvStatus(`Refreshed ${x.updated} of ${x.total} team page${x.total === 1 ? '' : 's'}`
      + (x.logosGained ? `, ${x.logosGained} new crest${x.logosGained === 1 ? '' : 's'}` : '')
      + (x.failed ? `, ${x.failed} failed` : '') + '.', true);
    await tvFetch(true);
  } catch (e) { tvStatus(e.message, false); }
  finally { btn.disabled = false; btn.textContent = 'Refresh from start.gg'; }
});

function tvSaveSettings() {
  fetch(TV_API + '/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: !!el('tv-enabled')?.checked,
      autoLink: !!el('tv-autolink')?.checked,
      autoEnrich: !!el('tv-autoenrich')?.checked
    })
  }).catch(() => {});
}
el('tv-enabled')?.addEventListener('change', tvSaveSettings);
el('tv-autolink')?.addEventListener('change', tvSaveSettings);
el('tv-autoenrich')?.addEventListener('change', tvSaveSettings);
el('teams-sub-nav')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-teamstab]');
  if (btn) switchTeamsTab(btn.dataset.teamstab);
});

el('btn-sort-teams-abc')?.addEventListener('click', () => {
  if (!currentState.savedTeams || currentState.savedTeams.length <= 1) return;
  const sorted = [...currentState.savedTeams].sort((a, b) => a.name.localeCompare(b.name));
  send('update_teams_order', { teams: sorted });
});

// Teams CSV import with COLUMN MAPPING — any layout works: pick which columns are the
// team name, logo URL, colour and players (a delimited column, or "remaining columns").
(function wireTeamsCsvTalent() {
  const inp = el('teams-csv');
  if (!inp) return;
  let _rows = [];
  const DELIM = /\s*[,;|/]\s*/;
  const guess = (headers, re) => { for (let i = 0; i < headers.length; i++) { if (re.test((headers[i] || '').toLowerCase())) return i; } return -1; };
  const opts = (headers, none) => (none != null ? `<option value="-1">${none}</option>` : '') +
    headers.map((h, i) => `<option value="${i}">${(h || ('Column ' + (i + 1))).toString().replace(/</g, '&lt;')}</option>`).join('');
  function headerRow() {
    const useHeader = el('map-header')?.checked !== false;
    return (useHeader && _rows.length) ? _rows[0] : (_rows[0] || []).map((_, i) => 'Column ' + (i + 1));
  }
  function dataRows() { return (el('map-header')?.checked !== false) ? _rows.slice(1) : _rows.slice(); }
  function buildMapping() {
    const headers = headerRow();
    const team = el('map-team'), logo = el('map-logo'), color = el('map-color'), players = el('map-players');
    if (!team) return;
    team.innerHTML = opts(headers); logo.innerHTML = opts(headers, '— none —');
    color.innerHTML = opts(headers, '— none —'); players.innerHTML = opts(headers, 'Remaining columns');
    team.value = Math.max(0, guess(headers, /team|org|squad|entrant|clan|^name$/));
    logo.value = guess(headers, /logo|image|icon|badge|crest/);
    color.value = guess(headers, /colou?r|hex/);
    players.value = guess(headers, /players|roster|members|lineup|line-up/);
    updatePreview();
  }
  function updatePreview() {
    const ti = +(el('map-team')?.value || 0);
    const n = dataRows().filter((r) => (r[ti] || '').trim()).length;
    const p = el('teams-csv-preview'); if (p) p.textContent = n ? `${n} team${n !== 1 ? 's' : ''} detected` : 'No team rows detected';
  }
  inp.addEventListener('change', () => {
    const file = inp.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      _rows = (typeof csvParse === 'function' ? csvParse(evt.target.result || '') : []).filter((r) => r.some((c) => (c || '').toString().trim()));
      inp.value = '';
      const st = el('teams-csv-status');
      if (!_rows.length) { if (st) { st.textContent = 'Empty or unreadable CSV.'; st.style.color = '#f56565'; } return; }
      if (st) st.textContent = '';
      const map = el('teams-csv-map'); if (map) map.style.display = '';
      buildMapping();
    };
    reader.readAsText(file);
  });
  el('map-header')?.addEventListener('change', buildMapping);
  el('map-team')?.addEventListener('change', updatePreview);
  el('teams-csv-import')?.addEventListener('click', () => {
    if (!_rows.length) return;
    const ti = +el('map-team').value, li = +el('map-logo').value, ci = +el('map-color').value, pi = +el('map-players').value;
    let count = 0;
    dataRows().forEach((r) => {
      const name = (r[ti] || '').trim(); if (!name) return;
      const logo = li >= 0 ? (r[li] || '').trim() : '';
      const color = (ci >= 0 && /^#[0-9a-f]{3,8}$/i.test((r[ci] || '').trim())) ? (r[ci] || '').trim() : '';
      let names;
      if (pi >= 0) names = (r[pi] || '').split(DELIM).map((s) => s.trim()).filter(Boolean);
      else names = r.filter((c, idx) => idx !== ti && idx !== li && idx !== ci && (c || '').trim()).map((c) => c.trim());
      const players = names.map((nm) => ({ id: Date.now() + Math.random(), name: nm, role: '', country: '' }));
      send('save_team', { oldName: '', name, color, logo, players, merge: true });
      count++;
    });
    const map = el('teams-csv-map'); if (map) map.style.display = 'none';
    const st = el('teams-csv-status'); if (st) { st.textContent = `✓ Imported ${count} team${count !== 1 ? 's' : ''}`; st.style.color = '#22c55e'; }
    showToast(`Imported ${count} team${count !== 1 ? 's' : ''}`, '#22c55e');
  });
})();

// Teams JSON import — restores logos + full player info from an app Export.
el('teams-json')?.addEventListener('change', function () {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    let data; try { data = JSON.parse(e.target.result); } catch { const st = el('teams-json-status'); if (st) { st.textContent = 'Invalid JSON file.'; st.style.color = '#f56565'; } return; }
    const teams = Array.isArray(data) ? data : (data.teams || []);
    let count = 0;
    teams.forEach((t) => {
      if (!t || !t.name) return;
      const players = (t.players || []).map((p) => (typeof p === 'string'
        ? { id: Date.now() + Math.random(), name: p }
        : { id: p.id || (Date.now() + Math.random()), name: p.name || p.gamerTag || '', role: p.role || '', country: p.country || '', startgg: p.startgg || '', sixmans: p.sixmans || '' })).filter((p) => p.name);
      send('save_team', { oldName: '', name: t.name, color: t.color || '', logo: t.logo || '', favorite: !!t.favorite, players, merge: true });
      count++;
    });
    this.value = '';
    const st = el('teams-json-status'); if (st) { st.textContent = `✓ Imported ${count} team${count !== 1 ? 's' : ''} (with logos)`; st.style.color = '#22c55e'; }
    showToast(`Imported ${count} team${count !== 1 ? 's' : ''}`, '#22c55e');
  };
  reader.readAsText(file);
});

// Teams page sub-tabs: Match (live card + scorecard) vs All Teams (saved library + start.gg).
function teamsShowTab(tab) {
  document.querySelectorAll('#teams-subnav .ev-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.teamtab === tab));
  const match = el('teams-panel-match'), lib = el('teams-panel-library');
  if (match) match.style.display = tab === 'match' ? '' : 'none';
  if (lib) lib.style.display = tab === 'library' ? '' : 'none';
}
document.querySelectorAll('#teams-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', () => teamsShowTab(b.dataset.teamtab)));

function openTeamEditor() {
  if (typeof window._tlOpenEditor === 'function') { window._tlOpenEditor(); return; }
  const m = el('te-editor-modal');
  if (m) m.classList.add('show');
}
function closeTeamEditor() {
  const m = el('te-editor-modal');
  if (m) m.classList.remove('show');
}
el('te-modal-close')?.addEventListener('click', closeTeamEditor);
el('te-editor-modal')?.addEventListener('mousedown', (e) => { if (e.target === el('te-editor-modal')) closeTeamEditor(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el('te-editor-modal')?.classList.contains('show')) closeTeamEditor(); });

function startEditTeam(t) {
  document.querySelector('[data-tab="equipos"]')?.click();
  if (typeof window._ttShow === 'function') window._ttShow('library');
  else if (typeof teamsShowTab === 'function') teamsShowTab('library');
  // Always use freshest data from currentState in case the card closure is stale (e.g. color changed since last render)
  const fresh = (currentState && currentState.savedTeams || []).find(s => s.name === t.name) || t;
  teLoad({ oldName: fresh.name, name: fresh.name, logo: fresh.logo, color: fresh.color, players: fresh.players, favorite: fresh.favorite });
  openTeamEditor();
  el('te-name')?.focus();
}

// delete_team has no cascade server-side (deleting a Team Library entry doesn't touch anything
// that references it by name) — a league roster, Teams to Watch, or Team Spotlight pointing at a
// deleted team just silently freezes on its last-known copy with no indication the link broke.
// Rather than force a cascade (deleting a library entry shouldn't reach into an active league's
// roster mid-season), at least warn the producer what's still pointing at it before they confirm.
function teamReferenceWarning(name) {
  const tn = (s) => (s || '').trim().toLowerCase();
  const target = tn(name);
  const refs = [];
  (currentState.leagues || []).forEach((lg) => {
    if ((lg.teams || []).some((t) => tn(t.teamName) === target)) refs.push(`league "${lg.name || 'Unnamed'}"`);
  });
  if ((currentState.watchlist?.teams || []).some((t) => tn(t.name) === target)) refs.push('Teams to Watch');
  if (tn(currentState.teamSpotlight?.name) === target) refs.push('Team Spotlight');
  if (!refs.length) return '';
  return ` This team is still referenced by ${refs.join(', ')} — deleting it will leave those pointing at a stale, un-updatable copy.`;
}

async function deleteTeam(name) {
  const ok = await customConfirm('Delete Team', `Are you sure you want to delete the team "${name}"?${teamReferenceWarning(name)}`, 'Delete');
  if (ok) send('delete_team', { name });
}

function toggleTeamFavorite(t) {
  const newFav = !t.favorite;
  send('save_team', {
    oldName: t.name, name: t.name,
    logo: t.logo || null, color: t.color || null,
    players: (t.players || []).map((p) => ({ ...p, name: (p.name || '').trim() })).filter((p) => p.name),
    favorite: newFav
  });
  // Optimistically update the local state so the card refreshes immediately.
  const saved = currentState.savedTeams || [];
  const idx = saved.findIndex((s) => s.name === t.name);
  if (idx !== -1) { saved[idx] = { ...saved[idx], favorite: newFav }; _teamsListSig = ''; renderTeamsList(saved); }
}

el('btn-delete-all-teams')?.addEventListener('click', async () => {
  const toDelete = (currentState.savedTeams || []).filter((t) => !t.favorite);
  if (!toDelete.length) { showToast('No non-favorited teams to delete.'); return; }
  const referenced = toDelete.filter((t) => teamReferenceWarning(t.name));
  const refWarning = referenced.length ? ` ${referenced.length} of these are still referenced by a league, Teams to Watch, or Team Spotlight and will leave those pointing at a stale copy.` : '';
  const ok = await customConfirm('Delete All Teams', `Delete ${toDelete.length} non-favorited team${toDelete.length !== 1 ? 's' : ''}? Favorited teams are kept. This cannot be undone.${refWarning}`, 'Delete All');
  if (!ok) return;
  toDelete.forEach((t) => send('delete_team', { name: t.name }));
});

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
    row.appendChild(nm); row.appendChild(role);
    const chips = playerProfileChips(p);
    if (chips) { const c = document.createElement('span'); c.innerHTML = chips; row.appendChild(c.firstChild); }
    row.appendChild(del);
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
    players: tmModel.players.map((p) => ({ ...p, name: (p.name || '').trim(), role: (p.role || '').trim() })).filter((p) => p.name)
  });
  tmModel.oldName = name;
  el('tm-team-select').value = name;
  tmStatus('Saved.', true);
});
el('tm-delete')?.addEventListener('click', async () => {
  if (!tmModel || !tmModel.oldName) { tmShowEditor(false); tmModel = null; return; }
  const ok = await customConfirm('Delete Team', `Delete "${tmModel.oldName}"?${teamReferenceWarning(tmModel.oldName)}`, 'Delete');
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
function hslToHexColor(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.min(100, Math.max(0, s)) / 100;
  l = Math.min(100, Math.max(0, l)) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

// Normalize any pasteable color string to '#rrggbb' (lowercase), or null if unparseable.
// Accepts: #rgb / #rgba / #rrggbb / #rrggbbaa (with or without '#', '0x' prefix ok — alpha is
// dropped); rgb()/hsl() notation with or without the wrapper — bare "205, 92, 92" triplets are
// read as RGB, "0, 53%, 58%" or an hsl prefix as HSL; plus CSS named colors (parsed by Chromium).
function normalizeAnyColor(input) {
  let v = String(input || '').trim();
  if (!v) return null;
  const bare = v.replace(/^0x/i, '');
  if (/^([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(bare)) v = '#' + bare;
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/i.exec(v);
  if (m) return ('#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toLowerCase();
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(v);
  if (m) return ('#' + m[1]).toLowerCase();
  // Number triplets, wrapped or bare, comma/space/slash separated, optional trailing alpha
  // (dropped): "rgb(205, 92, 92)", "205, 92, 92", "hsl 0 53 58", "0, 53%, 58%".
  m = /^(rgba?|hsla?)?[\s:(]*(-?[\d.]+)(%?)[,\s/]+(-?[\d.]+)(%?)[,\s/]+(-?[\d.]+)(%?)(?:[,\s/]+[\d.]+%?)?[\s)]*$/i.exec(v);
  if (m) {
    const kind = (m[1] || '').toLowerCase();
    const n1 = parseFloat(m[2]), n2 = parseFloat(m[4]), n3 = parseFloat(m[6]);
    // No prefix + % on saturation/lightness reads as HSL; a bare all-number triplet is RGB.
    if (kind.startsWith('hsl') || (!kind && (m[5] === '%' || m[7] === '%'))) return hslToHexColor(n1, n2, n3);
    const c1 = m[3] === '%' ? n1 * 2.55 : n1, c2 = m[5] === '%' ? n2 * 2.55 : n2, c3 = m[7] === '%' ? n3 * 2.55 : n3;
    if ([c1, c2, c3].every((n) => n >= 0 && n <= 255)) {
      const h = (n) => Math.round(n).toString(16).padStart(2, '0');
      return '#' + h(c1) + h(c2) + h(c3);
    }
    return null;
  }
  if (typeof CSS === 'undefined' || !CSS.supports('color', v)) return null;
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = v;
  const out = probe.fillStyle; // Chromium serializes to '#rrggbb' or 'rgba(r, g, b, a)'
  if (/^#[0-9a-f]{6}$/i.test(out)) return out.toLowerCase();
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(out);
  if (m) {
    const h = (n) => Number(n).toString(16).padStart(2, '0');
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  }
  return null;
}

// Pair a native color picker with a free-text hex field: picker edits mirror into the text
// field; typing/pasting any color style into the text field updates the picker once it parses.
function wireColorHexPair(pickId, hexId) {
  const pick = el(pickId), hex = el(hexId);
  if (!pick || !hex) return;
  pick.addEventListener('input', () => { hex.value = pick.value; hex.style.borderColor = ''; });
  const apply = () => {
    const norm = normalizeAnyColor(hex.value);
    if (norm) { pick.value = norm; hex.value = norm; hex.style.borderColor = ''; }
    else if (hex.value.trim()) { hex.style.borderColor = '#ef4444'; }
  };
  hex.addEventListener('change', apply);
  hex.addEventListener('paste', () => setTimeout(apply, 0));
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

// ── Battle royale series (Fortnite / PUBG / Warzone) ────────────────────────
// Everything here writes RAW results to the server, which re-derives the standings — the panel
// never computes points itself, so the sheet, the manual grid and any live feed can't disagree.
// Mirrors BR_SCORING_PRESETS in server.js. Epic runs a different elim value per stage — 3 in
// Groups, 4 in Finals — so those ship as separate entries rather than one "FNCS" preset a TO
// then applies to the wrong stage.
const BR_PRESET_LABELS = {
  fncsFinals: 'Fortnite — FNCS Finals (4/elim)',
  fncsGroups: 'Fortnite — FNCS Groups (3/elim)',
  fncsReload: 'Fortnite — Reload path',
  fncs: 'Fortnite (FNCS legacy)', fncsCup: 'Fortnite (Victory Cup)', algs: 'Apex (ALGS)',
  pubg: 'PUBG (Esports)', warzone: 'Warzone (Kill Race)', custom: 'Custom'
};
function brSend(patch) { send('set_br', patch); }
let _brSig = '';
function renderBrPanel(data) {
  const br = (data && data.br) || {};
  const sec = el('games-section-fortnite');
  if (!sec) return;

  const presetSel = el('br-preset');
  if (presetSel && !presetSel.options.length) {
    Object.entries(BR_PRESET_LABELS).forEach(([id, label]) => {
      const o = document.createElement('option'); o.value = id; o.textContent = label; presetSel.appendChild(o);
    });
  }

  // Don't fight the producer's cursor: skip any field they're currently typing in.
  const active = document.activeElement;
  const setVal = (id, v) => { const e = el(id); if (e && e !== active) e.value = v; };
  const setChk = (id, v) => { const e = el(id); if (e && e !== active) e.checked = !!v; };

  setChk('chk-br-enabled', br.enabled);
  setVal('br-title', (br.event && br.event.title) || '');
  setVal('br-split', (br.event && br.event.split) || '');
  setVal('br-round', (br.event && br.event.match) || '');
  setVal('br-matches', (br.format && br.format.matches) || 6);
  setVal('br-preset', br.scoringPreset || 'fncs');
  setVal('br-killpts', (br.scoring && br.scoring.killPoints) != null ? br.scoring.killPoints : 1);
  setVal('br-killcap', (br.scoring && br.scoring.killCap) || 0);
  setVal('br-table', ((br.scoring && br.scoring.placementPoints) || []).join(', '));
  const maps = (data && data.sheets && data.sheets.maps) || {};
  setVal('br-tab-results', (maps.brResults && maps.brResults.tab) || '');
  setVal('br-tab-players', (maps.brPlayers && maps.brPlayers.tab) || '');

  const rows = br.standings || [];
  const played = rows.reduce((m, t) => Math.max(m, ...Object.keys(t.matches || {}).map(Number)), 0);
  const st = el('br-status');
  if (st) {
    st.textContent = rows.length
      ? `${rows.length} team(s) · ${played} match(es) scored · source: ${br.source || 'manual'}`
      : 'No results yet.';
  }

  // Standings preview mirrors the overlay's ordering so the producer can sanity-check before air.
  const sig = JSON.stringify(rows.slice(0, 20));
  if (sig !== _brSig) {
    _brSig = sig;
    const box = el('br-standings-preview');
    if (box) {
      box.innerHTML = rows.length
        ? '<table class="stats-table" style="width:100%;"><thead><tr><th>#</th><th>Team</th><th>Played</th><th>Wins</th><th>Elims</th><th>Points</th></tr></thead><tbody>'
          + rows.slice(0, 20).map((t) => `<tr><td>${t.rank}</td><td class="st-name">${esc(t.name)}</td>`
            + `<td>${t.played}</td><td>${t.wins}</td><td>${t.elims}</td><td class="st-hi">${t.pts}</td></tr>`).join('')
          + '</tbody></table>'
        : '<p class="field-hint" style="margin:0;">Standings appear here as results come in.</p>';
    }
  }
}

el('chk-br-enabled')?.addEventListener('change', function () { brSend({ enabled: this.checked }); });
['br-title', 'br-split', 'br-round'].forEach((id) => {
  el(id)?.addEventListener('change', () => brSend({ event: {
    title: el('br-title')?.value || '', split: el('br-split')?.value || '', match: el('br-round')?.value || '' } }));
});
el('br-matches')?.addEventListener('change', function () { brSend({ format: { matches: parseInt(this.value, 10) || 6 } }); });
el('br-preset')?.addEventListener('change', function () { brSend({ scoringPreset: this.value }); });
el('br-killpts')?.addEventListener('change', function () { brSend({ scoring: { killPoints: parseInt(this.value, 10) || 0 } }); });
el('br-killcap')?.addEventListener('change', function () { brSend({ scoring: { killCap: parseInt(this.value, 10) || 0 } }); });
el('br-table')?.addEventListener('change', function () {
  const nums = this.value.split(/[,\s]+/).map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
  if (nums.length) brSend({ scoring: { placementPoints: nums } });
});

el('btn-br-template')?.addEventListener('click', async () => {
  const teams = (el('br-template-teams')?.value || '').split('\n').map((t) => t.trim()).filter(Boolean);
  const ok = await appConfirm('Build the BR scorekeeping tabs in the connected Google Sheet? Existing content in those tabs is replaced.', 'Build');
  if (!ok) return;
  send('br_sheet_template', {
    matches: parseInt(el('br-matches')?.value, 10) || 6,
    resultsTab: el('br-tab-results')?.value || '',
    playersTab: el('br-tab-players')?.value || '',
    teams
  });
});
el('btn-br-sync')?.addEventListener('click', () => send('sheets_sync', {}));

el('btn-br-add')?.addEventListener('click', () => {
  const team = (el('br-m-team')?.value || '').trim();
  if (!team) { showToast('Enter a team name first.', '#f59e0b'); return; }
  send('set_br_result', {
    match: parseInt(el('br-m-match')?.value, 10) || 1,
    team,
    placement: parseInt(el('br-m-place')?.value, 10) || 0,
    elims: parseInt(el('br-m-elims')?.value, 10) || 0
  });
  // Clear only the per-team fields — match number stays put so a whole lobby can be typed in a run.
  ['br-m-team', 'br-m-place', 'br-m-elims'].forEach((id) => { const e = el(id); if (e) e.value = ''; });
  el('br-m-team')?.focus();
});
el('btn-br-clear-match')?.addEventListener('click', async () => {
  const m = parseInt(el('br-m-match')?.value, 10) || 0;
  if (!m) return;
  if (!(await appConfirm(`Clear every result for match ${m}? The rest of the series is untouched.`, 'Clear match'))) return;
  send('clear_br_results', { scope: 'match', match: m });
});
el('btn-br-clear-all')?.addEventListener('click', async () => {
  if (!(await appConfirm('Reset the whole BR series? Every match result is deleted.', 'Reset series'))) return;
  send('clear_br_results', { scope: 'all' });
});

// ── Event: Event name ─────────────────────────────────────────────────────
el('input-event')?.addEventListener('input', function() {
  send('set_event_name', { name: this.value });
});

// ── Ad-slot sponsor pickers — pull logos from the ACTIVE BRAND's sponsor set ──
// Single source of truth for BOTH the markup and the wiring: sponsor logos are uploaded per client
// in the Brands tab; each Dashboard ad slot just *picks which* brand sponsor fills it (or "Upload
// custom"). Every picker is select+preview+custom-upload-block, so instead of hand-duplicating that
// per card in index.html, each card carries one <div data-ad-picker="<suffix>"></div> placeholder
// and this table generates + mounts the real markup into it (must run before the input/button
// listeners below, which look up elements this creates).
const AD_PICKERS = [
  { pick: 'pick-ot-logo',      suffix: 'ot-logo',      slot: 'overtime',      field: 'logo',      msg: 'set_overtime',      label: 'Overtime' },
  { pick: 'pick-replay-logo',  suffix: 'replay-logo',  slot: 'replay',        field: 'logo',      msg: 'set_replay',        label: 'Goal replay' },
  { pick: 'pick-replay-outro', suffix: 'replay-outro', slot: 'replay',        field: 'outroLogo', msg: 'set_replay',        label: 'After the replay' },
  { pick: 'pick-sbad-logo',    suffix: 'sbad-logo',    slot: 'scoreboardAd',  field: 'logo',      msg: 'set_scoreboard_ad', label: 'Post-game scorecard' },
].map((p) => Object.assign(p, { custom: 'custom-' + p.suffix }));
(function mountAdPickers() {
  AD_PICKERS.forEach((p) => {
    const mount = document.querySelector('[data-ad-picker="' + p.suffix + '"]');
    if (!mount || mount._mounted) return;
    mount._mounted = true;
    mount.innerHTML =
      '<label class="field-label" for="' + p.pick + '">' + p.label + '</label>' +
      '<div style="display:flex; gap:8px; align-items:center;">' +
        '<select id="' + p.pick + '" class="input-select ad-sponsor-pick" style="flex:1; min-width:0;"></select>' +
        '<img id="preview-' + p.suffix + '" alt="" style="height:30px; max-width:90px; object-fit:contain; display:none;">' +
      '</div>' +
      '<div class="ad-custom" id="' + p.custom + '" style="display:none; margin-top:8px;">' +
        '<div style="display:flex; gap:8px; align-items:center;">' +
          '<input type="file" id="input-' + p.suffix + '" accept="image/*" class="input-text" style="padding:6px; flex:1;">' +
          '<button class="btn btn-ghost btn-sm" id="btn-' + p.suffix + '-clear" type="button">Clear</button>' +
        '</div>' +
      '</div>';
  });
})();

// ── Overtime ad slot (sellable sponsor slot) ──────────────────────────────
el('input-ot-label')?.addEventListener('input', function() {
  send('set_overtime', { label: this.value });
});
el('input-ot-bg')?.addEventListener('input', function() {
  send('set_overtime', { bg: this.value });
});
el('input-ot-color')?.addEventListener('input', function() {
  send('set_overtime', { color: this.value });
});
el('input-ot-logo')?.addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_overtime', { logo: b64 });
});
el('btn-ot-logo-clear')?.addEventListener('click', function() {
  const f = el('input-ot-logo'); if (f) f.value = '';
  send('set_overtime', { logo: null });
});

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
  // Scorebar drop-down row: which brand sponsors drop and how often (set in the brand kit editor).
  const ds = el('rls-drop-status');
  if (ds) {
    const b = (data && data.brand) || {};
    const drops = (Array.isArray(b.dropSponsors) ? b.dropSponsors : []).filter((s) => s && s.logo);
    ds.textContent = !data || !data.brand ? 'No brand kit is active'
      : !drops.length ? 'No sponsor has it yet'
      : drops.map((s) => s.name || 'Sponsor').join(', ') + ' · every ' + (b.dropEvery || 120) + 's for ' + (b.dropHold || 12) + 's';
    ds.classList.toggle('is-on', drops.length > 0);
  }
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
el('input-replay-label')?.addEventListener('input', function() {
  send('set_replay', { label: this.value });
});
el('select-replay-color')?.addEventListener('change', function() {
  send('set_replay', { colorMode: this.value });
});
el('select-speed-unit')?.addEventListener('change', function() {
  send('set_speed_unit', { unit: this.value });
});
el('select-date-format')?.addEventListener('change', function() {
  send('set_date_format', { format: this.value });
});
el('input-replay-logo')?.addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_replay', { logo: b64 });
});
el('btn-replay-logo-clear')?.addEventListener('click', function() {
  const f = el('input-replay-logo'); if (f) f.value = '';
  send('set_replay', { logo: null });
});
el('input-replay-outro')?.addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_replay', { outroLogo: b64 });
});
el('btn-replay-outro-clear')?.addEventListener('click', function() {
  const f = el('input-replay-outro'); if (f) f.value = '';
  send('set_replay', { outroLogo: null });
});
el('sel-replay-style')?.addEventListener('change', function () { send('set_replay', { style: this.value }); });
el('input-replay-skin')?.addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_replay', { skin: b64 });
});
el('btn-replay-skin-clear')?.addEventListener('click', function() {
  const f = el('input-replay-skin'); if (f) f.value = '';
  send('set_replay', { skin: null });
});

// ── Scoreboard ad slot (sponsor logo on the end-of-match scorecard) ───────
el('input-sbad-label')?.addEventListener('input', function() {
  send('set_scoreboard_ad', { label: this.value });
});
el('input-sbad-logo')?.addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_scoreboard_ad', { logo: b64 });
});
el('btn-sbad-logo-clear')?.addEventListener('click', function() {
  const f = el('input-sbad-logo'); if (f) f.value = '';
  send('set_scoreboard_ad', { logo: null });
});
el('input-sbad-bg')?.addEventListener('change', async function() {
  const file = this.files && this.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('set_scoreboard_ad', { background: b64 });
});
el('btn-sbad-bg-clear')?.addEventListener('click', function() {
  const f = el('input-sbad-bg'); if (f) f.value = '';
  send('set_scoreboard_ad', { background: null });
});

// ── Event: Team logo file inputs ──────────────────────────────────────────
async function handleLogoInput(side, file) {
  if (!file) return;
  const b64 = await fileToBase64(file);
  if (side === 'blue') pendingLogoBlue = b64; else pendingLogoOrange = b64;
  _logoDirty[side] = true;
  setSideLogo(side, b64);   // sets src AND clears the white-fallback filter
}

// Reset the file input after reading so re-picking the same file refires 'change'.
el('input-logo-blue')?.addEventListener('change', e => { handleLogoInput('blue', e.target.files[0]); e.target.value = ''; });
el('input-logo-orange')?.addEventListener('change', e => { handleLogoInput('orange', e.target.files[0]); e.target.value = ''; });

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
    setAbbrField(side, t.abbr);
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
  // Placeholder: clear the side outright — logo, roster and saved colour all belong to the team
  // that WAS here, and carrying them into "TBD" is what made the placeholder look broken on air.
  if (isTbdName(name)) {
    if (side === 'blue') pendingLogoBlue = null; else pendingLogoOrange = null;
    _logoDirty[side] = false;
    setSideLogo(side, null);
    // Back to the side's default colour too — a placeholder wearing the last team's brand colour
    // is the same stale-identity problem as the logo.
    const defColor = side === 'blue' ? '#055fdb' : '#e97139';
    const colorEl = el(`input-color-${side}`); if (colorEl) colorEl.value = defColor;
    setAbbrField(side, '');
    send('set_team', { side, name, logo: null, players: [], color: defColor, abbr: '' });
    return;
  }
  const t = findTeam(name);
  const pending = side === 'blue' ? pendingLogoBlue : pendingLogoOrange;
  // A crest changed here goes out exactly as set - null included, so Default really clears instead
  // of falling through to the saved crest - and is flagged so the server makes it the team's crest
  // in the library and vault. Untouched, the side keeps reading the saved team's crest as before.
  const dirty = !!_logoDirty[side];
  const logo = dirty ? (pending || null) : (pending || (t && t.logo) || null);
  const payload = { side, name, logo, abbr: abbrField(side) };
  if (dirty) payload.logoChanged = true;
  // Picking a saved/event team makes its roster THE side's roster — even an empty one.
  // (A rosterless team like JONZEY must clear the previous team's players, not inherit them.)
  if (t) payload.players = Array.isArray(t.players) ? t.players : [];
  if (t && t.color) payload.color = t.color;   // carry the saved team's own colour → Team colour-mode
  send('set_team', payload);
  _logoDirty[side] = false;
}

el('btn-apply-blue')?.addEventListener('click', () => applyTeam('blue'));
el('btn-apply-orange')?.addEventListener('click', () => applyTeam('orange'));

['blue', 'orange'].forEach(side => {
  const c = el(`input-color-${side}`);
  if (c) c.addEventListener('input', function() { send('set_team_color', { side, color: this.value }); });
});

// ── Team abbreviation (Match ▸ Teams) ────────────────────────────────────────
// The short tag every overlay prints where a full name won't fit (RL Worlds series board,
// matchup crest, countdown/replay-desk name pair, Pulse/GRID tiles). Blank = the library/vault tag
// for that team, else initials — so "AUTO" is the placeholder, not a value. Typing one applies on
// change (no Apply click), the same way the colour picker does, and Save banks it to the library.
function cleanAbbr(v) { return String(v || '').replace(/[^\p{L}\p{N}|&.-]/gu, '').toUpperCase().slice(0, 6); }
function abbrField(side) { const e = el(`input-abbr-${side}`); return e ? cleanAbbr(e.value) : ''; }
function setAbbrField(side, v) { const e = el(`input-abbr-${side}`); if (e && document.activeElement !== e) e.value = cleanAbbr(v); }
['blue', 'orange'].forEach(side => {
  const a = el(`input-abbr-${side}`);
  if (!a) return;
  a.addEventListener('input', function () { const c = cleanAbbr(this.value); if (this.value !== c) this.value = c; });
  a.addEventListener('change', function () { send('set_team_abbr', { side, abbr: cleanAbbr(this.value) }); });
  a.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); a.blur(); } });
});

['blue', 'orange'].forEach(side => {
  el(`input-name-${side}`).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTeam(side);
  });
  // Typeahead: update the saved badge and, when the typed name matches a saved team,
  // auto-load that team's logo so picking from the autocomplete fills the card.
  el(`input-name-${side}`).addEventListener('input', function () {
    updateTeamSavedBadge(side);
    // TBD has no library entry to match — apply it directly (same as an exact team match) so
    // picking it from the dropdown clears the side immediately, no Apply click needed.
    if (isTbdName(this.value)) { applyTeam(side); return; }
    const t = findTeam(this.value);
    if (t) {
      setAbbrField(side, t.abbr);
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

  // TBD rides at the top of the list as a synthetic entry so the placeholder is always one click
  // away — it's deliberately NOT in the team library, so a plain filter would show "no matches"
  // and leave the producer thinking the name isn't allowed.
  const TBD_ITEM = { name: 'TBD', logo: null, color: null, players: [], source: 'tbd' };
  const filtered = (q) => {
    q = (q || '').trim();
    // Ranked, and capped only AFTER ranking — the old unranked slice(0,60) could cut off the exact
    // team being typed whenever it sat past the 60th row of the library. Rosters are searchable
    // too, so a gamertag off the entrant list finds the team it belongs to.
    const out = NESearch.filter(allMatchTeams(), q, (t) => [
      { text: t.name, weight: 2 },
      { text: (t.players || []).map((p) => (typeof p === 'string' ? p : ((p && (p.name || p.gamertag)) || ''))).join(' '), bag: true }
    ], { limit: 60 }).slice(0, 60);
    const lq = q.toLowerCase();
    if (!lq || 'tbd'.startsWith(lq) || 'tba'.startsWith(lq)) out.unshift(TBD_ITEM);
    return out;
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
      const tag = t.source === 'event' ? '<span class="team-dd-tag">EVENT</span>'
        : t.source === 'tbd' ? '<span class="team-dd-tag">PLACEHOLDER</span>' : '';
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
  // What the producer actually TYPED, kept apart from input.value. Arrow keys preview the
  // highlighted team into the field (that's what lets the existing Enter handler apply it), which
  // used to overwrite the query — so arrowing down once re-filtered the list to that one team and
  // arrowing back up was impossible. The list is now always filtered by `typed`.
  let typed = '';
  const refresh = () => { typed = input.value; items = filtered(typed); active = -1; render(); };
  const preview = () => { if (items[active]) input.value = (items[active].name || '').toUpperCase(); render(); };

  input.addEventListener('focus', refresh);
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (!open && e.key === 'ArrowDown') { refresh(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); preview(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); preview(); }
    else if (e.key === 'Enter') { close(); }            // value already set; existing Enter handler applies it
    // Escape puts the query back, so a stray arrow key doesn't leave the field holding a team the
    // producer never picked.
    else if (e.key === 'Escape') { input.value = typed; close(); }
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
el('btn-quick-save-blue')?.addEventListener('click', () => {
  // Store the name as typed (don't force upper-case) — overlays upper-case at render, and the server
  // matches the library case-insensitively, so this keeps a picked "Team Alpha" from duplicating.
  const name = el('input-name-blue').value.trim();
  if (!name) { showToast('Enter team name.', '#ef4444'); return; }
  if (isTbdName(name)) { showToast('TBD is a placeholder — nothing to save.', '#fbbf24'); return; }
  const payload = { name, color: teamOwnColor('blue') };
  // A typed abbreviation is banked with the team; blank never clears the library's own tag.
  const abbrBlue = abbrField('blue');
  if (abbrBlue) payload.abbr = abbrBlue;
  // Changed here: send it as set (null = the producer hit Default) and say so. Untouched: send the
  // crest on show, or nothing when there is none - a bare side used to wipe the saved crest.
  if (_logoDirty.blue) { payload.logo = pendingLogoBlue || null; payload.logoChanged = true; }
  else if (pendingLogoBlue) payload.logo = pendingLogoBlue;
  send('save_team', payload);
  _logoDirty.blue = false;
});

el('btn-quick-save-orange')?.addEventListener('click', () => {
  const name = el('input-name-orange').value.trim();
  if (!name) { showToast('Enter team name.', '#ef4444'); return; }
  if (isTbdName(name)) { showToast('TBD is a placeholder — nothing to save.', '#fbbf24'); return; }
  const payload = { name, color: teamOwnColor('orange') };
  // A typed abbreviation is banked with the team; blank never clears the library's own tag.
  const abbrOrange = abbrField('orange');
  if (abbrOrange) payload.abbr = abbrOrange;
  // Changed here: send it as set (null = the producer hit Default) and say so. Untouched: send the
  // crest on show, or nothing when there is none - a bare side used to wipe the saved crest.
  if (_logoDirty.orange) { payload.logo = pendingLogoOrange || null; payload.logoChanged = true; }
  else if (pendingLogoOrange) payload.logo = pendingLogoOrange;
  send('save_team', payload);
  _logoDirty.orange = false;
});

// ── Scorecard (reusable: rendered below Match-Teams on Dashboard + on Teams tab)
function scorecardHTML(sfx) {
  const bo = [1, 3, 5, 7].map((v) => `<label class="bo-opt"><input type="radio" name="bestof-${sfx}" value="${v}">${v}</label>`).join('');
  return `
  <div class="sc-live-tags" title="What's currently showing on the overlay">
    <span class="sc-live-tag-val" id="sc-live-status-${sfx}">—</span>
  </div>
  <div class="sc-teams-score">
    <div class="sc-side-col">
      <span class="sc-team-name" id="series-label-blue-${sfx}">A</span>
      <span class="series-value sc-big-score" id="val-series-blue-${sfx}">0</span>
      <div class="sc-score-btns">
        <button class="btn-counter" data-sc="series" data-side="blue" data-delta="-1">−</button>
        <button class="btn-counter" data-sc="series" data-side="blue" data-delta="1">+</button>
      </div>
    </div>
    <div class="sc-divider">VS</div>
    <div class="sc-side-col">
      <span class="sc-team-name" id="series-label-orange-${sfx}">B</span>
      <span class="series-value sc-big-score" id="val-series-orange-${sfx}">0</span>
      <div class="sc-score-btns">
        <button class="btn-counter" data-sc="series" data-side="orange" data-delta="-1">−</button>
        <button class="btn-counter" data-sc="series" data-side="orange" data-delta="1">+</button>
      </div>
    </div>
  </div>
  <div class="sc-bottom">
    <div class="sc-bottom-row">
      <span class="series-label">Best of</span>
      <div class="best-of-options">${bo}</div>
    </div>
    <!-- Overwatch only: how the scoreboard's centre pill words the format — FT3 (first to 3 wins)
         or BO5 (best of 5 maps). Classes, not ids: this card renders twice. -->
    <div class="sc-bottom-row sc-ow-label" style="display:none;">
      <span class="series-label">Label</span>
      <div class="pb-seg sc-ow-label-seg">
        <button type="button" data-sc="ow-label" data-v="ft">FT3</button>
        <button type="button" data-sc="ow-label" data-v="bo">BO5</button>
      </div>
    </div>
    <!-- Live match controls, ABOVE the game counter: these are the two things a producer reaches
         for mid-game, so they sit nearer the score than the Best-of / Game config rows do.
         Classes, not ids — the scorecard renders TWICE (Dashboard + Teams tab), so an id would
         collide. The whole row is hidden unless the active game is Rocket League, since both
         actions are Rocket League Stats API calls. -->
    <div class="sc-bottom-row sc-live-ctl" style="display:none;">
      <button class="btn btn-secondary btn-sm js-rl-pause" data-sc="pause" type="button">Pause match</button>
      <button class="btn btn-ghost btn-sm js-rl-clear-board" data-sc="clear-board" type="button">Clear scoreboard</button>
    </div>
    <div class="sc-bottom-row">
      <span class="series-label">Game</span>
      <div class="series-counter">
        <button class="btn-counter btn-counter-sm" data-sc="game" data-delta="-1">−</button>
        <span class="series-value sc-game-val" id="val-game-number-${sfx}">1</span>
        <button class="btn-counter btn-counter-sm" data-sc="game" data-delta="1">+</button>
      </div>
    </div>
    <button class="btn btn-ghost btn-sm" data-sc="reset" type="button">Reset series</button>
  </div>
  <p class="sc-note">Adding a series win auto-advances the current game.</p>`;
}
function wireScorecard(containerId, sfx) {
  const c = el(containerId); if (!c) return;
  c.innerHTML = scorecardHTML(sfx);
  c.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sc]'); if (!b) return;
    const kind = b.dataset.sc;
    if (kind === 'series') send('adjust_series', { side: b.dataset.side, delta: parseInt(b.dataset.delta, 10) });
    else if (kind === 'game') send('adjust_game_number', { delta: parseInt(b.dataset.delta, 10) });
    else if (kind === 'reset') confirmResetSeries();
    else if (kind === 'ow-label') send('ow_set_series_label', { label: b.dataset.v === 'bo' ? 'bo' : 'ft' });
    // Toggle off the button's OWN state so a double-click can't desync; the incoming
    // MatchPaused/Unpaused event snaps every copy of the button back to the truth.
    else if (kind === 'pause') send('set_rl_paused', { paused: b.dataset.paused !== '1' });
    // Destructive: it wipes the on-air board. Same confirm the old Settings-strip button had —
    // moving it next to the score puts it within easy reach of a mis-click mid-game.
    else if (kind === 'clear-board') {
      appConfirm('Clear the on-air scoreboard now? Team names, scores and series reset on the overlay immediately.', 'Clear scoreboard')
        .then((ok) => { if (ok) send('clear_scoreboard', {}); });
    }
    else if (kind === 'label-upcoming') {
      const inp = c.querySelector(`#input-game-label-${sfx}`);
      if (inp) inp.value = 'UPCOMING MATCH';
      send('set_game_label', { text: 'UPCOMING MATCH' });
    }
    else if (kind === 'label-auto') {
      const inp = c.querySelector(`#input-game-label-${sfx}`);
      if (inp) inp.value = '';
      send('set_game_label', { text: '' });
    }
    else if (kind === 'round-startgg') {
      send('use_startgg_round');   // server fills roundLabel from the active start.gg set
    }
    else if (kind === 'round-clear') {
      const inp = c.querySelector(`#input-round-label-${sfx}`);
      if (inp) inp.value = '';
      send('set_round_label', { text: '' });
    }
  });
  c.addEventListener('change', (e) => {
    if (e.target.name === `bestof-${sfx}` && e.target.checked) send('set_best_of', { value: parseInt(e.target.value, 10) });
  });
  c.addEventListener('input', (e) => {
    if (e.target.id === `input-game-label-${sfx}`) send('set_game_label', { text: e.target.value });
    if (e.target.id === `input-round-label-${sfx}`) send('set_round_label', { text: e.target.value });
  });
}
wireScorecard('scorecard-dash', 'dash');
wireScorecard('scorecard-teams', 'teams');

// Wire the Match-Teams settings panel (collapsible from the gear button in the panel header).
// Handles Match Label and Round/Stage inputs that live outside scorecard-dash.
;(function wireMtSettingsPanel() {
  const btn = el('btn-match-settings');
  const panel = el('match-settings-panel');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'grid';
    btn.classList.toggle('active', !open);
    if (!open && typeof renderPlayerCamMounts === 'function') renderPlayerCamMounts();
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-msp]'); if (!b) return;
    const kind = b.dataset.msp;
    if (kind === 'label-auto') {
      const inp = el('input-game-label-dash'); if (inp) inp.value = '';
      send('set_game_label', { text: '' });
    } else if (kind === 'label-upcoming') {
      const inp = el('input-game-label-dash'); if (inp) inp.value = 'UPCOMING MATCH';
      send('set_game_label', { text: 'UPCOMING MATCH' });
    } else if (kind === 'round-startgg') {
      send('use_startgg_round');
    } else if (kind === 'round-clear') {
      const inp = el('input-round-label-dash'); if (inp) inp.value = '';
      send('set_round_label', { text: '' });
    }
  });
  panel.addEventListener('input', (e) => {
    if (e.target.id === 'input-game-label-dash') send('set_game_label', { text: e.target.value });
    if (e.target.id === 'input-round-label-dash') send('set_round_label', { text: e.target.value });
  });
  panel.addEventListener('change', (e) => {
    if (e.target.id === 'chk-team-record') send('set_team_record_settings', { enabled: e.target.checked });
    if (e.target.id === 'chk-team-seed') send('set_team_record_settings', { showSeed: e.target.checked });
    if (e.target.id === 'sel-team-record-metric') send('set_team_record_settings', { metric: e.target.value });
    if (e.target.id === 'sel-team-record-league') send('set_team_record_settings', { leagueId: e.target.value });
    if (e.target.id === 'sel-team-record-week') send('set_team_record_settings', { week: e.target.value });
  });
  el('btn-pull-league')?.addEventListener('click', () => pullStartggLeagueStandings('input-league-slug', 'league-pull-status'));
})();

// Green "connected & working" outline on the Match-settings auto controls so producers know they'll do
// something: "From Platform" (Round/Stage) lights up when a tournament platform is loaded (it'll pull
// the live round); "Auto" (Match Label) lights up when the label is blank (the overlay is auto-computing
// BEST OF X · GAME X). Driven from state on every broadcast.
function updateMspConnectedState(data) {
  const plat = data && data.activeEvent && data.activeEvent.platform;
  const platName = plat === 'startgg' ? 'start.gg' : plat === 'challonge' ? 'Challonge' : plat === 'nxgen' ? 'NXGEN' : plat === 'faceit' ? 'FACEIT' : plat;
  document.querySelectorAll('[data-msp="round-startgg"]').forEach((b) => {
    b.classList.toggle('msp-connected', !!plat);
    b.title = plat
      ? `Connected to ${platName} — pull the live round/stage`
      : 'Load a tournament (Events ▸ platform) to pull the round automatically';
  });
  const labelAuto = !((data && data.gameLabel) || '').trim();
  document.querySelectorAll('[data-msp="label-auto"]').forEach((b) => {
    b.classList.toggle('msp-connected', labelAuto);
    b.title = labelAuto ? 'Auto-filling the label (BEST OF X · GAME X) — active' : 'Reset the label to auto (BEST OF X · GAME X)';
  });
}

// Shared start.gg League standings pull — used by both the Dashboard match gear popover and the
// Rocket League section in Integrations (mirrored controls, suffixed -int).
async function pullStartggLeagueStandings(slugId, statusId) {
  const slug = (el(slugId)?.value || '').trim();
  const status = el(statusId);
  if (!slug) { if (status) status.textContent = 'Enter a start.gg league URL or slug first.'; return; }
  if (status) status.textContent = 'Pulling standings…';
  try {
    const r = await fetch('http://127.0.0.1:3000/api/startgg/league-standings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    if (status) status.textContent = `Pulled ${d.count} teams${d.name ? ' from ' + d.name : ''}.`;
  } catch (err) {
    if (status) status.textContent = friendlyError(err);
  }
}

// Team Record source (Tournament / In-app stats / Manual) — segmented control in the gear popover.
document.querySelectorAll('#tr-source-seg .seg-btn').forEach((b) => {
  b.addEventListener('click', () => send('set_team_record_settings', { source: b.dataset.src }));
});
// Per-team record inputs (W-L + optional points) in the Match — Teams team boxes.
// Source-aware: Manual writes to state.teamRecord.manualByName (keyed by the team on that side, so it
// stays tied to the team profile); In-app writes back to the linked league.
['blue', 'orange'].forEach((side) => {
  const push = () => {
    const w = el('tr-w-' + side)?.value, l = el('tr-l-' + side)?.value, pts = el('tr-pts-' + side)?.value;
    const tr = currentState.teamRecord || {};
    const source = tr.source || 'stats';
    if (source === 'stats' && tr.leagueId) {
      const teamName = (currentState.teams && currentState.teams[side] && currentState.teams[side].name) || '';
      if (!teamName) return;
      send('set_league_team_record', { leagueId: tr.leagueId, teamName, w, l, pts });
    } else {
      send('set_team_record_manual', { side, w, l, pts });
    }
  };
  ['tr-w-', 'tr-l-', 'tr-pts-'].forEach((p) => el(p + side)?.addEventListener('change', push));
});
// Auto team names from the live game (match saved library → logos/colours).
el('chk-auto-teams-game')?.addEventListener('change', (e) => send('set_auto_teams_from_game', { enabled: e.target.checked }));

let _autoLeaguePullSlug = '';
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
    const glEl = el(`input-game-label-${sfx}`);
    if (glEl && document.activeElement !== glEl) glEl.value = data.gameLabel || '';
    const rlEl = el(`input-round-label-${sfx}`);
    if (rlEl && document.activeElement !== rlEl) rlEl.value = data.roundLabel || '';
    // What's actually live on the overlay right now, combined the same way rl-hud.html shows it:
    // ROUND / STAGE | GAME n OF X — a blank Match Label auto-shows "GAME n OF X" there, not nothing.
    const liveStatus = el(`sc-live-status-${sfx}`);
    if (liveStatus) {
      const round = (data.roundLabel || '').trim().toUpperCase();
      const gameLine = (data.gameLabel || '').trim() ? data.gameLabel.trim().toUpperCase() : `GAME ${data.game?.number ?? 1} OF ${bo}`;
      liveStatus.textContent = round ? `${round} | ${gameLine}` : gameLine;
    }
  });
  updateMspConnectedState(data);
  const atg = el('chk-auto-teams-game'); if (atg && document.activeElement !== atg) atg.checked = !!data.autoTeamsFromGame;
  const tr = data.teamRecord || {};
  const ls = data.startggLeagueStandings || {};
  const trSource = tr.source || 'stats';
  const chk = el('chk-team-record'); if (chk && document.activeElement !== chk) chk.checked = !!tr.enabled;
  const chkSeed = el('chk-team-seed'); if (chkSeed && document.activeElement !== chkSeed) chkSeed.checked = !!tr.showSeed;
  const selM = el('sel-team-record-metric'); if (selM && document.activeElement !== selM) selM.value = tr.metric || 'season';
  document.querySelectorAll('#tr-source-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.src === trSource));
  const slugIn = el('input-league-slug');
  if (slugIn && document.activeElement !== slugIn && !slugIn.value) slugIn.value = ls.slug || '';
  const status = el('league-pull-status');
  if (status && !status.textContent) {
    if (ls.lastError) status.textContent = 'Error: ' + ls.lastError;
    else if (Array.isArray(ls.teams) && ls.teams.length) status.textContent = `${ls.teams.length} teams loaded${ls.name ? ' from ' + ls.name : ''}.`;
  }
  // "Tournament" source promises to auto-pull from the platform — don't make the producer paste
  // a league URL by hand when one's already loaded via the Events panel. Prefill from the active
  // event and auto-run the pull once per distinct event (re-fires if a different event loads).
  if (trSource === 'startgg') {
    const ae = data.activeEvent || {};
    const wantSlug = (ae.platform === 'startgg' && (ae.url || ae.slug)) ? (ae.url || ae.slug) : '';
    if (wantSlug && slugIn && document.activeElement !== slugIn) {
      if (!slugIn.value) slugIn.value = wantSlug;
      if (_autoLeaguePullSlug !== wantSlug) {
        _autoLeaguePullSlug = wantSlug;
        pullStartggLeagueStandings('input-league-slug', 'league-pull-status');
      }
    }
  }
  // Source-dependent sections: in-app league box for In-app, start.gg box for Tournament, hint for Manual.
  const statsBox = el('tr-stats-box'); if (statsBox) statsBox.style.display = trSource === 'stats' ? '' : 'none';
  const sggBox = el('tr-startgg-box'); if (sggBox) sggBox.style.display = trSource === 'startgg' ? '' : 'none';
  const manHint = el('tr-manual-hint'); if (manHint) manHint.style.display = trSource === 'manual' ? '' : 'none';
  const statsHint = el('tr-stats-hint'); if (statsHint) statsHint.style.display = (trSource === 'stats' && tr.leagueId) ? '' : 'none';
  // In-app league dropdown — keep options in sync with the leagues, reflect the chosen id.
  if (typeof lgPopulateLeagueSelect === 'function') {
    lgPopulateLeagueSelect(el('sel-team-record-league'), data.leagues || [], { placeholder: 'Auto (best match)', value: tr.leagueId || '' });
  }
  // "This week" source week — options come from the chosen league's own schedule weeks (same
  // pattern as Graphics ▸ Schedule's week filter, gfxFillScheduleWeeks).
  const wkSel = el('sel-team-record-week');
  if (wkSel && document.activeElement !== wkSel) {
    const lgForWeek = (data.leagues || []).find((l) => String(l.id) === String(tr.leagueId || '')) ||
      (!tr.leagueId ? (data.leagues || []).find((l) => l.game === data.activeGame) : null);
    const weeks = [...new Set(((lgForWeek && lgForWeek.schedule) || []).map((m) => String(m.week || '')).filter(Boolean))]
      .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
    const sig = weeks.join('|');
    if (wkSel.dataset.sig !== sig) {
      wkSel.dataset.sig = sig;
      wkSel.innerHTML = '<option value="">Auto (latest completed week)</option>' + weeks.map((w) => `<option value="${w}">Week ${w}</option>`).join('');
    }
    wkSel.value = (tr.week && weeks.includes(tr.week)) ? tr.week : '';
  }
  // Per-team record rows — shown when Team Record is on AND (Manual, or In-app with a linked league).
  // Both prefill from the resolved per-side records (teamRecords.rawBlue/rawOrange) — manual is keyed
  // by team name server-side, so the box always shows the record for the team now on that side.
  const tRec = data.teamRecords || {};
  const editable = tr.enabled && (trSource === 'manual' || (trSource === 'stats' && tr.leagueId));
  ['blue', 'orange'].forEach((side) => {
    const row = el('team-record-row-' + side);
    if (row) row.style.display = editable ? '' : 'none';
    // Both manual (keyed by team name) and in-app-league records resolve per side into rawBlue/rawOrange,
    // so the box shows the record for whichever team is currently on that side.
    const src = side === 'blue' ? (tRec.rawBlue || {}) : (tRec.rawOrange || {});
    const setv = (id, v) => { const e = el(id); if (e && document.activeElement !== e) e.value = (v == null ? '' : v); };
    setv('tr-w-' + side, src.w); setv('tr-l-' + side, src.l); setv('tr-pts-' + side, src.pts);
  });
}


// ── Caster Desk: Best-of ──────────────────────────────────────────────────
document.querySelectorAll('input[name="bestof-desk"]').forEach(r => {
  r.addEventListener('change', function() {
    if (this.checked) send('set_best_of', { value: parseInt(this.value, 10) });
  });
});

// ── Event: View controls ──────────────────────────────────────────────────
el('btn-force-scoreboard')?.addEventListener('click', () => send('force_scoreboard'));
el('btn-force-hud')?.addEventListener('click',        () => send('force_hud'));

el('btn-swap-teams')?.addEventListener('click', () => {
  // Optimistic swap of the visible top-level fields → instant feedback (server confirms).
  const swapVal = (a, b) => { const ea = el(a), eb = el(b); if (ea && eb) { const t = ea.value; ea.value = eb.value; eb.value = t; } };
  swapVal('input-name-blue', 'input-name-orange');
  swapVal('input-abbr-blue', 'input-abbr-orange');
  swapVal('input-color-blue', 'input-color-orange');
  const lb = el('preview-logo-blue'), lo = el('preview-logo-orange');
  if (lb && lo) {
    const ts = lb.src; lb.src = lo.src; lo.src = ts;
    // Swap the white-fallback filter too, else a real logo can render white after a swap.
    const bw = lb.classList.contains('game-logo-white');
    lb.classList.toggle('game-logo-white', lo.classList.contains('game-logo-white'));
    lo.classList.toggle('game-logo-white', bw);
  }
  const pl = pendingLogoBlue; pendingLogoBlue = pendingLogoOrange; pendingLogoOrange = pl;
  _logoDirty = { blue: _logoDirty.orange, orange: _logoDirty.blue };
  send('swap_teams');
});

el('btn-reset-all')?.addEventListener('click', async () => {
  const ok = await customConfirm('Reset Data', 'Are you sure you want to reset ALL match data? This cannot be undone.', 'Reset All');
  if (ok) {
    send('reset_all');
  }
});

el('btn-default-logo-blue')?.addEventListener('click', () => {
  pendingLogoBlue = null;
  _logoDirty.blue = true;
  setSideLogo('blue', null);
});

el('btn-default-logo-orange')?.addEventListener('click', () => {
  pendingLogoOrange = null;
  _logoDirty.orange = true;
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
              : mode === 'default' ? 'Team colour (overlay using game defaults — see swatch →)'
              : mode === 'game' ? 'Team colour (overlay using the live in-game paint colours — see swatch →)' : '';
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
  if (mode !== 'team' && mode !== 'brand' && mode !== 'default' && mode !== 'game') return;
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
  syncTeamsAlign();
}
function syncMasterPlayersToggle() {
  const cb = el('check-show-players'); if (!cb) return;
  cb.checked = ['blue', 'orange'].some((s) => { const w = el('team-players-' + s); return w && w.style.display !== 'none'; });
}
// Center the Blue/Orange columns against the scorecard when no player rows are showing;
// top-align them (with the scorecard) once players are shown. Scorecard height stays fixed.
function syncTeamsAlign() {
  const grid = document.querySelector('#match-teams-section .teams-grid'); if (!grid) return;
  const anyShown = ['blue', 'orange'].some((s) => { const w = el('team-players-' + s); return w && w.style.display !== 'none' && w.children.length > 0; });
  grid.classList.toggle('teams-centered', !anyShown);
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
try { applyMtCollapsed(false); localStorage.removeItem('ne_mt_collapsed'); } catch {}   // minimize removed — always expanded
el('btn-mt-collapse')?.addEventListener('click', () => {
  const sec = el('match-teams-section'); if (!sec) return;
  const on = !sec.classList.contains('mt-collapsed');
  try { localStorage.setItem('ne_mt_collapsed', on ? '1' : '0'); } catch {}
  applyMtCollapsed(on);
});
el('btn-mt-popout')?.addEventListener('click', () => openPopout('match'));

// Player Hero · Role · Country · Info fields are always shown now (no toggle). Clear any
// stale "roles-hidden" state a previous build may have left applied.
(function () {
  const sec = el('match-teams-section'); if (sec) sec.classList.remove('roles-hidden');
  try { localStorage.removeItem('ne_show_roles'); } catch {}
})();

// (Per-game default colours now live server-side; the client only sends the active mode.)

// ── Add team logo ─────────────────────────────────────────────────────────
