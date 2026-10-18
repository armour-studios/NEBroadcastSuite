// node test/scorebar-drop.test.js
// The RL HUD scorebar drop-down (brand 'drop' placement) is timed off the clock in TWO places:
// overlay/rl-hud.html dropSlotAt() decides what is on screen, server.js dropSlot() decides what the
// Sponsor Proof of Play counts. If the two ever differ, sponsors get counted for screen time they did
// not get. Both bodies are pulled from source and run side by side.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };

const grab = (file, name) => {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const m = src.match(new RegExp('function ' + name + '\\(nowMs, every, hold, n\\)\\s*\\{[\\s\\S]*?\\r?\\n\\}'));
  assert.ok(m, name + ' found in ' + file);
  return new Function('return ' + m[0])();
};
const server = grab('server.js', 'dropSlot');
const hud = grab('overlay/rl-hud.html', 'dropSlotAt');

let same = true;
for (let t = 0; t < 4000; t += 0.5) for (const [e, h, n] of [[120, 12, 1], [90, 10, 3], [30, 29, 2], [0, 0, 4], [45, 200, 2]]) {
  if (server(t * 1000, e, h, n) !== hud(t * 1000, e, h, n)) same = false;
}
ok(same, 'HUD and server agree on every second');
ok(server(5000, 120, 12, 2) === 0 && server(13000, 120, 12, 2) === -1, 'down for the hold, then up');
ok(server(125000, 120, 12, 2) === 1, 'the next drop is the next sponsor');
ok(server(5000, 120, 12, 0) === -1, 'no sponsors, no drop');
ok(server(3000, 10, 2, 1) === 0 && server(31000, 10, 2, 1) === 0, 'every is at least 30 seconds');
console.log('scorebar-drop: ' + pass + ' checks passed');
