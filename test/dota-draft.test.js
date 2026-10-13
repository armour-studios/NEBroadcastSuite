// node test/dota-draft.test.js
// Dota 2 Game State Integration + the MOBA draft board (Dota 2 / Mobile Legends / Honor of Kings).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const draft = require('../backend/draft');
const gsi = require('../backend/dota-gsi');
const server = require('./lib/server-source').serverSource().replace(/\r\n/g, '\n');
const overlay = fs.readFileSync(path.join(root, 'overlay', 'draft.html'), 'utf8');
let pass = 0;
const ok = (cond, why) => { assert.ok(cond, why); pass++; };
const order = (g) => draft.buildDraft(g).map((s) => (s.teamIdx ? 'B' : 'A') + s.action[0]).join(' ');

// ── Draft orders ──
// Captains Mode since patch 7.34: bans 3-2-2 (first pick) / 4-1-2 (second), picks 1-3-1 each.
ok(order('dota2') === 'Ab Ab Bb Bb Ab Bb Bb Ap Bp Ab Ab Bb Bp Ap Ap Bp Bp Ap Ab Bb Ab Bb Ap Bp', 'Dota 2 Captains Mode order (7.34)');
const counts = (g, team, action) => draft.buildDraft(g).filter((s) => s.teamIdx === team && s.action === action).length;
ok(counts('dota2', 0, 'ban') === 7 && counts('dota2', 1, 'ban') === 7 && counts('dota2', 0, 'pick') === 5, 'Dota: 7 bans and 5 picks a side');
ok(draft.buildDraft('mobile-legends').length === 20 && counts('mobile-legends', 0, 'ban') === 5, 'Mobile Legends: 10 bans, 10 picks');
ok(draft.buildDraft('honor-of-kings').length === 18 && counts('honor-of-kings', 1, 'ban') === 4, 'Honor of Kings: 4 bans a side');

// ── Rosters ──
const ml = draft.roster('mobile-legends');
ok(ml.length >= 130, 'Mobile Legends roster loaded (' + ml.length + ')');
ok(ml.every((h) => h.role && /^\/assets\/heroes\/mobile-legends\/[a-z0-9-]+\.jpg$/.test(h.image)), 'every MLBB hero has a role and a .jpg portrait');
ok(ml.every((h) => fs.existsSync(path.join(root, h.image))), 'every MLBB portrait exists on disk');
ok(draft.imageFor('mobile-legends', 'Tigreal').endsWith('/tigreal.jpg') && draft.roleFor('mobile-legends', 'Tigreal') === 'Tank', 'name lookups resolve');
ok(draft.roster('dota2').every((h) => /\.png$/.test(h.image) && fs.existsSync(path.join(root, h.image))), 'roster links keep the real file extension');
ok(draft.roster('dota2').some((h) => h.name === "Nature's Prophet") && draft.roster('dota2').some((h) => h.name === 'Anti-Mage'), 'Dota display names');

// ── GSI: hero names, config, parse ──
const map = { antimage: 'anti-mage', npc_dota_hero_nevermore: 'shadow-fiend', npc_dota_hero_furion: 'natures-prophet', wisp: 'io', npc_dota_hero_sand_king: 'sand-king', centaur: 'centaur-warrunner', obsidian_destroyer: 'outworld-destroyer' };
Object.entries(map).forEach(([k, v]) => ok(gsi.heroId(k) === v, 'heroId ' + k + ' -> ' + v));
const ids = new Set(draft.roster('dota2').map((h) => h.id));
['antimage', 'nevermore', 'furion', 'zuus', 'wisp', 'windrunner', 'skeleton_king', 'life_stealer', 'magnataur', 'necrolyte', 'queenofpain',
  'rattletrap', 'shredder', 'treant', 'vengefulspirit', 'doom_bringer', 'abyssal_underlord', 'centaur', 'obsidian_destroyer']
  .forEach((n) => ok(ids.has(gsi.heroId(n)), 'internal name ' + n + ' has a portrait'));
const cfg = gsi.cfgText(3000, 'tok');
ok(/"uri"\s+"http:\/\/127\.0\.0\.1:3000\/api\/dota-gsi"/.test(cfg) && /"draft"\s+"1"/.test(cfg) && /"token" "tok"/.test(cfg), 'cfg posts to /api/dota-gsi with the draft provider and token');
ok(gsi.launchUrl() === 'steam://run/570//-gamestateintegration/', 'launch link adds -gamestateintegration');
const frame = {
  map: { matchid: '1', clock_time: 125, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', radiant_score: 4, dire_score: 2 },
  player: { team2: { player0: { name: 'A', kills: 3, deaths: 1, assists: 2, net_worth: 5000 } }, team3: { player5: { name: 'B', kills: 1, net_worth: 3000 } } },
  hero: { team2: { player0: { name: 'npc_dota_hero_zuus', level: 7, alive: true } }, team3: { player5: { name: 'npc_dota_hero_wisp', level: 5, alive: false } } },
  items: { team2: { player0: { slot0: { name: 'item_blink' }, slot1: { name: 'empty' } } }, team3: {} }
};
const p = gsi.parse(frame);
ok(p.spectating && p.map.state === 'live' && p.map.clock === 125 && p.map.radiantScore === 4, 'map parsed');
ok(p.players.radiant[0].hero === 'zeus' && p.players.dire[0].hero === 'io' && p.players.dire[0].alive === false, 'players parsed');
ok(p.teams.radiant.netWorth === 5000 && p.teams.dire.netWorth === 3000, 'team net worth summed');
ok(/items\/blink\.png$/.test(p.players.radiant[0].items[0]) && p.players.radiant[0].items[1] === '', 'item icons, empty slots blank');
// Draft: picks/bans per team are interleaved back into the Captains Mode order.
const seq = draft.buildDraft('dota2').map((s) => ({ action: s.action, by: s.teamIdx ? 'b' : 'a' }));
const dr = gsi.parse({ draft: { activeteam: 3, pick: false, activeteam_time_remaining: 9,
  team2: { ban0_class: 'pudge', ban0_id: 1, ban1_class: 'invoker', ban1_id: 2, ban2_class: 'tiny', ban2_id: 3, pick0_class: 'rubick', pick0_id: 4 },
  team3: { ban0_class: 'mars', ban0_id: 5, ban1_class: 'lion', ban1_id: 6, ban2_class: 'axe', ban2_id: 7, ban3_class: 'lina', ban3_id: 8, pick0_class: 'sniper', pick0_id: 9 } } }).draft;
ok(dr.activeTeam === 'dire' && dr.remaining === 9 && dr.radiant.bans.length === 3, 'draft block parsed');
const ops = gsi.draftOps(seq, dr, { a: 'radiant', b: 'dire' });
ok(ops.length === 9 && ops[0].hero === 'pudge' && ops[2].hero === 'mars' && ops[7].action === 'pick' && ops[7].hero === 'rubick' && ops[8].hero === 'sniper', 'draft steps interleaved in Captains Mode order');
ok(gsi.draftOps(seq, dr, { a: 'dire', b: 'radiant' })[0].hero === 'mars', 'Radiant on the orange side swaps the mapping');

// ── Server wiring ──
ok(/app\.post\('\/api\/dota-gsi'/.test(server) && /token !== DOTA_GSI_TOKEN/.test(server), 'GSI receiver checks its token');
ok(require('../backend/state-schema').broadcastTiers().dota === 'live', 'state.dota has a broadcast tier');
ok(/dota: \{ cfgPath: state\.dota\.cfgPath/.test(server) && /saved\.dota && typeof saved\.dota === 'object'/.test(server), 'Dota settings saved and restored (never the live frame)');
ok(/draftLook: draftLookPrefs\(state\.draft\)/.test(server) && /saved\.draftLook/.test(server), 'draft look prefs saved and restored');
ok(/function draftLookPrefs\(prev\) \{\n  const p = prev \|\| \{\};\n  const DRAFT_LAYOUTS/.test(server), 'layout list is local to the function (no TDZ at boot)');
ok(/state\.activeGame !== 'dota2'/.test(server), 'the in-game draft only fills the board while Dota 2 is the active game');
// First in-game layout must not be the full-screen camera scene.
['cod', 'eafc', 'rainbow6', 'mobile-legends', 'honor-of-kings', 'dota2'].forEach((g) => {
  const m = server.match(new RegExp("'" + g + "': \\[ \\{ id: '[^']+', name: '[^']+', path: '([^']+)'"));
  ok(m && !/duorow/.test(m[1]), g + ' opens on an in-game layout (' + (m && m[1]) + ')');
});

// ── Overlay ──
ok(/const STRIP_GAMES = \['dota2', 'mobile-legends', 'honor-of-kings'\]/.test(overlay), 'strip is the default for the MOBA drafts');
ok(/SceneBase\.liveUpdates\('dota'\)/.test(overlay) && /gsiDraft\.remaining/.test(overlay), 'board follows the live Dota clock');
ok(fs.existsSync(path.join(root, 'overlay', 'dota2-hud.html')) && fs.existsSync(path.join(root, 'overlay', 'scorebar.html')), 'Dota HUD and generic scorebar exist');

console.log(`dota-draft: all ${pass} checks passed`);
