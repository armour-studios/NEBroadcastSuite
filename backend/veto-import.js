'use strict';
// ── Map veto import: FACEIT room / HLTV match link → a finished pick/ban board ──────────────────
// Paste a match link and the veto comes in as it was played: teams (with logos), best-of, every
// ban and pick in order, and the decider. The producer applies it instead of clicking seven maps.
//
//   FACEIT  https://www.faceit.com/en/cs2/room/1-xxxx…   (also /csgo/room/, trailing /scoreboard)
//           Official data API (needs the key from Settings → Integrations) gives teams, best-of and
//           the picked maps. The order of bans comes from the match room's voting history, which
//           is the same public endpoint the room page itself reads; without it the picks still
//           come through and the bans are left blank.
//   HLTV    https://www.hltv.org/matches/1234567/team-a-vs-team-b-event
//           No API, and Cloudflare blocks every automated fetch (plain request, a hidden or even a
//           visible Electron 18 window, reader proxies — all tried 2026-10-11). The page's veto box
//           ("1. Vitality removed Dust2 … 7. Train was left over") is parsed from HTML when a
//           caller can supply it, and otherwise from the TEXT the producer copies off the page and
//           pastes in — the same lines, no network needed.
//
// Pure module: nothing here touches the network or app state. server.js supplies `fetchJson` /
// `fetchHtml` and turns the result into state.veto with vetoLoad().

const https = require('https');

// ── Link parsing ───────────────────────────────────────────────────────────────────────────────
function parseVetoUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (_) { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'faceit.com' || host.endsWith('.faceit.com')) {
    const m = /\/room\/([0-9a-z-]+)/i.exec(u.pathname);
    if (m) return { source: 'faceit', id: m[1], url: u.href };
    return null;
  }
  if (host === 'hltv.org' || host.endsWith('.hltv.org')) {
    const m = /\/matches\/(\d+)/i.exec(u.pathname);
    if (m) return { source: 'hltv', id: m[1], url: u.href };
    return null;
  }
  return null;
}

// "de_mirage" / "Mirage" / "Dust II" / "Dust2" → the pool id ("mirage", "dust2").
function mapIdFromName(name) {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/^(de|cs|ar)_/, '');
  s = s.replace(/\s+ii$/, '2').replace(/\s+2$/, '2');
  s = s.replace(/[^a-z0-9]/g, '');
  if (s === 'dustii') s = 'dust2';
  return s;
}
function prettyMap(name) {
  const id = mapIdFromName(name);
  const KNOWN = { dust2: 'Dust2', mirage: 'Mirage', inferno: 'Inferno', nuke: 'Nuke', ancient: 'Ancient', anubis: 'Anubis', train: 'Train', overpass: 'Overpass', vertigo: 'Vertigo', cache: 'Cache', office: 'Office', italy: 'Italy', basalt: 'Basalt', edin: 'Edin', palais: 'Palais', whistle: 'Whistle' };
  if (KNOWN[id]) return KNOWN[id];
  const raw = String(name || '').replace(/^(de|cs|ar)_/i, '').trim();
  return raw ? raw[0].toUpperCase() + raw.slice(1) : id;
}

// ── FACEIT ─────────────────────────────────────────────────────────────────────────────────────
// Official /matches/{id} shape: teams.faction1/2 {name, avatar}, best_of, voting.map.pick[],
// voting.map.entities[{game_map_id, name, image_lg}]. The unofficial match/v2 payload carries the
// same under payload.teams / payload.voting with bestOf — both are accepted.
function faceitTeams(match) {
  const m = match && match.payload ? match.payload : (match || {});
  const t = m.teams || {};
  const pick = (f) => f ? { name: String(f.name || '').trim(), logo: f.avatar || f.logo || '' } : { name: '', logo: '' };
  return [pick(t.faction1), pick(t.faction2)];
}
function faceitBestOf(match) {
  const m = match && match.payload ? match.payload : (match || {});
  const bo = Number(m.best_of || m.bestOf || 0);
  return [1, 2, 3, 5].includes(bo) ? bo : 0;
}
function faceitEntities(match) {
  const m = match && match.payload ? match.payload : (match || {});
  const ents = (((m.voting || {}).map || {}).entities) || [];
  const out = {};
  ents.forEach((e) => {
    const guid = e.game_map_id || e.guid || e.class_name || '';
    if (guid) out[guid] = { name: e.name || prettyMap(guid), image: e.image_lg || e.image_sm || '' };
  });
  return out;
}
// The room's voting history: tickets[].entities[] in the order they were acted on, each with
// status 'drop' (ban) / 'pick' and selected_by 'faction1' / 'faction2'. Only the map ticket counts.
function faceitStepsFromHistory(history) {
  const h = history && history.payload ? history.payload : (history || {});
  const tickets = Array.isArray(h.tickets) ? h.tickets : [];
  const steps = [];
  tickets.filter((t) => t && (t.entity_type === 'map' || t.entity_type === 'maps')).forEach((t) => {
    (t.entities || []).forEach((e) => {
      const guid = e.guid || e.game_map_id || '';
      if (!guid) return;
      const st = String(e.status || '').toLowerCase();
      const by = e.selected_by === 'faction2' ? 1 : e.selected_by === 'faction1' ? 0 : -1;
      if (st === 'drop' || st === 'ban') steps.push({ map: guid, action: 'ban', by });
      else if (st === 'pick') steps.push({ map: guid, action: e.random || by < 0 ? 'decider' : 'pick', by: by < 0 ? null : by });
    });
  });
  return steps;
}
function importFaceit(match, history) {
  const teams = faceitTeams(match);
  const bestOf = faceitBestOf(match);
  const ents = faceitEntities(match);
  const m = match && match.payload ? match.payload : (match || {});
  const picks = (((m.voting || {}).map || {}).pick) || [];
  let steps = faceitStepsFromHistory(history);
  // History came back empty: fall back to the picked maps alone (no ban order known).
  if (!steps.length) steps = picks.map((guid, i) => ({ map: guid, action: 'pick', by: i % 2 }));
  // A best-of the API did not state: picks + leftover tell it.
  const pickCount = steps.filter((s) => s.action !== 'ban').length;
  const bo = bestOf || (pickCount >= 5 ? 5 : pickCount >= 3 ? 3 : 1);
  // The last pick of a series with an even number of picks is really the leftover (FACEIT shows
  // the decider as a "pick" by nobody or a random pick).
  const out = steps.map((s) => ({
    mapId: mapIdFromName(s.map),
    map: (ents[s.map] && ents[s.map].name) || prettyMap(s.map),
    image: (ents[s.map] && ents[s.map].image) || '',
    action: s.action, by: s.by == null ? null : s.by,
  }));
  return finish({ source: 'faceit', teams, bestOf: bo, steps: out });
}

// ── HLTV ───────────────────────────────────────────────────────────────────────────────────────
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function hltvTeams(html) {
  const names = [];
  const re = /class="teamName"[^>]*>([^<]*)</g;
  let m;
  while ((m = re.exec(html)) && names.length < 2) names.push(stripTags(m[1]));
  const logos = names.map((n) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // <img alt="Vitality" src="…" class="logo"> in either attribute order.
    const r1 = new RegExp('<img[^>]*alt="' + esc + '"[^>]*src="([^"]+)"', 'i');
    const r2 = new RegExp('<img[^>]*src="([^"]+)"[^>]*alt="' + esc + '"', 'i');
    const a = r1.exec(html) || r2.exec(html);
    return a ? a[1] : '';
  });
  return names.map((name, i) => ({ name, logo: logos[i] || '' }));
}
function hltvBestOf(html) {
  const m = /Best of (\d)/i.exec(stripTags((/<div class="padding preformatted-text">([\s\S]*?)<\/div>/.exec(html) || [])[1] || ''))
    || /Best of (\d)/i.exec(html);
  const bo = m ? Number(m[1]) : 0;
  return [1, 2, 3, 5].includes(bo) ? bo : 0;
}
// "1. Vitality removed Dust2" / "3. FaZe picked Mirage" / "7. Train was left over"
function hltvSteps(html, teams) {
  const names = teams.map((t) => t.name);
  const boxes = [];
  const re = /<div class="standard-box veto-box">([\s\S]*?)<\/div>\s*<\/div>/g;
  let m;
  while ((m = re.exec(html))) boxes.push(m[1]);
  const lines = [];
  boxes.forEach((b) => {
    const lr = /<div[^>]*>\s*(\d+)\.\s*([^<]+)/g;   // the last line's closing tag is eaten by the box match
    let x;
    while ((x = lr.exec(b))) lines.push(stripTags(x[2]));
  });
  const steps = [];
  lines.forEach((line) => {
    let r;
    if ((r = /^(.+?) (removed|banned) (.+)$/i.exec(line))) {
      steps.push({ map: r[3], action: 'ban', by: teamIndex(r[1], names) });
    } else if ((r = /^(.+?) picked (.+)$/i.exec(line))) {
      steps.push({ map: r[2], action: 'pick', by: teamIndex(r[1], names) });
    } else if ((r = /^(.+?) was left over$/i.exec(line))) {
      steps.push({ map: r[1], action: 'decider', by: null });
    }
  });
  return steps.map((s) => ({ mapId: mapIdFromName(s.map), map: prettyMap(s.map), image: '', action: s.action, by: s.by }));
}
function teamIndex(name, names) {
  const n = String(name || '').trim().toLowerCase();
  const i = names.findIndex((x) => String(x || '').trim().toLowerCase() === n);
  return i >= 0 ? i : 0;
}
// Played maps with scores (a finished or in-progress match page).
function hltvResults(html) {
  const out = [];
  // Each mapholder runs up to the next one (or the end): HLTV's nesting is not worth matching.
  const parts = html.split(/<div class="mapholder">/).slice(1);
  for (const b of parts) {
    const name = stripTags((/class="mapname">([^<]*)</.exec(b) || [])[1] || '');
    const scores = [];
    const sr = /class="results-team-score">([^<]*)</g;
    let s;
    while ((s = sr.exec(b))) scores.push(Number(stripTags(s[1])));
    if (name && scores.length === 2 && scores.every((n) => Number.isFinite(n))) {
      const leftWon = /results-left[^"]*won/.test(b);
      const rightWon = /results-right[^"]*won/.test(b);
      out.push({ mapId: mapIdFromName(name), score: { a: scores[0], b: scores[1] }, winner: leftWon ? 0 : rightWon ? 1 : (scores[0] === scores[1] ? null : (scores[0] > scores[1] ? 0 : 1)) });
    }
  }
  return out;
}
function importHltv(html) {
  const teams = hltvTeams(html);
  if (teams.length < 2) throw new Error('Could not find both teams on that HLTV page.');
  const steps = hltvSteps(html, teams);
  if (!steps.length) throw new Error('No veto on that HLTV page yet — it appears once the teams have picked.');
  const pickCount = steps.filter((s) => s.action !== 'ban').length;
  const bestOf = hltvBestOf(html) || (pickCount >= 5 ? 5 : pickCount >= 3 ? 3 : 1);
  return finish({ source: 'hltv', teams, bestOf, steps, results: hltvResults(html) });
}

// ── Pasted text ────────────────────────────────────────────────────────────────────────────────
// The veto box copied off an HLTV match page (or typed by hand), with or without line breaks:
//   "Best of 3 … 1. BIG removed Ancient 2. G2 removed Dust2 3. BIG picked Mirage … 7. Nuke was left over"
// Team 1 is whoever acted first; names come from the lines themselves.
function looksLikePastedVeto(text) {
  return /\d\.\s*\S.*\b(removed|banned|picked|left over)\b/i.test(String(text || ''));
}
function importPasted(text) {
  const src = stripTags(String(text || '').replace(/<\/(div|p|li|br)>/gi, '\n'));
  const lines = [];
  const re = /(\d+)\.\s*(.+?)(?=\s+\d+\.\s|$)/g;
  let m;
  while ((m = re.exec(src))) lines.push(m[2].trim());
  const names = [];
  const steps = [];
  const who = (n) => { const k = n.trim(); const i = names.findIndex((x) => x.toLowerCase() === k.toLowerCase()); if (i >= 0) return i; names.push(k); return names.length - 1; };
  lines.forEach((line) => {
    let r;
    if ((r = /^(.+?) (removed|banned) (.+)$/i.exec(line))) steps.push({ map: r[3], action: 'ban', by: who(r[1]) });
    else if ((r = /^(.+?) picked (.+)$/i.exec(line))) steps.push({ map: r[2], action: 'pick', by: who(r[1]) });
    else if ((r = /^(.+?) was left over$/i.exec(line))) steps.push({ map: r[1], action: 'decider', by: null });
  });
  if (!steps.length) throw new Error('No veto lines found. Copy the "1. Team removed Map …" lines from the match page and paste them.');
  if (names.length < 2) throw new Error('Only one team appears in those lines.');
  const bm = /Best of (\d)/i.exec(src);
  const pickCount = steps.filter((s) => s.action !== 'ban').length;
  const bestOf = bm && [1, 2, 3, 5].includes(Number(bm[1])) ? Number(bm[1]) : (pickCount >= 5 ? 5 : pickCount >= 3 ? 3 : 1);
  return finish({
    source: 'pasted',
    teams: names.slice(0, 2).map((name) => ({ name, logo: '' })),
    bestOf,
    steps: steps.map((s) => ({ mapId: mapIdFromName(s.map), map: prettyMap(s.map), image: '', action: s.action, by: s.by != null && s.by > 1 ? 0 : s.by })),
  });
}

// ── Common ─────────────────────────────────────────────────────────────────────────────────────
// Tidy: who banned first, deciders at the end, and a sequence the app's veto engine can replay.
function finish(imp) {
  const steps = imp.steps.filter((s) => s && s.mapId);
  // Drop duplicates (a map acted on twice is a parse slip) keeping the first.
  const seen = new Set();
  const uniq = steps.filter((s) => { if (seen.has(s.mapId)) return false; seen.add(s.mapId); return true; });
  const first = uniq.find((s) => s.action === 'ban' || s.action === 'pick');
  const teamStart = first && first.by === 1 ? 'b' : 'a';
  return {
    source: imp.source,
    teams: imp.teams,
    bestOf: imp.bestOf,
    teamStart,
    steps: uniq,
    results: imp.results || [],
    summary: imp.teams.map((t) => t.name || '?').join(' vs ') + ' · Best of ' + imp.bestOf + ' · ' + uniq.length + ' steps',
  };
}

// ── Fetch helpers (plain https, browser-like headers) ──────────────────────────────────────────
function httpGet(url, { headers = {}, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Bad URL')); }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }, headers),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 6e6) { req.destroy(new Error('Response too large')); } });
      res.on('end', () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timed out')));
    req.end();
  });
}
async function getJson(url, headers) {
  const r = await httpGet(url, { headers: Object.assign({ Accept: 'application/json' }, headers || {}) });
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  try { return JSON.parse(r.body); } catch (e) { throw new Error('Not JSON'); }
}

// Orchestrator. `fetchHtml(url)` must return the page HTML (server.js adds a browser fallback for
// Cloudflare); `faceitKey` enables the official data API.
async function importVeto(url, { faceitKey = '', fetchHtml = null, fetchJson = getJson } = {}) {
  if (looksLikePastedVeto(url)) return importPasted(url);
  const ref = parseVetoUrl(url);
  if (!ref) throw new Error('Paste a FACEIT room link, or the veto lines copied from an HLTV match page.');
  if (ref.source === 'faceit') {
    let match = null, history = null;
    if (faceitKey) {
      try { match = await fetchJson('https://open.faceit.com/data/v4/matches/' + encodeURIComponent(ref.id), { Authorization: 'Bearer ' + faceitKey }); } catch (e) { match = null; }
    }
    if (!match) {
      try { match = await fetchJson('https://api.faceit.com/match/v2/match/' + encodeURIComponent(ref.id)); } catch (e) { match = null; }
    }
    if (!match) throw new Error('FACEIT did not return that match. Check the link' + (faceitKey ? '.' : ', or add a FACEIT API key in Settings.'));
    try { history = await fetchJson('https://api.faceit.com/democracy/v1/match/' + encodeURIComponent(ref.id) + '/history'); } catch (e) { history = null; }
    const out = importFaceit(match, history);
    if (!out.steps.length) throw new Error('That FACEIT room has no map picks yet — wait for the veto to finish and import again.');
    return out;
  }
  let html = '';
  try { html = fetchHtml ? await fetchHtml(ref.url) : (await httpGet(ref.url)).body; } catch (e) { html = ''; }
  if (!html || (/just a moment|cf-chl|challenge-platform/i.test(html.slice(0, 4000)) && !/veto-box/.test(html))) {
    const err = new Error('HLTV blocks automated access. Open the match page, copy the veto lines ("1. Team removed Map …") and paste them here instead.');
    err.openUrl = ref.url;
    throw err;
  }
  return importHltv(html);
}

module.exports = { parseVetoUrl, mapIdFromName, prettyMap, importFaceit, importHltv, importPasted, looksLikePastedVeto, importVeto, httpGet, getJson, faceitStepsFromHistory, hltvSteps, hltvTeams, hltvResults };
