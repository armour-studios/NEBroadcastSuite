// backend/veto.js — multi-game map-veto data + sequence engine.
// Pure helpers; server.js owns the live state and broadcasting.
//
// Per game we need three things the recon flagged as missing:
//   1) a MAP POOL (names + images),
//   2) a competitive VETO FORMAT per best-of (the ban/pick order + who acts),
//   3) a way to resolve "team index 0/1" → the concrete side ('a'/'b') that starts.

// ── Map pools ───────────────────────────────────────────────────────────────
// CS2 ships with radar PNGs we already host; other games carry names (drop images
// into /assets/<game>/maps/ later and fill the `image` field to light them up).
const MAP_POOLS = {
  csgo: [
    { id: 'mirage',   name: 'Mirage',   image: '/assets/csgo/maps/de_mirage.png' },
    { id: 'inferno',  name: 'Inferno',  image: '/assets/csgo/maps/de_inferno.png' },
    { id: 'nuke',     name: 'Nuke',     image: '/assets/csgo/maps/de_nuke.png' },
    { id: 'ancient',  name: 'Ancient',  image: '/assets/csgo/maps/de_ancient.png' },
    { id: 'anubis',   name: 'Anubis',   image: '/assets/csgo/maps/de_anubis.png' },
    { id: 'dust2',    name: 'Dust II',  image: '/assets/csgo/maps/de_dust2.png' },
    { id: 'train',    name: 'Train',    image: '/assets/csgo/maps/de_train.png' }
  ],
  valorant: [
    { id: 'ascent', name: 'Ascent', image: '' }, { id: 'bind', name: 'Bind', image: '' },
    { id: 'haven', name: 'Haven', image: '' },   { id: 'lotus', name: 'Lotus', image: '' },
    { id: 'split', name: 'Split', image: '' },   { id: 'sunset', name: 'Sunset', image: '' },
    { id: 'abyss', name: 'Abyss', image: '' }
  ],
  rainbow6: [
    { id: 'bank', name: 'Bank', image: '' },         { id: 'border', name: 'Border', image: '' },
    { id: 'chalet', name: 'Chalet', image: '' },     { id: 'clubhouse', name: 'Clubhouse', image: '' },
    { id: 'consulate', name: 'Consulate', image: '' },{ id: 'kafe', name: 'Kafe Dostoyevsky', image: '' },
    { id: 'lair', name: 'Lair', image: '' }
  ],
  // Super Smash Bros. Ultimate — starter STAGES (struck 1-2-1 down to the game-1 stage).
  smash: [
    { id: 'battlefield', name: 'Battlefield', image: '' },
    { id: 'final-destination', name: 'Final Destination', image: '' },
    { id: 'small-battlefield', name: 'Small Battlefield', image: '' },
    { id: 'pokemon-stadium-2', name: 'Pokémon Stadium 2', image: '' },
    { id: 'smashville', name: 'Smashville', image: '' }
  ],
  // Overwatch 2 — OWCS 2025 competitive map pool. type field drives the center display in overwatch.html.
  overwatch: [
    // Control
    { id: 'ilios',               name: 'Ilios',                type: 'Control',   image: '' },
    { id: 'lijiang',             name: 'Lijiang Tower',        type: 'Control',   image: '' },
    { id: 'oasis',               name: 'Oasis',                type: 'Control',   image: '' },
    { id: 'nepal',               name: 'Nepal',                type: 'Control',   image: '' },
    { id: 'samoa',               name: 'Samoa',                type: 'Control',   image: '' },
    { id: 'antarctic-peninsula', name: 'Antarctic Peninsula',  type: 'Control',   image: '' },
    // Hybrid
    { id: 'kings-row',           name: "King's Row",           type: 'Hybrid',    image: '' },
    { id: 'numbani',             name: 'Numbani',              type: 'Hybrid',    image: '' },
    { id: 'midtown',             name: 'Midtown',              type: 'Hybrid',    image: '' },
    { id: 'paraiso',             name: 'Paraíso',              type: 'Hybrid',    image: '' },
    { id: 'blizzard-world',      name: 'Blizzard World',       type: 'Hybrid',    image: '' },
    // Escort
    { id: 'dorado',              name: 'Dorado',               type: 'Escort',    image: '' },
    { id: 'circuit-royal',       name: 'Circuit Royal',        type: 'Escort',    image: '' },
    { id: 'havana',              name: 'Havana',               type: 'Escort',    image: '' },
    { id: 'junkertown',          name: 'Junkertown',           type: 'Escort',    image: '' },
    // Push
    { id: 'new-queen-street',    name: 'New Queen Street',     type: 'Push',      image: '' },
    { id: 'esperanca',           name: 'Esperança',            type: 'Push',      image: '' },
    { id: 'colosseo',            name: 'Colosseo',             type: 'Push',      image: '' },
    { id: 'runasapi',            name: 'Runasapi',             type: 'Push',      image: '' },
    // Flashpoint
    { id: 'suravasa',            name: 'Suravasa',             type: 'Flashpoint', image: '' },
    { id: 'new-junk-city',       name: 'New Junk City',        type: 'Flashpoint', image: '' }
  ],
  // Marvel Rivals — convergence/domination map pool (names approximate; edit as the pool rotates).
  'marvel-rivals': [
    { id: 'yggsgard', name: 'Yggsgard', image: '' },      { id: 'tokyo-2099', name: 'Tokyo 2099', image: '' },
    { id: 'klyntar', name: 'Klyntar', image: '' },        { id: 'wakanda', name: 'Empire of Wakanda', image: '' },
    { id: 'hydra-base', name: 'Hydra Charteris Base', image: '' }, { id: 'spider-islands', name: 'Spider-Islands', image: '' },
    { id: 'hells-heaven', name: "Hell's Heaven", image: '' }
  ],
  // Rocket League — arenas are cosmetic (no real competitive veto); included so the app can
  // show/select an arena on the board if a tournament chooses to.
  'rocket-league': [
    { id: 'dfh-stadium', name: 'DFH Stadium', image: '/assets/rocket-league/maps/dfh-stadium.jpg' },     { id: 'mannfield', name: 'Mannfield', image: '/assets/rocket-league/maps/mannfield.jpg' },
    { id: 'champions-field', name: 'Champions Field', image: '/assets/rocket-league/maps/champions-field.jpg' }, { id: 'neo-tokyo', name: 'Neo Tokyo', image: '/assets/rocket-league/maps/neo-tokyo.jpg' },
    { id: 'beckwith-park', name: 'Beckwith Park', image: '/assets/rocket-league/maps/beckwith-park.jpg' },  { id: 'urban-central', name: 'Urban Central', image: '/assets/rocket-league/maps/urban-central.jpg' },
    { id: 'utopia-coliseum', name: 'Utopia Coliseum', image: '/assets/rocket-league/maps/utopia-coliseum.jpg' }, { id: 'salty-shores', name: 'Salty Shores', image: '/assets/rocket-league/maps/salty-shores.jpg' }
  ]
};

// Per-game terminology so the UI/board read correctly per selection type.
const VETO_META = {
  csgo:            { kind: 'map',   banWord: 'Ban',    unit: 'map' },
  valorant:        { kind: 'map',   banWord: 'Ban',    unit: 'map' },
  rainbow6:        { kind: 'map',   banWord: 'Ban',    unit: 'map' },
  overwatch:       { kind: 'map',   banWord: 'Ban',    unit: 'map', hasBans: true },
  'marvel-rivals': { kind: 'map',   banWord: 'Ban',    unit: 'map' },
  'rocket-league': { kind: 'arena', banWord: 'Ban',    unit: 'arena' },
  smash:           { kind: 'stage', banWord: 'Strike', unit: 'stage' }
};
function getMeta(game) { return VETO_META[game] || { kind: 'map', banWord: 'Ban', unit: 'map' }; }

// ── Veto formats ─────────────────────────────────────────────────────────────
// Each step is [action, teamIdx]; teamIdx 0 = the side that bans first, 1 = the other.
// Deciders are implicit (the maps left after every ban/pick), so formats list only
// the manual ban/pick steps. STD7 = the standard CS2/Valorant 7-map orders.
const STD7 = {
  1: [['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1]],          // → 1 decider
  3: [['ban', 0], ['ban', 1], ['pick', 0], ['pick', 1], ['ban', 0], ['ban', 1]],          // → 3 maps
  5: [['ban', 0], ['ban', 1], ['pick', 0], ['pick', 1], ['pick', 0], ['pick', 1]]          // → 5 maps
};
// Smash Ultimate game-1 stage striking on a 5-stage starter set: P1 strikes 1,
// P2 strikes 2, P1 strikes 1 → 1 stage remains (the "1-2-1" rule).
const SMASH_STRIKE = { 1: [['ban', 0], ['ban', 1], ['ban', 1], ['ban', 0]] };

// OWCS map veto: FT3 → each team strikes 3, then alternately picks until 5 maps remain.
// FT2: ban 2 (1 each), pick 2 (1 each), 1 decider. FT3: ban 2, pick 2, ban 2, 1 decider (→5 total).
// Simplified to the standard alternate-ban generic fallback since OWCS is not fully standardized.
const OWCS_VETO = {
  2: [['ban',0],['ban',1],['pick',0],['pick',1]],                          // → 2 maps + 1 decider
  3: [['ban',0],['ban',1],['pick',0],['pick',1],['ban',0],['ban',1]],      // → 3 maps + 1 decider (but played as FT3 so stop at winner)
  5: [['ban',0],['ban',1],['pick',0],['pick',1],['pick',0],['pick',1]]     // → 5 maps
};
const VETO_FORMATS = { csgo: STD7, valorant: STD7, rainbow6: STD7, smash: SMASH_STRIKE, overwatch: OWCS_VETO };

// Each map carries an image; when none is set we fall back to a generated placeholder
// at /assets/<game>/maps/<id>.svg (see assets/build-map-placeholders.js).
function mapPool(game) {
  return (MAP_POOLS[game] || []).map(m => ({
    ...m,
    image: m.image || `/assets/${game}/maps/${m.id}.svg`
  }));
}
function hasVeto(game) { return (MAP_POOLS[game] || []).length > 0; }
function vetoGames() { return Object.keys(MAP_POOLS); }

// Resolve the manual ban/pick steps for a game + best-of, sized to the pool.
// Falls back to a generic "alternate bans down to N maps" order for any game/size.
function buildSequence(game, bestOf, poolSize) {
  const bo = [1, 3, 5, 7].includes(Number(bestOf)) ? Number(bestOf) : 1;
  const fmt = VETO_FORMATS[game] && VETO_FORMATS[game][bo];
  if (fmt) return fmt.map(s => ({ action: s[0], teamIdx: s[1] }));
  // Generic fallback for games without an authored format: alternate bans until
  // `bo` maps remain (the remainder become deciders).
  const bans = Math.max(0, poolSize - bo);
  const seq = [];
  for (let i = 0; i < bans; i++) seq.push({ action: 'ban', teamIdx: i % 2 });
  return seq;
}

// teamIdx (0|1) → concrete side ('a'|'b') given which side starts.
function resolveSide(teamIdx, teamStart) {
  const other = teamStart === 'a' ? 'b' : 'a';
  return teamIdx === 0 ? (teamStart || 'a') : other;
}

module.exports = { MAP_POOLS, VETO_FORMATS, VETO_META, getMeta, mapPool, hasVeto, vetoGames, buildSequence, resolveSide };
