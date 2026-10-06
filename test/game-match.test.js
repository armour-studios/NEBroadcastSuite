// backend/game-match.js turns a platform's free-text game name into a GAMES id. It is what makes
// Challonge (and every other platform) multi-game — load a bracket and the app lands on that
// game's overlay, labels and roster size instead of whatever was active before.
//
// The whole risk in that module is ORDER: several games' names contain another game's name, so a
// careless pattern list sends "Rocket League" to `league` and puts a Rocket League bracket on air
// wearing League of Legends' HUD. These cases are exactly that trap.
const assert = require('assert');
const { resolveGameId, normalizeGameName } = require('../backend/game-match');

// The real registry keys, so a mapping can never point at a game this build doesn't have.
const KNOWN = ['rocket-league', 'csgo', 'valorant', 'league', 'dota2', 'overwatch', 'rainbow6',
  'cod', 'apex', 'fortnite', 'bedwars', 'marvel-rivals', 'smash', 'brawlhalla', 'tekken8', 'sf6',
  'ggstrive', '2xko', 'marvel-tokon', 'the-finals', 'eafc', 'mobile-legends', 'honor-of-kings'];

const cases = [
  // ── the collision cases: each of these CONTAINS another game's name ──────
  ['Rocket League', 'rocket-league'],
  ['Mobile Legends: Bang Bang', 'mobile-legends'],
  ['Apex Legends', 'apex'],
  ['League of Legends', 'league'],

  // ── the new one ──────────────────────────────────────────────────────────
  ['Brawlhalla', 'brawlhalla'],
  ['brawlhalla 1v1', 'brawlhalla'],

  // ── spelling variants each platform actually sends ───────────────────────
  ['Super Smash Bros. Ultimate', 'smash'],
  ['SSBU', 'smash'],
  ['Melee', 'smash'],
  ['Counter-Strike: Global Offensive', 'csgo'],
  ['CS2', 'csgo'],
  ['VALORANT', 'valorant'],
  ['Street Fighter 6', 'sf6'],
  ['TEKKEN 8', 'tekken8'],
  ['Guilty Gear -STRIVE-', 'ggstrive'],
  ['Marvel Rivals', 'marvel-rivals'],
  ['Marvel Tokon: Fighting Souls', 'marvel-tokon'],
  ['THE FINALS', 'the-finals'],
  ['Overwatch 2', 'overwatch'],
  ["Tom Clancy's Rainbow Six Siege", 'rainbow6'],
  ['Call of Duty: Black Ops 6', 'cod'],
  ['EA SPORTS FC 25', 'eafc'],
  ['FIFA 23', 'eafc'],
  ['Minecraft', 'bedwars'],

  // ── Challengermode sends a hyphenated SLUG rather than a display name.
  //    Normalisation has to cover it, or every Challengermode load lands on
  //    the wrong overlay. ────────────────────────────────────────────────────
  ['counter-strike-2', 'csgo'],
  ['league-of-legends', 'league'],
  ['rocket-league', 'rocket-league'],
  ['apex-legends', 'apex'],
  ['rainbow-six-siege', 'rainbow6'],
  ['overwatch-2', 'overwatch'],
  ['street-fighter-6', 'sf6'],
  ['tekken-8', 'tekken8'],
  ['ea-sports-fc-25', 'eafc'],
  ['dota-2', 'dota2'],

  // ── must NOT resolve: a wrong id silently swaps the overlay, so '' is the
  //    correct, safe answer for anything we don't actually support ──────────
  ['trackmania', ''],
  ['Legends of Runeterra', ''],
  ['Teamfight Tactics', ''],
  ['Chess', ''],
  ['', ''],
  [null, ''],
  [undefined, '']
];

let failed = 0;
cases.forEach(([input, want]) => {
  const got = resolveGameId(input, KNOWN);
  if (got === want) {
    console.log(`PASS  ${JSON.stringify(input)} -> ${want || '(none)'}`);
  } else {
    failed++;
    console.log(`FAIL  ${JSON.stringify(input)} -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
});

// A pattern must never return an id this build doesn't carry: dropping a game from GAMES would
// otherwise leave a mapping pointing at nothing, and applyActiveGame() would silently no-op.
assert.strictEqual(resolveGameId('Brawlhalla', ['csgo', 'valorant']), '',
  'an id missing from the registry must resolve to "" rather than being returned anyway');
console.log('PASS  an id absent from the registry is not returned');

// Normalisation is what lets one pattern cover every platform's punctuation.
assert.strictEqual(normalizeGameName('Counter-Strike: Global Offensive'), 'counter strike global offensive');
console.log('PASS  punctuation is squashed before matching');

assert.strictEqual(failed, 0, failed + ' case(s) failed');
console.log('\nall passed');
