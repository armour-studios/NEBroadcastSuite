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
  const GUESS = {
    team:      [/^entrant/i, /team/i, /squad/i],
    player:    [/gamer.?tag/i, /^tag$/i, /player/i, /^name$/i, /^attendee/i],
    email:     [/e-?mail/i],
    challonge: [/challonge/i]
  };
  function guessCol(headers, key) {
    for (const re of GUESS[key]) {
      const i = headers.findIndex((h) => re.test(h));
      if (i !== -1) return i;
    }
    return -1;
  }

  function eoRenderMapBox() {
    const box = el('eo-map-box'); if (!box || !_eoCsv) return;
    const { headers, rows } = _eoCsv;
    const opts = (sel) => ['<option value="-1">— none —</option>']
      .concat(headers.map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${eoEsc(h) || '(column ' + (i + 1) + ')'}</option>`)).join('');
    const fields = [
      ['team', 'Team name'], ['player', 'Player / gamertag'], ['email', 'Email'], ['challonge', 'Challonge username']
    ];
    box.style.display = '';
    box.innerHTML = `
      <div class="eo-map-grid">
        ${fields.map(([k, label]) => `
          <label class="eo-map-field">
            <span>${label}</span>
            <select class="input-select" id="eo-map-${k}">${opts(guessCol(headers, k))}</select>
          </label>`).join('')}
      </div>
      <div class="eo-map-preview" id="eo-map-preview"></div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="btn btn-primary btn-sm" id="eo-map-import">Import ${rows.length} rows</button>
        <button class="btn btn-ghost btn-sm" id="eo-map-cancel">Cancel</button>
      </div>`;
    const preview = () => {
      const idx = {}; fields.forEach(([k]) => { idx[k] = Number(el('eo-map-' + k)?.value); });
      const head = '<tr>' + fields.map(([, l]) => `<th>${l}</th>`).join('') + '</tr>';
      const body = rows.slice(0, 4).map((r) =>
        '<tr>' + fields.map(([k]) => `<td>${idx[k] >= 0 ? eoEsc(r[idx[k]]) : '<span class="eo-dim">—</span>'}</td>`).join('') + '</tr>').join('');
      const pv = el('eo-map-preview'); if (pv) pv.innerHTML = `<table class="eo-table">${head}${body}</table>`;
    };
    fields.forEach(([k]) => el('eo-map-' + k)?.addEventListener('change', preview));
    preview();
    el('eo-map-cancel')?.addEventListener('click', () => { _eoCsv = null; box.style.display = 'none'; box.innerHTML = ''; });
    el('eo-map-import')?.addEventListener('click', () => {
      const idx = {}; fields.forEach(([k]) => { idx[k] = Number(el('eo-map-' + k)?.value); });
      if (idx.team < 0 && idx.player < 0) { showToast('Map at least the team or player column.', '#fbbf24'); return; }
      const out = rows.map((r) => ({
        team: idx.team >= 0 ? (r[idx.team] || '').toString().trim() : '',
        player: idx.player >= 0 ? (r[idx.player] || '').toString().trim() : '',
        email: idx.email >= 0 ? (r[idx.email] || '').toString().trim() : '',
        challonge: idx.challonge >= 0 ? (r[idx.challonge] || '').toString().trim() : ''
      })).filter((r) => r.team || r.player);
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
  function groupTeams(rows) {
    const m = new Map();
    rows.forEach((r) => {
      const key = (r.team || '(No team)').trim() || '(No team)';
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    });
    return [...m.entries()].map(([team, players]) => ({ team, players }));
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
    // Seeded teams first in seed order, then the rest alphabetically.
    teams.sort((a, b) => {
      const sa = seeds.get(a.team.toLowerCase()), sb = seeds.get(b.team.toLowerCase());
      if (sa != null && sb != null) return sa - sb;
      if (sa != null) return -1;
      if (sb != null) return 1;
      return a.team.localeCompare(b.team);
    });
    const q = _eoSearch.trim().toLowerCase();
    if (q) {
      teams = teams.filter((t) =>
        t.team.toLowerCase().includes(q) ||
        t.players.some((p) => (p.player + ' ' + p.email + ' ' + p.challonge).toLowerCase().includes(q)));
    }
    const emails = rows.filter((r) => r.email);
    const challonges = rows.filter((r) => r.challonge);

    const chips = `
      <div class="eo-chips">
        <span class="eo-chip">${groupTeams(rows).length} teams</span>
        <span class="eo-chip">${rows.length} players</span>
        <span class="eo-chip${emails.length < rows.length ? ' warn' : ''}">${emails.length}/${rows.length} emails</span>
        <span class="eo-chip${challonges.length < rows.length ? ' warn' : ''}">${challonges.length}/${rows.length} challonge</span>
      </div>`;
    const controls = `
      <div class="eo-controls">
        <input type="text" id="eo-search" class="input-text" placeholder="Search team, player, email, challonge…" value="${eoEsc(_eoSearch)}">
        <button class="btn btn-secondary btn-sm" id="eo-copy-emails" title="Every email in the roster, one per line">Copy all emails</button>
        <button class="btn btn-secondary btn-sm" id="eo-copy-challonge" title="Every Challonge username, one per line">Copy all Challonge</button>
      </div>`;
    const cards = teams.map((t) => {
      const seed = seeds.get(t.team.toLowerCase());
      const tEmails = t.players.filter((p) => p.email).map((p) => p.email);
      const sel = _eoTeam && _eoTeam.toLowerCase() === t.team.toLowerCase();
      return `
        <div class="eo-team-card${sel ? ' sel' : ''}" data-eo-team="${eoEsc(t.team)}">
          <div class="eo-team-head">
            ${seed != null ? `<span class="eo-seed" title="start.gg seed">#${seed}</span>` : ''}
            <span class="eo-team-name">${eoEsc(t.team)}</span>
            <span class="eo-team-n">${t.players.length}</span>
            <button class="btn btn-ghost btn-sm eo-copy-team" data-team="${eoEsc(t.team)}" title="Copy this team's emails">emails</button>
          </div>
          <div class="eo-players">
            ${t.players.map((p) => `
              <div class="eo-player">
                <span class="eo-p-name">${eoEsc(p.player) || '<span class="eo-dim">—</span>'}</span>
                <span class="eo-p-mail">${p.email ? eoEsc(p.email) : '<span class="eo-miss">no email</span>'}</span>
                <span class="eo-p-ch">${p.challonge ? 'ch: ' + eoEsc(p.challonge) : '<span class="eo-miss">no challonge</span>'}</span>
              </div>`).join('')}
          </div>
        </div>`;
    }).join('');
    host.innerHTML = chips + controls + `<div class="eo-team-grid">${cards || '<div class="eo-empty">Nothing matches the search.</div>'}</div>`;

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
    host.querySelectorAll('.eo-team-card').forEach((c) => c.addEventListener('click', () => {
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
