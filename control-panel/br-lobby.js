/* ─── br-lobby.js — Match — Lobby (battle-royale games) ────────────────────────
   A BR broadcast has one lobby of N entrants racing a points table over M matches, not two
   teams with a score, so for the games the server lists in brMeta.lobbyGames this panel takes
   the place of the blue/orange team cards inside Match — Teams.

   Hard rule: every other game must be untouched. brLobbyApply() is the ONLY thing that ever
   shows #match-lobby or adds .lobby-mode, and it removes both the moment the active game isn't
   a lobby game (or is on a head-to-head Fortnite mode like Ballistic / Creative 1v1, where the
   normal two-team cards are genuinely the right instrument).

   Like the BR series panel, this writes RAW results to the server and lets computeBrStandings()
   re-derive everything — the panel never adds up points itself, so the board, the overlays and
   this table cannot disagree.

   Loads after app.js; brLobbyApply(data) is called from applyState(). */

(function () {
  'use strict';

  // Fields the producer is typing into must never be clobbered by an inbound state update.
  const isActive = (node) => node && node === document.activeElement;
  const setVal = (node, v) => { if (node && !isActive(node)) node.value = v; };

  let _rowSig = '';       // field-table signature (rebuild gate)
  let _metaSig = '';      // mode/format <select> option signature
  let _leagueSig = '';
  let _cmpRows = [];      // comparison builder rows, local until Apply
  let _wired = false;

  // ── state readers ─────────────────────────────────────────────────────────
  function brOf(data) { return (data && data.br) || {}; }
  function metaOf(data) { return (data && data.brMeta) || {}; }
  // Lobby mode = the active game is a lobby game AND the selected mode is a lobby-shaped one.
  // Fortnite Ballistic (5v5) and Creative 1v1 are Fortnite but are head-to-head, so they fall
  // back to the standard team cards rather than being forced into a field table of two.
  function inLobbyMode(data) {
    const meta = metaOf(data);
    const games = meta.lobbyGames || [];
    if (!games.includes(data && data.activeGame)) return false;
    const mode = meta.mode || {};
    return mode.kind !== 'versus';
  }
  function curMatch() { return Math.max(1, parseInt((el('mlb-match') || {}).value, 10) || 1); }
  function matchTotal() {
    const br = ((typeof currentState !== 'undefined' && currentState.br) || {});
    return Math.max(1, (br.format && br.format.matches) || 6);
  }
  // Set how many matches this cup runs. Bound to a league cup → the cup owns it (so the league
  // page's grid grows to match); standalone → the series' own format.
  function pushTotal(n) {
    const total = Math.max(1, Math.min(40, parseInt(n, 10) || 6));
    const br = ((typeof currentState !== 'undefined' && currentState.br) || {});
    if (br.leagueId && br.seriesId) send('br_series', { leagueId: br.leagueId, seriesId: br.seriesId, matches: total });
    else send('set_br', { format: { matches: total } });
  }

  // Result rows for one match, keyed by lower-cased entrant name (that's the key the raw
  // results use — a BR sheet only ever gives us a name).
  function resultsFor(data, match) {
    const out = new Map();
    for (const r of (brOf(data).results || [])) {
      if ((parseInt(r.match, 10) || 0) !== match) continue;
      out.set(String(r.team || '').trim().toLowerCase(), r);
    }
    return out;
  }
  function standingsFor(data) {
    const out = new Map();
    for (const s of (brOf(data).standings || [])) out.set(String(s.name || '').trim().toLowerCase(), s);
    return out;
  }

  // ── senders ───────────────────────────────────────────────────────────────
  function saveEntrant(patch) { send('br_lobby_entrant', patch); }
  function saveResult(name, patch) {
    if (!name) return;
    send('set_br_result', Object.assign({ match: curMatch(), team: name }, patch));
  }

  // ── option lists ──────────────────────────────────────────────────────────
  function syncSelectors(data) {
    const meta = metaOf(data), br = brOf(data);
    const modes = meta.modes || [], formats = meta.formats || [];
    const sig = JSON.stringify([modes.map((m) => [m.id, m.name]), formats.map((f) => [f.id, f.name])]);
    if (sig !== _metaSig) {
      _metaSig = sig;
      const mSel = el('mlb-mode');
      if (mSel) {
        mSel.innerHTML = modes.map((m) =>
          `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
      }
      const fSel = el('mlb-format');
      if (fSel) {
        fSel.innerHTML = formats.map((f) =>
          `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
      }
    }
    setVal(el('mlb-mode'), br.mode || '');
    setVal(el('mlb-format'), br.teamFormat || 'duo');

    // POI datalist — the drop cells and the add row both type against it.
    const pois = (meta.poi && meta.poi.pois) || [];
    const dl = el('mlb-poi-list');
    if (dl && dl.dataset.sig !== JSON.stringify(pois.map((p) => p.id))) {
      dl.dataset.sig = JSON.stringify(pois.map((p) => p.id));
      dl.innerHTML = pois.map((p) => `<option value="${esc(p.name)}">`).join('');
    }

    // League picker for the manual/offline roster path.
    const leagues = (data.leagues || []).filter((l) => l && l.id);
    const lsig = JSON.stringify(leagues.map((l) => [l.id, l.name]));
    const lSel = el('mlb-league');
    if (lSel && lsig !== _leagueSig) {
      _leagueSig = lsig;
      lSel.innerHTML = '<option value="">From league…</option>'
        + leagues.map((l) => `<option value="${esc(l.id)}">${esc(l.name || 'League')}</option>`).join('');
    }

    // Cup binding. Only battle-royale leagues can hold cups, so only those are offered —
    // grouped by league because a producer running two circuits needs to tell them apart.
    const brGames = metaOf(data).lobbyGames || [];
    const brLeagues = leagues.filter((l) => brGames.includes(l.game));
    const cupSig = JSON.stringify(brLeagues.map((l) => [l.id, l.name, (l.brSeries || []).map((s) => [s.id, s.name])]));
    const cSel = el('mlb-cup');
    if (cSel && cSel.dataset.sig !== cupSig) {
      cSel.dataset.sig = cupSig;
      const groups = brLeagues.filter((l) => (l.brSeries || []).length).map((l) =>
        `<optgroup label="${esc(l.name || 'League')}">`
        + (l.brSeries || []).map((s) => `<option value="${esc(l.id)}|${esc(s.id)}">${esc(s.name)}</option>`).join('')
        + '</optgroup>').join('');
      cSel.innerHTML = '<option value="">Standalone (not in a league)</option>' + groups
        + (groups ? '' : '<option value="" disabled>No BR league cups yet — add one on the league page</option>');
    }
    if (cSel && !isActive(cSel)) {
      cSel.value = (br.leagueId && br.seriesId) ? (br.leagueId + '|' + br.seriesId) : '';
    }
  }

  // ── the field table ───────────────────────────────────────────────────────
  function renderRows(data) {
    const br = brOf(data);
    const lobby = Array.isArray(br.lobby) ? br.lobby : [];
    const match = curMatch();
    const res = resultsFor(data, match);
    const st = standingsFor(data);
    const focus = (br.live && br.live.focus) || '';
    const pois = ((metaOf(data).poi || {}).pois) || [];

    // Order the field by series standing so the top of the table is the top of the board;
    // entrants with no results yet keep their roster order underneath.
    const rankOf = (e) => {
      const s = st.get(String(e.name || '').trim().toLowerCase());
      return s ? s.rank : 9999;
    };
    const ordered = lobby.map((e, i) => ({ e, i })).sort((a, b) => {
      const ra = rankOf(a.e), rb = rankOf(b.e);
      return ra !== rb ? ra - rb : a.i - b.i;
    }).map((x) => x.e);

    const project = !!(el('mlb-project') || {}).checked;

    const sig = JSON.stringify([
      ordered.map((e) => [e.id, e.name, e.drop, (e.players || []).map((p) => p.name)]),
      [...res.entries()].map(([k, r]) => [k, r.placement, r.elims]),
      [...st.entries()].map(([k, s]) => [k, s.rank, s.pts, s.wins, (s.matches || {})[match]]),
      match, focus, project, pois.map((p) => p.id)
    ]);
    if (sig === _rowSig) return;
    _rowSig = sig;

    const host = el('mlb-rows');
    const empty = el('mlb-empty');
    if (!host) return;
    if (empty) empty.style.display = ordered.length ? 'none' : '';

    host.innerHTML = ordered.map((e) => {
      const key = String(e.name || '').trim().toLowerCase();
      const r = res.get(key) || {};
      const s = st.get(key) || {};
      const players = (e.players || []).map((p) => p.name).filter(Boolean).join(', ');
      const won = (parseInt(r.placement, 10) || 0) === 1;
      const cls = ['mlb-row', focus === e.id ? 'focused' : '', won ? 'won' : ''].filter(Boolean).join(' ');
      // The board total already includes whatever has been entered for THIS match, so PTS shows
      // where they stood going in and LIVE shows where they'd finish if it ended now. That pair
      // ("they were on 80, this puts them on 113") is the call a caster actually needs.
      const thisMatch = ((s.matches || {})[match] || {}).pts || 0;
      const before = (s.pts || 0) - thisMatch;
      return `<div class="${cls}" data-eid="${esc(e.id)}" data-ename="${esc(e.name)}">
        <div class="mlb-c-rank">${s.rank || '–'}</div>
        <div class="mlb-c-name"><input type="text" class="input-text" data-mlb="name" value="${esc(e.name)}"></div>
        <div class="mlb-c-players"><input type="text" class="input-text" data-mlb="players" value="${esc(players)}" placeholder="Players"></div>
        <div class="mlb-c-drop"><input type="text" class="input-text" data-mlb="drop" list="mlb-poi-list" value="${esc(e.drop)}" placeholder="Drop"></div>
        <div class="mlb-c-num"><input type="number" class="input-text" data-mlb="placement" min="0" max="200" value="${r.placement || ''}"></div>
        <div class="mlb-c-num"><input type="number" class="input-text" data-mlb="elims" min="0" max="200" value="${r.elims != null ? r.elims : ''}"></div>
        <div class="mlb-c-num"><span class="mlb-val ${s.wins ? '' : 'dim'}">${s.wins || 0}</span></div>
        <div class="mlb-c-num mlb-c-pts"><span class="mlb-val">${before}</span></div>
        <div class="mlb-c-num mlb-c-live">${project
          ? `<span class="mlb-live-val ${thisMatch ? '' : 'dim'}">${s.pts || 0}</span>`
          : '<span class="mlb-val dim">—</span>'}</div>
        <div class="mlb-c-act">
          <button type="button" class="mlb-star ${focus === e.id ? 'on' : ''}" data-mlb="focus" title="Mark as the entrant being spectated">${focus === e.id ? '★' : '☆'}</button>
          <button type="button" class="mlb-del" data-mlb="remove" title="Remove from the lobby">✕</button>
        </div>
      </div>`;
    }).join('');

    // Player datalist for the comparison builder.
    const names = [];
    lobby.forEach((e) => (e.players || []).forEach((p) => { if (p.name) names.push(p.name); }));
    const pdl = el('mlb-player-list');
    if (pdl && pdl.dataset.sig !== names.join('|')) {
      pdl.dataset.sig = names.join('|');
      pdl.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
    }
  }

  // ── entry modes ───────────────────────────────────────────────────────────
  // Between games a producer has minutes to enter 25-50 rows. Typing a placement into every row
  // is the slow way; these are the two shapes that aren't.
  let _entryMode = 'grid';
  let _finishSig = '', _elimsSig = '';

  function setEntryMode(mode) {
    _entryMode = ['grid', 'finish', 'elims'].includes(mode) ? mode : 'grid';
    document.querySelectorAll('#mlb-entry-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.entry === _entryMode));
    const show = (id, on) => { const n = el(id); if (n) n.style.display = on ? '' : 'none'; };
    show('mlb-mode-grid', _entryMode === 'grid');
    show('mlb-mode-finish', _entryMode === 'finish');
    show('mlb-mode-elims', _entryMode === 'elims');
    _rowSig = _finishSig = _elimsSig = '';
    if (typeof currentState !== 'undefined') brLobbyApply(currentState);
  }

  // Finish order: tap entrants in the order they placed. The next placement is whatever the
  // lowest unused number is, so an accidental double-tap or an Undo can't strand a gap.
  function nextPlacement(res) {
    const used = new Set([...res.values()].map((r) => parseInt(r.placement, 10) || 0).filter(Boolean));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }
  function renderFinish(data) {
    const host = el('mlb-finish-grid');
    if (!host) return;
    const lobby = (brOf(data).lobby) || [];
    const match = curMatch();
    const res = resultsFor(data, match);
    const sig = JSON.stringify([lobby.map((e) => [e.id, e.name]), [...res.entries()].map(([k, r]) => [k, r.placement]), match]);
    if (sig !== _finishSig) {
      _finishSig = sig;
      host.innerHTML = lobby.map((e) => {
        const r = res.get(String(e.name || '').trim().toLowerCase()) || {};
        const pl = parseInt(r.placement, 10) || 0;
        const cls = ['mlb-finish-btn', pl ? 'placed' : '', pl === 1 ? 'won' : ''].filter(Boolean).join(' ');
        return `<button type="button" class="${cls}" data-eid="${esc(e.id)}" data-ename="${esc(e.name)}">
          <span class="fb-place">${pl || '·'}</span><span class="fb-name">${esc(e.name)}</span></button>`;
      }).join('');
    }
    const placed = [...res.values()].filter((r) => (parseInt(r.placement, 10) || 0) > 0).length;
    const nx = el('mlb-finish-next'); if (nx) nx.textContent = String(nextPlacement(res));
    const dn = el('mlb-finish-done'); if (dn) dn.textContent = `${placed} of ${lobby.length} placed`;
  }

  function renderElims(data) {
    const host = el('mlb-elims-grid');
    if (!host) return;
    const lobby = (brOf(data).lobby) || [];
    const match = curMatch();
    const res = resultsFor(data, match);
    const sig = JSON.stringify([lobby.map((e) => [e.id, e.name]), [...res.entries()].map(([k, r]) => [k, r.elims]), match]);
    if (sig === _elimsSig) return;
    _elimsSig = sig;
    host.innerHTML = lobby.map((e) => {
      const r = res.get(String(e.name || '').trim().toLowerCase()) || {};
      return `<div class="mlb-elims-row" data-ename="${esc(e.name)}">
        <span title="${esc(e.name)}">${esc(e.name)}</span>
        <input type="number" class="input-text" min="0" max="200" value="${r.elims != null ? r.elims : ''}" placeholder="0">
      </div>`;
    }).join('');
  }

  function wireEntryModes() {
    if (wireEntryModes._done) return;
    wireEntryModes._done = true;

    document.querySelectorAll('#mlb-entry-seg .seg-btn').forEach((b) => {
      b.addEventListener('click', () => setEntryMode(b.dataset.entry));
    });
    el('mlb-project')?.addEventListener('change', () => { _rowSig = ''; if (typeof currentState !== 'undefined') renderRows(currentState); });
    el('mlb-roster-toggle')?.addEventListener('click', () => {
      const row = el('mlb-roster-row');
      if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
    });
    el('mlb-clear-match')?.addEventListener('click', async () => {
      const m = curMatch();
      if (!(await appConfirm(`Clear every result for match ${m}? The rest of the cup is untouched.`, 'Clear match'))) return;
      send('clear_br_results', { scope: 'match', match: m });
    });

    // One tap = one placement. Tapping an already-placed entrant clears it, so a misfire is a
    // second tap rather than a hunt through the grid.
    el('mlb-finish-grid')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-eid]');
      if (!btn) return;
      const data = (typeof currentState !== 'undefined' && currentState) || {};
      const match = curMatch();
      const res = resultsFor(data, match);
      const key = btn.dataset.ename.trim().toLowerCase();
      const cur = res.get(key) || {};
      const isPlaced = (parseInt(cur.placement, 10) || 0) > 0;
      saveResult(btn.dataset.ename, {
        placement: isPlaced ? 0 : nextPlacement(res),
        elims: parseInt(cur.elims, 10) || 0
      });
    });
    el('mlb-finish-undo')?.addEventListener('click', () => {
      const data = (typeof currentState !== 'undefined' && currentState) || {};
      const res = resultsFor(data, curMatch());
      // Undo the HIGHEST placement handed out — that's the last tap.
      let worst = null;
      for (const r of res.values()) {
        const pl = parseInt(r.placement, 10) || 0;
        if (pl && (!worst || pl > worst.pl)) worst = { pl, team: r.team };
      }
      if (!worst) { showToast('Nothing to undo.', '#f59e0b'); return; }
      const cur = res.get(worst.team.trim().toLowerCase()) || {};
      saveResult(worst.team, { placement: 0, elims: parseInt(cur.elims, 10) || 0 });
    });
    el('mlb-finish-reset')?.addEventListener('click', async () => {
      if (!(await appConfirm(`Clear the finishing order for match ${curMatch()}? Elims are cleared too.`, 'Restart order'))) return;
      send('clear_br_results', { scope: 'match', match: curMatch() });
    });

    el('mlb-elims-grid')?.addEventListener('change', (e) => {
      const row = e.target.closest('[data-ename]');
      if (!row || e.target.tagName !== 'INPUT') return;
      const data = (typeof currentState !== 'undefined' && currentState) || {};
      const cur = resultsFor(data, curMatch()).get(row.dataset.ename.trim().toLowerCase()) || {};
      saveResult(row.dataset.ename, {
        elims: parseInt(e.target.value, 10) || 0,
        placement: parseInt(cur.placement, 10) || 0
      });
    });
    el('mlb-elims-grid')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      e.target.blur();
      const all = [...el('mlb-elims-grid').querySelectorAll('input')];
      const next = all[all.indexOf(e.target) + 1];
      if (next) { next.focus(); next.select(); }
    });
  }

  // ── overlay pack ──────────────────────────────────────────────────────────
  // "How do I get the Fortnite overlays into OBS" in one place: every URL with a copy button,
  // plus a one-click build of the whole scene set through OBS WebSocket.
  const PACK = [
    ['gfx',     'Graphics layer',  '/gfx.html',                        'Carries every pushed graphic — add this one first'],
    ['board',   'Standings board', '/br-leaderboard.html?skin=fncs',   'Full-frame board (drop ?skin=fncs for the dark board)'],
    ['rail',    'Standings rail',  '/br-rail.html',                    'Narrow always-on rail'],
    ['match',   'Match result',    '/br-match.html',                   'Winner + placements for the last match'],
    ['dropmap', 'Drop map',        '/fn-dropmap.html',                 'Landing spots on the island'],
    ['compare', 'Comparison',      '/fn-compare.html',                 'Head-to-head stat card'],
    ['victory', 'Victory Royale',  '/fn-victory.html',                 'The #1 slam']
  ];
  function packBase() { return (window.SCENE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''); }
  function renderPack() {
    const host = el('mlb-pack-rows');
    if (!host || host.dataset.built) return;
    host.dataset.built = '1';
    const base = packBase();
    host.innerHTML = PACK.map(([key, name, path, hint]) =>
      `<div class="mlb-pack-row" data-pk="${key}">
        <span class="pk-name" title="${esc(hint)}">${esc(name)}</span>
        <span class="pk-url">${esc(base + path)}</span>
        <button class="btn btn-ghost btn-sm" data-pk-copy="${esc(base + path)}" type="button">Copy</button>
        <a class="btn btn-ghost btn-sm" href="${esc(base + path)}" target="_blank" rel="noopener">Open</a>
      </div>`).join('');
  }
  function wirePack() {
    if (wirePack._done) return;
    wirePack._done = true;
    el('mlb-pack-open')?.addEventListener('click', () => {
      const box = el('mlb-pack');
      if (!box) return;
      const showing = box.style.display !== 'none';
      box.style.display = showing ? 'none' : '';
      if (!showing) renderPack();
    });
    el('mlb-pack-rows')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pk-copy]');
      if (!btn) return;
      copyText(btn.dataset.pkCopy, btn);
    });
    el('mlb-pack-copyall')?.addEventListener('click', (e) => {
      const base = packBase();
      copyText(PACK.map(([, name, path]) => `${name}: ${base}${path}`).join('\n'), e.currentTarget);
    });
    el('mlb-pack-obs')?.addEventListener('click', () => {
      const st = el('mlb-pack-status');
      if (st) st.textContent = 'Building scenes in OBS…';
      send('br_obs_setup', { base: packBase(), prefix: 'BR' });
    });
  }

  // ── point matrix editor ───────────────────────────────────────────────────
  // Scoring is per-tournament and per-season in real circuits, so a matrix is a named reusable
  // object. Everything here edits a LOCAL draft until Save/Apply — a producer mid-edit must
  // never have a half-typed table land on the live board.
  let _mxDraft = null;      // { id, name, placementPoints[], killPoints, killCap, vrBonus, builtin }
  let _mxPickSig = '';

  function mxStatus(msg) { const n = el('mlb-mx-status'); if (n) n.textContent = msg || ''; }

  function mxLoad(data, id) {
    const list = (metaOf(data).matrices) || [];
    const m = list.find((x) => x.id === id) || list[0];
    if (!m) return;
    _mxDraft = {
      id: m.id, name: m.name, builtin: !!m.builtin,
      placementPoints: (m.placementPoints || []).slice(),
      killPoints: m.killPoints || 0, killCap: m.killCap || 0, vrBonus: m.vrBonus || 0
    };
    mxRenderDraft();
    // Built-ins are read-only on purpose — "Duplicate" is the path to a house ruleset, and that
    // keeps the shipped tables trustworthy as a reference.
    const ro = _mxDraft.builtin;
    ['mlb-mx-name', 'mlb-mx-kill', 'mlb-mx-cap', 'mlb-mx-vr'].forEach((k) => { const n = el(k); if (n) n.disabled = ro; });
    ['mlb-mx-save', 'mlb-mx-del', 'mlb-mx-addrow', 'mlb-mx-fill', 'mlb-mx-paste'].forEach((k) => { const n = el(k); if (n) n.disabled = ro; });
    mxStatus(ro ? 'Built-in matrix — duplicate it to make changes.' : '');
  }
  function mxRenderDraft() {
    if (!_mxDraft) return;
    const set = (id, v) => { const n = el(id); if (n && n !== document.activeElement) n.value = v; };
    set('mlb-mx-name', _mxDraft.name);
    set('mlb-mx-kill', _mxDraft.killPoints);
    set('mlb-mx-cap', _mxDraft.killCap);
    set('mlb-mx-vr', _mxDraft.vrBonus);
    const host = el('mlb-mx-rows');
    if (host) {
      host.innerHTML = _mxDraft.placementPoints.map((v, i) =>
        `<div class="mlb-mx-row" data-mi="${i}">
          <span class="mx-place">${i + 1}${i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'}</span>
          <input type="number" class="input-text" min="0" value="${v}"${_mxDraft.builtin ? ' disabled' : ''}>
          <button type="button" class="mlb-del" data-mx="del" title="Remove this placement"${_mxDraft.builtin ? ' disabled' : ''}>✕</button>
        </div>`).join('');
    }
  }
  function mxRenderMults(data) {
    const host = el('mlb-mx-mults');
    if (!host) return;
    const br = brOf(data);
    const n = Math.max(1, Math.min(40, (br.format && br.format.matches) || 6));
    const mults = br.matchMultipliers || {};
    const sig = JSON.stringify([n, mults]);
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    host.innerHTML = Array.from({ length: n }, (_, i) => {
      const v = mults[String(i + 1)];
      return `<div class="mx-mult" data-mm="${i + 1}"><span>M${i + 1}</span>
        <input type="number" class="input-text${v ? ' on' : ''}" min="1" max="10" step="0.5" value="${v || ''}" placeholder="1×"></div>`;
    }).join('');
  }

  function wireMatrix() {
    if (wireMatrix._done) return;
    wireMatrix._done = true;

    el('mlb-matrix-btn')?.addEventListener('click', () => {
      const box = el('mlb-matrix');
      if (!box) return;
      const showing = box.style.display !== 'none';
      box.style.display = showing ? 'none' : '';
      if (!showing && typeof currentState !== 'undefined') {
        mxLoad(currentState, (currentState.br || {}).matrixId);
        mxRenderMults(currentState);
      }
    });
    el('mlb-mx-pick')?.addEventListener('change', function () {
      if (typeof currentState !== 'undefined') mxLoad(currentState, this.value);
    });
    ['mlb-mx-name', 'mlb-mx-kill', 'mlb-mx-cap', 'mlb-mx-vr'].forEach((id) => {
      el(id)?.addEventListener('input', function () {
        if (!_mxDraft || _mxDraft.builtin) return;
        if (id === 'mlb-mx-name') _mxDraft.name = this.value;
        else if (id === 'mlb-mx-kill') _mxDraft.killPoints = Number(this.value) || 0;
        else if (id === 'mlb-mx-cap') _mxDraft.killCap = parseInt(this.value, 10) || 0;
        else _mxDraft.vrBonus = Number(this.value) || 0;
        mxStatus('Unsaved changes.');
      });
    });
    el('mlb-mx-rows')?.addEventListener('input', (e) => {
      const row = e.target.closest('[data-mi]');
      if (!row || !_mxDraft || e.target.tagName !== 'INPUT') return;
      _mxDraft.placementPoints[parseInt(row.dataset.mi, 10)] = Math.max(0, Number(e.target.value) || 0);
      mxStatus('Unsaved changes.');
    });
    el('mlb-mx-rows')?.addEventListener('click', (e) => {
      const del = e.target.closest('[data-mx="del"]');
      const row = e.target.closest('[data-mi]');
      if (!del || !row || !_mxDraft) return;
      _mxDraft.placementPoints.splice(parseInt(row.dataset.mi, 10), 1);
      mxRenderDraft();
      mxStatus('Unsaved changes.');
    });
    el('mlb-mx-addrow')?.addEventListener('click', () => {
      if (!_mxDraft) return;
      _mxDraft.placementPoints.push(0);
      mxRenderDraft();
      mxStatus('Unsaved changes.');
    });
    // Quick fill — most house tables are a descending ramp, so ask for the two ends and the
    // count rather than making someone type 25 boxes.
    el('mlb-mx-fill')?.addEventListener('click', async () => {
      if (!_mxDraft) return;
      const spec = await appPrompt('Quick fill — "places, firstPoints, lastPoints"\ne.g. 25, 30, 1');
      if (!spec) return;
      const [n, hi, lo] = spec.split(/[,\s]+/).map((x) => Number(x));
      if (!(n > 0) || !isFinite(hi) || !isFinite(lo)) { showToast('Use: places, firstPoints, lastPoints', '#f59e0b'); return; }
      const places = Math.min(150, Math.round(n));
      _mxDraft.placementPoints = Array.from({ length: places }, (_, i) =>
        places === 1 ? Math.round(hi) : Math.round(hi + ((lo - hi) * i) / (places - 1)));
      mxRenderDraft();
      mxStatus('Unsaved changes.');
    });
    el('mlb-mx-paste')?.addEventListener('click', async () => {
      if (!_mxDraft) return;
      const txt = await appPrompt('Paste placement points, 1st first.\nComma, space or line separated — e.g. 30, 26, 24, 22, 21…');
      if (!txt) return;
      const nums = txt.split(/[^0-9.]+/).map((x) => Number(x)).filter((x) => isFinite(x));
      if (!nums.length) { showToast('No numbers found in that paste.', '#f59e0b'); return; }
      _mxDraft.placementPoints = nums.slice(0, 150).map((x) => Math.max(0, Math.round(x)));
      mxRenderDraft();
      mxStatus('Unsaved changes.');
    });
    el('mlb-mx-dup')?.addEventListener('click', () => {
      if (!_mxDraft) return;
      send('set_point_matrix', { action: 'duplicate', id: _mxDraft.id, name: _mxDraft.name + ' (copy)' });
      mxStatus('Duplicated — the copy is now editable.');
    });
    el('mlb-mx-del')?.addEventListener('click', async () => {
      if (!_mxDraft || _mxDraft.builtin) return;
      if (!(await appConfirm(`Delete the matrix "${_mxDraft.name}"? Cups already scored under it keep their points.`, 'Delete'))) return;
      send('set_point_matrix', { action: 'delete', id: _mxDraft.id });
      _mxDraft = null;
    });
    el('mlb-mx-save')?.addEventListener('click', () => {
      if (!_mxDraft || _mxDraft.builtin) return;
      send('set_point_matrix', { ..._mxDraft, action: 'save' });
      mxStatus('Saved.');
    });
    el('mlb-mx-apply')?.addEventListener('click', () => {
      if (!_mxDraft) return;
      const br = (typeof currentState !== 'undefined' && currentState.br) || {};
      send('br_apply_matrix', { matrixId: _mxDraft.id, leagueId: br.leagueId || '', seriesId: br.seriesId || '' });
      mxStatus('Applied to this cup — it now scores under "' + _mxDraft.name + '".');
    });
    el('mlb-mx-apply-league')?.addEventListener('click', () => {
      if (!_mxDraft) return;
      const br = (typeof currentState !== 'undefined' && currentState.br) || {};
      if (!br.leagueId) { showToast('Pick a league cup first — a season default needs a league.', '#f59e0b'); return; }
      send('br_apply_matrix', { scope: 'league', matrixId: _mxDraft.id, leagueId: br.leagueId });
      mxStatus('Set as this league’s default for new cups.');
    });
    el('mlb-mx-mults')?.addEventListener('change', (e) => {
      const cell = e.target.closest('[data-mm]');
      if (!cell) return;
      const br = (typeof currentState !== 'undefined' && currentState.br) || {};
      send('set_br_multiplier', {
        leagueId: br.leagueId || '', seriesId: br.seriesId || '',
        match: parseInt(cell.dataset.mm, 10), multiplier: Number(e.target.value) || 1
      });
    });
  }

  function syncMatrixChip(data) {
    const meta = metaOf(data), br = brOf(data);
    const list = meta.matrices || [];
    const cur = list.find((m) => m.id === br.matrixId);
    const name = el('mlb-matrix-name');
    if (name) {
      // No matrix linked = the cup is on a raw table (a preset, or hand-edited). Say the elim
      // value either way, because that's the number producers get wrong between stages.
      const perElim = (br.scoring && br.scoring.killPoints) != null ? br.scoring.killPoints : '?';
      name.textContent = (cur ? cur.name : 'Custom table') + ' · ' + perElim + '/elim';
    }
    const drift = el('mlb-matrix-drift');
    if (drift) drift.style.display = meta.matrixDrift ? '' : 'none';

    const sel = el('mlb-mx-pick');
    const sig = JSON.stringify(list.map((m) => [m.id, m.name, m.builtin]));
    if (sel && sig !== _mxPickSig) {
      _mxPickSig = sig;
      const grp = (builtin) => list.filter((m) => !!m.builtin === builtin)
        .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
      sel.innerHTML = `<optgroup label="Your matrices">${grp(false) || '<option disabled>None yet — duplicate a built-in</option>'}</optgroup>`
        + `<optgroup label="Built-in">${grp(true)}</optgroup>`;
      if (_mxDraft) sel.value = _mxDraft.id;
    }
  }

  // ── comparison builder ────────────────────────────────────────────────────
  const CMP_PRESET = ['Eliminations', 'Damage Dealt', 'Mats Farmed', 'Builds Placed', 'Solo Clutch Pts'];

  function renderCmpRows() {
    const host = el('mlb-cmp-rows');
    if (!host) return;
    host.innerHTML = _cmpRows.map((r, i) => `<div class="mlb-cmp-row" data-ci="${i}">
      <input type="text" class="input-text" data-cmp="a" value="${esc(r.a)}" placeholder="0">
      <input type="text" class="input-text" data-cmp="label" value="${esc(r.label)}" placeholder="Stat">
      <input type="text" class="input-text" data-cmp="b" value="${esc(r.b)}" placeholder="0">
      <button type="button" class="mlb-del" data-cmp="del" title="Remove row">✕</button>
    </div>`).join('');
  }

  function comparePayload(visible) {
    return {
      title: (el('mlb-cmp-title') || {}).value || 'Comparison',
      label: (el('mlb-cmp-label') || {}).value || '',
      footnote: (el('mlb-cmp-foot') || {}).value || '',
      a: { name: (el('mlb-cmp-a-name') || {}).value || '', team: (el('mlb-cmp-a-team') || {}).value || '', image: (el('mlb-cmp-a-img') || {}).value || '' },
      b: { name: (el('mlb-cmp-b-name') || {}).value || '', team: (el('mlb-cmp-b-team') || {}).value || '', image: (el('mlb-cmp-b-img') || {}).value || '' },
      rows: _cmpRows.filter((r) => r.label),
      visible: visible
    };
  }

  // Hydrate the builder once from server state, so reopening it after a restart shows what's
  // actually on the card rather than an empty form.
  let _cmpHydrated = false;
  function hydrateCompare(data) {
    if (_cmpHydrated) return;
    const c = brOf(data).compare;
    if (!c) return;
    _cmpHydrated = true;
    setVal(el('mlb-cmp-title'), c.title || 'Comparison');
    setVal(el('mlb-cmp-label'), c.label || '');
    setVal(el('mlb-cmp-foot'), c.footnote || '');
    setVal(el('mlb-cmp-a-name'), (c.a || {}).name || '');
    setVal(el('mlb-cmp-a-team'), (c.a || {}).team || '');
    setVal(el('mlb-cmp-a-img'), (c.a || {}).image || '');
    setVal(el('mlb-cmp-b-name'), (c.b || {}).name || '');
    setVal(el('mlb-cmp-b-team'), (c.b || {}).team || '');
    setVal(el('mlb-cmp-b-img'), (c.b || {}).image || '');
    _cmpRows = (c.rows || []).map((r) => ({ label: r.label || '', a: r.a || '', b: r.b || '' }));
    if (!_cmpRows.length) _cmpRows = CMP_PRESET.map((label) => ({ label, a: '', b: '' }));
    renderCmpRows();
  }

  // ── wiring (once) ─────────────────────────────────────────────────────────
  function wire() {
    if (_wired) return;
    _wired = true;

    el('mlb-mode')?.addEventListener('change', function () { send('set_br_mode', { mode: this.value }); });

    // Binding a cup MIRRORS it onto the board (results + that cup's own scoring table), so this
    // is also how the producer moves from week 1 to week 2 without re-typing anything.
    // Jump to the bound league's BR Cups page — where the season table and the results grid live.
    el('mlb-cup-open')?.addEventListener('click', () => {
      const br = (typeof currentState !== 'undefined' && currentState.br) || {};
      if (!br.leagueId) { showToast('Pick a cup first, or add one on a league’s BR Cups tab.', '#f59e0b'); return; }
      document.querySelector('.tab-btn[data-tab="events"]')?.click();
      setTimeout(() => {
        if (typeof lgActiveId !== 'undefined') { lgActiveId = br.leagueId; }
        if (typeof lgSwitchTab === 'function') { if (typeof lgRender === 'function') lgRender(); lgSwitchTab('brseries'); }
      }, 140);
    });

    el('mlb-cup')?.addEventListener('change', function () {
      const [leagueId, seriesId] = (this.value || '').split('|');
      send('set_br_league', { leagueId: leagueId || '', seriesId: seriesId || '' });
      _rowSig = '';   // the whole results set just changed under us
    });
    el('mlb-format')?.addEventListener('change', function () { send('set_br_mode', { teamFormat: this.value }); });

    // Match selector is LOCAL (it picks which match the table edits); the server only hears
    // about it so the overlays' "GAME n" chip follows the producer.
    const pushMatch = () => {
      const m = curMatch();
      send('set_br_live', { match: m });
      _rowSig = _finishSig = _elimsSig = '';   // force the visible mode to re-read that match
      if (typeof currentState !== 'undefined') brLobbyApply(currentState);
    };
    el('mlb-match')?.addEventListener('change', pushMatch);
    // A number input only fires `change` on blur, so Enter felt like nothing happened.
    el('mlb-match')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } });
    el('mlb-match-prev')?.addEventListener('click', () => {
      const n = el('mlb-match'); if (!n) return;
      n.value = String(Math.max(1, curMatch() - 1)); pushMatch();
    });
    el('mlb-match-next')?.addEventListener('click', () => {
      const n = el('mlb-match'); if (!n) return;
      const next = Math.min(40, curMatch() + 1);
      n.value = String(next);
      // A cup running past its planned length is normal (a re-drop, an extra game). Raise the
      // total to follow rather than refusing to advance — the producer would just have to go
      // find the setting anyway, mid-show.
      if (next > matchTotal()) pushTotal(next);
      pushMatch();
    });

    // The match TOTAL ("of 6"). Routing matters: bound to a league cup it belongs to the cup, so
    // the league page and the board agree; standalone it's the series' own format.
    el('mlb-match-total')?.addEventListener('change', function () {
      pushTotal(parseInt(this.value, 10) || 6);
    });
    el('mlb-match-total')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } });

    // Add entrant
    el('mlb-add')?.addEventListener('click', () => {
      const players = ((el('mlb-new-players') || {}).value || '')
        .split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name }));
      const name = ((el('mlb-new-name') || {}).value || '').trim();
      if (!name && !players.length) { showToast('Enter an entrant name or its players.', '#f59e0b'); return; }
      saveEntrant({ name, players, drop: ((el('mlb-new-drop') || {}).value || '').trim() });
      ['mlb-new-name', 'mlb-new-players', 'mlb-new-drop'].forEach((id) => { const n = el(id); if (n) n.value = ''; });
      el('mlb-new-name')?.focus();
    });
    // Enter anywhere in the add row commits it — typing a 25-duo field by hand is the fallback
    // path that has to be fast.
    ['mlb-new-name', 'mlb-new-players', 'mlb-new-drop'].forEach((id) => {
      el(id)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el('mlb-add')?.click(); } });
    });

    // Always MERGE — never replace. Re-pulling after a roster change is normal mid-show, and it
    // must not wipe drop POIs and notes already set. "Clear field" is the explicit destructive
    // action, so nothing irreversible hides behind this button.
    el('mlb-pull-startgg')?.addEventListener('click', () => {
      send('br_pull_field', { replace: false });
      const st = el('mlb-source-status'); if (st) st.textContent = 'Pulling field from start.gg…';
    });

    el('mlb-league')?.addEventListener('change', function () {
      const id = this.value;
      this.value = '';
      if (!id) return;
      send('br_lobby_from_league', { leagueId: id, replace: false });
    });

    el('mlb-paste')?.addEventListener('click', async () => {
      const txt = await appPrompt('Paste entrants, one per line. Use "Name: Player1, Player2" to include the roster.');
      if (!txt) return;
      const lobby = txt.split('\n').map((line) => {
        const s = line.trim();
        if (!s) return null;
        const i = s.indexOf(':');
        if (i < 0) return { name: s, players: [] };
        return {
          name: s.slice(0, i).trim(),
          players: s.slice(i + 1).split(',').map((n) => n.trim()).filter(Boolean).map((name) => ({ name }))
        };
      }).filter(Boolean);
      if (!lobby.length) return;
      const existing = ((typeof currentState !== 'undefined' && currentState.br && currentState.br.lobby) || []);
      send('set_br_lobby', { lobby: existing.concat(lobby) });
    });

    el('mlb-clear')?.addEventListener('click', async () => {
      if (!(await appConfirm('Remove every entrant from the lobby? Match results are kept — only the field is cleared.', 'Clear field'))) return;
      send('set_br_lobby', { lobby: [] });
    });

    el('mlb-settings-btn')?.addEventListener('click', () => {
      // The scoring table, sheet sync, event branding and drop-map POIs already live in the
      // Fortnite game section — jump there rather than duplicating them in two places. Same
      // route the Integration store's game cards use (openSettings + click the game tab), so
      // this stays correct if that navigation ever changes.
      if (typeof openSettings === 'function') openSettings('games');
      const game = ((typeof currentState !== 'undefined' && currentState.br && currentState.br.game) || 'fortnite');
      setTimeout(() => {
        document.querySelector('#integration-games .game-tab-btn[data-game="' + game + '"]')?.click();
      }, 50);
    });

    // Field table — event-delegated, since the rows are rebuilt on every relevant state change.
    const rows = el('mlb-rows');
    rows?.addEventListener('change', (e) => {
      const input = e.target.closest('[data-mlb]');
      const row = e.target.closest('.mlb-row');
      if (!input || !row) return;
      const id = row.dataset.eid, name = row.dataset.ename;
      switch (input.dataset.mlb) {
        case 'name':
          saveEntrant({ id, name: input.value.trim() });
          break;
        case 'players':
          saveEntrant({ id, players: input.value.split(',').map((s) => s.trim()).filter(Boolean).map((n) => ({ name: n })) });
          break;
        case 'drop':
          send('set_br_drops', { drops: { [id]: input.value.trim() } });
          break;
        case 'placement':
          saveResult(name, { placement: parseInt(input.value, 10) || 0, elims: parseInt(row.querySelector('[data-mlb="elims"]').value, 10) || 0 });
          break;
        case 'elims':
          saveResult(name, { elims: parseInt(input.value, 10) || 0, placement: parseInt(row.querySelector('[data-mlb="placement"]').value, 10) || 0 });
          break;
      }
    });
    rows?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-mlb="focus"], [data-mlb="remove"]');
      const row = e.target.closest('.mlb-row');
      if (!btn || !row) return;
      if (btn.dataset.mlb === 'focus') {
        const cur = ((typeof currentState !== 'undefined' && currentState.br && currentState.br.live) || {}).focus || '';
        send('set_br_live', { focus: cur === row.dataset.eid ? '' : row.dataset.eid });
      } else {
        if (!(await appConfirm(`Remove "${row.dataset.ename}" from the lobby?`, 'Remove'))) return;
        saveEntrant({ id: row.dataset.eid, remove: true });
      }
    });
    // Tab/Enter through the placement + elims columns without reaching for the mouse.
    rows?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const input = e.target.closest('[data-mlb="placement"], [data-mlb="elims"]');
      if (!input) return;
      e.preventDefault();
      input.blur();                                    // commit via the change handler
      const all = [...rows.querySelectorAll(`[data-mlb="${input.dataset.mlb}"]`)];
      const next = all[all.indexOf(input) + 1];
      if (next) next.focus();
    });

    // Graphics strip
    document.querySelectorAll('[data-mlb-gfx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.mlbGfx;
        const live = btn.classList.contains('live');
        if (key === 'brdrop') send('set_br_dropmap', { visible: !live });
        else if (key === 'brcompare') send('set_br_compare', { visible: !live });
        else if (key === 'brvictory') {
          // Auto-fill from the selected match's winner, so one press is the whole action.
          if (!live) send('set_br_victory', { fromMatch: curMatch(), visible: true });
          else send('set_br_victory', { visible: false });
        } else if (key === 'standings') send('set_gfx_active', { scene: live ? null : 'standings' });
      });
    });
    el('mlb-gfx-clear')?.addEventListener('click', () => send('set_gfx_active', { scene: null }));

    // Comparison builder
    el('mlb-compare-open')?.addEventListener('click', () => {
      const box = el('mlb-compare');
      if (!box) return;
      const showing = box.style.display !== 'none';
      box.style.display = showing ? 'none' : '';
      if (!showing && !_cmpRows.length) { _cmpRows = CMP_PRESET.map((label) => ({ label, a: '', b: '' })); renderCmpRows(); }
    });
    el('mlb-cmp-addrow')?.addEventListener('click', () => { _cmpRows.push({ label: '', a: '', b: '' }); renderCmpRows(); });
    el('mlb-cmp-preset')?.addEventListener('click', () => { _cmpRows = CMP_PRESET.map((label) => ({ label, a: '', b: '' })); renderCmpRows(); });
    el('mlb-cmp-rows')?.addEventListener('input', (e) => {
      const f = e.target.closest('[data-cmp]');
      const row = e.target.closest('.mlb-cmp-row');
      if (!f || !row) return;
      const i = parseInt(row.dataset.ci, 10);
      if (_cmpRows[i] && f.dataset.cmp !== 'del') _cmpRows[i][f.dataset.cmp] = f.value;
    });
    el('mlb-cmp-rows')?.addEventListener('click', (e) => {
      const del = e.target.closest('[data-cmp="del"]');
      const row = e.target.closest('.mlb-cmp-row');
      if (!del || !row) return;
      _cmpRows.splice(parseInt(row.dataset.ci, 10), 1);
      renderCmpRows();
    });
    el('mlb-cmp-apply')?.addEventListener('click', () => { send('set_br_compare', comparePayload(false)); showToast('Comparison card updated.', '#10B981'); });
    el('mlb-cmp-push')?.addEventListener('click', () => send('set_br_compare', comparePayload(true)));
  }

  // A prompt that matches the app's own modal style where one exists, falling back to the
  // browser prompt so the paste path still works in a stripped-down window.
  function appPrompt(message) {
    if (typeof window.appPromptModal === 'function') return window.appPromptModal(message);
    return Promise.resolve(window.prompt(message) || '');
  }

  // ── entry point (called from applyState) ──────────────────────────────────
  function brLobbyApply(data) {
    const section = el('match-teams-section');
    const panel = el('match-lobby');
    if (!section || !panel) return;

    const on = inLobbyMode(data);
    // Both of these are removed for every non-lobby game, every time — that is what guarantees
    // switching back to Rocket League restores the team cards exactly as they were.
    section.classList.toggle('lobby-mode', on);
    panel.style.display = on ? '' : 'none';
    if (!on) return;

    wire();
    wireEntryModes();
    wirePack();
    wireMatrix();
    syncSelectors(data);
    syncMatrixChip(data);
    hydrateCompare(data);

    const br = brOf(data);
    setVal(el('mlb-match'), String((br.live && br.live.match) || 1));
    setVal(el('mlb-match-total'), String((br.format && br.format.matches) || 6));
    const ofEl = el('mlb-match-of');
    // Say where the cup is up to, not just how long it is — "3 scored" is the number a producer
    // checks when they lose track between games.
    if (ofEl) {
      const played = (br.standings || []).reduce((m, t) =>
        Math.max(m, ...Object.keys(t.matches || {}).map(Number), 0), 0);
      ofEl.textContent = played ? `· ${played} scored` : '';
    }
    const countEl = el('mlb-count');
    if (countEl) {
      const n = (br.lobby || []).length;
      const fmt = ((metaOf(data).formats || []).find((f) => f.id === br.teamFormat) || {}).name || '';
      countEl.textContent = `${n} entrant${n === 1 ? '' : 's'}${fmt ? ' · ' + fmt : ''}`;
    }
    const src = el('mlb-source-status');
    if (src && !/^Pulling/.test(src.textContent)) {
      // Say plainly where results are landing — "manual" vs "into the league season" is the
      // difference between a score that survives the cup and one that doesn't.
      const lg = (data.leagues || []).find((l) => l && l.id === br.leagueId);
      const cup = lg && (lg.brSeries || []).find((s) => s.id === br.seriesId);
      src.textContent = cup
        ? `Scoring into "${cup.name}" — ${lg.name || 'league'}. The league page's BR Cups grid edits the same results.`
        : (br.source === 'sheets' ? 'Results source: Google Sheet.'
          : 'Standalone series — results are not saved to a league season. Pick a Cup above to build a season record.');
    }

    // Source chip — "why isn't the board updating" is nearly always this being on the wrong thing.
    const chip = el('mlb-src-chip');
    if (chip) {
      const src = br.source || 'manual';
      chip.textContent = { manual: 'Manual', sheets: 'Google Sheet', live: 'Live feed' }[src] || src;
      chip.classList.toggle('sheets', src === 'sheets');
      chip.classList.toggle('live', src === 'live');
      const ing = br.lastIngest;
      chip.title = ing && ing.at
        ? `Last ingest: ${ing.rows} row(s) for match ${ing.match} from ${ing.source}`
        : 'Where this cup’s results come from';
    }

    // Only the visible entry mode is rendered — a 50-entrant field is three grids otherwise.
    if (_entryMode === 'grid') renderRows(data);
    else if (_entryMode === 'finish') renderFinish(data);
    else renderElims(data);
    if ((el('mlb-matrix') || {}).style && el('mlb-matrix').style.display !== 'none') mxRenderMults(data);

    // Light the graphics buttons that are actually on air.
    const liveMap = {
      brdrop: !!(br.dropmap && br.dropmap.visible),
      brcompare: !!(br.compare && br.compare.visible),
      brvictory: !!(br.victory && br.victory.visible),
      standings: data.gfxActive === 'standings'
    };
    document.querySelectorAll('[data-mlb-gfx]').forEach((btn) => {
      btn.classList.toggle('live', !!liveMap[btn.dataset.mlbGfx]);
    });
  }

  window.brLobbyApply = brLobbyApply;

  // ── Drop-map POI editor (Settings ▸ Games ▸ Fortnite) ─────────────────────
  // The island changes every season, so the POI table is producer-editable data. Edits are held
  // locally until Save, then written into the game's config bundle server-side — which is what
  // makes them travel with a Producer Profile like every other per-game content set.
  let _pois = [];          // working copy for the selected island
  let _poiSet = '';        // which island is loaded into _pois
  let _poiWired = false;

  function poiRender() {
    const host = el('fn-poi-rows');
    if (!host) return;
    host.innerHTML = _pois.map((p, i) => `<div class="fn-poi-row" data-pi="${i}">
      <input type="text" class="input-text" data-poi="name" value="${esc(p.name)}" placeholder="POI name">
      <input type="number" class="input-text" data-poi="x" value="${p.x}" min="0" max="100" step="0.5" title="X position, % of map width">
      <input type="number" class="input-text" data-poi="y" value="${p.y}" min="0" max="100" step="0.5" title="Y position, % of map height">
      <button type="button" class="mlb-del" data-poi="del" title="Remove POI">✕</button>
    </div>`).join('');
  }

  function poiStatus(msg) { const n = el('fn-poi-status'); if (n) n.textContent = msg || ''; }

  function poiWire() {
    if (_poiWired) return;
    _poiWired = true;

    el('fn-poi-set')?.addEventListener('change', () => { _poiSet = ''; if (typeof currentState !== 'undefined') brPoiApply(currentState); });
    el('fn-poi-add')?.addEventListener('click', () => {
      _pois.push({ id: 'poi' + (_pois.length + 1), name: '', x: 50, y: 50 });
      poiRender();
      poiStatus('Unsaved changes.');
    });
    el('fn-poi-rows')?.addEventListener('input', (e) => {
      const f = e.target.closest('[data-poi]');
      const row = e.target.closest('[data-pi]');
      if (!f || !row || f.dataset.poi === 'del') return;
      const i = parseInt(row.dataset.pi, 10);
      if (!_pois[i]) return;
      _pois[i][f.dataset.poi] = f.dataset.poi === 'name' ? f.value : (Number(f.value) || 0);
      poiStatus('Unsaved changes.');
    });
    el('fn-poi-rows')?.addEventListener('click', (e) => {
      const del = e.target.closest('[data-poi="del"]');
      const row = e.target.closest('[data-pi]');
      if (!del || !row) return;
      _pois.splice(parseInt(row.dataset.pi, 10), 1);
      poiRender();
      poiStatus('Unsaved changes.');
    });
    el('fn-poi-save')?.addEventListener('click', () => {
      send('set_br_pois', {
        game: 'fortnite',
        set: (el('fn-poi-set') || {}).value || 'br-build',
        map: (el('fn-poi-map') || {}).value || '',
        pois: _pois
      });
      poiStatus('Saved.');
    });
    el('fn-poi-reset')?.addEventListener('click', async () => {
      if (!(await appConfirm('Discard your POI edits for this island and go back to the built-in list?', 'Reset'))) return;
      send('set_br_pois', { game: 'fortnite', set: (el('fn-poi-set') || {}).value || 'br-build', pois: null });
      _poiSet = '';   // force a reload from the next broadcast
    });
  }

  // ── Drop assignments (Graphics ▸ Drop Map) ───────────────────────────────
  // Same data as Match — Lobby's Drop column; here so the whole drop map can be built on the
  // graphic's own panel without bouncing between two pages.
  let _dropSig = '';
  function dropRender(data) {
    const host = el('fn-drop-rows');
    const empty = el('fn-drop-empty');
    if (!host) return;
    const br = brOf(data);
    const lobby = Array.isArray(br.lobby) ? br.lobby : [];
    const pois = ((metaOf(data).poi || {}).pois) || [];
    if (empty) empty.style.display = lobby.length ? 'none' : '';

    const sig = JSON.stringify([lobby.map((e) => [e.id, e.name, e.drop]), pois.map((p) => [p.id, p.name])]);
    if (sig === _dropSig) return;
    _dropSig = sig;

    host.innerHTML = lobby.map((e) => {
      // A drop the producer typed by hand (free text, not a POI) must stay selectable, or
      // re-rendering the row would silently discard it.
      const known = pois.some((p) => p.id === e.drop);
      const custom = e.drop && !known ? `<option value="${esc(e.drop)}" selected>${esc(e.drop)} (typed)</option>` : '';
      return `<div class="fn-drop-row" data-eid="${esc(e.id)}">
        <span class="fn-drop-name" title="${esc(e.name)}">${esc(e.name)}</span>
        <select class="input-select">
          <option value=""${e.drop ? '' : ' selected'}>— No drop —</option>
          ${custom}
          ${pois.map((p) => `<option value="${esc(p.id)}"${p.id === e.drop ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></div>`;
    }).join('');
  }

  function dropWire() {
    if (dropWire._done) return;
    dropWire._done = true;
    el('fn-drop-rows')?.addEventListener('change', (e) => {
      const row = e.target.closest('[data-eid]');
      if (!row) return;
      send('set_br_drops', { drops: { [row.dataset.eid]: e.target.value } });
    });
    el('fn-drop-clear')?.addEventListener('click', async () => {
      if (!(await appConfirm('Clear every entrant’s drop assignment?', 'Clear drops'))) return;
      send('set_br_drops', { clearAll: true });
    });
    // Spread the unassigned across free POIs — the fast way to get a usable map up, then adjust.
    el('fn-drop-auto')?.addEventListener('click', () => {
      const data = (typeof currentState !== 'undefined' && currentState) || {};
      const lobby = (brOf(data).lobby) || [];
      const pois = ((metaOf(data).poi || {}).pois) || [];
      if (!lobby.length || !pois.length) { showToast('Need a field and a POI list first.', '#f59e0b'); return; }
      const taken = new Set(lobby.map((e) => e.drop).filter(Boolean));
      const free = pois.filter((p) => !taken.has(p.id));
      const drops = {};
      let i = 0;
      for (const e of lobby) {
        if (e.drop) continue;
        // Wrap round the full POI list once the free ones run out — contested spots are normal.
        drops[e.id] = (free[i] || pois[i % pois.length]).id;
        i++;
      }
      if (!Object.keys(drops).length) { showToast('Every entrant already has a drop.', '#f59e0b'); return; }
      send('set_br_drops', { drops });
    });
  }

  function brPoiApply(data) {
    if (!el('fn-poi-rows')) return;
    // Only a battle-royale game has a drop map — do nothing (and touch nothing) otherwise.
    if (!((metaOf(data).lobbyGames || []).includes(data && data.activeGame))) return;
    poiWire();
    dropWire();
    dropRender(data);
    const key = (el('fn-poi-set') || {}).value || 'br-build';
    // Only (re)load from server state when the selected island changes or nothing is loaded —
    // otherwise an inbound broadcast would wipe half-typed edits mid-season-update.
    if (_poiSet === key) return;
    const cfg = ((data.gameConfigs || {}).fortnite || {});
    const saved = (cfg.pois || {})[key];
    // Seed the editor from the server's resolved set for THIS island (brMeta.poiSets carries
    // every island, not just the one being played) so the producer always edits the real list
    // rather than starting from an empty table.
    const meta = metaOf(data);
    const resolved = ((meta.poiSets || {})[key]) || { map: '', pois: [] };
    _poiSet = key;
    _pois = (resolved.pois || []).map((p) => ({ id: p.id || '', name: p.name || '', x: Number(p.x) || 0, y: Number(p.y) || 0 }));
    setVal(el('fn-poi-map'), resolved.map || '');
    poiRender();
    poiStatus(saved ? 'Using your edited list.' : 'Using the built-in list — edits are saved per island.');
  }

  window.brPoiApply = brPoiApply;
})();
