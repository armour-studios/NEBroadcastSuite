// backend/draft.js — champion/hero DRAFT data + sequence engine (multi-game pick/ban).
// Sibling of backend/veto.js: same step model, but the "pool" is a champion/hero roster
// (with portraits) and the order is a draft order. Pure helpers; server.js owns the live
// state + broadcast. Works for MOBAs (full pick/ban) and hero shooters (ban-only).

const fs = require('fs');
const path = require('path');

// ── Draft orders. Each step is [action, teamIdx]; teamIdx 0 = the side that acts first
//    (resolved to blue/red via teamStart). ──────────────────────────────────────────────
// LoL standard tournament draft: 6 bans, 6 picks, 4 bans, 4 picks (5 bans + 5 picks/team).
const LOL = [
  ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1],   // ban phase 1
  ['pick', 0], ['pick', 1], ['pick', 1], ['pick', 0], ['pick', 0], ['pick', 1], // pick phase 1 (B R R B B R)
  ['ban', 1], ['ban', 0], ['ban', 1], ['ban', 0],                            // ban phase 2 (R B R B)
  ['pick', 1], ['pick', 0], ['pick', 0], ['pick', 1]                         // pick phase 2 (R B B R)
];
// Hero shooters: alternating hero bans, 2 per team (picks happen live in-game).
const HERO_BANS_2 = [['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1]];

const DRAFT_FORMATS = {
  league: LOL,
  overwatch: HERO_BANS_2,
  'marvel-rivals': HERO_BANS_2
  // dota2 / mobile-legends / honor-of-kings: add their orders here later (engine is order-driven).
};

// ── Rosters: [{ id, name, image }] per game ─────────────────────────────────────────────
// LoL ships a generated JSON (id/name/image) + downloaded splash art. Hero-shooter rosters
// are auto-discovered from their portrait folders so adding a PNG adds the hero.
function titleCase(id) {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
// Display names titleCase() can't infer from the file id.
const NAME_OVERRIDES = {
  dva: 'D.Va', lucio: 'Lúcio', torbjorn: 'Torbjörn', 'soldier-76': 'Soldier: 76',
  'cloak-dagger': 'Cloak & Dagger', 'spider-man': 'Spider-Man', 'star-lord': 'Star-Lord',
  'jeff-the-land-shark': 'Jeff the Land Shark'
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

let LOL_ROSTER = [];
try { LOL_ROSTER = require('../assets/lol/champions.json'); } catch (e) { LOL_ROSTER = []; }

const ROSTERS = {
  league: LOL_ROSTER,
  overwatch: rosterFromDir('assets/overwatch/heroes', '/assets/overwatch/heroes/'),
  'marvel-rivals': rosterFromDir('assets/heroes/marvel-rivals', '/assets/heroes/marvel-rivals/')
};

// name (case-insensitive) → image, per game, for stamping picks/bans with a portrait.
const _imgIndex = {};
for (const g of Object.keys(ROSTERS)) {
  _imgIndex[g] = {};
  for (const c of ROSTERS[g]) _imgIndex[g][c.name.toLowerCase()] = c.image;
}

function draftGames() { return Object.keys(DRAFT_FORMATS); }
function hasDraft(game) { return !!DRAFT_FORMATS[game]; }
function roster(game) { return ROSTERS[game] || []; }
function champions(game) { return (ROSTERS[game] || []).map((c) => c.name); }   // back-compat: names only
function imageFor(game, name) { return (_imgIndex[game] || {})[(name || '').toString().toLowerCase()] || ''; }

function buildDraft(game) {
  return (DRAFT_FORMATS[game] || []).map((s) => ({ action: s[0], teamIdx: s[1] }));
}
function resolveSide(teamIdx, teamStart) {
  const other = teamStart === 'a' ? 'b' : 'a';
  return teamIdx === 0 ? (teamStart || 'a') : other;
}

module.exports = {
  DRAFT_FORMATS, ROSTERS,
  draftGames, hasDraft, roster, champions, imageFor, buildDraft, resolveSide
};
