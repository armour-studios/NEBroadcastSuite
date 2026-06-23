// Generate placeholder map/stage/arena art for the veto board, one SVG per map.
// Real screenshots can replace these later — drop a same-named file in the folder and
// this script will skip it (it never overwrites existing art). CS2 uses real radar PNGs.
//
//   node assets/build-map-placeholders.js
//
const fs = require('fs');
const path = require('path');
const { MAP_POOLS } = require('../backend/veto');

const ASSETS = __dirname;
const TINT = {
  valorant: '#ff4655', rainbow6: '#1b6ec2', overwatch: '#f99e1a',
  'marvel-rivals': '#e23636', 'rocket-league': '#1f8fff', smash: '#e60012'
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svgFor(name, tint) {
  // 16:10 card: dark gradient + a diagonal tint sweep + the map name.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#10131a"/><stop offset="1" stop-color="#1c2230"/>
    </linearGradient>
    <linearGradient id="t" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="${tint}" stop-opacity="0.0"/>
      <stop offset="0.55" stop-color="${tint}" stop-opacity="0.0"/>
      <stop offset="1" stop-color="${tint}" stop-opacity="0.45"/>
    </linearGradient>
  </defs>
  <rect width="320" height="200" fill="url(#g)"/>
  <rect width="320" height="200" fill="url(#t)"/>
  <rect x="0" y="186" width="320" height="14" fill="${tint}" opacity="0.85"/>
  <text x="160" y="104" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="30" font-weight="800" fill="#f2f4f8" letter-spacing="0.5">${esc(name)}</text>
</svg>
`;
}

let made = 0, skipped = 0;
Object.keys(MAP_POOLS).forEach((game) => {
  if (game === 'csgo') return;                       // real radar PNGs already exist
  const dir = path.join(ASSETS, game, 'maps');
  fs.mkdirSync(dir, { recursive: true });
  const tint = TINT[game] || '#3a7bd5';
  MAP_POOLS[game].forEach((m) => {
    const file = path.join(dir, `${m.id}.svg`);
    if (fs.existsSync(file)) { skipped++; return; }  // never clobber real art
    fs.writeFileSync(file, svgFor(m.name, tint));
    made++;
  });
});
console.log(`map placeholders: ${made} created, ${skipped} kept`);
