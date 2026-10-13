/*
  match-title.js — one title template for the stream title, VOD file names and the recordings log.

  A template is plain text with {placeholders}:
    {event} {round} {team1} {team2} {score} {bestof} {game} {maps} {date} {time}
  ({p1}/{p2} are accepted as aliases of {team1}/{team2}, so an FGC organiser's habit still works.)

  An empty placeholder must never leave debris behind — a match with no round should not read
  "Event  - A vs B", and no characters should not read "A () vs B ()". tidyTitle() removes empty
  brackets, collapses whitespace and drops separators that end up doubled or dangling at an edge.

  Pure helpers only; server.js owns state, timers and the Twitch / OBS side effects.
*/

'use strict';

const FIELDS = ['event', 'round', 'team1', 'team2', 'score', 'bestof', 'game', 'maps', 'date', 'time'];
const ALIASES = { p1: 'team1', p2: 'team2', bo: 'bestof' };

const DEFAULT_TWITCH_TEMPLATE = '{event} | {round}: {team1} vs {team2}';
const DEFAULT_VOD_TEMPLATE = '{event} {round} - {team1} vs {team2}';
const TWITCH_TITLE_MAX = 140;   // Helix rejects longer titles

function fillTemplate(template, fields) {
  const f = fields || {};
  return String(template || '').replace(/\{(\w+)\}/g, (whole, key) => {
    const k = ALIASES[key.toLowerCase()] || key.toLowerCase();
    if (!FIELDS.includes(k)) return whole;            // unknown placeholder: leave it visible so it gets noticed
    const v = f[k];
    return v == null ? '' : String(v).trim();
  });
}

// Separators a template may join parts with. Order matters only for readability.
const SEP = '(?:-|–|—|\\||:|•|·|,|/)';

function tidyTitle(s) {
  let t = String(s || '');
  t = t.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '');                    // empty brackets
  t = t.replace(/\s+/g, ' ');
  // "A vs " / " vs B" / " vs " with a missing side — drop the "vs" itself.
  t = t.replace(/(^|\s)vs\.?(?=\s*(?:$|[-–—|:•·,/]))/gi, '$1').replace(/(^|[-–—|:•·,/])\s*vs\.?\s/gi, '$1 ');
  let prev;
  do {
    prev = t;
    t = t.replace(new RegExp('\\s*(' + SEP + ')\\s*' + SEP + '\\s*', 'g'), ' $1 ');   // doubled separators: keep the first
    t = t.replace(new RegExp('^\\s*' + SEP + '\\s*'), '');                           // leading
    t = t.replace(new RegExp('\\s*' + SEP + '\\s*$'), '');                           // trailing
    t = t.replace(/\s+([:,])/g, '$1').replace(/\s+/g, ' ').trim();
  } while (t !== prev);
  return t;
}

// ── Round names ────────────────────────────────────────────────────────────────
// start.gg says "Winners Quarter-Final", the overlay label is upper-cased, a producer types
// "LOSERS SEMIS". Titles read better as "Winners Quarters" — the VGBootCamp convention.
const ROUND_RULES = [
  [/\bgrand\s*finals?\s*(?:-\s*)?reset\b/i, 'Grand Finals Reset'],
  [/\bgrand\s*finals?\b/i, 'Grand Finals'],
  [/\bquarter[\s-]*finals?\b/i, 'Quarters'],
  [/\bsemi[\s-]*finals?\b/i, 'Semis'],
  [/\bfinals?\b/i, 'Finals']
];
const KEEP_UPPER = /^(?:lcq|gf|wf|lf|ws|ls|wq|lq|ro\d+|top\d+|bo\d+|ft\d+|[a-z]\d+|\d+[a-z]?)$/i;

function titleCaseWord(w) {
  if (!w) return w;
  if (KEEP_UPPER.test(w)) return /^(?:ro|top|bo|ft)\d+$/i.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toUpperCase();
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function normalizeRound(text) {
  let t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  // Only re-case text that is shouting (all caps) or all lower — a producer's own "LCQ Day 2" stays.
  if (t === t.toUpperCase() || t === t.toLowerCase()) t = t.split(' ').map(titleCaseWord).join(' ');
  for (const [re, rep] of ROUND_RULES) {
    if (re.test(t)) { t = t.replace(re, rep); break; }
  }
  return t;
}

// "TSM | Leffen" → "Leffen". start.gg puts the sponsor/org prefix in front of a singles tag.
function stripSponsor(name) {
  const s = String(name || '').trim();
  const m = s.match(/^[^|]{1,24}?\s*\|\s*(.+)$/);
  return m && m[1].trim() ? m[1].trim() : s;
}

// ── File names ────────────────────────────────────────────────────────────────
function sanitizeFilename(s, max) {
  let t = String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.slice(0, max || 180).replace(/[. ]+$/g, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t = '_' + t;
  return t;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function localDate(d) { d = d || new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function localTime(d) { d = d || new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

/*
  Build the field set from the live app state. `gameName` is the active game's display name.
  Team names: syncStartGgSet keeps start.gg's original casing on team.nameRaw — the on-air name is
  upper-cased for the overlays, which reads like shouting in a title. A producer who has since
  edited the name gets their edit (nameRaw no longer matches it).
*/
function matchFields(state, opts) {
  const o = opts || {};
  const st = state || {};
  const teams = st.teams || {};
  const teamName = (side) => {
    const t = teams[side] || {};
    const shown = String(t.name || '').trim();
    const raw = String(t.nameRaw || '').trim();
    let n = raw && raw.toUpperCase() === shown.toUpperCase() ? raw : shown;
    if (/^(tbd|blue team|orange team)$/i.test(n)) n = /^tbd$/i.test(n) ? 'TBD' : '';
    return o.stripSponsors === false ? n : stripSponsor(n);
  };
  const ser = st.series || {};
  const maps = ((st.match && st.match.maps) || [])
    .filter((m) => m && m.name && (m.played || m.scoreA || m.scoreB))
    .map((m) => String(m.name).trim()).filter(Boolean);
  const bo = Number(st.bestOf) || 0;
  const now = o.now ? new Date(o.now) : new Date();
  return {
    event: String(st.eventName || '').trim(),
    round: normalizeRound(st.roundLabel),
    team1: teamName('blue'),
    team2: teamName('orange'),
    score: `${Number(ser.blue) || 0}-${Number(ser.orange) || 0}`,
    bestof: bo > 0 ? `Bo${bo}` : '',
    game: String(o.gameName || '').trim(),
    maps: maps.join(', '),
    date: localDate(now),
    time: localTime(now)
  };
}

function buildTitle(template, fields, max) {
  const t = tidyTitle(fillTemplate(template, fields));
  if (!max || t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, '').trim() + '…';
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const CSV_HEADER = ['Date', 'Time', 'Event', 'Game', 'Round', 'Team 1', 'Team 2', 'Score', 'Best Of', 'Maps', 'Duration', 'Title', 'Filename'];

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
}

// One recordings-log row, in CSV_HEADER order.
function rowCells(entry) {
  const f = entry.fields || {};
  return [f.date, f.time, f.event, f.game, f.round, f.team1, f.team2, f.score, f.bestof, f.maps,
    formatDuration(entry.durationSec), entry.title, entry.filename].map((v) => String(v == null ? '' : v));
}
function csvRow(entry) { return rowCells(entry).map(csvCell).join(','); }
// Tab-separated, for pasting a row straight into a spreadsheet (a stream worksheet).
function tsvRow(entry) { return rowCells(entry).map((v) => v.replace(/[\t\r\n]+/g, ' ')).join('\t'); }

module.exports = {
  FIELDS, DEFAULT_TWITCH_TEMPLATE, DEFAULT_VOD_TEMPLATE, TWITCH_TITLE_MAX, CSV_HEADER,
  fillTemplate, tidyTitle, normalizeRound, stripSponsor, sanitizeFilename,
  matchFields, buildTitle, csvCell, csvRow, tsvRow, rowCells, formatDuration, localDate, localTime
};
