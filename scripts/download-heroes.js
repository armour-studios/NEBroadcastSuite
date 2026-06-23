#!/usr/bin/env node
/*
 * Builds the per-game hero/agent/operator lists and downloads portrait images so the roster
 * hero picker can autocomplete with pictures. Run once (needs internet):
 *
 *     node scripts/download-heroes.js
 *
 * Output:
 *   assets/heroes/<game>/<slug>.png   — portrait images (Valorant, Overwatch, LoL, Dota 2)
 *   control-panel/heroes-data.js      — generated HEROES_BY_GAME = { game: [{ n, img? }] }
 *
 * Games with clean image APIs get pictures; the rest get name-only lists (still autocompletes).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const HERO_DIR = path.join(__dirname, '..', 'assets', 'heroes');
const DATA_OUT = path.join(__dirname, '..', 'control-panel', 'heroes-data.js');

function get(url, asBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ne-broadcast-suite' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(get(res.headers.location, asBuffer));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(asBuffer ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
const getJSON = async (u) => JSON.parse(await get(u, false));
const slug = (s) => String(s).toLowerCase().replace(/[''.:]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function saveImg(game, name, url) {
  const s = slug(name);
  if (!url) return s;
  const dir = path.join(HERO_DIR, game);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, s + '.png');
  try { fs.writeFileSync(dest, await get(url, true)); } catch (e) { /* keep name, no image */ }
  return s;
}

async function valorant() {
  const j = await getJSON('https://valorant-api.com/v1/agents?isPlayableCharacter=true');
  const out = [];
  for (const a of j.data) out.push({ n: a.displayName, img: await saveImg('valorant', a.displayName, a.displayIcon) });
  return out.sort((a, b) => a.n.localeCompare(b.n));
}
async function overwatch() {
  const j = await getJSON('https://overfast-api.tekrop.fr/heroes');
  const out = [];
  for (const h of j) out.push({ n: h.name, img: await saveImg('overwatch', h.name, h.portrait) });
  return out.sort((a, b) => a.n.localeCompare(b.n));
}
async function league() {
  const vers = await getJSON('https://ddragon.leagueoflegends.com/api/versions.json');
  const v = vers[0];
  const j = await getJSON(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`);
  const out = [];
  for (const key of Object.keys(j.data)) {
    const c = j.data[key];
    const url = `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${c.image.full}`;
    out.push({ n: c.name, img: await saveImg('league', c.id, url) });
  }
  return out.sort((a, b) => a.n.localeCompare(b.n));
}
async function dota2() {
  const j = await getJSON('https://api.opendota.com/api/heroes');
  const out = [];
  for (const h of j) {
    const short = h.name.replace('npc_dota_hero_', '');
    const url = `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${short}.png`;
    out.push({ n: h.localized_name, img: await saveImg('dota2', h.localized_name, url) });
  }
  return out.sort((a, b) => a.n.localeCompare(b.n));
}

// Name-only lists for games without a clean free image API (still autocompletes).
const STATIC = {
  rainbow6: ['Sledge', 'Thatcher', 'Ash', 'Thermite', 'Twitch', 'Montagne', 'Glaz', 'Fuze', 'Blitz', 'IQ', 'Buck', 'Blackbeard', 'Capitão', 'Hibana', 'Jackal', 'Ying', 'Zofia', 'Dokkaebi', 'Lion', 'Finka', 'Maverick', 'Nomad', 'Gridlock', 'Nøkk', 'Amaru', 'Kali', 'Iana', 'Ace', 'Zero', 'Flores', 'Osa', 'Sens', 'Grim', 'Brava', 'Ram', 'Deimos', 'Smoke', 'Mute', 'Castle', 'Pulse', 'Doc', 'Rook', 'Kapkan', 'Tachanka', 'Jäger', 'Bandit', 'Frost', 'Valkyrie', 'Caveira', 'Echo', 'Mira', 'Lesion', 'Ela', 'Vigil', 'Maestro', 'Alibi', 'Clash', 'Kaid', 'Mozzie', 'Warden', 'Goyo', 'Wamai', 'Oryx', 'Melusi', 'Aruni', 'Thunderbird', 'Thorn', 'Azami', 'Solis', 'Fenrir', 'Tubarão', 'Skopós'],
  'marvel-rivals': ['Adam Warlock', 'Black Panther', 'Black Widow', 'Captain America', 'Cloak & Dagger', 'Doctor Strange', 'Emma Frost', 'Groot', 'Hawkeye', 'Hela', 'Hulk', 'Human Torch', 'Invisible Woman', 'Iron Fist', 'Iron Man', 'Jeff the Land Shark', 'Loki', 'Luna Snow', 'Magik', 'Magneto', 'Mantis', 'Mister Fantastic', 'Moon Knight', 'Namor', 'Peni Parker', 'Psylocke', 'The Punisher', 'Rocket Raccoon', 'Scarlet Witch', 'Spider-Man', 'Squirrel Girl', 'Star-Lord', 'Storm', 'Thor', 'Venom', 'Winter Soldier', 'Wolverine'],
  apex: ['Wraith', 'Bangalore', 'Bloodhound', 'Lifeline', 'Caustic', 'Gibraltar', 'Mirage', 'Pathfinder', 'Octane', 'Wattson', 'Crypto', 'Revenant', 'Loba', 'Rampart', 'Horizon', 'Fuse', 'Valkyrie', 'Seer', 'Ash', 'Mad Maggie', 'Newcastle', 'Vantage', 'Catalyst', 'Ballistic', 'Conduit', 'Alter'],
  'mobile-legends': ['Miya', 'Balmond', 'Saber', 'Alice', 'Nana', 'Tigreal', 'Alucard', 'Karina', 'Akai', 'Franco', 'Bane', 'Bruno', 'Clint', 'Rafaela', 'Eudora', 'Zilong', 'Fanny', 'Layla', 'Minotaur', 'Lolita', 'Hayabusa', 'Freya', 'Gord', 'Natalia', 'Kagura', 'Chou', 'Sun', 'Alpha', 'Ruby', 'Yi Sun-shin', 'Moskov', 'Johnson', 'Cyclops', 'Estes', 'Hilda', 'Aurora', 'Lapu-Lapu', 'Vexana', 'Roger', 'Karrie', 'Gatotkaca', 'Harley', 'Irithel', 'Grock', 'Argus', 'Odette', 'Lancelot', 'Diggie', 'Hylos', 'Zhask', 'Helcurt', 'Pharsa', 'Lesley', 'Jawhead', 'Angela', 'Gusion', 'Valir', 'Martis', 'Uranus', 'Hanabi', 'Chang’e', 'Kaja', 'Selena', 'Aldous', 'Claude', 'Vale', 'Leomord', 'Lunox', 'Hanzo', 'Belerick', 'Kimmy', 'Thamuz', 'Harith', 'Minsitthar', 'Kadita', 'Faramis', 'Badang', 'Khufra', 'Granger', 'Guinevere', 'Esmeralda', 'Terizla', 'X.Borg', 'Ling', 'Dyrroth', 'Lylia', 'Baxia', 'Masha', 'Wanwan', 'Silvanna', 'Cecilion', 'Carmilla', 'Atlas', 'Popol and Kupa', 'Yu Zhong', 'Luo Yi', 'Benedetta', 'Khaleed', 'Barats', 'Brody', 'Yve', 'Mathilda', 'Paquito', 'Gloo', 'Beatrix', 'Phoveus', 'Natan', 'Aulus', 'Aamon', 'Valentina', 'Edith', 'Floryn', 'Yin', 'Melissa', 'Xavier', 'Julian', 'Fredrinn', 'Joy', 'Novaria', 'Arlott', 'Ixia', 'Nolan', 'Cici', 'Chip', 'Zhuxin', 'Suyou', 'Lukas', 'Kalea'],
  'honor-of-kings': ['Di Renjie', 'Marco Polo', 'Hou Yi', 'Consort Yu', 'Gongsun Li', 'Lady Sun', 'Garo', 'Erin', 'Mayene', 'Tachi', 'Yang Yuhuan', 'Zhuge Liang', 'Daji', 'Angela', 'Diao Chan', 'Shangguan Wan’er', 'Gao Jianli', 'Wukong', 'Nakoruru', 'Athena', 'Li Bai', 'Zhao Yun', 'Han Xin', 'Luna', 'Prince of Lanling', 'Sima Yi', 'Jing', 'Yao', 'Musashi', 'Dun', 'Lü Bu', 'Guan Yu', 'Cao Cao', 'Zhang Fei', 'Liu Bang', 'Ata', 'Dolia', 'Sun Bin', 'Mozi', 'Zhuangzhou', 'Cai Wenji', 'Sun Ce', 'Kaizer', 'Charlotte', 'Magni', 'Allain', 'Yan', 'Milady', 'Fuxi', 'Pei', 'Lam', 'Ukyo Tachibana']
};

(async () => {
  fs.mkdirSync(HERO_DIR, { recursive: true });
  const games = {};
  const fetchers = { valorant, overwatch, league, dota2 };
  for (const [game, fn] of Object.entries(fetchers)) {
    try {
      process.stdout.write(`Fetching ${game}… `);
      games[game] = await fn();
      const withImg = games[game].filter((h) => h.img).length;
      console.log(`${games[game].length} (${withImg} images)`);
    } catch (e) {
      console.log('FAILED:', e.message, '— skipping');
    }
  }
  for (const [game, names] of Object.entries(STATIC)) {
    games[game] = names.map((n) => ({ n })).sort((a, b) => a.n.localeCompare(b.n));
    console.log(`${game}: ${names.length} (names only)`);
  }

  const banner = '/* GENERATED by scripts/download-heroes.js — do not edit by hand.\n'
    + ' * Per-game hero/agent/operator lists for the roster hero picker. Items: { n: name, img?: slug }.\n'
    + ' * Images live at assets/heroes/<game>/<slug>.png. Re-run the script to refresh. */\n';
  const body = 'const HEROES_BY_GAME = ' + JSON.stringify(games, null, 0) + ';\n'
    + "if (typeof module !== 'undefined' && module.exports) { module.exports = { HEROES_BY_GAME }; }\n";
  fs.writeFileSync(DATA_OUT, banner + body, 'utf8');
  const total = Object.values(games).reduce((a, g) => a + g.length, 0);
  console.log(`\nWrote ${DATA_OUT} (${Object.keys(games).length} games, ${total} heroes).`);
})();
