/*
  Challengermode maps a GraphQL tournament graph onto our bracket / queue / placement shapes.
  Three things in that mapping can go silently wrong on air, so they are pinned here:

  1. **Side assignment.** `results.lineupResults[].lineupNumber` is the authority on which side a
     score belongs to — `lineups[]` order is NOT guaranteed to match. Pairing them by array index
     puts the winner's score under the loser's name, and it looks completely plausible.
  2. **Bracket side.** Upper / lower / grand-final come from `TournamentNodeLabel`, not from a
     round number's sign. Getting this wrong draws the losers bracket as the winners bracket.
  3. **Placement ties.** Challengermode models a finish as a RANGE (5th–8th). Flattening that to a
     single number invents a 5th and a 6th place that were never played for.

  The fixture is shaped from the real SDL (publicapi.challengermode.com/graphql?sdl).
*/
const assert = require('assert');
const cm = require('../backend/challengermode');

const series = (id, title, state, aName, aId, aScore, aPlace, bName, bId, bScore, bPlace, final, opts = {}) => ({
  id, title, ordinal: opts.ordinal || 0, state, bestOf: opts.bestOf || 3,
  scheduledStartTimeAt: opts.at || null, labels: opts.labels || [],
  lineups: [{ id: aId, name: aName }, { id: bId, name: bName }],
  results: {
    final, draw: false,
    // Deliberately listed OUT of lineup order: side assignment must come from lineupNumber.
    lineupResults: [
      { lineupNumber: 1, score: bScore, placement: bPlace, final },
      { lineupNumber: 0, score: aScore, placement: aPlace, final }
    ]
  }
});

const lineup = (id, name, seed, best, worst, text) => ({
  id, name, seed, disqualified: false,
  placement: best ? { bestPlacement: best, worstPlacement: worst, displayPlacement: text } : null,
  logo: { url: 'https://img/' + id + '.png' },
  members: [{ user: { username: name + '_p1' }, captain: true }]
});

const TOURNAMENT = {
  id: 't-1', name: 'Nameless Open', state: 'RUNNING',
  gameTitle: { id: 'g-1', slug: 'rocket-league', title: 'Rocket League' },
  attendance: {
    roster: {
      lineupCount: 4,
      lineups: [
        lineup('L1', 'Alpha', 1, 0, 0, ''),            // still alive — no placement yet
        lineup('L2', 'Bravo', 2, 0, 0, ''),
        lineup('L3', 'Charlie', 3, 3, 4, '3-4'),        // tied 3rd–4th
        lineup('L4', 'Delta', 4, 3, 4, '3-4')
      ]
    }
  },
  stages: [
    {
      index: 0, format: 'DOUBLE_ELIMINATION', lineupCount: 4,
      brackets: [
        {
          title: 'Upper Bracket', labels: ['DOUBLE_ELIMINATION_UPPER_BRACKET'],
          rounds: [{
            roundNumber: 0, title: 'Upper Semifinal', labels: [], isLastRound: false,
            matchSeries: [series('S1', 'Upper Semifinal', 'COMPLETED', 'Alpha', 'L1', 2, 1, 'Charlie', 'L3', 1, 2, true, { ordinal: 1 })]
          }]
        },
        {
          title: 'Lower Bracket', labels: ['DOUBLE_ELIMINATION_LOWER_BRACKET'],
          rounds: [{
            roundNumber: 0, title: 'Lower Round 1', labels: [], isLastRound: false,
            matchSeries: [series('S2', 'Lower Round 1', 'RUNNING', 'Bravo', 'L2', 1, 0, 'Delta', 'L4', 0, 0, false, { ordinal: 2 })]
          }]
        },
        {
          title: 'Grand Final', labels: ['DOUBLE_ELIMINATION_FINALS_BRACKET'],
          rounds: [{
            roundNumber: 0, title: 'Grand Final', labels: ['FINALS_ROUND'], isLastRound: true,
            matchSeries: [series('S3', 'Grand Final', 'WAITING', 'Alpha', 'L1', 0, 0, 'TBD', '', 0, 0, false, { ordinal: 3 })]
          }]
        }
      ]
    }
  ]
};

// ── 1. side assignment ──────────────────────────────────────────────────────
const s1 = cm.mapSeries(TOURNAMENT.stages[0].brackets[0].rounds[0].matchSeries[0]);
assert.strictEqual(s1.a.name, 'Alpha');
assert.strictEqual(s1.a.score, 2, 'side A must take lineupNumber 0, not results[0]');
assert.strictEqual(s1.b.name, 'Charlie');
assert.strictEqual(s1.b.score, 1, 'side B must take lineupNumber 1, not results[1]');
assert.strictEqual(s1.a.winner, true, 'placement 1 on a final result = winner');
assert.strictEqual(s1.b.winner, false);
console.log('PASS  scores follow lineupNumber, not array order');

// A non-final result must not crown anyone, even with a placement already present.
const live = cm.mapSeries(TOURNAMENT.stages[0].brackets[1].rounds[0].matchSeries[0]);
assert.strictEqual(live.a.winner, false, 'a series that is not final has no winner yet');
assert.strictEqual(live.b.winner, false);
console.log('PASS  an unfinished series crowns nobody');

// ── 2. bracket side from labels ─────────────────────────────────────────────
const phases = cm.mapStages(TOURNAMENT);
assert.strictEqual(phases.length, 1, 'one stage -> one phase');
const p = phases[0];
assert.strictEqual(p.type, 'DOUBLE_ELIMINATION');
assert.strictEqual(p.winners.length, 1, 'upper bracket -> winners');
assert.strictEqual(p.winners[0].sets[0].a.name, 'Alpha');
assert.strictEqual(p.losers.length, 1, 'lower bracket -> losers');
assert.strictEqual(p.losers[0].sets[0].a.name, 'Bravo');
assert.strictEqual(p.finals.length, 1, 'finals bracket -> finals');
assert.strictEqual(p.finals[0].sets[0].title, 'Grand Final');
console.log('PASS  upper/lower/grand-final come from the bracket labels');

// ── 3. placement ranges ─────────────────────────────────────────────────────
const pl = cm.buildPlacements(TOURNAMENT, 8);
assert.strictEqual(pl.rows.length, 2, 'only lineups with a real placement appear');
assert.deepStrictEqual(pl.rows.map((r) => r.name).sort(), ['Charlie', 'Delta']);
assert.strictEqual(pl.rows[0].placement, 3, 'bestPlacement is the sortable number');
assert.strictEqual(pl.rows[0].placementText, '3-4', 'the tie RANGE survives for the board to print');
assert.strictEqual(pl.complete, false, 'a RUNNING tournament is never a complete top 8');
console.log('PASS  placement ranges survive, and a running event is not "complete"');

// A still-alive entrant must never be given a placement it has not earned.
assert.ok(!pl.rows.some((r) => r.name === 'Alpha'), 'an entrant still playing has no placement');
console.log('PASS  entrants still playing are absent from the finish order');

// ── standings: alive above eliminated ───────────────────────────────────────
const st = cm.buildStandings(TOURNAMENT);
const rank = (n) => st.findIndex((r) => r.name === n);
assert.ok(rank('Alpha') < rank('Charlie'), 'an entrant still alive outranks one already eliminated');
assert.strictEqual(st.find((r) => r.name === 'Alpha').wins, 1, 'W/L comes from final series only');
assert.strictEqual(st.find((r) => r.name === 'Charlie').losses, 1);
assert.strictEqual(st.find((r) => r.name === 'Bravo').wins, 0, 'a running series contributes nothing');
console.log('PASS  standings rank the living above the eliminated, W/L from final results only');

// ── queue ordering ──────────────────────────────────────────────────────────
const q = cm.buildQueue(TOURNAMENT);
assert.strictEqual(q[0].state, 'RUNNING', 'what is live sorts first');
assert.strictEqual(q[0].teamA, 'Bravo');
assert.ok(q.some((m) => m.teamB === 'TBD'), 'an upcoming series with a TBD side is still listed');
assert.ok(!q.some((m) => m.state === 'COMPLETED'), 'finished series are not in the play queue');
console.log('PASS  queue puts the live series first and keeps TBD fixtures');

// ── feed ────────────────────────────────────────────────────────────────────
const feed = cm.buildMatchFeed(TOURNAMENT);
const done = feed.find((m) => m.matchId === 'S1');
assert.strictEqual(done.status, 'final');
assert.strictEqual(done.winSide, 'a');
assert.ok(!feed.some((m) => m.matchId === 'S3'), 'a series that has not started is not in the feed');
console.log('PASS  feed marks final results and their winning side');

// ── a single-elimination stage lifts its last round into `finals` ───────────
const SE = {
  ...TOURNAMENT,
  stages: [{
    index: 0, format: 'SINGLE_ELIMINATION', lineupCount: 4,
    brackets: [{
      title: 'Bracket', labels: ['SINGLE_ELIMINATION_BRACKET'],
      rounds: [
        { roundNumber: 0, title: 'Semifinal', labels: [], isLastRound: false,
          matchSeries: [series('A', 'SF1', 'COMPLETED', 'Alpha', 'L1', 2, 1, 'Charlie', 'L3', 0, 2, true),
                        series('B', 'SF2', 'COMPLETED', 'Bravo', 'L2', 2, 1, 'Delta', 'L4', 1, 2, true)] },
        { roundNumber: 1, title: 'Final', labels: ['FINALS_ROUND'], isLastRound: true,
          matchSeries: [series('C', 'Final', 'COMPLETED', 'Alpha', 'L1', 3, 1, 'Bravo', 'L2', 2, 2, true)] }
      ]
    }]
  }]
};
const sePhase = cm.mapStages(SE)[0];
assert.strictEqual(sePhase.finals.length, 1, 'the last single-elim round becomes the final');
assert.strictEqual(sePhase.finals[0].sets[0].a.name, 'Alpha');
assert.strictEqual(sePhase.winners.length, 1, 'and is no longer duplicated in the winners rounds');
console.log('PASS  single elimination lifts its last round into finals');

// ── group + swiss stages land in the schedule lane ──────────────────────────
const GROUPS = {
  ...TOURNAMENT,
  stages: [{
    index: 0, format: 'ROUND_ROBIN', lineupCount: 4,
    groups: [{ title: 'Group A', number: 1, state: 'RUNNING',
      matchSeries: [series('G1', 'A1', 'COMPLETED', 'Alpha', 'L1', 2, 1, 'Bravo', 'L2', 0, 2, true)] }]
  }]
};
const gPhase = cm.mapStages(GROUPS)[0];
assert.strictEqual(gPhase.schedule.length, 1);
assert.strictEqual(gPhase.schedule[0].name, 'Group A');
assert.strictEqual(gPhase.winners.length, 0, 'a group stage draws no elimination bracket');
console.log('PASS  group stages map onto the schedule lane');

// ── id parsing: producers paste URLs, not UUIDs ─────────────────────────────
const { parseTournamentId } = require('../backend/integrations/challengermode-client');
const ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
[
  ID,
  `https://www.challengermode.com/tournaments/${ID}`,
  `https://www.challengermode.com/s/my-space/tournaments/${ID}`,
  `https://www.challengermode.com/tournaments/${ID}?tab=bracket`,
  `  ${ID.toUpperCase()}  `
].forEach((input) => {
  assert.strictEqual(parseTournamentId(input), ID, 'failed to parse: ' + input);
});
assert.strictEqual(parseTournamentId('not-a-tournament'), '', 'junk yields no id rather than a guess');
assert.strictEqual(parseTournamentId(''), '');
assert.strictEqual(parseTournamentId(null), '');
console.log('PASS  tournament ids parse out of every URL form producers paste');

// ── malformed payloads must not throw: this runs on every poll ─────────────
assert.deepStrictEqual(cm.mapStages({}), []);
assert.deepStrictEqual(cm.buildQueue({}), []);
assert.deepStrictEqual(cm.buildStandings({}), []);
assert.deepStrictEqual(cm.buildPlacements({}).rows, []);
assert.strictEqual(cm.mapSeries(null), null);
assert.strictEqual(cm.mapLineup(null), null);
const bare = cm.mapSeries({ id: 'x' });
assert.strictEqual(bare.a.name, 'TBD');
assert.strictEqual(bare.a.score, 0);
console.log('PASS  an empty or partial payload maps to empty, never throws');

console.log('\nall passed');
