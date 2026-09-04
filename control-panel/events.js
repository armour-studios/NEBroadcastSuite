/* ─── events.js — Events/ESPORTS page domain (ev*: start.gg admin tournaments + ──
   sponsorship data, events grid/detail/source tabs, MY EVENTS live sync,
   cross-platform event sync modal, Challonge link modal; also carries the Teams
   import/export block that sits inside this region). Extracted verbatim from
   app.js (2026-07). Loads after app.js and leagues.js; inbound calls
   (evAutoLoad/renderMyEvents/evStatus/…) are runtime, typeof-guarded in app.js. */

// ══════════════ Events tab — start.gg admin tournaments + sponsorship data ══════════════
const EV_API = 'http://127.0.0.1:3000/api/startgg';
let _evDetail = null;
let _evTournaments = [];
let _evFilter = 'upcoming';   // 'upcoming' | 'past' | 'all'
let _evSearch = '';
let _evMode = 'mine';         // 'mine' = my admin tournaments | 'search' = global start.gg search
let _evSource = 'startgg';    // 'startgg' | 'challonge' | 'nxgen' | 'faceit' — which platform the grid is showing

function evStatus(msg, kind) {
  const s = el('ev-status'); if (!s) return;
  s.textContent = msg || '';
  s.className = 'ev-status' + (kind ? ' ev-' + kind : '');
}
function fmtEvDate(ts) {
  if (!ts) return '';
  try { return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; }
}
async function evPost(path, body) {
  const r = await fetch(EV_API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
// Auto-load the producer's in-house tournaments when the Competitions tab first opens — instant
// from the local cache, then refreshed from start.gg in the background. No button click needed.
let _evAutoLoaded = false;
function evAutoLoad() {
  if (_evAutoLoaded) return;
  _evAutoLoaded = true;
  _evMode = 'mine';
  let cachedCount = 0;
  try {
    const c = JSON.parse(localStorage.getItem('ne_my_tournaments') || 'null');
    if (c && Array.isArray(c.tournaments) && c.tournaments.length) {
      _evTournaments = c.tournaments; cachedCount = c.tournaments.length;
      if (typeof evSetMode === 'function') evSetMode('My tournaments');
      const toolbar = el('ev-toolbar'); if (toolbar) toolbar.style.display = '';
      applyEventsView();
    }
  } catch (e) {}
  evLoadTournaments({ silent: cachedCount > 0 });   // refresh from start.gg (quiet if we showed cache)
}
async function evLoadTournaments(opts) {
  opts = opts || {};
  _evMode = 'mine';
  const btn = el('ev-load'); if (btn) btn.disabled = true;
  if (!opts.silent) evStatus('Loading your tournaments…');
  try {
    const data = await evPost('/my-tournaments', {});
    _evTournaments = data.tournaments || [];
    try { localStorage.setItem('ne_my_tournaments', JSON.stringify({ tournaments: _evTournaments, at: Date.now() })); } catch (e) {}
    _evSearch = (el('ev-search')?.value || '').trim();   // box filters the loaded list in mine mode
    const toolbar = el('ev-toolbar'); if (toolbar) toolbar.style.display = '';
    if (typeof evSetMode === 'function') evSetMode('My tournaments');
    applyEventsView();
    evStatus(_evTournaments.length ? '' : 'No tournaments found for this token — confirm you admin/staff events and your token is set in Settings → start.gg.');
  } catch (e) {
    if (!opts.silent) evStatus(e.message || 'Failed to load. Check your start.gg token in Settings.', 'err');
  } finally { if (btn) btn.disabled = false; }
}
// Challonge and NXGEN tournaments are one bracket each (no nested "events" the way a start.gg
// tournament can have), so they're normalized into the same card shape as start.gg tournaments —
// same search/filter/sort in applyEventsView() — but tagged with `platform` so renderEventsGrid()
// gives them inline "+ My Events" / "Set live" actions instead of a detail-drilldown click.
async function evLoadChallongeTournaments() {
  const btn = el('ev-load'); if (btn) btn.disabled = true;
  evStatus('Loading your Challonge tournaments…');
  try {
    const r = await fetch('http://127.0.0.1:3000/api/challonge/my-tournaments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    _evTournaments = (data.tournaments || []).map((t) => ({
      platform: 'challonge', slug: t.slug, name: t.name,
      startAt: t.startedAt ? Math.floor(new Date(t.startedAt).getTime() / 1000) : null,
      numAttendees: t.participantsCount || 0, eventCount: 1, image: t.logo || '', game: t.gameName || '',
    }));
    evSetMode('Challonge — my tournaments');
    applyEventsView();
    evStatus(_evTournaments.length ? '' : 'No Challonge tournaments found — confirm your API key in Settings → Integrations.');
  } catch (e) {
    evStatus(e.message || 'Failed to load. Check your Challonge API key in Settings.', 'err');
  } finally { if (btn) btn.disabled = false; }
}
async function evLoadNxgenTournaments() {
  const btn = el('ev-load'); if (btn) btn.disabled = true;
  evStatus('Loading your NXGEN events…');
  try {
    const r = await fetch('http://127.0.0.1:3000/api/nxgen/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 100, includePast: true }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    _evTournaments = (data.events || []).map((e) => ({
      platform: 'nxgen', slug: e.slug, name: e.name,
      startAt: e.eventDate ? Math.floor(new Date(e.eventDate).getTime() / 1000) || null : null,
      numAttendees: e.participantCount || 0, eventCount: 1, image: e.coverImage || '', game: e.activity || '',
    }));
    evSetMode('NXGEN — events');
    applyEventsView();
    evStatus(_evTournaments.length ? '' : 'No NXGEN events found — confirm your API key in Settings → Integrations.');
  } catch (e) {
    evStatus(e.message || 'Failed to load. Check your NXGEN API key in Settings.', 'err');
  } finally { if (btn) btn.disabled = false; }
}
// FACEIT lists an ORGANISER'S own championships and hubs (set the organiser name in Settings ▸
// Integrations ▸ FACEIT). There is no "everything I admin" endpoint the way start.gg has one, so
// without an organiser this grid is empty and the Dashboard's paste-a-link path is the way in.
async function evLoadFaceitCompetitions() {
  const btn = el('ev-load'); if (btn) btn.disabled = true;
  evStatus('Loading your FACEIT competitions…');
  try {
    const r = await fetch('http://127.0.0.1:3000/api/faceit/my-competitions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    _evTournaments = (data.competitions || []).map((c) => ({
      platform: 'faceit', slug: c.id, competitionType: c.type || 'championship', name: c.name,
      startAt: null,
      numAttendees: c.slots || 0, eventCount: 1, image: c.avatar || '', game: c.game || '',
    }));
    evSetMode('FACEIT — my competitions');
    applyEventsView();
    evStatus(_evTournaments.length ? ''
      : (data.needsOrganizer
        ? 'Add your FACEIT organiser name in Settings → Integrations → FACEIT to list your competitions here (or paste a championship link on the Dashboard).'
        : 'No FACEIT competitions found for this organiser.'));
  } catch (e) {
    evStatus(e.message || 'Failed to load. Check your FACEIT API key in Settings.', 'err');
  } finally { if (btn) btn.disabled = false; }
}
// Switch which platform the Tournaments grid is showing.
function evSetSource(src) {
  _evSource = ['challonge', 'nxgen', 'faceit'].includes(src) ? src : 'startgg';
  document.querySelectorAll('#ev-src-seg .ev-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.src === _evSource));
  const searchbar = el('ev-searchbar'); if (searchbar) searchbar.style.display = _evSource === 'startgg' ? '' : 'none';
  const loadBtn = el('ev-load');
  if (loadBtn) loadBtn.textContent = _evSource === 'challonge' ? 'My Challonge tournaments' : _evSource === 'nxgen' ? 'My NXGEN events' : _evSource === 'faceit' ? 'My FACEIT competitions' : 'My tournaments';
  _evTournaments = []; _evDetail = null;
  const sec = el('ev-detail-section'); if (sec) sec.style.display = 'none';
  const toolbar = el('ev-toolbar'); if (toolbar) toolbar.style.display = '';
  if (_evSource === 'challonge') evLoadChallongeTournaments();
  else if (_evSource === 'nxgen') evLoadNxgenTournaments();
  else if (_evSource === 'faceit') evLoadFaceitCompetitions();
  else evLoadTournaments();
}
document.querySelectorAll('#ev-src-seg .ev-seg-btn').forEach((b) => b.addEventListener('click', () => evSetSource(b.dataset.src)));
// Filter (upcoming/past/all) + name search + sort, then render. Default: upcoming,
// soonest tournament first → farthest. Past: most recent first.
function evStartTs(t) { return t.startAt || t.endAt || 0; }
function evIsUpcoming(t, now) { return (t.endAt || t.startAt || 0) >= now; }
function applyEventsView() {
  const now = Date.now() / 1000;
  const q = _evSearch.trim();
  // Filter only — the date sort below is the ordering the producer expects here, so relevance
  // ranking would fight it.
  let list = _evTournaments.slice();
  if (q) list = list.filter((t) => NESearch.matches(q, [
    { text: t.name, weight: 2 }, t.slug, t.city, t.venue, t.ownerName
  ]));

  const upAsc = (a, b) => (evStartTs(a) || Infinity) - (evStartTs(b) || Infinity);   // soonest first
  const pastDesc = (a, b) => evStartTs(b) - evStartTs(a);                             // most recent first
  if (_evFilter === 'upcoming') list = list.filter((t) => evIsUpcoming(t, now)).sort(upAsc);
  else if (_evFilter === 'past') list = list.filter((t) => !evIsUpcoming(t, now)).sort(pastDesc);
  else list = list.filter((t) => evIsUpcoming(t, now)).sort(upAsc)
    .concat(list.filter((t) => !evIsUpcoming(t, now)).sort(pastDesc));

  const cnt = el('ev-count');
  if (cnt) cnt.textContent = list.length + (list.length === 1 ? ' tournament' : ' tournaments');
  renderEventsGrid(list, now);
}
function evRelDate(ts, now) {
  if (!ts) return '';
  const days = Math.round((ts - now) / 86400);
  if (days === 0) return 'today';
  if (days > 0) return days === 1 ? 'tomorrow' : (days < 14 ? `in ${days} days` : (days < 60 ? `in ${Math.round(days / 7)} weeks` : `in ${Math.round(days / 30)} months`));
  const ago = -days;
  return ago === 1 ? 'yesterday' : (ago < 14 ? `${ago} days ago` : (ago < 60 ? `${Math.round(ago / 7)} weeks ago` : `${Math.round(ago / 30)} months ago`));
}
function renderEventsGrid(list, now) {
  const grid = el('ev-grid'); if (!grid) return;
  now = now || Date.now() / 1000;
  const sec = el('ev-detail-section'); if (sec) sec.style.display = 'none';
  grid.style.display = '';
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = `<div class="ev-empty" style="grid-column:1/-1;">${_evSearch ? 'No tournaments match your search.' : 'No ' + (_evFilter === 'all' ? '' : _evFilter + ' ') + 'tournaments.'}</div>`;
    return;
  }
  list.forEach((t) => {
    const past = !evIsUpcoming(t, now);
    const platform = t.platform || 'startgg';
    // Start.gg tournaments can hold several events, so the whole card is a <button> that drills
    // into the detail view (unchanged). Challonge/NXGEN tournaments are one bracket each — a plain
    // <div> card with its own inline action <button>s (a <button> can't nest another <button>).
    const card = document.createElement(platform === 'startgg' ? 'button' : 'div');
    card.className = 'ev-card' + (past ? ' ev-card-past' : '');
    const PLAT_PILL = { challonge: 'CHALLONGE', nxgen: 'NXGEN', faceit: 'FACEIT' };
    const platformBadge = platform !== 'startgg' ? `<span class="ev-pill ev-pill-src">${PLAT_PILL[platform] || platform.toUpperCase()}</span>` : '';
    card.innerHTML = `<div class="ev-card-img"></div><div class="ev-card-body">
      <div class="ev-card-name"></div><div class="ev-card-meta"></div>
      <div class="ev-card-stats">${platformBadge}<span class="ev-pill"></span><span class="ev-pill"></span></div>
      ${platform !== 'startgg' ? '<div class="ev-card-acts"><button type="button" class="btn btn-secondary btn-sm ev-card-addmy">+ My Events</button><button type="button" class="btn btn-primary btn-sm ev-card-live">Set live</button></div>' : ''}</div>`;
    const img = card.querySelector('.ev-card-img');
    if (t.image) { const i = document.createElement('img'); i.src = t.image; i.alt = ''; img.appendChild(i); }
    else img.textContent = (t.name || '?').slice(0, 1).toUpperCase();
    card.querySelector('.ev-card-name').textContent = t.name || '(untitled)';
    const rel = evRelDate(evStartTs(t), now);
    card.querySelector('.ev-card-meta').textContent = [fmtEvDate(t.startAt), rel, [t.city, t.countryCode].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    const pills = card.querySelectorAll('.ev-pill:not(.ev-pill-src)');
    pills[0].textContent = (t.numAttendees || 0) + (platform === 'startgg' ? ' entrants' : ' teams');
    if (platform === 'startgg') pills[1].textContent = (t.eventCount || 0) + ' events'; else pills[1].remove();
    if (platform === 'startgg') {
      card.addEventListener('click', () => evOpenDetail(t.slug));
    } else {
      card.querySelector('.ev-card-addmy')?.addEventListener('click', (e) => {
        e.stopPropagation();
        send('add_my_event', { platform, platformSlug: t.slug, name: t.name, tournamentName: t.name, game: t.game || '', numEntrants: t.numAttendees || 0, startAt: t.startAt || null, image: t.image || '', ...(platform === 'faceit' ? { competitionType: t.competitionType || 'championship' } : {}) });
        const btn = e.currentTarget; btn.textContent = 'Added ✓'; setTimeout(() => { btn.textContent = '+ My Events'; }, 1400);
      });
      card.querySelector('.ev-card-live')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (platform === 'faceit') send('load_faceit_event', { id: t.slug, competitionType: t.competitionType || 'championship' });
        else send(platform === 'challonge' ? 'load_challonge_tournament' : 'load_nxgen_event', { slug: t.slug });
        evStatus(`Loading "${t.name}" live…`);
      });
    }
    grid.appendChild(card);
  });
}
async function evOpenDetail(slug) {
  // Show the locally-cached detail instantly (great for past events), then refresh from the API.
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('ne_tourn_detail_' + slug) || 'null'); } catch (e) {}
  if (cached && cached.detail) { _evDetail = cached.detail; renderEventDetail(cached.detail); evStatus('Refreshing…'); }
  else evStatus('Loading tournament…');
  try {
    const data = await evPost('/tournament-detail', { slug });
    _evDetail = data.detail;
    renderEventDetail(data.detail);
    try { localStorage.setItem('ne_tourn_detail_' + slug, JSON.stringify({ detail: data.detail, at: Date.now() })); } catch (e) {}
    evStatus('');
  } catch (e) { if (!cached) evStatus(e.message || 'Failed to load tournament.', 'err'); else evStatus(''); }
}
let _evTeams = [];            // teams (with players) of the currently-selected event
let _evTeamsCache = {};       // eventSlug → teams (avoid refetching)
let _evSelSlug = '';          // selected event slug
let _evSelName = '';          // selected event name (→ Teams to Watch subtitle)
const _evEsc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;');
function renderEventDetail(d) {
  _evDetail = d;
  const grid = el('ev-grid'); if (grid) grid.style.display = 'none';
  const sec = el('ev-detail-section'); if (sec) sec.style.display = '';
  el('ev-detail-name').textContent = d.name || '';
  const s = d.summary || {};
  // Hero
  const logo = el('ev-hero-logo'); if (logo) { logo.innerHTML = ''; if (d.image) { const i = document.createElement('img'); i.src = d.image; i.alt = ''; logo.appendChild(i); } else logo.textContent = (d.name || '?').slice(0, 1).toUpperCase(); }
  const bg = el('ev-hero-bg'); if (bg) bg.style.backgroundImage = d.image ? `url("${d.image}")` : 'none';
  const dateRange = [fmtEvDate(s.startAt), fmtEvDate(s.endAt)].filter(Boolean).join(' – ');
  const meta = el('ev-hero-meta'); if (meta) meta.textContent = [dateRange, d.location, (s.attendees || 0) + ' attendees'].filter(Boolean).join('  ·  ');
  const games = el('ev-hero-games'); if (games) games.innerHTML = (d.games || []).map((g) => `<span class="ev-game-chip">${_evEsc(g)}</span>`).join('');
  const sgg = el('ev-hero-startgg'); if (sgg) sgg.href = 'https://www.start.gg/' + (d.slug || '');
  // Stat cards
  const stats = [
    ['Attendees', s.attendees || 0], ['Events', s.eventCount || 0],
    ['Total entrants', s.totalEntrants || 0], ['Unique players', s.uniquePlayers || 0],
    ['Games', s.gameCount || 0], ['Dates', dateRange || '—'],
  ];
  const sg = el('ev-stat-grid'); sg.innerHTML = '';
  stats.forEach(([k, v]) => {
    const cell = document.createElement('div'); cell.className = 'ev-stat';
    cell.innerHTML = '<div class="ev-stat-v"></div><div class="ev-stat-k"></div>';
    cell.querySelector('.ev-stat-v').textContent = v;
    cell.querySelector('.ev-stat-k').textContent = k;
    sg.appendChild(cell);
  });
  // Events — clickable cards (select → load teams) with quick actions
  el('ev-events-count').textContent = (d.events || []).length;
  const ev = el('ev-events-list'); ev.innerHTML = '';
  (d.events || []).forEach((e) => {
    const row = document.createElement('div'); row.className = 'ev-event-row'; row.dataset.slug = e.slug;
    row.innerHTML = '<div class="ev-event-info"><div class="ev-event-name"></div><div class="ev-event-sub"></div></div>'
      + '<div class="ev-event-acts"><button class="btn btn-secondary btn-sm ev-add-my" title="Save this event to My Events (live sync + seeding)">+ My Events</button>'
      + '<button class="btn btn-primary btn-sm ev-activate" title="Import all teams + load the bracket and make this the live broadcast event">Set live</button></div>';
    row.querySelector('.ev-event-name').textContent = e.name;
    row.querySelector('.ev-event-sub').textContent = [e.game, (e.numEntrants || 0) + ' teams', e.state].filter(Boolean).join(' · ');
    row.querySelector('.ev-activate').addEventListener('click', (cev) => { cev.stopPropagation(); evActivateEvent(d, e); });
    row.querySelector('.ev-add-my').addEventListener('click', (clickEv) => {
      clickEv.stopPropagation();
      send('add_my_event', { eventSlug: e.slug, tournamentSlug: d.slug || '', name: e.name, tournamentName: d.name || '', game: e.game || '', numEntrants: e.numEntrants || 0, startAt: e.startAt || null, image: d.image || '' });
      const btn = clickEv.currentTarget; btn.textContent = 'Added ✓'; setTimeout(() => { btn.textContent = '+ My Events'; }, 1400);
    });
    row.addEventListener('click', () => evSelectEvent(e));
    ev.appendChild(row);
  });
  // Auto-select the first (or biggest) event so its teams show immediately.
  const first = (d.events || []).slice().sort((a, b) => (b.numEntrants || 0) - (a.numEntrants || 0))[0];
  if (first) evSelectEvent(first); else { _evTeams = []; renderEventTeams(''); }
  el('ev-sponsor-text').textContent = buildSponsorSummary(d);
}
// Select an event → highlight it + load its teams (with players) into the right column.
async function evSelectEvent(e) {
  _evSelSlug = e.slug; _evSelName = e.name || '';
  document.querySelectorAll('#ev-events-list .ev-event-row').forEach((r) => r.classList.toggle('is-sel', r.dataset.slug === e.slug));
  const title = el('ev-teams-title'); if (title) title.textContent = 'Teams · ' + (e.name || '');
  if (_evTeamsCache[e.slug]) { _evTeams = _evTeamsCache[e.slug]; renderEventTeams(el('ev-players-filter')?.value || ''); return; }
  _evTeams = []; renderEventTeams('', true);   // loading
  try {
    const r = await fetch(EV_API + '/event-seeding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventSlug: e.slug }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    _evTeams = (data.entrants || []).map((t) => ({ entrantId: t.entrantId, name: t.name, seedNum: t.seedNum, players: (t.players || []).map((p) => p.gamerTag).filter(Boolean) }));
    _evTeamsCache[e.slug] = _evTeams;
    if (_evSelSlug === e.slug) renderEventTeams(el('ev-players-filter')?.value || '');
  } catch (err) {
    if (_evSelSlug === e.slug) { const list = el('ev-players-list'); if (list) list.innerHTML = `<div class="ev-empty">Couldn't load teams: ${_evEsc(err.message)}</div>`; }
  }
}
// Render the selected event's teams as readable cards, each with its players. Searchable.
function renderEventTeams(filter, loading) {
  const list = el('ev-players-list'); if (!list) return;
  if (loading) { list.innerHTML = '<div class="ev-empty">Loading teams…</div>'; el('ev-players-count').textContent = ''; return; }
  const f = (filter || '').trim();
  const shown = NESearch.filter(_evTeams, f, (t) => [{ text: t.name, weight: 2 }].concat(t.players || []));
  el('ev-players-count').textContent = _evTeams.length ? _evTeams.length + ' teams · ' + _evTeams.reduce((n, t) => n + (t.players || []).length, 0) + ' players' : '';
  list.innerHTML = '';
  if (!shown.length) { list.innerHTML = `<div class="ev-empty">${_evTeams.length ? 'No teams match.' : 'No teams listed for this event yet.'}</div>`; return; }
  shown.forEach((t) => {
    const card = document.createElement('div'); card.className = 'ev-team-card';
    const players = (t.players || []).length
      ? `<div class="ev-team-players">${(t.players || []).map((p) => `<span class="ev-team-player">${_evEsc(p)}</span>`).join('')}</div>`
      : '<div class="ev-team-players ev-team-noplayers">—</div>';
    const marked = (currentState.watchlist && currentState.watchlist.teams || []).some((x) => (x.name || '').toLowerCase() === (t.name || '').toLowerCase());
    card.innerHTML = `<div class="ev-team-head">${t.seedNum ? `<span class="ev-team-seed" title="Current start.gg seed">${t.seedNum}</span>` : ''}<span class="ev-team-name">${_evEsc(t.name) || '(unnamed)'}</span><span class="ev-team-count">${(t.players || []).length}</span>`
      + `<button class="ev-team-star${marked ? ' is-on' : ''}" title="Feature in Teams to Watch">★</button></div>${players}`;
    card.querySelector('.ev-team-star').addEventListener('click', function () {
      const on = this.classList.toggle('is-on');   // optimistic
      send('toggle_watchlist_team', { team: { name: t.name, players: t.players || [], entrantId: t.entrantId || '', eventSlug: _evSelSlug }, event: _evSelName });
      evStatus(on ? `Added "${t.name}" to Teams to Watch.` : `Removed "${t.name}" from Teams to Watch.`, 'ok');
    });
    list.appendChild(card);
  });
}
function buildSponsorSummary(d) {
  const s = d.summary || {};
  return [
    d.name,
    d.location ? 'Location: ' + d.location : null,
    'Dates: ' + ([fmtEvDate(s.startAt), fmtEvDate(s.endAt)].filter(Boolean).join(' – ') || '—'),
    'Attendees: ' + (s.attendees || 0),
    'Events: ' + (s.eventCount || 0) + ' (' + (s.totalEntrants || 0) + ' total entrants)',
    'Unique players listed: ' + (s.uniquePlayers || 0),
    'Games: ' + ((s.games || []).join(', ') || '—'),
    'start.gg: https://www.start.gg/' + (d.slug || ''),
  ].filter((x) => x != null).join('\n');
}
function evActivateEvent(d, e) {
  send('activate_startgg_event', { tournamentSlug: d.slug, eventSlug: e.slug, name: e.name, tournamentName: d.name });
  evStatus(`Activating "${e.name}" — importing teams + bracket and making it the live event…`, 'ok');
}
// ── Import Teams modal (↓ Import button on Teams topbar) ──────────────────
(function () {
  const modal = el('teams-import-modal');
  function openImportModal(tab) {
    if (!modal) return;
    modal.classList.add('show');
    if (tab) switchImportTab(tab);
  }
  function closeImportModal() { modal?.classList.remove('show'); }

  function switchImportTab(tab) {
    modal?.querySelectorAll('.import-tab-btn').forEach((b) => {
      const active = b.dataset.importtab === tab;
      b.classList.toggle('active', active);
      b.style.borderBottomColor = active ? 'var(--cp-accent)' : 'transparent';
      b.style.color = active ? 'var(--text)' : 'var(--muted)';
    });
    const csvPane = el('import-tab-csv'), sggPane = el('import-tab-startgg'), jsonPane = el('import-tab-json');
    if (csvPane) csvPane.style.display = tab === 'csv' ? '' : 'none';
    if (jsonPane) jsonPane.style.display = tab === 'json' ? '' : 'none';
    if (sggPane) sggPane.style.display = tab === 'startgg' ? '' : 'none';
  }

  el('btn-teams-import')?.addEventListener('click', () => openImportModal('csv'));
  el('teams-import-modal-close')?.addEventListener('click', closeImportModal);
  modal?.addEventListener('mousedown', (e) => { if (e.target === modal) closeImportModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal?.classList.contains('show')) closeImportModal(); });

  modal?.querySelectorAll('.import-tab-btn').forEach((b) => {
    b.addEventListener('click', () => switchImportTab(b.dataset.importtab));
  });

  // CSV file status feedback
  el('teams-csv')?.addEventListener('change', () => {
    const st = el('teams-csv-status');
    if (st) { st.textContent = ''; }
  });
})();

// ── Export Teams as JSON (full backup — includes logos + player info) ───────
// CSV can't carry images, so the export is JSON: team name/colour/logo(base64) +
// each player's name/role/country/start.gg/6mans. Re-import via the Backup (JSON) tab.
el('btn-teams-export')?.addEventListener('click', () => {
  const teams = (currentState && currentState.savedTeams) || [];
  if (!teams.length) { showToast('No saved teams to export.', '#f59e0b'); return; }
  const out = teams.map((t) => ({
    name: t.name || '', color: t.color || '', logo: t.logo || null, favorite: !!t.favorite,
    players: (t.players || []).map((p) => ({ name: p.name || '', role: p.role || '', country: p.country || '', startgg: p.startgg || '', sixmans: p.sixmans || '' }))
  }));
  const payload = { app: 'NE Broadcast Suite', kind: 'teams-library', version: 1, exportedAt: new Date().toISOString(), teams: out };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'teams-library.json'; a.click();
  URL.revokeObjectURL(url);
  const withLogos = teams.filter((t) => t.logo).length;
  showToast(`Exported ${teams.length} team${teams.length !== 1 ? 's' : ''}${withLogos ? ` (${withLogos} with logos)` : ''}`, '#22c55e');
});

// Teams page — pull rosters straight from a start.gg event into the library.
function teamsStartggImport(slug) {
  const st = el('teams-startgg-status');
  if (!slug) { if (st) { st.textContent = 'Paste a start.gg event or tournament URL first.'; st.style.color = '#f56565'; } return; }
  send('import_startgg_teams', { eventSlug: slug });
  if (st) { st.textContent = 'Importing teams from start.gg…'; st.style.color = 'var(--muted)'; }
}
el('btn-teams-startgg-pull')?.addEventListener('click', () => {
  teamsStartggImport((el('teams-startgg-slug')?.value || '').trim());
});
el('btn-teams-use-current-event')?.addEventListener('click', () => {
  const sgg = (currentState && currentState.startgg) || {};
  const url = sgg.eventSlug
    ? 'https://www.start.gg/' + sgg.eventSlug
    : sgg.tournamentSlug
      ? 'https://www.start.gg/tournament/' + sgg.tournamentSlug
      : '';
  const inp = el('teams-startgg-slug');
  if (!url) { const st = el('teams-startgg-status'); if (st) { st.textContent = 'No start.gg event connected yet — configure one in Settings.'; st.style.color = '#f56565'; } return; }
  if (inp) inp.value = url;
  teamsStartggImport(url);
});

// ── Events sub-nav (start.gg | Leagues) ───────────────────────────────────
function evShowSubtab(t) {
  // Not a panel — a deep-link out to Production ▸ Graphics ▸ Bracket. Leave the current panel and
  // the saved sub-tab untouched so coming back to ESPORTS lands where the producer actually was.
  if (t === 'buildbracket') { if (typeof openBracketBuilder === 'function') openBracketBuilder(); return; }
  document.querySelectorAll('#ev-subnav .ev-subnav-btn').forEach((x) => x.classList.toggle('active', x.dataset.evtab === t));
  const sg = el('ev-startgg-panel'), lg = el('ev-leagues-panel'), me = el('ev-myevents-panel'), sd = el('ev-seeding-panel');
  if (sg) sg.style.display = t === 'startgg' ? '' : 'none';
  if (lg) lg.style.display = t === 'leagues' ? '' : 'none';
  if (me) me.style.display = t === 'myevents' ? '' : 'none';
  if (sd) sd.style.display = t === 'seeding' ? '' : 'none';
  if (t === 'leagues') lgRender();
  if (t === 'myevents') { renderMyEvents(); evRefreshAllOnOpen(); }
  // Land on the event picker; openSeedingStudio() re-shows the studio right after when seeding a specific event.
  if (t === 'seeding') { seedShowStudio(false); renderSeedPicker(); evRefreshAllOnOpen(); }
  try { localStorage.setItem('ev_active_subtab', t); } catch (_) {}
}
document.querySelectorAll('#ev-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', function () { evShowSubtab(this.dataset.evtab); }));

// Show the "Tournaments" (platform import) tab only when a start.gg / Challonge / NXGEN credential
// actually exists. Organisers who run their own competitions never sign into a platform, and a dead
// search box as the first thing on the page reads as "this app needs start.gg" — it doesn't. Re-run
// on every state broadcast so the tab appears the moment a token is saved.
function evSyncPlatformTab() {
  const btn = document.querySelector('#ev-subnav .ev-subnav-btn[data-evtab="startgg"]');
  if (!btn) return;
  // `currentState` is a top-level `let` in core.js — shared global lexical scope, NOT window.*.
  const s = currentState || {};
  const any = !!(s.startgg?.hasToken || s.challonge?.hasKey || s.nxgen?.hasKey || s.faceit?.hasKey);
  btn.hidden = !any;
  // If the producer was parked on Tournaments and the credential went away, don't strand them.
  if (!any && btn.classList.contains('active')) evShowSubtab('leagues');
}
window.evSyncPlatformTab = evSyncPlatformTab;
// Reopen whichever Events sub-tab the producer was last on — survives refresh. Guarded against a
// saved tab whose button no longer exists (e.g. 'brackets'/'spotlight' get pruned from this nav).
// Deferred to a macrotask: evShowSubtab() reaches into lgRender()/renderMyEvents()/
// evRefreshAllOnOpen()/seedShowStudio()/renderSeedPicker() — calling those synchronously here
// risks the same TDZ crash documented for switchRole('monitor')/loadScenePreviews if any transitively
// touch a `let`/`const` declared further down. setTimeout(...,0) waits for the script to finish.
setTimeout(() => {
  evSyncPlatformTab();
  let saved; try { saved = localStorage.getItem('ev_active_subtab'); } catch (_) {}
  const usable = saved && document.querySelector(`#ev-subnav .ev-subnav-btn[data-evtab="${saved}"]:not([hidden])`);
  // Always land on SOMETHING: every panel is display:none in the markup, so without this a fresh
  // install (no saved tab) would render an empty page. 'leagues' is the native-first default.
  evShowSubtab(usable ? saved : 'leagues');
}, 0);

// Relative "x ago" for sync timestamps.
function evAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s < 10 ? 'just now' : s + 's ago';
  const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
function evSyncBadge(ev) {
  if (ev.syncError) return `<span class="me-sync me-sync-err" title="${(ev.syncError || '').replace(/"/g, '')}">sync failed</span>`;
  if (ev.lastSync) return `<span class="me-sync" title="Auto-syncs from start.gg every ~3 min">● synced ${evAgo(ev.lastSync)}</span>`;
  return `<span class="me-sync me-sync-wait">● awaiting sync…</span>`;
}
// Event logo (start.gg image) shown left of My Events / seeding cards; letter fallback otherwise.
function evCardLogo(ev) {
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return ev.image
    ? `<div class="me-logo"><img src="${esc(ev.image)}" alt="" loading="lazy"></div>`
    : `<div class="me-logo me-logo-empty">${esc((ev.name || '?').slice(0, 1).toUpperCase())}</div>`;
}
// Throttle client-triggered "refresh all" so toggling tabs doesn't hammer start.gg.
let _evRefreshAt = 0;
function evRefreshAllOnOpen() {
  if (!(currentState.myEvents || []).length) return;
  if (Date.now() - _evRefreshAt < 60000) return;   // at most once / min from the client
  _evRefreshAt = Date.now();
  send('refresh_my_event', {});   // server force-refreshes every My Event
}
// ── MY EVENTS — saved start.gg events with quick actions + live sync ──────
function renderMyEvents() {
  const list = el('my-events-list'); if (!list) return;
  const empty = el('my-events-empty');
  const events = currentState.myEvents || [];
  if (empty) empty.style.display = events.length ? 'none' : '';
  list.innerHTML = '';
  const esc = (s) => (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  events.forEach((ev) => {
    const platform = ev.platform || 'startgg';   // older saved entries have no field — they're start.gg
    const card = document.createElement('div'); card.className = 'my-event-card';
    const rosterN = Array.isArray(ev.roster) ? ev.roster.length : (ev.numEntrants || 0);
    const sub = [ev.game, rosterN ? rosterN + ' teams' : '', ev.tournamentName].filter(Boolean).join(' · ');
    const isLive = platform === 'challonge' ? (currentState.challonge && currentState.challonge.tournamentSlug) === ev.platformSlug
      : platform === 'nxgen' ? (currentState.nxgen && currentState.nxgen.eventSlug) === ev.platformSlug
      : platform === 'faceit' ? (currentState.faceit && currentState.faceit.competitionId) === ev.platformSlug
      : platform === 'manual' ? false
      : (currentState.startgg && currentState.startgg.eventSlug) === ev.eventSlug;
    const ME_SRC = { challonge: 'Challonge', nxgen: 'NXGEN', faceit: 'FACEIT', manual: 'Manual' };
    const srcBadge = platform !== 'startgg' ? ` <span class="me-src-badge">${ME_SRC[platform] || 'Manual'}</span>` : '';
    const metaText = platform === 'startgg' ? evSyncBadge(ev) : platform === 'manual' ? 'Manual entry — no platform to sync from.' : 'No auto-sync for this platform yet — refresh manually as needed.';
    card.innerHTML = evCardLogo(ev) + `<div class="me-info"><div class="me-name">${esc(ev.name || 'Event')}${srcBadge}${isLive ? ' <span class="me-live">LIVE</span>' : ''}</div>`
      + `<div class="me-sub">${esc(sub)}</div><div class="me-meta">${metaText}</div></div>`;
    const acts = document.createElement('div'); acts.className = 'me-acts';
    const mk = (cls, label, fn, title) => { const b = document.createElement('button'); b.className = cls; b.innerHTML = label; if (title) b.title = title; b.addEventListener('click', fn); return b; };
    // "Set live" activates a platform's bracket/queue — nothing to activate for a manual entry.
    if (platform !== 'manual') {
      acts.appendChild(mk('btn btn-primary btn-sm', isLive ? 'Reload' : 'Set live', () => {
        if (platform === 'challonge') send('load_challonge_tournament', { slug: ev.platformSlug });
        else if (platform === 'nxgen') send('load_nxgen_event', { slug: ev.platformSlug });
        else if (platform === 'faceit') send('load_faceit_event', { id: ev.platformSlug, competitionType: ev.competitionType || 'championship' });
        else send('activate_startgg_event', { eventSlug: ev.eventSlug, tournamentSlug: ev.tournamentSlug });
      }, 'Make this the broadcast event — imports teams + bracket + queue'));
    }
    acts.appendChild(mk('btn btn-secondary btn-sm', 'Seeding', () => openSeedingStudio(ev), 'Open the seeding studio for this event — add teams by hand here'));
    // Replaces the removed ESPORTS-level "Bracket Builder" tab: build the bracket from the event
    // it belongs to. Manual entries need this most — they have no platform bracket to import.
    acts.appendChild(mk('btn btn-secondary btn-sm', 'Bracket', () => { if (typeof window.openBracketBuilder === 'function') window.openBracketBuilder(); },
      'Open the bracket builder — phases, pools, double elimination and swiss'));
    if (platform === 'startgg') {
      acts.appendChild(mk('btn btn-secondary btn-sm', 'Pre-load teams', () => send('import_startgg_teams', { eventSlug: ev.eventSlug }), 'Import this event\'s entrants into your team library'));
      const refr = mk('btn btn-ghost btn-sm', '↻', () => { refr.disabled = true; refr.textContent = '…'; send('refresh_my_event', { id: ev.id }); setTimeout(() => { refr.disabled = false; refr.innerHTML = '↻'; }, 2500); }, 'Refresh this event from the platform now');
      acts.appendChild(refr);
      acts.appendChild(mk('btn btn-ghost btn-sm', 'View event ↗', () => window.open('https://www.start.gg/' + ev.eventSlug, '_blank', 'noopener'), 'Open on platform'));
    } else if (platform === 'challonge') {
      acts.appendChild(mk('btn btn-secondary btn-sm', 'Pre-load teams', () => send('import_challonge_teams', { slug: ev.platformSlug }), 'Import this tournament\'s participants into your team library'));
      acts.appendChild(mk('btn btn-ghost btn-sm', 'View event ↗', () => window.open('https://challonge.com/' + ev.platformSlug, '_blank', 'noopener'), 'Open on platform'));
    } else if (platform === 'faceit') {
      acts.appendChild(mk('btn btn-ghost btn-sm', 'View event ↗', () => window.open(
        (ev.competitionType === 'hub' ? 'https://www.faceit.com/en/hub/' : 'https://www.faceit.com/en/championship/') + ev.platformSlug,
        '_blank', 'noopener'), 'Open on platform'));
    } else if (platform === 'manual' && ev.url) {
      acts.appendChild(mk('btn btn-ghost btn-sm', 'View event ↗', () => window.open(ev.url, '_blank', 'noopener'), 'Open the link you saved for this event'));
    }
    // NXGEN has no standalone "import by slug" or confirmed public tournament URL yet — Set
    // live/Seeding above still work; those two extra actions are start.gg/Challonge-only for now.

    // Platform-linking sub-row (push a start.gg event to a Challonge mirror for live score sync) —
    // only meaningful for a start.gg-sourced event; doesn't apply to an already-Challonge/NXGEN one.
    let linkRow = null;
    if (platform === 'startgg') {
      linkRow = document.createElement('div'); linkRow.className = 'me-linking';
      const isSynced = !!(ev.challongeSync && ev.challongeSync.slug);
      linkRow.style.display = isSynced ? 'flex' : 'none';   // auto-open when already linked
      const gear = mk('btn btn-ghost btn-sm me-gear', '⚙ Link platform', () => {
        const show = linkRow.style.display === 'none';
        linkRow.style.display = show ? 'flex' : 'none';
        gear.classList.toggle('is-on', show);
      }, 'Link / sync this event to another platform (Challonge)');
      gear.classList.toggle('is-on', isSynced);
      acts.appendChild(gear);

      linkRow.appendChild(mk('btn btn-blue btn-sm', 'Push / Sync to Challonge', () => openEvSyncModal(ev),
        'Full workflow: download start.gg data, map players via CSV, create/select a Challonge event, push seeding, keep scores synced live'));
      linkRow.appendChild(mk('btn btn-ghost btn-sm', 'Link existing', () => openChalLinkModal(ev), 'Link an existing Challonge tournament for real-time score sync'));
      if (isSynced) {
        const linkBadge = document.createElement('span');
        linkBadge.style.cssText = 'font-size:10px;padding:2px 7px;border-radius:3px;background:rgba(16,185,129,.15);color:#86efac;white-space:nowrap;cursor:default;align-self:center;';
        const errMark = ev.challongeSync.lastError ? ' !' : (ev.challongeSync.enabled ? '' : ' (paused)');
        linkBadge.textContent = `Synced: ${ev.challongeSync.slug}${errMark}`;
        if (ev.challongeSync.lastError) linkBadge.title = ev.challongeSync.lastError;
        linkRow.appendChild(linkBadge);
        const unlink = mk('btn btn-ghost btn-sm', 'Unlink', () => {
          if (unlink.dataset.armed) { send('unlink_event_challonge', { eventId: ev.id }); return; }
          unlink.dataset.armed = '1'; unlink.textContent = 'Confirm?'; setTimeout(() => { delete unlink.dataset.armed; unlink.textContent = 'Unlink'; }, 2400);
        }, 'Remove the real-time Challonge sync link for this event');
        linkRow.appendChild(unlink);
      }
    }

    const del = mk('btn btn-ghost btn-sm me-del', '✕', () => {
      if (del.dataset.armed) { send('remove_my_event', { id: ev.id }); return; }
      del.dataset.armed = '1'; del.textContent = 'Remove?'; setTimeout(() => { del.removeAttribute('data-armed'); del.textContent = '✕'; }, 2600);
    }, 'Remove from My Events');
    acts.appendChild(del);

    card.appendChild(acts);
    if (linkRow) card.appendChild(linkRow);
    list.appendChild(card);
  });
}
// Manual "+ Add Event" — a My Event with no platform behind it (a LAN, a one-off, anything not on
// start.gg/Challonge/NXGEN). No "Set live"/pre-load/auto-sync since there's no API to pull from;
// it's a plain reference you seed and manage by hand (Seeding tab already supports manual entry).
let _meAddLogo = '';
function meAddResetForm() {
  ['me-add-name', 'me-add-tournament', 'me-add-date', 'me-add-entrants', 'me-add-url'].forEach((id) => { const e = el(id); if (e) e.value = ''; });
  const g = el('me-add-game'); if (g) g.value = '';
  _meAddLogo = '';
  const lp = el('me-add-logo-preview'), le = el('me-add-logo-empty');
  if (lp) { lp.style.display = 'none'; lp.removeAttribute('src'); }
  if (le) le.style.display = '';
}
// Event-day checklist links — jump straight to the Talent / Profiles pages.
el('ed-checklist-talent')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('tab-equipos')?.click();
});
el('ed-checklist-brand')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('tab-media')?.click();
  setTimeout(() => { if (typeof window._assetsShow === 'function') window._assetsShow('profiles'); }, 60);
});
el('me-add-btn')?.addEventListener('click', () => {
  const form = el('me-add-form'); if (!form) return;
  const show = form.style.display === 'none';
  form.style.display = show ? '' : 'none';
  if (show) { const g = el('me-add-game'); if (g) lgGameOptions(g); el('me-add-name')?.focus(); }
});
el('me-add-cancel')?.addEventListener('click', () => {
  const form = el('me-add-form'); if (form) form.style.display = 'none';
  meAddResetForm();
});
el('me-add-logo-preview')?.addEventListener('click', () => el('me-add-logo-file')?.click());
el('me-add-logo-empty')?.addEventListener('click', () => el('me-add-logo-file')?.click());
el('me-add-logo-clear')?.addEventListener('click', () => {
  _meAddLogo = '';
  const lp = el('me-add-logo-preview'), le = el('me-add-logo-empty');
  if (lp) { lp.style.display = 'none'; lp.removeAttribute('src'); }
  if (le) le.style.display = '';
});
el('me-add-logo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; this.value = ''; if (!f) return;
  try {
    _meAddLogo = await fileToBase64(f, 400);
    const lp = el('me-add-logo-preview'), le = el('me-add-logo-empty');
    if (lp) { lp.src = _meAddLogo; lp.style.display = ''; }
    if (le) le.style.display = 'none';
  } catch (e) { evStatus('Could not load logo.', 'err'); }
});
el('me-add-save')?.addEventListener('click', () => {
  const name = (el('me-add-name')?.value || '').trim();
  if (!name) { evStatus('Enter an event name.', 'err'); return; }
  const tournamentName = (el('me-add-tournament')?.value || '').trim();
  const game = el('me-add-game')?.value || '';
  const dateVal = el('me-add-date')?.value || '';
  const startAt = dateVal ? Math.floor(new Date(dateVal + 'T00:00:00').getTime() / 1000) : null;
  const numEntrants = Number(el('me-add-entrants')?.value) || 0;
  const url = (el('me-add-url')?.value || '').trim();
  send('add_my_event', {
    platform: 'manual', platformSlug: 'manual-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name, tournamentName, game, startAt, numEntrants, image: _meAddLogo, url,
  });
  el('me-add-form') && (el('me-add-form').style.display = 'none');
  meAddResetForm();
  evStatus(`Added "${name}" to MY EVENTS.`, 'ok');
});
// ── Cross-Platform Event Sync Modal ───────────────────────────────────────────

let _evSyncEvent = null;             // My Event being synced
let _evSyncMappings = {};            // name.toLowerCase() → challongeUsername from CSV upload
let _evSyncParticipants = [];        // resolved participant list (shown in preview)
let _evSyncChalTournaments = null;   // cached Challonge tournament list for the existing picker
let _evSyncChalSearchTimer = null;
let _evSyncLinkedSlug = '';          // slug selected from the existing-tournament picker

function openEvSyncModal(ev) {
  _evSyncEvent = ev;
  _evSyncMappings = {};
  _evSyncChalTournaments = null; // force fresh tournament list on open
  _evSyncLinkedSlug = (ev.challongeSync && ev.challongeSync.slug) || '';

  // Resolve participants from seeding studio data or roster
  _evSyncParticipants = resolveEvSyncParticipants(ev);

  // Pre-fill fields from event data
  const nameInp = el('ev-sync-t-name');
  const slugInp = el('ev-sync-t-slug');
  const gameInp = el('ev-sync-t-game');
  const titleEl = el('ev-sync-modal-title');

  if (titleEl) titleEl.textContent = `Push "${ev.name || 'Event'}" to Platform`;
  if (nameInp) nameInp.value = ev.name || '';
  if (slugInp) {
    const autoSlug = (ev.name || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 55);
    slugInp.value = autoSlug;
    evSyncUpdateSlugPreview(autoSlug);
  }
  if (gameInp) gameInp.value = ev.game || '';

  // Source info bar
  const srcEl = el('ev-sync-source-info');
  if (srcEl) {
    const n = _evSyncParticipants.length;
    const seeded = _evSyncParticipants.filter(p => p.seed).length;
    srcEl.innerHTML = `<strong style="color:var(--fg);">${escapeHtml(ev.name || '')}</strong>&nbsp;·&nbsp;start.gg&nbsp;·&nbsp;${n} participant${n !== 1 ? 's' : ''}${seeded ? `&nbsp;·&nbsp;${seeded} seeded` : ''}`;
  }

  // Select mode: switch to "existing" if this event already has a Challonge link
  if (_evSyncLinkedSlug) {
    const modeExisting = el('ev-sync-mode-existing');
    if (modeExisting) { modeExisting.checked = true; evSyncToggleMode('existing'); }
    // Pre-fill picker with the existing link
    const chalSearch = el('ev-sync-chal-search');
    if (chalSearch) chalSearch.value = _evSyncLinkedSlug;
    const chalClear = el('ev-sync-chal-clear');
    if (chalClear) chalClear.style.display = 'block';
    const selDiv = el('ev-sync-chal-selected');
    if (selDiv) {
      const sync = ev.challongeSync || {};
      const lastSync = sync.lastSyncAt ? ` · Last sync: ${new Date(sync.lastSyncAt).toLocaleTimeString()}` : '';
      const errPart = sync.lastError ? ` · Error: ${escapeHtml(sync.lastError)}` : '';
      selDiv.innerHTML = `Linked: <strong style="color:var(--fg);">challonge.com/${escapeHtml(_evSyncLinkedSlug)}</strong>${lastSync}${errPart}`;
      selDiv.style.display = '';
    }
    const autoSync = el('ev-sync-autosync');
    if (autoSync) autoSync.checked = !!(ev.challongeSync && ev.challongeSync.enabled);
  } else {
    const modeCreate = el('ev-sync-mode-create');
    if (modeCreate) { modeCreate.checked = true; evSyncToggleMode('create'); }
    const chalSearch = el('ev-sync-chal-search');
    if (chalSearch) chalSearch.value = '';
    const selDiv = el('ev-sync-chal-selected');
    if (selDiv) selDiv.style.display = 'none';
    const chalClear = el('ev-sync-chal-clear');
    if (chalClear) chalClear.style.display = 'none';
  }

  // Clear CSV status + log
  const csvSt = el('ev-sync-csv-status'); if (csvSt) csvSt.textContent = '';
  const logEl = el('ev-sync-log'); if (logEl) logEl.textContent = '';

  evSyncRenderPreview();
  el('ev-sync-modal').removeAttribute('hidden');
}

function resolveEvSyncParticipants(ev) {
  // Try seeding studio data first (has seedNum)
  const seedEntrants = ev.seeding && Array.isArray(ev.seeding.entrants) ? ev.seeding.entrants : [];
  if (seedEntrants.length > 0) {
    return seedEntrants
      .slice()
      .sort((a, b) => (a.seedNum || 9999) - (b.seedNum || 9999))
      .map((e, i) => ({
        name: e.name || '',
        seed: e.seedNum || (i + 1),
        players: (e.players || []).map(p => p.gamerTag).filter(Boolean)
      }));
  }
  // Fall back to roster
  const roster = Array.isArray(ev.roster) ? ev.roster : [];
  if (roster.length > 0) {
    return roster.map((t, i) => ({
      name: t.name || t.teamName || '',
      seed: i + 1,
      players: Array.isArray(t.players) ? t.players.map(p => p.gamerTag || p.name).filter(Boolean) : []
    }));
  }
  return [];
}

function evSyncToggleMode(mode) {
  const createFields   = el('ev-sync-create-fields');
  const existingFields = el('ev-sync-existing-fields');
  if (createFields)   createFields.style.display   = mode === 'create'   ? '' : 'none';
  if (existingFields) existingFields.style.display  = mode === 'existing' ? '' : 'none';
}

function evSyncUpdateSlugPreview(raw) {
  const clean = (raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
  const prev = el('ev-sync-slug-preview'); if (prev) prev.textContent = clean || '…';
}

function evSyncRenderPreview() {
  const label = el('ev-sync-preview-label');
  const container = el('ev-sync-preview');
  if (!container) return;
  const list = _evSyncParticipants;
  if (label) label.textContent = `Participants (${list.length})`;
  if (!list.length) {
    container.innerHTML = '<div style="font-size:12px; color:var(--muted); padding:6px;">No participants found — open Seeding or Pre-load Teams first to populate the list.</div>';
    return;
  }
  container.innerHTML = list.map((p, i) => {
    const mapped = _evSyncMappings[(p.name || '').toLowerCase()];
    const sub = p.players.length ? `<span style="color:var(--muted);">${p.players.slice(0,3).map(escapeHtml).join(', ')}${p.players.length>3?'…':''}</span>` : '';
    const userBadge = mapped ? `<span style="font-size:10px; padding:1px 6px; border-radius:3px; background:rgba(74,222,128,.15); color:#86efac; flex-shrink:0;">@${escapeHtml(mapped)}</span>` : '';
    return `<div style="display:flex; align-items:center; gap:8px; padding:3px 6px; border-radius:4px; background:rgba(255,255,255,.025);">
      <span style="font-size:10px; color:var(--muted); width:22px; text-align:right; flex-shrink:0;">${p.seed}</span>
      <span style="flex:1; font-size:12px; font-weight:600;">${escapeHtml(p.name)}</span>
      ${sub}
      ${userBadge}
    </div>`;
  }).join('');
}

// CSV parsing for username mapping
function parseEvSyncCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return {};
  // Detect header
  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''));
  const nameIdx = header.findIndex(h => ['name','team','teamname','player','gamertag'].includes(h));
  const userIdx = header.findIndex(h => ['challonge_username','challongeusername','username','challonge'].includes(h));
  const map = {};
  const start = (nameIdx >= 0 && userIdx >= 0) ? 1 : 0; // skip header if detected
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    if (!cols.length || !cols[0]) continue;
    const ni = nameIdx >= 0 ? nameIdx : 0;
    const ui = userIdx >= 0 ? userIdx : 1;
    const name = (cols[ni] || '').trim();
    const username = (cols[ui] || '').trim();
    if (name && username) map[name.toLowerCase()] = username;
  }
  return map;
}

async function evSyncPush() {
  const logEl   = el('ev-sync-log');
  const pushBtn = el('ev-sync-push-btn');
  const setLog  = (msg, ok) => { if (logEl) { logEl.textContent = msg; logEl.style.color = ok === false ? '#f87171' : ok === true ? '#86efac' : 'var(--muted)'; } };

  const mode = document.querySelector('input[name="ev-sync-mode"]:checked')?.value || 'create';
  const startBracket = !!el('ev-sync-start-bracket')?.checked;

  if (!_evSyncParticipants.length) { setLog('No participants to push.', false); return; }
  if (!currentState.challonge?.hasKey) { setLog('Add your Challonge API key in Settings → Integrations first.', false); return; }

  if (pushBtn) { pushBtn.disabled = true; pushBtn.textContent = 'Pushing…'; }

  try {
    let slug;

    if (mode === 'create') {
      const name = (el('ev-sync-t-name')?.value || '').trim();
      const rawSlug = (el('ev-sync-t-slug')?.value || '').trim();
      const type = el('ev-sync-t-type')?.value || 'single elimination';
      const gameName = (el('ev-sync-t-game')?.value || '').trim();
      const isPrivate = !!el('ev-sync-t-private')?.checked;
      if (!name) throw new Error('Enter a tournament name.');
      if (!rawSlug) throw new Error('Enter a URL slug.');

      setLog('Creating tournament…', null);
      const cr = await fetch('http://127.0.0.1:3000/api/challonge/create-tournament', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug: rawSlug, tournamentType: type, gameName, private: isPrivate })
      }).then(r => r.json());
      if (!cr.ok) throw new Error(cr.error || 'Failed to create tournament');
      slug = cr.slug;
      setLog(`Tournament created: challonge.com/${slug}`, null);
    } else {
      // Use slug from the picker (preferred) or whatever is typed in the search input
      slug = _evSyncLinkedSlug || (el('ev-sync-chal-search')?.value || '').trim().replace(/^https?:\/\/[^/]*challonge\.com\//,'').replace(/\/$/, '');
      if (!slug) throw new Error('Select a tournament from the list first.');
    }

    const clearExisting = mode === 'existing' && !!el('ev-sync-clear-existing')?.checked;
    if (clearExisting) {
      // Wiping the Challonge-side roster is irreversible on their platform — make it explicit,
      // and never leave the checkbox armed for the next sync.
      const ok = await appConfirm('Delete ALL existing participants on the Challonge tournament before syncing? This wipes its current roster on challonge.com.', 'Wipe and sync');
      if (!ok) { setLog('Sync cancelled.', null); return; }
    }
    if (el('ev-sync-clear-existing')) el('ev-sync-clear-existing').checked = false;

    // Build participant payload with mappings
    const participants = _evSyncParticipants.map(p => ({
      name: p.name,
      seed: p.seed,
      challongeUsername: _evSyncMappings[(p.name || '').toLowerCase()] || null
    }));

    setLog(`Syncing ${participants.length} participants…`, null);
    // eventSlug lets the server override each seed with start.gg's TRUE bracket seed (initialSeedNum)
    // instead of trusting locally-cached roster/seeding-studio order, which can drift from what
    // actually produced the real bracket's bye placement.
    const sr = await fetch('http://127.0.0.1:3000/api/challonge/sync-participants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tournamentSlug: slug, participants, clearExisting, eventSlug: _evSyncEvent && _evSyncEvent.eventSlug })
    }).then(r => r.json());
    // The route reports the real reason in .message (a summary) and .errors (per-chunk detail) —
    // it never sets .error, so checking only sr.error silently discarded the actual cause.
    const syncErrText = sr.message || (Array.isArray(sr.errors) && sr.errors.join('; ')) || sr.error || '';
    // Re-pushing to a tournament that already has its bracket started fails to (re-)add
    // participants — expected, not fatal. But the EXISTING bracket may have been seeded wrong
    // (e.g. from before this fix), producing a different shape than start.gg's real bracket, which
    // would silently block every result from matching. So actively REPAIR it: reset, re-apply the
    // true seed to every participant, and regenerate — rather than just skipping past the problem.
    const alreadySetUp = /no longer be added|already been taken|already exist/i.test(syncErrText);
    if (!sr.ok && !sr.added && !alreadySetUp) throw new Error(syncErrText || 'Sync failed (no detail returned)');

    if (alreadySetUp && _evSyncEvent && _evSyncEvent.eventSlug) {
      setLog('Bracket already started — repairing seeds & regenerating to match start.gg…', null);
      const rb = await fetch('http://127.0.0.1:3000/api/challonge/rebuild-bracket', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentSlug: slug, eventSlug: _evSyncEvent.eventSlug })
      }).then(r => r.json());
      if (!rb.ok) throw new Error(rb.error || 'Failed to rebuild bracket');
      setLog(rb.message || 'Bracket rebuilt.', null);
    } else if (startBracket) {
      setLog('Generating bracket…', null);
      const br = await fetch('http://127.0.0.1:3000/api/challonge/start-bracket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentSlug: slug })
      }).then(r => r.json());
      // "Already started" is likewise non-fatal here (e.g. an existing tournament whose bracket
      // was generated outside this app) — fall through to the results backfill either way.
      if (!br.ok && !/already.*start|state/i.test(br.error || '')) throw new Error(br.error || 'Failed to start bracket');
    }

    // Backfill any COMPLETED start.gg results onto the Challonge bracket. For a finished PAST
    // event this fills in the entire bracket in one shot; for a future/current event with nothing
    // played yet it's a harmless no-op (results then flow live via the auto-sync link below).
    let resultsPushed = 0, pushWarn = '';
    if (_evSyncEvent && _evSyncEvent.eventSlug) {
      setLog('Pulling match results from start.gg…', null);
      try {
        const pr = await fetch('http://127.0.0.1:3000/api/challonge/push-results', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tournamentSlug: slug, eventSlug: _evSyncEvent.eventSlug })
        }).then(r => r.json());
        if (pr.ok) {
          resultsPushed = pr.pushed || 0;
          if ((pr.unmatchedNames && pr.unmatchedNames.length) || (pr.unplaced && pr.unplaced.length)) pushWarn = pr.message || '';
        }
      } catch (e) { /* non-fatal — participants/bracket are already pushed */ }
    }

    // Link for live auto-sync. A freshly CREATED tournament is always linked (you built it to run it
    // live); for an EXISTING tournament, link only when the "keep synced" box is ticked.
    const autoSync = (mode === 'create') || (mode === 'existing' && !!el('ev-sync-autosync')?.checked);
    if (autoSync && _evSyncEvent && slug) {
      send('link_event_challonge', { eventId: _evSyncEvent.id, challongeSlug: slug, enabled: true });
    }

    const viewUrl = `https://challonge.com/${slug}`;
    const autoMsg = autoSync ? ' · Auto-sync enabled.' : '';
    const resMsg = resultsPushed ? ` · ${resultsPushed} result(s) filled in.` : '';
    const warnMsg = pushWarn ? ` — Heads up: ${pushWarn}` : '';
    setLog(`Done! ${sr.message || ''}${resMsg}${autoMsg}${warnMsg}`, pushWarn ? null : true);
    if (pushBtn) { pushBtn.textContent = 'View on Challonge ↗'; pushBtn.onclick = () => window.open(viewUrl, '_blank', 'noopener'); pushBtn.disabled = false; }
  } catch (e) {
    setLog(e.message, false);
    if (pushBtn) { pushBtn.disabled = false; pushBtn.textContent = 'Push to Challonge'; }
  }
}

// ── Challonge Link Modal — lightweight "just search, pick & link" ─────────────

let _chalLinkEvent = null;
let _chalLinkSlug = '';
let _chalLinkTournaments = null;
let _chalLinkSearchTimer = null;

function openChalLinkModal(ev) {
  _chalLinkEvent = ev;
  _chalLinkSlug = (ev.challongeSync && ev.challongeSync.slug) || '';
  _chalLinkTournaments = null;

  const titleEl = el('ev-chal-link-title');
  if (titleEl) titleEl.textContent = `Link Challonge: ${ev.name || 'Event'}`;

  const curDiv = el('ev-chal-link-current');
  if (curDiv) {
    if (_chalLinkSlug) { curDiv.textContent = `Currently linked: challonge.com/${_chalLinkSlug}`; curDiv.style.display = ''; }
    else curDiv.style.display = 'none';
  }

  const srch = el('ev-chal-link-search');
  if (srch) srch.value = '';
  const clr = el('ev-chal-link-clear');
  if (clr) clr.style.display = 'none';
  const res = el('ev-chal-link-results');
  if (res) res.style.display = 'none';
  const sel = el('ev-chal-link-selected');
  if (sel) sel.style.display = 'none';
  const logEl = el('ev-chal-link-log');
  if (logEl) logEl.textContent = '';
  const btn = el('ev-chal-link-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Link tournament'; }
  const commInp = el('ev-chal-link-community');
  if (commInp && !commInp.value) commInp.value = localStorage.getItem('ne_challonge_community') || '';

  el('ev-chal-link-modal').removeAttribute('hidden');
  setTimeout(() => el('ev-chal-link-search')?.focus(), 80);
}

function renderChalLinkDropdown(tournaments, filterQuery) {
  const container = el('ev-chal-link-results');
  if (!container) return;
  const filtered = NESearch.filter(tournaments, filterQuery,
    (t) => [{ text: t.name, weight: 2 }, t.slug, t.state]);
  if (!filtered.length) {
    container.innerHTML = filterQuery
      ? `<div class="ev-dropdown-msg">No match for "${escapeHtml(filterQuery)}"</div>`
      : '<div class="ev-dropdown-msg">No Challonge tournaments found.</div>';
    container.style.display = 'block';
    return;
  }
  container.innerHTML = '';
  filtered.forEach(t => {
    const row = document.createElement('div');
    row.className = 'ev-dropdown-row';
    row.innerHTML = _chalTournamentRowHtml(t);
    row.addEventListener('click', () => {
      const si = el('ev-chal-link-search');
      if (si) si.value = t.name || t.slug;
      const cb = el('ev-chal-link-clear');
      if (cb) cb.style.display = 'block';
      container.style.display = 'none';
      _chalLinkSlug = t.slug || '';
      const selDiv = el('ev-chal-link-selected');
      if (selDiv) {
        const pCount = t.participantsCount ? ` · ${t.participantsCount} participants` : '';
        const stLabel = t.state ? ` · ${t.state}` : '';
        selDiv.innerHTML = `<strong style="color:var(--fg);">challonge.com/${escapeHtml(_chalLinkSlug)}</strong>${pCount}${stLabel}`;
        selDiv.style.display = '';
      }
      const btn = el('ev-chal-link-btn');
      if (btn) btn.disabled = false;
    });
    container.appendChild(row);
  });
  container.style.display = 'block';
}

(function wireChalLinkModal() {
  ['ev-chal-link-close', 'ev-chal-link-cancel'].forEach(id => {
    el(id)?.addEventListener('click', () => el('ev-chal-link-modal').setAttribute('hidden', ''));
  });
  el('ev-chal-link-modal')?.addEventListener('click', e => {
    if (e.target === el('ev-chal-link-modal')) el('ev-chal-link-modal').setAttribute('hidden', '');
  });

  const searchInput = el('ev-chal-link-search');
  const resultsDiv  = el('ev-chal-link-results');
  const clearBtn    = el('ev-chal-link-clear');
  if (!searchInput || !resultsDiv) return;

  async function loadLinkTournaments() {
    resultsDiv.innerHTML = '<div class="ev-dropdown-msg">Loading your Challonge tournaments…</div>';
    resultsDiv.style.display = 'block';
    try {
      const community = (el('ev-chal-link-community')?.value || '').trim();
      if (community) localStorage.setItem('ne_challonge_community', community);
      const subdomains = community ? [community] : [];
      const resp = await fetch('http://127.0.0.1:3000/api/challonge/my-tournaments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subdomains }) });
      const data = await resp.json();
      _chalLinkTournaments = resp.ok ? (data.tournaments || []) : [];
      renderChalLinkDropdown(_chalLinkTournaments, '');
      if (data.subdomainErrors?.length) {
        const errEl = el('ev-chal-link-results');
        if (errEl) errEl.insertAdjacentHTML('beforeend', data.subdomainErrors.map(e => `<div class="ev-dropdown-msg" style="color:#f59e0b;">Community "${escapeHtml(e.subdomain)}": ${escapeHtml(e.error)}</div>`).join(''));
      }
    } catch (e) {
      _chalLinkTournaments = [];
      resultsDiv.innerHTML = `<div class="ev-dropdown-msg" style="color:#ef4444;">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  // Restore saved community from localStorage
  const savedComm = localStorage.getItem('ne_challonge_community') || '';
  if (savedComm) { const ci = el('ev-chal-link-community'); if (ci) ci.value = savedComm; }

  el('ev-chal-link-community-reload')?.addEventListener('click', () => {
    _chalLinkTournaments = null;
    loadLinkTournaments();
  });

  searchInput.addEventListener('focus', () => {
    if (!currentState.challonge?.hasKey) {
      resultsDiv.innerHTML = '<div class="ev-dropdown-msg" style="color:#f59e0b;">Add a Challonge API key in Integrations first.</div>';
      resultsDiv.style.display = 'block';
      return;
    }
    if (_chalLinkTournaments !== null) {
      renderChalLinkDropdown(_chalLinkTournaments, searchInput.value.trim().toLowerCase());
      resultsDiv.style.display = 'block';
      return;
    }
    loadLinkTournaments();
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
    clearTimeout(_chalLinkSearchTimer);
    _chalLinkSearchTimer = setTimeout(() => {
      if (_chalLinkTournaments !== null) renderChalLinkDropdown(_chalLinkTournaments, q.toLowerCase());
    }, 60);
  });

  if (clearBtn) clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    _chalLinkSlug = '';
    const selDiv = el('ev-chal-link-selected');
    if (selDiv) selDiv.style.display = 'none';
    const btn = el('ev-chal-link-btn');
    if (btn) btn.disabled = true;
    if (_chalLinkTournaments !== null) renderChalLinkDropdown(_chalLinkTournaments, '');
    searchInput.focus();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#ev-chal-link-wrap') && !e.target.closest('#ev-chal-link-results')) {
      resultsDiv.style.display = 'none';
    }
  }, true);

  el('ev-chal-link-btn')?.addEventListener('click', () => {
    const btn   = el('ev-chal-link-btn');
    const logEl = el('ev-chal-link-log');
    const setLog = (msg, ok) => { if (logEl) { logEl.textContent = msg; logEl.style.color = ok === false ? '#f87171' : ok ? '#86efac' : 'var(--muted)'; } };
    if (!_chalLinkSlug || !_chalLinkEvent) { setLog('Select a tournament first.', false); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Linking…'; }
    setLog('Building participant map…', null);
    // Use a one-shot listener so we know when this specific link-result comes back
    const onMsg = (e2) => {
      try {
        const m = JSON.parse(e2.data);
        if (m.type !== 'link-result') return;
        ws.removeEventListener('message', onMsg);
        if (m.data.ok && !m.data.loading) {
          setLog(m.data.message || 'Linked!', true);
          const curDiv = el('ev-chal-link-current');
          if (curDiv) { curDiv.textContent = `Linked: challonge.com/${_chalLinkSlug}`; curDiv.style.display = ''; }
          if (btn) { btn.textContent = 'Linked'; }
          setTimeout(() => el('ev-chal-link-modal').setAttribute('hidden', ''), 1200);
        } else if (!m.data.ok) {
          setLog(m.data.message || 'Failed.', false);
          if (btn) { btn.disabled = false; btn.textContent = 'Link tournament'; }
        }
      } catch {}
    };
    ws.addEventListener('message', onMsg);
    send('link_event_challonge', { eventId: _chalLinkEvent.id, challongeSlug: _chalLinkSlug, enabled: true });
  });
})();

function _chalTournamentRowHtml(t) {
  const stateColors = { underway: '#10b981', pending: '#f59e0b', ended: '#9ca3af' };
  const stateBg     = { underway: 'rgba(16,185,129,0.15)', pending: 'rgba(245,158,11,0.15)', ended: 'rgba(107,114,128,0.2)' };
  const sc  = stateColors[t.state] || '#9ca3af';
  const sbg = stateBg[t.state]    || 'rgba(107,114,128,0.2)';
  const meta = [
    t.type ? t.type.replace(/_/g, ' ') : '',
    t.gameName || '',
    t.participantsCount ? `${t.participantsCount} teams` : '',
    t.subdomain ? `${t.subdomain}/…` : '',
  ].filter(Boolean).map(escapeHtml).join(' · ');
  // Letter avatar: first alphanumeric character, skip symbols like [$
  const letter = (((t.name || t.slug || '').match(/[A-Za-z0-9]/) || ['?'])[0]).toUpperCase();
  let hash = 0;
  for (let i = 0; i < (t.name || '').length; i++) hash = ((hash << 5) - hash + (t.name || '').charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  const avBg  = `hsl(${hue},45%,22%)`;
  const avClr = `hsl(${hue},70%,72%)`;
  const avatarHtml = `<div class="ev-dropdown-logo-ph" style="background:${avBg};color:${avClr};font-size:15px;font-weight:700;">${escapeHtml(letter)}</div>`;
  const logoHtml = t.logo
    ? `<img class="ev-dropdown-logo" src="${escapeHtml(t.logo)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">${avatarHtml.replace('style="', 'style="display:none;')}`
    : avatarHtml;
  return `${logoHtml}<div class="ev-dropdown-info"><div class="ev-dropdown-name">${escapeHtml(t.name || t.slug || '')}</div><div class="ev-dropdown-meta">${meta}</div></div><span class="ev-dropdown-badge" style="background:${sbg};color:${sc};text-transform:capitalize;">${escapeHtml(t.state || '')}</span>`;
}

function renderEvSyncChalDropdown(tournaments, filterQuery) {
  const container = el('ev-sync-chal-results');
  if (!container) return;
  const filtered = NESearch.filter(tournaments, filterQuery,
    (t) => [{ text: t.name, weight: 2 }, t.slug, t.state]);
  if (!filtered.length) {
    container.innerHTML = filterQuery
      ? `<div class="ev-dropdown-msg">No match for "${escapeHtml(filterQuery)}"</div>`
      : '<div class="ev-dropdown-msg">No Challonge tournaments found.</div>';
    container.style.display = 'block';
    return;
  }
  container.innerHTML = '';
  filtered.forEach(t => {
    const row = document.createElement('div');
    row.className = 'ev-dropdown-row';
    row.innerHTML = _chalTournamentRowHtml(t);
    row.addEventListener('click', () => {
      const srch = el('ev-sync-chal-search');
      if (srch) srch.value = t.name || t.slug;
      const clr = el('ev-sync-chal-clear');
      if (clr) clr.style.display = 'block';
      container.style.display = 'none';
      _evSyncLinkedSlug = t.slug || '';
      const selDiv = el('ev-sync-chal-selected');
      if (selDiv) {
        const pCount = t.participantsCount ? ` · ${t.participantsCount} participants` : '';
        selDiv.innerHTML = `Selected: <strong style="color:var(--fg);">challonge.com/${escapeHtml(_evSyncLinkedSlug)}</strong>${pCount}`;
        selDiv.style.display = '';
      }
    });
    container.appendChild(row);
  });
  container.style.display = 'block';
}

// Wire up modal events (runs once on load)
(function wireEvSyncModal() {
  // Close buttons
  ['ev-sync-modal-close', 'ev-sync-modal-close2'].forEach(id => {
    el(id)?.addEventListener('click', () => el('ev-sync-modal').setAttribute('hidden', ''));
  });
  // Click outside to close
  el('ev-sync-modal')?.addEventListener('click', (e) => {
    if (e.target === el('ev-sync-modal')) el('ev-sync-modal').setAttribute('hidden', '');
  });

  // Mode toggle
  document.querySelectorAll('input[name="ev-sync-mode"]').forEach(r => {
    r.addEventListener('change', () => evSyncToggleMode(r.value));
  });

  // Slug live preview
  el('ev-sync-t-slug')?.addEventListener('input', () => evSyncUpdateSlugPreview(el('ev-sync-t-slug').value));

  // CSV upload
  el('ev-sync-csv-btn')?.addEventListener('click', () => el('ev-sync-csv-file')?.click());
  el('ev-sync-csv-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev2) => {
      _evSyncMappings = parseEvSyncCsv(ev2.target.result || '');
      const n = Object.keys(_evSyncMappings).length;
      const st = el('ev-sync-csv-status');
      if (st) { st.textContent = n ? `${n} mapping${n !== 1 ? 's' : ''} loaded from CSV.` : 'No valid mappings found — check your CSV has name and challonge_username columns.'; st.style.color = n ? '#86efac' : '#f59e0b'; }
      evSyncRenderPreview();
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Push button
  el('ev-sync-push-btn')?.addEventListener('click', evSyncPush);

  // Existing-tournament picker
  (function wireEvSyncChalPicker() {
    const searchInput = el('ev-sync-chal-search');
    const resultsDiv  = el('ev-sync-chal-results');
    const clearBtn    = el('ev-sync-chal-clear');
    if (!searchInput || !resultsDiv) return;

    async function loadEvSyncTournaments() {
      resultsDiv.innerHTML = '<div class="ev-dropdown-msg">Loading your Challonge tournaments…</div>';
      resultsDiv.style.display = 'block';
      try {
        const community = (el('ev-sync-chal-community')?.value || '').trim();
        if (community) localStorage.setItem('ne_challonge_community', community);
        const subdomains = community ? [community] : [];
        const resp = await fetch('http://127.0.0.1:3000/api/challonge/my-tournaments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subdomains }) });
        const data = await resp.json();
        _evSyncChalTournaments = resp.ok ? (data.tournaments || []) : [];
        renderEvSyncChalDropdown(_evSyncChalTournaments, '');
        if (data.subdomainErrors?.length) {
          const errEl = el('ev-sync-chal-results');
          if (errEl) errEl.insertAdjacentHTML('beforeend', data.subdomainErrors.map(e => `<div class="ev-dropdown-msg" style="color:#f59e0b;">Community "${escapeHtml(e.subdomain)}": ${escapeHtml(e.error)}</div>`).join(''));
        }
      } catch (e) {
        _evSyncChalTournaments = [];
        resultsDiv.innerHTML = `<div class="ev-dropdown-msg" style="color:#ef4444;">Error loading tournaments: ${escapeHtml(e.message)}</div>`;
      }
    }

    // Restore saved community
    const savedCommSync = localStorage.getItem('ne_challonge_community') || '';
    if (savedCommSync) { const ci = el('ev-sync-chal-community'); if (ci) ci.value = savedCommSync; }

    el('ev-sync-chal-community-reload')?.addEventListener('click', () => {
      _evSyncChalTournaments = null;
      loadEvSyncTournaments();
    });

    searchInput.addEventListener('focus', () => {
      if (!currentState.challonge?.hasKey) {
        resultsDiv.innerHTML = '<div class="ev-dropdown-msg" style="color:#f59e0b;">Add a Challonge API key in Integrations first.</div>';
        resultsDiv.style.display = 'block';
        return;
      }
      if (_evSyncChalTournaments !== null) {
        renderEvSyncChalDropdown(_evSyncChalTournaments, searchInput.value.trim().toLowerCase());
        resultsDiv.style.display = 'block';
        return;
      }
      loadEvSyncTournaments();
    });

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
      clearTimeout(_evSyncChalSearchTimer);
      _evSyncChalSearchTimer = setTimeout(() => {
        if (_evSyncChalTournaments !== null) renderEvSyncChalDropdown(_evSyncChalTournaments, q.toLowerCase());
      }, 60);
    });

    if (clearBtn) clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      _evSyncLinkedSlug = '';
      const selDiv = el('ev-sync-chal-selected');
      if (selDiv) selDiv.style.display = 'none';
      if (_evSyncChalTournaments !== null) renderEvSyncChalDropdown(_evSyncChalTournaments, '');
      searchInput.focus();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ev-sync-chal-search-wrap') && !e.target.closest('#ev-sync-chal-results')) {
        resultsDiv.style.display = 'none';
      }
    }, true);
  })();
})();

