// node test/match-title.test.js
// The shared title template (Twitch title + VOD names + recordings.csv).
'use strict';
const mt = require('../backend/match-title');

let failures = 0;
function eq(actual, expected, label) {
  if (actual === expected) console.log('PASS  ' + label);
  else { failures++; console.log('FAIL  ' + label + '\n      expected: ' + JSON.stringify(expected) + '\n      actual:   ' + JSON.stringify(actual)); }
}

const full = { event: 'Nameless Weekly 12', round: 'Winners Quarters', team1: 'Team Alpha', team2: 'Team Bravo', score: '2-1', bestof: 'Bo5', game: 'Rocket League', maps: '', date: '2026-10-06', time: '19:30' };

// ── fill + tidy ──
eq(mt.buildTitle(mt.DEFAULT_TWITCH_TEMPLATE, full), 'Nameless Weekly 12 | Winners Quarters: Team Alpha vs Team Bravo', 'twitch default, every field present');
eq(mt.buildTitle(mt.DEFAULT_TWITCH_TEMPLATE, { ...full, round: '' }), 'Nameless Weekly 12 | Team Alpha vs Team Bravo', 'no round: no dangling colon');
eq(mt.buildTitle(mt.DEFAULT_TWITCH_TEMPLATE, { ...full, event: '' }), 'Winners Quarters: Team Alpha vs Team Bravo', 'no event: no leading pipe');
eq(mt.buildTitle(mt.DEFAULT_VOD_TEMPLATE, { ...full, round: '' }), 'Nameless Weekly 12 - Team Alpha vs Team Bravo', 'vod default, no round');
eq(mt.buildTitle('{event} - {team1} ({maps}) vs {team2} ({maps}) {game}', full), 'Nameless Weekly 12 - Team Alpha vs Team Bravo Rocket League', 'empty parentheses removed');
eq(mt.buildTitle('{p1} vs {p2} [{score}]', full), 'Team Alpha vs Team Bravo [2-1]', 'p1/p2 aliases');
eq(mt.buildTitle('{event} | {team1} vs {team2}', { ...full, team2: '' }), 'Nameless Weekly 12 | Team Alpha', 'missing side drops the vs');
eq(mt.buildTitle('{event} {nope}', full), 'Nameless Weekly 12 {nope}', 'unknown placeholder left visible');
eq(mt.buildTitle('{event} - - {round}', full), 'Nameless Weekly 12 - Winners Quarters', 'doubled separators collapse');
eq(mt.buildTitle('x'.repeat(200), full, 140).length <= 140, true, 'clamped to the Twitch limit');

// ── rounds ──
eq(mt.normalizeRound('WINNERS QUARTER-FINAL'), 'Winners Quarters', 'start.gg quarter-final, upper-cased');
eq(mt.normalizeRound('Losers Semi-Final'), 'Losers Semis', 'semi-final');
eq(mt.normalizeRound('GRAND FINAL RESET'), 'Grand Finals Reset', 'grand final reset');
eq(mt.normalizeRound('Grand Final'), 'Grand Finals', 'grand final');
eq(mt.normalizeRound('WINNERS FINAL'), 'Winners Finals', 'winners final');
eq(mt.normalizeRound('LCQ DAY 2'), 'LCQ Day 2', 'acronym kept');
eq(mt.normalizeRound('TOP8 WINNERS ROUND 1'), 'Top8 Winners Round 1', 'top8 kept readable');
eq(mt.normalizeRound('Pool A3'), 'Pool A3', 'mixed case left alone');
eq(mt.normalizeRound(''), '', 'empty');

// ── sponsors + filenames ──
eq(mt.stripSponsor('TSM | Leffen'), 'Leffen', 'sponsor prefix stripped');
eq(mt.stripSponsor('Leffen'), 'Leffen', 'no prefix untouched');
eq(mt.sanitizeFilename('A: B / C? "D" <E>|F*.'), 'A B C D E F', 'windows-illegal chars removed, trailing dot');
eq(mt.sanitizeFilename('CON'), '_CON', 'reserved device name');

// ── matchFields from app state ──
const st = {
  eventName: 'Nameless Weekly 12', roundLabel: 'WINNERS SEMI-FINAL', bestOf: 5,
  teams: { blue: { name: 'TSM | LEFFEN', nameRaw: 'TSM | Leffen' }, orange: { name: 'NRG', nameRaw: 'nrg' } },
  series: { blue: 3, orange: 1 },
  match: { maps: [{ name: 'Mirage', played: true }, { name: 'Inferno', played: false }] }
};
const f = mt.matchFields(st, { gameName: 'CS2', now: new Date(2026, 9, 6, 9, 5) });
eq(f.team1, 'Leffen', 'nameRaw casing used when it still matches the on-air name');
eq(f.team2, 'nrg', 'nameRaw used for team2');
eq(mt.matchFields({ ...st, teams: { blue: { name: 'EDITED', nameRaw: 'Leffen' }, orange: {} } }).team1, 'EDITED', 'producer edit beats nameRaw');
eq(mt.matchFields({ teams: { blue: { name: 'BLUE TEAM' }, orange: { name: 'TBD' } } }).team1, '', 'placeholder team name is empty');
eq(f.round, 'Winners Semis', 'round normalized');
eq(f.score, '3-1', 'score');
eq(f.bestof, 'Bo5', 'best of');
eq(f.maps, 'Mirage', 'only played maps');
eq(f.date + ' ' + f.time, '2026-10-06 09:05', 'local date/time');

// ── csv ──
eq(mt.csvCell('a,"b"'), '"a,""b"""', 'csv quoting');
eq(mt.formatDuration(3725), '1:02:05', 'duration h:mm:ss');
eq(mt.formatDuration(65), '1:05', 'duration m:ss');

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
