// node test/valorant-gep.test.js
//
// Guards the Valorant live feed. The bug this replaces was not a typo — it was a feed built
// against an endpoint that does not exist (League's :2999) and a HUD drawing widgets for data
// nothing supplied. So this test checks both halves of "honest":
//
//   1. the documented Overwolf payloads normalise correctly, and
//   2. the fields Valorant does NOT expose (per-player health, ability charges) stay absent.
//
// The sample payloads below are copied from Overwolf's own Valorant GEP docs, not invented.
'use strict';
const path = require('path');
const fs = require('fs');

const gep = require(path.join(__dirname, '..', 'backend', 'integrations', 'valorant-gep'));
const { resolveAgent } = require(path.join(__dirname, '..', 'backend', 'valorant-agents'));

let failures = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++; };

// One scoreboard_N entry, verbatim field names from Overwolf's docs.
const sb = (over) => Object.assign({
  name: 'MrTest #1111', character: 'Pandemic', teammate: true, team: 0, alive: true,
  player_id: '61b608c1', shield: 50, weapon: 'TX_Hud_Pistol_Classic', spike: false,
  ult_points: 3, ult_max: 8, kills: 11, deaths: 5, assists: 3, money: 1800, is_local: true
}, over || {});

// ── 1. A documented payload becomes a usable scoreboard ─────────────────────
let st = gep.applyGepUpdate(null, {
  scoreboard: [sb(), sb({ name: 'Enemy #2222', character: 'Wushu', team: 1, teammate: false, is_local: false, shield: 25, spike: true })],
  map: 'Foxtrot', round_number: '7', round_phase: 'combat',
  match_score: { team_0: 4, team_1: 2 }, team: 'attack', observing: 'Enemy #2222',
  game_mode: 'bomb', pseudo_match_id: 'abc123', events: []
});

check(st.connected === true, 'a relay POST marks Valorant connected');
check(st.map.displayName === 'Breeze', 'internal map codename Foxtrot resolves to Breeze');
check(st.order.score === 4 && st.chaos.score === 2, 'match_score team_0/team_1 become the ORDER/CHAOS scores');
check(st.round.number === 7 && st.round.phase === 'live', 'round number and the combat phase carry through');
check(st.players.length === 2, 'both scoreboard entries become players');
check(st.players[0].agentName === 'Viper' && st.players[0].agent === 'viper', 'Pandemic resolves to Viper');
check(st.players[1].agentName === 'Jett', 'Wushu resolves to Jett');
check(st.players[0].team === 'ORDER' && st.players[1].team === 'CHAOS', 'GEP team index 0/1 maps to ORDER/CHAOS');
check(st.players[0].armor === 2 && st.players[1].armor === 1, 'shield 50 is heavy armour, 25 is light');
check(st.players[0].credits === 1800 && st.players[0].ultPointsNeeded === 8, 'money and ult_max carry through');
check(st.players[0].weapon === 'classic', 'weapon asset id TX_Hud_Pistol_Classic becomes "classic"');
check(st.players[1].hasSpike === true, 'the spike carrier is flagged');
check(st.observed && st.observed.name === 'Enemy #2222', 'match_info.observing picks the spectated player');

// ── 2. What Valorant does NOT expose must not appear ────────────────────────
const p0 = st.players[0];
check(!('health' in p0) && !('maxHealth' in p0), 'no per-player health field is invented (GEP has none)');
check(!('c_util' in p0) && !('q_util' in p0) && !('e_util' in p0), 'no ability-charge fields are invented');
check(!('spentCredits' in p0), 'no credits-spent field is invented (only current money exists)');

const overlay = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'valorant.html'), 'utf8');
check(!/p\.health/.test(overlay), 'the overlay no longer reads p.health');
check(!/\bp\[`\$\{slot\}_util`\]/.test(overlay) && !/p\[slot\s*\+\s*'_util'\]/.test(overlay), 'the overlay no longer reads ability charges');
check(!/spentCredits/.test(overlay), 'the overlay no longer reads spentCredits');

// The dead League poller must not come back.
const server = require('./lib/server-source').serverSource();
check(!/_valorantFetch/.test(server) && !/startValorantPolling/.test(server),
  'the League-endpoint Valorant poller is gone from server.js');
check(/applyValorantGep/.test(server) && /\/api\/val-gep/.test(server),
  'server.js exposes the GEP relay route instead');

// ── 3. Round history is derived from the score moving ───────────────────────
check(st.roundHistory.length === 0,
  'attaching mid-match at 4-2 invents NO round history (the order of those rounds is unknowable)');
let st2 = gep.applyGepUpdate(st, { match_score: { team_0: 5, team_1: 2 }, round_number: '8', round_phase: 'shopping' });
check(st2.roundHistory.length === 1 && st2.roundHistory[0].winner === 'ORDER',
  'a score going up records who won that round');
check(st2.roundHistory[0].round === 7,
  'that round is numbered from the live scoreline, so the strip lines up with the real round');
check(st2.round.phase === 'shopping', 'the buy phase is reported as shopping');

// A new map resets rather than accumulating a bogus history.
let st3 = gep.applyGepUpdate(st2, { match_score: { team_0: 0, team_1: 0 }, round_number: '1' });
check(st3.roundHistory.length === 0, 'a score reset (new map) clears the derived round history');

// ── 4. Spike events, and the new round clearing them ────────────────────────
let st4 = gep.applyGepUpdate(st3, { events: ['spike_planted'], round_number: '1' });
check(st4.spikeState === 'planted' && st4.round.phase === 'bomb', 'spike_planted drives the bomb phase');
let st5 = gep.applyGepUpdate(st4, { round_number: '2', round_phase: 'shopping' });
check(st5.spikeState === '' && st5.round.phase === 'shopping', 'a new round clears the stale spike state');

// ── 5. A tick that omits fields must not blank the board ────────────────────
let st6 = gep.applyGepUpdate(st, {});
check(st6.order.score === 4 && st6.chaos.score === 2 && st6.players.length === 2,
  'a partial relay tick carries the last good score and roster forward');

// ── 6. Agent registry covers the roster, and degrades on an unknown one ─────
check(resolveAgent('Aggrobot').name === 'Gekko', 'the generated registry knows Aggrobot is Gekko');
check(resolveAgent('SomethingNew').name === 'SomethingNew', 'an unreleased codename falls back to itself, not blank');

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
