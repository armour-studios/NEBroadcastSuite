// Game Config bundles are producer-authored, so everything the builder (or an imported .zip) sends
// goes through normalizeGameConfig before the merge-by-id in veto.js / draft.js sees it.
const assert = require('assert');
const { normalizeGameConfig } = require('../backend/game-config.js');
const veto = require('../backend/veto.js');
const draft = require('../backend/draft.js');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const built = { maps: veto.mapPool('overwatch'), characters: draft.ROSTERS.overwatch };

const cfg = normalizeGameConfig({
  game: 'overwatch', author: ' me ', pois: { keep: 1 },
  maps: [
    { id: 'mapx1', name: 'Brand New Map', image: PNG, type: 'Clash' },      // new → slug id
    { id: 'mapx2', name: "king's row", image: PNG },                        // name matches a built-in → override
    { id: 'ilios', name: 'Ilios', image: '', type: '' },                    // override with nothing changed
    { id: 'mapx3', name: '', image: PNG },                                  // unnamed new row → dropped
    { id: 'mapx4', name: 'Bad', image: 'javascript:alert(1)' }              // bad image → kept without it
  ],
  characters: [{ id: 'charq', name: 'New Hero', image: PNG, role: 'Tank' }, { id: 'charq2', name: 'New Hero', role: 'Support' }],
  roles: ['Flex', 'flex', ' Shotcaller '],
  roleIcons: { Tank: PNG, Flex: 'nope' }
}, built);

assert.strictEqual(cfg.author, 'me');
assert.deepStrictEqual(cfg.pois, { keep: 1 }, 'keys owned by other features survive');
assert.deepStrictEqual(cfg.maps.map((m) => m.id).sort(), ['bad', 'brand-new-map', 'ilios', 'kings-row']);
assert.strictEqual(cfg.maps.find((m) => m.id === 'bad').image, undefined);
assert.deepStrictEqual(cfg.maps.find((m) => m.id === 'ilios'), { id: 'ilios' }, 'blank / unchanged fields are not stored');
assert.strictEqual(cfg.characters.length, 1, 'same name collapses to one row');
assert.strictEqual(cfg.characters[0].id, 'new-hero');
assert.deepStrictEqual(cfg.roles, ['Flex', 'Shotcaller']);
assert.deepStrictEqual(cfg.roleIcons, { tank: PNG });

// Normalising twice is stable (re-saving never mints new ids).
assert.deepStrictEqual(normalizeGameConfig(cfg, built), cfg);

// Merged into the live pools: the override keeps the built-in's type + gets the new image, an
// untouched override leaves the built-in image alone, and nothing is duplicated.
const pool = veto.mergedMapPools({ overwatch: cfg }).overwatch;
assert.strictEqual(pool.length, built.maps.length + 2);
const kr = pool.find((m) => m.id === 'kings-row');
assert.strictEqual(kr.image, PNG); assert.strictEqual(kr.type, 'Hybrid');
assert.strictEqual(pool.find((m) => m.id === 'ilios').image, '/assets/overwatch/maps/ilios.jpg');

const roster = draft.mergedRosters({ overwatch: cfg }).overwatch;
assert.strictEqual(roster.length, built.characters.length + 1);
assert.strictEqual(draft.roleFor('overwatch', 'New Hero', { overwatch: cfg }), 'Support');

// Garbage in → an empty, well-formed bundle (never a throw).
const empty = normalizeGameConfig(null, null);
assert.deepStrictEqual([empty.maps, empty.characters, empty.roles, empty.modes], [[], [], [], []]);

console.log('game-config: ok');
