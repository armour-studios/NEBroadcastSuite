// Control panel, part 6 of 17: Team editor, players, appearance, match titles, banners, profile, cloud sync, integrations, facecams.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Team editor (create / edit a saved team: logo, name, colour, roster) ──────
// The colour is saved on the team and applied to the live match (and thus the overlays)
// whenever the team is loaded — see set_team / save_team `color`.
let teModel = { oldName: null, name: '', abbr: '', logo: null, color: '#055fdb', players: [] };
const teUid = () => 'p' + Math.random().toString(36).slice(2, 9);
function teStatus(msg, ok) { const s = el('te-status'); if (s) { s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)'); } }

// Social platform config — drives player bar icons and the edit popup link fields.
const TE_SOCIALS = [
  { key: 'twitter',   label: 'X / Twitter', color: '#e7e9ea', ph: '@handle or x.com/…',       urlFn: v => 'https://x.com/' + encodeURIComponent(v.replace(/^@/, '')),        svg: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
  { key: 'twitch',    label: 'Twitch',       color: '#9146ff', ph: 'channel name',              urlFn: v => 'https://twitch.tv/' + encodeURIComponent(v),                       svg: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z' },
  { key: 'discord',   label: 'Discord',      color: '#7289da', ph: 'username',                  urlFn: null, svg: 'M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.03.056a19.9 19.9 0 0 0 5.993 3.03.077.077 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z' },
  { key: 'instagram', label: 'Instagram',    color: '#e1306c', ph: '@handle',                   urlFn: v => 'https://instagram.com/' + encodeURIComponent(v.replace(/^@/, '')), svg: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z' },
  { key: 'tiktok',    label: 'TikTok',       color: '#69c9d0', ph: '@handle',                   urlFn: v => 'https://tiktok.com/@' + encodeURIComponent(v.replace(/^@/, '')),   svg: 'M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.29 6.29 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.74a8.16 8.16 0 004.77 1.52V6.79a4.84 4.84 0 01-1-.1z' },
  { key: 'youtube',   label: 'YouTube',      color: '#ff4444', ph: '@handle or youtube.com/…',  urlFn: v => 'https://youtube.com/@' + encodeURIComponent(v.replace(/^@/, '')),  svg: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
];

function teSocIconHtml(soc, size) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${soc.svg}"/></svg>`;
}

function teRenderPlayers() {
  const wrap = el('te-players-list'); if (!wrap) return;
  wrap.innerHTML = '';
  if (!teModel.players.length) { wrap.innerHTML = '<div class="tp-empty">No players yet — add your roster.</div>'; return; }
  teModel.players.forEach((p) => {
    const row = document.createElement('div'); row.className = 'te-player-row';

    // Hidden file input — shared by bar avatar and popup avatar
    const avatarFile = document.createElement('input');
    avatarFile.type = 'file'; avatarFile.accept = 'image/*'; avatarFile.style.display = 'none';
    row.append(avatarFile);

    // ── PLAYER BAR ──────────────────────────────────────────────────────
    const bar = document.createElement('div'); bar.className = 'te-player-bar';

    const barAvatar = document.createElement('img');
    barAvatar.className = 'tp-player-avatar'; barAvatar.title = p.name || 'Player';
    if (p.photo) barAvatar.src = p.photo;
    bar.append(barAvatar);

    const barName = document.createElement('span'); barName.className = 'te-bar-name';
    barName.textContent = p.name || '(unnamed)';
    bar.append(barName);

    const barStatus = document.createElement('span');
    barStatus.className = `te-bar-status ${p.status === 'sub' ? 'sub' : 'starter'}`;
    barStatus.textContent = p.status === 'sub' ? 'Sub' : 'Starter';
    bar.append(barStatus);

    // Social icons — only filled-in platforms shown
    const iconsWrap = document.createElement('div'); iconsWrap.className = 'te-bar-socials';
    const buildBarIcons = () => {
      iconsWrap.innerHTML = '';
      if (p.startgg) {
        const a = document.createElement('a'); a.className = 'te-soc-icon'; a.href = teStartggLink(p.startgg); a.target = '_blank'; a.rel = 'noopener'; a.title = `start.gg: ${p.startgg}`;
        a.innerHTML = `<img src="../assets/images/start.png" alt="start.gg" class="te-soc-icon-img">`;
        iconsWrap.append(a);
      }
      if (p.sixmans) {
        const a = document.createElement('a'); a.className = 'te-soc-icon'; a.href = teSixmansLink(p.sixmans); a.target = '_blank'; a.rel = 'noopener'; a.title = `6mans: ${p.sixmans}`;
        a.innerHTML = `<img src="../assets/images/sixmanlogo.webp" alt="6mans" class="te-soc-icon-img">`;
        iconsWrap.append(a);
      }
      TE_SOCIALS.forEach(soc => {
        const val = p[soc.key]; if (!val) return;
        const url = soc.urlFn ? soc.urlFn(val) : null;
        const icon = url ? document.createElement('a') : document.createElement('span');
        icon.className = 'te-soc-icon'; icon.style.color = soc.color; icon.title = `${soc.label}: ${val}`;
        if (url) { icon.href = url; icon.target = '_blank'; icon.rel = 'noopener'; }
        icon.innerHTML = teSocIconHtml(soc, 15);
        iconsWrap.append(icon);
      });
    };
    buildBarIcons();
    bar.append(iconsWrap);

    // Edit + delete buttons
    const editBtn = document.createElement('button'); editBtn.className = 'btn btn-ghost btn-sm te-edit-btn'; editBtn.textContent = 'Edit'; editBtn.title = 'Edit player details';
    const del = document.createElement('button'); del.className = 'te-del'; del.textContent = '✕'; del.title = 'Remove player';
    del.addEventListener('click', () => { teModel.players = teModel.players.filter((x) => x !== p); teRenderPlayers(); });
    bar.append(editBtn, del);
    row.append(bar);

    // ── EDIT POPUP ──────────────────────────────────────────────────────
    const popup = document.createElement('div'); popup.className = 'te-edit-popup';

    const hdr = document.createElement('div'); hdr.className = 'te-popup-header';
    const hdrTitle = document.createElement('span'); hdrTitle.className = 'te-popup-title'; hdrTitle.textContent = 'Edit Player';
    const hdrClose = document.createElement('button'); hdrClose.className = 'te-popup-close'; hdrClose.title = 'Close'; hdrClose.textContent = '×';
    hdr.append(hdrTitle, hdrClose);
    popup.append(hdr);

    const body = document.createElement('div'); body.className = 'te-popup-body';

    // Left column: big avatar + status toggle
    const leftCol = document.createElement('div'); leftCol.className = 'te-popup-left';
    const popAvatar = document.createElement('img'); popAvatar.className = 'tp-player-avatar te-popup-avatar';
    popAvatar.title = 'Click to change photo';
    if (p.photo) popAvatar.src = p.photo;
    popAvatar.addEventListener('click', () => avatarFile.click());
    const popStatus = document.createElement('button');
    popStatus.className = `btn tp-status ${p.status === 'sub' ? 'sub' : 'starter'}`;
    popStatus.style.cssText = 'width:100%;margin-top:6px;font-size:10px;';
    popStatus.textContent = p.status === 'sub' ? 'Sub' : 'Starter';
    popStatus.addEventListener('click', () => {
      p.status = p.status === 'sub' ? 'starter' : 'sub';
      popStatus.textContent = p.status === 'sub' ? 'Sub' : 'Starter';
      popStatus.className = `btn tp-status ${p.status}`; popStatus.style.cssText = 'width:100%;margin-top:6px;font-size:10px;';
      barStatus.textContent = p.status === 'sub' ? 'Sub' : 'Starter';
      barStatus.className = `te-bar-status ${p.status}`;
    });
    leftCol.append(popAvatar, popStatus);
    body.append(leftCol);

    // Right column: name, role, country + all links
    const rightCol = document.createElement('div'); rightCol.className = 'te-popup-right';

    const mkField = (labelText, ctrl) => {
      const row2 = document.createElement('div'); row2.className = 'te-popup-field';
      const lbl = document.createElement('span'); lbl.className = 'te-popup-label'; lbl.textContent = labelText;
      row2.append(lbl, ctrl); return row2;
    };

    const nameInp = document.createElement('input'); nameInp.className = 'input-text'; nameInp.value = p.name || ''; nameInp.placeholder = 'Player name';
    nameInp.addEventListener('input', () => { p.name = nameInp.value; barName.textContent = nameInp.value || '(unnamed)'; barAvatar.title = nameInp.value || 'Player'; });
    const roleCtrl = buildRoleControl(p.role || '', rolesForActiveGame(), v => { p.role = v; });
    const countryCtrl = buildCountryControl(p.country || '', code => { p.country = code; });
    const realNameInp = document.createElement('input'); realNameInp.className = 'input-text'; realNameInp.value = p.realName || ''; realNameInp.placeholder = 'Legal / full name (optional)';
    realNameInp.addEventListener('input', () => { p.realName = realNameInp.value; });
    const customFieldInp = document.createElement('input'); customFieldInp.className = 'input-text'; customFieldInp.value = p.customField || ''; customFieldInp.placeholder = 'Fun fact, hometown, nickname… (shown on Team Intro / Matchup)';
    customFieldInp.addEventListener('input', () => { p.customField = customFieldInp.value; });
    rightCol.append(mkField('Name', nameInp), mkField('Real Name', realNameInp), mkField('Role', roleCtrl), mkField('Country', countryCtrl), mkField('Custom Field', customFieldInp));

    // Profile links section
    const pHead = document.createElement('div'); pHead.className = 'te-popup-section-head'; pHead.textContent = 'Profile Links';
    rightCol.append(pHead);
    const mkLink = (iconHtml, inpPh, val, syncCb) => {
      const r = document.createElement('div'); r.className = 'te-popup-link-row';
      const ico = document.createElement('span'); ico.className = 'te-popup-link-icon'; ico.innerHTML = iconHtml;
      const inp = document.createElement('input'); inp.className = 'input-text'; inp.placeholder = inpPh; inp.value = val || '';
      inp.addEventListener('input', function() { syncCb(this.value.trim()); });
      r.append(ico, inp); return { row: r, inp };
    };
    const linksGrid = document.createElement('div'); linksGrid.className = 'te-popup-links-grid';

    // start.gg
    const { row: sggRow, inp: sggInp } = mkLink(`<img src="../assets/images/start.png" alt="SGG" style="height:14px;filter:brightness(0)invert(1);opacity:.7">`, 'start.gg link or slug', p.startgg, v => { p.startgg = v; buildBarIcons(); });
    const sggA = document.createElement('a'); sggA.className = `te-plink-open${p.startgg ? '' : ' is-off'}`; sggA.target = '_blank'; sggA.title = 'Open'; sggA.textContent = '↗';
    const syncSgg = () => { p.startgg = sggInp.value.trim(); sggA.href = teStartggLink(p.startgg); sggA.classList.toggle('is-off', !p.startgg); buildBarIcons(); };
    sggInp.removeEventListener('input', sggInp._sync); sggInp.addEventListener('input', syncSgg); syncSgg();
    sggRow.append(sggA);

    // 6mans
    const { row: sixRow, inp: sixInp } = mkLink(`<img src="../assets/images/sixmanlogo.webp" alt="6mans" style="height:14px;filter:brightness(0)invert(1);opacity:.7">`, '6mans username or link', p.sixmans, v => { p.sixmans = v; buildBarIcons(); });
    const sixA = document.createElement('a'); sixA.className = `te-plink-open${p.sixmans ? '' : ' is-off'}`; sixA.target = '_blank'; sixA.title = 'Open'; sixA.textContent = '↗';
    const syncSix = () => { p.sixmans = sixInp.value.trim(); sixA.href = teSixmansLink(p.sixmans); sixA.classList.toggle('is-off', !p.sixmans); buildBarIcons(); };
    sixInp.removeEventListener('input', sixInp._sync); sixInp.addEventListener('input', syncSix); syncSix();
    sixRow.append(sixA);

    linksGrid.append(sggRow, sixRow);
    rightCol.append(linksGrid);

    // Social link section
    const sHead = document.createElement('div'); sHead.className = 'te-popup-section-head'; sHead.textContent = 'Socials';
    rightCol.append(sHead);

    const socialsGrid = document.createElement('div'); socialsGrid.className = 'te-popup-links-grid';
    TE_SOCIALS.forEach(soc => {
      const { row: sr } = mkLink(teSocIconHtml(soc, 14).replace('<svg', `<svg style="color:${soc.color}"`), soc.ph, p[soc.key], v => { p[soc.key] = v; buildBarIcons(); });
      socialsGrid.append(sr);
    });
    rightCol.append(socialsGrid);
    body.append(rightCol);
    popup.append(body);
    row.append(popup);

    // Avatar file upload updates both bar and popup avatars
    avatarFile.addEventListener('change', async () => {
      const f = avatarFile.files[0]; if (!f) return;
      p.photo = await fileToBase64(f);
      barAvatar.src = p.photo; popAvatar.src = p.photo;
      avatarFile.value = '';
    });

    // Toggle popup open/close
    const openPopup = () => {
      wrap.querySelectorAll('.te-player-row.te-editing').forEach(r => {
        if (r !== row) { r.classList.remove('te-editing'); const eb = r.querySelector('.te-edit-btn'); if (eb) eb.textContent = 'Edit'; const op = r.querySelector('.te-edit-popup'); if (op) op.removeAttribute('style'); }
      });
      // Position as a fixed overlay so it escapes the editor's overflow scroll container —
      // the CSS default (absolute, below the row) left the popup clipped/off-screen for rows
      // near the bottom until you scrolled. Same flip-above/clamp logic as the match panel.
      const rect = row.getBoundingClientRect();
      const popW = Math.max(rect.width, 440);
      const leftPx = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
      popup.style.cssText = `display:block;position:fixed;left:${leftPx}px;width:${popW}px;z-index:9999;visibility:hidden;top:0;`;
      row.classList.add('te-editing'); editBtn.textContent = 'Done';
      const margin = 8, vh = window.innerHeight, popH = popup.offsetHeight || 360;
      const below = rect.bottom + 4, above = rect.top - popH - 4;
      const topPx = (below + popH + margin <= vh) ? below
        : (above >= margin) ? above
        : Math.max(margin, vh - popH - margin);
      popup.style.top = topPx + 'px';
      popup.style.visibility = '';
    };
    const closePopup = () => { row.classList.remove('te-editing'); popup.removeAttribute('style'); editBtn.textContent = 'Edit'; };
    editBtn.addEventListener('click', () => row.classList.contains('te-editing') ? closePopup() : openPopup());
    hdrClose.addEventListener('click', closePopup);

    wrap.appendChild(row);
  });

  // Close any open popup when clicking outside
  if (!wrap._outsideHandler) {
    const closeAllTe = () => {
      wrap.querySelectorAll('.te-player-row.te-editing').forEach(r => {
        r.classList.remove('te-editing');
        const eb = r.querySelector('.te-edit-btn'); if (eb) eb.textContent = 'Edit';
        const op = r.querySelector('.te-edit-popup'); if (op) op.removeAttribute('style');
      });
    };
    wrap._outsideHandler = (e) => {
      wrap.querySelectorAll('.te-player-row.te-editing').forEach(r => {
        if (!r.contains(e.target)) closeAllTe();
      });
    };
    document.addEventListener('click', wrap._outsideHandler);
    // A fixed-position popup would drift away from its row when the list scrolls — close it.
    // Capture-phase so it fires for ANY scrollable ancestor (scroll events don't bubble);
    // scrolls that originate inside the popup itself are ignored.
    document.addEventListener('scroll', (e) => {
      if (e.target instanceof Element && e.target.closest('.te-edit-popup')) return;
      closeAllTe();
    }, { capture: true, passive: true });
  }
}
// Thematic logo placeholder (no white box): a dashed, team-coloured tile with the team's
// initials — or a shield glyph before a name is typed. Updates live as name/colour change.
function teePlaceholder(name, color) {
  const c = /^#[0-9a-f]{6}$/i.test(color) ? color : '#055fdb';
  // Initials by CODE POINT, letters/digits only. `w[0]` took one UTF-16 code unit, so a team
  // whose name starts with an emoji (start.gg entrant names are full of them) yielded a LONE
  // SURROGATE — and encodeURIComponent() below threw "URI malformed". That throw escaped
  // renderEventTeamsPanel() into applyState(), which aborted every renderer after it on EVERY
  // state broadcast: bracket phases, ticker, standings and spotlight all silently stopped
  // updating. Anything that isn't a letter or digit (&, <, emoji) is dropped — it would break
  // the inline SVG anyway — and an empty result falls through to the shield glyph.
  const initials = (name || '').trim().split(/\s+/)
    .map((w) => Array.from(w).find((ch) => /[\p{L}\p{N}]/u.test(ch)) || '')
    .join('').slice(0, 2).toUpperCase();
  const inner = initials
    ? `<text x="60" y="62" font-family="Inter,Arial,sans-serif" font-size="44" font-weight="800" fill="${c}" text-anchor="middle" dominant-baseline="central">${initials}</text>`
    : `<path d="M60 33l21 9v15c0 13-9 23-21 27-12-4-21-14-21-27V42z" fill="none" stroke="${c}" stroke-width="5" stroke-linejoin="round" opacity="0.85"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">`
    + `<rect x="5" y="5" width="110" height="110" rx="18" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-opacity="0.6" stroke-width="2.5" stroke-dasharray="7 5"/>`
    + inner + `</svg>`;
  // Belt and braces: a placeholder tile is never worth taking the panel down for.
  try { return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); } catch (e) { return ''; }
}
function teRefreshLogoPreview() {
  const teImg = el('te-logo-preview'); if (!teImg) return;
  teImg.src = teModel.logo || teePlaceholder(teModel.name, teModel.color);
  teImg.classList.remove('game-logo-white');   // never the white silhouette
}
function teRender() {
  if (el('te-name')) el('te-name').value = teModel.name || '';
  if (el('te-abbr')) el('te-abbr').value = teModel.abbr || '';
  if (el('te-color')) el('te-color').value = /^#[0-9a-f]{6}$/i.test(teModel.color) ? teModel.color : '#055fdb';
  teRefreshLogoPreview();
  if (el('te-title')) el('te-title').textContent = teModel.oldName ? 'Edit Team' : 'Create Team';
  if (el('te-save')) el('te-save').textContent = teModel.oldName ? 'Update Team' : 'Save Team';
  teRenderPlayers();
}
function teLoad(team) {
  team = team || {};
  teModel = {
    oldName: team.oldName || null,
    name: team.name || '',
    abbr: team.abbr || '',
    logo: team.logo || null,
    color: team.color || '#055fdb',
    favorite: !!team.favorite,
    players: (team.players || []).map((p) => {
      // Backfill from the player-profile registry: start.gg slug, 6mans, and any
      // social/country/photo data the import pipeline wrote there (even if the player
      // object itself came from a raw event-team with only name/id).
      const reg = (currentState.playerProfiles || {})[(p.name || '').trim().toLowerCase()] || {};
      const startgg = p.startgg || (reg.startggSlug ? 'https://www.start.gg/' + String(reg.startggSlug).replace(/^\/+/, '') : '');
      const sixmans = p.sixmans || ((reg.sixmans && reg.sixmans.name) ? reg.sixmans.name : '');
      // Spread p FIRST: fields this editor doesn't know about (platform/platformId, camera
      // and VDO assignments from match-side saves, info, …) must round-trip untouched —
      // rebuilding from a fixed field list silently stripped them on every edit+save.
      return {
        ...p,
        id: p.id || teUid(),
        name: p.name || '',
        role: p.role || '',
        country:   p.country   || reg.countryCode || '',
        startgg,
        sixmans,
        status:    p.status    || 'starter',
        realName:  p.realName  || reg.realName || '',
        photo:     p.photo     || p.image || reg.image || '',
        discord:   p.discord   || '',
        twitter:   p.twitter   || reg.twitter || '',
        twitch:    p.twitch    || reg.twitch  || '',
        instagram: p.instagram || '',
        tiktok:    p.tiktok    || '',
        youtube:   p.youtube   || '',
      };
    })
  };
  teStatus('');
  teRender();
}
el('te-name')?.addEventListener('input', function () { teModel.name = this.value; if (!teModel.logo) teRefreshLogoPreview(); });
el('te-abbr')?.addEventListener('input', function () { teModel.abbr = this.value.toUpperCase().slice(0, 6); this.value = teModel.abbr; });
el('te-color')?.addEventListener('input', function () { teModel.color = this.value; if (!teModel.logo) teRefreshLogoPreview(); });
el('te-add-player')?.addEventListener('click', () => {
  teModel.players.push({ id: teUid(), name: '', role: '', country: '', status: 'starter', photo: '', discord: '', twitter: '', twitch: '', instagram: '', tiktok: '', youtube: '' });
  teRenderPlayers();
  const rows = el('te-players-list')?.querySelectorAll('.te-player-row .te-edit-btn');
  if (rows && rows.length) rows[rows.length - 1].click();
});
// Set the editor preview to a real (non-fallback) logo: update src AND drop the
// game-logo-white filter that teRender() applies to a blank team — otherwise an
// uploaded logo renders as a white silhouette on the 2nd+ team (the +New path).
function teSetPreviewLogo(src) {
  const img = el('te-logo-preview'); if (!img) return;
  img.src = src;
  img.classList.remove('game-logo-white');
}
el('te-logo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f) return;
  teModel.logo = await fileToBase64(f);
  teSetPreviewLogo(teModel.logo);
  this.value = '';   // allow re-picking the same file later (else 'change' won't refire)
});
el('te-logo-lib')?.addEventListener('click', () => {
  if (typeof mpOpen === 'function') mpOpen((url) => { teModel.logo = url; teSetPreviewLogo(url); });
});
el('te-new')?.addEventListener('click', () => { teLoad({}); openTeamEditor(); el('te-name')?.focus(); });
el('te-clear')?.addEventListener('click', () => teLoad({}));
el('te-save')?.addEventListener('click', () => {
  const name = (teModel.name || '').trim();
  if (!name) { teStatus('Enter a team name.', false); return; }
  send('save_team', {
    oldName: teModel.oldName || null,
    name,
    abbr: (teModel.abbr || '').trim().toUpperCase().slice(0, 6) || null,
    logo: teModel.logo || null,
    color: teModel.color || null,
    favorite: teModel.favorite || false,
    players: teModel.players.map((p) => ({ ...p, id: p.id, name: (p.name || '').trim(), realName: (p.realName || '').trim(), info: (p.info || '').trim(), role: (p.role || '').trim(), country: (p.country || '').toLowerCase(), startgg: (p.startgg || '').trim(), sixmans: (p.sixmans || '').trim(), status: p.status || 'starter', photo: p.photo || '', discord: (p.discord || '').trim(), twitter: (p.twitter || '').trim(), twitch: (p.twitch || '').trim(), instagram: (p.instagram || '').trim(), tiktok: (p.tiktok || '').trim(), youtube: (p.youtube || '').trim() })).filter((p) => p.name)
  });
  teModel.oldName = name;
  if (el('te-title')) el('te-title').textContent = 'Edit Team';
  if (el('te-save')) el('te-save').textContent = 'Update Team';
  teStatus('Saved.', true);
  setTimeout(() => closeTeamEditor(), 600);
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
  el('player-create-camera').checked = false;
  el('player-new-camera-form').style.display = 'none';

  // Build the options BEFORE applying the value — a <select> silently drops a value
  // whose option doesn't exist yet.
  syncPlayerCameraDropdown(player?.assignedCamera || '');
  modal.classList.add('show');
}

function closePlayerModal() {
  const modal = el('player-modal-overlay');
  modal.classList.remove('show');
  editingPlayerId = null;
  editingPlayerSide = null;
}

function syncPlayerCameraDropdown(desired) {
  const select = el('player-camera');
  if (!select) return;
  const currentValue = desired !== undefined ? desired : select.value;
  select.innerHTML = playerCameraOptions(editingPlayerSide || 'blue', currentValue);
  select.value = currentValue;
}

function savePlayer() {
  if (!editingPlayerSide) return;
  const name = el('player-name').value?.trim();
  if (!name) {
    showToast('Player name is required', '#ef4444');
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
      showToast('Camera URL is required', '#ef4444');
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
  appConfirm('Delete this player?', 'Delete').then(ok => { if (ok) send('delete_player', { side, playerId }); });
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
        ${playerProfileChips(p)}
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
function applyFontPreview(family) {
  const box = el('font-preview-box');
  if (box) box.style.fontFamily = `'${family}', sans-serif`;
}

async function loadSystemFonts() {
  const select = el('select-font');
  if (!select) return;

  // Brand fonts pinned at top, then curated broadcast fonts, then system fonts sorted.
  const BRAND = ['Industry'];
  const CURATED = ['Bourgeois', 'Rajdhani', 'Barlow Condensed', 'Oswald', 'Bebas Neue', 'Inter', 'Anton', 'Exo 2', 'Teko', 'Saira Condensed', 'Saira', 'Arial', 'Impact', 'Verdana', 'Georgia', 'Trebuchet MS'];
  const LABELS = { 'Industry': 'Industry (brand)', 'Bourgeois': 'Bourgeois' };

  function fontLabel(f) { return LABELS[f] || f; }

  function buildOptions(list) {
    select.innerHTML = '';
    list.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = fontLabel(f);
      select.appendChild(opt);
    });
  }

  try {
    const availableFonts = await window.queryLocalFonts();
    const systemFonts = [...new Set(availableFonts.map(f => f.family))].sort();
    // Brand first, then other curated (excluding brand dups), then remaining system fonts.
    const combined = [
      ...BRAND,
      ...CURATED.filter(f => !BRAND.includes(f)),
      ...systemFonts.filter(f => !BRAND.includes(f) && !CURATED.includes(f))
    ];
    buildOptions(combined);
    const cur = currentState.fontFamily;
    if (cur && !combined.includes(cur)) {
      const opt = document.createElement('option');
      opt.value = cur; opt.textContent = fontLabel(cur);
      select.prepend(opt);
    }
    if (cur) select.value = cur;
  } catch {
    buildOptions([...BRAND, ...CURATED]);
    if (currentState.fontFamily) select.value = currentState.fontFamily;
  }
  applyFontPreview(select.value);
}

el('tab-ajustes')?.addEventListener('click', async () => {
  await loadSystemFonts();
  syncSettingsFromState();
});

el('select-font')?.addEventListener('change', function() {
  send('set_font_family', { fontFamily: this.value });
  applyFontPreview(this.value);
});

// ── Overlay Appearance: theme + accent ────────────────────────────────────
el('select-theme')?.addEventListener('change', function () {
  send('set_theme', { theme: this.value });
});

function settingsAccentSync() {
  const hex = el('settings-accent-hex'), pick = el('settings-accent');
  if (!hex || !pick) return;
  hex.value = pick.value;
}
el('settings-accent')?.addEventListener('input', function () {
  const hexEl = el('settings-accent-hex'); if (hexEl) hexEl.value = this.value;
});
el('settings-accent')?.addEventListener('change', function () {
  send('set_global_accent', { color: this.value });
});
el('settings-accent-hex')?.addEventListener('change', function () {
  const v = normalizeAnyColor(this.value);
  if (v) {
    this.value = v;
    const pick = el('settings-accent'); if (pick) pick.value = v;
    send('set_global_accent', { color: v });
  }
});

// ── Broadcast Defaults ────────────────────────────────────────────────────
el('settings-default-bo')?.addEventListener('change', function () {
  send('set_default_bo', { bestOf: Number(this.value) });
});
el('settings-clock-24h')?.addEventListener('change', function () {
  send('set_clock_format', { clock24h: this.checked });
});
el('settings-follow-set-game')?.addEventListener('change', function () {
  send('set_follow_set_game', { enabled: this.checked });
});
el('settings-show-series')?.addEventListener('change', function () {
  send('set_show_series', { show: this.checked });
});

// ── Grid multiview (publish my match to the org wall) ─────────────────────
// state.pulse is shared with the Pulse scene — one publish switch feeds both.
['grid-publish', 'grid-channel', 'grid-label', 'grid-feed'].forEach(function (id) {
  const node = el(id);
  if (!node) return;
  node.addEventListener('change', function () {
    send('set_pulse', {
      publish:     !!el('grid-publish')?.checked,
      channel:     el('grid-channel')?.value.trim() || '',
      label:       el('grid-label')?.value.trim() || '',
      feedViewUrl: el('grid-feed')?.value.trim() || ''
    });
  });
});
[['grid-copy-4', '/grid.html?tiles=4'], ['grid-copy-2', '/grid.html?tiles=2'], ['grid-copy-bars', '/grid-bars.html?tiles=4']].forEach(function (pair) {
  el(pair[0])?.addEventListener('click', function () {
    const url = 'http://localhost:3000' + pair[1];
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => showToast('Browser-source URL copied.', '#22c55e', 2000));
  });
});
// The wall is an ORG feature — say plainly when it can't work rather than publishing into a void.
function syncGridMultiview() {
  const p = currentState.pulse || {};
  const pub = el('grid-publish'), ch = el('grid-channel'), lb = el('grid-label'), fd = el('grid-feed');
  if (pub && document.activeElement !== pub) pub.checked = !!p.publish;
  if (ch && document.activeElement !== ch) ch.value = p.channel || '';
  if (lb && document.activeElement !== lb) lb.value = p.label || '';
  if (fd && document.activeElement !== fd) fd.value = p.feedViewUrl || '';
  const st = el('grid-status');
  if (st) {
    st.textContent = !p.publish ? 'Not publishing — your match is not on the wall.'
      : (p.feedViewUrl ? 'Publishing your match and feed every 3 seconds.'
                       : 'Publishing scores only — add a feed URL to fill your tile with video.');
  }
}

// ── Match titles (Twitch auto-title + VOD naming) ─────────────────────────
// Templates save on change (blur/Enter), toggles immediately; the server returns live previews.
function sendMatchTitles() {
  send('set_match_titles', {
    twitch: { auto: !!el('mtt-twitch-auto')?.checked, template: el('mtt-twitch-tpl')?.value || '' },
    vod: {
      rename: !!el('mtt-vod-rename')?.checked, template: el('mtt-vod-tpl')?.value || '',
      eventFolder: !!el('mtt-vod-folder')?.checked, datePrefix: !!el('mtt-vod-date')?.checked, csv: !!el('mtt-vod-csv')?.checked
    },
    stripSponsors: !!el('mtt-strip-sponsors')?.checked
  });
}
['mtt-twitch-auto', 'mtt-twitch-tpl', 'mtt-vod-rename', 'mtt-vod-tpl', 'mtt-vod-folder', 'mtt-vod-date', 'mtt-vod-csv', 'mtt-strip-sponsors'].forEach(function (id) {
  el(id)?.addEventListener('change', sendMatchTitles);
});
['mtt-twitch-tpl', 'mtt-vod-tpl'].forEach(function (id) {
  el(id)?.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); this.blur(); } });
});
el('mtt-twitch-push')?.addEventListener('click', function () {
  send('match_titles_push_twitch', {});
  showToast('Sending the title to Twitch.', '#22c55e', 2000);
});
el('mtt-vod-clear')?.addEventListener('click', function () { send('vod_clear_log', {}); });
el('mtt-vod-log')?.addEventListener('click', function (e) {
  const btn = e.target.closest('[data-vod-act]');
  if (!btn) return;
  const id = btn.dataset.id, act = btn.dataset.vodAct;
  if (act === 'retry') send('vod_retry', { id });
  else if (act === 'reveal') send('vod_reveal', { id });
  else if (act === 'copy') {
    const entry = ((currentState.matchTitles || {}).vodLog || []).find((x) => x.id === id);
    if (entry && entry.row && navigator.clipboard) navigator.clipboard.writeText(entry.row).then(() => showToast('Row copied. Paste it into your sheet.', '#22c55e', 2000));
  }
});
function syncMatchTitles() {
  const mt = currentState.matchTitles;
  if (!mt) return;
  const setChk = (id, v) => { const n = el(id); if (n && document.activeElement !== n) n.checked = !!v; };
  const setVal = (id, v) => { const n = el(id); if (n && document.activeElement !== n) n.value = v || ''; };
  setChk('mtt-twitch-auto', mt.twitch && mt.twitch.auto);
  setVal('mtt-twitch-tpl', mt.twitch && mt.twitch.template);
  setChk('mtt-vod-rename', mt.vod && mt.vod.rename);
  setVal('mtt-vod-tpl', mt.vod && mt.vod.template);
  setChk('mtt-vod-folder', mt.vod && mt.vod.eventFolder);
  setChk('mtt-vod-date', mt.vod && mt.vod.datePrefix);
  setChk('mtt-vod-csv', mt.vod && mt.vod.csv);
  setChk('mtt-strip-sponsors', mt.stripSponsors !== false);
  const pv = mt.preview || {};
  const tp = el('mtt-twitch-preview'); if (tp) tp.textContent = pv.twitch || '(nothing on air yet)';
  const vp = el('mtt-vod-preview'); if (vp) vp.textContent = pv.vod || '(nothing on air yet)';
  const st = el('mtt-twitch-status');
  if (st) {
    const s = mt.status || {};
    const tw = currentState.twitch || {};
    let txt = '', bad = false;
    if (!mt.twitch || !mt.twitch.auto) txt = 'Off. The title is only changed by hand.';
    else if (s.twitchError) { txt = s.twitchError; bad = true; }
    else if (!tw.connected) { txt = 'Waiting for Twitch. Connect it on the Twitch page.'; bad = true; }
    else if (s.twitchAt) txt = 'Last sent ' + new Date(s.twitchAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
    else txt = 'On. The title is sent a few seconds after the match changes.';
    st.textContent = txt;
    st.style.color = bad ? '#f87171' : '';
  }
  const log = Array.isArray(mt.vodLog) ? mt.vodLog : [];
  const wrap = el('mtt-vod-log-wrap');
  if (wrap) wrap.style.display = log.length ? '' : 'none';
  const box = el('mtt-vod-log');
  if (box) {
    const key = JSON.stringify(log.map((x) => [x.id, x.status, x.filename, x.error, x.csvError]));
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = log.slice(0, 10).map(function (x) {
        const when = new Date(x.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const badge = x.status === 'saved' ? (x.csvError ? 'warn' : 'ok') : x.status === 'error' ? 'err' : 'wait';
        const label = { ok: 'Saved', warn: 'Saved, not logged', err: 'Error', wait: 'Saving' }[badge];
        const note = x.status === 'error' ? x.error : (x.csvError || x.filename || 'Waiting for OBS to release the file');
        const acts = (x.status === 'error' || x.csvError ? `<button type="button" class="btn btn-sm" data-vod-act="retry" data-id="${esc(x.id)}">Retry</button>` : '')
          + (x.row ? `<button type="button" class="btn btn-ghost btn-sm" data-vod-act="copy" data-id="${esc(x.id)}">Copy row</button>` : '')
          + `<button type="button" class="btn btn-ghost btn-sm" data-vod-act="reveal" data-id="${esc(x.id)}">Show file</button>`;
        return `<div class="mtt-log-row"><span class="mtt-badge mtt-badge-${badge}">${label}</span>`
          + `<div class="mtt-log-main"><div class="mtt-log-title">${esc(x.title)}</div><div class="mtt-log-note" title="${esc(note)}">${esc(when)} · ${esc(note)}</div></div>`
          + `<div class="mtt-log-acts">${acts}</div></div>`;
      }).join('');
    }
  }
}

function syncSettingsFromState() {
  syncGridMultiview();
  syncMatchTitles();
  const th = el('select-theme');
  if (th && currentState.theme && document.activeElement !== th) th.value = currentState.theme;
  const bo = el('settings-default-bo');
  if (bo && currentState.defaultBestOf && document.activeElement !== bo) bo.value = String(currentState.defaultBestOf);
  const cl = el('settings-clock-24h');
  if (cl && currentState.clock24h !== undefined) cl.checked = !!currentState.clock24h;
  const ss = el('settings-show-series');
  if (ss && currentState.showSeries !== undefined) ss.checked = currentState.showSeries !== false;
  const fg = el('settings-follow-set-game');
  if (fg && document.activeElement !== fg) fg.checked = !!currentState.followSetGame;
  const acPick = el('settings-accent'); const acHex = el('settings-accent-hex');
  const acColor = (currentState.brand && currentState.brand.color) || '#055fdb';
  if (acPick && document.activeElement !== acPick) { acPick.value = acColor; }
  if (acHex && document.activeElement !== acHex) { acHex.value = acColor; }
}

el('cf-facecams-enabled')?.addEventListener('change', function () {
  send('set_facecams_enabled', { enabled: this.checked });
});
el('check-facecams-enabled')?.addEventListener('change', function() {
  send('set_facecams_enabled', { enabled: this.checked });
});
const _cbReplayCams = el('check-replay-cams');
if (_cbReplayCams) _cbReplayCams.addEventListener('change', function() {
  send('set_replay_cams', { enabled: this.checked });
});

// ── Banner Settings ───────────────────────────────────────────────────────
el('check-banner-visible')?.addEventListener('change', function() {
  send('set_banner_visibility', { visible: this.checked });
});

el('input-banner-interval')?.addEventListener('change', function() {
  send('set_banner_interval', { interval: parseInt(this.value) || 10 });
});

el('select-banner-slant')?.addEventListener('change', function() {
  send('set_banner_slant', { slant: this.value });
});

el('input-banner-header')?.addEventListener('change', function() {
  send('set_banner_header', { header: this.value });
});

el('input-banner-image')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const b64 = await fileToBase64(file);
  send('add_banner_image', { image: b64 });
  // clear input so we can select same file again if needed
  e.target.value = '';
});

// ── Producer profile (portable .zip, secret-free) — the one consolidated export/import ──────
el('btn-export-profile')?.addEventListener('click', () => send('export_profile'));
el('btn-import-profile')?.addEventListener('click', () => {
  // Libraries + show settings always merge; overlay STYLES only when the producer asks (see applyProfileBundle).
  const replaceStyles = !!el('chk-import-settings')?.checked;
  send('import_profile', { options: { settings: true, styles: replaceStyles } });   // server opens a native file picker
});

// ── Cloud sync (Nameless backend) — UI stays hidden until the backend is configured ──
function cloudRequestStatus() { send('cloud_status'); }
el('btn-cloud-push')?.addEventListener('click', () => send('cloud_push_profile', { name: (currentState?.eventName || 'My Profile') }));
el('btn-cloud-refresh')?.addEventListener('click', () => send('cloud_list_profiles'));
el('cloud-profiles-list')?.addEventListener('click', (e) => {
  const load = e.target.closest('.cloud-load'); if (!load) return;
  const replaceStyles = !!el('chk-import-settings')?.checked;
  send('cloud_pull_profile', { id: load.dataset.id, options: { settings: true, styles: replaceStyles } });
});
el('tab-ajustes')?.addEventListener('click', cloudRequestStatus);   // section lives on the Settings tab
setTimeout(cloudRequestStatus, 1500);

function applyCloudStatus(s) {
  s = s || {};
  // Snapshot the PREVIOUS workspace before anything below overwrites it, so a real org switch
  // (including dropping to a personal workspace, or signing out) can be detected below and the
  // stale-org caches cleared — they're otherwise only ever overwritten by a fresh response, never
  // reset, so a revoked seat or a workspace change can leave the old org's camera/station data
  // sitting in state indefinitely with nothing to trigger a re-render.
  const prevWorkspaceId = window._cloudWorkspaceId || '';
  const block = el('cloud-sync-block'); if (block) block.style.display = s.configured ? '' : 'none';
  const pill = el('cloud-status-pill');
  if (pill) {
    if (!s.configured) { pill.textContent = 'Cloud: offline'; pill.className = 'stat-pill'; }
    else if (s.authed) { pill.textContent = 'Cloud: signed in' + (s.user?.username ? ' · ' + s.user.username : ''); pill.className = 'stat-pill ok'; }
    else { pill.textContent = 'Cloud: sign in required'; pill.className = 'stat-pill bad'; }
  }
  const push = el('btn-cloud-push'), refresh = el('btn-cloud-refresh');
  if (push) push.disabled = !s.authed;
  if (refresh) refresh.disabled = !s.authed;
  if (s.authed) send('cloud_list_profiles');

  const tup = el('ai-telemetry-upload-toggle');
  if (tup) tup.disabled = !s.authed;

  // ── Org workspace / broadcast-seat licensing ── workspaceId is a real Organization
  // id when the account has an active seat, or the synthetic "user:<id>" personal
  // workspace otherwise — only real orgs get the seat-management panel.
  window._cloudWorkspaceId = s.workspaceId || null;
  window._cloudRole = s.role || null;
  const isOrg = !!(s.workspaceId && !String(s.workspaceId).startsWith('user:'));
  const wsLine = el('cloud-workspace-line');
  if (wsLine) {
    wsLine.textContent = s.authed
      ? (isOrg ? `Workspace: ${s.orgName || s.workspaceId} · Role: ${s.role}` : 'Personal workspace (not in an organization)')
      : '';
  }
  renderCloudPlan(s);
  const seatsBlock = el('org-seats-block');
  const canManage = isOrg && (s.role === 'owner' || s.role === 'admin');
  if (seatsBlock) seatsBlock.style.display = canManage ? '' : 'none';
  if (canManage) send('cloud_list_org_seats', { orgId: s.workspaceId });
  if (isOrg) send('cloud_list_camera_feeds', { orgId: s.workspaceId });
  if (isOrg) send('cloud_list_station_feeds', { orgId: s.workspaceId });
  if (isOrg) send('cloud_list_stations', { orgId: s.workspaceId });   // station-binding picker + invite links
  window._cloudWorkspaceId = isOrg ? s.workspaceId : '';              // for re-requests (binding change)

  // Workspace actually changed (org→org, org→personal, or personal→org) — drop the previous
  // org's cached camera/station data instead of leaving it to linger until (if ever) fresh data
  // happens to arrive. The sends above already re-request current data when isOrg is true.
  if (window._cloudWorkspaceId !== prevWorkspaceId) {
    _pcamCloudFeedsCache = [];
    _cfStationsCache = [];
    window._cfStationsIndex = [];
    if (typeof renderCfStations === 'function') renderCfStations();
  }

  // Org Library sync + Invite Links — real-org only (both need a workspace to share into / mint from).
  const libBlock = el('org-library-block'), invBlock = el('org-invites-block');
  if (libBlock) libBlock.style.display = isOrg ? '' : 'none';
  if (invBlock) invBlock.style.display = isOrg ? '' : 'none';
  if (isOrg) renderOrgLibraryStatus();

  // Stations sub-tab on the Cameras page — only meaningful for a real org. Refresh it if it's open.
  const stTab = el('cf-tab-stations');
  if (stTab) stTab.style.display = isOrg ? '' : 'none';
  if (isOrg && el('cf-panel-stations') && el('cf-panel-stations').classList.contains('active') && typeof cfLoadStations === 'function') cfLoadStations();

  // Leagues website sync — org-scoped only (CompeteLeague requires an orgId); hidden entirely
  // for a solo/personal workspace rather than letting a producer hit a 403.
  const lgSyncGroup = el('lg-cloud-sync-group'), lgBrowseBtn = el('lg-cloud-browse-toggle');
  if (lgSyncGroup) lgSyncGroup.style.display = isOrg ? '' : 'none';
  if (lgBrowseBtn) lgBrowseBtn.style.display = isOrg ? '' : 'none';
  if (isOrg) send('cloud_list_leagues', { orgId: s.workspaceId });

  // Topbar organization indicator — the one always-visible cue that org-shared features
  // (teams/leagues/cameras/stations) exist at all. Solo producers see nothing extra.
  const orgChip = el('ck-chip-org');
  if (orgChip) {
    orgChip.style.display = isOrg ? '' : 'none';
    // orgName needs a website redeploy to show up — fall back to the raw workspace id
    // for anyone still on an older cached session so the chip never renders blank. The name
    // lives in its own inner span so the CSS ellipsis-truncation has a box to apply to.
    if (isOrg) orgChip.innerHTML = 'ORG: <span class="ck-org-name">' + esc(s.orgName || (s.workspaceId || '').slice(0, 18)) + '</span>';
  }
}
// Studio plan line under the workspace line in Settings, from the website's /api/broadcast/me
// (cloud-client getPlan). Display only: no feature is locked on it. Older websites send no plan,
// and then nothing is shown, exactly as before.
function renderCloudPlan(s) {
  const wsLine = el('cloud-workspace-line');
  if (!wsLine) return;
  let line = el('cloud-plan-line');
  if (!line) {
    line = document.createElement('p');
    line.id = 'cloud-plan-line';
    line.className = 'section-desc';
    line.style.marginTop = '4px';
    wsLine.insertAdjacentElement('afterend', line);
  }
  const p = s && s.authed ? s.plan : null;
  if (!p || (!p.tierName && !p.founding)) { line.style.display = 'none'; line.innerHTML = ''; return; }
  const ends = p.currentPeriodEnd ? new Date(p.currentPeriodEnd) : null;
  const endTxt = ends && !isNaN(ends.getTime())
    ? (p.source === 'stripe' ? ' · Renews ' : ' · Until ') + ends.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  const badge = p.founding
    ? ' <span class="stat-pill ok" style="margin-left:6px;" title="Thank you for producing with us during the beta.">Founding producer</span>'
    : '';
  line.innerHTML = 'Plan: <strong>' + esc(p.tierName || 'Broadcast Studio') + '</strong>' + esc(endTxt) + badge;
  line.style.display = '';
}
el('ck-chip-org')?.addEventListener('click', () => {
  document.getElementById('tab-ajustes')?.click();
  setTimeout(() => el('cloud-sync-block')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
});

// ── Org Library sync controls ──────────────────────────────────────────────
function renderOrgLibraryStatus() {
  const line = el('org-library-status'); if (!line) return;
  const o = (currentState && currentState.orgLibrary) || {};
  const chk = el('check-org-autosync'); if (chk) chk.checked = o.autoSync !== false;
  const teams = (currentState && currentState.savedTeams) || [];
  const orgTeams = Array.isArray(teams) ? teams.filter((t) => t && t._org).length : 0;
  const when = o.lastPull ? new Date(o.lastPull).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  line.textContent = o.autoSync === false
    ? 'Auto-sync is off — your library stays on this machine. Use the buttons to share or pull manually.'
    : `Syncing automatically.${orgTeams ? ` ${orgTeams} team${orgTeams === 1 ? '' : 's'} from your organization available.` : ''}${when ? ` Last pulled ${when}.` : ''}`;
}
el('check-org-autosync')?.addEventListener('change', (e) => send('cloud_set_autosync', { on: !!e.target.checked }));
el('btn-org-lib-pull')?.addEventListener('click', () => send('cloud_pull_org_library'));
el('btn-org-lib-push')?.addEventListener('click', () => send('cloud_push_org_library'));

// ── Invite-link generators ─────────────────────────────────────────────────
// Each button asks the server to mint the matching website link; the reply lands in
// cloud_invite_created → renderInviteResult(). Team-match pulls the two live match teams.
let _lastInviteContextual = false;
function requestInvite(kind, extra, opts) {
  const map = {
    match: 'cloud_create_match',
    caster: 'cloud_create_room',
    observer: 'cloud_create_room',
    camera: 'cloud_create_camera_session',
    talent: 'cloud_create_talent_invite'
  };
  const type = map[kind]; if (!type) return;
  // Team-match + talent links only need an approved producer account; caster/observer/camera rooms
  // are org-scoped tooling and need a real organization workspace.
  const isOrg = !!(window._cloudWorkspaceId && !String(window._cloudWorkspaceId).startsWith('user:'));
  const needsOrg = (kind === 'caster' || kind === 'observer' || kind === 'camera');
  if (needsOrg && !isOrg) { showToast('Sign in to your organization (Settings ▸ Organization) to create caster, observer or camera links.', '#c53030', 5000); return; }
  _lastInviteContextual = !!(opts && opts.contextual);
  const data = Object.assign({}, extra);
  if (kind === 'caster') data.kind = 'caster';
  if (kind === 'observer') data.kind = 'observer';
  const res = el('cloud-invite-result');
  if (res && !_lastInviteContextual) res.innerHTML = '<div class="section-desc">Generating link…</div>';
  if (_lastInviteContextual) showToast('Generating link…', '#3b82f6', 1500);
  send(type, data);
}
document.querySelectorAll('#org-invites-block [data-inv]').forEach((b) => {
  b.addEventListener('click', () => requestInvite(b.dataset.inv));
});
// Contextual "+ … link" buttons anywhere in the app (Camera Feeds, Series, …) — auto-copy + toast.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-inv-ctx]'); if (!b) return;
  requestInvite(b.dataset.invCtx, {}, { contextual: true });
});
function renderInviteResult(d) {
  // Contextual buttons (Casters / Camera Feeds / Series) auto-copy the link and toast — no panel needed.
  if (_lastInviteContextual && d && d.ok && d.url) {
    _lastInviteContextual = false;
    (async () => { try { await navigator.clipboard.writeText(d.url); showToast('Link copied to clipboard: ' + d.url, '#22c55e', 5000); } catch (_) { showToast('Link ready: ' + d.url, '#22c55e', 6000); } })();
  }
  const wrap = el('cloud-invite-result'); if (!wrap) return;
  if (!d || !d.ok || !d.url) { wrap.innerHTML = `<div class="section-desc" style="color:var(--danger);">${(d && d.message) || 'Could not create the link.'}</div>`; return; }
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const titles = { match: `Team match — ${d.teamA || 'Team A'} vs ${d.teamB || 'Team B'}`, room: d.roomKind === 'observer' ? 'Observer feeds room' : 'Caster room', camera: 'Camera assignments', talent: 'Talent invite' };
  const title = titles[d.kind] || 'Invite link';
  const meta = [];
  if (d.slots) meta.push(`${d.slots} slot${d.slots === 1 ? '' : 's'}`);
  if (d.expiresAt) meta.push('expires ' + new Date(d.expiresAt).toLocaleDateString());
  wrap.innerHTML = `
    <div class="preset-item" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <span class="preset-name">${esc(title)}</span>
        ${meta.length ? `<span class="section-desc" style="margin:0;">${esc(meta.join(' · '))}</span>` : ''}
      </div>
      <input type="text" class="input-text" id="cloud-invite-url" readonly value="${esc(d.url)}" onclick="this.select()" style="font-size:12px;">
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" id="cloud-invite-copy">Copy link</button>
        <button class="btn btn-secondary btn-sm" id="cloud-invite-open">Open</button>
      </div>
    </div>`;
  el('cloud-invite-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(d.url); } catch (_) { const i = el('cloud-invite-url'); if (i) { i.select(); document.execCommand('copy'); } }
    const b = el('cloud-invite-copy'); if (b) { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy link'; }, 1500); }
  });
  el('cloud-invite-open')?.addEventListener('click', () => { try { window.open(d.url, '_blank'); } catch (_) {} });
}

const ORG_SEAT_ROLES = ['owner', 'admin', 'producer', 'operator', 'talent', 'analyst'];
function renderOrgSeats(d) {
  const wrap = el('org-seats-list'); if (!wrap) return;
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  if (!d || !d.ok) { wrap.innerHTML = `<div class="section-desc">${d && d.message ? esc(d.message) : 'Could not load seats.'}</div>`; return; }
  const seats = d.seats || [];
  const limitLine = el('org-seats-limit');
  if (limitLine) limitLine.textContent = d.seatLimit != null ? `${d.seatsUsed ?? seats.length} / ${d.seatLimit} seats used` : 'Broadcast licensing not enabled for this org.';
  wrap.innerHTML = seats.length
    ? seats.map((seat) => {
        const name = (seat.user && (seat.user.name || seat.user.username)) || seat.userId;
        return `<div class="preset-item">
        <span class="preset-name">${esc(name)} — ${esc(seat.role)}</span>
        <div class="preset-actions"><button class="btn btn-danger btn-xs org-seat-remove" data-id="${esc(seat.id)}" data-name="${esc(name)}">Remove</button></div>
      </div>`;
      }).join('')
    : '<div class="section-desc">No producers added yet.</div>';
  wrap.querySelectorAll('.org-seat-remove').forEach((b) => b.addEventListener('click', async () => {
    if (!window._cloudWorkspaceId) return;
    const ok = await appConfirm(`Revoke ${b.dataset.name}'s seat? They'll lose access to this organization's broadcast tools immediately.`, 'Revoke Seat');
    if (!ok) return;
    send('cloud_remove_org_seat', { orgId: window._cloudWorkspaceId, seatId: b.dataset.id });
  }));
}
el('btn-org-seat-add')?.addEventListener('click', () => {
  if (!window._cloudWorkspaceId) return;
  const userId = (el('org-seat-userid')?.value || '').trim();
  const role = el('org-seat-role')?.value || 'producer';
  if (!userId) { const r = el('org-seats-result'); if (r) { r.textContent = 'Enter the producer’s Nameless user id.'; r.style.color = 'red'; } return; }
  send('cloud_add_org_seat', { orgId: window._cloudWorkspaceId, userId, role });
  el('org-seat-userid').value = '';
});
function renderCloudProfiles(d) {
  const wrap = el('cloud-profiles-list'); if (!wrap) return;
  if (!d || !d.ok) { wrap.innerHTML = `<div class="section-desc">${(d && d.message) ? String(d.message).replace(/</g,'&lt;') : 'Cloud unavailable.'}</div>`; return; }
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  // Yours first. Every producer's auto-synced library is named "My Profile" by default, so in an org
  // the list was N identical "My Profile" rows; the API sends `mine` + `ownerName` to tell them apart.
  const list = (d.profiles || []).slice().sort((a, b) => (a.mine === false) - (b.mine === false));
  // Org-share toggle: only meaningful for your OWN profiles (mine !== false), and only in an
  // org workspace — a solo/personal workspace has no team to share with.
  const isOrg = !!(window._cloudWorkspaceId && !String(window._cloudWorkspaceId).startsWith('user:'));
  wrap.innerHTML = list.length
    ? list.map((p) => {
        const shared = p.scope === 'workspace';
        const shareBtn = (p.mine !== false && isOrg)
          ? `<button class="btn btn-xs cloud-share-toggle ${shared ? 'btn-secondary' : 'btn-primary'}" data-id="${esc(p.id)}" data-scope="${shared ? 'private' : 'workspace'}" title="${shared ? 'Stop sharing this with your organization' : 'Share teams, brand kits & more in this profile with your organization'}">${shared ? 'Shared ✓' : 'Share with org'}</button>`
          : '';
        return `<div class="cloud-prof-row">
        <span class="cloud-prof-name">${esc(p.name) || '(unnamed)'} <span class="cloud-prof-owner">${p.mine === false ? esc(p.ownerName || 'A teammate') : 'You'}</span></span>
        <span class="cloud-prof-meta">${p.updatedAt ? 'Updated ' + new Date(p.updatedAt).toLocaleDateString() : ''}${p.scope === 'workspace' ? ' · shared with org' : p.scope ? ' · ' + esc(p.scope) : ''}</span>
        ${shareBtn}
        <button class="btn btn-secondary btn-xs cloud-load" data-id="${esc(p.id)}" title="Merge this profile in">Load</button>
      </div>`;
      }).join('')
    : '<div class="section-desc">No cloud profiles yet — “Sync to cloud” to save your first.</div>';
  wrap.querySelectorAll('.cloud-share-toggle').forEach((btn) => btn.addEventListener('click', async () => {
    // Only the sharing direction needs a yes — turning sharing OFF only reduces exposure.
    if (btn.dataset.scope === 'workspace') {
      const ok = await appConfirm('Share this profile — teams, brand kits, presets, casters and more — with everyone in your organization?', 'Share with Org', false);
      if (!ok) return;
    }
    send('cloud_share_profile', { id: btn.dataset.id, scope: btn.dataset.scope });
  }));
}


// ── Start.gg settings ─────────────────────────────────────────────────────
el('btn-startgg-change-token')?.addEventListener('click', () => {
  appConfirm(
    'A start.gg API token is already saved. Do you want to replace it? You will need to paste the full token again. You can find or generate tokens at: start.gg → your profile → Developer Settings → API Tokens.',
    'Replace Token'
  ).then(confirmed => {
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
});

el('btn-startgg-disconnect')?.addEventListener('click', () => {
  appConfirm(
    'Disconnect start.gg? This removes the saved API token and turns the integration off. Tournament/event slugs are kept — you can reconnect by pasting a token again.',
    'Disconnect', true
  ).then((confirmed) => {
    if (!confirmed) return;
    send('startgg_disconnect', {});
    const tokenEl = el('input-startgg-token');
    if (tokenEl) { tokenEl.readOnly = false; tokenEl.value = ''; tokenEl.style.opacity = ''; tokenEl.style.cursor = ''; tokenEl.placeholder = 'Paste your start.gg API token'; }
    ['btn-startgg-change-token', 'btn-startgg-disconnect', 'startgg-token-indicator'].forEach((id) => { const e = el(id); if (e) e.style.display = 'none'; });
    showToast('start.gg disconnected.', '#22c55e');
  });
});

el('btn-startgg-save')?.addEventListener('click', () => {
  send('set_startgg_settings', getStartggPayload());
});

el('btn-startgg-test')?.addEventListener('click', () => {
  send('set_startgg_settings', getStartggPayload());
  send('startgg_test_connection');
});

el('btn-startgg-sync')?.addEventListener('click', () => {
  send('set_startgg_settings', getStartggPayload());
  send('startgg_sync_set', { setId: el('input-startgg-setid')?.value.trim() || '' });
});

// ── Challengermode integration ────────────────────────────────────────────
// challengermode.com — a DIFFERENT platform from Challonge above. GraphQL + bot token, multi-stage
// tournaments, and real finish placements (including ties like "5-8").

function getChallengermodePayload() {
  return {
    enabled: !!(el('check-cm-enabled')?.checked),
    tournamentId: (el('input-cm-tournament')?.value || '').trim(),
    refreshKey: (el('input-cm-key')?.value || '').trim(),
    spaceId: (el('input-cm-space')?.value || '').trim(),
    pollSec: parseInt(el('input-cm-poll')?.value, 10) || 30
  };
}

el('btn-cm-save')?.addEventListener('click', () => {
  send('set_challengermode_settings', getChallengermodePayload());
  const r = el('cm-result'); if (r) { r._userMsg = true; r.style.color = 'var(--muted)'; r.textContent = 'Saved.'; }
});
el('input-cm-poll')?.addEventListener('change', () => send('set_challengermode_settings', getChallengermodePayload()));

el('btn-cm-test')?.addEventListener('click', () => {
  send('set_challengermode_settings', getChallengermodePayload());
  send('challengermode_test_connection');
  const r = el('cm-result'); if (r) { r._userMsg = true; r.style.color = 'var(--muted)'; r.textContent = 'Testing connection…'; }
});

el('btn-cm-load')?.addEventListener('click', () => {
  send('set_challengermode_settings', getChallengermodePayload());
  send('load_challengermode_tournament', { id: (el('input-cm-tournament')?.value || '').trim() });
  const r = el('cm-result'); if (r) { r._userMsg = true; r.style.color = 'var(--muted)'; r.textContent = 'Loading tournament…'; }
});

el('btn-cm-refresh')?.addEventListener('click', () => {
  send('challengermode_refresh');
  const r = el('cm-result'); if (r) { r._userMsg = true; r.style.color = 'var(--muted)'; r.textContent = 'Refreshing…'; }
});

el('cm-autofollow')?.addEventListener('change', (e) => {
  send('set_challengermode_auto_follow', { enabled: e.target.checked });
});

el('btn-cm-push-top8')?.addEventListener('click', () => send('push_challengermode_placements', { limit: 8 }));

el('btn-cm-change-key')?.addEventListener('click', () => {
  const k = el('input-cm-key');
  if (!k) return;
  k.readOnly = false; k.value = ''; k.placeholder = 'Paste your Challengermode refresh key';
  k.style.opacity = '1'; k.style.cursor = 'text'; k.focus();
  const b = el('btn-cm-change-key'); if (b) b.style.display = 'none';
});

function renderChallengermodeSettings(data) {
  const c = data.challengermode || {};
  const enabledCb = el('check-cm-enabled');
  const idInp = el('input-cm-tournament');
  const keyInp = el('input-cm-key');
  const badge = el('cm-conn-badge');
  const changeBtn = el('btn-cm-change-key');
  const refreshBtn = el('btn-cm-refresh');
  const infoWrap = el('cm-tournament-info');

  if (enabledCb && document.activeElement !== enabledCb) enabledCb.checked = !!c.enabled;
  if (idInp && document.activeElement !== idInp) idInp.value = c.tournamentId || '';

  // A stored key is never sent back to the client — show it as masked and offer a re-entry path.
  if (keyInp && c.hasKey && !keyInp.value && !keyInp.readOnly) {
    keyInp.readOnly = true; keyInp.value = ''; keyInp.placeholder = '••••••••••••••••••••';
    keyInp.style.opacity = '0.5'; keyInp.style.cursor = 'default';
    if (changeBtn) changeBtn.style.display = '';
  }
  if (badge) badge.style.display = c.connected ? '' : 'none';
  if (refreshBtn) refreshBtn.style.display = c.selectedTournament ? '' : 'none';

  const pollSel = el('input-cm-poll');
  if (pollSel && document.activeElement !== pollSel) {
    const v = String(c.pollSec || 30);
    if (![].some.call(pollSel.options, (o) => o.value === v)) pollSel.add(new Option('Every ' + v + ' seconds', v));
    pollSel.value = v;
  }

  const af = el('cm-autofollow');
  if (af && document.activeElement !== af) af.checked = !!c.autoFollow;

  const spaceInp = el('input-cm-space');
  if (spaceInp && document.activeElement !== spaceInp) spaceInp.value = c.spaceId || '';
  // A changed Space id invalidates the cached tournament list, or a producer who sets it AFTER
  // first opening the Events panel keeps looking at the empty result it cached.
  if (_evCmSpaceSeen !== (c.spaceId || '')) { _evCmSpaceSeen = c.spaceId || ''; _evCmList = null; }
  // The Events-page hint depends on both the key and the Space id, so refresh it from here — it is
  // the one place that sees every change to either.
  if (typeof evCmHint === 'function') evCmHint();

  if (c.selectedTournament && infoWrap) {
    infoWrap.style.display = '';
    const t = c.selectedTournament;
    const nameEl = el('cm-t-name'); if (nameEl) nameEl.textContent = t.name || '';
    const metaEl = el('cm-t-meta');
    if (metaEl) {
      // Say what the game resolved to. Loading a tournament can SWITCH the active game, and a
      // silent switch is alarming; a game we could not recognise is worth flagging, because the
      // overlay then stays on whatever was already active.
      const gName = ((currentState.games || {})[c.gameId] || {}).name || '';
      const gNote = c.gameId ? (c.gameApplied ? ' · switched to ' + gName : ' · ' + gName)
                             : (t.gameName ? ' · game not recognised - pick it in the header' : '');
      const stages = ((currentState.bracket || {}).phases || []).length;
      metaEl.textContent = [
        t.state ? t.state.charAt(0) + t.state.slice(1).toLowerCase() : '',
        t.gameName,
        t.lineupCount ? t.lineupCount + ' entrants' : '',
        stages > 1 ? stages + ' stages' : ''
      ].filter(Boolean).join(' · ') + gNote;
    }
    const linkEl = el('cm-t-link'); if (linkEl && t.url) linkEl.href = t.url;

    // Say how much finish order exists, so "Push Top 8" is never a guess.
    const note = el('cm-placement-note');
    if (note) {
      const pl = data.challengermodePlacements || {};
      const n = (pl.rows || []).length;
      note.textContent = !n
        ? 'No finish order yet — Challengermode assigns a placement once an entrant is out.'
        : `${n} placement${n === 1 ? '' : 's'} known${pl.complete ? ' · final' : ' · still updating'}`;
    }
  } else if (infoWrap) {
    infoWrap.style.display = 'none';
  }

  const resultEl = el('cm-result');
  if (resultEl && c.lastError && !resultEl._userMsg) {
    resultEl.style.color = '#f87171'; resultEl.textContent = c.lastError;
  }
}

// Server replies to every Challengermode action on one channel. Exposed on `window` and called
// from the socket dispatch, the same way every other platform's result box is wired.
window._handleChallengermodeResult = function (d) {
  d = d || {};
  const r = el('cm-result');
  if (!r) return;
  r._userMsg = true;
  r.style.color = d.ok ? '#86efac' : '#f87171';
  r.textContent = d.message || (d.ok ? 'Done.' : 'Failed.');
  // Let a later state push own the line again once the producer has read this one.
  clearTimeout(r._clear);
  r._clear = setTimeout(() => { r._userMsg = false; }, 8000);
};

// ── Challonge integration ─────────────────────────────────────────────────

function getChallongePayload() {
  return {
    enabled: !!(el('check-challonge-enabled')?.checked),
    tournamentSlug: (el('input-challonge-slug')?.value || '').trim(),
    apiKey: (el('input-challonge-key')?.value || '').trim(),
    pollSec: parseInt(el('input-challonge-poll')?.value, 10) || 30
  };
}

el('btn-challonge-save')?.addEventListener('click', () => {
  send('set_challonge_settings', getChallongePayload());
});

// The poll interval is the dial for the API quota, so it applies on change rather than waiting for
// a Save the producer may not think to press while a bracket is already polling.
el('input-challonge-poll')?.addEventListener('change', () => {
  send('set_challonge_settings', getChallongePayload());
});

el('btn-challonge-test')?.addEventListener('click', () => {
  send('set_challonge_settings', getChallongePayload());
  send('challonge_test_connection');
  const r = el('challonge-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Testing connection…'; }
});

el('btn-challonge-load')?.addEventListener('click', () => {
  const slug = (el('input-challonge-slug')?.value || '').trim();
  if (!slug) { const r = el('challonge-result'); if (r) { r.style.color = '#f87171'; r.textContent = 'Enter a tournament slug first.'; } return; }
  send('set_challonge_settings', getChallongePayload());
  send('load_challonge_tournament', { slug });
});

el('btn-challonge-refresh')?.addEventListener('click', () => {
  send('challonge_refresh');
  const r = el('challonge-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Refreshing…'; }
});

el('btn-challonge-change-key')?.addEventListener('click', () => {
  const inp = el('input-challonge-key');
  const btn = el('btn-challonge-change-key');
  if (!inp) return;
  inp.readOnly = false; inp.value = ''; inp.placeholder = 'Paste your new Challonge API key';
  inp.style.opacity = ''; inp.style.cursor = '';
  if (btn) btn.style.display = 'none';
  inp.focus();
});

el('btn-challonge-import-teams')?.addEventListener('click', () => {
  send('import_challonge_teams', { slug: (el('input-challonge-slug')?.value || '').trim() });
  const r = el('challonge-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Importing teams…'; }
});

function renderChallongeSettings(data) {
  const c = data.challonge || {};
  const enabledCb = el('check-challonge-enabled');
  const slugInp   = el('input-challonge-slug');
  const keyInp    = el('input-challonge-key');
  const badge     = el('challonge-conn-badge');
  const changeBtn = el('btn-challonge-change-key');
  const refreshBtn = el('btn-challonge-refresh');
  const infoWrap  = el('challonge-tournament-info');

  if (enabledCb && document.activeElement !== enabledCb) enabledCb.checked = !!c.enabled;
  if (slugInp && document.activeElement !== slugInp) slugInp.value = c.tournamentSlug || '';

  if (keyInp && c.hasKey && !keyInp.value) {
    keyInp.readOnly = true; keyInp.value = ''; keyInp.placeholder = '••••••••••••••••••••';
    keyInp.style.opacity = '0.5'; keyInp.style.cursor = 'default';
    if (changeBtn) changeBtn.style.display = '';
  }
  if (badge) badge.style.display = c.connected ? '' : 'none';
  if (refreshBtn) refreshBtn.style.display = c.selectedTournament ? '' : 'none';

  // Poll interval + this month's API spend. Challonge's free plan is 500 requests/month and each
  // poll costs three — a producer needs to see that number BEFORE a 429 kills the bracket on air.
  const pollSel = el('input-challonge-poll');
  if (pollSel && document.activeElement !== pollSel) {
    const v = String(c.pollSec || 30);
    if (![].some.call(pollSel.options, (o) => o.value === v)) pollSel.add(new Option('Every ' + v + ' seconds', v));
    pollSel.value = v;
  }
  const budgetEl = el('challonge-budget');
  if (budgetEl) {
    const b = c.budget || {};
    const used = Number(b.used) || 0;
    const limit = Number(b.limit) || 500;
    const pct = limit ? used / limit : 0;
    budgetEl.textContent = used ? `${used} / ${limit} requests this month` : '';
    budgetEl.style.color = pct >= 1 ? '#f87171' : pct >= 0.8 ? '#fbbf24' : 'var(--muted)';
    budgetEl.title = pct >= 0.8
      ? "Close to Challonge's free-plan limit. Past it the API returns 429 and the bracket stops updating — raise the interval or upgrade the plan."
      : 'Counted since the start of this calendar month. A paid Challonge plan raises the limit.';
  }

  // Tournament info panel
  if (c.selectedTournament && infoWrap) {
    infoWrap.style.display = '';
    const t = c.selectedTournament;
    const nameEl = el('challonge-t-name'); if (nameEl) nameEl.textContent = t.name || '';
    const metaEl = el('challonge-t-meta');
    if (metaEl) {
      // Say what the tournament's game resolved to. Loading a bracket can SWITCH the active game
      // (that is what makes Challonge work across games), and a silent switch is alarming — while
      // a game we couldn't recognise is worth flagging, because the overlay then stays on whatever
      // was already active.
      const gName = ((currentState.games || {})[c.gameId] || {}).name || '';
      const gNote = c.gameId
        ? (c.gameApplied ? ' · switched to ' + gName : ' · ' + gName)
        : (t.gameName ? " · game not recognised - pick it in the header" : '');
      metaEl.textContent = [t.type, t.gameName, t.state ? t.state.charAt(0).toUpperCase() + t.state.slice(1) : ''].filter(Boolean).join(' · ') + gNote;
    }
    const linkEl = el('challonge-t-link'); if (linkEl && t.url) { linkEl.href = t.url; }
    const labelEl = el('challonge-teams-label');
    if (labelEl) labelEl.textContent = `Participants (${(c.eventTeams || []).length})`;
    renderChallongeTeams(c.eventTeams || []);
    renderChallongeQueue(c.queue || []);
  } else if (infoWrap) {
    infoWrap.style.display = 'none';
  }

  const resultEl = el('challonge-result');
  if (resultEl && c.lastError && !resultEl._userMsg) {
    resultEl.style.color = '#f87171'; resultEl.textContent = c.lastError;
  }
}

function renderChallongeTeams(teams) {
  const list = el('challonge-teams-list'); if (!list) return;
  if (!teams.length) { list.innerHTML = '<p class="sps-empty">No participants loaded.</p>'; return; }
  list.innerHTML = teams.map((t) =>
    `<div style="display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:6px; background:rgba(255,255,255,.03);">
      ${t.logo ? `<img src="${t.logo}" style="width:20px; height:20px; object-fit:contain; border-radius:3px;">` : '<span style="width:20px; height:20px; background:rgba(255,255,255,.08); border-radius:3px; display:inline-block;"></span>'}
      <span style="flex:1; font-size:12px;">${t.name.replace(/</g,'&lt;')}</span>
      ${t.seed ? `<span style="font-size:10px; color:var(--muted);">#${t.seed}</span>` : ''}
    </div>`
  ).join('');
}

function renderChallongeQueue(queue) {
  const list = el('challonge-queue-list');
  const empty = el('challonge-queue-empty');
  if (!list) return;
  const open = queue.filter((m) => ['open', 'pending'].includes(m.state));
  if (empty) empty.style.display = open.length ? 'none' : '';
  list.innerHTML = open.map((m) =>
    `<div class="challonge-queue-row" style="display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:6px; background:rgba(255,255,255,.04); border:1px solid ${m.live ? 'rgba(236,72,153,.3)' : 'var(--border)'};">
      ${m.live ? '<span style="font-size:10px; font-weight:700; color:#7C3AED; flex-shrink:0;">LIVE</span>' : `<span style="font-size:10px; color:var(--muted); flex-shrink:0;">${m.identifier || 'M'}</span>`}
      <span style="flex:1; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${(m.teamA || 'TBD').replace(/</g,'&lt;')} <span style="color:var(--muted);">vs</span> ${(m.teamB || 'TBD').replace(/</g,'&lt;')}</span>
      <button class="btn btn-ghost btn-xs challonge-sync-btn" data-match-id="${m.matchId}" data-team-a="${(m.teamA||'').replace(/"/g,'&quot;')}" data-team-b="${(m.teamB||'').replace(/"/g,'&quot;')}" data-logo-a="${(m.logoA||'').replace(/"/g,'&quot;')}" data-logo-b="${(m.logoB||'').replace(/"/g,'&quot;')}" title="Set as current match (Blue vs Orange)">Set Live</button>
    </div>`
  ).join('');
  list.querySelectorAll('.challonge-sync-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.teamA, b = btn.dataset.teamB;
      const la = btn.dataset.logoA || null, lb = btn.dataset.logoB || null;
      send('set_team', { side: 'blue',   name: a, ...(la ? { logo: la } : {}) });
      send('set_team', { side: 'orange', name: b, ...(lb ? { logo: lb } : {}) });
    });
  });
}

// Handle challonge-result WS messages
window._handleChallongeResult = function(data) {
  // Update integrations panel result element
  const r = el('challonge-result');
  if (r) {
    r._userMsg = true;
    r.style.color = data.ok ? '#86efac' : '#f87171';
    r.textContent = data.message || '';
    setTimeout(() => { r._userMsg = false; }, 5000);
  }
  // Update dashboard load status when loading from dashboard
  const status = el('ev-load-status');
  if (status && _evActivePlatform === 'challonge') {
    status.style.color = data.ok ? '#86efac' : '#f87171';
    status.textContent = data.message || '';
    setTimeout(() => { status.style.color = ''; status.textContent = 'Imports teams, bracket & match queue.'; }, 4000);
  }
};

// ── NXGEN ────────────────────────────────────────────────────────────────────

function getNxgenPayload() {
  return {
    enabled: !!(el('check-nxgen-enabled')?.checked),
    eventSlug: (el('input-nxgen-slug')?.value || '').trim(),
    apiKey: (el('input-nxgen-key')?.value || '').trim()
  };
}

el('btn-nxgen-save')?.addEventListener('click', () => {
  send('set_nxgen_settings', getNxgenPayload());
});

el('btn-nxgen-test')?.addEventListener('click', () => {
  send('set_nxgen_settings', getNxgenPayload());
  send('nxgen_test_connection');
  const r = el('nxgen-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Testing connection…'; }
});

el('btn-nxgen-load')?.addEventListener('click', () => {
  const slug = (el('input-nxgen-slug')?.value || '').trim();
  if (!slug) { const r = el('nxgen-result'); if (r) { r.style.color = '#f87171'; r.textContent = 'Enter an event slug first.'; } return; }
  send('set_nxgen_settings', getNxgenPayload());
  send('load_nxgen_event', { slug });
});

el('btn-nxgen-refresh')?.addEventListener('click', () => {
  send('nxgen_refresh');
  const r = el('nxgen-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Refreshing…'; }
});

el('btn-nxgen-change-key')?.addEventListener('click', () => {
  const inp = el('input-nxgen-key');
  const btn = el('btn-nxgen-change-key');
  if (!inp) return;
  inp.readOnly = false; inp.value = ''; inp.placeholder = 'Paste your new NXGEN API key (nxk_…)';
  inp.style.opacity = ''; inp.style.cursor = '';
  if (btn) btn.style.display = 'none';
  inp.focus();
});

// ── Google Sheets integration (Marketplace ▸ Integrations) ─────────────────────────
function getSheetsPayload() {
  const p = {
    enabled: !!(el('check-sheets-enabled')?.checked),
    sheetUrl: (el('input-sheets-url')?.value || '').trim(),
    autoSyncSec: Math.max(0, parseInt(el('input-sheets-autosync')?.value, 10) || 0),
    maps: {}
  };
  ['teams', 'schedule', 'standings'].forEach((k) => {
    p.maps[k] = { tab: el('sheets-tab-' + k)?.value || '', direction: el('sheets-dir-' + k)?.value || 'off' };
  });
  const sa = (el('input-sheets-sa')?.value || '').trim();
  if (sa) p.serviceAccount = sa;   // only send the key when the producer pasted a new one
  return p;
}
function _sheetsSaveThen(extraType, statusMsg) {
  send('set_sheets_config', getSheetsPayload());
  const saEl = el('input-sheets-sa'); if (saEl) saEl.value = '';   // never keep the key sitting in the field
  if (extraType) send(extraType);
  const r = el('sheets-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = statusMsg; }
}
el('btn-sheets-save')?.addEventListener('click', () => _sheetsSaveThen(null, 'Saved.'));
el('btn-sheets-connect')?.addEventListener('click', () => _sheetsSaveThen('sheets_connect', 'Connecting…'));
el('btn-sheets-sync')?.addEventListener('click', () => _sheetsSaveThen('sheets_sync', 'Syncing…'));

function syncSheetsUi(data) {
  const s = (data && data.sheets) || {};
  const cb = el('check-sheets-enabled'); if (!cb) return;
  if (document.activeElement !== cb) cb.checked = !!s.enabled;
  const url = el('input-sheets-url'); if (url && document.activeElement !== url) url.value = s.sheetUrl || '';
  const as = el('input-sheets-autosync'); if (as && document.activeElement !== as) as.value = s.autoSyncSec || 0;
  const tabs = Array.isArray(s.tabs) ? s.tabs : [];
  ['teams', 'schedule', 'standings'].forEach((k) => {
    const tsel = el('sheets-tab-' + k);
    const cur = (s.maps && s.maps[k] && s.maps[k].tab) || '';
    if (tsel && document.activeElement !== tsel) {
      const sig = JSON.stringify(tabs) + '|' + cur;
      if (tsel.dataset.sig !== sig) {
        tsel.dataset.sig = sig;
        const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        let opts = '<option value="">— tab —</option>' + tabs.map((t) => '<option value="' + esc(t) + '"' + (t === cur ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
        if (cur && !tabs.includes(cur)) opts += '<option value="' + esc(cur) + '" selected>' + esc(cur) + ' (not found)</option>';
        tsel.innerHTML = opts;
      }
    }
    const dsel = el('sheets-dir-' + k);
    if (dsel && document.activeElement !== dsel) dsel.value = (s.maps && s.maps[k] && s.maps[k].direction) || 'off';
  });
  const badge = el('sheets-conn-badge'); if (badge) badge.style.display = s.connected ? '' : 'none';
  const email = el('sheets-sa-email');
  if (email) email.textContent = s.hasKey
    ? (s.saEmail ? ('Share your sheet (Editor) with: ' + s.saEmail) : 'Service-account key set.')
    : 'No service-account key yet — paste one above and Save.';
  const saField = el('input-sheets-sa');
  if (saField) saField.placeholder = s.hasKey ? 'Key saved. Paste a new JSON key here only to replace it.' : 'Paste the whole service-account JSON key here…';
  const lm = el('sheets-result');
  if (lm && !lm.textContent && s.lastSyncMsg) { lm.style.color = 'var(--muted)'; lm.textContent = s.lastSyncMsg; }
}

el('btn-nxgen-import-teams')?.addEventListener('click', () => {
  send('nxgen_import_teams');
  const r = el('nxgen-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Importing teams…'; }
});

function renderNxgenSettings(data) {
  const nx = data.nxgen || {};
  const enabledCb  = el('check-nxgen-enabled');
  const slugInp    = el('input-nxgen-slug');
  const keyInp     = el('input-nxgen-key');
  const badge      = el('nxgen-conn-badge');
  const changeBtn  = el('btn-nxgen-change-key');
  const refreshBtn = el('btn-nxgen-refresh');
  const infoWrap   = el('nxgen-event-info');

  if (enabledCb && document.activeElement !== enabledCb) enabledCb.checked = !!nx.enabled;
  if (slugInp && document.activeElement !== slugInp) slugInp.value = nx.eventSlug || '';

  if (keyInp && nx.hasKey && !keyInp.value) {
    keyInp.readOnly = true; keyInp.value = ''; keyInp.placeholder = '••••••••••••••••••••';
    keyInp.style.opacity = '0.5'; keyInp.style.cursor = 'default';
    if (changeBtn) changeBtn.style.display = '';
  }
  if (badge) badge.style.display = nx.connected ? '' : 'none';
  if (refreshBtn) refreshBtn.style.display = nx.selectedEvent ? '' : 'none';

  if (nx.selectedEvent && infoWrap) {
    infoWrap.style.display = '';
    const ev = nx.selectedEvent;
    const nameEl = el('nxgen-ev-name'); if (nameEl) nameEl.textContent = ev.name || '';
    const metaEl = el('nxgen-ev-meta');
    if (metaEl) metaEl.textContent = [ev.activity, ev.format, ev.status ? ev.status.charAt(0).toUpperCase() + ev.status.slice(1) : ''].filter(Boolean).join(' · ');
    const linkEl = el('nxgen-ev-link'); if (linkEl && ev.url) { linkEl.href = ev.url; }
    const labelEl = el('nxgen-teams-label');
    if (labelEl) labelEl.textContent = `Participants (${(nx.eventTeams || []).length})`;
    renderNxgenTeams(nx.eventTeams || []);
    renderNxgenQueueInSettings(nx.queue || []);
  } else if (infoWrap) {
    infoWrap.style.display = 'none';
  }

  const resultEl = el('nxgen-result');
  if (resultEl && nx.lastError && !resultEl._userMsg) {
    resultEl.style.color = '#f87171'; resultEl.textContent = nx.lastError;
  }
}

// ── Ballchasing.com (Rocket League replay stats) — Settings panel ──────────
function renderBallchasingSettings(data) {
  const b = data.ballchasing || {};
  const keyInp = el('input-ballchasing-key');
  const indicator = el('ballchasing-key-indicator');
  const changeBtn = el('btn-ballchasing-change-key');
  const disconnectBtn = el('btn-ballchasing-disconnect');
  const resultEl = el('ballchasing-result');

  if (keyInp) {
    if (b.hasKey && !keyInp.value) {
      keyInp.readOnly = true; keyInp.value = ''; keyInp.placeholder = '••••••••••••••••••••';
      keyInp.style.opacity = '0.5'; keyInp.style.cursor = 'default';
      if (changeBtn) changeBtn.style.display = '';
      if (disconnectBtn) disconnectBtn.style.display = '';
      if (indicator) indicator.style.display = b.connected ? '' : 'none';
    } else if (!b.hasKey) {
      keyInp.readOnly = false; keyInp.style.opacity = ''; keyInp.style.cursor = '';
      keyInp.placeholder = 'Paste your ballchasing.com API key';
      if (changeBtn) changeBtn.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      if (indicator) indicator.style.display = 'none';
    }
  }

  if (resultEl && b.lastError && !resultEl._userMsg) {
    resultEl.style.color = '#f56565'; resultEl.textContent = 'Last error: ' + b.lastError;
  }

  const au = b.autoUpload || {};
  const autoCb = el('check-ballchasing-autoupload');
  const autoOpts = el('ballchasing-autoupload-opts');
  const folderInp = el('input-ballchasing-folder');
  const leagueSel = el('select-ballchasing-autoleague');
  if (autoCb && document.activeElement !== autoCb) autoCb.checked = !!au.enabled;
  if (autoOpts) autoOpts.style.display = au.enabled ? 'flex' : 'none';
  if (folderInp && document.activeElement !== folderInp) folderInp.value = au.folder || '';
  if (leagueSel && document.activeElement !== leagueSel) {
    const rlLeagues = (data.leagues || []).filter((lg) => lg.game === 'rocket-league' && lg.ballchasing && lg.ballchasing.groupId);
    leagueSel.innerHTML = '<option value="">— pick a league with Ballchasing enabled —</option>'
      + rlLeagues.map((lg) => `<option value="${escapeHtml(lg.id)}"${au.activeLeagueId === lg.id ? ' selected' : ''}>${escapeHtml(lg.name || 'Unnamed league')}</option>`).join('');
  }

  const rr = b.replayRename || {};
  const rrCb = el('check-ballchasing-replayrename');
  const rrOpts = el('ballchasing-replayrename-opts');
  const rrFolderInp = el('input-ballchasing-replayrename-folder');
  const rrLeagueSel = el('select-ballchasing-replayrename-league');
  if (rrCb && document.activeElement !== rrCb) rrCb.checked = !!rr.enabled;
  if (rrOpts) rrOpts.style.display = rr.enabled ? 'flex' : 'none';
  if (rrFolderInp && document.activeElement !== rrFolderInp) rrFolderInp.value = rr.folder || '';
  if (rrLeagueSel && document.activeElement !== rrLeagueSel) {
    const rlLeagues = (data.leagues || []).filter((lg) => lg.game === 'rocket-league' && lg.ballchasing && lg.ballchasing.groupId);
    rrLeagueSel.innerHTML = '<option value="">— pick a league with Ballchasing enabled —</option>'
      + rlLeagues.map((lg) => `<option value="${escapeHtml(lg.id)}"${rr.activeLeagueId === lg.id ? ' selected' : ''}>${escapeHtml(lg.name || 'Unnamed league')}</option>`).join('');
  }
}

window._handleBallchasingResult = function (data) {
  const r = el('ballchasing-result');
  if (r) {
    r._userMsg = true;
    r.style.color = data.ok ? '#86efac' : '#f87171';
    r.textContent = data.message || '';
    setTimeout(() => { r._userMsg = false; }, 5000);
  }
};

el('btn-ballchasing-save')?.addEventListener('click', () => {
  const key = el('input-ballchasing-key')?.value.trim() || '';
  send('set_ballchasing_settings', { apiKey: key });
  if (key) showToast('Ballchasing key saved.', '#22c55e');
});

el('btn-ballchasing-test')?.addEventListener('click', () => {
  const key = el('input-ballchasing-key')?.value.trim() || '';
  if (key) send('set_ballchasing_settings', { apiKey: key });
  send('ballchasing_test_connection');
});

el('btn-ballchasing-change-key')?.addEventListener('click', () => {
  const keyEl = el('input-ballchasing-key');
  const changeBtn = el('btn-ballchasing-change-key');
  const indicator = el('ballchasing-key-indicator');
  if (!keyEl) return;
  keyEl.readOnly = false; keyEl.value = ''; keyEl.placeholder = 'Paste your new ballchasing.com API key';
  keyEl.style.opacity = ''; keyEl.style.cursor = '';
  if (changeBtn) changeBtn.style.display = 'none';
  if (indicator) indicator.style.display = 'none';
  keyEl.focus();
});

el('btn-ballchasing-disconnect')?.addEventListener('click', () => {
  appConfirm(
    'Disconnect ballchasing.com? This removes the saved API key. Any leagues with Ballchasing enabled keep their group link — reconnect by pasting a key again.',
    'Disconnect', true
  ).then((confirmed) => {
    if (!confirmed) return;
    send('ballchasing_disconnect', {});
    const keyEl = el('input-ballchasing-key');
    if (keyEl) { keyEl.readOnly = false; keyEl.value = ''; keyEl.style.opacity = ''; keyEl.style.cursor = ''; keyEl.placeholder = 'Paste your ballchasing.com API key'; }
    ['btn-ballchasing-change-key', 'btn-ballchasing-disconnect', 'ballchasing-key-indicator'].forEach((id) => { const e = el(id); if (e) e.style.display = 'none'; });
    showToast('Ballchasing disconnected.', '#22c55e');
  });
});

el('check-ballchasing-autoupload')?.addEventListener('change', function () {
  const folder = el('input-ballchasing-folder')?.value.trim() || '';
  const activeLeagueId = el('select-ballchasing-autoleague')?.value || '';
  send('set_ballchasing_autoupload', { enabled: this.checked, folder, activeLeagueId });
});
el('input-ballchasing-folder')?.addEventListener('change', function () {
  send('set_ballchasing_autoupload', {
    enabled: !!el('check-ballchasing-autoupload')?.checked,
    folder: this.value.trim(),
    activeLeagueId: el('select-ballchasing-autoleague')?.value || ''
  });
});
el('select-ballchasing-autoleague')?.addEventListener('change', function () {
  send('set_ballchasing_autoupload', {
    enabled: !!el('check-ballchasing-autoupload')?.checked,
    folder: el('input-ballchasing-folder')?.value.trim() || '',
    activeLeagueId: this.value
  });
});
el('btn-ballchasing-browse-folder')?.addEventListener('click', () => {
  send('ballchasing_pick_autoupload_folder', {});
});

el('check-ballchasing-replayrename')?.addEventListener('change', function () {
  send('set_ballchasing_replayrename', {
    enabled: this.checked,
    folder: el('input-ballchasing-replayrename-folder')?.value.trim() || '',
    activeLeagueId: el('select-ballchasing-replayrename-league')?.value || ''
  });
});
el('input-ballchasing-replayrename-folder')?.addEventListener('change', function () {
  send('set_ballchasing_replayrename', {
    enabled: !!el('check-ballchasing-replayrename')?.checked,
    folder: this.value.trim(),
    activeLeagueId: el('select-ballchasing-replayrename-league')?.value || ''
  });
});
el('select-ballchasing-replayrename-league')?.addEventListener('change', function () {
  send('set_ballchasing_replayrename', {
    enabled: !!el('check-ballchasing-replayrename')?.checked,
    folder: el('input-ballchasing-replayrename-folder')?.value.trim() || '',
    activeLeagueId: this.value
  });
});
el('btn-ballchasing-replayrename-browse-folder')?.addEventListener('click', () => {
  send('ballchasing_pick_replayrename_folder', {});
});
el('btn-ballchasing-run-replayrename')?.addEventListener('click', function () {
  this.disabled = true;
  const status = el('ballchasing-replayrename-status');
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Scanning…'; }
  send('ballchasing_run_replayrename', {});
});

window._handleReplayRenameResult = function (data) {
  const btn = el('btn-ballchasing-run-replayrename');
  if (btn) btn.disabled = false;
  const status = el('ballchasing-replayrename-status');
  if (status) { status.style.color = data.ok ? '#86efac' : '#f87171'; status.textContent = data.message || ''; }
  const box = el('ballchasing-replayrename-results');
  if (!box) return;
  const rows = data.results || [];
  box.style.display = rows.length ? '' : 'none';
  box.innerHTML = rows.map((r) => {
    const ok = r.uploaded;
    const color = ok ? '#86efac' : (r.newName ? '#facc15' : '#94a3b8');
    const detail = r.newName
      ? `→ ${escapeHtml(r.newName)}${ok ? ' (uploaded)' : r.error ? ` — upload failed: ${escapeHtml(r.error)}` : ''}`
      : `no match: ${escapeHtml(r.error || 'unknown')}`;
    return `<div style="padding:2px 0; color:${color};">${escapeHtml(r.originalName)} ${detail}</div>`;
  }).join('');
};

function renderNxgenTeams(teams) {
  const list = el('nxgen-teams-list'); if (!list) return;
  if (!teams.length) { list.innerHTML = '<p class="sps-empty">No participants loaded.</p>'; return; }
  list.innerHTML = teams.map((t) =>
    `<div style="display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:6px; background:rgba(255,255,255,.03);">
      ${t.logo ? `<img src="${t.logo}" style="width:20px; height:20px; object-fit:contain; border-radius:3px;">` : '<span style="width:20px; height:20px; background:rgba(255,255,255,.08); border-radius:3px; display:inline-block;"></span>'}
      <span style="flex:1; font-size:12px;">${escapeHtml(t.name || '')}</span>
    </div>`
  ).join('');
}

function renderNxgenQueueInSettings(queue) {
  const list  = el('nxgen-queue-list');
  const empty = el('nxgen-queue-empty');
  if (!list) return;
  const open = (queue || []).filter(m => m.status !== 'completed');
  if (empty) empty.style.display = open.length ? 'none' : '';
  list.innerHTML = open.map((m) =>
    `<div style="display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:6px; background:rgba(255,255,255,.04); border:1px solid ${m.live ? 'rgba(236,72,153,.3)' : 'var(--border)'};">
      ${m.live ? '<span style="font-size:10px; font-weight:700; color:#7C3AED; flex-shrink:0;">LIVE</span>' : `<span style="font-size:10px; color:var(--muted); flex-shrink:0;">R${m.round || '?'}</span>`}
      <span style="flex:1; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(m.teamA || 'TBD')} <span style="color:var(--muted);">vs</span> ${escapeHtml(m.teamB || 'TBD')}</span>
      <button class="btn btn-ghost btn-xs nxgen-set-live-btn" data-team-a="${(m.teamA||'').replace(/"/g,'&quot;')}" data-team-b="${(m.teamB||'').replace(/"/g,'&quot;')}" data-logo-a="${(m.logoA||'').replace(/"/g,'&quot;')}" data-logo-b="${(m.logoB||'').replace(/"/g,'&quot;')}" title="Set as current match">Set Live</button>
    </div>`
  ).join('');
  list.querySelectorAll('.nxgen-set-live-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      send('set_team', { side: 'blue',   name: btn.dataset.teamA, ...(btn.dataset.logoA ? { logo: btn.dataset.logoA } : {}) });
      send('set_team', { side: 'orange', name: btn.dataset.teamB, ...(btn.dataset.logoB ? { logo: btn.dataset.logoB } : {}) });
    });
  });
}

window._handleNxgenResult = function(data) {
  const r = el('nxgen-result');
  if (r) {
    r._userMsg = true;
    r.style.color = data.ok ? '#86efac' : '#f87171';
    r.textContent = data.message || '';
    setTimeout(() => { r._userMsg = false; }, 5000);
  }
  const status = el('ev-load-status');
  if (status && _evActivePlatform === 'nxgen') {
    status.style.color = data.ok ? '#86efac' : '#f87171';
    status.textContent = data.message || '';
    setTimeout(() => { status.style.color = ''; status.textContent = 'Imports teams, bracket & match queue.'; }, 4000);
  }
};

function renderDashNxgenQueue(queue, fetchedAt) {
  const container = el('dash-nxgen-queue');
  const status    = el('dash-nxgen-queue-status');
  if (!container) return;
  const open = (queue || []).filter(m => m.status !== 'completed');
  if (!open.length) {
    container.innerHTML = '<div style="font-size:12px; color:var(--muted); padding:4px 0;">No open matches.</div>';
  } else {
    container.innerHTML = '';
    open.slice(0, 6).forEach(m => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:5px; background:rgba(255,255,255,.04); margin-bottom:4px; border:1px solid ${m.live ? 'rgba(236,72,153,.3)' : 'var(--border)'};`;
      row.innerHTML = `
        ${m.live ? '<span style="font-size:9px; font-weight:700; color:#7C3AED; flex-shrink:0;">LIVE</span>' : `<span style="font-size:9px; color:var(--muted); flex-shrink:0;">R${m.round || '?'}</span>`}
        <span style="flex:1; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(m.teamA || 'TBD')} <span style="color:var(--muted);">vs</span> ${escapeHtml(m.teamB || 'TBD')}</span>
        <button class="btn btn-ghost btn-xs nxgen-dash-set-live" style="flex-shrink:0;">Set Live</button>`;
      row.querySelector('.nxgen-dash-set-live').addEventListener('click', () => {
        send('set_team', { side: 'blue',   name: m.teamA || '', ...(m.logoA ? { logo: m.logoA } : {}) });
        send('set_team', { side: 'orange', name: m.teamB || '', ...(m.logoB ? { logo: m.logoB } : {}) });
      });
      container.appendChild(row);
    });
  }
  if (status && fetchedAt) status.textContent = `Updated ${new Date(fetchedAt).toLocaleTimeString()}`;
}

// ── FACEIT (Marketplace ▸ Integrations) ─────────────────────────────────────────

function getFaceitPayload() {
  return {
    enabled: !!(el('check-faceit-enabled')?.checked),
    competitionId: (el('input-faceit-comp')?.value || '').trim(),
    competitionType: el('select-faceit-type')?.value || 'championship',
    organizerName: (el('input-faceit-org')?.value || '').trim(),
    apiKey: (el('input-faceit-key')?.value || '').trim()
  };
}

el('btn-faceit-save')?.addEventListener('click', () => {
  send('set_faceit_settings', getFaceitPayload());
});

el('btn-faceit-test')?.addEventListener('click', () => {
  send('set_faceit_settings', getFaceitPayload());
  send('faceit_test_connection');
  const r = el('faceit-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Testing connection…'; }
});

el('btn-faceit-load')?.addEventListener('click', () => {
  const p = getFaceitPayload();
  if (!p.competitionId) { const r = el('faceit-result'); if (r) { r.style.color = '#f87171'; r.textContent = 'Paste a FACEIT championship or hub link first.'; } return; }
  send('set_faceit_settings', p);
  send('load_faceit_event', { id: p.competitionId, competitionType: p.competitionType });
});

el('btn-faceit-refresh')?.addEventListener('click', () => {
  send('faceit_refresh');
  const r = el('faceit-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Refreshing…'; }
});

el('btn-faceit-change-key')?.addEventListener('click', () => {
  const inp = el('input-faceit-key');
  const btn = el('btn-faceit-change-key');
  if (!inp) return;
  inp.readOnly = false; inp.value = ''; inp.placeholder = 'Paste your new FACEIT server-side API key';
  inp.style.opacity = ''; inp.style.cursor = '';
  if (btn) btn.style.display = 'none';
  inp.focus();
});

el('btn-faceit-import-teams')?.addEventListener('click', () => {
  send('faceit_import_teams');
  const r = el('faceit-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Importing teams…'; }
});

function renderFaceitTeams(teams) {
  const list = el('faceit-teams-list'); if (!list) return;
  if (!teams.length) { list.innerHTML = '<p class="sps-empty">No teams loaded.</p>'; return; }
  list.innerHTML = teams.map((t) =>
    `<div style="display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:6px; background:rgba(255,255,255,.03);">
      ${t.logo ? `<img src="${t.logo}" style="width:20px; height:20px; object-fit:contain; border-radius:3px;">` : '<span style="width:20px; height:20px; background:rgba(255,255,255,.08); border-radius:3px; display:inline-block;"></span>'}
      <span style="flex:1; font-size:12px;">${escapeHtml(t.name || '')}</span>
      ${(t.players || []).length ? `<span style="font-size:10px; color:var(--muted);">${(t.players || []).length}p</span>` : ''}
    </div>`
  ).join('');
}

// One row template for both the Settings list and the Dashboard queue — same markup, different
// Set Live hook class.
function faceitQueueRowHtml(m, btnClass) {
  return `${m.live ? '<span style="font-size:10px; font-weight:700; color:#ff5500; flex-shrink:0;">LIVE</span>' : `<span style="font-size:10px; color:var(--muted); flex-shrink:0;">R${m.round == null ? '?' : m.round}</span>`}
    <span style="flex:1; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(m.teamA || 'TBD')} <span style="color:var(--muted);">vs</span> ${escapeHtml(m.teamB || 'TBD')}</span>
    <button class="btn btn-ghost btn-xs ${btnClass}" style="flex-shrink:0;" title="Set as current match">Set Live</button>`;
}

function renderFaceitQueueInSettings(queue) {
  const list  = el('faceit-queue-list');
  const empty = el('faceit-queue-empty');
  if (!list) return;
  // The server already drops finished/cancelled matches — the queue IS the open list.
  const open = queue || [];
  if (empty) empty.style.display = open.length ? 'none' : '';
  list.innerHTML = '';
  open.forEach((m) => {
    const row = document.createElement('div');
    row.style.cssText = `display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:6px; background:rgba(255,255,255,.04); border:1px solid ${m.live ? 'rgba(255,85,0,.35)' : 'var(--border)'};`;
    row.innerHTML = faceitQueueRowHtml(m, 'faceit-set-live-btn');
    row.querySelector('.faceit-set-live-btn').addEventListener('click', () => {
      send('set_team', { side: 'blue',   name: m.teamA || '', ...(m.logoA ? { logo: m.logoA } : {}) });
      send('set_team', { side: 'orange', name: m.teamB || '', ...(m.logoB ? { logo: m.logoB } : {}) });
    });
    list.appendChild(row);
  });
}

function renderFaceitSettings(data) {
  const fc = data.faceit || {};
  const enabledCb  = el('check-faceit-enabled');
  const compInp    = el('input-faceit-comp');
  const typeSel    = el('select-faceit-type');
  const orgInp     = el('input-faceit-org');
  const keyInp     = el('input-faceit-key');
  const badge      = el('faceit-conn-badge');
  const changeBtn  = el('btn-faceit-change-key');
  const refreshBtn = el('btn-faceit-refresh');
  const infoWrap   = el('faceit-event-info');

  if (enabledCb && document.activeElement !== enabledCb) enabledCb.checked = !!fc.enabled;
  if (compInp && document.activeElement !== compInp) compInp.value = fc.competitionId || '';
  if (typeSel && document.activeElement !== typeSel) typeSel.value = fc.competitionType || 'championship';
  if (orgInp && document.activeElement !== orgInp) orgInp.value = fc.organizerName || '';

  if (keyInp && fc.hasKey && !keyInp.value) {
    keyInp.readOnly = true; keyInp.value = ''; keyInp.placeholder = '••••••••••••••••••••';
    keyInp.style.opacity = '0.5'; keyInp.style.cursor = 'default';
    if (changeBtn) changeBtn.style.display = '';
  }
  if (badge) badge.style.display = fc.connected ? '' : 'none';
  if (refreshBtn) refreshBtn.style.display = fc.selectedEvent ? '' : 'none';

  if (fc.selectedEvent && infoWrap) {
    infoWrap.style.display = '';
    const ev = fc.selectedEvent;
    const nameEl = el('faceit-ev-name'); if (nameEl) nameEl.textContent = ev.name || '';
    const metaEl = el('faceit-ev-meta');
    if (metaEl) metaEl.textContent = [
      ev.type === 'hub' ? 'Hub' : 'Championship',
      ev.game, ev.region,
      ev.status ? ev.status.charAt(0).toUpperCase() + ev.status.slice(1) : ''
    ].filter(Boolean).join(' · ');
    const linkEl = el('faceit-ev-link'); if (linkEl && ev.url) { linkEl.href = ev.url; }
    const labelEl = el('faceit-teams-label');
    if (labelEl) labelEl.textContent = `Teams (${(fc.eventTeams || []).length})`;
    renderFaceitTeams(fc.eventTeams || []);
    renderFaceitQueueInSettings(fc.queue || []);
  } else if (infoWrap) {
    infoWrap.style.display = 'none';
  }

  const resultEl = el('faceit-result');
  if (resultEl && fc.lastError && !resultEl._userMsg) {
    resultEl.style.color = '#f87171'; resultEl.textContent = fc.lastError;
  }
}

window._handleFaceitResult = function (data) {
  const r = el('faceit-result');
  if (r) {
    r._userMsg = true;
    r.style.color = data.ok ? '#86efac' : '#f87171';
    r.textContent = data.message || '';
    setTimeout(() => { r._userMsg = false; }, 5000);
  }
  const status = el('ev-load-status');
  if (status && _evActivePlatform === 'faceit') {
    status.style.color = data.ok ? '#86efac' : '#f87171';
    status.textContent = data.message || '';
    setTimeout(() => { status.style.color = ''; status.textContent = 'Imports teams, bracket & match queue.'; }, 4000);
  }
};

function renderDashFaceitQueue(queue, fetchedAt) {
  const container = el('dash-faceit-queue');
  const status    = el('dash-faceit-queue-status');
  if (!container) return;
  const open = queue || [];
  if (!open.length) {
    container.innerHTML = '<div style="font-size:12px; color:var(--muted); padding:4px 0;">No open matches.</div>';
  } else {
    container.innerHTML = '';
    open.slice(0, 6).forEach((m) => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:5px; background:rgba(255,255,255,.04); margin-bottom:4px; border:1px solid ${m.live ? 'rgba(255,85,0,.35)' : 'var(--border)'};`;
      row.innerHTML = faceitQueueRowHtml(m, 'faceit-dash-set-live');
      row.querySelector('.faceit-dash-set-live').addEventListener('click', () => {
        send('set_team', { side: 'blue',   name: m.teamA || '', ...(m.logoA ? { logo: m.logoA } : {}) });
        send('set_team', { side: 'orange', name: m.teamB || '', ...(m.logoB ? { logo: m.logoB } : {}) });
      });
      container.appendChild(row);
    });
  }
  if (status && fetchedAt) status.textContent = `Updated ${new Date(fetchedAt).toLocaleTimeString()}`;
}

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
      if (urlEl && document.activeElement !== urlEl) {
        let urlVal = saved ? (saved.link || '') : '';
        // If no saved URL, auto-fill from the VDO talent room obs feed for this player
        if (!urlVal && _vdoLinks) {
          const vt = _vdoLinks.teams && _vdoLinks.teams[side];
          const vp = vt && (vt.players || []).find(vp => vp.name === p.name);
          if (vp && vp.obsUrl) urlVal = vp.obsUrl;
        }
        urlEl.value = urlVal;
      }

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
        let previewUrl = saved?.link || '';
        if (!previewUrl && _vdoLinks) {
          const vt = _vdoLinks.teams && _vdoLinks.teams[side];
          const vp = vt && (vt.players || []).find(vp => vp.name === p.name);
          if (vp && vp.obsUrl) previewUrl = vp.obsUrl;
        }
        if (previewUrl) {
          previewIframe.dataset.src = previewUrl;
          previewToggle.style.display = '';
          if (previewWrap.classList.contains('open') && previewIframe.src !== previewUrl) {
            previewIframe.src = previewUrl;
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
el('btn-add-facecam-manual')?.addEventListener('click', () => {
  const name     = el('add-fc-name').value.trim();
  const platform = el('add-fc-platform').value;
  const link     = el('add-fc-url').value.trim();
  
  if (!name || !link) {
    showToast('Please enter both a Name/ID and a URL.', '#ef4444');
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
  if (!name && !platformId) { showToast('Select a player or enter a Primary ID.', '#ef4444'); return; }
  if (!link) { showToast('Enter the facecam URL.', '#ef4444'); return; }
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
el('btn-apply-all-facecams')?.addEventListener('click', () => {
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
  if (saved === 0) showToast('No facecams to apply — fill in at least one URL.', '#f59e0b');
});

// ── Player Modal Events ────────────────────────────────────────────────────
el('btn-cancel-player')?.addEventListener('click', closePlayerModal);
el('btn-close-player-modal')?.addEventListener('click', closePlayerModal);
el('btn-save-player')?.addEventListener('click', savePlayer);
el('player-create-camera')?.addEventListener('change', function() {
  el('player-new-camera-form').style.display = this.checked ? 'block' : 'none';
});

el('player-modal-overlay')?.addEventListener('click', function(e) {
  if (e.target === this) closePlayerModal();
});
