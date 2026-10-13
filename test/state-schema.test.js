// node test/state-schema.test.js
// backend/state-schema.js is the one table for the app's state: broadcast tier, saved or not, how
// it is restored. This checks the table against the REAL server module, so a state key added
// without a decision, or a save/load that disagrees with the table, fails here.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const schema = require('../backend/state-schema');
let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };

// The real server, in plain node (backend/electron-api.js has a node mode), against a temp file.
const quiet = [console.log, console.warn, console.error];
console.log = console.warn = console.error = () => {};
const server = require('../server.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-schema-'));
const file = path.join(dir, 'state.json');
fs.writeFileSync(file, '{}');
server._testLoadState(file);
const state = server._testBrandStyles.getState();
const snap = server._testSaveSnapshot();
[console.log, console.warn, console.error] = quiet;

const S = schema.STATE_SCHEMA;
const stateKeys = Object.keys(state);
const missing = stateKeys.filter((k) => !S[k]);
ok(!missing.length, 'every state key is declared in backend/state-schema.js: ' + missing.join(', '));
const stale = Object.keys(S).filter((k) => !(k in state));
ok(!stale.length, 'no schema entry for a key that no longer exists: ' + stale.join(', '));
const untiered = stateKeys.filter((k) => !S[k].tier);
ok(!untiered.length, 'every state key has a broadcast tier: ' + untiered.join(', '));
ok(Object.values(S).every((e) => [null, 'live', 'library', 'local'].includes(e.tier) && [false, 'plain', 'custom'].includes(e.save) && (e.save ? ['typed', 'custom'].includes(e.load) : e.load === null)),
  'every entry uses known tier / save / load values (and unsaved keys have no loader)');

// What is saved is exactly what the table says.
const savedKeys = Object.keys(snap);
const shouldSave = Object.keys(S).filter((k) => S[k].save);
ok(shouldSave.every((k) => savedKeys.includes(k)), 'every key marked saved is in the snapshot: ' + shouldSave.filter((k) => !savedKeys.includes(k)).join(', '));
const unexpected = savedKeys.filter((k) => !(S[k] && S[k].save) && !schema.SAVED_EXTRA.includes(k));
ok(!unexpected.length, 'nothing is saved that the table does not declare (state key or SAVED_EXTRA): ' + unexpected.join(', '));
const notSavedButIn = Object.keys(S).filter((k) => S[k].save === false && savedKeys.includes(k));
ok(!notSavedButIn.length, 'runtime-only keys are never saved: ' + notSavedButIn.join(', '));
ok(Object.keys(S).filter((k) => S[k].save === 'plain').every((k) => JSON.stringify(snap[k]) === JSON.stringify(state[k])), "'plain' keys are saved as they are in state");

// The tiers server.js uses are the table's.
ok(Object.keys(schema.DERIVED_TIERS).every((k) => !(k in S)), 'derived broadcast keys are not state keys');
const t = schema.broadcastTiers();
ok(stateKeys.every((k) => t[k] === S[k].tier), 'broadcastTiers() carries every state key tier');

// 'typed' restore: a value of the default's type comes back; a value of another type is ignored.
const typedKeys = Object.keys(S).filter((k) => S[k].load === 'typed');
ok(typedKeys.length >= 5, 'some settings use the generic typed loader (' + typedKeys.length + ')');
const probe = {}; const saved = {};
for (const k of typedKeys) {
  probe[k] = state[k];
  saved[k] = typeof state[k] === 'string' ? state[k] + ' x' : typeof state[k] === 'number' ? state[k] + 2 : !state[k];
}
schema.restoreTyped(probe, saved);
ok(typedKeys.every((k) => probe[k] === saved[k]), 'typed keys restore a value of the right type');
const wrong = {}; const before = {};
for (const k of typedKeys) { before[k] = state[k]; wrong[k] = typeof state[k] === 'string' ? 5 : 'nope'; }
schema.restoreTyped(before, wrong);
ok(typedKeys.every((k) => before[k] === state[k]), 'and ignore a value of the wrong type');

// The live server restores them too (through loadState).
fs.writeFileSync(file, JSON.stringify(saved));
console.log = console.warn = console.error = () => {};
const restored = server._testLoadState(file).state;
[console.log, console.warn, console.error] = quiet;
ok(typedKeys.every((k) => restored[k] === saved[k]), 'loadState restores the typed keys from state.json');

console.log(`state-schema: all ${pass} checks passed (${stateKeys.length} state keys, ${shouldSave.length} saved, ${typedKeys.length} typed)`);
process.exit(0);
