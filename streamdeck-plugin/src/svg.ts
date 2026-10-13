/** Runtime key renderer: every key draws as a consistent 72x72 tile (glyph, label,
 *  optional sub-line and on-air pill). Rendered once per actual change — the base
 *  class diffs the data URI, so identical frames never re-push (no flashing). */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const trunc = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Glyphs drawn in a 24x24 box; "{c}" is replaced with the tile's glyph colour. */
export const GLYPHS: Record<string, string> = {
  "adjust-score":   `<text x="12" y="17" font-family="Segoe UI, Arial" font-size="14" font-weight="800" text-anchor="middle" fill="{c}">+1</text>`,
  "set-score":      `<text x="12" y="17" font-family="Segoe UI, Arial" font-size="14" font-weight="800" text-anchor="middle" fill="{c}">=N</text>`,
  "series-control": `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><path d="M19 12a7 7 0 1 1-2-4.9"/><path d="M17 3v4h-4"/></g>`,
  "swap":           `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><path d="M4 8h13M14 4l4 4-4 4"/><path d="M20 16H7M10 12l-4 4 4 4"/></g>`,
  "plus":           `<text x="12" y="18" font-family="Segoe UI, Arial" font-size="17" font-weight="800" text-anchor="middle" fill="{c}">+</text>`,
  "minus":          `<text x="12" y="17" font-family="Segoe UI, Arial" font-size="17" font-weight="800" text-anchor="middle" fill="{c}">-</text>`,
  "select-team":    `<g fill="{c}"><circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5z"/><circle cx="17" cy="8" r="2.4" opacity=".55"/><path d="M14.8 13.4c.6-.2 1.4-.4 2.2-.4 2.4 0 4.5 1.6 4.5 4h-5" opacity=".55"/></g>`,
  "gfx-onair":      `<path fill="{c}" d="M12 2l2.4 6.9L21 11l-6.6 2.1L12 20l-2.4-6.9L3 11l6.6-2.1z"/>`,
  "clear-gfx":      `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/></g>`,
  "switch-scene":   `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></g>`,
  "fire-flow":      `<path fill="{c}" d="M13 2L5 14h5l-1.5 8L19 9h-5.5z"/>`,
  "break-countdown":`<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/></g>`,
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
  "output-control": `<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.5" fill="{c}"/><path d="M8.2 7.8a6 6 0 0 0 0 8.4M15.8 7.8a6 6 0 0 1 0 8.4M5.2 4.8a10 10 0 0 0 0 14.4M18.8 4.8a10 10 0 0 1 0 14.4"/></g>`,
  "offline":        `<g stroke="{c}" stroke-width="4" stroke-linecap="round" fill="none"><path d="M26 46 46 26"/><path d="M30 26h-8v8"/><path d="M42 46h8v-8"/></g>`
};

export interface TileOpts {
  glyph: string;          // key into GLYPHS
  label?: string;         // main line (bottom)
  sub?: string;           // dim second line
  accent?: string;        // ring/pill/glyph colour while on (default green)
  on?: boolean;           // lit state: accent ring + pill
  pill?: string;          // pill text shown while on (e.g. LIVE, ON AIR, MUTED)
}

export function tile(o: TileOpts): string {
  const accent = o.accent || "#22c55e";
  const glyphColor = o.on ? accent : "#8b93a7";
  const glyph = (GLYPHS[o.glyph] || GLYPHS["gfx-onair"]).replaceAll("{c}", glyphColor);
  const labelY = o.sub ? 52 : 57;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<rect width="72" height="72" rx="12" fill="#16181f"/>` +
    (o.on ? `<rect x="1.5" y="1.5" width="69" height="69" rx="10.5" fill="none" stroke="${accent}" stroke-width="3"/>` : "") +
    `<g transform="translate(21,7) scale(1.25)">${glyph}</g>` +
    (o.on && o.pill
      ? `<rect x="36" y="5" width="31" height="12" rx="6" fill="${accent}"/>` +
        `<text x="51.5" y="13.5" font-family="Segoe UI, Arial" font-size="7" font-weight="800" fill="#0b0d12" text-anchor="middle">${esc(o.pill)}</text>`
      : "") +
    (o.label
      ? `<text x="36" y="${labelY}" font-family="Segoe UI, Arial" font-size="11" font-weight="600" fill="#e6e9f0" text-anchor="middle">${esc(trunc(o.label, 11))}</text>`
      : "") +
    (o.sub
      ? `<text x="36" y="64" font-family="Segoe UI, Arial" font-size="8.5" font-weight="600" fill="#79808f" text-anchor="middle">${esc(trunc(o.sub, 14))}</text>`
      : "") +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Score tiles: team-coloured bar, name, big number, corner badge. */
export function scoreKeySvg(opts: { color: string; name: string; value: string; badge: string }): string {
  const name = esc(trunc(opts.name, 9));
  const color = /^#[0-9a-fA-F]{6}$/.test(opts.color) ? opts.color : "#3b82f6";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<rect width="72" height="72" rx="12" fill="#16181f"/>` +
    `<rect x="8" y="8" width="56" height="5" rx="2.5" fill="${color}"/>` +
    `<text x="36" y="27" font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="600" fill="#c8cdd8" text-anchor="middle">${name}</text>` +
    `<text x="36" y="56" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="800" fill="#ffffff" text-anchor="middle">${esc(opts.value)}</text>` +
    `<text x="63" y="66" font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="700" fill="${color}" text-anchor="end">${esc(opts.badge)}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Clock text: "auto" = m:ss, hours only when needed; "hms" = always h:mm:ss; "ms" = total-minutes:ss. */
export function fmtClock(totalSec: number, format?: string): string {
  const s = Math.max(0, Math.round(totalSec));
  const two = (n: number) => String(n).padStart(2, "0");
  if (format === "hms") return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  if (format === "ms") return `${Math.floor(s / 60)}:${two(s % 60)}`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** Flexible duration input → seconds. Accepts "300" (seconds), "5:00", "1:30:00",
 *  and unit forms like "5m", "90s", "2m30s", "1h10m". Falls back to dflt. */
export function parseDuration(v: unknown, dflt: number): number {
  if (v == null || v === "") return dflt;
  const s = String(v).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(1, Math.round(parseFloat(s)));
  const colon = s.match(/^(?:(\d+):)?(\d+):(\d{1,2})$/);
  if (colon) {
    return Math.max(1, (parseInt(colon[1] || "0", 10) * 3600) + (parseInt(colon[2], 10) * 60) + parseInt(colon[3], 10));
  }
  let total = 0, matched = false, m: RegExpExecArray | null;
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s)/g;
  while ((m = re.exec(s))) { matched = true; total += parseFloat(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1); }
  return matched ? Math.max(1, Math.round(total)) : dflt;
}

/** Word-wrap text tile: up to 3 centred lines of text + a dim sub line. Used by
 *  keys whose payload IS text (headline cycler) — the words are the display. */
export function textKeySvg(opts: { text: string; sub: string; on: boolean; accent?: string }): string {
  const accent = opts.accent || "#f59e0b";
  const words = opts.text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + " " + w).length <= 12) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  const shown = lines.slice(0, 3);
  const startY = 30 - (shown.length - 1) * 6.5;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<rect width="72" height="72" rx="12" fill="#16181f"/>` +
    (opts.on ? `<rect x="1.5" y="1.5" width="69" height="69" rx="10.5" fill="none" stroke="${accent}" stroke-width="3"/>` : "") +
    shown.map((l, i) =>
      `<text x="36" y="${startY + i * 13}" font-family="Segoe UI, Arial, sans-serif" font-size="10.5" font-weight="800" fill="${opts.on ? "#ffffff" : "#c8cdd8"}" text-anchor="middle">${esc(trunc(l, 13))}</text>`
    ).join("") +
    `<text x="36" y="64" font-family="Segoe UI, Arial, sans-serif" font-size="8" font-weight="600" fill="#79808f" text-anchor="middle">${esc(trunc(opts.sub, 16))}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Countdown tile: big mm:ss clock, title underneath, lit ring while running. */
export function clockKeySvg(opts: { value: string; sub: string; on: boolean; accent?: string }): string {
  const accent = opts.accent || "#f59e0b";
  const size = opts.value.length > 5 ? 20 : 26;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<rect width="72" height="72" rx="12" fill="#16181f"/>` +
    (opts.on ? `<rect x="1.5" y="1.5" width="69" height="69" rx="10.5" fill="none" stroke="${accent}" stroke-width="3"/>` : "") +
    `<g transform="translate(26,6) scale(0.85)">${GLYPHS["break-countdown"].replaceAll("{c}", opts.on ? accent : "#8b93a7")}</g>` +
    `<text x="36" y="47" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="800" fill="${opts.on ? "#ffffff" : "#c8cdd8"}" text-anchor="middle">${esc(opts.value)}</text>` +
    `<text x="36" y="64" font-family="Segoe UI, Arial, sans-serif" font-size="8.5" font-weight="600" fill="#79808f" text-anchor="middle">${esc(trunc(opts.sub, 14))}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Grey "unplugged" tile shown while the suite is unreachable. */
export const OFFLINE_IMAGE =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">` +
    `<rect width="72" height="72" rx="12" fill="#16181f"/>` +
    GLYPHS["offline"].replaceAll("{c}", "#4a5061") +
    `<text x="36" y="64" font-family="Segoe UI, Arial" font-size="8.5" font-weight="600" fill="#4a5061" text-anchor="middle">SUITE OFFLINE</text>` +
    `</svg>`
  );
