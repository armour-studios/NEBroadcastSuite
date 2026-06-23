#!/usr/bin/env node
/*
 * Downloads every country's SVG flag into assets/flags/<code>.svg so the app can show flags
 * offline during a live broadcast. Run once (needs internet):
 *
 *     node scripts/download-flags.js
 *
 * Source: flagcdn.com (public domain flag set). Re-running only fetches missing files unless
 * you pass --force. Country list comes from control-panel/countries.js.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const { COUNTRIES } = require(path.join(__dirname, '..', 'control-panel', 'countries.js'));
const OUT_DIR = path.join(__dirname, '..', 'assets', 'flags');
const FORCE = process.argv.includes('--force');
const CONCURRENCY = 8;

fs.mkdirSync(OUT_DIR, { recursive: true });

function download(code) {
  const dest = path.join(OUT_DIR, `${code}.svg`);
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return Promise.resolve({ code, status: 'skip' });
  }
  const url = `https://flagcdn.com/${code}.svg`;
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ code, status: 'fail', reason: `HTTP ${res.statusCode}` });
      }
      const tmp = dest + '.tmp';
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve({ code, status: 'ok' }); }));
      file.on('error', () => { try { fs.unlinkSync(tmp); } catch (e) {} resolve({ code, status: 'fail', reason: 'write error' }); });
    });
    req.on('error', (e) => resolve({ code, status: 'fail', reason: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ code, status: 'fail', reason: 'timeout' }); });
  });
}

(async () => {
  const codes = COUNTRIES.map((c) => c.c);
  let ok = 0, skip = 0, fail = 0;
  const failures = [];
  console.log(`Downloading ${codes.length} flags → ${OUT_DIR}${FORCE ? ' (forced)' : ''}\n`);
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(download));
    for (const r of results) {
      if (r.status === 'ok') ok++;
      else if (r.status === 'skip') skip++;
      else { fail++; failures.push(`${r.code} (${r.reason})`); }
    }
    process.stdout.write(`\r  ${ok} downloaded · ${skip} skipped · ${fail} failed`);
  }
  console.log('\n');
  if (failures.length) console.log('Failed:', failures.join(', '));
  console.log(`Done. ${ok + skip}/${codes.length} flags available in assets/flags/.`);
})();
