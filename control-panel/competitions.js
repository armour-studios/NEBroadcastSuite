/* ─── competitions.js — Esports ▸ Competitions hub + league ▸ Data source tab ─────────────────
   The hub is the front door of ESPORTS: which competition is LIVE (every competition scene follows
   it — ticker, schedule board, standings, starting-soon, BRB up-next), the list of leagues, and how
   to connect a league's data (typed in / Google Sheet / website feed / API / platforms).

   The server owns the model (server.js "Live competition" + backend/competition.js). This file only
   renders currentState.competition / compFeed / compSync / leagues and sends:
     competition_set_live, competition_set_options, competition_match_status,
     competition_sync_now, competition_import, competition_set_feed_token,
     competition_feed_token_status, competition_api_key
   Replies addressed to this panel arrive as `competition_result` (see cmpOnResult).

   Loads after leagues.js + league-interchange.js (uses lgLeagues/lgActiveId/lgActive/lgSave/
   lgRender/lgSwitchTab/lgResolveTeam) and before events.js (evShowSubtab calls cmpRender). */

const CMP_API = 'http://127.0.0.1:3000/api/v1';
let _cmpApiKey = '';
let _cmpHubSig = '';
const _cmpTokenState = {};   // leagueId -> hasToken (the token itself never comes back)

function cmpState() { return (typeof currentState !== 'undefined' && currentState) || {}; }
function cmpLeagues() { return (typeof lgLeagues !== 'undefined' && lgLeagues.length) ? lgLeagues : (cmpState().leagues || []); }
function cmpEsc(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const CMP_SRC_LABEL = { manual: 'Entered here', sheet: 'Google Sheet', feed: 'Website feed', push: 'API', cloud: 'Nameless website' };
// Sources the app PULLS on a schedule (they get sync status, Test / Sync now, the synced-rows note).
function cmpPulls(type) { return type === 'sheet' || type === 'feed' || type === 'cloud'; }
// Nameless website competitions: the list rides the LIBRARY tier (not every broadcast), so keep the
// last one we saw; the sign-in state arrives via cloud_status → applyCloudStatus (wrapped below).
let _cmpCloudList = [];
let _cmpCloudSess = null;   // null = no cloud_status heard yet → fall back to window._cloudWorkspaceId
function cmpCloudSignedIn() { return _cmpCloudSess ? !!_cmpCloudSess.authed : !!window._cloudWorkspaceId; }
function cmpCloudIsOrg() {
  const w = _cmpCloudSess ? _cmpCloudSess.workspaceId : window._cloudWorkspaceId;
  return !!(w && !String(w).startsWith('user:'));
}

function cmpAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}
// "7:30 PM" today, "Sat 9/20, 7:30 PM" otherwise — follows the region + 24h settings.
function cmpWhen(m) {
  if (!m) return '';
  if (m.postponed) return 'Postponed';
  if (!m.date) return m.time || 'Date TBD';
  const st = cmpState();
  const t = m.time && /^\d{1,2}:\d{2}/.test(m.time) ? (m.time.length === 4 ? '0' + m.time : m.time) : '12:00';
  const d = new Date(m.date + 'T' + t);
  if (isNaN(d.getTime())) return [m.date, m.time].filter(Boolean).join(' ');
  const h = d.getHours(), mi = String(d.getMinutes()).padStart(2, '0');
  const time = m.time ? (st.clock24h ? String(h).padStart(2, '0') + ':' + mi : ((h % 12) || 12) + ':' + mi + (h < 12 ? ' AM' : ' PM')) : '';
  if (d.toDateString() === new Date().toDateString()) return time ? 'Today ' + time : 'Today';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const dm = st.dateFormat === 'intl' ? d.getDate() + '/' + (d.getMonth() + 1) : (d.getMonth() + 1) + '/' + d.getDate();
  return day + ' ' + dm + (time ? ', ' + time : '');
}
function cmpCopy(text, what) {
  try {
    navigator.clipboard.writeText(text).then(
      () => showToast((what || 'Copied') + ' — copied to clipboard.', '#22c55e', 2200),
      () => showToast('Could not copy to the clipboard.', '#c53030', 3000));
  } catch (_) { showToast('Could not copy to the clipboard.', '#c53030', 3000); }
}

// ── Hub ──────────────────────────────────────────────────────────────────────
function cmpHubVisible() { const p = el('ev-comp-panel'); return !!(p && p.style.display !== 'none'); }

function cmpRender(force) {
  if (!cmpHubVisible()) return;
  const st = cmpState();
  const c = st.competition || {};
  const feed = st.compFeed || null;
  const leagues = cmpLeagues();
  const sig = JSON.stringify([c, feed, st.compSync, leagues.map((l) => [l.id, l.name, l.season, l.game, l.logo ? l.logo.length : 0, (l.teams || []).length, (l.schedule || []).length, l.source && l.source.type, l.status]), st.dateFormat, st.clock24h]);
  if (!force && sig === _cmpHubSig) return;
  _cmpHubSig = sig;

  const live = c.leagueId ? leagues.find((l) => l.id === c.leagueId) : null;
  const box = el('cmp-onair');
  if (box) box.classList.toggle('is-live', !!live);
  const name = el('cmp-live-name'), meta = el('cmp-live-meta'), eyebrow = el('cmp-live-eyebrow');
  if (eyebrow) eyebrow.textContent = live ? 'On air' : 'Live competition';
  if (name) name.textContent = live ? ([live.name, live.season].filter(Boolean).join(' — ') || 'League') : 'Nothing on air';
  if (meta) {
    if (live) {
      const src = (live.source && live.source.type) || 'manual';
      const sync = (st.compSync || {})[live.id];
      let line = CMP_SRC_LABEL[src] || 'Entered here';
      if (cmpPulls(src) && sync) {
        line += sync.lastError ? ' — last sync failed: ' + sync.lastError : (sync.lastOkAt ? ' — synced ' + cmpAgo(sync.lastOkAt) : '');
      }
      meta.textContent = line + '. ' + (live.teams || []).length + ' teams, ' + (live.schedule || []).length + ' fixtures.';
    } else {
      meta.textContent = 'Pick the league your ticker, schedule board, standings and break scenes should follow. Enter results however you like and every one of those scenes updates on its own.';
    }
  }

  const sel = el('cmp-live-select');
  if (sel && document.activeElement !== sel) {
    const want = sel.value || c.leagueId || (leagues[0] && leagues[0].id) || '';
    sel.innerHTML = leagues.length
      ? leagues.map((l) => `<option value="${cmpEsc(l.id)}">${cmpEsc([l.name || 'League', l.season].filter(Boolean).join(' — '))}</option>`).join('')
      : '<option value="">No leagues yet</option>';
    sel.value = leagues.some((l) => l.id === (live ? live.id : want)) ? (live ? live.id : want) : ((leagues[0] && leagues[0].id) || '');
    sel.disabled = !leagues.length;
  }
  const go = el('cmp-go-live'), off = el('cmp-off-air');
  if (go) { go.disabled = !leagues.length; go.textContent = live ? 'Switch' : 'Go live'; }
  if (off) off.hidden = !live;

  document.querySelectorAll('#ev-comp-panel [data-cmp-feed]').forEach((i) => { if (document.activeElement !== i) i.checked = !(c.feeds && c.feeds[i.dataset.cmpFeed] === false); });
  document.querySelectorAll('#ev-comp-panel [data-cmp-ticker]').forEach((i) => { if (document.activeElement !== i) i.checked = !(c.ticker && c.ticker[i.dataset.cmpTicker] === false); });

  cmpRenderNow(live, feed);
  cmpRenderGrid(leagues, c.leagueId, st.compSync || {});
}

function cmpRenderNow(live, feed) {
  const wrap = el('cmp-now'); if (!wrap) return;
  if (!live || !feed) { wrap.innerHTML = ''; return; }
  const row = (m, kind) => {
    const score = kind === 'upcoming' ? '<b>vs</b>' : `<b>${m.scoreA == null ? '-' : m.scoreA} - ${m.scoreB == null ? '-' : m.scoreB}</b>`;
    const right = kind === 'live'
      ? `<button class="btn btn-ghost btn-sm cmp-mini" type="button" data-cmp-status="" data-mid="${cmpEsc(m.id)}" title="Stop showing this match as live">Clear live</button>`
      : kind === 'upcoming'
        ? `<span class="cmp-now-when">${cmpEsc(cmpWhen(m))}</span><button class="btn btn-ghost btn-sm cmp-mini" type="button" data-cmp-status="live" data-mid="${cmpEsc(m.id)}" title="Show this match as LIVE on the ticker and schedule">Mark live</button>`
        : `<span class="cmp-now-when">${cmpEsc(m.round || '')}</span>`;
    return `<div class="cmp-now-row">${kind === 'live' ? '<span class="cmp-pill live">Live</span>' : ''}<span class="cmp-now-teams">${cmpEsc(m.teamA)}${score}${cmpEsc(m.teamB)}</span>${right}</div>`;
  };
  const col = (title, rows, kind, empty) => `<div class="cmp-now-col"><div class="cmp-sub">${title}</div>${rows.length ? rows.map((m) => row(m, kind)).join('') : `<div class="cmp-now-empty">${empty}</div>`}</div>`;
  wrap.innerHTML =
    col('Live now', feed.live || [], 'live', 'No match is live. Mark one live, or arm a match for capture on the league Schedule.') +
    col('Up next', (feed.upcoming || []).slice(0, 4), 'upcoming', 'No upcoming fixtures.') +
    col('Latest results', (feed.results || []).slice(0, 4), 'done', 'No results yet.');
}

function cmpRenderGrid(leagues, liveId, sync) {
  const grid = el('cmp-grid'); if (!grid) return;
  const games = cmpState().games || {};
  const cards = leagues.map((l) => {
    const src = (l.source && l.source.type) || 'manual';
    const s = sync[l.id];
    const isLive = l.id === liveId;
    const abbr = l.abbr || (l.name || '').split(/\s+/).map((w) => w[0] || '').join('').slice(0, 3).toUpperCase() || '?';
    const logo = l.logo ? `<img src="${cmpEsc(l.logo)}" alt="">` : cmpEsc(abbr);
    const played = (l.schedule || []).filter((m) => (Array.isArray(m.games) && m.games.length) || (m.result && m.result.scoreA != null && m.result.scoreB != null)).length;
    let status = '';
    let statusErr = false;
    if (cmpPulls(src)) {
      if (s && s.running) status = 'Syncing…';
      else if (s && s.lastError) { status = 'Sync failed: ' + s.lastError; statusErr = true; }
      else if (s && s.lastOkAt) status = 'Synced ' + cmpAgo(s.lastOkAt) + (s.summary ? ' — ' + s.summary : '');
      else if (src === 'sheet') status = l.source.sheetUrl ? 'Waiting for first sync' : 'Add the sheet link';
      else if (src === 'feed') status = l.source.feedUrl ? 'Waiting for first sync' : 'Add the feed URL';
      else status = l.source.cloudCompetitionId ? 'Waiting for first sync' : 'Pick a website competition';
    }
    const gameLabel = (games[l.game] && (games[l.game].name || games[l.game].label)) || l.game || 'No game set';
    return `<div class="cmp-card${isLive ? ' is-live' : ''}" data-lid="${cmpEsc(l.id)}">
      <div class="cmp-card-top"><div class="cmp-card-logo">${logo}</div>
        <div style="min-width:0;"><div class="cmp-card-name">${cmpEsc(l.name || 'League')}</div>
        <div class="cmp-card-sub">${cmpEsc([l.season, gameLabel].filter(Boolean).join(' · '))}</div></div></div>
      <div class="cmp-card-pills">${isLive ? '<span class="cmp-pill live">On air</span>' : ''}<span class="cmp-pill src">${cmpEsc(CMP_SRC_LABEL[src] || src)}</span>${statusErr ? '<span class="cmp-pill err">Needs attention</span>' : ''}</div>
      <div class="cmp-card-sub">${(l.teams || []).length} teams · ${played}/${(l.schedule || []).length} matches played</div>
      <div class="cmp-card-status${statusErr ? ' err' : ''}" title="${cmpEsc(status)}">${cmpEsc(status)}</div>
      <div class="cmp-card-actions">
        <button class="btn btn-secondary btn-sm cmp-mini" type="button" data-cmp-open="overview">Open</button>
        <button class="btn btn-ghost btn-sm cmp-mini" type="button" data-cmp-open="source">Data source</button>
        ${cmpPulls(src) ? '<button class="btn btn-ghost btn-sm cmp-mini" type="button" data-cmp-sync>Sync now</button>' : ''}
        ${isLive ? '' : '<button class="btn btn-primary btn-sm cmp-mini" type="button" data-cmp-live>Go live</button>'}
      </div></div>`;
  });
  cards.push('<div class="cmp-card cmp-card-new" id="cmp-card-new" role="button" tabindex="0">+ New league</div>');
  grid.innerHTML = cards.join('');
}

// Jump into a league's editor on a given tab.
function cmpOpenLeague(id, tab) {
  if (typeof evShowSubtab === 'function') evShowSubtab('leagues');
  lgActiveId = id;
  if (tab) _lgActiveTab = tab;
  lgRender();
}
function cmpNewLeague() {
  if (typeof evShowSubtab === 'function') evShowSubtab('leagues');
  el('lg-new')?.click();
}

// ── Hub wiring ───────────────────────────────────────────────────────────────
el('cmp-go-live')?.addEventListener('click', () => {
  const id = el('cmp-live-select')?.value || '';
  if (!id) { showToast('Create a league first.', '#f59e0b'); return; }
  send('competition_set_live', { leagueId: id });
});
el('cmp-off-air')?.addEventListener('click', async () => {
  if (!(await appConfirm('Take the live competition off air? The ticker and schedule board stop following it.', 'Take off air', true))) return;
  send('competition_set_live', { leagueId: '' });
});
el('ev-comp-panel')?.addEventListener('change', (e) => {
  const f = e.target.closest('[data-cmp-feed]');
  if (f) { send('competition_set_options', { feeds: { [f.dataset.cmpFeed]: f.checked } }); return; }
  const t = e.target.closest('[data-cmp-ticker]');
  if (t) send('competition_set_options', { ticker: { [t.dataset.cmpTicker]: t.checked } });
});
el('ev-comp-panel')?.addEventListener('click', (e) => {
  const st = e.target.closest('[data-cmp-status]');
  if (st) {
    const c = cmpState().competition || {};
    send('competition_match_status', { leagueId: c.leagueId, matchId: st.dataset.mid, status: st.dataset.cmpStatus });
    return;
  }
  const card = e.target.closest('.cmp-card[data-lid]');
  if (card) {
    const id = card.dataset.lid;
    const open = e.target.closest('[data-cmp-open]');
    if (open) return cmpOpenLeague(id, open.dataset.cmpOpen);
    if (e.target.closest('[data-cmp-live]')) return send('competition_set_live', { leagueId: id });
    if (e.target.closest('[data-cmp-sync]')) { send('competition_sync_now', { leagueId: id }); showToast('Syncing…', '#7C3AED', 1500); return; }
  }
  if (e.target.closest('#cmp-card-new')) return cmpNewLeague();
  const tpl = e.target.closest('[data-cmp-template]');
  if (tpl) cmpOpenApiDocs(tpl.dataset.cmpTemplate === 'api' ? 'api-sec-key' : 'cmp-tpl-' + tpl.dataset.cmpTemplate);
});
el('cmp-new-league')?.addEventListener('click', cmpNewLeague);
const cmpOpenPlatforms = () => {
  const btn = document.querySelector('#ev-subnav .ev-subnav-btn[data-evtab="startgg"]');
  if (btn && !btn.hidden) evShowSubtab('startgg');
  else {
    showToast('Add a start.gg, Challonge, FACEIT or NXGEN key in Marketplace > Integrations first.', '#f59e0b', 4000);
    document.querySelector('.js-goto-settings')?.click();
  }
};
el('cmp-open-platforms')?.addEventListener('click', cmpOpenPlatforms);
el('cmp-platforms-2')?.addEventListener('click', cmpOpenPlatforms);

// API key + reference — Marketplace ▸ API (#integration-api). The key loads when that page opens.
function cmpLoadKey() { if (!_cmpApiKey) send('competition_api_key'); }
// Jump from anywhere (Competitions source cards, a league's Data source tab) to one section of the API page.
function cmpOpenApiDocs(sectionId) {
  document.getElementById('tab-integrations')?.click();
  if (typeof _intShowTab === 'function') _intShowTab('api');
  if (sectionId) setTimeout(() => el(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}
el('integration-api')?.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-cmp-copy]');
  if (copy) return cmpCopy(copy.dataset.cmpCopy, 'Headers');
  const jump = e.target.closest('[data-api-jump]');
  if (jump) { e.preventDefault(); el(jump.dataset.apiJump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});
el('cmp-key-show')?.addEventListener('click', function () {
  const i = el('cmp-api-key'); if (!i) return;
  i.type = i.type === 'password' ? 'text' : 'password';
  this.textContent = i.type === 'password' ? 'Show' : 'Hide';
});
el('cmp-key-copy')?.addEventListener('click', () => { if (_cmpApiKey) cmpCopy(_cmpApiKey, 'API key'); else cmpLoadKey(); });
el('cmp-key-regen')?.addEventListener('click', async () => {
  if (!(await appConfirm('Create a new API key? Anything using the current key (bots, scripts, Stream Deck) stops working until you give it the new one.', 'Regenerate', true))) return;
  _cmpApiKey = '';
  send('competition_api_key', { regenerate: true });
});

(function cmpFillExamples() {
  const feed = el('cmp-feed-example');
  if (feed) feed.textContent = JSON.stringify({
    format: 'ne-competition', version: 1,
    competition: { id: 'fall-2026', name: 'Collegiate Fall League', season: 'Fall 2026', game: 'rocket-league' },
    teams: [
      { id: 'rvs', name: 'Riverside', abbr: 'RVS', logo: 'https://yourleague.com/logos/riverside.png', division: 'East' },
      { id: 'lkn', name: 'Lakeside North', abbr: 'LKN', logo: 'https://yourleague.com/logos/lakeside.png', division: 'East' }
    ],
    matches: [
      { id: 'wk3-rvs-lkn', teamA: 'rvs', teamB: 'lkn', scheduledAt: '2026-09-24T19:30:00-04:00', week: '3', bestOf: 5, status: 'scheduled' },
      { id: 'wk2-lkn-rvs', teamA: 'lkn', teamB: 'rvs', scheduledAt: '2026-09-17T19:30:00-04:00', week: '2', bestOf: 5, status: 'completed', scoreA: 3, scoreB: 1 }
    ]
  }, null, 2);
  const api = el('cmp-api-example');
  if (api) api.textContent =
    '# Report a result (PowerShell: use curl.exe)\n' +
    'curl -X PATCH http://127.0.0.1:3000/api/v1/competitions/<competition-id>/matches/wk3-rvs-lkn \\\n' +
    '  -H "Authorization: Bearer <your-key>" -H "Content-Type: application/json" \\\n' +
    '  -d "{\\"status\\":\\"completed\\",\\"scoreA\\":3,\\"scoreB\\":2}"\n\n' +
    '# Mark a match live\n' +
    'curl -X PATCH http://127.0.0.1:3000/api/v1/competitions/<competition-id>/matches/wk3-rvs-lkn \\\n' +
    '  -H "Authorization: Bearer <your-key>" -H "Content-Type: application/json" -d "{\\"status\\":\\"live\\"}"';
})();

// ── League ▸ Data source tab ────────────────────────────────────────────────
function cmpSourceOf(lg) {
  const s = (lg && lg.source) || {};
  return {
    type: s.type || 'manual', sheetUrl: s.sheetUrl || '', tabs: { teams: 'Teams', matches: 'Matches', standings: '', ...(s.tabs || {}) },
    feedUrl: s.feedUrl || '', intervalSec: s.intervalSec || 60, auto: s.auto !== false, prune: s.prune !== false,
    cloudCompetitionId: s.cloudCompetitionId || '',
  };
}
function cmpSetInput(id, v) { const i = el(id); if (i && document.activeElement !== i) i.value = v; }
function cmpSetCheck(id, v) { const i = el(id); if (i && document.activeElement !== i) i.checked = !!v; }

function lgRenderSourceTab() {
  const lg = lgActive(); if (!lg) return;
  const s = cmpSourceOf(lg);
  document.querySelectorAll('#lg-src-types .cmp-src-type').forEach((b) => b.classList.toggle('active', b.dataset.src === s.type));
  document.querySelectorAll('#lg2-panel-source [data-srcbody]').forEach((b) => { b.hidden = b.dataset.srcbody !== s.type; });
  const pulls = cmpPulls(s.type);
  const sync = el('lg-src-sync'); if (sync) sync.hidden = !pulls;
  // A website competition has no interval: the list is checked every minute and the document only
  // when the website says it changed, so "Check every" would be a lie there.
  const intervalField = el('lg-src-interval') && el('lg-src-interval').closest('.cmp-field');
  if (intervalField) intervalField.hidden = s.type === 'cloud';
  if (s.type === 'cloud') cmpRenderCloudPicker(lg, s);

  cmpSetInput('lg-src-sheet-url', s.sheetUrl);
  cmpSetInput('lg-src-tab-teams', s.tabs.teams);
  cmpSetInput('lg-src-tab-matches', s.tabs.matches);
  cmpSetInput('lg-src-tab-standings', s.tabs.standings);
  cmpSetInput('lg-src-feed-url', s.feedUrl);
  cmpSetInput('lg-src-interval', String([30, 60, 120, 300, 900].includes(Number(s.intervalSec)) ? s.intervalSec : 60));
  cmpSetCheck('lg-src-auto', s.auto);
  cmpSetCheck('lg-src-prune', s.prune);

  const access = el('lg-src-sheet-access');
  if (access) {
    const sh = cmpState().sheets || {};
    access.textContent = sh.hasKey
      ? 'Reading with your connected service account' + (sh.saEmail ? ' (' + sh.saEmail + ')' : '') + ' — share the sheet with that email.'
      : 'Share the sheet as "Anyone with the link, Viewer". For a private sheet, connect a service account under Apps > Google Sheets.';
  }
  if (s.type === 'feed' && _cmpTokenState[lg.id] === undefined) send('competition_feed_token_status', { leagueId: lg.id });
  const ts = el('lg-src-token-state');
  if (ts) ts.textContent = _cmpTokenState[lg.id] ? 'A token is saved (stored encrypted on this PC).' : 'No token saved.';

  cmpSetInput('lg-src-push-id', lg.id);
  const ex = el('lg-src-push-example');
  if (ex) ex.textContent =
    'PATCH ' + CMP_API + '/competitions/' + lg.id + '\n' +
    'Authorization: Bearer <your-key>\n\n' +
    JSON.stringify({ matches: [{ id: 'your-match-id', teamA: 'Riverside', teamB: 'Lakeside North', scheduledAt: '2026-09-24T19:30:00-04:00', status: 'scheduled' }] }, null, 2) +
    '\n\nPATCH ' + CMP_API + '/competitions/' + lg.id + '/matches/your-match-id\n' +
    JSON.stringify({ status: 'completed', scoreA: 3, scoreB: 1 });

  cmpRenderSyncStatus(lg);
  cmpRenderSyncedNote(lg);
}
function cmpRenderSyncStatus(lg) {
  const box = el('lg-src-status'); if (!box || !lg) return;
  const s = (cmpState().compSync || {})[lg.id];
  box.className = 'cmp-status';
  if (!s || (!s.lastSyncAt && !s.running)) { box.textContent = 'Not synced yet.'; }
  else if (s.running) { box.textContent = 'Syncing…'; }
  else if (s.lastError) { box.classList.add('err'); box.textContent = 'Last sync failed ' + cmpAgo(s.lastSyncAt) + ': ' + s.lastError + (s.fails > 1 ? ' (retrying less often)' : ''); }
  else { box.classList.add('ok'); box.textContent = 'Synced ' + cmpAgo(s.lastOkAt) + (s.summary ? ' — ' + s.summary : '') + '.'; }
  const w = el('lg-src-warnings');
  if (w) {
    const list = (s && !s.lastError && s.warnings) || [];
    w.hidden = !list.length;
    w.innerHTML = list.map((x) => '<li>' + cmpEsc(x) + '</li>').join('');
  }
}
// On the league's other tabs: say plainly that synced rows are owned by the source.
function cmpRenderSyncedNote(lg) {
  const host = el('lg-detail'); if (!host || !lg) return;
  let note = el('lg-src-synced-note');
  const s = cmpSourceOf(lg);
  const pulls = cmpPulls(s.type);
  if (!pulls) { if (note) note.remove(); return; }
  if (!note) {
    note = document.createElement('p');
    note.id = 'lg-src-synced-note';
    note.className = 'cmp-synced-note';
    const tabs = el('lg2-tabs');
    if (tabs && tabs.parentNode) tabs.parentNode.insertBefore(note, tabs);
  }
  note.textContent = 'This league syncs from ' + (s.type === 'sheet' ? 'a Google Sheet' : s.type === 'cloud' ? 'the Nameless website' : 'a website feed') +
    '. Change teams, fixtures and results there — edits made here to synced matches are replaced on the next sync.';
}

// ── Nameless website competitions (source.type 'cloud') ──
function cmpRenderCloudPicker(lg, s) {
  const sel = el('lg-src-cloud-pick'); if (!sel || !lg) return;
  const list = _cmpCloudList;
  const signedIn = cmpCloudSignedIn();
  const hint = el('lg-src-cloud-hint');
  if (hint) {
    hint.textContent = !signedIn ? 'Sign in on Settings > Profile to see your website competitions.'
      : !cmpCloudIsOrg() ? 'Website competitions belong to an organization — your account is not in one.'
      : !list.length ? 'No competitions on your website yet. Create one there and it shows up here within a minute.' : '';
    hint.hidden = !hint.textContent;
  }
  if (document.activeElement !== sel) {
    const keep = sel.value || s.cloudCompetitionId;
    sel.innerHTML = list.length
      ? list.map((c) => `<option value="${cmpEsc(c.id)}">${cmpEsc([c.name || 'Untitled', c.season, c.kind === 'tournament' ? 'Tournament' : 'League'].filter(Boolean).join(' · ') + (c.live ? ' (live)' : ''))}</option>`).join('')
      : '<option value="">' + (signedIn ? 'No competitions yet' : 'Sign in first') + '</option>';
    if (keep && list.some((c) => c.id === keep)) sel.value = keep;
  }
  sel.disabled = !list.length;
  const btn = el('lg-src-cloud-link'); if (btn) btn.disabled = !list.length;
  const linked = el('lg-src-cloud-linked');
  if (linked) {
    const c = list.find((x) => x.id === s.cloudCompetitionId);
    linked.textContent = !s.cloudCompetitionId ? 'Not linked yet — pick a competition and press Link.'
      : 'Linked to ' + (c ? [c.name || 'Untitled', c.season].filter(Boolean).join(' · ') : s.cloudCompetitionId) + (c && c.live ? ' — live on the website' : '') + '.';
  }
}
el('lg-src-cloud-link')?.addEventListener('click', () => {
  const lg = lgActive(); const sel = el('lg-src-cloud-pick');
  if (!lg || !sel || !sel.value) { showToast('Pick a website competition first.', '#f59e0b'); return; }
  const c = _cmpCloudList.find((x) => x.id === sel.value);
  // A fresh league takes the website's name/season/game; a named one keeps the producer's.
  if (c) {
    if (!lg.name || lg.name === 'New League') lg.name = c.name || lg.name;
    if (!lg.season && c.season) lg.season = c.season;
    if (!lg.game && c.game) lg.game = c.game;
  }
  cmpUpdateSource({ type: 'cloud', cloudCompetitionId: sel.value, intervalSec: 60, auto: true });
  if (typeof lgRender === 'function') lgRender();
  lgRenderSourceTab();
  const box = el('lg-src-status'); if (box) { box.className = 'cmp-status'; box.textContent = 'Syncing…'; }
  cmpFlushThen(() => send('competition_sync_now', { leagueId: lg.id }));
});
// cloud_status replies are routed in app.js to applyCloudStatus(); it is a global function
// declaration (a writable window property), so wrap it here instead of adding a second router.
(function cmpHookCloudStatus() {
  const orig = window.applyCloudStatus;
  if (typeof orig !== 'function') return;
  window.applyCloudStatus = function (s) {
    try { return orig.apply(this, arguments); }
    finally {
      _cmpCloudSess = s || {};
      const p = el('lg2-panel-source');
      const lg = typeof lgActive === 'function' ? lgActive() : null;
      if (p && p.style.display !== 'none' && lg && cmpSourceOf(lg).type === 'cloud') cmpRenderCloudPicker(lg, cmpSourceOf(lg));
    }
  };
})();

function cmpUpdateSource(patch) {
  const lg = lgActive(); if (!lg) return;
  const cur = cmpSourceOf(lg);
  lg.source = { ...cur, ...patch, tabs: { ...cur.tabs, ...(patch.tabs || {}) } };
  lgSave();
}
document.querySelector('#lg-src-types')?.addEventListener('click', (e) => {
  const b = e.target.closest('.cmp-src-type'); if (!b) return;
  cmpUpdateSource({ type: b.dataset.src });
  lgRenderSourceTab();
});
[['lg-src-sheet-url', (v) => ({ sheetUrl: v })], ['lg-src-feed-url', (v) => ({ feedUrl: v })],
 ['lg-src-tab-teams', (v) => ({ tabs: { teams: v } })], ['lg-src-tab-matches', (v) => ({ tabs: { matches: v } })],
 ['lg-src-tab-standings', (v) => ({ tabs: { standings: v } })]].forEach(([id, fn]) => {
  el(id)?.addEventListener('change', function () { cmpUpdateSource(fn(this.value.trim())); });
});
el('lg-src-interval')?.addEventListener('change', function () { cmpUpdateSource({ intervalSec: Number(this.value) || 60 }); });
el('lg-src-auto')?.addEventListener('change', function () { cmpUpdateSource({ auto: this.checked }); });
el('lg-src-prune')?.addEventListener('change', function () { cmpUpdateSource({ prune: this.checked }); });

// Test / Sync read the SAVED source, so flush a pending edit first (inputs commit on change).
function cmpFlushThen(fn) {
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#lg2-panel-source')) document.activeElement.blur();
  clearTimeout(_lgSaveTimer);
  send('set_leagues', { leagues: lgLeagues });
  setTimeout(fn, 150);
}
el('lg-src-test')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const box = el('lg-src-status'); if (box) { box.className = 'cmp-status'; box.textContent = 'Testing…'; }
  cmpFlushThen(() => send('competition_sync_now', { leagueId: lg.id, dryRun: true }));
});
el('lg-src-sync-now')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const box = el('lg-src-status'); if (box) { box.className = 'cmp-status'; box.textContent = 'Syncing…'; }
  cmpFlushThen(() => send('competition_sync_now', { leagueId: lg.id }));
});
el('lg-src-token-save')?.addEventListener('click', () => {
  const lg = lgActive(); const i = el('lg-src-feed-token'); if (!lg || !i) return;
  if (!i.value.trim()) { showToast('Paste the token first.', '#f59e0b'); return; }
  send('competition_set_feed_token', { leagueId: lg.id, token: i.value.trim() });
  i.value = '';
});
el('lg-src-token-clear')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  send('competition_set_feed_token', { leagueId: lg.id, clear: true });
});
el('lg-src-push-copy')?.addEventListener('click', () => { const lg = lgActive(); if (lg) cmpCopy(lg.id, 'Competition ID'); });

// One-off import
el('lg-src-import-pick')?.addEventListener('click', () => el('lg-src-import-file')?.click());
el('lg-src-import-file')?.addEventListener('change', function () {
  const f = this.files && this.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { const t = el('lg-src-import-text'); if (t) t.value = String(r.result || ''); };
  r.readAsText(f);
  this.value = '';
});
el('lg-src-import-go')?.addEventListener('click', () => {
  const lg = lgActive(); const t = el('lg-src-import-text'); if (!lg || !t) return;
  if (!t.value.trim()) { showToast('Paste CSV or JSON, or choose a file.', '#f59e0b'); return; }
  const st = el('lg-src-import-status'); if (st) { st.className = 'cmp-status'; st.textContent = 'Importing…'; }
  cmpFlushThen(() => send('competition_import', { leagueId: lg.id, text: t.value }));
});

// ── Dashboard ▸ Event ▸ My league ───────────────────────────────────────────
// One paste box for wherever a league lives. Platform links go to the loaders the other tabs use;
// a Google Sheet or any other https link becomes a league that syncs from it (competition_link).
function evLeagueClassify(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: '' };
  let u = null;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (_) { return { kind: 'bad' }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'docs.google.com' && /\/spreadsheets\/d\//.test(u.pathname)) return { kind: 'sheet', url: u.toString() };
  if (host === 'start.gg' || host === 'smash.gg' || host.endsWith('.start.gg')) return { kind: 'startgg', url: u.toString() };
  if (host === 'challonge.com' || host.endsWith('.challonge.com')) {
    const slug = parts[parts.length - 1] || '';
    const sub = host.endsWith('.challonge.com') ? host.split('.')[0] : '';
    // Challonge's API names a community tournament "<subdomain>-<slug>".
    return slug ? { kind: 'challonge', slug: sub && sub !== 'challonge' ? sub + '-' + slug : slug } : { kind: 'bad' };
  }
  if (host === 'faceit.com' || host.endsWith('.faceit.com')) return { kind: 'faceit', url: u.toString() };
  if (host === 'nxgen.pro' || host.endsWith('.nxgen.pro')) return { kind: 'nxgen', slug: parts[parts.length - 1] || '' };
  if (!/^https?:\/\//i.test(s)) return { kind: 'bad' };
  return { kind: 'feed', url: u.toString() };
}
function evLeagueStatus(msg, cls) {
  const st = el('ev-league-link-status'); if (!st) return;
  st.className = 'evl-status' + (cls ? ' ' + cls : '');
  st.textContent = msg || '';
}
function evLeagueGoToPlatform(plat) {
  document.querySelector(`.ev-plat-tab[data-plat="${plat}"]`)?.click();
}
function evLeagueLink() {
  const input = el('ev-league-link');
  const c = evLeagueClassify(input && input.value);
  const goLive = el('ev-league-link-live') ? el('ev-league-link-live').checked : true;
  if (c.kind === '') { evLeagueStatus('Paste a link first.', 'err'); return; }
  if (c.kind === 'bad') { evLeagueStatus('That does not look like a link. Paste the full address from your browser.', 'err'); return; }
  if (c.kind === 'startgg') {
    evLeagueGoToPlatform('startgg');
    if (typeof loadStartggEvent === 'function') loadStartggEvent(c.url);
    if (input) input.value = '';
    evLeagueStatus('');
    return;
  }
  if (c.kind === 'challonge' || c.kind === 'nxgen' || c.kind === 'faceit') {
    const need = { challonge: 'challonge', nxgen: 'nxgen', faceit: 'faceit' }[c.kind];
    const has = { challonge: cmpState().challonge?.hasKey, nxgen: cmpState().nxgen?.hasKey, faceit: cmpState().faceit?.hasKey }[c.kind];
    evLeagueGoToPlatform(need);
    if (!has) { showToast('Add your ' + ({ challonge: 'Challonge', nxgen: 'NXGEN', faceit: 'FACEIT' }[c.kind]) + ' key under Apps to load this.', '#f59e0b', 4500); return; }
    if (c.kind === 'challonge') send('load_challonge_tournament', { slug: c.slug });
    if (c.kind === 'nxgen') send('load_nxgen_event', { slug: c.slug });
    if (c.kind === 'faceit') send('load_faceit_event', { id: c.url });
    const ls = el('ev-load-status'); if (ls) ls.textContent = 'Loading…';
    if (input) input.value = '';
    evLeagueStatus('');
    return;
  }
  const btn = el('ev-league-link-go');
  if (btn) { btn.disabled = true; btn.textContent = 'Linking…'; }
  evLeagueStatus(c.kind === 'sheet' ? 'Reading the sheet…' : 'Reading the feed…');
  send('competition_link', { type: c.kind, url: c.url, goLive });
}
function evLeagueRender(force) {
  const panel = el('ev-plat-panel-league');
  if (!panel || (!force && panel.style.display === 'none')) return;
  const st = cmpState();
  const leagues = cmpLeagues();
  const liveId = (st.competition || {}).leagueId || '';
  const live = liveId ? leagues.find((l) => l.id === liveId) : null;

  const btn = el('ev-league-link-go');
  if (btn && !btn.disabled) btn.textContent = (el('ev-league-link-live') && !el('ev-league-link-live').checked) ? 'Link' : 'Link and go live';

  const sel = el('ev-league-pick');
  if (sel && document.activeElement !== sel) {
    const keep = sel.value;
    sel.innerHTML = leagues.length
      ? leagues.map((l) => `<option value="${cmpEsc(l.id)}">${cmpEsc([l.name || 'League', l.season].filter(Boolean).join(' — '))}</option>`).join('')
      : '<option value="">No leagues yet</option>';
    const want = [keep, liveId].find((id) => id && leagues.some((l) => l.id === id));
    if (want) sel.value = want;
    sel.disabled = !leagues.length;
  }
  const go = el('ev-league-golive');
  if (go) {
    const picked = sel && sel.value;
    go.disabled = !leagues.length || (picked && picked === liveId);
    go.textContent = picked && picked === liveId ? 'On air' : 'Go live';
  }

  const card = el('ev-league-live');
  if (card) {
    card.hidden = !live;
    if (live) {
      const src = (live.source && live.source.type) || 'manual';
      const sync = (st.compSync || {})[live.id];
      const feed = st.compFeed;
      const next = feed && feed.next && feed.next.id ? feed.next : null;
      el('ev-league-live-name').textContent = [live.name || 'League', live.season].filter(Boolean).join(' — ');
      const bits = [CMP_SRC_LABEL[src] || src];
      if (cmpPulls(src) && sync) bits.push(sync.lastError ? 'sync failed' : sync.lastOkAt ? 'synced ' + cmpAgo(sync.lastOkAt) : 'syncing');
      if (next) bits.push((next.status === 'live' ? 'Live: ' : 'Next: ') + next.teamA + ' vs ' + next.teamB);
      el('ev-league-live-meta').textContent = bits.join(' · ');
      el('ev-league-live-meta').title = sync && sync.lastError ? sync.lastError : '';
    }
  }
}
window.evLeagueRender = evLeagueRender;

el('ev-league-link-go')?.addEventListener('click', evLeagueLink);
el('ev-league-link')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') evLeagueLink(); });
el('ev-league-link')?.addEventListener('input', function () {
  const c = evLeagueClassify(this.value);
  const hint = { sheet: 'Google Sheet — it will sync every minute.', feed: 'Website feed — it will be checked every minute.',
    startgg: 'start.gg link — loads like the start.gg tab.', challonge: 'Challonge link — loads like the Challonge tab.',
    faceit: 'FACEIT link — loads like the FACEIT tab.', nxgen: 'NXGEN link — loads like the NXGEN tab.' }[c.kind];
  evLeagueStatus(hint || '');
});
el('ev-league-link-live')?.addEventListener('change', () => evLeagueRender(true));
el('ev-league-pick')?.addEventListener('change', () => evLeagueRender(true));
el('ev-league-golive')?.addEventListener('click', () => {
  const id = el('ev-league-pick')?.value;
  if (!id) { showToast('Create a league first.', '#f59e0b'); return; }
  send('competition_set_live', { leagueId: id });
});
el('ev-league-new')?.addEventListener('click', () => {
  document.getElementById('tab-events')?.click();
  cmpNewLeague();
});
el('ev-league-open')?.addEventListener('click', () => {
  const id = (cmpState().competition || {}).leagueId; if (!id) return;
  document.getElementById('tab-events')?.click();
  cmpOpenLeague(id, 'overview');
});
el('ev-league-off')?.addEventListener('click', async () => {
  if (!(await appConfirm('Take the live competition off air? The ticker and schedule board stop following it.', 'Take off air', true))) return;
  send('competition_set_live', { leagueId: '' });
});
// Reopen My league if that is where the producer was (an active platform event still wins — its
// tab is selected when that event is set).
setTimeout(() => {
  let t; try { t = localStorage.getItem('ne_ev_plat_tab'); } catch (_) {}
  if (t === 'league' && !(cmpState().activeEvent && cmpState().activeEvent.name)) evLeagueGoToPlatform('league');
}, 0);

// ── Replies from the server ──────────────────────────────────────────────────
function cmpOnResult(d) {
  if (!d) return;
  if (d.op === 'api_key') {
    _cmpApiKey = d.key || '';
    const i = el('cmp-api-key'); if (i) i.value = _cmpApiKey;
    return;
  }
  if (d.op === 'link') {
    const btn = el('ev-league-link-go');
    if (btn) btn.disabled = false;
    evLeagueRender(true);
    if (!d.ok) { evLeagueStatus(d.error, 'err'); return; }
    const input = el('ev-league-link'); if (input) input.value = '';
    evLeagueStatus((d.created ? 'Linked "' : 'Synced "') + d.name + '": ' + d.teams + ' teams, ' + d.matches + ' matches' +
      (d.live ? '. It is live now.' : '.') + (d.warnings && d.warnings.length ? ' ' + d.warnings.length + ' row(s) skipped — see its Data source tab.' : ''), 'ok');
    showToast((d.live ? 'Live: ' : 'Linked: ') + d.name, '#22c55e', 2500);
    return;
  }
  if (d.op === 'feed_token') {
    _cmpTokenState[d.leagueId] = !!d.hasToken;
    const lg = typeof lgActive === 'function' ? lgActive() : null;
    if (lg && lg.id === d.leagueId) {
      const ts = el('lg-src-token-state');
      if (ts) ts.textContent = d.hasToken ? 'A token is saved (stored encrypted on this PC).' : 'No token saved.';
    }
    return;
  }
  if (d.op === 'import') {
    const st = el('lg-src-import-status');
    if (st) { st.className = 'cmp-status ' + (d.ok ? 'ok' : 'err'); st.textContent = d.ok ? 'Imported: ' + d.summary + '.' : d.error; }
    if (d.ok) { const t = el('lg-src-import-text'); if (t) t.value = ''; }
    if (d.warnings && d.warnings.length) console.info('[competition import] warnings:', d.warnings);
    return;
  }
  if (d.op === 'test' || d.op === 'sync') {
    const lg = typeof lgActive === 'function' ? lgActive() : null;
    const onThis = lg && lg.id === d.leagueId && el('lg2-panel-source') && el('lg2-panel-source').style.display !== 'none';
    if (d.op === 'test') {
      if (!onThis) return;
      const box = el('lg-src-status');
      if (box) {
        box.className = 'cmp-status ' + (d.ok ? 'ok' : 'err');
        box.textContent = d.ok
          ? (d.counts ? `Connected. Found ${d.counts.teams} teams, ${d.counts.matches} matches${d.counts.standings ? ', ' + d.counts.standings + ' standings rows' : ''}. A sync would make: ${d.summary}.` : 'Connected. ' + (d.summary || ''))
          : 'Test failed: ' + d.error;
      }
      const w = el('lg-src-warnings');
      if (w) { const list = d.warnings || []; w.hidden = !list.length; w.innerHTML = list.map((x) => '<li>' + cmpEsc(x) + '</li>').join(''); }
      return;
    }
    if (!d.ok) showToast('Sync failed: ' + d.error, '#c53030', 6000);
    else if (!onThis) showToast('Synced: ' + d.summary, '#22c55e', 2500);
  }
}
window.cmpOnResult = cmpOnResult;

// Re-render on every state broadcast (cheap: signature-guarded, and only when a panel is visible).
function cmpApplyState() {
  cmpRender(false);
  const p = el('lg2-panel-source');
  const lg = typeof lgActive === 'function' ? lgActive() : null;
  const open = p && p.style.display !== 'none' && lg;
  // Library-tier key: present only on the broadcasts where it changed, so remember the last copy.
  const cc = cmpState().cloudCompetitions;
  if (Array.isArray(cc) && JSON.stringify(cc) !== JSON.stringify(_cmpCloudList)) {
    _cmpCloudList = cc;
    if (open && cmpSourceOf(lg).type === 'cloud') cmpRenderCloudPicker(lg, cmpSourceOf(lg));
  }
  if (lg) cmpRenderSyncedNote(lg);
  if (open) cmpRenderSyncStatus(lg);
}
window.cmpApplyState = cmpApplyState;
window.cmpRender = cmpRender;
window.lgRenderSourceTab = lgRenderSourceTab;
