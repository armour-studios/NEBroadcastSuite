// backend/draft.js — champion/hero DRAFT data + sequence engine (multi-game pick/ban).
// Sibling of backend/veto.js: same step model, but the "pool" is a champion/hero roster
// (with portraits) and the order is a draft order. Pure helpers; server.js owns the live
// state + broadcast. Works for MOBAs (full pick/ban) and hero shooters (ban-only).

const fs = require('fs');
const path = require('path');

// ── Draft orders. Each step is [action, teamIdx]; teamIdx 0 = the side that acts first
//    (resolved to blue/red via teamStart). ──────────────────────────────────────────────

// LoL standard tournament draft: 5 bans + 5 picks per team, 2 ban phases.
// Phase 1 bans (6): A B A B A B
// Phase 1 picks (6): A BB AA B  (ABBAAB)
// Phase 2 bans (4): B A B A
// Phase 2 picks (4): B AA B
const LOL = [
  ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1],
  ['pick', 0], ['pick', 1], ['pick', 1], ['pick', 0], ['pick', 0], ['pick', 1],
  ['ban', 1], ['ban', 0], ['ban', 1], ['ban', 0],
  ['pick', 1], ['pick', 0], ['pick', 0], ['pick', 1]
];

// Dota 2 Captain's Mode: 3 ban phases + 3 pick phases.
// Ban-1: A B A B A B (3 each)
// Pick-1: A B B A (2 each)
// Ban-2: A B A B (2 each)
// Pick-2: A B A B (2 each)
// Ban-3: A B (1 each)
// Pick-3: B A (1 each, reverse to balance)
const DOTA2 = [
  ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1],
  ['pick', 0], ['pick', 1], ['pick', 1], ['pick', 0],
  ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1],
  ['pick', 0], ['pick', 1], ['pick', 0], ['pick', 1],
  ['ban', 0], ['ban', 1],
  ['pick', 1], ['pick', 0]
];

// Mobile Legends / Honor of Kings: same LoL-style tournament draft (5+5).
const ML_DRAFT = LOL;

// Valorant: 6 bans alternating (3 each), then 10 picks alternating (5 each).
const VALORANT = [
  ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1],
  ['pick', 0], ['pick', 1], ['pick', 0], ['pick', 1], ['pick', 0],
  ['pick', 1], ['pick', 0], ['pick', 1], ['pick', 0], ['pick', 1]
];

// Marvel Rivals: alternating hero bans only, 2 per team.
const HERO_BANS_2 = [['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1]];

// Overwatch 2: 4 hero bans in SNAKE order (not straight alternating) — Team A bans,
// Team B bans, Team B bans again, Team A bans again. Mirrors the in-client weighted-vote
// ban resolution (each player ranks 3 heroes worth 7/5/3 votes; the 4 highest-voted
// picks lock in this A-B-B-A order, skipping any hero that would break the 2-per-role
// ban cap). We don't simulate the vote itself here — the producer enters the resolved
// ban — but we do enforce the role cap in draftAction() via roleLimitOk() below.
// Picking is simultaneous with no fixed order, so the format only carries bans.
const OW_HERO_BANS = [['ban', 0], ['ban', 1], ['ban', 1], ['ban', 0]];

const DRAFT_FORMATS = {
  league:          LOL,
  dota2:           DOTA2,
  overwatch:       OW_HERO_BANS,
  'marvel-rivals': HERO_BANS_2,
  valorant:        VALORANT,
  'mobile-legends': ML_DRAFT,
  'honor-of-kings': ML_DRAFT
};

// ── Rosters: [{ id, name, image }] per game ─────────────────────────────────────────────
// Portrait images are served via Express /assets/... routes. The control panel prefixes
// "http://localhost:3000" at render time so they resolve correctly from the file:// origin.
function titleCase(id) {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Display names that titleCase() can't infer from the file id.
const NAME_OVERRIDES = {
  // Overwatch
  dva: 'D.Va', lucio: 'Lúcio', torbjorn: 'Torbjörn', 'soldier-76': 'Soldier: 76',
  // Marvel Rivals
  'cloak-dagger': 'Cloak & Dagger', 'spider-man': 'Spider-Man', 'star-lord': 'Star-Lord',
  'jeff-the-land-shark': 'Jeff the Land Shark',
  // Valorant
  'kay-o': 'KAY/O'
};

function idsFromDir(rel) {
  try {
    return fs.readdirSync(path.join(__dirname, '..', rel))
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => f.replace(/\.[^.]+$/, ''));
  } catch (e) { return []; }
}

function rosterFromDir(rel, urlBase) {
  return idsFromDir(rel)
    .map((id) => ({ id, name: NAME_OVERRIDES[id] || titleCase(id), image: urlBase + id + '.png' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// LoL: use the portrait images from assets/heroes/league/ (better crop than splash art).
// champions.json has the canonical name list; we map each to its portrait by lowercasing the id.
let LOL_ROSTER = [];
try {
  const raw = require('../assets/lol/champions.json');
  LOL_ROSTER = raw.map((c) => ({
    id: c.id,
    name: c.name,
    image: '/assets/heroes/league/' + c.id.toLowerCase() + '.png'
  }));
} catch (e) { LOL_ROSTER = []; }

// Overwatch role by portrait id — drives the front-panel role filter chips and the
// 2-per-role ban cap enforced in roleLimitOk() below.
const OW_ROLES = {
  dva: 'Tank', dmon: 'Tank', domina: 'Tank', doomfist: 'Tank', hazard: 'Tank', 'junker-queen': 'Tank', mauga: 'Tank',
  orisa: 'Tank', ramattra: 'Tank', reinhardt: 'Tank', roadhog: 'Tank', sigma: 'Tank',
  winston: 'Tank', 'wrecking-ball': 'Tank', zarya: 'Tank',
  anran: 'Damage', ashe: 'Damage', emre: 'Damage', shion: 'Damage', sierra: 'Damage', vendetta: 'Damage', bastion: 'Damage', cassidy: 'Damage', echo: 'Damage', freja: 'Damage',
  genji: 'Damage', hanzo: 'Damage', junkrat: 'Damage', mei: 'Damage', pharah: 'Damage',
  reaper: 'Damage', sojourn: 'Damage', 'soldier-76': 'Damage', sombra: 'Damage',
  symmetra: 'Damage', torbjorn: 'Damage', tracer: 'Damage', venture: 'Damage', widowmaker: 'Damage',
  ana: 'Support', 'jetpack-cat': 'Support', mizuki: 'Support', wuyang: 'Support', baptiste: 'Support', brigitte: 'Support', illari: 'Support', juno: 'Support',
  kiriko: 'Support', lifeweaver: 'Support', lucio: 'Support', mercy: 'Support', moira: 'Support',
  zenyatta: 'Support'
};

function rosterFromDirWithRoles(rel, urlBase, roleMap) {
  return idsFromDir(rel)
    .map((id) => ({ id, name: NAME_OVERRIDES[id] || titleCase(id), image: urlBase + id + '.png', role: (roleMap && roleMap[id]) || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const ROSTERS = {
  league:           LOL_ROSTER,
  dota2:            rosterFromDir('assets/heroes/dota2',          '/assets/heroes/dota2/'),
  // Canonical OW hero portraits (assets/overwatch/heroes) — the same folder the Overwatch overlay +
  // hero-ban manager use, kept current by scripts/download-ow-heroes.js. Not assets/heroes/overwatch:
  // that folder has mangled file names (l-cio/torbj-rn) that break the id → name/role lookups.
  overwatch:        rosterFromDirWithRoles('assets/overwatch/heroes', '/assets/overwatch/heroes/', OW_ROLES),
  'marvel-rivals':  rosterFromDir('assets/heroes/marvel-rivals',  '/assets/heroes/marvel-rivals/'),
  valorant:         rosterFromDir('assets/heroes/valorant',       '/assets/heroes/valorant/'),
  'mobile-legends': [],   // no portrait folder yet — falls back to text-only
  'honor-of-kings': []
};

// name (case-insensitive) → image, per game, for stamping picks/bans with a portrait.
const _imgIndex = {};
// name (case-insensitive) → role, per game (only populated where ROSTERS carries a role).
const _roleIndex = {};
for (const g of Object.keys(ROSTERS)) {
  _imgIndex[g] = {}; _roleIndex[g] = {};
  for (const c of ROSTERS[g]) {
    _imgIndex[g][c.name.toLowerCase()] = c.image;
    if (c.role) _roleIndex[g][c.name.toLowerCase()] = c.role;
  }
}

function draftGames() { return Object.keys(DRAFT_FORMATS); }
function hasDraft(game) { return !!DRAFT_FORMATS[game]; }
function roster(game) { return ROSTERS[game] || []; }
function champions(game) { return (ROSTERS[game] || []).map((c) => c.name); }

// Merge each game's built-in roster with its active Game Config's characters (state.gameConfigs,
// keyed by gameId), by id — new ids append after the built-ins, matching ids override that one
// entry. Mirrors backend/veto.js's mergedMapPools.
function mergedRosters(gameConfigs) {
  const cfgs = gameConfigs || {};
  const gameIds = new Set([...Object.keys(ROSTERS), ...Object.keys(cfgs)]);
  const out = {};
  gameIds.forEach((game) => {
    const built = ROSTERS[game] || [];
    const custom = (cfgs[game] && Array.isArray(cfgs[game].characters)) ? cfgs[game].characters : [];
    if (!custom.length) { out[game] = built; return; }
    const byId = {};
    built.forEach((c) => { byId[c.id] = c; });
    custom.forEach((c) => { if (c && c.id) byId[c.id] = byId[c.id] ? { ...byId[c.id], ...c } : { ...c, custom: true }; });
    out[game] = Object.values(byId);
  });
  return out;
}
// name (case-insensitive) → {image, role} for a game's active Game Config characters, if any.
function _customLookup(game, gameConfigs) {
  const chars = (gameConfigs && gameConfigs[game] && Array.isArray(gameConfigs[game].characters)) ? gameConfigs[game].characters : [];
  const img = {}, role = {};
  chars.forEach((c) => {
    if (!c || !c.name) return;
    const key = c.name.toLowerCase();
    if (c.image) img[key] = c.image;
    if (c.role) role[key] = c.role;
  });
  return { img, role };
}
// gameConfigs param is optional — pass state.gameConfigs to also resolve custom Game Config
// characters (checked first so a config can override a built-in hero's image/role too).
function imageFor(game, name, gameConfigs) {
  const key = (name || '').toString().toLowerCase();
  if (gameConfigs) { const { img } = _customLookup(game, gameConfigs); if (img[key]) return img[key]; }
  return (_imgIndex[game] || {})[key] || '';
}
function roleFor(game, name, gameConfigs) {
  const key = (name || '').toString().toLowerCase();
  if (gameConfigs) { const { role } = _customLookup(game, gameConfigs); if (role[key]) return role[key]; }
  return (_roleIndex[game] || {})[key] || '';
}

// Overwatch ban rule: no more than 2 bans of the same role among the bans resolved so far.
// Non-Overwatch games (and unrecognized heroes) are always allowed.
function roleLimitOk(game, ops, name, gameConfigs) {
  if (game !== 'overwatch') return true;
  const role = roleFor(game, name, gameConfigs);
  if (!role) return true;
  const count = (ops || []).filter((o) => o.action === 'ban' && roleFor(game, o.name, gameConfigs) === role).length;
  return count < 2;
}

function buildDraft(game) {
  return (DRAFT_FORMATS[game] || []).map((s) => ({ action: s[0], teamIdx: s[1] }));
}
function resolveSide(teamIdx, teamStart) {
  const other = teamStart === 'a' ? 'b' : 'a';
  return teamIdx === 0 ? (teamStart || 'a') : other;
}

module.exports = {
  DRAFT_FORMATS, ROSTERS,
  draftGames, hasDraft, roster, champions, mergedRosters, imageFor, roleFor, roleLimitOk, buildDraft, resolveSide
};
