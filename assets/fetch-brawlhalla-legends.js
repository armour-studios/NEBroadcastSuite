#!/usr/bin/env node
/*
  fetch-brawlhalla-legends.js — pull the Brawlhalla legend art the suite renders.

    node assets/fetch-brawlhalla-legends.js            # fetch anything missing (resumable)
    node assets/fetch-brawlhalla-legends.js --force    # re-download everything
    node assets/fetch-brawlhalla-legends.js --only mordex,bodvar
    node assets/fetch-brawlhalla-legends.js --registry # ALSO refresh overlay/brawlhalla-legends.js

  Writes two sizes per legend, keyed by the slugs in overlay/brawlhalla-legends.js:
    assets/brawlhalla/legends/icon/<slug>.png     128px  -> stock pips + seat chips on the HUD
    assets/brawlhalla/legends/render/<slug>.png   600px  -> plate portrait / top-8 card art

  Source is the Brawlhalla wiki (brawlhalla.fandom.com), resolved through the MediaWiki API so a
  file move upstream doesn't silently break the fetch. Both sizes come from the SAME source image
  as API-generated thumbnails, so nothing here needs an image library.

  ART IS OPTIONAL. Every board falls back cleanly — pips become plain accent dots and the portrait
  is simply absent — so a miss is a cosmetic gap, not a broken overlay. Expect misses on
  recently-added legends: the wiki lags a patch, and the canonical "File:<Name>.png" for them may
  not exist yet. Re-run later and the resumable pass picks them up.

  The art is Blue Mammoth's / Ubisoft's. It is fetched at build time and not redistributed by this
  script — treat it the way every other broadcast tool does, and swap in licensed art if an event
  requires it.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = {
  icon: path.join(__dirname, 'brawlhalla', 'legends', 'icon'),
  render: path.join(__dirname, 'brawlhalla', 'legends', 'render')
};
const API = 'https://brawlhalla.fandom.com/api.php';
const UA = 'NE-Broadcast-Suite/1.0 (broadcast overlay asset fetch)';
const ICON_WIDTH = 128;
const RENDER_WIDTH = 600;

// ── the roster (shared with the overlays / control panel) ────────────────────
global.window = global;
require(path.join(ROOT, 'overlay', 'brawlhalla-legends.js'));
const LEGENDS = global.BrawlhallaLegends.list;

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const REGISTRY = argv.includes('--registry');
const onlyArg = argv.indexOf('--only');
const ONLY = onlyArg >= 0 && argv[onlyArg + 1]
  ? new Set(argv[onlyArg + 1].split(',').map((s) => s.trim()).filter(Boolean))
  : null;

async function apiGet(url, tries = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt >= tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

/*
  Resolve File: titles to thumbnail URLs at one width.

  A missing `thumburl` when iiurlwidth is set means the wiki failed to render the thumbnail. Taking
  info.url instead would pull the full-size original, so leave it unresolved and let a later run
  ask again — the same trap the Smash fetcher documents.
*/
async function resolveTitles(titles, width, batchSize = 20) {
  const found = new Map();
  const uniq = [...new Set(titles)];
  for (let i = 0; i < uniq.length; i += batchSize) {
    const slice = uniq.slice(i, i + batchSize);
    const params = new URLSearchParams({
      action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|size',
      iiurlwidth: String(width),
      titles: slice.map((t) => 'File:' + t).join('|')
    });
    const data = await apiGet(API + '?' + params.toString());
    const pages = (data.query && data.query.pages) || {};
    for (const page of Object.values(pages)) {
      const info = page.imageinfo && page.imageinfo[0];
      if (info && info.thumburl) found.set(page.title.replace(/^File:/, ''), info.thumburl);
    }
    process.stdout.write('.');
  }
  return found;
}

// Last resort for a legend whose canonical file isn't where we expect: ask the wiki's search for
// a File: page carrying the legend's name and take the closest match.
async function searchFile(name) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', list: 'search', srnamespace: '6',
    srsearch: name, srlimit: '5'
  });
  const data = await apiGet(API + '?' + params.toString());
  const hits = ((data.query && data.query.search) || []).map((h) => h.title.replace(/^File:/, ''));
  const want = name.toLowerCase();
  // Prefer the bare "<Name>.png" over a skin ("<Name> Darkheart.png").
  return hits.find((t) => t.toLowerCase() === want + '.png')
      || hits.find((t) => /\.(png|jpg)$/i.test(t) && t.toLowerCase().startsWith(want))
      || null;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 200) throw new Error('suspiciously small response (' + buf.length + ' bytes)');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// Regenerate overlay/brawlhalla-legends.js from the game's own static data, so a patch that adds a
// legend is one command away rather than a hand edit.
async function refreshRegistry() {
  const out = [];
  let page = 1, total = 1;
  while (page <= total && page <= 10) {
    const res = await fetch(`https://api.brawlhalla.com/v1/static/legends?max_results=100&page=${page}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('legends API HTTP ' + res.status);
    const data = await res.json();
    out.push(...(data.legends || []));
    total = data.total_pages || 1;
    page++;
  }
  const known = new Set(LEGENDS.map((l) => l.id));
  const added = out.filter((l) => l.legend_id !== 2 && !known.has(l.legend_id));
  if (!added.length) {
    console.log(`Registry is current — ${LEGENDS.length} legends, none added upstream.`);
    return;
  }
  console.log(`\n${added.length} legend(s) missing from overlay/brawlhalla-legends.js:`);
  added.forEach((l) => {
    const name = l.bio_name || l.legend_name;
    const slug = name.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
    console.log(`  { id: ${l.legend_id}, slug: '${slug}', name: '${name}', weapons: ['${l.weapon_one}', '${l.weapon_two}'] },`);
  });
  console.log('\nPaste those into the LEGENDS array in overlay/brawlhalla-legends.js, then re-run without --registry.');
}

(async function main() {
  if (REGISTRY) { await refreshRegistry(); if (argv.length === 1) return; }
  Object.values(OUT).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

  const roster = LEGENDS.filter((l) => !ONLY || ONLY.has(l.slug));
  const want = roster.filter((l) => FORCE
    || !fs.existsSync(path.join(OUT.icon, l.slug + '.png'))
    || !fs.existsSync(path.join(OUT.render, l.slug + '.png')));

  if (!want.length) {
    console.log(`Nothing to do — all ${roster.length} legends already have art. Use --force to re-download.`);
    return;
  }
  console.log(`Fetching art for ${want.length} legend(s)...`);

  const titleFor = new Map(want.map((l) => [l.slug, l.name + '.png']));
  process.stdout.write('resolving icons ');
  let icons = await resolveTitles([...titleFor.values()], ICON_WIDTH);
  process.stdout.write('\nresolving renders ');
  let renders = await resolveTitles([...titleFor.values()], RENDER_WIDTH);
  process.stdout.write('\n');

  // Anything unresolved gets one search pass — newer legends are the usual cause.
  const missing = want.filter((l) => !icons.has(titleFor.get(l.slug)));
  if (missing.length) {
    console.log(`Searching the wiki for ${missing.length} legend(s) with no "<Name>.png"...`);
    for (const l of missing) {
      const hit = await searchFile(l.name);
      if (hit) titleFor.set(l.slug, hit);
    }
    const retry = missing.map((l) => titleFor.get(l.slug)).filter(Boolean);
    if (retry.length) {
      const i2 = await resolveTitles(retry, ICON_WIDTH);
      const r2 = await resolveTitles(retry, RENDER_WIDTH);
      icons = new Map([...icons, ...i2]);
      renders = new Map([...renders, ...r2]);
      process.stdout.write('\n');
    }
  }

  let ok = 0;
  const failed = [];
  for (const l of want) {
    const title = titleFor.get(l.slug);
    const iconUrl = icons.get(title);
    const renderUrl = renders.get(title);
    if (!iconUrl && !renderUrl) { failed.push(l.name); continue; }
    try {
      if (iconUrl) await download(iconUrl, path.join(OUT.icon, l.slug + '.png'));
      if (renderUrl) await download(renderUrl, path.join(OUT.render, l.slug + '.png'));
      ok++;
      process.stdout.write('.');
    } catch (err) {
      failed.push(`${l.name} (${err.message})`);
    }
  }

  console.log(`\nDone — ${ok} legend(s) fetched into assets/brawlhalla/legends/.`);
  if (failed.length) {
    console.log(`No art found for ${failed.length}: ${failed.join(', ')}`);
    console.log('Those legends render as plain accent pips with no portrait, which is a supported fallback — re-run later once the wiki catches up.');
  }
})().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
