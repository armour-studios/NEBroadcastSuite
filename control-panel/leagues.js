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
const lgUid = (p) => (p || 'id') + Math.random().toString(36).slice(2, 9);

function lgActive() { return lgLeagues.find((l) => l.id === lgActiveId) || null; }
function lgStatus(msg, ok) { const s = el('lg-status'); if (s) { s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good,#48bb78)' : 'var(--muted)'); } }
function lgSave() { clearTimeout(_lgSaveTimer); _lgSaveTimer = setTimeout(() => send('set_leagues', { leagues: lgLeagues }), 400); }

function lgHydrate(leagues) {
  const incoming = Array.isArray(leagues) ? leagues : [];
  const sig = JSON.stringify(incoming);
  if (sig === _lgSig) return;                       // no change
  const panel = el('ev-leagues-panel');
  if (panel && panel.contains(document.activeElement)) return;   // don't clobber active edits
  _lgSig = sig;
  lgLeagues = incoming;
  if (lgActiveId && !lgLeagues.some((l) => l.id === lgActiveId)) lgActiveId = null;
  if (el('ev-leagues-panel') && el('ev-leagues-panel').style.display !== 'none') lgRender();
}
function lgGameOptions(sel) {
  const games = currentState.games || {};
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Game —</option>' + Object.keys(games).map((id) => `<option value="${id}">${games[id].name || id}</option>`).join('');
  if (cur) sel.value = cur;
}
function lgNewPlayer() { return { id: lgUid('pl'), name: '', role: '', salary: 0, stats: '' }; }
function lgNewTeam() { return { id: lgUid('tm'), name: '', logo: null, players: [] }; }
function lgNewLeague() {
  return { id: lgUid('lg'), name: 'New League', game: currentState.activeGame || '', type: 'team', season: '', salaryCap: 0, starterCount: 3, logo: null, abbr: '', status: 'active', teams: [], freeAgents: [], standings: [], schedule: [], scoring: { win: 3, loss: 0, draw: 1, otw: 2 }, playoffN: 4, tiebreak: 'gd', startggSource: '', linkedEventId: '' };
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
  const key = (tm && (tm.teamName || tm.name)) || '';
  const saved = (currentState.savedTeams || []).find((s) => (s.name || '') === key);
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
function lgRenderTeams() {
  const wrap = el('lg-teams'); const lg = lgActive(); if (!wrap || !lg) return;
  lgRenderMatchup();
  const isSalary = lg.type === 'salary';
  const cap = lg.salaryCap || 0;
  const starterCount = lg.starterCount || 3;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  wrap.innerHTML = (lg.teams || []).map((tm) => {
    const r = lgResolveTeam(tm);
    let starterUsed = 0, starterIdx = 0;
    const players = (r.players || []).map((p) => {
      const pid = p.id || p.name || '';
      const sal = (tm.salaries && tm.salaries[pid] != null) ? tm.salaries[pid] : (p.salary || 0);
      const isStarter = starterIdx < starterCount; starterIdx++;
      if (isSalary && isStarter) starterUsed += Number(sal) || 0;
      const role = esc(p.role);
      return `<div class="lg-player">
        <span class="lg-pl-name">${esc(p.name) || '—'}</span>
        ${role ? `<span class="lg-pl-role">${role}</span>` : ''}
        ${!isStarter && isSalary ? '<span class="lg-pl-role" style="color:var(--muted);font-style:italic;">Sub</span>' : ''}
        ${isSalary ? `<input type="number" class="input-text lg-pl-salary" data-tid="${esc(tm.id)}" data-pid="${esc(pid)}" value="${Number(sal) || 0}" placeholder="Rating" style="width:82px;" title="${isStarter ? 'Counts toward cap' : 'Sub — excluded from cap'}">` : ''}
      </div>`;
    }).join('') || '<div class="lg-empty" style="padding:4px 0;">No players in the library for this team.</div>';
    const pct = cap > 0 ? Math.min((starterUsed / cap) * 100, 110) : 0;
    const over = cap > 0 && starterUsed > cap;
    const capBar = isSalary && cap > 0 ? `<div class="lg2-cap-bar-wrap">
      <div class="lg2-cap-label"><span>Rating used (starters)</span><span>${starterUsed} / ${cap}${over ? ' ⚠ over' : ''}</span></div>
      <div class="lg2-cap-bar"><div class="lg2-cap-bar-fill${over ? ' over' : ''}" style="width:${Math.min(pct,100)}%"></div></div>
    </div>` : '';
    return `<div class="lg-team" data-tid="${tm.id}">
      <div class="lg-team-head">
        <img class="lg-team-logo${r.logo ? '' : ' game-logo-white'}" src="${r.logo || gameLogo()}" alt="" onerror="this.onerror=null;this.src='../assets/rl.png';">
        <span class="lg-team-name">${esc(r.name)}</span>
        ${r.linked ? '' : '<span class="lg-unlinked" title="Not in the team library">unlinked</span>'}
        <button class="btn btn-ghost btn-xs lg-team-live" data-tid="${tm.id}" data-side="blue">→ Blue</button>
        <button class="btn btn-ghost btn-xs lg-team-live" data-tid="${tm.id}" data-side="orange">→ Orange</button>
        <button class="lg-del lg-team-del" data-tid="${tm.id}" title="Remove from league">×</button>
      </div>
      ${capBar}
      <div class="lg2-team-meta">
        <input type="text" class="input-text lg2-abbr-team-inp lg2-team-abbr" data-tid="${tm.id}" value="${esc(tm.abbr || '')}" placeholder="Abbr" title="Team abbreviation (e.g. BDG)">
        <input type="text" class="input-text lg2-owner-inp lg2-team-owner" data-tid="${tm.id}" value="${esc(tm.franchiseOwner || '')}" placeholder="Franchise owner">
      </div>
      <div class="lg-players">${players}</div>
    </div>`;
  }).join('') || '<div class="lg-empty">No teams yet — add from your team library above.</div>';

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
  wrap.querySelectorAll('.lg-team-live').forEach((b) => b.addEventListener('click', () => {
    const tm = lg.teams.find((t) => t.id === b.dataset.tid); if (!tm) return;
    const r = lgResolveTeam(tm);
    send('set_team', { side: b.dataset.side, name: r.name || 'Team', logo: r.logo || null, players: (r.players || []).map((p) => ({ name: p.name, role: p.role })) });
    lgStatus(`${r.name || 'Team'} → ${b.dataset.side}.`, true);
  }));
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
// ── enhanced standings (W/L/T/GF/GA/PTS) ─────────────────────────────────
function lgRenderStandingsTab() {
  const wrap = el('lg-standings'); const lg = lgActive(); if (!wrap || !lg) return;
  const playoffN = lg.playoffN || 4;
  const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');

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
    ...ranked.map(s => { const tm = teamsMap[s.teamId]; return { teamId: tm.id, teamName: lgResolveTeam(tm).name, w: s.w || 0, l: s.l || 0, t: s.t || 0, gf: s.gf || 0, ga: s.ga || 0, pts: s.pts || 0, form: s.form || [], streak: s.streak || '' }; }),
    ...unranked.map(tm => ({ teamId: tm.id, teamName: lgResolveTeam(tm).name, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0, form: [], streak: '' }))
  ];

  if (!rows.length) { wrap.innerHTML = '<div class="lg-empty">Add teams to track standings.</div>'; return; }
  const formDots = (form) => form.map(f => `<span class="lg2-fd lg2-fd-${f.toLowerCase()}">${f}</span>`).join('');
  wrap.innerHTML = `<table class="lg2-st-table">
    <thead><tr><th class="lg2-drag-th"></th><th>#</th><th>Team</th><th>W</th><th>L</th><th>T</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th><th>Form</th><th>Str</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr data-tid="${r.teamId}" draggable="true">
      <td class="lg2-drag-cell"><span class="lg2-drag-handle" title="Drag to reorder"></span></td>
      <td class="lg2-pos">${i < playoffN ? '<span class="lg2-playoff-dot" title="Playoff spot"></span>' : ''}${i + 1}</td>
      <td>${esc(r.teamName)}</td>
      <td><input type="number" class="input-text lg2-st-inp" data-tid="${r.teamId}" data-key="w" value="${r.w}" min="0"></td>
      <td><input type="number" class="input-text lg2-st-inp" data-tid="${r.teamId}" data-key="l" value="${r.l}" min="0"></td>
      <td><input type="number" class="input-text lg2-st-inp" data-tid="${r.teamId}" data-key="t" value="${r.t}" min="0"></td>
      <td><input type="number" class="input-text lg2-st-inp" data-tid="${r.teamId}" data-key="gf" value="${r.gf}" min="0"></td>
      <td><input type="number" class="input-text lg2-st-inp" data-tid="${r.teamId}" data-key="ga" value="${r.ga}" min="0"></td>
      <td>${r.gf - r.ga >= 0 ? '+' : ''}${r.gf - r.ga}</td>
      <td><input type="number" class="input-text lg2-st-inp" data-tid="${r.teamId}" data-key="pts" value="${r.pts}"></td>
      <td class="lg2-form-cell">${formDots(r.form)}</td>
      <td class="lg2-streak">${esc(r.streak)}</td>
    </tr>`).join('')}</tbody></table>`;

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
      lgRenderStandingsTab(); lgSave();
    });
  });

  wrap.querySelectorAll('.lg2-st-inp').forEach((inp) => inp.addEventListener('change', () => {
    let s = (lg.standings || []).find((x) => x.teamId === inp.dataset.tid);
    if (!s) { s = { teamId: inp.dataset.tid, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0 }; lg.standings = lg.standings || []; lg.standings.push(s); }
    s[inp.dataset.key] = Number(inp.value) || 0;
    lgSave();
  }));
}

function lgComputeStandingsFromSchedule() {
  const lg = lgActive(); if (!lg) return;
  const sc = lg.scoring || {};
  const ptsWin = sc.win ?? 3, ptsLoss = sc.loss ?? 0, ptsDraw = sc.draw ?? 1;
  const map = {};
  (lg.teams || []).forEach((tm) => { map[tm.id] = { teamId: tm.id, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0, form: [], h2h: {} }; });
  for (const m of (lg.schedule || [])) {
    const r = m.result; if (!r || r.scoreA == null || r.scoreB == null) continue;
    const a = map[m.teamA], b = map[m.teamB]; if (!a || !b) continue;
    const sa = Number(r.scoreA) || 0, sb = Number(r.scoreB) || 0;
    a.gf += sa; a.ga += sb; b.gf += sb; b.ga += sa;
    if (sa > sb) {
      a.w++; a.pts += ptsWin; a.form.push('W'); a.h2h[m.teamB] = (a.h2h[m.teamB] || 0) + 1;
      b.l++; b.pts += ptsLoss; b.form.push('L');
    } else if (sb > sa) {
      b.w++; b.pts += ptsWin; b.form.push('W'); b.h2h[m.teamA] = (b.h2h[m.teamA] || 0) + 1;
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
  lg.standings = Object.values(map).map((s) => ({
    teamId: s.teamId, w: s.w, l: s.l, t: s.t, gf: s.gf, ga: s.ga, pts: s.pts,
    form: s.form.slice(-5), streak: calcStreak(s.form), h2h: s.h2h
  }));
  lg.standings.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (tb === 'h2h') {
      const ah = (a.h2h && a.h2h[b.teamId]) || 0, bh = (b.h2h && b.h2h[a.teamId]) || 0;
      if (ah !== bh) return bh - ah;
    }
    const gdDiff = ((b.gf - b.ga) - (a.gf - a.ga));
    if (gdDiff !== 0) return gdDiff;
    return b.gf - a.gf;
  });
  lgRenderStandingsTab(); lgSave();
  lgStatus('Standings recalculated from schedule.', true);
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
        const dtStr = [m.date, m.time].filter(Boolean).map(esc).join(' · ');
        return `<div class="lg2-match-item" data-mid="${m.id}">
          <div class="lg2-match-row">
            <div class="lg2-match-teams">
              <span${winner === 'A' ? ' style="font-weight:900"' : winner === 'B' ? ' style="color:var(--muted)"' : ''}>${esc(aName)}</span>
              <span style="color:var(--muted);margin:0 6px;">vs</span>
              <span${winner === 'B' ? ' style="font-weight:900"' : winner === 'A' ? ' style="color:var(--muted)"' : ''}>${esc(bName)}</span>
            </div>
            <span class="lg2-match-fmt">${esc(m.format || 'BO3')}</span>
            ${dtStr ? `<span class="lg2-match-date">${dtStr}</span>` : ''}
            <div class="lg2-match-score">
              <input type="number" class="input-text lg2-score-a" data-mid="${m.id}" value="${r.scoreA ?? ''}" placeholder="—" min="0">
              <span style="color:var(--muted);font-weight:700;">:</span>
              <input type="number" class="input-text lg2-score-b" data-mid="${m.id}" value="${r.scoreB ?? ''}" placeholder="—" min="0">
            </div>
            <button class="btn btn-ghost btn-xs lg2-match-live" data-mid="${m.id}">Go Live</button>
            <button class="lg-del lg2-match-del" data-mid="${m.id}" title="Remove">×</button>
          </div>
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
    lgSave(); lgRenderScheduleTab();
  };
  wrap.querySelectorAll('.lg2-score-a, .lg2-score-b').forEach((inp) => inp.addEventListener('change', () => saveScore(inp.dataset.mid)));
  wrap.querySelectorAll('.lg2-match-del').forEach((b) => b.addEventListener('click', () => { lg.schedule = (lg.schedule || []).filter((m) => m.id !== b.dataset.mid); lgRenderScheduleTab(); lgSave(); }));
  wrap.querySelectorAll('.lg2-match-live').forEach((b) => b.addEventListener('click', () => {
    const m = (lg.schedule || []).find((x) => x.id === b.dataset.mid); if (!m) return;
    const ta = (lg.teams || []).find((t) => t.id === m.teamA), tb = (lg.teams || []).find((t) => t.id === m.teamB);
    if (!ta || !tb) { lgStatus('Add both teams to the Roster tab first.', false); return; }
    const ra = lgResolveTeam(ta), rb = lgResolveTeam(tb);
    send('set_team', { side: 'blue',   name: ra.name, logo: ra.logo || null, players: ra.players.map((p) => ({ name: p.name, role: p.role })) });
    send('set_team', { side: 'orange', name: rb.name, logo: rb.logo || null, players: rb.players.map((p) => ({ name: p.name, role: p.role })) });
    send('reset_series'); lgStatus(`${ra.name} vs ${rb.name} pushed live.`, true);
  }));
  wrap.querySelectorAll('.lg2-match-notes-inp').forEach(inp => inp.addEventListener('change', () => {
    const m = (lg.schedule || []).find(x => x.id === inp.dataset.mid); if (!m) return;
    m.notes = inp.value.trim(); lgSave();
  }));
  wrap.querySelectorAll('.lg2-match-vod-inp').forEach(inp => inp.addEventListener('change', () => {
    const m = (lg.schedule || []).find(x => x.id === inp.dataset.mid); if (!m) return;
    m.vod = inp.value.trim(); lgSave();
  }));
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
  lg.schedule.push({ id: lgUid('m'), teamA: a, teamB: b, format: fmt, week, date, time, result: { scoreA: null, scoreB: null } });
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
        lg.schedule.push({ id: lgUid('m'), teamA: ta.id, teamB: tb.id, format: fmt, week, date: '', result: { scoreA: null, scoreB: null } });
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
        lg.schedule.push({ id: lgUid('m'), teamA: ta.id, teamB: tb.id, format: fmt, week, date: '', result: { scoreA: null, scoreB: null } });
        existing.add(`${ta.id}|${tb.id}`); added++;
      }
    });
  });
  rounds.forEach((round, ri) => {
    const week = String(startWeek + rounds.length + ri);
    round.forEach(([ta, tb]) => {
      if (!existing.has(`${tb.id}|${ta.id}`)) {
        lg.schedule = lg.schedule || [];
        lg.schedule.push({ id: lgUid('m'), teamA: tb.id, teamB: ta.id, format: fmt, week, date: '', result: { scoreA: null, scoreB: null } });
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
  const tbEl = el('lg-tiebreak'); if (tbEl) tbEl.value = lg.tiebreak || 'gd';
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
    send('set_team', { side: 'blue',   name: ra.name, logo: ra.logo || null, players: (ra.players || []).map((p) => ({ name: p.name, role: p.role })) });
    send('set_team', { side: 'orange', name: rb.name, logo: rb.logo || null, players: (rb.players || []).map((p) => ({ name: p.name, role: p.role })) });
    send('reset_series'); lgStatus(`${ra.name} vs ${rb.name} pushed live.`, true);
  }));
}
function lgRenderOverview() {
  const lg = lgActive(); if (!lg) return;
  const schedule = lg.schedule || [];
  const played = schedule.filter((m) => m.result && m.result.scoreA != null).length;
  if (el('lg2-stat-teams')) el('lg2-stat-teams').textContent = (lg.teams || []).length;
  if (el('lg2-stat-played')) el('lg2-stat-played').textContent = played;
  if (el('lg2-stat-remaining')) el('lg2-stat-remaining').textContent = schedule.length - played;
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  let leader = null, topPts = -1;
  for (const tm of (lg.teams || [])) { const pts = (byId[tm.id] || {}).pts || 0; if (pts > topPts) { topPts = pts; leader = lgResolveTeam(tm).name; } }
  if (el('lg2-stat-leader')) el('lg2-stat-leader').textContent = ((lg.standings || []).length && leader) ? leader : '—';
  lgRenderMatchup(); lgRenderRecentResults(); lgRenderNextMatches();
}

// ── tab switching ──────────────────────────────────────────────────────────
function lgSwitchTab(name) {
  _lgActiveTab = name;
  document.querySelectorAll('#lg2-tabs .lg2-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['overview', 'roster', 'standings', 'schedule', 'settings'].forEach((t) => {
    const p = el('lg2-panel-' + t); if (p) p.style.display = t === name ? '' : 'none';
  });
  if (name === 'overview') lgRenderOverview();
  else if (name === 'roster') { lgRenderTeams(); lgRenderFreeAgents(); }
  else if (name === 'standings') lgRenderStandingsTab();
  else if (name === 'schedule') lgRenderScheduleTab();
  else if (name === 'settings') lgRenderSettingsTab();
}

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
el('lg-delete')?.addEventListener('click', () => { const lg = lgActive(); if (!lg) return; appConfirm('Delete this league?', 'Delete').then(ok => { if (!ok) return; lgLeagues = lgLeagues.filter((l) => l.id !== lg.id); lgActiveId = null; lgRender(); lgSave(); }); });
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
          const results = data.results || [];
          if (!results.length) { dd.innerHTML = '<div class="team-dd-item team-dd-empty">No leagues found.</div>'; dd.style.display = 'block'; return; }
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
})();

el('lg-sgg-sync')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  if (!lg.startggSource) { showToast('Set a start.gg league source first.', '#f59e0b'); return; }
  if (!currentState.startgg?.hasToken) { showToast('Set up your Start.gg API token in Settings first.', '#f59e0b'); return; }
  lgStatus('Syncing matches from start.gg…');
  fetch('http://localhost:3000/api/startgg/league-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leagueId: lg.id }) })
    .then(r => r.json()).then(data => {
      if (data.error) { lgStatus('Sync failed: ' + data.error, false); return; }
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
el('lg-manage-teams')?.addEventListener('click', () => { if (typeof switchTab === 'function') switchTab('equipos'); });
el('lg-recalc')?.addEventListener('click', lgComputeStandingsFromSchedule);
el('lg-add-match')?.addEventListener('click', lgAddMatch);
el('lg-gen-rr')?.addEventListener('click', lgGenerateRoundRobin);
el('lg-gen-drr')?.addEventListener('click', lgGenerateDoubleRoundRobin);
el('lg2-tabs')?.addEventListener('click', (e) => { const tab = e.target.closest('.lg2-tab'); if (tab) lgSwitchTab(tab.dataset.tab); });

// Logo + name search typeahead for adding teams from the central library (reuses the .team-dd look).
function setupLeagueTeamSearch() {
  const input = el('lg-team-search'); const dd = el('lg-team-dd');
  if (!input || !dd) return;
  let items = [], active = -1, open = false;
  const candidates = (q) => {
    const lg = lgActive(); if (!lg) return [];
    const taken = new Set((lg.teams || []).map((t) => t.teamName || t.name));
    q = (q || '').trim().toLowerCase();
    return (currentState.savedTeams || [])
      .filter((s) => !taken.has(s.name) && (!q || (s.name || '').toLowerCase().includes(q)))
      .slice(0, 60);
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
  const ta = findTeam(a), tb = findTeam(b);
  send('set_team', { side: 'blue',   name: a, logo: (ta && ta.logo) || null, color: (ta && ta.color) || undefined, players: (ta && ta.players) || [] });
  send('set_team', { side: 'orange', name: b, logo: (tb && tb.logo) || null, color: (tb && tb.color) || undefined, players: (tb && tb.players) || [] });
  send('reset_series');
  if (el('lg-mu-title')?.checked) {
    const title = [lg.name, lg.season].filter(Boolean).join(' — ');
    if (title) send('set_event_name', { name: title.toUpperCase() });
  }
  lgStatus(`${a} vs ${b} pushed live.`, true);
});
el('lg-add-fa')?.addEventListener('click', () => { const lg = lgActive(); if (lg) { lg.freeAgents.push(lgNewPlayer()); lgRenderFreeAgents(); lgSave(); } });
el('lg-push-standings')?.addEventListener('click', () => {
  const lg = lgActive(); if (!lg) return;
  const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
  const teamsById = {}; (lg.teams || []).forEach(t => { teamsById[t.id] = t; });
  // Use the stored standings order (which the tab preserves via drag); fall back to pts sort
  const ordered = (lg.standings && lg.standings.length)
    ? lg.standings.map(s => teamsById[s.teamId]).filter(Boolean)
    : (lg.teams || []).slice().sort((a, b) => ((byId[b.id] || {}).pts || 0) - ((byId[a.id] || {}).pts || 0));
  const rows = ordered.map((tm, i) => {
    const s = byId[tm.id] || {};
    const r = lgResolveTeam(tm);
    return { placement: i + 1, name: r.name || tm.teamName || 'Team', logo: r.logo || null, wins: s.w || 0, losses: s.l || 0, points: s.pts || 0 };
  });
  const title = [lg.name, lg.season].filter(Boolean).join(' — ');
  send('set_standings', { visible: true, title: title || 'Standings', rows });
  lgStatus('Standings pushed to the standings overlay.', true);
});

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

