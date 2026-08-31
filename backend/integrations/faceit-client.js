'use strict';

// FACEIT Data API v4 client — https://open.faceit.com/data/v4
//
// Auth is a SERVER-SIDE api key issued at developers.faceit.com (Apps ▸ your app ▸ API keys),
// sent as a plain bearer token. There is no OAuth handshake for read-only competition data, so
// this is a paste-a-key integration exactly like NXGEN and Challonge.
//
// Two competition kinds carry matches and both are supported, because organisers use them
// interchangeably: CHAMPIONSHIPS (a tournament with a bracket/stages) and HUBS (a rolling ladder).
// The endpoints differ only in their path prefix, so everything downstream shares one shape.

const https = require('https');

const FACEIT_BASE = 'https://open.faceit.com/data/v4';

function faceitGet(apiKey, path) {
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error('FACEIT API key not configured — add it in Settings → Integrations.'));
    const url = new URL(FACEIT_BASE + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json',
        'User-Agent': 'BroadcastStudio/1.0'
      }
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('FACEIT rejected the API key — check it in Settings → Integrations (it must be a SERVER-side key).'));
        }
        if (res.statusCode === 404) return reject(new Error('Not found on FACEIT — check the championship/hub ID.'));
        if (res.statusCode === 429) return reject(new Error('FACEIT rate limit exceeded — retry in a moment.'));
        if (res.statusCode >= 400) {
          let msg = `HTTP ${res.statusCode}`;
          try {
            const j = JSON.parse(body);
            msg = j.message || (Array.isArray(j.errors) && j.errors[0] && j.errors[0].message) || j.error || msg;
          } catch {}
          return reject(new Error('FACEIT: ' + msg));
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON from FACEIT API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('FACEIT API request timed out')); });
    req.end();
  });
}

// Stable identity for a paged item, so a list that shifts under us mid-walk can't duplicate rows.
function faceitItemKey(it) {
  if (!it || typeof it !== 'object') return null;
  return it.match_id || it.subscription_id || it.championship_id || it.hub_id
      || (it.team && it.team.team_id) || it.team_id || it.user_id || it.player_id || null;
}

// Every list endpoint is offset/limit paged. Walk the WHOLE list — the bracket needs every round
// and the team import needs every entrant.
//
// The trap: FACEIT clamps `limit` per endpoint, and it does it SILENTLY. Ask a subscriptions or
// matches endpoint for 100 and it may hand back 20 with no error and no indication it capped you.
// That breaks the two obvious paging idioms in opposite directions:
//   • stopping when `batch.length < limit` quits after the FIRST page (20 of 128 teams imported),
//   • advancing the offset by the REQUESTED limit skips whole pages of results.
// So: advance by however many items actually came back, and stop only on an empty page.
async function faceitPaged(apiKey, path, { limit = 100, maxItems = 3000, maxRequests = 60 } = {}) {
  const items = [];
  const seen = new Set();
  const joiner = path.includes('?') ? '&' : '?';
  let offset = 0;
  for (let req = 0; req < maxRequests; req++) {
    const data = await faceitGet(apiKey, `${path}${joiner}offset=${offset}&limit=${limit}`);
    const batch = Array.isArray(data.items) ? data.items : [];
    if (!batch.length) break;
    let added = 0;
    for (const it of batch) {
      const key = faceitItemKey(it);
      if (key) { if (seen.has(key)) continue; seen.add(key); }
      items.push(it);
      added++;
    }
    offset += batch.length;
    if (items.length >= maxItems) break;
    // An endpoint that ignores `offset` would otherwise spin here re-reading page one forever.
    if (!added) break;
  }
  return items;
}

// FACEIT ships faceit_url with a literal "{lang}" placeholder — pasting that straight into an
// href gives the producer a dead link, so bake the language in.
function faceitUrl(u, lang = 'en') {
  return typeof u === 'string' ? u.replace('{lang}', lang) : '';
}

// A producer will paste the browser URL, not a bare UUID. Accept both, plus the /hub/ form, and
// report WHICH kind it is so the caller hits the right endpoint family.
//   https://www.faceit.com/en/championship/<uuid>/<name>/...
//   https://www.faceit.com/en/cs2/hub/<uuid>/<name>
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function parseFaceitCompetition(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const id = (raw.match(UUID_RE) || [])[0] || '';
  if (!id) return null;
  let type = 'championship';
  if (/\/hub\//.test(lower)) type = 'hub';
  else if (/\/championship/.test(lower)) type = 'championship';
  return { id: id.toLowerCase(), type };
}

// ── Championships ────────────────────────────────────────────────────────────

async function searchFaceitChampionships(apiKey, { name = '', game = '', region = '', type = 'all', limit = 30 } = {}) {
  const qs = new URLSearchParams();
  if (name) qs.set('name', name);
  if (game) qs.set('game', game);
  if (region) qs.set('region', region);
  if (type) qs.set('type', type);
  qs.set('offset', '0');
  qs.set('limit', String(Math.min(50, Math.max(1, limit))));
  const data = await faceitGet(apiKey, '/search/championships?' + qs.toString());
  return Array.isArray(data.items) ? data.items : [];
}

async function getFaceitChampionship(apiKey, id) {
  return faceitGet(apiKey, `/championships/${encodeURIComponent(id)}?expanded=organizer,game`);
}

async function getFaceitChampionshipMatches(apiKey, id, type = 'all') {
  return faceitPaged(apiKey, `/championships/${encodeURIComponent(id)}/matches?type=${encodeURIComponent(type)}`);
}

// One team's full record — crest + members. Used to backfill entrants whose subscription and
// match rows both came back without an avatar or a roster.
async function getFaceitTeam(apiKey, teamId) {
  return faceitGet(apiKey, `/teams/${encodeURIComponent(teamId)}`);
}

async function getFaceitChampionshipSubscriptions(apiKey, id) {
  return faceitPaged(apiKey, `/championships/${encodeURIComponent(id)}/subscriptions`);
}

async function getFaceitChampionshipResults(apiKey, id) {
  // Only league/swiss-style championships expose results; a plain bracket 404s or returns empty.
  // Standings are a nice-to-have, never a reason to fail the whole import.
  try { return await faceitPaged(apiKey, `/championships/${encodeURIComponent(id)}/results`, { maxItems: 500 }); }
  catch { return []; }
}

// ── Hubs ─────────────────────────────────────────────────────────────────────

async function getFaceitHub(apiKey, id) {
  return faceitGet(apiKey, `/hubs/${encodeURIComponent(id)}?expanded=organizer,game`);
}

async function getFaceitHubMatches(apiKey, id, type = 'all') {
  return faceitPaged(apiKey, `/hubs/${encodeURIComponent(id)}/matches?type=${encodeURIComponent(type)}`);
}

// Hubs have members (players), not team subscriptions — team names come off the matches instead.
async function getFaceitHubMembers(apiKey, id) {
  try { return await faceitPaged(apiKey, `/hubs/${encodeURIComponent(id)}/members`, { maxItems: 500 }); }
  catch { return []; }
}

// ── Organizers (the "my events" analogue — an org's own championships/hubs) ───

async function getFaceitOrganizerByName(apiKey, name) {
  return faceitGet(apiKey, '/organizers?name=' + encodeURIComponent(name));
}

async function getFaceitOrganizer(apiKey, id) {
  return faceitGet(apiKey, `/organizers/${encodeURIComponent(id)}`);
}

async function getFaceitOrganizerChampionships(apiKey, id) {
  return faceitPaged(apiKey, `/organizers/${encodeURIComponent(id)}/championships`, { maxItems: 300 });
}

async function getFaceitOrganizerHubs(apiKey, id) {
  try { return await faceitPaged(apiKey, `/organizers/${encodeURIComponent(id)}/hubs`, { maxItems: 300 }); }
  catch { return []; }
}

// ── Matches ──────────────────────────────────────────────────────────────────

async function getFaceitMatch(apiKey, matchId) {
  return faceitGet(apiKey, `/matches/${encodeURIComponent(matchId)}`);
}

module.exports = {
  faceitGet,
  faceitUrl,
  parseFaceitCompetition,
  searchFaceitChampionships,
  getFaceitChampionship,
  getFaceitChampionshipMatches,
  getFaceitTeam,
  getFaceitChampionshipSubscriptions,
  getFaceitChampionshipResults,
  getFaceitHub,
  getFaceitHubMatches,
  getFaceitHubMembers,
  getFaceitOrganizerByName,
  getFaceitOrganizer,
  getFaceitOrganizerChampionships,
  getFaceitOrganizerHubs,
  getFaceitMatch
};
