// Run: node scripts/download-ow-heroes.js
// Syncs assets/overwatch/{heroes,maps,roles} from overfast-api so new heroes/maps/role icons
// appear after a Blizzard update. Existing files are skipped. Prints the id→role table and the
// map list so backend/draft.js (OW_ROLES), backend/veto.js and control-panel/app.js can be updated.
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT = path.join(__dirname, '..', 'assets', 'overwatch');
const DIRS = { heroes: path.join(ROOT, 'heroes'), maps: path.join(ROOT, 'maps'), roles: path.join(ROOT, 'roles') };
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

const API = 'https://overfast-api.tekrop.fr';
// Not real picks (test/placeholder entries in the API). D.Mon was one until it shipped as a tank.
const SKIP_HEROES = new Set([]);
// Only modes the overlay + veto actually use
const MAP_MODES = new Set(['control', 'hybrid', 'escort', 'push', 'flashpoint', 'clash', 'assault']);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NE-BroadcastStudio/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function save(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 500) return 'skip';
  try {
    const buf = await get(url);
    if (buf.length < 200) throw new Error('empty file');
    fs.writeFileSync(dest, buf);
    console.log('  GET   ' + label + ' (' + (buf.length / 1024).toFixed(0) + 'KB)');
    return 'ok';
  } catch (e) { console.log('  FAIL  ' + label + ' (' + e.message + ')'); return 'fail'; }
}

(async () => {
  const json = async p => JSON.parse((await get(API + p)).toString());
  const [heroes, maps, roles] = await Promise.all([json('/heroes?locale=en-us'), json('/maps'), json('/roles')]);

  console.log('Heroes');
  const roleOf = {};
  for (const h of heroes) {
    if (SKIP_HEROES.has(h.key) || !h.portrait) continue;
    roleOf[h.key] = h.role;
    await save(h.portrait, path.join(DIRS.heroes, h.key + '.png'), h.key);
  }

  console.log('Role icons');
  for (const r of roles) await save(r.icon, path.join(DIRS.roles, r.key + '.svg'), r.key);

  console.log('Maps');
  const mapRows = [];
  for (const m of maps) {
    const mode = (m.gamemodes || []).find(g => MAP_MODES.has(g));
    if (!mode) continue;
    const ext = path.extname(m.screenshot.split('?')[0]) || '.jpg';
    const file = path.join(DIRS.maps, m.key + ext);
    const existing = fs.readdirSync(DIRS.maps).find(f => f.startsWith(m.key + '.'));
    if (!existing) await save(m.screenshot, file, m.key);
    mapRows.push(m.key + ' | ' + m.name + ' | ' + mode);
  }

  console.log('\nHero roles:\n' + Object.keys(roleOf).sort().map(k => k + ':' + roleOf[k]).join(' '));
  console.log('\nMaps:\n' + mapRows.join('\n'));
})();
