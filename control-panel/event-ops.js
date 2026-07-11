// ── EVENT OPS (ESPORTS ▸ Event Ops) ──────────────────────────────────────────
// The start.gg → Challonge mirroring workbench:
//   1. Import the start.gg attendee CSV → roster dashboard (team, players, emails,
//      Challonge usernames) with copy helpers for populating Challonge teams.
//   2. Pull TRUE bracket seeds (initialSeedNum) from the start.gg API — the exact
//      order to recreate on Challonge so byes land identically.
//   3. Bracket explorer: the full imported start.gg bracket with scores; click a
//      team to trace its whole path (every set, every phase) while copying results.
// Depends on globals from earlier scripts: el(), send(), currentState, showToast(),
// csvParse() (seeding-spotlight.js). State lives in state.eventOps (library tier).

(function () {
  'use strict';

  const eoEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const eoOps = () => (window.currentState && currentState.eventOps) || { rows: [], seeds: [] };
  let _eoTeam = '';       // selected team (bracket path + card highlight)
  let _eoSearch = '';
  let _eoSort = 'team';   // team | seed | players
  let _eoFilter = 'all';  // all | noemail | nochallonge
  let _eoPhaseId = '';    // bracket explorer phase/pool selection
  let _eoPoolId = '';

  function eoCopy(text, label) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Copied ' + label + '.', '#22c55e'),
      () => showToast('Could not copy — clipboard blocked.', '#c53030')
    );
  }

  // ── CSV import with column mapping ─────────────────────────────────────────
  let _eoCsv = null;   // { headers, rows } while the mapping box is open

  el('eo-csv-pick')?.addEventListener('click', () => el('eo-csv-file')?.click());
  el('eo-csv-file')?.addEventListener('change', function () {
    const f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const all = (typeof csvParse === 'function' ? csvParse(ev.target.result || '') : [])
        .filter((r) => r.some((c) => (c || '').toString().trim()));
      if (all.length < 2) { showToast('CSV looks empty — need a header row plus data.', '#c53030'); return; }
      _eoCsv = { headers: all[0].map((h) => (h || '').toString().trim()), rows: all.slice(1) };
      eoRenderMapBox();
    };
    reader.readAsText(f);
  });

  // Header auto-guess: start.gg attendee exports name these differently per event
  // (custom registration fields carry whatever label the TO typed), so match loosely.
  // Team lives in TWO columns on team events: "<event> Completed Team" (registered as a
  // full squad) and "<event> Incomplete Teams" ("ACCEPTED: <team>" once filled) — a row
  // has one, the other, or neither (free agent).
  const GUESS = {
    team:      [/completed team/i, /^entrant/i, /^team$/i, /squad/i],
    team2:     [/incomplete team/i],
    player:    [/^gamer.?tag$/i, /gamer.?tag/i, /^tag$/i, /player/i, /^name$/i, /^attendee/i],
    email:     [/^e-?mail$/i, /e-?mail/i],
    challonge: [/challonge.*(url|profile)/i, /(url|profile).*challonge/i, /challonge(?!.*register)/i, /challonge/i],
    flags:     [/member\s*flags/i, /\bflags\b/i]
  };
  function guessCol(headers, key) {
    for (const re of GUESS[key]) {
      const i = headers.findIndex((h) => re.test(h));
      if (i !== -1) return i;
    }
    return -1;
  }

  // "ACCEPTED: Cyclone Esports" → "Cyclone Esports" (start.gg prefixes the roster status).
  const cleanTeam = (v) => String(v || '').trim().replace(/^(accepted|pending|invited|waitlisted|declined)\s*:\s*/i, '').trim();
  // Challonge answers are a mess of profile URLs (challonge.com/users/x, regional /es/ /fr/
  // subpaths, league subdomains) and bare usernames — extract the username when it's a
  // challonge URL, otherwise show what they typed so junk answers are visible.
  function cleanChallonge(v) {
    v = String(v || '').trim();
    if (!v || /^x$/i.test(v)) return '';
    const m = v.match(/challonge\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?users\/([^\/?#\s]+)/i);
    if (m) { try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; } }
    return v;
  }
  // Shared by the live preview and the import so what you see is exactly what lands.
  function deriveRow(r, idx) {
    const pick = (k) => (idx[k] >= 0 ? (r[idx[k]] || '').toString().trim() : '');
    return {
      team: cleanTeam(pick('team')) || cleanTeam(pick('team2')),
      player: pick('player'),
      email: pick('email'),
      challonge: cleanChallonge(pick('challonge')),
      flags: pick('flags').toUpperCase()
    };
  }

  function eoRenderMapBox() {
    const box = el('eo-map-box'); if (!box || !_eoCsv) return;
    const { headers, rows } = _eoCsv;
    // Distinct non-empty values per column — the fastest way to SEE which column is
    // the team (repeats, few distinct) vs per-player data (mostly unique).
    const distinct = headers.map((_, i) => new Set(rows.map((r) => (r[i] || '').toString().trim().toLowerCase()).filter(Boolean)).size);
    const opts = (sel) => ['<option value="-1">— none —</option>']
      .concat(headers.map((h, i) =>
        `<option value="${i}"${i === sel ? ' selected' : ''}>${eoEsc(h) || '(column ' + (i + 1) + ')'} · ${distinct[i]} unique</option>`)).join('');
    const fields = [
      ['team', 'Team name'], ['team2', 'Team name (2nd column)'], ['player', 'Player / gamertag'],
      ['email', 'Email'], ['challonge', 'Challonge username'], ['flags', 'Captain/role flags']
    ];
    // Header guess first; if no header matches for TEAM, fall back to the most
    // repeated text column (a team column has ~rows/teamSize distinct values).
    let teamGuess = guessCol(headers, 'team');
    if (teamGuess < 0 && rows.length > 4) {
      let best = -1, bestN = Infinity;
      distinct.forEach((n, i) => { if (n >= 2 && n < rows.length * 0.8 && n < bestN) { best = i; bestN = n; } });
      teamGuess = best;
    }
    box.style.display = '';
    box.innerHTML = `
      <div class="eo-map-grid">
        ${fields.map(([k, label]) => `
          <label class="eo-map-field">
            <span>${label}</span>
            <select class="input-select" id="eo-map-${k}">${opts(k === 'team' ? teamGuess : guessCol(headers, k))}</select>
          </label>`).join('')}
      </div>
      <p class="field-hint" style="margin:0 0 8px;">start.gg team events split the team across two columns — "…Completed Team" and "…Incomplete Teams" ("ACCEPTED: name"). Map both; the status prefix is stripped automatically, players with neither become Free Agents.</p>
      <div class="eo-map-summary" id="eo-map-summary"></div>
      <div class="eo-map-preview" id="eo-map-preview"></div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="btn btn-primary btn-sm" id="eo-map-import">Import ${rows.length} rows</button>
        <button class="btn btn-ghost btn-sm" id="eo-map-cancel">Cancel</button>
      </div>`;
    const readIdx = () => { const idx = {}; fields.forEach(([k]) => { idx[k] = Number(el('eo-map-' + k)?.value); }); return idx; };
    const preview = () => {
      const idx = readIdx();
      const derived = rows.map((r) => deriveRow(r, idx));
      // Live outcome: exactly how the dashboard will group this mapping.
      const teamsN = new Set(derived.map((d) => d.team.toLowerCase()).filter(Boolean)).size;
      const freeN = derived.filter((d) => !d.team && d.player).length;
      const sm = el('eo-map-summary');
      if (sm) {
        if (idx.team < 0 && idx.team2 < 0) {
          sm.innerHTML = '<span class="eo-miss">No team column selected — everyone will land in one Free Agents group. Map the "…Completed Team" and "…Incomplete Teams" columns.</span>';
        } else if (teamsN <= 1 && rows.length > 4) {
          sm.innerHTML = `<span class="eo-miss">This mapping creates only ${teamsN || 1} team from ${rows.length} rows — those columns don't look like team names.</span>`;
        } else {
          sm.innerHTML = `<span class="eo-ok">This mapping creates ${teamsN} teams · ${rows.length} players${freeN ? ` · ${freeN} free agents` : ''}.</span>`;
        }
      }
      const cols = [['team', 'Team (derived)'], ['player', 'Player'], ['email', 'Email'], ['challonge', 'Challonge'], ['flags', 'Flags']];
      const head = '<tr>' + cols.map(([, l]) => `<th>${l}</th>`).join('') + '</tr>';
      const body = derived.slice(0, 5).map((d) =>
        '<tr>' + cols.map(([k]) => `<td>${d[k] ? eoEsc(d[k]) : '<span class="eo-dim">—</span>'}</td>`).join('') + '</tr>').join('');
      const pv = el('eo-map-preview'); if (pv) pv.innerHTML = `<table class="eo-table">${head}${body}</table>`;
    };
    fields.forEach(([k]) => el('eo-map-' + k)?.addEventListener('change', preview));
    preview();
    el('eo-map-cancel')?.addEventListener('click', () => { _eoCsv = null; box.style.display = 'none'; box.innerHTML = ''; });
    el('eo-map-import')?.addEventListener('click', () => {
      const idx = readIdx();
      if (idx.team < 0 && idx.team2 < 0 && idx.player < 0) { showToast('Map at least the team or player column.', '#fbbf24'); return; }
      const out = rows.map((r) => deriveRow(r, idx)).filter((r) => r.team || r.player);
      send('set_event_ops', { rows: out, eventSlug: (currentState?.startgg?.eventSlug || '') });
      _eoCsv = null; box.style.display = 'none'; box.innerHTML = '';
      showToast('Imported ' + out.length + ' roster rows.', '#22c55e');
    });
  }

  el('eo-clear')?.addEventListener('click', () => {
    if (!confirm('Clear the imported roster? (The CSV file itself is untouched.)')) return;
    send('set_event_ops', { rows: [] });
  });

  // ── Roster dashboard ────────────────────────────────────────────────────────
  function seedByName() {
    const m = new Map();
    (eoOps().seeds || []).forEach((s) => m.set((s.name || '').toLowerCase(), s.seed));
    return m;
  }
  const FREE_AGENTS = 'Free Agents';
  function groupTeams(rows) {
    const m = new Map();
    rows.forEach((r) => {
      const key = (r.team || FREE_AGENTS).trim() || FREE_AGENTS;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    });
    // Captains first inside each team, then keep CSV order.
    const rank = (p) => (/captain/i.test(p.flags || '') ? 0 : /alternate|sub/i.test(p.flags || '') ? 2 : 1);
    return [...m.entries()].map(([team, players]) => ({ team, players: players.slice().sort((a, b) => rank(a) - rank(b)) }));
  }

  function eoRenderDash() {
    const host = el('eo-dash'); if (!host) return;
    const rows = eoOps().rows || [];
    const clearBtn = el('eo-clear'); if (clearBtn) clearBtn.style.display = rows.length ? '' : 'none';
    if (!rows.length) {
      host.innerHTML = '<div class="eo-empty">No roster imported yet — export the attendee CSV from start.gg and click <strong>Import start.gg CSV</strong>.</div>';
      return;
    }
    const seeds = seedByName();
    let teams = groupTeams(rows);

    // Sift: free-text search + missing-data filters.
    const q = _eoSearch.trim().toLowerCase();
    if (q) {
      teams = teams.filter((t) =>
        t.team.toLowerCase().includes(q) ||
        t.players.some((p) => (p.player + ' ' + p.email + ' ' + p.challonge).toLowerCase().includes(q)));
    }
    if (_eoFilter === 'noemail') teams = teams.filter((t) => t.players.some((p) => !p.email));
    if (_eoFilter === 'nochallonge') teams = teams.filter((t) => t.players.some((p) => !p.challonge));

    // Sort: team A–Z, start.gg seed, or roster size.
    const seedOf = (t) => { const s = seeds.get(t.team.toLowerCase()); return s != null ? s : 9999; };
    if (_eoSort === 'seed') teams.sort((a, b) => seedOf(a) - seedOf(b) || a.team.localeCompare(b.team));
    else if (_eoSort === 'players') teams.sort((a, b) => b.players.length - a.players.length || a.team.localeCompare(b.team));
    else teams.sort((a, b) => a.team.localeCompare(b.team, undefined, { sensitivity: 'base', numeric: true }));

    const emails = rows.filter((r) => r.email);
    const challonges = rows.filter((r) => r.challonge);

    // Imported with no/bad team column → one giant "(No team)" group. Say so instead
    // of letting it look like the dashboard only supports one team.
    const totalTeams = groupTeams(rows).length;
    const badGrouping = totalTeams <= 1 && rows.length > 4
      ? `<div class="eo-empty" style="border-color:rgba(245,158,11,.5); color:#fbbf24; margin-bottom:10px;">All ${rows.length} players are in one group — the CSV import needs the TEAM column mapped. Click <strong>Import start.gg CSV</strong> again and pick the column that repeats per team (start.gg calls it "Entrant").</div>`
      : '';
    const chips = `
      ${badGrouping}
      <div class="eo-chips">
        <span class="eo-chip">${groupTeams(rows).length} teams</span>
        <span class="eo-chip">${rows.length} players</span>
        <span class="eo-chip${emails.length < rows.length ? ' warn' : ''}">${emails.length}/${rows.length} emails</span>
        <span class="eo-chip${challonges.length < rows.length ? ' warn' : ''}">${challonges.length}/${rows.length} challonge</span>
      </div>`;
    const controls = `
      <div class="eo-controls">
        <input type="text" id="eo-search" class="input-text" placeholder="Search team, player, email, challonge…" value="${eoEsc(_eoSearch)}">
        <select class="input-select eo-ctl-sel" id="eo-sort" title="Sort teams">
          <option value="team"${_eoSort === 'team' ? ' selected' : ''}>Sort: Team A–Z</option>
          <option value="seed"${_eoSort === 'seed' ? ' selected' : ''}>Sort: Seed</option>
          <option value="players"${_eoSort === 'players' ? ' selected' : ''}>Sort: Most players</option>
        </select>
        <select class="input-select eo-ctl-sel" id="eo-filter" title="Filter teams">
          <option value="all"${_eoFilter === 'all' ? ' selected' : ''}>All teams</option>
          <option value="noemail"${_eoFilter === 'noemail' ? ' selected' : ''}>Missing emails</option>
          <option value="nochallonge"${_eoFilter === 'nochallonge' ? ' selected' : ''}>Missing challonge</option>
        </select>
        <button class="btn btn-secondary btn-sm" id="eo-copy-emails" title="Every email in the roster, one per line">Copy all emails</button>
        <button class="btn btn-secondary btn-sm" id="eo-copy-challonge" title="Every Challonge username, one per line">Copy all Challonge</button>
      </div>`;

    // One block per team, whitespace between blocks:
    //   TEAM NAME — SEED X
    //   Player 1  GAMERTAG   EMAIL   CHALLONGE
    const blocks = teams.map((t) => {
      const seed = seeds.get(t.team.toLowerCase());
      const sel = _eoTeam && _eoTeam.toLowerCase() === t.team.toLowerCase();
      return `
        <div class="eo-block${sel ? ' sel' : ''}">
          <div class="eo-block-head" data-eo-team="${eoEsc(t.team)}">
            <span class="eo-block-title">${eoEsc(t.team)}</span>
            <span class="eo-block-seed">${seed != null ? '— SEED ' + seed : ''}</span>
            <span class="eo-team-n">${t.players.length} player${t.players.length === 1 ? '' : 's'}</span>
            <button class="btn btn-ghost btn-sm eo-copy-team" data-team="${eoEsc(t.team)}" title="Copy this team's emails">Copy emails</button>
          </div>
          ${t.players.map((p, i) => `
            <div class="eo-block-player">
              <span class="eo-p-idx">Player ${i + 1}</span>
              <span class="eo-p-name">${eoEsc(p.player) || '<span class="eo-dim">—</span>'}${/captain/i.test(p.flags || '') ? ' <span class="eo-flag cap">C</span>' : ''}${/alternate|sub/i.test(p.flags || '') ? ' <span class="eo-flag">ALT</span>' : ''}</span>
              <span class="eo-p-mail">${p.email ? eoEsc(p.email) : '<span class="eo-miss">no email</span>'}</span>
              <span class="eo-p-ch">${p.challonge ? eoEsc(p.challonge) : '<span class="eo-miss">no challonge</span>'}</span>
            </div>`).join('')}
        </div>`;
    }).join('');
    host.innerHTML = chips + controls +
      (teams.length ? `<div class="eo-blocks">${blocks}</div>` : '<div class="eo-empty">Nothing matches this search/filter.</div>');
    el('eo-sort')?.addEventListener('change', function () { _eoSort = this.value; eoRenderDash(); });
    el('eo-filter')?.addEventListener('change', function () { _eoFilter = this.value; eoRenderDash(); });

    const search = el('eo-search');
    search?.addEventListener('input', () => { _eoSearch = search.value; eoRenderDash(); });
    if (q && search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
    el('eo-copy-emails')?.addEventListener('click', () => eoCopy(emails.map((r) => r.email).join('\n'), emails.length + ' emails'));
    el('eo-copy-challonge')?.addEventListener('click', () => eoCopy(challonges.map((r) => r.challonge).join('\n'), challonges.length + ' Challonge usernames'));
    host.querySelectorAll('.eo-copy-team').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const t = groupTeams(rows).find((x) => x.team === b.dataset.team);
      const list = (t ? t.players.filter((p) => p.email).map((p) => p.email) : []);
      if (!list.length) { showToast('No emails on this team.', '#fbbf24'); return; }
      eoCopy(list.join('\n'), list.length + ' emails (' + b.dataset.team + ')');
    }));
    host.querySelectorAll('.eo-block-head').forEach((c) => c.addEventListener('click', () => {
      eoSelectTeam(c.dataset.eoTeam === _eoTeam ? '' : c.dataset.eoTeam);
    }));
  }

  // ── Seeding table ───────────────────────────────────────────────────────────
  el('eo-seed-pull')?.addEventListener('click', () => {
    const st = el('eo-seed-status');
    if (st) { st.textContent = 'Pulling seeds from start.gg…'; st.style.color = 'var(--muted)'; }
    send('eventops_fetch_seeds', { slug: (el('eo-seed-slug')?.value || '').trim() });
  });
  window.eventOpsResult = function (d) {
    const st = el('eo-seed-status');
    if (st) { st.textContent = d.message || ''; st.style.color = d.ok ? '#9ae6b4' : '#f56565'; }
    if (!d.ok) showToast(d.message || 'Seed fetch failed.', '#c53030', 6000);
  };

  function eoRenderSeeds() {
    const host = el('eo-seeds'); if (!host) return;
    const ops = eoOps();
    const slugInp = el('eo-seed-slug');
    if (slugInp && !slugInp.value && document.activeElement !== slugInp) {
      slugInp.value = ops.eventSlug || currentState?.bracket?.eventSlug || currentState?.startgg?.eventSlug || '';
    }
    const seeds = ops.seeds || [];
    if (!seeds.length) { host.innerHTML = '<div class="eo-empty">No seeds pulled yet.</div>'; return; }
    const rosterTeams = new Set(groupTeams(ops.rows || []).map((t) => t.team.toLowerCase()));
    const rowsHtml = seeds.map((s) => `
      <tr class="eo-seed-row${_eoTeam && _eoTeam.toLowerCase() === s.name.toLowerCase() ? ' sel' : ''}" data-eo-team="${eoEsc(s.name)}">
        <td class="eo-seed-num">${s.seed}</td>
        <td>${eoEsc(s.name)}</td>
        <td>${rosterTeams.size ? (rosterTeams.has(s.name.toLowerCase()) ? '<span class="eo-ok">in roster</span>' : '<span class="eo-miss">not in CSV</span>') : ''}</td>
      </tr>`).join('');
    host.innerHTML = `
      <div class="eo-controls" style="margin-top:0;">
        <button class="btn btn-secondary btn-sm" id="eo-copy-seedorder" title="Team names in seed order, one per line — paste into Challonge bulk add">Copy names in seed order</button>
        <span class="field-hint" style="margin:0;">Challonge ▸ Participants ▸ bulk add keeps this order, so seeds match start.gg.</span>
      </div>
      <table class="eo-table eo-seed-table"><tr><th>Seed</th><th>Team</th><th></th></tr>${rowsHtml}</table>`;
    el('eo-copy-seedorder')?.addEventListener('click', () =>
      eoCopy(seeds.map((s) => s.name).join('\n'), seeds.length + ' teams in seed order'));
    host.querySelectorAll('.eo-seed-row').forEach((r) => r.addEventListener('click', () => {
      eoSelectTeam(r.dataset.eoTeam === _eoTeam ? '' : r.dataset.eoTeam);
    }));
  }

  // ── Bracket explorer + click-a-team path ───────────────────────────────────
  el('eo-goto-bracket')?.addEventListener('click', () => {
    if (typeof evSelectTab === 'function') evSelectTab('brackets');
  });

  function bands(container) {
    // A pool/phase's round bands in play order; swiss/RR events carry `schedule` instead.
    const out = [];
    (container.winners || []).forEach((r) => out.push({ band: 'Winners', ...r }));
    (container.losers || []).forEach((r) => out.push({ band: 'Losers', ...r }));
    (container.finals || []).forEach((r) => out.push({ band: 'Grand Final', ...r }));
    (container.schedule || []).forEach((r) => out.push({ band: '', ...r }));
    return out;
  }

  // Every set a team plays, across every phase and pool, in display order.
  function teamPath(name) {
    const br = currentState?.bracket || {};
    const low = (name || '').toLowerCase();
    const path = [];
    (br.phases || []).forEach((ph) => {
      const pools = (ph.pools && ph.pools.length) ? ph.pools : [{ name: '', winners: ph.winners, losers: ph.losers, finals: ph.finals, schedule: ph.schedule }];
      pools.forEach((pool) => {
        bands(pool).forEach((round) => {
          (round.sets || []).forEach((s) => {
            const aN = (s.a && s.a.name) || '', bN = (s.b && s.b.name) || '';
            if (aN.toLowerCase() !== low && bN.toLowerCase() !== low) return;
            const me = aN.toLowerCase() === low ? s.a : s.b;
            const opp = aN.toLowerCase() === low ? s.b : s.a;
            path.push({
              phase: ph.name, pool: pool.name && pools.length > 1 ? pool.name : '',
              round: round.name, band: round.band,
              opp: (opp && opp.name) || 'TBD',
              myScore: me && me.score != null ? me.score : null,
              oppScore: opp && opp.score != null ? opp.score : null,
              won: !!(me && me.winner), done: s.state === 3, live: s.state === 2
            });
          });
        });
      });
    });
    return path;
  }

  function eoSelectTeam(name) {
    _eoTeam = name || '';
    eoRenderDash(); eoRenderSeeds(); eoRenderBracket();
  }

  function eoRenderBracket() {
    const host = el('eo-bracket'); if (!host) return;
    const br = currentState?.bracket || {};
    const phases = br.phases || [];
    if (!phases.length) {
      host.innerHTML = '<div class="eo-empty">No bracket loaded — link a start.gg event on the Brackets &amp; Graphics tab and it appears here with every score.</div>';
      return;
    }
    let ph = phases.find((p) => p.id === _eoPhaseId) || phases[0];
    _eoPhaseId = ph.id;
    const pools = (ph.pools && ph.pools.length) ? ph.pools : [{ id: '', name: '', winners: ph.winners, losers: ph.losers, finals: ph.finals, schedule: ph.schedule }];
    let pool = pools.find((p) => p.id === _eoPoolId) || pools[0];
    _eoPoolId = pool.id;

    const phaseChips = phases.map((p) =>
      `<button class="eo-chipbtn${p.id === ph.id ? ' active' : ''}" data-eo-phase="${eoEsc(p.id)}">${eoEsc(p.name)}</button>`).join('');
    const poolChips = pools.length > 1 ? pools.map((p) =>
      `<button class="eo-chipbtn sm${p.id === pool.id ? ' active' : ''}" data-eo-pool="${eoEsc(p.id)}">${eoEsc(p.name)}</button>`).join('') : '';

    // Path panel for the selected team
    let pathHtml = '';
    if (_eoTeam) {
      const p = teamPath(_eoTeam);
      const seeds = seedByName();
      const seed = seeds.get(_eoTeam.toLowerCase());
      const wl = p.filter((x) => x.done);
      const wins = wl.filter((x) => x.won).length;
      pathHtml = `
        <div class="eo-path">
          <div class="eo-path-head">
            ${seed != null ? `<span class="eo-seed">#${seed}</span>` : ''}
            <span class="eo-path-team">${eoEsc(_eoTeam)}</span>
            <span class="eo-path-rec">${wins}–${wl.length - wins} in sets</span>
            <button class="btn btn-ghost btn-sm" id="eo-path-close">Close</button>
          </div>
          ${p.length ? p.map((x) => `
            <div class="eo-path-row${x.done ? (x.won ? ' win' : ' loss') : ''}${x.live ? ' live' : ''}">
              <span class="eo-path-round">${eoEsc([x.phase, x.pool].filter(Boolean).join(' · '))}${x.band ? ' — ' + x.band : ''} · ${eoEsc(x.round)}</span>
              <span class="eo-path-res">${x.done ? (x.won ? 'W' : 'L') : (x.live ? 'LIVE' : '·')}</span>
              <span class="eo-path-score">${x.myScore != null && x.oppScore != null ? x.myScore + '–' + x.oppScore : '—'}</span>
              <span class="eo-path-opp">vs ${eoEsc(x.opp)}</span>
            </div>`).join('') : '<div class="eo-empty">No sets found for this team in the loaded bracket.</div>'}
        </div>`;
    }

    // Bracket grid: one column per round
    const low = _eoTeam.toLowerCase();
    const roundCols = bands(pool).map((round) => `
      <div class="eo-round">
        <div class="eo-round-name">${round.band && round.band !== 'Winners' ? eoEsc(round.band) + ' · ' : ''}${eoEsc(round.name)}</div>
        ${(round.sets || []).map((s) => {
          const hit = low && ((s.a && s.a.name || '').toLowerCase() === low || (s.b && s.b.name || '').toLowerCase() === low);
          const row = (slot) => {
            const nm = (slot && slot.name) || 'TBD';
            const isMe = low && nm.toLowerCase() === low;
            return `<div class="eo-set-row${slot && slot.winner ? ' win' : ''}${isMe ? ' me' : ''}">
              <span class="eo-set-name" data-eo-team="${eoEsc(nm)}">${eoEsc(nm)}</span>
              <span class="eo-set-score">${slot && slot.score != null ? slot.score : ''}</span>
            </div>`;
          };
          return `<div class="eo-set${hit ? ' hl' : ''}${s.state === 2 ? ' live' : ''}${s.state !== 3 ? ' pend' : ''}">${row(s.a)}${row(s.b)}</div>`;
        }).join('')}
      </div>`).join('');

    host.innerHTML = `
      <div class="eo-chips" style="margin-bottom:6px;">${phaseChips}</div>
      ${poolChips ? `<div class="eo-chips" style="margin-bottom:8px;">${poolChips}</div>` : ''}
      ${pathHtml}
      <div class="eo-bracket-scroll"><div class="eo-rounds">${roundCols || '<div class="eo-empty">This phase has no sets.</div>'}</div></div>
      <p class="field-hint" style="margin-top:8px;">Click any team name to trace their full path with scores.</p>`;

    host.querySelectorAll('[data-eo-phase]').forEach((b) => b.addEventListener('click', () => { _eoPhaseId = b.dataset.eoPhase; _eoPoolId = ''; eoRenderBracket(); }));
    host.querySelectorAll('[data-eo-pool]').forEach((b) => b.addEventListener('click', () => { _eoPoolId = b.dataset.eoPool; eoRenderBracket(); }));
    host.querySelectorAll('.eo-set-name').forEach((n) => n.addEventListener('click', () => {
      const t = n.dataset.eoTeam;
      if (!t || t === 'TBD') return;
      eoSelectTeam(t.toLowerCase() === low ? '' : t);
    }));
    el('eo-path-close')?.addEventListener('click', () => eoSelectTeam(''));
  }

  // ── Render entry points ─────────────────────────────────────────────────────
  window.eventOpsRender = function () {
    eoRenderDash(); eoRenderSeeds(); eoRenderBracket();
  };
  // full_state hook — only re-render while the tab is visible (renders are cheap but
  // full_state arrives constantly; skip the work when the panel is hidden).
  window.eventOpsOnState = function () {
    const panel = el('ev-eventops-panel');
    if (!panel || panel.style.display === 'none') return;
    // Don't rebuild under the producer's cursor mid-keystroke.
    const a = document.activeElement;
    if (a && (a.id === 'eo-search' || a.id === 'eo-seed-slug')) return;
    window.eventOpsRender();
  };
})();
