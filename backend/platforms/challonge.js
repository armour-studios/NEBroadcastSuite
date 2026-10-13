// backend/platforms/challonge.js — moved out of server.js (refactor step 3) unchanged; server.js creates it once
// with createChallonge(ctx). ctx carries stable references plus live getters (ctx.<name>) for values
// server.js replaces at runtime, and set_<name>(v) for the ones this code writes.
module.exports = function createChallonge(ctx) {
  const { https, createChallongeClient, GAMES, state, saveTeams, adoptEventGame, pollLoop, saveAppState, broadcastFullState } = ctx;
  const retuneRoundLabel = (...a) => ctx.retuneRoundLabel(...a);   // created later in server.js: resolved on call
  const syncActiveBracketPhase = (...a) => ctx.syncActiveBracketPhase(...a);   // created later in server.js: resolved on call
  const adoptEventName = (...a) => ctx.adoptEventName(...a);   // created later in server.js: resolved on call

// ─── Challonge integration ───────────────────────────────────────────────────

function challongePartMap(participants) {
  const map = {};
  participants.forEach((p) => {
    const d = p.participant;
    map[d.id] = {
      name: d.display_name || d.name || `Participant ${d.id}`,
      logo: d.attached_participatable_portrait_url || null,
      seed: d.seed || 0,
      challongeId: d.id,
      finalRank: d.final_rank || null
    };
  });
  return map;
}

function challongeBracketType(type) {
  if (!type) return 'SINGLE_ELIMINATION';
  const t = type.toLowerCase();
  if (t.includes('double')) return 'DOUBLE_ELIMINATION';
  if (t.includes('round robin')) return 'ROUND_ROBIN';
  if (t.includes('swiss')) return 'SWISS';
  return 'SINGLE_ELIMINATION';
}

/*
  Standings for a Challonge bracket — for EVERY format, not just round robin.

  Challonge gives two different truths and they answer different questions:
    · participant.final_rank  the REAL finish order, with the ties a bracket actually produces
                              (1, 2, 3, 4, 5, 5, 7, 7). It fills in progressively as players are
                              eliminated, so a running event already has its lower placings.
    · match results           W/L, which is all you have for the players still alive.
  So: rank by final_rank where it exists, and fall back to W/L for everyone still in. Sorting an
  elimination bracket by wins alone is what puts a losers-run runner-up above the champion.
*/
function challongeStandings(partMap, matches) {
  const rec = {};
  Object.values(partMap).forEach((p) => {
    rec[p.challongeId] = { name: p.name, logo: p.logo || null, seed: p.seed || 0,
                           finalRank: p.finalRank || 0, wins: 0, losses: 0, gameWins: 0, gameLosses: 0 };
  });
  matches.forEach((m) => {
    const d = m.match;
    if (d.state !== 'complete' || !d.winner_id) return;
    const w = rec[d.winner_id];
    const loserId = d.winner_id === d.player1_id ? d.player2_id : d.player1_id;
    const l = rec[loserId];
    if (w) w.wins++;
    if (l) l.losses++;
    // Per-GAME totals (a Bo5 won 3-1 is 3 game wins), so a points-style board has real numbers.
    const csv = String(d.scores_csv || '').trim();
    if (!csv) return;
    let g1 = 0, g2 = 0;
    csv.split(',').forEach((g) => {
      const mm = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(g);
      if (!mm) return;
      const a = parseInt(mm[1], 10), b = parseInt(mm[2], 10);
      if (a > b) g1++; else if (b > a) g2++;
    });
    const p1 = rec[d.player1_id], p2 = rec[d.player2_id];
    if (p1) { p1.gameWins += g1; p1.gameLosses += g2; }
    if (p2) { p2.gameWins += g2; p2.gameLosses += g1; }
  });

  const rows = Object.values(rec);
  rows.sort((a, b) => {
    // A known finish beats any inference, and finishing 3rd beats finishing 5th.
    if (a.finalRank && b.finalRank) return a.finalRank - b.finalRank;
    if (a.finalRank) return 1;       // ranked = ELIMINATED, so they sit below everyone still alive
    if (b.finalRank) return -1;
    return (b.wins - a.wins) || (a.losses - b.losses) || ((a.seed || 999) - (b.seed || 999));
  });
  return rows.map((r, i) => ({
    placement: r.finalRank || (i + 1),
    name: r.name, logo: r.logo, wins: r.wins, losses: r.losses,
    gameWins: r.gameWins, gameLosses: r.gameLosses
  }));
}

/*
  The TOP 8 board's rows: real finish order only.

  Distinct from challongeStandings() on purpose. Standings will happily rank the field with an
  inference for anyone still playing, because a standings board is allowed to be provisional. A
  top-8 graphic is not — it states "this is how the event finished", so it draws ONLY from
  final_rank and reports how far along it is. `complete` says every one of the top N has a real
  placement; until then the panel can show what there is and say so.
*/
function challongePlacements(partMap, limit = 8) {
  const ranked = Object.values(partMap).filter((p) => p.finalRank > 0)
    .sort((a, b) => a.finalRank - b.finalRank)
    .slice(0, limit)
    .map((p) => ({ placement: p.finalRank, name: p.name, logo: p.logo || null, seed: p.seed || 0,
                   // Mirrors the start.gg placement row shape so the same Top 8 builder,
                   // the same overlay and the same push path handle both platforms.
                   entrantId: p.challongeId, players: [], countryCode: '', character: '' }));
  const fieldSize = Object.keys(partMap).length;
  return { rows: ranked, complete: ranked.length >= Math.min(limit, fieldSize) };
}

/*
  Split a Challonge participant name into an org tag and a player name.

  Challonge has no prefix field — a 1v1 entrant is typed free-hand, and the convention every
  fighting-game TO uses is "TAG | Player". Splitting it is what lets the head-to-head name plates,
  the FGC skins and the Smash/Brawlhalla boards print an org the way they do for start.gg, where
  the prefix arrives as its own field.
*/
function challongeSplitName(raw) {
  const str = String(raw || '').trim();
  const m = /^(.{1,20}?)\s*[|｜]\s*(.+)$/.exec(str);
  if (m) return { prefix: m[1].trim(), name: m[2].trim() };
  return { prefix: '', name: str };
}

function buildChalongeBracket(tournament, participants, matches) {
  const partMap = challongePartMap(participants);
  const getName = (id) => (id ? (partMap[id]?.name || `#${id}`) : 'TBD');
  const type = challongeBracketType(tournament.tournament_type);

  // Challonge's scores_csv is PER GAME, comma separated: a Bo5 comes back "3-1,2-3,3-0".
  // Splitting the whole string on '-' (what this used to do) read "3-1,2-3" as ["3","1,2","3"] and
  // put 3-0 on the bracket for a 2-1 series — every multi-game set on every fighting-game bracket
  // we draw. Count GAMES WON when the set has more than one game; a single-game set is its own
  // score (a 13-7 Valorant map is the score, not "1-0").
  //
  // A negative number is Challonge's forfeit marker ("-1-0"), so the split has to tolerate a
  // leading '-' on either side rather than assuming two clean integers.
  const GAME_RE = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/;
  function parseScore(match) {
    const csv = String(match.scores_csv || '').trim();
    if (!csv) return { aScore: 0, bScore: 0 };
    const games = csv.split(',').map((g) => GAME_RE.exec(g)).filter(Boolean)
      .map((m) => ({ a: parseInt(m[1], 10), b: parseInt(m[2], 10) }));
    if (!games.length) return { aScore: 0, bScore: 0 };
    if (games.length === 1) return { aScore: games[0].a, bScore: games[0].b };
    let a = 0, b = 0;
    games.forEach((g) => { if (g.a > g.b) a++; else if (g.b > g.a) b++; });
    return { aScore: a, bScore: b };
  }

  if (type === 'ROUND_ROBIN' || type === 'SWISS') {
    const roundMap = {};
    matches.forEach((m) => {
      const d = m.match;
      const r = Math.abs(d.round);
      if (!roundMap[r]) roundMap[r] = [];
      const { aScore, bScore } = parseScore(d);
      roundMap[r].push({ a: { name: getName(d.player1_id), score: aScore, winner: d.winner_id === d.player1_id }, b: { name: getName(d.player2_id), score: bScore, winner: d.winner_id === d.player2_id } });
    });
    const schedule = Object.keys(roundMap).map(Number).sort((a, b) => a - b).map((r) => ({ name: 'Round ' + r, sets: roundMap[r] }));
    const roster = Object.values(partMap).sort((a, b) => (a.seed || 99) - (b.seed || 99)).map((p) => p.name);
    return { type, winners: [], losers: [], finals: [], standings: challongeStandings(partMap, matches), schedule, roster };
  }

  // Elimination: positive round = winners side, negative = losers side.
  const winnersMap = {}, losersMap = {};
  let maxWR = -Infinity;
  matches.forEach((m) => {
    const d = m.match;
    const r = d.round;
    const { aScore, bScore } = parseScore(d);
    const set = { a: { name: getName(d.player1_id), score: aScore, winner: d.winner_id === d.player1_id }, b: { name: getName(d.player2_id), score: bScore, winner: d.winner_id === d.player2_id } };
    if (r >= 0) { if (!winnersMap[r]) winnersMap[r] = []; winnersMap[r].push(set); if (r > maxWR) maxWR = r; }
    else { if (!losersMap[r]) losersMap[r] = []; losersMap[r].push(set); }
  });

  let finals = [];
  if (type === 'DOUBLE_ELIMINATION' && maxWR > 0 && winnersMap[maxWR]) {
    finals = [{ name: 'Grand Final', sets: winnersMap[maxWR] }];
    delete winnersMap[maxWR];
  }

  const wKeys = Object.keys(winnersMap).map(Number).sort((a, b) => a - b);
  const totalW = wKeys.length;
  const winners = wKeys.map((r, idx) => {
    let name;
    if (type === 'DOUBLE_ELIMINATION') {
      name = idx === totalW - 1 ? "Winners Final" : idx === totalW - 2 ? "Winners Semifinal" : "Winners Round " + r;
    } else {
      name = idx === totalW - 1 ? "Grand Final" : idx === totalW - 2 ? "Semifinal" : "Round " + r;
    }
    return { name, sets: winnersMap[r] };
  });

  const lKeys = Object.keys(losersMap).map(Number).sort((a, b) => b - a);
  const losers = lKeys.map((r) => ({ name: 'Losers Round ' + Math.abs(r), sets: losersMap[r] }));

  return { type, winners, losers, finals, standings: challongeStandings(partMap, matches), schedule: [], roster: [] };
}

/*
  Put one platform entrant on a side of the scoreboard. Shared by every tournament platform.

  This is the "works across games" half of a platform integration. A team game only needs the name
  and the crest, but a 1v1 game (Smash, Brawlhalla, every FGC title, EA FC) draws the PLAYER and
  their org from the side's ROSTER — SceneBase.soloIdentity and the head-to-head name plates read
  teams[side].players[0], not the team name. Setting only the name left every 1v1 board with a
  blank plate, which is why a platform could look like it "didn't work" for fighting games.

  So: always set name + logo, and for a 1v1 game also seed a one-player roster from the entrant,
  splitting the "TAG | Player" convention into an org prefix and a player name.

  `roster` (optional) is the platform's own member list, used in preference to splitting the
  entrant name — Challengermode gives us real usernames, so there is no need to guess from a
  string. An existing roster is left alone when it already names the same player: a producer may
  have filled in country, socials or a camera assignment, and none of that should be thrown away
  because the poller came round again.
*/
function pushEntrantToSide(side, rawName, logo, opts = {}) {
  const name = String(rawName || '').trim();
  const logoMap = opts.logoMap || {};
  const teamLogo = logo || logoMap[name.toLowerCase()] || null;
  state.teams[side] = { ...state.teams[side], name, logo: teamLogo };
  const game = GAMES[state.activeGame] || {};
  const isSolo = game.format === '1v1' || Number(game.rosterSize) === 1;
  if (!isSolo || !name) return;
  // Prefer the platform's own roster over parsing the entrant name.
  const member = Array.isArray(opts.roster) && opts.roster.length
    ? String((opts.roster[0] && (opts.roster[0].name || opts.roster[0])) || '').trim() : '';
  const split = member ? { prefix: '', name: member } : challongeSplitName(name);
  const existing = (state.teams[side].players || [])[0];
  if (existing && String(existing.name || '').toLowerCase() === split.name.toLowerCase()) return;
  state.teams[side].players = [{
    id: Math.random().toString(36).slice(2, 11),
    name: split.name, platform: opts.platform || 'challonge', platformId: '', assignedCamera: null,
    country: '', countryCode: '', prefix: split.prefix, realName: ''
  }];
  // A new roster invalidates whichever member was pinned as the on-air one.
  state.activePlayer[side] = '';
}

function buildChallongeQueue(partMap, matches) {
  return matches
    .filter((m) => ['open', 'pending'].includes(m.match.state))
    .sort((a, b) => (a.match.suggested_play_order || 0) - (b.match.suggested_play_order || 0))
    .map((m) => {
      const d = m.match;
      const csv = (d.scores_csv || '').split('-').map((s) => parseInt(s) || 0);
      return {
        matchId: d.id, round: d.round, identifier: d.identifier,
        state: d.state, live: d.state === 'open',
        teamA: partMap[d.player1_id]?.name || 'TBD',
        teamB: partMap[d.player2_id]?.name || 'TBD',
        logoA: partMap[d.player1_id]?.logo || null,
        logoB: partMap[d.player2_id]?.logo || null,
        scoreA: csv[0] || 0, scoreB: csv[1] || 0,
        player1ChallongeId: d.player1_id,
        player2ChallongeId: d.player2_id
      };
    });
}

/*
  Count Challonge requests against the calendar month.

  Challonge's free plan is 500 requests per MONTH, and the grace period on that ended 6 July 2026 —
  past it, a free app over the limit gets 429s. Our live poll costs THREE requests (tournament +
  participants + matches), so a 30s poll is ~86,000 a month: a free key runs out in under four
  hours of broadcasting. That is not something a producer should discover from a dead bracket
  mid-show, so we count it and show it. We do NOT block on it — it is their quota to spend, and a
  paid plan has a much larger allowance — but the number is visible before the 429 arrives.
*/
function challongeSpend(n = 1) {
  const b = state.challonge.budget || (state.challonge.budget = { month: '', used: 0, limit: 500, warned: false });
  const month = new Date().toISOString().slice(0, 7);   // YYYY-MM
  if (b.month !== month) { b.month = month; b.used = 0; b.warned = false; }
  b.used += n;
  if (!b.warned && b.limit && b.used >= b.limit * 0.8) {
    b.warned = true;
    console.warn(`[challonge] ${b.used}/${b.limit} requests used this month. Challonge's free plan cuts off at ${b.limit}/month (429 after that) — raise the poll interval in Settings or upgrade the Challonge plan.`);
  }
}

async function fetchChallongeTournamentData(slug) {
  const client = createChallongeClient(ctx.challongeApiKey);
  challongeSpend(3);
  const [tData, pData, mData] = await Promise.all([
    client.get(`/tournaments/${slug}.json`),
    client.get(`/tournaments/${slug}/participants.json`),
    client.get(`/tournaments/${slug}/matches.json`)
  ]);
  return { tournament: tData.tournament, participants: pData, matches: mData };
}

async function loadChalongeTournament(slug) {
  const { tournament, participants, matches } = await fetchChallongeTournamentData(slug);
  const partMap = challongePartMap(participants);

  // Auto-import participants into the saved team library
  Object.values(partMap).forEach(p => {
    if (!ctx.savedTeams.find(t => t.name.toLowerCase() === p.name.toLowerCase())) {
      ctx.savedTeams.push({ name: p.name, logo: p.logo || null, players: [] });
    }
  });
  saveTeams();

  const eventTeams = Object.values(partMap).sort((a, b) => (a.seed || 99) - (b.seed || 99)).map((p) => ({
    name: p.name, logo: p.logo, seed: p.seed, challongeId: p.challongeId, finalRank: p.finalRank
  }));
  const logoMap = {};
  eventTeams.forEach((t) => { if (t.logo) logoMap[t.name.toLowerCase()] = t.logo; });

  state.challonge.eventTeams = eventTeams;
  state.challonge.logoMap = logoMap;
  state.challonge.selectedTournament = {
    id: tournament.id, slug: tournament.url, name: tournament.name,
    url: tournament.full_challonge_url, type: tournament.tournament_type,
    state: tournament.state, participantsCount: tournament.participants_count,
    gameName: tournament.game_name || ''
  };
  state.challonge.tournamentSlug = slug;
  state.challonge.connected = true;
  state.challonge.lastError = null;
  state.challonge.lastSyncAt = new Date().toISOString();
  state.challonge.queue = buildChallongeQueue(partMap, matches);
  state.activeEvent = {
    platform: 'challonge',
    slug,
    name: tournament.name,
    gameName: tournament.game_name || '',
    numEntrants: participants.length,
    format: tournament.tournament_type || '',
    url: tournament.full_challonge_url || `https://challonge.com/${slug}`,
    logo: '',   // Challonge tournaments have no logo
    loadedAt: new Date().toISOString()
  };
  adoptEventName(slug, tournament.name);
  ctx.setActivePlatform('challonge');   // this is now the active platform — silence start.gg / NXGEN follow
  // THE thing that makes Challonge multi-game: Challonge tags every tournament with a game, so
  // loading one lands us on that game's overlay, labels, roster size and colours. Without this a
  // Brawlhalla bracket went on air wearing whatever game was already active.
  const adopted = adoptEventGame(tournament.game_name);
  state.challonge.gameId = adopted.id;
  state.challonge.gameApplied = adopted.changed;
  state.challonge.queueFetchedAt = Date.now();
  // Real finish order for the top-8 board. Challonge fills final_rank progressively as players are
  // eliminated, so a running event already has its lower placings.
  const pl = challongePlacements(partMap, 8);
  state.challongePlacements = { slug, rows: pl.rows, complete: pl.complete, fetchedAt: Date.now(), error: '' };

  // Apply bracket to state.bracket
  const bd = buildChalongeBracket(tournament, participants, matches);
  const teams = eventTeams.filter((t) => t.logo).map((t) => ({ name: t.name, logo: t.logo }));
  state.bracket.phases = [{ id: 'challonge-main', name: tournament.name || 'Bracket', type: bd.type, winners: bd.winners, losers: bd.losers, finals: bd.finals, standings: bd.standings, schedule: bd.schedule, roster: bd.roster }];
  state.bracket.activePhaseId = 'challonge-main';
  state.bracket.title = tournament.name || 'Bracket';
  state.bracket.teams = teams;
  state.bracket.matches = [];
  state.bracket.eventSlug = 'challonge:' + slug;
  state.bracket.mode = 'imported';
  state.bracket.source = 'challonge';
  state.bracket.lastFetchAt = Date.now();
  syncActiveBracketPhase();
  broadcastFullState();
  return { name: tournament.name, teamsCount: eventTeams.length, matchesCount: matches.length };
}

async function refreshChallongeLive() {
  const slug = (state.challonge.tournamentSlug || '').trim();
  if (!slug || !ctx.challongeApiKey) return;
  try {
    const { tournament, participants, matches } = await fetchChallongeTournamentData(slug);
    // Switched tournaments while this was out: the old one's bracket must not land over the new one.
    if ((state.challonge.tournamentSlug || '').trim() !== slug) return;
    const partMap = challongePartMap(participants);
    state.challonge.queue = buildChallongeQueue(partMap, matches);
    state.challonge.queueFetchedAt = Date.now();
    state.challonge.connected = true;
    state.challonge.lastError = null;
    // Auto-follow: push teams to scoreboard when a match goes live
    if (state.challonge.autoFollow) {
      const live = state.challonge.queue.find(m => m.live);
      if (live && live.matchId !== state.challonge.lastAutoFollowMatchId) {
        state.challonge.lastAutoFollowMatchId = live.matchId;
        if (live.teamA && live.teamA !== 'TBD') {
          const opts = { logoMap: state.challonge.logoMap, platform: 'challonge' };
          pushEntrantToSide('blue', live.teamA, live.logoA, opts);
          pushEntrantToSide('orange', live.teamB, live.logoB, opts);
          saveAppState();
        }
      }
    }
    // Re-bind an auto round label to whoever is on air now (or clear a stale one from a previous
    // event/platform). No-op for a hand-typed label.
    retuneRoundLabel();
    // Finish order, and — when the board on air is following it — re-mirror the rows so a top 8
    // resolves itself live instead of freezing at push time. Same contract as start.gg's
    // refreshStartggPlacements(), including preserving anything the producer typed by hand.
    const pl = challongePlacements(partMap, 8);
    state.challongePlacements = { slug, rows: pl.rows, complete: pl.complete, fetchedAt: Date.now(), error: '' };
    if ((state.standings.source || '') === 'challonge-placements') {
      const keep = {};
      (state.standings.rows || []).forEach((r) => { if (r && r.name) keep[String(r.name).toLowerCase()] = r; });
      state.standings.rows = pl.rows.map((r) => {
        const prev = keep[String(r.name).toLowerCase()] || {};
        // A fighter/character the producer set by hand is theirs — Challonge never reports one,
        // so re-mirroring must never blank it.
        return { ...prev, placement: r.placement, name: r.name, logo: r.logo || prev.logo || null,
                 character: prev.character || '' };
      });
    }
    // Refresh bracket scores
    const bd = buildChalongeBracket(tournament, participants, matches);
    const existingPhase = state.bracket.phases.find((p) => p.id === 'challonge-main');
    if (existingPhase) {
      existingPhase.winners = bd.winners;
      existingPhase.losers = bd.losers;
      existingPhase.finals = bd.finals;
      state.bracket.lastFetchAt = Date.now();
      syncActiveBracketPhase();
    }
    broadcastFullState();
  } catch (e) {
    state.challonge.connected = false;
    state.challonge.lastError = e.message;
    broadcastFullState();
    throw e;
  }
}

let _challongePollTimer = null;
function setChallongePolling(enabled) {
  if (_challongePollTimer) { _challongePollTimer.stop(); _challongePollTimer = null; }
  if (enabled && ctx.challongeApiKey && (state.challonge.tournamentSlug || '').trim()) {
    const tick = () => refreshChallongeLive().catch((e) => { console.warn('[challonge]', e && e.message); throw e; });   // rethrown so pollLoop backs off
    const sec = Math.max(15, Math.min(600, Number(state.challonge.pollSec) || 30));
    _challongePollTimer = pollLoop('challonge', tick, sec * 1000, { runNow: true });
  }
}


  return { challongePlacements, pushEntrantToSide, setChallongePolling, loadChalongeTournament, refreshChallongeLive, challongePartMap };
};
