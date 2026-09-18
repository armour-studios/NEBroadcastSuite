// Auto-follow must never take a producer off the match they are on, or off their own station.
// Drives the REAL pickAutoFollowSet out of server.js (pulled out by source, so the test can't drift
// from the shipped function) with the shapes fetchStreamQueue builds.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = src.indexOf('function pickAutoFollowSet');
assert.ok(start > 0, 'pickAutoFollowSet not found in server.js');
const end = src.indexOf('\n}', start) + 2;
const pickAutoFollowSet = new Function(src.slice(start, end) + ' return pickAutoFollowSet;')();

const set = (o) => ({ state: 1, live: false, onStream: false, winnerId: null, ...o });
const id = (s) => (s ? s.setId : null);

// A Smash station mid-bracket: Winners Final on air, the rounds it feeds still unresolved.
const wf = set({ setId: 'wf', stream: 'hq', teamA: 'Ling', teamB: 'Agency | Morris', onStream: true });
const lf = set({ setId: 'lf', stream: 'hq', teamA: 'TBD', teamB: 'TBD' });
const gf = set({ setId: 'gf', stream: 'hq', teamA: 'TBD', teamB: 'TBD' });
const other = set({ setId: 'tv1', stream: 'tv', teamA: 'Zain', teamB: 'Cody', state: 2, live: true, onStream: true });
const queue = [wf, lf, gf, other];

assert.strictEqual(id(pickAutoFollowSet(queue, 'hq', 'wf')), 'wf',
  'the match on air is held while start.gg still has it unreported');
assert.strictEqual(id(pickAutoFollowSet(queue, 'hq', null)), 'wf',
  'nothing on air yet — take this station\'s cued-up set');
assert.strictEqual(id(pickAutoFollowSet(queue, 'hq', 'gf')), 'wf',
  'a TBD vs TBD set is not something to hold either');

// The TO stacks another set on top of ours mid-match (or the queue simply re-orders).
const jumped = [set({ setId: 'x', stream: 'hq', teamA: 'A', teamB: 'B', onStream: true }), { ...wf, onStream: false }, lf, gf];
assert.strictEqual(id(pickAutoFollowSet(jumped, 'hq', 'wf')), 'wf',
  'a reshuffled queue head must not pull the scoreboard off a live match');

// Our set is reported. The next rounds are still empty shells — put nothing on rather than TBD vs TBD.
const reported = [{ ...wf, state: 3, onStream: false }, { ...lf, onStream: true }, gf, other];
assert.strictEqual(pickAutoFollowSet(reported, 'hq', 'wf'), null,
  'never auto-follow onto a set with both sides unresolved');
assert.strictEqual(pickAutoFollowSet(reported, 'hq', null), null,
  '...and that holds with nothing on air either');

// Losers Final resolves — now there is a real match to advance to.
const resolved = reported.map((s) => (s.setId === 'lf' ? { ...s, teamA: 'Agency | Morris', teamB: 'Sol' } : s));
assert.strictEqual(id(pickAutoFollowSet(resolved, 'hq', 'wf')), 'lf',
  'once the next match has entrants, auto-follow advances');

// Stations stay separate in every direction.
assert.strictEqual(id(pickAutoFollowSet(resolved, 'tv', null)), 'tv1', 'the other station follows its own set');
assert.strictEqual(pickAutoFollowSet(resolved, 'lan3', null), null,
  'a station with no sets on the queue gets nothing — never another station\'s match');
assert.strictEqual(id(pickAutoFollowSet(queue, '', null)), 'tv1',
  '"All streams" is unchanged: first set start.gg marks in progress, anywhere');

console.log('PASS  auto-follow holds the live match and stays on its own station — 10 assertions');
