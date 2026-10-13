// node test/rl-board-new-match.test.js
// Rocket League post-game scoreboard: it leaves the moment the NEXT MATCH IS CREATED (no minimum time
// on screen: back-to-back games), and a match created before the board went up skips the board.
// Drives the real clearBoardForNewMatch out of server.js.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = require('./lib/server-source').serverSource().replace(/\r\n/g, '\n');
function fn(name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  return src.slice(start, src.indexOf('\n}', start) + 2);
}
assert.ok(!/BOARD_MIN_MS/.test(src), 'no minimum time on screen');
const created = fn('handleMatchCreated');
assert.ok(/if \(holdBoard\) clearBoardForNewMatch\(\);/.test(created), 'handleMatchCreated clears the board');
assert.ok(/_newMatchSinceEnd = true;/.test(created), 'handleMatchCreated remembers a new match exists');
assert.ok(/_newMatchSinceEnd = false;/.test(fn('handleMatchEnded')), 'handleMatchEnded resets it');
assert.ok(/if \(_newMatchSinceEnd\) \{\s*logAuto\('rl-scene', 'Post-game board skipped/.test(src), 'a board still pending when the next match is created is skipped');

function world() {
  const out = { cleared: 0, resets: 0, cancelledCasterCut: 0 };
  const state = { view: 'scoreboard', game: { number: 2 } };
  const body = 'let _boardShownAt = 0, _newMatchSinceEnd = false, _boardNewMatchTimer = null, _postGameTimer = null;\n'
    + fn('clearBoardForNewMatch')
    + '\nreturn { clearBoardForNewMatch, setCasterCut: (v) => { _postGameTimer = v; } };';
  const api = new Function('state', 'clearTimeout', 'clearPostGameBoard', 'broadcast', 'bridgeClients', 'logAuto', body)(
    state, () => {},
    () => { out.cleared++; state.view = 'hud'; },
    (c, m) => { if (m.type === 'game_reset') out.resets++; if (m.type === 'rl-scene-result') out.cancelledCasterCut++; },
    null, () => {});
  return { state, out, api };
}

// 1. Next match created → the board leaves at once and the overlays reset, however briefly it was up.
{
  const w = world();
  w.api.clearBoardForNewMatch();
  assert.strictEqual(w.state.view, 'hud');
  assert.strictEqual(w.out.cleared, 1);
  assert.strictEqual(w.out.resets, 1, 'overlays get a game_reset');
  console.log('PASS  next match created: the board leaves straight away (back-to-back friendly)');
}
// 2. A pending post-game cut to casters is cancelled, and says so.
{
  const w = world();
  w.api.setCasterCut({});
  w.api.clearBoardForNewMatch();
  assert.strictEqual(w.out.cancelledCasterCut, 1);
  console.log('PASS  a pending caster cut is cancelled with a message');
}
// 3. Already off the board (kickoff came first) → nothing happens.
{
  const w = world();
  w.state.view = 'hud';
  w.api.clearBoardForNewMatch();
  assert.strictEqual(w.out.cleared, 0);
  console.log('PASS  no board, nothing to clear');
}
console.log('\nAll RL board / new match tests passed.');
