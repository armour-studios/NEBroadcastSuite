'use strict';
// LAN seat cams: permanent per-seat links, players assigned per match, facecams follow the seat.
const assert = require('assert');
const L = require('../backend/lan-seats');

let n = 0;
const fresh = () => ({ room: 'room' + (++n), password: 'pw' + n });
const ls = L.normalize({ enabled: true, perSide: 3 });
L.ensureRooms(ls, fresh);
L.rebuild(ls, { base: 'https://vdo.ninja/' });
assert.deepStrictEqual(ls.seats.map((s) => s.id), ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
const a1 = ls.seats[0];
assert.ok(a1.joinUrl.startsWith('https://vdo.ninja/?room=room1&push=seat_a1&label=Team%201%20side%20Seat%201'), a1.joinUrl);
assert.ok(a1.joinUrl.endsWith('#p=pw1'));
assert.strictEqual(a1.viewUrl, 'https://vdo.ninja/?room=room1&view=seat_a1&solo&cleanoutput&cover#p=pw1');
assert.ok(ls.seats[3].viewUrl.includes('room=room2'), 'Team 2 side has its own room');

// Links are stable: a rebuild with rooms already made changes nothing.
assert.strictEqual(L.ensureRooms(ls, fresh), false);
const before = ls.seats.map((s) => s.viewUrl).join();
L.rebuild(ls, { base: 'https://vdo.ninja' });
assert.strictEqual(ls.seats.map((s) => s.viewUrl).join(), before);

// Assign: the player gets the seat's cam (replacing any old cam of theirs, any spelling).
const cams = [{ name: 'zen', link: 'https://old', platformId: '' }, { name: 'Other', link: 'https://x' }];
L.assign(ls, cams, 'a2', 'Zen');
assert.strictEqual(ls.assign.a2, 'Zen');
assert.deepStrictEqual(cams.filter((c) => c.name.toLowerCase() === 'zen').map((c) => [c.name, c.link, c.seatId]), [['Zen', ls.seats[1].viewUrl, 'a2']]);
assert.ok(cams.some((c) => c.name === 'Other'), 'other cams untouched');

// The same player moving seats frees the old one; a new player in a seat takes over its cam.
L.assign(ls, cams, 'b1', 'Zen');
assert.ok(!ls.assign.a2 && ls.assign.b1 === 'Zen');
assert.strictEqual(cams.find((c) => c.name === 'Zen').link, ls.seats[3].viewUrl);
L.assign(ls, cams, 'b1', 'Rise');
assert.ok(!cams.some((c) => c.name === 'Zen'), 'Zen left the seat, so the seat cam leaves with him');
assert.strictEqual(cams.find((c) => c.name === 'Rise').seatId, 'b1');

// Custom seat link (e.g. a capture card source): rewrites the occupant's cam.
ls.links.b1 = 'https://my-capture/seat-b1';
L.rebuild(ls, {});
assert.strictEqual(L.refreshSeatCams(ls, cams), true);
assert.strictEqual(cams.find((c) => c.name === 'Rise').link, 'https://my-capture/seat-b1');

// Next match: clear seats, then returning players sit where they sat last.
L.clearAll(ls, cams);
assert.deepStrictEqual(ls.assign, {});
assert.ok(!cams.some((c) => c.seatId), 'no seat cams left after clearing');
L.assign(ls, cams, 'a3', 'Atomic');
// Rise and Zen both last sat in b1 (Rise took it after Zen). Rise goes back to b1; Zen's last seat is
// taken, so he waits for the producer; Atomic is already seated; Newbie has never sat anywhere.
const seated = L.autoSeat(ls, cams, [{ name: 'RISE' }, { name: 'Zen' }, { name: 'Atomic' }, { name: 'Newbie' }]);
assert.strictEqual(seated, 1);
assert.strictEqual(ls.assign.b1, 'RISE', 'matched ignoring case, seated under the in-game spelling');
assert.ok(!Object.values(ls.assign).includes('Zen') && !Object.values(ls.assign).includes('Newbie'));
assert.strictEqual(cams.find((c) => c.name === 'RISE').link, 'https://my-capture/seat-b1');

// A smaller seat count drops the occupants of the removed seats.
ls.perSide = 2; L.rebuild(ls, {}); L.refreshSeatCams(ls, cams);
assert.ok(!ls.assign.a3 && !cams.some((c) => c.name === 'Atomic' && c.seatId));
assert.deepStrictEqual(L.normalize({ perSide: 99, assign: { z9: 'x', a1: 5 } }).assign, {});
// Seat helper script: seat + token baked in, quotes escaped, short enough for a .cmd -EncodedCommand.
const ps = L.helperScript({ producer: '192.168.1.20', port: 3005, token: 'ab'.repeat(16), seatId: 'b2', seatLabel: "O'Brien's PC", statsPort: 49123 });
assert.ok(ps.includes("$Producer = 'http://192.168.1.20:3005'") && ps.includes("$Seat = 'b2'") && ps.includes("$Token = '" + 'ab'.repeat(16) + "'"));
assert.ok(ps.includes("O''Brien''s PC"), 'single quotes doubled for PowerShell');
assert.ok(ps.includes('bReplay') && ps.includes('Target'));
assert.ok(Buffer.from(ps, 'utf16le').toString('base64').length < 7900, 'fits a cmd line');
assert.strictEqual(L.normalize({ agent: { enabled: true, port: 80, token: 'nothex' } }).agent.port, 1024);
assert.strictEqual(L.normalize({ agent: { token: 'nothex' } }).agent.token, '');
console.log('lan-seats: all assertions passed');
