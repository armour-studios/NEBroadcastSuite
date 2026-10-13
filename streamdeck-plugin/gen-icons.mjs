// Generates the action icon set: icon.svg (20x20 actions-list glyph, white),
// key.svg (72x72 idle state) and key-on.svg (72x72 lit state) per action.
// Run: node gen-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join("com.armour-studios.ne-broadcast.sdPlugin", "imgs");

// Each glyph is drawn in a 24x24 viewBox (stroke-based, currentColor via fill/stroke params).
const GLYPHS = {
  "adjust-score":   `<text x="12" y="17" font-family="Segoe UI, Arial" font-size="14" font-weight="800" text-anchor="middle" fill="{c}">+1</text>`,
  "set-score":      `<text x="12" y="17" font-family="Segoe UI, Arial" font-size="14" font-weight="800" text-anchor="middle" fill="{c}">=N</text>`,
  "series-control": `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><path d="M19 12a7 7 0 1 1-2-4.9"/><path d="M17 3v4h-4" fill="none"/></g>`,
  "select-team":    `<g fill="{c}"><circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5z"/><circle cx="17" cy="8" r="2.4" opacity=".55"/><path d="M14.8 13.4c.6-.2 1.4-.4 2.2-.4 2.4 0 4.5 1.6 4.5 4h-5" opacity=".55"/></g>`,
  "gfx-onair":      `<path fill="{c}" d="M12 2l2.4 6.9L21 11l-6.6 2.1L12 20l-2.4-6.9L3 11l6.6-2.1z"/>`,
  "clear-gfx":      `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/></g>`,
  "switch-scene":   `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></g>`,
  "fire-flow":      `<path fill="{c}" d="M13 2L5 14h5l-1.5 8L19 9h-5.5z"/>`,
  "break-countdown":`<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/></g>`,
  "countdown-clock":`<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></g>`,
  "audio-mute":     `<g fill="{c}"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"/></g>`,
  "source-toggle":  `<g fill="none" stroke="{c}" stroke-width="2"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="3"/></g>`,
  "view-force":     `<g fill="none" stroke="{c}" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M12 10v10"/></g>`,
  "save-replay":    `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></g>`,
  "replay-buffer":  `<g><circle cx="12" cy="12" r="9" fill="none" stroke="{c}" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="{c}"/></g>`,
  "ad-break":       `<text x="12" y="17" font-family="Segoe UI, Arial" font-size="13" font-weight="800" text-anchor="middle" fill="{c}">AD</text>`,
  "overlay-toggle": `<g fill="none" stroke="{c}" stroke-width="2" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5" opacity=".55"/></g>`,
  "twitch-clip":    `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><circle cx="6.5" cy="7" r="2.5"/><circle cx="6.5" cy="17" r="2.5"/><path d="M8.6 8.5L20 17M8.6 15.5L20 7"/></g>`,
  "twitch-marker":  `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4a1 1 0 0 1 1-1h11l-3.5 5L18 13H7"/></g>`,
  "desk-topic":     `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><path d="M4 6h10M4 12h10M4 18h10"/><path d="M17 9l4 3-4 3"/></g>`,
  "run-of-show":    `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><path d="M4 5h16M4 11h9M4 17h9"/><path d="M16 14l5 3-5 3z" fill="{c}"/></g>`,
  "countdown-controls": `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/><path d="M19 4l2 2"/></g>`,
  "output-control": `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.5" fill="{c}"/><path d="M8.2 7.8a6 6 0 0 0 0 8.4M15.8 7.8a6 6 0 0 1 0 8.4M5.2 4.8a10 10 0 0 0 0 14.4M18.8 4.8a10 10 0 0 1 0 14.4"/></g>`
};

// Actions whose lit state means "warning" (muted mic) light red instead of green.
const RED_ON = new Set(["audio-mute", "output-control"]);

const svg = (size, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${inner}</svg>`;

const keySvg = (glyph, color, ring) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
  `<rect width="72" height="72" rx="12" fill="#16181f"/>` +
  (ring ? `<rect x="2" y="2" width="68" height="68" rx="10" fill="none" stroke="${ring}" stroke-width="3"/>` : "") +
  `<g transform="translate(18,14) scale(1.5)">${glyph.replaceAll("{c}", color)}</g>` +
  `</svg>`;

for (const [slug, glyph] of Object.entries(GLYPHS)) {
  const dir = join(OUT, "actions", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "icon.svg"), svg(20, glyph.replaceAll("{c}", "#ffffff")));
  writeFileSync(join(dir, "key.svg"), keySvg(glyph, "#8b93a7", null));
  const onColor = RED_ON.has(slug) ? "#ef4444" : "#22c55e";
  writeFileSync(join(dir, "key-on.svg"), keySvg(glyph, onColor, onColor));
}

mkdirSync(join(OUT, "plugin"), { recursive: true });
writeFileSync(
  join(OUT, "plugin", "category-icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24">` +
  `<g fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round">` +
  `<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M7 21h10"/><path d="M12 17v4"/>` +
  `</g><circle cx="18" cy="8" r="2" fill="#ffffff"/></svg>`
);

console.log("icons written");
