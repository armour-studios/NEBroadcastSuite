// Run once: node scripts/download-ow-heroes.js
// Fetches portrait URLs from overfast-api then downloads to assets/overwatch/heroes/
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const OUT = path.join(__dirname, '..', 'assets', 'overwatch', 'heroes');
fs.mkdirSync(OUT, { recursive: true });

// Map our slug → OverFast key (most match; exceptions listed here)
const SLUG_MAP = {
  'dva':            'dva',
  'wrecking-ball':  'wrecking-ball',
  'junker-queen':   'junker-queen',
  'soldier-76':     'soldier-76',
  'torbjorn':       'torbjorn',
  'lucio':          'lucio',
};

// Slugs we want (matches our OW_HEROES_BY_ROLE in app.js)
const WANT_SLUGS = [
  'ana','ashe','baptiste','bastion','brigitte','cassidy','dva','doomfist',
  'echo','freja','genji','hanzo','hazard','illari','junkrat','junker-queen',
  'juno','kiriko','lifeweaver','lucio','mauga','mei','mercy','moira',
  'orisa','pharah','ramattra','reaper','reinhardt','roadhog','sigma','sojourn',
  'soldier-76','sombra','symmetra','torbjorn','tracer','venture',
  'widowmaker','winston','wrecking-ball','zarya','zenyatta'
];

function get(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    https.get(url, { headers: { 'User-Agent': 'NE-BroadcastStudio/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return get(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NE-BroadcastStudio/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

(async () => {
  // 1. Fetch hero list from OverFast
  console.log('Fetching hero list from overfast-api...');
  let heroData;
  try {
    const buf = await get('https://overfast-api.tekrop.fr/heroes?locale=en-us');
    heroData = JSON.parse(buf.toString());
  } catch (e) {
    console.error('Failed to fetch hero list:', e.message); process.exit(1);
  }

  // Build key → portrait URL map
  const portraitMap = {};
  for (const h of heroData) {
    if (h.key && h.portrait) portraitMap[h.key] = h.portrait;
  }
  console.log(`Got ${Object.keys(portraitMap).length} heroes from API\n`);

  // 2. Download each hero portrait
  let ok = 0, skip = 0, fail = 0;
  for (const slug of WANT_SLUGS) {
    const dest = path.join(OUT, slug + '.png');
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      console.log(`  SKIP  ${slug} (exists)`);
      skip++; continue;
    }
    const ovKey = SLUG_MAP[slug] || slug;
    const url   = portraitMap[ovKey];
    if (!url) { console.log(`  MISS  ${slug} (no API entry)`); fail++; continue; }

    process.stdout.write(`  GET   ${slug.padEnd(16)}`);
    try {
      await downloadFile(url, dest);
      const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      if (size < 500) { fs.unlinkSync(dest); throw new Error('empty file'); }
      console.log(`OK (${(size/1024).toFixed(0)}KB)`);
      ok++;
    } catch (e) {
      console.log(`FAIL (${e.message})`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} downloaded, ${skip} skipped, ${fail} failed`);
  if (fail > 0) {
    console.log('\nMissing heroes — add their images manually to: assets/overwatch/heroes/');
    console.log('Filename should be:  {slug}.png  (e.g. ana.png, wrecking-ball.png)');
  }
})();
