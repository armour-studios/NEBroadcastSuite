'use strict';
// CS2 overlay producer feedback (2026-10-05), tested against the real server.js code:
//   1. AWP kills showed as knife kills on the kill feed (the AWPer switches to knife before the GSI tick)
//   4. no victory screen when a map ends
//   5. Swap teams moved the logos but not the names (auto team names put the names straight back,
//      and at halftime names changed side while logos stayed)
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = require('./lib/server-source').serverSource();
const between = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + 1);
  assert.ok(i >= 0 && j > i, 'markers not found: ' + a + ' .. ' + b);
  return src.slice(i, j);
};

// Code under test, in file order where it matters.
const code = [
  between('const CS_NADE_ORDER', 'let csgoStaleTimer'),                       // parseWeapons
  between('let prevFire = {}', 'function detectFiring'),                      // trackShots / killWeapon
  between('// CS2 auto team names: the game', 'let killPrev = null'),         // manual-swap hold, csApplyAutoTeams, auto winner
  between('let killPrev = null', '\n  killPrev = {};') + '\n  killPrev = {}; players.forEach(p => { killPrev[p.steamid] = { deaths: p.deaths || 0, roundKills: p.roundKills || 0, roundHs: p.roundHs || 0 }; });\n}',
  between('// Swap everything that belongs to a TEAM', '// Auto team names from the live game'),
  between('const GENERIC_TEAM_RE', '// The overlay round label is only ever'),
].join('\n');

function makeWorld() {
  const state = {
    activeGame: 'csgo', autoTeamsFromGame: true,
    teams: { blue: { name: 'Alpha', logo: 'alpha.png' }, orange: { name: 'Bravo', logo: 'bravo.png' } },
    series: { blue: 1, orange: 0 }, activePlayer: { blue: null, orange: null }, observedPlayer: null,
    leagueCapture: { active: false },
    csgo: { killfeed: [], autoWinner: true, ct: { name: 'Alpha', score: 0 }, t: { name: 'Bravo', score: 0 } },
    winner: { visible: false },
  };
  const winnerCalls = [];
  const WS_HANDLERS = { set_winner: (m) => { winnerCalls.push(m.data); if ('visible' in m.data) state.winner.visible = !!m.data.visible; } };
  const flowBus = { emit() {} };
  // eslint-disable-next-line no-new-func
  const api = new Function('state', 'WS_HANDLERS', 'flowBus', 'savedTeams', 'abbrForTeamName', 'retuneRoundLabel', 'ctx',
    code + '\nreturn { parseWeapons, trackShots, updateKillfeed, csApplyAutoTeams, csShowAutoWinner, csHideAutoWinner, swapTeamSides, setManualSwap: (k) => { _csManualSwapKey = k; }, csGameTeamsKey };')(
    state, WS_HANDLERS, flowBus, [], () => null, () => {}, { state, savedTeams: [], abbrForTeamName: () => null, retuneRoundLabel: () => {} });
  return { state, api, winnerCalls };
}

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('PASS ', name); };

// A GSI player as the server builds it (only the fields these paths read).
function player(api, steamid, team, weapons, st) {
  const wp = api.parseWeapons(weapons);
  return { steamid, name: steamid, team, weapon: wp.weapon, clip: wp.clip, _clips: wp.clips,
           deaths: st.deaths || 0, roundKills: st.roundKills || 0, roundHs: 0 };
}
const awpActive = (clip) => ({ weapon_0: { name: 'weapon_knife', type: 'Knife', state: 'holstered' }, weapon_1: { name: 'weapon_awp', type: 'SniperRifle', state: 'active', ammo_clip: clip, ammo_reserve: 20 } });
const knifeActive = (awpClip) => ({ weapon_0: { name: 'weapon_knife', type: 'Knife', state: 'active' }, weapon_1: { name: 'weapon_awp', type: 'SniperRifle', state: 'holstered', ammo_clip: awpClip, ammo_reserve: 20 } });

function tick(w, players) { w.api.trackShots(players, Date.now()); w.api.updateKillfeed(players); }

check('AWP shot then instant knife switch: kill feed says AWP', () => {
  const w = makeWorld();
  tick(w, [player(w.api, 'sniper', 'CT', awpActive(5), {}), player(w.api, 'victim', 'T', knifeActive(5), {})]);
  tick(w, [player(w.api, 'sniper', 'CT', knifeActive(4), { roundKills: 1 }), player(w.api, 'victim', 'T', knifeActive(5), { deaths: 1 })]);
  assert.strictEqual(w.state.csgo.killfeed.length, 1);
  assert.strictEqual(w.state.csgo.killfeed[0].weapon, 'awp');
});

check('a real knife kill (no recent shot) still says knife', () => {
  const w = makeWorld();
  tick(w, [player(w.api, 'stabber', 'CT', knifeActive(5), {}), player(w.api, 'victim', 'T', knifeActive(5), {})]);
  tick(w, [player(w.api, 'stabber', 'CT', knifeActive(5), { roundKills: 1 }), player(w.api, 'victim', 'T', knifeActive(5), { deaths: 1 })]);
  assert.strictEqual(w.state.csgo.killfeed[0].weapon, 'knife');
});

check('the magazine map never reaches the broadcast player object', () => {
  const w = makeWorld();
  const p = player(w.api, 'x', 'CT', awpActive(5), {});
  w.api.trackShots([p], Date.now());
  assert.ok(!('_clips' in p));
});

check('map end: the side with more rounds gets the victory screen, with the map score', () => {
  const w = makeWorld();
  w.state.csgo.ct.score = 13; w.state.csgo.t.score = 9;
  w.api.csShowAutoWinner();
  assert.deepStrictEqual(w.winnerCalls[0], { side: 'blue', visible: true, subtitle: '13–09'.replace('09', '9') });
  w.api.csHideAutoWinner();
  assert.strictEqual(w.winnerCalls[1].visible, false);
});

check('victory screen: T-side win -> orange; draw -> nothing; switched off -> nothing', () => {
  let w = makeWorld(); w.state.csgo.ct.score = 7; w.state.csgo.t.score = 13; w.api.csShowAutoWinner();
  assert.strictEqual(w.winnerCalls[0].side, 'orange');
  w = makeWorld(); w.state.csgo.ct.score = 12; w.state.csgo.t.score = 12; w.api.csShowAutoWinner();
  assert.strictEqual(w.winnerCalls.length, 0);
  w = makeWorld(); w.state.csgo.autoWinner = false; w.state.csgo.ct.score = 13; w.api.csShowAutoWinner();
  assert.strictEqual(w.winnerCalls.length, 0);
});

check('a winner the producer put up by hand is not auto-hidden', () => {
  const w = makeWorld(); w.state.winner.visible = true;
  w.api.csHideAutoWinner();
  assert.strictEqual(w.winnerCalls.length, 0);
});

check('halftime side change moves the WHOLE team (name, logo, series) across', () => {
  const w = makeWorld();
  w.state.csgo.ct.name = 'Bravo'; w.state.csgo.t.name = 'Alpha';   // the game reports the teams switched sides
  w.api.csApplyAutoTeams({ name: 'Bravo' }, { name: 'Alpha' });
  assert.deepStrictEqual([w.state.teams.blue.name, w.state.teams.blue.logo], ['Bravo', 'bravo.png']);
  assert.deepStrictEqual([w.state.teams.orange.name, w.state.teams.orange.logo], ['Alpha', 'alpha.png']);
  assert.deepStrictEqual(w.state.series, { blue: 0, orange: 1 });
});

check('producer Swap with auto team names sticks until the game reports different names', () => {
  const w = makeWorld();
  w.api.swapTeamSides(); w.api.setManualSwap(w.api.csGameTeamsKey());   // what the swap_teams case does
  w.api.csApplyAutoTeams({ name: 'Alpha' }, { name: 'Bravo' });          // next GSI tick, same names
  assert.deepStrictEqual([w.state.teams.blue.name, w.state.teams.blue.logo], ['Bravo', 'bravo.png'], 'names AND logos stay swapped');
  w.state.csgo.ct.name = 'Bravo'; w.state.csgo.t.name = 'Alpha';           // halftime: game names change
  w.api.csApplyAutoTeams({ name: 'Bravo' }, { name: 'Alpha' });
  assert.deepStrictEqual([w.state.teams.blue.name, w.state.teams.blue.logo], ['Bravo', 'bravo.png'], 'auto resumes and agrees');
});

console.log(`\ncs2-feedback: all ${pass} checks passed`);
