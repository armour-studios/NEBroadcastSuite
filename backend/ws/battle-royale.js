'use strict';
// Battle royale (lobbies, results, point matrices, Apex) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_apexAcc, _apexGamesSig, gameConfigsVer, leaguesVer, obsClient, startggApiToken).
let
  BR_DEFAULT_MODE, BR_SCORING_PRESETS, BR_TEAM_FORMATS, GAMES, HTTP_PORT, apexLive,
  brApplyScoringPreset, brBinding, brFormatSize, brMergeLobby, brModeMeta, brModesFor,
  brNameFromPlayers, brNewMatrixId, brNewSeries, brResolveSeries, brSyncFromLeague,
  brWriteSheetTemplate, broadcastFullState, computeBrStandings, createStartGgClient,
  fetchAllEntrants, findMatrix, isLobbyGame, logAuto, mapEntrantsToTeams, matrixToScoring,
  obsAppName, parseEventSlug, recomputeApexBroadcast, recomputeBrSeason, sanitizeBrEntrant,
  sanitizePointMatrix, saveAppState, sendWs, setExclusiveGfxVisible, state;
let ctx;

const handlers = {
  // -- Battle royale series (Fortnite / PUBG / Warzone / any points-per-placement format) ------
  // Everything derives from state.br.results, so every one of these ends by recomputing rather
  // than patching a total in place.
  set_br(msg, ws) {
    const p = msg.data || {};
    const br = state.br;
    if (typeof p.enabled === 'boolean') br.enabled = p.enabled;
    if (typeof p.game === 'string' && GAMES[p.game]) br.game = p.game;
    if (typeof p.source === 'string' && ['manual', 'sheets', 'live'].includes(p.source)) br.source = p.source;
    if (p.event && typeof p.event === 'object') {
      br.event = {
        title: (p.event.title != null ? String(p.event.title) : br.event.title).slice(0, 120),
        match: (p.event.match != null ? String(p.event.match) : br.event.match).slice(0, 60),
        split: (p.event.split != null ? String(p.event.split) : br.event.split).slice(0, 60)
      };
    }
    if (p.format && typeof p.format === 'object') {
      if (p.format.matches != null) br.format.matches = Math.max(1, Math.min(40, parseInt(p.format.matches, 10) || 6));
      if (p.format.teamSize != null) br.format.teamSize = Math.max(1, Math.min(8, parseInt(p.format.teamSize, 10) || 4));
    }
    if (typeof p.scoringPreset === 'string') brApplyScoringPreset(p.scoringPreset);
    if (p.scoring && typeof p.scoring === 'object') {
      // Hand-edited table -> the preset no longer describes it. Say so, rather than showing
      // "FNCS" next to numbers that aren't FNCS.
      if (Array.isArray(p.scoring.placementPoints)) {
        br.scoring.placementPoints = p.scoring.placementPoints.slice(0, 100).map((n) => Math.max(0, Math.round(Number(n) || 0)));
        br.scoringPreset = 'custom';
      }
      if (p.scoring.killPoints != null) { br.scoring.killPoints = Math.max(0, Number(p.scoring.killPoints) || 0); br.scoringPreset = 'custom'; }
      if (p.scoring.killCap != null) { br.scoring.killCap = Math.max(0, parseInt(p.scoring.killCap, 10) || 0); br.scoringPreset = 'custom'; }
    }
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // Manual scorekeeping - one team's result in one match. This is the path that has to work when
  // the sheet doesn't: upserts by (match, team) so re-entering a corrected number replaces it.
  set_br_result(msg, ws) {
    const p = msg.data || {};
    const team = (p.team || '').toString().trim();
    const match = Math.max(1, parseInt(p.match, 10) || 0);
    if (!team || !match) return;
    const row = {
      match, team: team.slice(0, 80),
      placement: Math.max(0, parseInt(p.placement, 10) || 0),
      elims: Math.max(0, parseInt(p.elims, 10) || 0)
    };
    const upsert = (arr) => {
      const i = arr.findIndex((r) => (parseInt(r.match, 10) || 0) === match
        && (r.team || '').toString().trim().toLowerCase() === team.toLowerCase());
      if (p.remove) { if (i >= 0) arr.splice(i, 1); }
      else if (i >= 0) arr[i] = row;
      else arr.push(row);
    };
    // A cup targeted explicitly (the league page's grid editing a cup that ISN'T on air) or
    // the live binding. Either way the LEAGUE is the store and the live board re-mirrors it,
    // so the two surfaces can never drift apart.
    const target = brResolveSeries(p.leagueId, p.seriesId);
    if (target) {
      upsert(target.series.results);
      recomputeBrSeason(target.lg);
      ctx.leaguesVer++;
      // Only re-mirror when the edited cup is the one on air.
      if (target.series.id === state.br.seriesId && target.lg.id === state.br.leagueId) brSyncFromLeague();
    } else {
      if (!Array.isArray(state.br.results)) state.br.results = [];
      upsert(state.br.results);
      state.br.source = 'manual';
    }
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // Same, for the per-player elim board.
  set_br_player_result(msg, ws) {
    const p = msg.data || {};
    const player = (p.player || '').toString().trim();
    const match = Math.max(1, parseInt(p.match, 10) || 0);
    if (!player || !match) return;
    if (!Array.isArray(state.br.playerResults)) state.br.playerResults = [];
    const i = state.br.playerResults.findIndex((r) => (parseInt(r.match, 10) || 0) === match
      && (r.player || '').toString().trim().toLowerCase() === player.toLowerCase());
    const row = { match, player: player.slice(0, 80), team: (p.team || '').toString().trim().slice(0, 80), elims: Math.max(0, parseInt(p.elims, 10) || 0) };
    if (p.remove) { if (i >= 0) state.br.playerResults.splice(i, 1); }
    else if (i >= 0) state.br.playerResults[i] = row;
    else state.br.playerResults.push(row);
    state.br.source = 'manual';
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // Wipe results. scope 'match' clears one match (a re-run/replayed game), 'all' resets the series.
  clear_br_results(msg, ws) {
    const p = msg.data || {};
    const m = parseInt(p.match, 10) || 0;
    const target = brResolveSeries(p.leagueId, p.seriesId);
    if (target) {
      // Bound to a league cup — clear it there, then re-mirror. Clearing only the live copy
      // would leave the league holding results the board says don't exist.
      target.series.results = (p.scope === 'match' && m)
        ? target.series.results.filter((r) => (parseInt(r.match, 10) || 0) !== m)
        : [];
      recomputeBrSeason(target.lg);
      ctx.leaguesVer++;
      if (target.series.id === state.br.seriesId && target.lg.id === state.br.leagueId) brSyncFromLeague();
    } else if (p.scope === 'match' && m) {
      state.br.results = (state.br.results || []).filter((r) => (parseInt(r.match, 10) || 0) !== m);
    } else {
      state.br.results = [];
    }
    // The per-player elim board is live-series-only (no league store), so it clears either way.
    state.br.playerResults = (p.scope === 'match' && m)
      ? (state.br.playerResults || []).filter((r) => (parseInt(r.match, 10) || 0) !== m)
      : [];
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // ── BR lobby (the Fortnite Match — Lobby panel) ──────────────────────────
  // Mode / squad size. Changing the mode also re-points the drop map at that mode's POI set
  // (Reload is a different island), which is why this isn't folded into set_br.
  set_br_mode(msg, ws) {
    const p = msg.data || {};
    if (typeof p.mode === 'string') {
      const meta = brModeMeta(state.br.game, p.mode);
      if (meta) state.br.mode = meta.id;
    }
    if (typeof p.teamFormat === 'string' && BR_TEAM_FORMATS.some((f) => f.id === p.teamFormat)) {
      state.br.teamFormat = p.teamFormat;
      state.br.format.teamSize = brFormatSize(p.teamFormat);
    }
    if (typeof p.game === 'string' && GAMES[p.game]) {
      state.br.game = p.game;
      // A game switch can strand the series on a mode the new game doesn't have.
      if (!brModesFor(p.game).some((m) => m.id === state.br.mode)) {
        state.br.mode = BR_DEFAULT_MODE[p.game] || brModesFor(p.game)[0].id;
      }
    }
    saveAppState();
    broadcastFullState();
  },

  // ── Point matrices ───────────────────────────────────────────────────────
  // Create / update / delete a named matrix. Built-ins can't be edited or deleted — "Duplicate"
  // copies one into the producer's own library, which is the path for "we run FNCS but with
  // 3 points a kill".
  set_point_matrix(msg, ws) {
    const p = msg.data || {};
    if (!Array.isArray(state.pointMatrices)) state.pointMatrices = [];
    const action = String(p.action || 'save');
    const id = String(p.id || '');
    if (action === 'delete') {
      state.pointMatrices = state.pointMatrices.filter((m) => m.id !== id);
      // Cups keep their SNAPSHOT and keep scoring correctly — only the link is broken.
      (state.leagues || []).forEach((lg) => {
        if (lg.brMatrixId === id) lg.brMatrixId = '';
        (lg.brSeries || []).forEach((s) => { if (s.matrixId === id) s.matrixId = ''; });
      });
      if (state.br.matrixId === id) state.br.matrixId = '';
      ctx.leaguesVer++;
    } else if (action === 'duplicate') {
      const src = findMatrix(id);
      if (!src) return;
      if (state.pointMatrices.length >= 100) return;
      const copy = sanitizePointMatrix({ ...src, id: brNewMatrixId(), builtin: false,
        name: (p.name || (src.name + ' (copy)')).slice(0, 60) });
      state.pointMatrices.push(copy);
      sendWs(ws, { type: 'event-result', data: { ok: true, matrixId: copy.id, message: `Created "${copy.name}".` } });
    } else {
      const existing = state.pointMatrices.find((m) => m.id === id);
      if (existing) {
        Object.assign(existing, sanitizePointMatrix({ ...existing, ...p, id: existing.id, builtin: false }));
      } else {
        if (state.pointMatrices.length >= 100) return;
        const m = sanitizePointMatrix({ ...p, id: id || brNewMatrixId(), builtin: false });
        state.pointMatrices.push(m);
        sendWs(ws, { type: 'event-result', data: { ok: true, matrixId: m.id, message: `Created "${m.name}".` } });
      }
    }
    saveAppState();
    broadcastFullState();
  },

  // Point a cup (or a league's season default) at a matrix, copying it in as that cup's
  // snapshot. Editing the matrix later never re-scores played cups on its own — re-applying is
  // this same message, sent deliberately.
  br_apply_matrix(msg, ws) {
    const p = msg.data || {};
    const m = findMatrix(p.matrixId);
    if (!m) return;
    const lg = (state.leagues || []).find((l) => l && l.id === String(p.leagueId || ''));
    if (p.scope === 'league' && lg) {
      lg.brMatrixId = m.id;
    } else {
      const target = brResolveSeries(p.leagueId, p.seriesId);
      if (target) {
        target.series.matrixId = m.id;
        target.series.scoring = matrixToScoring(m);
        target.series.scoringPreset = 'matrix';
        recomputeBrSeason(target.lg);
        if (target.series.id === state.br.seriesId && target.lg.id === state.br.leagueId) brSyncFromLeague();
      } else {
        // Standalone (unbound) series — apply straight to the live board.
        state.br.matrixId = m.id;
        state.br.scoring = matrixToScoring(m);
        state.br.scoringPreset = 'matrix';
      }
    }
    ctx.leaguesVer++;
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // Per-match weighting on a cup (double-points final, etc). { match, multiplier } —
  // multiplier 1 or 0 removes the entry rather than storing a no-op.
  set_br_multiplier(msg, ws) {
    const p = msg.data || {};
    const n = Math.max(1, Math.min(40, parseInt(p.match, 10) || 0));
    if (!n) return;
    const v = Number(p.multiplier);
    const target = brResolveSeries(p.leagueId, p.seriesId);
    const bag = target ? (target.series.matchMultipliers = target.series.matchMultipliers || {}) : (state.br.matchMultipliers = state.br.matchMultipliers || {});
    if (!(v > 0) || v === 1) delete bag[String(n)];
    else bag[String(n)] = Math.round(v * 100) / 100;
    if (target) {
      recomputeBrSeason(target.lg);
      ctx.leaguesVer++;
      if (target.series.id === state.br.seriesId && target.lg.id === state.br.leagueId) brSyncFromLeague();
    }
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // ── BR overlay pack → OBS ────────────────────────────────────────────────
  // "Where are the Fortnite overlays and how do I get them into OBS" was a dead end: the URLs
  // were scattered across a themes dropdown and three panel hints. This builds the whole pack
  // in one action — a scene per graphic (so the producer can cut to them) plus the shared
  // gfx.html layer that carries every pushed graphic.
  //
  // Idempotent: an existing scene is reused and its source retargeted, so running it twice
  // after a URL/port change repairs the setup instead of duplicating it.
  br_obs_setup(msg, ws) {
    const d = msg.data || {};
    (async () => {
      let ok = false, message = '';
      try {
        if (!ctx.obsClient || !ctx.obsClient.isConnected()) throw new Error(`Not connected to ${obsAppName()}. Connect it on the Apps page, then run this again.`);
        const base = (d.base || `http://localhost:${HTTP_PORT || 3000}`).replace(/\/+$/, '');
        const prefix = String(d.prefix || 'BR').trim().slice(0, 20);
        // gfx.html is deliberately FIRST: it is the one source that carries every punch-up
        // graphic, and a producer who only adds one should end up with that one.
        const pack = [
          { key: 'gfx',       scene: 'Graphics',        source: 'Graphics Layer',   url: `${base}/gfx.html` },
          { key: 'board',     scene: 'Standings',       source: 'BR Standings',     url: `${base}/br-leaderboard.html?skin=fncs` },
          { key: 'rail',      scene: 'Standings Rail',  source: 'BR Rail',          url: `${base}/br-rail.html` },
          { key: 'match',     scene: 'Match Result',    source: 'BR Match Result',  url: `${base}/br-match.html` },
          { key: 'dropmap',   scene: 'Drop Map',        source: 'BR Drop Map',      url: `${base}/fn-dropmap.html` },
          { key: 'compare',   scene: 'Comparison',      source: 'BR Comparison',    url: `${base}/fn-compare.html` },
          { key: 'victory',   scene: 'Victory Royale',  source: 'BR Victory Royale', url: `${base}/fn-victory.html` }
        ].filter((x) => !Array.isArray(d.only) || d.only.includes(x.key));

        const scenesRes = await ctx.obsClient.call('GetSceneList');
        const have = new Set((scenesRes.scenes || []).map((s) => s.sceneName));
        const inputsRes = await ctx.obsClient.call('GetInputList');
        const haveInput = new Set((inputsRes.inputs || []).map((i) => i.inputName));

        let made = 0, retargeted = 0;
        for (const item of pack) {
          const sceneName = `${prefix} — ${item.scene}`;
          const inputName = `${prefix} ${item.source}`;
          if (!have.has(sceneName)) { await ctx.obsClient.call('CreateScene', { sceneName }); have.add(sceneName); }
          if (haveInput.has(inputName)) {
            await ctx.obsClient.call('SetInputSettings', { inputName, inputSettings: { url: item.url } });
            retargeted++;
          } else {
            await ctx.obsClient.call('CreateInput', {
              sceneName, inputName, inputKind: 'browser_source',
              inputSettings: { url: item.url, width: 1920, height: 1080, reroute_audio: false }
            });
            haveInput.add(inputName);
            made++;
          }
        }
        ok = true;
        message = `BR pack ready in OBS — ${made} source(s) created, ${retargeted} retargeted, across ${pack.length} scene(s).`;
      } catch (e) { message = (e && e.message) || 'OBS error'; }
      try { ws.send(JSON.stringify({ type: 'obs-ensure-result', data: { ok, message } })); } catch (e) {}
    })();
  },

  // ── Live game-state ingest ───────────────────────────────────────────────
  // The single door any live feed comes in through — Apex LiveAPI today, Fortnite via the
  // Overwolf GEP relay once that lands, an OCR pass, or a partner API. Feeds push RESULTS and
  // this decides where they land (bound cup or standalone), so no feed ever has to know about
  // leagues, matrices or mirroring.
  //   { match, results: [{ team, placement, elims }], source }
  // Deliberately additive per team so a feed reporting one squad at a time works as well as
  // one reporting a whole final standings table.
  br_ingest_result(msg, ws) {
    const p = msg.data || {};
    const rows = Array.isArray(p.results) ? p.results
      : (p.team ? [{ team: p.team, placement: p.placement, elims: p.elims }] : []);
    if (!rows.length) return;
    const match = Math.max(1, Math.min(40, parseInt(p.match, 10) || (state.br.live && state.br.live.match) || 1));
    const target = brResolveSeries(p.leagueId, p.seriesId);
    const sink = target ? target.series.results : (state.br.results = state.br.results || []);
    let n = 0;
    for (const raw of rows.slice(0, 200)) {
      const team = String((raw && raw.team) || '').trim();
      if (!team) continue;
      const row = {
        match, team: team.slice(0, 80),
        placement: Math.max(0, parseInt(raw.placement, 10) || 0),
        elims: Math.max(0, parseInt(raw.elims, 10) || 0)
      };
      const i = sink.findIndex((r) => (parseInt(r.match, 10) || 0) === match
        && String(r.team || '').trim().toLowerCase() === team.toLowerCase());
      if (i >= 0) sink[i] = row; else sink.push(row);
      n++;
    }
    const src = ['live', 'sheets', 'manual'].includes(p.source) ? p.source : 'live';
    if (target) {
      target.series.source = src;
      recomputeBrSeason(target.lg);
      ctx.leaguesVer++;
      if (target.series.id === state.br.seriesId && target.lg.id === state.br.leagueId) brSyncFromLeague();
    } else {
      state.br.source = src;
    }
    computeBrStandings();
    state.br.lastIngest = { at: Date.now(), source: src, match, rows: n };
    saveAppState();
    broadcastFullState();
    logAuto('br', `Ingested ${n} result(s) for match ${match} from ${src}.`);
  },

  // Bind the live board to a league cup (or unbind with empty ids). Binding MIRRORS the cup
  // onto the board — including its scoring table, so switching cups switches the table too.
  set_br_league(msg, ws) {
    const p = msg.data || {};
    const lid = String(p.leagueId || '');
    const sid = String(p.seriesId || '');
    if (!lid || !sid) {
      state.br.leagueId = '';
      state.br.seriesId = '';
      state.br.source = 'manual';
    } else {
      const target = brResolveSeries(lid, sid);
      if (!target) {
        sendWs(ws, { type: 'event-result', data: { ok: false, message: 'That league cup no longer exists.' } });
        return;
      }
      state.br.leagueId = lid;
      state.br.seriesId = sid;
      brSyncFromLeague();
      // The league's teams ARE the season field — seed the lobby from them so binding a cup
      // gives you a board to score into immediately, without a second import step.
      if (p.fillLobby !== false && !(state.br.lobby || []).length) {
        brMergeLobby((target.lg.teams || []).map((t, i) => ({
          name: t.name, seed: i + 1,
          players: (t.players || []).map((pl) => ({ name: pl.name, epic: '' }))
        })));
      }
    }
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // Cup CRUD on a league. create/rename/delete/scoring — the season's shape.
  br_series(msg, ws) {
    const p = msg.data || {};
    const lg = (state.leagues || []).find((l) => l && l.id === String(p.leagueId || ''));
    if (!lg) return;
    // Season default matrix — a new cup in this league starts from it. Per-cup override wins.
if (typeof lg.brMatrixId !== 'string') lg.brMatrixId = '';
if (!Array.isArray(lg.brSeries)) lg.brSeries = [];
    const action = String(p.action || '');
    const idx = lg.brSeries.findIndex((s) => s && s.id === String(p.seriesId || ''));
    if (action === 'create') {
      if (lg.brSeries.length >= 60) return;
      const s = brNewSeries(p.name, p.matches);
      // Inherit the league's season default so a circuit doesn't need the matrix re-picked
      // every week. An explicit per-cup choice still overrides it afterwards.
      const seasonMx = findMatrix(p.matrixId || lg.brMatrixId);
      if (seasonMx) { s.matrixId = seasonMx.id; s.scoring = matrixToScoring(seasonMx); s.scoringPreset = 'matrix'; }
      lg.brSeries.push(s);
      // Deliberately does NOT bind. Adding next week's cup during this week's broadcast is
      // normal admin, and auto-binding would swap the on-air board out from under the
      // producer. Going live with a cup is the explicit "Go live with this cup" button.
      if (p.bind === true) { state.br.leagueId = lg.id; state.br.seriesId = s.id; brSyncFromLeague(); }
    } else if (action === 'delete' && idx >= 0) {
      const gone = lg.brSeries.splice(idx, 1)[0];
      if (gone && gone.id === state.br.seriesId) { state.br.leagueId = ''; state.br.seriesId = ''; state.br.source = 'manual'; }
    } else if (idx >= 0) {
      const s = lg.brSeries[idx];
      if (p.name != null) s.name = String(p.name).slice(0, 60);
      if (p.date != null) s.date = String(p.date).slice(0, 30);
      if (p.matches != null) s.matches = Math.max(1, Math.min(40, parseInt(p.matches, 10) || 6));
      // Where this cup's results come in from — manual, the scorekeeper's sheet, or a live feed.
      if (['manual', 'sheets', 'live'].includes(p.source)) s.source = p.source;
      if (p.sheetTab != null) s.sheetTab = String(p.sheetTab).slice(0, 80);
      // A preset change re-tables THIS cup only. Past cups keep their own snapshot.
      if (typeof p.scoringPreset === 'string' && BR_SCORING_PRESETS[p.scoringPreset]) {
        const pr = BR_SCORING_PRESETS[p.scoringPreset];
        s.scoringPreset = p.scoringPreset;
        s.scoring = { placementPoints: pr.placementPoints.slice(), killPoints: pr.killPoints, killCap: pr.killCap };
      }
      if (p.scoring && typeof p.scoring === 'object') {
        if (Array.isArray(p.scoring.placementPoints)) { s.scoring.placementPoints = p.scoring.placementPoints.slice(0, 100).map((n) => Math.max(0, Math.round(Number(n) || 0))); s.scoringPreset = 'custom'; }
        if (p.scoring.killPoints != null) { s.scoring.killPoints = Math.max(0, Number(p.scoring.killPoints) || 0); s.scoringPreset = 'custom'; }
        if (p.scoring.killCap != null) { s.scoring.killCap = Math.max(0, parseInt(p.scoring.killCap, 10) || 0); s.scoringPreset = 'custom'; }
      }
      if (s.id === state.br.seriesId && lg.id === state.br.leagueId) brSyncFromLeague();
    }
    recomputeBrSeason(lg);
    ctx.leaguesVer++;
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // Whole-field replace. Used by the panel's bulk paste and by anything that rebuilds the
  // lobby wholesale; single-entrant edits go through br_lobby_entrant so they can't race it.
  set_br_lobby(msg, ws) {
    const p = msg.data || {};
    if (Array.isArray(p.lobby)) {
      state.br.lobby = p.lobby.slice(0, 200).map(sanitizeBrEntrant).filter((e) => e.name);
      computeBrStandings();   // the board seeds from the lobby — a new field must re-derive it
      saveAppState();
      broadcastFullState();
    }
  },

  // Add / edit / remove ONE entrant. `id` present = edit that row; absent = add.
  br_lobby_entrant(msg, ws) {
    const p = msg.data || {};
    if (!Array.isArray(state.br.lobby)) state.br.lobby = [];
    const id = String(p.id || '').trim();
    const i = id ? state.br.lobby.findIndex((e) => e.id === id) : -1;
    if (p.remove) {
      if (i >= 0) state.br.lobby.splice(i, 1);
    } else {
      const prevName = i >= 0 ? state.br.lobby[i].name : '';
      const ent = sanitizeBrEntrant(i >= 0 ? { ...state.br.lobby[i], ...p } : p);
      // A duo pulled from a roster often has players but no entrant name — derive it rather
      // than dropping the row on the floor for failing the name check.
      if (!ent.name) ent.name = brNameFromPlayers(ent.players);
      if (!ent.name) return;
      if (i >= 0) {
        // Results are keyed by entrant NAME (that's all a sheet or a manual entry ever gives
        // us), so a rename would orphan every point that entrant has scored — the board would
        // silently show them back at zero next to a ghost row under the old name. Carry the
        // results and the player board across with them.
        if (prevName && prevName.toLowerCase() !== ent.name.toLowerCase()) {
          const from = prevName.toLowerCase();
          const relabel = (arr) => (arr || []).forEach((r) => {
            if (String(r.team || '').trim().toLowerCase() === from) r.team = ent.name;
          });
          relabel(state.br.results);
          relabel(state.br.playerResults);
          // When bound, the league is the store — rename there too, or the next mirror would
          // pull the old name straight back in and undo the fix.
          const b = brBinding();
          if (b) {
            relabel(b.series.results);
            recomputeBrSeason(b.lg);
            ctx.leaguesVer++;
          }
        }
        state.br.lobby[i] = ent;
      } else if (state.br.lobby.length < 200) {
        state.br.lobby.push(ent);
      }
    }
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // Drop assignments for the drop map. Sent as a whole { entrantId: poiIdOrText } map so a
  // producer dragging several plates around lands one coherent update, not a burst of races.
  set_br_drops(msg, ws) {
    const p = msg.data || {};
    const drops = (p.drops && typeof p.drops === 'object') ? p.drops : {};
    (state.br.lobby || []).forEach((e) => {
      if (Object.prototype.hasOwnProperty.call(drops, e.id)) e.drop = String(drops[e.id] || '').trim().slice(0, 40);
    });
    if (p.clearAll) (state.br.lobby || []).forEach((e) => { e.drop = ''; });
    computeBrStandings();
    saveAppState();
    broadcastFullState();
  },

  // Live counters + which entrant the observer is on. High-churn during a match, so this one
  // deliberately does NOT saveAppState() — it's this-moment state, restored as zero on boot.
  set_br_live(msg, ws) {
    const p = msg.data || {};
    const lv = state.br.live;
    if (p.match != null) lv.match = Math.max(1, Math.min(40, parseInt(p.match, 10) || 1));
    if (p.teamsAlive != null) lv.teamsAlive = Math.max(0, parseInt(p.teamsAlive, 10) || 0);
    if (p.playersAlive != null) lv.playersAlive = Math.max(0, parseInt(p.playersAlive, 10) || 0);
    if (p.focus != null) lv.focus = String(p.focus || '').slice(0, 40);
    if (typeof p.running === 'boolean') {
      lv.running = p.running;
      lv.startedAt = p.running ? Date.now() : 0;
    }
    // This message is high-churn (spectate focus changes constantly), so it does not save on
    // every call — but which MATCH the show is on is worth surviving a mid-event restart, and
    // saveAppState() is debounced, so persisting just that is cheap.
    if (p.match != null) saveAppState();
    broadcastFullState();
  },

  // Drop-map graphic.
  set_br_dropmap(msg, ws) {
    const p = msg.data || {};
    const dm = state.br.dropmap;
    if (p.title != null) dm.title = String(p.title).slice(0, 80);
    // Reject data URLs outright: state.br rides EVERY live broadcast (BROADCAST_TIERS), so a
    // pasted base64 map would put megabytes on the wire many times a second.
    if (p.mapUrl != null) {
      const u = String(p.mapUrl).trim();
      dm.mapUrl = /^data:/i.test(u) ? '' : u.slice(0, 400);
    }
    if (typeof p.showPlayers === 'boolean') dm.showPlayers = p.showPlayers;
    if (typeof p.showLogos === 'boolean') dm.showLogos = p.showLogos;
    if (typeof p.visible === 'boolean') {
      dm.visible = p.visible;
      setExclusiveGfxVisible('brdrop', p.visible);   // also drives gfx.html's layer
    }
    saveAppState();
    broadcastFullState();
  },

  // Comparison card. rows are free-form stat lines so the same graphic serves a BR duo
  // comparison and a Creative 1v1 without a schema change.
  set_br_compare(msg, ws) {
    const p = msg.data || {};
    const c = state.br.compare;
    const side = (o, prev) => ({
      name: String((o && o.name) != null ? o.name : prev.name).slice(0, 60),
      team: String((o && o.team) != null ? o.team : prev.team).slice(0, 60),
      sub:  String((o && o.sub)  != null ? o.sub  : prev.sub).slice(0, 60),
      // Same data-URL rule as the drop map — player photos come from start.gg as URLs.
      image: (function () {
        const v = (o && o.image) != null ? String(o.image) : prev.image;
        return /^data:/i.test(v) ? '' : v.slice(0, 400);
      })()
    });
    if (p.title != null) c.title = String(p.title).slice(0, 40);
    if (p.label != null) c.label = String(p.label).slice(0, 40);
    if (p.kind != null) c.kind = String(p.kind).slice(0, 20);
    if (p.footnote != null) c.footnote = String(p.footnote).slice(0, 80);
    if (p.a) c.a = side(p.a, c.a);
    if (p.b) c.b = side(p.b, c.b);
    if (Array.isArray(p.rows)) {
      c.rows = p.rows.slice(0, 8).map((r) => ({
        label: String((r && r.label) || '').slice(0, 30),
        a: String((r && r.a) != null ? r.a : '').slice(0, 20),
        b: String((r && r.b) != null ? r.b : '').slice(0, 20)
      })).filter((r) => r.label);
    }
    if (typeof p.visible === 'boolean') {
      c.visible = p.visible;
      setExclusiveGfxVisible('brcompare', p.visible);
    }
    saveAppState();
    broadcastFullState();
  },

  // Victory Royale slam. Fired by hand, or auto-filled from whoever placed 1st in a match.
  set_br_victory(msg, ws) {
    const p = msg.data || {};
    const v = state.br.victory;
    if (p.fromMatch) {
      // Auto-fill: read the winner straight off the derived result card so the graphic can
      // never disagree with the board sitting next to it on screen.
      const m = Math.max(1, parseInt(p.fromMatch, 10) || 1);
      const win = (state.br.results || [])
        .filter((r) => (parseInt(r.match, 10) || 0) === m && (parseInt(r.placement, 10) || 0) === 1)[0];
      if (win) {
        const ent = (state.br.lobby || []).find((e) => e.name.toLowerCase() === String(win.team || '').trim().toLowerCase());
        v.team = String(win.team || '');
        v.players = ent ? ent.players.map((pl) => pl.name) : [];
        v.elims = Math.max(0, parseInt(win.elims, 10) || 0);
        v.match = 'GAME ' + m;
        v.stage = state.br.event.match || state.br.event.split || '';
      }
    }
    if (p.team != null) v.team = String(p.team).slice(0, 80);
    if (Array.isArray(p.players)) v.players = p.players.slice(0, 8).map((n) => String(n || '').slice(0, 60)).filter(Boolean);
    if (p.stage != null) v.stage = String(p.stage).slice(0, 60);
    if (p.match != null) v.match = String(p.match).slice(0, 40);
    if (p.elims != null) v.elims = Math.max(0, parseInt(p.elims, 10) || 0);
    if (typeof p.visible === 'boolean') {
      v.visible = p.visible;
      v.at = p.visible ? Date.now() : 0;   // overlays key their slam animation off this
      setExclusiveGfxVisible('brvictory', p.visible);
    }
    broadcastFullState();
  },

  // Pull the FIELD from the tournament platform. Same entrant fetch the team import uses, so a
  // duo entrant arrives with both real gamertags attached rather than one typed team name.
  br_pull_field(msg, ws) {
    (async () => {
      const d = msg.data || {};
      try {
        if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
        const slug = parseEventSlug((d.eventSlug || d.slug || d.url || '').trim())
          || parseEventSlug(state.startgg.eventSlug || '');
        if (!slug) throw new Error('Paste a start.gg EVENT URL (…/event/…) or activate an event first.');
        const client = createStartGgClient(ctx.startggApiToken);
        const entrants = await fetchAllEntrants(client, slug);
        if (!entrants.length) throw new Error('That event has no entrants yet.');
        // mapEntrantsToTeams already normalises gamertags AND backfills the player-profile
        // registry (start.gg slug, country, photo) — reuse it so the lobby benefits from every
        // identity feature the rest of the app has instead of re-querying differently.
        const teams = mapEntrantsToTeams(entrants);
        const r = brMergeLobby(teams.map((t, i) => ({
          name: t.name,
          seed: i + 1,
          players: (t.players || []).map((p) => ({ name: p.name, epic: '' }))
        })), { replace: !!d.replace });
        state.br.game = isLobbyGame(state.activeGame) ? state.activeGame : state.br.game;
        computeBrStandings();
        saveAppState();
        broadcastFullState();
        sendWs(ws, { type: 'event-result', data: { ok: true,
          message: `Lobby field: ${r.added} added, ${r.updated} updated — ${r.total} entrant(s).` } });
      } catch (e) {
        sendWs(ws, { type: 'event-result', data: { ok: false, message: e.message } });
      }
    })();
  },

  // Manual path: send an in-app league's teams into the lobby. This is the one that has to work
  // for an offline/LAN event with no start.gg bracket behind it at all.
  br_lobby_from_league(msg, ws) {
    const d = msg.data || {};
    const lg = (state.leagues || []).find((l) => l.id === d.leagueId);
    if (!lg) {
      sendWs(ws, { type: 'event-result', data: { ok: false, message: 'League not found.' } });
      return;
    }
    const r = brMergeLobby((lg.teams || []).map((t, i) => ({
      name: t.name,
      seed: i + 1,
      players: (t.players || []).map((p) => ({ name: p.name, epic: '' }))
    })), { replace: !!d.replace });
    computeBrStandings();
    saveAppState();
    broadcastFullState();
    sendWs(ws, { type: 'event-result', data: { ok: true,
      message: `${lg.name || 'League'} → lobby: ${r.added} added, ${r.updated} updated (${r.total} total).` } });
  },

  // Build the scorekeeping tabs in the connected sheet and point the sync at them.
  br_sheet_template(msg, ws) {
    (async () => {
      try {
        const r = await brWriteSheetTemplate(msg.data || {});
        ws.send(JSON.stringify({ type: 'sheets-result', data: { ok: true, notify: true,
          message: 'Built "' + r.resultsTab + '" (' + r.rows + ' rows for ' + r.matches + ' matches) and "' + r.playersTab + '" — sync set to Import.' } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'sheets-result', data: { ok: false, notify: true, message: e.message } }));
      }
    })();
  },

  // Drop-map POIs. Stored inside the game's config bundle (so they export/import with a
  // Producer Profile like every other per-game content set) rather than in their own state key.
  // `pois: null` for a set deletes the override and falls back to the built-in seed table.
  set_br_pois(msg, ws) {
    const p = msg.data || {};
    const gameId = String(p.game || state.br.game || 'fortnite');
    const key = String(p.set || 'br-build');
    if (!GAMES[gameId]) return;
    const cfgs = { ...(state.gameConfigs || {}) };
    const bundle = { ...(cfgs[gameId] || { format: 'ne-game-config', game: gameId }) };
    const sets = { ...(bundle.pois || {}) };
    if (p.pois === null) {
      delete sets[key];
    } else if (Array.isArray(p.pois)) {
      sets[key] = {
        name: String(p.name || '').slice(0, 60),
        // A data-URL map image would ride every live broadcast via brMeta — same rule as
        // state.br.dropmap.mapUrl.
        map: /^data:/i.test(String(p.map || '')) ? '' : String(p.map || '').slice(0, 400),
        pois: p.pois.slice(0, 60).map((poi, i) => ({
          id: String((poi && poi.id) || ('poi' + (i + 1))).trim().slice(0, 40) || ('poi' + (i + 1)),
          name: String((poi && poi.name) || '').trim().slice(0, 40),
          x: Math.max(0, Math.min(100, Number((poi && poi.x)) || 0)),
          y: Math.max(0, Math.min(100, Number((poi && poi.y)) || 0))
        })).filter((poi) => poi.name)
      };
    } else return;
    bundle.pois = sets;
    cfgs[gameId] = bundle;
    state.gameConfigs = cfgs; ctx.gameConfigsVer++;
    saveAppState();
    broadcastFullState();
    sendWs(ws, { type: 'event-result', data: { ok: true,
      message: p.pois === null ? 'Reset to the built-in POI list.' : `Saved ${(sets[key] && sets[key].pois.length) || 0} POI(s).` } });
  },

  // ── Apex LiveAPI producer controls ───────────────────────────────────────
  apex_set_scoring(msg, ws) {
    const d = msg.data || {};
    if (Array.isArray(d.placementPoints)) state.apex.scoring.placementPoints = d.placementPoints.map((n) => Math.max(0, Math.round(Number(n) || 0)));
    if (d.killPoints != null) state.apex.scoring.killPoints = Math.max(0, Number(d.killPoints) || 0);
    recomputeApexBroadcast();
    saveAppState();
  },

  apex_set_teammap(msg, ws) {
    const d = msg.data || {};
    if (d.map && typeof d.map === 'object') state.apex.teamMap = d.map;                 // full replace
    else if (d.key != null) {                                                            // single entry
      if (d.savedName) state.apex.teamMap[String(d.key)] = String(d.savedName);
      else delete state.apex.teamMap[String(d.key)];
    }
    recomputeApexBroadcast();
    saveAppState();
  },

  apex_set_event(msg, ws) {
    const d = msg.data || {};
    state.apex.event = { title: String(d.title || ''), match: String(d.match || ''), split: String(d.split || '') };
    recomputeApexBroadcast();
    saveAppState();
  },

  apex_reset_series(msg, ws) {
    state.apex.games = [];
    if (ctx._apexAcc) ctx._apexAcc.games = [];
    ctx._apexGamesSig = '0';
    recomputeApexBroadcast();
    saveAppState();
  },

  apex_remove_game(msg, ws) {
    const idx = Number(msg.data && msg.data.index);
    if (!isNaN(idx) && state.apex.games[idx]) {
      state.apex.games.splice(idx, 1);
      state.apex.games.forEach((g, i) => { g.n = i + 1; });
      if (ctx._apexAcc) ctx._apexAcc.games = state.apex.games.map((g) => ({ ...g }));
      recomputeApexBroadcast();
      saveAppState();
    }
  },

  apex_finalize_game(msg, ws) {
    if (ctx._apexAcc && ctx._apexAcc.matchState !== 'postmatch' && Object.keys(ctx._apexAcc.squads).length) {
      apexLive.finalizeGame(ctx._apexAcc);
      ctx._apexAcc.matchState = 'postmatch';
      recomputeApexBroadcast();
      saveAppState();
    }
  },
};

module.exports = function createBattleRoyaleHandlers(c) {
  ctx = c;
  ({
    BR_DEFAULT_MODE, BR_SCORING_PRESETS, BR_TEAM_FORMATS, GAMES, HTTP_PORT, apexLive,
    brApplyScoringPreset, brBinding, brFormatSize, brMergeLobby, brModeMeta, brModesFor,
    brNameFromPlayers, brNewMatrixId, brNewSeries, brResolveSeries, brSyncFromLeague,
    brWriteSheetTemplate, broadcastFullState, computeBrStandings, createStartGgClient,
    fetchAllEntrants, findMatrix, isLobbyGame, logAuto, mapEntrantsToTeams, matrixToScoring,
    obsAppName, parseEventSlug, recomputeApexBroadcast, recomputeBrSeason, sanitizeBrEntrant,
    sanitizePointMatrix, saveAppState, sendWs, setExclusiveGfxVisible, state
  } = c);
  return handlers;
};
