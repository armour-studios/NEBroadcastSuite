// node test/preflight-core.test.js
//
// Pins the credits membership rule and the preflight checks. The bug this replaced:
// crew.workedEvent is set automatically (station pull-in, desk seating, a swap, apply_shift) and
// cleared almost never, so the credits scene rolled everyone who had ever brushed the desk since
// the last Clear. Membership is now EXPLICIT — on the desk now, or on the Off-Air Event Staff list
// — and these cases hold that line.
'use strict';
const path = require('path');
const PF = require(path.join(__dirname, '..', 'overlay', 'preflight-core'));

let failures = 0;
function ck(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) failures++;
}
const flat = (groups) => groups
  .map((g) => g.label + ':' + g.people.map((p) => p.name + (p.role ? '(' + p.role + ')' : '')).join(','))
  .join(' | ');

const st = {
  crew: [
    { id: 'c1', name: 'Nathan', group: 'casters', active: true, workedEvent: true },
    // The exact defect: seated once by a station pull-in, never on the desk, flag never cleared.
    { id: 'c2', name: 'Michael Poupa', handle: '0ofen', group: 'casters', active: true, workedEvent: true },
    { id: 'c3', name: 'B3n', handle: 'B3N', group: 'producer', workedEvent: true },
    { id: 'c4', name: 'Kenzo', group: 'casters', workedEvent: true },   // earlier shift -> off-air staff
    { id: 'c5', name: 'Nyah', group: 'casters', workedEvent: true },    // replay op via off-air staff
    { id: 'c6', name: 'Gingee', group: 'casters', workedEvent: true },  // host role
    { id: 'c7', name: 'Ghost', group: 'casters', workedEvent: true }    // stale flag ONLY
  ],
  casters: {
    library: [{ id: 'L1', name: 'Nathan' }, { id: 'L2', name: 'Gingee' }, { id: 'L3', name: 'Guest Caster' }],
    lineup: [{ libraryId: 'L1', slot: 1 }],
    list: [{ name: 'Nathan', camUrl: 'http://feed/1' }],
    showRoles: { host: 'Gingee', observer: '' },
    support: [{ crewId: 'c3', role: 'Producer' }, { crewId: 'c4', role: 'Caster' }, { crewId: 'c5', role: 'Replay Op' }]
  },
  credits: { talent: [] }
};

// ── The credits roster ───────────────────────────────────────────────────────
const rendered = flat(PF.creditsGroups(st));
ck('a stale workedEvent flag alone credits nobody', rendered.indexOf('Ghost') === -1);
ck('...including one that also carries a stale active flag',
  rendered.indexOf('Michael Poupa') === -1 && rendered.indexOf('0ofen') === -1);
ck('someone on a desk slot is credited', rendered.indexOf('Nathan') !== -1);
ck('a finished shift moved to Off-Air Event Staff keeps its credit', rendered.indexOf('Kenzo') !== -1);
ck('the host role credits under Talent, not Casters', /Talent:Gingee/.test(rendered));
ck('off-air staff bucket by their DECK role, not their crew group',
  /Production:B3N/.test(rendered) && /Operations:Nyah/.test(rendered));
ck('an ops role IS printed next to the name', /Nyah\(Replay Op\)/.test(rendered));
ck('a role that just repeats its heading is not printed', /Production:B3N($| )/.test(rendered));
ck('a library card with no desk seat is not credited', rendered.indexOf('Guest Caster') === -1);

// ── Checks ───────────────────────────────────────────────────────────────────
const ids = (extra) => PF.checks(st, extra).map((c) => c.id);
ck('flags a crew member marked on shift who holds no slot', ids().indexOf('crew-active-no-slot') !== -1);
ck('tells you who is flagged as worked but will NOT be credited', ids().indexOf('worked-not-credited') !== -1);

const collide = JSON.parse(JSON.stringify(st));
collide.casters.lineup.push({ libraryId: 'L2', slot: 1 });
ck('flags two lineup entries claiming one slot', PF.checks(collide).some((c) => c.id === 'slot-collision'));

const strayGfx = JSON.parse(JSON.stringify(st));
strayGfx.gfxActive = 'winner';
strayGfx.winner = { visible: true };
strayGfx.standings = { visible: true };
ck('flags a second exclusive graphic left visible', PF.checks(strayGfx).some((c) => c.id === 'gfx-stray-visible'));

const hiddenGfx = JSON.parse(JSON.stringify(st));
hiddenGfx.gfxActive = 'winner';
hiddenGfx.winner = { visible: false };
ck('flags a punched-up graphic whose layer is hidden', PF.checks(hiddenGfx).some((c) => c.id === 'gfx-active-not-visible'));

const deadScene = JSON.parse(JSON.stringify(st));
deadScene.switcher = { target: 'obs' };
deadScene.obs = { enabled: true, connected: true, availableScenes: ['In Game'], scenes: { inGame: 'In Game', casters: 'Deleted Scene' } };
ck('flags an OBS scene the automation points at that no longer exists',
  PF.checks(deadScene).some((c) => c.id === 'obs-scene-missing'));

ck('reports cloud trouble when the breaker is open',
  PF.checks(st, { cloudHealth: { healthy: false, consecutiveFailures: 3, lastError: 'boom', lastStatus: 503, retryInMs: 20000 } })
    .some((c) => c.id === 'cloud-degraded'));

// ── The desk view must name people the way the credits will ──────────────────
const desk = PF.deskRows(st);
ck('desk row carries the name the credits will print', desk[0].name === 'Nathan' && desk[0].credited === 'Nathan');

const renamed = JSON.parse(JSON.stringify(st));
renamed.casters.library.push({ id: 'L4', name: 'Michael Poupa' });
renamed.casters.lineup = [{ libraryId: 'L4', slot: 1 }];
const seat = PF.deskRows(renamed);
ck('...and shows the gamertag when the deck name differs',
  seat[0].name === 'Michael Poupa' && seat[0].credited === '0ofen');

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
