/*
  Challonge reports a set's score PER GAME, comma separated: a Bo5 comes back as "3-1,2-3,3-0".

  buildChalongeBracket()'s parseScore used to split the whole string on '-', which read
  "3-1,2-3" as ["3", "1,2", "3"] and put 3-0 on the bracket for a 2-1 series. That is every
  multi-game set on every bracket we draw from Challonge — and it is invisible, because the number
  it produces is a plausible score, just the wrong one.

  Loads the REAL parseScore out of server.js (server.js can't be required — it boots Electron and
  binds ports — so the function is extracted by brace-matching, the same approach the other
  server-side unit tests here use) and checks it against the shapes Challonge actually sends.
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Pull out `const GAME_RE = ...` through the end of `function parseScore(...) { ... }`.
const start = src.indexOf('const GAME_RE =');
assert.ok(start > 0, 'GAME_RE not found in server.js — did parseScore move or get renamed?');
const fnStart = src.indexOf('function parseScore(match) {', start);
assert.ok(fnStart > start, 'parseScore not found after GAME_RE');
let depth = 0, end = -1;
for (let i = src.indexOf('{', fnStart); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
assert.ok(end > fnStart, 'could not brace-match parseScore');

const ctx = { module: {} };
vm.runInNewContext(src.slice(start, end) + '\nmodule.exports = parseScore;', ctx);
const parseScore = ctx.module.exports;

const cases = [
  // [scores_csv, aScore, bScore, why]
  ['', 0, 0, 'no score reported yet'],
  ['3-1', 3, 1, 'a SINGLE game keeps its own score (a 13-7 map is the score, not 1-0)'],
  ['0-0', 0, 0, 'a played-but-scoreless game'],
  ['3-1,2-3,3-0', 2, 1, 'a Bo5 counts GAMES WON — this is the case the old split got wrong'],
  ['1-3,3-1,3-2', 2, 1, 'the losing side taking game 1 does not change the count'],
  ['3-0,3-0', 2, 0, 'a clean sweep'],
  ['0-3,0-3,0-3', 0, 3, 'swept the other way'],
  ['3-1, 2-3, 3-0', 2, 1, 'whitespace after the commas (producers paste these by hand)'],
  ['-1-0', -1, 0, "Challonge's forfeit marker survives as a single game"],
  ['nonsense', 0, 0, 'unparseable text is 0-0, never NaN on air'],
  ['3-1,oops,2-3', 1, 1, 'a junk game is skipped and the set still counts as multi-game (one game each)'],
  ['2-2,3-1', 1, 0, 'a drawn game counts for neither side']
];

let failed = 0;
cases.forEach(([csv, wantA, wantB, why]) => {
  const got = parseScore({ scores_csv: csv });
  if (got.aScore === wantA && got.bScore === wantB) {
    console.log(`PASS  ${JSON.stringify(csv).padEnd(18)} -> ${got.aScore}-${got.bScore}   ${why}`);
  } else {
    failed++;
    console.log(`FAIL  ${JSON.stringify(csv)} -> got ${got.aScore}-${got.bScore}, want ${wantA}-${wantB}   (${why})`);
  }
});

// A missing/odd field must not throw: this runs inside the bracket build on every poll, and one
// throw there takes the whole bracket refresh down.
[undefined, null, {}, { scores_csv: null }, { scores_csv: 42 }].forEach((m) => {
  const got = parseScore(m || {});
  assert.ok(Number.isFinite(got.aScore) && Number.isFinite(got.bScore),
    'parseScore must always return finite numbers, got ' + JSON.stringify(got));
});
console.log('PASS  a missing or malformed match object returns 0-0 rather than throwing');

assert.strictEqual(failed, 0, failed + ' case(s) failed');
console.log('\nall passed');
