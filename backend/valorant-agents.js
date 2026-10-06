'use strict';

// GENERATED — do not edit by hand. Refresh with: node assets/fetch-valorant-agents.js
// Source: https://valorant-api.com/v1/agents?isPlayableCharacter=true (29 playable agents, 2026-09-20)
//
// Riot's INTERNAL developer name → what the agent is called on screen. Overwolf's GEP reports
// the internal one ("Pandemic" = Viper, "Wushu" = Jett, "Aggrobot" = Gekko), so every live
// Valorant player has to come through here before an overlay can draw them.

const AGENTS_BY_DEV_NAME = {
  "rift": { name: "Astra", slug: "astra" },
  "breach": { name: "Breach", slug: "breach" },
  "sarge": { name: "Brimstone", slug: "brimstone" },
  "deadeye": { name: "Chamber", slug: "chamber" },
  "smonk": { name: "Clove", slug: "clove" },
  "gumshoe": { name: "Cypher", slug: "cypher" },
  "cable": { name: "Deadlock", slug: "deadlock" },
  "bountyhunter": { name: "Fade", slug: "fade" },
  "aggrobot": { name: "Gekko", slug: "gekko" },
  "mage": { name: "Harbor", slug: "harbor" },
  "sequoia": { name: "Iso", slug: "iso" },
  "wushu": { name: "Jett", slug: "jett" },
  "grenadier": { name: "KAY/O", slug: "kayo" },
  "killjoy": { name: "Killjoy", slug: "killjoy" },
  "iris": { name: "Miks", slug: "miks" },
  "sprinter": { name: "Neon", slug: "neon" },
  "wraith": { name: "Omen", slug: "omen" },
  "phoenix": { name: "Phoenix", slug: "phoenix" },
  "clay": { name: "Raze", slug: "raze" },
  "vampire": { name: "Reyna", slug: "reyna" },
  "thorne": { name: "Sage", slug: "sage" },
  "guide": { name: "Skye", slug: "skye" },
  "hunter": { name: "Sova", slug: "sova" },
  "cashew": { name: "Tejo", slug: "tejo" },
  "pine": { name: "Veto", slug: "veto" },
  "pandemic": { name: "Viper", slug: "viper" },
  "nox": { name: "Vyse", slug: "vyse" },
  "terra": { name: "Waylay", slug: "waylay" },
  "stealth": { name: "Yoru", slug: "yoru" },
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
