// FGC plaque flags must come from an ISO-2 code. start.gg fills `country` with the country NAME
// ("United States") and `countryCode` with "us"; reading the name asked for "united states.svg",
// a 404 the image skin drew as a broken-image icon on air (Marvel Tokon, 2026-09-13).
// Loads the REAL overlay/fgc/fgc-adapter.js in a sandbox and calls its exposed mapper.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'fgc', 'fgc-adapter.js'), 'utf8');
const window = {};
vm.runInNewContext(src, {
  window, location: { search: '', href: 'http://127.0.0.1:3001/fgc/default-img/template.html' },
  document: { getElementById: () => null, documentElement: { classList: { toggle() {} } } },
  setTimeout: () => 0, console
});
const map = window.__fgcMapState;
assert.strictEqual(typeof map, 'function', '__fgcMapState not exposed');

const side = (name, player) => ({ name, color: '#e0383e', logo: '', players: [player] });
const out = map({
  teams: {
    blue: side('HPARK', { country: 'United States', countryCode: 'us' }),
    orange: side('DREDAWG', { country: 'United States' })   // name only, no code
  },
  series: { blue: 0, orange: 0 }
});

assert.strictEqual(out.player1.img, '/fgc/static/flags/flags/1x1/us.svg', 'countryCode wins over a country name');
assert.strictEqual(out.player2.img, '', 'a bare country name must not become a flag URL');

// Our own team editor stores the lowercase ISO code in `country` — still honoured.
const own = map({ teams: { blue: side('A', { gamertag: 'A', country: 'gb' }), orange: {} }, series: {} });
assert.strictEqual(own.player1.img, '/fgc/static/flags/flags/1x1/gb.svg');

console.log('fgc-flag: ok');
