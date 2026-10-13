// backend/platforms/challengermode.js — moved out of server.js (refactor step 3) unchanged; server.js creates it once
// with createChallengermode(ctx). ctx carries stable references plus live getters (ctx.<name>) for values
// server.js replaces at runtime, and set_<name>(v) for the ones this code writes.
module.exports = function createChallengermode(ctx) {
  const { https, createChallengermodeClient, cmData, state, saveTeams, adoptEventGame, pollLoop, saveAppState, pushEntrantToSide, broadcastFullState } = ctx;
  const parseChallengermodeId = (...a) => ctx.parseChallengermodeId(...a);   // created later in server.js: resolved on call
  const retuneRoundLabel = (...a) => ctx.retuneRoundLabel(...a);   // created later in server.js: resolved on call
  const syncActiveBracketPhase = (...a) => ctx.syncActiveBracketPhase(...a);   // created later in server.js: resolved on call
  const adoptEventName = (...a) => ctx.adoptEventName(...a);   // created later in server.js: resolved on call

// ─── Challengermode integration ──────────────────────────────────────────────
// challengermode.com — NOT Challonge. GraphQL, bot-token auth, stage-based tournaments.
// Queries + mapping live in backend/challengermode.js; this is the state/lifecycle half.

let _cmClient = null;
let _cmClientKey = '';
function challengermodeClient() {
  // Rebuild when the key changes so a re-paste takes effect without a relaunch (server.js runs in
  // the Electron main process, so a stale client would otherwise survive until the app restarts).
  if (!_cmClient || _cmClientKey !== ctx.challengermodeRefreshKey) {
    _cmClient = createChallengermodeClient(ctx.challengermodeRefreshKey);
    _cmClientKey = ctx.challengermodeRefreshKey;
  }
  return _cmClient;
}

async function fetchChallengermodeTournament(id, { live = false } = {}) {
  const data = await challengermodeClient().query(
    live ? cmData.TOURNAMENT_LIVE_QUERY : cmData.TOURNAMENT_QUERY, { id });
  const t = data && data.tournament;
  if (!t) throw new Error('No Challengermode tournament with that id, or the bot cannot see it. A private tournament needs the bot linked to its Space.');
  return t;
}

// Apply a fetched tournament to the bracket/queue/placement state. Shared by load and refresh so
// the two can never drift into showing different things from the same payload.
function applyChallengermodeTournament(t, { full }) {
  const phases = cmData.mapStages(t);
  state.challengermode.queue = cmData.buildQueue(t);
  state.challengermode.matchFeed = cmData.buildMatchFeed(t);
  state.challengermode.queueFetchedAt = Date.now();
  state.challengermode.connected = true;
  state.challengermode.lastError = null;
  state.challengermode.lastSyncAt = new Date().toISOString();

  const pl = cmData.buildPlacements(t, 8);
  state.challengermodePlacements = { id: t.id, rows: pl.rows, complete: pl.complete, fetchedAt: Date.now(), error: '' };

  if (full) {
    const teams = cmData.buildEventTeams(t);
    state.challengermode.eventTeams = teams;
    const logoMap = {};
    teams.forEach((x) => { if (x.logo) logoMap[x.name.toLowerCase()] = x.logo; });
    state.challengermode.logoMap = logoMap;
    state.bracket.teams = teams.filter((x) => x.logo).map((x) => ({ name: x.name, logo: x.logo }));
  }

  if (phases.length) {
    state.bracket.phases = phases;
    // Keep the producer on the stage they were watching; fall back to the LAST stage with matches,
    // because that is the one being played (groups finish before playoffs start).
    const keep = phases.find((p) => p.id === state.bracket.activePhaseId);
    state.bracket.activePhaseId = keep ? keep.id : phases[phases.length - 1].id;
  }
  state.bracket.standings = cmData.buildStandings(t);
  state.bracket.lastFetchAt = Date.now();
  syncActiveBracketPhase();
}

async function loadChallengermodeTournament(rawId) {
  const id = parseChallengermodeId(rawId) || String(rawId || '').trim();
  if (!id) throw new Error('Paste a Challengermode tournament link or id.');
  const t = await fetchChallengermodeTournament(id, { live: false });

  state.challengermode.tournamentId = id;
  const gameName = (t.gameTitle && (t.gameTitle.title || t.gameTitle.slug)) || '';
  state.challengermode.selectedTournament = {
    id: t.id,
    name: t.name || '',
    state: t.state || '',
    gameName,
    gameSlug: (t.gameTitle && t.gameTitle.slug) || '',
    lineupCount: (((t.attendance || {}).roster || {}).lineupCount) || 0,
    url: `https://www.challengermode.com/tournaments/${id}`
  };

  state.activeEvent = {
    platform: 'challengermode',
    slug: id,
    name: t.name || '',
    gameName,
    numEntrants: state.challengermode.selectedTournament.lineupCount,
    format: (t.stages && t.stages.length ? String(t.stages[t.stages.length - 1].format || '') : ''),
    url: state.challengermode.selectedTournament.url,
    loadedAt: new Date().toISOString()
  };
  adoptEventName(id, t.name);
  // Same rule as every other platform: the tournament knows its game, so follow it onto that
  // game's overlay rather than leaving whatever was active. Challengermode's slug ("rocket-league",
  // "counter-strike-2") resolves cleanly through backend/game-match.js.
  const adopted = adoptEventGame((t.gameTitle && t.gameTitle.slug) || gameName);
  state.challengermode.gameId = adopted.id;
  state.challengermode.gameApplied = adopted.changed;
  ctx.setActivePlatform('challengermode');   // silence the other platforms' auto-follow

  // Auto-import entrants into the saved team library, same as the other loaders.
  cmData.buildEventTeams(t).forEach((x) => {
    if (!x.name) return;
    if (!ctx.savedTeams.find((s) => s.name.toLowerCase() === x.name.toLowerCase())) {
      ctx.savedTeams.push({ name: x.name, logo: x.logo || null, players: [] });
    }
  });
  saveTeams();

  state.bracket.title = t.name || 'Bracket';
  state.bracket.matches = [];
  state.bracket.eventSlug = 'challengermode:' + id;
  state.bracket.mode = 'imported';
  state.bracket.source = 'challengermode';
  applyChallengermodeTournament(t, { full: true });
  saveAppState();
  broadcastFullState();
  return {
    name: t.name || '',
    teamsCount: state.challengermode.eventTeams.length,
    matchesCount: cmData.allSeries(t).length,
    stages: (t.stages || []).length,
    game: gameName
  };
}

async function refreshChallengermodeLive() {
  const id = (state.challengermode.tournamentId || '').trim();
  if (!id || !ctx.challengermodeRefreshKey) return;
  try {
    const t = await fetchChallengermodeTournament(id, { live: true });
    applyChallengermodeTournament(t, { full: false });
    if (state.challengermode.selectedTournament) state.challengermode.selectedTournament.state = t.state || '';

    if (state.challengermode.autoFollow) {
      const liveMatch = state.challengermode.queue.find((m) => m.live);
      if (liveMatch && liveMatch.matchId !== state.challengermode.lastAutoFollowMatchId
          && liveMatch.teamA && liveMatch.teamA !== 'TBD' && liveMatch.teamB && liveMatch.teamB !== 'TBD') {
        state.challengermode.lastAutoFollowMatchId = liveMatch.matchId;
        const teams = state.challengermode.eventTeams || [];
        const rosterFor = (name) => {
          const hit = teams.find((x) => x.name.toLowerCase() === String(name || '').toLowerCase());
          return hit ? hit.players : [];
        };
        const opts = { logoMap: state.challengermode.logoMap, platform: 'challengermode' };
        pushEntrantToSide('blue', liveMatch.teamA, liveMatch.logoA, { ...opts, roster: rosterFor(liveMatch.teamA) });
        pushEntrantToSide('orange', liveMatch.teamB, liveMatch.logoB, { ...opts, roster: rosterFor(liveMatch.teamB) });
        // The series is a best-of; following it without the format leaves the scorebar on the
        // previous match's Bo, which is wrong on screen the moment the first game ends.
        if (liveMatch.bestOf) state.bestOf = Math.max(1, Math.min(9, Number(liveMatch.bestOf)));
        saveAppState();
      }
    }
    // Re-bind an auto round label to whoever is on air now (or clear a stale one).
    retuneRoundLabel();

    // A board following this platform keeps following it as the bracket resolves. Producer-typed
    // rows are keyed by name and must survive the re-mirror.
    if ((state.standings.source || '') === 'challengermode-placements') {
      const keep = {};
      (state.standings.rows || []).forEach((r) => { if (r && r.name) keep[String(r.name).toLowerCase()] = r; });
      state.standings.rows = state.challengermodePlacements.rows.map((r) => {
        const prev = keep[String(r.name).toLowerCase()] || {};
        return { ...prev, placement: r.placement, placementText: r.placementText,
                 name: r.name, logo: r.logo || prev.logo || null,
                 players: (r.players && r.players.length) ? r.players : (prev.players || []),
                 character: prev.character || '' };
      });
    }
    broadcastFullState();
  } catch (e) {
    state.challengermode.connected = false;
    state.challengermode.lastError = e.message;
    broadcastFullState();
    throw e;
  }
}

let _cmPollTimer = null;
function setChallengermodePolling(enabled) {
  if (_cmPollTimer) { _cmPollTimer.stop(); _cmPollTimer = null; }
  if (enabled && ctx.challengermodeRefreshKey && (state.challengermode.tournamentId || '').trim()) {
    const sec = Math.max(10, Math.min(600, Number(state.challengermode.pollSec) || 30));
    _cmPollTimer = pollLoop('challengermode', () => refreshChallengermodeLive().catch((e) => { console.warn('[challengermode]', e.message); throw e; }), sec * 1000, { runNow: true });
  }
}


  return { challengermodeClient, setChallengermodePolling, loadChallengermodeTournament, refreshChallengermodeLive, fetchChallengermodeTournament };
};
