/* ─── spotlight.js — Spotlight / Teams-to-Watch builders + shared event helpers ──
   Spotlight & watchlist overlay builders, plus small helpers other pages call at runtime:
   evSelectTab / openBracketBuilder (Events + Event Ops + Leagues), evLiveRefreshOpen (app.js),
   teStartggLink / teSixmansLink / playerProfileChips (Teams editor, match panel), csvParse
   (Event Ops, league import). The Seeding studio that used to live here was removed (2026-09-17).
   Loads after app.js. */

// Switch the Events subnav to a given tab (drives panel visibility via the #ev-subnav handler).
function evSelectTab(tab) {
  // 'brackets' is NOT in this sub-nav: buildGraphicsHub() relocates the bracket builder into
  // the Graphics hub (Dashboard ▸ Graphics ▸ Bracket) and deletes the button. Without this, callers (Event Ops'
  // "Go to bracket") silently no-op'd — querySelector found nothing and the click never fired.
  if (tab === 'brackets') { openBracketBuilder(); return; }
  const btn = document.querySelector(`#ev-subnav .ev-subnav-btn[data-evtab="${tab}"]`);
  if (btn) btn.click();
}
// Jump to the manual tournament/bracket builder wherever it currently lives. Single place to update
// if the builder moves again.
function openBracketBuilder() {
  document.querySelector('.tab-btn.nav-item[data-tab="principal"]')?.click();
  const tab = document.getElementById('gfx-tab-bracket');
  if (tab) { tab.click(); tab.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
window.openBracketBuilder = openBracketBuilder;
// Re-render the My Events list when a background sync changes something — but only when actually
// visible and only on a real change (cheap signature), so it never churns the UI.
let _evMySig = '';
function evLiveRefreshOpen() {
  const evs = currentState.myEvents || [];
  const sig = evs.map((e) => `${e.id}:${e.lastSync || 0}:${(e.roster || []).length}:${e.syncError ? 1 : 0}`).join('|');
  if (sig === _evMySig) return;
  _evMySig = sig;
  const me = el('ev-myevents-panel'); if (me && me.offsetParent !== null) renderMyEvents();
}

// Build a profile URL from a stored value that may be a full URL OR a slug/username.
function teStartggLink(v) { v = (v || '').trim(); return /^https?:\/\//i.test(v) ? v : 'https://www.start.gg/' + v.replace(/^\/+/, ''); }
function teSixmansLink(v) { v = (v || '').trim(); return /^https?:\/\//i.test(v) ? v : 'https://www.rl6mans.com/profile/' + encodeURIComponent(v.toLowerCase()); }
function teTwitterLink(v) { v = (v || '').trim().replace(/^@/, ''); return /^https?:\/\//i.test(v) ? v : 'https://x.com/' + encodeURIComponent(v); }
function teTwitchLink(v)  { v = (v || '').trim(); return /^https?:\/\//i.test(v) ? v : 'https://twitch.tv/' + encodeURIComponent(v); }
function teInstaLink(v)   { v = (v || '').trim().replace(/^@/, ''); return /^https?:\/\//i.test(v) ? v : 'https://instagram.com/' + encodeURIComponent(v); }
function teTikTokLink(v)  { v = (v || '').trim().replace(/^@/, ''); return /^https?:\/\//i.test(v) ? v : 'https://tiktok.com/@' + encodeURIComponent(v); }
function teYouTubeLink(v) { v = (v || '').trim().replace(/^@/, ''); return /^https?:\/\//i.test(v) ? v : 'https://youtube.com/@' + encodeURIComponent(v); }

// Profile-link chips for a player (start.gg + 6mans). Accepts a gamertag string OR a
// player object. Prefers links STORED on the player; falls back to the auto-linked
// registry (state.playerProfiles, keyed by gamertag). Shown across seeding/team/match.
function playerProfileChips(p) {
  let tag = '', storedSgg = '', storedSix = '', storedSocials = {};
  if (typeof p === 'string') tag = p;
  else if (p) {
    tag = p.gamerTag || p.name || '';
    storedSgg = p.startgg || '';
    storedSix = p.sixmans || '';
    storedSocials = { twitter: p.twitter || '', twitch: p.twitch || '', discord: p.discord || '', instagram: p.instagram || '', tiktok: p.tiktok || '', youtube: p.youtube || '' };
  }
  const reg = (tag && currentState.playerProfiles) ? currentState.playerProfiles[tag.trim().toLowerCase()] : null;
  const chips = [];
  const sggUrl = storedSgg ? teStartggLink(storedSgg)
    : (reg && reg.startggSlug ? 'https://www.start.gg/' + String(reg.startggSlug).replace(/^\/+/, '') : '');
  if (sggUrl) chips.push(`<a class="pp-chip pp-sgg" href="${sggUrl}" target="_blank" title="start.gg profile"><img src="../assets/images/start.png" alt="start.gg"></a>`);
  let sixUrl = '', sixTitle = '6mans profile';
  if (storedSix) { sixUrl = teSixmansLink(storedSix); }
  else if (reg && reg.sixmans && reg.sixmans.name) {
    const s = reg.sixmans;
    sixUrl = 'https://www.rl6mans.com/profile/' + encodeURIComponent(String(s.name).toLowerCase());
    const meta = [s.rank, s.elo ? s.elo + ' ELO' : '', s.region].filter(Boolean).join(' · ');
    if (meta) sixTitle = '6mans · ' + meta;
  }
  if (sixUrl) chips.push(`<a class="pp-chip pp-6m" href="${sixUrl}" target="_blank" title="${tlEsc(sixTitle)}"><img src="../assets/images/sixmanlogo.webp" alt="6mans"></a>`);
  // Twitch — player-stored takes priority over registry
  const twitchVal = storedSocials.twitch || (reg && reg.twitch) || '';
  if (twitchVal) chips.push(`<a class="pp-chip pp-twitch" href="https://twitch.tv/${encodeURIComponent(twitchVal)}" target="_blank" title="Twitch: ${tlEsc(twitchVal)}"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg></a>`);
  // Twitter/X — player-stored takes priority over registry
  const twitterVal = storedSocials.twitter || (reg && reg.twitter) || '';
  if (twitterVal) chips.push(`<a class="pp-chip pp-twitter" href="https://x.com/${encodeURIComponent(twitterVal.replace(/^@/, ''))}" target="_blank" title="X/Twitter: ${tlEsc(twitterVal)}"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>`);
  // Player-stored-only socials
  if (storedSocials.discord) chips.push(`<span class="pp-chip pp-discord" title="Discord: ${tlEsc(storedSocials.discord)}">DC</span>`);
  if (storedSocials.instagram) chips.push(`<a class="pp-chip pp-instagram" href="https://instagram.com/${encodeURIComponent(storedSocials.instagram.replace(/^@/, ''))}" target="_blank" title="Instagram: ${tlEsc(storedSocials.instagram)}">IG</a>`);
  if (storedSocials.tiktok) chips.push(`<a class="pp-chip pp-tiktok" href="https://tiktok.com/@${encodeURIComponent(storedSocials.tiktok.replace(/^@/, ''))}" target="_blank" title="TikTok: ${tlEsc(storedSocials.tiktok)}">TK</a>`);
  if (storedSocials.youtube) chips.push(`<a class="pp-chip pp-youtube" href="https://youtube.com/@${encodeURIComponent(storedSocials.youtube.replace(/^@/, ''))}" target="_blank" title="YouTube: ${tlEsc(storedSocials.youtube)}">YT</a>`);
  if (reg && reg.countryCode) chips.push(`<span class="pp-chip pp-flag" title="${tlEsc(reg.country || reg.countryCode.toUpperCase())}"><img src="https://flagcdn.com/16x12/${reg.countryCode.toLowerCase()}.png" alt="${tlEsc(reg.countryCode.toUpperCase())}" width="16" height="12"></span>`);
  return chips.length ? `<span class="pp-chips">${chips.join('')}</span>` : '';
}

function csvParse(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((x) => (x || '').toString().trim()));
}

// ── Spotlight / "Teams to Watch" overlay builder ─────────────────────────────
let _wlSig = '';
let _wlDrag = -1;
let _wlTitleTimer = null;
let _wlSubTimer = null;
function wlState() { return (currentState && currentState.watchlist) || { title: 'TEAMS TO WATCH', logo: '', fields: [{ id: 'rank', label: 'CURRENT RANK' }], teams: [], visible: false }; }
function wlSend(patch) { send('set_watchlist', patch); }
const _wlEsc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// Read teams + per-field values out of the DOM (the source of truth while editing).
function wlCollectTeams() {
  const w = wlState(); const out = [];
  document.querySelectorAll('#wl-teams .wl-team-row').forEach((row) => {
    const t = (w.teams || []).find((x) => x.id === row.dataset.id) || { id: row.dataset.id, name: '', players: [] };
    const values = {};
    row.querySelectorAll('.wl-tv-input').forEach((inp) => { const v = inp.value.trim(); if (v) values[inp.dataset.fid] = v; });
    const ps = row.querySelector('.wl-pos');
    out.push({ id: t.id, name: t.name, players: t.players || [], values, pos: Number(ps && ps.value) || 0 });
  });
  return out;
}
function wlPopulateLeagues() {
  const sel = el('wl-league'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select league</option>' + (currentState.leagues || []).map((l) => `<option value="${l.id}">${_wlEsc(l.name || 'League')}</option>`).join('');
  sel.value = cur;
}
function wlRenderFields(w) {
  const wrap = el('wl-fields-chips'); if (wrap) {
    wrap.innerHTML = '';
    (w.fields || []).forEach((f) => {
      const chip = document.createElement('span'); chip.className = 'wl-field-chip';
      chip.innerHTML = `<span>${_wlEsc(f.label)}</span><button title="Remove field">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => wlSend({ fields: (wlState().fields || []).filter((x) => x.id !== f.id), teams: wlCollectTeams() }));
      wrap.appendChild(chip);
    });
  }
  const lf = el('wl-league-field'); if (lf) lf.innerHTML = (w.fields || []).map((f) => `<option value="${f.id}">${_wlEsc(f.label)}</option>`).join('');
}
function wlRenderTeams(w) {
  const wrap = el('wl-teams'); if (!wrap) return;
  wrap.innerHTML = '';
  (w.teams || []).forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'wl-team-row'; row.dataset.id = t.id; row.draggable = true;
    const n = (w.teams || []).length;
    const posOpts = ['<option value="0">—</option>'].concat(Array.from({ length: n }, (_, k) => `<option value="${k + 1}"${(t.pos || 0) === k + 1 ? ' selected' : ''}>${k + 1}</option>`)).join('');
    const fields = (w.fields || []).map((f) => `<label class="wl-tv"><span>${_wlEsc(f.label)}</span><input class="input-text wl-tv-input" data-fid="${f.id}" value="${_wlEsc((t.values || {})[f.id] || '')}" placeholder="—"></label>`).join('');
    row.innerHTML = `<span class="wl-team-grip" title="Drag to reorder">⠿</span>`
      + `<label class="wl-pos-wrap" title="Podium position — #1 shows in the centre of the overlay"><span>RANK</span><select class="input-select wl-pos">${posOpts}</select></label>`
      + `<div class="wl-team-main"><div class="wl-team-name">${_wlEsc(t.name) || '(unnamed)'}</div><div class="wl-team-players">${_wlEsc((t.players || []).join(', ')) || 'no players'}</div></div>`
      + `<div class="wl-team-fields">${fields}</div>`
      + `<button class="wl-solo${((currentState.teamSpotlight && currentState.teamSpotlight.name || '').toLowerCase() === (t.name || '').toLowerCase()) ? ' is-on' : ''}" title="Solo spotlight this team (start.gg deep-dive overlay)">◉</button>`
      + `<button class="wl-team-del" title="Remove from Teams to Watch">✕</button>`;
    row.querySelector('.wl-team-del').addEventListener('click', () => wlSend({ teams: wlCollectTeams().filter((x) => x.id !== t.id) }));
    row.querySelector('.wl-solo').addEventListener('click', () => tsSpotlight(t));
    row.querySelector('.wl-pos').addEventListener('mousedown', (e) => e.stopPropagation());
    row.querySelector('.wl-pos').addEventListener('change', () => wlSend({ teams: wlCollectTeams() }));
    row.querySelectorAll('.wl-tv-input').forEach((inp) => { inp.draggable = false; inp.addEventListener('mousedown', (e) => e.stopPropagation()); inp.addEventListener('change', () => wlSend({ teams: wlCollectTeams() })); });
    row.addEventListener('dragstart', (e) => { if (e.target.classList && e.target.classList.contains('wl-tv-input')) { e.preventDefault(); return; } _wlDrag = i; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { _wlDrag = -1; row.classList.remove('dragging'); });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drag-over'); if (_wlDrag < 0 || _wlDrag === i) return; const teams = wlCollectTeams(); const m = teams.splice(_wlDrag, 1)[0]; teams.splice(i, 0, m); wlSend({ teams }); });
    wrap.appendChild(row);
  });
}
function wlSyncValues(w) {
  document.querySelectorAll('#wl-teams .wl-team-row').forEach((row) => {
    const t = (w.teams || []).find((x) => x.id === row.dataset.id); if (!t) return;
    row.querySelectorAll('.wl-tv-input').forEach((inp) => { if (document.activeElement !== inp) inp.value = (t.values || {})[inp.dataset.fid] || ''; });
    const ps = row.querySelector('.wl-pos'); if (ps && document.activeElement !== ps) ps.value = String(t.pos || 0);
  });
}
function renderSpotlight() {
  const panel = el('ev-spotlight-panel'); if (!panel) return;
  const w = wlState();
  const gl = el('wl-golive');
  if (gl) { gl.textContent = w.visible ? '■ Stop' : 'Go live'; gl.classList.toggle('btn-danger', !!w.visible); gl.classList.toggle('btn-primary', !w.visible); }
  const ti = el('wl-title'); if (ti && document.activeElement !== ti) ti.value = w.title || '';
  const su = el('wl-subtitle'); if (su && document.activeElement !== su) su.value = w.subtitle || '';
  const lp = el('wl-logo-preview'), le = el('wl-logo-empty');
  if (w.logo) { if (lp) { lp.src = w.logo; lp.style.display = ''; } if (le) le.style.display = 'none'; }
  else { if (lp) lp.style.display = 'none'; if (le) le.style.display = ''; }
  wlPopulateLeagues();
  const sig = JSON.stringify({ f: (w.fields || []).map((f) => [f.id, f.label]), t: (w.teams || []).map((t) => [t.id, t.name, (t.players || []).join(',')]) });
  if (sig !== _wlSig) { _wlSig = sig; wlRenderFields(w); wlRenderTeams(w); } else wlSyncValues(w);
  const em = el('wl-empty-msg'); if (em) em.style.display = (w.teams || []).length ? 'none' : '';
  spPopulateEvents();
  if (_spMode === 'solo') { renderSpSoloList(); renderSpLink(); }
  renderTeamSpotlightBar();
  spRefreshPreviewBar();
}
function wlAddField() {
  const inp = el('wl-field-new'); const label = (inp && inp.value || '').trim(); if (!label) return;
  const fields = (wlState().fields || []).slice();
  if (fields.length >= 6) { evStatus('Max 6 custom fields.', 'err'); return; }
  fields.push({ id: 'f' + Math.random().toString(36).slice(2, 7), label });
  if (inp) inp.value = '';
  wlSend({ fields, teams: wlCollectTeams() });
}
function wlOrdinal(n) { if (!n) return ''; const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function wlLeagueFill() {
  const leagueId = el('wl-league')?.value, src = el('wl-league-src')?.value, fieldId = el('wl-league-field')?.value;
  if (!leagueId || !fieldId) { evStatus('Pick a league and a target field first.', 'err'); return; }
  const league = (currentState.leagues || []).find((l) => l.id === leagueId); if (!league) return;
  const byId = {}; (league.standings || []).forEach((s) => { byId[s.teamId] = s; });
  // Use stored standings order for rank (respects manual drag)
  const rankOf = {}; (league.standings || []).forEach((s, i) => { rankOf[s.teamId] = i + 1; });
  // Key league teams by resolved name (teamName field, not name)
  const teamByName = {}; (league.teams || []).forEach((t) => { teamByName[(lgResolveTeam(t).name || t.teamName || '').trim().toLowerCase()] = t; });
  let n = 0;
  const teams = wlCollectTeams().map((t) => {
    const lt = teamByName[(t.name || '').trim().toLowerCase()];
    const values = { ...t.values };
    if (lt) {
      const st = byId[lt.id] || {}; n++;
      if (src === 'rank') values[fieldId] = wlOrdinal(rankOf[lt.id] || 0);
      else if (src === 'record') values[fieldId] = `${st.w || 0}-${st.l || 0}`;
      else values[fieldId] = String(st.pts || 0);
    }
    return { ...t, values };
  });
  wlSend({ teams });
  const fld = el('wl-league-field'); const fldName = (fld && fld.selectedOptions[0] && fld.selectedOptions[0].textContent) || 'field';
  evStatus(n ? `Filled ${fldName} from "${league.name}" for ${n} team(s).` : `No teams matched "${league.name}" by name.`, n ? 'ok' : 'err');
}
el('wl-title')?.addEventListener('input', function () { clearTimeout(_wlTitleTimer); const v = this.value; _wlTitleTimer = setTimeout(() => wlSend({ title: v }), 350); });
el('wl-subtitle')?.addEventListener('input', function () { clearTimeout(_wlSubTimer); const v = this.value; _wlSubTimer = setTimeout(() => wlSend({ subtitle: v }), 350); });
el('wl-field-add')?.addEventListener('click', wlAddField);
el('wl-field-new')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wlAddField(); } });
el('wl-league-fill')?.addEventListener('click', wlLeagueFill);
el('wl-golive')?.addEventListener('click', () => wlSend({ visible: !wlState().visible }));
el('wl-logo-clear')?.addEventListener('click', () => wlSend({ logo: '' }));
el('wl-logo-preview')?.addEventListener('click', () => el('wl-logo-file')?.click());
el('wl-logo-empty')?.addEventListener('click', () => el('wl-logo-file')?.click());
el('wl-logo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; this.value = ''; if (!f) return;
  try { const b64 = await fileToBase64(f, 400); wlSend({ logo: b64 }); } catch (e) { evStatus('Could not load logo.', 'err'); }
});
el('wl-copy-url')?.addEventListener('click', (e) => {
  const url = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://127.0.0.1:3000') + '/watchlist.html';
  if (typeof copyText === 'function') copyText(url, e.currentTarget);
  else if (navigator.clipboard) navigator.clipboard.writeText(url);
  evStatus('Copied the Teams to Watch overlay URL.', 'ok');
});
{ const pv = el('wl-preview'); if (pv) pv.href = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://127.0.0.1:3000') + '/watchlist.html?preview=1'; }

// ── Single-team spotlight (start.gg deep-dive) ───────────────────────────────
function tsOrdinal(n) { if (!n) return ''; const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function tsSpotlight(t) {
  send('set_team_spotlight', { name: t.name, eventSlug: t.eventSlug || '', entrantId: t.entrantId || '', players: (t.players || []).map((p) => ({ gamerTag: p })) });
  evStatus(t.entrantId ? `Spotlighting "${t.name}" — pulling start.gg data…` : `Spotlighting "${t.name}" — re-mark it from the event for live start.gg stats.`, 'ok');
}
function renderTeamSpotlightBar() {
  const ts = (currentState && currentState.teamSpotlight) || {};
  const has = !!ts.name;
  const target = el('ts-bar-target'); if (target) target.textContent = has ? ts.name : 'No team selected — click ◉ on a team above.';
  const sync = el('ts-bar-sync');
  if (sync) {
    if (!has) { sync.textContent = ''; sync.className = 'ts-bar-sync'; }
    else if (ts.syncError) { sync.textContent = '⚠ ' + ts.syncError; sync.className = 'ts-bar-sync err'; }
    else if (ts.lastSync) { const sg = ts.sg || {}; const bits = []; if (sg.seed) bits.push('seed #' + sg.seed); if (sg.placement) bits.push(tsOrdinal(sg.placement)); if (sg.record && (sg.record.w || sg.record.l)) bits.push(sg.record.w + '–' + sg.record.l); sync.textContent = '● ' + (bits.join(' · ') || 'synced from start.gg'); sync.className = 'ts-bar-sync ok'; }
    else { sync.textContent = '… fetching'; sync.className = 'ts-bar-sync'; }
  }
  const gl = el('ts-golive'); if (gl) { gl.disabled = !has; gl.textContent = ts.visible ? '■ Stop' : 'Go live'; gl.classList.toggle('btn-danger', !!ts.visible); gl.classList.toggle('btn-primary', !ts.visible); }
  // Reflect the active solo target on the per-team ◉ buttons.
  document.querySelectorAll('#wl-teams .wl-team-row').forEach((row) => {
    const t = (wlState().teams || []).find((x) => x.id === row.dataset.id); const solo = row.querySelector('.wl-solo');
    if (solo && t) solo.classList.toggle('is-on', has && (ts.name || '').toLowerCase() === (t.name || '').toLowerCase());
  });
}
el('ts-golive')?.addEventListener('click', () => { const ts = currentState.teamSpotlight || {}; if (!ts.name) return; send('set_team_spotlight', { visible: !ts.visible, fetch: false }); });
el('ts-refresh')?.addEventListener('click', () => { const ts = currentState.teamSpotlight || {}; if (!ts.name) return; send('set_team_spotlight', { name: ts.name, eventSlug: ts.eventSlug, entrantId: ts.entrantId }); evStatus('Refreshing spotlight from start.gg…'); });
el('ts-copy-url')?.addEventListener('click', (e) => {
  const url = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://127.0.0.1:3000') + '/team-spotlight.html';
  if (typeof copyText === 'function') copyText(url, e.currentTarget); else if (navigator.clipboard) navigator.clipboard.writeText(url);
  evStatus('Copied the Team Spotlight overlay URL.', 'ok');
});
{ const pv = el('ts-preview'); if (pv) pv.href = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://127.0.0.1:3000') + '/team-spotlight.html?preview=1'; }

// ── Spotlight studio: mode toggle + in-page team picker + live WYSIWYG preview ──
let _spMode = 'watch';
let _spFramesInit = false;
// The control panel is loaded over file:// — point the preview iframes at the overlay server.
function spInitFrames() {
  if (_spFramesInit) return; _spFramesInit = true;
  const base = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://127.0.0.1:3000');
  const fw = el('sp-frame-watch'); if (fw) fw.src = base + '/watchlist.html?embed=1';
  const fs = el('sp-frame-solo'); if (fs) fs.src = base + '/team-spotlight.html?embed=1';
}
function spSetMode(mode) {
  spInitFrames();
  _spMode = (mode === 'solo') ? 'solo' : 'watch';
  document.querySelectorAll('#sp-modes .sp-mode-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.spmode === _spMode));
  const wb = el('sp-watch-build'), sb = el('sp-solo-build');
  if (wb) wb.style.display = _spMode === 'watch' ? '' : 'none';
  if (sb) sb.style.display = _spMode === 'solo' ? '' : 'none';
  const fw = el('sp-frame-watch'), fs = el('sp-frame-solo');
  if (fw) fw.style.display = _spMode === 'watch' ? '' : 'none';
  if (fs) fs.style.display = _spMode === 'solo' ? '' : 'none';
  const desc = el('sp-mode-desc');
  if (desc) desc.textContent = _spMode === 'watch'
    ? 'Feature a set of teams in one graphic — logos, custom stats, and a podium. Build it on the left, watch it live on the right.'
    : 'Deep-dive a single team — placement, seed, record and recent/next matches from start.gg, plus live in-game player stats when on-air.';
  if (_spMode === 'solo') { renderSpSoloList(); renderSpLink(); }
  spRefreshPreviewBar();
}
document.querySelectorAll('#sp-modes .sp-mode-btn').forEach((b) => b.addEventListener('click', () => spSetMode(b.dataset.spmode)));
let _spEvtSig = '';
function spPopulateEvents() {
  const sel = el('sp-event'); if (!sel) return;
  const cur = sel.value, evs = currentState.myEvents || [];
  const sig = evs.map((e) => e.id + ':' + (e.name || '')).join('|');
  if (sig === _spEvtSig && sel.options.length) return;   // don't rebuild the dropdown every broadcast
  _spEvtSig = sig;
  sel.innerHTML = '<option value="">Select a saved event…</option>' + evs.map((e) => `<option value="${e.id}">${_wlEsc(e.name || 'Event')}</option>`).join('');
  sel.value = (cur && evs.some((e) => e.id === cur)) ? cur : ((evs[0] && evs[0].id) || '');
}
function spSelectedEvent() { return (currentState.myEvents || []).find((e) => e.id === (el('sp-event') && el('sp-event').value)); }
let _spSrc = 'event';        // team source: 'event' (My Event roster) | 'library' (saved teams)
let _spPickSig = '';
// Resolve a small chip logo: the team's own logo, else a saved-team logo by name.
function spTeamLogo(name, ownLogo) {
  if (ownLogo) return ownLogo;
  const t = (currentState.savedTeams || []).find((x) => (x.name || '').toLowerCase() === (name || '').toLowerCase());
  return (t && t.logo) || '';
}
function spSetSource(src) {
  _spSrc = (src === 'library') ? 'library' : 'event';
  document.querySelectorAll('#sp-src-tabs .sp-src-tab').forEach((b) => b.classList.toggle('is-on', b.dataset.spsrc === _spSrc));
  const evSel = el('sp-event'); if (evSel) evSel.style.display = _spSrc === 'event' ? '' : 'none';
  if (_spTeamSearchCtl) _spTeamSearchCtl.refresh();
}
// Candidates for the Add-team search — same shape/logo lookup as before, minus teams already added.
function spTeamSearchCandidates(q) {
  q = (q || '').trim().toLowerCase();
  const marked = new Set(((currentState.watchlist && currentState.watchlist.teams) || []).map((t) => (t.name || '').toLowerCase()));
  let list = [];
  if (_spSrc === 'library') {
    list = (currentState.savedTeams || []).map((t) => ({ name: t.name || '', players: (t.players || []).map((p) => p.name || p.gamerTag).filter(Boolean), logo: t.logo || '', entrantId: '', eventSlug: '', source: 'saved' }));
  } else {
    const ev = spSelectedEvent(); if (!ev) return [];
    list = ((ev && ev.roster) || []).map((rt) => ({ name: rt.name || '', players: (rt.players || []).map((p) => p.gamerTag).filter(Boolean), logo: '', entrantId: rt.entrantId || '', eventSlug: ev.eventSlug, _evName: ev.name, source: 'event' }));
  }
  list = list.filter((t) => t.name && !marked.has(t.name.toLowerCase()));
  // Rank BEFORE the 60-item cap — capping an unranked list used to drop the exact match a producer
  // was typing whenever it happened to sit past the first 60 rows of the library.
  return NESearch.filter(list, q,
    (t) => [{ text: t.name, weight: 2 }].concat(t.players || []),
    { limit: 60 }).slice(0, 60);
}
// Add-team search — same logo-capable typeahead pattern as Match > Teams (setupTeamTypeahead) and
// the League "search library to add" field (setupLeagueTeamSearch): type, pick a result from the
// .team-dd popover, it's added immediately and the field clears so the next one can be typed.
let _spTeamSearchCtl = null;
function setupSpotlightTeamSearch() {
  const input = el('sp-team-search'), dd = el('sp-team-dd');
  if (!input || !dd) return null;
  let items = [], active = -1, open = false;
  const close = () => { dd.classList.remove('show'); open = false; active = -1; };
  const position = () => {
    const r = input.getBoundingClientRect();
    dd.style.left = r.left + 'px'; dd.style.width = r.width + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 220 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
  };
  const render = () => {
    if (!items.length) {
      const msg = _spSrc === 'library'
        ? ((currentState.savedTeams || []).length ? 'No matching teams' : 'No saved teams yet — add them on the Teams page')
        : (!spSelectedEvent() ? 'Pick a saved event above to search its teams.' : 'No matching teams');
      dd.innerHTML = `<div class="team-dd-empty">${msg}</div>`;
      position(); dd.classList.add('show'); open = true; return;
    }
    dd.innerHTML = items.map((t, i) => {
      const logo = spTeamLogo(t.name, t.logo);
      const nm = _wlEsc((t.name || '').toUpperCase());
      const tag = t.source === 'event' ? '<span class="team-dd-tag">EVENT</span>' : '';
      return `<div class="team-dd-item${i === active ? ' active' : ''}" data-i="${i}" role="option">`
        + `<img class="team-dd-logo${logo ? '' : ' game-logo-white'}" src="${logo || gameLogo()}" alt="" onerror="this.style.visibility='hidden'">`
        + `<span class="team-dd-name">${nm}</span>${tag}</div>`;
    }).join('');
    position(); dd.classList.add('show'); open = true;
    const act = dd.querySelector('.team-dd-item.active'); if (act) act.scrollIntoView({ block: 'nearest' });
  };
  const refresh = () => { items = spTeamSearchCandidates(input.value); active = -1; render(); };
  const pick = (t) => {
    if (!t) return;
    send('toggle_watchlist_team', { team: { name: t.name, players: t.players, entrantId: t.entrantId, eventSlug: t.eventSlug }, event: t._evName || '' });
    input.value = ''; refresh(); input.focus();
  };
  input.addEventListener('focus', refresh);
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (!open && e.key === 'ArrowDown') { refresh(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && items[active]) pick(items[active]); else if (items.length === 1) pick(items[0]); }
    else if (e.key === 'Escape') { close(); }
  });
  dd.addEventListener('mousedown', (e) => { const it = e.target.closest('.team-dd-item'); if (!it) return; e.preventDefault(); pick(items[Number(it.dataset.i)]); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  window.addEventListener('scroll', () => { if (open) position(); }, true);
  window.addEventListener('resize', () => { if (open) close(); });
  return { refresh, close };
}
_spTeamSearchCtl = setupSpotlightTeamSearch();
document.querySelectorAll('#sp-src-tabs .sp-src-tab').forEach((b) => b.addEventListener('click', () => spSetSource(b.dataset.spsrc)));
el('sp-event')?.addEventListener('change', () => { if (_spTeamSearchCtl) _spTeamSearchCtl.refresh(); });
function spCustomAdd() {
  const inp = el('sp-custom-name'); const name = (inp && inp.value || '').trim(); if (!name) return;
  const marked = new Set(((currentState.watchlist && currentState.watchlist.teams) || []).map((t) => (t.name || '').toLowerCase()));
  if (marked.has(name.toLowerCase())) { evStatus(`"${name}" is already added.`); if (inp) inp.value = ''; return; }
  send('toggle_watchlist_team', { team: { name, players: [], entrantId: '', eventSlug: '' } });
  if (inp) inp.value = '';
  evStatus(`Added "${name}".`, 'ok');
}
el('sp-custom-add')?.addEventListener('click', spCustomAdd);
el('sp-custom-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); spCustomAdd(); } });
let _spSoloSig = '';
// Team Spotlight's solo-pick control — a logo-capable dropdown (native <select> can't host <img>,
// so this is a custom button + popover list, styled and behaving like a dropdown/combobox).
function spSoloDdClose() { const dd = el('sp-solo-dd'); const menu = el('sp-solo-dd-menu'); if (dd) dd.classList.remove('is-open'); if (menu) menu.style.display = 'none'; }
function spSoloDdOpen() { const dd = el('sp-solo-dd'); const menu = el('sp-solo-dd-menu'); if (dd) dd.classList.add('is-open'); if (menu) menu.style.display = ''; }
function renderSpSoloList() {
  const menu = el('sp-solo-dd-menu'), btn = el('sp-solo-dd-btn'); if (!menu || !btn) return;
  const teams = (currentState.watchlist && currentState.watchlist.teams) || [];
  const cur = (currentState.teamSpotlight && currentState.teamSpotlight.name || '').toLowerCase();
  const sig = cur + '#' + teams.map((t) => (t.name || '') + ':' + (t.players || []).length + ':' + (t.entrantId ? 1 : 0) + ':' + (t.logo || '')).join(',');
  if (sig !== _spSoloSig || !menu.children.length) {
    _spSoloSig = sig;
    menu.innerHTML = '';
    if (!teams.length) {
      menu.innerHTML = '<span class="sp-pick-empty">No teams marked yet — add some in Teams to Watch.</span>';
    } else {
      teams.forEach((t) => {
        const on = (t.name || '').toLowerCase() === cur;
        const logoUrl = spTeamLogo(t.name, t.logo);
        const item = document.createElement('button'); item.type = 'button'; item.className = 'sp-solo-dd-item' + (on ? ' is-on' : '');
        const link = t.entrantId
          ? '<span class="sp-solo-dd-item-link ok" title="Linked to start.gg">● start.gg</span>'
          : '<span class="sp-solo-dd-item-link" title="Not linked — link it after selecting for full stats">○ no link</span>';
        item.innerHTML = (logoUrl ? `<img class="sp-solo-dd-item-logo" src="${_wlEsc(logoUrl)}" alt="">` : `<span class="sp-solo-dd-item-logo"></span>`)
          + `<span class="sp-solo-dd-item-main"><span class="sp-solo-dd-item-name">${_wlEsc(t.name || 'Team')}</span><span class="sp-solo-dd-item-players">${_wlEsc((t.players || []).join(' · ')) || 'no players'}</span></span>`
          + link;
        item.addEventListener('click', () => { tsSpotlight(t); spSoloDdClose(); });
        menu.appendChild(item);
      });
    }
  }
  // Closed-button face always reflects the current pick — cheap, updates even when the menu itself
  // didn't need a rebuild (e.g. only the spotlighted team changed, not the team list).
  const curTeam = teams.find((t) => (t.name || '').toLowerCase() === cur);
  const logoEl = el('sp-solo-dd-logo'), labelEl = el('sp-solo-dd-label');
  if (curTeam) {
    const logoUrl = spTeamLogo(curTeam.name, curTeam.logo);
    if (logoEl) { if (logoUrl) { logoEl.src = logoUrl; logoEl.style.display = ''; } else logoEl.style.display = 'none'; }
    if (labelEl) labelEl.textContent = curTeam.name || 'Team';
  } else {
    if (logoEl) logoEl.style.display = 'none';
    if (labelEl) labelEl.textContent = 'Select a team to spotlight…';
  }
}
el('sp-solo-dd-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = el('sp-solo-dd'); if (!dd) return;
  if (dd.classList.contains('is-open')) spSoloDdClose(); else spSoloDdOpen();
});
document.addEventListener('click', (e) => {
  const dd = el('sp-solo-dd'); if (!dd || !dd.classList.contains('is-open')) return;
  if (!dd.contains(e.target)) spSoloDdClose();
});

// "Add team" dropdown (Teams to Watch) — opens the same source-tabs/search/pick-list/custom-add
// controls in a popover instead of an always-expanded scroll-and-click grid. Stays open after a
// pick so several teams can be added in a row; closes on outside click or the button again.
function spAddDdClose() { const dd = el('sp-adddd'); const menu = el('sp-adddd-menu'); if (dd) dd.classList.remove('is-open'); if (menu) menu.style.display = 'none'; }
function spAddDdOpen() { const dd = el('sp-adddd'); const menu = el('sp-adddd-menu'); if (dd) dd.classList.add('is-open'); if (menu) menu.style.display = ''; el('sp-team-search')?.focus(); }
el('sp-adddd-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = el('sp-adddd'); if (!dd) return;
  if (dd.classList.contains('is-open')) spAddDdClose(); else spAddDdOpen();
});
document.addEventListener('click', (e) => {
  const dd = el('sp-adddd'); if (!dd || !dd.classList.contains('is-open')) return;
  if (!dd.contains(e.target)) spAddDdClose();
});
function spRefreshPreviewBar() {
  const base = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://127.0.0.1:3000');
  const open = el('sp-open'); if (open) open.href = base + (_spMode === 'solo' ? '/team-spotlight.html' : '/watchlist.html') + '?preview=1';
  const gl = el('sp-golive'), foot = el('sp-preview-foot');
  if (_spMode === 'solo') {
    const ts = currentState.teamSpotlight || {};
    if (gl) { gl.disabled = !ts.name; gl.textContent = ts.visible ? '■ Stop' : 'Go live'; gl.classList.toggle('btn-danger', !!ts.visible); gl.classList.toggle('btn-primary', !ts.visible); }
    if (foot) foot.textContent = ts.name ? (ts.visible ? 'ON AIR · ' + ts.name : 'Ready · ' + ts.name) : 'Pick a team to spotlight.';
  } else {
    const w = currentState.watchlist || {}, n = (w.teams || []).length;
    if (gl) { gl.disabled = !n; gl.textContent = w.visible ? '■ Stop' : 'Go live'; gl.classList.toggle('btn-danger', !!w.visible); gl.classList.toggle('btn-primary', !w.visible); }
    if (foot) foot.textContent = n ? (w.visible ? `ON AIR · ${n} team${n === 1 ? '' : 's'}` : `Ready · ${n} team${n === 1 ? '' : 's'}`) : 'Add teams to build the card.';
  }
}
el('sp-golive')?.addEventListener('click', () => {
  if (_spMode === 'solo') { const ts = currentState.teamSpotlight || {}; if (!ts.name) return; send('set_team_spotlight', { visible: !ts.visible, fetch: false }); }
  else { const w = currentState.watchlist || {}; if (!(w.teams || []).length) return; send('set_watchlist', { visible: !w.visible }); }
});
el('sp-copy-url')?.addEventListener('click', (e) => {
  const base = (typeof SCENE_BASE_URL !== 'undefined' ? SCENE_BASE_URL : 'http://127.0.0.1:3000');
  const url = base + (_spMode === 'solo' ? '/team-spotlight.html' : '/watchlist.html');
  if (typeof copyText === 'function') copyText(url, e.currentTarget); else if (navigator.clipboard) navigator.clipboard.writeText(url);
  evStatus('Copied the overlay URL.', 'ok');
});

// ── Link a library / custom-added team to a start.gg entrant (for the full deep-dive) ──
function spLinkBestMatch(roster, name) {
  const k = (name || '').trim().toLowerCase();
  return (roster || []).find((r) => (r.name || '').trim().toLowerCase() === k)
    || (roster || []).find((r) => (r.name || '').toLowerCase().includes(k) || k.includes((r.name || '').toLowerCase()));
}
let _spLinkSig = '';
function renderSpLink() {
  const panel = el('sp-link'); if (!panel) return;
  const ts = currentState.teamSpotlight || {};
  if (!ts.name) { panel.style.display = 'none'; _spLinkSig = ''; return; }
  panel.style.display = '';
  const lbl = el('sp-link-lbl'); if (lbl) lbl.textContent = ts.entrantId ? 'start.gg link ✓' : '⚠ Link to start.gg';
  const evs = currentState.myEvents || [];
  const sig = ts.name + '#' + (ts.eventSlug || '') + '#' + (ts.entrantId || '') + '#' + evs.map((e) => e.id).join(',');
  if (sig === _spLinkSig) return;   // don't rebuild the dropdowns every broadcast
  _spLinkSig = sig;
  const evSel = el('sp-link-event'); if (!evSel) return;
  evSel.innerHTML = '<option value="">Select event…</option>' + evs.map((e) => `<option value="${e.id}">${_wlEsc(e.name || 'Event')}</option>`).join('');
  const pre = evs.find((e) => e.eventSlug === ts.eventSlug) || evs[0];
  evSel.value = pre ? pre.id : '';
  spLinkPopulateEntrants();
}
function spLinkPopulateEntrants() {
  const sel = el('sp-link-entrant'); if (!sel) return;
  const ev = (currentState.myEvents || []).find((e) => e.id === (el('sp-link-event') && el('sp-link-event').value));
  const roster = (ev && ev.roster) || [];
  sel.innerHTML = '<option value="">Match team…</option>' + roster.map((r) => `<option value="${_wlEsc(r.entrantId)}">${_wlEsc(r.name || 'Team')}</option>`).join('');
  const ts = currentState.teamSpotlight || {};
  const best = spLinkBestMatch(roster, ts.name);
  sel.value = (ts.entrantId && roster.some((r) => String(r.entrantId) === String(ts.entrantId))) ? ts.entrantId : (best ? best.entrantId : '');
}
function spLinkApply() {
  const ts = currentState.teamSpotlight || {};
  const target = ts.name; if (!target) return;
  const ev = (currentState.myEvents || []).find((e) => e.id === (el('sp-link-event') && el('sp-link-event').value));
  const entrantId = el('sp-link-entrant') && el('sp-link-entrant').value;
  if (!ev || !entrantId) { spLinkStatus('Pick an event and entrant.', 'err'); return; }
  const rt = (ev.roster || []).find((r) => String(r.entrantId) === String(entrantId));
  const rtPlayers = rt ? (rt.players || []).map((p) => p.gamerTag).filter(Boolean) : [];
  const teams = ((currentState.watchlist && currentState.watchlist.teams) || []).map((t) =>
    (t.name || '').toLowerCase() === target.toLowerCase()
      ? { ...t, entrantId, eventSlug: ev.eventSlug, players: (t.players && t.players.length) ? t.players : rtPlayers }
      : t);
  send('set_watchlist', { teams });
  const finalT = teams.find((t) => (t.name || '').toLowerCase() === target.toLowerCase());
  send('set_team_spotlight', { name: target, eventSlug: ev.eventSlug, entrantId, players: ((finalT && finalT.players) || rtPlayers).map((p) => ({ gamerTag: p })) });
  spLinkStatus(`Linked to "${(rt && rt.name) || 'entrant'}" — pulling stats…`, 'ok');
}
function spLinkStatus(msg, kind) { const s = el('sp-link-status'); if (!s) return; s.textContent = msg || ''; s.style.color = kind === 'err' ? '#f87171' : (kind === 'ok' ? '#34d399' : 'var(--muted)'); }
el('sp-link-event')?.addEventListener('change', spLinkPopulateEntrants);
el('sp-link-btn')?.addEventListener('click', spLinkApply);

