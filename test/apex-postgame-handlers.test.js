// node test/apex-postgame-handlers.test.js
// Apex official results, panel side (backend/ws/battle-royale.js): importing the results .json a
// browser downloads from EA's token link, and the auto-pull switch. Both land in the same place
// as a Pull: state.apex.postgame, plus the series games when "Use for the series" is on.
'use strict';
const assert = require('assert');
const apexLive = require('../backend/apex-live');
const create = require('../backend/ws/battle-royale');
let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };

const sent = [];
let saves = 0, recomputes = 0;
const state = { activeGame: 'rl', apex: { games: [{ n: 1, results: [] }], postgame: { hasToken: false, matches: [] } } };
const ctx = {
  state, apexLive, dataDir: '', apexStatsToken: '',
  sendWs: (ws, m) => sent.push(m), saveAppState: () => { saves++; }, broadcastFullState: () => {},
  recomputeApexBroadcast: () => { recomputes++; },
};
const h = create(ctx);
const last = () => sent[sent.length - 1].data;

const file = JSON.stringify({ matches: [
  { mid: 'm1', match_start: 1760000000, map_name: 'mp_rr_district', player_results: [
    { playerName: 'A', teamName: 'Nameless', teamNum: 2, teamPlacement: 1, kills: 4 },
    { playerName: 'B', teamName: 'Horizon', teamNum: 3, teamPlacement: 2, kills: 2 },
  ] },
] });

h.apex_import_results({ data: { json: 'not json', useForSeries: true } }, {});
ok(!last().ok && /not JSON/.test(last().message), 'a non-JSON file is refused with a reason');
ok(state.apex.games.length === 1 && !state.apex.games[0].official, 'a refused file leaves the series alone');

h.apex_import_results({ data: { json: JSON.stringify({ matches: [] }), useForSeries: true } }, {});
ok(!last().ok && /No matches/.test(last().message), 'a file with no matches says so');

h.apex_import_results({ data: { json: '﻿' + file, useForSeries: false } }, {});
ok(last().ok && /Imported 1 match\./.test(last().message), 'a BOM-prefixed file imports');
ok(state.apex.postgame.matches.length === 1 && state.apex.postgame.matches[0].winner === 'Nameless' && state.apex.postgame.source === 'file', 'matches listed, source is the file');
ok(state.apex.games.length === 1 && !state.apex.games[0].official, 'without Use for the series the games stay');

h.apex_import_results({ data: { json: file, useForSeries: true } }, {});
ok(state.apex.games.length === 1 && state.apex.games[0].official && state.apex.games[0].results[0].kills === 4, 'Use for the series replaces the games with official ones');
ok(recomputes === 1, 'standings recomputed once the series changed');

h.apex_set_autopull({ data: { on: true, useForSeries: true } }, {});
ok(state.apex.postgame.auto.on === true && state.apex.postgame.auto.useForSeries === true && last().ok, 'auto-pull switches on and is saved');
h.apex_set_autopull({ data: { on: false } }, {});
ok(state.apex.postgame.auto.on === false && /off/.test(last().message), 'and off again');
ok(saves >= 4, 'each change is saved');

console.log('apex-postgame-handlers: ' + pass + ' checks passed');
