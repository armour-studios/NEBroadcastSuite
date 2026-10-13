// backend/dota-gsi.js — Dota 2 Game State Integration (GSI).
//
// Valve's own feed, no key or approval: Dota 2 POSTs JSON to a URL listed in a
// gamestate_integration_*.cfg file. While the PC is SPECTATING or OBSERVING a match the payload
// carries all ten players (heroes, K/D/A, net worth, items) plus the live Captains Mode draft;
// while playing it only describes the local player. Since a 2023 update the game also needs the
// -gamestateintegration launch option.
//
// This module is pure (no app state): the config text, finding the cfg folder through Steam, the
// launch link, hero/item name mapping, and parse() which turns a raw payload into the small,
// stable shape the HUD and the draft board read. server.js owns receiving, state and broadcasts.
'use strict';
const fs = require('fs');
const path = require('path');

const DOTA_DIR = path.join('steamapps', 'common', 'dota 2 beta');
const GSI_SUB = path.join('game', 'dota', 'cfg', 'gamestate_integration');
const CFG_FILE = 'gamestate_integration_ne_broadcast_suite.cfg';
const APP_ID = 570;

function cfgText(port, token) {
  return `"NE Broadcast Suite Dota 2"
{
  "uri"       "http://127.0.0.1:${port}/api/dota-gsi"
  "timeout"   "5.0"
  "buffer"    "0.1"
  "throttle"  "0.25"
  "heartbeat" "10.0"
  "auth"
  {
    "token" "${token}"
  }
  "data"
  {
    "provider"   "1"
    "map"        "1"
    "player"     "1"
    "hero"       "1"
    "abilities"  "0"
    "items"      "1"
    "draft"      "1"
    "buildings"  "0"
    "wearables"  "0"
    "league"     "1"
  }
}
`;
}

// Where Dota 2 lives: every Steam library (cs2-setup reads Steam's own registry key and
// libraryfolders.vdf), then the first one holding "dota 2 beta". The gamestate_integration folder
// does not exist on a fresh install, so the cfg folder is what we look for.
async function findGsiDir(steamRoots, parseLibraryFolders) {
  const roots = await steamRoots();
  const libs = [];
  for (const r of roots) {
    libs.push(r);
    try { parseLibraryFolders(fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8')).forEach((l) => libs.push(l)); } catch (_) { /* no vdf */ }
  }
  for (const lib of [...new Set(libs.map((l) => path.normalize(l)))]) {
    const cfg = path.join(lib, DOTA_DIR, 'game', 'dota', 'cfg');
    try { if (fs.existsSync(cfg)) return path.join(lib, DOTA_DIR, GSI_SUB); } catch (_) {}
  }
  return '';
}

// Accept the gamestate_integration folder, the cfg folder, the Dota install or a Steam library.
function resolveGsiDir(input) {
  const dir = String(input || '').trim().replace(/^"|"$/g, '');
  if (!dir) return '';
  if (/[\\/]gamestate_integration[\\/]?$/i.test(dir)) return dir;
  const tries = [path.join(dir, 'gamestate_integration'), path.join(dir, 'game', 'dota', 'cfg', 'gamestate_integration'), path.join(dir, DOTA_DIR, GSI_SUB)];
  for (const t of tries) {
    try { if (fs.existsSync(path.dirname(t))) return t; } catch (_) {}
  }
  return '';
}

function install(dir, port, token) {
  if (!dir) throw new Error('Dota 2 was not found. Enter your Dota 2 folder (…\\steamapps\\common\\dota 2 beta).');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CFG_FILE);
  fs.writeFileSync(file, cfgText(port, token));
  return file;
}

// Starts Dota through Steam with the launch option GSI needs. Steam asks once to confirm.
function launchUrl() {
  return 'steam://run/' + APP_ID + '//' + encodeURIComponent('-gamestateintegration') + '/';
}

// npc_dota_hero_<internal> → our portrait id (assets/heroes/dota2/<id>.png). Most internal names are
// the hero name with underscores; these are the ones Valve never renamed.
const HERO_INTERNAL = {
  antimage: 'anti-mage', obsidian_destroyer: 'outworld-destroyer', nevermore: 'shadow-fiend', zuus: 'zeus',
  wisp: 'io', windrunner: 'windranger', skeleton_king: 'wraith-king', furion: 'natures-prophet',
  life_stealer: 'lifestealer', magnataur: 'magnus', necrolyte: 'necrophos', queenofpain: 'queen-of-pain',
  rattletrap: 'clockwerk', shredder: 'timbersaw', treant: 'treant-protector', vengefulspirit: 'vengeful-spirit',
  doom_bringer: 'doom', abyssal_underlord: 'underlord', centaur: 'centaur-warrunner'
};
function heroId(cls) {
  const raw = String(cls || '').toLowerCase().replace(/^npc_dota_hero_/, '').trim();
  if (!raw) return '';
  return HERO_INTERNAL[raw] || raw.replace(/_/g, '-');
}

// item_<name> → Valve's CDN icon. Empty slots are "empty".
function itemIcon(name) {
  const n = String(name || '').replace(/^item_/, '');
  if (!n || n === 'empty') return '';
  return 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/' + encodeURIComponent(n) + '.png';
}

const STATES = {
  DOTA_GAMERULES_STATE_INIT: 'init', DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD: 'loading',
  DOTA_GAMERULES_STATE_HERO_SELECTION: 'draft', DOTA_GAMERULES_STATE_STRATEGY_TIME: 'strategy',
  DOTA_GAMERULES_STATE_TEAM_SHOWCASE: 'showcase', DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD: 'loading',
  DOTA_GAMERULES_STATE_PRE_GAME: 'pregame', DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: 'live',
  DOTA_GAMERULES_STATE_POST_GAME: 'post', DOTA_GAMERULES_STATE_DISCONNECT: 'post'
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// One side's draft from the GSI draft block: picks and bans in the order they were made.
// Keys look like pick0_id / pick0_class / ban0_id / ban0_class; an id of 0 is an empty slot.
function draftSide(t) {
  const out = { picks: [], bans: [] };
  if (!t || typeof t !== 'object') return out;
  for (const kind of ['pick', 'ban']) {
    for (let i = 0; i < 10; i++) {
      const id = num(t[kind + i + '_id']);
      const cls = t[kind + i + '_class'];
      if (!id && !cls) continue;
      const hid = heroId(cls);
      if (hid) out[kind + 's'].push(hid);
    }
  }
  return out;
}

// Raw GSI payload → { spectating, map, teams: { radiant, dire }, players: { radiant[5], dire[5] }, draft }.
function parse(body) {
  const b = body && typeof body === 'object' ? body : {};
  const map = b.map || {};
  const out = {
    at: Date.now(),
    spectating: !!(b.player && (b.player.team2 || b.player.team3)),
    map: {
      matchId: String(map.matchid || ''),
      state: STATES[map.game_state] || (map.game_state ? 'other' : ''),
      clock: num(map.clock_time),
      gameTime: num(map.game_time),
      daytime: map.daytime !== false,
      paused: !!map.paused,
      radiantScore: num(map.radiant_score),
      direScore: num(map.dire_score),
      winner: map.win_team === 'radiant' || map.win_team === 'dire' ? map.win_team : ''
    },
    players: { radiant: [], dire: [] },
    teams: { radiant: { netWorth: 0, kills: 0 }, dire: { netWorth: 0, kills: 0 } },
    draft: null
  };
  const side = (team) => (team === 'team2' ? 'radiant' : 'dire');
  for (const team of ['team2', 'team3']) {
    const ps = (b.player && b.player[team]) || {};
    const hs = (b.hero && b.hero[team]) || {};
    const is = (b.items && b.items[team]) || {};
    Object.keys(ps).filter((k) => /^player\d+$/.test(k)).sort((x, y) => num(x.slice(6)) - num(y.slice(6))).forEach((k) => {
      const p = ps[k] || {}, h = hs[k] || {}, it = is[k] || {};
      const items = [];
      for (let i = 0; i < 6; i++) items.push(itemIcon(it['slot' + i] && it['slot' + i].name));
      const pl = {
        slot: num(k.slice(6)), name: String(p.name || ''), steamId: String(p.steamid || ''),
        hero: heroId(h.name), level: num(h.level), alive: h.alive !== false, respawn: num(h.respawn_seconds),
        hp: num(h.health_percent), mp: num(h.mana_percent),
        kills: num(p.kills), deaths: num(p.deaths), assists: num(p.assists),
        lastHits: num(p.last_hits), denies: num(p.denies),
        gold: num(p.gold), netWorth: num(p.net_worth), gpm: num(p.gpm), xpm: num(p.xpm),
        items, neutral: itemIcon(it.neutral0 && it.neutral0.name)
      };
      out.players[side(team)].push(pl);
      out.teams[side(team)].netWorth += pl.netWorth;
      out.teams[side(team)].kills += pl.kills;
    });
  }
  const d = b.draft;
  if (d && typeof d === 'object' && (d.team2 || d.team3)) {
    out.draft = {
      activeTeam: num(d.activeteam) === 2 ? 'radiant' : num(d.activeteam) === 3 ? 'dire' : '',
      picking: !!d.pick,
      remaining: num(d.activeteam_time_remaining),
      bonus: { radiant: num(d.radiant_bonus_time), dire: num(d.dire_bonus_time) },
      radiant: draftSide(d.team2),
      dire: draftSide(d.team3)
    };
  }
  return out;
}

// The interleaved Captains Mode order, filled from each side's picks/bans in the order made.
// sequence: [{ action, by }] (by = 'a'|'b'); sideOf: { a: 'radiant'|'dire', b: … }.
// Returns [{ action, by, hero }] for every step that has happened.
function draftOps(sequence, draft, sideOf) {
  const used = { a: { ban: 0, pick: 0 }, b: { ban: 0, pick: 0 } };
  const ops = [];
  for (const step of sequence || []) {
    const team = draft[sideOf[step.by]] || { picks: [], bans: [] };
    const list = step.action === 'ban' ? team.bans : team.picks;
    const hero = list[used[step.by][step.action]];
    if (!hero) break;   // the draft has not reached this step yet
    used[step.by][step.action]++;
    ops.push({ action: step.action, by: step.by, hero });
  }
  return ops;
}

module.exports = { cfgText, findGsiDir, resolveGsiDir, install, launchUrl, heroId, itemIcon, parse, draftOps, CFG_FILE, DOTA_DIR, GSI_SUB };
