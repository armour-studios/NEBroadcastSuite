'use strict';
// Battle royale (lobbies, results, point matrices, Apex) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_apexAcc, _apexGamesSig, gameConfigsVer, leaguesVer, miniGameManager, obsClient, startggApiToken).
let
  BH_REGIONS, BR_DEFAULT_MODE, BR_SCORING_PRESETS, BR_TEAM_FORMATS, GAMES, HTTP_PORT,
  announceGameResult, apexLive, brApplyScoringPreset, brBinding, brFormatSize, brMergeLobby,
  brModeMeta, brModesFor, brNameFromPlayers, brNewMatrixId, brNewSeries, brResolveSeries,
  brSyncFromLeague, brWriteSheetTemplate, bridgeClients, broadcast, broadcastFullState,
  buildLiveState, checkBrawlhallaGameOver, computeBrStandings, createStartGgClient,
  fetchAllEntrants, findMatrix, flowBus, gameTimers, isLobbyGame, logAuto, mapEntrantsToTeams,
  matrixToScoring, obsAppName, obsSwitch, parseEventSlug, recomputeApexBroadcast,
  recomputeBrSeason, refillBrawlhallaStocks, resolveClockTarget, sanitizeBrEntrant,
  sanitizePointMatrix, saveAppState, saveTwitchData, scheduleBreakAutoSwitch, sendWs,
  setExclusiveGfxVisible, state, syncActiveBracketPhase;
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

  // ── Break / "starting soon" standby (countdown scene) ────────────────
  // Partial updates merge. endsAt = epoch ms target (or null to clear the timer).
  set_break(msg, ws) {
    const b = msg.data || {};
    const cur = state.breakScreen || {};
    state.breakScreen = {
      visible: ('visible' in b) ? !!b.visible : !!cur.visible,
      title: typeof b.title === 'string' ? b.title : (cur.title ?? 'STARTING SOON'),
      message: typeof b.message === 'string' ? b.message : (cur.message ?? ''),
      finalMessage: typeof b.finalMessage === 'string' ? b.finalMessage : (cur.finalMessage ?? "WE'RE LIVE!"),
      // accept either an absolute endsAt, a `seconds` countdown from now, or a
      // `frozenSeconds` static value (paused producer timer). Running clears frozen.
      // `until: "23:00"` counts down to a wall-clock time; `seconds` counts down a duration;
      // `endsAt` is an absolute target; `frozenSeconds` is a paused static value.
      endsAt: ('frozenSeconds' in b) ? null
        : ('until' in b) ? resolveClockTarget(b.until)
        : ('seconds' in b) ? (b.seconds > 0 ? Date.now() + Math.round(b.seconds * 1000) : null)
        : ('endsAt' in b ? (b.endsAt || null) : (cur.endsAt ?? null)),
      frozenSeconds: ('frozenSeconds' in b) ? (b.frozenSeconds != null ? Math.max(0, Math.round(b.frozenSeconds)) : null)
        : (('seconds' in b || 'endsAt' in b || 'until' in b) ? null : (cur.frozenSeconds ?? null)),
      // Draw the title without a clock. Sticky like the other look settings: a bare timer
      // mirror ({seconds}/{frozenSeconds}) must not silently switch the clock back on.
      titleOnly: ('titleOnly' in b) ? !!b.titleOnly : !!cur.titleOnly,
      // OBS scene to auto-cut to when the countdown reaches 0 ('' = stay on the break screen).
      // Deliberately the ONLY thing a finished countdown can do: it never rolls a clip/ad playlist.
      thenScene: typeof b.thenScene === 'string' ? b.thenScene : (cur.thenScene ?? '')
    };
    // HIDE DISARMS THE CLOCK. Every consumer treats "break hidden" as "there is no countdown"
    // (the panel drops its mirror, the desk/replay/countdown-bar scenes blank their clock), but
    // the merge above kept `endsAt` alive through a Hide — leaving a half state the producer
    // could not see or clear. The counterpart to this is that those scenes no longer require
    // `visible`: the top-bar Start arms a segment clock WITHOUT putting the break GRAPHIC on
    // air, and that clock is exactly what the desk scenes borrow. Same reasoning as
    // scheduleBreakAutoSwitch: the timer is about the timer, not about which graphic is up.
    // Only a bare Hide clears it — a message that also sets a timer is setting one, not hiding one.
    if (b.visible === false && !('seconds' in b) && !('endsAt' in b) && !('until' in b) && !('frozenSeconds' in b)) {
      state.breakScreen.endsAt = null;
      state.breakScreen.frozenSeconds = null;
    }

    // Auto-start minigame when break screen becomes visible
    const wasVisible = cur.visible;
    const nowVisible = state.breakScreen.visible;
    // Keeps gfxActive in sync with .visible — see setExclusiveGfxVisible's own doc.
    if ('visible' in b) setExclusiveGfxVisible('break', nowVisible);

    if (!wasVisible && nowVisible && ctx.miniGameManager && state.twitch.minigame.settings.enabled) {
      // Break screen just turned on - auto-start a game
      const gameType = state.twitch.minigame.settings.breakScreenGameType || 'trivia';
      console.log('[Twitch] Auto-starting minigame on break screen:', gameType);

      // Create a default game based on type
      const _blueTeam   = state.teams?.blue?.name   || 'Blue';
      const _orangeTeam = state.teams?.orange?.name || 'Orange';
      const _triviaPool = [
        { q: 'How many players are on a Rocket League team?',       a: ['2', '3', '4', '5'],                                                  c: 1 },
        { q: 'How long is a standard Rocket League match?',          a: ['3 minutes', '4 minutes', '5 minutes', '6 minutes'],                  c: 2 },
        { q: 'What does RLCS stand for?',                             a: ['Rocket League Club Series', 'Rocket League Championship Series', 'Rocket League Cup Showdown', 'Rocket League Circuit Season'], c: 1 },
        { q: 'Which rank is the highest in Rocket League?',           a: ['Grand Champion', 'Champion', 'Diamond', 'Supersonic Legend'],        c: 3 },
        { q: 'How many goals are needed to win a standard RL match?', a: ['Most in 5 min', 'First to 5', 'First to 3', 'Most in 3 min'],        c: 0 },
        { q: 'What colour is the Rocket League logo?',                a: ['Blue', 'Red', 'Green', 'Orange'],                                    c: 0 },
        { q: `Who do you think will win this series — ${_blueTeam} or ${_orangeTeam}?`, a: [_blueTeam, _orangeTeam, 'Going to OT!', 'No idea!'], c: 0 },
      ];
      const _trivia = _triviaPool[Math.floor(Math.random() * _triviaPool.length)];

      let autoGame = null;
      if (gameType === 'trivia') {
        autoGame = ctx.miniGameManager.createTrivia(_trivia.q, _trivia.a, _trivia.c);
      } else if (gameType === 'prediction') {
        autoGame = ctx.miniGameManager.createPrediction(
          `Who will win — ${_blueTeam} or ${_orangeTeam}?`,
          [_blueTeam, _orangeTeam]
        );
      } else if (gameType === 'vote') {
        autoGame = ctx.miniGameManager.createVote(
          `Who do you think wins this series?`,
          [_blueTeam, _orangeTeam]
        );
      } else if (gameType === 'spin') {
        autoGame = ctx.miniGameManager.createSpin(['Sub Gift', '$10 Gift Card', 'Game Key', 'Shoutout']);
      }

      if (autoGame) {
        const gameId = autoGame.id;
        const duration = autoGame.duration || 30000;

        if (gameTimers.has(gameId)) clearTimeout(gameTimers.get(gameId));

        const timer = setTimeout(() => {
          if (ctx.miniGameManager && ctx.miniGameManager.currentGame?.id === gameId) {
            const result = ctx.miniGameManager.finalize();
            broadcastFullState();
            saveTwitchData();
            announceGameResult(result);
            console.log('[Twitch] Auto-game finalized');
            setTimeout(() => {
              if (state.twitch.minigame.current?.id === gameId) {
                state.twitch.minigame.current = null;
                broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
              }
            }, 10000);
          }
          gameTimers.delete(gameId);
        }, duration);

        gameTimers.set(gameId, timer);
      }
    }

    if (!wasVisible && nowVisible) flowBus.emit('break_shown', {});
    if (wasVisible && !nowVisible) flowBus.emit('break_hidden', {});
    saveAppState();
    broadcastFullState();
    obsSwitch(state.breakScreen.visible ? 'break' : 'inGame');
    scheduleBreakAutoSwitch();
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

  // ── Brawlhalla HUD (overlay/brawlhalla.html) ────────────────────────────────
  // NOTE: every `case` below keeps its body inside braces. A bare `let`/`const` between cases in
  // this switch is a silent TDZ ReferenceError for every case after it (see
  // test/switch-scope.test.js) — that is how reset_series was killed once already.
  set_brawlhalla_mode(msg, ws) {
    const m = (msg.data && msg.data.mode) === '2v2' ? '2v2' : '1v1';
    state.brawlhalla.mode = m;
    saveAppState();
    broadcastFullState();
  },

  set_brawlhalla_stocks(msg, ws) {
    const d = msg.data || {};
    if (d.side === 'blue' || d.side === 'orange') {
      const v = Math.max(0, Math.min(9, Math.round(Number(d.value) || 0)));
      const seat = Math.max(0, Math.min(1, Math.round(Number(d.seat) || 0)));
      if (state.brawlhalla.mode === '2v2') state.brawlhalla[d.side].players[seat].stocks = v;
      else state.brawlhalla[d.side].stocks = v;
      checkBrawlhallaGameOver();
      saveAppState();
      broadcastFullState();
    }
  },

  set_brawlhalla_legend(msg, ws) {
    const d = msg.data || {};
    if (d.side === 'blue' || d.side === 'orange') {
      const name = String(d.legend || '').slice(0, 40);
      const seat = Math.max(0, Math.min(1, Math.round(Number(d.seat) || 0)));
      if (state.brawlhalla.mode === '2v2') state.brawlhalla[d.side].players[seat].legend = name;
      else state.brawlhalla[d.side].legend = name;
      saveAppState();
      broadcastFullState();
    }
  },

  set_brawlhalla_start_stocks(msg, ws) {
    const v = Math.max(1, Math.min(9, Math.round(Number((msg.data || {}).value) || 3)));
    state.brawlhalla.startStocks = v;
    refillBrawlhallaStocks();
    saveAppState();
    broadcastFullState();
  },

  set_brawlhalla_options(msg, ws) {
    const d = msg.data || {};
    if ('autoAdvance' in d) state.brawlhalla.autoAdvance = !!d.autoAdvance;
    if ('showRank' in d) state.brawlhalla.showRank = !!d.showRank;
    if ('showLegend' in d) state.brawlhalla.showLegend = !!d.showLegend;
    if (typeof d.title === 'string') {
      state.brawlhalla.title = d.title.slice(0, 40);
      // Typing a label pins it; clearing the box hands the slot back to the auto-fill.
      state.brawlhalla.titleManual = !!state.brawlhalla.title;
    }
    if (typeof d.region === 'string' && BH_REGIONS.includes(d.region.toUpperCase())) state.brawlhalla.region = d.region.toUpperCase();
    if (d.rankMode === 'ranked_1v1' || d.rankMode === 'ranked_3v3') state.brawlhalla.rankMode = d.rankMode;
    if (d.railPos === 'auto' || d.railPos === 'topleft') state.brawlhalla.railPos = d.railPos;
    saveAppState();
    broadcastFullState();
  },

  // (set_watchlist / toggle_watchlist_team / set_team_spotlight migrated to the WS_HANDLERS registry above handleControlMessage)

  // ── Bracket ──────────────────────────────────────────────────────────
  set_bracket_settings(msg, ws) {
    const p = msg.data || {};
    if (typeof p.eventSlug === 'string') {
      state.bracket.eventSlug = p.eventSlug.trim();
      // Typing a slug that ISN'T the active event = explicit override → stop following the
      // active event. Clearing it (or matching the active event) resumes following.
      state.bracket.followActive = !state.bracket.eventSlug
        || state.bracket.eventSlug === (state.startgg.eventSlug || '').trim();
    }
    if (typeof p.visible === 'boolean') setExclusiveGfxVisible('bracket', p.visible);
    // Overlay view mode — drives the single bracket source + the live preview.
    if (typeof p.view === 'string' && ['both', 'winners', 'losers', 'finals', 'schedule', 'standings', 'matrix', 'swiss', 'group', 'pairings'].includes(p.view)) state.bracket.view = p.view;
    // 0 clears the override and hands the threshold back to the overlay's round-count default.
    ['swissAdvance', 'swissEliminate'].forEach((k) => {
      if (p[k] == null) return;
      const n = parseInt(p[k], 10);
      if (Number.isFinite(n) && n >= 0 && n <= 12) state.bracket[k] = n;
    });
    if (p.rounds != null) { const n = parseInt(p.rounds, 10); if (Number.isFinite(n) && n >= 1 && n <= 20) state.bracket.rounds = n; }
    if (typeof p.title === 'string') state.bracket.title = p.title.slice(0, 120);
    if (typeof p.subtitle === 'string') state.bracket.subtitle = p.subtitle.slice(0, 140);
    if (typeof p.showRecord === 'boolean') state.bracket.showRecord = p.showRecord;
    if (typeof p.swissColors === 'boolean') state.bracket.swissColors = p.swissColors;
    // Display filters: hide the grand-final RESET match, and/or hide the first N rounds (clean up a
    // wide bracket by dropping the early rounds). Applied at render time — the data stays intact.
    if (typeof p.ignoreReset === 'boolean') state.bracket.ignoreReset = p.ignoreReset;
    if (p.ignoreRounds != null) { const n = parseInt(p.ignoreRounds, 10); if (Number.isFinite(n) && n >= 0 && n <= 12) state.bracket.ignoreRounds = n; }
    if (typeof p.hideLogos === 'boolean') state.bracket.hideLogos = p.hideLogos;
    if (typeof p.logoWatermark === 'boolean') state.bracket.logoWatermark = p.logoWatermark;
    if (p.watermarkOpacity != null) { const n = parseInt(p.watermarkOpacity, 10); if (Number.isFinite(n) && n >= 0 && n <= 40) state.bracket.watermarkOpacity = n; }
    saveAppState();
    broadcastFullState();
    if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
  },

  // Manually-built bracket (no start.gg). Writes the same winners/losers/finals
  // shape the bracket overlay already renders.
  // Manual builder is the source of truth for its phases — it sends the whole set.
  set_bracket_phases(msg, ws) {
    const p = msg.data || {};
    if (Array.isArray(p.phases)) state.bracket.phases = p.phases;
    if (p.activePhaseId != null) state.bracket.activePhaseId = p.activePhaseId;
    if (typeof p.title === 'string') state.bracket.title = p.title;
    if (Array.isArray(p.teams)) state.bracket.teams = p.teams;     // [{name,logo}] for overlay logos
    state.bracket.matches = [];
    state.bracket.eventSlug = '';      // manual mode is not start.gg-backed
    state.bracket.mode = 'manual';     // the in-app builder now owns these phases — no external clobber
    state.bracket.source = '';
    state.bracket.lastFetchAt = Date.now();
    syncActiveBracketPhase();          // mirror the active phase to the top-level overlay fields
    if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
    saveAppState();
    broadcastFullState();
    if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
  },
};

module.exports = function createBattleRoyaleHandlers(c) {
  ctx = c;
  ({
    BH_REGIONS, BR_DEFAULT_MODE, BR_SCORING_PRESETS, BR_TEAM_FORMATS, GAMES, HTTP_PORT,
    announceGameResult, apexLive, brApplyScoringPreset, brBinding, brFormatSize, brMergeLobby,
    brModeMeta, brModesFor, brNameFromPlayers, brNewMatrixId, brNewSeries, brResolveSeries,
    brSyncFromLeague, brWriteSheetTemplate, bridgeClients, broadcast, broadcastFullState,
    buildLiveState, checkBrawlhallaGameOver, computeBrStandings, createStartGgClient,
    fetchAllEntrants, findMatrix, flowBus, gameTimers, isLobbyGame, logAuto,
    mapEntrantsToTeams, matrixToScoring, obsAppName, obsSwitch, parseEventSlug,
    recomputeApexBroadcast, recomputeBrSeason, refillBrawlhallaStocks, resolveClockTarget,
    sanitizeBrEntrant, sanitizePointMatrix, saveAppState, saveTwitchData,
    scheduleBreakAutoSwitch, sendWs, setExclusiveGfxVisible, state, syncActiveBracketPhase
  } = c);
  return handlers;
};
