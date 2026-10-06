// node test/brand-styles.test.js
//
// Guards the rule that overlay STYLES belong to the producer, not to a brand kit:
//   1. A kit only changes per-game layouts when it is linked (kit.linkStyles), and then every game
//      it names — not just the active one.
//   2. A package's captured scene style presets apply only for a linked kit, and MERGE (presets the
//      producer made after the capture survive).
//   3. Importing a profile merges libraries and show settings but leaves overlay styles alone
//      unless options.styles === true.
// Before this, every save/activation/package switch snapped the active game's layout to the kit's
// and replaced every scene preset, and every profile import overwrote replay / stats-screen looks.
'use strict';
const os = require('os');
const path = require('path');
const Module = require('module');

const stub = new Proxy(function () {}, { get: (t, k) => (k === '__esModule' ? false : stub), apply: () => stub, construct: () => stub });
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      app: { getPath: () => os.tmpdir(), isPackaged: false, on() {}, getVersion: () => '0.0.0' },
      dialog: stub, BrowserWindow: stub, ipcMain: stub, shell: stub, screen: stub, nativeImage: stub,
      Notification: stub, powerMonitor: stub, safeStorage: { isEncryptionAvailable: () => false }
    };
  }
  return origLoad.call(this, req, ...rest);
};

let failures = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failures++; };

const server = require(path.join(__dirname, '..', 'server.js'));
const { applyKitStyles, applyPackageSnapshot, applyProfileBundle, getState } = server._testBrandStyles;
const state = getState();
state.activeGame = 'rocket-league';
state.themesByGame['rocket-league'] = 'classic';

// 1. Unlinked kit: no change.
const kit = { id: 'k1', linkStyles: false, themes: { 'rocket-league': 'lexogrine', smash: 'definitely-not-a-layout' } };
check(applyKitStyles(kit) === false && state.themesByGame['rocket-league'] === 'classic', 'unlinked kit leaves the RL layout alone');

// 1b. Linked kit: every valid game it names changes (active or not); invalid ids are ignored.
state.activeGame = 'csgo';
const smashBefore = state.themesByGame.smash;
kit.linkStyles = true;
applyKitStyles(kit);
check(state.themesByGame['rocket-league'] === 'lexogrine', 'linked kit sets a game that is NOT the active game');
check(state.themesByGame.smash === smashBefore, 'linked kit ignores a layout id that does not exist');
state.themesByGame['rocket-league'] = 'classic';

// 2. Snapshot scene presets.
state.scenePresets = { duorow: { active: 'Mine', presets: { Mine: { label: 'Mine', config: { accent: '#ff0000' } } } } };
const pkg = { showSnapshot: { scenePresets: { duorow: { active: 'Old', presets: { Old: { label: 'Old', config: { accent: '#00ff00' } } } } } } };
applyPackageSnapshot(pkg);
check(state.scenePresets.duorow.active === 'Mine' && !state.scenePresets.duorow.presets.Old, 'unlinked snapshot does not touch scene presets');
applyPackageSnapshot(pkg, { styles: true });
check(state.scenePresets.duorow.active === 'Old', 'linked snapshot selects the captured preset');
check(!!state.scenePresets.duorow.presets.Mine && !!state.scenePresets.duorow.presets.Old, 'linked snapshot MERGES — the producer\'s newer preset survives');

// 3. Profile import.
state.rlStatsScreen = { showStats: true, design: 'default' };
state.bestOf = 5;
const bundle = { format: 'ne-broadcast-profile', data: { settings: { rlStatsScreen: { showStats: false, design: 'minimal' }, bestOf: 7, themesByGame: { 'rocket-league': 'react' } } } };
applyProfileBundle(bundle, { settings: true });
check(state.rlStatsScreen.design === 'default' && state.themesByGame['rocket-league'] === 'classic', 'profile import leaves overlay styles alone by default');
check(state.bestOf === 7, 'profile import still applies show settings');
applyProfileBundle(bundle, { settings: true, styles: true });
check(state.rlStatsScreen.design === 'minimal' && state.themesByGame['rocket-league'] === 'react', 'profile import replaces styles when asked (options.styles)');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('brand-styles: ok');
process.exit(0);   // server.js leaves save/cloud timers running
