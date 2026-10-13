'use strict';
// One-click CS2 setup: Steam library parsing, folder resolution, the launch link and spectate detection.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../backend/cs2-setup');

test('parses Steam library folders', () => {
  const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\SteamLibrary"\n\t\t"apps"\t{ "730" "1" }\n\t}\n}';
  assert.deepStrictEqual(C.parseLibraryFolders(vdf), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
  assert.deepStrictEqual(C.parseLibraryFolders(''), []);
});

test('resolves the cfg folder from the cfg, install or library folder', () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2lib-'));
  const cfg = path.join(lib, C.CS2_DIR, C.CFG_SUB);
  fs.mkdirSync(cfg, { recursive: true });
  assert.strictEqual(C.resolveCfgDir(cfg), cfg);
  assert.strictEqual(C.resolveCfgDir(path.join(lib, C.CS2_DIR)), cfg);
  assert.strictEqual(C.resolveCfgDir(lib), cfg);
  assert.strictEqual(C.resolveCfgDir('"' + lib + '"'), cfg, 'quotes from Copy as path are fine');
  assert.strictEqual(C.resolveCfgDir(path.join(lib, 'nope')), '');
  assert.strictEqual(C.resolveCfgDir(''), '');
});

test('launch link carries the console port and the observer cfg', () => {
  assert.strictEqual(C.launchUrl(2121), 'steam://run/730//-netconport%202121%20%2Bexec%20cs2-spectator/');
  assert.strictEqual(C.launchUrl('bad'), C.launchUrl(2121));
  assert.ok(C.launchUrl(2999).includes('2999'));
});

test('spectating means more than one player in allplayers', () => {
  assert.strictEqual(C.isSpectating({ player: {} }), false);
  assert.strictEqual(C.isSpectating({ allplayers: { a: {} } }), false);
  assert.strictEqual(C.isSpectating({ allplayers: { a: {}, b: {} } }), true);
  assert.strictEqual(C.isSpectating(null), false);
});
