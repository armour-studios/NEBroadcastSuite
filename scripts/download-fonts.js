'use strict';
/**
 * Downloads Rajdhani, Inter, and Montserrat (Latin subset, WOFF2) from Google
 * Fonts and writes them to assets/fonts/.  Run once, or again to refresh.
 *
 *   node scripts/download-fonts.js
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const CSS_OUT   = path.join(__dirname, '..', 'overlay', 'fonts.css');

fs.mkdirSync(FONTS_DIR, { recursive: true });

const REQUESTS = [
  { family: 'Rajdhani',   tag: 'rajdhani',   weights: '400;500;600;700' },
  { family: 'Inter',      tag: 'inter',       weights: '500;600;700;800' },
  { family: 'Montserrat', tag: 'montserrat',  weights: '500;700;800' },
];

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function get(url, binary) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': CHROME_UA } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, binary).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

async function main() {
  const faceLines = [];

  for (const { family, tag, weights } of REQUESTS) {
    const apiUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weights}&display=swap`;
    console.log(`\nFetching ${family} CSS...`);
    const css = await get(apiUrl, false);

    // Each @font-face block is preceded by a comment naming the subset (/* latin */, etc.)
    const blockRe = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
    let match;
    while ((match = blockRe.exec(css)) !== null) {
      const [, subset, body] = match;
      if (subset !== 'latin') continue;   // skip extended/cyrillic/etc.

      const wMatch = body.match(/font-weight:\s*(\d+)/);
      const uMatch = body.match(/url\((https?:\/\/[^)]+\.woff2)\)/);
      if (!wMatch || !uMatch) continue;

      const weight   = wMatch[1];
      const woff2Url = uMatch[1];
      const filename = `${tag}-${weight}.woff2`;
      const filepath = path.join(FONTS_DIR, filename);

      if (fs.existsSync(filepath)) {
        console.log(`  skip (exists): ${filename}`);
      } else {
        process.stdout.write(`  downloading: ${filename} ... `);
        const data = await get(woff2Url, true);
        fs.writeFileSync(filepath, data);
        console.log(`${(data.length / 1024).toFixed(0)} KB`);
      }

      faceLines.push({ family, weight, filename });
    }
  }

  if (!faceLines.length) {
    console.error('\nNo @font-face rules extracted — Google may have changed their CSS format.');
    process.exit(1);
  }

  const cssContent = faceLines.map(({ family, weight, filename }) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url('/assets/fonts/${filename}')format('woff2');}`
  ).join('\n') + '\n';

  fs.writeFileSync(CSS_OUT, cssContent);
  console.log(`\nWrote overlay/fonts.css (${faceLines.length} faces)`);
  console.log('Refresh OBS browser sources to apply.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
