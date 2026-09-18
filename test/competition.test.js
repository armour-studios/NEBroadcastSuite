// node test/competition.test.js
//
// The competition interchange is the contract every outside system (Google Sheets, a league
// website's JSON feed, the local write API, CSV) uses to reach a league, and the live feed it builds
// is what the ticker / schedule / BRB scenes draw. These pin the behaviours that would silently
// corrupt a season if they regressed: re-syncing must not duplicate fixtures, names must never
// fuzzy-merge two teams, pruning must never delete a hand-added fixture, and a source's standings
// table must not be wiped by Recalculate.
'use strict';
const assert = require('assert');
const C = require('../backend/competition.js');

let n = 0;
const uid = (p) => p + (++n);
const ok = (name, fn) => { fn(); console.log('PASS  ' + name); };

ok('CSV parser handles quotes, doubled quotes, CRLF and blank lines', () => {
  const rows = C.parseCsv('Team A,Team B,Note\r\n"St. John\'s","Lakeside, North","say ""hi"""\r\n\r\nX,Y,\n');
  assert.deepStrictEqual(rows, [['Team A', 'Team B', 'Note'], ["St. John's", 'Lakeside, North', 'say "hi"'], ['X', 'Y', '']]);
});

ok('csvToDoc detects schedule / standings / team list shapes', () => {
  assert.strictEqual(C.csvToDoc('Home,Away,Date\nA,B,2026-09-20').shape, 'schedule');
  assert.strictEqual(C.csvToDoc('Team,W,L\nA,1,0').shape, 'standings');
  assert.strictEqual(C.csvToDoc('School\nA').shape, 'teams');
  assert.ok(C.csvToDoc('foo,bar\n1,2').error);
});

ok('validateDoc normalises dates, 12h times, statuses and aliases', () => {
  const { doc, errors, warnings } = C.validateDoc({
    matches: [
      { home: 'A', away: 'B', date: '9/20/26', time: '7:30 PM', homeScore: 2, awayScore: 1 },
      { teamA: 'A', teamB: 'C', status: 'In Progress' },
      { teamA: 'A', teamB: 'A' },
      { teamA: 'B', teamB: 'C', status: 'nonsense' },
    ],
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(doc.matches.length, 3);
  assert.strictEqual(doc.matches[0].date, '2026-09-20');
  assert.strictEqual(doc.matches[0].time, '19:30');
  assert.strictEqual(doc.matches[0].status, 'completed');
  assert.strictEqual(doc.matches[1].status, 'live');
  assert.strictEqual(doc.matches[2].status, 'scheduled');
  assert.ok(warnings.some((w) => /same team/.test(w)));
  assert.ok(warnings.some((w) => /nonsense/.test(w)));
});

ok('validateDoc rejects an empty document and bad JSON', () => {
  assert.ok(C.validateDoc({}).errors.length);
  assert.ok(C.validateDoc('{nope').errors.length);
});

ok('applyDoc is idempotent — the same sheet synced twice adds nothing', () => {
  const lg = { id: 'lg1', teams: [], schedule: [], standings: [] };
  const { doc } = C.validateDoc(C.csvToDoc('Home,Away,Week,Date\nRiverside,Lakeside,1,2026-09-20\nLakeside,Hilltop,1,2026-09-20').doc);
  const r1 = C.applyDoc(lg, doc, { uid, prune: true });
  assert.strictEqual(r1.matchesAdded, 2);
  assert.strictEqual(lg.teams.length, 3);
  const r2 = C.applyDoc(lg, doc, { uid, prune: true });
  assert.strictEqual(r2.matchesAdded, 0);
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(lg.schedule.length, 2);
});

ok('a result typed into the sheet updates the same fixture in place (no id column)', () => {
  const lg = { id: 'lg1', teams: [], schedule: [], standings: [] };
  C.applyDoc(lg, C.validateDoc(C.csvToDoc('Home,Away,Week\nA,B,1').doc).doc, { uid, prune: true });
  const r = C.applyDoc(lg, C.validateDoc(C.csvToDoc('Home,Away,Week,Home Score,Away Score\nA,B,1,3,1').doc).doc, { uid, prune: true });
  assert.strictEqual(lg.schedule.length, 1);
  assert.strictEqual(r.matchesUpdated, 1);
  assert.deepStrictEqual([lg.schedule[0].result.scoreA, lg.schedule[0].result.scoreB], [3, 1]);
  assert.strictEqual(r.needsRecalc, true);
});

ok('source ids win — a renamed team and a rescheduled match still update the same rows', () => {
  const lg = { id: 'lg1', teams: [], schedule: [], standings: [] };
  const v1 = { teams: [{ id: 't1', name: 'Old Name' }, { id: 't2', name: 'Other' }], matches: [{ id: 'm1', teamA: 't1', teamB: 't2', date: '2026-09-20' }] };
  C.applyDoc(lg, C.validateDoc(v1).doc, { uid });
  const v2 = { teams: [{ id: 't1', name: 'New Name' }, { id: 't2', name: 'Other' }], matches: [{ id: 'm1', teamA: 't1', teamB: 't2', date: '2026-09-27', scoreA: 2, scoreB: 0 }] };
  C.applyDoc(lg, C.validateDoc(v2).doc, { uid });
  assert.strictEqual(lg.teams.length, 2);
  assert.strictEqual(lg.schedule.length, 1);
  assert.strictEqual(lg.schedule[0].date, '2026-09-27');
});

ok('names match exactly or normalised, never by containment', () => {
  const lg = { id: 'lg1', teams: [{ id: 'x', teamName: "St. John's Esports" }, { id: 'y', teamName: 'Lakeside' }], schedule: [], standings: [] };
  C.applyDoc(lg, C.validateDoc({ matches: [{ teamA: 'St Johns', teamB: 'Lakeside, North' }] }).doc, { uid });
  assert.strictEqual(lg.schedule[0].teamA, 'x', "St Johns should match St. John's Esports");
  assert.notStrictEqual(lg.schedule[0].teamB, 'y', 'Lakeside, North must NOT merge into Lakeside');
  assert.strictEqual(lg.teams.length, 3);
});

ok('prune removes stale synced fixtures but never hand-added ones', () => {
  const lg = { id: 'lg1', teams: [{ id: 'a', teamName: 'A' }, { id: 'b', teamName: 'B' }], schedule: [
    { id: 'hand', teamA: 'a', teamB: 'b', week: '9', result: { scoreA: null, scoreB: null } },
  ], standings: [] };
  C.applyDoc(lg, C.validateDoc({ matches: [{ id: 's1', teamA: 'A', teamB: 'B', week: '1' }, { id: 's2', teamA: 'B', teamB: 'A', week: '2' }] }).doc, { uid, prune: true });
  assert.strictEqual(lg.schedule.length, 3);
  const r = C.applyDoc(lg, C.validateDoc({ matches: [{ id: 's1', teamA: 'A', teamB: 'B', week: '1' }] }).doc, { uid, prune: true });
  assert.strictEqual(r.matchesRemoved, 1);
  assert.deepStrictEqual(lg.schedule.map((m) => m.id).sort(), ['hand', lg.schedule.find((m) => m.extId === 's1').id].sort());
});

ok('a source standings table locks manual mode and keeps its points', () => {
  const lg = { id: 'lg1', teams: [], schedule: [], standings: [], standingsMode: 'schedule' };
  const r = C.applyDoc(lg, C.validateDoc(C.csvToDoc('Team,W,L,Pts\nB,1,1,3\nA,2,0,6').doc).doc, { uid });
  assert.strictEqual(lg.standingsMode, 'manual');
  assert.strictEqual(r.needsRecalc, false);
  assert.strictEqual(lg.standings.length, 2);
  assert.ok(lg.standings.every((s) => s.ptsLocked));
});

ok('source branding fills gaps but never overwrites a producer-set crest', () => {
  const lg = { id: 'lg1', teams: [{ id: 'a', teamName: 'A', logo: 'mine.png' }], schedule: [], standings: [] };
  C.applyDoc(lg, C.validateDoc({ teams: [{ name: 'A', logo: 'https://x/theirs.png', abbr: 'AAA' }, { name: 'B', logo: 'https://x/b.png' }] }).doc, { uid });
  assert.strictEqual(lg.teams[0].logo, 'mine.png');
  assert.strictEqual(lg.teams[0].abbr, 'AAA');
  assert.strictEqual(lg.teams[1].logo, 'https://x/b.png');
});

ok('buildFeed splits live / upcoming (soonest first) / results (latest first) and skips cancelled', () => {
  const lg = { id: 'lg1', name: 'Fall League', season: 'S3', teams: [
    { id: 'a', teamName: 'A' }, { id: 'b', teamName: 'B' }, { id: 'c', teamName: 'C', logo: 'data:image/png;base64,QQ' },
  ], schedule: [
    { id: 'm1', teamA: 'a', teamB: 'b', date: '2026-09-27', time: '19:00', result: {} },
    { id: 'm2', teamA: 'a', teamB: 'c', date: '2026-09-20', time: '19:00', result: {} },
    { id: 'm3', teamA: 'b', teamB: 'c', date: '2026-09-13', result: { scoreA: 2, scoreB: 1 } },
    { id: 'm4', teamA: 'b', teamB: 'c', date: '2026-09-06', result: {}, games: [{ scoreA: 1, scoreB: 3 }, { scoreA: 0, scoreB: 2 }] },
    { id: 'm5', teamA: 'a', teamB: 'c', result: {}, status: 'cancelled' },
    { id: 'm6', teamA: 'c', teamB: 'b', result: {}, status: 'live' },
  ] };
  const f = C.buildFeed(lg, { liveIds: new Set(['m1']) });
  assert.deepStrictEqual(f.live.map((m) => m.id), ['m1', 'm6']);
  assert.deepStrictEqual(f.upcoming.map((m) => m.id), ['m2']);
  assert.deepStrictEqual(f.results.map((m) => m.id), ['m3', 'm4']);
  assert.strictEqual(f.results[1].winSide, 'b');
  assert.deepStrictEqual([f.results[1].scoreA, f.results[1].scoreB], [0, 2]);
  assert.strictEqual(f.next.id, 'm1');
  assert.strictEqual(f.title, 'Fall League — S3');
  assert.ok(f.logos.C, 'a league-only team logo travels once in logos');
});

ok('leagueToDoc round-trips back through applyDoc into an empty league', () => {
  const src = { id: 'lg1', name: 'Fall', teams: [{ id: 'a', teamName: 'A' }, { id: 'b', teamName: 'B', logo: 'data:image/png;base64,QQ' }],
    schedule: [{ id: 'm1', teamA: 'a', teamB: 'b', week: '1', format: 'bo3', result: { scoreA: 2, scoreB: 0 }, games: [] }],
    standings: [{ teamId: 'a', w: 1, l: 0, t: 0, pts: 3 }, { teamId: 'b', w: 0, l: 1, t: 0, pts: 0 }] };
  const doc = C.leagueToDoc(src);
  assert.ok(!doc.teams[1].logo, 'data: URI logos are not exported');
  const { doc: v, errors } = C.validateDoc(JSON.parse(JSON.stringify(doc)));
  assert.deepStrictEqual(errors, []);
  const dst = { id: 'lg2', teams: [], schedule: [], standings: [] };
  C.applyDoc(dst, v, { uid });
  assert.strictEqual(dst.teams.length, 2);
  assert.strictEqual(dst.schedule.length, 1);
  assert.strictEqual(dst.schedule[0].format, 'bo3');
  assert.strictEqual(dst.standings[0].pts, 3);
});

console.log('\nAll competition tests passed.');
