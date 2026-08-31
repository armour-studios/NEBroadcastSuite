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
  // Super Smash Bros. Ultimate — the legal stage list most modern rulesets run.
  //
  // `tier` is a DEFAULT ruleset hint, not a property of the stage: every event is different, and
  // plenty run no strike phase at all. It seeds the guided veto's "Strike from" picker (which the
  // producer can override, or ignore entirely by never starting a veto) and nothing else.
  // Deliberately NOT `type` — that field is intrinsic map data (Overwatch's Control/Hybrid, always
  // true of the map) and the Series editor auto-labels the graphic from it. Tagging stages with
  // `type:'Starter'` stamped a ruleset onto every card of every Smash event.
  // Stage art is fetched by assets/fetch-smash-stages.js.
  smash: [
    { id: 'battlefield',        name: 'Battlefield',          tier: 'Starter',     image: '/assets/smash/maps/battlefield.png' },
    { id: 'final-destination',  name: 'Final Destination',    tier: 'Starter',     image: '/assets/smash/maps/final-destination.png' },
    { id: 'small-battlefield',  name: 'Small Battlefield',    tier: 'Starter',     image: '/assets/smash/maps/small-battlefield.png' },
    { id: 'pokemon-stadium-2',  name: 'Pokémon Stadium 2',    tier: 'Starter',     image: '/assets/smash/maps/pokemon-stadium-2.png' },
    { id: 'smashville',         name: 'Smashville',           tier: 'Starter',     image: '/assets/smash/maps/smashville.png' },
    { id: 'hollow-bastion',     name: 'Hollow Bastion',       tier: 'Counterpick', image: '/assets/smash/maps/hollow-bastion.png' },
    { id: 'town-and-city',      name: 'Town and City',        tier: 'Counterpick', image: '/assets/smash/maps/town-and-city.png' },
    { id: 'kalos-pokemon-league', name: 'Kalos Pokémon League', tier: 'Counterpick', image: '/assets/smash/maps/kalos-pokemon-league.png' },
    { id: 'yoshis-story',       name: "Yoshi's Story",        tier: 'Counterpick', image: '/assets/smash/maps/yoshis-story.png' }
  ],
  // Overwatch 2 — OWCS 2025 competitive map pool. type field drives the center display in overwatch.html.
  // Map images sourced from Liquipedia (liquipedia.net/overwatch/Maps) and hosted locally.
  overwatch: [
    // Control
    { id: 'ilios',               name: 'Ilios',                type: 'Control',   image: '/assets/overwatch/maps/ilios.jpg' },
    { id: 'lijiang',             name: 'Lijiang Tower',        type: 'Control',   image: '/assets/overwatch/maps/lijiang.jpg' },
    { id: 'oasis',               name: 'Oasis',                type: 'Control',   image: '/assets/overwatch/maps/oasis.jpg' },
    { id: 'nepal',               name: 'Nepal',                type: 'Control',   image: '/assets/overwatch/maps/nepal.jpg' },
    { id: 'samoa',               name: 'Samoa',                type: 'Control',   image: '/assets/overwatch/maps/samoa.jpg' },
    { id: 'antarctic-peninsula', name: 'Antarctic Peninsula',  type: 'Control',   image: '/assets/overwatch/maps/antarctic-peninsula.jpg' },
    // Hybrid
    { id: 'kings-row',           name: "King's Row",           type: 'Hybrid',    image: '/assets/overwatch/maps/kings-row.jpg' },
    { id: 'numbani',             name: 'Numbani',              type: 'Hybrid',    image: '/assets/overwatch/maps/numbani.jpg' },
    { id: 'midtown',             name: 'Midtown',              type: 'Hybrid',    image: '/assets/overwatch/maps/midtown.jpg' },
    { id: 'paraiso',             name: 'Paraíso',              type: 'Hybrid',    image: '/assets/overwatch/maps/paraiso.png' },
    { id: 'blizzard-world',      name: 'Blizzard World',       type: 'Hybrid',    image: '/assets/overwatch/maps/blizzard-world.jpg' },
    // Escort
    { id: 'dorado',              name: 'Dorado',               type: 'Escort',    image: '/assets/overwatch/maps/dorado.jpg' },
    { id: 'circuit-royal',       name: 'Circuit Royal',        type: 'Escort',    image: '/assets/overwatch/maps/circuit-royal.png' },
    { id: 'havana',              name: 'Havana',               type: 'Escort',    image: '/assets/overwatch/maps/havana.jpg' },
    { id: 'junkertown',          name: 'Junkertown',           type: 'Escort',    image: '/assets/overwatch/maps/junkertown.jpg' },
    // Push
    { id: 'new-queen-street',    name: 'New Queen Street',     type: 'Push',      image: '/assets/overwatch/maps/new-queen-street.jpg' },
    { id: 'esperanca',           name: 'Esperança',            type: 'Push',      image: '/assets/overwatch/maps/esperanca.jpg' },
    { id: 'colosseo',            name: 'Colosseo',             type: 'Push',      image: '/assets/overwatch/maps/colosseo.jpg' },
    { id: 'runasapi',            name: 'Runasapi',             type: 'Push',      image: '/assets/overwatch/maps/runasapi.jpg' },
    // Flashpoint
    { id: 'suravasa',            name: 'Suravasa',             type: 'Flashpoint', image: '/assets/overwatch/maps/suravasa.jpg' },
    { id: 'new-junk-city',       name: 'New Junk City',        type: 'Flashpoint', image: '/assets/overwatch/maps/new-junk-city.jpg' }
  ],
  // Marvel Rivals — verified Ignite 2026 / MRC S7 competitive pool (14 maps, syncs with the
  // in-game Competitive pool each season — see docs/marvel-rivals-production.md). Map 1 of a
  // series is always Domination. Images best-effort from assets/maps/marvel-rivals/.
  'marvel-rivals': [
    { id: 'birnin-tchalla',    name: "Birnin T'Challa",        type: 'Domination',  image: '/assets/maps/marvel-rivals/birnin-tchaka.png' },
    { id: 'hells-heaven',      name: "Hell's Heaven",          type: 'Domination',  image: '/assets/maps/marvel-rivals/hydra-charteris-base.png' },
    { id: 'krakoa',            name: 'Krakoa',                 type: 'Domination',  image: '/assets/maps/marvel-rivals/krakoa-grove.png' },
    { id: 'celestial-husk',    name: 'Celestial Husk',         type: 'Domination',  image: '' },
    { id: 'yggdrasill-path',   name: 'Yggdrasill Path',        type: 'Convoy',      image: '/assets/maps/marvel-rivals/yggsgard.png' },
    { id: 'spider-islands',    name: 'Spider-Islands',         type: 'Convoy',      image: '/assets/maps/marvel-rivals/klyntar-spider-islands.png' },
    { id: 'midtown',           name: 'Midtown',                type: 'Convoy',      image: '/assets/maps/marvel-rivals/midtown.png' },
    { id: 'arakko',            name: 'Arakko',                 type: 'Convoy',      image: '/assets/maps/marvel-rivals/hellfire-gala-arakko.png' },
    { id: 'museum-of-contemplation', name: 'Museum of Contemplation', type: 'Convoy', image: '' },
    { id: 'hall-of-djalia',    name: 'Hall of Djalia',         type: 'Convergence', image: '/assets/maps/marvel-rivals/hall-of-djalia.png' },
    { id: 'symbiotic-surface', name: 'Symbiotic Surface',      type: 'Convergence', image: '' },
    { id: 'central-park',      name: 'Central Park',           type: 'Convergence', image: '/assets/maps/marvel-rivals/central-park.png' },
    { id: 'heart-of-heaven',   name: 'Heart of Heaven',        type: 'Convergence', image: '' },
    { id: 'shin-shibuya',      name: 'Shin-Shibuya',           type: 'Convergence', image: '/assets/maps/marvel-rivals/shin-shibuya.png' }
  ],
  // Rocket League — arenas are cosmetic (no real competitive veto); included so the app can
  // show/select an arena on the board if a tournament chooses to. type is the GAME MODE played
  // on it: every arena ships as Standard (the competitive playlist name producers and casters
  // use; the game files call the same mode "Soccar") and the producer can switch any row to
  // Hoops/Dropshot/Snow Day/Rumble/Heatseeker (see MODE_OPTIONS) — RL mode is chosen per game,
  // not baked into the arena. Only arenas with real art in assets/rocket-league/maps are listed.
  'rocket-league': [
    { id: 'dfh-stadium', name: 'DFH Stadium', type: 'Standard', image: '/assets/rocket-league/maps/dfh-stadium.jpg' },
    { id: 'mannfield', name: 'Mannfield', type: 'Standard', image: '/assets/rocket-league/maps/mannfield.jpg' },
    { id: 'champions-field', name: 'Champions Field', type: 'Standard', image: '/assets/rocket-league/maps/champions-field.jpg' },
    { id: 'neo-tokyo', name: 'Neo Tokyo', type: 'Standard', image: '/assets/rocket-league/maps/neo-tokyo.jpg' },
    { id: 'beckwith-park', name: 'Beckwith Park', type: 'Standard', image: '/assets/rocket-league/maps/beckwith-park.jpg' },
    { id: 'urban-central', name: 'Urban Central', type: 'Standard', image: '/assets/rocket-league/maps/urban-central.jpg' },
    { id: 'utopia-coliseum', name: 'Utopia Coliseum', type: 'Standard', image: '/assets/rocket-league/maps/utopia-coliseum.jpg' },
    { id: 'salty-shores', name: 'Salty Shores', type: 'Standard', image: '/assets/rocket-league/maps/salty-shores.jpg' },
    { id: 'aquadome', name: 'AquaDome', type: 'Standard', image: '/assets/rocket-league/maps/aquadome.jpg' },
    { id: 'wasteland', name: 'Wasteland', type: 'Standard', image: '/assets/rocket-league/maps/wasteland.jpg' },
    { id: 'farmstead', name: 'Farmstead', type: 'Standard', image: '/assets/rocket-league/maps/farmstead.jpg' },
    { id: 'forbidden-temple', name: 'Forbidden Temple', type: 'Standard', image: '/assets/rocket-league/maps/forbidden-temple.jpg' },
    { id: 'neon-fields', name: 'Neon Fields', type: 'Standard', image: '/assets/rocket-league/maps/neon-fields.jpg' },
    { id: 'starbase-arc', name: 'Starbase ARC', type: 'Standard', image: '/assets/rocket-league/maps/starbase-arc.jpg' },
    { id: 'deadeye-canyon', name: 'Deadeye Canyon', type: 'Standard', image: '/assets/rocket-league/maps/deadeye-canyon.jpg' },
    { id: 'drift-woods', name: 'Drift Woods', type: 'Standard', image: '/assets/rocket-league/maps/drift-woods.jpg' },
    { id: 'estadio-vida', name: 'Estadio Vida', type: 'Standard', image: '/assets/rocket-league/maps/estadio-vida.jpg' },
    { id: 'futura-garden', name: 'Futura Garden', type: 'Standard', image: '/assets/rocket-league/maps/futura-garden.jpg' },
    { id: 'parc-de-paris', name: 'Parc de Paris', type: 'Standard', image: '/assets/rocket-league/maps/parc-de-paris.jpg' },
    { id: 'rivals-arena', name: 'Rivals Arena', type: 'Standard', image: '/assets/rocket-league/maps/rivals-arena.jpg' },
    { id: 'sovereign-heights', name: 'Sovereign Heights', type: 'Standard', image: '/assets/rocket-league/maps/sovereign-heights.jpg' },
    { id: 'boostfield-mall', name: 'Boostfield Mall', type: 'Standard', image: '/assets/rocket-league/maps/boostfield-mall.jpg' }
  ]
};

// Game modes selectable per map row (VETO_META.modes, broadcast to the control panel). A game
// absent here just gets no mode dropdown. Icons for these live at /assets/<game>/modes/ and are
// resolved by slug in the overlay + panel (mapscreen.html MODE_IMG).
const MODE_OPTIONS = {
  overwatch:       ['Control', 'Hybrid', 'Escort', 'Push', 'Flashpoint', 'Clash', 'Assault'],
  'marvel-rivals': ['Domination', 'Convoy', 'Convergence'],
  'rocket-league': ['Standard', 'Hoops', 'Dropshot', 'Snow Day', 'Rumble', 'Heatseeker', 'Spike Rush']
};

// Per-game terminology so the UI/board read correctly per selection type.
const VETO_META = {
  csgo:            { kind: 'map',   banWord: 'Ban',    unit: 'map' },
  valorant:        { kind: 'map',   banWord: 'Ban',    unit: 'map' },
  rainbow6:        { kind: 'map',   banWord: 'Ban',    unit: 'map' },
  overwatch:       { kind: 'map',   banWord: 'Ban',    unit: 'map', hasBans: true, modes: MODE_OPTIONS.overwatch },
  'marvel-rivals': { kind: 'map',   banWord: 'Ban',    unit: 'map', modes: MODE_OPTIONS['marvel-rivals'] },
  'rocket-league': { kind: 'arena', banWord: 'Ban',    unit: 'arena', modes: MODE_OPTIONS['rocket-league'] },
  // strikeFrom = the DEFAULT stage tier the guided veto strikes from; the producer can pick any
  // tier (or all stages) per event, and an event with no ban phase simply never starts a veto.
  smash:           { kind: 'stage', banWord: 'Strike', unit: 'stage', strikeFrom: 'Starter' }
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
// Smash Ultimate game-1 stage striking: alternating 1-2-2-…-1 until ONE stage remains.
// Built from the starter count rather than hardcoded, so a ruleset running 3, 7 or 9 starters
// still resolves to exactly one stage — a fixed 4-strike list silently left 5 stages standing
// the moment the pool grew past five.
function smashStrikeOrder(starters) {
  const n = Number(starters) || 0;
  // Nothing to strike: one stage (or none) is already the decider. Clamping up to 2 instead
  // generated a strike that would have removed the only stage in the pool.
  if (n < 2) return [];
  const seq = [];
  let team = 0;
  // first and last turns strike one; every turn in between strikes two
  seq.push(['ban', team]);
  let struck = 1;
  while (n - struck > 1) {
    team = team ? 0 : 1;
    const take = (n - struck > 2) ? 2 : 1;
    for (let i = 0; i < take; i++) seq.push(['ban', team]);
    struck += take;
  }
  return seq;
}

// OWCS map veto: FT3 → each team strikes 3, then alternately picks until 5 maps remain.
// FT2: ban 2 (1 each), pick 2 (1 each), 1 decider. FT3: ban 2, pick 2, ban 2, 1 decider (→5 total).
// Simplified to the standard alternate-ban generic fallback since OWCS is not fully standardized.
const OWCS_VETO = {
  2: [['ban',0],['ban',1],['pick',0],['pick',1]],                          // → 2 maps + 1 decider
  3: [['ban',0],['ban',1],['pick',0],['pick',1],['ban',0],['ban',1]],      // → 3 maps + 1 decider (but played as FT3 so stop at winner)
  5: [['ban',0],['ban',1],['pick',0],['pick',1],['pick',0],['pick',1]]     // → 5 maps
};
const VETO_FORMATS = { csgo: STD7, valorant: STD7, rainbow6: STD7, overwatch: OWCS_VETO };

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

// Merge each game's built-in map pool with its active Game Config's maps (state.gameConfigs,
// keyed by gameId), by id — new ids append after the built-ins, matching ids override that one
// entry. A game with a config but no built-in pool at all (e.g. dota2) is still included, so
// importing a config can enable veto for a game that previously had none.
function mergedMapPools(gameConfigs) {
  const cfgs = gameConfigs || {};
  const gameIds = new Set([...Object.keys(MAP_POOLS), ...Object.keys(cfgs)]);
  const out = {};
  gameIds.forEach((game) => {
    const built = mapPool(game);
    const custom = (cfgs[game] && Array.isArray(cfgs[game].maps)) ? cfgs[game].maps : [];
    if (!custom.length) { out[game] = built; return; }
    const byId = {};
    built.forEach((m) => { byId[m.id] = m; });
    custom.forEach((m) => { if (m && m.id) byId[m.id] = { ...byId[m.id], ...m }; });
    out[game] = Object.values(byId);
  });
  return out;
}

// Resolve the manual ban/pick steps for a game + best-of, sized to the pool.
// Falls back to a generic "alternate bans down to N maps" order for any game/size.
function buildSequence(game, bestOf, poolSize) {
  const bo = [1, 3, 5, 7].includes(Number(bestOf)) ? Number(bestOf) : 1;
  // Smash strikes down to one stage for game 1 regardless of how many starters the pool holds.
  if (game === 'smash') return smashStrikeOrder(poolSize).map(s => ({ action: s[0], teamIdx: s[1] }));
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

module.exports = { MAP_POOLS, MODE_OPTIONS, VETO_FORMATS, VETO_META, getMeta, mapPool, smashStrikeOrder, mergedMapPools, hasVeto, vetoGames, buildSequence, resolveSide };
