// node test/apex-postgame.test.js
// Apex official post-game results (backend/apex-postgame.js): EA's stats-token endpoint answers
// per-player rows; they are grouped into teams, ordered by placement, and become series games the
// ALGS standings already score (backend/apex-live.js computeStandings).
'use strict';
const assert = require('assert');
const pg = require('../backend/apex-postgame');
const apexLive = require('../backend/apex-live');
let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };

const sample = { matches: [
  { mid: 'b', match_start: 1760000600, map_name: 'mp_rr_tropic_island_mu2', player_results: [
    { playerName: 'Alpha1', teamName: 'Nameless', teamNum: 2, teamPlacement: 1, kills: 4, damageDealt: 1200, characterName: 'wraith', nidHash: 'h1' },
    { playerName: 'Alpha2', teamName: 'Nameless', teamNum: 2, teamPlacement: 1, kills: 2, damageDealt: 800 },
    { playerName: 'Beta1', teamName: 'Horizon', teamNum: 3, teamPlacement: 2, kills: 5, damageDealt: 1500 },
  ] },
  { mid: 'a', match_start: 1760000000, map_name: 'mp_rr_district', player_results: [
    { playerName: 'Beta1', teamName: 'Horizon', teamNum: 3, teamPlacement: 1, kills: 3 },
    { playerName: 'Alpha1', teamName: 'Nameless', teamNum: 2, teamPlacement: 6, kills: 1 },
  ] },
] };
const ms = pg.parsePostGame(sample);
ok(ms.length === 2 && ms[0].id === 'a' && ms[1].id === 'b', 'matches oldest first');
const m = ms[1];
ok(m.teams[0].name === 'Nameless' && m.teams[0].placement === 1 && m.teams[0].kills === 6 && m.teams[0].damage === 2000, 'player rows grouped into teams, kills and damage summed');
ok(m.teams[0].players.length === 2 && m.teams[0].players[0].legend === 'wraith' && m.teams[0].players[0].id === 'h1', 'players kept with legend and id');
ok(m.startedAt === 1760000600000 && m.map === 'mp_rr_tropic_island_mu2', 'seconds become ms; map kept');
// Tolerant of other shapes.
ok(pg.parsePostGame([{ player_results: [{ playerName: 'x', team_name: 'T', team_num: 1, placement: 3, eliminations: 2 }] }])[0].teams[0].kills === 2, 'a bare array and alternate field names');
ok(pg.parsePostGame({ player_results: [{ playerName: 'x', teamNum: 1, teamPlacement: 1 }] }).length === 1, 'a single match object');
ok(pg.parsePostGame({}).length === 0 && pg.parsePostGame(null).length === 0 && pg.parsePostGame({ matches: [] }).length === 0, 'nothing yet is an empty list, not an error');

// Into the series: the standings score them like live-recorded games.
const games = pg.toSeriesGames(ms, apexLive.teamKeyOf);
ok(games.length === 2 && games.every((g) => g.official) && games[1].n === 2, 'series games, numbered and marked official');
const acc = apexLive.initialState(); acc.games = games; acc.matchState = 'postmatch';
const st = apexLive.computeStandings(acc, apexLive.DEFAULT_SCORING);
const hz = st.find((r) => /Horizon/.test(r.name)), nl = st.find((r) => /Nameless/.test(r.name));
ok(hz && nl, 'both teams in the standings: ' + JSON.stringify(st.map((r) => r.name)));
// Horizon: 1st (12) + 3 kills, then 2nd (9) + 5 = 29. Nameless: 6th (3) + 1, then 1st (12) + 6 = 22.
ok(hz.seriesPoints === 29 && nl.seriesPoints === 22 && hz.rank === 1, 'official placement and kills scored with the ALGS table: ' + hz.seriesPoints + ' / ' + nl.seriesPoints);

// Token checks happen before any request.
(async () => {
  let err = null;
  try { await pg.fetchPostGame('a b'); } catch (e) { err = e; }
  ok(err && /stats token/.test(err.message), 'a malformed token is refused without calling EA');
  console.log('apex-postgame: all ' + pass + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
