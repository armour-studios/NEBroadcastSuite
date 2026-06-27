/**
 * Download Marvel Rivals map images, map icons, and game-mode icons
 * from the rivalskins.com CDN into:
 *   assets/maps/marvel-rivals/          ← full map preview images
 *   assets/maps/marvel-rivals/icons/    ← small in-game map icons
 *   assets/game-modes/marvel-rivals/    ← game-mode icons
 *
 * Run from the project root:  node scripts/download-mr-maps.js
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CDN = 'https://rivalskins.com/wp-content/uploads/marvel-assets/assets/';

// ── Output directories ────────────────────────────────────────────────────────
const DIRS = {
  maps:      path.join(__dirname, '..', 'assets', 'maps', 'marvel-rivals'),
  mapIcons:  path.join(__dirname, '..', 'assets', 'maps', 'marvel-rivals', 'icons'),
  gameModes: path.join(__dirname, '..', 'assets', 'game-modes', 'marvel-rivals'),
};
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Map full previews ─────────────────────────────────────────────────────────
// local slug → exact CDN filename (with original capitalisation + spaces)
const MAPS = [
  // Competitive maps (Convergence / Domination / Convoy)
  { name: 'Midtown',                       cdn: 'Midtown',                             mode: 'convergence' },
  { name: 'Sanctum Sanctorum',             cdn: 'Sanctum Sanctorum',                   mode: 'convergence' },
  { name: 'Tokyo 2099: Web World',         cdn: 'Tokyo Web World Metropolis',           mode: 'convergence' },
  { name: 'Klyntar: Spider-Islands',       cdn: 'Klyntar Ruins',                       mode: 'domination'  },
  { name: 'Hall of Djalia',                cdn: 'Hall of Dialia',                      mode: 'domination'  },
  { name: 'Yggsgard: Royal Palace',        cdn: 'Yggdrasil Throne',                    mode: 'domination'  },
  { name: 'Hydra Charteris Base',          cdn: 'Hydra Charteris Base',                mode: 'domination'  },
  { name: 'Shin-Shibuya',                  cdn: 'Tokyo Web World Shrine',              mode: 'convoy'      },
  { name: 'Birnin T\'Chaka',              cdn: 'Wakanda',                             mode: 'convoy'      },
  { name: 'Hydra Erebus Base',             cdn: 'Hydra Erebus Base',                   mode: 'convoy'      },
  // Additional maps
  { name: 'Archive',                       cdn: 'Archive'                                                  },
  { name: 'Celestial Hand',                cdn: 'Celestial Hand'                                           },
  { name: 'Celestial Heart',               cdn: 'Celestial Heart'                                          },
  { name: 'Central Park',                  cdn: 'Central Park'                                             },
  { name: 'Golden City',                   cdn: 'Golden City'                                              },
  { name: 'Golden City: Warrior Falls',    cdn: 'Golden City Warrior Falls'                                },
  { name: 'Hellfire Gala: Arakko',         cdn: 'Hellfire Gala Arakko'                                     },
  { name: 'Hydrabase Altar',               cdn: 'Hydrabase Altar'                                          },
  { name: 'Hydrabase Arsenal',             cdn: 'Hydrabase Arsenal'                                        },
  { name: 'Krakoa: Carousel',              cdn: 'Krakoa Carousel'                                          },
  { name: 'Krakoa: Cradle',               cdn: 'Krakoa Cradle'                                            },
  { name: 'Krakoa: Grove',                cdn: 'Krakoa Grove'                                             },
  { name: 'Thorny Jungle',                 cdn: 'Thorny Jungle'                                            },
  { name: 'Tokyo: Spider-Island',          cdn: 'Tokyo Web World Spiderisland'                             },
  { name: 'Yggsgard: Garden',             cdn: 'Yggdrasil Garden'                                         },
  { name: 'Yggsgard',                     cdn: 'Yggdrasil'                                                },
];

// ── Map icons (small in-UI thumbnail) ────────────────────────────────────────
const MAP_ICONS = [
  { slug: 'archive',            cdn: 'img_gamemap_archive' },
  { slug: 'celestial-hand',     cdn: 'img_gamemap_celestial_hand' },
  { slug: 'celestial-heart',    cdn: 'img_gamemap_celestial_heart' },
  { slug: 'collector-1',        cdn: 'img_gamemap_collector1' },
  { slug: 'collector-2',        cdn: 'img_gamemap_collector2' },
  { slug: 'garden',             cdn: 'img_gamemap_garden' },
  { slug: 'hydrabase-altar',    cdn: 'img_gamemap_hydrabase_altar' },
  { slug: 'hydrabase-arsenal',  cdn: 'img_gamemap_hydrabase_arsenal' },
  { slug: 'hydra-charteris',    cdn: 'img_gamemap_hydracharterisbase' },
  { slug: 'krakoa-carousel',    cdn: 'img_gamemap_krakoacarousel' },
  { slug: 'krakoa-cradle',      cdn: 'img_gamemap_krakoacradle' },
  { slug: 'krakoa-grove',       cdn: 'img_gamemap_krakoagrove' },
  { slug: 'kunlun',             cdn: 'img_gamemap_kunlun_heartoftiandu' },
  { slug: 'lower-manhattan',    cdn: 'img_gamemap_newyork_lowermanhattan' },
  { slug: 'spacecraft',         cdn: 'img_gamemap_spacecraft' },
  { slug: 'thorny-jungle',      cdn: 'img_gamemap_thorny_jungle' },
  { slug: 'throne',             cdn: 'img_gamemap_throne' },
  { slug: 'time-crystal',       cdn: 'img_gamemap_timecrystal' },
  { slug: 'waterfall',          cdn: 'img_gamemap_waterfall' },
];

// ── Game-mode icons ───────────────────────────────────────────────────────────
const GAME_MODES = [
  { slug: 'capture',    cdn: 'icon_squad_capture'    }, // Convergence equivalent
  { slug: 'conquest',   cdn: 'icon_squad_conquest'   }, // Domination equivalent
  { slug: 'teamfight',  cdn: 'icon_squad_teamfight'  }, // Convoy equivalent
  { slug: 'ranked',     cdn: 'icon_squad_rank'       },
  { slug: 'quickgame',  cdn: 'icon_squad_quickgame'  },
  { slug: 'league',     cdn: 'icon_squad_league'     },
  { slug: 'custom',     cdn: 'icon_squad_custom'     },
  { slug: 'deathmatch', cdn: 'icon_squad_deathmatch' },
  { slug: 'duel',       cdn: 'icon_squad_duel'       },
];

// ── Shared helpers ────────────────────────────────────────────────────────────
function toSlug(name) {
  return name.toLowerCase()
    .replace(/[':]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) return resolve('skip');
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
      file.on('finish', () => { file.close(); resolve('ok'); });
    }).on('error', err => { file.close(); fs.unlink(dest, () => {}); reject(err); });
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Download groups ───────────────────────────────────────────────────────────
async function downloadMaps() {
  console.log('\n── Map full previews ──');
  let ok = 0, skip = 0, fail = 0;
  for (const m of MAPS) {
    const localSlug = toSlug(m.name);
    const dest = path.join(DIRS.maps, localSlug + '.png');
    // Try both capitalised (.Png) and lowercase (.png)
    const urls = [
      CDN + 'maps/' + encodeURIComponent(m.cdn) + '.Png',
      CDN + 'maps/' + encodeURIComponent(m.cdn) + '.png',
    ];
    let success = false;
    for (const url of urls) {
      try {
        const res = await download(url, dest);
        if (res === 'skip') { console.log(`  skip  ${m.name}`); skip++; success = true; break; }
        console.log(`  ok    ${m.name}`);
        ok++; success = true; break;
      } catch { /* try next */ }
    }
    if (!success) { console.warn(`  FAIL  ${m.name}`); fail++; }
    await delay(100);
  }
  console.log(`  → ${ok} downloaded, ${skip} skipped, ${fail} failed`);
}

async function downloadMapIcons() {
  console.log('\n── Map icons ──');
  let ok = 0, skip = 0, fail = 0;
  for (const m of MAP_ICONS) {
    const dest = path.join(DIRS.mapIcons, m.slug + '.png');
    const url  = CDN + 'map-icons/' + m.cdn + '.png';
    try {
      const res = await download(url, dest);
      if (res === 'skip') { console.log(`  skip  ${m.slug}`); skip++; }
      else { console.log(`  ok    ${m.slug}`); ok++; }
    } catch (e) { console.warn(`  FAIL  ${m.slug} — ${e.message}`); fail++; }
    await delay(80);
  }
  console.log(`  → ${ok} downloaded, ${skip} skipped, ${fail} failed`);
}

async function downloadGameModes() {
  console.log('\n── Game-mode icons ──');
  let ok = 0, skip = 0, fail = 0;
  for (const g of GAME_MODES) {
    const dest = path.join(DIRS.gameModes, g.slug + '.png');
    const url  = CDN + 'game-mode-icons/' + g.cdn + '.png';
    try {
      const res = await download(url, dest);
      if (res === 'skip') { console.log(`  skip  ${g.slug}`); skip++; }
      else { console.log(`  ok    ${g.slug}`); ok++; }
    } catch (e) { console.warn(`  FAIL  ${g.slug} — ${e.message}`); fail++; }
    await delay(80);
  }
  console.log(`  → ${ok} downloaded, ${skip} skipped, ${fail} failed`);
}

(async () => {
  console.log('Downloading Marvel Rivals map + mode assets from rivalskins CDN...');
  await downloadMaps();
  await downloadMapIcons();
  await downloadGameModes();
  console.log('\nAll done. Assets saved to:');
  Object.entries(DIRS).forEach(([k, v]) => console.log('  ' + v));
})();
