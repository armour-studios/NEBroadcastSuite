/*
  game-match.js — free-text game name  →  our GAMES registry id.

  Every tournament platform hands us the game as a STRING and each one spells it differently:
    start.gg   videogame.name   "Super Smash Bros. Ultimate", "Rocket League"
    Challonge  tournament.game_name  "Brawlhalla", "Counter-Strike 2", "SSBU"
    FACEIT     game              "cs2", "valorant"
    NXGEN      game              "Rocket League"

  Without this, loading a Challonge bracket for ANY game left the app on whatever game was
  already active — so a Brawlhalla bracket went on air wearing Rocket League's overlay, labels
  and roster size. Resolving the id is what makes a platform multi-game rather than "multi-game
  as long as you remember to change the dropdown first".

  ORDER MATTERS. The patterns run top-to-bottom and the first hit wins, so anything whose name
  CONTAINS another game's name has to be listed above it:
    "Rocket League" / "Mobile Legends" / "Apex Legends"  must beat  "League of Legends"
    "Legends of Runeterra" is not a game we support, so it must not fall through to `league`.
*/

'use strict';

// [pattern, GAMES id]. Patterns are matched against the lowercased, punctuation-squashed name.
const GAME_PATTERNS = [
  // ── names that contain another game's name (must come first) ──────────────
  [/\brocket\s*league\b|\brl\b|\brlcs\b/, 'rocket-league'],
  [/\bmobile\s*legends\b|\bmlbb\b/, 'mobile-legends'],
  [/\bapex\s*legends\b|\balgs\b/, 'apex'],
  [/\blegends?\s*of\s*runeterra\b|\blor\b/, null],          // known, but not a game we run
  [/\bteamfight\s*tactics\b|\btft\b/, null],

  // ── fighters / platform fighters ──────────────────────────────────────────
  [/\bbrawlhalla\b/, 'brawlhalla'],
  [/\bsuper\s*smash\b|\bsmash\s*bros\b|\bssbu?\b|\bssbm\b|\bmelee\b|\bultimate\s*singles\b|\bssb64\b/, 'smash'],
  [/\bmarvel\s*tokon\b|\btokon\b|\bfighting\s*souls\b/, 'marvel-tokon'],
  [/\btekken\b/, 'tekken8'],
  [/\bstreet\s*fighter\b|\bsf6\b|\bsfv\b/, 'sf6'],
  [/\bguilty\s*gear\b|\bggst\b|\bstrive\b/, 'ggstrive'],
  [/\b2xko\b|\bproject\s*l\b/, '2xko'],

  // ── shooters / MOBAs / the rest ───────────────────────────────────────────
  [/\bcounter\s*strike\b|\bcounterstrike\b|\bcs\s*:?\s*go\b|\bcsgo\b|\bcs2\b|\bcs\b/, 'csgo'],
  [/\bvalorant\b|\bvct\b/, 'valorant'],
  [/\bmarvel\s*rivals\b/, 'marvel-rivals'],
  [/\boverwatch\b|\bow2?\b|\bowcs\b/, 'overwatch'],
  [/\brainbow\s*six\b|\br6s?\b|\bsiege\b/, 'rainbow6'],
  [/\bcall\s*of\s*duty\b|\bcod\b|\bwarzone\b|\bblack\s*ops\b|\bmw\d?\b/, 'cod'],
  [/\bfortnite\b|\bfncs\b/, 'fortnite'],
  [/\bthe\s*finals\b/, 'the-finals'],
  [/\bdota\b/, 'dota2'],
  [/\bhonou?r\s*of\s*kings\b|\bhok\b/, 'honor-of-kings'],
  [/\bleague\s*of\s*legends\b|\blol\b|\blck\b|\blec\b|\blcs\b/, 'league'],
  [/\bea\s*(sports\s*)?fc\b|\bfifa\b|\beafc\b/, 'eafc'],
  [/\bminecraft\b|\bbed\s*wars\b|\bbedwars\b/, 'bedwars']
];

// Squash the spelling differences the patterns shouldn't have to care about: case, punctuation
// ("Counter-Strike: Global Offensive"), and runs of whitespace.
function normalizeGameName(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[._:/\\|,'"()\[\]+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
  Resolve a platform's game string to a GAMES id, or '' when we can't tell.

  Returns '' rather than guessing: a wrong id is worse than no id, because it silently swaps the
  overlay, the team labels and the roster size out from under the producer. `knownIds` (optional)
  is the live GAMES key list — passing it means a pattern can never return an id this build
  doesn't actually have, so removing a game from the registry can't strand a mapping here.
*/
function resolveGameId(name, knownIds) {
  const n = normalizeGameName(name);
  if (!n) return '';
  const known = knownIds && knownIds.length ? new Set(knownIds) : null;
  // An exact id ("rocket-league") or a bare registry key comes through untouched.
  if (known) {
    const direct = String(name).trim().toLowerCase();
    if (known.has(direct)) return direct;
  }
  for (let i = 0; i < GAME_PATTERNS.length; i++) {
    const [re, id] = GAME_PATTERNS[i];
    if (!re.test(n)) continue;
    if (!id) return '';                       // matched a game we deliberately don't support
    if (known && !known.has(id)) return '';
    return id;
  }
  return '';
}

module.exports = { resolveGameId, normalizeGameName, GAME_PATTERNS };
