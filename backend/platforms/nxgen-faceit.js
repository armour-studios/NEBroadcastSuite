// backend/platforms/nxgen-faceit.js — moved out of server.js (refactor step 3) unchanged; server.js creates it once
// with createNxgenFaceit(ctx). ctx carries stable references plus live getters (ctx.<name>) for values
// server.js replaces at runtime, and set_<name>(v) for the ones this code writes.
module.exports = function createNxgenFaceit(ctx) {
  const { https, getNxgenEventLive, faceit, state, adoptEventGame, pollLoop, saveAppState, touchMyEvents, upsertPlayerProfile, finalizeAndResetSeries, formatTickerFeed, setStartggQueuePolling, setChallongePolling, setChallengermodePolling, broadcastFullState } = ctx;
  const logoForTeamName = (...a) => ctx.logoForTeamName(...a);   // created later in server.js: resolved on call
  const retuneRoundLabel = (...a) => ctx.retuneRoundLabel(...a);   // created later in server.js: resolved on call
  const syncActiveBracketPhase = (...a) => ctx.syncActiveBracketPhase(...a);   // created later in server.js: resolved on call
  const fetchEventSeeding = (...a) => ctx.fetchEventSeeding(...a);   // created later in server.js: resolved on call
  const adoptEventName = (...a) => ctx.adoptEventName(...a);   // created later in server.js: resolved on call
  const pickEventImage = (...a) => ctx.pickEventImage(...a);   // created later in server.js: resolved on call

// ─── NXGEN integration ────────────────────────────────────────────────────────

// NXGEN puts the participant INLINE on each match — match.participant1 is { id, name }, not the
// id it was originally read as, so every imported set resolved to TBD/TBD (empty bracket, no
// teams for the graphics). Accept both shapes, and fall back to the participants list for a logo.
function nxgenPartMap(participants) {
  const pm = {};
  (participants || []).forEach(p => { if (p && p.id) pm[p.id] = p; });
  return pm;
}
function nxgenSide(ref, pm) {
  if (!ref) return { id: null, name: '', logo: null };
  const isObj = typeof ref === 'object';
  const id = isObj ? (ref.id || null) : ref;
  const full = (id && pm[id]) || {};
  const name = (isObj ? ref.name : '') || full.name || '';
  // NXGEN participants usually carry no logoUrl at all — fall back to the saved team library so
  // queue rows, the bracket and the pushed graphics still get a crest.
  return { id, name, logo: (isObj && ref.logoUrl) || full.logoUrl || logoForTeamName(name) || null };
}
const NXGEN_LIVE_STATUSES = ['in-progress', 'in_progress', 'live', 'active', 'ongoing'];

// NXGEN mints EVERY match of a bracket the moment it's generated, so a live event is full of
// unplayed shells with both sides null. They belong in the bracket drawing — that is the shape of
// the rounds still to come — but not in the stream queue, where they read as "TBD vs TBD" rows
// (17 of 28 on a real 20-team event) that a producer can never play.
function nxgenEmptyShell(m) { return !m || (!m.participant1 && !m.participant2); }

// The bracket overlay and the panel both read start.gg's numeric set state (1 = not started,
// 2 = in progress, 3 = complete) — 1 is what mutes an unplayed match. NXGEN ships a status
// STRING, so every imported set fell through as neither upcoming nor complete.
function nxgenSetState(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return 3;
  if (NXGEN_LIVE_STATUSES.includes(s)) return 2;
  return 1;
}

// An unplayed NXGEN match still carries scores of 0, and 0 draws as a real "0 – 0" on the bracket
// instead of the "–" that says "not played yet". Only report a score once the match has a winner,
// a completed status, or an actual score on the board.
function nxgenScores(m) {
  const sc = m.scores || {};
  const a = Number(sc.participant1) || 0, b = Number(sc.participant2) || 0;
  const played = String(m.status || '').toLowerCase() === 'completed' || !!m.winnerId || !!a || !!b;
  return played ? [a, b] : [null, null];
}

function buildNxgenQueue(participants, matches) {
  const pm = nxgenPartMap(participants);
  return (matches || [])
    .filter(m => m.status !== 'completed' && !nxgenEmptyShell(m))
    .map(m => {
      const p1 = nxgenSide(m.participant1, pm);
      const p2 = nxgenSide(m.participant2, pm);
      const [sa, sb] = nxgenScores(m);
      return {
        matchId: m._id,
        round: m.round,
        matchNumber: m.matchNumber,
        teamA: p1.name || 'TBD',
        teamB: p2.name || 'TBD',
        logoA: p1.logo,
        logoB: p2.logo,
        scoreA: sa,
        scoreB: sb,
        status: m.status,
        live: NXGEN_LIVE_STATUSES.includes(String(m.status || '').toLowerCase()),
        winnerId: m.winnerId || null
      };
    });
}

// The scores ticker, in the SAME item shape start.gg's matchFeed uses (mapStartggSetToFeedItem),
// so overlay/app.js renders an NXGEN event with the identical LIVE/FINAL cards — logo, team,
// score, team, logo — instead of needing a second layout.
// Composition matches buildStartggMatchFeed too: LIVE matches lead, then the most recent FINALS
// fill up to a target length, so a bracket that is nearly done still has a ticker with content.
function buildNxgenMatchFeed(participants, matches) {
  const pm = nxgenPartMap(participants);
  const live = [], done = [];
  (matches || []).forEach(m => {
    const p1 = nxgenSide(m.participant1, pm);
    const p2 = nxgenSide(m.participant2, pm);
    if (!p1.name || !p2.name) return;              // a half-empty shell is not a fixture yet
    const status = String(m.status || '').toLowerCase();
    const isLive = NXGEN_LIVE_STATUSES.includes(status);
    const isDone = status === 'completed';
    if (!isLive && !isDone) return;
    let [sa, sb] = nxgenScores(m);
    // NXGEN records plenty of finished matches as 0-0 with only a winnerId. "FINAL A 0-0 B" reads
    // as a result nobody won, so drop to the winner-only form the start.gg formatter already has.
    if (isDone && !sa && !sb && m.winnerId) { sa = null; sb = null; }
    const item = {
      matchId: m._id,
      setId: String(m._id || ''),                  // desk widgets key off setId
      round: m.round != null ? 'Round ' + m.round : '',
      teamA: p1.name, teamB: p2.name,
      logoA: p1.logo || '', logoB: p2.logo || '',
      scoreA: sa, scoreB: sb,
      dq: false,
      winSide: m.winnerId ? (m.winnerId === p1.id ? 'a' : m.winnerId === p2.id ? 'b' : null) : null,
      status: isLive ? 'live' : 'done',
      stream: '',
      completedAt: m.completedAt || null
    };
    (isLive ? live : done).push(item);
  });
  done.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  const TARGET = 10;
  return live.concat(done.slice(0, Math.max(3, TARGET - live.length))).slice(0, 14);
}

// NXGEN carries NO winners/losers flag on a match, and a double-elimination event numbers BOTH
// ladders from round 1. Grouping by round number alone therefore stacked the lower bracket on top
// of the upper one: a 20-team double-elim imported as eight "Round N" columns, the first holding
// 25 sets, with an empty losers side and no grand final — the "brackets don't import" symptom.
// The ladders ARE separable, by CREATION ORDER: NXGEN generates the whole upper bracket first,
// then the whole lower bracket, then the grand final. So a round number that DROPS from the
// previous match in creation order is where the next ladder starts.
function nxgenSections(matches) {
  const ordered = (matches || []).slice().sort((a, b) =>
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
    String(a._id || '').localeCompare(String(b._id || '')));
  const sections = [];
  let cur = null, prev = 0;
  ordered.forEach(m => {
    const r = Number(m.round) || 0;
    if (!cur || r < prev) { cur = []; sections.push(cur); }
    cur.push(m);
    prev = r;
  });
  return sections;
}

// One ladder → its rounds, low to high, each round in bracket-draw order.
function nxgenRoundGroups(section) {
  const by = new Map();
  (section || []).forEach(m => {
    const r = Number(m.round) || 0;
    if (!by.has(r)) by.set(r, []);
    by.get(r).push(m);
  });
  return [...by.keys()].sort((a, b) => a - b)
    .map(r => ({ round: r, matches: by.get(r).slice().sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0)) }));
}

// NXGEN gives a flat round NUMBER with no stage text. For a clean single-elim halving ladder
// (…16, 8, 4, 2, 1 matches) the match count names the stage exactly; anything else (an
// in-progress/partial ladder) stays "Round N" rather than guessing a stage — a wrong "SEMIFINALS"
// column on air is worse than an honest round number.
function nxgenRoundNames(counts) {
  const clean = counts.length > 0 && counts[counts.length - 1] === 1 &&
    counts.every((c, i) => i === 0 || c === Math.ceil(counts[i - 1] / 2));
  return counts.map((c, i) => {
    if (!clean) return 'Round ' + (i + 1);
    if (c === 1) return 'Final';
    if (c === 2) return 'Semifinals';
    if (c === 4) return 'Quarterfinals';
    return 'Round of ' + (c * 2);
  });
}

function buildNxgenBracketData(eventFormat, participants, matches) {
  const pm = nxgenPartMap(participants);
  const isDouble = (eventFormat || '').toLowerCase().includes('double');

  // The bracket overlay/panel expect rounds as { name, sets: [{ a:{name,score,winner}, b:{…} }] }
  // (same shape start.gg and Challonge import into) — anything else renders as an empty bracket.
  const toRound = (name, group) => ({
    name,
    round: group.round,
    sets: group.matches.map(m => {
      const p1 = nxgenSide(m.participant1, pm);
      const p2 = nxgenSide(m.participant2, pm);
      const [sa, sb] = nxgenScores(m);
      return {
        id: m._id,
        a: { name: p1.name || 'TBD', score: sa, winner: !!m.winnerId && !!p1.id && m.winnerId === p1.id, logo: p1.logo },
        b: { name: p2.name || 'TBD', score: sb, winner: !!m.winnerId && !!p2.id && m.winnerId === p2.id, logo: p2.logo },
        state: nxgenSetState(m.status)
      };
    })
  });

  const sections = nxgenSections(matches);
  let winners = [], losers = [], finals = [];

  if (isDouble) {
    const upper = nxgenRoundGroups(sections[0] || []);
    const rest = nxgenRoundGroups(sections[1] || []);
    // Against a W-round upper bracket a double-elim lower bracket runs 2W-3 rounds (32 slots:
    // upper 16/8/4/2/1, lower 8/8/4/4/2/2/1) — NXGEN puts those and the grand final in the same
    // creation-order section, so anything past the lower ladder's length IS the final.
    const lowerCount = Math.max(1, 2 * upper.length - 3);
    const lower = rest.slice(0, lowerCount);
    const gf = rest.slice(lowerCount);
    const wLast = upper.length - 1;
    winners = upper.map((g, i) => toRound(
      i === wLast ? 'Winners Final' : i === wLast - 1 ? 'Winners Semifinal' : 'Winners Round ' + (i + 1), g));
    losers = lower.map((g, i) => toRound('Losers Round ' + (i + 1), g));
    finals = gf.map((g, i) => toRound(i === 0 ? 'Grand Final' : 'Grand Final Reset', g));
    // NXGEN also mints a pair of matches AFTER the grand final on every double-elim event and has
    // never populated them on a real event. Carry one in only once it holds actual teams.
    sections.slice(2).forEach(s => nxgenRoundGroups(s).forEach(g => {
      if (g.matches.some(m => !nxgenEmptyShell(m))) finals.push(toRound('Grand Final Reset', g));
    }));
  } else {
    const groups = nxgenRoundGroups([].concat(...sections));
    const names = nxgenRoundNames(groups.map(g => g.matches.length));
    winners = groups.map((g, i) => toRound(names[i], g));
  }

  const standings = participants
    .filter(p => p.finalRank)
    .sort((a, b) => (a.finalRank || 99) - (b.finalRank || 99))
    .map(p => ({ placement: p.finalRank, name: p.name, logo: p.logoUrl || null }));

  // roster is a plain list of entrant names (round-robin/swiss views), seeded order.
  const roster = participants
    .slice()
    .sort((a, b) => (a.seed || 99) - (b.seed || 99))
    .map(p => p.name);

  return {
    type: isDouble ? 'DOUBLE_ELIMINATION' : 'SINGLE_ELIMINATION',
    winners,
    losers,
    finals,
    standings,
    schedule: [],
    roster
  };
}

async function loadNxgenEvent(slug) {
  const { event, participants, matches } = await getNxgenEventLive(ctx.nxgenApiKey, slug);

  // event.format is the PARTICIPATION format ("team_vs_team") — bracketFormat is the one that
  // says single/double elimination, so read that first.
  const bracketFormat = event.bracketFormat || event.format || '';

  const logoMap = {};
  participants.forEach(p => {
    const logo = p.logoUrl || logoForTeamName(p.name);   // NXGEN rarely ships crests — use ours
    if (p.name && logo) logoMap[p.name.toLowerCase()] = logo;
  });

  const eventTeams = participants.map(p => ({ name: p.name, logo: p.logoUrl || logoForTeamName(p.name) || null, nxgenId: p.id }));
  const queue = buildNxgenQueue(participants, matches);
  const bd = buildNxgenBracketData(bracketFormat, participants, matches);

  state.nxgen.eventSlug = slug;
  state.nxgen.selectedEvent = {
    name: event.name,
    slug: event.slug,
    activity: event.activity || '',
    format: bracketFormat,
    status: event.status || '',
    url: event.streamUrl || `https://www.nxgen.pro/events/${slug}`
  };
  state.nxgen.eventTeams = eventTeams;
  state.nxgen.logoMap = logoMap;
  state.nxgen.queue = queue;
  state.nxgen.matchFeed = buildNxgenMatchFeed(participants, matches);
  state.nxgen.queueFetchedAt = Date.now();
  state.nxgen.connected = true;
  state.nxgen.lastError = null;
  // Loading an event IS the decision to use NXGEN live — arm the integration so the 30s poll
  // actually starts (setNxgenPolling is gated on this flag). Without it the event looked linked
  // while nothing ever refetched: an empty queue, an empty ticker and no way to tell why.
  state.nxgen.enabled = true;

  state.activeEvent = {
    platform: 'nxgen',
    slug,
    name: event.name,
    gameName: event.activity || '',
    numEntrants: participants.length,
    format: bracketFormat,
    url: event.streamUrl || `https://www.nxgen.pro/events/${slug}`,
    logo: pickEventImage(event),
    loadedAt: new Date().toISOString()
  };
  // Loading an event we haven't loaded before re-arms the ticker: NXGEN now has real scores to
  // show, so point it at the live feed instead of the manual message list — same rule start.gg
  // uses. Re-loading the SAME event leaves a producer's own choice of source alone.
  const _newNxgenEvent = state.eventNameSlug !== slug;
  adoptEventName(slug, event.name);
  if (_newNxgenEvent) state.ticker.source = 'nxgen';
  if (state.ticker.source === 'nxgen') state.ticker.feed = formatTickerFeed(state.nxgen.matchFeed);
  setActivePlatform('nxgen');   // this is now the active platform — silence start.gg / Challonge follow

  const phase = {
    id: 'nxgen-main',
    name: event.name,
    type: bd.type,
    winners: bd.winners,
    losers: bd.losers,
    finals: bd.finals,
    standings: bd.standings,
    schedule: bd.schedule,
    roster: bd.roster
  };
  // Loading an NXGEN event makes NXGEN the owner of the bracket (setActivePlatform above), so it
  // REPLACES the phase list — same as the start.gg and Challonge importers. Appending left a
  // previous platform's phase behind forever ("Weekly Rocket Rush Season 1" sitting next to the
  // live NXGEN phase), and bracket.html shows phase chips as soon as there's more than one.
  state.bracket.phases = [phase];
  state.bracket.activePhaseId = 'nxgen-main';
  state.bracket.title = event.name || 'Bracket';
  state.bracket.teams = eventTeams.filter(t => t.logo).map(t => ({ name: t.name, logo: t.logo }));
  state.bracket.matches = [];
  state.bracket.eventSlug = 'nxgen:' + slug;
  state.bracket.mode = 'imported';
  state.bracket.source = 'nxgen';
  state.bracket.lastFetchAt = Date.now();
  syncActiveBracketPhase();   // mirror the phase into state.bracket.* — the overlay reads the mirror

  // An NXGEN event that hasn't had its bracket generated yet returns zero matches, which imports
  // as a blank bracket with no clue why. Say so instead of leaving the producer staring at it.
  const warning = matches.length ? '' :
    (event.bracketGenerated === false
      ? ' The bracket has not been generated on NXGEN yet — generate it there, then load again.'
      : ' NXGEN returned no matches for this event, so the bracket is empty.');
  return { name: event.name, teamsCount: participants.length, matchesCount: matches.length, warning };
}

async function refreshNxgenLive() {
  const slug = (state.nxgen.eventSlug || '').trim();
  if (!slug || !ctx.nxgenApiKey) return;
  try {
    const { event, participants, matches } = await getNxgenEventLive(ctx.nxgenApiKey, slug);
    state.nxgen.queue = buildNxgenQueue(participants, matches);
    state.nxgen.matchFeed = buildNxgenMatchFeed(participants, matches);
    if (state.ticker.source === 'nxgen') state.ticker.feed = formatTickerFeed(state.nxgen.matchFeed);
    state.nxgen.queueFetchedAt = Date.now();
    state.nxgen.connected = true;
    state.nxgen.lastError = null;

    if (state.nxgen.autoFollow) {
      const live = state.nxgen.queue.find(m => m.live);
      if (live && live.matchId !== state.nxgen.lastAutoFollowMatchId) {
        state.nxgen.lastAutoFollowMatchId = live.matchId;
        if (live.teamA && live.teamA !== 'TBD') {
          state.teams.blue   = { ...state.teams.blue,   name: live.teamA, logo: live.logoA || state.nxgen.logoMap[(live.teamA || '').toLowerCase()] || null };
          state.teams.orange = { ...state.teams.orange, name: live.teamB || '', logo: live.logoB || state.nxgen.logoMap[(live.teamB || '').toLowerCase()] || null };
          saveAppState();
        }
      }
    }
    // Re-bind an auto round label to whoever is on air now (or clear a stale one from a previous
    // event/platform). No-op for a hand-typed label.
    retuneRoundLabel();

    const bd = buildNxgenBracketData(event.bracketFormat || event.format, participants, matches);
    const existingPhase = state.bracket.phases.find(p => p.id === 'nxgen-main');
    if (existingPhase) {
      Object.assign(existingPhase, { type: bd.type, winners: bd.winners, losers: bd.losers, finals: bd.finals, standings: bd.standings, roster: bd.roster });
      state.bracket.lastFetchAt = Date.now();
      syncActiveBracketPhase();
    }

    broadcastFullState();
  } catch (e) {
    state.nxgen.connected = false;
    state.nxgen.lastError = e.message;
    broadcastFullState();
  }
}

let _nxgenPollTimer = null;
function setNxgenPolling(enabled) {
  if (_nxgenPollTimer) { _nxgenPollTimer.stop(); _nxgenPollTimer = null; }
  if (enabled && ctx.nxgenApiKey && (state.nxgen.eventSlug || '').trim()) {
    _nxgenPollTimer = pollLoop('nxgen', async () => { await refreshNxgenLive(); if (state.nxgen.lastError) throw new Error(state.nxgen.lastError); }, 30000, { runNow: true });   // its own catch records the error; surface it so the loop backs off
  }
}

// Only ONE tournament platform (start.gg / Challonge / NXGEN) may drive the broadcast at a time —
// two live auto-follows fighting over the scoreboard is exactly the "trouble" to prevent. Making a
// platform active turns the OTHERS' auto-follow + live polling OFF. (Result push-back via each
// event's challongeSync link is a separate one-directional path and is deliberately left running.)
let _faceitPollTimer = null;
function setActivePlatform(platform) {
  state.activeEvent.platform = platform || null;
  // Another platform took over: the website event stops following its live match.
  if (platform !== 'nameless' && state.siteEvent) { state.siteEvent.id = ''; state.siteEvent.leagueId = ''; state.siteEvent.matchId = ''; }
  if (platform !== 'startgg')   { state.startgg.autoFollow  = false; if (state.startgg.queueEnabled) setStartggQueuePolling(false); }
  if (platform !== 'challonge') { state.challonge.autoFollow = false; setChallongePolling(false); }
  if (platform !== 'nxgen')     {
    state.nxgen.autoFollow    = false; setNxgenPolling(false);
    // NXGEN stops polling here, so its match feed can only go stale — scrolling a dead event's
    // scores through a live show is worse than an empty ticker.
    state.nxgen.matchFeed = [];
  }
  if (platform !== 'faceit')    { state.faceit.autoFollow   = false; setFaceitPolling(false); }
  if (platform !== 'challengermode') { state.challengermode.autoFollow = false; setChallengermodePolling(false); }
  retuneTickerSource();
}

// The scores ticker FOLLOWS the active platform. A producer who put scores on the ticker wants the
// scores of the event actually being produced; left pointed at a platform that has just stopped
// polling it scrolls stale results, or silently nothing at all.
// What it will NOT do is override a deliberate choice: 'manual' and 'br' are the producer's call
// and are never touched, so sponsor copy parked on the ticker for a break stays there. The only
// thing that moves is a ticker ALREADY showing scores, and only to the platform now on air.
// (Challonge and FACEIT publish no match feed, so becoming active drops a scores ticker back to
// the producer's own message list rather than leaving it blank.)
const TICKER_SCORE_PLATFORMS = ['startgg', 'nxgen'];
function retuneTickerSource() {
  const src = state.ticker.source;
  if (!TICKER_SCORE_PLATFORMS.includes(src)) return;
  const active = state.activeEvent.platform || '';
  const want = TICKER_SCORE_PLATFORMS.includes(active) ? active : 'manual';
  if (want === src) return;
  console.log(`[ticker] active platform is ${active || 'none'} — moving the scores ticker from ${src} to ${want}`);
  state.ticker.source = want;
  state.ticker.feed = want === 'startgg' ? formatTickerFeed(state.startgg.matchFeed)
                    : want === 'nxgen'   ? formatTickerFeed(state.nxgen.matchFeed)
                    : [];
}

// ─── FACEIT integration ───────────────────────────────────────────────────────

// A FACEIT match carries both sides inline as teams.faction1 / teams.faction2. For a CHAMPIONSHIP
// those are real teams (name + avatar + roster); for a HUB or a 1v1 championship faction1 is a
// single player wrapped in the same envelope, so read the roster's nickname as the name rather
// than printing FACEIT's auto-generated "team_<nickname>" placeholder on air.
// A FACEIT roster entry → our team-library player row. The FACEIT NICKNAME is the player's
// platform handle: it is what casters say, what the player registry keys on, and what stays
// stable. game_player_name is whatever Steam/Epic alias they happen to be wearing today, so it
// rides along as a secondary field instead of becoming the name (reading it first meant a card
// could go on air saying "xX_sniper_Xx" for a player everyone knows by their FACEIT handle).
function faceitPlayers(roster) {
  return (roster || []).map((p) => {
    if (!p || typeof p !== 'object') return null;
    const name = String(p.nickname || p.game_player_name || '').trim();
    if (!name) return null;
    // /teams/{id} members use user_id; championship + match rosters use player_id.
    const pid = p.player_id || p.user_id || '';
    const alt = String(p.game_player_name || '').trim();
    const row = {
      id: Math.random().toString(36).slice(2, 11),
      name,
      platform: 'faceit',
      platformId: pid ? String(pid) : '',
      assignedCamera: null,
      photo: p.avatar || ''
    };
    if (alt && alt.toLowerCase() !== name.toLowerCase()) row.gameName = alt;
    // Fold into the cross-platform player registry so a FACEIT roster lights up the same
    // profile cards a start.gg import does.
    if (name) {
      const patch = { faceit: name };
      if (pid) patch.faceitId = String(pid);
      if (p.avatar) patch.image = p.avatar;
      try { upsertPlayerProfile(name, patch); } catch {}
    }
    return row;
  }).filter(Boolean);
}

function faceitSide(faction) {
  if (!faction || typeof faction !== 'object') return { id: null, name: '', logo: null, players: [], playerRows: [] };
  const roster = Array.isArray(faction.roster) ? faction.roster
               : Array.isArray(faction.players) ? faction.players : [];
  const playerRows = faceitPlayers(roster);
  const players = playerRows.map((p) => p.name);
  let name = faction.name || '';
  // "team_someNickname" is FACEIT's synthetic solo-queue wrapper, not a name a producer typed.
  if (/^team_/i.test(name) && players.length === 1) name = players[0];
  const logo = faction.avatar || logoForTeamName(name) || null;
  return { id: faction.faction_id || faction.team_id || faction.id || null, name, logo, players, playerRows };
}

const FACEIT_LIVE_STATUSES = ['ongoing'];
const FACEIT_DONE_STATUSES = ['finished', 'cancelled', 'aborted'];

function faceitMatchRow(m) {
  const t = m.teams || {};
  const a = faceitSide(t.faction1);
  const b = faceitSide(t.faction2);
  const score = (m.results && m.results.score) || {};
  const status = String(m.status || '').toLowerCase();
  return {
    matchId: m.match_id,
    round: m.round ?? null,
    group: m.group ?? null,
    teamA: a.name || 'TBD',
    teamB: b.name || 'TBD',
    logoA: a.logo,
    logoB: b.logo,
    scoreA: score.faction1 ?? null,
    scoreB: score.faction2 ?? null,
    bestOf: m.best_of || null,
    status,
    live: FACEIT_LIVE_STATUSES.includes(status),
    scheduledAt: m.scheduled_at || m.started_at || null,
    url: faceit.faceitUrl(m.faceit_url),
    winner: (m.results && m.results.winner) || null,
    _a: a, _b: b
  };
}

// The producer queue is the matches still to play, in the order FACEIT lists them. Never re-sort
// by round prestige — a Losers Final legitimately runs before a Grand Final.
function buildFaceitQueue(matches) {
  return (matches || [])
    .map(faceitMatchRow)
    .filter((r) => !FACEIT_DONE_STATUSES.includes(r.status))
    .map(({ _a, _b, ...row }) => row);
}

// FACEIT gives a flat round NUMBER with no stage text and no winners/losers side (same gap as
// NXGEN). A clean halving ladder (…16, 8, 4, 2, 1) names the stage exactly; anything else stays
// "Round N" — a wrong "SEMIFINALS" burned on air is worse than an honest round number.
function faceitIsLadder(counts) {
  return counts.length > 0 && counts[counts.length - 1] === 1 &&
    counts.every((c, i) => i === 0 || c === Math.ceil(counts[i - 1] / 2));
}
function faceitRoundNames(counts) {
  const clean = faceitIsLadder(counts);
  return counts.map((c, i) => {
    if (!clean) return 'Round ' + (i + 1);
    if (c === 1) return 'Final';
    if (c === 2) return 'Semifinals';
    if (c === 4) return 'Quarterfinals';
    return 'Round of ' + (c * 2);
  });
}

// Is this an ELIMINATION bracket, or a league/swiss where losers keep playing?
//
// FACEIT never says. The previous guess — "do the round sizes halve down to one match" — is only
// answerable once the whole bracket exists, so a 16-team single-elim that had played only round 1
// (counts [8], no round 2 created yet) failed the test and got mis-typed as SWISS, which drew the
// wrong overlay for the entire first round of the event.
//
// The decisive signal is in the data: in an elimination bracket a team that LOSES never appears
// again. If anyone lost in round r and still shows up in a later round, losers keep playing, so
// it is a league/swiss. With only one round played nobody has a later appearance, so this
// correctly answers "elimination" — the far more common championship shape.
function faceitIsElimination(rows) {
  const lastLoss = new Map();   // team → earliest round they lost in
  const lastSeen = new Map();   // team → latest round they appear in
  const norm = (n) => String(n || '').trim().toLowerCase();
  rows.forEach((r) => {
    const rd = r.round == null ? 1 : Number(r.round);
    [[r.teamA, r.winner === 'faction2'], [r.teamB, r.winner === 'faction1']].forEach(([name, lost]) => {
      const k = norm(name);
      if (!k || k === 'tbd') return;
      if (!lastSeen.has(k) || rd > lastSeen.get(k)) lastSeen.set(k, rd);
      if (lost && (!lastLoss.has(k) || rd < lastLoss.get(k))) lastLoss.set(k, rd);
    });
  });
  for (const [k, lossRound] of lastLoss) {
    if ((lastSeen.get(k) || 0) > lossRound) return false;
  }
  return true;
}

// W-L (+ game differential) tallied from the matches themselves. FACEIT's /results endpoint only
// exists for some championship formats, and without standings the Swiss chart and the group board
// have nothing to draw — so compute them rather than shipping an empty table.
function faceitStandingsFrom(rows, teams) {
  const tally = new Map();
  const seed = (name, logo) => {
    const k = String(name || '').trim().toLowerCase();
    if (!k || k === 'tbd') return null;
    if (!tally.has(k)) tally.set(k, { name: String(name).trim(), logo: logo || null, wins: 0, losses: 0, gameWins: 0, gameLosses: 0 });
    const rec = tally.get(k);
    if (!rec.logo && logo) rec.logo = logo;
    return rec;
  };
  // Seed from the entrant list first so teams yet to play still appear on the board.
  (teams || []).forEach((t) => seed(t.name, t.logo));
  rows.forEach((r) => {
    const a = seed(r.teamA, r.logoA), b = seed(r.teamB, r.logoB);
    if (!a || !b || !r.winner) return;
    const as = Number(r.scoreA) || 0, bs = Number(r.scoreB) || 0;
    a.gameWins += as; a.gameLosses += bs;
    b.gameWins += bs; b.gameLosses += as;
    if (r.winner === 'faction1') { a.wins++; b.losses++; } else { b.wins++; a.losses++; }
  });
  return [...tally.values()]
    .sort((x, y) => (y.wins - y.losses) - (x.wins - x.losses)
                 || (y.gameWins - y.gameLosses) - (x.gameWins - x.gameLosses)
                 || x.name.localeCompare(y.name))
    .map((t, i) => ({ placement: i + 1, ...t }));
}

// FACEIT's own final standings, when the championship exposes them — authoritative ordering, so
// these win over the computed table.
function faceitResultStandings(results) {
  return (results || []).map((r, i) => {
    const ent = r.team || r.entity || r.user || r;
    const name = ent.name || ent.nickname || '';
    return {
      placement: r.position ?? r.rank ?? (i + 1),
      name,
      logo: ent.avatar || logoForTeamName(name) || null,
      wins: r.wins ?? r.won ?? 0,
      losses: r.losses ?? r.lost ?? 0,
      points: r.points ?? null
    };
  }).filter((x) => x.name);
}

function faceitGroupName(g) {
  const n = Number(g);
  if (Number.isFinite(n) && n >= 1 && n <= 26) return 'Group ' + String.fromCharCode(64 + n);
  return 'Group ' + g;
}

// One band of matches → the { winners, standings, schedule, roster } shape every other importer
// produces. Shared by the championship as a whole and by each group of a group stage.
function faceitLadder(rows, teams, results) {
  const byRound = {};
  rows.forEach((r) => {
    const key = r.round == null ? 1 : r.round;
    (byRound[key] = byRound[key] || []).push(r);
  });
  const roundKeys = Object.keys(byRound).map(Number).sort((a, b) => a - b);
  const roundsSorted = roundKeys.map((k) => byRound[k]);
  const names = faceitRoundNames(roundsSorted.map((ms) => ms.length));

  // The bracket overlay/panel expect { name, sets: [{ a:{name,score,winner,logo}, b:{…} }] } —
  // the same shape start.gg, Challonge and NXGEN import into.
  const bands = roundsSorted.map((ms, idx) => ({
    name: names[idx],
    round: roundKeys[idx],
    sets: ms.map((r) => ({
      id: r.matchId,
      a: { name: r.teamA, score: r.scoreA ?? 0, winner: r.winner === 'faction1', logo: r.logoA },
      b: { name: r.teamB, score: r.scoreB ?? 0, winner: r.winner === 'faction2', logo: r.logoB },
      state: r.status
    }))
  }));

  const resultRows = faceitResultStandings(results);
  const standings = resultRows.length ? resultRows : faceitStandingsFrom(rows, teams);
  const roster = (teams || []).map((t) => t.name).filter(Boolean);

  // Losers still playing ⇒ league/swiss: the rounds are a SCHEDULE, not an elimination ladder.
  // Drawing that as a bracket puts a fictional "Final" on air.
  if (!faceitIsElimination(rows)) {
    return { type: 'SWISS', winners: [], losers: [], finals: [], standings, schedule: bands, roster };
  }
  return { type: 'SINGLE_ELIMINATION', winners: bands, losers: [], finals: [], standings, schedule: [], roster };
}

function buildFaceitBracketData(matches, teams, results) {
  const rows = (matches || []).map(faceitMatchRow);

  // Group-stage championships tag every match with a group number. Folding them all into one set
  // of round columns merged every group's round 1 into a single column of unrelated matches — so
  // each group becomes a POOL, which the bracket panel and overlay already know how to switch
  // between. Teams carry the group from their subscription.
  const groupIds = [...new Set(rows.map((r) => r.group).filter((g) => g != null && g !== ''))]
    .sort((a, b) => (Number(a) || 0) - (Number(b) || 0));

  const base = faceitLadder(rows, teams, results);
  base.pools = [];
  if (groupIds.length > 1) {
    base.pools = groupIds.map((g) => {
      const gRows = rows.filter((r) => String(r.group) === String(g));
      const gTeams = (teams || []).filter((t) => String(t.group) === String(g));
      // A group's standings must come from that group's own matches — the championship-wide
      // /results list is not per-group.
      const l = faceitLadder(gRows, gTeams.length ? gTeams : [], []);
      return {
        id: 'faceit-g' + g,
        name: faceitGroupName(g),
        type: l.type,
        winners: l.winners, losers: [], finals: [],
        standings: l.standings, schedule: l.schedule, roster: l.roster, matrix: null
      };
    });
  }
  return base;
}

// One fetch of everything a competition needs, for both kinds. Championships carry a subscription
// list (the entrants); hubs don't, so their team list is derived from the matches themselves.
async function fetchFaceitCompetition(id, type) {
  if (type === 'hub') {
    const [comp, matches] = await Promise.all([
      faceit.getFaceitHub(ctx.faceitApiKey, id),
      faceit.getFaceitHubMatches(ctx.faceitApiKey, id, 'all')
    ]);
    return { comp, matches, subs: [], results: [] };
  }
  const [comp, matches, subs, results] = await Promise.all([
    faceit.getFaceitChampionship(ctx.faceitApiKey, id),
    faceit.getFaceitChampionshipMatches(ctx.faceitApiKey, id, 'all'),
    faceit.getFaceitChampionshipSubscriptions(ctx.faceitApiKey, id),
    faceit.getFaceitChampionshipResults(ctx.faceitApiKey, id)
  ]);
  return { comp, matches, subs, results };
}

// Entrants. Championship subscriptions are the authoritative list (they include teams that
// haven't been drawn into a match yet); hubs and thin subscription payloads fall back to the
// distinct sides seen across the match list so the team import is never empty.
// Entrants, merged across every source that mentions them.
//
// Two shape facts that cost the previous version its rosters and half its crests:
//  • On a championship SUBSCRIPTION the roster sits on the subscription itself (`item.roster`).
//    `item.team` carries only { name, avatar, team_id, team_type, faceit_url } — so reading
//    `item.team.roster` returned undefined and EVERY championship team imported with no players.
//  • A subscription often has the crest but the match faction has the fuller roster, or the
//    reverse. First-source-wins meant a team seen first without a logo could never gain one.
// So: merge by name, taking the best non-empty value for each field from whichever source has it.
function faceitTeamsFrom(subs, matches) {
  const byKey = new Map();
  const merge = (name, info) => {
    const clean = String(name || '').trim();
    const key = clean.toLowerCase();
    if (!key || key === 'tbd') return;
    let rec = byKey.get(key);
    if (!rec) { rec = { name: clean, logo: null, faceitId: null, seed: null, group: null, players: [] }; byKey.set(key, rec); }
    if (!rec.logo && info.logo) rec.logo = info.logo;
    if (!rec.faceitId && info.id) rec.faceitId = String(info.id);
    if (rec.seed == null && info.seed != null) rec.seed = info.seed;
    if (rec.group == null && info.group != null && info.group !== '') rec.group = info.group;
    if (info.players && info.players.length > rec.players.length) rec.players = info.players;
  };

  (subs || []).forEach((sub) => {
    if (!sub || typeof sub !== 'object') return;
    const t = sub.team || sub.entity || null;
    const roster = Array.isArray(sub.roster) ? sub.roster
                 : Array.isArray(sub.members) ? sub.members
                 : (t && Array.isArray(t.roster)) ? t.roster
                 : (t && Array.isArray(t.members)) ? t.members : [];
    const players = faceitPlayers(roster);
    if (t && t.name) {
      merge(t.name, { logo: t.avatar, id: t.team_id || t.id || sub.team_id, players, group: sub.group, seed: sub.seed });
      return;
    }
    // Solo championships subscribe a USER, not a team.
    const u = sub.user || null;
    if (u && (u.nickname || u.name)) {
      merge(u.nickname || u.name, { logo: u.avatar, id: u.user_id || sub.user_id, players: faceitPlayers([u]), group: sub.group, seed: sub.seed });
    }
  });

  (matches || []).forEach((m) => {
    const t = (m && m.teams) || {};
    [t.faction1, t.faction2].forEach((f) => {
      const side = faceitSide(f);
      if (side.name) merge(side.name, { logo: side.logo, id: side.id, players: side.playerRows, group: m.group });
    });
  });

  // Our own saved crest is the LAST resort, so a real FACEIT avatar always wins.
  return [...byKey.values()].map((t) => ({ ...t, logo: t.logo || logoForTeamName(t.name) || null }));
}

// Backfill entrants that neither the subscriptions nor the matches described fully. /teams/{id}
// returns both the crest and the members, so one lookup fixes a missing logo AND a missing roster.
// Bounded and initial-load-only: a 128-team championship would otherwise fire 128 requests
// straight into the rate limit, and the 30s live poll must never do this at all.
async function enrichFaceitTeams(teams) {
  const need = (teams || []).filter((t) => t.faceitId && (!t.logo || !t.players.length)).slice(0, 48);
  for (let i = 0; i < need.length; i += 6) {
    await Promise.all(need.slice(i, i + 6).map(async (t) => {
      try {
        const full = await faceit.getFaceitTeam(ctx.faceitApiKey, t.faceitId);
        if (!full || typeof full !== 'object') return;
        if (!t.logo && full.avatar) t.logo = full.avatar;
        if (!t.players.length) {
          const roster = Array.isArray(full.members) ? full.members
                       : Array.isArray(full.roster) ? full.roster : [];
          const rows = faceitPlayers(roster);
          if (rows.length) t.players = rows;
        }
      } catch { /* a team we can't read is not a reason to fail the import */ }
    }));
  }
  return teams;
}

async function loadFaceitCompetition(id, type) {
  const kind = type === 'hub' ? 'hub' : 'championship';
  const { comp, matches, subs, results } = await fetchFaceitCompetition(id, kind);

  const name = comp.name || comp.championship_id || comp.hub_id || 'FACEIT competition';
  const game = comp.game_id || comp.game || '';
  const region = comp.region || '';
  const url = faceit.faceitUrl(comp.faceit_url) ||
    (kind === 'hub' ? `https://www.faceit.com/en/hub/${id}` : `https://www.faceit.com/en/championship/${id}`);

  const eventTeams = await enrichFaceitTeams(faceitTeamsFrom(subs, matches));
  const logoMap = {};
  eventTeams.forEach((t) => { if (t.name && t.logo) logoMap[t.name.toLowerCase()] = t.logo; });

  const queue = buildFaceitQueue(matches);
  const bd = buildFaceitBracketData(matches, eventTeams, results);

  state.faceit.competitionId = id;
  state.faceit.competitionType = kind;
  state.faceit.selectedEvent = {
    id,
    type: kind,
    name,
    game,
    region,
    status: comp.status || '',
    slots: comp.slots || comp.total_slots || null,
    url
  };
  state.faceit.eventTeams = eventTeams;
  state.faceit.logoMap = logoMap;
  state.faceit.queue = queue;
  state.faceit.queueFetchedAt = Date.now();
  state.faceit.connected = true;
  state.faceit.lastError = null;

  state.activeEvent = {
    platform: 'faceit',
    slug: id,
    name,
    gameName: game,
    numEntrants: eventTeams.length,
    format: kind === 'hub' ? 'Hub' : (comp.type || 'Championship'),
    url,
    logo: pickEventImage(comp),
    loadedAt: new Date().toISOString()
  };
  adoptEventName(id, name);
  // Same rule as Challonge and start.gg: the platform knows the game, so follow it onto the right
  // overlay instead of leaving whatever was active. FACEIT reports ids like "cs2" / "valorant",
  // which backend/game-match.js resolves directly.
  adoptEventGame(game);
  setActivePlatform('faceit');   // this is now the active platform — silence the other follows

  const phase = {
    id: 'faceit-main',
    name,
    type: bd.type,
    winners: bd.winners,
    losers: bd.losers,
    finals: bd.finals,
    standings: bd.standings,
    schedule: bd.schedule,
    roster: bd.roster,
    pools: bd.pools || []
  };
  // FACEIT is a single-phase source like Challonge/NXGEN, so loading REPLACES the phase list —
  // appending would leave a previous platform's phase chip sitting on bracket.html forever.
  state.bracket.phases = [phase];
  state.bracket.activePhaseId = 'faceit-main';
  state.bracket.title = name || 'Bracket';
  state.bracket.teams = eventTeams.filter((t) => t.logo).map((t) => ({ name: t.name, logo: t.logo }));
  state.bracket.matches = [];
  state.bracket.eventSlug = 'faceit:' + id;
  state.bracket.mode = 'imported';
  state.bracket.source = 'faceit';
  state.bracket.lastFetchAt = Date.now();
  syncActiveBracketPhase();   // mirror the phase into state.bracket.* — the overlay reads the mirror

  return { name, teamsCount: eventTeams.length, matchesCount: (matches || []).length };
}

async function refreshFaceitLive() {
  const id = (state.faceit.competitionId || '').trim();
  if (!id || !ctx.faceitApiKey) return;
  try {
    const kind = state.faceit.competitionType === 'hub' ? 'hub' : 'championship';
    const { matches, subs, results } = await fetchFaceitCompetition(id, kind);
    // Switched competitions while this was out: drop the old one's reply.
    if ((state.faceit.competitionId || '').trim() !== id) return;
    // The live poll deliberately does NOT re-run enrichFaceitTeams (that is a per-team lookup and
    // this fires every 30s). So carry the already-enriched crest/roster forward: a plain rebuild
    // would silently strip the logos and rosters that the initial load backfilled, and a team
    // would lose its crest mid-show 30 seconds after going on air.
    const prev = new Map((state.faceit.eventTeams || []).map((t) => [(t.name || '').toLowerCase(), t]));
    const eventTeams = faceitTeamsFrom(subs, matches).map((t) => {
      const had = prev.get((t.name || '').toLowerCase());
      if (!had) return t;
      return {
        ...t,
        logo: t.logo || had.logo || null,
        players: t.players.length ? t.players : (had.players || []),
        faceitId: t.faceitId || had.faceitId || null,
        group: t.group != null ? t.group : (had.group ?? null)
      };
    });
    state.faceit.eventTeams = eventTeams;
    eventTeams.forEach((t) => { if (t.name && t.logo) state.faceit.logoMap[t.name.toLowerCase()] = t.logo; });
    state.faceit.queue = buildFaceitQueue(matches);
    state.faceit.queueFetchedAt = Date.now();
    state.faceit.connected = true;
    state.faceit.lastError = null;

    if (state.faceit.autoFollow) {
      const live = state.faceit.queue.find((m) => m.live);
      if (live && live.matchId !== state.faceit.lastAutoFollowMatchId) {
        state.faceit.lastAutoFollowMatchId = live.matchId;
        if (live.teamA && live.teamA !== 'TBD') {
          // A new match: close out the previous series (like start.gg auto-follow) and take the new
          // teams whole. Only name + logo used to change, so the previous team's players, seed and
          // org stayed on that side and showed on air under the new name. After an app restart the
          // last followed match is unknown: if the same teams are already on air it is the same
          // series, so it is never reset.
          const lc = (x) => String(x || '').trim().toLowerCase();
          const sameTeams = lc(state.teams.blue && state.teams.blue.name) === lc(live.teamA) && lc(state.teams.orange && state.teams.orange.name) === lc(live.teamB);
          if (!sameTeams) finalizeAndResetSeries();
          const fresh = (name, logo) => {
            const t = (state.faceit.eventTeams || []).find((x) => (x.name || '').toLowerCase() === String(name || '').toLowerCase());
            return { name: name || '', logo: logo || state.faceit.logoMap[String(name || '').toLowerCase()] || null,
              players: (t && Array.isArray(t.players) ? t.players : []).map((p) => ({ ...p })),   // faceitPlayers rows (full player records)
              org: '', seed: null, entrantId: null };
          };
          state.teams.blue   = { ...state.teams.blue,   ...fresh(live.teamA, live.logoA) };
          state.teams.orange = { ...state.teams.orange, ...fresh(live.teamB, live.logoB) };
          state.activePlayer = { blue: '', orange: '' };
          saveAppState();
        }
      }
    }
    retuneRoundLabel();

    const bd = buildFaceitBracketData(matches, eventTeams, results);
    const existingPhase = state.bracket.phases.find((p) => p.id === 'faceit-main');
    if (existingPhase) {
      // schedule + pools must ride along: a group stage loses its pools (and a swiss its rounds)
      // on the very first live poll if the refresh only copies the elimination fields.
      Object.assign(existingPhase, { type: bd.type, winners: bd.winners, losers: bd.losers, finals: bd.finals,
        standings: bd.standings, schedule: bd.schedule, roster: bd.roster, pools: bd.pools || [] });
      state.bracket.lastFetchAt = Date.now();
      syncActiveBracketPhase();
    }

    broadcastFullState();
  } catch (e) {
    state.faceit.connected = false;
    state.faceit.lastError = e.message;
    broadcastFullState();
  }
}

function setFaceitPolling(enabled) {
  if (_faceitPollTimer) { _faceitPollTimer.stop(); _faceitPollTimer = null; }
  if (enabled && ctx.faceitApiKey && (state.faceit.competitionId || '').trim()) {
    _faceitPollTimer = pollLoop('faceit', async () => { await refreshFaceitLive(); if (state.faceit.lastError) throw new Error(state.faceit.lastError); }, 30000, { runNow: true });   // its own catch records the error; surface it so the loop backs off
  }
}

// ─── My Events live-refresh ───────────────────────────────────────────────────
// Keep every saved My Event current: poll start.gg for its entrants (team names + player
// gamertags + current seed) so the seeding studio and the event page always reflect the latest
// registration. Stored as a lightweight `ev.roster`; rank/MMR is NOT on start.gg (it's entered in
// the seeding studio). Auto every ~3 min + on add + on demand (refresh_my_event WS command).
let _myEventsTimer = null;
let _myEventsSyncing = false;
async function refreshMyEvent(ev) {
  if (!ev || !ev.eventSlug || !ctx.startggApiToken) return false;
  try {
    const data = await fetchEventSeeding(ctx.startggApiToken, ev.eventSlug);
    const entrants = data.entrants || [];
    ev.roster = entrants.map((e) => ({
      entrantId: e.entrantId, name: e.name, seedNum: e.seedNum || null,
      players: (e.players || []).map((p) => ({ gamerTag: p.gamerTag, epic: p.epic || '', alts: p.alts || [] })).filter((p) => p.gamerTag)
    }));
    ev.numEntrants = entrants.length;
    if (data.eventName && !ev.name) ev.name = data.eventName;
    if (data.image) ev.image = data.image;   // logo for My Events / seeding cards
    ev.lastSync = Date.now();
    ev.syncError = '';
    touchMyEvents();
    return true;
  } catch (e) {
    ev.syncError = (e && e.message) || 'sync failed';
    touchMyEvents();
    return false;
  }
}
async function refreshAllMyEvents(opts) {
  opts = opts || {};
  if (_myEventsSyncing) return;
  if (!ctx.startggApiToken || !Array.isArray(state.myEvents) || !state.myEvents.length) return;
  _myEventsSyncing = true;
  let changed = false;
  try {
    for (const ev of state.myEvents.slice()) {
      if (!opts.force && ev.lastSync && (Date.now() - ev.lastSync) < 90 * 1000) continue;  // recently synced
      if (await refreshMyEvent(ev)) changed = true;
      await new Promise((r) => setTimeout(r, 350));   // stagger for start.gg rate limits
    }
  } finally {
    _myEventsSyncing = false;
    if (changed || opts.force) { saveAppState(); broadcastFullState(); }
  }
}
function startMyEventsAutoSync() {
  if (_myEventsTimer) return;
  _myEventsTimer = pollLoop('my-events', () => refreshAllMyEvents().catch((e) => { console.warn('[my-events]', e && e.message); throw e; }), 3 * 60 * 1000);
  setTimeout(() => { refreshAllMyEvents().catch(() => {}); }, 8000);   // initial kick after boot
}


  return { setNxgenPolling, setActivePlatform, refreshMyEvent, refreshAllMyEvents, startMyEventsAutoSync, setFaceitPolling, loadNxgenEvent, refreshNxgenLive, loadFaceitCompetition, refreshFaceitLive };
};
