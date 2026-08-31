/* ─── leagues.js — Leagues domain (manual leagues: teams/free agents/salary, ──────
   enhanced standings, schedule/settings/overview sub-tabs, league banner).
   Extracted verbatim from app.js (2026-07). Loads after app.js; inbound calls
   (lgHydrate/lgRender/lgResolveTeam/evSetMode…) are all runtime, several already
   typeof-guarded at the call sites. */

// ── Leagues (manual: team / free-agent / salary) ──────────────────────────
let lgLeagues = [];
let lgActiveId = null;
let _lgSaveTimer = null;
let _lgSig = '';
let _lgActiveTab = 'overview';
// A server-side update (spectated-match auto-capture finalizing, a Ballchasing refresh
// completing, etc.) that arrived while a field in the Leagues panel had focus and couldn't be
// applied (see lgHydrate below). Left set until focus actually clears the panel — lgSave() checks
// it so the pending 400ms debounced save can't fire with our now-stale local copy and silently
// overwrite whatever the server just computed, which is exactly what used to happen.
let _lgHydratePending = null;
const lgUid = (p) => (p || 'id') + Math.random().toString(36).slice(2, 9);

function lgActive() { return lgLeagues.find((l) => l.id === lgActiveId) || null; }
function lgStatus(msg, ok) { const s = el('lg-status'); if (s) { s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)'); } }
function lgSave() {
  clearTimeout(_lgSaveTimer);
  _lgSaveTimer = setTimeout(() => {
    if (_lgHydratePending) { lgSave(); return; }   // still stale relative to a pending server update — retry later
    send('set_leagues', { leagues: lgLeagues });
  }, 400);
}

function lgHydrate(leagues) {
  const incoming = Array.isArray(leagues) ? leagues : [];
  const sig = JSON.stringify(incoming);
  if (sig === _lgSig) { _lgHydratePending = null; return; }   // no change — nothing pending either
  const panel = el('ev-leagues-panel');
  if (panel && panel.contains(document.activeElement)) {
    _lgHydratePending = incoming;   // don't clobber active edits — apply once focus clears (below)
    return;
  }
  _lgHydratePending = null;
  _lgSig = sig;
  lgLeagues = incoming;
  if (lgActiveId && !lgLeagues.some((l) => l.id === lgActiveId)) lgActiveId = null;
  if (el('ev-leagues-panel') && el('ev-leagues-panel').style.display !== 'none') lgRender();
}
// Once focus actually leaves the Leagues panel, apply whatever server update was left pending —
// otherwise it stayed invisible forever, and the producer's own next edit could still overwrite it.
document.addEventListener('focusout', () => {
  if (!_lgHydratePending) return;
  setTimeout(() => {   // let the new focus target (if any) settle before re-checking
    if (!_lgHydratePending) return;
    const panel = el('ev-leagues-panel');
    if (panel && panel.contains(document.activeElement)) return;   // focus moved to another field in the same panel
    const pending = _lgHydratePending;
    _lgHydratePending = null;
    lgHydrate(pending);
  }, 0);
});
function lgGameOptions(sel) {
  const games = currentState.games || {};
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Game —</option>' + Object.keys(games).map((id) => `<option value="${id}">${games[id].name || id}</option>`).join('');
  if (cur) sel.value = cur;
}
function lgNewPlayer() { return { id: lgUid('pl'), name: '', role: '', salary: 0, stats: '' }; }
function lgNewTeam() { return { id: lgUid('tm'), name: '', logo: null, players: [] }; }
function lgNewLeague() {
  return { id: lgUid('lg'), name: 'New League', game: currentState.activeGame || '', type: 'team', season: '', salaryCap: 0, starterCount: 3, logo: null, abbr: '', status: 'active', teams: [], freeAgents: [], standings: [], schedule: [], seasonHistory: [], scoring: { win: 3, loss: 0, draw: 1, otw: 2 }, playoffN: 4, tiebreak: 'gd', startggSource: '', linkedEventId: '' };
}

// Shared league-<select> populator, used everywhere a producer picks an in-app league (Team Record
// settings, Graphics ▸ Standings/Bracket/Schedule, legacy Standings pop-out). Signature-diffs against
// a data-sig attribute so it's a no-op (and never clobbers mid-edit) when the league list hasn't
// actually changed, and always skips while the element itself has focus.
// opts.placeholder: leading empty-value option text ('Select league…' default; pass null to omit it
//   entirely when the list is non-empty). opts.emptyPlaceholder: placeholder text used only when the
//   list is empty (falls back to opts.placeholder). opts.value: if provided, force the select's value
//   to this after (re)building — for callers where an external state field is authoritative; omit to
//   just preserve whatever was already selected.
function lgPopulateLeagueSelect(selectEl, leagues, opts) {
  if (!selectEl || document.activeElement === selectEl) return;
  opts = opts || {};
  const list = leagues || [];
  const hasPlaceholder = list.length ? (opts.placeholder !== null) : true;
  const placeholderText = list.length
    ? (opts.placeholder != null ? opts.placeholder : 'Select league…')
    : (opts.emptyPlaceholder != null ? opts.emptyPlaceholder : (opts.placeholder != null ? opts.placeholder : 'Select league…'));
  const sig = list.map((l) => l.id + ':' + (l.name || '')).join('|') + '::' + (hasPlaceholder ? placeholderText : '');
  if (selectEl.dataset.sig !== sig) {
    selectEl.dataset.sig = sig;
    const prev = selectEl.value;
    const optsHtml = list.map((l) => `<option value="${l.id}">${String(l.name || 'League').replace(/</g, '&lt;')}</option>`).join('');
    selectEl.innerHTML = hasPlaceholder ? (`<option value="">${placeholderText}</option>` + optsHtml) : optsHtml;
    if (prev && list.some((l) => String(l.id) === String(prev))) selectEl.value = prev;
  }
  if (opts.value !== undefined) selectEl.value = opts.value || '';
}

function lgRenderList() {
  const wrap = el('lg-list'); if (!wrap) return;
  const STATUS_LABELS = { active: 'Active', playoffs: 'Playoffs', offseason: 'Off-season', complete: 'Complete' };
  wrap.innerHTML = lgLeagues.length
    ? lgLeagues.map((l) => {
        const esc = (s) => (s || '').replace(/</g, '&lt;');
        const phText = l.abbr
          ? l.abbr.slice(0, 4)
          : (l.name || '').split(/\s+/).map((w) => w[0] || '').join('').slice(0, 4).toUpperCase() || '?';
        const logoHtml = l.logo
          ? `<img class="lg-list-logo" src="${l.logo}" alt="">`
          : `<div class="lg-list-logo-ph">${esc(phText)}</div>`;
        const status = l.status || 'active';
        return `<button class="lg-list-item${l.id === lgActiveId ? ' active' : ''}" data-id="${l.id}">
          ${logoHtml}
          <div class="lg-list-info">
            <span class="lg-list-name">${esc(l.name || 'League')}</span>
            <span class="lg-list-sub">
              <span class="lg-list-status" data-s="${status}"></span>
              ${esc(STATUS_LABELS[status] || status)} · ${(l.teams || []).length} teams
            </span>
          </div></button>`;
      }).join('')
    : '<div class="lg-empty" style="padding:14px;">No leagues yet.</div>';
  wrap.querySelectorAll('.lg-list-item').forEach((b) => b.addEventListener('click', () => { lgActiveId = b.dataset.id; lgRender(); }));
}
// One central team database: league teams REFERENCE a saved team (by name) and resolve their
// name/logo/roster live from currentState.savedTeams. Legacy embedded teams fall back to their
// own data and are flagged "unlinked" so they can be re-added from the library.
function lgResolveTeam(tm) {
  const key = ((tm && (tm.teamName || tm.name)) || '').trim().toLowerCase();
  const saved = (currentState.savedTeams || []).find((s) => (s.name || '').trim().toLowerCase() === key);
  if (saved) return { name: saved.name, logo: saved.logo || null, players: saved.players || [], linked: true };
  return { name: (tm && (tm.name || tm.teamName)) || 'Team', logo: (tm && tm.logo) || null, players: (tm && tm.players) || [], linked: false };
}
// Add a saved team (by name) to the active league as a reference. Returns true on success.
function lgAddTeamByName(name) {
  const lg = lgActive(); if (!lg || !name) return false;
  if ((lg.teams || []).some((t) => (t.teamName || t.name) === name)) { lgStatus('That team is already in this league.', false); return false; }
  lg.teams = lg.teams || [];
  lg.teams.push({ id: lgUid('tm'), teamName: name });   // reference, not a copy
  lgRenderTeams(); lgRenderStandingsTab(); lgSave();
  lgStatus(name + ' added.', true);
  return true;
}
// Import a saved event's roster as embedded (unlinked) teams — for a league scoped to just that
// one event, so producers don't have to add each team by hand from the central library. Embedded
// teams carry their own name/logo/players (lgResolveTeam's fallback path) rather than referencing
// currentState.savedTeams, so this never touches the shared team library.
function lgImportTeamsFromEvent(eventId) {
  const lg = lgActive(); if (!lg) return { added: 0, eventName: '' };
  const ev = (currentState.myEvents || []).find((e) => e.id === eventId);
  if (!ev) return { added: 0, eventName: '' };
  lg.teams = lg.teams || [];
  const existing = new Set(lg.teams.map((t) => lgResolveTeam(t).name.toLowerCase()));
  let added = 0;
  (ev.roster || []).forEach((rt) => {
    const name = (rt.name || '').trim();
    if (!name || existing.has(name.toLowerCase())) return;
    const players = (rt.players || []).map((p) => ({ id: lgUid('pl'), name: p.gamerTag || '', role: '', salary: 0, stats: '' }));
    lg.teams.push({ id: lgUid('tm'), name, logo: '', players });
    existing.add(name.toLowerCase());
    added++;
  });
  lg.linkedEventId = eventId;
  lgRenderTeams(); lgRenderStandingsTab(); lgRenderList(); lgUpdateBanner(); lgSave();
  return { added, eventName: ev.name || '' };
}
// Go-Live matchup launcher: pick two league teams → push to Blue/Orange + reset series.
function lgRenderMatchup() {
  const lg = lgActive(); const home = el('lg-mu-home'), away = el('lg-mu-away'); if (!lg || !home || !away) return;
  const teams = (lg.teams || []).map((t) => lgResolveTeam(t).name);
  const opts = (sel) => '<option value="">— team —</option>' + teams.map((n) => `<option value="${(n || '').replace(/"/g, '&quot;')}"${n === sel ? ' selected' : ''}>${(n || '').replace(/</g, '&lt;')}</option>`).join('');
  const ph = home.value, pa = away.value;
  home.innerHTML = opts(ph); away.innerHTML = opts(pa);
  const sec = el('lg-golive-section'); if (sec) sec.style.display = teams.length >= 2 ? '' : 'none';
}
// Normalize a name/gamertag for matching (mirrors the server's _bcNorm).
function lgNorm(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
// A normalized-name → ballchasing-player-stats index for the active league (empty until a refresh).
function lgBcByName(lg) {
  const out = {};
  Object.values((lg && lg.ballchasingPlayers) || {}).forEach((p) => { const k = lgNorm(p.name); if (k) out[k] = p; });
  return out;
}

// Rank of each team by its position in lg.standings (the table's own order). Teams that have no
// standings row yet rank after everyone who does, so a fresh league still renders sensible cards.
function lgRankMap(lg) {
  const out = {}; let n = 0;
  (lg.standings || []).forEach((s) => { if ((lg.teams || []).some((t) => t.id === s.teamId)) out[s.teamId] = ++n; });
  (lg.teams || []).forEach((t) => { if (!out[t.id]) out[t.id] = ++n; });
  return out;
}
function lgDivName(lg, teamId) {
  const d = lgDivisions(lg).find((x) => x.id === lgTeamDivId(lg, teamId));
  return d ? d.name : '';
}

// "Send to BR lobby" only makes sense for a league on a battle-royale game — a Rocket League
// league has no lobby to send a field into. The list of BR games comes from the server
// (brMeta.lobbyGames), so adding a game there lights this button up with no change here.
function lgSyncBrSend(lg) {
  const btn = el('lg-send-br');
  if (!btn) return;
  const games = ((currentState && currentState.brMeta && currentState.brMeta.lobbyGames) || []);
  btn.style.display = (lg && games.includes(lg.game)) ? '' : 'none';
}

function lgRenderTeams() {
  const wrap = el('lg-teams'); const lg = lgActive(); if (!wrap || !lg) return;
  lgRenderMatchup();
  lgSyncBrSend(lg);
  const isSalary = lg.type === 'salary';
  const cap = lg.salaryCap || 0;
  const starterCount = lg.starterCount || 3;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const stById = {}; (lg.standings || []).forEach((s) => { stById[s.teamId] = s; });
  const bcByName = lgBcByName(lg);
  const hasBc = Object.keys(bcByName).length > 0;
  const ranks = lgRankMap(lg);
  const gs = lgGameStats(lg.game);
  const playoffN = lg.playoffN || 0;
  wrap.innerHTML = (lg.teams || []).map((tm) => {
    const r = lgResolveTeam(tm);
    const roster = r.players || [];
    let starterUsed = 0, starterIdx = 0;
    const players = roster.map((p) => {
      const pid = p.id || p.name || '';
      const sal = (tm.salaries && tm.salaries[pid] != null) ? tm.salaries[pid] : (p.salary || 0);
      const isStarter = starterIdx < starterCount; starterIdx++;
      if (isSalary && isStarter) starterUsed += Number(sal) || 0;
      const role = esc(p.role);
      const isCap = tm.captain && lgNorm(tm.captain) === lgNorm(p.name);
      const bc = bcByName[lgNorm(p.name)];
      const statChips = bc ? `<span class="lg-pl-stats" title="Ballchasing: ${bc.games || 0} games">
        <span class="lg-pl-stat"><b>${bc.goals || 0}</b>G</span><span class="lg-pl-stat"><b>${bc.assists || 0}</b>A</span><span class="lg-pl-stat"><b>${bc.saves || 0}</b>Sv</span></span>` : '';
      return `<div class="lg-player">
        <button class="lg-cap-star${isCap ? ' on' : ''}" data-tid="${esc(tm.id)}" data-pname="${esc(p.name)}" title="${isCap ? 'Captain' : 'Set as captain'}">★</button>
        <span class="lg-pl-name">${esc(p.name) || '—'}</span>
        ${role ? `<span class="lg-pl-role">${role}</span>` : ''}
        ${!isStarter && isSalary ? '<span class="lg-pl-role" style="color:var(--muted);font-style:italic;">Sub</span>' : ''}
        ${statChips}
        ${isSalary ? `<input type="number" class="input-text lg-pl-salary" data-tid="${esc(tm.id)}" data-pid="${esc(pid)}" value="${Number(sal) || 0}" placeholder="Rating" style="width:82px;" title="${isStarter ? 'Counts toward cap' : 'Sub — excluded from cap'}">` : ''}
      </div>`;
    }).join('') || '<div class="lg-empty" style="padding:4px 0;">No players in the library — use Manage teams to add a roster.</div>';
    const pct = cap > 0 ? Math.min((starterUsed / cap) * 100, 110) : 0;
    const over = cap > 0 && starterUsed > cap;
    const capBar = isSalary && cap > 0 ? `<div class="lg2-cap-bar-wrap">
      <div class="lg2-cap-label"><span>Rating used (starters)</span><span>${starterUsed} / ${cap}${over ? ' ⚠ over' : ''}</span></div>
      <div class="lg2-cap-bar"><div class="lg2-cap-bar-fill${over ? ' over' : ''}" style="width:${Math.min(pct,100)}%"></div></div>
    </div>` : '';
    const st = stById[tm.id] || {};
    const rank = ranks[tm.id] || 0;
    const inPlayoff = playoffN > 0 && rank <= playoffN;
    const diff = (st.gf || 0) - (st.ga || 0);
    const form = (st.form || []).slice(-5).map((f) => `<span class="lg2-fd lg2-fd-${String(f).toLowerCase()}">${esc(f)}</span>`).join('');
    const divName = lgDivName(lg, tm.id);
    // Neutral league-management stat strip: rank, record, points, differential, streak, form.
    // Deliberately carries NO side colour — which team is blue/orange is a per-match broadcast
    // decision made on the Overview → Broadcast card, not a property of the team.
    const statStrip = `<div class="lg-team-stats">
      <div class="lg-tstat"><span class="lg-tstat-v">${st.w || 0}<span class="lg-tstat-dash">-</span>${st.l || 0}${st.t ? '<span class="lg-tstat-dash">-</span>' + st.t : ''}</span><span class="lg-tstat-l">Record</span></div>
      <div class="lg-tstat"><span class="lg-tstat-v">${st.pts || 0}</span><span class="lg-tstat-l">Points</span></div>
      ${gs.sub ? `<div class="lg-tstat"><span class="lg-tstat-v">${st.subW || 0}<span class="lg-tstat-dash">-</span>${st.subL || 0}</span><span class="lg-tstat-l">${esc(gs.sub.noun)}</span></div>` : ''}
      ${gs.unit ? `<div class="lg-tstat"><span class="lg-tstat-v ${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">${diff > 0 ? '+' : ''}${diff}</span><span class="lg-tstat-l">Diff</span></div>` : ''}
      <div class="lg-tstat"><span class="lg-tstat-v">${esc(st.streak || '—')}</span><span class="lg-tstat-l">Streak</span></div>
      <div class="lg-tstat lg-tstat-form"><span class="lg-tstat-v">${form || '<span class="lg-tstat-dash">—</span>'}</span><span class="lg-tstat-l">Last 5</span></div>
    </div>`;
    return `<div class="lg-team" data-tid="${tm.id}">
      <div class="lg-team-head">
        <span class="lg-team-rank${inPlayoff ? ' in-playoff' : ''}" title="${inPlayoff ? 'Playoff position' : 'League position'}">${rank || '—'}</span>
        <img class="lg-team-logo${r.logo ? '' : ' game-logo-white'}" src="${r.logo || gameLogo()}" alt="" onerror="this.onerror=null;this.src='../assets/rl.png';">
        <div class="lg-team-idbox">
          <span class="lg-team-name">${esc(r.name)}</span>
          <span class="lg-team-sub">${[divName && esc(divName), `${roster.length} player${roster.length === 1 ? '' : 's'}`, tm.franchiseOwner ? esc(tm.franchiseOwner) : ''].filter(Boolean).join(' · ')}</span>
        </div>
        ${r.linked ? '' : '<span class="lg-unlinked" title="Not in the team library">unlinked</span>'}
        <button class="btn btn-ghost btn-xs lg-team-detail" data-tid="${tm.id}" title="Open the full team profile">Details</button>
        <button class="lg-del lg-team-del" data-tid="${tm.id}" title="Remove from league">&#215;</button>
      </div>
      ${statStrip}
      ${capBar}
      <div class="lg2-team-meta">
        <input type="text" class="input-text lg2-abbr-team-inp lg2-team-abbr" data-tid="${tm.id}" value="${esc(tm.abbr || '')}" placeholder="Abbr" title="Team abbreviation (e.g. BDG)">
        <input type="text" class="input-text lg2-owner-inp lg2-team-owner" data-tid="${tm.id}" value="${esc(tm.franchiseOwner || '')}" placeholder="Franchise owner">
      </div>
      <div class="lg-players">${players}</div>
    </div>`;
  }).join('') || '<div class="lg-empty">No teams yet — add from your team library above.</div>';

  lgRenderRosterCounts(lg, hasBc);

  wrap.querySelectorAll('.lg-cap-star').forEach((b) => b.addEventListener('click', () => {
    const tm = lg.teams.find((t) => t.id === b.dataset.tid); if (!tm) return;
    tm.captain = (tm.captain && lgNorm(tm.captain) === lgNorm(b.dataset.pname)) ? '' : b.dataset.pname;   // toggle
    lgSave(); lgRenderTeams();
  }));
  wrap.querySelectorAll('.lg-pl-salary').forEach((inp) => inp.addEventListener('change', () => {
    const tm = lg.teams.find((t) => t.id === inp.dataset.tid); if (!tm) return;
    tm.salaries = tm.salaries || {};
    tm.salaries[inp.dataset.pid] = Number(inp.value) || 0;
    lgSave(); lgRenderTeams();
  }));
  wrap.querySelectorAll('.lg2-team-abbr').forEach((inp) => inp.addEventListener('change', () => {
    const tm = lg.teams.find((t) => t.id === inp.dataset.tid); if (!tm) return;
    tm.abbr = inp.value.toUpperCase().trim().slice(0, 6); lgSave();
  }));
  wrap.querySelectorAll('.lg2-team-owner').forEach((inp) => inp.addEventListener('change', () => {
    const tm = lg.teams.find((t) => t.id === inp.dataset.tid); if (!tm) return;
    tm.franchiseOwner = inp.value.trim(); lgSave();
  }));
  wrap.querySelectorAll('.lg-team-del').forEach((b) => b.addEventListener('click', () => { lg.teams = lg.teams.filter((t) => t.id !== b.dataset.tid); lgRenderTeams(); lgRenderStandingsTab(); lgSave(); }));
  wrap.querySelectorAll('.lg-team-detail').forEach((b) => b.addEventListener('click', () => lgOpenTeamDetail(b.dataset.tid)));
}

// ── Team detail drawer ───────────────────────────────────────────────────────
// A team's full league profile in one place: position + record, season stat totals, the roster
// with per-player numbers, this team's fixtures (played and upcoming) and its head-to-head record
// against everyone else. Read-only by design — editing still happens on the tab that owns the data.
function lgOpenTeamDetail(teamId) {
  const lg = lgActive(); if (!lg) return;
  const tm = (lg.teams || []).find((t) => t.id === teamId); if (!tm) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r = lgResolveTeam(tm);
  const st = (lg.standings || []).find((s) => s.teamId === teamId) || {};
  const ranks = lgRankMap(lg);
  const gs = lgGameStats(lg.game);
  const nameOf = (id) => { const t = (lg.teams || []).find((x) => x.id === id); return t ? lgResolveTeam(t).name : 'TBD'; };
  const logoOf = (id) => { const t = (lg.teams || []).find((x) => x.id === id); return (t && lgResolveTeam(t).logo) || ''; };

  // Fixtures involving this team, split by whether a result has been entered.
  const mine = (lg.schedule || []).filter((m) => m.teamA === teamId || m.teamB === teamId);
  const h2h = {};   // opponentId -> { w, l, t }
  const fixtureRow = (m) => {
    const home = m.teamA === teamId;
    const oppId = home ? m.teamB : m.teamA;
    const played = (Array.isArray(m.games) && m.games.length) || (m.result && m.result.scoreA != null && m.result.scoreB != null);
    if (!played) {
      return `<div class="lgtd-fix"><span class="lgtd-fix-wk">${m.week ? 'Wk ' + esc(m.week) : '—'}</span>
        <img class="lgtd-fix-logo" src="${logoOf(oppId) || gameLogo()}" onerror="this.style.visibility='hidden'">
        <span class="lgtd-fix-opp">${esc(nameOf(oppId))}</span>
        <span class="lgtd-fix-when">${esc([m.date, m.time].filter(Boolean).join(' ')) || 'Unscheduled'}</span></div>`;
    }
    const { sa, sb } = lgMatchTally(m);
    const mineScore = home ? sa : sb, theirs = home ? sb : sa;
    const res = mineScore > theirs ? 'w' : mineScore < theirs ? 'l' : 'd';
    const hh = h2h[oppId] = h2h[oppId] || { w: 0, l: 0, t: 0 };
    if (res === 'w') hh.w++; else if (res === 'l') hh.l++; else hh.t++;
    return `<div class="lgtd-fix lgtd-fix-done"><span class="lgtd-fix-wk">${m.week ? 'Wk ' + esc(m.week) : '—'}</span>
      <img class="lgtd-fix-logo" src="${logoOf(oppId) || gameLogo()}" onerror="this.style.visibility='hidden'">
      <span class="lgtd-fix-opp">${esc(nameOf(oppId))}</span>
      <span class="lgtd-fix-score lgtd-${res}">${mineScore}<span class="lg-tstat-dash">-</span>${theirs}</span></div>`;
  };
  const playedRows = mine.filter((m) => (Array.isArray(m.games) && m.games.length) || (m.result && m.result.scoreA != null)).map(fixtureRow).join('');
  const upcomingRows = mine.filter((m) => !((Array.isArray(m.games) && m.games.length) || (m.result && m.result.scoreA != null))).map(fixtureRow).join('');
  const h2hRows = Object.entries(h2h).map(([oid, v]) => `<div class="lgtd-h2h"><span class="lgtd-h2h-opp">${esc(nameOf(oid))}</span><span class="lgtd-h2h-rec">${v.w}<span class="lg-tstat-dash">-</span>${v.l}${v.t ? '<span class="lg-tstat-dash">-</span>' + v.t : ''}</span></div>`).join('');

  // Roster with whatever per-player stats we have (Ballchasing sync, when it's populated).
  const bcByName = lgBcByName(lg);
  const rosterRows = (r.players || []).map((p) => {
    const bc = bcByName[lgNorm(p.name)] || null;
    const isCap = tm.captain && lgNorm(tm.captain) === lgNorm(p.name);
    return `<div class="lgtd-pl">
      <span class="lgtd-pl-name">${isCap ? '<span class="lg-players-table lg-pt-cap" style="color:#f5b942">&#9733;</span> ' : ''}${esc(p.name) || '—'}</span>
      <span class="lgtd-pl-role">${esc(p.role || '')}</span>
      ${bc ? `<span class="lgtd-pl-stats"><b>${bc.goals || 0}</b>G <b>${bc.assists || 0}</b>A <b>${bc.saves || 0}</b>Sv <b>${bc.mvps || 0}</b>MVP</span>` : '<span class="lgtd-pl-stats lgtd-dim">no stats</span>'}
    </div>`;
  }).join('') || '<div class="lg-empty" style="padding:8px 0;">No roster in the team library.</div>';

  // Season in-game totals a producer entered on the Stats tab.
  const inSet = LG_STAT_SETS[lg.game] || [];
  const ts = (lg.stats || {})[teamId] || {};
  const statTiles = inSet.map((label) => `<div class="lgtd-tile"><span class="lgtd-tile-v">${ts[lgStatKey(label)] ?? '—'}</span><span class="lgtd-tile-l">${esc(label)}</span></div>`).join('');

  const diff = (st.gf || 0) - (st.ga || 0);
  const head = `<div class="lgtd-head">
    <img class="lgtd-logo" src="${r.logo || gameLogo()}" onerror="this.style.visibility='hidden'">
    <div class="lgtd-head-id">
      <div class="lgtd-name">${esc(r.name)}${tm.abbr ? `<span class="lgtd-abbr">${esc(tm.abbr)}</span>` : ''}</div>
      <div class="lgtd-sub">${[lgDivName(lg, teamId), tm.franchiseOwner, lg.season].filter(Boolean).map(esc).join(' · ') || esc(lg.name || '')}</div>
    </div>
    <div class="lgtd-rank"><span class="lgtd-rank-v">#${ranks[teamId] || '—'}</span><span class="lgtd-rank-l">in league</span></div>
  </div>
  <div class="lgtd-kpis">
    <div class="lgtd-kpi"><span class="lgtd-kpi-v">${st.w || 0}<span class="lg-tstat-dash">-</span>${st.l || 0}${st.t ? '<span class="lg-tstat-dash">-</span>' + st.t : ''}</span><span class="lgtd-kpi-l">Series</span></div>
    <div class="lgtd-kpi"><span class="lgtd-kpi-v">${st.pts || 0}</span><span class="lgtd-kpi-l">Points</span></div>
    ${gs.sub ? `<div class="lgtd-kpi"><span class="lgtd-kpi-v">${st.subW || 0}<span class="lg-tstat-dash">-</span>${st.subL || 0}</span><span class="lgtd-kpi-l">${esc(gs.sub.noun)}</span></div>` : ''}
    ${gs.unit ? `<div class="lgtd-kpi"><span class="lgtd-kpi-v ${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">${diff > 0 ? '+' : ''}${diff}</span><span class="lgtd-kpi-l">${esc(gs.unit.noun)} diff</span></div>` : ''}
    <div class="lgtd-kpi"><span class="lgtd-kpi-v">${esc(st.streak || '—')}</span><span class="lgtd-kpi-l">Streak</span></div>
  </div>`;

  const body = `${head}
  <div class="lgtd-cols">
    <section class="lgtd-sec"><h5>Roster</h5>${rosterRows}</section>
    <section class="lgtd-sec"><h5>Results</h5>${playedRows || '<div class="lg-empty" style="padding:8px 0;">No results yet.</div>'}</section>
    <section class="lgtd-sec"><h5>Upcoming</h5>${upcomingRows || '<div class="lg-empty" style="padding:8px 0;">Nothing scheduled.</div>'}</section>
    <section class="lgtd-sec"><h5>Head to head</h5>${h2hRows || '<div class="lg-empty" style="padding:8px 0;">No completed matchups yet.</div>'}</section>
    ${statTiles ? `<section class="lgtd-sec lgtd-sec-wide"><h5>Season totals</h5><div class="lgtd-tiles">${statTiles}</div></section>` : ''}
  </div>`;

  let box = el('lg-team-detail-modal');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lg-team-detail-modal';
    box.className = 'modal-container lgtd-modal';
    document.body.appendChild(box);
    box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('.lgtd-close')) box.classList.remove('active'); });
  }
  box.innerHTML = `<div class="modal-box lgtd-box">
    <div class="modal-header"><span>Team profile</span><button class="modal-close lgtd-close" type="button">&#215;</button></div>
    <div class="modal-body lgtd-body">${body}</div>
  </div>`;
  box.classList.add('active');
}
function lgRenderFreeAgents() {
  const sec = el('lg-fa-section'); const wrap = el('lg-freeagents'); const lg = lgActive(); if (!sec || !wrap || !lg) return;
  sec.style.display = (lg.type === 'freeagent') ? '' : 'none';
  if (lg.type !== 'freeagent') return;
  const isSalary = lg.type === 'salary';
  wrap.innerHTML = (lg.freeAgents || []).map((p) => `<div class="lg-player" data-pid="${p.id}">
    <input class="input-text lg-fa-name" data-pid="${p.id}" value="${(p.name || '').replace(/"/g, '&quot;')}" placeholder="Free agent">
    <input class="input-text lg-fa-role" data-pid="${p.id}" value="${(p.role || '').replace(/"/g, '&quot;')}" placeholder="Role">
    <input type="number" class="input-text lg-fa-salary" data-pid="${p.id}" value="${p.salary || 0}" placeholder="Asking" style="width:90px;">
    <input class="input-text lg-fa-stats" data-pid="${p.id}" value="${(p.stats || '').replace(/"/g, '&quot;')}" placeholder="Stats / notes">
    <button class="lg-del lg-fa-del" data-pid="${p.id}" title="Remove">×</button>
  </div>`).join('') || '<div class="lg-empty">No free agents listed.</div>';
  const bind = (cls, key, num) => wrap.querySelectorAll(cls).forEach((inp) => inp.addEventListener('change', () => { const p = lg.freeAgents.find((x) => x.id === inp.dataset.pid); if (p) { p[key] = num ? (Number(inp.value) || 0) : inp.value.trim(); lgSave(); } }));
  bind('.lg-fa-name', 'name'); bind('.lg-fa-role', 'role'); bind('.lg-fa-salary', 'salary', true); bind('.lg-fa-stats', 'stats');
  wrap.querySelectorAll('.lg-fa-del').forEach((b) => b.addEventListener('click', () => { lg.freeAgents = lg.freeAgents.filter((p) => p.id !== b.dataset.pid); lgRenderFreeAgents(); lgSave(); }));
}

// ── Roster sub-views (Teams | Players) ───────────────────────────────────────
let _lgRosterView = 'teams';
let _lgPlayerSort = { key: 'goals', dir: -1 };   // default: most goals first

function lgRenderRosterCounts(lg, hasBc) {
  const el0 = el('lg-roster-counts');
  if (el0) {
    const teams = (lg.teams || []).length;
    const players = (lg.teams || []).reduce((n, tm) => n + ((lgResolveTeam(tm).players || []).length), 0);
    el0.textContent = `${teams} team${teams === 1 ? '' : 's'} · ${players} player${players === 1 ? '' : 's'}`;
  }
  const note = el('lg-players-src-note');
  if (note) note.textContent = hasBc ? 'Stats via ballchasing.com' : (lg.game === 'rocket-league' ? 'Enable Ballchasing + Refresh Stats to populate' : 'Player stats populate for Rocket League (Ballchasing)');
}

// Assemble a league-wide player list: every rostered player across teams, each joined to its
// ballchasing stats by normalized name (0s when unmatched). Captains are flagged.
function lgLeaguePlayers(lg) {
  const bcByName = lgBcByName(lg);
  const rows = [];
  (lg.teams || []).forEach((tm) => {
    const r = lgResolveTeam(tm);
    (r.players || []).forEach((p) => {
      const bc = bcByName[lgNorm(p.name)] || {};
      rows.push({
        name: p.name || '—', role: p.role || '', team: r.name || tm.teamName || 'Team', teamId: tm.id,
        captain: !!(tm.captain && lgNorm(tm.captain) === lgNorm(p.name)),
        games: bc.games || 0, goals: bc.goals || 0, assists: bc.assists || 0,
        saves: bc.saves || 0, shots: bc.shots || 0, mvps: bc.mvps || 0, score: bc.score || 0,
        matched: !!bcByName[lgNorm(p.name)]
      });
    });
  });
  return rows;
}

function lgRenderRosterPlayers() {
  const wrap = el('lg-roster-players'); const lg = lgActive(); if (!wrap || !lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let rows = lgLeaguePlayers(lg);
  // lgNorm still strips punctuation on both sides (so "T.S.M" matches "TSM"), but the comparison
  // itself is the shared matcher, so a typo or an acronym finds the player too.
  const q = lgNorm((el('lg-players-search') || {}).value || '');
  if (q) rows = rows.filter((r) => NESearch.matches(q, [
    { text: lgNorm(r.name), weight: 2 }, lgNorm(r.team)
  ]));
  if (!rows.length) { wrap.innerHTML = '<div class="lg-empty">No players yet — add teams with rosters in the Teams view.</div>'; return; }
  const s = _lgPlayerSort;
  const sortKey = s.key;
  rows.sort((a, b) => {
    if (sortKey === 'name' || sortKey === 'team') return String(a[sortKey]).localeCompare(String(b[sortKey])) * s.dir;
    return ((a[sortKey] || 0) - (b[sortKey] || 0)) * s.dir;
  });
  // Rocket-League stat columns; for non-RL leagues only name/team/role show (stats stay 0/hidden).
  const isRL = lg.game === 'rocket-league';
  const statCols = isRL ? [['games', 'GP'], ['goals', 'G'], ['assists', 'A'], ['saves', 'Sv'], ['shots', 'Sh'], ['mvps', 'MVP']] : [];
  const arrow = (k) => sortKey === k ? (s.dir < 0 ? ' ▾' : ' ▴') : '';
  const th = (k, lbl, cls) => `<th class="lg-pt-sort${cls || ''}" data-sk="${k}">${esc(lbl)}${arrow(k)}</th>`;
  const head = '<th class="lg-pt-rank">#</th>' + th('name', 'Player', ' lg-pt-l') + th('team', 'Team', ' lg-pt-l') + statCols.map((c) => th(c[0], c[1])).join('');
  const body = rows.map((r, i) => {
    const cells = statCols.map((c) => `<td class="${sortKey === c[0] ? 'lg-pt-hot' : ''}">${r[c[0]] || 0}</td>`).join('');
    return `<tr>
      <td class="lg-pt-rank">${i + 1}</td>
      <td class="lg-pt-l"><span class="lg-pt-name">${r.captain ? '<span class="lg-pt-cap" title="Captain">★</span>' : ''}${esc(r.name)}</span>${r.role ? `<span class="lg-pt-role">${esc(r.role)}</span>` : ''}</td>
      <td class="lg-pt-l lg-pt-team">${esc(r.team)}</td>
      ${cells}
    </tr>`;
  }).join('');
  wrap.innerHTML = `<div class="lg2-st-scroll"><table class="lg2-st-table lg-players-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  wrap.querySelectorAll('.lg-pt-sort').forEach((h) => h.addEventListener('click', () => {
    const k = h.dataset.sk;
    if (_lgPlayerSort.key === k) _lgPlayerSort.dir *= -1;
    else _lgPlayerSort = { key: k, dir: (k === 'name' || k === 'team') ? 1 : -1 };
    lgRenderRosterPlayers();
  }));
}

function lgSetRosterView(v) {
  _lgRosterView = (v === 'players') ? 'players' : 'teams';
  document.querySelectorAll('#lg-roster-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.rv === _lgRosterView));
  const tv = el('lg-roster-teams-view'), pv = el('lg-roster-players-view');
  if (tv) tv.style.display = _lgRosterView === 'teams' ? '' : 'none';
  if (pv) pv.style.display = _lgRosterView === 'players' ? '' : 'none';
  if (_lgRosterView === 'players') lgRenderRosterPlayers();
  else { lgRenderTeams(); lgRenderFreeAgents(); }
}
// ── enhanced standings (W/L/T/GF/GA/PTS) ─────────────────────────────────
const LG_ST_KEY = 'ne_lg_standings_v1';
function lgStPrefs() { try { return Object.assign({ density: 'comfortable' }, JSON.parse(localStorage.getItem(LG_ST_KEY) || '{}')); } catch { return { density: 'comfortable' }; } }
function lgStSavePrefs(p) { try { localStorage.setItem(LG_ST_KEY, JSON.stringify(p)); } catch {} }
// Sort state — '' = manual (drag) order, 'auto' = the league's own rules (points + tiebreak), or any
// stat key. Remembered in prefs so Recalculate and the column headers keep honouring the producer's
// chosen ordering instead of silently snapping back to points every time.
let _lgStSort = (() => { const p = lgStPrefs(); return { key: p.sortKey || '', dir: p.sortDir === 1 ? 1 : -1 }; })();
function lgStSaveSort() { const p = lgStPrefs(); p.sortKey = _lgStSort.key; p.sortDir = _lgStSort.dir; lgStSavePrefs(p); }

// Metrics the Sort-by dropdown offers. The clickable column headers use the same keys/values, so the
// two surfaces are always describing the same ordering.
const LG_SORT_METRICS = [
  { key: 'auto',     label: 'League rules (Pts + tiebreak)' },
  { key: 'w',        label: 'Wins' },
  { key: 'l',        label: 'Losses' },
  { key: 't',        label: 'Draws' },
  { key: 'winpct',   label: 'Win %' },
  { key: 'pts',      label: 'Points' },
  { key: 'subW',     label: 'Games won',  needsSub: true },
  { key: 'subL',     label: 'Games lost', needsSub: true },
  { key: 'diff',     label: 'Difference', needsUnit: true },
  { key: 'gf',       label: 'For',        needsUnit: true },
  { key: 'ga',       label: 'Against',    needsUnit: true },
  { key: 'streak',   label: 'Streak' },
  { key: 'teamName', label: 'Team name' },
  { key: '',         label: 'Manual (drag order)' },
];
// Keys where "best" means lowest, so a fresh click/pick starts ascending.
const LG_SORT_ASC = new Set(['teamName', 'l', 'ga', 'subL']);
function lgStStreakVal(s) {
  const st = String(s.streak || ''); const n = Number(st.slice(1)) || 0;
  return st[0] === 'W' ? n : st[0] === 'L' ? -n : 0;
}
function lgStSortValue(s, key) {
  if (key === 'diff') return (s.gf || 0) - (s.ga || 0);
  if (key === 'winpct') { const g = (s.w || 0) + (s.l || 0) + (s.t || 0); return g ? ((s.w || 0) + (s.t || 0) * 0.5) / g : 0; }
  if (key === 'streak') return lgStStreakVal(s);
  return s[key] || 0;
}
function lgStSortLabel() {
  const m = LG_SORT_METRICS.find((x) => x.key === _lgStSort.key);
  return m ? m.label : 'League rules (Pts + tiebreak)';
}

// Ensure every team has a standings row (so sort/reorder covers unranked teams too).
function lgStEnsureRows(lg) {
  lg.standings = lg.standings || [];
  (lg.teams || []).forEach((tm) => { if (!lg.standings.find((s) => s.teamId === tm.id)) lg.standings.push({ teamId: tm.id, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0 }); });
}
// Reorder lg.standings by the current sort. Returns false when the table is in manual order (nothing
// to do) so callers can word their status message honestly. Does NOT save or re-render.
function lgStApplySort(lg) {
  const { key, dir } = _lgStSort;
  if (!lg || !key) return false;
  lgStEnsureRows(lg);
  if (key === 'auto') { lgSortManualStandings(lg); return true; }   // points, then the league tiebreak
  const nameOf = (s) => { const tm = (lg.teams || []).find((t) => t.id === s.teamId); return tm ? lgResolveTeam(tm).name : ''; };
  lg.standings.sort((a, b) => key === 'teamName'
    ? nameOf(a).localeCompare(nameOf(b)) * dir
    : (lgStSortValue(a, key) - lgStSortValue(b, key)) * dir);
  return true;
}
function lgStSortBy(key, keepDir) {
  const lg = lgActive(); if (!lg) return;
  const dir = keepDir ? _lgStSort.dir
    : (_lgStSort.key === key) ? -_lgStSort.dir
    : (LG_SORT_ASC.has(key) ? 1 : -1);
  _lgStSort = { key, dir };
  lgStSaveSort();
  lgStApplySort(lg);
  lgSave(); lgRenderStandingsTab();
}

// Divisions / conferences — a client-side grouping layer over the flat standings. Stored on the
// league (lg.divisions + per-team tm.divisionId); the server preserves unknown league fields through
// set_leagues, so this needs no server change. Empty = one ungrouped table (unchanged behaviour).
function lgDivisions(lg) { return Array.isArray(lg && lg.divisions) ? lg.divisions : []; }
function lgTeamDivId(lg, teamId) { const tm = (lg.teams || []).find((t) => t.id === teamId); return (tm && tm.divisionId) || ''; }
function lgRenderDivMgr() {
  const box = el('lg-st-divmgr'); const lg = lgActive(); if (!box || !lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const divs = lgDivisions(lg);
  box.innerHTML = `<div class="lg2-divmgr-inner">
    <div class="lg2-divmgr-list">${divs.map((d) => `<span class="lg2-divmgr-chip"><input class="lg2-div-rename" data-did="${esc(d.id)}" value="${esc(d.name)}"><button class="lg2-div-rm" data-did="${esc(d.id)}" title="Remove division">&#215;</button></span>`).join('') || '<span class="sr-summary">No divisions yet — add one to group the table.</span>'}</div>
    <div class="lg2-divmgr-add"><input id="lg-div-new" class="input-text" placeholder="New division name (e.g. East)" style="width:200px;"><button class="btn btn-secondary btn-sm" id="lg-div-add">+ Add</button></div>
  </div>`;
  el('lg-div-add')?.addEventListener('click', () => {
    const name = (el('lg-div-new')?.value || '').trim(); if (!name) return;
    lg.divisions = lgDivisions(lg).concat([{ id: 'dv_' + Math.random().toString(36).slice(2, 8), name }]);
    lgSave(); lgRenderDivMgr(); lgRenderStandingsTab();
  });
  box.querySelectorAll('.lg2-div-rename').forEach((inp) => inp.addEventListener('change', () => {
    const d = lgDivisions(lg).find((x) => x.id === inp.dataset.did); if (d) { d.name = inp.value.trim() || d.name; lgSave(); lgRenderStandingsTab(); }
  }));
  box.querySelectorAll('.lg2-div-rm').forEach((b) => b.addEventListener('click', () => {
    lg.divisions = lgDivisions(lg).filter((x) => x.id !== b.dataset.did);
    (lg.teams || []).forEach((tm) => { if (tm.divisionId === b.dataset.did) tm.divisionId = ''; });
    lgSave(); lgRenderDivMgr(); lgRenderStandingsTab();
  }));
}

// ── Standings source mode ────────────────────────────────────────────────────
// 'schedule' — the table is derived from results on the Schedule tab (Recalculate rebuilds it).
// 'manual'   — the table IS the record. Nothing has to exist on the schedule; points derive from
//              the scoring rules as you type W/L/T, and the drift banner + Recalculate stand down
//              so a hand-kept table is never second-guessed or overwritten.
// Existing leagues default to 'schedule', so nothing changes for anyone already using it that way.
// 'schedule' = computed from results on the Schedule tab (W/L).
// 'manual'   = typed by hand.
// 'points'   = totalled from the Tournaments tab's placement matrices. The server derives it
//              (see recomputeBrSeason, which mirrors the season table into lg.standings) so the
//              standings overlay and the team-record features work off it unchanged.
function lgStandingsMode(lg) {
  const m = lg && lg.standingsMode;
  return (m === 'manual' || m === 'points') ? m : 'schedule';
}
function lgStandingsRow(lg, teamId) {
  lg.standings = lg.standings || [];
  let s = lg.standings.find((x) => x.teamId === teamId);
  if (!s) { s = { teamId, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0, subW: 0, subL: 0, form: [], streak: '' }; lg.standings.push(s); }
  return s;
}
// Points from the league's own scoring rules. Skipped when the producer has typed a points value by
// hand (ptsLocked) — an override should survive the next W/L edit rather than being stomped.
function lgApplyScoring(lg, s) {
  if (s.ptsLocked) return s.pts || 0;
  const sc = lg.scoring || {};
  const ptsWin = sc.win ?? 3, ptsLoss = sc.loss ?? 0, ptsDraw = sc.draw ?? 1, ptsOtw = sc.otw ?? ptsWin;
  s.pts = (s.w || 0) * ptsWin + (s.otw || 0) * (ptsOtw - ptsWin) + (s.t || 0) * ptsDraw + (s.l || 0) * ptsLoss;
  return s.pts;
}
function lgRecalcStreak(s) {
  const f = s.form || [];
  if (!f.length) { s.streak = ''; return; }
  const last = f[f.length - 1]; let n = 0;
  for (let i = f.length - 1; i >= 0 && f[i] === last; i--) n++;
  s.streak = last + n;
}
// Order a manual table the same way the schedule aggregation does, so both modes rank identically.
function lgSortManualStandings(lg) {
  const tb = lg.tiebreak || 'gd';
  (lg.standings || []).sort((a, b) => {
    if ((b.pts || 0) !== (a.pts || 0)) return (b.pts || 0) - (a.pts || 0);
    if (tb === 'h2h') {
      const ah = (a.h2h && a.h2h[b.teamId]) || 0, bh = (b.h2h && b.h2h[a.teamId]) || 0;
      if (ah !== bh) return bh - ah;
    }
    const gd = ((b.gf || 0) - (b.ga || 0)) - ((a.gf || 0) - (a.ga || 0));
    if (gd !== 0) return gd;
    return (b.gf || 0) - (a.gf || 0);
  });
}

function lgRenderStandingsTab() {
  const wrap = el('lg-standings'); const lg = lgActive(); if (!wrap || !lg) return;
  const playoffN = lg.playoffN || 4;
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  const panel = el('lg2-panel-standings');
  if (panel) panel.classList.toggle('lg2-st-compact', lgStPrefs().density === 'compact');
  document.querySelectorAll('#lg-st-density .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.d === lgStPrefs().density));

  const mode = lgStandingsMode(lg);
  const manual = mode === 'manual';
  document.querySelectorAll('#lg-st-source .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.src === mode));
  const srcNote = el('lg-st-source-note');
  if (srcNote) srcNote.textContent = manual
    ? 'The table is the record — type it in, or log results below. Points follow your scoring rules automatically.'
    : 'Enter results on the Schedule tab, then Recalculate. Switch to Manual to type the table directly.';
  const qr = el('lg-quick-result'); if (qr) qr.style.display = manual ? '' : 'none';
  if (manual) lgRenderQuickResult();
  const recalcBtn = el('lg-recalc');
  if (recalcBtn) {
    recalcBtn.disabled = manual;
    recalcBtn.title = manual
      ? 'Disabled in Manual mode — recalculating would overwrite the table you typed with the schedule.'
      : 'Rebuild the table from the results on the Schedule tab';
  }

  // Sort-by control. Labels follow the game (Games/Maps, Goals/Rounds), and options that make no
  // sense for this game (no sub-unit, no score unit) are left out rather than sorting by zeroes.
  const sortSel = el('lg-st-sortby');
  if (sortSel) {
    const sortGs = lgGameStats(lg.game);
    sortSel.innerHTML = LG_SORT_METRICS
      .filter((m) => (!m.needsSub || sortGs.sub) && (!m.needsUnit || sortGs.unit))
      .map((m) => {
        let lbl = m.label;
        if (sortGs.sub && (m.key === 'subW' || m.key === 'subL')) lbl = sortGs.sub.noun + (m.key === 'subW' ? ' won' : ' lost');
        if (sortGs.unit && (m.key === 'gf' || m.key === 'ga')) lbl = sortGs.unit.noun + ' ' + (m.key === 'gf' ? 'for' : 'against');
        return `<option value="${m.key}"${m.key === _lgStSort.key ? ' selected' : ''}>${esc(lbl)}</option>`;
      }).join('');
  }
  const sortDirBtn = el('lg-st-sortdir');
  if (sortDirBtn) {
    const manualOrder = !_lgStSort.key;
    sortDirBtn.disabled = manualOrder || _lgStSort.key === 'auto';
    sortDirBtn.textContent = _lgStSort.dir < 0 ? '↓' : '↑';
    sortDirBtn.title = sortDirBtn.disabled
      ? 'Direction is fixed for this ordering'
      : (_lgStSort.dir < 0 ? 'Highest first — click for lowest first' : 'Lowest first — click for highest first');
  }

  const banner = el('lg-drift-banner');
  if (banner && manual) { banner.style.display = 'none'; banner.textContent = ''; }
  else if (banner) {
    const drift = lgStandingsDrift(lg);
    if (!drift.inSync) {
      banner.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:8px 12px;border-radius:8px;background:rgba(201,138,31,.12);border:1px solid rgba(201,138,31,.35);color:#c98a1f;font-size:12px;font-weight:600;';
      banner.textContent = `Standings differ from schedule results (${drift.diffCount} team${drift.diffCount === 1 ? '' : 's'}) — Recalculate to sync.`;
    } else {
      banner.style.display = 'none'; banner.textContent = '';
    }
  }

  // Cap display
  const capEl = el('lg-cap-used');
  if (capEl) {
    if (lg.type === 'salary' && lg.salaryCap) {
      const used = (lg.teams || []).reduce((sum, tm) => {
        const r = lgResolveTeam(tm);
        return sum + (r.players || []).reduce((a, p) => { const pid = p.id || p.name || ''; const sal = (tm.salaries && tm.salaries[pid] != null) ? tm.salaries[pid] : (p.salary || 0); return a + (Number(sal) || 0); }, 0);
      }, 0);
      capEl.textContent = `Cap: ${used.toLocaleString()} / ${Number(lg.salaryCap).toLocaleString()}`;
      capEl.style.color = used > lg.salaryCap ? '#f56565' : 'var(--muted)';
    } else capEl.textContent = '';
  }

  // Build rows in standings array order (preserves manual drag order / computed sort)
  const teamsMap = {}; (lg.teams || []).forEach(tm => { teamsMap[tm.id] = tm; });
  const byId = {}; (lg.standings || []).forEach(s => { byId[s.teamId] = s; });
  const ranked = (lg.standings || []).filter(s => teamsMap[s.teamId]);
  const rankedIds = new Set(ranked.map(s => s.teamId));
  const unranked = (lg.teams || []).filter(tm => !rankedIds.has(tm.id));
  const rows = [
    ...ranked.map(s => { const tm = teamsMap[s.teamId]; return { teamId: tm.id, teamName: lgResolveTeam(tm).name, w: s.w || 0, l: s.l || 0, t: s.t || 0, gf: s.gf || 0, ga: s.ga || 0, pts: s.pts || 0, subW: s.subW || 0, subL: s.subL || 0, form: s.form || [], streak: s.streak || '', ptsLocked: !!s.ptsLocked }; }),
    ...unranked.map(tm => ({ teamId: tm.id, teamName: lgResolveTeam(tm).name, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0, subW: 0, subL: 0, form: [], streak: '' }))
  ];

  if (!rows.length) { wrap.innerHTML = '<div class="lg-empty">Add teams to track standings.</div>'; return; }
  const formDots = (form) => form.map(f => `<span class="lg2-fd lg2-fd-${f.toLowerCase()}">${f}</span>`).join('');
  const gs = lgGameStats(lg.game);
  const u = gs.unit;
  const showDraw = rows.some(r => (r.t || 0) > 0) || (!gs.series && lg.scoring && lg.scoring.draw != null && Number(lg.scoring.draw) !== 0);
  const divs = lgDivisions(lg);
  const hasDivs = divs.length > 0;
  // Sortable header cell: clicking a stat column sorts lg.standings by it (arrow shows active key/dir).
  const sortArrow = (k) => _lgStSort.key === k ? (_lgStSort.dir < 0 ? ' ▾' : ' ▴') : '';
  const sTh = (k, lbl, title) => `<th class="lg2-st-sort" data-sk="${k}"${title ? ` title="${title}"` : ''}>${lbl}${sortArrow(k)}</th>`;
  let head = '<th class="lg2-drag-th"></th><th>#</th>' + sTh('teamName', 'Team') + sTh('w', 'W', 'Series won') + sTh('l', 'L', 'Series lost');
  if (showDraw) head += sTh('t', 'T', 'Series tied');
  if (gs.sub) head += sTh('subW', esc(gs.sub.abbr) + 'W', esc(gs.sub.noun) + ' won') + sTh('subL', esc(gs.sub.abbr) + 'L', esc(gs.sub.noun) + ' lost');
  if (u) head += sTh('gf', 'For', esc(u.noun) + ' scored') + sTh('ga', 'Against', esc(u.noun) + ' conceded') + sTh('diff', 'Diff', esc(u.noun) + ' difference');
  head += sTh('pts', 'Pts') + '<th>Form</th><th title="Current win/loss streak">Streak</th>';
  if (hasDivs) head += '<th title="Division">Div</th>';
  const numInp = (r, key, min) => `<td><input type="number" class="input-text lg2-st-inp" data-tid="${r.teamId}" data-key="${key}" value="${r[key]}"${min != null ? ` min="${min}"` : ''}></td>`;
  const divSel = (r) => hasDivs ? `<td><select class="input-select lg2-st-div" data-tid="${r.teamId}"><option value="">—</option>${divs.map((d) => `<option value="${esc(d.id)}"${lgTeamDivId(lg, r.teamId) === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select></td>` : '';
  // One team-row; rank is passed in so divisions can rank within each group. Playoff zone = rank ≤ N.
  const rowHtml = (r, rank) => {
    const zone = rank <= playoffN ? ' lg2-st-playoff' : '';
    const cut = rank === playoffN ? ' lg2-st-cut' : '';
    let c = `<td class="lg2-drag-cell"><span class="lg2-drag-handle" title="Drag to reorder"></span></td>`
      + `<td class="lg2-pos">${rank <= playoffN ? '<span class="lg2-playoff-dot" title="Playoff spot"></span>' : ''}${rank}</td>`
      + `<td>${esc(r.teamName)}</td>` + numInp(r, 'w', 0) + numInp(r, 'l', 0);
    if (showDraw) c += numInp(r, 't', 0);
    if (gs.sub) c += numInp(r, 'subW', 0) + numInp(r, 'subL', 0);
    if (u) c += numInp(r, 'gf', 0) + numInp(r, 'ga', 0) + `<td>${(r.gf - r.ga) >= 0 ? '+' : ''}${r.gf - r.ga}</td>`;
    // In manual mode points normally derive from the scoring rules; a typed value pins the cell
    // (marked with a dot) until it's cleared, which hands the column back to the rules.
    const ptsCell = manual
      ? `<td><input type="number" class="input-text lg2-st-inp lg2-st-pts${r.ptsLocked ? ' pinned' : ''}" data-tid="${r.teamId}" data-key="pts" value="${r.pts}" title="${r.ptsLocked ? 'Overridden by hand — clear the field to go back to the scoring rules' : 'Derived from your scoring rules — type a value to override'}"></td>`
      : numInp(r, 'pts');
    c += ptsCell + `<td class="lg2-form-cell">${formDots(r.form)}</td><td class="lg2-streak">${esc(r.streak)}</td>` + divSel(r);
    return `<tr data-tid="${r.teamId}" draggable="true" class="lg2-st-row${zone}${cut}">${c}</tr>`;
  };
  const tableFor = (groupRows) => `<div class="lg2-st-scroll"><table class="lg2-st-table"><thead><tr>${head}</tr></thead><tbody>${groupRows.map((r, i) => rowHtml(r, i + 1)).join('')}</tbody></table></div>`;
  if (hasDivs) {
    const groups = divs.map((d) => ({ name: d.name, rows: rows.filter((r) => lgTeamDivId(lg, r.teamId) === d.id) }));
    const un = rows.filter((r) => !divs.find((d) => d.id === lgTeamDivId(lg, r.teamId)));
    if (un.length) groups.push({ name: 'Unassigned', rows: un });
    wrap.innerHTML = groups.map((g) => `<div class="lg2-div-group"><div class="lg2-div-head">${esc(g.name)}<span class="lg2-div-count">${g.rows.length}</span></div>${g.rows.length ? tableFor(g.rows) : '<div class="lg-empty" style="padding:6px 0;">No teams in this division.</div>'}</div>`).join('');
  } else {
    wrap.innerHTML = tableFor(rows);
  }

  // Sortable headers
  wrap.querySelectorAll('.lg2-st-sort').forEach((h) => h.addEventListener('click', () => lgStSortBy(h.dataset.sk)));
  // Division assignment
  wrap.querySelectorAll('.lg2-st-div').forEach((sel) => sel.addEventListener('change', () => {
    const tm = (lg.teams || []).find((t) => t.id === sel.dataset.tid); if (tm) { tm.divisionId = sel.value; lgSave(); lgRenderStandingsTab(); }
  }));

  // Drag-to-reorder rows
  let dragTid = null;
  wrap.querySelectorAll('tbody tr[data-tid]').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragTid = row.dataset.tid; row.classList.add('lg2-dragging');
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragTid);
    });
    row.addEventListener('dragend', () => {
      dragTid = null; wrap.querySelectorAll('tr').forEach(r => r.classList.remove('lg2-dragging', 'lg2-drag-over'));
    });
    row.addEventListener('dragover', e => { e.preventDefault(); if (row.dataset.tid !== dragTid) row.classList.add('lg2-drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('lg2-drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('lg2-drag-over');
      if (!dragTid || dragTid === row.dataset.tid) return;
      // Ensure all teams are in lg.standings before reorder
      const all = [...rows.map(r => r.teamId)];
      lg.standings = lg.standings || [];
      all.forEach(tid => { if (!lg.standings.find(s => s.teamId === tid)) lg.standings.push({ teamId: tid, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0 }); });
      const from = lg.standings.findIndex(s => s.teamId === dragTid);
      const to   = lg.standings.findIndex(s => s.teamId === row.dataset.tid);
      if (from === -1 || to === -1) return;
      const [item] = lg.standings.splice(from, 1);
      lg.standings.splice(to, 0, item);
      // A hand-dragged order IS the order — drop back to manual so the next Recalculate doesn't
      // quietly re-sort it out from under the producer.
      _lgStSort = { key: '', dir: _lgStSort.dir }; lgStSaveSort();
      lgRenderStandingsTab(); lgSave();
    });
  });

  wrap.querySelectorAll('.lg2-st-inp').forEach((inp) => inp.addEventListener('change', () => {
    const s = lgStandingsRow(lg, inp.dataset.tid);
    const key = inp.dataset.key;
    // Typing a points value is an explicit override; typing W/L/T re-derives points from the
    // scoring rules so a manual table never needs the points column filled in by hand.
    // Clearing the points field releases the override and hands the column back to the rules.
    if (key === 'pts' && manual && inp.value.trim() === '') {
      delete s.ptsLocked; lgApplyScoring(lg, s);
    } else {
      s[key] = Number(inp.value) || 0;
      if (key === 'pts' && manual) s.ptsLocked = true;
      else if (manual && (key === 'w' || key === 'l' || key === 't')) lgApplyScoring(lg, s);
    }
    lgSave();
    if (manual) { lgRenderStandingsTab(); lgRenderTeams(); }
  }));
}

// Manual mode: log a result that never went near the schedule. Applies to BOTH teams at once —
// record, for/against, points, last-5 form and streak — which is the whole point of the shortcut.
let _lgQrUndo = null;   // { leagueId, rows:[{teamId, snap}] } — one level of undo, enough to fix a typo
function lgRenderQuickResult() {
  const lg = lgActive(); if (!lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const opts = (lg.teams || []).map((tm) => `<option value="${esc(tm.id)}">${esc(lgResolveTeam(tm).name)}</option>`).join('');
  const a = el('lg-qr-a'), b = el('lg-qr-b');
  [a, b].forEach((sel, i) => {
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = '<option value="">— Team —</option>' + opts;
    if (keep && (lg.teams || []).some((t) => t.id === keep)) sel.value = keep;
    else if ((lg.teams || [])[i]) sel.value = (lg.teams || [])[i].id;
  });
  const undo = el('lg-qr-undo'); if (undo) undo.disabled = !(_lgQrUndo && _lgQrUndo.leagueId === lg.id);
  const note = el('lg-qr-note');
  if (note) note.textContent = (lg.teams || []).length < 2 ? 'Add at least two teams first.' : '';
}
el('lg-qr-add')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const ta = (el('lg-qr-a') || {}).value, tb = (el('lg-qr-b') || {}).value;
  if (!ta || !tb) { lgStatus('Pick both teams first.', false); return; }
  if (ta === tb) { lgStatus('Pick two different teams.', false); return; }
  const sa = Number((el('lg-qr-sa') || {}).value), sb = Number((el('lg-qr-sb') || {}).value);
  if (!Number.isFinite(sa) || !Number.isFinite(sb) || (el('lg-qr-sa').value === '' && el('lg-qr-sb').value === '')) {
    lgStatus('Enter a score for both teams.', false); return;
  }
  const ot = !!(el('lg-qr-ot') || {}).checked;
  const rowA = lgStandingsRow(lg, ta), rowB = lgStandingsRow(lg, tb);
  _lgQrUndo = { leagueId: lg.id, rows: [{ teamId: ta, snap: JSON.parse(JSON.stringify(rowA)) }, { teamId: tb, snap: JSON.parse(JSON.stringify(rowB)) }] };
  const apply = (s, mine, theirs) => {
    s.gf = (s.gf || 0) + mine; s.ga = (s.ga || 0) + theirs;
    s.form = (s.form || []).concat([mine > theirs ? 'W' : mine < theirs ? 'L' : 'D']).slice(-5);
    if (mine > theirs) { s.w = (s.w || 0) + 1; if (ot) s.otw = (s.otw || 0) + 1; }
    else if (mine < theirs) s.l = (s.l || 0) + 1;
    else s.t = (s.t || 0) + 1;
    lgRecalcStreak(s); lgApplyScoring(lg, s);
  };
  apply(rowA, sa, sb); apply(rowB, sb, sa);
  // Head-to-head, so the h2h tiebreak keeps working for hand-kept tables too.
  if (sa !== sb) { const win = sa > sb ? rowA : rowB, lose = sa > sb ? rowB : rowA; win.h2h = win.h2h || {}; win.h2h[lose.teamId] = (win.h2h[lose.teamId] || 0) + 1; }
  lgSortManualStandings(lg); lgSave();
  lgRenderStandingsTab(); lgRenderTeams();
  const nm = (id) => { const t = (lg.teams || []).find((x) => x.id === id); return t ? lgResolveTeam(t).name : 'Team'; };
  lgStatus(`Logged ${nm(ta)} ${sa}-${sb} ${nm(tb)}.`, true);
  const ea = el('lg-qr-sa'), eb = el('lg-qr-sb'), eo = el('lg-qr-ot');
  if (ea) ea.value = ''; if (eb) eb.value = ''; if (eo) eo.checked = false;
});
el('lg-qr-undo')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg || !_lgQrUndo || _lgQrUndo.leagueId !== lg.id) return;
  _lgQrUndo.rows.forEach(({ teamId, snap }) => {
    const i = (lg.standings || []).findIndex((x) => x.teamId === teamId);
    if (i >= 0) lg.standings[i] = snap;
  });
  _lgQrUndo = null;
  lgSortManualStandings(lg); lgSave(); lgRenderStandingsTab(); lgRenderTeams();
  lgStatus('Last logged result undone.', true);
});
// Sort-by dropdown + direction toggle. Both just drive lgStSortBy, which is the same path the
// clickable column headers use, so the arrow in the header always matches the dropdown.
el('lg-st-sortby')?.addEventListener('change', function () {
  lgStSortBy(this.value);
  lgStatus(this.value ? `Standings sorted by ${lgStSortLabel()}.` : 'Standings back to manual order — drag rows to arrange them.', true);
});
el('lg-st-sortdir')?.addEventListener('click', () => {
  if (!_lgStSort.key || _lgStSort.key === 'auto') return;
  _lgStSort = { key: _lgStSort.key, dir: -_lgStSort.dir };
  lgStSortBy(_lgStSort.key, true);
});

// Switching source mode. Going manual seeds a row for every team so the table is immediately
// typeable, and carries over whatever the schedule had already produced rather than starting at 0.
el('lg-st-source')?.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  const lg = lgActive(); if (!lg) return;
  const mode = ['manual', 'points'].includes(b.dataset.src) ? b.dataset.src : 'schedule';
  lg.standingsMode = mode;
  if (mode === 'manual') (lg.teams || []).forEach((tm) => lgStandingsRow(lg, tm.id));
  lgSave(); lgRenderStandingsTab(); lgRenderTeams();
  lgStatus({
    manual: 'Manual standings — type the table directly; the schedule no longer overwrites it.',
    points: 'Standings now total the placement points from the Tournaments tab. Add an event there to fill the table.',
    schedule: 'Standings now follow the schedule — use Recalculate to rebuild from results.'
  }[mode], true);
});

// ── Playoff bracket (single-elimination, seeded from standings) ──────────────
// Stored client-side on lg.bracket (the server preserves unknown league fields), and pushed to the
// SAME bracket.html overlay the manual Bracket Builder uses (set_bracket_phases). rounds[] mirror
// the builder's shape: [{ name, sets:[{ a:{name,score,seed}, b:{...} }] }].
function lgBracketModel(lg) {
  if (!lg.bracket || typeof lg.bracket !== 'object') lg.bracket = { type: 'single', size: 8, rounds: [], seededAt: 0 };
  if (!Array.isArray(lg.bracket.rounds)) lg.bracket.rounds = [];
  return lg.bracket;
}
// Standard bracket seeding order for n slots (n a power of 2): [1,8,4,5,2,7,3,6] for 8, so the top
// seed always meets the lowest and the bracket halves are balanced.
function lgSeedSlots(n) {
  let arr = [1, 2];
  while (arr.length < n) { const m = arr.length * 2 + 1; const out = []; arr.forEach((s) => { out.push(s); out.push(m - s); }); arr = out; }
  return arr;
}
function lgBracketRoundName(idx, total) {
  const fromEnd = total - idx;
  if (fromEnd === 1) return 'Final';
  if (fromEnd === 2) return 'Semifinals';
  if (fromEnd === 3) return 'Quarterfinals';
  return 'Round ' + (idx + 1);
}
function lgBracketWinnerOf(set) {
  const an = set.a.name, bn = set.b.name;
  if (an && lgIsBye(bn)) return 'a';
  if (bn && lgIsBye(an)) return 'b';
  const sa = Number(set.a.score) || 0, sb = Number(set.b.score) || 0;
  if (sa === sb) return '';
  return sa > sb ? 'a' : 'b';
}
function lgIsBye(name) { return !name || name === '(bye)'; }
function lgBracketGenerate() {
  const lg = lgActive(); if (!lg) return;
  const bk = lgBracketModel(lg);
  const size = Math.max(2, parseInt((el('lg-bkt-size') || {}).value, 10) || 8);
  // Seed order = current standings order (fall back to teams order). Resolve display names.
  const teamsById = {}; (lg.teams || []).forEach((t) => { teamsById[t.id] = t; });
  const ordered = (lg.standings && lg.standings.length)
    ? lg.standings.map((s) => teamsById[s.teamId]).filter(Boolean)
    : (lg.teams || []).slice();
  if (ordered.length < 2) { lgStatus('Add at least 2 teams (and standings) before generating a bracket.', false); return; }
  const seeds = ordered.slice(0, size).map((tm) => lgResolveTeam(tm).name || tm.teamName || 'Team');
  const slotOrder = lgSeedSlots(size);   // seed positions in slot order
  const slots = slotOrder.map((seed) => seeds[seed - 1] || '(bye)');
  const roundCount = Math.round(Math.log2(size));
  const rounds = [];
  // Round 1 from the seeded slots.
  const r1 = [];
  for (let i = 0; i < slots.length; i += 2) r1.push({ a: { name: slots[i], score: 0 }, b: { name: slots[i + 1], score: 0 } });
  rounds.push({ name: lgBracketRoundName(0, roundCount), sets: r1 });
  // Empty later rounds.
  for (let r = 1; r < roundCount; r++) {
    const n = r1.length >> r;
    rounds.push({ name: lgBracketRoundName(r, roundCount), sets: Array.from({ length: n }, () => ({ a: { name: '', score: 0 }, b: { name: '', score: 0 } })) });
  }
  bk.type = 'single'; bk.size = size; bk.rounds = rounds; bk.seededAt = Date.now();
  // Auto-advance any first-round byes so the producer starts on real matchups.
  rounds[0].sets.forEach((set, si) => { const w = lgBracketWinnerOf(set); if (w && (lgIsBye(set.a.name) || lgIsBye(set.b.name))) lgBracketAdvanceInto(bk, 0, si, w); });
  lgSave(); lgRenderBracketTab();
  lgStatus(`Seeded a ${size}-team single-elimination bracket from standings.`, true);
}
// Place a set's winner into the correct slot of the next round (no re-render/save — caller does).
function lgBracketAdvanceInto(bk, ri, si, w) {
  const rounds = bk.rounds; if (ri >= rounds.length - 1) return;
  const winnerName = w === 'a' ? rounds[ri].sets[si].a.name : rounds[ri].sets[si].b.name;
  const next = rounds[ri + 1].sets[Math.floor(si / 2)]; if (!next) return;
  const slot = si % 2 === 0 ? 'a' : 'b';
  next[slot].name = winnerName;
}
function lgBracketAdvance(ri, si) {
  const lg = lgActive(); if (!lg) return; const bk = lgBracketModel(lg);
  const w = lgBracketWinnerOf(bk.rounds[ri].sets[si]);
  if (!w) { lgStatus('Enter a winning score first (scores can\'t be tied).', false); return; }
  lgBracketAdvanceInto(bk, ri, si, w);
  lgSave(); lgRenderBracketTab();
}
function lgRenderBracketTab() {
  const board = el('lg-bkt-board'); const lg = lgActive(); if (!board || !lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bk = lgBracketModel(lg);
  if (!bk.rounds.length) {
    board.innerHTML = '<div class="lg-empty">No bracket yet — pick a size and hit <strong>Generate from standings</strong> to seed the playoffs, then push it to the bracket overlay.</div>';
    return;
  }
  const champ = (() => { const lastR = bk.rounds[bk.rounds.length - 1]; if (!lastR || !lastR.sets[0]) return ''; const w = lgBracketWinnerOf(lastR.sets[0]); return w ? (w === 'a' ? lastR.sets[0].a.name : lastR.sets[0].b.name) : ''; })();
  const cols = bk.rounds.map((round, ri) => {
    const sets = round.sets.map((set, si) => {
      const w = lgBracketWinnerOf(set);
      const side = (slot) => {
        const nm = set[slot].name; const bye = lgIsBye(nm);
        return `<div class="lg-bkt-side${w === slot ? ' win' : ''}${bye ? ' bye' : ''}">
          <span class="lg-bkt-tname">${bye ? '(bye)' : esc(nm) || 'TBD'}</span>
          <input type="number" class="input-text lg-bkt-score" data-ri="${ri}" data-si="${si}" data-slot="${slot}" value="${Number(set[slot].score) || 0}"${bye ? ' disabled' : ''}>
        </div>`;
      };
      const canAdv = ri < bk.rounds.length - 1 && !!w;
      return `<div class="lg-bkt-set">${side('a')}${side('b')}
        ${ri < bk.rounds.length - 1 ? `<button class="lg-bkt-adv${canAdv ? '' : ' dim'}" data-ri="${ri}" data-si="${si}" title="Advance the winner">${canAdv ? 'Advance →' : ''}</button>` : ''}
      </div>`;
    }).join('');
    return `<div class="lg-bkt-col"><div class="lg-bkt-round">${esc(round.name)}</div>${sets}</div>`;
  }).join('');
  board.innerHTML = `${champ ? `<div class="lg-bkt-champ">Champion: <strong>${esc(champ)}</strong></div>` : ''}<div class="lg-bkt-scroll"><div class="lg-bkt-cols">${cols}</div></div>`;
  board.querySelectorAll('.lg-bkt-score').forEach((inp) => inp.addEventListener('change', () => {
    bk.rounds[+inp.dataset.ri].sets[+inp.dataset.si][inp.dataset.slot].score = Number(inp.value) || 0;
    lgSave(); lgRenderBracketTab();
  }));
  board.querySelectorAll('.lg-bkt-adv').forEach((b) => b.addEventListener('click', () => { if (!b.classList.contains('dim')) lgBracketAdvance(+b.dataset.ri, +b.dataset.si); }));
}
// Push the league bracket to bracket.html (same set_bracket_phases shape as the manual builder).
function lgBracketPush(visible) {
  const lg = lgActive(); if (!lg) return; const bk = lgBracketModel(lg);
  if (!bk.rounds.length) { lgStatus('Generate a bracket first.', false); return; }
  const logoByName = {}; (lg.teams || []).forEach((tm) => { const r = lgResolveTeam(tm); if (r.name && r.logo) logoByName[r.name] = r.logo; });
  const winners = bk.rounds.map((round, ri) => ({
    name: round.name, round: ri + 1,
    sets: round.sets.map((set) => {
      const w = lgBracketWinnerOf(set);
      return { a: { name: lgIsBye(set.a.name) ? 'BYE' : (set.a.name || 'TBD'), score: Number(set.a.score) || 0, winner: w === 'a' },
               b: { name: lgIsBye(set.b.name) ? 'BYE' : (set.b.name || 'TBD'), score: Number(set.b.score) || 0, winner: w === 'b' } };
    })
  }));
  const teams = Object.keys(logoByName).map((name) => ({ name, logo: logoByName[name] }));
  const title = [lg.name, lg.season].filter(Boolean).join(' — ') || 'Playoffs';
  send('set_bracket_phases', {
    phases: [{ id: 'lgph_' + lg.id, name: 'Playoffs', type: 'SINGLE_ELIMINATION', winners, losers: [], finals: [], standings: [], schedule: [], roster: [] }],
    activePhaseId: 'lgph_' + lg.id, title, teams, visible: visible !== false
  });
  lgStatus(visible === false ? 'Bracket overlay hidden.' : 'Bracket pushed to the bracket overlay.', true);
}

// Resolve a schedule match's series score (games won per side) + real per-side totals. When a
// per-game breakdown (m.games) is provided, the series score is derived by counting games won
// and totals are summed from the individual game scores; otherwise both come directly from the
// single result.scoreA/scoreB entry (today's behavior, unchanged) — the per-game breakdown is
// strictly optional, so leagues that don't use it see no change at all.
function lgMatchTally(m) {
  const r = m.result || {};
  const hasGames = Array.isArray(m.games) && m.games.length > 0;
  if (hasGames) {
    let sa = 0, sb = 0, totA = 0, totB = 0;
    for (const g of m.games) {
      const ga = Number(g.scoreA) || 0, gb = Number(g.scoreB) || 0;
      totA += ga; totB += gb;
      if (ga > gb) sa++; else if (gb > ga) sb++;
    }
    return { sa, sb, totA, totB, hasGames: true };
  }
  const sa = Number(r.scoreA) || 0, sb = Number(r.scoreB) || 0;
  return { sa, sb, totA: sa, totB: sb, hasGames: false };
}

// Pure schedule → standings aggregation. Shared by lgComputeStandingsFromSchedule (which persists
// the result to lg.standings) and lgStandingsDrift (which only compares against what's stored,
// without mutating anything) — avoids a third copy of this logic alongside server.js's lgRecalcServer.
function lgAggregateFromSchedule(lg) {
  const sc = lg.scoring || {};
  const ptsWin = sc.win ?? 3, ptsLoss = sc.loss ?? 0, ptsDraw = sc.draw ?? 1, ptsOtw = sc.otw ?? ptsWin;
  const map = {};
  (lg.teams || []).forEach((tm) => { map[tm.id] = { teamId: tm.id, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0, subW: 0, subL: 0, form: [], h2h: {} }; });
  for (const m of (lg.schedule || [])) {
    const r = m.result;
    const hasGames = Array.isArray(m.games) && m.games.length > 0;
    if (!hasGames && (!r || r.scoreA == null || r.scoreB == null)) continue;
    const a = map[m.teamA], b = map[m.teamB]; if (!a || !b) continue;
    const { sa, sb, totA, totB } = lgMatchTally(m);
    a.gf += totA; a.ga += totB; b.gf += totB; b.ga += totA;
    a.subW += sa; a.subL += sb; b.subW += sb; b.subL += sa;   // games/maps won across the series
    const winPts = (r && r.ot) ? ptsOtw : ptsWin;
    if (sa > sb) {
      a.w++; a.pts += winPts; a.form.push('W'); a.h2h[m.teamB] = (a.h2h[m.teamB] || 0) + 1;
      b.l++; b.pts += ptsLoss; b.form.push('L');
    } else if (sb > sa) {
      b.w++; b.pts += winPts; b.form.push('W'); b.h2h[m.teamA] = (b.h2h[m.teamA] || 0) + 1;
      a.l++; a.pts += ptsLoss; a.form.push('L');
    } else {
      a.t++; a.pts += ptsDraw; a.form.push('D');
      b.t++; b.pts += ptsDraw; b.form.push('D');
    }
  }
  const tb = lg.tiebreak || 'gd';
  const calcStreak = (form) => {
    if (!form.length) return '';
    const last = form[form.length - 1]; let n = 0;
    for (let i = form.length - 1; i >= 0 && form[i] === last; i--) n++;
    return last + n;
  };
  const standings = Object.values(map).map((s) => ({
    teamId: s.teamId, w: s.w, l: s.l, t: s.t, gf: s.gf, ga: s.ga, pts: s.pts, subW: s.subW, subL: s.subL,
    form: s.form.slice(-5), streak: calcStreak(s.form), h2h: s.h2h
  }));
  standings.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (tb === 'h2h') {
      const ah = (a.h2h && a.h2h[b.teamId]) || 0, bh = (b.h2h && b.h2h[a.teamId]) || 0;
      if (ah !== bh) return bh - ah;
    }
    const gdDiff = ((b.gf - b.ga) - (a.gf - a.ga));
    if (gdDiff !== 0) return gdDiff;
    return b.gf - a.gf;
  });
  return standings;
}

// ── Game-aware standings profile ──────────────────────────────────────────────
// What a "map/game" is called for series-based (best-of-N) games — drives a Games/Maps W-L column
// distinct from the series (match) W-L. Games not listed have no sub-unit (single-game or FFA/BR).
const LG_SUB_UNIT = {
  'rocket-league': { noun: 'Games', abbr: 'Gm' },
  'csgo':          { noun: 'Maps',  abbr: 'Mp' },
  'valorant':      { noun: 'Maps',  abbr: 'Mp' },
  'rainbow6':      { noun: 'Maps',  abbr: 'Mp' },
  'overwatch':     { noun: 'Maps',  abbr: 'Mp' },
  'cod':           { noun: 'Maps',  abbr: 'Mp' },
  'marvel-rivals': { noun: 'Maps',  abbr: 'Mp' },
  'league':        { noun: 'Games', abbr: 'Gm' },
  'dota2':         { noun: 'Games', abbr: 'Gm' },
  'smash':         { noun: 'Games', abbr: 'Gm' },
  'mobile-legends':{ noun: 'Games', abbr: 'Gm' },
  'honor-of-kings':{ noun: 'Games', abbr: 'Gm' },
  'bedwars':       { noun: 'Games', abbr: 'Gm' }
};
// Games where the numeric For/Against "unit" score is meaningful (goals/rounds). MOBAs and BR games
// have no simple per-game score, so their For/Against/Diff columns are hidden rather than shown as 0.
const LG_UNIT_GAMES = new Set(['rocket-league', 'csgo', 'valorant', 'rainbow6', 'overwatch', 'cod', 'eafc']);
function lgGameStats(gameId) {
  const g = (currentState.games || {})[gameId] || {};
  const sub = LG_SUB_UNIT[gameId] || null;
  const unit = LG_UNIT_GAMES.has(gameId) ? { noun: g.statLabel || 'Score', abbr: g.statAbbr || '' } : null;
  return { series: !!sub, sub, unit };
}
// For/against/diff labels — kept for the overlay push; derives from the game's unit vocabulary.
function lgStatLabels(lg) {
  const u = lgGameStats(lg && lg.game).unit || { noun: 'Score', abbr: '' };
  const abbr = u.abbr || null, noun = u.noun;
  return {
    forAbbr: abbr ? abbr + 'F' : 'For', againstAbbr: abbr ? abbr + 'A' : 'Against', diffAbbr: abbr ? abbr + 'D' : 'Diff',
    forFull: noun + ' For', againstFull: noun + ' Against', diffFull: noun + ' Diff'
  };
}

// ── In-game stat sets (Stats tab) ─────────────────────────────────────────────
// Plain-English stat labels per game — NO cryptic abbreviations (no ADR/KOST/GPM). These are the
// detailed per-team totals tracked on top of the series + game record. Games not listed show only
// the series/game tiers. Stored per team in lg.stats[teamId] keyed by a slug of the label.
const LG_STAT_SETS = {
  'rocket-league': ['Goals', 'Assists', 'Saves', 'Shots', 'MVPs', 'Demos'],
  'csgo':          ['Kills', 'Deaths', 'Assists', 'Damage', 'Headshots'],
  'valorant':      ['Kills', 'Deaths', 'Assists', 'Damage', 'First Bloods'],
  'rainbow6':      ['Kills', 'Deaths', 'Assists', 'Plants', 'Defuses'],
  'overwatch':     ['Eliminations', 'Deaths', 'Assists', 'Damage', 'Healing'],
  'cod':           ['Kills', 'Deaths', 'Assists', 'Damage', 'Objectives'],
  'marvel-rivals': ['Final Hits', 'Deaths', 'Assists', 'Damage', 'Healing'],
  'league':        ['Kills', 'Deaths', 'Assists', 'CS', 'Gold'],
  'dota2':         ['Kills', 'Deaths', 'Assists', 'Last Hits', 'Net Worth'],
  'mobile-legends':['Kills', 'Deaths', 'Assists', 'Gold', 'Damage'],
  'honor-of-kings':['Kills', 'Deaths', 'Assists', 'Gold', 'Damage'],
  'smash':         ['Wins', 'KOs', 'Falls', 'Self-destructs'],
  'eafc':          ['Goals', 'Assists', 'Shots', 'Possession %'],
  'bedwars':       ['Beds Broken', 'Final Kills', 'Kills', 'Deaths'],
  // Battle royale: scored per placement + elims rather than head-to-head, so the tracked totals are
  // the ones an organiser actually reads off a lobby result sheet.
  'fortnite':      ['Eliminations', 'Placement Points', 'Victory Royales', 'Damage']
};
function lgStatKey(label) { return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

// Stats tab — three clearly-labelled tiers per team: SERIES (match W-L, read-only), GAME/MAP record +
// score (read-only, from the schedule), and IN-GAME totals (editable). Recalculate refreshes the first
// two tiers from the schedule; in-game numbers are entered by the producer.
function lgRenderStatsTab() {
  const wrap = el('lg2-stats'); const lg = lgActive(); if (!wrap || !lg) return;
  lg.stats = lg.stats || {};
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  const teams = lg.teams || [];
  if (!teams.length) { wrap.innerHTML = '<div class="lg-empty">Add teams to the league to track stats.</div>'; return; }
  const gs = lgGameStats(lg.game);
  const unit = gs.unit;
  const inSet = LG_STAT_SETS[lg.game] || [];
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  const gameLbl = gs.sub ? gs.sub.noun : 'Games';
  const gameCols = 2 + (unit ? 2 : 0);

  const groupRow = `<tr class="lg2-stat-grouprow">`
    + `<th></th>`
    + `<th class="lg2-stat-group lg2-stat-g-series" colspan="2">Series</th>`
    + `<th class="lg2-stat-group lg2-stat-g-game" colspan="${gameCols}">${esc(gameLbl)}</th>`
    + (inSet.length ? `<th class="lg2-stat-group lg2-stat-g-ingame" colspan="${inSet.length}">In-game</th>` : '')
    + `</tr>`;
  const headRow = `<tr>`
    + `<th class="lg2-stat-team">Team</th>`
    + `<th title="Series (matches) won">W</th><th title="Series (matches) lost">L</th>`
    + `<th title="${esc(gameLbl)} won">Won</th><th title="${esc(gameLbl)} lost">Lost</th>`
    + (unit ? `<th title="${esc(unit.noun)} scored">For</th><th title="${esc(unit.noun)} conceded">Against</th>` : '')
    + inSet.map((s) => `<th title="${esc(s)}">${esc(s)}</th>`).join('')
    + `</tr>`;
  const ro = (v) => `<td class="lg2-stat-ro">${v || 0}</td>`;
  const body = teams.map((tm) => {
    const r = lgResolveTeam(tm); const s = byId[tm.id] || {}; const ts = lg.stats[tm.id] || {};
    let c = `<td class="lg2-stat-team">${esc(r.name || tm.teamName || 'Team')}</td>`
      + ro(s.w) + ro(s.l) + ro(s.subW) + ro(s.subL) + (unit ? ro(s.gf) + ro(s.ga) : '')
      + inSet.map((label) => { const k = lgStatKey(label); const v = ts[k]; return `<td><input type="number" class="input-text lg2-stat-inp" data-tid="${tm.id}" data-key="${k}" value="${v == null ? '' : v}" placeholder="0" min="0"></td>`; }).join('');
    return `<tr>${c}</tr>`;
  }).join('');
  const note = inSet.length ? '' : `<div class="lg2-stat-note">Detailed in-game stats for ${esc((currentState.games[lg.game] || {}).name || lg.game || 'this game')} aren't set up yet — showing the series &amp; game record.</div>`;
  wrap.innerHTML = `<div class="lg2-st-scroll"><table class="lg2-st-table lg2-stat-table"><thead>${groupRow}${headRow}</thead><tbody>${body}</tbody></table></div>${note}`;

  wrap.querySelectorAll('.lg2-stat-inp').forEach((inp) => inp.addEventListener('change', () => {
    const tid = inp.dataset.tid, key = inp.dataset.key;
    lg.stats[tid] = lg.stats[tid] || {};
    if (inp.value === '') delete lg.stats[tid][key]; else lg.stats[tid][key] = Number(inp.value) || 0;
    lgSave();
  }));
}

// ── Power rankings ────────────────────────────────────────────────────────────
// Standings answer "who has the most points"; rankings answer "who is playing best right now".
// The rating blends four normalised components so a 6-2 team that has beaten the top of the table
// outranks a 6-2 team that farmed the bottom, and a cold streak actually costs you position:
//   win%  (35) · points per match (20) · unit differential per match (20) · recent form (15)
//   · strength of schedule — mean opponent points-per-match (10)
// Teams with no completed matches score 0 and sort last. A producer can pin a team to a fixed
// position (lg.rankPins) when the eye test beats the maths — pins survive every recompute.
const LG_RANK_W = { win: 35, ppm: 20, diff: 20, form: 15, sos: 10 };
function lgPowerRankings(lg) {
  const st = {}; (lg.standings || []).forEach((s) => { st[s.teamId] = s; });
  const teams = (lg.teams || []);
  // Per-team played counts and opponent lists, straight from the schedule.
  const opp = {}; const played = {};
  teams.forEach((t) => { opp[t.id] = []; played[t.id] = 0; });
  (lg.schedule || []).forEach((m) => {
    const done = (Array.isArray(m.games) && m.games.length) || (m.result && m.result.scoreA != null && m.result.scoreB != null);
    if (!done || !opp[m.teamA] || !opp[m.teamB]) return;
    opp[m.teamA].push(m.teamB); opp[m.teamB].push(m.teamA);
    played[m.teamA]++; played[m.teamB]++;
  });
  // Matches played is whichever is larger: fixtures found on the schedule, or the team's own W-L-T.
  // A hand-kept table has no schedule rows at all, and must still rank properly.
  teams.forEach((tm) => {
    const s = st[tm.id] || {};
    played[tm.id] = Math.max(played[tm.id] || 0, (s.w || 0) + (s.l || 0) + (s.t || 0));
  });
  const ppmOf = (tid) => { const s = st[tid] || {}; const n = played[tid] || 0; return n ? (s.pts || 0) / n : 0; };
  const raw = teams.map((tm) => {
    const s = st[tm.id] || {};
    const n = played[tm.id] || 0;
    const w = s.w || 0, l = s.l || 0, t = s.t || 0;
    const decided = w + l + t;
    const winPct = decided ? (w + t * 0.5) / decided : 0;
    const ppm = ppmOf(tm.id);
    const diffPm = n ? ((s.gf || 0) - (s.ga || 0)) / n : 0;
    // Recent form: last 5 results, most recent weighted heaviest (5x down to 1x).
    const f = (s.form || []).slice(-5);
    let fNum = 0, fDen = 0;
    f.forEach((res, i) => { const wt = i + 1; fDen += wt; fNum += wt * (res === 'W' ? 1 : res === 'D' ? 0.5 : 0); });
    const form = fDen ? fNum / fDen : 0;
    const sos = opp[tm.id].length ? opp[tm.id].reduce((a, o) => a + ppmOf(o), 0) / opp[tm.id].length : 0;
    return { teamId: tm.id, name: lgResolveTeam(tm).name, logo: lgResolveTeam(tm).logo || null, n, winPct, ppm, diffPm, form, sos, rec: `${w}-${l}${t ? '-' + t : ''}` };
  });
  // Normalise each component to 0..1 across the league before weighting, so the rating is
  // comparable regardless of the game's scoring scale.
  const norm = (key) => {
    const vals = raw.filter((r) => r.n > 0).map((r) => r[key]);
    const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
    return (v) => (hi === lo ? (hi === 0 ? 0 : 1) : (v - lo) / (hi - lo));
  };
  const nPpm = norm('ppm'), nDiff = norm('diffPm'), nSos = norm('sos');
  raw.forEach((r) => {
    r.rating = r.n === 0 ? 0 : Math.round(
      LG_RANK_W.win * r.winPct + LG_RANK_W.ppm * nPpm(r.ppm) + LG_RANK_W.diff * nDiff(r.diffPm)
      + LG_RANK_W.form * r.form + LG_RANK_W.sos * nSos(r.sos)
    );
  });
  raw.sort((a, b) => b.rating - a.rating || b.winPct - a.winPct || a.name.localeCompare(b.name));
  // Apply producer pins: a pinned team is lifted out and re-inserted at its 1-based slot.
  const pins = lg.rankPins || {};
  const pinned = raw.filter((r) => pins[r.teamId]).sort((a, b) => pins[a.teamId] - pins[b.teamId]);
  if (pinned.length) {
    const rest = raw.filter((r) => !pins[r.teamId]);
    pinned.forEach((p) => rest.splice(Math.max(0, Math.min(rest.length, pins[p.teamId] - 1)), 0, p));
    rest.forEach((r, i) => { r.rank = i + 1; r.pinned = !!pins[r.teamId]; });
    return rest;
  }
  raw.forEach((r, i) => { r.rank = i + 1; });
  return raw;
}

function lgRenderRankingsTab() {
  const wrap = el('lg-rank-board'); const lg = lgActive(); if (!wrap || !lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = lgPowerRankings(lg);
  const note = el('lg-rank-note');
  if (!rows.length) { wrap.innerHTML = '<div class="lg-empty">Add teams to build power rankings.</div>'; if (note) note.textContent = ''; return; }
  // Movement is measured against the last snapshot the producer took, not against the standings —
  // that's what makes "up 3 this week" mean something on air.
  const snap = lg.rankSnapshot || null;
  const prev = {}; if (snap && Array.isArray(snap.order)) snap.order.forEach((tid, i) => { prev[tid] = i + 1; });
  if (note) note.textContent = snap ? `Movement since ${new Date(snap.at).toLocaleDateString()} — ${snap.label || 'last snapshot'}` : 'Take a snapshot to start tracking week-over-week movement.';
  const moveCell = (r) => {
    if (!snap || prev[r.teamId] == null) return '<span class="lgrk-move lgrk-move-new">NEW</span>';
    const d = prev[r.teamId] - r.rank;
    if (d === 0) return '<span class="lgrk-move lgrk-move-flat">&#8211;</span>';
    return `<span class="lgrk-move lgrk-move-${d > 0 ? 'up' : 'down'}">${d > 0 ? '&#9650;' : '&#9660;'}${Math.abs(d)}</span>`;
  };
  const pins = lg.rankPins || {};
  wrap.innerHTML = `<div class="lg2-st-scroll"><table class="lg2-st-table lgrk-table">
    <thead><tr><th>#</th><th></th><th class="lgrk-th-team">Team</th><th title="Series record">Rec</th>
      <th title="Composite power rating out of 100">Rating</th><th title="Share of series won">Win%</th>
      <th title="Average league points per match">PPM</th><th title="Average unit differential per match">Diff/M</th>
      <th title="Weighted last-5 form">Form</th><th title="Strength of schedule — mean opponent points per match">SOS</th>
      <th title="Pin this team to a fixed position">Pin</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="lgrk-row${r.pinned ? ' lgrk-pinned' : ''}">
      <td class="lg2-pos">${r.rank}</td>
      <td class="lgrk-move-cell">${moveCell(r)}</td>
      <td class="lgrk-team"><img class="lgov-snap-logo" src="${r.logo || gameLogo()}" onerror="this.style.visibility='hidden'"><span>${esc(r.name)}</span></td>
      <td class="lgrk-rec">${esc(r.rec)}</td>
      <td class="lgrk-rating"><span class="lgrk-bar"><span class="lgrk-bar-fill" style="width:${Math.max(2, r.rating)}%"></span></span><b>${r.rating}</b></td>
      <td>${r.n ? Math.round(r.winPct * 100) + '%' : '—'}</td>
      <td>${r.n ? r.ppm.toFixed(2) : '—'}</td>
      <td>${r.n ? (r.diffPm > 0 ? '+' : '') + r.diffPm.toFixed(1) : '—'}</td>
      <td>${r.n ? Math.round(r.form * 100) + '%' : '—'}</td>
      <td>${r.n ? r.sos.toFixed(2) : '—'}</td>
      <td><input type="number" class="input-text lgrk-pin" data-tid="${r.teamId}" min="1" max="${rows.length}" value="${pins[r.teamId] || ''}" placeholder="—" title="Force this team to a position"></td>
    </tr>`).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('.lgrk-pin').forEach((inp) => inp.addEventListener('change', () => {
    lg.rankPins = lg.rankPins || {};
    const v = parseInt(inp.value, 10);
    if (!v || v < 1) delete lg.rankPins[inp.dataset.tid]; else lg.rankPins[inp.dataset.tid] = v;
    lgSave(); lgRenderRankingsTab();
  }));
}

el('lg-rank-snapshot')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const rows = lgPowerRankings(lg);
  if (!rows.length) { lgStatus('Nothing to snapshot yet.', false); return; }
  lg.rankSnapshot = { at: Date.now(), label: (el('lg-rank-label')?.value || '').trim(), order: rows.map((r) => r.teamId) };
  lgSave(); lgRenderRankingsTab();
  lgStatus('Rankings snapshot taken — movement now measures from here.', true);
});
el('lg-rank-clear-pins')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  lg.rankPins = {}; lgSave(); lgRenderRankingsTab(); lgStatus('Manual pins cleared.', true);
});
// Rankings ride the standings overlay: same table shape, different title and ordering, so no new
// browser source is needed on the producer's OBS scene.
function lgPushRankingsToOverlay(topN) {
  const lg = lgActive(); if (!lg) return;
  let rows = lgPowerRankings(lg);
  if (!rows.length) { lgStatus('No rankings to push.', false); return; }
  if (topN > 0) rows = rows.slice(0, topN);
  const st = {}; (lg.standings || []).forEach((s) => { st[s.teamId] = s; });
  send('set_standings', {
    visible: true,
    title: [lg.abbr || lg.name, 'Power Rankings'].filter(Boolean).join(' '),
    gamesLabel: '',
    rows: rows.map((r) => { const s = st[r.teamId] || {}; return { placement: r.rank, name: r.name, logo: r.logo, wins: s.w || 0, losses: s.l || 0, points: r.rating, gameWins: s.subW || 0, gameLosses: s.subL || 0 }; })
  });
  lgStatus(`Power rankings pushed to the standings overlay${topN > 0 ? ` (top ${topN})` : ''}.`, true);
}
el('lg-rank-push')?.addEventListener('click', () => lgPushRankingsToOverlay(parseInt((el('lg-rank-topn') || {}).value, 10) || 0));

// ── Ballchasing.com tab — group status, replay upload, stats refresh. A SEPARATE data sink from
// lg.stats (the manual tab above): this never overwrites what a producer typed in by hand. ──
function lgRenderBallchasingTab() {
  const lg = lgActive(); if (!lg) return;
  const bc = lg.ballchasing || {};
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');

  const pill = el('lg-bc-connected-pill');
  const desc = el('lg-bc-status-desc');
  const enableBtn = el('lg-bc-enable');
  const groupLink = el('lg-bc-group-link');
  const uploadSection = el('lg-bc-upload-section');
  const refreshSection = el('lg-bc-refresh-section');

  const hasGroup = !!bc.groupId;
  if (pill) pill.style.display = hasGroup ? '' : 'none';
  if (enableBtn) { enableBtn.style.display = hasGroup ? 'none' : ''; }
  if (groupLink) {
    if (hasGroup) { groupLink.style.display = ''; groupLink.href = bc.groupUrl || `https://ballchasing.com/group/${bc.groupId}`; }
    else groupLink.style.display = 'none';
  }
  if (desc) {
    desc.textContent = hasGroup
      ? 'Ballchasing is set up for this league — upload replays below and refresh stats any time.'
      : 'This league has no Ballchasing group yet — click Enable to create one (nothing to set up on ballchasing.com itself).';
  }
  if (uploadSection) uploadSection.style.display = hasGroup ? '' : 'none';
  if (refreshSection) refreshSection.style.display = hasGroup ? '' : 'none';

  const pendingChip = el('lg-bc-pending-chip');
  if (pendingChip) {
    const n = (bc.pendingReplays || []).length;
    pendingChip.textContent = n ? `${n} replay${n === 1 ? '' : 's'} processing…` : '';
  }

  const refreshNote = el('lg-bc-refresh-note');
  if (refreshNote) {
    refreshNote.textContent = bc.lastRefreshNote || (bc.lastSyncedAt ? `Last refreshed ${new Date(bc.lastSyncedAt).toLocaleString()}` : 'Never refreshed yet.');
  }

  lgRenderBallchasingTeamStats(lg, esc);
  lgRenderBallchasingLeaderboard(lg, esc);

  // Global auto-upload settings (state.ballchasing.autoUpload) reflected into this league's tab.
  const au = (currentState.ballchasing && currentState.ballchasing.autoUpload) || {};
  const autoToggle = el('lg-bc-auto-toggle'), autoBox = el('lg-bc-auto-box'), autoPath = el('lg-bc-auto-folder-path');
  if (autoToggle && document.activeElement !== autoToggle) autoToggle.checked = !!au.enabled;
  if (autoBox) autoBox.style.display = au.enabled ? 'flex' : 'none';
  if (autoPath) autoPath.textContent = au.folder ? (au.folder + (au.activeLeagueId === lg.id ? '' : '  — active league: another')) : 'No folder chosen yet.';
}

// Read-only preview of lg.ballchasingPlayers (the per-player leaderboard sink), sorted by score.
function lgRenderBallchasingLeaderboard(lg, esc) {
  const wrap = el('lg-bc-player-links'); if (!wrap) return;
  const players = Object.values(lg.ballchasingPlayers || {});
  if (!players.length) { wrap.innerHTML = ''; return; }
  const rows = players.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 12);
  const cols = [['games', 'GP'], ['goals', 'G'], ['assists', 'A'], ['saves', 'Sv'], ['shots', 'Sh'], ['mvps', 'MVP']];
  const head = `<tr><th class="lg2-stat-team">#</th><th class="lg2-stat-team">Player</th><th class="lg2-stat-team">Team</th>${cols.map((c) => `<th>${c[1]}</th>`).join('')}</tr>`;
  const body = rows.map((p, i) => `<tr><td class="lg2-stat-ro">${i + 1}</td><td class="lg2-stat-team">${esc(p.name || 'Player')}</td><td class="lg2-stat-team" style="color:${p.teamId ? '#c4b5fd' : '#f0a860'}">${esc(p.teamName || '— unmatched')}</td>${cols.map((c) => `<td class="lg2-stat-ro">${p[c[0]] || 0}</td>`).join('')}</tr>`).join('');
  wrap.innerHTML = `<div style="margin-top:10px;"><div class="sr-summary" style="margin-bottom:4px;">Player leaderboard preview (top 12 by score)</div><div class="lg2-st-scroll"><table class="lg2-st-table lg2-stat-table"><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
}

// Read-only preview of lg.ballchasingStats (the auto-populated sink), same column shape as the
// manual Stats tab's In-game tier so producers can compare the two at a glance.
function lgRenderBallchasingTeamStats(lg, esc) {
  const wrap = el('lg-bc-team-stats'); if (!wrap) return;
  const teams = lg.teams || [];
  const bs = lg.ballchasingStats || {};
  if (!teams.length || !Object.keys(bs).length) {
    wrap.innerHTML = '<div class="lg-empty">No Ballchasing stats yet — upload replays, then Refresh Stats.</div>';
    return;
  }
  const cols = ['goals', 'assists', 'saves', 'shots', 'mvps', 'demos'];
  const labels = { goals: 'Goals', assists: 'Assists', saves: 'Saves', shots: 'Shots', mvps: 'MVPs', demos: 'Demos' };
  const head = `<tr><th class="lg2-stat-team">Team</th>${cols.map((c) => `<th>${labels[c]}</th>`).join('')}</tr>`;
  const body = teams.map((tm) => {
    const r = lgResolveTeam(tm); const s = bs[tm.id] || {};
    return `<tr><td class="lg2-stat-team">${esc(r.name || tm.teamName || 'Team')}</td>${cols.map((c) => `<td class="lg2-stat-ro">${s[c] || 0}</td>`).join('')}</tr>`;
  }).join('');
  wrap.innerHTML = `<div class="lg2-st-scroll"><table class="lg2-st-table lg2-stat-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

el('lg-bc-enable')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  send('ballchasing_enable_group', { leagueId: lg.id });
});

// Upload: an Electron <input type=file> exposes each File's absolute .path — send those to the
// server, which streams them to ballchasing (no server-side file dialog needed).
el('lg-bc-upload')?.addEventListener('click', () => el('lg-bc-upload-file')?.click());
el('lg-bc-upload-file')?.addEventListener('change', function () {
  const lg = lgActive(); const paths = [...(this.files || [])].map((f) => f.path).filter(Boolean);
  this.value = '';
  if (!lg || !paths.length) return;
  const r = el('lg-bc-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = `Uploading ${paths.length} replay${paths.length === 1 ? '' : 's'}…`; }
  send('ballchasing_upload_replays', { leagueId: lg.id, paths });
});

el('lg-bc-refresh')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const r = el('lg-bc-result'); if (r) { r.style.color = 'var(--muted)'; r.textContent = 'Refreshing stats from ballchasing…'; }
  send('ballchasing_refresh_stats', { leagueId: lg.id });
});

// Push team totals to the league-stats overlay (reuses set_league_stats — same overlay as the
// manual Stats tab, but sourced from the ballchasing sink).
el('lg-bc-push-stats')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const bs = lg.ballchasingStats || {};
  if (!Object.keys(bs).length) { lgStatus('No Ballchasing team stats yet — Refresh Stats first.', false); return; }
  const cols = [['goals', 'Goals'], ['assists', 'Assists'], ['saves', 'Saves'], ['shots', 'Shots'], ['mvps', 'MVPs'], ['demos', 'Demos']];
  const columns = cols.map((c) => ({ key: c[0], label: c[1], group: 'Ballchasing' }));
  const rows = (lg.teams || []).filter((tm) => bs[tm.id]).map((tm) => {
    const s = bs[tm.id] || {}, rt = lgResolveTeam(tm);
    const values = {}; cols.forEach((c) => { values[c[0]] = s[c[0]] || 0; });
    return { name: rt.name || tm.teamName || 'Team', logo: rt.logo || null, color: tm.color || null, values };
  });
  const title = [lg.name, lg.season].filter(Boolean).join(' — ');
  send('set_league_stats', { visible: true, title: title || 'Team Stats', subtitle: 'via ballchasing.com', columns, rows });
  lgStatus('Ballchasing team stats pushed to the league-stats overlay.', true);
});

// Push the per-player leaderboard to its own overlay (state.leagueLeaderboard).
el('lg-bc-push-leaderboard')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const players = Object.values(lg.ballchasingPlayers || {});
  if (!players.length) { lgStatus('No Ballchasing player stats yet — Refresh Stats first.', false); return; }
  const cols = [['games', 'GP'], ['goals', 'Goals'], ['assists', 'Assists'], ['saves', 'Saves'], ['shots', 'Shots'], ['mvps', 'MVPs']];
  const columns = cols.map((c) => ({ key: c[0], label: c[1] }));
  const rows = players.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 20).map((p) => {
    const values = {}; cols.forEach((c) => { values[c[0]] = p[c[0]] || 0; });
    return { name: p.name || 'Player', team: p.teamName || '', values };
  });
  const title = [lg.name, lg.season].filter(Boolean).join(' — ');
  send('set_league_leaderboard', { visible: true, title: title || 'Player Leaderboard', subtitle: 'via ballchasing.com', columns, rows });
  lgStatus('Player leaderboard pushed to the league-leaderboard overlay.', true);
});

// Auto-upload folder watcher (global setting; the active league is the one currently open).
el('lg-bc-auto-toggle')?.addEventListener('change', function () {
  const lg = lgActive();
  const au = (currentState.ballchasing && currentState.ballchasing.autoUpload) || {};
  send('set_ballchasing_autoupload', { enabled: this.checked, folder: au.folder || '', activeLeagueId: lg ? lg.id : (au.activeLeagueId || '') });
});
el('lg-bc-auto-folder')?.addEventListener('click', () => send('ballchasing_pick_autoupload_folder', {}));

window._handleBallchasingLeagueResult = function (data) {
  const r = el('lg-bc-result');
  if (r) {
    r.style.color = data.ok ? '#86efac' : '#f87171';
    r.textContent = data.message || '';
  }
};

function lgComputeStandingsFromSchedule() {
  const lg = lgActive(); if (!lg) return;
  // In manual mode the table is the record — rebuilding from the schedule would silently erase
  // every off-schedule result the producer entered by hand.
  if (lgStandingsMode(lg) === 'manual') {
    lgStatus('Standings are set to Manual — switch the source to "From schedule" first if you want to rebuild from fixtures.', false);
    return;
  }
  const completed = (lg.schedule || []).filter(m => m.result && (m.result.scoreA != null || m.result.scoreB != null));
  if (!completed.length) {
    // Nothing to aggregate — but still do the half of the job that CAN be done (seed a row per team
    // and apply the chosen ordering) rather than dead-ending on an error.
    lgStEnsureRows(lg);
    const sorted = lgStApplySort(lg);
    lgSave(); lgRenderStandingsTab();
    lgStatus(sorted
      ? `No completed matches in the schedule yet — table re-sorted by ${lgStSortLabel()}. Add results to fill in the numbers.`
      : 'No completed matches in schedule — add results first, then recalculate.', false);
    return;
  }
  lg.standings = lgAggregateFromSchedule(lg);   // comes back in league-rules order
  lgStApplySort(lg);                            // ...then honour the producer's chosen metric
  lgRenderStandingsTab(); lgSave();
  lgStatus(_lgStSort.key && _lgStSort.key !== 'auto'
    ? `Standings recalculated from schedule, sorted by ${lgStSortLabel()}.`
    : 'Standings recalculated from schedule.', true);
}

// Diff the stored standings against a fresh schedule-based recompute, WITHOUT mutating anything —
// lets the Standings tab warn before a hand-edit is silently blown away by Recalculate.
function lgStandingsDrift(lg) {
  if (!lg || !(lg.schedule || []).length) return { inSync: true, diffCount: 0 };
  const fresh = lgAggregateFromSchedule(lg);
  const freshById = {}; fresh.forEach((s) => { freshById[s.teamId] = s; });
  const storedById = {}; (lg.standings || []).forEach((s) => { storedById[s.teamId] = s; });
  const keys = ['w', 'l', 't', 'gf', 'ga', 'pts', 'subW', 'subL'];
  const ids = new Set([...Object.keys(freshById), ...Object.keys(storedById)]);
  let diffCount = 0;
  ids.forEach((id) => {
    const f = freshById[id] || { w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0 };
    const s = storedById[id] || { w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0 };
    if (keys.some((k) => (f[k] || 0) !== (s[k] || 0))) diffCount++;
  });
  return { inSync: diffCount === 0, diffCount };
}

// ── schedule tab ──────────────────────────────────────────────────────────
function lgPopulateScheduleSelects() {
  const lg = lgActive(); if (!lg) return;
  const opts = (curId) => '<option value="">— Team —</option>' + (lg.teams || []).map((tm) => {
    const n = lgResolveTeam(tm).name;
    return `<option value="${tm.id}"${tm.id === curId ? ' selected' : ''}>${n.replace(/</g, '&lt;')}</option>`;
  }).join('');
  const sa = el('lg-sch-a'), sb = el('lg-sch-b');
  if (sa) sa.innerHTML = opts(sa.value); if (sb) sb.innerHTML = opts(sb.value);
}
// Match ids whose per-game breakdown panel is currently expanded in the Schedule tab — pure UI
// state, not saved to the league, so it just needs to survive re-renders within this session.
const _lgExpandedGames = new Set();

function lgRenderScheduleTab() {
  const lg = lgActive(); const wrap = el('lg2-schedule'); if (!wrap || !lg) return;
  lgPopulateScheduleSelects();
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  const schedule = lg.schedule || [];
  if (!schedule.length) { wrap.innerHTML = '<div class="lg-empty">No matches yet. Add one above or generate a round-robin.</div>'; return; }
  const byWeek = {};
  for (const m of schedule) { const w = m.week || ''; (byWeek[w] = byWeek[w] || []).push(m); }
  const teamName = (id, fallback) => { const tm = (lg.teams || []).find((t) => t.id === id); return tm ? lgResolveTeam(tm).name : (fallback || '?'); };
  wrap.innerHTML = Object.entries(byWeek).map(([week, matches]) => `
    <div class="lg2-schedule-week">
      ${week ? `<div class="lg2-week-label">Week ${esc(week)}</div>` : ''}
      ${matches.map((m) => {
        const r = m.result || {};
        const hasResult = r.scoreA != null && r.scoreB != null;
        const winner = hasResult ? (Number(r.scoreA) > Number(r.scoreB) ? 'A' : Number(r.scoreB) > Number(r.scoreA) ? 'B' : 'draw') : null;
        const aName = teamName(m.teamA, m.sggTeamA), bName = teamName(m.teamB, m.sggTeamB);
        // Imported (start.gg-synced) rows can fail to fuzzy-match onto a league team — teamA/teamB
        // stays null while the raw platform name survives in sggTeamA/sggTeamB. Unmatched rows are
        // silently excluded from standings recalculation, so surface a picker rather than hiding it.
        const aUnmatched = !m.teamA && m.sggTeamA;
        const bUnmatched = !m.teamB && m.sggTeamB;
        const unmatchedOpts = (raw) => '<option value="">Unmatched — pick a team…</option>' + (lg.teams || []).map((tm) =>
          `<option value="${tm.id}">${esc(lgResolveTeam(tm).name)}</option>`).join('') +
          (raw ? `<option value="" disabled>(start.gg: ${esc(raw)})</option>` : '');
        const dtStr = [m.date, m.time].filter(Boolean).map(esc).join(' · ');
        // Per-game breakdown is optional — a match with 0 games keeps today's single-number series
        // entry; once at least 1 game is logged, the series score is derived from the games below
        // (real per-game totals also then feed GF/GA in standings instead of the series tally).
        const hasGames = Array.isArray(m.games) && m.games.length > 0;
        const tally = lgMatchTally(m);
        const expanded = _lgExpandedGames.has(m.id);
        const gamesRows = expanded ? `
          <div class="lg2-match-games" style="display:flex;flex-direction:column;gap:4px;margin-top:6px;padding:8px;background:rgba(255,255,255,.03);border-radius:6px;">
            ${(m.games || []).map((g, gi) => `
              <div class="lg2-game-row" style="display:flex;align-items:center;gap:6px;">
                <span style="color:var(--muted);font-size:11px;min-width:24px;">G${gi + 1}</span>
                <input type="number" class="input-text lg2-game-a" data-mid="${m.id}" data-gi="${gi}" value="${g.scoreA ?? ''}" min="0" placeholder="—" style="width:64px;">
                <span style="color:var(--muted);">:</span>
                <input type="number" class="input-text lg2-game-b" data-mid="${m.id}" data-gi="${gi}" value="${g.scoreB ?? ''}" min="0" placeholder="—" style="width:64px;">
                <button class="lg-del lg2-game-del" data-mid="${m.id}" data-gi="${gi}" title="Remove game">×</button>
              </div>`).join('')}
            <button class="btn btn-ghost btn-xs lg2-game-add" data-mid="${m.id}" style="align-self:flex-start;">+ Add Game</button>
          </div>` : '';
        return `<div class="lg2-match-item" data-mid="${m.id}">
          <div class="lg2-match-row">
            <div class="lg2-match-teams">
              ${aUnmatched
                ? `<select class="input-text lg2-unmatched-sel" data-mid="${m.id}" data-side="A" style="border-color:var(--warn,#c98a1f);color:var(--warn,#c98a1f);max-width:180px;">${unmatchedOpts(m.sggTeamA)}</select>`
                : `<span${winner === 'A' ? ' style="font-weight:900"' : winner === 'B' ? ' style="color:var(--muted)"' : ''}>${esc(aName)}</span>`}
              <span style="color:var(--muted);margin:0 6px;">vs</span>
              ${bUnmatched
                ? `<select class="input-text lg2-unmatched-sel" data-mid="${m.id}" data-side="B" style="border-color:var(--warn,#c98a1f);color:var(--warn,#c98a1f);max-width:180px;">${unmatchedOpts(m.sggTeamB)}</select>`
                : `<span${winner === 'B' ? ' style="font-weight:900"' : winner === 'A' ? ' style="color:var(--muted)"' : ''}>${esc(bName)}</span>`}
            </div>
            <span class="lg2-match-fmt">${esc(m.format || 'BO3')}</span>
            ${dtStr ? `<span class="lg2-match-date">${dtStr}</span>` : ''}
            <div class="lg2-match-score">
              ${hasGames
                ? `<span class="lg2-series-derived" title="Derived from ${m.games.length} game(s) below" style="font-weight:800;">${tally.sa}–${tally.sb}</span>`
                : `<input type="number" class="input-text lg2-score-a" data-mid="${m.id}" value="${r.scoreA ?? ''}" placeholder="—" min="0">
                   <span style="color:var(--muted);font-weight:700;">:</span>
                   <input type="number" class="input-text lg2-score-b" data-mid="${m.id}" value="${r.scoreB ?? ''}" placeholder="—" min="0">`}
              <label class="lg2-ot-chk" title="This result went to overtime" style="display:flex;align-items:center;gap:3px;font-size:11px;color:var(--muted);">
                <input type="checkbox" class="lg2-ot-inp" data-mid="${m.id}" ${r.ot ? 'checked' : ''}>OT
              </label>
            </div>
            <button class="btn btn-ghost btn-xs lg2-match-games-toggle" data-mid="${m.id}">${hasGames ? `Games (${m.games.length})` : '+ Games'}</button>
            ${(function () { const cap = (currentState && currentState.leagueCapture) || {}; const armed = cap.active && cap.matchId === m.id; return `<button class="btn btn-ghost btn-xs lg2-match-record${armed ? ' armed' : ''}" data-mid="${m.id}" title="Record the spectated result of this match into the league">${armed ? '● Recording' : 'Record'}</button>`; })()}
            <button class="btn btn-ghost btn-xs lg2-match-live" data-mid="${m.id}">Go Live</button>
            <button class="lg-del lg2-match-del" data-mid="${m.id}" title="Remove">×</button>
          </div>
          ${gamesRows}
          <div class="lg2-match-extra">
            <input type="text" class="input-text lg2-match-notes-inp" data-mid="${m.id}" value="${esc(m.notes || '')}" placeholder="Notes…">
            <input type="url" class="input-text lg2-match-vod-inp" data-mid="${m.id}" value="${esc(m.vod || '')}" placeholder="VOD link…">
          </div>
        </div>`;
      }).join('')}
    </div>`).join('');
  const saveScore = (mid) => {
    const m = (lg.schedule || []).find((x) => x.id === mid); if (!m) return;
    const ia = wrap.querySelector(`.lg2-score-a[data-mid="${mid}"]`);
    const ib = wrap.querySelector(`.lg2-score-b[data-mid="${mid}"]`);
    m.result = m.result || {};
    m.result.scoreA = ia && ia.value !== '' ? Number(ia.value) : null;
    m.result.scoreB = ib && ib.value !== '' ? Number(ib.value) : null;
    const hasResult = m.result.scoreA != null && m.result.scoreB != null;
    if (hasResult) lg.standings = lgAggregateFromSchedule(lg);
    lgSave(); lgRenderScheduleTab();
    if (hasResult && _lgActiveTab === 'standings') lgRenderStandingsTab();
  };
  wrap.querySelectorAll('.lg2-score-a, .lg2-score-b').forEach((inp) => inp.addEventListener('change', () => saveScore(inp.dataset.mid)));
  wrap.querySelectorAll('.lg2-ot-inp').forEach((inp) => inp.addEventListener('change', () => {
    const m = (lg.schedule || []).find((x) => x.id === inp.dataset.mid); if (!m) return;
    m.result = m.result || {}; m.result.ot = inp.checked; lgSave();
  }));
  wrap.querySelectorAll('.lg2-match-games-toggle').forEach((b) => b.addEventListener('click', () => {
    const mid = b.dataset.mid;
    if (_lgExpandedGames.has(mid)) _lgExpandedGames.delete(mid); else _lgExpandedGames.add(mid);
    lgRenderScheduleTab();
  }));
  wrap.querySelectorAll('.lg2-game-add').forEach((b) => b.addEventListener('click', () => {
    const m = (lg.schedule || []).find((x) => x.id === b.dataset.mid); if (!m) return;
    m.games = m.games || []; m.games.push({ scoreA: null, scoreB: null });
    _lgExpandedGames.add(m.id);
    lgSave(); lgRenderScheduleTab();
  }));
  wrap.querySelectorAll('.lg2-game-del').forEach((b) => b.addEventListener('click', () => {
    const m = (lg.schedule || []).find((x) => x.id === b.dataset.mid); if (!m) return;
    m.games = (m.games || []).filter((_, i) => String(i) !== b.dataset.gi);
    lgSave(); lgRenderScheduleTab();
  }));
  wrap.querySelectorAll('.lg2-game-a, .lg2-game-b').forEach((inp) => inp.addEventListener('change', () => {
    const m = (lg.schedule || []).find((x) => x.id === inp.dataset.mid); if (!m || !Array.isArray(m.games)) return;
    const g = m.games[Number(inp.dataset.gi)]; if (!g) return;
    const v = inp.value !== '' ? Number(inp.value) : null;
    if (inp.classList.contains('lg2-game-a')) g.scoreA = v; else g.scoreB = v;
    lg.standings = lgAggregateFromSchedule(lg);
    lgSave(); lgRenderScheduleTab();
    if (_lgActiveTab === 'standings') lgRenderStandingsTab();
  }));
  wrap.querySelectorAll('.lg2-unmatched-sel').forEach((sel) => sel.addEventListener('change', () => {
    if (!sel.value) return;
    const m = (lg.schedule || []).find((x) => x.id === sel.dataset.mid); if (!m) return;
    if (sel.dataset.side === 'A') m.teamA = sel.value; else m.teamB = sel.value;
    lgSave(); lgRenderScheduleTab(); lgRenderStandingsTab();
    lgStatus('Match linked — Recalculate standings to include it.', true);
  }));
  wrap.querySelectorAll('.lg2-match-del').forEach((b) => b.addEventListener('click', () => {
    lg.schedule = (lg.schedule || []).filter((m) => m.id !== b.dataset.mid);
    lg.standings = lgAggregateFromSchedule(lg);
    lgRenderScheduleTab(); lgSave();
    if (_lgActiveTab === 'standings') lgRenderStandingsTab();
  }));
  wrap.querySelectorAll('.lg2-match-live').forEach((b) => b.addEventListener('click', () => {
    const m = (lg.schedule || []).find((x) => x.id === b.dataset.mid); if (!m) return;
    const ta = (lg.teams || []).find((t) => t.id === m.teamA), tb = (lg.teams || []).find((t) => t.id === m.teamB);
    if (!ta || !tb) { lgStatus('Add both teams to the Roster tab first.', false); return; }
    const ra = lgResolveTeam(ta), rb = lgResolveTeam(tb);
    send('set_team', { side: 'blue',   name: ra.name, logo: ra.logo || null, players: ra.players });
    send('set_team', { side: 'orange', name: rb.name, logo: rb.logo || null, players: rb.players });
    send('reset_series'); lgStatus(`${ra.name} vs ${rb.name} pushed live.`, true);
  }));
  wrap.querySelectorAll('.lg2-match-record').forEach((b) => b.addEventListener('click', () => {
    const cap = (currentState && currentState.leagueCapture) || {};
    if (cap.active && cap.matchId === b.dataset.mid) { send('league_capture_stop', {}); return; }   // toggle off
    const m = (lg.schedule || []).find((x) => x.id === b.dataset.mid); if (!m) return;
    if (!m.teamA || !m.teamB) { lgStatus('Both teams must be assigned before recording.', false); return; }
    send('league_capture_arm', { leagueId: lg.id, matchId: m.id });
    lgStatus('Armed — the next spectated series records into this match (saves when it clinches).', true);
  }));
  wrap.querySelectorAll('.lg2-match-notes-inp').forEach(inp => inp.addEventListener('change', () => {
    const m = (lg.schedule || []).find(x => x.id === inp.dataset.mid); if (!m) return;
    m.notes = inp.value.trim(); lgSave();
  }));
  lgRenderCaptureBar();
  wrap.querySelectorAll('.lg2-match-vod-inp').forEach(inp => inp.addEventListener('change', () => {
    const m = (lg.schedule || []).find(x => x.id === inp.dataset.mid); if (!m) return;
    m.vod = inp.value.trim(); lgSave();
  }));
}
// Live status of the producer-armed spectated-match capture (state.leagueCapture). Re-rendered on
// every full_state (see app.js hook) so it ticks up as games finish.
function lgRenderCaptureBar() {
  const bar = el('lg-capture-bar'); if (!bar) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cap = (currentState && currentState.leagueCapture) || {};
  if (!cap.active) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  const games = cap.games || [];
  const sa = games.filter((g) => g.scoreA > g.scoreB).length;
  const sb = games.filter((g) => g.scoreB > g.scoreA).length;
  bar.style.display = '';
  bar.innerHTML = `<span class="lg-cap-dot"></span>
    <span class="lg-cap-txt"><strong>Recording spectated match</strong> — ${esc(cap.teamA)} <b>${sa}</b>&ndash;<b>${sb}</b> ${esc(cap.teamB)} · Bo${cap.bestOf} · game ${games.length + 1} <span class="lg-cap-hint">saves automatically when the series clinches</span></span>
    <button class="btn btn-primary btn-xs" id="lg-cap-save" title="Write the current games into the match now">Save now</button>
    <button class="btn btn-ghost btn-xs" id="lg-cap-stop" title="Stop recording without saving">Stop</button>`;
  el('lg-cap-save')?.addEventListener('click', () => send('league_capture_save', {}));
  el('lg-cap-stop')?.addEventListener('click', () => send('league_capture_stop', {}));
}
function lgAddMatch() {
  const lg = lgActive(); if (!lg) return;
  const a = el('lg-sch-a')?.value, b = el('lg-sch-b')?.value;
  if (!a || !b) { lgStatus('Pick both teams.', false); return; }
  if (a === b) { lgStatus('Pick two different teams.', false); return; }
  const fmt = el('lg-sch-fmt')?.value || 'BO3';
  const week = el('lg-sch-week')?.value.trim() || '';
  const date = el('lg-sch-date')?.value || '';
  const time = el('lg-sch-time')?.value || '';
  lg.schedule = lg.schedule || [];
  lg.schedule.push({ id: lgUid('m'), teamA: a, teamB: b, format: fmt, week, date, time, result: { scoreA: null, scoreB: null, ot: false }, games: [] });
  lgRenderScheduleTab(); lgSave();
}
// Circle-method round-robin: returns array of rounds, each round = array of [teamA, teamB] pairs.
function _rrRounds(teams) {
  const t = teams.length % 2 === 0 ? [...teams] : [...teams, null];
  const half = t.length / 2, rounds = [];
  let circle = t.slice(1);
  for (let r = 0; r < t.length - 1; r++) {
    const round = [];
    if (t[0] !== null && circle[0] !== null) round.push([t[0], circle[0]]);
    for (let i = 1; i < half; i++) {
      const a = circle[i], b = circle[circle.length - i];
      if (a !== null && b !== null) round.push([a, b]);
    }
    rounds.push(round);
    circle = [circle[circle.length - 1], ...circle.slice(0, circle.length - 1)];
  }
  return rounds;
}
function _nextWeekNum(lg) {
  const weeks = (lg.schedule || []).map(m => parseInt(m.week, 10)).filter(n => !isNaN(n));
  return weeks.length ? Math.max(...weeks) + 1 : 1;
}

function lgGenerateRoundRobin() {
  const lg = lgActive(); if (!lg) return;
  const teams = lg.teams || [];
  if (teams.length < 2) { lgStatus('Need at least 2 teams for a round-robin.', false); return; }
  const fmt = el('lg-sch-fmt')?.value || 'BO3';
  const rounds = _rrRounds(teams);
  const startWeek = _nextWeekNum(lg);
  const existing = new Set((lg.schedule || []).map(m => [m.teamA, m.teamB].sort().join('|')));
  let added = 0;
  rounds.forEach((round, ri) => {
    const week = String(startWeek + ri);
    round.forEach(([ta, tb]) => {
      const key = [ta.id, tb.id].sort().join('|');
      if (!existing.has(key)) {
        lg.schedule = lg.schedule || [];
        lg.schedule.push({ id: lgUid('m'), teamA: ta.id, teamB: tb.id, format: fmt, week, date: '', result: { scoreA: null, scoreB: null, ot: false }, games: [] });
        existing.add(key); added++;
      }
    });
  });
  if (!added) { lgStatus('All round-robin matchups already exist.', false); return; }
  lgRenderScheduleTab(); lgSave();
  lgStatus(`Generated ${added} matchup${added !== 1 ? 's' : ''} across ${rounds.length} weeks.`, true);
}

function lgGenerateDoubleRoundRobin() {
  const lg = lgActive(); if (!lg) return;
  const teams = lg.teams || [];
  if (teams.length < 2) { lgStatus('Need at least 2 teams.', false); return; }
  const fmt = el('lg-sch-fmt')?.value || 'BO3';
  const rounds = _rrRounds(teams);
  const startWeek = _nextWeekNum(lg);
  const existing = new Set((lg.schedule || []).map(m => `${m.teamA}|${m.teamB}`));
  let added = 0;
  rounds.forEach((round, ri) => {
    const week = String(startWeek + ri);
    round.forEach(([ta, tb]) => {
      if (!existing.has(`${ta.id}|${tb.id}`)) {
        lg.schedule = lg.schedule || [];
        lg.schedule.push({ id: lgUid('m'), teamA: ta.id, teamB: tb.id, format: fmt, week, date: '', result: { scoreA: null, scoreB: null, ot: false }, games: [] });
        existing.add(`${ta.id}|${tb.id}`); added++;
      }
    });
  });
  rounds.forEach((round, ri) => {
    const week = String(startWeek + rounds.length + ri);
    round.forEach(([ta, tb]) => {
      if (!existing.has(`${tb.id}|${ta.id}`)) {
        lg.schedule = lg.schedule || [];
        lg.schedule.push({ id: lgUid('m'), teamA: tb.id, teamB: ta.id, format: fmt, week, date: '', result: { scoreA: null, scoreB: null, ot: false }, games: [] });
        existing.add(`${tb.id}|${ta.id}`); added++;
      }
    });
  });
  if (!added) { lgStatus('All double round-robin matchups already exist.', false); return; }
  lgRenderScheduleTab(); lgSave();
  lgStatus(`Generated ${added} matchups (DRR, ${rounds.length * 2} weeks).`, true);
}

// ── settings tab ──────────────────────────────────────────────────────────
function lgRenderSggSource(lg) {
  const sel = el('lg-sgg-selected');
  if (!sel || !lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  if (lg.startggSource) {
    const name = lg.sggLeagueName || lg.startggSource;
    sel.innerHTML = `<span class="lg-sgg-chip">${esc(name)} <button class="lg-sgg-chip-del" title="Remove source">×</button></span>`;
    sel.querySelector('.lg-sgg-chip-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      lg.startggSource = ''; lg.sggLeagueName = ''; lg.sggSyncedAt = null; lgSave();
      lgRenderSggSource(lg);
    });
  } else {
    sel.innerHTML = '';
  }
  const syncTs = el('lg-sgg-sync-ts');
  if (syncTs) syncTs.textContent = lg.sggSyncedAt ? 'Last synced: ' + new Date(lg.sggSyncedAt).toLocaleString() : '';
}

function lgRenderSettingsTab() {
  const lg = lgActive(); if (!lg) return;
  const typeEl = el('lg-type'); if (typeEl) typeEl.value = lg.type || 'team';
  const gameEl = el('lg-game'); if (gameEl) { lgGameOptions(gameEl); gameEl.value = lg.game || ''; }
  const seasonEl = el('lg-season'); if (seasonEl && document.activeElement !== seasonEl) seasonEl.value = lg.season || '';
  const isSalary = lg.type === 'salary';
  document.querySelectorAll('.lg-salary-field').forEach((el2) => { el2.style.display = isSalary ? '' : 'none'; });
  const capEl = el('lg-cap'); if (capEl && document.activeElement !== capEl) capEl.value = lg.salaryCap || 0;
  const scEl = el('lg-starter-count'); if (scEl && document.activeElement !== scEl) scEl.value = lg.starterCount || 3;
  lgRenderSggSource(lg);
  const evEl = el('lg-linked-event');
  if (evEl) {
    const evs = currentState.myEvents || [];
    evEl.innerHTML = '<option value="">— None —</option>' + evs.map((e) => `<option value="${e.id}">${(e.name || 'Event').replace(/</g, '&lt;')}</option>`).join('');
    evEl.value = (lg.linkedEventId && evs.some((e) => e.id === lg.linkedEventId)) ? lg.linkedEventId : '';
  }
  const linkStatus = el('lg-linked-event-status');
  if (linkStatus) linkStatus.textContent = lg.linkedEventId ? 'Importing adds any new roster teams — already-added teams are left alone.' : '';
  const sc = lg.scoring || {};
  const setV = (id, v) => { const e = el(id); if (e && document.activeElement !== e) e.value = v; };
  setV('lg-pts-win', sc.win ?? 3); setV('lg-pts-loss', sc.loss ?? 0); setV('lg-pts-draw', sc.draw ?? 1); setV('lg-pts-otw', sc.otw ?? 2);
  setV('lg-playoff-n', lg.playoffN || 4);
  const tbEl = el('lg-tiebreak');
  if (tbEl) {
    const lbl = lgStatLabels(lg);
    const optGd = tbEl.querySelector('option[value="gd"]'); if (optGd) optGd.textContent = lbl.diffFull;
    const optGf = tbEl.querySelector('option[value="gf"]'); if (optGf) optGf.textContent = lbl.forFull;
    tbEl.value = lg.tiebreak || 'gd';
  }
  lgRenderSeasonHistory();
  lgRenderCloudSyncStatus();
}

// ── website sync (bidirectional, opt-in per league — see CompeteLeague on the website) ──
function lgRenderCloudSyncStatus() {
  const lg = lgActive();
  const status = el('lg-cloud-sync-status');
  if (!status) return;
  status.textContent = !lg ? '' : (lg.cloudLeagueId ? 'Synced to the website.' : 'Not synced — click "Sync to Website" to push this league.');
}
el('lg-cloud-push')?.addEventListener('click', async () => {
  const lg = lgActive(); if (!lg) return;
  if (!window._cloudWorkspaceId) { lgStatus('Sign in to the cloud (Settings) first.', false); return; }
  // Only the first push creates the website's copy — every push after that OVERWRITES it, so
  // that's the moment that needs an explicit yes, not the harmless first-time case.
  if (lg.cloudLeagueId) {
    const ok = await appConfirm(`Sync "${lg.name}" to the website? This overwrites the website's copy of this league's scoring/teams/schedule with what's here — any edits made there since the last sync will be lost.`, 'Sync & Overwrite');
    if (!ok) return;
  }
  send('cloud_push_league', { orgId: window._cloudWorkspaceId, leagueId: lg.id });
});

// Leagues created on the website for this org — discovery list + "Pull in" action.
function lgRenderCloudList(leagues) {
  const wrap = el('lg-cloud-list'); if (!wrap) return;
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (!leagues || !leagues.length) {
    wrap.innerHTML = '<div class="field-label" style="font-size:11px;color:var(--muted);">No leagues on the website yet.</div>';
    return;
  }
  wrap.innerHTML = leagues.map((l) => `<div class="preset-item" style="display:flex;align-items:center;gap:10px;">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:700;color:#e8eaf0;">${esc(l.name)}
        <span style="margin-left:6px;font-size:10px;font-weight:500;color:#9090a8;">${(l._count && l._count.teams) || 0} teams &middot; ${(l._count && l._count.matches) || 0} matches</span>
      </span>
      <button class="btn btn-secondary btn-xs lg-cloud-pull-btn" data-id="${esc(l.id)}">Pull in</button>
    </div>`).join('');
  wrap.querySelectorAll('.lg-cloud-pull-btn').forEach((btn) => btn.addEventListener('click', () => {
    if (!window._cloudWorkspaceId) return;
    send('cloud_pull_league', { orgId: window._cloudWorkspaceId, leagueId: btn.dataset.id });
  }));
}
window.lgRenderCloudList = lgRenderCloudList;
el('lg-cloud-browse-toggle')?.addEventListener('click', () => {
  const panel = el('lg-cloud-panel'); if (!panel) return;
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? '' : 'none';
  if (opening && window._cloudWorkspaceId) send('cloud_list_leagues', { orgId: window._cloudWorkspaceId });
});

// ── season archive ──────────────────────────────────────────────────────────
// Snapshot the current schedule/standings/settings into lg.seasonHistory, then reset the live
// league for a fresh season. Archived team refs store only {id, teamName} — never embedded
// logo/roster blobs — so archiving never multiplies the base64-logo broadcast cost (leagues is a
// 'library'-tier item re-sent on every leaguesVer bump).
function lgArchiveSeason() {
  const lg = lgActive(); if (!lg) return;
  if (!(lg.schedule || []).length && !(lg.standings || []).length) {
    lgStatus('Nothing to archive yet — add a schedule or standings first.', false);
    return;
  }
  appConfirm(`Archive "${lg.season || 'this season'}"? The schedule and standings will be snapshotted, then cleared for a new season. Roster carries over.`, 'Archive').then((ok) => {
    if (!ok) return;
    lg.seasonHistory = lg.seasonHistory || [];
    lg.seasonHistory.push({
      id: lgUid('szn'),
      season: lg.season || '',
      archivedAt: Date.now(),
      scoring: { ...(lg.scoring || {}) },
      tiebreak: lg.tiebreak || 'gd',
      playoffN: lg.playoffN || 4,
      starterCount: lg.starterCount || 3,
      teams: (lg.teams || []).map((t) => ({ id: t.id, teamName: t.teamName || t.name || '' })),
      standings: (lg.standings || []).map((s) => ({ ...s })),
      schedule: (lg.schedule || []).map((m) => ({ ...m, result: m.result ? { ...m.result } : m.result })),
      ballchasing: lgSnapshotBallchasing(lg),
      // Manual in-game Stats-tab totals (per team) also carry no season boundary of their own —
      // team ids persist across archive ("roster carries over"), so without this a returning
      // team's new-season Stats tab silently started from LAST season's cumulative numbers
      // instead of zero, and there was nowhere to recover the old totals from either.
      stats: JSON.parse(JSON.stringify(lg.stats || {}))
    });
    lg.schedule = [];
    lg.standings = [];
    lg.status = 'active';
    lg.season = '';
    lg.stats = {};
    lgResetBallchasing(lg);
    lgRenderOverview(); lgRenderStandingsTab(); lgRenderScheduleTab(); lgRenderSettingsTab(); lgRenderStatsTab(); lgSave();
    lgStatus('Season archived. Schedule/standings cleared — roster kept.', true);
  });
}

// Ballchasing has no season boundary of its own (a group is just an ever-growing bucket of replays),
// so an archive/restore must explicitly snapshot + reset it — otherwise leaving groupId wired up would
// silently blend next season's replays into a group still tagged with last season's stats. Snapshot
// only if licensing was ever enabled (groupId set); a league that never touched Ballchasing gets null.
function lgSnapshotBallchasing(lg) {
  if (!lg.ballchasing || !lg.ballchasing.groupId) return null;
  return {
    groupId: lg.ballchasing.groupId,
    groupUrl: lg.ballchasing.groupUrl || '',
    ballchasingStats: JSON.parse(JSON.stringify(lg.ballchasingStats || {})),
    ballchasingPlayers: JSON.parse(JSON.stringify(lg.ballchasingPlayers || {}))
  };
}
function lgResetBallchasing(lg) {
  lg.ballchasing = { groupId: '', groupUrl: '', enabledAt: 0, playerLinks: [], pendingReplays: [], mvpCounts: {}, processedReplayIds: [], lastSyncedAt: null, lastRefreshNote: '' };
  lg.ballchasingStats = {};
  lg.ballchasingPlayers = {};
}

// Restore an archived season back to live — the CURRENT live season is pushed onto seasonHistory
// first (nothing is lost), then the archived snapshot's teams/standings/schedule/settings replace it.
function lgRestoreSeason(seasonHistoryId) {
  const lg = lgActive(); if (!lg) return;
  const snap = (lg.seasonHistory || []).find((s) => s.id === seasonHistoryId);
  if (!snap) return;
  appConfirm(`Restore "${snap.season || 'this archived season'}"? Your current in-progress season will be archived first, then replaced with the archived one.`, 'Restore').then((ok) => {
    if (!ok) return;
    lg.seasonHistory = lg.seasonHistory || [];
    lg.seasonHistory.push({
      id: lgUid('szn'),
      season: lg.season || '',
      archivedAt: Date.now(),
      scoring: { ...(lg.scoring || {}) },
      tiebreak: lg.tiebreak || 'gd',
      playoffN: lg.playoffN || 4,
      starterCount: lg.starterCount || 3,
      teams: (lg.teams || []).map((t) => ({ id: t.id, teamName: t.teamName || t.name || '' })),
      standings: (lg.standings || []).map((s) => ({ ...s })),
      schedule: (lg.schedule || []).map((m) => ({ ...m, result: m.result ? { ...m.result } : m.result })),
      ballchasing: lgSnapshotBallchasing(lg),
      stats: JSON.parse(JSON.stringify(lg.stats || {}))
    });
    lg.seasonHistory = lg.seasonHistory.filter((s) => s.id !== seasonHistoryId);
    lg.teams = snap.teams.map((t) => ({ id: t.id, teamName: t.teamName }));
    lg.standings = (snap.standings || []).map((s) => ({ ...s }));
    lg.schedule = (snap.schedule || []).map((m) => ({ ...m, result: m.result ? { ...m.result } : m.result }));
    lg.season = snap.season || '';
    lg.scoring = { ...(snap.scoring || {}) };
    lg.tiebreak = snap.tiebreak || 'gd';
    lg.playoffN = snap.playoffN || 4;
    lg.starterCount = snap.starterCount || 3;
    // Restore that season's own manual Stats-tab totals instead of leaving the just-archived
    // current season's numbers attached to the restored one.
    lg.stats = JSON.parse(JSON.stringify(snap.stats || {}));
    // Restore that season's own Ballchasing snapshot (if it had one) instead of leaving the
    // just-archived current season's group/stats misattributed to the restored season.
    if (snap.ballchasing && snap.ballchasing.groupId) {
      lg.ballchasing = { groupId: snap.ballchasing.groupId, groupUrl: snap.ballchasing.groupUrl || '', enabledAt: 0, playerLinks: [], pendingReplays: [], mvpCounts: {}, processedReplayIds: [], lastSyncedAt: null, lastRefreshNote: '' };
      lg.ballchasingStats = JSON.parse(JSON.stringify(snap.ballchasing.ballchasingStats || {}));
      lg.ballchasingPlayers = JSON.parse(JSON.stringify(snap.ballchasing.ballchasingPlayers || {}));
    } else {
      lgResetBallchasing(lg);
    }
    lgRenderOverview(); lgRenderTeams(); lgRenderStandingsTab(); lgRenderScheduleTab(); lgRenderSettingsTab(); lgRenderStatsTab(); lgSave();
    lgStatus('Archived season restored to live.', true);
  });
}

function lgRenderSeasonHistory() {
  const wrap = el('lg-season-history'); const lg = lgActive(); if (!wrap || !lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  const history = (lg.seasonHistory || []).slice().sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  if (!history.length) { wrap.innerHTML = '<div class="lg-empty" style="font-size:12px;">No archived seasons yet.</div>'; return; }
  wrap.innerHTML = history.map((s) => `
    <div class="lg2-season-row" data-sid="${s.id}" style="display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--border-soft,rgba(255,255,255,.08));">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:12px;">${esc(s.season || 'Untitled season')}</div>
        <div style="font-size:11px;color:var(--muted);">${new Date(s.archivedAt).toLocaleDateString()} · ${(s.teams || []).length} teams · ${(s.schedule || []).length} matches</div>
      </div>
      <button class="btn btn-ghost btn-xs lg2-season-restore" data-sid="${s.id}" type="button">Restore</button>
    </div>`).join('');
  wrap.querySelectorAll('.lg2-season-restore').forEach((b) => b.addEventListener('click', () => lgRestoreSeason(b.dataset.sid)));
}

// ── overview tab ──────────────────────────────────────────────────────────
function lgRenderRecentResults() {
  const wrap = el('lg2-recent'); const lg = lgActive(); if (!wrap || !lg) return;
  const done = (lg.schedule || []).filter((m) => m.result && m.result.scoreA != null && m.result.scoreB != null);
  if (!done.length) { wrap.innerHTML = '<div class="lg-empty">No results yet.</div>'; return; }
  const teamName = (id) => { const tm = (lg.teams || []).find((t) => t.id === id); return tm ? lgResolveTeam(tm).name : '?'; };
  wrap.innerHTML = done.slice(-5).reverse().map((m) => {
    const sa = Number(m.result.scoreA), sb = Number(m.result.scoreB);
    const an = (teamName(m.teamA) || '').replace(/</g, '&lt;'), bn = (teamName(m.teamB) || '').replace(/</g, '&lt;');
    return `<div class="lg2-result-row">
      <span class="lg2-result-teams">${an} vs ${bn}</span>
      <span class="lg2-result-score">${sa} – ${sb}</span>
      ${m.week ? `<span class="lg2-result-week">Wk ${m.week}</span>` : ''}
    </div>`;
  }).join('');
}
function lgRenderNextMatches() {
  const wrap = el('lg2-next'); const lg = lgActive(); if (!wrap || !lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  const teamName = (id) => { const tm = (lg.teams || []).find((t) => t.id === id); return tm ? lgResolveTeam(tm).name : null; };
  const upcoming = (lg.schedule || [])
    .filter((m) => !m.result || (m.result.scoreA == null && m.result.scoreB == null))
    .slice(0, 4);
  if (!upcoming.length) { wrap.innerHTML = '<div class="lg-empty" style="font-size:12px;">No upcoming matches.</div>'; return; }
  wrap.innerHTML = upcoming.map((m) => {
    const an = esc(teamName(m.teamA) || m.sggTeamA || '?'), bn = esc(teamName(m.teamB) || m.sggTeamB || '?');
    const dt = [m.date, m.time].filter(Boolean).join(' · ');
    return `<div class="lg2-next-row">
      <span class="lg2-next-teams">${an} <span style="opacity:.5">vs</span> ${bn}</span>
      ${m.format ? `<span class="lg2-match-fmt">${esc(m.format)}</span>` : ''}
      ${m.week ? `<span class="lg2-result-week">Wk ${esc(m.week)}</span>` : ''}
      ${dt ? `<span class="lg2-next-date">${esc(dt)}</span>` : ''}
      <button class="btn btn-ghost btn-xs lg2-next-live" data-mid="${esc(m.id)}">Go Live</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.lg2-next-live').forEach((b) => b.addEventListener('click', () => {
    const m = (lg.schedule || []).find((x) => x.id === b.dataset.mid); if (!m) return;
    const ta = (lg.teams || []).find((t) => t.id === m.teamA), tb = (lg.teams || []).find((t) => t.id === m.teamB);
    if (!ta || !tb) { lgStatus('Add both teams to the Roster tab first.', false); return; }
    const ra = lgResolveTeam(ta), rb = lgResolveTeam(tb);
    send('set_team', { side: 'blue',   name: ra.name, logo: ra.logo || null, players: (ra.players || []) });
    send('set_team', { side: 'orange', name: rb.name, logo: rb.logo || null, players: (rb.players || []) });
    send('reset_series'); lgStatus(`${ra.name} vs ${rb.name} pushed live.`, true);
  }));
}
// ── Overview cockpit ─────────────────────────────────────────────────────────
const LG_OV_KEY = 'ne_lg_overview_v1';
function lgOvPrefs() { try { return Object.assign({ density: 'comfortable', hidden: [] }, JSON.parse(localStorage.getItem(LG_OV_KEY) || '{}')); } catch { return { density: 'comfortable', hidden: [] }; } }
function lgOvSavePrefs(p) { try { localStorage.setItem(LG_OV_KEY, JSON.stringify(p)); } catch {} }
const LG_OV_CARDS = [['standings', 'Standings'], ['broadcast', 'Broadcast'], ['leaders', 'Leaders'], ['thisweek', 'This Week']];

function lgApplyOvLayout() {
  const p = lgOvPrefs();
  const panel = el('lg2-panel-overview');
  if (panel) panel.classList.toggle('lgov-compact', p.density === 'compact');
  document.querySelectorAll('#lgov-density .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.d === p.density));
  LG_OV_CARDS.forEach(([id]) => { const c = document.querySelector(`.lgov-card[data-card="${id}"]`); if (c) c.style.display = p.hidden.includes(id) ? 'none' : ''; });
  const tg = el('lgov-card-toggles');
  if (tg) {
    tg.innerHTML = LG_OV_CARDS.map(([id, lbl]) => `<button type="button" class="lgov-card-tg${p.hidden.includes(id) ? '' : ' on'}" data-card="${id}">${lbl}</button>`).join('');
    tg.querySelectorAll('.lgov-card-tg').forEach((b) => b.addEventListener('click', () => {
      const pr = lgOvPrefs(); const id = b.dataset.card;
      pr.hidden = pr.hidden.includes(id) ? pr.hidden.filter((x) => x !== id) : [...pr.hidden, id];
      lgOvSavePrefs(pr); lgApplyOvLayout();
    }));
  }
}

// Compact standings snapshot with a playoff cut-line — the landing view of the table.
function lgRenderStandingsSnap() {
  const wrap = el('lgov-standings-snap'); const lg = lgActive(); if (!wrap || !lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  const topN = parseInt((el('lgov-topn') || {}).value, 10); const limit = topN > 0 ? topN : 999;
  const playoffN = lg.playoffN || 0;
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  const teamsById = {}; (lg.teams || []).forEach((t) => { teamsById[t.id] = t; });
  const ordered = (lg.standings && lg.standings.length)
    ? lg.standings.map((s) => teamsById[s.teamId]).filter(Boolean)
    : (lg.teams || []).slice().sort((a, b) => ((byId[b.id] || {}).pts || 0) - ((byId[a.id] || {}).pts || 0));
  if (!ordered.length) { wrap.innerHTML = '<div class="lg-empty">Add teams to see standings.</div>'; return; }
  const gs = lgGameStats(lg.game);
  const rows = ordered.slice(0, limit).map((tm, i) => {
    const s = byId[tm.id] || {}; const r = lgResolveTeam(tm);
    const form = (s.form || []).slice(-5).map((f) => `<span class="lg2-fd lg2-fd-${String(f).toLowerCase()}">${esc(f)}</span>`).join('');
    const cut = playoffN && i === playoffN ? ' lgov-snap-cut' : '';
    return `<tr class="lgov-snap-row${cut}">
      <td class="lgov-snap-pos">${playoffN && i < playoffN ? '<span class="lg2-playoff-dot" title="Playoff spot"></span>' : ''}${i + 1}</td>
      <td class="lgov-snap-team"><img class="lgov-snap-logo" src="${r.logo || gameLogo()}" onerror="this.style.visibility='hidden'"><span>${esc(r.name || tm.teamName || 'Team')}</span></td>
      <td class="lgov-snap-rec">${s.w || 0}<span class="lgov-snap-dim">-</span>${s.l || 0}${s.t ? '<span class="lgov-snap-dim">-</span>' + s.t : ''}</td>
      <td class="lgov-snap-pts">${s.pts || 0}</td>
      <td class="lgov-snap-form">${form}</td>
    </tr>`;
  }).join('');
  wrap.innerHTML = `<table class="lgov-snap-table"><thead><tr><th>#</th><th class="lgov-snap-team">Team</th><th title="Series record">W-L</th><th>Pts</th><th>Form</th></tr></thead><tbody>${rows}</tbody></table>`
    + (topN > 0 && ordered.length > topN ? `<div class="lgov-snap-more">+${ordered.length - topN} more · <span class="lgov-link" id="lgov-snap-viewall">view full</span></div>` : '');
  const va = el('lgov-snap-viewall'); if (va) va.addEventListener('click', () => lgSwitchTab('standings'));
}

// Leaders card — top scorer / most saves / MVP from the Ballchasing sync, plus the points leader.
function lgRenderLeaders() {
  const wrap = el('lgov-leaders'); const lg = lgActive(); if (!wrap || !lg) return;
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  const players = Object.values(lg.ballchasingPlayers || {});
  const chips = [];
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  const ordered = (lg.standings || []).map((s) => ({ tm: (lg.teams || []).find((t) => t.id === s.teamId), s })).filter((x) => x.tm);
  if (ordered.length) { const top = ordered[0]; chips.push(['Points leader', lgResolveTeam(top.tm).name, `${top.s.pts || 0} pts`]); }
  if (players.length) {
    const top = (k) => players.slice().sort((a, b) => (b[k] || 0) - (a[k] || 0))[0];
    const g = top('goals'), sv = top('saves'), mv = top('mvps');
    if (g && g.goals) chips.push(['Top scorer', g.name, `${g.goals} goals`, g.teamName]);
    if (sv && sv.saves) chips.push(['Most saves', sv.name, `${sv.saves} saves`, sv.teamName]);
    if (mv && mv.mvps) chips.push(['Most MVPs', mv.name, `${mv.mvps} MVP`, mv.teamName]);
  }
  if (!chips.length) { wrap.innerHTML = '<div class="lg-empty">Leaders appear once results and Ballchasing stats are in.</div>'; return; }
  wrap.innerHTML = chips.map(([lbl, name, val, sub]) => `<div class="lgov-leader">
    <div class="lgov-leader-lbl">${esc(lbl)}</div>
    <div class="lgov-leader-name">${esc(name)}</div>
    <div class="lgov-leader-val">${esc(val)}${sub ? ` <span class="lgov-leader-sub">${esc(sub)}</span>` : ''}</div>
  </div>`).join('');
}

// ── Broadcast card — the league's graphics rack ──────────────────────────────
// One row per league-driven overlay: what it shows, whether it's currently on air, and its own
// Push / Hide. Standings and Power Rankings deliberately share the standings browser source (same
// table shape), so the on-air pill names whichever was pushed last rather than lighting both.
let _lgStandingsFeed = 'standings';   // 'standings' | 'rankings' — which one last went up
function lgBroadcastRows() {
  const s = currentState || {};
  const up = s.upcoming || {}, stn = s.standings || {}, lst = s.leagueStats || {}, lb = s.leagueLeaderboard || {};
  return [
    { key: 'standings', title: 'Standings', sub: 'League table with form', live: !!stn.visible && _lgStandingsFeed === 'standings',
      push: () => lgPushStandingsToOverlay(parseInt((el('lgov-topn') || {}).value, 10) || 0), hide: () => send('set_standings', { visible: false }) },
    { key: 'rankings', title: 'Power Rankings', sub: 'Computed form-weighted order', live: !!stn.visible && _lgStandingsFeed === 'rankings',
      push: () => lgPushRankingsToOverlay(parseInt((el('lgov-topn') || {}).value, 10) || 0), hide: () => send('set_standings', { visible: false }) },
    { key: 'schedule', title: 'Schedule', sub: 'Weekly fixtures and results', live: !!up.visible && up.source === 'league',
      push: () => lgPushScheduleToOverlay(), hide: () => send('set_upcoming', { visible: false }) },
    { key: 'stats', title: 'Team Stats', sub: 'Season stat board', live: !!lst.visible,
      push: () => { const b = el('lg-stats-push'); if (b) b.click(); else lgStatus('Open the Stats tab once to push team stats.', false); }, hide: () => send('set_league_stats', { visible: false }) },
    { key: 'leaderboard', title: 'Player Leaderboard', sub: 'Top players by stat', live: !!lb.visible,
      push: () => { const b = el('lg-bc-push-leaderboard'); const tab = el('lg2-tab-ballchasing'); if (b && tab && tab.style.display !== 'none') b.click(); else lgStatus('Player leaderboard needs Rocket League + a Ballchasing refresh.', false); }, hide: () => send('set_league_leaderboard', { visible: false }) }
  ];
}
function lgRenderBroadcastCard() {
  const wrap = el('lgov-gfx-rack'); if (!wrap) return;
  const rows = lgBroadcastRows();
  wrap.innerHTML = rows.map((r) => `<div class="lgov-gfx${r.live ? ' on-air' : ''}" data-k="${r.key}">
    <span class="lgov-gfx-dot"></span>
    <span class="lgov-gfx-txt"><b>${r.title}</b><i>${r.sub}</i></span>
    ${r.live ? '<span class="lgov-gfx-live">ON AIR</span>' : ''}
    <button class="btn btn-ghost btn-xs lgov-gfx-hide" data-k="${r.key}" title="Hide this graphic">Hide</button>
    <button class="btn btn-primary btn-xs lgov-gfx-push" data-k="${r.key}">Push</button>
  </div>`).join('');
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  wrap.querySelectorAll('.lgov-gfx-push').forEach((b) => b.addEventListener('click', () => {
    const r = byKey[b.dataset.k]; if (!r) return;
    if (r.key === 'standings' || r.key === 'rankings') _lgStandingsFeed = r.key;
    r.push(); setTimeout(lgRenderBroadcastCard, 120);
  }));
  wrap.querySelectorAll('.lgov-gfx-hide').forEach((b) => b.addEventListener('click', () => {
    const r = byKey[b.dataset.k]; if (!r) return;
    r.hide(); lgStatus(`${r.title} hidden.`, true); setTimeout(lgRenderBroadcastCard, 120);
  }));
}

function lgRenderOverview() {
  const lg = lgActive(); if (!lg) return;
  const schedule = lg.schedule || [];
  const played = schedule.filter((m) => m.result && m.result.scoreA != null).length;
  const total = schedule.length;
  if (el('lg2-stat-teams')) el('lg2-stat-teams').textContent = (lg.teams || []).length;
  if (el('lg2-stat-played')) el('lg2-stat-played').textContent = played;
  if (el('lg2-stat-total')) el('lg2-stat-total').textContent = total;
  if (el('lg2-stat-remaining')) el('lg2-stat-remaining').textContent = total - played;
  if (el('lgov-progress-fill')) el('lgov-progress-fill').style.width = (total ? Math.round((played / total) * 100) : 0) + '%';
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  let leader = null, topPts = -1;
  for (const tm of (lg.teams || [])) { const pts = (byId[tm.id] || {}).pts || 0; if (pts > topPts) { topPts = pts; leader = lgResolveTeam(tm).name; } }
  if (el('lg2-stat-leader')) el('lg2-stat-leader').textContent = ((lg.standings || []).length && leader) ? leader : '—';
  if (el('lg2-stat-seasons')) el('lg2-stat-seasons').textContent = (lg.seasonHistory || []).length;
  // Health chip: standings drift vs schedule.
  const health = el('lgov-health');
  if (health) {
    const drift = (typeof lgStandingsDrift === 'function') ? lgStandingsDrift(lg) : { inSync: true };
    if (!total) { health.className = 'lgov-health lgov-health-idle'; health.textContent = 'No matches scheduled yet'; }
    else if (!drift.inSync) { health.className = 'lgov-health lgov-health-warn'; health.textContent = `Standings differ from results (${drift.diffCount}) — recalc in Standings`; }
    else if (played < total) { health.className = 'lgov-health lgov-health-ok'; health.textContent = `${total - played} match${total - played === 1 ? '' : 'es'} left to play`; }
    else { health.className = 'lgov-health lgov-health-ok'; health.textContent = 'Season complete — all matches played'; }
  }
  // Data source chip — says whether this league is linked to a start.gg league, and takes you to
  // the control. Without this the only hint lived at the bottom of the Settings sub-tab.
  const src = el('lgov-source');
  if (src) {
    if (lg.startggSource) {
      const when = lg.sggSyncedAt ? new Date(lg.sggSyncedAt).toLocaleDateString() : 'never synced';
      src.className = 'lgov-health lgov-health-ok';
      src.textContent = `Linked to start.gg: ${lg.sggLeagueName || lg.startggSource} — ${when}`;
    } else {
      src.className = 'lgov-health lgov-health-idle';
      src.textContent = 'Not linked to a platform — results entered by hand. Click to link a start.gg league.';
    }
    src.onclick = () => { lgSwitchTab('settings'); };
  }
  lgApplyOvLayout();
  lgRenderStandingsSnap(); lgRenderLeaders(); lgRenderBroadcastCard();
  lgRenderMatchup(); lgRenderRecentResults(); lgRenderNextMatches();
}

// ── tab switching ──────────────────────────────────────────────────────────
function lgSwitchTab(name) {
  _lgActiveTab = name;
  document.querySelectorAll('#lg2-tabs .lg2-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['overview', 'roster', 'standings', 'rankings', 'schedule', 'bracket', 'stats', 'brseries', 'ballchasing', 'settings'].forEach((t) => {
    const p = el('lg2-panel-' + t); if (p) p.style.display = t === name ? '' : 'none';
  });
  if (name === 'overview') lgRenderOverview();
  else if (name === 'roster') lgSetRosterView(_lgRosterView);
  else if (name === 'standings') lgRenderStandingsTab();
  else if (name === 'rankings') lgRenderRankingsTab();
  else if (name === 'schedule') lgRenderScheduleTab();
  else if (name === 'bracket') lgRenderBracketTab();
  else if (name === 'stats') lgRenderStatsTab();
  else if (name === 'brseries') lgRenderBrTab();
  else if (name === 'ballchasing') lgRenderBallchasingTab();
  else if (name === 'settings') lgRenderSettingsTab();
}

// ── BR Cups tab ────────────────────────────────────────────────────────────
// A battle-royale league is a SEASON OF CUPS. Each cup (lg.brSeries[]) keeps its own scoring
// table and its own per-match results; lg.brSeason is the server-derived rollup (see
// recomputeBrSeason in server.js — the client never re-implements the scorer, which is exactly
// how a second, subtly-different points engine would get born).
//
// Everything here writes through the SERVER (set_br_result / br_series), not through lgSave():
// the same results back the live board, and routing them through the client's full-replace
// set_leagues would race the lobby panel's writes.
let _lgBrSeriesId = null;
// Set while a create is in flight so the next render selects the cup that was just added — the
// server doesn't auto-bind it (that would swap the on-air board mid-show), so following the live
// cup would otherwise leave the producer looking at the wrong one.
let _lgBrPendingCreate = false;

function lgBrIsBrGame(lg) {
  const games = ((currentState && currentState.brMeta && currentState.brMeta.lobbyGames) || []);
  return !!(lg && games.includes(lg.game));
}
// What the per-match secondary stat is CALLED for this league's game. Fortnite scores elims,
// Rocket League goals, Bedwars beds — the matrix maths is identical, only the label differs.
function lgBrStatLabel(lg) {
  const g = ((currentState.games || {})[(lg && lg.game) || ''] || {});
  if (lgBrIsBrGame(lg)) return { long: 'Elims', short: 'EL' };
  return { long: g.statLabel || 'Stat', short: g.statAbbr || (g.statLabel || 'ST').slice(0, 2).toUpperCase() };
}
function lgBrSeries(lg) { return Array.isArray(lg && lg.brSeries) ? lg.brSeries : []; }
function lgBrActiveSeries(lg) {
  const list = lgBrSeries(lg);
  return list.find((s) => s.id === _lgBrSeriesId) || list[0] || null;
}
// Is this cup the one currently driving the on-air board?
function lgBrIsLive(lg, s) {
  const br = (currentState && currentState.br) || {};
  return !!(s && lg && br.leagueId === lg.id && br.seriesId === s.id);
}

function lgRenderBrTab() {
  const lg = lgActive();
  if (!lg) return;
  const list = lgBrSeries(lg);
  if (_lgBrSeriesId && !list.some((s) => s.id === _lgBrSeriesId)) _lgBrSeriesId = null;
  if (_lgBrPendingCreate && list.length) {
    _lgBrPendingCreate = false;
    _lgBrSeriesId = list[list.length - 1].id;   // the cup that was just appended
  }
  // Otherwise follow the live cup — that's the one the producer is working on.
  if (!_lgBrSeriesId) {
    const live = list.find((s) => lgBrIsLive(lg, s));
    _lgBrSeriesId = (live || list[0] || {}).id || null;
  }

  // Matrix options come from the SERVER's resolved list (built-ins + the producer's own), so the
  // league page and the lobby's matrix editor can never offer different sets.
  const matrices = ((currentState.brMeta && currentState.brMeta.matrices) || []);
  const mxOpts = (sel, extraLabel) => {
    if (!sel) return;
    const sig = JSON.stringify(matrices.map((m) => [m.id, m.name, m.builtin])) + '|' + (extraLabel || '');
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    const grp = (b) => matrices.filter((m) => !!m.builtin === b)
      .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    sel.innerHTML = (extraLabel ? `<option value="">${esc(extraLabel)}</option>` : '')
      + `<optgroup label="Your matrices">${grp(false) || '<option disabled>None yet</option>'}</optgroup>`
      + `<optgroup label="Built-in">${grp(true)}</optgroup>`;
  };
  mxOpts(el('lg-br-preset'), '— Custom table (not linked) —');
  mxOpts(el('lg-br-matrix'), '— None —');
  const lgMx = el('lg-br-matrix');
  if (lgMx && document.activeElement !== lgMx) lgMx.value = lg.brMatrixId || '';

  // ── cup list ──
  const host = el('lg-br-list');
  if (host) {
    host.innerHTML = list.length ? list.map((s) => {
      const roll = ((lg.brSeason && lg.brSeason.series) || []).find((x) => x.id === s.id) || {};
      const live = lgBrIsLive(lg, s);
      return `<div class="lg-br-item${s.id === _lgBrSeriesId ? ' active' : ''}${live ? ' live' : ''}" data-brs="${esc(s.id)}">
        <div><div class="lg-br-name">${esc(s.name)}</div><div class="lg-br-meta">${esc(s.date || '')}</div></div>
        <div class="lg-br-meta">${esc((matrices.find((m) => m.id === s.matrixId) || {}).name || 'Custom table')}${s.source && s.source !== 'manual' ? ' · ' + esc(s.source) : ''}</div>
        <div class="lg-br-meta">${roll.played || 0} / ${s.matches} matches</div>
        <div class="lg-br-meta">${roll.winner ? esc(roll.winner) : '—'}</div>
        ${live ? '<span class="lg-br-live-pill">On air</span>' : '<span></span>'}
      </div>`;
    }).join('') : '<p class="field-hint" style="margin:0;">No tournaments yet — add the season’s first event above.</p>';
  }

  // ── the selected cup's results grid ──
  const s = lgBrActiveSeries(lg);
  const ed = el('lg-br-editor');
  if (ed) ed.style.display = s ? '' : 'none';
  // Only a battle-royale league has a live lobby board to point at.
  const bindBtn = el('lg-br-bind');
  if (bindBtn) bindBtn.style.display = lgBrIsBrGame(lg) ? '' : 'none';
  if (s) {
    const t = el('lg-br-editor-title');
    if (t) t.textContent = s.name + (lgBrIsLive(lg, s) ? '  ·  on air' : '');
    const ps = el('lg-br-preset'); if (ps && document.activeElement !== ps) ps.value = s.matrixId || '';
    const so = el('lg-br-source'); if (so && document.activeElement !== so) so.value = s.source || 'manual';
    const tb = el('lg-br-tab');
    if (tb) {
      tb.style.display = (s.source === 'sheets') ? '' : 'none';
      if (document.activeElement !== tb) tb.value = s.sheetTab || '';
    }
    const mi = el('lg-br-matches'); if (mi && document.activeElement !== mi) mi.value = String(s.matches || 6);
    const hint = el('lg-br-hint');
    if (hint) {
      hint.innerHTML = `Each cell is <strong>placement / ${esc(lgBrStatLabel(lg).long.toLowerCase())}</strong> for that match. `
        + (lgBrIsLive(lg, s)
          ? 'This event is on air — edits here and in <strong>Match — Lobby</strong> are the same data.'
          : (lgBrIsBrGame(lg) ? 'Put this event on air to score it from Match — Lobby.' : 'Enter results in the grid below.'))
        + ' Scoring: <strong>' + esc((matrices.find((m) => m.id === s.matrixId) || {}).name || 'custom table')
        + '</strong> — ' + ((s.scoring && s.scoring.killPoints) || 0) + ' pt(s) per ' + esc(lgBrStatLabel(lg).long.toLowerCase().replace(/s$/, ''))
        + (((s.scoring || {}).vrBonus) ? ', +' + s.scoring.vrBonus + ' VR bonus' : '')
        + '. Changing it re-scores this cup only — other cups keep their own table.';
    }
    lgRenderBrGrid(lg, s);
  }

  // ── season rollup ──
  const seasonHost = el('lg-br-season');
  const rows = ((lg.brSeason && lg.brSeason.standings) || []);
  if (seasonHost) {
    seasonHost.innerHTML = rows.length
      ? '<table class="lg-br-season-tbl"><thead><tr><th>#</th><th>Team</th><th>Events</th><th>Wins</th><th>${esc(lgBrStatLabel(lg).long)}</th><th>Plcmnt</th><th>Pts</th></tr></thead><tbody>'
        + rows.map((t) => `<tr><td class="num">${t.rank}</td><td>${esc(t.name)}</td>`
          + `<td class="num">${t.played}</td><td class="num">${t.wins}</td><td class="num">${t.elims}</td>`
          + `<td class="num">${t.placePts}</td><td class="pts">${t.pts}</td></tr>`).join('')
        + '</tbody></table>'
      : '<p class="field-hint" style="margin:0;">Season totals appear here once a cup has results.</p>';
  }
  const note = el('lg-br-season-note');
  if (note) note.textContent = rows.length ? `${list.length} event(s) · ${rows.length} team(s)` : '';
}

function lgRenderBrGrid(lg, s) {
  const grid = el('lg-br-grid');
  const empty = el('lg-br-grid-empty');
  if (!grid) return;
  // The league's teams ARE the cup's field — that's the whole point of a season store.
  const teams = (lg.teams || []).map((t) => lgResolveTeam(t)).filter((t) => t && t.name);
  if (empty) empty.style.display = teams.length ? 'none' : '';
  if (!teams.length) { grid.innerHTML = ''; return; }

  const n = Math.max(1, Math.min(40, s.matches || 6));
  const cols = `minmax(130px, 1.4fr) repeat(${n}, 92px) 64px`;
  const byKey = new Map();
  for (const r of (s.results || [])) {
    byKey.set(String(r.team || '').trim().toLowerCase() + '|' + (parseInt(r.match, 10) || 0), r);
  }
  const pts = new Map(Object.entries(((lg.brSeason && lg.brSeason.series) || []).find((x) => x.id === s.id)?.points || {}));

  const stat = lgBrStatLabel(lg);
  let html = `<div class="lg-br-grow lg-br-ghead" style="grid-template-columns:${cols}">`
    + '<div>Team</div>'
    + Array.from({ length: n }, (_, i) => `<div style="text-align:center;" title="Placement / ${esc(stat.long)}">M${i + 1}</div>`).join('')
    + '<div style="text-align:center;">Pts</div></div>';

  html += teams.map((t) => {
    const key = t.name.trim().toLowerCase();
    const cells = Array.from({ length: n }, (_, i) => {
      const r = byKey.get(key + '|' + (i + 1)) || {};
      return `<div class="lg-br-cell" data-m="${i + 1}">
        <input type="number" class="input-text pl" data-brf="placement" min="0" max="200" placeholder="PL" value="${r.placement || ''}">
        <input type="number" class="input-text" data-brf="elims" min="0" max="200" placeholder="${esc(stat.short)}" value="${r.elims != null ? r.elims : ''}">
      </div>`;
    }).join('');
    return `<div class="lg-br-grow" style="grid-template-columns:${cols}" data-team="${esc(t.name)}">
      <div class="lg-br-team" title="${esc(t.name)}">${esc(t.name)}</div>${cells}
      <div class="lg-br-pts">${pts.get(key) || 0}</div></div>`;
  }).join('');

  grid.innerHTML = html;
}

// Grid edits go straight to the server, which writes the league and re-mirrors the live board.
el('lg-br-grid')?.addEventListener('change', (e) => {
  const f = e.target.closest('[data-brf]');
  const cell = e.target.closest('.lg-br-cell');
  const row = e.target.closest('[data-team]');
  const lg = lgActive();
  const s = lg && lgBrActiveSeries(lg);
  if (!f || !cell || !row || !s) return;
  const get = (sel) => parseInt((cell.querySelector(sel) || {}).value, 10) || 0;
  send('set_br_result', {
    leagueId: lg.id, seriesId: s.id,
    match: parseInt(cell.dataset.m, 10) || 1,
    team: row.dataset.team,
    placement: get('[data-brf="placement"]'),
    elims: get('[data-brf="elims"]')
  });
});
// Enter walks DOWN the same match column — a producer reconciles one match at a time.
el('lg-br-grid')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const f = e.target.closest('[data-brf]');
  const cell = e.target.closest('.lg-br-cell');
  if (!f || !cell) return;
  e.preventDefault();
  f.blur();
  const all = [...el('lg-br-grid').querySelectorAll(`.lg-br-cell[data-m="${cell.dataset.m}"] [data-brf="${f.dataset.brf}"]`)];
  const next = all[all.indexOf(f) + 1];
  if (next) { next.focus(); next.select?.(); }
});

el('lg-br-list')?.addEventListener('click', (e) => {
  const item = e.target.closest('[data-brs]');
  if (!item) return;
  _lgBrSeriesId = item.dataset.brs;
  lgRenderBrTab();
});

el('lg-br-add')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const name = (el('lg-br-new-name')?.value || '').trim();
  if (!name) { showToast('Give the event a name first.', '#f59e0b'); return; }
  send('br_series', { action: 'create', leagueId: lg.id, name,
    matches: parseInt(el('lg-br-new-matches')?.value, 10) || 6 });
  const n = el('lg-br-new-name'); if (n) n.value = '';
  // Select it once it arrives, but it is NOT put on air — see the server's br_series create.
  _lgBrPendingCreate = true;
});

el('lg-br-preset')?.addEventListener('change', function () {
  const lg = lgActive(); const s = lg && lgBrActiveSeries(lg); if (!s) return;
  if (!this.value) return;   // "custom table" means leave the snapshot alone
  send('br_apply_matrix', { leagueId: lg.id, seriesId: s.id, matrixId: this.value });
});
// Season default — new cups in this league inherit it.
el('lg-br-matrix')?.addEventListener('change', function () {
  const lg = lgActive(); if (!lg || !this.value) return;
  send('br_apply_matrix', { scope: 'league', leagueId: lg.id, matrixId: this.value });
});
el('lg-br-source')?.addEventListener('change', function () {
  const lg = lgActive(); const s = lg && lgBrActiveSeries(lg); if (!s) return;
  send('br_series', { leagueId: lg.id, seriesId: s.id, source: this.value });
});
el('lg-br-tab')?.addEventListener('change', function () {
  const lg = lgActive(); const s = lg && lgBrActiveSeries(lg); if (!s) return;
  send('br_series', { leagueId: lg.id, seriesId: s.id, sheetTab: this.value });
});
el('lg-br-matches')?.addEventListener('change', function () {
  const lg = lgActive(); const s = lg && lgBrActiveSeries(lg); if (!s) return;
  send('br_series', { leagueId: lg.id, seriesId: s.id, matches: parseInt(this.value, 10) || 6 });
});
el('lg-br-bind')?.addEventListener('click', () => {
  const lg = lgActive(); const s = lg && lgBrActiveSeries(lg); if (!s) return;
  send('set_br_league', { leagueId: lg.id, seriesId: s.id });
  showToast(`"${s.name}" is now driving the live board.`, '#10B981');
});
el('lg-br-clear')?.addEventListener('click', async () => {
  const lg = lgActive(); const s = lg && lgBrActiveSeries(lg); if (!s) return;
  if (!(await appConfirm(`Delete every result in "${s.name}"? The event itself is kept.`, 'Clear results'))) return;
  send('clear_br_results', { leagueId: lg.id, seriesId: s.id, scope: 'all' });
});
el('lg-br-delete')?.addEventListener('click', async () => {
  const lg = lgActive(); const s = lg && lgBrActiveSeries(lg); if (!s) return;
  if (!(await appConfirm(`Delete "${s.name}" and all of its results? This can't be undone.`, 'Delete event', true))) return;
  send('br_series', { action: 'delete', leagueId: lg.id, seriesId: s.id });
  _lgBrSeriesId = null;
});

// ── banner ─────────────────────────────────────────────────────────────────
function lgUpdateBanner() {
  const lg = lgActive(); if (!lg) return;
  // Name
  const nameEl = el('lg-name'); if (nameEl && document.activeElement !== nameEl) nameEl.value = lg.name || '';
  // Abbreviation
  const abbrEl = el('lg-abbr'); if (abbrEl && document.activeElement !== abbrEl) abbrEl.value = lg.abbr || '';
  // Status
  const statusEl = el('lg-league-status'); if (statusEl) statusEl.value = lg.status || 'active';
  // Logo
  const imgEl = el('lg2-logo-img'), phEl = el('lg2-logo-ph');
  if (imgEl && phEl) {
    if (lg.logo) { imgEl.src = lg.logo; imgEl.style.display = ''; phEl.style.display = 'none'; }
    else { imgEl.style.display = 'none'; phEl.style.display = ''; const ph = el('lg2-logo-abbr-ph'); if (ph) ph.textContent = lg.abbr || (lg.name || 'LOGO').slice(0, 4).toUpperCase(); }
  }
  // Ballchasing only applies to Rocket League — hide the tab entirely for every other game,
  // and bounce off it if it was active when the producer switched leagues/games.
  const bcTab = el('lg2-tab-ballchasing');
  if (bcTab) {
    const showBc = lg.game === 'rocket-league';
    bcTab.style.display = showBc ? '' : 'none';
    if (!showBc && _lgActiveTab === 'ballchasing') lgSwitchTab('overview');
  }
  // Tournaments is NOT game-gated (Ballchasing above is). Any league can run a circuit scored on
  // placement points — a weekly Rocket League cup, a Bedwars series, an FGC ranking season — so
  // the tab is always available. Only "Go live with this event", which drives the battle-royale
  // lobby board, is game-specific, and it hides itself in lgRenderBrTab.
  // Chips
  const chips = el('lg2-banner-chips'); if (!chips) return;
  const game = lg.game && currentState.games && currentState.games[lg.game] ? currentState.games[lg.game].name : (lg.game || '');
  const type = { team: 'Team League', freeagent: 'Free Agent Pool', salary: 'Rating Cap' }[lg.type] || lg.type || '';
  const STATUS_LABELS = { active: 'Active', playoffs: 'Playoffs', offseason: 'Off-season', complete: 'Complete' };
  const status = lg.status || 'active';
  const linkedEvent = lg.linkedEventId ? (currentState.myEvents || []).find((e) => e.id === lg.linkedEventId) : null;
  chips.innerHTML = [
    game && `<span class="lg2-chip">${game.replace(/</g, '&lt;')}</span>`,
    lg.season && `<span class="lg2-chip">${lg.season.replace(/</g, '&lt;')}</span>`,
    type && `<span class="lg2-chip">${type}</span>`,
    linkedEvent && `<span class="lg2-chip" title="Teams imported from this event">Event: ${(linkedEvent.name || 'Event').replace(/</g, '&lt;')}</span>`,
    `<span class="lg2-chip">${(lg.teams || []).length} teams</span>`,
    `<span class="lg2-status-chip" data-s="${status}">${STATUS_LABELS[status] || status}</span>`,
  ].filter(Boolean).join('');
}

function lgRender() {
  lgRenderList();
  const lg = lgActive();
  const empty = el('lg-empty'), detail = el('lg-detail');
  if (!lg) { if (empty) empty.style.display = ''; if (detail) detail.style.display = 'none'; return; }
  if (empty) empty.style.display = 'none'; if (detail) detail.style.display = '';
  lgUpdateBanner();
  lgSwitchTab(_lgActiveTab);
}

el('lg-new')?.addEventListener('click', () => { const l = lgNewLeague(); lgLeagues.push(l); lgActiveId = l.id; _lgActiveTab = 'overview'; lgRender(); lgSave(); });
// Import a league from a start.gg event (server fetches entrants → builds a team league).
el('lg-startgg-import')?.addEventListener('click', () => {
  const input = (el('lg-startgg-slug')?.value || '').trim();
  if (!input) { showToast('Paste a start.gg event URL or slug first.', '#f59e0b'); return; }
  if (!currentState.startgg?.hasToken) { showToast('Add your Start.gg API token in Settings → Integrations first.', '#f59e0b'); return; }
  send('create_league_from_startgg', { input });
  lgStatus('Importing league from start.gg (teams + rosters)…');
});
// Delete now lives in Settings ▸ Danger Zone rather than beside the league name in the banner.
function lgDeleteActiveLeague() {
  const lg = lgActive(); if (!lg) return;
  appConfirm(`Delete "${lg.name || 'this league'}"? Its schedule, standings, stats and archived seasons go with it.`, 'Delete').then((ok) => {
    if (!ok) return;
    lgLeagues = lgLeagues.filter((l) => l.id !== lg.id); lgActiveId = null; lgRender(); lgSave();
  });
}
el('lg-delete')?.addEventListener('click', lgDeleteActiveLeague);
el('lg-delete-settings')?.addEventListener('click', lgDeleteActiveLeague);
el('lg-archive-season')?.addEventListener('click', () => lgArchiveSeason());
el('lg-name')?.addEventListener('input', function () { const lg = lgActive(); if (lg) { lg.name = this.value; lgRenderList(); lgSave(); lgUpdateBanner(); } });
el('lg-type')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.type = this.value; document.querySelectorAll('.lg-salary-field').forEach((e) => { e.style.display = this.value === 'salary' ? '' : 'none'; }); lgRenderTeams(); lgRenderList(); lgSave(); lgUpdateBanner(); } });
el('lg-game')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.game = this.value; lgSave(); lgUpdateBanner(); } });
el('lg-season')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.season = this.value.trim(); lgSave(); lgUpdateBanner(); } });
el('lg-cap')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.salaryCap = Number(this.value) || 0; lgRenderTeams(); lgRenderStandingsTab(); lgSave(); } });
el('lg-starter-count')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.starterCount = Number(this.value) || 3; lgRenderTeams(); lgSave(); } });
el('lg-linked-event')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.linkedEventId = this.value || ''; lgSave(); lgUpdateBanner(); } });
el('lg-import-event-teams')?.addEventListener('click', function () {
  const evId = el('lg-linked-event')?.value || '';
  if (!evId) { lgStatus('Pick an event first.', false); return; }
  const { added, eventName } = lgImportTeamsFromEvent(evId);
  lgStatus(added ? `Imported ${added} team${added > 1 ? 's' : ''} from ${eventName}.` : `No new teams to import from ${eventName || 'that event'}.`, !!added);
});
// Start.gg league source typeahead
(function () {
  const inp = el('lg-sgg-search'), dd = el('lg-sgg-dd');
  if (!inp || !dd) return;
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
  let _timer = null;
  inp.addEventListener('input', function () {
    clearTimeout(_timer);
    const v = this.value.trim();
    if (!v || v.length < 2) { dd.style.display = 'none'; return; }
    if (v.includes('start.gg') || (v.includes('/') && !v.includes(' '))) {
      dd.style.display = 'none';
      const lg = lgActive(); if (!lg) return;
      lg.startggSource = v; lgSave(); lgRenderSggSource(lg); inp.value = '';
      return;
    }
    _timer = setTimeout(() => {
      if (!currentState.startgg?.hasToken) {
        dd.innerHTML = '<div class="team-dd-item team-dd-empty">Set up Start.gg API token first.</div>';
        dd.style.display = 'block'; return;
      }
      fetch('http://localhost:3000/api/startgg/search-leagues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: v }) })
        .then(r => r.json()).then(data => {
          let results = data.results || [];
          if (!results.length) { dd.innerHTML = '<div class="team-dd-item team-dd-empty">No leagues found.</div>'; dd.style.display = 'block'; return; }
          // Re-rank start.gg's order against the typed name so the closest league is first.
          results = NESearch.filter(results, v, (l) => [{ text: l.name, weight: 2 }, l.slug]).concat(
            results.filter((l) => !NESearch.matches(v, [l.name, l.slug])));
          dd.innerHTML = results.map(l => `<div class="team-dd-item" data-slug="${esc(l.slug)}" data-name="${esc(l.name)}">${esc(l.name)} <span style="opacity:.5;font-size:11px;">${esc(l.slug)}</span></div>`).join('');
          dd.style.display = 'block';
          dd.querySelectorAll('.team-dd-item[data-slug]').forEach(item => {
            item.addEventListener('mousedown', (e) => {
              e.preventDefault();
              const lg = lgActive(); if (!lg) return;
              lg.startggSource = item.dataset.slug;
              lg.sggLeagueName = item.dataset.name;
              lgSave(); lgRenderSggSource(lg);
              inp.value = ''; dd.style.display = 'none';
            });
          });
        }).catch(() => { dd.style.display = 'none'; });
    }, 350);
  });
  inp.addEventListener('blur', () => { setTimeout(() => { dd.style.display = 'none'; }, 200); });
  // Arrow-key navigation. The rows are wired on mousedown (to beat that blur), so Enter has to
  // replay a mousedown rather than a click.
  NESearch.bindListNav(inp, dd, '.team-dd-item[data-slug]', {
    activeClass: 'active',
    pick: (node) => node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })),
    onEscape: () => { dd.style.display = 'none'; }
  });
})();

el('lg-sgg-sync')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  if (!lg.startggSource) { showToast('Set a start.gg league source first.', '#f59e0b'); return; }
  if (!currentState.startgg?.hasToken) { showToast('Set up your Start.gg API token in Settings first.', '#f59e0b'); return; }
  lgStatus('Syncing matches from start.gg…');
  fetch('http://localhost:3000/api/startgg/league-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leagueId: lg.id }) })
    .then(r => r.json()).then(data => {
      if (data.error) { lgStatus('Sync failed: ' + data.error, false); return; }
      // Adopt the server's post-sync league so our authoritative copy keeps the imported matches +
      // their sggSetIds. Otherwise our stale copy's next save wipes them and the next sync re-imports
      // everything (the dedup keys off schedule[].sggSetId).
      if (data.league && data.league.id) {
        const local = lgLeagues.find((l) => l.id === data.league.id);
        if (local) {
          // Adopt only what the sync changed, so any unsaved local edits (name/teams/etc.) survive.
          local.schedule = Array.isArray(data.league.schedule) ? data.league.schedule : local.schedule;
          local.standings = Array.isArray(data.league.standings) ? data.league.standings : local.standings;
          local.startggSource = data.league.startggSource || local.startggSource;
          local.sggSyncedAt = data.league.sggSyncedAt;
          local.sggLeagueName = data.league.sggLeagueName || local.sggLeagueName;
          _lgSig = '';
          lgRender();
        }
      }
      lgStatus(`Synced "${data.leagueName}": ${data.imported} new matches, ${data.skipped} already present.`, true);
    }).catch(err => lgStatus('Sync error: ' + err.message, false));
});

el('lg-abbr')?.addEventListener('input', function () { const lg = lgActive(); if (lg) { lg.abbr = this.value.toUpperCase().slice(0, 8); lgRenderList(); lgSave(); const ph = el('lg2-logo-abbr-ph'); if (ph && !lg.logo) ph.textContent = lg.abbr || (lg.name || 'LOGO').slice(0,4).toUpperCase(); } });
el('lg-league-status')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.status = this.value; lgRenderList(); lgSave(); lgUpdateBanner(); } });
el('lg2-logo-wrap')?.addEventListener('click', () => el('lg2-logo-file')?.click());
el('lg2-logo-file')?.addEventListener('change', function () {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => { const lg = lgActive(); if (!lg) return; lg.logo = ev.target.result; lgUpdateBanner(); lgRenderList(); lgSave(); };
  reader.readAsDataURL(file); this.value = '';
});
el('lg-pts-win')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.scoring = lg.scoring || {}; lg.scoring.win = Number(this.value) || 0; lgSave(); } });
el('lg-pts-loss')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.scoring = lg.scoring || {}; lg.scoring.loss = Number(this.value) || 0; lgSave(); } });
el('lg-pts-draw')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.scoring = lg.scoring || {}; lg.scoring.draw = Number(this.value) || 0; lgSave(); } });
el('lg-pts-otw')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.scoring = lg.scoring || {}; lg.scoring.otw = Number(this.value) || 0; lgSave(); } });
el('lg-playoff-n')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.playoffN = Number(this.value) || 4; lgSave(); } });
el('lg-tiebreak')?.addEventListener('change', function () { const lg = lgActive(); if (lg) { lg.tiebreak = this.value; lgSave(); } });
el('lg-manage-teams')?.addEventListener('click', () => { document.querySelector('.tab-btn[data-tab="equipos"]')?.click(); });

// Send this league's teams into the battle-royale lobby (the manual/offline path — a LAN event
// with no start.gg bracket still needs its field on screen). Merges by default so drop POIs and
// notes already set on entrants survive a re-send.
el('lg-send-br')?.addEventListener('click', () => {
  const lg = lgActive();
  if (!lg) return;
  const n = (lg.teams || []).length;
  if (!n) { showToast('This league has no teams yet.', '#f59e0b'); return; }
  // Always MERGE — never replace. Re-sending after a roster change is a normal mid-show action,
  // and it must not wipe drop POIs and notes the producer already set. Emptying the field is the
  // explicit "Clear field" button in Match — Lobby, so nothing destructive hides behind this one.
  send('br_lobby_from_league', { leagueId: lg.id, replace: false });
});
el('lg-recalc')?.addEventListener('click', lgComputeStandingsFromSchedule);
el('lg-stats-recalc')?.addEventListener('click', () => { lgComputeStandingsFromSchedule(); lgRenderStatsTab(); });
// Push the season stats board (same three tiers as the Stats tab) to the league-stats overlay.
el('lg-stats-push')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  lg.stats = lg.stats || {};
  const gs = lgGameStats(lg.game), unit = gs.unit, inSet = LG_STAT_SETS[lg.game] || [];
  const gameLbl = gs.sub ? gs.sub.noun : 'Games';
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  const columns = [
    { key: 'w', label: 'W', group: 'Series' }, { key: 'l', label: 'L', group: 'Series' },
    { key: 'gw', label: 'Won', group: gameLbl }, { key: 'gl', label: 'Lost', group: gameLbl },
    ...(unit ? [{ key: 'gf', label: 'For', group: gameLbl }, { key: 'ga', label: 'Against', group: gameLbl }] : []),
    ...inSet.map((s) => ({ key: lgStatKey(s), label: s, group: 'In-game' }))
  ];
  const rows = (lg.teams || []).map((tm) => {
    const s = byId[tm.id] || {}, ts = lg.stats[tm.id] || {}, r = lgResolveTeam(tm);
    const values = { w: s.w || 0, l: s.l || 0, gw: s.subW || 0, gl: s.subL || 0 };
    if (unit) { values.gf = s.gf || 0; values.ga = s.ga || 0; }
    inSet.forEach((label) => { const k = lgStatKey(label); values[k] = ts[k] || 0; });
    return { name: r.name || tm.teamName || 'Team', logo: r.logo || null, color: tm.color || null, values };
  });
  const title = [lg.name, lg.season].filter(Boolean).join(' — ');
  send('set_league_stats', { visible: true, title: title || 'Season Stats', columns, rows });
  lgStatus('Season stats pushed to the league-stats overlay.', true);
});
el('lg-add-match')?.addEventListener('click', lgAddMatch);
el('lg-gen-rr')?.addEventListener('click', lgGenerateRoundRobin);
el('lg-gen-drr')?.addEventListener('click', lgGenerateDoubleRoundRobin);
el('lg2-tabs')?.addEventListener('click', (e) => { const tab = e.target.closest('.lg2-tab'); if (tab) lgSwitchTab(tab.dataset.tab); });
el('lg-roster-seg')?.addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b) lgSetRosterView(b.dataset.rv); });
el('lg-players-search')?.addEventListener('input', () => lgRenderRosterPlayers());
// Overview cockpit controls
el('lgov-density')?.addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (!b) return; const p = lgOvPrefs(); p.density = b.dataset.d; lgOvSavePrefs(p); lgApplyOvLayout(); });
el('lgov-topn')?.addEventListener('change', () => lgRenderStandingsSnap());
el('lgov-view-standings')?.addEventListener('click', () => lgSwitchTab('standings'));
el('lgov-push-standings')?.addEventListener('click', () => { const n = parseInt((el('lgov-topn') || {}).value, 10) || 0; lgPushStandingsToOverlay(n); });
// The individual pushes now live on the graphics rack (lgRenderBroadcastCard) so each one can
// carry its own on-air state and Hide — only the blanket clear stays a plain button here.
el('lgov-clear-overlays')?.addEventListener('click', () => { lgClearOverlays(); lgRenderBroadcastCard(); });

// Logo + name search typeahead for adding teams from the central library (reuses the .team-dd look).
function setupLeagueTeamSearch() {
  const input = el('lg-team-search'); const dd = el('lg-team-dd');
  if (!input || !dd) return;
  let items = [], active = -1, open = false;
  const candidates = (q) => {
    const lg = lgActive(); if (!lg) return [];
    const taken = new Set((lg.teams || []).map((t) => t.teamName || t.name));
    // Ranked before the 60-item cap, and rosters are searchable — adding a team to a league is
    // often driven by "which team is <player> on again?".
    return NESearch.filter(
      (currentState.savedTeams || []).filter((s) => !taken.has(s.name)),
      (q || '').trim(),
      (s) => [{ text: s.name, weight: 2 },
        { text: (s.players || []).map((p) => (typeof p === 'string' ? p : ((p && (p.name || p.gamertag)) || ''))).join(' '), bag: true }],
      { limit: 60 }
    ).slice(0, 60);
  };
  const close = () => { dd.classList.remove('show'); open = false; active = -1; };
  const position = () => {
    const r = input.getBoundingClientRect();
    dd.style.left = r.left + 'px'; dd.style.width = Math.max(r.width, 220) + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 220 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
  };
  const render = () => {
    if (!items.length) { dd.innerHTML = `<div class="team-dd-empty">${(currentState.savedTeams || []).length ? 'No matching teams' : 'No teams in the library yet — create some on the Teams page'}</div>`; position(); dd.classList.add('show'); open = true; return; }
    dd.innerHTML = items.map((t, i) => `<div class="team-dd-item${i === active ? ' active' : ''}" data-i="${i}" role="option">
      <img class="team-dd-logo${t.logo ? '' : ' game-logo-white'}" src="${t.logo || gameLogo()}" alt="" onerror="this.onerror=null;this.src='../assets/rl.png';">
      <span class="team-dd-name">${(t.name || '').toUpperCase().replace(/</g, '&lt;')}</span></div>`).join('');
    position(); dd.classList.add('show'); open = true;
    const act = dd.querySelector('.team-dd-item.active'); if (act) act.scrollIntoView({ block: 'nearest' });
  };
  const refresh = () => { items = candidates(input.value); active = -1; render(); };
  const pick = (t) => { if (t && lgAddTeamByName(t.name)) { input.value = ''; refresh(); input.focus(); } };
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
  input.addEventListener('blur', () => setTimeout(close, 120));
  window.addEventListener('scroll', () => { if (open) position(); }, true);
}
setupLeagueTeamSearch();

// Go Live: push the selected league matchup to the broadcast (Blue/Orange + reset series).
el('lg-mu-go')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const a = el('lg-mu-home')?.value, b = el('lg-mu-away')?.value;
  if (!a || !b) { lgStatus('Pick both teams for the matchup.', false); return; }
  if (a === b) { lgStatus('Pick two different teams.', false); return; }
  const tmo = (lg.teams || []).find((t) => lgResolveTeam(t).name === a);
  const tmob = (lg.teams || []).find((t) => lgResolveTeam(t).name === b);
  const ra = lgResolveTeam(tmo || { name: a });
  const rb = lgResolveTeam(tmob || { name: b });
  send('set_team', { side: 'blue',   name: ra.name, logo: ra.logo || null, color: (tmo && tmo.color) || undefined, players: ra.players });
  send('set_team', { side: 'orange', name: rb.name, logo: rb.logo || null, color: (tmob && tmob.color) || undefined, players: rb.players });
  send('reset_series');
  if (el('lg-mu-title')?.checked) {
    const title = [lg.name, lg.season].filter(Boolean).join(' — ');
    if (title) send('set_event_name', { name: title.toUpperCase() });
  }
  lgStatus(`${ra.name} vs ${rb.name} pushed live.`, true);
});
el('lg-add-fa')?.addEventListener('click', () => { const lg = lgActive(); if (lg) { lg.freeAgents.push(lgNewPlayer()); lgRenderFreeAgents(); lgSave(); } });
// Shared standings push — used by the Standings tab button AND the Overview cockpit. topN limits
// the pushed rows (0 = all).
function lgPushStandingsToOverlay(topN) {
  const lg = lgActive(); if (!lg) return;
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  const teamsById = {}; (lg.teams || []).forEach(t => { teamsById[t.id] = t; });
  const ordered = (lg.standings && lg.standings.length)
    ? lg.standings.map(s => teamsById[s.teamId]).filter(Boolean)
    : (lg.teams || []).slice().sort((a, b) => ((byId[b.id] || {}).pts || 0) - ((byId[a.id] || {}).pts || 0));
  const gs = lgGameStats(lg.game);
  let rows = ordered.map((tm, i) => {
    const s = byId[tm.id] || {};
    const r = lgResolveTeam(tm);
    return { placement: i + 1, name: r.name || tm.teamName || 'Team', logo: r.logo || null, wins: s.w || 0, losses: s.l || 0, points: s.pts || 0, gameWins: s.subW || 0, gameLosses: s.subL || 0 };
  });
  if (topN > 0) rows = rows.slice(0, topN);
  const title = [lg.name, lg.season].filter(Boolean).join(' — ');
  send('set_standings', { visible: true, title: title || 'Standings', rows, gamesLabel: gs.sub ? gs.sub.noun : '' });
  lgStatus(`Standings pushed to the standings overlay${topN > 0 ? ` (top ${topN})` : ''}.`, true);
}
el('lg-push-standings')?.addEventListener('click', () => lgPushStandingsToOverlay(parseInt((el('lg-st-topn') || {}).value, 10) || 0));
el('lg-st-divisions')?.addEventListener('click', () => { const b = el('lg-st-divmgr'); if (!b) return; const show = b.style.display === 'none'; b.style.display = show ? '' : 'none'; if (show) lgRenderDivMgr(); });
el('lg-bkt-generate')?.addEventListener('click', lgBracketGenerate);
// The standalone "Bracket Builder" sub-tab was removed from the ESPORTS nav (2026-08) — the builder
// is reached from the competition it belongs to instead. openBracketBuilder() is defined in
// seeding-spotlight.js (loads before this file) and is the single place that knows where the
// builder's DOM currently lives.
el('lg-bkt-builder')?.addEventListener('click', () => { if (typeof window.openBracketBuilder === 'function') window.openBracketBuilder(); });
el('lg-bkt-push')?.addEventListener('click', () => lgBracketPush(true));
el('lg-bkt-hide')?.addEventListener('click', () => lgBracketPush(false));
el('lg-st-density')?.addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (!b) return; const p = lgStPrefs(); p.density = b.dataset.d; lgStSavePrefs(p); lgRenderStandingsTab(); });

// Push the league's fixtures to the schedule overlay (state.upcoming) — the schedule overlay merges
// these with the start.gg queue, so a league's own weekly matches can now drive it.
function lgPushScheduleToOverlay() {
  const lg = lgActive(); if (!lg) return;
  const teamName = (id) => { const tm = (lg.teams || []).find((t) => t.id === id); return tm ? lgResolveTeam(tm).name : ''; };
  const teamLogo = (id) => { const tm = (lg.teams || []).find((t) => t.id === id); return tm ? (lgResolveTeam(tm).logo || null) : null; };
  const matches = (lg.schedule || []).slice(0, 12).map((m) => {
    const done = m.result && m.result.scoreA != null && m.result.scoreB != null;
    return {
      id: m.id, round: m.week ? ('Week ' + m.week) : '', teamA: teamName(m.teamA) || m.sggTeamA || 'TBD', teamB: teamName(m.teamB) || m.sggTeamB || 'TBD',
      teamALogo: teamLogo(m.teamA), teamBLogo: teamLogo(m.teamB), date: m.date || '', time: m.time || '',
      scoreA: done ? Number(m.result.scoreA) : null, scoreB: done ? Number(m.result.scoreB) : null
    };
  });
  if (!matches.length) { lgStatus('No matches in the schedule to push.', false); return; }
  const title = [lg.name, lg.season].filter(Boolean).join(' — ');
  send('set_upcoming', { visible: true, title: title || 'Schedule', source: 'league', showResults: true, matches });
  lgStatus('League schedule pushed to the schedule overlay.', true);
}

// Hide every league-driven overlay in one click (end-of-segment reset).
function lgClearOverlays() {
  send('set_standings', { visible: false });
  send('set_league_stats', { visible: false });
  send('set_league_leaderboard', { visible: false });
  send('set_upcoming', { visible: false });
  lgStatus('League overlays cleared.', true);
}

function evSetMode(label) { const m = el('ev-mode'); if (m) m.textContent = label || ''; }
// Global search of ANY start.gg tournament (not just yours).
async function evSearchTournaments() {
  const q = (el('ev-search')?.value || '').trim();
  if (q.length < 2) { evStatus('Type at least 2 characters to search.', 'err'); return; }
  const btn = el('ev-search-btn'); if (btn) btn.disabled = true;
  evStatus('Searching start.gg…');
  try {
    const data = await evPost('/search-tournaments', { query: q, filter: _evFilter });
    _evMode = 'search';
    _evSearch = '';   // results already match the query — don't re-filter them by the same text
    _evTournaments = data.tournaments || [];
    el('ev-toolbar').style.display = '';
    evSetMode(`Search: "${q}"`);
    applyEventsView();
    evStatus(_evTournaments.length ? '' : `No tournaments matched "${q}".`);
  } catch (e) {
    evStatus(e.message || 'Search failed. Check your start.gg token in Settings.', 'err');
  } finally { if (btn) btn.disabled = false; }
}

el('ev-load')?.addEventListener('click', () => {
  if (_evSource === 'challonge') evLoadChallongeTournaments();
  else if (_evSource === 'nxgen') evLoadNxgenTournaments();
  else if (_evSource === 'faceit') evLoadFaceitCompetitions();
  else { _evMode = 'mine'; evSetMode('My tournaments'); evLoadTournaments(); }
});
el('ev-search-btn')?.addEventListener('click', evSearchTournaments);
el('ev-search')?.addEventListener('input', function () {
  // In "my tournaments" mode the box filters the loaded list live; in search mode it's the query (submit to search).
  if (_evMode === 'mine') { _evSearch = this.value; applyEventsView(); }
});
el('ev-search')?.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); evSearchTournaments(); } });
document.querySelectorAll('#ev-filter-seg .ev-seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    _evFilter = b.dataset.filter;
    document.querySelectorAll('#ev-filter-seg .ev-seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    // Re-query in search mode so the server date window matches; just re-filter in mine mode.
    if (_evMode === 'search' && _evTournaments.length) evSearchTournaments();
    else applyEventsView();
  });
});
el('ev-back')?.addEventListener('click', () => { _evDetail = null; const sec = el('ev-detail-section'); if (sec) sec.style.display = 'none'; const g = el('ev-grid'); if (g) g.style.display = ''; });
el('ev-players-filter')?.addEventListener('input', function () { renderEventTeams(this.value); });
el('ev-copy-summary')?.addEventListener('click', () => {
  const txt = el('ev-sponsor-text')?.textContent || '';
  if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => evStatus('Summary copied.', 'ok')).catch(() => {});
});
document.querySelectorAll('.js-goto-settings').forEach((b) => b.addEventListener('click', () => document.querySelector('.tab-btn[data-tab="integrations"]')?.click()));

