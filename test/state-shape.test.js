// node test/state-shape.test.js
//
// Guards the SHAPE CONTRACT between server.js's state and the control panel's applyState().
//
// applyState() defensively coerces a set of state keys to [] when they don't arrive as arrays.
// That guard is good — but it is only correct if every key in the list is genuinely an array on
// the server. Two keys that are objects BY DESIGN had been added to it:
//
//   state.playerProfiles — a map keyed by gamertag (5,800 entries on a real install)
//   state.questions      — { list, settings }
//
// so the coercion fired on EVERY state apply and replaced both with []. Object.keys(playerProfiles)
// went empty and questions.list went undefined, which silently killed the player-profile registry
// across seeding / spotlight / team editor / match, and left the Q&A mailbag permanently empty.
// Both keys are also in applyState's backfill list, so the [] was then carried forward onto every
// later payload for the rest of the session. Nothing threw; the panels just quietly showed nothing.
//
// This test reads the ACTUAL declared shape out of server.js's state literal and asserts that the
// panel's two coercion lists agree with it.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appjs = fs.readFileSync(path.join(ROOT, 'control-panel', 'app.js'), 'utf8');

let failures = 0;
const pass = (m) => console.log('PASS  ' + m);
const fail = (m) => { failures++; console.log('FAIL  ' + m); };

// ── Pull the two coercion lists out of applyState() ────────────────────────────
function listAfter(marker) {
  const at = appjs.indexOf(marker);
  if (at < 0) return null;
  const open = appjs.indexOf('[', at);
  const close = appjs.indexOf(']', open);
  if (open < 0 || close < 0) return null;
  return appjs.slice(open + 1, close).split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// The array list is the first [...] before `.forEach` that mentions savedTeams.
const arrayList = listAfter("['savedTeams', 'crew'");
const objectList = listAfter("['questions', 'playerProfiles'");

if (!arrayList) fail('could not find the array-coercion list in applyState() — did it move or get renamed?');
if (!objectList) fail('could not find the object-coercion list in applyState() — did it move or get renamed?');

// ── Read each key's declared shape from server.js's `let state = { ... }` ──────
// Scoped to the state literal ONLY. Searching the whole file matches same-named keys at the same
// indent in other objects — BROADCAST_TIERS has `crew: 'live'`, which read as "not an array" and
// produced a false failure for a key that is genuinely an array.
const STATE_START = server.indexOf('\nlet state = {');
const STATE_END = STATE_START < 0 ? -1 : server.indexOf('\n};', STATE_START);
if (STATE_START < 0 || STATE_END < 0) fail('could not locate the `let state = { ... }` literal in server.js');
const STATE_SRC = STATE_START < 0 ? '' : server.slice(STATE_START, STATE_END);

function declaredShape(key) {
  const re = new RegExp('^  ' + key + ':\\s*(.)', 'm');
  const m = STATE_SRC.match(re);
  if (!m) return null;
  return m[1] === '[' ? 'array' : m[1] === '{' ? 'object' : 'other';
}

// Keys the server builds in libraryData()/buildLiveState() rather than the state literal.
const BUILT = {
  savedTeams: 'array',    // savedTeams.map(...)
  brandKits: 'array',     // savedBrandKits.map(...)
  facecams: 'array',      // savedFacecams
  presets: 'array',       // savedPresets.map(...)
  crew: 'array',          // state.crew || []
};

function shapeOf(key) {
  return declaredShape(key) || BUILT[key] || null;
}

for (const key of arrayList || []) {
  const shape = shapeOf(key);
  if (!shape) { fail(`'${key}' is coerced to [] but its shape could not be determined in server.js`); continue; }
  if (shape !== 'array') fail(`'${key}' is coerced to [] by applyState but server.js declares it as an ${shape} — the coercion will DESTROY it on every state apply`);
  else pass(`'${key}' is an array on both sides`);
}

for (const key of objectList || []) {
  const shape = shapeOf(key);
  if (!shape) { fail(`'${key}' is coerced to {} but its shape could not be determined in server.js`); continue; }
  if (shape !== 'object') fail(`'${key}' is coerced to {} by applyState but server.js declares it as an ${shape}`);
  else pass(`'${key}' is an object on both sides`);
}

// A key must not appear in both lists.
for (const k of (objectList || [])) {
  if ((arrayList || []).includes(k)) fail(`'${k}' appears in BOTH coercion lists — the second one wins and the first is a lie`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
