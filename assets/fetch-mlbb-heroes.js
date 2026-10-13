'use strict';

// Regenerates the Mobile Legends: Bang Bang hero roster used by the draft board.
//
//   node assets/fetch-mlbb-heroes.js
//
// Writes assets/mlbb/heroes.json ([{ id, name, role, roles, lane }], sorted by name) and one
// portrait per hero at assets/heroes/mobile-legends/<id>.jpg. Run it after a hero release; nothing
// calls it at runtime (an offline venue must never depend on it).
//
// Source: the public hero index at mlbbhub.com/heroes, whose page data carries every hero's name,
// role, lane and splash art. The art itself is served from Moonton's own CDN
// (akmweb.youngjoygame.com); MLBB has no official public API. Heroes already on disk are skipped,
// so a re-run only downloads new ones. Hero art remains the property of Moonton.

const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = 'https://mlbbhub.com/heroes';
const IMG_DIR = path.join(__dirname, 'heroes', 'mobile-legends');
const OUT = path.join(__dirname, 'mlbb', 'heroes.json');

function get(url, binary) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (broadcast-suite roster refresh)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(get(res.headers.location, binary)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

// Each hero is a flat record in the page's serialized data:
// {"id":109,"slug":"aamon","name":"Aamon","title":…,"role":["Assassin"],…,"splashArt":"https://…","lane":["Jungle"],…}
function parseHeroes(html) {
  const s = html.replace(/\\"/g, '"');
  const out = new Map();
  const re = /\{"id":(\d+),"slug":"([a-z0-9-]+)","name":"([^"]+)"[^{}]*?\}/g;
  let m;
  while ((m = re.exec(s))) {
    const rec = m[0];
    const field = (k) => {
      const x = rec.match(new RegExp('"' + k + '":("[^"]*"|\\[[^\\]]*\\])'));
      try { return x ? JSON.parse(x[1]) : undefined; } catch (e) { return undefined; }
    };
    if (out.has(m[2])) continue;
    const roles = [].concat(field('role') || []).filter(Boolean);
    out.set(m[2], {
      id: m[2], name: m[3], role: roles[0] || '', roles,
      lane: [].concat(field('lane') || []).filter(Boolean),
      splash: field('splashArt') || ''
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

(async () => {
  const heroes = parseHeroes(await get(SRC));
  if (heroes.length < 100) throw new Error('Only ' + heroes.length + ' heroes parsed — the page layout probably changed; nothing written.');
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let got = 0, kept = 0, failed = [];
  for (const h of heroes) {
    const file = path.join(IMG_DIR, h.id + '.jpg');
    if (fs.existsSync(file)) { kept++; continue; }
    if (!/^https:\/\/akmweb\.youngjoygame\.com\//.test(h.splash)) { failed.push(h.name); continue; }
    try { fs.writeFileSync(file, await get(h.splash, true)); got++; }
    catch (e) { failed.push(h.name); }
  }
  fs.writeFileSync(OUT, JSON.stringify(heroes.map(({ splash, ...h }) => h), null, 1) + '\n');
  console.log(`${heroes.length} heroes → ${path.relative(process.cwd(), OUT)}; portraits: ${got} new, ${kept} kept` + (failed.length ? `, missing: ${failed.join(', ')}` : ''));
})().catch((e) => { console.error(e.message); process.exit(1); });
