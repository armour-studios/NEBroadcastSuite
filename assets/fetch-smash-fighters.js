#!/usr/bin/env node
/*
  fetch-smash-fighters.js — pull the Super Smash Bros. Ultimate fighter art the suite renders.

    node assets/fetch-smash-fighters.js            # fetch anything missing (resumable)
    node assets/fetch-smash-fighters.js --force    # re-download everything
    node assets/fetch-smash-fighters.js --only fox,steve

  Writes two sizes per fighter, keyed by the slugs in overlay/smash-fighters.js:
    assets/smash/fighters/stock/<slug>.png    64x64 stock icon  -> stock pips on the HUDs
    assets/smash/fighters/render/<slug>.png   ~600px render     -> placement / line-up card art

  Source is SmashWiki (ssbwiki.com), the only set that covers the FULL 89-fighter roster including
  every Fighters Pass character. Its file naming is regular — "<Name>HeadSSBU.png" for the stock
  icon and "<Name> SSBU.png" for the render — so titles are generated from the registry's display
  names, with WIKI_TITLE_FIXES below covering the handful that don't follow the rule. Titles are
  resolved through the MediaWiki API rather than hardcoded as URLs so a file move upstream doesn't
  silently break the fetch; renders come back as API-generated thumbnails (the originals are 3000px+).

  The art is Nintendo's. It is fetched at build time and not redistributed by this script — treat it
  the way every other broadcast tool does, and swap in licensed art if an event requires it.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = {
  stock: path.join(__dirname, 'smash', 'fighters', 'stock'),
  render: path.join(__dirname, 'smash', 'fighters', 'render')
};
const API = 'https://www.ssbwiki.com/api.php';
const UA = 'NE-Broadcast-Suite/1.0 (broadcast overlay asset fetch)';
const RENDER_WIDTH = 600;

// Fighters whose wiki title isn't just the display name with the punctuation stripped.
const WIKI_TITLE_FIXES = {
  mr_game_and_watch: { head: 'MrGame&WatchHeadSSBU.png', art: 'Mr. Game & Watch SSBU.png' },
  rob:               { head: 'ROBHeadSSBU.png',          art: 'R.O.B. SSBU.png' },
  pac_man:           { head: 'Pac-ManHeadSSBU.png',      art: 'Pac-Man SSBU.png' },
  pokemon_trainer:   { head: 'PokemonTrainerHeadSSBU.png', art: 'Pokémon Trainer SSBU.png' }
};

// ── the roster (shared with the overlays / control panel) ────────────────────
global.window = global;
require(path.join(ROOT, 'overlay', 'smash-fighters.js'));
const FIGHTERS = global.SmashFighters.list;

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const onlyArg = argv.indexOf('--only');
const ONLY = onlyArg >= 0 && argv[onlyArg + 1]
  ? new Set(argv[onlyArg + 1].split(',').map((s) => s.trim()).filter(Boolean))
  : null;

// ── candidate wiki titles per fighter ───────────────────────────────────────
// "Banjo & Kazooie" -> the wiki uses "Banjo & Kazooie SSBU.png" but "BanjoHeadSSBU.png", so the
// ampersand forms and the leading-name-only form are both offered and whichever exists wins.
function candidates(f) {
  const fix = WIKI_TITLE_FIXES[f.slug] || {};
  const tight = f.name.replace(/[^A-Za-z0-9]/g, '');
  const heads = [fix.head, tight + 'HeadSSBU.png'];
  const arts = [fix.art, f.name + ' SSBU.png'];
  if (f.name.includes('&')) {
    const first = f.name.split('&')[0].trim();
    heads.push(first.replace(/[^A-Za-z0-9]/g, '') + 'HeadSSBU.png');
    arts.push(f.name.replace('&', 'and') + ' SSBU.png', first + ' SSBU.png');
  }
  return {
    head: [...new Set(heads.filter(Boolean))],
    art: [...new Set(arts.filter(Boolean))]
  };
}

// ── MediaWiki imageinfo lookup ──────────────────────────────────────────────
async function apiGet(url, tries = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt >= tries - 1) throw err;
      // First-time thumbnail generation on a 3000px source is slow; back off and ask again.
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

// Resolve a batch of File: titles to their (thumb) URLs. Batches stay small for the render pass
// because each miss makes the wiki render a thumbnail on the spot.
async function resolveTitles(titles, width, batchSize) {
  const found = new Map();
  const uniq = [...new Set(titles)];
  for (let i = 0; i < uniq.length; i += batchSize) {
    const slice = uniq.slice(i, i + batchSize);
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      prop: 'imageinfo',
      iiprop: 'url|size',
      titles: slice.map((t) => 'File:' + t).join('|')
    });
    if (width) params.set('iiurlwidth', String(width));
    const data = await apiGet(API + '?' + params.toString());
    const pages = (data.query && data.query.pages) || {};
    for (const page of Object.values(pages)) {
      const info = page.imageinfo && page.imageinfo[0];
      if (!info) continue;
      // With iiurlwidth set, a missing thumburl means the wiki failed to render the thumbnail —
      // taking info.url instead would pull the 3000px/8MB original, so leave it unresolved and
      // let the retry pass below ask again.
      const url = width ? info.thumburl : (info.thumburl || info.url);
      if (info && url) found.set(page.title.replace(/^File:/, ''), url);
    }
    process.stdout.write('.');
  }
  return found;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 200) throw new Error('suspiciously small response (' + buf.length + ' bytes)');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

(async function main() {
  Object.values(OUT).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

  const roster = FIGHTERS.filter((f) => !ONLY || ONLY.has(f.slug));
  const want = roster.filter((f) => FORCE
    || !fs.existsSync(path.join(OUT.stock, f.slug + '.png'))
    || !fs.existsSync(path.join(OUT.render, f.slug + '.png')));

  if (!want.length) {
    console.log(`All ${roster.length} fighters already have stock + render art. Use --force to refetch.`);
    return;
  }
  console.log(`Resolving ${want.length} fighter(s) on SmashWiki`);

  const cands = new Map(want.map((f) => [f.slug, candidates(f)]));
  process.stdout.write('  stock icons ');
  const heads = await resolveTitles([...cands.values()].flatMap((c) => c.head), null, 40);
  process.stdout.write('\n  renders     ');
  const arts = await resolveTitles([...cands.values()].flatMap((c) => c.art), RENDER_WIDTH, 8);
  process.stdout.write('\n');

  let ok = 0, skipped = 0, bytes = 0;
  const missing = [];
  for (const f of want) {
    const c = cands.get(f.slug);
    const jobs = [
      ['stock', c.head.map((t) => heads.get(t)).find(Boolean)],
      ['render', c.art.map((t) => arts.get(t)).find(Boolean)]
    ];
    for (const [kind, url] of jobs) {
      const dest = path.join(OUT[kind], f.slug + '.png');
      if (!FORCE && fs.existsSync(dest)) { skipped++; continue; }
      if (!url) { missing.push(`${f.name} (${kind})`); continue; }
      try {
        bytes += await download(url, dest);
        ok++;
      } catch (err) {
        missing.push(`${f.name} (${kind}: ${err.message})`);
      }
    }
    process.stdout.write(`\r  downloading ${ok} file(s)…   `);
  }

  console.log(`\nDone — ${ok} downloaded, ${skipped} already present, ${(bytes / 1048576).toFixed(1)} MB.`);
  if (missing.length) {
    console.log(`\nCould not resolve ${missing.length} file(s) — add an entry to WIKI_TITLE_FIXES:`);
    missing.forEach((m) => console.log('  - ' + m));
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('Fetch failed:', err.message);
  process.exit(1);
});
