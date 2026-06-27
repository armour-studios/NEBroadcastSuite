/**
 * Download Marvel Rivals hero avatars from rivalskins.com CDN
 * into assets/heroes/marvel-rivals/
 *
 * Run from the project root:  node scripts/download-mr-heroes.js
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const OUT_DIR = path.join(__dirname, '..', 'assets', 'heroes', 'marvel-rivals');
const CDN_BASE = 'https://rivalskins.com/wp-content/uploads/marvel-assets/ui/heroes/avatar/';

// Hero display name → filename stem on rivalskins (stem + _avatar.png)
// Most follow the standard slug; overrides listed where they differ.
const HEROES = [
  // Vanguard
  { name: 'Captain America',  slug: 'captain-america' },
  { name: 'Doctor Strange',   slug: 'doctor-strange' },
  { name: 'Emma Frost',       slug: 'emma-frost' },
  { name: 'Groot',            slug: 'groot' },
  { name: 'Hulk',             slug: 'hulk' },
  { name: 'Magneto',          slug: 'magneto' },
  { name: 'Mister Fantastic', slug: 'mister-fantastic' },
  { name: 'Peni Parker',      slug: 'peni-parker' },
  { name: 'Thor',             slug: 'thor' },
  { name: 'Venom',            slug: 'venom' },
  // Duelist
  { name: 'Black Panther',    slug: 'black-panther' },
  { name: 'Black Widow',      slug: 'black-widow' },
  { name: 'Hawkeye',          slug: 'hawkeye' },
  { name: 'Hela',             slug: 'hela' },
  { name: 'Human Torch',      slug: 'human-torch' },
  { name: 'Iron Fist',        slug: 'iron-fist' },
  { name: 'Iron Man',         slug: 'iron-man' },
  { name: 'Magik',            slug: 'magik' },
  { name: 'Moon Knight',      slug: 'moon-knight' },
  { name: 'Namor',            slug: 'namor' },
  { name: 'Psylocke',         slug: 'psylocke' },
  { name: 'Scarlet Witch',    slug: 'scarlet-witch' },
  { name: 'Spider-Man',       slug: 'spider-man' },
  { name: 'Squirrel Girl',    slug: 'squirrel-girl' },
  { name: 'Star-Lord',        slug: 'star-lord' },
  { name: 'Storm',            slug: 'storm' },
  { name: 'The Punisher',     slug: 'punisher', alt: 'the-punisher' },
  { name: 'Winter Soldier',   slug: 'winter-soldier' },
  { name: 'Wolverine',        slug: 'wolverine' },
  // Strategist
  { name: 'Adam Warlock',     slug: 'adam-warlock' },
  { name: 'Cloak & Dagger',   slug: 'cloak-and-dagger', alt: 'cloak-dagger' },
  { name: 'Invisible Woman',  slug: 'invisible-woman' },
  { name: 'Jeff the Land Shark', slug: 'jeff-the-land-shark', alt: 'jeff' },
  { name: 'Loki',             slug: 'loki' },
  { name: 'Luna Snow',        slug: 'luna-snow' },
  { name: 'Mantis',           slug: 'mantis' },
  { name: 'Rocket Raccoon',   slug: 'rocket-raccoon' },
];

function localSlug(displayName) {
  return displayName.toLowerCase()
    .replace(/[&]/g, '').replace(/[.']/g, '').replace(/:\s*/g, '-')
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { file.close(); fs.unlink(dest, () => {}); reject(err); });
  });
}

async function tryDownload(hero) {
  const destSlug  = localSlug(hero.name);   // what the overlay expects
  const destPath  = path.join(OUT_DIR, destSlug + '.png');

  if (fs.existsSync(destPath)) {
    console.log(`  skip  ${hero.name} (already exists)`);
    return true;
  }

  const slugsToTry = [hero.slug, hero.alt].filter(Boolean);
  for (const s of slugsToTry) {
    const url = CDN_BASE + s + '_avatar.png';
    try {
      await download(url, destPath);
      console.log(`  ok    ${hero.name}  ← ${s}_avatar.png`);
      return true;
    } catch (e) {
      // try next alternative
    }
  }
  console.warn(`  FAIL  ${hero.name} (tried: ${slugsToTry.join(', ')})`);
  return false;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Downloading ${HEROES.length} hero portraits to:\n  ${OUT_DIR}\n`);
  let ok = 0, fail = 0;
  for (const h of HEROES) {
    const success = await tryDownload(h);
    if (success) ok++; else fail++;
    await new Promise(r => setTimeout(r, 120)); // polite delay
  }
  console.log(`\nDone: ${ok} downloaded, ${fail} failed`);
  if (fail > 0) console.log('Failed heroes will use role-icon fallback on the overlay.');
})();
