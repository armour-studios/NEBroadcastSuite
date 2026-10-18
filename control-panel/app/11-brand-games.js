// Control panel, part 11 of 17: Brand kits; CS2, OCR, OBS settings, RL automation, Smash, Brawlhalla, chat commands, scene hotkeys.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Brand kits (client identities + sponsor sets) ────────────────────────────
let editingBrandId = null;
// Which kit the section-header Export button writes — set by renderBrandKits (active kit, or the
// only kit). Null disables the button rather than exporting an arbitrary one.
let _brandExportTargetId = null;
let editingBrandThemes = {};      // preserve per-game theme prefs not edited here
let pendingBrandLogo = null;      // base64 data URL or existing URL
let brandSponsors = [];           // [{ id?, name, logo, tier }]
let pendingSponsorLogo = null;
let brandBannerImages = [];       // base64 images for this kit's banner
let brandBannerCaptions = [];     // optional per-image text, parallel to brandBannerImages
let brandReplaySkin = null;       // per-profile replay transition background (base64), or null
let brandScoreboardBg = null;     // per-profile RL post-game scoreboard background (base64), or null
// Brand packages: a profile holds 1+ named packages (sponsor set + placements + banner) — e.g. one
// per sponsorship deal / event type. The working vars above mirror the CURRENTLY-EDITED package;
// brandPackages is the full list, editingPackageId = which one is loaded, editingActivePackageId =
// which one goes live when this profile is activated.
let brandPackages = [];
let editingPackageId = null;
let editingActivePackageId = null;
function newBrandPackage(name) {
  return { id: 'p' + Math.random().toString(36).slice(2, 9), name: name || 'Package', sponsorLabel: 'PARTNERS', presentedLabel: '', sponsorInterval: 6, sponsorMode: 'cycle', sponsors: [], bannerImages: [], bannerCaptions: [], bannerSlant: 'right', bannerHeader: '', bannerInterval: 10, replaySkin: null, scoreboardBg: null };
}
// Copy the live editor fields back into the package being edited (call before switching/saving).
function flushEditorToPackage() {
  const pkg = brandPackages.find((p) => p.id === editingPackageId);
  if (!pkg) return;
  // Empty is allowed and meaningful: a cleared label renders NO rail heading (overlays hide it).
  // We store exactly what's typed (trimmed) — the 'PARTNERS' default only seeds a brand-new package
  // (newBrandPackage), so clearing the field and saving persists '' rather than snapping back.
  pkg.sponsorLabel = el('input-brand-sponsor-label').value.trim();
  if (el('input-brand-presented-label')) pkg.presentedLabel = el('input-brand-presented-label').value.trim();
  pkg.sponsorInterval = Number(el('input-brand-interval').value) || 6;
  pkg.sponsorMode = el('select-brand-sponsor-mode')?.value === 'static' ? 'static' : 'cycle';
  pkg.sponsors = brandSponsors;
  pkg.bannerImages = brandBannerImages;
  pkg.bannerCaptions = brandBannerCaptions;
  pkg.bannerInterval = Number(el('input-brand-banner-interval').value) || 10;
  if (el('input-brand-drop-every')) pkg.dropEvery = Math.min(900, Math.max(30, Number(el('input-brand-drop-every').value) || 120));
  if (el('input-brand-drop-hold')) pkg.dropHold = Math.min(60, Math.max(5, Number(el('input-brand-drop-hold').value) || 12));
  pkg.bannerSlant = el('select-brand-banner-slant')?.value || 'right';
  pkg.bannerHeader = el('input-brand-banner-header')?.value || '';
  pkg.replaySkin = brandReplaySkin;
  pkg.scoreboardBg = brandScoreboardBg;
}
// Load a package's sponsor/banner config into the editor fields.
function loadPackageIntoEditor(pkg) {
  pkg = pkg || newBrandPackage('Main');
  brandSponsors = (pkg.sponsors || []).map((s) => ({ ...s, placements: { ...(s.placements || {}) } }));
  brandBannerImages = Array.isArray(pkg.bannerImages) ? [...pkg.bannerImages] : [];
  brandBannerCaptions = Array.isArray(pkg.bannerCaptions) ? [...pkg.bannerCaptions] : [];
  el('input-brand-sponsor-label').value = pkg.sponsorLabel || '';
  if (el('input-brand-presented-label')) el('input-brand-presented-label').value = pkg.presentedLabel || '';
  el('input-brand-interval').value = pkg.sponsorInterval || 6;
  if (el('select-brand-sponsor-mode')) el('select-brand-sponsor-mode').value = pkg.sponsorMode === 'static' ? 'static' : 'cycle';
  el('input-brand-banner-interval').value = pkg.bannerInterval || 10;
  if (el('input-brand-drop-every')) el('input-brand-drop-every').value = pkg.dropEvery || 120;
  if (el('input-brand-drop-hold')) el('input-brand-drop-hold').value = pkg.dropHold || 12;
  if (el('select-brand-banner-slant')) el('select-brand-banner-slant').value = pkg.bannerSlant || 'right';
  if (el('input-brand-banner-header')) el('input-brand-banner-header').value = pkg.bannerHeader || '';
  brandReplaySkin = pkg.replaySkin || null;
  setBrandReplaySkinPreview(brandReplaySkin);
  brandScoreboardBg = pkg.scoreboardBg || null;
  setBrandScoreboardBgPreview(brandScoreboardBg);
  // Show a link-sourced background back in the URL box (an uploaded/inline one stays as the
  // thumbnail only — a data: blob in a text field is unreadable).
  const sbUrl = el('input-brand-scoreboardbg-url');
  if (sbUrl) sbUrl.value = /^https?:\/\//i.test(brandScoreboardBg || '') ? brandScoreboardBg : '';
  renderBrandSponsors();
  renderKitBannerImages();
}
// Show/hide the replay-skin preview thumbnail + clear the file input.
function setBrandReplaySkinPreview(url) {
  const prev = el('preview-brand-replayskin'), fileIn = el('input-brand-replayskin');
  if (prev) { if (url) { prev.src = url; prev.style.display = ''; } else { prev.style.display = 'none'; prev.removeAttribute('src'); } }
  if (fileIn && !url) fileIn.value = '';
}
// Show/hide the scoreboard-background preview thumbnail + clear the file input.
function setBrandScoreboardBgPreview(url) {
  const prev = el('preview-brand-scoreboardbg'), fileIn = el('input-brand-scoreboardbg');
  if (prev) { if (url) { prev.src = url; prev.style.display = ''; } else { prev.style.display = 'none'; prev.removeAttribute('src'); } }
  if (fileIn && !url) fileIn.value = '';
}
function selectEditorPackage(id) {
  flushEditorToPackage();
  editingPackageId = id;
  loadPackageIntoEditor(brandPackages.find((p) => p.id === id) || brandPackages[0]);
  renderBrandPackageBar();
}
async function addBrandPackage() {
  flushEditorToPackage();
  const name = await nePrompt('New package name:', 'Package ' + (brandPackages.length + 1));
  if (name === null) return;
  const pkg = newBrandPackage((name || '').trim() || ('Package ' + (brandPackages.length + 1)));
  brandPackages.push(pkg);
  editingPackageId = pkg.id;
  loadPackageIntoEditor(pkg);
  renderBrandPackageBar();
}
function duplicateBrandPackage() {
  flushEditorToPackage();
  const cur = brandPackages.find((p) => p.id === editingPackageId); if (!cur) return;
  const copy = JSON.parse(JSON.stringify(cur));
  copy.id = 'p' + Math.random().toString(36).slice(2, 9);
  copy.name = 'Copy of ' + cur.name;
  brandPackages.splice(brandPackages.indexOf(cur) + 1, 0, copy);
  editingPackageId = copy.id;
  loadPackageIntoEditor(copy);
  renderBrandPackageBar();
}
async function renameBrandPackage() {
  const cur = brandPackages.find((p) => p.id === editingPackageId); if (!cur) return;
  const name = await nePrompt('Rename package:', cur.name);
  if (name === null) return;
  cur.name = (name || '').trim() || cur.name;
  renderBrandPackageBar();
}
async function deleteBrandPackage() {
  if (brandPackages.length <= 1) { showToast('A profile needs at least one package.', '#f59e0b'); return; }
  const cur = brandPackages.find((p) => p.id === editingPackageId); if (!cur) return;
  const ok = await customConfirm('Delete Package', `Delete package "${cur.name}"? Its sponsors and banner images will be removed.`, 'Delete');
  if (!ok) return;
  const idx = brandPackages.indexOf(cur);
  brandPackages.splice(idx, 1);
  if (editingActivePackageId === cur.id) editingActivePackageId = brandPackages[0].id;
  editingPackageId = brandPackages[Math.max(0, idx - 1)].id;
  loadPackageIntoEditor(brandPackages.find((p) => p.id === editingPackageId));
  renderBrandPackageBar();
}
function renderBrandPackageBar() {
  const bar = el('brand-package-tabs'); if (!bar) return;
  bar.innerHTML = '';
  brandPackages.forEach((p) => {
    const tab = document.createElement('div');
    tab.className = 'brand-pkg-tab' + (p.id === editingPackageId ? ' active' : '') + (p.id === editingActivePackageId ? ' live' : '');
    const star = document.createElement('button');
    star.type = 'button'; star.className = 'brand-pkg-live';
    star.textContent = p.id === editingActivePackageId ? '★' : '☆';
    star.title = p.id === editingActivePackageId ? 'This package goes live when the profile is activated' : 'Make this the live package';
    star.addEventListener('click', (e) => { e.stopPropagation(); editingActivePackageId = p.id; renderBrandPackageBar(); });
    const lbl = document.createElement('span'); lbl.className = 'brand-pkg-name'; lbl.textContent = p.name;
    tab.appendChild(star); tab.appendChild(lbl);
    tab.addEventListener('click', () => selectEditorPackage(p.id));
    bar.appendChild(tab);
  });
}

async function populateBrandObsSelects(currentCollection, currentProfile) {
  const collSel = el('select-brand-obs-collection');
  const profSel = el('select-brand-obs-profile');
  if (!collSel || !profSel) return;
  const base = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : null) || 'http://localhost:3000';
  const safeJson = (r) => { if (!r.ok) throw new Error('http' + r.status); return r.json(); };
  try {
    const [cRes, pRes] = await Promise.all([
      fetch(base + '/api/obs/scene-collections').then(safeJson),
      fetch(base + '/api/obs/profiles').then(safeJson),
    ]);
    collSel.innerHTML = '<option value="">— None —</option>' +
      (cRes.collections || []).map((c) => `<option value="${c}">${c}</option>`).join('');
    profSel.innerHTML = '<option value="">— None —</option>' +
      (pRes.profiles || []).map((p) => `<option value="${p}">${p}</option>`).join('');
    if (currentCollection) collSel.value = currentCollection;
    if (currentProfile) profSel.value = currentProfile;
  } catch (e) {
    const label = (e && e.message && e.message.startsWith('http')) ? '— Reload app —' : '— OBS not connected —';
    collSel.innerHTML = `<option value="">${label}</option>`;
    profSel.innerHTML = `<option value="">${label}</option>`;
  }
}
el('btn-refresh-obs-collections')?.addEventListener('click', () =>
  populateBrandObsSelects(el('select-brand-obs-collection')?.value || '', el('select-brand-obs-profile')?.value || ''));
el('btn-refresh-obs-profiles')?.addEventListener('click', () =>
  populateBrandObsSelects(el('select-brand-obs-collection')?.value || '', el('select-brand-obs-profile')?.value || ''));

// Set a brand color picker + its paired hex text field together. Stored kit colors may be any
// pasteable style (older kits, hand-edited state) — normalize for the picker, which only takes #rrggbb.
function setBrandColorField(pickId, value) {
  const norm = normalizeAnyColor(value) || '#000000';
  const pick = el(pickId); if (pick) pick.value = norm;
  const hex = el(pickId + '-hex'); if (hex) { hex.value = norm; hex.style.borderColor = ''; }
}
wireColorHexPair('input-brand-color', 'input-brand-color-hex');
wireColorHexPair('input-brand-accent', 'input-brand-accent-hex');

function resetBrandForm() {
  editingBrandId = null;
  editingBrandThemes = {};
  { const ls = el('chk-brand-link-styles'); if (ls) ls.checked = false; }
  pendingBrandLogo = null;
  pendingSponsorLogo = null;
  const pkg = newBrandPackage('Main');
  brandPackages = [pkg];
  editingPackageId = pkg.id;
  editingActivePackageId = pkg.id;
  el('brand-editor-title').textContent = 'New Brand Kit';
  el('input-brand-name').value = '';
  setBrandColorField('input-brand-color', '#055fdb');
  setBrandColorField('input-brand-accent', '#e97139');
  el('input-brand-logo').value = '';
  el('input-sponsor-name').value = '';
  el('input-sponsor-logo').value = '';
  setBrandLogoPreview(null);
  setSponsorLogoPreview(null);
  populateBrandDesign();
  loadPackageIntoEditor(pkg);     // fills sponsor-label / interval / banner fields + renders lists
  renderBrandPackageBar();
  populateBrandObsSelects('', '');
}

// Spots a sponsor logo can be assigned to. `desc` is what the producer reads: where it shows and
// when it is on screen (the same conditions sponsor proof-of-play counts, server.js adProofOnAir).
const SPONSOR_SPOTS_UI = [
  { key: 'title',       label: 'Title',        multi: false, desc: 'The "Presented by" logo on the break screen and the full-screen boards: bracket, desk show, schedule, standings, matchup and credits.' },
  { key: 'rail',        label: 'Rail',         multi: true,  desc: 'The sponsor bug on the gameplay overlay. Several sponsors take turns.' },
  { key: 'desk',        label: 'Caster desk',  multi: true,  desc: 'Logos along the bottom of the caster desk while the casters are on screen.' },
  { key: 'banner',      label: 'Banner',       multi: true,  desc: 'The sponsor banner graphic. It rotates through every sponsor ticked here while you show it.' },
  { key: 'scoreboard',  label: 'Scoreboard',   multi: false, desc: 'The logo on the post-game scoreboard.' },
  { key: 'ticker',      label: 'Ticker',       multi: false, desc: 'The logo on the scrolling ticker bar while it is on.' },
  { key: 'replayGoal',  label: 'Replay',       multi: false, desc: 'The logo on goal and highlight replays.' },
  { key: 'replayOutro', label: 'Replay outro', multi: false, desc: 'The logo at the end of each replay.' },
  { key: 'overtime',    label: 'Overtime',     multi: false, desc: 'The logo on the Overtime graphic when a game goes to overtime.' },
  { key: 'drop',        label: 'Scorebar drop', multi: true, desc: 'A card that drops down under the Rocket League scorebar on a timer, above the round label. Use a logo or a QR code image, with an optional line of text.' },
];
// Sponsor tiers: a tier is a preset of placements, so a producer picks "Title sponsor" instead of
// working out nine checkboxes. Ticking a box by hand turns the sponsor into Custom. One-sponsor
// spots a tier claims are taken from whoever had them.
const SPONSOR_TIERS = [
  { id: 'title',      label: 'Title sponsor',      blurb: 'Top billing: presented-by, scoreboard and ticker, plus rail, desk and banner.', spots: ['title', 'scoreboard', 'ticker', 'rail', 'desk', 'banner'] },
  { id: 'presenting', label: 'Presenting partner', blurb: 'Owns the replays and overtime, plus rail, desk and banner.', spots: ['replayGoal', 'replayOutro', 'overtime', 'rail', 'desk', 'banner'] },
  { id: 'partner',    label: 'Official partner',   blurb: 'Rail, caster desk and banner.', spots: ['rail', 'desk', 'banner'] },
  { id: 'supporting', label: 'Supporting',         blurb: 'The rail only.', spots: ['rail'] },
  { id: 'custom',     label: 'Custom',             blurb: 'Pick the placements yourself.', spots: null },
];
function defaultPlacements() {
  return { title: false, rail: true, desk: false, banner: false, overtime: false, replayGoal: false, replayOutro: false, scoreboard: false, ticker: false, drop: false };
}
function ensurePlacements(s) {
  if (!s.placements || typeof s.placements !== 'object') s.placements = defaultPlacements();
  SPONSOR_SPOTS_UI.forEach((sp) => { if (typeof s.placements[sp.key] !== 'boolean') s.placements[sp.key] = false; });
  return s.placements;
}
// The tier whose preset matches what is ticked; anything else reads as Custom.
function sponsorTierOf(s) {
  const pl = ensurePlacements(s);
  const on = SPONSOR_SPOTS_UI.filter((sp) => pl[sp.key]).map((sp) => sp.key).sort().join(',');
  const hit = SPONSOR_TIERS.find((t) => t.spots && t.spots.slice().sort().join(',') === on);
  return hit ? hit.id : 'custom';
}
// Apply a tier preset. Returns the names of sponsors a one-sponsor spot was taken from.
function applySponsorTier(s, tierId) {
  const t = SPONSOR_TIERS.find((x) => x.id === tierId);
  s.tier = tierId;
  if (!t || !t.spots) return [];
  const taken = [];
  SPONSOR_SPOTS_UI.forEach((sp) => {
    const want = t.spots.includes(sp.key);
    s.placements[sp.key] = want;
    if (want && !sp.multi) {
      brandSponsors.forEach((o) => {
        if (o === s) return;
        ensurePlacements(o);
        if (o.placements[sp.key]) { o.placements[sp.key] = false; o.tier = sponsorTierOf(o); taken.push((o.name || 'another sponsor') + ' (' + sp.label + ')'); }
      });
    }
  });
  return taken;
}

let sponsorsSortable = null;
let _sponsorNote = '';
function renderBrandSponsors() {
  const list = el('sponsors-list'); const empty = el('sponsors-empty');
  if (!list) return;
  list.querySelectorAll('.sponsor-row, .sponsor-note').forEach((i) => i.remove());
  if (empty) empty.style.display = brandSponsors.length ? 'none' : '';
  if (_sponsorNote) {
    const n = document.createElement('div'); n.className = 'sponsor-note'; n.textContent = _sponsorNote;
    list.insertBefore(n, list.firstChild);
    _sponsorNote = '';
  }
  // Who holds each one-sponsor spot, so a chip can say "with Red Bull" before you take it.
  const holder = {};
  brandSponsors.forEach((o) => { ensurePlacements(o); SPONSOR_SPOTS_UI.forEach((sp) => { if (!sp.multi && o.placements[sp.key] && !holder[sp.key]) holder[sp.key] = o; }); });
  brandSponsors.forEach((s, idx) => {
    ensurePlacements(s);
    const row = document.createElement('div'); row.className = 'sponsor-row preset-item';
    row._sponsorRef = s;   // kept in sync by drag-reorder below (DOM order → array order)

    const head = document.createElement('div'); head.className = 'sponsor-row-head';
    const grip = document.createElement('span'); grip.className = 'sponsor-row-grip'; grip.title = 'Drag to reorder (the rail and banner rotate in this order)'; grip.textContent = '⠿';
    head.appendChild(grip);
    const thumb = document.createElement('div'); thumb.className = 'sponsor-row-thumb';
    if (s.logo) { const img = document.createElement('img'); img.src = s.logo; thumb.appendChild(img); }
    else { thumb.textContent = 'TXT'; }
    const name = document.createElement('input'); name.type = 'text';
    name.className = 'sponsor-row-name sponsor-name-input';
    name.value = s.name || '';
    name.placeholder = '(logo only)';
    name.title = 'Rename this sponsor';
    name.addEventListener('input', () => { s.name = name.value; });
    // Tier: a preset of placements.
    const tierWrap = document.createElement('label'); tierWrap.className = 'sponsor-tier';
    tierWrap.title = 'A tier ticks the placements for you. Change any placement below and it becomes Custom.';
    const tierSel = document.createElement('select'); tierSel.className = 'input-select sponsor-tier-select';
    const curTier = sponsorTierOf(s);
    SPONSOR_TIERS.forEach((t) => { const o = new Option(t.label, t.id); o.title = t.blurb; tierSel.appendChild(o); });
    tierSel.value = curTier;
    s.tier = curTier;
    tierSel.addEventListener('change', () => {
      const taken = applySponsorTier(s, tierSel.value);
      if (taken.length) _sponsorNote = 'Moved to ' + (s.name || 'this sponsor') + ': ' + taken.join(', ') + '. Those spots show one sponsor at a time.';
      renderBrandSponsors();
    });
    tierWrap.appendChild(tierSel);
    const del = document.createElement('button'); del.className = 'btn btn-danger btn-sm'; del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    del.title = 'Remove sponsor';
    del.addEventListener('click', () => { brandSponsors.splice(idx, 1); renderBrandSponsors(); });
    head.appendChild(thumb); head.appendChild(name); head.appendChild(tierWrap); head.appendChild(del);

    // Placements as chips: lit = this sponsor shows there. Each says what it is on hover; a
    // one-sponsor spot held by someone else says who.
    const spots = document.createElement('div'); spots.className = 'sponsor-placements';
    const lab0 = document.createElement('span'); lab0.className = 'sponsor-placements-k'; lab0.textContent = 'Shows on';
    spots.appendChild(lab0);
    SPONSOR_SPOTS_UI.forEach((sp) => {
      const on = !!s.placements[sp.key];
      const other = !sp.multi && !on && holder[sp.key] && holder[sp.key] !== s ? holder[sp.key] : null;
      const chip = document.createElement('button'); chip.type = 'button';
      chip.className = 'sponsor-chip' + (on ? ' is-on' : '') + (sp.multi ? '' : ' is-single') + (other ? ' is-held' : '');
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.title = sp.label + ': ' + sp.desc + (sp.multi ? ' Any number of sponsors.' : ' One sponsor at a time.')
        + (other ? ' Now: ' + (other.name || 'another sponsor') + '. Click to give it to ' + (s.name || 'this sponsor') + '.' : '');
      chip.textContent = sp.label;
      if (!sp.multi) { const one = document.createElement('i'); one.textContent = '1'; one.title = 'One sponsor'; chip.appendChild(one); }
      chip.addEventListener('click', () => {
        s.placements[sp.key] = !on;
        if (!sp.multi && !on) {
          brandSponsors.forEach((o) => { if (o !== s) { ensurePlacements(o); if (o.placements[sp.key]) { o.placements[sp.key] = false; o.tier = sponsorTierOf(o); } } });
        }
        s.tier = sponsorTierOf(s);
        renderBrandSponsors();
      });
      spots.appendChild(chip);
    });

    // Deal numbers are optional and only matter for Analytics, so they sit quietly at the end.
    const deal = document.createElement('div'); deal.className = 'sponsor-deal-row';
    const dvLab = document.createElement('label'); dvLab.className = 'sponsor-deal-field';
    dvLab.title = 'Optional. What this sponsor paid for the deal. Analytics turns it into a cost per thousand views delivered.';
    dvLab.appendChild(document.createTextNode('Deal $'));
    const dv = document.createElement('input'); dv.type = 'number'; dv.min = '0'; dv.step = '0.01'; dv.placeholder = 'optional';
    dv.className = 'input-text sponsor-deal-input';
    dv.value = s.dealValue != null ? s.dealValue : '';
    dv.addEventListener('change', () => { const n = parseFloat(dv.value); s.dealValue = (Number.isFinite(n) && n >= 0) ? n : null; });
    dvLab.appendChild(dv);
    const cpmLab = document.createElement('label'); cpmLab.className = 'sponsor-deal-field';
    cpmLab.title = 'Optional. Their agreed price per 1,000 views. Analytics uses it to put a dollar value on the screen time delivered.';
    cpmLab.appendChild(document.createTextNode('Target CPM $'));
    const cpm = document.createElement('input'); cpm.type = 'number'; cpm.min = '0'; cpm.step = '0.01'; cpm.placeholder = 'optional';
    cpm.className = 'input-text sponsor-deal-input';
    cpm.value = s.targetCpm != null ? s.targetCpm : '';
    cpm.addEventListener('change', () => { const n = parseFloat(cpm.value); s.targetCpm = (Number.isFinite(n) && n >= 0) ? n : null; });
    cpmLab.appendChild(cpm);
    deal.appendChild(dvLab); deal.appendChild(cpmLab);
    // The scorebar drop-down card carries one line of text beside the logo or QR code.
    if (s.placements.drop) {
      const ctaLab = document.createElement('label'); ctaLab.className = 'sponsor-deal-field sponsor-cta-field';
      ctaLab.title = 'One line beside the logo on the scorebar drop-down, like "Build your free portfolio". Leave empty for the logo alone.';
      ctaLab.appendChild(document.createTextNode('Drop-down text'));
      const cta = document.createElement('input'); cta.type = 'text'; cta.maxLength = 60; cta.placeholder = 'optional';
      cta.className = 'input-text sponsor-cta-input';
      cta.value = s.cta || '';
      cta.addEventListener('input', () => { s.cta = cta.value; });
      ctaLab.appendChild(cta);
      deal.appendChild(ctaLab);
    }

    row.appendChild(head); row.appendChild(spots); row.appendChild(deal); list.appendChild(row);
  });
  renderSponsorGuide();

  if (sponsorsSortable) { sponsorsSortable.destroy(); sponsorsSortable = null; }
  if (brandSponsors.length > 1 && typeof Sortable !== 'undefined') {
    sponsorsSortable = Sortable.create(list, {
      animation: 150, draggable: '.sponsor-row', handle: '.sponsor-row-grip',
      onEnd: () => { brandSponsors = [...list.querySelectorAll('.sponsor-row')].map((r) => r._sponsorRef).filter(Boolean); renderBrandSponsors(); }
    });
  }
}
// "Where sponsors show": every placement, what it is, and who has it in this package. Sits above
// the sponsor list, folded by default once you have seen it.
function renderSponsorGuide() {
  const host = el('sponsor-guide'); if (!host) return;
  const who = (key) => brandSponsors.filter((o) => o.placements && o.placements[key]).map((o) => o.name || 'logo only');
  const rows = SPONSOR_SPOTS_UI.map((sp) => {
    const w = who(sp.key);
    return `<div class="sg-row"><b>${sp.label}${sp.multi ? '' : '<i title="One sponsor">1</i>'}</b><span>${escHtml(sp.desc)}</span><em class="${w.length ? '' : 'is-empty'}">${w.length ? escHtml(w.join(', ')) : 'Nobody yet'}</em></div>`;
  }).join('');
  const tiers = SPONSOR_TIERS.filter((t) => t.spots).map((t) => `<div class="sg-tier"><b>${t.label}</b><span>${escHtml(t.blurb)}</span></div>`).join('');
  host.innerHTML = `<details class="sg"${brandSponsors.length ? '' : ' open'}><summary>Where sponsors show, and what the tiers mean</summary>`
    + `<div class="sg-tiers">${tiers}</div><div class="sg-rows">${rows}</div>`
    + `<p class="sg-foot">Spots marked 1 hold one sponsor at a time. The rest show every sponsor ticked, taking turns in the order of the list.</p></details>`;
}

// Show/hide the square brand-logo preview vs the empty placeholder.
function setBrandLogoPreview(url) {
  const prev = el('brand-logo-preview'), empty = el('brand-logo-empty');
  if (url) { if (prev) { prev.src = url; prev.style.display = ''; } if (empty) empty.style.display = 'none'; }
  else { if (prev) { prev.style.display = 'none'; prev.removeAttribute('src'); } if (empty) empty.style.display = ''; }
}
// Same, for the pending sponsor logo (so a library pick is visible before "Add Sponsor").
function setSponsorLogoPreview(url) {
  const prev = el('sponsor-logo-preview'), empty = el('sponsor-logo-empty');
  if (url) { if (prev) { prev.src = url; prev.style.display = ''; } if (empty) empty.style.display = 'none'; }
  else { if (prev) { prev.style.display = 'none'; prev.removeAttribute('src'); } if (empty) empty.style.display = ''; }
}
// Per-game overlay design: pick a game, then a design for it. Saved per game in editingBrandThemes,
// so one profile can carry a different overlay design for each game it runs.
function brandThemesFor(gameId) {
  const games = (currentState && currentState.games) || {};
  return (games[gameId] && games[gameId].themes) || [];
}
function fillBrandThemeSelect(gameId) {
  const themeSel = el('select-brand-theme'); if (!themeSel) return;
  themeSel.innerHTML = '<option value="">— default design —</option>' +
    brandThemesFor(gameId).map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  themeSel.value = (editingBrandThemes && editingBrandThemes[gameId]) || '';
}
function populateBrandDesign() {
  const gameSel = el('select-brand-game'); if (!gameSel) return;
  const games = (currentState && currentState.games) || {};
  const ids = Object.keys(games);
  const prevGame = gameSel.value;
  gameSel.innerHTML = ids.map((id) => `<option value="${id}">${games[id].name || id}</option>`).join('');
  gameSel.value = (prevGame && games[prevGame]) ? prevGame : ((currentState && currentState.activeGame) || ids[0] || '');
  fillBrandThemeSelect(gameSel.value);
  renderBrandDesignSummary();
}
function renderBrandDesignSummary() {
  const sum = el('brand-design-summary'); if (!sum) return;
  const games = (currentState && currentState.games) || {};
  const parts = Object.keys(editingBrandThemes || {}).filter((g) => editingBrandThemes[g]).map((g) => {
    const gn = (games[g] && games[g].name) || g;
    const tn = ((games[g] && games[g].themes) || []).find((t) => t.id === editingBrandThemes[g]);
    return `${gn} → ${tn ? tn.name : editingBrandThemes[g]}`;
  });
  sum.textContent = parts.length ? 'Designs set: ' + parts.join('  ·  ') : 'No per-game designs set — your current overlay layouts are left alone.';
}

// The package a kit currently has live (falls back to legacy top-level fields).
function kitActivePackage(k) {
  const pkgs = Array.isArray(k.packages) ? k.packages : [];
  if (pkgs.length) return pkgs.find((p) => p.id === k.activePackageId) || pkgs[0];
  return { id: null, name: 'Main', sponsors: k.sponsors || [], bannerImages: k.bannerImages || [] };
}

function renderBrands(data) {
  const kits = data.brandKits || [];

  // Skip the select + list rebuild when nothing brand-related changed. Keyed on the server's
  // monotonic brandKitsVer (bumped on EVERY brand-kit mutation) + the active-kit selection, so any
  // edit — reorder, tier, same-length rename, a non-active package — refreshes the closures and the
  // Edit buttons always carry up-to-date kit data. (The old length/count hash missed those and made
  // sponsor edits silently revert.)
  const sig = (data.activeBrandKitId || '') + '::' + (data.brandKitsVer || 0);
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
  // Package quick-switch — show the active client's packages (Profiles + Dashboard). Hidden when
  // the active client has 0–1 packages (nothing to switch).
  const activeKitForPkg = kits.find((k) => k.id === data.activeBrandKitId);
  const pkgs = (activeKitForPkg && Array.isArray(activeKitForPkg.packages)) ? activeKitForPkg.packages : [];
  ['select-active-package', 'select-active-package-main'].forEach((sid) => {
    const sel = el(sid);
    if (!sel) return;
    if (pkgs.length > 1) {
      sel.innerHTML = pkgs.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
      if (document.activeElement !== sel) sel.value = activeKitForPkg.activePackageId || (pkgs[0] && pkgs[0].id) || '';
      sel.style.display = '';
    } else {
      sel.innerHTML = '';
      sel.style.display = 'none';
    }
  });
  const chip = el('active-brand-chip');
  if (chip) {
    const activeKit = kits.find((k) => k.id === data.activeBrandKitId);
    const apkg = activeKit ? kitActivePackage(activeKit) : null;
    chip.textContent = activeKit ? (activeKit.name + (pkgs.length > 1 && apkg ? ' · ' + apkg.name : '')) : 'No client';
    chip.classList.toggle('ok', !!activeKit);
  }

  // Section-header "Export Kit" — the counterpart to "Import Kit", which is where producers look
  // first. It has no row of its own to read the kit from, so it targets the active profile (or the
  // only one, when there's just one) and says so on the button — no silent guess about which kit
  // lands in the file. Per-kit Export still lives on every row below.
  const hdrExp = el('btn-export-brand-kit');
  if (hdrExp) {
    const target = kits.find((k) => k.id === data.activeBrandKitId) || (kits.length === 1 ? kits[0] : null);
    _brandExportTargetId = target ? target.id : null;
    hdrExp.disabled = !target;
    hdrExp.title = target
      ? `Export "${target.name}" to a file — identity, every package, sponsors and OBS settings`
      : (kits.length ? 'Activate a profile first, or use the Export button on the kit you want' : 'No brand kits to export yet');
  }

  const list = el('brands-list'); const empty = el('brands-empty');
  if (!list) return;
  list.querySelectorAll('.preset-item').forEach((i) => i.remove());
  if (empty) empty.style.display = kits.length ? 'none' : '';
  kits.forEach((k) => {
    const isActive = k.id === data.activeBrandKitId;
    const nSp = (kitActivePackage(k).sponsors || []).length;
    const nPkg = (k.packages || []).length || 1;
    const item = document.createElement('div'); item.className = 'preset-item brand-kit-item' + (k._org ? ' is-org' : '') + (isActive ? ' is-active' : '');
    // Left: brand logo + name, with sponsors (and a package quick-switch) on a second line.
    const main = document.createElement('div'); main.className = 'brand-kit-main';
    const logo = document.createElement('div'); logo.className = 'brand-kit-logo';
    if (k.logo) { const im = document.createElement('img'); im.src = k.logo; im.alt = ''; logo.appendChild(im); }
    else { logo.textContent = ((k.name || '?').trim().charAt(0) || '?').toUpperCase(); }
    const info = document.createElement('div'); info.className = 'brand-kit-info';
    // Name alone on its line (ellipsised), counts on a meta line under it. The counts used to be glued
    // onto the name, and with seven buttons beside it the name column shrank to ~110px, so "Nameless
    // Esports · 1 package · 6 sponsors" wrapped over four lines on every card.
    const nameLine = document.createElement('div'); nameLine.className = 'brand-kit-name';
    const nameTxt = document.createElement('span'); nameTxt.className = 'brand-kit-name-txt';
    nameTxt.textContent = k.name; nameTxt.title = k.name; nameLine.appendChild(nameTxt);
    if (isActive) { const lv = document.createElement('span'); lv.className = 'brand-kit-live'; lv.textContent = 'Live'; nameLine.appendChild(lv); }
    if (k._org) { const b = document.createElement('span'); b.className = 'tc-org-badge'; b.textContent = 'ORG'; b.title = 'From organization' + (k._orgOwner ? ' · ' + k._orgOwner : ''); nameLine.appendChild(b); }
    const metaLine = document.createElement('div'); metaLine.className = 'brand-kit-meta';
    metaLine.textContent = `${nPkg} package${nPkg === 1 ? '' : 's'} · ${nSp} sponsor${nSp === 1 ? '' : 's'}`;
    const subLine = document.createElement('div'); subLine.className = 'brand-kit-sub';
    const sponsors = (kitActivePackage(k).sponsors || []);
    if (sponsors.length) {
      sponsors.slice(0, 14).forEach((s) => {
        if (s.logo) { const si = document.createElement('img'); si.className = 'brand-kit-sponsor'; si.src = s.logo; si.alt = ''; si.title = s.name || ''; subLine.appendChild(si); }
        else if (s.name) { const st = document.createElement('span'); st.className = 'brand-kit-sponsor-txt'; st.textContent = s.name; subLine.appendChild(st); }
      });
      if (sponsors.length > 14) { const more = document.createElement('span'); more.className = 'brand-kit-sponsor-txt'; more.textContent = '+' + (sponsors.length - 14); subLine.appendChild(more); }
    } else {
      const none = document.createElement('span'); none.className = 'brand-kit-sub-empty'; none.textContent = 'No sponsors in this package'; subLine.appendChild(none);
    }
    info.appendChild(nameLine); info.appendChild(metaLine); info.appendChild(subLine);
    main.appendChild(logo); main.appendChild(info);
    const actions = document.createElement('div'); actions.className = 'preset-actions';
    // Live-package quick-switch, inline with the action buttons (only when there's more than one).
    if ((k.packages || []).length > 1) {
      const psel = document.createElement('select'); psel.className = 'input-select brand-kit-pkg';
      psel.title = "Switch this profile's live package";
      psel.innerHTML = k.packages.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
      psel.value = k.activePackageId || k.packages[0].id;
      psel.addEventListener('change', () => {
        send('activate_brand_package', { kitId: k.id, packageId: psel.value });
        const pname = (k.packages.find((p) => p.id === psel.value) || {}).name || 'package';
        // Switching a NON-active profile's package changes nothing on screen (by design — it
        // takes effect when that profile activates). Say so, or it reads as "not switching".
        if (k.id !== (currentState && currentState.activeBrandKitId)) {
          showToast(`"${pname}" set as ${k.name}'s live package — but "${k.name}" isn't the active profile. Hit Activate on it to bring this on screen.`, '#fbbf24', 7000);
        } else {
          showToast(`Live package → "${pname}"`, '#22c55e');
        }
      });
      actions.appendChild(psel);
    }
    const actBtn = document.createElement('button');
    actBtn.className = 'btn btn-primary btn-sm'; actBtn.textContent = isActive ? 'Active' : 'Activate';
    actBtn.disabled = isActive;
    actBtn.addEventListener('click', () => send('activate_brand_kit', { id: k.id }));
    // Capture the CURRENT show setup into this profile's live package: scene presets, ticker,
    // event name, board titles, caster lineup + slot labels, OBS moment mappings. Activating
    // the kit/package later restores it all. (Facecams/replay-cam toggles are deliberately
    // NOT captured — those are production-dependent, not brand-dependent.)
    const pkg = kitActivePackage(k);
    const capBtn = document.createElement('button');
    capBtn.className = 'btn btn-ghost btn-sm';
    capBtn.textContent = pkg.showSnapshot ? 'Re-capture' : 'Capture setup';
    capBtn.title = (pkg.showSnapshot
      ? 'Update the captured show setup (last captured ' + new Date(pkg.showSnapshot.capturedAt || 0).toLocaleString() + ')'
      : 'Snapshot the current show setup into "' + (pkg.name || 'Main') + '"')
      + ' — scene presets · ticker · event name · titles · caster lineup · OBS scene mappings · the Rocket League overlay look (overtime / replay wording and colours, scoreboard and replay styles, Presented by label, Worlds extras)';
    capBtn.addEventListener('click', () => {
      send('capture_package_snapshot', { kitId: k.id, packageId: pkg.id });   // brand-result toasts the outcome
    });
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-ghost btn-sm'; editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => { openBrandEditor(); loadBrandIntoForm(k); });
    const dupBtn = document.createElement('button');
    dupBtn.className = 'btn btn-ghost btn-sm'; dupBtn.textContent = 'Duplicate';
    dupBtn.title = 'Duplicate this profile and all its packages';
    dupBtn.addEventListener('click', () => send('duplicate_brand_kit', { id: k.id }));
    const expBtn = document.createElement('button');
    expBtn.className = 'btn btn-ghost btn-sm'; expBtn.textContent = 'Export';
    expBtn.title = 'Export this brand kit to a file (includes OBS profile settings)';
    expBtn.addEventListener('click', () => send('export_brand_kit', { id: k.id }));
    const urlBtn = document.createElement('button');
    urlBtn.className = 'btn btn-ghost btn-sm'; urlBtn.textContent = 'Banner URL';
    urlBtn.title = "Copy this brand's standalone banner OBS browser-source URL";
    urlBtn.addEventListener('click', () => copyText(`${SCENE_BASE_URL}/sponsor-banner.html?brand=${encodeURIComponent(k.id)}`, urlBtn));
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm'; delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.addEventListener('click', async () => {
      // This removes the WHOLE profile, not just the currently-live package — warn explicitly so
      // deleting one package (e.g. a game-specific one) doesn't surprise-delete the rest. To remove
      // just one package, use Edit → select its tab → Delete Package instead.
      const pkgWarn = nPkg > 1
        ? ` This client has ${nPkg} packages (${(k.packages || []).map((p) => p.name).join(', ')}) — deleting it removes ALL of them, not just one. To delete a single package, open Edit instead.`
        : '';
      const ok = await customConfirm('Delete Brand Kit', `Delete "${k.name}"? This deletes the entire client profile and ALL of its brand packages — this cannot be undone.${pkgWarn}`, 'Delete Everything');
      if (ok) send('delete_brand_kit', { id: k.id });
    });
    // Activate and Edit are what a producer reaches for every show; capture, duplicate, export, banner
    // URL and delete go behind More. Seven buttons in a row is what crushed the name column.
    actBtn.textContent = isActive ? 'Live' : 'Activate';
    const more = document.createElement('details'); more.className = 'bk-more';
    const moreSum = document.createElement('summary'); moreSum.className = 'btn btn-ghost btn-sm bk-more-sum'; moreSum.textContent = 'More';
    const menu = document.createElement('div'); menu.className = 'bk-more-menu';
    [capBtn, dupBtn, expBtn, urlBtn].forEach((b) => { b.className = 'bk-more-item'; });
    urlBtn.textContent = 'Copy banner URL';
    delBtn.className = 'bk-more-item is-danger'; delBtn.textContent = 'Delete kit…';
    const sep = document.createElement('div'); sep.className = 'bk-more-sep';
    [capBtn, dupBtn, expBtn, urlBtn, sep, delBtn].forEach((n) => menu.appendChild(n));
    menu.addEventListener('click', (e) => { if (e.target.closest('.bk-more-item')) more.open = false; });
    more.appendChild(moreSum); more.appendChild(menu);
    actions.appendChild(actBtn); actions.appendChild(editBtn); actions.appendChild(more);
    item.appendChild(main); item.appendChild(actions); list.appendChild(item);
  });
}
// A kit's More menu closes when you click anywhere else.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.bk-more[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});

// Compact Dashboard brand-kit strip (above Event): shows the active client + its sponsors, and lets
// you search/switch/edit/add kits without leaving the Dashboard. Reuses the Profiles editor modal.
function renderDashBrandKit(data) {
  const panel = el('dash-brandkit'); if (!panel) return;
  const kits = data.brandKits || [];
  const activeId = data.activeBrandKitId || '';
  // Cheap guard (version + active) so we don't rebuild the strip every broadcast.
  const sig = activeId + '::' + (data.brandKitsVer || 0);
  if (renderDashBrandKit._sig === sig) return;
  const mount = el('dbk-picker-mount');
  if (mount && mount.contains(document.activeElement)) return;   // don't clobber an open picker; retry next tick
  renderDashBrandKit._sig = sig;

  const active = kits.find((k) => k.id === activeId) || null;

  // Sponsors of the active package.
  const spWrap = el('dbk-sponsors');
  if (spWrap) {
    spWrap.innerHTML = '';
    const sponsors = active ? (kitActivePackage(active).sponsors || []) : [];
    if (!active) { const s = document.createElement('span'); s.className = 'dbk-hint'; s.textContent = 'Pick or add a brand kit →'; spWrap.appendChild(s); }
    else if (!sponsors.length) { const s = document.createElement('span'); s.className = 'dbk-hint'; s.textContent = 'No sponsors in this package'; spWrap.appendChild(s); }
    else {
      sponsors.slice(0, 24).forEach((sp) => {
        if (sp.logo) { const im = document.createElement('img'); im.className = 'dbk-sponsor'; im.src = sp.logo; im.alt = ''; im.title = sp.name || ''; spWrap.appendChild(im); }
        else if (sp.name) { const t = document.createElement('span'); t.className = 'dbk-sponsor-txt'; t.textContent = sp.name; t.title = sp.name; spWrap.appendChild(t); }
      });
      if (sponsors.length > 24) { const m = document.createElement('span'); m.className = 'dbk-sponsor-txt'; m.textContent = '+' + (sponsors.length - 24); spWrap.appendChild(m); }
    }
  }

  // Searchable kit picker — shows each kit's LOGO next to its name in the dropdown (native <select>
  // can't render images). Picking a kit makes it the active client.
  if (mount && typeof buildSearchPicker === 'function') {
    const items = kits.map((k) => ({ value: k.id, label: k.name || '(unnamed)', img: k.logo || '' }));
    mount.innerHTML = '';
    mount.appendChild(buildSearchPicker({
      items, value: activeId, placeholder: 'No brand kit', emptyLabel: '— No brand kit —',
      className: 'dbk-kit-pick',
      onPick: (id) => send('activate_brand_kit', { id: id || null }),
    }));
  }
}
// Dashboard brand-kit strip controls (bound once). Edit/Duplicate act on the ACTIVE kit.
function _dbkActiveKit() {
  const id = (currentState && currentState.activeBrandKitId) || '';
  return ((currentState && currentState.brandKits) || []).find((x) => x.id === id) || null;
}
el('dbk-edit')?.addEventListener('click', () => {
  const k = _dbkActiveKit();
  if (k) { openBrandEditor(); loadBrandIntoForm(k); }
  else { resetBrandForm(); openBrandEditor(); }   // nothing active → open a blank new-kit form
});
el('dbk-dup')?.addEventListener('click', () => {
  const k = _dbkActiveKit();
  if (k) send('duplicate_brand_kit', { id: k.id });
  else if (typeof showToast === 'function') showToast('Activate a brand kit first to duplicate it.', '#f59e0b');
});
el('dbk-new')?.addEventListener('click', () => { resetBrandForm(); openBrandEditor(); });

function loadBrandIntoForm(k) {
  editingBrandId = k.id;
  editingBrandThemes = (k.themes && typeof k.themes === 'object') ? { ...k.themes } : {};
  { const ls = el('chk-brand-link-styles'); if (ls) ls.checked = !!k.linkStyles; }
  pendingBrandLogo = k.logo || null;
  // Server sends kit.packages; fall back to wrapping legacy top-level sponsor/banner fields.
  let src = Array.isArray(k.packages) && k.packages.length ? k.packages
    : [{ id: k.activePackageId, name: 'Main', sponsorLabel: k.sponsorLabel, sponsorInterval: k.sponsorInterval, sponsorMode: k.sponsorMode, sponsors: k.sponsors, bannerImages: k.bannerImages, bannerCaptions: k.bannerCaptions, bannerSlant: k.bannerSlant, bannerHeader: k.bannerHeader, bannerInterval: k.bannerInterval, replaySkin: k.replaySkin, scoreboardBg: k.scoreboardBg }];
  brandPackages = src.map((p) => ({
    id: p.id || ('p' + Math.random().toString(36).slice(2, 9)),
    name: p.name || 'Main',
    sponsorLabel: p.sponsorLabel != null ? p.sponsorLabel : 'PARTNERS',   // preserve an explicit '' (no heading); default only when unset
    sponsorInterval: p.sponsorInterval || 6,
    sponsorMode: p.sponsorMode === 'static' ? 'static' : 'cycle',
    sponsors: (p.sponsors || []).map((s) => ({ ...s, placements: { ...(s.placements || {}) } })),
    bannerImages: Array.isArray(p.bannerImages) ? [...p.bannerImages] : [],
    bannerCaptions: Array.isArray(p.bannerCaptions) ? [...p.bannerCaptions] : [],
    bannerSlant: p.bannerSlant || 'right',
    bannerHeader: p.bannerHeader || '',
    bannerInterval: p.bannerInterval || 10,
    dropEvery: p.dropEvery || 120,
    dropHold: p.dropHold || 12,
    replaySkin: p.replaySkin || null,
    scoreboardBg: p.scoreboardBg || null,
  }));
  editingActivePackageId = (k.activePackageId && brandPackages.some((p) => p.id === k.activePackageId)) ? k.activePackageId : brandPackages[0].id;
  editingPackageId = editingActivePackageId;
  el('brand-editor-title').textContent = 'Edit: ' + k.name;
  el('input-brand-name').value = k.name || '';
  setBrandColorField('input-brand-color', k.color || '#055fdb');
  setBrandColorField('input-brand-accent', k.accent || '#e97139');
  setBrandLogoPreview(pendingBrandLogo);
  populateBrandDesign();
  loadPackageIntoEditor(brandPackages.find((p) => p.id === editingPackageId));
  renderBrandPackageBar();
  populateBrandObsSelects(k.obsSceneCollection || '', k.obsProfile || '');
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

el('input-brand-banner-image')?.addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  brandBannerImages.push(await fileToBase64(f, 1600));   // banners span the lower third — keep them wide/crisp
  brandBannerCaptions.push('');
  e.target.value = '';
  renderKitBannerImages();
});

el('input-brand-logo')?.addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingBrandLogo = await fileToBase64(f);
  setBrandLogoPreview(pendingBrandLogo);
});
el('btn-clear-brand-logo')?.addEventListener('click', () => {
  pendingBrandLogo = null;
  const f = el('input-brand-logo'); if (f) f.value = '';
  setBrandLogoPreview(null);
});

// Per-profile replay transition background (full-frame image). It's the heaviest single kit asset, so
// we store it as a FILE (served URL) rather than base64 embedded in the kit — that keeps the brand
// JSON tiny so saves + library broadcasts stay fast (embedding it re-serialized MBs on every save).
// Falls back to inline base64 if the media upload is unavailable. Save is blocked while it uploads
// (saving mid-upload used to drop the image silently). Capped at 1440px — plenty for a skewed bg.
el('input-brand-replayskin')?.addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const saveBtn = el('btn-save-brand');
  if (saveBtn) saveBtn.disabled = true;
  if (typeof showToast === 'function') showToast('Uploading replay background…', '#3b82f6');
  try {
    brandReplaySkin = await uploadImageFile(f, 'brand-skins', 1440);
  } catch (_) {
    try {
      brandReplaySkin = await fileToBase64(f, 1440);
      if (typeof showToast === 'function') showToast('Saved inline (media upload unavailable).', '#f59e0b');
    } catch (__) {}
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
  setBrandReplaySkinPreview(brandReplaySkin);
});
el('btn-brand-replayskin-clear')?.addEventListener('click', () => {
  brandReplaySkin = null;
  setBrandReplaySkinPreview(null);
});
el('input-brand-scoreboardbg')?.addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const saveBtn = el('btn-save-brand');
  if (saveBtn) saveBtn.disabled = true;
  if (typeof showToast === 'function') showToast('Uploading scoreboard background…', '#3b82f6');
  try {
    brandScoreboardBg = await uploadImageFile(f, 'brand-skins', 1920);
  } catch (_) {
    try {
      brandScoreboardBg = await fileToBase64(f, 1920);
      if (typeof showToast === 'function') showToast('Saved inline (media upload unavailable).', '#f59e0b');
    } catch (__) {}
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
  setBrandScoreboardBgPreview(brandScoreboardBg);
});
el('btn-brand-scoreboardbg-clear')?.addEventListener('click', () => {
  brandScoreboardBg = null;
  setBrandScoreboardBgPreview(null);
  const u = el('input-brand-scoreboardbg-url'); if (u) u.value = '';
});
// Paste-a-link path: the overlay renders whatever URL it's given, so a hosted image needs no upload.
function applyBrandScoreboardBgUrl() {
  const inp = el('input-brand-scoreboardbg-url'); if (!inp) return;
  const url = (inp.value || '').trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) {
    if (typeof showToast === 'function') showToast('Paste a full image link starting with https://', '#f59e0b');
    return;
  }
  brandScoreboardBg = url;
  setBrandScoreboardBgPreview(url);
  if (typeof showToast === 'function') showToast('Scoreboard background set — Save the profile to keep it.', '#22c55e');
}
el('btn-brand-scoreboardbg-url')?.addEventListener('click', applyBrandScoreboardBgUrl);
el('input-brand-scoreboardbg-url')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyBrandScoreboardBgUrl(); } });

// Per-game overlay design pickers.
el('select-brand-game')?.addEventListener('change', function () { fillBrandThemeSelect(this.value); });
el('select-brand-theme')?.addEventListener('change', function () {
  const g = el('select-brand-game')?.value;
  if (!g) return;
  if (!editingBrandThemes || typeof editingBrandThemes !== 'object') editingBrandThemes = {};
  if (this.value) editingBrandThemes[g] = this.value; else delete editingBrandThemes[g];
  renderBrandDesignSummary();
});

el('input-sponsor-logo')?.addEventListener('change', async (e) => {
  const f = e.target.files[0]; pendingSponsorLogo = f ? await fileToBase64(f) : null;
  setSponsorLogoPreview(pendingSponsorLogo);
});

el('btn-add-sponsor')?.addEventListener('click', () => {
  const name = (el('input-sponsor-name').value || '').trim();
  if (!name && !pendingSponsorLogo) { showToast('Enter a sponsor name or pick a logo.', '#ef4444'); return; }
  // New sponsors start as Official partner (rail, caster desk, banner); the tier picker changes it.
  brandSponsors.push({ name, logo: pendingSponsorLogo || null, tier: 'partner', placements: { ...defaultPlacements(), desk: true, banner: true }, dealValue: null, targetCpm: null });
  pendingSponsorLogo = null;
  el('input-sponsor-name').value = '';
  el('input-sponsor-logo').value = '';
  setSponsorLogoPreview(null);
  renderBrandSponsors();
});

function saveBrandKitFromEditor(activate) {
  const name = (el('input-brand-name').value || '').trim();
  if (!name) { showToast('Enter a client / brand name.', '#ef4444'); return; }
  // Capture the design currently shown (per-game prefs are kept live in editingBrandThemes).
  const gSel = el('select-brand-game'), tSel = el('select-brand-theme');
  if (gSel && tSel) { const g = gSel.value, v = tSel.value; if (v) editingBrandThemes[g] = v; else delete editingBrandThemes[g]; }
  flushEditorToPackage();
  send('save_brand_kit', {
    id: editingBrandId || undefined,
    name,
    logo: pendingBrandLogo || null,
    color: normalizeAnyColor(el('input-brand-color-hex')?.value) || el('input-brand-color').value,
    accent: normalizeAnyColor(el('input-brand-accent-hex')?.value) || el('input-brand-accent').value,
    themes: editingBrandThemes,
    linkStyles: !!el('chk-brand-link-styles')?.checked,
    packages: brandPackages,
    activePackageId: editingActivePackageId,
    obsSceneCollection: (el('select-brand-obs-collection')?.value || '').trim(),
    obsProfile: (el('select-brand-obs-profile')?.value || '').trim(),
    activate: !!activate,   // Save & Activate — put this profile on air in the same action
  });
  const livePkg = brandPackages.find((p) => p.id === editingActivePackageId);
  const openPkg = brandPackages.find((p) => p.id === editingPackageId);
  if (activate) {
    showToast(`Saved & activated "${name}" — live package: "${(livePkg && livePkg.name) || 'Main'}".`, '#22c55e');
  } else if (livePkg && openPkg && livePkg.id !== openPkg.id) {
    // Say WHICH package the star made live — when the open tab isn't the starred one it's
    // easy to think the save "didn't work".
    showToast(`Saved. Live package: "${livePkg.name}" (star) — you were editing "${openPkg.name}". Click a tab's star to make it the live one.`, '#fbbf24', 7000);
  } else {
    const isActiveKit = editingBrandId && currentState && currentState.activeBrandKitId === editingBrandId;
    showToast(isActiveKit
      ? `Saved — live package: "${(livePkg && livePkg.name) || 'Main'}".`
      : `Saved "${name}" — NOT on air. Use Save & Activate (or the profile's Activate button) to put it on screen.`, isActiveKit ? '#22c55e' : '#fbbf24', 6000);
  }
  resetBrandForm();
  closeBrandEditor();
}
el('btn-save-brand')?.addEventListener('click', () => saveBrandKitFromEditor(false));
el('btn-save-activate-brand')?.addEventListener('click', () => saveBrandKitFromEditor(true));

// Brand package bar buttons.
el('btn-add-package')?.addEventListener('click', addBrandPackage);
el('btn-dup-package')?.addEventListener('click', duplicateBrandPackage);
el('btn-rename-package')?.addEventListener('click', renameBrandPackage);
el('btn-del-package')?.addEventListener('click', deleteBrandPackage);

// Brand editor modal — opened by "+ New Brand Kit" and each kit's Edit button.
function openBrandEditor() {
  const m = el('brand-editor-modal');
  if (!m) return;
  // The editor lives inside the Assets▸Profiles panel (display:none on other tabs). Lift it to <body>
  // so it opens from anywhere — e.g. the Dashboard brand-kit strip — not just the Profiles page.
  if (m.parentElement !== document.body) document.body.appendChild(m);
  m.style.display = 'flex';
}
function closeBrandEditor() { const m = el('brand-editor-modal'); if (m) m.style.display = 'none'; }
el('btn-open-new-brand')?.addEventListener('click', () => { resetBrandForm(); openBrandEditor(); });
el('btn-import-brand-kit')?.addEventListener('click', () => send('import_brand_kit'));
el('btn-export-brand-kit')?.addEventListener('click', () => {
  if (!_brandExportTargetId) { showToast('Pick a profile first — activate one, or hit Export on its row.', '#fbbf24', 5000); return; }
  send('export_brand_kit', { id: _brandExportTargetId });
});
// Export from inside the editor — the kit you're looking at, no hunting for its row. A kit that
// has never been saved has no id on the server to export, so send it there first.
el('btn-export-brand-editor')?.addEventListener('click', () => {
  if (!editingBrandId) { showToast('Save this brand kit first — there is nothing on disk to export yet.', '#fbbf24', 5000); return; }
  send('export_brand_kit', { id: editingBrandId });
});
el('brand-editor-close')?.addEventListener('click', () => { resetBrandForm(); closeBrandEditor(); });
el('brand-editor-modal')?.addEventListener('click', (e) => { if (e.target === el('brand-editor-modal')) { resetBrandForm(); closeBrandEditor(); } });

['select-active-brand', 'select-active-brand-main'].forEach((sid) => {
  const sel = el(sid);
  if (sel) sel.addEventListener('change', (e) => send('activate_brand_kit', { id: e.target.value || null }));
});
// Package quick-switch (Profiles + Dashboard) — change the live sponsor package mid-show.
['select-active-package', 'select-active-package-main'].forEach((sid) => {
  const sel = el(sid);
  if (sel) sel.addEventListener('change', (e) => {
    const kitId = currentState && currentState.activeBrandKitId;
    if (kitId) send('activate_brand_package', { kitId, packageId: e.target.value });
  });
});

// ── CS2 Game State Integration ──────────────────────────────────────────────
// One click: the server finds CS2 through Steam and installs the game-data and observer configs.
el('btn-csgo-setup')?.addEventListener('click', () => {
  const r = el('csgo-result'); if (r) { r.textContent = 'Looking for CS2 in your Steam libraries...'; r.style.color = ''; }
  send('csgo_setup', {});
});
el('btn-csgo-launch')?.addEventListener('click', () => send('csgo_launch_observer', {}));
// CS2 Pro HUD radar position/size (1920x1080 px). Default = the layout's own spot.
const CS2_RADAR_DEFAULT = { wide: { x: 18, y: 34, size: 380 }, stacked: { x: 1522, y: 34, size: 380 } };
function cs2RadarSend() {
  const v = (id) => Number(el(id)?.value);
  send('csgo_radar_layout', { layout: { x: v('cs2-radar-x'), y: v('cs2-radar-y'), size: v('cs2-radar-size') } });
}
['cs2-radar-x', 'cs2-radar-y', 'cs2-radar-size'].forEach((id) => el(id)?.addEventListener('change', cs2RadarSend));
el('cs2-radar-reset')?.addEventListener('click', () => send('csgo_radar_layout', { layout: null }));
el('check-csgo-auto-hud')?.addEventListener('change', (e) => send('csgo_auto_hud', { enabled: !!e.target.checked }));
el('check-csgo-observer-assist')?.addEventListener('change', (e) => send('csgo_observer_assist', { enabled: !!e.target.checked }));
el('btn-csgo-install')?.addEventListener('click', () => {
  const p = (el('input-csgo-path')?.value || '').trim();
  if (!p) { showToast('Paste the CS2 folder first.', '#ef4444'); return; }
  send('csgo_setup', { path: p });
});

el('btn-csgo-spectator')?.addEventListener('click', () => {
  // Reuses the same folder path as the GSI install (server falls back to the saved path).
  send('install_spectator_cfg', { path: (el('input-csgo-path')?.value || '').trim() });
});

el('check-csgo-auto-winner')?.addEventListener('change', (e) => {
  send('csgo_auto_winner', { enabled: !!e.target.checked });
});
el('check-csgo-history')?.addEventListener('change', (e) => {
  send('csgo_show_history', { visible: !!e.target.checked });
});

el('check-csgo-builtin-radar')?.addEventListener('change', (e) => {
  send('csgo_radar_mode', { builtin: !!e.target.checked });
});

// CS2 Pro HUD layout (one click, live on air).
el('csgo-pro-layout-seg')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-layout]'); if (!b) return;
  send('csgo_pro_layout', { layout: b.dataset.layout });
});
// Suggest mode = Director auto-switch off (same setting as Production > Director).
el('csgo-director-mode-seg')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  send('set_director', { autoSwitch: b.dataset.mode === 'auto' });
});
// The CS2 HUD over the game: ONE window. Observer Assist is part of it (toggle above), not a second
// window. Opens whichever CS2 HUD design is selected.
el('btn-csgo-observer-assist')?.addEventListener('click', () => {
  const msgEl = el('csgo-observer-msg');
  const say = (t, ok) => { if (msgEl) { msgEl.textContent = t; msgEl.style.color = ok ? '#9ae6b4' : '#f56565'; } };
  const pro = ((currentState && currentState.themesByGame && currentState.themesByGame.csgo) || '') === 'cs2-pro';
  const hud = pro ? '/cs2-pro.html' : '/csgo.html';
  if (!window.electronAPI || !window.electronAPI.openGameOverlay) {
    say('Over-game windows only work in the desktop app.', false);
    return;
  }
  window.electronAPI.openGameOverlay({ url: SCENE_BASE_URL + hud, path: hud, name: pro ? 'CS2 Pro HUD' : 'CS2 HUD', nativeW: 1920, nativeH: 1080 })
    .then((r) => say(r && r.ok ? 'The HUD is open over the game. Run CS2 in borderless or windowed mode. Point at any part of it to see through it. Ctrl+Shift+F10 hides it all; Ctrl+Shift+F9 to move, resize or make it see-through.' : 'Could not open the HUD over the game.', !!(r && r.ok)))
    .catch(() => say('Could not open the HUD over the game.', false));
});
// Cinematic freezetime camera.
el('check-csgo-cinematic')?.addEventListener('change', (e) => {
  send('csgo_cinematic_set', { enabled: !!e.target.checked, port: Number(el('input-csgo-netcon-port')?.value) || 2121 });
});
el('input-csgo-netcon-port')?.addEventListener('change', (e) => {
  const port = Math.round(Number(e.target.value));
  if (port >= 1024 && port <= 65535) send('csgo_cinematic_set', { port });
});
el('csgo-cine-shots')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cine]'); if (!b) return;
  const idx = Number(b.dataset.idx) || 0;
  const map = el('csgo-cine-shots').dataset.map || '';
  const act = b.dataset.cine;
  if (act === 'from' || act === 'to') send('csgo_cinematic_capture', { map, idx, which: act });
  else if (act === 'preview') send('csgo_cinematic_preview', { map, idx });
  else if (act === 'reset') send('csgo_cinematic_reset', { map, idx });
});

// Auto-hide RL native UI was REMOVED (2026-08) — Rocket League now has its own in-game "Hide UI"
// option, so the suite no longer presses/commands the HUD off. applyRlSpectatorUi is a no-op kept
// only so the message dispatcher's call site stays valid for older state payloads.
function applyRlSpectatorUi() { /* removed — game handles UI hiding natively now */ }

// Copy the DefaultStatsAPI.ini contents to the clipboard for the RL Stats API setup.
el('btn-rl-copy-ini')?.addEventListener('click', async () => {
  const txt = (el('rl-ini-text')?.textContent || '').trim();
  const btn = el('btn-rl-copy-ini');
  try {
    await navigator.clipboard.writeText(txt + '\n');
    if (btn) { const o = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = o; }, 1600); }
  } catch (e) {
    if (typeof showToast === 'function') showToast('Copy failed — select the text manually', '#c53030', 3000);
  }
});

function applyValorantState(data) {
  const val = data.valorant || {};
  const conn = el('val-conn');
  if (conn) {
    const connected = !!val.connected;
    // Name the RELAY, not the game. Valorant has no first-party feed, so "waiting" always means
    // the Overwolf relay has not reported — the producer's next move is on that PC, not this one.
    const where = val.map && val.map.displayName ? (' — ' + val.map.displayName +
      ' ' + (val.order && val.order.score || 0) + '-' + (val.chaos && val.chaos.score || 0)) : '';
    conn.textContent = connected ? ('Valorant: relay live' + where) : 'Valorant: waiting for the Overwolf relay';
    conn.className = 'prod-chip' + (connected ? ' ok' : '');
  }
}

function applyLolState(data) {
  const lol = data.lol || {};
  const conn = el('lol-conn');
  if (conn) {
    const connected = !!lol.connected;
    conn.textContent = connected ? 'League: connected' : 'League: waiting';
    conn.className = 'prod-chip' + (connected ? ' ok' : '');
  }
  // reflect the saved teamfight-transition mode on the segmented control
  const mode = lol.hudMode || 'auto';
  document.querySelectorAll('#lol-hud-mode .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

  // OCR gold override — toggle, monitor, region inputs, calibration boxes, status
  const ocr = lol.ocr || {};
  const enEl = el('lol-ocr-enable');
  if (enEl && document.activeElement !== enEl) enEl.checked = !!ocr.enabled;
  const dispEl = el('lol-ocr-display');
  if (dispEl && document.activeElement !== dispEl && !_lolCal.drag) {
    if (!dispEl.options.length && !_lolCal.displaysAsked) { _lolCal.displaysAsked = true; send('lol_ocr_displays', {}); }
    if (dispEl.options.length && dispEl.value !== (ocr.displayId || '')) {
      const has = Array.from(dispEl.options).some((o) => o.value === (ocr.displayId || ''));
      dispEl.value = has ? (ocr.displayId || '') : '';
    }
  }
  const r = ocr.regions || {};
  if (!_lolCal.drag) {
    const setReg = (id, v) => { const e = el(id); if (e && document.activeElement !== e && v != null) e.value = v; };
    if (r.blue) { setReg('lol-ocr-bx', r.blue.x); setReg('lol-ocr-by', r.blue.y); setReg('lol-ocr-bw', r.blue.w); setReg('lol-ocr-bh', r.blue.h); }
    if (r.red)  { setReg('lol-ocr-rx', r.red.x);  setReg('lol-ocr-ry', r.red.y);  setReg('lol-ocr-rw', r.red.w);  setReg('lol-ocr-rh', r.red.h); }
    if (r.blue && r.red) { _lolCal.regions = { blue: { ...r.blue }, red: { ...r.red } }; lolCalRender(); }
  }
  lolOcrStatus(ocr.status || 'off', ocr.statusDetail || '', ocr.lastBlue, ocr.lastRed, { blueConf: ocr.lastBlueConf, redConf: ocr.lastRedConf, reason: ocr.lastReason, source: ocr.source });
}

// Apex LiveAPI — connection + server status chips + scoring/teams/series panels.
let _apexSavedTeams = [];
function applyApexState(data) {
  const apex = data.apex || {};
  // Official results card.
  const pg = apex.postgame || {};
  const chip = el('apex-token-chip');
  if (chip) { chip.textContent = pg.hasToken ? 'Token saved' : 'No token'; chip.classList.toggle('ok', !!pg.hasToken); }
  const pgl = el('apex-pg-list');
  if (pgl) {
    const ms = Array.isArray(pg.matches) ? pg.matches : [];
    const sig = JSON.stringify([pg.lastPullAt, ms.length, pg.lastError]);
    if (pgl._sig !== sig) {
      pgl._sig = sig;
      pgl.innerHTML = ms.length ? ms.map((m, i) => '<div style="padding:4px 0; border-bottom:1px solid var(--border);"><b>Match ' + (i + 1) + '</b> · ' + escapeHtml(m.map || 'map unknown')
        + (m.startedAt ? ' · ' + new Date(m.startedAt).toLocaleString() : '') + ' · ' + m.teams + ' teams · winner <b>' + escapeHtml(m.winner || '?') + '</b></div>').join('')
        : (pg.lastError ? escapeHtml(pg.lastError) : (pg.lastPullAt ? 'No matches yet.' : ''));
    }
  }
  const auto = el('apex-pg-auto');
  if (auto && document.activeElement !== auto) auto.checked = !!(pg.auto && pg.auto.on);
  const last = el('apex-pg-last');
  if (last) last.textContent = pg.lastPullAt
    ? 'Last ' + (pg.source === 'file' ? 'import' : 'pull') + ' ' + new Date(pg.lastPullAt).toLocaleTimeString()
    : '';
  if (Array.isArray(data.savedTeams)) _apexSavedTeams = data.savedTeams;
  const conn = el('apex-conn');
  if (conn) {
    const connected = !!apex.connected;
    conn.textContent = connected ? 'Apex: connected' : 'Apex: waiting';
    conn.className = 'prod-chip' + (connected ? ' ok' : '');
  }
  const srv = el('apex-server-chip');
  if (srv) {
    const running = (data.activeGame || '') === 'apex';
    srv.textContent = running ? ('Server: on :' + (apex.port || 7777)) : 'Server: stopped';
    srv.className = 'prod-chip' + (running ? ' ok' : '');
  }
  // Scoring table — only overwrite inputs when the user isn't editing them.
  const sc = apex.scoring;
  if (sc && Array.isArray(sc.placementPoints)) {
    apexBuildPlaceGrid(sc.placementPoints);
    // The table sits in a closed disclosure; its summary line says what is scoring now.
    const sum = el('apex-points-sum');
    if (sum) sum.textContent = sc.placementPoints.slice(0, 10).join('-') + (sc.placementPoints.length > 10 ? '...' : '')
      + ' · ' + (sc.killPoints != null ? sc.killPoints : 1) + ' per kill' + (sc.killCap ? ' (max ' + sc.killCap + ')' : '');
    const kp = el('apex-kill-pts'); if (kp && document.activeElement !== kp) kp.value = sc.killPoints != null ? sc.killPoints : 1;
    const kc = el('apex-kill-cap'); if (kc && document.activeElement !== kc) kc.value = sc.killCap || 0;
    // Presets: ALGS (built in) + the producer's leagues; the current table's name is selected.
    const ps = el('apex-preset');
    if (ps && document.activeElement !== ps) {
      const names = ['ALGS'].concat((apex.scoringPresets || []).map((p) => p.name));
      const cur = sc.name || 'ALGS';
      const sig = names.join('|') + '#' + cur;
      if (ps._sig !== sig) {
        ps._sig = sig;
        ps.innerHTML = names.map((n) => '<option value="' + esc(n) + '">' + esc(n) + (n === 'ALGS' ? ' (built in)' : '') + '</option>').join('')
          + (names.indexOf(cur) < 0 ? '<option value="' + esc(cur) + '">' + esc(cur) + ' (not saved)</option>' : '');
        ps.value = cur;
      }
      const del = el('apex-preset-delete'); if (del) del.disabled = cur === 'ALGS' || names.indexOf(cur) < 0;
    }
  }
  // Event branding
  const ev = apex.event || {};
  [['apex-ev-title','title'],['apex-ev-split','split'],['apex-ev-match','match']].forEach(([id,k]) => {
    const e = el(id); if (e && document.activeElement !== e) e.value = ev[k] || '';
  });
  // Series game list
  apexRenderGames(apex.games || []);
  // Team identity mapping rows (from the current standings)
  apexRenderTeamMap(apex.standings || [], apex.teamMap || {});
}

let _apexPlaceGridBuilt = false;
function apexBuildPlaceGrid(points) {
  const grid = el('apex-place-grid'); if (!grid) return;
  if (!_apexPlaceGridBuilt) {
    grid.innerHTML = points.map((v, i) =>
      '<label style="font-size:10px;color:var(--muted);text-align:center;">' + (i + 1) +
      '<input type="number" class="input-text apex-pp" data-i="' + i + '" value="' + v + '" min="0" step="1" style="width:100%;padding:4px;text-align:center;"></label>'
    ).join('');
    _apexPlaceGridBuilt = true;
  } else if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('apex-pp')) {
    return; // don't clobber mid-edit
  } else {
    grid.querySelectorAll('.apex-pp').forEach((inp) => { const i = +inp.dataset.i; if (points[i] != null) inp.value = points[i]; });
  }
}

function apexRenderGames(games) {
  const box = el('apex-games-list'); if (!box) return;
  if (!games.length) { box.textContent = 'No games recorded yet.'; return; }
  box.innerHTML = games.map((g, i) => {
    const win = (g.results || []).slice().sort((a, b) => (a.placement || 99) - (b.placement || 99))[0];
    return '<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.06);">' +
      '<strong style="color:#e0e0e0;">Game ' + g.n + '</strong>' +
      '<span>' + (g.map || '') + '</span>' +
      '<span style="color:#86efac;">Winner: ' + (win ? (win.name || '') : '—') + '</span>' +
      '<button class="btn btn-secondary btn-sm apex-rm-game" data-i="' + i + '" style="margin-left:auto;">Remove</button>' +
    '</div>';
  }).join('');
  box.querySelectorAll('.apex-rm-game').forEach((b) => b.addEventListener('click', async () => {
    if (!await customConfirm('Remove game', `Remove game ${(+b.dataset.i) + 1} and its placements and kills from the series standings?`, 'Remove')) return;
    send('apex_remove_game', { index: +b.dataset.i });
  }));
}

function apexRenderTeamMap(standings, teamMap) {
  const box = el('apex-teammap'); if (!box) return;
  if (!standings.length) { box.innerHTML = '<p class="field-hint" style="margin:0;">Set the active game to Apex and start a lobby — the squads will appear here to map.</p>'; return; }
  const norm = (s) => String(s || '').trim().toLowerCase();
  const opts = ['<option value="">— auto-match —</option>'].concat(
    _apexSavedTeams.map((t) => '<option value="' + encodeURIComponent(t.name) + '">' + (t.name || '') + '</option>')
  ).join('');
  box.innerHTML = standings.slice(0, 20).map((r) => {
    const bound = teamMap[r.key] || '';
    const auto = _apexSavedTeams.find((t) => norm(t.name) === norm(r.name));
    const status = bound ? 'bound' : (auto ? 'auto: ' + auto.name : 'no match');
    return '<div style="display:flex;align-items:center;gap:10px;">' +
      '<span style="width:150px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (r.name || r.key) + '</span>' +
      '<select class="input-select apex-tm" data-key="' + encodeURIComponent(r.key) + '" style="width:220px;">' + opts + '</select>' +
      '<span class="field-hint" style="margin:0;color:' + (bound || auto ? '#86efac' : '#f5a3a3') + ';">' + status + '</span>' +
    '</div>';
  }).join('');
  box.querySelectorAll('.apex-tm').forEach((sel) => {
    const key = decodeURIComponent(sel.dataset.key);
    if (teamMap[key]) sel.value = encodeURIComponent(teamMap[key]);
    sel.addEventListener('change', () => send('apex_set_teammap', { key, savedName: sel.value ? decodeURIComponent(sel.value) : '' }));
  });
}

function wireApexScoring() {
  const saveSc = el('apex-save-scoring');
  if (saveSc) saveSc.addEventListener('click', () => {
    const placementPoints = Array.from(document.querySelectorAll('#apex-place-grid .apex-pp')).sort((a, b) => a.dataset.i - b.dataset.i).map((i) => +i.value || 0);
    const killPoints = +(el('apex-kill-pts') || {}).value || 0;
    const killCap = +(el('apex-kill-cap') || {}).value || 0;
    send('apex_set_scoring', { placementPoints, killPoints, killCap });
    const st = el('apex-scoring-status'); if (st) { st.textContent = 'Saved.'; st.style.color = '#86efac'; setTimeout(() => st.textContent = '', 1500); }
  });
  const resetSc = el('apex-reset-scoring');
  if (resetSc) resetSc.addEventListener('click', () => {
    send('apex_scoring_preset', { op: 'apply', name: 'ALGS' });
    _apexPlaceGridBuilt = false;
  });
  // Scoring presets: switch league, save the table under a name, delete one, or paste rules text.
  el('apex-preset')?.addEventListener('change', function () { send('apex_scoring_preset', { op: 'apply', name: this.value }); _apexPlaceGridBuilt = false; });
  el('apex-preset-save')?.addEventListener('click', () => {
    const cur = ((currentState.apex || {}).scoring || {}).name || '';
    customPrompt('Save scoring preset', 'Name this scoring table (for example the league or series). The same name replaces it.', cur && cur !== 'ALGS' ? cur : '', 'Save').then((v) => {
      if (v == null || !String(v).trim()) return;
      // Save what is on screen first, so unsaved edits are part of the preset.
      el('apex-save-scoring')?.click();
      setTimeout(() => send('apex_scoring_preset', { op: 'save', name: String(v).trim() }), 150);
    });
  });
  el('apex-preset-delete')?.addEventListener('click', () => {
    const n = (el('apex-preset') || {}).value;
    if (!n || n === 'ALGS') return;
    appConfirm('Delete the scoring preset "' + n + '"? Games already played keep their results; standings use whatever table is selected.', 'Delete').then((ok) => { if (ok) send('apex_scoring_preset', { op: 'delete', name: n }); });
  });
  el('apex-preset-paste')?.addEventListener('click', () => {
    customPrompt('Paste scoring rules', 'Paste the league\'s scoring lines, for example:  Kills = 1pt   1st place = 12pts   6th-10th Place = 3pts', '', 'Fill table').then((v) => {
      if (v == null || !String(v).trim()) return;
      _apexPlaceGridBuilt = false;
      send('apex_set_scoring', { text: String(v), name: 'Custom' });
      const box = el('apex-points-edit'); if (box) box.open = true;
    });
  });
  const saveEv = el('apex-save-event');
  if (saveEv) saveEv.addEventListener('click', () => send('apex_set_event', {
    title: (el('apex-ev-title') || {}).value || '', split: (el('apex-ev-split') || {}).value || '', match: (el('apex-ev-match') || {}).value || ''
  }));
  const fin = el('apex-finalize-game'); if (fin) fin.addEventListener('click', () => send('apex_finalize_game', {}));
  const rs = el('apex-reset-series'); if (rs) rs.addEventListener('click', () => { if (confirm('Reset the whole series? All recorded games and points will be cleared.')) send('apex_reset_series', {}); });
  // Official results: EA stats token + post-game pull (backend/apex-postgame.js).
  el('apex-save-token')?.addEventListener('click', () => {
    const inp = el('apex-stats-token'); const v = (inp && inp.value || '').trim();
    if (!v) { showToast('Paste the stats token first.', '#fbbf24', 4000); return; }
    send('apex_set_stats_token', { token: v }); inp.value = '';
  });
  el('apex-clear-token')?.addEventListener('click', () => {
    appConfirm('Remove the saved stats token?', 'Remove').then((ok) => { if (ok) send('apex_set_stats_token', { clear: true }); });
  });
  // Pull, import and auto-pull can all replace the series games: ask first when there are
  // live-recorded games to replace.
  const confirmReplace = (series) => {
    const live = ((currentState.apex && currentState.apex.games) || []).filter((g) => !g.official).length;
    return series && live ? appConfirm('Replace the ' + live + ' game' + (live === 1 ? '' : 's') + ' recorded from the live feed with EA\'s official results?', 'Replace') : Promise.resolve(true);
  };
  el('apex-pull-results')?.addEventListener('click', () => {
    const series = !!(el('apex-pg-series') && el('apex-pg-series').checked);
    confirmReplace(series).then((ok) => {
      if (!ok) return;
      const st = el('apex-pg-status'); if (st) st.textContent = 'Asking EA...';
      send('apex_pull_results', { useForSeries: series });
    });
  });
  el('apex-pg-auto')?.addEventListener('change', (e) => {
    const box = e.target; const on = !!box.checked;
    const series = !!(el('apex-pg-series') && el('apex-pg-series').checked);
    if (on && !(currentState.apex && currentState.apex.postgame && currentState.apex.postgame.hasToken)) {
      box.checked = false; showToast('Save your stats token first.', '#fbbf24', 4000); return;
    }
    (on ? confirmReplace(series) : Promise.resolve(true)).then((ok) => {
      if (!ok) { box.checked = false; return; }
      send('apex_set_autopull', { on, useForSeries: series });
    });
  });
  el('apex-import-results')?.addEventListener('click', () => { const f = el('apex-import-file'); if (f) { f.value = ''; f.click(); } });
  el('apex-import-file')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 20e6) { showToast('That file is too large to be an Apex results file.', '#f56565', 6000); return; }
    const series = !!(el('apex-pg-series') && el('apex-pg-series').checked);
    confirmReplace(series).then((ok) => {
      if (!ok) return;
      file.text().then((text) => {
        const st = el('apex-pg-status'); if (st) st.textContent = 'Importing...';
        send('apex_import_results', { json: text, useForSeries: series });
      }, () => showToast('Could not read that file.', '#f56565', 6000));
    });
  });
}

// Fetch the LiveAPI details once (launch string + config path) and fill the setup card.
let _apexSetupLoaded = false;
async function loadApexSetup() {
  if (_apexSetupLoaded) return; _apexSetupLoaded = true;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/apex/liveapi');
    const d = await r.json();
    const launch = el('apex-launch'); if (launch && d.launchOptions) launch.textContent = d.launchOptions;
    const pathEl = el('apex-config-path'); if (pathEl && d.configPath) pathEl.textContent = d.configPath;
    const addr = el('apex-ws-addr'); if (addr && d.port) addr.textContent = 'ws://127.0.0.1:' + d.port;
  } catch (e) { /* server not up yet — chips still work off state */ }
}

function wireApexSetup() {
  const writeBtn = el('apex-write-config');
  if (writeBtn) writeBtn.addEventListener('click', async () => {
    const status = el('apex-config-status');
    if (status) { status.textContent = 'Writing…'; status.style.color = ''; }
    try {
      const r = await fetch('http://127.0.0.1:3000/api/apex/liveapi/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (d.ok) { if (status) { status.textContent = 'Wrote ' + d.file + ' — restart Apex.'; status.style.color = '#86efac'; } }
      else { if (status) { status.textContent = 'Failed: ' + (d.error || 'unknown') + ' (use Option B instead)'; status.style.color = '#f5a3a3'; } }
    } catch (e) {
      if (status) { status.textContent = 'Failed: ' + e.message + ' (use Option B instead)'; status.style.color = '#f5a3a3'; }
    }
  });
  const copyBtn = el('apex-copy-launch');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const txt = (el('apex-launch') || {}).textContent || '';
    try { await navigator.clipboard.writeText(txt); copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy', 1200); } catch (e) {}
  });
}

// extra = { blueConf, redConf, reason:{blue,red}, source } from the server's lol_ocr_status / state.
function lolOcrStatus(status, detail, lastBlue, lastRed, extra) {
  const x = extra || {};
  const chip = el('lol-ocr-status');
  if (chip) {
    const map = { off: 'OCR: off', starting: 'OCR: starting…', reading: 'OCR: locked', holding: 'OCR: holding last good read', searching: 'OCR: searching', error: 'OCR: error', unavailable: 'OCR: unavailable' };
    chip.textContent = map[status] || ('OCR: ' + status);
    chip.className = 'prod-chip' + (status === 'reading' ? ' ok' : (status === 'error' || status === 'unavailable' ? ' warn' : ''));
    chip.title = detail || '';
  }
  const read = el('lol-ocr-read');
  if (read) {
    const REASON = { lowconf: 'unsure', jump: 'jump held', decrease: 'drop held', noread: 'no read', range: 'out of range', reset: 'new game' };
    const side = (v, conf, reason) => {
      let s = v == null ? '—' : String(v);
      if (conf != null && v != null) s += ' (' + Math.round(conf) + '%)';
      if (reason && REASON[reason]) s += ' · ' + REASON[reason];
      return s;
    };
    if (lastBlue != null || lastRed != null) {
      read.textContent = 'blue ' + side(lastBlue, x.blueConf, x.reason && x.reason.blue) + '   /   red ' + side(lastRed, x.redConf, x.reason && x.reason.red)
        + (x.source === 'ocr' ? '   · driving the overlay' : '');
    } else if (detail) read.textContent = detail;
  }
}

function sendLolOcrConfig() {
  const num = (id) => { const v = Number(el(id)?.value); return isNaN(v) ? undefined : v; };
  send('lol_ocr_config', {
    enabled: !!el('lol-ocr-enable')?.checked,
    displayId: el('lol-ocr-display')?.value || '',
    regions: {
      blue: { x: num('lol-ocr-bx'), y: num('lol-ocr-by'), w: num('lol-ocr-bw'), h: num('lol-ocr-bh') },
      red:  { x: num('lol-ocr-rx'), y: num('lol-ocr-ry'), w: num('lol-ocr-rw'), h: num('lol-ocr-rh') }
    }
  });
}
el('lol-ocr-enable')?.addEventListener('change', sendLolOcrConfig);
el('lol-ocr-apply')?.addEventListener('click', () => { sendLolOcrConfig(); lolOcrRequestSnapshot(400); });
el('lol-ocr-display')?.addEventListener('change', () => { sendLolOcrConfig(); lolOcrRequestSnapshot(400); });
el('lol-ocr-details')?.addEventListener('toggle', (e) => { if (e.target.open) send('lol_ocr_displays', {}); });

// ── OCR calibration picture ───────────────────────────────────────────────────
// A snapshot of the chosen monitor with the two capture boxes drawn on it. Regions are kept
// in the monitor's physical pixels; the picture is only scaled for display. Dragging edits
// the local copy, mouse-up sends it (lol_ocr_config) and refreshes the snapshot so the
// per-box previews show what the engine will actually read.
const _lolCal = { w: 0, h: 0, regions: null, side: 'blue', drag: null, displaysAsked: false, snapTimer: null };

function lolOcrMsg(text, bad) {
  const m = el('lol-ocr-msg');
  if (!m) return;
  m.textContent = text || '';
  m.classList.toggle('bad', !!bad);
}

function lolOcrRequestSnapshot(delayMs) {
  if (_lolCal.snapTimer) clearTimeout(_lolCal.snapTimer);
  _lolCal.snapTimer = setTimeout(() => { _lolCal.snapTimer = null; send('lol_ocr_snapshot', {}); }, delayMs || 0);
}

function lolCalScale() {
  const img = el('lol-ocr-shot');
  if (!img || !_lolCal.w || !img.clientWidth) return 0;
  return img.clientWidth / _lolCal.w;
}

function lolCalRender() {
  const k = lolCalScale();
  ['blue', 'red'].forEach((side) => {
    const box = el('lol-ocr-box-' + side);
    if (!box) return;
    const r = _lolCal.regions && _lolCal.regions[side];
    if (!k || !r) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.style.left = (r.x * k) + 'px'; box.style.top = (r.y * k) + 'px';
    box.style.width = Math.max(4, r.w * k) + 'px'; box.style.height = Math.max(4, r.h * k) + 'px';
    box.classList.toggle('active', _lolCal.side === side);
  });
}

function lolCalWriteInputs(side) {
  const r = _lolCal.regions && _lolCal.regions[side];
  if (!r) return;
  const p = side === 'blue' ? 'b' : 'r';
  const set = (k, v) => { const e = el('lol-ocr-' + p + k); if (e) e.value = Math.round(v); };
  set('x', r.x); set('y', r.y); set('w', r.w); set('h', r.h);
}

function lolCalClamp(r) {
  r.w = Math.max(8, Math.min(_lolCal.w, r.w)); r.h = Math.max(8, Math.min(_lolCal.h, r.h));
  r.x = Math.max(0, Math.min(_lolCal.w - r.w, r.x)); r.y = Math.max(0, Math.min(_lolCal.h - r.h, r.y));
  return r;
}

(function wireLolCal() {
  const cal = el('lol-ocr-cal'), shot = el('lol-ocr-shot');
  if (!cal || !shot) return;
  shot.addEventListener('load', () => { cal.classList.add('has-shot'); lolCalRender(); });
  window.addEventListener('resize', () => lolCalRender());
  document.querySelectorAll('#lol-ocr-side .seg-btn').forEach((b) => b.addEventListener('click', () => {
    _lolCal.side = b.dataset.side;
    document.querySelectorAll('#lol-ocr-side .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    lolCalRender();
  }));

  const pos = (ev) => {
    const k = lolCalScale(); const rect = shot.getBoundingClientRect();
    return k ? { x: (ev.clientX - rect.left) / k, y: (ev.clientY - rect.top) / k } : null;
  };
  cal.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !_lolCal.w || !_lolCal.regions) return;
    const p = pos(ev); if (!p) return;
    const k = lolCalScale();
    let mode = 'draw', side = _lolCal.side;
    // Hit test, active side first so overlapping boxes stay grabbable.
    for (const s of [_lolCal.side, _lolCal.side === 'blue' ? 'red' : 'blue']) {
      const r = _lolCal.regions[s];
      if (!r) continue;
      const inside = p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
      const nearCorner = Math.abs(p.x - (r.x + r.w)) * k <= 12 && Math.abs(p.y - (r.y + r.h)) * k <= 12;
      if (nearCorner) { mode = 'resize'; side = s; break; }
      if (inside) { mode = 'move'; side = s; break; }
    }
    const start = mode === 'draw' ? { x: p.x, y: p.y, w: 8, h: 8 } : { ..._lolCal.regions[side] };
    if (mode === 'draw') _lolCal.regions[side] = { ...start };
    _lolCal.drag = { mode, side, p0: p, start };
    _lolCal.side = side;
    document.querySelectorAll('#lol-ocr-side .seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.side === side));
    cal.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  cal.addEventListener('pointermove', (ev) => {
    const d = _lolCal.drag; if (!d) return;
    const p = pos(ev); if (!p) return;
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    let r;
    if (d.mode === 'move') r = { x: d.start.x + dx, y: d.start.y + dy, w: d.start.w, h: d.start.h };
    else if (d.mode === 'resize') r = { x: d.start.x, y: d.start.y, w: d.start.w + dx, h: d.start.h + dy };
    else r = { x: Math.min(d.p0.x, p.x), y: Math.min(d.p0.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
    _lolCal.regions[d.side] = lolCalClamp(r);
    lolCalWriteInputs(d.side);
    lolCalRender();
  });
  const finish = (ev) => {
    const d = _lolCal.drag; if (!d) return;
    _lolCal.drag = null;
    try { cal.releasePointerCapture(ev.pointerId); } catch (e) {}
    lolCalWriteInputs(d.side);
    sendLolOcrConfig();
    lolOcrRequestSnapshot(350);
  };
  cal.addEventListener('pointerup', finish);
  cal.addEventListener('pointercancel', finish);

  el('lol-ocr-snapshot')?.addEventListener('click', () => { lolOcrMsg('Taking a snapshot…'); send('lol_ocr_snapshot', {}); });
  el('lol-ocr-autolocate')?.addEventListener('click', () => {
    lolOcrMsg('Looking for the gold numbers on the top of the screen…');
    const b = el('lol-ocr-autolocate'); if (b) b.disabled = true;
    send('lol_ocr_autolocate', {});
    setTimeout(() => { if (b) b.disabled = false; }, 8000);
  });
})();

function onLolOcrDisplays(msg) {
  const sel = el('lol-ocr-display');
  if (!sel) return;
  const list = Array.isArray(msg.displays) ? msg.displays : [];
  const cur = sel.value || msg.current || '';
  sel.innerHTML = '';
  if (!list.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'Primary display'; sel.appendChild(o); }
  list.forEach((d) => {
    const o = document.createElement('option');
    o.value = d.primary ? '' : d.id;
    o.textContent = d.label;
    sel.appendChild(o);
  });
  const has = Array.from(sel.options).some((o) => o.value === cur);
  sel.value = has ? cur : '';
}

function onLolOcrSnapshot(msg) {
  if (!msg.ok) { lolOcrMsg(msg.message || 'Snapshot failed.', true); return; }
  _lolCal.w = msg.width || 0; _lolCal.h = msg.height || 0;
  const shot = el('lol-ocr-shot');
  if (shot && msg.image) shot.src = msg.image;
  ['blue', 'red'].forEach((side) => {
    const img = el('lol-ocr-prev-' + side), txt = el('lol-ocr-prev-' + side + '-txt');
    const s = msg[side];
    if (img) { if (s && s.png) { img.src = s.png; img.style.display = ''; } else img.style.display = 'none'; }
    if (txt) {
      if (!s) txt.textContent = '';
      else if (s.error) txt.textContent = s.error;
      else txt.textContent = (s.text ? 'read "' + s.text + '"' : 'nothing read') + (s.value != null ? ' = ' + s.value : '') + ' · ' + (s.confidence || 0) + '% sure' + (s.pass === 'binary' ? ' (binarised)' : '');
    }
  });
  lolOcrMsg('');
  lolCalRender();
}

function onLolOcrAutolocate(msg) {
  const b = el('lol-ocr-autolocate'); if (b) b.disabled = false;
  if (!msg.ok) { lolOcrMsg(msg.message || 'Auto-detect could not find the gold numbers.', true); return; }
  const w = msg.words || {};
  lolOcrMsg('Found blue "' + ((w.blue && w.blue.text) || '?') + '" and red "' + ((w.red && w.red.text) || '?') + '". Boxes saved — check the snapshot.');
  lolOcrRequestSnapshot(200);
}

function applyCsgoState(data) {
  const cs = data.csgo || {};
  const pathEl = el('input-csgo-path');
  if (pathEl && document.activeElement !== pathEl && cs.cfgPath) pathEl.value = cs.cfgPath;

  const conn = el('csgo-conn');
  if (conn) {
    conn.textContent = cs.connected ? 'Receiving' : 'Waiting';
    conn.className = 'prod-chip' + (cs.connected ? ' ok' : '');
  }
  // One-click setup checklist: each step goes green when it is done.
  const setupEl = el('cs2-setup');
  if (setupEl) {
    const c = cs.cinematic || {};
    const consoleOn = c.status === 'connected';
    const step = (k, done) => setupEl.querySelector('[data-step="' + k + '"]')?.classList.toggle('is-done', !!done);
    step('cfg', !!cs.cfgPath); step('console', consoleOn); step('hud', !!cs.cfgPath); step('live', !!cs.connected);
    const t = (id, v) => { const x = el(id); if (x) x.textContent = v; };
    t('cs2-step-cfg', cs.cfgPath ? 'Installed in ' + cs.cfgPath : 'Not set up yet.');
    t('cs2-step-console', consoleOn ? 'Connected. The app can hide the HUD and move the camera.'
      : (c.status === 'waiting' ? 'Not open. Current CS2 builds may not open their console even with -netconport, so cinematic camera moves can be unavailable. The clean observer view does not need it.' : 'Lets the app move the camera for cinematic shots.'));
    t('cs2-step-live', cs.connected ? 'Game data is coming in.' : 'Spectate a match in CS2 and the overlay fills in.');
    const sb = el('btn-csgo-setup'); if (sb) sb.textContent = cs.cfgPath ? 'Set up again' : 'Set up CS2';
    const ah = el('check-csgo-auto-hud'); if (ah && document.activeElement !== ah) ah.checked = cs.autoHud !== false;
  }
  const oa = el('check-csgo-observer-assist'); if (oa && document.activeElement !== oa) oa.checked = cs.observerAssist !== false;
  const rl = cs.radarLayout || CS2_RADAR_DEFAULT[cs.proLayout === 'stacked' ? 'stacked' : 'wide'];
  [['cs2-radar-x', rl.x], ['cs2-radar-y', rl.y], ['cs2-radar-size', rl.size]].forEach(([id, val]) => { const f = el(id); if (f && document.activeElement !== f) f.value = val; });
  const rr = el('cs2-radar-reset'); if (rr) rr.disabled = !cs.radarLayout;

  const awEl = el('check-csgo-auto-winner');
  if (awEl && document.activeElement !== awEl) awEl.checked = cs.autoWinner !== false;
  const histEl = el('check-csgo-history');
  if (histEl && document.activeElement !== histEl) histEl.checked = !!cs.showHistory;

  const radarEl = el('check-csgo-builtin-radar');
  if (radarEl && document.activeElement !== radarEl) radarEl.checked = !!cs.builtinRadar;

  el('csgo-pro-layout-seg')?.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === (cs.proLayout === 'stacked' ? 'stacked' : 'wide')));
  const auto = !!(data.director && data.director.autoSwitch);
  el('csgo-director-mode-seg')?.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', (b.dataset.mode === 'auto') === auto));
  renderCsgoCinematic(cs);
}

// Cinematic freezetime panel: toggle, port, console status + the two shots for the loaded map.
function renderCsgoCinematic(cs) {
  const c = (cs && cs.cinematic) || {};
  const chk = el('check-csgo-cinematic');
  if (chk && document.activeElement !== chk) chk.checked = !!c.enabled;
  const portEl = el('input-csgo-netcon-port');
  if (portEl && document.activeElement !== portEl && c.port) portEl.value = c.port;
  const launch = el('csgo-netcon-launch'); if (launch) launch.textContent = '-netconport ' + (c.port || 2121);
  const chip = el('csgo-cinematic-conn');
  if (chip) {
    const st = c.status || 'off';
    chip.textContent = st === 'connected' ? (c.playing ? 'Playing: ' + (c.playing.name || 'shot') : 'Console: connected') : st === 'waiting' ? 'Console: waiting for CS2' : 'Console: off';
    chip.className = 'prod-chip' + (st === 'connected' ? ' ok' : '');
    chip.title = c.statusDetail || '';
  }
  const map = (cs && cs.map && cs.map.name) || '';
  const mapEl = el('csgo-cine-map'); if (mapEl) mapEl.textContent = map || 'the current map (load one in CS2)';
  const box = el('csgo-cine-shots'); if (!box) return;
  const custom = (c.shots && c.shots[map]) || [];
  const live = c.enabled && c.status === 'connected';
  const fmt = (p) => p ? Math.round(p.x) + ', ' + Math.round(p.y) + ', ' + Math.round(p.z) : '';
  const html = !map ? '<p class="gh-hint">Load a map in CS2 (spectating) to capture shots for it.</p>' : [0, 1].map((i) => {
    const sh = custom[i] && custom[i].from ? custom[i] : null;
    const desc = sh ? 'Your shot: ' + fmt(sh.from) + (sh.to && sh.to !== sh.from ? ' to ' + fmt(sh.to) : '') : 'Starter shot above ' + (i ? 'B' : 'A') + ' site';
    const dis = live ? '' : ' disabled';
    return '<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:6px 0; border-top:1px solid var(--border);">'
      + '<b style="min-width:52px;">Shot ' + (i + 1) + '</b><span class="gh-hint" style="flex:1; min-width:180px;">' + tlEsc(desc) + '</span>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-cine="from" data-idx="' + i + '"' + dis + ' title="Use the CS2 spectator camera position right now as where this shot starts">Capture start</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-cine="to" data-idx="' + i + '"' + dis + ' title="Use the CS2 spectator camera position right now as where this shot ends">Capture end</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-cine="preview" data-idx="' + i + '"' + dis + '>Preview</button>'
      + (sh ? '<button type="button" class="btn btn-ghost btn-sm" data-cine="reset" data-idx="' + i + '">Use starter</button>' : '')
      + '</div>';
  }).join('');
  if (box.dataset.sig !== html) { box.dataset.sig = html; box.innerHTML = html; }
  box.dataset.map = map;
}

// ── OBS settings ────────────────────────────────────────────────────────────
const OBS_SCENE_KEYS = ['inGame', 'replay', 'postGame', 'break', 'commercial', 'casters', 'bracket'];
let _lastObsSceneSig = '';

// Apps > Streaming software: the scenes the connected app has, as chips (so a producer can see the
// app is reading their collection, and that Build show scenes added its NE scenes).
function renderSwScenes(obs) {
  const box = el('sw-scenes'), list = el('sw-scene-list');
  if (!box || !list) return;
  const scenes = obs.connected ? (obs.availableScenes || []).filter((n) => !/^═/.test(n)) : [];
  const sig = scenes.join('|') + '#' + (obs.currentScene || '');
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  box.hidden = !scenes.length;
  const c = el('sw-scene-count'); if (c) c.textContent = scenes.length ? String(scenes.length) : '';
  list.innerHTML = scenes.map((n) => '<span class="sw-chip' + (n === obs.currentScene ? ' is-live' : '') + (/^NE /.test(n) ? ' is-ne' : '') + '" title="' + esc(n) + '">' + esc(n) + '</span>').join('');
}
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
    // Kickoff scene automation is NOT included here — it's owned exclusively by
    // sendRlSceneAuto()/set_rl_scene_automation (Match — Teams gear panel) now. This payload used
    // to always include a `kickoff` object read from a hidden, unreachable duplicate control pair,
    // which silently reset the real setting to disabled on every OBS Settings save/test.
    scenes
  };
  const pw = el('input-obs-password')?.value.trim();
  if (pw) payload.password = pw;          // non-empty → update stored password
  else if (el('btn-obs-clear-password')?.dataset.clearing === '1') payload.clearPassword = true;
  // Streamlabs Desktop fills the same slot through its Remote Control API (own address + token).
  const appSel = el('select-obs-app');
  if (appSel) payload.app = appSel.value === 'streamlabs' ? 'streamlabs' : 'obs';
  const sIp = (el('input-slobs-ip')?.value.trim() || '127.0.0.1').replace(/^wss?:\/\//i, '');
  const sPort = el('input-slobs-port')?.value.trim() || '59650';
  payload.slobsUrl = `ws://${sIp}:${sPort}`;
  const tok = el('input-slobs-token')?.value.trim();
  if (tok) payload.slobsToken = tok;
  else if (el('btn-slobs-clear-token')?.dataset.clearing === '1') payload.clearSlobsToken = true;
  return payload;
}

// OBS scene-mapping variant (keeps a stale/unlisted scene selectable). Named distinctly from
// fillSceneSelect above — the two used to share a name and this (later) declaration silently
// shadowed the sig-guarded one, wiping custom first-option labels and rebuilding on every render.
function fillObsSceneSelect(sel, available, current) {
  if (!sel) return;
  const list = Array.isArray(available) ? available.slice() : [];
  if (current && !list.includes(current)) list.push(current);  // keep a stale/unlisted scene selectable
  sel.innerHTML = '<option value="">— None —</option>';
  list.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  sel.value = current;
}

function populateObsSceneSelects(available, mapping, kickoffScene) {
  // Only rebuild when the live scene list or saved mapping changes, so an
  // unsaved selection isn't wiped by an unrelated full_state broadcast.
  const sig = JSON.stringify({ available, mapping, kickoffScene });
  if (sig === _lastObsSceneSig) return;
  _lastObsSceneSig = sig;

  OBS_SCENE_KEYS.forEach(k => {
    fillObsSceneSelect(el(`select-obs-scene-${k}`), available, (mapping && mapping[k]) || '');
  });
  fillObsSceneSelect(el('select-obs-kickoff-scene'), available, kickoffScene || '');
}

// ── RL scene automation (Match ▸ Teams gear panel, Rocket League only) ───────────────────────────
let _lastRlSceneSig = '';
function sendRlSceneAuto() {
  send('set_rl_scene_automation', {
    kickoff: {
      enabled: !!(el('chk-rl-kickoff') && el('chk-rl-kickoff').checked),
      scene: (el('sel-rl-kickoff-scene') || {}).value || ''
    },
    scoreboardScene: {
      enabled: !!(el('chk-rl-sbscene') && el('chk-rl-sbscene').checked),
      scene: (el('sel-rl-sbscene') || {}).value || ''
    },
    postGame: {
      enabled: !!(el('chk-rl-postgame') && el('chk-rl-postgame').checked),
      scene: (el('sel-rl-postgame-scene') || {}).value || '',
      delaySec: Number((el('inp-rl-postgame-delay') || {}).value) || 20
    }
  });
}
function wireRlSceneAuto() {
  ['chk-rl-kickoff', 'sel-rl-kickoff-scene', 'chk-rl-sbscene', 'sel-rl-sbscene', 'chk-rl-postgame', 'sel-rl-postgame-scene', 'inp-rl-postgame-delay'].forEach(function (id) {
    const e = el(id);
    if (e && !e._rlWired) { e._rlWired = true; e.addEventListener('change', sendRlSceneAuto); }
  });
  // Clear Scoreboard now lives in the scorecard beside Pause match (scorecardHTML +
  // wireScorecard's 'clear-board' case) — a live in-match control, not scene config.
  const hide = el('chk-rl-hide-ui');
  if (hide && !hide._rlWired) { hide._rlWired = true; hide.addEventListener('change', function () { send('set_rl_hide_ui', { hidden: this.checked }); }); }
  // Where the board lives — segmented (RL HUD overlay vs its own OBS source). Same state as the old
  // "Board on a separate source" checkbox (rlScoreboardSeparate); as a two-way choice it also tells
  // the producer which of the two post-game cuts belongs to their setup.
  const locSeg = el('rl-sb-loc-seg');
  if (locSeg && !locSeg._rlWired) {
    locSeg._rlWired = true;
    locSeg.querySelectorAll('.seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        const separate = b.dataset.sbloc === 'source';
        setRlSbLocSeg(separate);
        send('set_rl_scoreboard_separate', { separate: separate });
      });
    });
  }
  // RL auto-spectate + first-kickoff camera wiring REMOVED 2026-08 (the camera automation is gone).
  // Pause/resume now lives in the scorecard (scorecardHTML + wireScorecard) — see .js-rl-pause.
  // Enable/disable the animated replay transitions (shutter-slam wipes + Brazil flag) on the overlays.
  const rtTog = el('chk-rl-replay-transitions');
  if (rtTog && !rtTog._rlWired) {
    rtTog._rlWired = true;
    rtTog.addEventListener('change', function () {
      send('set_rl_replay_transitions', { on: this.checked });
      const st = el('sel-replay-style'); if (st) st.disabled = !this.checked;   // moot pick while off
    });
  }
  // Occasional title-sponsor roll-out from the bottom-right statcard on the RL HUD.
  const srTog = el('chk-rl-sponsor-roll');
  if (srTog && !srTog._rlWired) {
    srTog._rlWired = true;
    srTog.addEventListener('change', function () {
      send('set_rl_sponsor_roll', { on: this.checked });
    });
  }
  // Scores ticker on/off, Worlds overlay only.
  const wtTog = el('chk-worlds-ticker');
  if (wtTog && !wtTog._wtWired) {
    wtTog._wtWired = true;
    wtTog.addEventListener('change', function () {
      send('set_worlds_ticker', { on: this.checked });
    });
  }
  // Worlds overlay stats sidebar (optional ranked panel): toggle + title/subtitle + Name|Value rows.
  const wsbTog = el('chk-worlds-sidebar');
  if (wsbTog && !wsbTog._wsbWired) {
    wsbTog._wsbWired = true;
    function wsbParseRows() {
      return (el('inp-wsb-rows').value || '').split('\n').map(function (ln) {
        var t = ln.trim(); if (!t) return null;
        var parts = t.split(/\s*[|\t]\s*|\s{2,}|\s*,\s*/); // split on | , tab or a run of spaces
        var name = (parts.shift() || '').trim();
        var value = parts.join(' ').trim();
        return name ? { name: name, value: value } : null;
      }).filter(Boolean);
    }
    function wsbSend() {
      send('set_worlds_sidebar', {
        visible: wsbTog.checked,
        title: (el('inp-wsb-title').value || '').trim(),
        subtitle: (el('inp-wsb-sub').value || '').trim(),
        source: 'manual',
        rows: wsbParseRows(),
      });
      var s = el('wsb-saved'); if (s) { s.style.display = ''; clearTimeout(s._t); s._t = setTimeout(function () { s.style.display = 'none'; }, 1600); }
    }
    wsbTog.addEventListener('change', wsbSend);
    el('btn-wsb-save').addEventListener('click', wsbSend);
    el('btn-wsb-fill-standings').addEventListener('click', function () {
      var st = ((typeof currentState !== 'undefined' && currentState) || {});
      // prefer live league/competition standings; fall back to the standings overlay rows
      var src = (st.standings && st.standings.rows) || (st.startggLeagueStandings && st.startggLeagueStandings.rows) || [];
      if (!Array.isArray(src) || !src.length) { alert('No standings loaded yet — load a league/competition first, or type rows by hand.'); return; }
      var lines = src.slice(0, 10).map(function (r, i) {
        var name = r.team || r.name || r.entrant || r.player || '';
        var value = (r.points != null ? r.points : (r.wins != null ? (r.wins + '-' + (r.losses != null ? r.losses : 0)) : (r.value != null ? r.value : '')));
        return name ? (name + ' | ' + value) : '';
      }).filter(Boolean);
      el('inp-wsb-rows').value = lines.join('\n');
      if (!el('inp-wsb-title').value) el('inp-wsb-title').value = 'Standings';
      wsbSend();
    });
  }
  // Stats-screen skin (show/hide the stat table + pick the design) — applies to the scoreboard scene.
  // Two copies of each control now — Settings ▸ Games ▸ Rocket League and the Match — Teams gear.
  // Whichever the producer touches wins; the other re-hydrates from the next full_state.
  ['chk-rl-stats-show', 'sel-rl-stats-design', 'chk-rl-stats-show-mt', 'sel-rl-stats-design-mt'].forEach(function (id) {
    const e = el(id);
    if (e && !e._rlWired) {
      e._rlWired = true;
      e.addEventListener('change', function () {
        const mt = this.id.endsWith('-mt');
        send('set_rl_stats_screen', {
          showStats: !!(el(mt ? 'chk-rl-stats-show-mt' : 'chk-rl-stats-show') || {}).checked,
          design: (el(mt ? 'sel-rl-stats-design-mt' : 'sel-rl-stats-design') || {}).value || 'default'
        });
      });
    }
  });
  // Quick one-tap style chips (Match ▸ Teams cockpit) — flip the on-air post-game board between styles
  // live, during the short post-game window. The overlay re-renders the board on the design change.
  const sbChips = el('sb-style-chips');
  if (sbChips && !sbChips._rlWired) {
    sbChips._rlWired = true;
    sbChips.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-sbstyle]'); if (!btn) return;
      const design = btn.dataset.sbstyle;
      const sel = el('sel-rl-stats-design-mt'); if (sel) sel.value = design;   // keep the dropdown in sync
      send('set_rl_stats_screen', { showStats: !!(el('chk-rl-stats-show-mt') || {}).checked, design });
    });
  }
}
// ── Smash controls (Match ▸ Teams gear ▸ Smash strip) — stocks + fighters, shown only for Smash ──
let _smashWired = false;
// Ultimate fighter names for the datalist (factual labels; producers can type any name).
// Fighter roster + name resolution come from the SHARED registry (overlay/smash-fighters.js,
// loaded in index.html) so the panel can only offer names the overlays have art for.
function smashFighterList() { return (window.SmashFighters ? SmashFighters.picks : []).map((f) => f.name); }
function smashResolve(v) { return window.SmashFighters ? SmashFighters.resolve(v) : null; }
// Paint a stock-icon thumbnail next to a fighter input so a producer can see that "gnw" or "zss"
// resolved to the fighter they meant before it reaches the scoreboard.
function smashSetThumb(imgEl, value) {
  if (!imgEl) return;
  const f = smashResolve(value);
  if (f) { const url = SmashFighters.stockUrl(f.slug); if (imgEl.getAttribute('src') !== url) imgEl.src = url;
           imgEl.classList.remove('is-empty'); imgEl.title = f.name; }
  else { imgEl.classList.add('is-empty'); imgEl.removeAttribute('title'); }
}
// ── Fighter picker ───────────────────────────────────────────────────────────
// Every fighter field opens the same popover: an icon grid, because picking a character out of a
// bare text list means already knowing all 87 names. Typing in the search box filters it; the
// field itself stays readonly so there is one way in and the value is always a real fighter.
const SmashPicker = (function () {
  let pop, search, grid, emptyEl, target = null, onPick = null, built = false;
  function ensure() {
    pop = pop || el('smash-pick-pop');
    search = search || el('smash-pick-search');
    grid = grid || el('smash-pick-grid');
    emptyEl = emptyEl || el('smash-pick-empty');
    if (!pop || built || !window.SmashFighters) return !!pop;
    // A "None" cell is the only way to unset a fighter now the field itself is readonly --
    // without it a mis-picked character could never be taken back off the card.
    grid.innerHTML = '<button type="button" class="smash-pick-cell smash-pick-none" data-slug="" title="No fighter">' +
      '<span class="smash-pick-x">&times;</span><span>None</span></button>' +
      SmashFighters.picks.map((f) =>
        `<button type="button" class="smash-pick-cell" data-slug="${f.slug}" title="${tlEsc(f.name)}">` +
        `<img src="${SmashFighters.stockUrl(f.slug)}" alt=""><span>${tlEsc(f.name)}</span></button>`).join('');
    built = true;
    return true;
  }
  function filter(q) {
    const n = window.SmashFighters ? SmashFighters.norm(q || '') : '';
    let shown = 0;
    grid.querySelectorAll('.smash-pick-cell').forEach((cell) => {
      const f = SmashFighters.bySlug[cell.dataset.slug];
      if (!f) { cell.hidden = !!n; return; }            // the "None" cell: only while not searching
      const hay = SmashFighters.norm(f.name) + ' ' + (f.alt || []).join(' ') + ' ' + f.slug;
      const hit = !n || hay.indexOf(n) >= 0;
      cell.hidden = !hit;
      if (hit) shown++;
    });
    if (emptyEl) emptyEl.hidden = shown > 0;
  }
  function place() {
    if (!target) return;
    const r = target.getBoundingClientRect();
    const w = pop.offsetWidth || 330, h = pop.offsetHeight || 340;
    // flip above / clamp to the viewport so it is never half off-screen in a scrolled panel
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    let left = Math.min(r.left, window.innerWidth - w - 8);
    pop.style.top = top + 'px';
    pop.style.left = Math.max(8, left) + 'px';
  }
  function open(input, cb) {
    if (!ensure()) return;
    target = input; onPick = cb;
    pop.hidden = false;
    const cur = window.SmashFighters ? SmashFighters.slugOf(input.value) : '';
    grid.querySelectorAll('.smash-pick-cell').forEach((c) => c.classList.toggle('is-on', c.dataset.slug === cur));
    search.value = '';
    filter('');
    place();
    search.focus();
    const on = grid.querySelector('.smash-pick-cell.is-on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function close() { if (pop) pop.hidden = true; target = null; onPick = null; }
  function isOpen() { return pop && !pop.hidden; }
  function wire() {
    if (!ensure() || pop.dataset.wired) return;
    pop.dataset.wired = '1';
    search.addEventListener('input', () => filter(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'Enter') {
        const first = grid.querySelector('.smash-pick-cell:not([hidden]):not(.smash-pick-none)');
        if (first) first.click();
        e.preventDefault();
      }
    });
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.smash-pick-cell'); if (!cell) return;
      const f = SmashFighters.bySlug[cell.dataset.slug];
      const cb = onPick, t = target;
      close();
      if (t) { t.value = f ? f.name : ''; if (cb) cb(f ? f.name : ''); }
    });
    document.addEventListener('mousedown', (e) => {
      if (!isOpen()) return;
      if (pop.contains(e.target) || e.target === target) return;
      close();
    });
    window.addEventListener('resize', () => { if (isOpen()) place(); });
    window.addEventListener('scroll', () => { if (isOpen()) place(); }, true);
  }
  return { open, close, isOpen, wire };
})();
// Any fighter field, anywhere: click to pick. The field is readonly so the value is always a real
// fighter; the grid's "None" cell is how a fighter gets unset.
function smashBindPicker(input, cb) {
  if (!input || input.dataset.pickerBound) return;
  input.dataset.pickerBound = '1';
  input.setAttribute('readonly', 'readonly');
  input.classList.add('smash-char-input');
  input.addEventListener('mousedown', (e) => { e.preventDefault(); SmashPicker.wire(); SmashPicker.open(input, cb); });
  input.addEventListener('focus', () => { SmashPicker.wire(); SmashPicker.open(input, cb); });
}

function wireSmashControls() {
  if (_smashWired) return; _smashWired = true;
  const dl = el('smash-fighters');
  if (dl && !dl.childElementCount) dl.innerHTML = smashFighterList().map((n) => `<option value="${tlEsc(n)}"></option>`).join('');
  const on = (id, ev, fn) => { const n = el(id); if (n) n.addEventListener(ev, () => fn(n)); };
  on('smash-start-stocks', 'change', (n) => send('set_smash_start_stocks', { value: parseInt(n.value, 10) }));
  on('smash-rail-pos', 'change', (n) => send('set_smash_rail_pos', { value: n.value }));
  on('smash-best-of', 'change', (n) => send('set_best_of', { value: parseInt(n.value, 10) }));
  on('smash-crew-size', 'change', (n) => send('set_smash_crew_size', { value: parseInt(n.value, 10) }));
  on('smash-auto-advance', 'change', (n) => send('set_smash_auto_advance', { value: n.checked }));
  on('btn-smash-reset', 'click', () => send('reset_smash_stocks', {}));
  on('btn-smash-swap', 'click', () => send('swap_teams', {}));
  on('btn-smash-reset-series', 'click', () => confirmResetSeries());
  // Scoreboard title ("Ultimate Singles"). Emptying the box re-arms the start.gg auto-fill rather
  // than blanking the badge - the server falls back to whatever the last event reported.
  const st = el('smash-title');
  if (st) {
    st.addEventListener('change', () => send('set_smash_title', { value: st.value.trim() }));
    st.addEventListener('keydown', (e) => { if (e.key === 'Enter') st.blur(); });
  }
  // Format toggle (Singles / Doubles / Crew battle).
  document.querySelectorAll('#smash-mode-seg .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => send('set_smash_mode', { mode: btn.dataset.smashMode }));
  });
  // The two side cards are re-rendered from state, so every control in them is delegated here.
  // Rows carry data-idx; singles (one row, no index on the server) is told apart by _smashMode.
  ['blue', 'orange'].forEach((side) => {
    const card = el('smash-side-' + side);
    if (!card) return;
    card.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]'); if (!t || !card.contains(t)) return;
      const act = t.dataset.act;
      const row = t.closest('.sm-row');
      const idx = row ? parseInt(row.dataset.idx, 10) : 0;
      const pooled = _smashMode !== 'singles';
      if (act === 'series') send('adjust_series', { side, delta: parseInt(t.dataset.d, 10) });
      else if (act === 'games') {
        // Clicking the marker that is already the last one won takes it back off (undo a mis-click).
        const won = parseInt(card.dataset.won, 10) || 0;
        const i = parseInt(t.dataset.i, 10);
        const target = (i + 1 === won) ? i : i + 1;
        send('adjust_series', { side, delta: target - won });
      } else if (act === 'stock' || act === 'stock-step') {
        const cur = parseInt(row.dataset.stocks, 10) || 0;
        const max = parseInt(row.dataset.max, 10) || 3;
        let value;
        if (act === 'stock') {
          // a tracker's click: the last lit stock clicked again drops it, so zero is reachable
          const i = parseInt(t.dataset.i, 10);
          value = (i + 1 === cur) ? i : i + 1;
        } else value = Math.max(0, Math.min(max, cur + parseInt(t.dataset.d, 10)));
        if (pooled) send('set_smash_player_stock', { side, index: idx, value });
        else send('set_smash_stocks', { side, value });
      }
    });
    // Fighter fields open the shared icon-grid picker (bound on demand: the rows are rebuilt).
    card.addEventListener('mousedown', (e) => {
      const inp = e.target.closest('.sm-fighter-in'); if (!inp) return;
      const idx = parseInt(inp.closest('.sm-row').dataset.idx, 10) || 0;
      smashBindPicker(inp, (name) => {
        smashSetThumb(inp.closest('.sm-row').querySelector('.sm-face'), name);
        if (_smashMode !== 'singles') send('set_smash_player_character', { side, index: idx, character: name });
        else send('set_smash_character', { side, character: name });
      });
    }, true);
  });
}
// Marvel Tokon strip (Match ▸ Teams) — tokon.html's "Best of 3 · Game 2" line and which bottom corner
// its caster/sponsor card sits in. Best-of and game number are the shared series fields.
var _tokonWired = false;
function wireTokonControls() {
  if (_tokonWired) return; _tokonWired = true;
  const bo = el('tokon-best-of');
  if (bo) bo.addEventListener('change', () => send('set_best_of', { value: parseInt(bo.value, 10) }));
  document.querySelectorAll('[data-tokon-game]').forEach((btn) => {
    btn.addEventListener('click', () => send('adjust_game_number', { delta: parseInt(btn.dataset.tokonGame, 10) }));
  });
  const rp = el('tokon-rail-pos');
  if (rp) rp.addEventListener('change', () => send('set_tokon_rail_pos', { value: rp.value }));
  // Position numbers. 'change' fires on each spinner click as well as on blur, so the board can be
  // nudged into place live; the server clamps every value.
  document.querySelectorAll('[data-tokon-layout]').forEach((inp) => {
    inp.addEventListener('change', () => {
      if (inp.value === '') return;
      send('set_tokon_layout', { key: inp.dataset.tokonLayout, value: Number(inp.value) });
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
  const lr = el('btn-tokon-layout-reset');
  if (lr) lr.addEventListener('click', () => send('set_tokon_layout', { reset: true }));
}
function applyTokonControls(data) {
  wireTokonControls();
  const on = !!(data && data.activeGame === 'marvel-tokon');
  const strip = el('msp-tokon');
  if (strip) strip.style.display = on ? '' : 'none';
  if (!data) return;   // filled even when Tokon isn't on air, so Game Settings can prep it
  const bo = el('tokon-best-of');
  if (bo && document.activeElement !== bo) {
    const v = String(data.bestOf || 3);
    if (![].some.call(bo.options, (o) => o.value === v)) bo.add(new Option(v, v));
    bo.value = v;
  }
  const gn = el('tokon-game-num');
  if (gn) gn.textContent = String((data.game && data.game.number) || 1);
  const rp = el('tokon-rail-pos');
  if (rp && document.activeElement !== rp) {
    const v = (data.tokon || {}).railPos;
    rp.value = (v === 'bottomleft' || v === 'bottomright') ? v : 'meters';
  }
  const lay = (data.tokon || {}).layout || {};
  document.querySelectorAll('[data-tokon-layout]').forEach((inp) => {
    if (document.activeElement === inp) return;
    const v = lay[inp.dataset.tokonLayout];
    if (v != null) inp.value = String(v);
  });
}
let _smashMode = 'singles';
// Smash's own player colours - the panel mirrors the scoreboard (P1 red, P2 blue).
const SMASH_SIDE = { blue: { tag: 'P1', label: 'Player 1' }, orange: { tag: 'P2', label: 'Player 2' } };
function applySmashControls(data) {
  wireSmashControls();
  const strip = el('msp-smash');
  if (strip) strip.style.display = (data && data.activeGame === 'smash') ? '' : 'none';
  if (!data) return;   // filled even when Smash isn't on air, so Game Settings can prep it
  const sm = data.smash || {};
  const mode = (sm.mode === 'team' || sm.mode === 'doubles') ? sm.mode : 'singles';
  _smashMode = mode;
  const pooled = mode !== 'singles';
  const setVal = (id, v) => { const n = el(id); if (n && document.activeElement !== n) n.value = v; };

  // Format + its one-line explanation.
  document.querySelectorAll('#smash-mode-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.smashMode === mode));
  const mh = el('smash-mode-hint');
  if (mh) {
    mh.textContent = mode === 'doubles'
      ? 'Both players show on each side of the scoreboard; the caster bar docks beside it.'
      : mode === 'team'
        ? 'The scoreboard switches to the crew board (pooled team stocks); the caster bar docks beside it.'
        : 'One player per side; the caster bar sits at the bottom of the screen.';
  }

  // Match-wide settings.
  setVal('smash-start-stocks', String(sm.startStocks || 3));
  setVal('smash-rail-pos', (sm.railPos === 'topleft' || sm.railPos === 'bottom') ? sm.railPos : 'auto');
  const bo = el('smash-best-of');
  if (bo && document.activeElement !== bo) {
    const v = String(data.bestOf || 3);
    if (![].some.call(bo.options, (o) => o.value === v)) bo.add(new Option(v, v));
    bo.value = v;
  }
  setVal('smash-crew-size', String(sm.crewSize || 4));
  const csw = el('smash-crew-size-wrap'); if (csw) csw.style.display = mode === 'team' ? '' : 'none';
  const aa = el('smash-auto-advance'); if (aa && document.activeElement !== aa) aa.checked = sm.autoAdvance !== false;
  const st = el('smash-title');
  if (st && document.activeElement !== st) {
    st.value = sm.title || '';
    // Show what start.gg said as the placeholder once we've heard from an event, so a producer
    // clearing the field can see exactly what auto-fill will put back.
    st.placeholder = sm.startggTitle ? ('Auto: ' + sm.startggTitle) : 'Auto from start.gg';
  }

  const start = Math.max(1, Math.min(9, Number(sm.startStocks) || 3));
  const need = Math.max(1, Math.ceil((Number(data.bestOf) || 3) / 2));
  const series = data.series || {};
  ['blue', 'orange'].forEach((side) => {
    const card = el('smash-side-' + side);
    if (!card) return;
    const t = (data.teams && data.teams[side]) || {};
    const roster = Array.isArray(t.players) ? t.players.filter(Boolean) : [];
    const s = sm[side] || {};
    const won = Number(series[side]) || 0;
    const nameOf = (p) => (p ? String(p.gamertag || p.name || '').trim() : '');

    // Rows: singles = the one player on the scoreboard (activePlayer, else the first); doubles/crew
    // = one per slot in players[], named from the roster in order.
    let rows;
    if (pooled) {
      const stocks = Array.isArray(s.players) ? s.players : [];
      const chars = Array.isArray(s.characters) ? s.characters : [];
      rows = stocks.map((n, i) => ({ name: nameOf(roster[i]), stocks: Math.max(0, Number(n) || 0), fighter: chars[i] || '' }));
    } else {
      const wantId = (data.activePlayer && data.activePlayer[side]) || '';
      const p = (wantId && roster.find((x) => String(x.id) === String(wantId))) || roster[0];
      rows = [{ name: nameOf(p), stocks: Math.max(0, Number(s.stocks != null ? s.stocks : start) || 0), fighter: s.character || '' }];
    }
    const title = pooled ? (String(t.name || '').trim() || SMASH_SIDE[side].label)
                         : (rows[0].name || String(t.name || '').trim() || SMASH_SIDE[side].label);
    const left = rows.reduce((a, r) => a + Math.min(start, r.stocks), 0);

    // Rebuild only when something shown changed, and never under an open fighter picker (the input
    // it is anchored to would be torn out from under it).
    const sig = JSON.stringify([mode, title, won, need, start, rows]);
    if (card.dataset.sig === sig) return;
    if (typeof SmashPicker !== 'undefined' && SmashPicker.isOpen()) return;
    card.dataset.sig = sig;
    card.dataset.won = String(won);

    const pips = (n, lit, act, cls) => Array.from({ length: n }, (_, i) =>
      `<button type="button" class="${cls}${i < lit ? ' on' : ''}" data-act="${act}" data-i="${i}" title="Set to ${i + 1}"></button>`).join('');
    card.innerHTML =
      `<div class="sm-side-hd">` +
        `<span class="sm-tag">${SMASH_SIDE[side].tag}</span>` +
        `<span class="sm-side-name" title="${tlEsc(title)}">${tlEsc(title)}</span>` +
        `<span class="sm-games" title="Games won - click to set">${pips(need, won, 'games', 'sm-game')}</span>` +
        `<span class="sm-score">` +
          `<button type="button" class="sm-step" data-act="series" data-d="-1" title="Take a game off">&minus;</button>` +
          `<span class="sm-score-n">${won}</span>` +
          `<button type="button" class="sm-step" data-act="series" data-d="1" title="Give this side a game">+</button>` +
        `</span>` +
      `</div>` +
      `<div class="sm-rows${pooled ? '' : ' sm-rows--solo'}">` +
        rows.map((r, i) => {
          const lit = Math.min(start, r.stocks);
          return `<div class="sm-row${lit === 0 ? ' is-out' : ''}" data-idx="${i}" data-stocks="${lit}" data-max="${start}">` +
            `<img class="sm-face smash-char-thumb is-empty" alt="">` +
            (pooled ? `<span class="sm-pname${r.name ? '' : ' is-empty'}">${tlEsc(r.name || ('Player ' + (i + 1)))}</span>` : '') +
            `<input type="text" class="input-text sm-fighter-in smash-char-input" placeholder="Pick a fighter" readonly value="${tlEsc(r.fighter)}">` +
            `<span class="sm-stocks">` +
              `<button type="button" class="sm-step" data-act="stock-step" data-d="-1" title="Lose a stock">&minus;</button>` +
              `<span class="sm-pips">${pips(start, lit, 'stock', 'sm-stock')}</span>` +
              `<button type="button" class="sm-step" data-act="stock-step" data-d="1" title="Give a stock back">+</button>` +
            `</span>` +
          `</div>`;
        }).join('') +
      `</div>` +
      (pooled ? `<div class="sm-side-ft"><b>${left}</b> / ${rows.length * start} ${mode === 'doubles' ? 'stocks left' : 'team stocks'}</div>` : '');
    card.querySelectorAll('.sm-row').forEach((row) => {
      smashSetThumb(row.querySelector('.sm-face'), row.querySelector('.sm-fighter-in').value);
    });
  });
}

// ── Brawlhalla controls (Match ▸ Teams ▸ Brawlhalla) ─────────────────────────
// Stocks and legends are MANUAL — Brawlhalla ships no live match feed, so this strip is the only
// way they reach the overlay. The rank/ELO chips beside each player are the part that IS real
// data: a linked Brawlhalla account is pulled from the official API (backend/brawlhalla.js).
const BH_SIDE = { blue: { tag: 'P1', label: 'Player 1' }, orange: { tag: 'P2', label: 'Player 2' } };
let _bhWired = false;

function bhLegendNames() {
  return (typeof BRAWLHALLA_LEGENDS !== 'undefined') ? BRAWLHALLA_LEGENDS : [];
}

function wireBrawlhallaControls() {
  if (_bhWired) return; _bhWired = true;
  const dl = el('bh-legends');
  if (dl && !dl.childElementCount) dl.innerHTML = bhLegendNames().map((n) => `<option value="${tlEsc(n)}"></option>`).join('');
  const on = (id, ev, fn) => { const n = el(id); if (n) n.addEventListener(ev, () => fn(n)); };
  on('bh-start-stocks', 'change', (n) => send('set_brawlhalla_start_stocks', { value: parseInt(n.value, 10) }));
  on('bh-best-of', 'change', (n) => send('set_best_of', { value: parseInt(n.value, 10) }));
  on('bh-auto-advance', 'change', (n) => send('set_brawlhalla_options', { autoAdvance: n.checked }));
  on('bh-show-rank', 'change', (n) => send('set_brawlhalla_options', { showRank: n.checked }));
  on('bh-rank-mode', 'change', (n) => send('set_brawlhalla_options', { rankMode: n.value }));
  on('bh-region', 'change', (n) => send('set_brawlhalla_options', { region: n.value }));
  on('btn-bh-reset', 'click', () => send('reset_brawlhalla_stocks', {}));
  on('btn-bh-swap', 'click', () => send('swap_teams', {}));
  on('btn-bh-refresh', 'click', () => {
    send('refresh_brawlhalla_cards', {});
    const st = el('bh-status'); if (st) st.textContent = 'Refreshing ranks…';
  });
  const title = el('bh-title');
  if (title) {
    title.addEventListener('change', () => send('set_brawlhalla_options', { title: title.value.trim() }));
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });
  }
  document.querySelectorAll('#bh-mode-seg .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => send('set_brawlhalla_mode', { mode: btn.dataset.bhMode }));
  });

  // The side cards are re-rendered from state, so everything inside them is delegated.
  ['blue', 'orange'].forEach((side) => {
    const card = el('bh-side-' + side);
    if (!card) return;
    card.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]'); if (!t || !card.contains(t)) return;
      const row = t.closest('.sm-row');
      const seat = row ? (parseInt(row.dataset.idx, 10) || 0) : 0;
      const act = t.dataset.act;
      if (act === 'stock') send('set_brawlhalla_stocks', { side, seat, value: (parseInt(t.dataset.i, 10) || 0) + 1 });
      else if (act === 'stock-step') send('brawlhalla_stock_delta', { side, seat, delta: parseInt(t.dataset.d, 10) || 0 });
      else if (act === 'series') send('adjust_series', { side, delta: parseInt(t.dataset.d, 10) || 0 });
      else if (act === 'games') {
        const target = (parseInt(t.dataset.i, 10) || 0) + 1;
        send('adjust_series', { side, delta: target - (parseInt(card.dataset.won, 10) || 0) });
      }
      else if (act === 'bh-find') bhFindPlayer(side, seat);
      else if (act === 'bh-unlink') send('link_brawlhalla_player', { side, seat, bhId: 0 });
    });
    card.addEventListener('change', (e) => {
      const row = e.target.closest('.sm-row');
      const seat = row ? (parseInt(row.dataset.idx, 10) || 0) : 0;
      if (e.target.classList.contains('bh-legend-in')) {
        send('set_brawlhalla_legend', { side, seat, legend: e.target.value.trim() });
      }
    });
  });
}

/*
  Look a player up and link them.

  This is a ranked-LEADERBOARD search — the only name lookup the Brawlhalla API has — so an
  unranked player cannot be found by name at all. The prompt says so, and offers the Brawlhalla ID
  as the way in, because otherwise "no results" reads as a broken integration.
*/
async function bhFindPlayer(side, seat) {
  const st = el('bh-status');
  const t = (currentState.teams || {})[side] || {};
  const roster = Array.isArray(t.players) ? t.players : [];
  const guess = ((roster[seat] && (roster[seat].gamertag || roster[seat].name)) || '').trim();
  const q = await customPrompt('Find Brawlhalla player', 'Brawlhalla name to look up, or paste a numeric Brawlhalla ID.', guess, 'Look up');
  if (q == null) return;
  const query = q.trim();
  if (!query) return;
  // A bare number is an ID — link it straight away and skip the search entirely.
  if (/^\d+$/.test(query)) {
    send('link_brawlhalla_player', { side, seat, bhId: parseInt(query, 10) });
    if (st) st.textContent = 'Linking Brawlhalla ID ' + query + '…';
    return;
  }
  if (st) st.textContent = 'Searching Brawlhalla ranked for "' + query + '"…';
  try {
    const r = await fetch('http://127.0.0.1:3000/api/brawlhalla/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, region: (currentState.brawlhalla || {}).region || 'ALL', limit: 10 })
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || 'Lookup failed');
    const hits = (d.hits || []).filter((h) => h.brawlhallaId);
    if (!hits.length) { if (st) st.textContent = d.note || 'No ranked player by that name.'; return; }
    const pick = hits.length === 1 ? hits[0] : await (async () => {
      const lines = hits.map((h, i) => `${i + 1}. ${h.name} — ${h.tier || 'unranked'} ${h.rating || ''} (${h.region}) #${h.rank}`);
      const n = await customPrompt('Which player?', lines.join('\n') + '\n\nType the number.', '1', 'Link');
      const idx = parseInt(n, 10);
      return (idx >= 1 && idx <= hits.length) ? hits[idx - 1] : null;
    })();
    if (!pick) { if (st) st.textContent = ''; return; }
    send('link_brawlhalla_player', { side, seat, bhId: pick.brawlhallaId });
    if (st) st.textContent = `Linked ${pick.name} (${pick.tier || 'unranked'}, ${pick.region}).`;
  } catch (err) {
    if (st) st.textContent = friendlyError(err);
  }
}

function applyBrawlhallaControls(data) {
  wireBrawlhallaControls();
  const strip = el('msp-brawlhalla');
  if (strip) strip.style.display = (data && data.activeGame === 'brawlhalla') ? '' : 'none';
  if (!data) return;   // filled even off-air so Game Settings can prep it
  const bh = data.brawlhalla || {};
  const mode = bh.mode === '2v2' ? '2v2' : '1v1';
  const seats = mode === '2v2' ? 2 : 1;
  const start = Math.max(1, Math.min(9, Number(bh.startStocks) || 3));
  const setVal = (id, v) => { const n = el(id); if (n && document.activeElement !== n) n.value = v; };

  document.querySelectorAll('#bh-mode-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.bhMode === mode));
  const hint = el('bh-mode-hint');
  if (hint) {
    hint.textContent = mode === '2v2'
      ? 'Both players show on each side and their stocks pool — the side is out when the pair runs dry.'
      : 'One player per side, with their legend and stocks.';
  }
  setVal('bh-start-stocks', String(start));
  setVal('bh-rank-mode', bh.rankMode === 'ranked_3v3' ? 'ranked_3v3' : 'ranked_1v1');
  setVal('bh-region', bh.region || 'ALL');
  const bo = el('bh-best-of');
  if (bo && document.activeElement !== bo) {
    const v = String(data.bestOf || 3);
    if (![].some.call(bo.options, (o) => o.value === v)) bo.add(new Option(v, v));
    bo.value = v;
  }
  const aa = el('bh-auto-advance'); if (aa && document.activeElement !== aa) aa.checked = bh.autoAdvance !== false;
  const sr = el('bh-show-rank'); if (sr && document.activeElement !== sr) sr.checked = bh.showRank !== false;
  const ti = el('bh-title');
  if (ti && document.activeElement !== ti) {
    ti.value = bh.title || '';
    ti.placeholder = 'Auto: ' + (mode === '2v2' ? '2v2 Doubles' : '1v1 Singles');
  }
  const status = el('bh-status');
  // Only overwrite the status line with an ERROR — a lookup's own "Linked X" message should stay
  // on screen rather than being wiped by the state push that the link itself caused.
  if (status && bh.lastError) status.textContent = 'Brawlhalla API: ' + bh.lastError;

  const need = Math.max(1, Math.ceil((Number(data.bestOf) || 3) / 2));
  const series = data.series || {};
  ['blue', 'orange'].forEach((side) => {
    const card = el('bh-side-' + side);
    if (!card) return;
    const t = (data.teams && data.teams[side]) || {};
    const roster = Array.isArray(t.players) ? t.players.filter(Boolean) : [];
    const sd = bh[side] || {};
    const won = Number(series[side]) || 0;
    const nameOf = (p) => (p ? String(p.gamertag || p.name || '').trim() : '');

    const rows = [];
    for (let i = 0; i < seats; i++) {
      const p = (sd.players || [])[i] || {};
      rows.push({
        name: nameOf(roster[i]),
        // Singles keeps its stock count on the SIDE (that is what the overlay draws); 2v2 keeps
        // one per seat. Reading the wrong one is how a board shows full stocks after three KOs.
        stocks: Math.max(0, Number(seats === 1 ? sd.stocks : p.stocks) || 0),
        legend: (seats === 1 ? sd.legend : p.legend) || '',
        bhId: Number(p.bhId) || 0,
        card: p.card || null
      });
    }
    const title = (rows[0].name || String(t.name || '').trim() || BH_SIDE[side].label);
    const left = rows.reduce((a, r) => a + Math.min(start, r.stocks), 0);

    const sig = JSON.stringify([mode, title, won, need, start, rows.map((r) => [r.name, r.stocks, r.legend, r.bhId,
      r.card ? [r.card.tier, r.card.rating, r.card.wins, r.card.losses, r.card.regionRank, r.card.globalRank].join('~') : ''])]);
    if (card.dataset.sig === sig) return;
    card.dataset.sig = sig;
    card.dataset.won = String(won);

    const pips = (n, lit, act, cls) => Array.from({ length: n }, (_, i) =>
      `<button type="button" class="${cls}${i < lit ? ' on' : ''}" data-act="${act}" data-i="${i}" title="Set to ${i + 1}"></button>`).join('');
    // The rank line for a seat: what the API actually returned, or the prompt to link one.
    const rankLine = (r) => {
      if (!r.bhId) return `<button type="button" class="btn btn-ghost btn-xs" data-act="bh-find" title="Search the Brawlhalla ranked leaderboard and link this player's account">Link rank</button>`;
      if (!r.card) return `<span class="sm-pname is-empty">Loading rank…</span>`;
      const c = r.card;
      const rank = c.regionRank ? `${c.region} #${c.regionRank}` : (c.globalRank ? `#${c.globalRank}` : '');
      return `<span class="bh-rank" title="${tlEsc(c.name)} — peak ${c.peakRating}">`
        + `<b>${tlEsc(c.tier || 'Unranked')}</b>`
        + (c.rating ? ` · ${c.rating}` : '')
        + (rank ? ` · ${tlEsc(rank)}` : '')
        + (c.games ? ` · ${c.wins}-${c.losses}` : '')
        + `</span> <button type="button" class="btn btn-ghost btn-xs" data-act="bh-unlink" title="Unlink this Brawlhalla account">×</button>`;
    };
    card.innerHTML =
      `<div class="sm-side-hd">` +
        `<span class="sm-tag">${BH_SIDE[side].tag}</span>` +
        `<span class="sm-side-name" title="${tlEsc(title)}">${tlEsc(title)}</span>` +
        `<span class="sm-games" title="Games won - click to set">${pips(need, won, 'games', 'sm-game')}</span>` +
        `<span class="sm-score">` +
          `<button type="button" class="sm-step" data-act="series" data-d="-1" title="Take a game off">&minus;</button>` +
          `<span class="sm-score-n">${won}</span>` +
          `<button type="button" class="sm-step" data-act="series" data-d="1" title="Give this side a game">+</button>` +
        `</span>` +
      `</div>` +
      `<div class="sm-rows${seats === 1 ? ' sm-rows--solo' : ''}">` +
        rows.map((r, i) => {
          const lit = Math.min(start, r.stocks);
          return `<div class="sm-row${lit === 0 ? ' is-out' : ''}" data-idx="${i}">` +
            (seats > 1 ? `<span class="sm-pname${r.name ? '' : ' is-empty'}">${tlEsc(r.name || ('Player ' + (i + 1)))}</span>` : '') +
            `<input type="text" class="input-text bh-legend-in" list="bh-legends" placeholder="Legend" value="${tlEsc(r.legend)}">` +
            `<span class="sm-stocks">` +
              `<button type="button" class="sm-step" data-act="stock-step" data-d="-1" title="Lose a stock">&minus;</button>` +
              `<span class="sm-pips">${pips(start, lit, 'stock', 'sm-stock')}</span>` +
              `<button type="button" class="sm-step" data-act="stock-step" data-d="1" title="Give a stock back">+</button>` +
            `</span>` +
            `<span class="bh-rank-cell">${rankLine(r)}</span>` +
          `</div>`;
        }).join('') +
      `</div>` +
      (seats > 1 ? `<div class="sm-side-ft"><b>${left}</b> / ${rows.length * start} stocks left</div>` : '');
  });
}

// ── Built-in chat commands (!bracket / !discord / !casters) ───────────────────
// The preview mirrors server.js chatCommandReply() so the producer sees the EXACT line the bot
// will post — keep the two in step if either changes.
let _chatCmdWired = false;
function wireChatCommands() {
  if (_chatCmdWired) return; _chatCmdWired = true;
  const en = el('chk-chatcmd-enabled');
  if (en) en.addEventListener('change', () => send('set_chat_commands', { enabled: en.checked }));
  const dc = el('input-chatcmd-discord');
  if (dc) dc.addEventListener('change', () => send('set_chat_commands', { discord: dc.value.trim() }));
}
function chatCommandPreview(kind, data) {
  data = data || {};
  if (kind === 'bracket') {
    const ev = data.activeEvent || {};
    const sg = data.startgg || {};
    let url = String(ev.url || '').trim() || (sg.eventSlug ? 'https://www.start.gg/' + sg.eventSlug : '');
    if (!url) return 'No bracket linked yet.';
    // Deep-link to the live bracket (phase + pool) — mirrors server.js chatCommandReply().
    const bk = data.bracket || {};
    const isStartgg = ev.platform === 'startgg' || (!ev.platform && !!sg.eventSlug);
    if (isStartgg && !/\/brackets\//.test(url)) {
      const phaseId = String(bk.activePhaseId || '').replace(/^p/, '');
      const poolId  = String(bk.activePoolId || '');
      if (/^\d+$/.test(phaseId) && /^\d+$/.test(poolId)) url += `/brackets/${phaseId}/${poolId}`;
    }
    const name = String(ev.name || '').trim();
    return name ? `${name} bracket: ${url}` : `Bracket: ${url}`;
  }
  if (kind === 'discord') {
    const link = String((data.chatCommands && data.chatCommands.discord) || '').trim();
    return link ? `Join the Discord: ${link}` : 'No Discord link set yet.';
  }
  if (kind === 'casters') {
    // Mirrors server.js casterSocialText() / chatCommandReply('casters').
    const SOC = {
      x: (v) => 'x.com/' + v.replace(/^@/, ''),          twitter: (v) => 'x.com/' + v.replace(/^@/, ''),
      twitch: (v) => 'twitch.tv/' + v.replace(/^@/, ''), youtube: (v) => 'youtube.com/@' + v.replace(/^@/, ''),
      instagram: (v) => 'instagram.com/' + v.replace(/^@/, ''), tiktok: (v) => 'tiktok.com/@' + v.replace(/^@/, ''),
      facebook: (v) => 'facebook.com/' + v.replace(/^@/, ''),   kick: (v) => 'kick.com/' + v.replace(/^@/, '')
    };
    const socText = (c) => {
      const raw = String((c && (c.socialHandle || c.handle)) || '').trim();
      if (!raw) return '';
      if (/^https?:\/\//i.test(raw)) return raw.replace(/^https?:\/\//i, '');
      const fn = SOC[String((c && c.social) || '').toLowerCase()];
      if (fn) return fn(raw);
      return raw.startsWith('@') ? raw : '@' + raw;
    };
    const parts = ((data.casters && data.casters.list) || [])
      .slice()
      .sort((a, b) => (Number(a.slot) || 99) - (Number(b.slot) || 99))
      .map((c) => {
        const nm = String((c && (c.gamertag || c.name)) || '').trim();
        if (!nm) return '';
        const soc = socText(c);
        return soc ? `${nm} — ${soc}` : nm;
      })
      .filter(Boolean);
    if (!parts.length) return 'No casters on the desk right now.';
    return parts.join('  ·  ');
  }
  return '';
}
function applyChatCommands(data) {
  wireChatCommands();
  const cc = (data && data.chatCommands) || {};
  const en = el('chk-chatcmd-enabled');
  if (en && document.activeElement !== en) en.checked = cc.enabled !== false;
  const dc = el('input-chatcmd-discord');
  if (dc && document.activeElement !== dc) dc.value = cc.discord || '';
  ['bracket', 'discord', 'casters'].forEach((k) => {
    const p = el('cc-preview-' + k);
    if (p) p.textContent = chatCommandPreview(k, data);
  });
}

// Light up the "Where the board lives" segment + swap its explanatory hint. separate=true means the
// board is its own OBS source (rl-hud.html?only=scoreboard) and the HUD hides its inline board.
function setRlSbLocSeg(separate) {
  const seg = el('rl-sb-loc-seg'); if (!seg) return;
  seg.querySelectorAll('.seg-btn').forEach(function (b) {
    b.classList.toggle('active', (b.dataset.sbloc === 'source') === !!separate);
  });
  const hh = el('rl-sb-loc-hint-hud'), hs = el('rl-sb-loc-hint-source');
  if (hh) hh.style.display = separate ? 'none' : '';
  if (hs) hs.style.display = separate ? '' : 'none';
}

function applyRlSceneAuto(data) {
  wireRlSceneAuto();   // idempotent — the panel elements exist after DOM load (relocated, not recreated)
  const sec = el('msp-rl-scenes');
  if (sec) sec.style.display = (data && data.activeGame === 'rocket-league') ? '' : 'none';
  const obs = (data && data.obs) || {};
  const ko = obs.kickoff || {}, pg = obs.postGame || {}, sbsc = obs.scoreboardScene || {};
  // Only rebuild the scene <select>s when the live list / saved scene changes (don't wipe an open dropdown).
  const sig = JSON.stringify({ a: obs.availableScenes || [], k: ko.scene || '', p: pg.scene || '', s: sbsc.scene || '' });
  if (sig !== _lastRlSceneSig) {
    _lastRlSceneSig = sig;
    fillObsSceneSelect(el('sel-rl-kickoff-scene'), obs.availableScenes || [], ko.scene || '');
    fillObsSceneSelect(el('sel-rl-sbscene'), obs.availableScenes || [], sbsc.scene || '');
    fillObsSceneSelect(el('sel-rl-postgame-scene'), obs.availableScenes || [], pg.scene || '');
  }
  const kEn = el('chk-rl-kickoff'); if (kEn) kEn.checked = !!ko.enabled;
  const sbscEn = el('chk-rl-sbscene'); if (sbscEn && document.activeElement !== sbscEn) sbscEn.checked = !!sbsc.enabled;
  const pEn = el('chk-rl-postgame'); if (pEn) pEn.checked = !!pg.enabled;
  const pd = el('inp-rl-postgame-delay'); if (pd && document.activeElement !== pd) pd.value = pg.delaySec || 20;
  const hEn = el('chk-rl-hide-ui'); if (hEn && document.activeElement !== hEn) hEn.checked = !!(data && data.rlHudHidden);
  const rtOn = (data && data.rlReplayTransitions) !== false;
  const rtEn = el('chk-rl-replay-transitions'); if (rtEn && document.activeElement !== rtEn) rtEn.checked = rtOn;
  const rtSel = el('sel-replay-style'); if (rtSel) rtSel.disabled = !rtOn;
  const srEn = el('chk-rl-sponsor-roll'); if (srEn && document.activeElement !== srEn) srEn.checked = !!(data && data.rlSponsorRoll);
  const wtEn = el('chk-worlds-ticker'); if (wtEn && document.activeElement !== wtEn) wtEn.checked = (data && data.worldsTicker) !== false;
  { // Worlds stats sidebar — hydrate the toggle + fields (skip whatever the producer is editing)
    const sb = (data && data.worldsSidebar) || {};
    const wt = el('chk-worlds-sidebar'); if (wt && document.activeElement !== wt) wt.checked = !!sb.visible;
    const wti = el('inp-wsb-title'); if (wti && document.activeElement !== wti) wti.value = sb.title || '';
    const wsu = el('inp-wsb-sub'); if (wsu && document.activeElement !== wsu) wsu.value = sb.subtitle || '';
    const wr = el('inp-wsb-rows');
    if (wr && document.activeElement !== wr) wr.value = (Array.isArray(sb.rows) ? sb.rows : []).map((r) => (r.name || '') + (r.value !== '' && r.value != null ? ' | ' + r.value : '')).join('\n');
  }
  { // Sponsors tab card: which title sponsor the roll-out will show (brand kit's title-tagged sponsor)
    const b = (data && data.brand) || {}, logo = (b.spots && b.spots.title) || '';
    const sp = (b.sponsors || []).find((x) => x && x.logo && x.placements && x.placements.title);
    const im = el('preview-sponroll-logo');
    if (im) { if (logo) { if (im.getAttribute('src') !== logo) im.src = logo; im.style.display = ''; } else im.style.display = 'none'; }
    const nm = el('sponroll-name'); if (nm) nm.textContent = logo ? ((sp && sp.name) || '') : 'None set';
    const miss = el('sponroll-missing'); if (miss) miss.style.display = logo ? 'none' : '';
  }
  setRlSbLocSeg(!!(data && data.rlScoreboardSeparate));
  // Overwatch FT/BO label row: only for Overwatch, buttons read the live numbers (FT3 / BO5).
  {
    const isOw = !!(data && data.activeGame === 'overwatch');
    const bestOf = (data && data.bestOf) || 5;
    const lbl = (data && data.owMatch && data.owMatch.seriesLabel) === 'bo' ? 'bo' : 'ft';
    document.querySelectorAll('.sc-ow-label').forEach((row) => {
      row.style.display = isOw ? '' : 'none';
      row.querySelectorAll('button[data-v]').forEach((b) => {
        b.textContent = b.dataset.v === 'bo' ? 'BO' + bestOf : 'FT' + Math.ceil(bestOf / 2);
        b.classList.toggle('is-on', b.dataset.v === lbl);
      });
    });
  }
  // RL auto-spectate + first-kickoff camera reflection REMOVED 2026-08 (the camera automation is gone).
  // Live-match pause button: label + data-state track the true pause state (which the
  // MatchPaused/Unpaused events confirm), and the button is inert unless RL is connected.
  // querySelectorAll, not el(): the scorecard is rendered twice (Dashboard + Teams tab), so there
  // are two live copies of this button and both have to track the same state.
  {
    const paused = !!(data && data.rlPaused);
    const connected = !!(data && data.rlConnected);
    const isRl = !!(data && data.activeGame === 'rocket-league');
    document.querySelectorAll('.js-rl-pause').forEach((btn) => {
      btn.dataset.paused = paused ? '1' : '0';
      btn.textContent = paused ? 'Resume match' : 'Pause match';
      btn.classList.toggle('btn-danger', paused);
      btn.disabled = !connected;
      btn.title = connected ? 'Pauses / resumes the live game via SetMatchPaused'
                            : 'Connect the Rocket League Stats API to pause/resume';
      // The whole row goes away for other games rather than sitting there dead — SetMatchPaused
      // is a Rocket League Stats API call and means nothing on a Smash or FGC board.
      const row = btn.closest('.sc-live-ctl');
      if (row) row.style.display = isRl ? '' : 'none';
    });
  }
  const ss = (data && data.rlStatsScreen) || {};
  ['chk-rl-stats-show', 'chk-rl-stats-show-mt'].forEach((id) => {
    const n = el(id); if (n && document.activeElement !== n) n.checked = ss.showStats !== false;
  });
  ['sel-rl-stats-design', 'sel-rl-stats-design-mt'].forEach((id) => {
    const n = el(id); if (n && document.activeElement !== n) n.value = ss.design || 'default';
  });
  // Light up the active quick-style chip so the producer can see which board style is live.
  document.querySelectorAll('#sb-style-chips [data-sbstyle]').forEach((b) => {
    b.classList.toggle('active', b.dataset.sbstyle === (ss.design || 'default'));
  });
  // Replay transition look (Match▸Teams). Server-authoritative like every other picker here.
  const rpStyle = el('sel-replay-style');
  if (rpStyle && document.activeElement !== rpStyle) rpStyle.value = ((data && data.replay) || {}).style || 'slam';
}

const SCENE_CONTROL_MOMENTS = [
  { key: 'inGame', label: 'In-Game' },
  { key: 'replay', label: 'Replay' },
  { key: 'postGame', label: 'Post-Game' },
  { key: 'break', label: 'Break' },
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
    // Position = key: fire the Nth button on the transport bar (whatever it is — scene cut,
    // overlay toggle, or trigger). The button's own click handler does the right thing, and it
    // works even while that button is in the collapsed second row.
    const btn = document.querySelector(`#qt-obs-scenes .qt-scene-btn[data-hk="${e.key}"]`);
    if (btn) {
      const lbl = (btn.querySelector('.qt-act-lbl') || btn).textContent.trim();
      btn.click();
      flashHotkeyHint(lbl ? `${e.key} · ${lbl}` : `Key ${e.key}`);
      e.preventDefault();
    }
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
      btn.title = sceneName ? 'Connect to OBS to use' : 'No scene mapped (Apps > Streaming software)';
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
      ? 'Not connected to OBS. Connect it under Apps > Streaming software.'
      : (anyMapped ? '' : 'No scenes mapped yet. Set them under Apps > Streaming software.');
  }
}

el('btn-obs-save-replay')?.addEventListener('click', () => send('obs_save_replay'));
el('btn-obs-toggle-buffer')?.addEventListener('click', () => send('obs_toggle_replay_buffer'));

function applyObsState(data) {
  const obs = data.obs || {};
  applySceneControl(obs);
  renderSwScenes(obs);

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
  const kEn = el('check-obs-kickoff');
  if (kEn) kEn.checked = !!(obs.kickoff && obs.kickoff.enabled);

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

  // Streaming app: OBS Studio or Streamlabs Desktop, each with its own connection fields.
  const appSel = el('select-obs-app');
  // A program picked but not saved yet (Apps ▸ Streaming software) keeps its form up until Save.
  if (window._swPendingApp && window._swPendingApp === (obs.app === 'streamlabs' ? 'streamlabs' : 'obs')) window._swPendingApp = '';
  if (appSel && document.activeElement !== appSel) appSel.value = window._swPendingApp || (obs.app === 'streamlabs' ? 'streamlabs' : 'obs');
  syncObsAppFields();
  if (typeof swRenderPicker === 'function') swRenderPicker(data);
  const sIpEl = el('input-slobs-ip'), sPortEl = el('input-slobs-port');
  if (sIpEl || sPortEl) {
    const m = String(obs.slobsUrl || 'ws://127.0.0.1:59650').match(/^wss?:\/\/([^:/]+)(?::(\d+))?/i);
    if (sIpEl && document.activeElement !== sIpEl) sIpEl.value = m ? m[1] : '127.0.0.1';
    if (sPortEl && document.activeElement !== sPortEl) sPortEl.value = m && m[2] ? m[2] : '59650';
  }
  const tokEl = el('input-slobs-token'), tokInd = el('slobs-token-indicator'), tokClear = el('btn-slobs-clear-token');
  if (tokEl && tokInd) {
    const hasTok = obs.hasSlobsToken && !tokEl.value;
    tokInd.style.display = hasTok ? 'block' : 'none';
    tokEl.placeholder = hasTok ? '••••••••••••' : 'From Settings > Remote Control';
    if (tokClear) tokClear.style.display = hasTok ? 'inline-block' : 'none';
  }

  populateObsSceneSelects(obs.availableScenes || [], obs.scenes || {}, (obs.kickoff && obs.kickoff.scene) || '');
  applyRlSceneAuto(data);   // RL-only kickoff/post-game scene automation in the Match ▸ Teams gear panel
  if (typeof syncSheetsUi === 'function') syncSheetsUi(data);   // Google Sheets integration settings
  if (typeof syncCreditsShiftEventSelect === 'function') syncCreditsShiftEventSelect();   // credits event picker
  applySmashControls(data); // Smash-only stocks + fighters strip
  applyBrawlhallaControls(data);   // Brawlhalla stocks + legends + ranked-card linking
  if (window.GamesHub) window.GamesHub.onState(data); // Settings ▸ Games + Dashboard Game Settings (games-hub.js)
  applyTokonControls(data); // Marvel Tokon format/game + rail corner
  applyChatCommands(data);  // !bracket / !discord / !casters config + live reply preview
  if (typeof syncReplayProgramScene === 'function') syncReplayProgramScene(obs);
  if (typeof syncGfxAutocutScene === 'function') syncGfxAutocutScene(obs);

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

  // Integrations store-card badge — reflects the REAL connection state.
  const obsCard = el('obs-card-badge');
  if (obsCard) {
    const st = obs.connected ? ['Connected', '#4ade80', 'rgba(74,222,128,.1)']
             : obs.enabled   ? ['Connecting…', '#fbbf24', 'rgba(251,191,36,.1)']
             :                 ['Setup', '#fbbf24', 'rgba(251,191,36,.1)'];
    obsCard.textContent = st[0]; obsCard.style.color = st[1]; obsCard.style.background = st[2];
  }
  const sggCard = el('startgg-card-badge');
  if (sggCard) {
    const has = !!(data.startgg && data.startgg.hasToken);
    sggCard.textContent = has ? 'Connected' : 'Setup';
    sggCard.style.color = has ? '#4ade80' : '#fbbf24';
    sggCard.style.background = has ? 'rgba(74,222,128,.1)' : 'rgba(251,191,36,.1)';
  }

  // Status line
  const resultEl = el('obs-result');
  if (resultEl) {
    if (obs.connected) {
      resultEl.textContent = `● Connected to ${obs.app === 'streamlabs' ? 'Streamlabs Desktop' : 'OBS'} — ${(obs.availableScenes || []).length} scene(s) available.`;
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

el('btn-obs-save')?.addEventListener('click', () => {
  send('set_obs_settings', getObsPayload());
});
// Show the connection fields for the chosen app. Changing app only switches the form; Save or
// Test connects to it.
function syncObsAppFields() {
  const slobs = (el('select-obs-app') || {}).value === 'streamlabs';
  const sf = el('slobs-fields'); if (sf) sf.style.display = slobs ? 'flex' : 'none';
  const og = el('obs-fields-grid'); if (og) og.style.display = slobs ? 'none' : 'grid';
  const oh = el('obs-fields-help'); if (oh) oh.style.display = slobs ? 'none' : '';
  // A scene collection file is imported by OBS only.
  const cc = el('sw-collection-card'); if (cc) cc.hidden = slobs;
}
el('select-obs-app')?.addEventListener('change', syncObsAppFields);
el('btn-slobs-clear-token')?.addEventListener('click', () => {
  const btn = el('btn-slobs-clear-token');
  const t = el('input-slobs-token'); if (t) t.value = '';
  btn.dataset.clearing = '1';
  send('set_obs_settings', getObsPayload());
  delete btn.dataset.clearing;
  btn.style.display = 'none';
  const ind = el('slobs-token-indicator'); if (ind) ind.style.display = 'none';
});
el('input-obs-postgame-casters')?.addEventListener('change', () => send('set_obs_settings', getObsPayload()));
// Rocket League > Automation > Replays (moved there from the streaming software screen): saves at once.
el('check-obs-autoreplay')?.addEventListener('change', () => send('set_obs_settings', getObsPayload()));
el('check-obs-kickoff')?.addEventListener('change', () => send('set_obs_settings', getObsPayload()));
el('select-obs-kickoff-scene')?.addEventListener('change', () => send('set_obs_settings', getObsPayload()));
el('check-commercial-auto-return')?.addEventListener('change', function () { send('set_commercial_auto_return', { enabled: this.checked }); });

el('btn-obs-test')?.addEventListener('click', () => {
  send('set_obs_settings', getObsPayload());
  send('obs_test_connection');
  const resultEl = el('obs-result');
  if (resultEl) { resultEl.textContent = 'Testing connection…'; resultEl.style.color = 'var(--muted)'; }
});

el('btn-obs-refresh-scenes')?.addEventListener('click', () => {
  send('obs_refresh_scenes');
});

// ── vMix settings (full alternative production backend) ──────────────────────
function getVmixPayload() {
  return {
    enabled: !!el('check-vmix-enabled')?.checked,
    host: (el('input-vmix-host')?.value || '').trim() || '127.0.0.1',
    port: parseInt(el('input-vmix-port')?.value, 10) || 8088,
  };
}
el('btn-vmix-save')?.addEventListener('click', () => {
  send('set_vmix_settings', getVmixPayload());
  const r = el('vmix-result'); if (r) { r.textContent = 'Saved.'; r.style.color = '#4ade80'; setTimeout(() => { r.textContent = ''; }, 2500); }
});
el('check-vmix-enabled')?.addEventListener('change', () => send('set_vmix_settings', getVmixPayload()));
el('btn-vmix-test')?.addEventListener('click', () => {
  send('set_vmix_settings', getVmixPayload());
  send('vmix_test_connection');
  const r = el('vmix-result'); if (r) { r.textContent = 'Testing connection…'; r.style.color = 'var(--muted)'; }
});
document.querySelectorAll('#switcher-target-seg .seg-btn').forEach((b) => b.addEventListener('click', () => send('set_switcher_target', { target: b.dataset.target })));
