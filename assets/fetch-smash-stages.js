#!/usr/bin/env node
/*
  fetch-smash-stages.js — pull the Super Smash Bros. Ultimate STAGE art the map pool renders.

    node assets/fetch-smash-stages.js            # fetch anything missing (resumable)
    node assets/fetch-smash-stages.js --force    # re-download everything

  Writes assets/smash/maps/<id>.png for every stage in backend/veto.js's `smash` pool, so the ids
  and the art can never drift apart — add a stage there and re-run this.

  Source is SmashWiki, same as the fighter art (see assets/fetch-smash-fighters.js). Stage files are
  named "SSBU-<Stage>.png", but inconsistently: some are .jpg, and some hyphenate the name
  ("SSBU-Small-Battlefield.jpg"), so every spelling is offered to the API and whichever exists wins.
  Images come back as API-generated thumbnails — the originals are full-resolution screenshots.

  The art is Nintendo's; it is fetched at build time, not redistributed by this script.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'smash', 'maps');
const API = 'https://www.ssbwiki.com/api.php';
const UA = 'NE-Broadcast-Suite/1.0 (broadcast overlay asset fetch)';
const WIDTH = 640;                       // map-pool tiles are small; this is plenty

const STAGES = require(path.join(__dirname, '..', 'backend', 'veto.js')).MAP_POOLS.smash;

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');

// "Pokémon Stadium 2" -> the spellings SmashWiki might have filed it under.
function candidates(name) {
  const forms = new Set([name, name.replace(/ /g, '-')]);
  // a few stages drop the apostrophe on the wiki
  if (name.includes("'")) forms.add(name.replace(/'/g, ''));
  const out = [];
  forms.forEach((f) => { out.push('SSBU-' + f + '.png'); out.push('SSBU-' + f + '.jpg'); });
  return out;
}

async function apiGet(url, tries = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt >= tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
    }
  }
}

async function resolveTitles(titles) {
  const found = new Map();
  const uniq = [...new Set(titles)];
  for (let i = 0; i < uniq.length; i += 10) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|size',
      iiurlwidth: String(WIDTH),
      titles: uniq.slice(i, i + 10).map((t) => 'File:' + t).join('|')
    });
    const data = await apiGet(API + '?' + params.toString());
    for (const page of Object.values((data.query && data.query.pages) || {})) {
      const info = page.imageinfo && page.imageinfo[0];
      // Require a generated thumbnail: falling back to info.url pulls the full-size screenshot.
      if (info && info.thumburl) found.set(page.title.replace(/^File:/, ''), info.thumburl);
    }
    process.stdout.write('.');
  }
  return found;
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const want = STAGES.filter((st) => FORCE || !fs.existsSync(path.join(OUT, st.id + '.png')));
  if (!want.length) {
    console.log(`All ${STAGES.length} stages already have art. Use --force to refetch.`);
    return;
  }
  console.log(`Resolving ${want.length} stage(s) on SmashWiki`);
  const cands = new Map(want.map((st) => [st.id, candidates(st.name)]));
  process.stdout.write('  ');
  let found = await resolveTitles([...cands.values()].flat());
  // one retry pass for stragglers — thumbnailing a big screenshot can time out server-side
  const missingTitles = want.filter((st) => !cands.get(st.id).some((t) => found.has(t)))
    .flatMap((st) => cands.get(st.id));
  if (missingTitles.length) {
    process.stdout.write('\n  retrying ');
    (await resolveTitles(missingTitles)).forEach((v, k) => found.set(k, v));
  }
  process.stdout.write('\n');

  let ok = 0, bytes = 0;
  const missing = [];
  for (const st of want) {
    const url = cands.get(st.id).map((t) => found.get(t)).find(Boolean);
    if (!url) { missing.push(`${st.name} (${st.id})`); continue; }
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error('suspiciously small (' + buf.length + ' bytes)');
      fs.writeFileSync(path.join(OUT, st.id + '.png'), buf);
      ok++; bytes += buf.length;
    } catch (err) {
      missing.push(`${st.name} (${err.message})`);
    }
  }
  console.log(`Done — ${ok} downloaded, ${(bytes / 1048576).toFixed(1)} MB.`);
  if (missing.length) {
    console.log(`\nCould not resolve ${missing.length} stage(s) — add a spelling to candidates():`);
    missing.forEach((m) => console.log('  - ' + m));
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('Fetch failed:', err.message);
  process.exit(1);
});
