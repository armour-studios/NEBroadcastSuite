// Competition data sources — the I/O half of backend/competition.js.
//
// Two pull sources, both turned into an ne-competition document:
//   sheet — a Google Sheet with Teams / Matches / Standings tabs. Read through the Sheets API when a
//           service account is connected (works on private sheets), otherwise through Google's
//           public CSV export (the sheet must be shared "Anyone with the link — Viewer").
//   feed  — any URL returning an ne-competition JSON document (or a CSV), optionally behind a bearer
//           token. This is the path for a league website: publish one JSON endpoint, the app polls it.
//
// Electron 18 ships Node 16, which has no global fetch — hence the small https helper.
'use strict';
const http = require('http');
const https = require('https');
const C = require('./competition.js');

const MAX_BYTES = 5 * 1024 * 1024;

function fetchText(urlStr, { headers = {}, timeoutMs = 15000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('That is not a valid URL.')); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('Only http(s) URLs are supported.'));
    const lib = u.protocol === 'https:' ? https : http;
    const rq = lib.request({ method: 'GET', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      headers: { 'User-Agent': 'NE-Broadcast-Suite', Accept: 'application/json, text/csv;q=0.9, */*;q=0.5', ...headers } }, (rs) => {
      if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location) {
        rs.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects.'));
        const next = new URL(rs.headers.location, u).toString();
        return resolve(fetchText(next, { headers, timeoutMs, redirects: redirects - 1 }));
      }
      let size = 0; const chunks = [];
      rs.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { rq.destroy(new Error('Response is larger than 5 MB.')); return; }
        chunks.push(c);
      });
      rs.on('end', () => resolve({ status: rs.statusCode, headers: rs.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    rq.on('error', (e) => reject(new Error(e.code === 'ENOTFOUND' ? 'Could not reach ' + u.hostname + '.' : e.message)));
    rq.setTimeout(timeoutMs, () => rq.destroy(new Error('The request timed out.')));
    rq.end();
  });
}

// ── Google Sheets ────────────────────────────────────────────────────────────
function sheetIdFrom(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : '';
}

// Public CSV export of one tab by NAME. ⚠ Google answers a missing tab name with the FIRST tab
// instead of an error, so callers must check the headers look like the tab they asked for.
async function readPublicTab(sheetId, tab) {
  const url = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(tab);
  const r = await fetchText(url);
  const type = String(r.headers['content-type'] || '');
  if (r.status === 401 || r.status === 403 || /text\/html/.test(type)) {
    throw new Error('Google would not share this sheet. Set General access to "Anyone with the link" (Viewer), or connect a service account in Settings ▸ Google Sheets.');
  }
  if (r.status === 404) throw new Error('No spreadsheet at that link.');
  if (r.status !== 200) throw new Error('Google Sheets answered ' + r.status + '.');
  return C.parseCsv(r.text);
}

const hasAny = (objs, names) => objs.length > 0 && names.some((n) => n in objs[0]);

/**
 * Read a league sheet. tabs = { teams, matches, standings } (tab names; blank = skip).
 * sheets/sa are the existing Sheets API client + service account (optional).
 * Returns { doc, tabsRead: { teams, matches, standings }, warnings }.
 */
async function readSheet({ sheetUrl, tabs = {}, sheets = null, sa = null }) {
  const sheetId = sheetIdFrom(sheetUrl);
  if (!sheetId) throw new Error('Paste the Google Sheet link (the one with /spreadsheets/d/…).');
  const warnings = [];
  const read = async (tab) => {
    if (!tab) return null;
    try {
      const rows = sa && sheets ? await sheets.readTab(sa, sheetId, tab) : await readPublicTab(sheetId, tab);
      return C.rowsToObjects(rows);
    } catch (e) {
      // A private sheet fails the same way on every tab — surface that once, as the error.
      if (/would not share|No spreadsheet|service-account|sign/i.test(e.message)) throw e;
      warnings.push('Tab "' + tab + '": ' + e.message);
      return null;
    }
  };
  const [teamRows, matchRows, standingRows] = await Promise.all([read(tabs.teams), read(tabs.matches), read(tabs.standings)]);
  // Header checks guard the "missing tab silently returns the first tab" behaviour above, and stop
  // a mistyped tab name from being read as an empty schedule (which would prune every fixture).
  const teamCols = ['team', 'name', 'team name', 'school', 'organization', 'org', 'club'];
  const tabsRead = {
    teams: !!(teamRows && hasAny(teamRows, teamCols)),
    matches: !!(matchRows && matchRows.length && hasAny(matchRows, ['team a', 'home', 'team 1', 'teama', 'home team', 'player 1', 'blue'])),
    standings: !!(standingRows && standingRows.length && hasAny(standingRows, ['w', 'wins', 'pts', 'points'])),
  };
  if (tabs.teams && teamRows && !tabsRead.teams) warnings.push('Tab "' + tabs.teams + '" has no Team column — skipped.');
  if (tabs.matches && matchRows && matchRows.length && !tabsRead.matches) warnings.push('Tab "' + tabs.matches + '" has no Team A / Team B columns — skipped (check the tab name).');
  if (tabs.standings && standingRows && standingRows.length && !tabsRead.standings) warnings.push('Tab "' + tabs.standings + '" has no W / Points columns — skipped.');
  const doc = C.tablesToDoc({
    teams: tabsRead.teams ? teamRows : [],
    matches: tabsRead.matches ? matchRows : [],
    standings: tabsRead.standings ? standingRows : [],
  });
  if (!tabsRead.matches) delete doc.matches;   // "no matches tab" must never read as "zero matches"
  return { doc, tabsRead, warnings };
}

// ── JSON / CSV feed ─────────────────────────────────────────────────────────
async function readFeed({ url, token = '', etag = '' }) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (etag) headers['If-None-Match'] = etag;
  const r = await fetchText(url, { headers });
  if (r.status === 304) return { notModified: true, etag };
  if (r.status === 401 || r.status === 403) throw new Error('The feed refused the request (' + r.status + ') — check the access token.');
  if (r.status !== 200) throw new Error('The feed answered ' + r.status + '.');
  const type = String(r.headers['content-type'] || '');
  const body = r.text.trim();
  let raw;
  if (/csv/.test(type) || (!/json/.test(type) && body && body[0] !== '{')) {
    const out = C.csvToDoc(body);
    if (!out.doc) throw new Error(out.error);
    raw = out.doc;
  } else {
    try { raw = JSON.parse(body); } catch (e) { throw new Error('The feed did not return valid JSON: ' + e.message); }
  }
  return { raw, etag: r.headers.etag || '' };
}

// ── First-time link: find the tabs + a name ────────────────────────────────
// Organisers name tabs differently ("Schedule", "Fixtures", "Table"). Used once, when a producer
// pastes a sheet link, so they don't have to type tab names before seeing anything happen.
const TAB_CANDIDATES = {
  teams: ['Teams', 'Roster', 'Rosters', 'Team List', 'Participants'],
  matches: ['Matches', 'Schedule', 'Fixtures', 'Games', 'Results', 'Matchups'],
  standings: ['Standings', 'Table', 'Rankings', 'Leaderboard'],
};
const TAB_HEADS = {
  teams: ['team', 'name', 'team name', 'school', 'organization', 'org', 'club'],
  matches: ['team a', 'home', 'team 1', 'teama', 'home team', 'player 1', 'blue'],
  standings: ['w', 'wins', 'pts', 'points'],
};
async function detectSheet({ sheetUrl, sheets = null, sa = null }) {
  const sheetId = sheetIdFrom(sheetUrl);
  if (!sheetId) throw new Error('Paste the Google Sheet link (the one with /spreadsheets/d/…).');
  let title = '';
  let realTabs = null;
  if (sa && sheets) {
    const meta = await sheets.getMeta(sa, sheetId);
    title = meta.title || '';
    realTabs = meta.tabs || [];
  } else {
    // Public sheets: the page title carries the spreadsheet name. Best effort only.
    try {
      const r = await fetchText('https://docs.google.com/spreadsheets/d/' + sheetId + '/edit', { timeoutMs: 8000 });
      const m = r.status === 200 && r.text.match(/<title>([^<]*?)\s*-\s*Google (?:Sheets|Tabellen|Hojas de cálculo)[^<]*<\/title>/i);
      if (m) title = m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    } catch (_) { /* no title — the caller falls back to a generic name */ }
  }
  const tabs = { teams: '', matches: '', standings: '' };
  for (const kind of Object.keys(TAB_CANDIDATES)) {
    // With the real tab list, match case-insensitively without any fetch; otherwise probe each
    // candidate and keep the first whose headers look right (a missing tab returns the FIRST tab).
    const names = realTabs
      ? TAB_CANDIDATES[kind].map((c) => realTabs.find((t) => t.trim().toLowerCase() === c.toLowerCase())).filter(Boolean)
      : TAB_CANDIDATES[kind];
    for (const name of names) {
      try {
        const rows = sa && sheets ? await sheets.readTab(sa, sheetId, name) : await readPublicTab(sheetId, name);
        const objs = C.rowsToObjects(rows);
        if (objs.length && hasAny(objs, TAB_HEADS[kind])) { tabs[kind] = name; break; }
      } catch (e) {
        if (/would not share|No spreadsheet/i.test(e.message)) throw e;
      }
    }
  }
  return { sheetId, title, tabs };
}

module.exports = { fetchText, sheetIdFrom, readSheet, readFeed, detectSheet };
