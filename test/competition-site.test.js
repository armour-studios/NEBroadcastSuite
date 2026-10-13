// node test/competition-site.test.js
// backend/competition-site.js: the Nameless website's match-day extras on an event document.
'use strict';
const assert = require('assert');
const site = require('../backend/competition-site');
let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };

// Older website / other sources: nothing to keep.
ok(site.matchExtras({ id: 'm1', teamA: 'a', teamB: 'b' }) === null, 'no extras → null');

const x = site.matchExtras({
  streamId: 's1', siteStatus: 'veto', calledAt: '2026-10-13T18:00:00Z', startedAt: 'nonsense', checkIn: { a: 1, b: 0 },
  station: 'Stage 1', lobby: { code: 'NE-1', password: '' }, vod: 'javascript:alert(1)',
  maps: [{ game: 1, map: 'Mirage', pickedBy: 'A', side: 'ct', status: 'completed', vod: 'https://youtu.be/x', characters: { A: ['Jett', 3], B: 'nope' } }, { game: 99, pickedBy: 'Z' }],
  veto: { status: 'completed', mapPool: ['Mirage', 'Nuke'], bans: [{ map: 'Nuke', by: 'B' }, { by: 'A' }], picks: [{ map: 'Mirage', by: 'A', side: 'ct', sideBy: 'B' }, { map: 'Inferno', by: 'decider' }], characters: [{ by: 'A', action: 'pick', names: [] }] },
  bracket: { stage: 'Playoffs', stageKind: 'double_elim', side: 'losers', round: 3, match: 2, winnerTo: 'f9', loserTo: null },
});
ok(x.streamId === 's1' && x.siteStatus === 'veto' && x.station === 'Stage 1', 'plain fields');
ok(x.calledAt === '2026-10-13T18:00:00.000Z' && x.startedAt === null, 'dates normalised, junk dropped');
ok(x.checkIn.a === true && x.checkIn.b === false, 'check-in as booleans');
ok(x.lobby.code === 'NE-1' && x.lobby.password === '', 'lobby kept');
ok(x.vod === '', 'only https links are kept (no javascript: VOD)');
ok(x.maps.length === 2 && x.maps[0].vod === 'https://youtu.be/x' && x.maps[1].game === 15 && x.maps[1].pickedBy === null, 'maps clamped and checked');
ok(JSON.stringify(x.maps[0].characters) === JSON.stringify({ A: ['Jett', '3'], B: [] }), 'character lists cleaned');
ok(x.veto.bans.length === 1 && x.veto.picks[1].by === 'decider' && x.veto.characters.length === 0, 'veto cleaned (no map → dropped, empty character steps dropped)');
ok(x.bracket.side === 'losers' && x.bracket.winnerTo === 'f9' && x.bracket.loserTo === null, 'bracket kept');
ok(site.matchExtras({ lobby: { code: '', password: '' }, streamId: 's' }).lobby === undefined, 'an empty lobby is left out');

// Flip: the league lists the website's team B first.
const f = site.flipExtras(x);
ok(f.checkIn.a === false && f.checkIn.b === true, 'check-in swapped');
ok(f.maps[0].pickedBy === 'B' && JSON.stringify(f.maps[0].characters) === JSON.stringify({ A: [], B: ['Jett', '3'] }), 'picks and characters swapped');
ok(f.veto.bans[0].by === 'A' && f.veto.picks[0].by === 'B' && f.veto.picks[0].sideBy === 'A' && f.veto.picks[1].by === 'decider', 'veto swapped, decider stays');
ok(x.maps[0].pickedBy === 'A', 'the original is not changed');

ok(JSON.stringify(site.streams([{ id: 's', name: 'Main', url: 'http://x' }, { id: '', name: 'x' }, { id: 't', name: 'B', url: 'https://twitch.tv/b' }]))
  === JSON.stringify([{ id: 's', name: 'Main', url: '' }, { id: 't', name: 'B', url: 'https://twitch.tv/b' }]), 'streams cleaned (https only, id and name required)');

// deskMatch
const done = (id, extra) => Object.assign({ id, result: { scoreA: 2, scoreB: 0 } }, extra);
const sched = [
  { id: 'a', status: 'live', onStream: true, queuePos: 2, site: { streamId: 's1' } },
  { id: 'b', status: 'live', onStream: true, queuePos: 1, site: { streamId: 's2' } },
  { id: 'c', queuePos: 3, site: { streamId: 's1' } },
  done('d', { queuePos: 1, site: { streamId: 's1' } }),
];
ok(site.deskMatch(sched, '').match.id === 'b', 'no stream picked: the first queued live match anywhere');
ok(site.deskMatch(sched, 's1').match.id === 'a' && site.deskMatch(sched, 's1').why === 'live', 'this stream\'s live match');
ok(site.deskMatch([sched[2], sched[3]], 's1').match.id === 'c' && site.deskMatch([sched[2], sched[3]], 's1').why === 'next', 'nothing live on it: the next queued (finished ones skipped)');
ok(site.deskMatch([sched[1]], 's1') === null, 'nothing on this stream at all → null');
ok(site.deskMatch([{ id: 'x', status: 'live' }, { id: 'y', status: 'live' }], '') === null, 'several live, none queued → no guess');

console.log(`competition-site: all ${pass} checks passed`);
