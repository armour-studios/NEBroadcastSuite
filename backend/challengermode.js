/*
  challengermode.js — the Challengermode GraphQL queries and the mapping from their tournament
  graph onto OUR bracket/queue/placement shapes.

  Kept out of server.js because this is pure data shaping: given a `tournament` payload it returns
  the same structures every other platform loader produces, so everything downstream (bracket.html,
  the stream queue, the top-8 board, auto-follow) is untouched.

  ── How Challengermode models a tournament ─────────────────────────────────
    Tournament
      └ stages[]                    played consecutively; each has a `format`
          ├ TournamentEliminationStage → brackets[] → rounds[] → matchSeries[]
          ├ TournamentGroupStage       → groups[]   → matchSeries[]
          └ TournamentSwissStage       → rounds[]   → matchSeries[]
      └ attendance.roster.lineups[]  the field, each with a `placement` RANGE
      └ gameTitle                    which game — drives our whole overlay switch

  A `MatchSeries` is a set (best-of-N); `matchSeries.results.lineupResults[]` holds each side's
  score. A `TournamentLineup` is an entrant — a team or a solo player.

  ── The two things this maps that Challonge cannot ─────────────────────────
  1. **Bracket side is LABELLED, not inferred.** `TournamentNodeLabel` marks a bracket as
     DOUBLE_ELIMINATION_UPPER_BRACKET / _LOWER_BRACKET / _FINALS_BRACKET. Challonge makes us guess
     from the sign of a round number. Labels are exact, so winners/losers/finals are never wrong.
  2. **Placements are RANGES.** `placement { bestPlacement, worstPlacement, displayPlacement }` —
     a top-8 finish that is genuinely "5th–8th" says so, which is what a bracket actually produces.
     We keep `bestPlacement` as the sortable number and `displayPlacement` as the text on air, so a
     board can print "5-8" instead of inventing a 5th and a 6th that were never played for.
*/

'use strict';

// ── Queries ─────────────────────────────────────────────────────────────────
// Every field costs (see the client header), so these ask for exactly what the overlays render
// and nothing else. Notably absent: player profiles, statistics, restrictions, schedules.

const LINEUP_FIELDS = `
  id
  name
  seed
  disqualified
  placement { bestPlacement worstPlacement displayPlacement }
  logo(size: MEDIUM) { url }
  members { user { username } captain }
`;

const SERIES_FIELDS = `
  id
  title
  ordinal
  state
  bestOf
  scheduledStartTimeAt
  labels
  lineups { id name }
  results {
    final
    draw
    lineupResults { lineupNumber score placement final }
  }
`;

const TOURNAMENT_QUERY = `
query NeTournament($id: UUID!) {
  tournament(tournamentId: $id) {
    id
    name
    state
    gameTitle { id slug title }
    links { __typename }
    attendance {
      roster {
        lineupCount
        lineups { ${LINEUP_FIELDS} }
      }
    }
    stages {
      index
      format
      lineupCount
      ... on TournamentEliminationStage {
        brackets {
          title
          labels
          rounds { roundNumber title labels isLastRound matchSeries { ${SERIES_FIELDS} } }
        }
      }
      ... on TournamentGroupStage {
        groups { title number state matchSeries { ${SERIES_FIELDS} } }
      }
      ... on TournamentSwissStage {
        rounds { roundNumber title labels isLastRound matchSeries { ${SERIES_FIELDS} } }
      }
    }
  }
}`;

// Lighter query for the poll: scores and states only, no roster/logos/members. The roster is
// re-read on the same tick ONLY because placements live on it — see refresh().
const TOURNAMENT_LIVE_QUERY = `
query NeTournamentLive($id: UUID!) {
  tournament(tournamentId: $id) {
    id
    name
    state
    attendance {
      roster {
        lineups { id name seed placement { bestPlacement worstPlacement displayPlacement } }
      }
    }
    stages {
      index
      format
      ... on TournamentEliminationStage {
        brackets { title labels rounds { roundNumber title labels isLastRound matchSeries { ${SERIES_FIELDS} } } }
      }
      ... on TournamentGroupStage {
        groups { title number state matchSeries { ${SERIES_FIELDS} } }
      }
      ... on TournamentSwissStage {
        rounds { roundNumber title labels isLastRound matchSeries { ${SERIES_FIELDS} } }
      }
    }
  }
}`;

const SEARCH_QUERY = `
query NeSearchTournaments($input: TournamentsForGameInput!) {
  tournamentsForGame(input: $input) {
    id
    name
    state
    gameTitle { slug title }
    attendance { roster { lineupCount } }
  }
}`;

const SPACE_QUERY = `
query NeSpaceTournaments($input: TournamentsForSpaceInput!) {
  tournamentsForSpace(input: $input) {
    id
    name
    state
    gameTitle { slug title }
    attendance { roster { lineupCount } }
  }
}`;

// ── Mapping ─────────────────────────────────────────────────────────────────

const str = (v) => (v == null ? '' : String(v));

/* One lineup -> our entrant shape. `logo` is a URL we hand straight to the overlays. */
function mapLineup(l) {
  if (!l) return null;
  const pl = l.placement || null;
  return {
    id: str(l.id),
    name: str(l.name) || 'TBD',
    seed: Number(l.seed) || 0,
    logo: (l.logo && l.logo.url) || null,
    disqualified: !!l.disqualified,
    // bestPlacement is the sortable number; displayPlacement is what goes on air ("5-8").
    placement: pl ? Number(pl.bestPlacement) || 0 : 0,
    placementWorst: pl ? Number(pl.worstPlacement) || 0 : 0,
    placementText: pl ? str(pl.displayPlacement) : '',
    players: (l.members || []).filter(Boolean).map((m) => ({
      name: str(m.user && m.user.username),
      captain: !!m.captain
    })).filter((p) => p.name)
  };
}

/*
  One MatchSeries -> our `{ a: {name,score,winner}, b: {...} }` set.

  `lineupResults[].lineupNumber` is 0-indexed and is the authority on WHICH side a result belongs
  to — `lineups[]` order is not guaranteed to match, and pairing them by array index is exactly the
  kind of silent swap that puts the winner's score on the loser's name.
*/
function mapSeries(s) {
  if (!s) return null;
  const lineups = (s.lineups || []);
  const results = (s.results && s.results.lineupResults) || [];
  const byNumber = {};
  results.forEach((r) => { if (r && r.lineupNumber != null) byNumber[Number(r.lineupNumber)] = r; });

  const side = (n) => {
    const lu = lineups[n] || null;
    const r = byNumber[n] || null;
    return {
      name: lu ? str(lu.name) || 'TBD' : 'TBD',
      lineupId: lu ? str(lu.id) : '',
      score: r && r.score != null ? Number(r.score) : 0,
      // placement 1 = won this series. Derived by Challengermode from the outcome, so a walkover
      // or a DQ is placed correctly even with no games played.
      winner: !!(r && Number(r.placement) === 1 && (s.results || {}).final)
    };
  };
  return {
    id: str(s.id),
    title: str(s.title),
    ordinal: Number(s.ordinal) || 0,
    state: str(s.state),
    bestOf: Number(s.bestOf) || 0,
    scheduledAt: s.scheduledStartTimeAt || null,
    labels: s.labels || [],
    final: !!(s.results && s.results.final),
    a: side(0),
    b: side(1)
  };
}

const hasLabel = (labels, name) => Array.isArray(labels) && labels.indexOf(name) >= 0;

/*
  A whole tournament -> one phase per STAGE, in our bracket shape.

  Challengermode stages are played consecutively (groups, then playoffs), which is exactly what our
  `state.bracket.phases` already models — so a two-stage tournament arrives as two selectable
  phases rather than being flattened into one unreadable bracket.
*/
function mapStages(tournament) {
  const stages = (tournament.stages || []).filter(Boolean);
  return stages.map((st, i) => {
    const format = str(st.format) || 'UNKNOWN';
    const phase = {
      id: 'cm-stage-' + (st.index != null ? st.index : i),
      name: '',
      type: format === 'DOUBLE_ELIMINATION' ? 'DOUBLE_ELIMINATION'
          : format === 'SINGLE_ELIMINATION' ? 'SINGLE_ELIMINATION'
          : format === 'ROUND_ROBIN' ? 'ROUND_ROBIN'
          : format === 'SWISS' ? 'SWISS' : 'SINGLE_ELIMINATION',
      winners: [], losers: [], finals: [], standings: [], schedule: [], roster: []
    };

    const roundToBlock = (r) => ({
      name: str(r.title) || ('Round ' + ((Number(r.roundNumber) || 0) + 1)),
      sets: (r.matchSeries || []).map(mapSeries).filter(Boolean)
    });

    if (Array.isArray(st.brackets) && st.brackets.length) {
      // Elimination. The bracket's LABEL says which side it is — no guessing from round signs.
      st.brackets.forEach((b) => {
        const blocks = (b.rounds || []).map(roundToBlock).filter((x) => x.sets.length);
        if (!blocks.length) return;
        if (hasLabel(b.labels, 'DOUBLE_ELIMINATION_LOWER_BRACKET')) phase.losers.push(...blocks);
        else if (hasLabel(b.labels, 'DOUBLE_ELIMINATION_FINALS_BRACKET')) phase.finals.push(...blocks);
        else phase.winners.push(...blocks);
      });
      // A single-elimination stage arrives as one unlabelled bracket; its last round IS the final,
      // so lift it into `finals` where our bracket overlay expects to find it.
      if (!phase.finals.length && phase.winners.length && phase.type === 'SINGLE_ELIMINATION') {
        const last = phase.winners[phase.winners.length - 1];
        if (last && last.sets.length === 1) {
          phase.finals = [{ name: last.name || 'Final', sets: last.sets }];
          phase.winners = phase.winners.slice(0, -1);
        }
      }
      phase.name = str((st.brackets[0] || {}).title) || (format === 'DOUBLE_ELIMINATION' ? 'Playoffs' : 'Bracket');
    } else if (Array.isArray(st.groups) && st.groups.length) {
      // Group stage -> the schedule lane, one block per group (that is how our board draws pools).
      phase.schedule = st.groups.map((g) => ({
        name: str(g.title) || ('Group ' + (g.number || '')),
        sets: (g.matchSeries || []).map(mapSeries).filter(Boolean)
      })).filter((x) => x.sets.length);
      phase.name = 'Group Stage';
    } else if (Array.isArray(st.rounds) && st.rounds.length) {
      // Swiss -> rounds in the schedule lane, same as our Challonge swiss handling.
      phase.schedule = st.rounds.map(roundToBlock).filter((x) => x.sets.length);
      phase.name = 'Swiss';
    }

    if (stages.length > 1 && phase.name) phase.name = `${phase.name}`;
    return phase;
  }).filter((p) => p.winners.length || p.losers.length || p.finals.length || p.schedule.length);
}

/* Every series in the tournament, flattened — the source for the queue, the feed and standings. */
function allSeries(tournament) {
  const out = [];
  (tournament.stages || []).forEach((st) => {
    (st.brackets || []).forEach((b) => (b.rounds || []).forEach((r) => out.push(...(r.matchSeries || []))));
    (st.groups || []).forEach((g) => out.push(...(g.matchSeries || [])));
    (st.rounds || []).forEach((r) => out.push(...(r.matchSeries || [])));
  });
  return out.map(mapSeries).filter(Boolean);
}

/*
  The stream queue: what is on now and what is next.

  RUNNING first, then WAITING in play order. A series with a TBD side is kept — a producer wants to
  see "Winner of SF1 vs …" coming up — but only a series with two real names can be auto-followed
  onto the scoreboard.
*/
function buildQueue(tournament) {
  const ORDER = { RUNNING: 0, PAUSED: 1, WAITING: 2 };
  return allSeries(tournament)
    .filter((s) => ORDER[s.state] != null)
    .sort((a, b) => (ORDER[a.state] - ORDER[b.state])
      || (Date.parse(a.scheduledAt || 0) - Date.parse(b.scheduledAt || 0))
      || (a.ordinal - b.ordinal))
    .map((s) => ({
      matchId: s.id,
      round: s.title,
      identifier: s.title,
      state: s.state,
      live: s.state === 'RUNNING',
      teamA: s.a.name,
      teamB: s.b.name,
      logoA: null,
      logoB: null,
      scoreA: s.a.score,
      scoreB: s.b.score,
      bestOf: s.bestOf,
      scheduledAt: s.scheduledAt
    }));
}

/* Finished + live series in the shape the scores ticker already renders for other platforms. */
function buildMatchFeed(tournament) {
  return allSeries(tournament)
    .filter((s) => s.state === 'RUNNING' || s.state === 'COMPLETED')
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((s) => ({
      matchId: s.id,
      round: s.title,
      teamA: s.a.name,
      teamB: s.b.name,
      logoA: null,
      logoB: null,
      scoreA: s.a.score,
      scoreB: s.b.score,
      status: s.state === 'RUNNING' ? 'live' : 'final',
      winSide: s.a.winner ? 'a' : (s.b.winner ? 'b' : '')
    }));
}

/*
  Standings for the whole tournament.

  Same rule as everywhere else: a REAL placement beats an inference, and anyone still playing is
  ranked by record below nobody — they sit ABOVE the eliminated, because being alive is a better
  result than any finish already recorded.
*/
function buildStandings(tournament) {
  const lineups = ((tournament.attendance || {}).roster || {}).lineups || [];
  const rec = {};
  lineups.forEach((l) => {
    const m = mapLineup(l);
    if (m) rec[m.id] = { ...m, wins: 0, losses: 0 };
  });
  allSeries(tournament).forEach((s) => {
    if (!s.final) return;
    [s.a, s.b].forEach((side, i) => {
      const other = i === 0 ? s.b : s.a;
      const r = rec[side.lineupId];
      if (!r) return;
      if (side.winner) r.wins++;
      else if (other.winner) r.losses++;
    });
  });
  const rows = Object.values(rec);
  rows.sort((a, b) => {
    if (a.placement && b.placement) return a.placement - b.placement;
    if (a.placement) return 1;          // placed = eliminated, so below everyone still alive
    if (b.placement) return -1;
    return (b.wins - a.wins) || (a.losses - b.losses) || ((a.seed || 999) - (b.seed || 999));
  });
  return rows.map((r, i) => ({
    placement: r.placement || (i + 1),
    placementText: r.placementText || '',
    name: r.name,
    logo: r.logo,
    wins: r.wins,
    losses: r.losses
  }));
}

/*
  Top-N finish order — real placements ONLY.

  Deliberately separate from buildStandings(): standings may infer a rank for someone still
  playing, because a standings board is allowed to be provisional. A top-8 graphic states how the
  event finished, so it draws only from what Challengermode has actually decided.

  Ties are native here. A 5th–8th finish has bestPlacement 5 and displayPlacement "5-8"; we sort on
  the number and print the text, so the board says what was actually played for.
*/
function buildPlacements(tournament, limit = 8) {
  const lineups = (((tournament.attendance || {}).roster || {}).lineups || [])
    .map(mapLineup)
    .filter((l) => l && l.placement > 0)
    .sort((a, b) => a.placement - b.placement || a.name.localeCompare(b.name))
    .slice(0, limit);
  const fieldSize = (((tournament.attendance || {}).roster || {}).lineups || []).length;
  return {
    rows: lineups.map((l) => ({
      placement: l.placement,
      placementText: l.placementText,
      name: l.name,
      logo: l.logo,
      seed: l.seed,
      entrantId: l.id,
      players: l.players.map((p) => p.name),
      countryCode: '',
      character: ''
    })),
    complete: lineups.length >= Math.min(limit, fieldSize) && str(tournament.state) === 'COMPLETED'
  };
}

/* The entrant list for the team library / logo map. */
function buildEventTeams(tournament) {
  return (((tournament.attendance || {}).roster || {}).lineups || [])
    .map(mapLineup)
    .filter(Boolean)
    .sort((a, b) => (a.seed || 999) - (b.seed || 999));
}

module.exports = {
  TOURNAMENT_QUERY,
  TOURNAMENT_LIVE_QUERY,
  SEARCH_QUERY,
  SPACE_QUERY,
  mapLineup,
  mapSeries,
  mapStages,
  allSeries,
  buildQueue,
  buildMatchFeed,
  buildStandings,
  buildPlacements,
  buildEventTeams
};
