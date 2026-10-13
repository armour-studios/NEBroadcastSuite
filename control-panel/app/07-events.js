// Control panel, part 7 of 17: Events: start.gg search and import, tournament picker, Challengermode.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Start.gg Search & Import ───────────────────────────────────────────────
el('btn-search-startgg-teams')?.addEventListener('click', async () => {
  const query = el('startgg-team-search').value.trim();
  if (!query) {
    showToast('Enter a team name to search', '#f59e0b');
    return;
  }

  if (!currentState.startgg?.hasToken) {
    showToast('Add your start.gg API token under Apps > start.gg first', '#f59e0b');
    return;
  }

  const resultsDiv = el('startgg-search-results');
  resultsDiv.innerHTML = '<p style="color: var(--muted); font-size: 12px;">Searching...</p>';

  try {
    const tokenInput = el('input-startgg-token');
    const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
    const response = await fetch('http://127.0.0.1:3000/api/startgg/search-teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, apiToken: token })
    });

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      resultsDiv.innerHTML = '<p style="color: #ef4444; font-size: 12px;">API Error: Invalid response. Check your API token or try again.</p>';
      return;
    }

    if (!response.ok) {
      resultsDiv.innerHTML = `<p style="color: #ef4444; font-size: 12px;">Error: ${data.error || 'Unknown error'}</p>`;
      return;
    }

    if (!data.teams || data.teams.length === 0) {
      resultsDiv.innerHTML = '<p style="color: var(--muted); font-size: 12px;">No teams found.</p>';
      return;
    }

    resultsDiv.innerHTML = '';
    data.teams.forEach(team => {
      const result = document.createElement('div');
      result.className = 'startgg-team-result';
      result.innerHTML = `
        <div class="startgg-team-result-name">${team.name}</div>
        <div class="startgg-team-result-meta">${team.playerCount || 0} players • ${team.state || 'Unknown'}</div>
      `;
      result.style.cursor = 'pointer';
      result.addEventListener('click', () => {
        importStartggTeam(team);
      });
      resultsDiv.appendChild(result);
    });
  } catch (err) {
    resultsDiv.innerHTML = `<p style="color: #ef4444; font-size: 12px;">Error: ${err.message}</p>`;
  }
});

// ── Start.gg Tournament Search ──────────────────────────────────────────────
el('btn-search-startgg-tournaments')?.addEventListener('click', async () => {
  const query = el('startgg-tournament-search').value.trim();
  if (!query) {
    showToast('Enter a tournament name to search', '#f59e0b');
    return;
  }

  if (!currentState.startgg?.hasToken) {
    showToast('Add your start.gg API token under Apps > start.gg first', '#f59e0b');
    return;
  }

  const resultsDiv = el('startgg-tournament-search-results');
  resultsDiv.innerHTML = '<div style="padding: 16px; text-align: center;"><span style="color: var(--muted); font-size: 12px;"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Searching tournaments...</span></div>';

  try {
    // First test if the token is valid
    const tokenInput2 = el('input-startgg-token');
    const t2 = (tokenInput2 && tokenInput2.value.trim()) || currentState.startgg?.apiToken || '';
    const tokenResponse = await fetch('http://127.0.0.1:3000/api/startgg/test-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiToken: t2 })
    });
    const tokenData = await tokenResponse.json();

    if (!tokenData.valid) {
      resultsDiv.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 12px; text-align: center;">Invalid API Token<br><small>Go to Settings and verify your Start.gg token</small></div>`;
      return;
    }

    // Token is valid, proceed with search
    const tokenInput = el('input-startgg-token');
    const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
    const response = await fetch('http://127.0.0.1:3000/api/startgg/search-tournaments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, apiToken: token })
    });

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      resultsDiv.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 12px; text-align: center;">API Error: Invalid response</div>`;
      return;
    }

    if (!response.ok) {
      resultsDiv.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 12px; text-align: center;">${data.error || 'Search failed'}</div>`;
      return;
    }

    if (!data.tournaments || data.tournaments.length === 0) {
      resultsDiv.innerHTML = '<div style="padding: 16px; color: var(--muted); font-size: 12px; text-align: center;">No tournaments found for "${query}"</div>';
      return;
    }

    resultsDiv.innerHTML = '';
    data.tournaments.forEach(tournament => {
      const startDate = tournament.startAt ? new Date(tournament.startAt * 1000).toLocaleDateString() : 'TBA';
      const result = document.createElement('div');
      result.className = 'startgg-tournament-preview';

      if (tournament.image) {
        result.innerHTML = `
          <div class="tournament-preview-image">
            <img src="${tournament.image}" alt="${tournament.name}" onerror="this.src='../assets/rl.png'">
          </div>
          <div class="tournament-preview-content">
            <div class="tournament-preview-name">${tournament.name}</div>
            <div class="tournament-preview-date">${startDate}</div>
            <div class="tournament-preview-slug">Slug: ${tournament.slug}</div>
          </div>
        `;
      } else {
        result.innerHTML = `
          <div class="tournament-preview-placeholder">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><rect x="2" y="6" width="20" height="12" rx="6"/></svg>
          </div>
          <div class="tournament-preview-content">
            <div class="tournament-preview-name">${tournament.name}</div>
            <div class="tournament-preview-date">${startDate}</div>
            <div class="tournament-preview-slug">Slug: ${tournament.slug}</div>
          </div>
        `;
      }

      result.style.cursor = 'pointer';
      result.addEventListener('click', () => {
        selectStartggTournament(tournament, true);
      });
      resultsDiv.appendChild(result);
    });
  } catch (err) {
    resultsDiv.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 12px; text-align: center;">Error: ${err.message}</div>`;
  }
});

function selectStartggTournament(tournament, autoLoadTeams = false) {
  // Update manual slug fields if present (teams tab)
  const tSlugEl = el('startgg-tournament-slug');
  const eSlugEl = el('startgg-event-slug');
  if (tSlugEl) tSlugEl.value = tournament.slug || '';
  if (eSlugEl) eSlugEl.value = '';

  const resultsDiv = el('startgg-tournament-search-results');
  if (resultsDiv) resultsDiv.innerHTML = `<p style="color: #86efac; font-size: 12px;">✓ Selected: ${tournament.name}</p>`;

  // Global selection for event + stats
  const payload = {
    tournamentSlug: tournament.slug,
    eventSlug: '', // will let user load specific or default to tournament slug for entrants
    name: tournament.name,
    tournamentName: tournament.name
  };
  send('select_startgg_event', payload);

  // Sync the queue tournament field (Dashboard) so stream queue can use the same
  const queueInput = el('sgg-tournament');
  if (queueInput) queueInput.value = tournament.slug || '';

  // Update selected pill (new design)
  const selDiv = el('dash-selected-sgg-event');
  const selText = el('ev-selected-text');
  if (selDiv && selText) {
    selText.textContent = tournament.name + (tournament.slug ? ` · ${tournament.slug}` : '');
    selDiv.style.display = 'flex';
  }

  _evSelectedSlug = tournament.slug || '';
  if (autoLoadTeams) {
    // Full load (teams→library + bracket + queue). Resolves the event automatically.
    loadStartggEvent(tournament.slug, tournament.name);
  }
}

// True when the text is a start.gg URL or a "tournament/..."-style slug (not a keyword).
function looksLikeStartggLink(s) {
  return /start\.gg\//i.test(s) || /(^|\/)tournament\//i.test(s);
}

let _evSelectedSlug = '';   // slug of the tournament chosen from the dashboard picker

// One-click "Load Event": resolve a tournament/event link or slug, import teams (→ library
// with logos), build the bracket, and populate the stream queue. Multi-event tournaments
// return a picker (handled by the event-result message).
let _evLoadTimer = null;
function loadStartggEvent(input, displayName) {
  if (!currentState.startgg?.hasToken) { showToast('Add your Start.gg API token in Marketplace → Integrations first.', '#f59e0b'); return; }
  const url = (input || '').trim();
  if (!url) { showToast('Paste a start.gg link or pick a tournament first.', '#f59e0b'); return; }
  console.info('[start.gg] load_startgg_url →', url);
  evLoadStatus(`Loading ${displayName ? '“' + displayName + '”' : 'event'}…`, '');
  const picker = el('dash-sgg-event-picker'); if (picker) picker.style.display = 'none';
  send('load_startgg_url', { url });
  // If the server never answers, it's almost always running stale code — the WS
  // bridge lives in the Electron MAIN process, so reloading the window isn't enough.
  if (_evLoadTimer) clearTimeout(_evLoadTimer);
  _evLoadTimer = setTimeout(() => {
    evLoadStatus('No response from the server. Fully quit and relaunch the app (not just reload the window), then try again.', '#f59e0b');
  }, 9000);
}

function evLoadStatus(msg, color) {
  const s = el('ev-load-status');
  if (s) { s.textContent = msg; s.style.color = color || 'var(--muted)'; }
}

// Render the event picker when a pasted tournament has more than one event.
function renderSggEventPicker(data) {
  const wrap = el('dash-sgg-event-picker');
  if (!wrap) return;
  const events = (data && data.events) || [];
  if (!events.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.innerHTML = `<div class="ev-picker-hdr">Pick an event from ${data.tournamentName ? '“' + data.tournamentName + '”' : 'this tournament'}</div>`;
  events.forEach((ev) => {
    const row = document.createElement('button');
    row.className = 'ev-picker-row';
    const meta = [ev.game, ev.numEntrants ? ev.numEntrants + ' entrants' : ''].filter(Boolean).join(' · ');
    row.innerHTML = `<span class="ev-picker-name">${(ev.name || 'Event').replace(/</g, '&lt;')}</span><span class="ev-picker-meta">${meta}</span>`;
    row.addEventListener('click', () => { wrap.style.display = 'none'; loadStartggEvent(ev.slug, ev.name); });
    wrap.appendChild(row);
  });
  wrap.style.display = 'block';
}

// Inline event picker for the Competitions → Brackets tab (so a multi-event tournament shows its
// events right where you pasted the link, not only on the Dashboard).
function renderBracketEventPicker(data) {
  const wrap = el('bracket-event-picker');
  if (!wrap) return;
  const events = (data && data.events) || [];
  if (!events.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  const tName = data.tournamentName ? '“' + data.tournamentName.replace(/</g, '&lt;') + '”' : 'this tournament';
  wrap.innerHTML = `<div class="bk-ev-hdr">${events.length} events on ${tName} — pick one:</div>`;
  const list = document.createElement('div'); list.className = 'bk-ev-list';
  events.forEach((ev) => {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'bk-ev-row';
    const meta = [ev.game, ev.numEntrants ? ev.numEntrants + ' entrants' : ''].filter(Boolean).join(' · ');
    row.innerHTML = `<span class="bk-ev-name">${(ev.name || 'Event').replace(/</g, '&lt;')}</span>${meta ? `<span class="bk-ev-meta">${meta.replace(/</g, '&lt;')}</span>` : ''}`;
    row.addEventListener('click', () => {
      wrap.style.display = 'none';
      const st = el('bracket-status'); if (st) { st.textContent = `Loading “${ev.name || 'event'}”…`; st.style.color = 'var(--muted)'; }
      // ev.slug is the full "tournament/x/event/y" slug → loads that event directly.
      send('activate_startgg_event', { eventSlug: ev.slug, tournamentSlug: data.tournamentSlug || '' });
    });
    list.appendChild(row);
  });
  wrap.appendChild(list);
  wrap.style.display = 'block';
}

async function loadStartggTeamsForSelection(tournamentSlug, eventSlug) {
  if (!currentState.startgg?.hasToken) {
    showToast('Add your start.gg API token under Apps > start.gg first', '#f59e0b');
    return;
  }
  const statusTarget = el('dash-selected-sgg-event') || el('startgg-import-status');
  if (statusTarget) statusTarget.textContent = 'Loading teams from event...';

  try {
    const tokenInput = el('input-startgg-token');
    const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
    // Prefer the dedicated endpoint (server will also call load + broadcast)
    const resp = await fetch('http://127.0.0.1:3000/api/startgg/event-teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentSlug: tournamentSlug || '',
        eventSlug: eventSlug || '',
        apiToken: token
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');

    if (statusTarget) statusTarget.textContent = `✓ Loaded ${data.teamsLoaded || 0} teams`;
    // state will arrive via WS broadcast shortly; render will update
  } catch (e) {
    // Fallback: use WS message directly
    send('load_startgg_event_teams', { tournamentSlug, eventSlug });
    if (statusTarget) statusTarget.textContent = 'Loading... (via WS)';
  }
}

function clearStartggTeams() {
  send('clear_startgg_teams', {});
  const selDiv = el('dash-selected-sgg-event');
  if (selDiv) selDiv.style.display = 'none';
  const searchInput = el('sgg-event-search');
  if (searchInput) { searchInput.value = ''; }
  if (el('ev-search-clear')) el('ev-search-clear').style.display = 'none';
  const picker = el('dash-sgg-event-picker'); if (picker) picker.style.display = 'none';
  _evSelectedSlug = '';   // drop any in-session tournament selection
  _evMyTourneys = null;   // force re-fetch next time
}

el('btn-import-tournament-roster')?.addEventListener('click', async () => {
  const tournamentSlug = el('startgg-tournament-slug').value.trim();
  const eventSlug = el('startgg-event-slug').value.trim();

  if (!tournamentSlug || !eventSlug) {
    showToast('Enter both tournament and event slugs', '#ef4444');
    return;
  }

  const statusDiv = el('startgg-import-status');
  statusDiv.innerHTML = '<p style="color: var(--muted);">Importing...</p>';

  try {
    const tokenInput = el('input-startgg-token');
    const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
    const response = await fetch('http://127.0.0.1:3000/api/startgg/import-tournament', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentSlug,
        eventSlug,
        apiToken: token
      })
    });
    const data = await response.json();

    if (!response.ok) {
      statusDiv.innerHTML = `<p style="color: #ef4444;">Error: ${data.error || 'Unknown error'}</p>`;
      return;
    }

    statusDiv.innerHTML = `<p style="color: #86efac;">✓ Imported ${data.teamsAdded || 0} teams with ${data.playersAdded || 0} players</p>`;
  } catch (err) {
    statusDiv.innerHTML = `<p style="color: #ef4444;">Error: ${err.message}</p>`;
  }
});

function importStartggTeam(teamData) {
  showToast(`Importing ${teamData.name} from Start.gg`, '#22c55e');
}

// ── Dashboard: start.gg Event / Tournament picker wiring ─────────────────────
let _evMyTourneys = null;   // cached admin tournament list; null = not yet fetched
let _evSearchTimer = null;
// Global (all of start.gg) search results for the CURRENT query — searched automatically
// as you type, so a producer never has to guess that Enter means "search wider".
let _evGlobal = { q: '', rows: [], loading: false, err: '' };
let _evAbort = null;        // AbortController for the in-flight global search
let _evNavIdx = -1;         // keyboard-highlighted row
let _evActs = [];           // one activate-fn per navigable row, in render order
let _evExpanded = '';       // slug of the tournament whose events are expanded inline

function wireSggEventPicker() {
  const searchInput = el('sgg-event-search');
  const resultsDiv  = el('dash-sgg-tournament-results');
  const clearBtn    = el('ev-search-clear');

  if (searchInput && resultsDiv) {
    searchInput.addEventListener('focus', () => evOpenDropdown());

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
      if (looksLikeStartggLink(q)) {
        _evSelectedSlug = '';
        const pill = el('dash-selected-sgg-event'); if (pill) pill.style.display = 'none';
      }
      // The old global results belong to the old query — drop them so nothing stale shows.
      if (_evGlobal.q && _evGlobal.q !== q.toLowerCase()) _evGlobal = { q: '', rows: [], loading: false, err: '' };
      _evNavIdx = -1;
      _evExpanded = '';
      evRenderDropdown();
      clearTimeout(_evSearchTimer);
      if (!looksLikeStartggLink(q) && q.length >= 3 && currentState.startgg?.hasToken) {
        _evSearchTimer = setTimeout(() => evFetchGlobal(q), 350);
      }
    });

    // Keyboard: ↑/↓ walk every row (including expanded events), Enter activates the
    // highlighted one, Enter with nothing highlighted searches all of start.gg now.
    searchInput.addEventListener('keydown', (e) => {
      const open = resultsDiv.style.display !== 'none';
      if (e.key === 'Escape') { resultsDiv.style.display = 'none'; _evNavIdx = -1; return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!open) { evOpenDropdown(); return; }
        if (!_evActs.length) return;
        e.preventDefault();
        _evNavIdx = (_evNavIdx + (e.key === 'ArrowDown' ? 1 : -1) + _evActs.length) % _evActs.length;
        evPaintActive();
        return;
      }
      if (e.key !== 'Enter') return;
      if (_evNavIdx >= 0 && _evActs[_evNavIdx]) { e.preventDefault(); _evActs[_evNavIdx](); return; }
      const q = searchInput.value.trim();
      if (!q || !currentState.startgg?.hasToken) return;
      if (looksLikeStartggLink(q)) { resultsDiv.style.display = 'none'; loadStartggEvent(q); return; }
      clearTimeout(_evSearchTimer);
      evFetchGlobal(q);
    });

    // X button clears the input and resets dropdown
    if (clearBtn) clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      _evGlobal = { q: '', rows: [], loading: false, err: '' };
      _evNavIdx = -1; _evExpanded = '';
      evRenderDropdown();
      searchInput.focus();
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ev-search-wrap') && !e.target.closest('#dash-sgg-tournament-results')) {
        resultsDiv.style.display = 'none';
      }
    }, true);
  }

  // Deselect pill button
  const pillClear = el('ev-pill-clear');
  if (pillClear) pillClear.addEventListener('click', () => {
    const selDiv = el('dash-selected-sgg-event');
    if (selDiv) selDiv.style.display = 'none';
  });

  // Load Event (full: teams → library + bracket + queue). Priority:
  //   1) a link/slug typed or pasted in the search box (the user's explicit intent),
  //   2) the tournament just chosen from the dropdown this session,
  //   3) only as a last resort, the persisted/previous event — never let a stale
  //      saved event override a freshly pasted link (that was the load-wrong-event bug).
  const loadDash = el('btn-load-sgg-teams-dash');
  if (loadDash) loadDash.addEventListener('click', () => {
    const typed = (el('sgg-event-search')?.value || '').trim();
    const input = looksLikeStartggLink(typed)
      ? typed
      : (_evSelectedSlug
         || (el('sgg-tournament')?.value || '').trim()
         || (el('startgg-event-slug')?.value || '').trim()
         || (currentState.startgg?.eventSlug || currentState.startgg?.tournamentSlug || '').trim());
    if (!input) { showToast('Paste a tournament link, or pick a tournament from the search.', '#f59e0b'); return; }
    loadStartggEvent(input);
  });

  // Teams tab bulk actions
  const saveAll = el('btn-save-all-sgg-teams');
  if (saveAll) saveAll.addEventListener('click', () => {
    const teams = currentState.startgg?.eventTeams || [];
    if (!teams.length) { showToast('No event teams to save.', '#f59e0b'); return; }
    appConfirm(`Save all ${teams.length} event teams into Saved Teams?`, 'Save All', false).then(ok => { if (!ok) return; send('save_startgg_teams_bulk', { names: teams.map(t => t.name) }); });
  });

  const massDel = el('btn-mass-delete-sgg-teams');
  if (massDel) massDel.addEventListener('click', () => {
    const teams = currentState.startgg?.eventTeams || [];
    if (!teams.length) return;
    appConfirm(`Delete all ${teams.length} event teams? (Saved teams are unaffected)`, 'Delete All').then(ok => { if (!ok) return; send('mass_delete_startgg_teams', {}); });
  });
}

// ── start.gg picker engine ───────────────────────────────────────────────────
// One dropdown, three sections (Recent · your tournaments · all of start.gg), ranked by
// relevance + how close the tournament is to NOW, keyboard-navigable, with each tournament's
// events expandable inline so you can load the exact event in one click.
const EV_RECENT_KEY = 'ne_sgg_recent_v1';

function evRecents() {
  try { const a = JSON.parse(localStorage.getItem(EV_RECENT_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function evPushRecent(t) {
  if (!t || !t.slug) return;
  const list = evRecents().filter(r => r.slug !== t.slug);
  list.unshift({
    slug: t.slug, name: t.name || t.slug, image: t.image || '',
    startAt: t.startAt || 0, endAt: t.endAt || 0,
    events: (t.events || []).slice(0, 20), eventCount: t.eventCount || (t.events || []).length
  });
  try { localStorage.setItem(EV_RECENT_KEY, JSON.stringify(list.slice(0, 6))); } catch { /* quota */ }
}

// When a tournament is, in words a producer thinks in.
function evWhen(t) {
  const now = Date.now() / 1000;
  const s = t.startAt || 0;
  const e = t.endAt || (s ? s + 86400 : 0);
  if (!s) return { label: 'Date TBA', badge: '', cls: '' };
  if (s <= now && now <= e) return { label: 'Happening now', badge: 'LIVE', cls: 'is-live' };
  const d = new Date(s * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const dstr = d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  if (s > now) {
    const days = Math.round((s - now) / 86400);
    const label = days <= 0 ? `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : days === 1 ? 'Tomorrow' : days < 14 ? `in ${days} days` : dstr;
    return { label, badge: days <= 7 ? 'SOON' : '', cls: 'is-soon' };
  }
  const ago = Math.round((now - s) / 86400);
  return { label: ago <= 1 ? 'Yesterday' : ago < 14 ? `${ago} days ago` : dstr, badge: '', cls: 'is-past' };
}

// Relevance: how well the name matches, then how close to now (live > soon > recent past).
function evScore(t, q) {
  const n = (t.name || '').toLowerCase();
  const s = (t.slug || '').toLowerCase();
  let score = 0;
  if (q) {
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (n.startsWith(q)) score = 100;
    else if (new RegExp('\\b' + esc).test(n)) score = 80;
    else if (n.includes(q)) score = 60;
    else if (s.includes(q)) score = 40;
    else if ((t.games || []).some(g => (g || '').toLowerCase().includes(q))) score = 20;
    // Last resort before dropping the row: a typo or an abbreviation of the name. Kept at the
    // bottom of the ladder so it can only ever surface below a genuine substring hit — the tiers
    // above are deliberately more specific than the shared matcher and stay in charge.
    else if (NESearch.score(q, [t.name || '']) >= 0) score = 10;
    else return -1;
  }
  const now = Date.now() / 1000;
  const st = t.startAt || 0;
  const en = t.endAt || (st ? st + 86400 : 0);
  if (st && st <= now && now <= en) score += 30;
  else if (st > now) score += 20 - Math.min(19, (st - now) / 86400 / 14);
  else if (st) score += Math.max(0, 10 - (now - st) / 86400 / 30);
  return score;
}
function evRank(list, q) {
  return list.map(t => ({ t, s: evScore(t, q) })).filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s).map(x => x.t);
}

// Bold the matched run inside a name.
function evHi(name, q) {
  const safe = esc(name || '');
  if (!q) return safe;
  const i = (name || '').toLowerCase().indexOf(q);
  if (i < 0) return safe;
  return esc(name.slice(0, i)) + '<span class="ev-hi">' + esc(name.slice(i, i + q.length)) + '</span>' + esc(name.slice(i + q.length));
}

function evLogoHtml(t) {
  const url = t.image || t.images?.[0]?.url || '';
  return url
    ? `<img class="ev-dropdown-logo" src="${esc(url)}" alt="" onerror="this.style.display='none'">`
    : `<div class="ev-dropdown-logo-ph"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2L3 7v11h5v-5h4v5h5V7L10 2z"/></svg></div>`;
}

async function evEnsureMyTourneys() {
  if (_evMyTourneys !== null) return _evMyTourneys;
  const token = (el('input-startgg-token')?.value.trim()) || currentState.startgg?.apiToken || '';
  try {
    const resp = await fetch('http://127.0.0.1:3000/api/startgg/my-tournaments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiToken: token })
    });
    const data = await resp.json();
    _evMyTourneys = resp.ok ? (data.tournaments || []) : [];
  } catch {
    _evMyTourneys = [];
  }
  return _evMyTourneys;
}

function evOpenDropdown() {
  const box = el('dash-sgg-tournament-results');
  if (!box) return;
  box.style.display = 'block';
  evRenderDropdown();
  if (_evMyTourneys === null && currentState.startgg?.hasToken) {
    evEnsureMyTourneys().then(() => evRenderDropdown());
  }
}

// Search all of start.gg for the current query (debounced from typing, or forced with Enter).
async function evFetchGlobal(query) {
  const q = (query || '').trim();
  if (q.length < 2 || !currentState.startgg?.hasToken) return;
  if (_evAbort) _evAbort.abort();
  const ctl = new AbortController();
  _evAbort = ctl;
  _evGlobal = { q: q.toLowerCase(), rows: [], loading: true, err: '' };
  evRenderDropdown();
  const token = (el('input-startgg-token')?.value.trim()) || currentState.startgg?.apiToken || '';
  try {
    const resp = await fetch('http://127.0.0.1:3000/api/startgg/search-tournaments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, apiToken: token }), signal: ctl.signal
    });
    const data = await resp.json();
    if (ctl !== _evAbort) return;                       // a newer search already started
    if (!resp.ok) throw new Error(data.error || 'Search failed');
    _evGlobal = { q: q.toLowerCase(), rows: data.tournaments || [], loading: false, err: '' };
  } catch (err) {
    if (err.name === 'AbortError' || ctl !== _evAbort) return;
    _evGlobal = { q: q.toLowerCase(), rows: [], loading: false, err: err.message || 'Search failed' };
  }
  evRenderDropdown();
}

function evPaintActive() {
  const box = el('dash-sgg-tournament-results');
  if (!box) return;
  box.querySelectorAll('.ev-nav').forEach((r) => {
    const on = Number(r.dataset.evIdx) === _evNavIdx;
    r.classList.toggle('is-active', on);
    if (on) r.scrollIntoView({ block: 'nearest' });
  });
}

function evPickTournament(t) {
  const input = el('sgg-event-search');
  if (input) input.value = t.name || t.slug || '';
  if (el('ev-search-clear')) el('ev-search-clear').style.display = 'block';
  const box = el('dash-sgg-tournament-results'); if (box) box.style.display = 'none';
  _evNavIdx = -1;
  evPushRecent(t);
  const evs = (t.events || []).filter(e => e && e.slug);
  // Single-event tournament: skip the "pick an event" step entirely.
  if (evs.length === 1) {
    _evSelectedSlug = t.slug || '';
    loadStartggEvent(evs[0].slug, t.name);
    return;
  }
  selectStartggTournament(t, true);
}

function evPickEvent(t, ev) {
  const input = el('sgg-event-search');
  if (input) input.value = `${t.name} — ${ev.name || 'Event'}`;
  if (el('ev-search-clear')) el('ev-search-clear').style.display = 'block';
  const box = el('dash-sgg-tournament-results'); if (box) box.style.display = 'none';
  _evNavIdx = -1;
  evPushRecent(t);
  _evSelectedSlug = t.slug || '';
  loadStartggEvent(ev.slug || t.slug, `${t.name} — ${ev.name || 'Event'}`);
}

function evSectionHdr(text, note) {
  const h = document.createElement('div');
  h.className = 'ev-dropdown-section-hdr';
  h.innerHTML = `<span>${esc(text)}</span>${note ? `<span class="ev-hdr-note">${esc(note)}</span>` : ''}`;
  return h;
}

// Build one tournament row (+ its expanded event sub-rows) into `box`.
function evAppendTournament(box, t, q, badge) {
  const when = evWhen(t);
  const evs = (t.events || []).filter(Boolean);
  const row = document.createElement('div');
  row.className = 'ev-dropdown-row ev-nav';
  row.dataset.evIdx = _evActs.length;
  const meta = [
    when.label,
    t.numAttendees ? `${t.numAttendees} entrants` : '',
    evs.length ? `${evs.length} event${evs.length > 1 ? 's' : ''}` : '',
    (t.games || []).slice(0, 2).join(', '),
    [t.city, t.countryCode].filter(Boolean).join(', ')
  ].filter(Boolean).slice(0, 4).join(' · ');
  const expanded = _evExpanded === t.slug;
  row.innerHTML = `${evLogoHtml(t)}
    <div class="ev-dropdown-info">
      <div class="ev-dropdown-name">${evHi(t.name || t.slug, q)}</div>
      <div class="ev-dropdown-meta">${esc(meta)}</div>
    </div>
    ${when.badge ? `<span class="ev-dropdown-badge ${when.cls}">${when.badge}</span>` : ''}
    ${badge ? `<span class="ev-dropdown-badge">${esc(badge)}</span>` : ''}
    ${evs.length > 1 ? `<button type="button" class="ev-row-exp${expanded ? ' is-open' : ''}" title="${expanded ? 'Hide' : 'Show'} events">${evs.length} ▾</button>` : ''}`;
  row.addEventListener('click', () => evPickTournament(t));
  _evActs.push(() => evPickTournament(t));
  const expBtn = row.querySelector('.ev-row-exp');
  if (expBtn) expBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _evExpanded = expanded ? '' : t.slug;
    _evNavIdx = -1;
    evRenderDropdown();
  });
  box.appendChild(row);

  if (expanded) {
    evs.forEach((ev) => {
      const sub = document.createElement('div');
      sub.className = 'ev-dropdown-row ev-sub-row ev-nav';
      sub.dataset.evIdx = _evActs.length;
      const emeta = [ev.game, ev.numEntrants ? `${ev.numEntrants} entrants` : '', ev.state === 'ACTIVE' ? 'in progress' : ''].filter(Boolean).join(' · ');
      sub.innerHTML = `<div class="ev-dropdown-info">
          <div class="ev-dropdown-name">${esc(ev.name || 'Event')}</div>
          <div class="ev-dropdown-meta">${esc(emeta)}</div>
        </div>
        <span class="ev-dropdown-badge is-load">Load</span>`;
      sub.addEventListener('click', (e) => { e.stopPropagation(); evPickEvent(t, ev); });
      _evActs.push(() => evPickEvent(t, ev));
      box.appendChild(sub);
    });
  }
}

function evRenderDropdown() {
  const box = el('dash-sgg-tournament-results');
  const input = el('sgg-event-search');
  if (!box || !input) return;
  const raw = input.value.trim();
  const q = raw.toLowerCase();
  _evActs = [];
  box.innerHTML = '';

  if (!currentState.startgg?.hasToken) {
    box.innerHTML = '<div class="ev-dropdown-msg" style="color:#f59e0b;"><svg class="svg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> Add a start.gg API token in Marketplace → Integrations first.</div>';
    box.style.display = 'block';
    return;
  }

  // A pasted link/slug is unambiguous — offer the one-click load and nothing else.
  if (looksLikeStartggLink(raw)) {
    const row = document.createElement('div');
    row.className = 'ev-dropdown-row ev-nav ev-link-load';
    row.dataset.evIdx = 0;
    row.innerHTML = `<div class="ev-dropdown-logo-ph"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 12a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M12 8a3 3 0 0 0-4.2 0L5.5 10.3a3 3 0 0 0 4.2 4.2l1-1"/></svg></div>
      <div class="ev-dropdown-info">
        <div class="ev-dropdown-name">Load this start.gg link</div>
        <div class="ev-dropdown-meta">${esc(raw.slice(0, 70))}</div>
      </div>
      <span class="ev-dropdown-badge">↵ Enter</span>`;
    row.addEventListener('click', () => { box.style.display = 'none'; loadStartggEvent(raw); });
    _evActs.push(() => { box.style.display = 'none'; loadStartggEvent(raw); });
    box.appendChild(row);
    box.style.display = 'block';
    evPaintActive();
    return;
  }

  const shown = new Set();
  let rowCount = 0;

  // 1) Recently loaded — the fastest path back to the event you ran an hour ago.
  const recents = evRank(evRecents(), q).slice(0, q ? 3 : 4);
  if (recents.length) {
    box.appendChild(evSectionHdr('Recent'));
    recents.forEach(t => { shown.add(t.slug); rowCount++; evAppendTournament(box, t, q, ''); });
  }

  // 2) Your own tournaments.
  if (_evMyTourneys === null) {
    const msg = document.createElement('div');
    msg.className = 'ev-dropdown-msg';
    msg.textContent = 'Loading your start.gg tournaments…';
    box.appendChild(msg);
  } else {
    const mine = evRank(_evMyTourneys.filter(t => !shown.has(t.slug)), q).slice(0, q ? 6 : 12);
    if (mine.length) {
      box.appendChild(evSectionHdr('Your tournaments'));
      mine.forEach(t => { shown.add(t.slug); rowCount++; evAppendTournament(box, t, q, 'Admin'); });
    }
  }

  // 3) Everything else on start.gg — searched automatically as you type.
  if (q.length >= 3) {
    if (_evGlobal.loading) {
      box.appendChild(evSectionHdr('All of start.gg'));
      const msg = document.createElement('div');
      msg.className = 'ev-dropdown-msg';
      msg.innerHTML = '<span class="ev-mini-spin"></span> Searching start.gg…';
      box.appendChild(msg);
    } else if (_evGlobal.q === q && _evGlobal.err) {
      box.appendChild(evSectionHdr('All of start.gg'));
      const msg = document.createElement('div');
      msg.className = 'ev-dropdown-msg';
      msg.style.color = '#ef4444';
      msg.textContent = _evGlobal.err;
      box.appendChild(msg);
    } else if (_evGlobal.q === q) {
      const global = evRank(_evGlobal.rows.filter(t => !shown.has(t.slug)), q).slice(0, 15);
      if (global.length) {
        box.appendChild(evSectionHdr('All of start.gg', `${global.length} found`));
        global.forEach(t => { shown.add(t.slug); rowCount++; evAppendTournament(box, t, q, ''); });
      } else if (!rowCount) {
        const msg = document.createElement('div');
        msg.className = 'ev-dropdown-msg';
        msg.innerHTML = `Nothing on start.gg matches “${esc(raw)}”. Paste the tournament link instead.`;
        box.appendChild(msg);
      }
    }
  } else if (!rowCount) {
    const msg = document.createElement('div');
    msg.className = 'ev-dropdown-msg';
    msg.textContent = q ? 'Keep typing to search all of start.gg…' : 'No tournaments on your account yet — type a name, or paste a tournament link.';
    box.appendChild(msg);
  }

  if (rowCount) {
    const foot = document.createElement('div');
    foot.className = 'ev-dropdown-foot';
    foot.textContent = '↑↓ navigate · Enter load · ▾ pick an event · Esc close';
    box.appendChild(foot);
  }

  if (_evNavIdx >= _evActs.length) _evNavIdx = -1;
  box.style.display = 'block';
  evPaintActive();
}

// Fetch and display "My Admin Tournaments" into a results container
async function showMyTournaments(container) {
  if (!container) return;
  if (!currentState.startgg?.hasToken) {
    container.innerHTML = '<div style="color:#ef4444;font-size:12px">Add your start.gg API token under Apps > start.gg first.</div>';
    return;
  }
  container.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--muted)">Loading your tournaments…</div>';
  const tokenInput = el('input-startgg-token');
  const token = (tokenInput && tokenInput.value.trim()) || currentState.startgg?.apiToken || '';
  try {
    const resp = await fetch('http://127.0.0.1:3000/api/startgg/my-tournaments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiToken: token })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    container.innerHTML = '';
    if (!data.tournaments || !data.tournaments.length) {
      container.innerHTML = '<div style="font-size:12px;color:var(--muted)">No tournaments found for this token (you may need search instead).</div>';
      return;
    }
    data.tournaments.forEach(t => {
      const div = document.createElement('div');
      div.className = 'startgg-tournament-preview';
      div.style.cursor = 'pointer';
      const date = t.startAt ? new Date(t.startAt * 1000).toLocaleDateString() : '';
      div.innerHTML = `
        <div class="tournament-preview-content" style="padding:6px 8px;">
          <div class="tournament-preview-name">${t.name}</div>
          <div class="tournament-preview-date" style="font-size:10px;">${date} • Slug: ${t.slug}</div>
        </div>
      `;
      div.addEventListener('click', () => {
        selectStartggTournament(t, true); // auto load teams on pick
      });
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = `<div style="color:#ef4444;font-size:12px">Error: ${err.message}</div>`;
  }
}

// Wire once
wireSggEventPicker();

// ── Tournament platform picker (platform tabs + Challonge + unified Load/Clear) ──────────────
let _evActivePlatform = 'startgg';
let _evChallongeSlug = '';
let _evChalMyTourneys = null;
let _evChalSearchTimer = null;
let _evNxgenSlug = '';
let _evNxgenSearchTimer = null;
let _evFaceitPick = null;          // { id, type, name } chosen from the FACEIT dropdown
let _evFaceitSearchTimer = null;
let _evFaceitMyComps = null;       // cached organiser competitions (null = not fetched yet)
let _evCmPick = '';                // tournament id chosen from the Challengermode dropdown
let _evCmSearchTimer = null;
let _evCmList = null;              // cached Space tournaments (null = not fetched yet)
let _evCmSpaceSeen = null;         // the Space id the cache above was built for

function updateEvTokenBadge() {
  const badge = el('ev-token-badge');
  if (!badge) return;
  if (_evActivePlatform === 'startgg') {
    badge.style.display = currentState.startgg?.hasToken ? 'none' : '';
  } else if (_evActivePlatform === 'challonge') {
    badge.style.display = currentState.challonge?.hasKey ? 'none' : '';
  } else if (_evActivePlatform === 'nxgen') {
    badge.style.display = currentState.nxgen?.hasKey ? 'none' : '';
  } else if (_evActivePlatform === 'faceit') {
    badge.style.display = currentState.faceit?.hasKey ? 'none' : '';
  } else if (_evActivePlatform === 'challengermode') {
    badge.style.display = currentState.challengermode?.hasKey ? 'none' : '';
  } else {
    badge.style.display = 'none';   // My league needs no platform key
  }
}

// Platform tab switching
document.querySelectorAll('.ev-plat-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    _evActivePlatform = tab.dataset.plat;
    document.querySelectorAll('.ev-plat-tab').forEach(t => t.classList.toggle('ev-plat-tab--active', t === tab));
    const sggPanel   = el('ev-plat-panel-startgg');
    const chalPanel  = el('ev-plat-panel-challonge');
    const nxgenPanel = el('ev-plat-panel-nxgen');
    const faceitPanel = el('ev-plat-panel-faceit');
    const cmPanel    = el('ev-plat-panel-challengermode');
    const leaguePanel = el('ev-plat-panel-league');
    if (leaguePanel) leaguePanel.style.display = _evActivePlatform === 'league'    ? '' : 'none';
    // Load Event / Clear belong to the platform importers; My league has its own buttons.
    if (el('ev-actions')) el('ev-actions').style.display = _evActivePlatform === 'league' ? 'none' : '';
    if (_evActivePlatform === 'league' && typeof window.evLeagueRender === 'function') window.evLeagueRender(true);
    try { localStorage.setItem('ne_ev_plat_tab', _evActivePlatform); } catch (_) {}
    if (sggPanel)    sggPanel.style.display    = _evActivePlatform === 'startgg'   ? '' : 'none';
    if (chalPanel)   chalPanel.style.display   = _evActivePlatform === 'challonge' ? '' : 'none';
    if (nxgenPanel)  nxgenPanel.style.display  = _evActivePlatform === 'nxgen'     ? '' : 'none';
    if (faceitPanel) faceitPanel.style.display = _evActivePlatform === 'faceit'    ? '' : 'none';
    if (cmPanel)     cmPanel.style.display     = _evActivePlatform === 'challengermode' ? '' : 'none';
    if (_evActivePlatform === 'challengermode' && typeof evCmHint === 'function') evCmHint();
    updateEvTokenBadge();
  });
});

// Unified Load Event button
el('btn-load-event-dash')?.addEventListener('click', () => {
  const status = el('ev-load-status');
  if (_evActivePlatform === 'startgg') {
    const typed = (el('sgg-event-search')?.value || '').trim();
    const input = looksLikeStartggLink(typed)
      ? typed
      : (_evSelectedSlug || (el('sgg-tournament')?.value || '').trim()
         || (currentState.startgg?.eventSlug || currentState.startgg?.tournamentSlug || '').trim());
    if (!input) { showToast('Paste a tournament link, or pick a tournament from the search.', '#f59e0b'); return; }
    loadStartggEvent(input);
  } else if (_evActivePlatform === 'challonge') {
    if (!_evChallongeSlug) { showToast('Pick a Challonge tournament from the search first.', '#f59e0b'); return; }
    if (status) status.textContent = 'Loading…';
    send('load_challonge_tournament', { slug: _evChallongeSlug });
  } else if (_evActivePlatform === 'nxgen') {
    const slug = (_evNxgenSlug || (el('ev-nxgen-search')?.value || '').trim() || (currentState.nxgen?.eventSlug || '').trim());
    if (!slug) { showToast('Enter an event slug or search for a NXGEN event.', '#f59e0b'); return; }
    if (status) status.textContent = 'Loading…';
    send('load_nxgen_event', { slug });
  } else if (_evActivePlatform === 'challengermode') {
    // A pick from the dropdown wins; otherwise whatever is typed is treated as a pasted link and
    // parseTournamentId() on the server digs the UUID out of it.
    const cmId = _evCmPick || (el('ev-cm-search')?.value || '').trim() || (currentState.challengermode?.tournamentId || '');
    if (!cmId) { showToast('Paste a Challengermode tournament link, or pick one from the search.', '#f59e0b'); return; }
    if (status) status.textContent = 'Loading…';
    send('load_challengermode_tournament', { id: cmId });
  } else if (_evActivePlatform === 'faceit') {
    // A pick from the dropdown wins; otherwise treat whatever is typed as a pasted FACEIT link
    // (the server pulls the UUID and the championship/hub kind out of it).
    const typed = (el('ev-faceit-search')?.value || '').trim();
    const pick = _evFaceitPick || (typed ? { id: typed, type: '' } : null)
      || (currentState.faceit?.competitionId ? { id: currentState.faceit.competitionId, type: currentState.faceit.competitionType } : null);
    if (!pick) { showToast('Paste a FACEIT championship/hub link, or pick one from the search.', '#f59e0b'); return; }
    if (status) status.textContent = 'Loading…';
    send('load_faceit_event', { id: pick.id, ...(pick.type ? { competitionType: pick.type } : {}) });
  }
});

// Unified Clear button
// This clears the active event AND wipes the imported start.gg teams (persisted server-side),
// so a stray click mid-show costs you the whole team list. Name the cost before doing it.
el('btn-clear-event-dash')?.addEventListener('click', async () => {
  const n = (((currentState || {}).startgg || {}).eventTeams || []).length;
  const ok = await appConfirm(
    n
      ? `Clear the active event? This also removes the ${n} imported team${n === 1 ? '' : 's'} — you would have to re-import them from start.gg.`
      : 'Clear the active event?',
    'Clear event',
    true
  );
  if (!ok) return;
  send('clear_active_event', {});
  clearStartggTeams();
  _evChallongeSlug = '';
  const chalSearch = el('ev-challonge-search');
  if (chalSearch) { chalSearch.value = ''; }
  if (el('ev-challonge-clear')) el('ev-challonge-clear').style.display = 'none';
  if (el('ev-challonge-results')) el('ev-challonge-results').style.display = 'none';
  _evNxgenSlug = '';
  const nxgenSearch = el('ev-nxgen-search');
  if (nxgenSearch) { nxgenSearch.value = ''; }
  if (el('ev-nxgen-clear')) el('ev-nxgen-clear').style.display = 'none';
  if (el('ev-nxgen-results')) el('ev-nxgen-results').style.display = 'none';
  _evFaceitPick = null;
  const faceitSearch = el('ev-faceit-search');
  if (faceitSearch) { faceitSearch.value = ''; }
  if (el('ev-faceit-clear')) el('ev-faceit-clear').style.display = 'none';
  if (el('ev-faceit-results')) el('ev-faceit-results').style.display = 'none';
  if (el('dash-active-event')) el('dash-active-event').style.display = 'none';
  const status = el('ev-load-status');
  if (status) status.textContent = 'Imports teams, bracket & match queue.';
});

// Clear active event card button
el('ev-active-clear')?.addEventListener('click', async () => {
  // Same question the Events page asks before clearing — this card's ✕ used to skip it.
  if (!await customConfirm('Clear event', 'Clear the active event? Its imported teams, bracket and match queue are removed until you load it again.', 'Clear event')) return;
  send('clear_active_event', {});
  if (el('dash-active-event')) el('dash-active-event').style.display = 'none';
});

// Challonge auto-follow toggle (dashboard)
el('challonge-autofollow')?.addEventListener('change', (e) => {
  send('set_challonge_auto_follow', { enabled: e.target.checked });
});

el('nxgen-autofollow')?.addEventListener('change', (e) => {
  send('set_nxgen_auto_follow', { enabled: e.target.checked });
});

el('faceit-autofollow')?.addEventListener('change', (e) => {
  send('set_faceit_auto_follow', { enabled: e.target.checked });
});

// ── Events ▸ Challengermode panel ───────────────────────────────────────────
// Challengermode addresses tournaments by UUID, so PASTE A LINK is the primary path and search is
// the convenience. Searching needs a Space id (the organisation), which is why the hint below
// tells the producer when that is the thing standing in their way rather than silently showing
// an empty dropdown.

const CM_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const looksLikeChallengermodeLink = (v) => CM_UUID_RE.test(String(v || ''));

function evCmHint() {
  const hint = el('ev-cm-hint');
  if (!hint) return;
  const cm = currentState.challengermode || {};
  if (!cm.hasKey) {
    hint.textContent = 'Add your Challengermode refresh key under Apps > Challengermode first.';
  } else if (!cm.spaceId) {
    hint.textContent = 'Paste a tournament link to load it. To browse instead, set your Space id in Settings.';
  } else {
    hint.textContent = 'Paste a link, or type to search your Space’s tournaments.';
  }
}

async function evCmSearch(term) {
  const box = el('ev-cm-results');
  if (!box) return;
  const cm = currentState.challengermode || {};
  const q = String(term || '').trim().toLowerCase();

  // A pasted link is not a search — it IS the answer. Show it as a one-row pick so the producer
  // gets the same confirm-then-load flow either way.
  if (looksLikeChallengermodeLink(q)) {
    _evCmPick = (String(term).match(CM_UUID_RE) || [''])[0].toLowerCase();
    box.innerHTML = '<div class="ev-dropdown-row" data-cmid="' + escapeHtml(_evCmPick) + '">'
      + '<div class="ev-dropdown-info"><div class="ev-dropdown-name">Tournament ' + escapeHtml(_evCmPick.slice(0, 8)) + '…</div>'
      + '<div class="ev-dropdown-meta">Link recognised — press Load Event</div></div></div>';
    box.style.display = 'block';
    return;
  }

  if (!cm.hasKey || !cm.spaceId) { box.style.display = 'none'; return; }

  if (_evCmList === null) {
    box.innerHTML = '<div class="ev-dropdown-msg">Loading your Challengermode tournaments…</div>';
    box.style.display = 'block';
    try {
      const r = await fetch('http://127.0.0.1:3000/api/challengermode/tournaments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spaceId: cm.spaceId })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'Could not list tournaments');
      _evCmList = d.tournaments || [];
    } catch (err) {
      _evCmList = [];
      box.innerHTML = '<div class="ev-dropdown-msg" style="color:#ef4444;">' + escapeHtml(friendlyError(err)) + '</div>';
      return;
    }
  }

  const hits = _evCmList.filter((t) => !q || String(t.name || '').toLowerCase().includes(q)).slice(0, 12);
  if (!hits.length) {
    box.innerHTML = '<div class="ev-dropdown-msg">No tournaments match. You can paste a link instead.</div>';
    box.style.display = 'block';
    return;
  }
  const STATE_COLORS = { RUNNING: '#10b981', OPEN: '#f59e0b', STARTING: '#f59e0b', COMPLETED: '#6b7280', CANCELLED: '#ef4444' };
  box.innerHTML = hits.map((t) => {
    // Say which of OUR games it will switch to — loading changes the overlay, the team labels and
    // the roster size, and that should never be a surprise.
    const g = (currentState.games || {})[t.gameId];
    const meta = [g ? g.name : (t.gameName || ''), t.entrants ? t.entrants + ' entrants' : '']
      .filter(Boolean).map(escapeHtml).join(' · ');
    const st = String(t.state || '');
    return '<div class="ev-dropdown-row" data-cmid="' + escapeHtml(t.id) + '">'
      + '<div class="ev-dropdown-logo-ph"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4v4h4"/><path d="M17 16v-4h-4"/><path d="M17 8A7 7 0 0 0 4.5 6"/><path d="M3 12a7 7 0 0 0 12.5 2"/></svg></div>'
      + '<div class="ev-dropdown-info"><div class="ev-dropdown-name">' + escapeHtml(t.name || 'Untitled') + '</div>'
      + '<div class="ev-dropdown-meta">' + meta + '</div></div>'
      + '<span class="ev-dropdown-badge" style="background:rgba(0,0,0,.2); color:' + (STATE_COLORS[st] || '#6b7280') + '; text-transform:capitalize;">'
      + escapeHtml(st ? st.charAt(0) + st.slice(1).toLowerCase() : '') + '</span></div>';
  }).join('');
  box.style.display = 'block';
}

el('ev-cm-search')?.addEventListener('input', (e) => {
  const v = e.target.value;
  const clear = el('ev-cm-clear'); if (clear) clear.style.display = v ? '' : 'none';
  _evCmPick = '';
  clearTimeout(_evCmSearchTimer);
  // A pasted link resolves instantly; a typed search waits for the producer to stop typing.
  _evCmSearchTimer = setTimeout(() => evCmSearch(v), looksLikeChallengermodeLink(v) ? 0 : 250);
});

el('ev-cm-clear')?.addEventListener('click', () => {
  const inp = el('ev-cm-search'); if (inp) inp.value = '';
  _evCmPick = '';
  const box = el('ev-cm-results'); if (box) box.style.display = 'none';
  const clear = el('ev-cm-clear'); if (clear) clear.style.display = 'none';
});

el('ev-cm-results')?.addEventListener('click', (e) => {
  const item = e.target.closest('[data-cmid]');
  if (!item) return;
  _evCmPick = item.dataset.cmid;
  const inp = el('ev-cm-search');
  const nameEl = item.querySelector('.ev-dropdown-name');
  if (inp && nameEl) inp.value = nameEl.textContent;
  const box = el('ev-cm-results'); if (box) box.style.display = 'none';
});

// Focusing the empty box offers the Space list straight away, same as the Challonge picker.
el('ev-cm-search')?.addEventListener('focus', () => {
  const cm = currentState.challengermode || {};
  const box = el('ev-cm-results');
  if (!box) return;
  if (!cm.hasKey) {
    box.innerHTML = '<div class="ev-dropdown-msg" style="color:#f59e0b;">Add a Challengermode refresh key under Apps > Challengermode first.</div>';
    box.style.display = 'block';
    return;
  }
  evCmSearch(el('ev-cm-search').value);
});

// Click-away closes it, matching every other picker on this page.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ev-cm-search-wrap') && !e.target.closest('#ev-cm-results')) {
    const box = el('ev-cm-results'); if (box) box.style.display = 'none';
  }
});

el('cm-autofollow-queue')?.addEventListener('change', (e) => {
  send('set_challengermode_auto_follow', { enabled: e.target.checked });
});

function renderDashChallengermodeQueue(queue, fetchedAt) {
  const container = el('dash-cm-queue');
  const status = el('dash-cm-queue-status');
  if (!container) return;
  // RUNNING and WAITING are the playable states; the server has already sorted live-first.
  const open = (queue || []).filter((m) => m.state === 'RUNNING' || m.state === 'WAITING' || m.state === 'PAUSED');
  if (!open.length) {
    container.innerHTML = '<div style="font-size:12px; color:var(--muted); padding:4px 0;">No open matches.</div>';
  } else {
    container.innerHTML = '';
    open.slice(0, 6).forEach((m) => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:5px; background:rgba(255,255,255,.04); margin-bottom:4px; border:1px solid ${m.live ? 'rgba(236,72,153,.3)' : 'var(--border)'};`;
      const bo = m.bestOf ? `<span style="font-size:9px; color:var(--muted); flex-shrink:0;">BO${m.bestOf}</span>` : '';
      row.innerHTML = `
        ${m.live ? '<span style="font-size:9px; font-weight:700; color:#7C3AED; flex-shrink:0;">LIVE</span>' : `<span style="font-size:9px; color:var(--muted); flex-shrink:0;">${escapeHtml(m.round || 'M')}</span>`}
        <span style="flex:1; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(m.teamA || 'TBD')} <span style="color:var(--muted);">vs</span> ${escapeHtml(m.teamB || 'TBD')}</span>
        ${bo}
        <button class="btn btn-ghost btn-xs cm-dash-set-live" style="flex-shrink:0;">Set Live</button>`;
      row.querySelector('.cm-dash-set-live').addEventListener('click', () => {
        send('set_team', { side: 'blue', name: m.teamA || '', ...(m.logoA ? { logo: m.logoA } : {}) });
        send('set_team', { side: 'orange', name: m.teamB || '', ...(m.logoB ? { logo: m.logoB } : {}) });
        // Following a series without its format leaves the scorebar on the previous match's
        // best-of, which is wrong on screen the moment the first game ends.
        if (m.bestOf) send('set_best_of', { value: m.bestOf });
      });
      container.appendChild(row);
    });
  }
  if (status && fetchedAt) status.textContent = `Updated ${new Date(fetchedAt).toLocaleTimeString()}`;
}

// Challonge search wiring
(function wireChallongeEventPicker() {
  const searchInput = el('ev-challonge-search');
  const resultsDiv = el('ev-challonge-results');
  const clearBtn = el('ev-challonge-clear');
  if (!searchInput || !resultsDiv) return;

  async function loadChalTournaments() {
    resultsDiv.innerHTML = '<div class="ev-dropdown-msg">Loading your Challonge tournaments…</div>';
    resultsDiv.style.display = 'block';
    try {
      const resp = await fetch('http://127.0.0.1:3000/api/challonge/my-tournaments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await resp.json();
      _evChalMyTourneys = resp.ok ? (data.tournaments || []) : [];
      renderChalDropdown(_evChalMyTourneys, '');
    } catch (e) {
      _evChalMyTourneys = [];
      resultsDiv.innerHTML = `<div class="ev-dropdown-msg" style="color:#ef4444;">Error: ${e.message}</div>`;
    }
  }

  searchInput.addEventListener('focus', () => {
    if (!currentState.challonge?.hasKey) {
      resultsDiv.innerHTML = '<div class="ev-dropdown-msg" style="color:#f59e0b;">Add a Challonge API key under Apps > Challonge first.</div>';
      resultsDiv.style.display = 'block';
      return;
    }
    if (_evChalMyTourneys !== null) {
      renderChalDropdown(_evChalMyTourneys, searchInput.value.trim().toLowerCase());
      resultsDiv.style.display = 'block';
      return;
    }
    loadChalTournaments();
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
    clearTimeout(_evChalSearchTimer);
    _evChalSearchTimer = setTimeout(() => {
      if (_evChalMyTourneys !== null) renderChalDropdown(_evChalMyTourneys, q.toLowerCase());
    }, 60);
  });

  if (clearBtn) clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    _evChallongeSlug = '';
    if (_evChalMyTourneys !== null) renderChalDropdown(_evChalMyTourneys, '');
    searchInput.focus();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ev-challonge-search-wrap') && !e.target.closest('#ev-challonge-results')) {
      resultsDiv.style.display = 'none';
    }
  }, true);
})();

function renderChalDropdown(tournaments, filterQuery) {
  const container = el('ev-challonge-results');
  if (!container) return;
  const filtered = NESearch.filter(tournaments, filterQuery,
    (t) => [{ text: t.name, weight: 2 }, t.slug, t.state]);
  if (!filtered.length) {
    container.innerHTML = filterQuery
      ? `<div class="ev-dropdown-msg">No match for "<strong>${escapeHtml(filterQuery)}</strong>"</div>`
      : '<div class="ev-dropdown-msg">No Challonge tournaments found.</div>';
    container.style.display = 'block';
    return;
  }
  container.innerHTML = '';
  if (!filterQuery) {
    const hdr = document.createElement('div');
    hdr.className = 'ev-dropdown-section-hdr';
    hdr.textContent = 'My Challonge Tournaments';
    container.appendChild(hdr);
  }
  filtered.forEach(t => {
    const row = document.createElement('div');
    row.className = 'ev-dropdown-row';
    const stateColors = { underway: '#10b981', pending: '#f59e0b', ended: '#6b7280' };
    const stateColor = stateColors[t.state] || '#6b7280';
    row.innerHTML = `
      <div class="ev-dropdown-logo-ph"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="8"/><path d="M10 6v4l3 2" stroke-linecap="round"/></svg></div>
      <div class="ev-dropdown-info">
        <div class="ev-dropdown-name">${escapeHtml(t.name || t.slug || '')}</div>
        <div class="ev-dropdown-meta">${[t.type, t.gameName, t.participantsCount ? `${t.participantsCount} teams` : ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>
      </div>
      <span class="ev-dropdown-badge" style="background:rgba(0,0,0,.2); color:${stateColor}; text-transform:capitalize;">${escapeHtml(t.state || '')}</span>`;
    row.addEventListener('click', () => {
      el('ev-challonge-search').value = t.name || t.slug;
      if (el('ev-challonge-clear')) el('ev-challonge-clear').style.display = 'block';
      container.style.display = 'none';
      _evChallongeSlug = t.slug || '';
      const status = el('ev-load-status');
      if (status) status.textContent = `"${t.name || t.slug}" selected — click Load Event`;
    });
    container.appendChild(row);
  });
  container.style.display = 'block';
}

// NXGEN event search wiring
(function wireNxgenEventPicker() {
  const searchInput = el('ev-nxgen-search');
  const resultsDiv  = el('ev-nxgen-results');
  const clearBtn    = el('ev-nxgen-clear');
  if (!searchInput || !resultsDiv) return;

  async function fetchNxgenEvents(query) {
    resultsDiv.innerHTML = '<div class="ev-dropdown-msg">Searching NXGEN events…</div>';
    resultsDiv.style.display = 'block';
    try {
      const resp = await fetch('http://127.0.0.1:3000/api/nxgen/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 30, includePast: true })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Request failed');
      renderNxgenDropdown(data.events || [], query.toLowerCase());
    } catch (e) {
      resultsDiv.innerHTML = `<div class="ev-dropdown-msg" style="color:#ef4444;">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  searchInput.addEventListener('focus', () => {
    if (!currentState.nxgen?.hasKey) {
      resultsDiv.innerHTML = '<div class="ev-dropdown-msg" style="color:#f59e0b;">Add a NXGEN API key under Apps > NXGEN first.</div>';
      resultsDiv.style.display = 'block';
      return;
    }
    fetchNxgenEvents(searchInput.value.trim());
    resultsDiv.style.display = 'block';
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
    clearTimeout(_evNxgenSearchTimer);
    _evNxgenSearchTimer = setTimeout(() => fetchNxgenEvents(q), 250);
  });

  if (clearBtn) clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    _evNxgenSlug = '';
    resultsDiv.style.display = 'none';
    searchInput.focus();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ev-nxgen-search-wrap') && !e.target.closest('#ev-nxgen-results')) {
      resultsDiv.style.display = 'none';
    }
  }, true);
})();

function renderNxgenDropdown(events, filterQuery) {
  const container = el('ev-nxgen-results');
  if (!container) return;
  const filtered = NESearch.filter(events, filterQuery,
    (ev) => [{ text: ev.name, weight: 2 }, ev.slug, ev.activity]);
  if (!filtered.length) {
    container.innerHTML = filterQuery
      ? `<div class="ev-dropdown-msg">No match for "<strong>${escapeHtml(filterQuery)}</strong>"</div>`
      : '<div class="ev-dropdown-msg">No NXGEN events found.</div>';
    container.style.display = 'block';
    return;
  }
  container.innerHTML = '';
  if (!filterQuery) {
    const hdr = document.createElement('div');
    hdr.className = 'ev-dropdown-section-hdr';
    hdr.textContent = 'NXGEN Events';
    container.appendChild(hdr);
  }
  const statusColors = { active: '#10b981', upcoming: '#f59e0b', completed: '#6b7280' };
  filtered.forEach(ev => {
    const row = document.createElement('div');
    row.className = 'ev-dropdown-row';
    const sc = statusColors[ev.status] || '#6b7280';
    const logoHtml = ev.coverImage
      ? `<img class="ev-dropdown-logo" src="${ev.coverImage}" alt="" onerror="this.style.display='none'">`
      : `<div class="ev-dropdown-logo-ph"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5l7 5-7 5V5z"/></svg></div>`;
    row.innerHTML = `${logoHtml}
      <div class="ev-dropdown-info">
        <div class="ev-dropdown-name">${escapeHtml(ev.name || ev.slug || '')}</div>
        <div class="ev-dropdown-meta">${[ev.activity, ev.eventDate, ev.participantCount ? `${ev.participantCount} participants` : ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>
      </div>
      <span class="ev-dropdown-badge" style="background:rgba(0,0,0,.2); color:${sc}; text-transform:capitalize;">${escapeHtml(ev.status || '')}</span>`;
    row.addEventListener('click', () => {
      const inp = el('ev-nxgen-search');
      if (inp) inp.value = ev.name || ev.slug;
      if (el('ev-nxgen-clear')) el('ev-nxgen-clear').style.display = 'block';
      container.style.display = 'none';
      _evNxgenSlug = ev.slug || '';
      const status = el('ev-load-status');
      if (status) status.textContent = `"${ev.name || ev.slug}" selected — click Load Event`;
    });
    container.appendChild(row);
  });
  container.style.display = 'block';
}

// FACEIT competition picker. With an organiser saved this lists THEIR championships and hubs
// (the useful default for a league producer); without one it falls back to a platform-wide
// championship search, and a pasted link always works regardless.
(function wireFaceitEventPicker() {
  const searchInput = el('ev-faceit-search');
  const resultsDiv  = el('ev-faceit-results');
  const clearBtn    = el('ev-faceit-clear');
  if (!searchInput || !resultsDiv) return;

  async function post(url, body) {
    const resp = await fetch('http://127.0.0.1:3000' + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function loadFaceitComps(query) {
    resultsDiv.innerHTML = '<div class="ev-dropdown-msg">Loading FACEIT competitions…</div>';
    resultsDiv.style.display = 'block';
    try {
      // Organiser list first — it's cached, so typing filters locally with no extra API calls.
      if (_evFaceitMyComps === null) {
        const mine = await post('/api/faceit/my-competitions', {});
        _evFaceitMyComps = mine.needsOrganizer ? [] : (mine.competitions || []);
      }
      if (_evFaceitMyComps.length) { renderFaceitDropdown(_evFaceitMyComps, (query || '').toLowerCase(), true); return; }
      if (!query) {
        resultsDiv.innerHTML = '<div class="ev-dropdown-msg">Type to search FACEIT championships, or paste a championship / hub link.<br><span style="opacity:.7;">Set your organiser name in Marketplace ▸ Integrations ▸ FACEIT to list your own competitions here.</span></div>';
        return;
      }
      const found = await post('/api/faceit/search', { name: query, limit: 30 });
      renderFaceitDropdown(found.competitions || [], '', false);
    } catch (e) {
      resultsDiv.innerHTML = `<div class="ev-dropdown-msg" style="color:#ef4444;">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  searchInput.addEventListener('focus', () => {
    if (!currentState.faceit?.hasKey) {
      resultsDiv.innerHTML = '<div class="ev-dropdown-msg" style="color:#f59e0b;">Add a FACEIT API key under Apps > FACEIT first.</div>';
      resultsDiv.style.display = 'block';
      return;
    }
    loadFaceitComps(searchInput.value.trim());
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
    // A pasted link is a direct load, not a search — say so instead of firing a useless query.
    if (/faceit\.com/i.test(q)) {
      _evFaceitPick = null;
      resultsDiv.innerHTML = '<div class="ev-dropdown-msg">FACEIT link detected — click <strong>Load Event</strong>.</div>';
      resultsDiv.style.display = 'block';
      return;
    }
    clearTimeout(_evFaceitSearchTimer);
    _evFaceitSearchTimer = setTimeout(() => loadFaceitComps(q), 300);
  });

  if (clearBtn) clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    _evFaceitPick = null;
    resultsDiv.style.display = 'none';
    searchInput.focus();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ev-faceit-search-wrap') && !e.target.closest('#ev-faceit-results')) {
      resultsDiv.style.display = 'none';
    }
  }, true);
})();

function renderFaceitDropdown(comps, filterQuery, isMine) {
  const container = el('ev-faceit-results');
  if (!container) return;
  const filtered = filterQuery
    ? NESearch.filter(comps, filterQuery, (c) => [{ text: c.name, weight: 2 }, c.game, c.region, c.organizer])
    : comps;
  if (!filtered.length) {
    container.innerHTML = filterQuery
      ? `<div class="ev-dropdown-msg">No match for "<strong>${escapeHtml(filterQuery)}</strong>"</div>`
      : '<div class="ev-dropdown-msg">No FACEIT competitions found.</div>';
    container.style.display = 'block';
    return;
  }
  container.innerHTML = '';
  const hdr = document.createElement('div');
  hdr.className = 'ev-dropdown-section-hdr';
  hdr.textContent = isMine ? 'My FACEIT Competitions' : 'FACEIT Championships';
  container.appendChild(hdr);
  const statusColors = { started: '#10b981', ongoing: '#10b981', upcoming: '#f59e0b', ready: '#f59e0b', hub: '#60a5fa', finished: '#6b7280', cancelled: '#6b7280' };
  filtered.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'ev-dropdown-row';
    const sc = statusColors[String(c.status || '').toLowerCase()] || '#6b7280';
    const logoHtml = c.avatar
      ? `<img class="ev-dropdown-logo" src="${c.avatar}" alt="" onerror="this.style.display='none'">`
      : '<div class="ev-dropdown-logo-ph"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h14l-5.5 6v5L8.5 17v-7L3 4z"/></svg></div>';
    row.innerHTML = `${logoHtml}
      <div class="ev-dropdown-info">
        <div class="ev-dropdown-name">${escapeHtml(c.name || c.id || '')}</div>
        <div class="ev-dropdown-meta">${[c.type === 'hub' ? 'Hub' : 'Championship', c.game, c.region, c.organizer, c.slots ? `${c.slots} slots` : ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>
      </div>
      <span class="ev-dropdown-badge" style="background:rgba(0,0,0,.2); color:${sc}; text-transform:capitalize;">${escapeHtml(c.status || '')}</span>`;
    row.addEventListener('click', () => {
      const inp = el('ev-faceit-search');
      if (inp) inp.value = c.name || c.id;
      if (el('ev-faceit-clear')) el('ev-faceit-clear').style.display = 'block';
      container.style.display = 'none';
      _evFaceitPick = { id: c.id, type: c.type || 'championship', name: c.name };
      const status = el('ev-load-status');
      if (status) status.textContent = `"${c.name || c.id}" selected — click Load Event`;
    });
    container.appendChild(row);
  });
  container.style.display = 'block';
}

function renderDashChallongeQueue(queue, fetchedAt) {
  const container = el('dash-challonge-queue');
  const status = el('dash-challonge-queue-status');
  if (!container) return;
  const open = (queue || []).filter(m => ['open', 'pending'].includes(m.state));
  if (!open.length) {
    container.innerHTML = '<div style="font-size:12px; color:var(--muted); padding:4px 0;">No open matches.</div>';
  } else {
    container.innerHTML = '';
    open.slice(0, 6).forEach(m => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:5px; background:rgba(255,255,255,.04); margin-bottom:4px; border:1px solid ${m.live ? 'rgba(236,72,153,.3)' : 'var(--border)'};`;
      row.innerHTML = `
        ${m.live ? '<span style="font-size:9px; font-weight:700; color:#7C3AED; flex-shrink:0;">LIVE</span>' : `<span style="font-size:9px; color:var(--muted); flex-shrink:0;">${escapeHtml(m.identifier || 'M')}</span>`}
        <span style="flex:1; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(m.teamA || 'TBD')} <span style="color:var(--muted);">vs</span> ${escapeHtml(m.teamB || 'TBD')}</span>
        <button class="btn btn-ghost btn-xs chal-dash-set-live" style="flex-shrink:0;">Set Live</button>`;
      row.querySelector('.chal-dash-set-live').addEventListener('click', () => {
        send('set_team', { side: 'blue',   name: m.teamA || '', ...(m.logoA ? { logo: m.logoA } : {}) });
        send('set_team', { side: 'orange', name: m.teamB || '', ...(m.logoB ? { logo: m.logoB } : {}) });
      });
      container.appendChild(row);
    });
  }
  if (status && fetchedAt) {
    status.textContent = `Updated ${new Date(fetchedAt).toLocaleTimeString()}`;
  }
}
