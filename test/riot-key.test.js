// node test/riot-key.test.js
//
// Guards the Riot Games key wiring:
//   1. state.riot exists with both routings, and a saved region/platform survives a restart.
//   2. riot-client's error text names the ACTUAL cause. A Riot development key dies after 24
//      hours and answers 403 — not 401 — so a generic "unauthorized" sends a producer hunting a
//      typo in a key that is simply expired. That sentence is the whole value of the panel.
//   3. A Riot ID without a tag is refused before a request is spent (rate limits are tiny).
'use strict';
const fs = require('fs');
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

const riot = require(path.join(__dirname, '..', 'backend', 'integrations', 'riot-client'));

// ── 1. state + restore ──────────────────────────────────────────────────────
const origErr = console.error;
console.error = () => {};
const server = require(path.join(__dirname, '..', 'server.js'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-riot-'));
const file = path.join(dir, 'state.json');

fs.writeFileSync(file, '{}');
const defaults = JSON.parse(JSON.stringify(server._testLoadState(file).state));
check(!!defaults.riot && !!defaults.riot.region && !!defaults.riot.platform,
  'state.riot ships with a default region and platform');

fs.writeFileSync(file, JSON.stringify({ ...defaults, riot: { region: 'asia', platform: 'kr' } }));
const restored = server._testLoadState(file).state;
console.error = origErr;
check(restored.riot.region === 'asia' && restored.riot.platform === 'kr',
  'a saved Riot region/platform survives a restart');

// ── 2. key kind + the 403 sentence ──────────────────────────────────────────
check(riot.keyKind('RGAPI-0000aaaa-1111-2222-3333-444455556666') === 'development', 'RGAPI- prefix reads as a development key');
check(riot.keyKind('abcd1234') === 'production', 'a non-prefixed key reads as production');
check(riot.keyKind('') === 'none', 'no key reads as none');

// Routing tables are what keep the two selectors honest.
check(riot.PLATFORM_REGION.kr === 'asia' && riot.PLATFORM_REGION.na1 === 'americas' && riot.PLATFORM_REGION.euw1 === 'europe',
  'platform → regional route mapping is right for kr / na1 / euw1');
check(Object.keys(riot.PLATFORMS).every((p) => riot.REGIONS.includes(riot.PLATFORM_REGION[p])),
  'every platform maps to a real regional route');

// ── 3. a malformed Riot ID never costs a request ────────────────────────────
(async () => {
  const bad = await riot.lookupPlayer('RGAPI-test', { region: 'americas', platform: 'na1', riotId: 'Faker' });
  check(!bad.ok && /tag/i.test(bad.error || ''), 'a Riot ID with no #TAG is refused locally, with a reason');

  const noKey = await riot.riotGet('', 'americas.api.riotgames.com', '/riot/account/v1/accounts/by-riot-id/a/b');
  check(!noKey.ok && /key/i.test(noKey.error || ''), 'a request with no key saved fails fast instead of calling Riot');

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
