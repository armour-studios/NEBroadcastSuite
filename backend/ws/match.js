'use strict';
// The match: teams on air, series score, best-of, game number, active game and player — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_csManualSwapKey, _smashGameClosed, savedTeams).
let
  GAMES, abbrForTeamName, applyActiveGame, broadcastFullState, cleanTeamAbbr, csCinematicApply,
  csGameTeamsKey, entrantOrgName, finalizeAndResetSeries, gameDefaultColors, persistMatchCrest,
  rebuildCombinedPlayers, resetOvertimeTrigger, retuneRoundLabel, saveAppState, state,
  swapTeamSides, vetoDraws;
let ctx;

const handlers = {
  set_default_bo(msg, ws) {
    if (typeof msg.data.bestOf === 'number') state.defaultBestOf = msg.data.bestOf;
    saveAppState();
  },

  set_follow_set_game(msg, ws) {
    state.followSetGame = !!(msg.data && msg.data.enabled);
    saveAppState();
    broadcastFullState();
  },

  // ── Game & overlay design (theme) ────────────────────────────────────
  set_active_game(msg, ws) {
    const g = msg.data?.game;
    if (g && GAMES[g]) {
      applyActiveGame(g);
      csCinematicApply();
      saveAppState();
      broadcastFullState();
    }
  },

  set_team(msg, ws) {
    if (msg.data.side === 'blue' || msg.data.side === 'orange') {
      // A DIFFERENT team arriving without a roster or colour (bracket Go Live, platform sync
      // buttons, the matchup picker) must not inherit the previous team's players and brand
      // colour through the spread below: that is how a stale roster rode onto the facecam rows.
      // Resolve both from the library when the name is a saved team, else fall back to an empty
      // roster and the side's per-game default colour. Same-name writes (abbr/logo edits) keep
      // everything, exactly as before.
      {
        const prevName = String((state.teams[msg.data.side] || {}).name || '').trim().toLowerCase();
        const newName = String(msg.data.name || '').trim().toLowerCase();
        if (newName && newName !== prevName) {
          // The team library is the module-level savedTeams — state.savedTeams is never assigned,
          // so this lookup always missed and a new team arriving without a roster got none.
          const lib = (ctx.savedTeams || []).find((t) => t && String(t.name || '').trim().toLowerCase() === newName);
          // A copy: the match roster gets mutated (vdoStreamId backfill, edits) and must not write
          // through to the saved library team.
          if (!Array.isArray(msg.data.players)) msg.data.players = (lib && Array.isArray(lib.players)) ? lib.players.map((p) => (p && typeof p === 'object' ? { ...p } : p)) : [];
          if (typeof msg.data.color !== 'string') {
            const def = gameDefaultColors(state.activeGame);
            msg.data.color = (lib && typeof lib.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(lib.color))
              ? lib.color : (msg.data.side === 'blue' ? def.a : def.b);
          }
        }
      }
      // Preserve color/players already set for this side
      state.teams[msg.data.side] = {
        ...state.teams[msg.data.side],
        name: msg.data.name || '',
        logo: msg.data.logo || null
      };
      // Carry the saved team's own colour when one is provided (so Team colour-mode reflects it).
      if (typeof msg.data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.data.color)) {
        state.teams[msg.data.side].color = msg.data.color;
      }
      // Abbreviation: the tag typed on the card wins; blank or absent (queue clicks, bracket Go
      // Live, auto-fill) re-resolves from the library for whoever is NOW on this side, so the
      // spread above can never carry the previous team's tag forward.
      state.teams[msg.data.side].abbr = cleanTeamAbbr(msg.data.abbr) || abbrForTeamName(msg.data.name);
      // Optional roster (e.g. picking a seeded start.gg team) → feeds the facecam rows.
      if (Array.isArray(msg.data.players)) {
        state.teams[msg.data.side].players = msg.data.players;
        // New roster → reset the active/on-air player to the first (avoids a stale id).
        state.activePlayer[msg.data.side] = '';
        if (state.observedPlayer && state.observedPlayer.side === msg.data.side) state.observedPlayer = { side: '', playerId: '' };
        rebuildCombinedPlayers();
      }
      // The org is DERIVED from whoever is now on this side, never inherited from whoever was
      // here before. No caller sends one, so spreading the old team forward kept the previous
      // entrant's sponsor: put Agency | Morris on a side and every later unsponsored player on
      // that half read "AGENCY DREDAWG". state.teams[].org feeds exactly two things - the smash
      // and camera-scene sponsor lines, both of which take the roster's shared prefix when
      // start.gg supplies one - so rebuilding it from the roster is the whole truth.
      state.teams[msg.data.side].org = (typeof msg.data.org === 'string')
        ? msg.data.org.trim()
        : entrantOrgName(state.teams[msg.data.side].players || []);
      // Only the Match > Teams logo controls set this (upload / media library / Default). Every
      // other set_team caller - bracket Go Live, queue clicks, swaps - passes the crest it READ,
      // which may itself be stale, so those must never write into the vault.
      if (msg.data.logoChanged === true) persistMatchCrest(msg.data.side);
      retuneRoundLabel();   // producer swapped a side — the pushed set's round may no longer apply
      saveAppState();
      broadcastFullState();
    }
  },

  // Which roster member is the one on the overlay for a side (FGC 1v1 within a multi-player
  // team). playerId '' → the side's first player. The FGC scoreboard reads state.activePlayer.
  set_active_player(msg, ws) {
    if (msg.data && (msg.data.side === 'blue' || msg.data.side === 'orange')) {
      state.activePlayer[msg.data.side] = String(msg.data.playerId || '');
      saveAppState();
      broadcastFullState();
    }
  },

  // Which player the in-game observer is spectating (one across both sides). Empty playerId or
  // no side clears it — the overlay then hides its player plate.
  set_observed_player(msg, ws) {
    const d = msg.data || {};
    const ok = (d.side === 'blue' || d.side === 'orange') && d.playerId;
    state.observedPlayer = ok ? { side: d.side, playerId: String(d.playerId) } : { side: '', playerId: '' };
    saveAppState();
    broadcastFullState();
  },

  adjust_series(msg, ws) {
    if (msg.data.side === 'blue' || msg.data.side === 'orange') {
      state.series[msg.data.side] = Math.max(0, Math.min(Math.ceil(state.bestOf / 2), state.series[msg.data.side] + (msg.data.delta || 0)));
      // Auto-advance the current game to (games played + 1) so producers don't
      // have to bump BOTH the series win and the game number.
      const played = (state.series.blue || 0) + (state.series.orange || 0) + vetoDraws();
      state.game.number = Math.max(1, Math.min(state.bestOf, played + 1));
      saveAppState();
      broadcastFullState();
    }
  },

  // Series/match editor: format, division, per-map results.
  set_match(msg, ws) {
    const p = msg.data || {};
    if (typeof p.format === 'string') {
      state.match.format = p.format;
      const bo = { bo1: 1, bo3: 3, bo5: 5, bo7: 7 }[p.format];
      if (bo) state.bestOf = bo;   // keep the legacy best-of in sync with the format
    }
    if (typeof p.seriesVisible === 'boolean') state.match.seriesVisible = p.seriesVisible;
    if (typeof p.division === 'string') state.match.division = p.division;
    if (Array.isArray(p.maps)) {
      state.match.maps = p.maps.slice(0, 9).map((m) => ({
        name: typeof m.name === 'string' ? m.name : '',
        scoreA: Math.max(0, Number(m.scoreA) || 0),
        scoreB: Math.max(0, Number(m.scoreB) || 0),
        played: !!m.played
      }));
    }
    saveAppState();
    broadcastFullState();
  },

  set_best_of(msg, ws) {
    state.bestOf = msg.data.value || 5;
    state.game.number = Math.min(state.game.number, state.bestOf);
    state.series.blue = Math.min(state.series.blue, Math.ceil(state.bestOf / 2));
    state.series.orange = Math.min(state.series.orange, Math.ceil(state.bestOf / 2));
    // Keep the series FORMAT string in step with the global best-of. set_match already syncs the
    // other direction (format → bestOf); without this the reverse drifts, so anything reading
    // match.format — the Lineup card's "Format" row — kept showing a stale BO3 after the producer
    // changed best-of from the Scorecard or Map Pool. Only rewrite an EXISTING bo-style format:
    // if they deliberately set Format to "None" (''), leave that row switched off.
    const curFmt = (state.match && state.match.format) || '';
    const nextFmt = { 1: 'bo1', 3: 'bo3', 5: 'bo5', 7: 'bo7' }[state.bestOf];
    if (nextFmt && /^bo\d+$/i.test(curFmt)) state.match.format = nextFmt;
    saveAppState();
    broadcastFullState();
  },

  adjust_game_number(msg, ws) {
    state.game.number = Math.max(1, Math.min(state.bestOf, state.game.number + (msg.data.delta || 0)));
    saveAppState();
    broadcastFullState();
  },

  reset_series(msg, ws) {
    ctx._smashGameClosed = false;
    finalizeAndResetSeries();
    saveAppState();
    broadcastFullState();
  },

  swap_teams(msg, ws) {
    swapTeamSides();
    // CS2 with auto team names: the next GSI tick would put the game's names straight back and
    // leave the logos crossed. Hold the producer's swap until the game reports different names.
    if (state.activeGame === 'csgo' && state.autoTeamsFromGame) ctx._csManualSwapKey = csGameTeamsKey();
    saveAppState();
    broadcastFullState();
  },

  reset_all(msg, ws) {
    state.eventName = '';
    state.eventNameSlug = '';
    state.fontFamily = 'Industry';
    state.banner = { ...state.banner, visible: false };
    // The prompt promises a reset of MATCH data. The caster library, VDO rooms, shifts, staff and
    // API key, and the banner / ticker content are set-up that outlives a match — replacing those
    // objects wholesale used to wipe all of it. Clear only what belongs to the show on the desk.
    state.casters = { ...state.casters, visible: true, list: [], lowerThird: '', lineup: [], autoFillSuppress: [] };
    state.breakScreen = { visible: false, title: 'STARTING SOON', message: '', endsAt: null };
    state.ticker = { ...state.ticker, visible: false };
    state.spotlight = { visible: false, playerName: '' };
    state.winner = { visible: false, side: '', name: '', logo: null, color: '', subtitle: '' };
    state.intro  = { visible: false, side: 'blue', title: '', style: 1, showFooter: false };
    state.veto   = { visible: false, title: state.veto.title || '', maps: [] };
    state.draft  = { ...state.draft, visible: false, ops: [], turn: null, complete: false };
    state.bestOf = 5;
    state.teams = {
      blue:   { name: 'BLUE TEAM',   logo: null, color: '#055fdb', abbr: null },
      orange: { name: 'ORANGE TEAM', logo: null, color: '#e97139', abbr: null }
    };
    state.series = { blue: 0, orange: 0 };
    state.game = { blueScore: 0, orangeScore: 0, time: 300, isOT: false, number: 1 };
    resetOvertimeTrigger();
    state.awaitingKickoff = false;
    state.view = 'hud';
    state.playerCache = {};
    state.players = [];

    saveAppState();
    broadcastFullState();
  },
};

module.exports = function createMatchHandlers(c) {
  ctx = c;
  ({
    GAMES, abbrForTeamName, applyActiveGame, broadcastFullState, cleanTeamAbbr,
    csCinematicApply, csGameTeamsKey, entrantOrgName, finalizeAndResetSeries,
    gameDefaultColors, persistMatchCrest, rebuildCombinedPlayers, resetOvertimeTrigger,
    retuneRoundLabel, saveAppState, state, swapTeamSides, vetoDraws
  } = c);
  return handlers;
};
