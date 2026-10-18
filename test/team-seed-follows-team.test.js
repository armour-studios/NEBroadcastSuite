// node test/team-seed-follows-team.test.js
// The start.gg seed (and entrant id) belong to the TEAM, not the side. set_team (backend/ws/match.js)
// used to spread the previous team's fields forward, so renaming a side or picking a team from the
// library kept the old seed: GOAT showed Arepassion's SEED 1. A different team now takes its seed
// from the loaded event's entrant list, or none.
'use strict';
const assert = require('assert');
const create = require('../backend/ws/match');
let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };

const state = {
  activeGame: 'rocket-league', activePlayer: { blue: '', orange: '' }, observedPlayer: null,
  teams: {
    blue: { name: 'AREPASSION', seed: 1, entrantId: '25028083', players: [], color: '#1f6fff' },
    orange: { name: 'GOAT', seed: 2, entrantId: '25028321', players: [], color: '#ff7a1a' },
  },
  startgg: { eventTeams: [
    { name: 'Arepassion', seed: 1, startggId: 25028083 },
    { name: 'GOAT', seed: 2, startggId: 25028321 },
    { name: 'MAD', seed: 6, startggId: 24985062 },
  ] },
};
const noop = () => {};
const h = create({
  GAMES: {}, abbrForTeamName: () => '', applyActiveGame: noop, broadcastFullState: noop, cleanTeamAbbr: (x) => x || '',
  csCinematicApply: noop, csGameTeamsKey: noop, entrantOrgName: () => '', finalizeAndResetSeries: noop,
  gameDefaultColors: () => ({ a: '#00f', b: '#f80' }), persistMatchCrest: noop, rebuildCombinedPlayers: noop, resetOvertimeTrigger: noop,
  retuneRoundLabel: noop, saveAppState: noop, state, swapTeamSides: noop, vetoDraws: noop, savedTeams: [],
});

h.set_team({ data: { side: 'blue', name: 'GOAT' } }, {});
ok(state.teams.blue.seed === 2 && state.teams.blue.entrantId === '25028321', 'GOAT on blue gets GOAT\'s seed and entrant id from the event');
h.set_team({ data: { side: 'orange', name: 'MAD' } }, {});
ok(state.teams.orange.seed === 6, 'MAD gets seed 6, not GOAT\'s 2');
h.set_team({ data: { side: 'orange', name: 'Some Pickup Team' } }, {});
ok(state.teams.orange.seed === 0 && state.teams.orange.entrantId === '', 'a team not in the event shows no seed');
h.set_team({ data: { side: 'blue', name: 'GOAT', logo: 'x' } }, {});
ok(state.teams.blue.seed === 2, 'a logo edit on the same team keeps its seed');
console.log('team-seed-follows-team: ' + pass + ' checks passed');
