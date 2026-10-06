'use strict';

// Regenerates backend/valorant-agents.js — the Valorant internal codename → agent registry.
//
//   node assets/fetch-valorant-agents.js
//
// Why this exists: Overwolf's GEP reports each player's agent by Riot's INTERNAL developer name
// ("Pandemic", "Wushu", "Aggrobot"), not the name on screen. Those pairings are not guessable —
// Aggrobot is Gekko, Wushu is Jett, Sequoia is Iso — so the map is generated from
// valorant-api.com's `developerName`/`displayName` fields rather than hand-written. Run this after
// an agent release; nothing calls it at runtime.
//
// `slug` is the lowercase art key the overlay uses (/assets/valorant/agents/<slug>/…), with
// punctuation stripped so KAY/O resolves as "kayo".

const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const OUT = path.join(__dirname, '..', 'backend', 'valorant-agents.js');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const slugify = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

(async () => {
  const body = await get(SRC);
  const rows = (body && body.data) || [];
  if (!rows.length) throw new Error('valorant-api returned no agents');

  const entries = rows
    .filter((a) => a.developerName && a.displayName)
    .map((a) => ({ dev: String(a.developerName), name: String(a.displayName), slug: slugify(a.displayName) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines = entries.map((e) =>
    `  ${JSON.stringify(e.dev.toLowerCase())}: { name: ${JSON.stringify(e.name)}, slug: ${JSON.stringify(e.slug)} },`
  );

  const out = `'use strict';

// GENERATED — do not edit by hand. Refresh with: node assets/fetch-valorant-agents.js
// Source: ${SRC} (${entries.length} playable agents, ${new Date().toISOString().slice(0, 10)})
//
// Riot's INTERNAL developer name → what the agent is called on screen. Overwolf's GEP reports
// the internal one ("Pandemic" = Viper, "Wushu" = Jett, "Aggrobot" = Gekko), so every live
// Valorant player has to come through here before an overlay can draw them.

const AGENTS_BY_DEV_NAME = {
${lines.join('\n')}
};

/** Resolve a GEP character codename to { name, slug }. Unknown agents (a release we have not
 *  regenerated for yet) fall back to the raw codename rather than rendering blank — a producer
 *  seeing "Pine" knows to refresh the registry; a blank slot just looks broken. */
function resolveAgent(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return { name: '', slug: '' };
  return AGENTS_BY_DEV_NAME[key] || { name: String(raw), slug: key.replace(/[^a-z0-9]/g, '') };
}

module.exports = { AGENTS_BY_DEV_NAME, resolveAgent };
`;

  fs.writeFileSync(OUT, out, 'utf8');
  console.log('wrote ' + path.relative(path.join(__dirname, '..'), OUT) + ' — ' + entries.length + ' agents');
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
