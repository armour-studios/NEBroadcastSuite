'use strict';
// Leagues — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (leaguesVer).
let
  brBinding, brSyncFromLeague, broadcastFullState, computeBrStandings, lgCaptureFinalize,
  migrateLeague, recomputeBrSeason, refreshCompetitionFeed, refreshLeagueStandingsMirror,
  saveAppState, state;
let ctx;

const handlers = {
  // Edit a team's standing directly in an in-app league (from the Match — Teams box when
  // Team Record source = In-app). Writes back to the league standings so it updates there too.
  set_league_team_record(msg, ws) {
    const d = msg.data || {};
    const lg = (state.leagues || []).find((l) => String(l.id) === String(d.leagueId));
    if (!lg) return;
    const key = String(d.teamName || '').trim().toLowerCase();
    const team = (lg.teams || []).find((t) => String(t.teamName || t.name || '').trim().toLowerCase() === key);
    if (!team) return;
    if (!Array.isArray(lg.standings)) lg.standings = [];
    let st = lg.standings.find((s) => s.teamId === team.id);
    if (!st) { st = { teamId: team.id, w: 0, l: 0, pts: 0 }; lg.standings.push(st); }
    ['w', 'l', 'pts'].forEach((k) => { if (k in d && d[k] !== '' && d[k] != null) st[k] = Math.max(0, parseInt(d[k], 10) || 0); });
    ctx.leaguesVer++;
    saveAppState();
    broadcastFullState();
  },

  // Leagues are control-panel-authoritative: the editor pushes the whole list. Validate/normalize
  // every incoming league (migrate to the current shape, cap oversized logos, dedupe ids) rather
  // than trusting the payload verbatim — this is the single write path for the whole feature.
  set_leagues(msg, ws) {
    const incoming = msg.data && msg.data.leagues;
    if (Array.isArray(incoming)) {
      const LEAGUES_MAX = 200;
      const capped = incoming.length > LEAGUES_MAX ? incoming.slice(0, LEAGUES_MAX) : incoming;
      if (incoming.length > LEAGUES_MAX) {
        console.warn(`[leagues] set_leagues payload had ${incoming.length} leagues — truncated to ${LEAGUES_MAX}.`);
      }
      const seenIds = new Set();
      const cleaned = [];
      for (const raw of capped) {
        if (!raw || typeof raw !== 'object') continue;
        const lg = migrateLeague(raw);
        if (seenIds.has(lg.id)) { console.warn(`[leagues] dropped duplicate league id "${lg.id}" in set_leagues payload.`); continue; }
        seenIds.add(lg.id);
        // brSeason is DERIVED — rebuild it from the incoming cups rather than trusting whatever
        // rollup the client happened to be carrying, so the season table can never disagree
        // with the results it is supposed to summarise.
        recomputeBrSeason(lg);
        cleaned.push(lg);
      }
      state.leagues = cleaned;
      ctx.leaguesVer++;
      // Self-heal the BR binding the same way the armed capture is healed below: if the bound
      // league or cup was deleted client-side, unbind rather than leaving the live board
      // pointed at a cup that no longer exists. Still there → re-mirror, since the client may
      // have edited that cup's results or scoring on the league page.
      if (state.br.leagueId || state.br.seriesId) {
        if (!brBinding()) {
          state.br.leagueId = ''; state.br.seriesId = ''; state.br.source = 'manual';
        } else {
          brSyncFromLeague();
        }
        computeBrStandings();
      }
      // Self-heal: if the armed capture points at a league/match that no longer exists, disarm.
      const cap = state.leagueCapture;
      if (cap && cap.active) {
        const lg = cleaned.find((l) => l.id === cap.leagueId);
        if (!lg || !(lg.schedule || []).some((m) => m.id === cap.matchId)) {
          state.leagueCapture = { active: false, leagueId: '', matchId: '', aSide: 'blue', teamA: '', teamB: '', bestOf: 5, games: [], startedAt: 0, lastNote: '' };
        }
      }
      // A League-sourced standings board follows this league's points live — recording a result
      // now updates the on-air board instead of leaving the snapshot it was pushed with.
      refreshLeagueStandingsMirror();
      // ...and so does everything following the live competition (ticker, schedule, BRB).
      refreshCompetitionFeed();
    }
    saveAppState();
    broadcastFullState();
  },

  // ── Spectated-match → league capture (producer-armed) ────────────────────
  // Arm: record the NEXT spectated series into a specific league fixture. aSide maps the live blue/
  // orange scores onto the fixture's A/B by matching the current on-air team names (default blue=A).
  league_capture_arm(msg, ws) {
    const d = msg.data || {};
    const lg = (state.leagues || []).find((l) => l.id === d.leagueId);
    const m = lg && (lg.schedule || []).find((x) => x.id === d.matchId);
    if (!lg || !m) { return; }
    const nm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const teamName = (id, raw) => { const tm = (lg.teams || []).find((t) => t.id === id); return tm ? (tm.teamName || tm.name || '') : (raw || ''); };
    const aName = teamName(m.teamA, m.sggTeamA), bName = teamName(m.teamB, m.sggTeamB);
    // Map live sides to A/B: if the ORANGE on-air team matches fixture A (or blue matches B), flip.
    const blueNm = nm(state.teams.blue && state.teams.blue.name), orangeNm = nm(state.teams.orange && state.teams.orange.name);
    let aSide = 'blue';
    if ((orangeNm && orangeNm === nm(aName)) || (blueNm && blueNm === nm(bName))) aSide = 'orange';
    state.leagueCapture = {
      active: true, leagueId: lg.id, matchId: m.id, aSide,
      teamA: aName || 'Team A', teamB: bName || 'Team B', bestOf: state.bestOf || Number((m.format || 'BO5').replace(/\D/g, '')) || 5,
      games: [], startedAt: Date.now(),
      lastNote: `Armed — recording into ${aName} vs ${bName}. Finish the games; it saves when the series clinches.`
    };
    refreshCompetitionFeed();   // the armed fixture reads LIVE on the ticker / schedule
    saveAppState();
    broadcastFullState();
  },

  league_capture_save(msg, ws) {
    lgCaptureFinalize('saved by producer');
  },

  league_capture_stop(msg, ws) {
    state.leagueCapture = { active: false, leagueId: '', matchId: '', aSide: 'blue', teamA: '', teamB: '', bestOf: 5, games: [], startedAt: 0, lastNote: '' };
    refreshCompetitionFeed();
    saveAppState();
    broadcastFullState();
  },

  // Player-leaderboard overlay board (state.leagueLeaderboard) — same generic columns/rows shape as
  // set_league_stats, but its own overlay + state slot so team stats and the leaderboard can run
  // as two independent OBS sources at once.
  set_league_leaderboard(msg, ws) {
    const p = msg.data || {};
    if (typeof p.visible === 'boolean') state.leagueLeaderboard.visible = p.visible;
    if (typeof p.title === 'string') state.leagueLeaderboard.title = p.title.slice(0, 80);
    if (typeof p.subtitle === 'string') state.leagueLeaderboard.subtitle = p.subtitle.slice(0, 120);
    if (Array.isArray(p.columns)) state.leagueLeaderboard.columns = p.columns.slice(0, 16);
    if (Array.isArray(p.rows)) state.leagueLeaderboard.rows = p.rows.slice(0, 30);
    saveAppState();
    broadcastFullState();
  },
};

module.exports = function createLeagueHandlers(c) {
  ctx = c;
  ({
    brBinding, brSyncFromLeague, broadcastFullState, computeBrStandings, lgCaptureFinalize,
    migrateLeague, recomputeBrSeason, refreshCompetitionFeed, refreshLeagueStandingsMirror,
    saveAppState, state
  } = c);
  return handlers;
};
