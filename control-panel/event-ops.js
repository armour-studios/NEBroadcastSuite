// ── EVENT OPS (ESPORTS ▸ Event Ops) ──────────────────────────────────────────
// A universal spreadsheet workbench for tournament ops (start.gg → Challonge):
//   1. Import ANY CSV — every column is kept. Work through it in a clean TABLE
//      (pick columns, click headers to sort, search, copy as TSV / per column),
//      or flip to a BY-TEAM view grouped from the columns you marked.
//   2. Pull TRUE bracket seeds (initialSeedNum) from the start.gg API.
//   3. Bracket explorer: the imported start.gg bracket with scores; click a
//      team to trace its whole path (every set, every phase).
// Data lives in state.eventOps (full headers+rows+roleMap, library tier) AND is
// mirrored to localStorage so the table works even if the app server predates
// the feature. Depends on globals: el(), send(), currentState, showToast(),
// csvParse() (spotlight.js).

(function () {
  'use strict';

  const eoEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const LS_DATA = 'ne_eventops_data_v1';
  const LS_COLS = 'ne_eventops_cols_v1';
  let _eoTeam = '';        // selected team (bracket path highlight)
  let _eoSearch = '';
  let _eoView = 'table';   // table | team
  let _eoSort = { col: -1, dir: 1 };
  let _eoVisible = null;   // Set of visible column indices (persisted per header signature)
  let _eoSeedAuto = false;   // one auto seed-pull attempt per session
  let _eoPhaseId = '';
  let _eoPoolId = '';

  // ── Data source: server state, falling back to the local mirror ────────────
  function eoData() {
    const s = (window.currentState && currentState.eventOps) || {};
    if (Array.isArray(s.headers) && s.headers.length && Array.isArray(s.rows)) {
      return { headers: s.headers, rows: s.rows, roleMap: s.roleMap || {}, seeds: s.seeds || [], eventSlug: s.eventSlug || '', local: false };
    }
    try {
      const l = JSON.parse(localStorage.getItem(LS_DATA) || 'null');
      if (l && Array.isArray(l.headers) && l.headers.length) return { ...l, seeds: (s.seeds || l.seeds || []), local: true };
    } catch (_) {}
    return { headers: [], rows: [], roleMap: {}, seeds: (s.seeds || []), eventSlug: s.eventSlug || '', local: false };
  }

  function eoCopy(text, label) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Copied ' + label + '.', '#22c55e'),
      () => showToast('Could not copy — clipboard blocked.', '#c53030')
    );
  }

  // ── CSV import ──────────────────────────────────────────────────────────────
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

  // Role auto-guess — powers the by-team view and Challonge copies. The TABLE always
  // keeps every column regardless; roles are optional helpers, not a filter.
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
  // Challonge answers are a mess of profile URLs and bare usernames — extract the
  // username when it's a challonge URL, otherwise show what they typed.
  function cleanChallonge(v) {
    v = String(v || '').trim();
    if (!v || /^x$/i.test(v)) return '';
    const m = v.match(/challonge\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?users\/([^\/?#\s]+)/i);
    if (m) { try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; } }
    return v;
  }
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
    const distinct = headers.map((_, i) => new Set(rows.map((r) => (r[i] || '').toString().trim().toLowerCase()).filter(Boolean)).size);
    const opts = (sel) => ['<option value="-1">— none —</option>']
      .concat(headers.map((h, i) =>
        `<option value="${i}"${i === sel ? ' selected' : ''}>${eoEsc(h) || '(column ' + (i + 1) + ')'} · ${distinct[i]} unique</option>`)).join('');
    const fields = [
      ['team', 'Team name'], ['team2', 'Team name (2nd column)'], ['player', 'Player / gamertag'],
      ['email', 'Email'], ['challonge', 'Challonge username'], ['flags', 'Captain/role flags']
    ];
    let teamGuess = guessCol(headers, 'team');
    if (teamGuess < 0 && rows.length > 4) {
      let best = -1, bestN = Infinity;
      distinct.forEach((n, i) => { if (n >= 2 && n < rows.length * 0.8 && n < bestN) { best = i; bestN = n; } });
      teamGuess = best;
    }
    box.style.display = '';
    box.innerHTML = `
      <p class="field-hint" style="margin:0 0 8px;">Every column is imported — the table lets you show/hide any of them. These picks just power the <strong>By team</strong> view and the Challonge copy buttons.</p>
      <div class="eo-map-grid">
        ${fields.map(([k, label]) => `
          <label class="eo-map-field">
            <span>${label}</span>
            <select class="input-select" id="eo-map-${k}">${opts(k === 'team' ? teamGuess : guessCol(headers, k))}</select>
          </label>`).join('')}
      </div>
      <div class="eo-map-summary" id="eo-map-summary"></div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="btn btn-primary btn-sm" id="eo-map-import">Import ${rows.length} rows</button>
        <button class="btn btn-ghost btn-sm" id="eo-map-cancel">Cancel</button>
      </div>`;
    const readIdx = () => { const idx = {}; fields.forEach(([k]) => { idx[k] = Number(el('eo-map-' + k)?.value); }); return idx; };
    const summary = () => {
      const idx = readIdx();
      const derived = rows.map((r) => deriveRow(r, idx));
      const teamsN = new Set(derived.map((d) => d.team.toLowerCase()).filter(Boolean)).size;
      const freeN = derived.filter((d) => !d.team && d.player).length;
      const sm = el('eo-map-summary');
      if (!sm) return;
      if (idx.team < 0 && idx.team2 < 0) {
        sm.innerHTML = '<span class="eo-miss">No team columns picked — the By-team view will show everyone as Free Agents (the table works regardless).</span>';
      } else {
        sm.innerHTML = `<span class="eo-ok">By-team view: ${teamsN} teams · ${rows.length} players${freeN ? ` · ${freeN} free agents` : ''}.</span>`;
      }
    };
    fields.forEach(([k]) => el('eo-map-' + k)?.addEventListener('change', summary));
    summary();
    el('eo-map-cancel')?.addEventListener('click', () => { _eoCsv = null; box.style.display = 'none'; box.innerHTML = ''; });
    el('eo-map-import')?.addEventListener('click', () => {
      const idx = readIdx();
      const payload = {
        headers,
        rows: rows.map((r) => headers.map((_, i) => (r[i] || '').toString())),
        roleMap: idx,
        eventSlug: (currentState?.startgg?.eventSlug || '')
      };
      // Local mirror FIRST — the dashboard works even if the app server predates this feature.
      try { localStorage.setItem(LS_DATA, JSON.stringify(payload)); } catch (_) {}
      send('set_event_ops', payload);
      _eoCsv = null; box.style.display = 'none'; box.innerHTML = '';
      _eoVisible = null; _eoSort = { col: -1, dir: 1 };
      showToast('Imported ' + payload.rows.length + ' rows · ' + headers.length + ' columns.', '#22c55e');
      eoRenderDash();
    });
  }

  el('eo-clear')?.addEventListener('click', () => {
    if (!confirm('Clear the imported spreadsheet? (The CSV file itself is untouched.)')) return;
    try { localStorage.removeItem(LS_DATA); } catch (_) {}
    send('set_event_ops', { headers: [], rows: [], roleMap: {} });
    eoRenderDash();
  });

  // ── Column visibility (persisted per header signature) ─────────────────────
  // Virtual table model: derived columns pinned before the raw CSV columns.
  // [Seed, Team, Challonge] are computed from the role mapping + pulled seeds —
  // clean values with short headers, ahead of whatever raw columns are shown.
  const VIRTUAL = 3;
  function buildModel(data) {
    const idx = data.roleMap || {};
    const seeds = seedByName();
    const headers = ['Seed', 'Team', 'Challonge', ...data.headers];
    const rows = data.rows.map((r) => {
      const d = deriveRow(r, idx);
      const seed = d.team ? seeds.get(d.team.toLowerCase()) : undefined;
      return [seed != null ? String(seed) : '', d.team, d.challonge, ...r];
    });
    return { headers, rows, hasSeeds: (data.seeds || []).length > 0 };
  }
  // Raw start.gg headers can be monsters ("[$100] Nameless Weekly ... Completed Team") —
  // show a readable tail, keep the full name in the tooltip.
  function shortHeader(h) {
    let x = String(h || '').replace(/^\[[^\]]*\]\s*/, '');
    const m = x.match(/(completed team|incomplete teams?|member flags)$/i);
    if (m) x = m[1];
    if (x.length > 30) x = '…' + x.slice(-28);
    return x;
  }

  function colSig(headers) { return headers.join('').slice(0, 400); }
  function loadVisible(headers, roleMap) {
    if (_eoVisible) return _eoVisible;
    try {
      const store = JSON.parse(localStorage.getItem(LS_COLS) || '{}');
      const saved = store[colSig(headers)];
      if (Array.isArray(saved)) { _eoVisible = new Set(saved.filter((i) => i >= 0 && i < headers.length)); return _eoVisible; }
    } catch (_) {}
    // Default: the derived columns + the useful raw ones (player/email/flags).
    // The raw team/challonge columns stay hidden — their DERIVED versions are cleaner.
    const def = [0, 1, 2];
    ['player', 'email', 'flags'].forEach((k) => {
      const i = Number(roleMap[k]);
      if (Number.isInteger(i) && i >= 0) def.push(i + VIRTUAL);
    });
    if (def.length === 3) headers.slice(VIRTUAL).forEach((_, i) => { if (def.length < 9) def.push(i + VIRTUAL); });
    _eoVisible = new Set(def);
    return _eoVisible;
  }
  function saveVisible(headers) {
    try {
      const store = JSON.parse(localStorage.getItem(LS_COLS) || '{}');
      store[colSig(headers)] = [..._eoVisible];
      localStorage.setItem(LS_COLS, JSON.stringify(store));
    } catch (_) {}
  }

  // ── Dashboard ───────────────────────────────────────────────────────────────
  const FREE_AGENTS = 'Free Agents';
  function groupTeams(data) {
    const idx = data.roleMap || {};
    const m = new Map();
    data.rows.forEach((r) => {
      const d = deriveRow(r, idx);
      if (!d.team && !d.player) return;
      const key = d.team || FREE_AGENTS;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(d);
    });
    const rank = (p) => (/captain/i.test(p.flags || '') ? 0 : /alternate|sub/i.test(p.flags || '') ? 2 : 1);
    return [...m.entries()].map(([team, players]) => ({ team, players: players.slice().sort((a, b) => rank(a) - rank(b)) }));
  }
  function seedByName() {
    const m = new Map();
    (eoData().seeds || []).forEach((s) => m.set((s.name || '').toLowerCase(), s.seed));
    return m;
  }

  function eoRenderDash() {
    const host = el('eo-dash'); if (!host) return;
    const data = eoData();
    const clearBtn = el('eo-clear'); if (clearBtn) clearBtn.style.display = data.rows.length ? '' : 'none';
    if (!data.rows.length) {
      host.innerHTML = '<div class="eo-empty">No spreadsheet imported yet — export the attendee CSV from start.gg (or any CSV) and click <strong>Import CSV</strong>.</div>';
      return;
    }
    const localNote = data.local
      ? '<div class="eo-empty" style="border-color:rgba(245,158,11,.5); color:#fbbf24; margin-bottom:10px;">Showing this browser\'s local copy — the app server hasn\'t stored it (relaunch the app, then re-import to sync it).</div>'
      : '';
    const viewBtns = `
      <div class="eo-controls" style="margin-top:0;">
        <div class="eo-chips" style="margin:0;">
          <button class="eo-chipbtn${_eoView === 'table' ? ' active' : ''}" id="eo-view-table">Table</button>
          <button class="eo-chipbtn${_eoView === 'team' ? ' active' : ''}" id="eo-view-team">By team</button>
        </div>
        <input type="text" id="eo-search" class="input-text" placeholder="Search everything…" value="${eoEsc(_eoSearch)}">
        <span class="eo-team-n">${data.rows.length} rows · ${data.headers.length} columns</span>
      </div>`;
    host.innerHTML = localNote + viewBtns + `<div id="eo-body"></div>`;
    el('eo-view-table')?.addEventListener('click', () => { _eoView = 'table'; eoRenderDash(); });
    el('eo-view-team')?.addEventListener('click', () => { _eoView = 'team'; eoRenderDash(); });
    const search = el('eo-search');
    search?.addEventListener('input', () => { _eoSearch = search.value; eoRenderBody(); });
    eoRenderBody();
    if (_eoSearch && search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  function eoRenderBody() {
    const body = el('eo-body'); if (!body) return;
    const data = eoData();
    if (_eoView === 'team') renderTeamView(body, data);
    else renderTableView(body, data);
  }

  // ── TABLE view: every column, pick/sort/filter/copy ─────────────────────────
  function renderTableView(body, data) {
    const model = buildModel(data);
    const { headers, rows } = model;
    // First render after seeds are pulled: default to seed order (the Challonge entry order).
    if (_eoSort.col === -1 && model.hasSeeds) _eoSort = { col: 0, dir: 1 };
    const visible = loadVisible(headers, data.roleMap || {});
    const cols = headers.map((h, i) => ({ h, i })).filter((c) => visible.has(c.i));

    const q = _eoSearch.trim();
    let view = rows.map((r, ri) => ({ r, ri }));
    // Every visible cell is one field, so a two-word query can straddle two columns ("smith
    // gmail" finds the row by name AND email) instead of needing both words in a single cell.
    if (q) view = NESearch.filter(view, q, (x) => cols.map((c) => (x.r[c.i] == null ? '' : String(x.r[c.i]))));
    if (_eoSort.col >= 0) {
      const ci = _eoSort.col, dir = _eoSort.dir;
      view.sort((a, b) => {
        const av = (a.r[ci] || '').toString(), bv = (b.r[ci] || '').toString();
        const an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn) && /^-?[\d.,]+$/.test(av.trim()) && /^-?[\d.,]+$/.test(bv.trim())) return (an - bn) * dir;
        if (!av && bv) return 1;      // empties always sink
        if (av && !bv) return -1;
        return av.localeCompare(bv, undefined, { sensitivity: 'base', numeric: true }) * dir;
      });
    }

    const picker = `
      <details class="eo-colpick">
        <summary>Columns (${cols.length}/${headers.length})</summary>
        <div class="eo-colpick-list">
          ${headers.map((h, i) => `
            <label><input type="checkbox" data-eo-col="${i}"${visible.has(i) ? ' checked' : ''}> ${eoEsc(h) || '(column ' + (i + 1) + ')'}</label>`).join('')}
          <div style="display:flex; gap:6px; margin-top:6px;">
            <button class="btn btn-ghost btn-sm" id="eo-cols-all">All</button>
            <button class="btn btn-ghost btn-sm" id="eo-cols-none">None</button>
          </div>
        </div>
      </details>`;
    const controls = `
      <div class="eo-controls" style="margin-top:0;">
        ${picker}
        <button class="btn btn-secondary btn-sm" id="eo-copy-tsv" title="Visible columns and filtered rows, tab-separated — pastes into Challonge notes, Sheets or Excel">Copy table</button>
        ${model.hasSeeds ? '' : `<button class="btn btn-ghost btn-sm" id="eo-pull-seeds-inline" title="Seeding is not in the CSV — it comes from the start.gg API and fills the Seed column">Fill Seed column from start.gg</button>`}
        <span class="eo-team-n">${view.length}${q ? ' matching' : ''} rows</span>
      </div>`;

    const thead = '<tr>' + cols.map((c) => {
      const active = _eoSort.col === c.i;
      return `<th data-eo-sort="${c.i}" title="${eoEsc(c.h)} — click to sort">
        <span class="eo-th-label">${eoEsc(shortHeader(c.h)) || '(col ' + (c.i + 1) + ')'}</span>
        <span class="eo-th-dir">${active ? (_eoSort.dir > 0 ? '▲' : '▼') : ''}</span>
        <button class="eo-th-copy" data-eo-colcopy="${c.i}" title="Copy this column (filtered rows, one per line)">⧉</button>
      </th>`;
    }).join('') + '</tr>';
    const tbody = view.map((x) =>
      '<tr>' + cols.map((c) => `<td>${eoEsc(x.r[c.i])}</td>`).join('') + '</tr>').join('');

    body.innerHTML = controls + `
      <div class="eo-tablewrap">
        <table class="eo-grid"><thead>${thead}</thead><tbody>${tbody || ''}</tbody></table>
        ${view.length ? '' : '<div class="eo-empty" style="border:none;">Nothing matches the search.</div>'}
      </div>`;

    body.querySelectorAll('[data-eo-col]').forEach((cb) => cb.addEventListener('change', () => {
      const i = Number(cb.dataset.eoCol);
      if (cb.checked) _eoVisible.add(i); else _eoVisible.delete(i);
      saveVisible(headers); eoRenderBody();
    }));
    el('eo-cols-all')?.addEventListener('click', () => { _eoVisible = new Set(headers.map((_, i) => i)); saveVisible(headers); eoRenderBody(); });
    el('eo-cols-none')?.addEventListener('click', () => { _eoVisible = new Set(); saveVisible(headers); eoRenderBody(); });
    body.querySelectorAll('[data-eo-sort]').forEach((th) => th.addEventListener('click', (ev) => {
      if (ev.target.closest('.eo-th-copy')) return;
      const i = Number(th.dataset.eoSort);
      _eoSort = { col: i, dir: _eoSort.col === i ? -_eoSort.dir : 1 };
      eoRenderBody();
    }));
    body.querySelectorAll('[data-eo-colcopy]').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = Number(b.dataset.eoColcopy);
      const vals = view.map((x) => (x.r[i] || '').toString()).filter(Boolean);
      if (!vals.length) { showToast('Column is empty (in the filtered rows).', '#fbbf24'); return; }
      eoCopy(vals.join('\n'), vals.length + ' × ' + (headers[i] || 'column'));
    }));
    el('eo-pull-seeds-inline')?.addEventListener('click', () => {
      const d = eoData();
      const slug = d.eventSlug || currentState?.bracket?.eventSlug || currentState?.startgg?.eventSlug || '';
      if (!slug) { showToast('No start.gg event linked — paste the event slug in the seeding section below.', '#fbbf24'); return; }
      showToast('Pulling seeds from start.gg…', '#22c55e');
      send('eventops_fetch_seeds', { slug });
    });
    el('eo-copy-tsv')?.addEventListener('click', () => {
      const tsv = [cols.map((c) => c.h).join('\t')]
        .concat(view.map((x) => cols.map((c) => (x.r[c.i] || '').toString().replace(/[\t\r\n]+/g, ' ')).join('\t')))
        .join('\n');
      eoCopy(tsv, 'table (' + view.length + ' rows × ' + cols.length + ' cols)');
    });
  }

  // ── BY-TEAM view (role-mapped grouping + Challonge copy helpers) ────────────
  function renderTeamView(body, data) {
    const seeds = seedByName();
    let teams = groupTeams(data);
    teams.sort((a, b) => a.team.localeCompare(b.team, undefined, { sensitivity: 'base', numeric: true }));
    const q = _eoSearch.trim();
    // Player, email and Challonge handle are separate fields per player — joined into one string
    // they only matched when the query words happened to be in that same order.
    teams = NESearch.filter(teams, q, (t) => [{ text: t.team, weight: 2 }].concat(
      t.players.reduce((acc, p) => acc.concat([p.player, p.email, p.challonge]), [])
    ));
    // One-click copy for a single cell — omitted entirely when the field is blank.
    const eoFieldCopy = (val, label) => (val
      ? `<button class="eo-fcopy" type="button" data-val="${eoEsc(val)}" data-label="${eoEsc(label)}" title="Copy ${eoEsc(label)}" aria-label="Copy ${eoEsc(label)}">copy</button>`
      : '');
    const teamBlockText = (t) => {
      const seed = seeds.get(t.team.toLowerCase());
      return t.team.toUpperCase() + (seed != null ? ' — SEED ' + seed : '') + '\n'
        + t.players.map((p) => [p.player, p.email, p.challonge].map((v) => v || '-').join('\t')).join('\n');
    };
    const controls = `
      <div class="eo-controls" style="margin-top:0;">
        <button class="btn btn-secondary btn-sm" id="eo-copy-emails">Copy all emails</button>
        <button class="btn btn-secondary btn-sm" id="eo-copy-challonge">Copy all Challonge</button>
        <button class="btn btn-secondary btn-sm" id="eo-copy-roster" title="Every team block as text — tab-separated player / email / challonge lines">Copy full roster</button>
      </div>`;
    const blocks = teams.map((t) => {
      const seed = seeds.get(t.team.toLowerCase());
      const sel = _eoTeam && _eoTeam.toLowerCase() === t.team.toLowerCase();
      return `
        <div class="eo-block${sel ? ' sel' : ''}">
          <div class="eo-block-head" data-eo-team="${eoEsc(t.team)}">
            <span class="eo-block-title">${eoEsc(t.team)}</span>
            <span class="eo-block-seed">${seed != null ? '— SEED ' + seed : ''}</span>
            <span class="eo-team-n">${t.players.length} player${t.players.length === 1 ? '' : 's'}</span>
            <button class="btn btn-ghost btn-sm eo-copy-team" data-team="${eoEsc(t.team)}" data-what="emails">emails</button>
            <button class="btn btn-ghost btn-sm eo-copy-team" data-team="${eoEsc(t.team)}" data-what="challonge">challonge</button>
            <button class="btn btn-ghost btn-sm eo-copy-team" data-team="${eoEsc(t.team)}" data-what="block">copy team</button>
          </div>
          ${t.players.map((p, i) => `
            <div class="eo-block-player">
              <span class="eo-p-idx">Player ${i + 1}</span>
              <span class="eo-p-cell">
                <span class="eo-p-name">${eoEsc(p.player) || '<span class="eo-dim">—</span>'}${/captain/i.test(p.flags || '') ? ' <span class="eo-flag cap">C</span>' : ''}${/alternate|sub/i.test(p.flags || '') ? ' <span class="eo-flag">ALT</span>' : ''}</span>
                ${eoFieldCopy(p.player, 'name')}
              </span>
              <span class="eo-p-cell">
                <span class="eo-p-mail">${p.email ? eoEsc(p.email) : '<span class="eo-miss">no email</span>'}</span>
                ${eoFieldCopy(p.email, 'email')}
              </span>
              <span class="eo-p-cell">
                <span class="eo-p-ch">${p.challonge ? eoEsc(p.challonge) : '<span class="eo-miss">no challonge</span>'}</span>
                ${eoFieldCopy(p.challonge, 'Challonge username')}
              </span>
            </div>`).join('')}
        </div>`;
    }).join('');
    body.innerHTML = controls + (teams.length
      ? `<div class="eo-blocks">${blocks}</div>`
      : '<div class="eo-empty">Nothing matches — or no team columns were mapped on import (the Table view always works).</div>');

    const allRows = groupTeams(data);
    const flat = allRows.flatMap((t) => t.players);
    el('eo-copy-emails')?.addEventListener('click', () => {
      const list = flat.map((p) => p.email).filter(Boolean);
      eoCopy(list.join('\n'), list.length + ' emails');
    });
    el('eo-copy-challonge')?.addEventListener('click', () => {
      const list = flat.map((p) => p.challonge).filter(Boolean);
      eoCopy(list.join('\n'), list.length + ' Challonge usernames');
    });
    el('eo-copy-roster')?.addEventListener('click', () => eoCopy(allRows.map(teamBlockText).join('\n\n'), 'full roster (' + allRows.length + ' teams)'));
    body.querySelectorAll('.eo-copy-team').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const t = allRows.find((x) => x.team === b.dataset.team);
      if (!t) return;
      const what = b.dataset.what;
      if (what === 'block') { eoCopy(teamBlockText(t), t.team + ' (full block)'); return; }
      const key = what === 'challonge' ? 'challonge' : 'email';
      const list = t.players.map((p) => p[key]).filter(Boolean);
      if (!list.length) { showToast('No ' + (key === 'email' ? 'emails' : 'Challonge usernames') + ' on this team.', '#fbbf24'); return; }
      eoCopy(list.join('\n'), list.length + ' ' + (key === 'email' ? 'emails' : 'Challonge usernames') + ' (' + t.team + ')');
    }));
    body.querySelectorAll('.eo-fcopy').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      eoCopy(b.dataset.val, b.dataset.label);
    }));
    body.querySelectorAll('.eo-block-head').forEach((c) => c.addEventListener('click', (ev) => {
      if (ev.target.closest('.eo-copy-team')) return;
      eoSelectTeam(c.dataset.eoTeam === _eoTeam ? '' : c.dataset.eoTeam);
    }));
  }

  // ── Seeding table ───────────────────────────────────────────────────────────
  el('eo-seed-pull')?.addEventListener('click', () => {
    const st = el('eo-seed-status');
    if (st) { st.textContent = 'Pulling seeds from start.gg…'; st.style.color = 'var(--muted)'; }
    send('eventops_fetch_seeds', { slug: (el('eo-seed-slug')?.value || '').trim() });
    // Stale-server guard: no reply within 6s = the running app predates this feature.
    clearTimeout(eoSeedGuard);
    eoSeedGuard = setTimeout(() => {
      if (st && st.textContent.startsWith('Pulling')) {
        st.textContent = 'No reply from the app server — relaunch the app (Event Ops is new), then try again.';
        st.style.color = '#f56565';
      }
    }, 6000);
  });
  let eoSeedGuard = null;
  window.eventOpsResult = function (d) {
    clearTimeout(eoSeedGuard);
    const st = el('eo-seed-status');
    if (st) { st.textContent = d.message || ''; st.style.color = d.ok ? '#9ae6b4' : '#f56565'; }
    if (!d.ok) showToast(d.message || 'Seed fetch failed.', '#c53030', 6000);
  };

  function eoRenderSeeds() {
    const host = el('eo-seeds'); if (!host) return;
    const data = eoData();
    const slugInp = el('eo-seed-slug');
    if (slugInp && !slugInp.value && document.activeElement !== slugInp) {
      slugInp.value = data.eventSlug || currentState?.bracket?.eventSlug || currentState?.startgg?.eventSlug || '';
    }
    const seeds = data.seeds || [];
    if (!seeds.length) { host.innerHTML = '<div class="eo-empty">No seeds pulled yet — optional; used for the SEED badges in the By-team view and to mirror seeding on Challonge.</div>'; return; }
    const rosterTeams = new Set(groupTeams(data).map((t) => t.team.toLowerCase()));
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
    const out = [];
    (container.winners || []).forEach((r) => out.push({ band: 'Winners', ...r }));
    (container.losers || []).forEach((r) => out.push({ band: 'Losers', ...r }));
    (container.finals || []).forEach((r) => out.push({ band: 'Grand Final', ...r }));
    (container.schedule || []).forEach((r) => out.push({ band: '', ...r }));
    return out;
  }

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
    // The CSV never carries seeding — it comes from the start.gg API. Pull it
    // automatically the first time the tab opens with a linked event + imported rows.
    if (!_eoSeedAuto) {
      const d = eoData();
      const slug = d.eventSlug || currentState?.bracket?.eventSlug || currentState?.startgg?.eventSlug || '';
      if (!(d.seeds || []).length && slug && d.rows.length) { _eoSeedAuto = true; send('eventops_fetch_seeds', { slug }); }
    }
    eoRenderDash(); eoRenderSeeds(); eoRenderBracket();
  };
  window.eventOpsOnState = function () {
    const panel = el('stats-panel-eventops');
    if (!panel || panel.style.display === 'none') return;
    const a = document.activeElement;
    if (a && (a.id === 'eo-search' || a.id === 'eo-seed-slug')) return;
    window.eventOpsRender();
  };
})();
