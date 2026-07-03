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

// Hero shooters (OW / Marvel Rivals): alternating hero bans only, 2 per team.
const HERO_BANS_2 = [['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1]];

const DRAFT_FORMATS = {
  league:          LOL,
  dota2:           DOTA2,
  overwatch:       HERO_BANS_2,
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

const ROSTERS = {
  league:           LOL_ROSTER,
  dota2:            rosterFromDir('assets/heroes/dota2',          '/assets/heroes/dota2/'),
  overwatch:        rosterFromDir('assets/heroes/overwatch',      '/assets/heroes/overwatch/'),
  'marvel-rivals':  rosterFromDir('assets/heroes/marvel-rivals',  '/assets/heroes/marvel-rivals/'),
  valorant:         rosterFromDir('assets/heroes/valorant',       '/assets/heroes/valorant/'),
  'mobile-legends': [],   // no portrait folder yet — falls back to text-only
  'honor-of-kings': []
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
function champions(game) { return (ROSTERS[game] || []).map((c) => c.name); }
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
