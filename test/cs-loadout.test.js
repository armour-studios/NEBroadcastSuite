// node test/cs-loadout.test.js
//
// Guards the CS2 loadout parse behind the player sidebar and the freezetime buy board.
//
// Those overlays used to show each player's ACTIVE weapon. In freezetime everyone runs with a
// knife out, so the buy board — whose whole job is showing what each team bought — became a row
// of knives (and, before the icon resolver, broken images for every custom knife skin). The fix
// is JT's HUD rule: show what a player OWNS, primary → pistol → zeus. That rule lives in
// parseWeapons() in server.js; this pins it, plus the grenade ordering and flashbang counting.
//
// parseWeapons is extracted from server.js source and evaluated on its own (server.js boots the
// whole app when required), the same approach test/switch-scope.test.js takes.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = src.indexOf('const CS_NADE_ORDER');
const fnAt = src.indexOf('function parseWeapons(');
if (start < 0 || fnAt < 0 || start > fnAt) { console.error('FAIL: parseWeapons / CS_NADE_ORDER not found in server.js'); process.exit(1); }
let depth = 0, end = src.indexOf('{', fnAt);
for (let i = end; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const sandboxed = vm.runInNewContext(src.slice(start, end) + ';({ parseWeapons })').parseWeapons;
// Arrays built inside the vm context carry that realm's Array prototype, which deepStrictEqual
// rejects even when the values match, so copy the result into this realm before asserting.
const parseWeapons = (w) => { const r = sandboxed(w); return Object.assign({}, r, { nades: Array.from(r.nades) }); };

// GSI weapons object from a compact list: [name, type, state?, extra?]
const gsi = (...items) => Object.fromEntries(items.map(([name, type, state = 'holstered', extra = {}], i) =>
  ['weapon_' + i, Object.assign({ name: 'weapon_' + name, state }, type === undefined ? {} : { type }, extra)]));

let failures = 0, passes = 0;
function check(label, fn) {
  try { fn(); passes++; }
  catch (e) { failures++; console.error('FAIL: ' + label + '\n  ' + e.message); }
}

check('freezetime: knife in hand, bought rifle is still the primary', () => {
  const r = parseWeapons(gsi(['knife_karambit', 'Knife', 'active'], ['glock', 'Pistol'], ['ak47', 'Rifle']));
  assert.strictEqual(r.weapon, 'knife_karambit');   // active stays the active item
  assert.strictEqual(r.primary, 'ak47');
  assert.strictEqual(r.secondary, 'glock');
});

check('every primary gun class counts; sniper found behind a pistol slot', () => {
  for (const type of ['Rifle', 'SniperRifle', 'Submachine Gun', 'Shotgun', 'Machine Gun']) {
    const r = parseWeapons(gsi(['usp_silencer', 'Pistol', 'active'], ['awp', type]));
    assert.strictEqual(r.primary, 'awp', type);
  }
});

check('pistol round: no primary, pistol is the secondary', () => {
  const r = parseWeapons(gsi(['knife', 'Knife'], ['usp_silencer', 'Pistol', 'active']));
  assert.strictEqual(r.primary, '');
  assert.strictEqual(r.secondary, 'usp_silencer');
});

check('zeus is flagged by name whatever its type, and never taken as the pistol', () => {
  for (const type of [undefined, 'Pistol', '']) {
    const r = parseWeapons(gsi(['taser', type], ['p250', 'Pistol']));
    assert.strictEqual(r.hasTaser, true, String(type));
    assert.strictEqual(r.secondary, 'p250', String(type));
    assert.strictEqual(r.primary, '', String(type));
  }
});

check('knives, bomb, healthshot and untyped items are never the primary', () => {
  const r = parseWeapons(gsi(['knife_butterfly', 'Knife'], ['c4', 'C4', 'active'], ['healthshot', 'StackableItem'], ['mystery', undefined]));
  assert.strictEqual(r.primary, '');
  assert.strictEqual(r.hasBomb, true);
});

check('grenades come out in reading order, not GSI slot order', () => {
  const r = parseWeapons(gsi(['flashbang', 'Grenade'], ['decoy', 'Grenade'], ['hegrenade', 'Grenade'], ['incgrenade', 'Grenade'], ['smokegrenade', 'Grenade']));
  assert.deepStrictEqual(r.nades, ['smokegrenade', 'hegrenade', 'incgrenade', 'flashbang', 'decoy']);
});

check('two flashbangs on one entry (ammo_reserve 2) render as two', () => {
  const r = parseWeapons(gsi(['flashbang', 'Grenade', 'holstered', { ammo_reserve: 2 }]));
  assert.deepStrictEqual(r.nades, ['flashbang', 'flashbang']);
});

check('flashbangs clamp to the game limit of 2; other grenades to 1', () => {
  const r = parseWeapons(gsi(['flashbang', 'Grenade', 'holstered', { ammo_reserve: 2 }], ['flashbang', 'Grenade'],
    ['smokegrenade', 'Grenade', 'holstered', { ammo_reserve: 3 }]));
  assert.deepStrictEqual(r.nades, ['smokegrenade', 'flashbang', 'flashbang']);
});

check('grenade in hand is reported, and an unknown grenade is kept rather than dropped', () => {
  const r = parseWeapons(gsi(['m4a1_silencer', 'Rifle'], ['molotov', 'Grenade', 'active'], ['tagrenade', 'Grenade']));
  assert.strictEqual(r.activeNade, 'molotov');
  assert.strictEqual(r.weapon, 'molotov');
  assert.strictEqual(r.primary, 'm4a1_silencer');
  assert.deepStrictEqual(r.nades, ['molotov', 'tagrenade']);
});

check('active ammo is still read for firing detection', () => {
  const r = parseWeapons(gsi(['ak47', 'Rifle', 'active', { ammo_clip: 17, ammo_reserve: 60 }]));
  assert.strictEqual(r.clip, 17);
  assert.strictEqual(r.reserve, 60);
});

check('missing or empty weapons object yields an empty loadout', () => {
  for (const w of [undefined, null, {}]) {
    const r = parseWeapons(w);
    assert.deepStrictEqual([r.weapon, r.primary, r.secondary, r.hasTaser, r.activeNade, r.nades.length, r.hasBomb],
      ['', '', '', false, '', 0, false]);
  }
});

if (failures) { console.error(`\n${failures} failed, ${passes} passed`); process.exit(1); }
console.log(`cs-loadout: all ${passes} checks passed`);
