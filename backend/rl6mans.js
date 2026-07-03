// rl6mans.js — look up player ranks on rl6mans.com (direct profile pages first,
// leaderboard scrape as a fallback for fuzzy candidates).
// NOTE: uses axios, NOT global fetch — the app runs on Electron 18 / Node 16,
// which has no global fetch or AbortSignal.timeout (everything silently failed
// before, which is why nothing was ever found).

const axios = require('axios');

// rl6mans rank ladder best→worst: S, X, A, B+, B, C, D, E, H. These are the
// leaderboard URL slugs (B+ is "BPLUS" in the URL). S/X pages are usually empty
// (so few players they don't list) but direct profile lookup still finds them.
const RANKS = ['S', 'X', 'A', 'BPLUS', 'B', 'C', 'D', 'E', 'H'];
const REGION_LIST = ['NA', 'EU', 'OCE', 'SAM', 'ME', 'ASIA'];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BASE = 'https://www.rl6mans.com';

// region → { allPlayers, byNorm, byExact, buildAt }
const _cache = new Map();

// ── normalisation helpers ──────────────────────────────────────────────────

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Levenshtein distance, bails early at `cap` to stay fast on large sets
function lev(a, b, cap = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const m = a.length, n = b.length;
  const row = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = j - 1;
    row[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = row[i];
      row[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[i], row[i - 1]);
      prev = tmp;
    }
  }
  return row[m];
}

// ── HTTP fetch ─────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadcastSuite/1.0)' },
      timeout: 12000,
      responseType: 'text',
      transformResponse: (d) => d,            // keep raw HTML (don't auto-JSON-parse)
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return typeof res.data === 'string' ? res.data : String(res.data || '');
  } catch (e) {
    return null;
  }
}

// ── direct profile lookup (accurate: exact ELO + tier per player) ──────────
// rl6mans.com/profile/<name> is case-insensitive and renders the player's exact
// ELO, rank tier, region and platform. This is FAR more accurate than matching
// names against a leaderboard (which only holds ranked regulars), so we try it
// first for every gamertag and only fall back to the fuzzy leaderboard index
// when a name doesn't resolve to a profile.
const _profileCache = new Map();        // nameLower → { data, at }
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;

function visibleText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse a profile page → { found, elo, rank(tier slug), region, platform, wins, losses }.
// A non-existent profile renders a tiny page with no "ELO" stat → found:false.
function parseProfile(html) {
  const t = visibleText(html);
  // A real profile renders the stats scaffold even when the player is unranked;
  // a non-existent name renders a tiny page without it. Detect existence by the
  // scaffold, NOT by ELO>0 (an unranked profile has 0 ELO but still exists).
  if (!/Current ELO|Season Stats|To Promote/i.test(t)) return { found: false };
  const eloM = t.match(/([\d,]{1,6})\s*Current ELO/i) || t.match(/([\d,]{1,6})\s*ELO\b/i);
  const elo = eloM ? Number(eloM[1].replace(/,/g, '')) : 0;
  // Rank tier — rl6mans ladder (best→worst): S, X, A, B+, B, C, D, E, H. The profile
  // renders B+ as the literal text "BPLUS". Valid set only (so "Current Rank N/A"
  // can't match an "N"); BPLUS/B+ MUST precede B; lookahead (a trailing \b fails
  // after "+"). Falls back to "Unranked".
  let tier = (t.match(/\bRank\s+(S|X|A|BPLUS|B\+|B|C|D|E|H)(?=\s|$)/) || [])[1] || '';
  if (!tier && /\bUnranked\b/i.test(t)) tier = 'Unranked';
  tier = tier.toUpperCase();
  if (tier === 'BPLUS') tier = 'B+';     // display form the user wants
  const region = (t.match(/\b(NA|EU|OCE|SAM|ME|ASIA)\b/) || [])[1] || '';
  const platform = (t.match(/\b(PC|PS[45]?|XBOX|XB|EPIC|STEAM|Switch)\b/i) || [])[1] || '';
  const wl = t.match(/(\d+)\s*Wins\s+(\d+)\s*Losses/i);
  return { found: true, elo, rank: tier, tier, unranked: !elo, region, platform, wins: wl ? +wl[1] : null, losses: wl ? +wl[2] : null };
}

// Ordered list of identities to try for one start.gg name, most→least specific.
// Handles the common ways a start.gg gamertag differs from the rl6mans username:
// team prefixes ("TEAM | Player", "TEAM: Player"), gaming suffixes ("PlayerRL",
// "Player_NA") and separators ("Player.RL" / "Player_RL" → "PlayerRL").
function profileVariants(name) {
  const base = (name || '').trim();
  if (!base) return [];
  const out = [];
  const push = (s) => { s = (s || '').trim(); if (s && s.length >= 2 && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  push(base);
  const seg = base.split(/\s*[|:\/]\s*/).pop();   // strip "TEAM | " style prefix
  push(seg);
  push(stripGamingTag(base));
  push(stripGamingTag(seg));
  push(base.replace(/[\s_.\-]+/g, ''));            // collapse separators
  return out.slice(0, 5);
}

async function fetchProfile(name) {
  const key = (name || '').toLowerCase().trim();
  if (!key) return { found: false };
  const cached = _profileCache.get(key);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.data;
  const html = await fetchHtml(`${BASE}/profile/${encodeURIComponent(name)}`);
  const data = html ? parseProfile(html) : { found: false };
  if (data.found) data.name = name;
  _profileCache.set(key, { data, at: Date.now() });
  return data;
}

// Bounded-concurrency map (polite to the server, fast for a roster of ~30).
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const worker = async () => { while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, arr.length || 1) }, worker));
  return out;
}

// ── HTML parsing ───────────────────────────────────────────────────────────

// Walk a JS object tree up to `depth` levels, return first array whose items
// look like player records (have a name/username/gamertag field).
function findPlayersInObj(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj) && obj.length > 0) {
    const s = obj[0];
    if (s && typeof s === 'object' && (s.name || s.username || s.gamertag || s.tag)) return obj;
  }
  for (const v of Object.values(obj)) {
    const found = findPlayersInObj(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function parsePage(html, rank) {
  const players = [];

  // Strategy 1: __NEXT_DATA__ embedded JSON
  const ndM = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (ndM) {
    try {
      const nd = JSON.parse(ndM[1]);
      const list = findPlayersInObj(nd?.props?.pageProps);
      if (list && list.length) {
        for (const p of list) {
          const name = p.name || p.username || p.gamertag || p.tag || p.handle;
          if (!name) continue;
          players.push({
            name: String(name).trim(),
            rank,
            elo:    Number(p.elo    || p.rating || p.mmr || p.score || 0) || 0,
            wins:   Number(p.wins   || p.win    || 0) || 0,
            losses: Number(p.losses || p.loss   || p.lose || 0) || 0,
          });
        }
        if (players.length) return players;
      }
    } catch { /* fall through */ }
  }

  // Strategy 2: regex extract profile links (names only; ELO not available without DOM)
  const seen = new Set();
  for (const [, raw] of html.matchAll(/href="\/profile\/([^"?/]{1,60})"/g)) {
    const name = decodeURIComponent(raw).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    players.push({ name, rank, elo: 0, wins: 0, losses: 0 });
  }

  return players;
}

function detectTotalPages(html) {
  // From __NEXT_DATA__
  const ndM = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (ndM) {
    try {
      const nd = JSON.parse(ndM[1]);
      const pp = nd?.props?.pageProps;
      const total = pp?.totalPages || pp?.pageCount || pp?.pagination?.totalPages
                 || pp?.data?.totalPages;
      if (total) return Number(total);
      const totalP = pp?.totalPlayers || pp?.total || pp?.data?.total;
      if (totalP) return Math.ceil(Number(totalP) / 100);
    } catch { /* fall through */ }
  }
  // Largest ?page= or &page= number seen in the HTML
  const nums = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  if (nums.length) return Math.max(...nums);
  return 1;
}

// ── scraping ───────────────────────────────────────────────────────────────

async function scrapeRank(region, rank) {
  const url1 = `${BASE}/leaderboards/${region}/${rank}`;
  const html1 = await fetchHtml(url1);
  if (!html1) return [];

  const players = parsePage(html1, rank);
  const totalPages = Math.min(detectTotalPages(html1), 30); // safety cap

  if (totalPages > 1) {
    const fetches = Array.from({ length: totalPages - 1 }, (_, i) =>
      fetchHtml(`${url1}?page=${i + 2}`).then((h) => h ? parsePage(h, rank) : [])
    );
    const batches = await Promise.all(fetches);
    batches.forEach((b) => players.push(...b));
  }

  return players;
}

// ── index build & cache ───────────────────────────────────────────────────

// International events: merge every region's leaderboard into one index so the
// manual-match candidates/autocomplete cover all players, not just one region.
// (Direct profile lookup is already region-agnostic; this only feeds the fallback.)
async function buildIndexAll() {
  const cached = _cache.get('ALL');
  if (cached && Date.now() - cached.buildAt < CACHE_TTL_MS) return cached;
  const per = await Promise.all(REGION_LIST.map((r) => buildIndex(r).catch(() => null)));
  const allPlayers = [];
  per.forEach((e) => { if (e) allPlayers.push(...e.allPlayers); });
  const byNorm = new Map(), byExact = new Map();
  for (const p of allPlayers) {
    const e = p.name.toLowerCase(), n = norm(p.name);
    if (!byExact.has(e)) byExact.set(e, p);
    if (!byNorm.has(n)) byNorm.set(n, p);
  }
  const entry = { allPlayers, byNorm, byExact, buildAt: Date.now() };
  _cache.set('ALL', entry);
  console.log(`[rl6mans] International index ready: ${allPlayers.length} players across ${REGION_LIST.length} regions`);
  return entry;
}

async function buildIndex(region) {
  if (region === 'ALL') return buildIndexAll();
  const cached = _cache.get(region);
  if (cached && Date.now() - cached.buildAt < CACHE_TTL_MS) return cached;

  console.log(`[rl6mans] Scraping ${region} leaderboards (${RANKS.join(', ')})…`);
  const allPlayers = [];

  // 3 ranks at a time — polite toward the server
  for (let i = 0; i < RANKS.length; i += 3) {
    const chunk = RANKS.slice(i, i + 3);
    const results = await Promise.all(chunk.map((r) => scrapeRank(region, r)));
    results.forEach((p) => allPlayers.push(...p));
    if (i + 3 < RANKS.length) await new Promise((r) => setTimeout(r, 500));
  }

  const byNorm  = new Map(); // normName → player
  const byExact = new Map(); // name.toLowerCase() → player
  for (const p of allPlayers) {
    const e = p.name.toLowerCase(), n = norm(p.name);
    if (!byExact.has(e)) byExact.set(e, p);
    if (!byNorm.has(n))  byNorm.set(n, p);
  }

  const entry = { allPlayers, byNorm, byExact, buildAt: Date.now() };
  _cache.set(region, entry);
  console.log(`[rl6mans] Index ready: ${allPlayers.length} players for ${region}`);
  return entry;
}

// Invalidate cached index (e.g. user requests a refresh)
function invalidateCache(region) {
  if (region) _cache.delete(region);
  else _cache.clear();
}

// Persist / restore the per-player profile cache across restarts.
// Entries older than PROFILE_TTL_MS are silently dropped on load.
function loadPersistedCache(entries) {
  if (!Array.isArray(entries)) return;
  const now = Date.now();
  let loaded = 0;
  for (const [key, entry] of entries) {
    if (entry && entry.at && now - entry.at < PROFILE_TTL_MS && !_profileCache.has(key)) {
      _profileCache.set(key, entry);
      loaded++;
    }
  }
  if (loaded) console.log(`[rl6mans] Restored ${loaded} cached profiles from disk`);
}

function dumpProfileCache() {
  return [..._profileCache.entries()];
}

// ── public lookup ─────────────────────────────────────────────────────────

// Strip common gaming platform tags from the end of a name before matching.
// "BoscoRL" → "Bosco", "Player_GG" → "Player", "Name_NA" → "Name"
const GAMING_SUFFIX_RE = /[-_. ]*(rl|gg|gc|ssl|champ|gaming|tv|esports|yt|twitch|official|na|eu|oce|sam|me|asia)$/i;
function stripGamingTag(s) {
  // Apply twice to catch double-suffixes like "Name_RL_NA"
  return (s || '').replace(GAMING_SUFFIX_RE, '').replace(GAMING_SUFFIX_RE, '').trim();
}

// Generate multiple normalised variants of a name to maximise matching chances.
// Returns [{ raw, n }] where n is norm(raw), deduped.
function nameVariants(input) {
  const base = (input || '').trim();
  const stripped = stripGamingTag(base);
  const firstToken = base.split(/[-_. ]+/)[0] || '';
  return [base, stripped, firstToken]
    .filter((v, i, arr) => v && v.length >= 2 && arr.indexOf(v) === i)
    .map((v) => ({ raw: v, n: norm(v) }))
    .filter((v) => v.n.length >= 2);
}

// Fuzzy-match one name against the (leaderboard) index → { match, confidence, distance, candidates }.
function fuzzyOne(input, idx) {
  const variants = nameVariants(input);

  // 1. Exact match — try every name variant (raw lowercase + normalised)
  for (const v of variants) {
    const exact = idx.byExact.get(v.raw.toLowerCase()) || idx.byNorm.get(v.n);
    if (exact) return { match: exact, confidence: 'exact', distance: 0, candidates: [{ ...exact, _distance: 0 }] };
  }

  // 2. Score every indexed player against all input variants (Levenshtein + substring bonus).
  const bestPerPlayer = new Map();
  for (const [n, player] of idx.byNorm) {
    let best = Infinity;
    for (const v of variants) {
      if (!v.n) continue;
      const d = lev(v.n, n, 8);
      if (d < best) best = d;
      const minLen = Math.min(v.n.length, n.length);
      if (minLen >= 4 && (v.n.includes(n) || n.includes(v.n))) {
        const subD = Math.abs(v.n.length - n.length);
        if (subD < best) best = subD;
      }
    }
    if (best < 8) bestPerPlayer.set(player, best);
  }

  const ranked = [...bestPerPlayer.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([player, d]) => ({ ...player, _distance: d }));

  const baseLen = variants[0]?.n?.length || 0;
  const maxDist = baseLen <= 5 ? 2 : baseLen <= 10 ? 3 : 4;
  const bestEntry = ranked[0];
  if (bestEntry && bestEntry._distance <= maxDist) {
    return { match: bestEntry, confidence: 'fuzzy', distance: bestEntry._distance, candidates: ranked };
  }
  return { match: null, confidence: 'none', distance: -1, candidates: ranked };
}

// names: string[]  →  results: [{ input, match, confidence, distance, candidates, source }]
// PROFILE-FIRST: every gamertag is looked up directly on rl6mans.com/profile/<tag>
// (exact ELO + tier + region + platform). Only names that don't resolve to a
// profile fall back to the fuzzy leaderboard index — and even those candidates
// are enriched with their real profile ELO. `region` only matters for the fallback.
// Each entry is either a gamertag string OR { name, alts } where alts are stronger
// identities (e.g. the player's connected Epic account from start.gg). Alts are
// tried FIRST — an Epic name maps directly to the rl6mans (PC) profile.
async function lookupPlayers(names, region = 'NA', opts = {}) {
  const profilesOnly = !!opts.profilesOnly;
  const items = (names || []).map((n) => (typeof n === 'string'
    ? { name: n, alts: [] }
    : { name: n.name || '', alts: (n.alts || []).filter(Boolean) }));

  // Try each player's identities (alts first, then the gamertag) and their
  // variants directly on /profile/ — first hit wins.
  const direct = await mapLimit(items, 10, async (item) => {
    const tried = new Set();
    for (const id of [...item.alts, item.name]) {
      for (const v of profileVariants(id)) {
        const key = v.toLowerCase();
        if (tried.has(key)) continue;
        tried.add(key);
        const p = await fetchProfile(v);
        if (p && p.found) return { input: item.name, prof: { ...p, name: v } };
      }
    }
    return { input: item.name, prof: { found: false } };
  });

  const exact = ({ input, prof }) => {
    const match = { name: prof.name || input, rank: prof.rank, elo: prof.elo, region: prof.region, platform: prof.platform, wins: prof.wins, losses: prof.losses };
    return { input, match, confidence: 'exact', distance: 0, candidates: [{ ...match, _distance: 0 }], totalIndexed: 0, source: 'profile' };
  };

  // FAST PATH (bulk verify): direct profiles only — never builds the leaderboard
  // index (that scrape is the slow part, esp. the 6-region 'ALL'). Misses are left
  // for the not-found tab (autocomplete + manual exact-name lookup, loaded lazily).
  if (profilesOnly) {
    return direct.map((d) => (d.prof && d.prof.found)
      ? exact(d)
      : { input: d.input, match: null, confidence: 'none', distance: -1, candidates: [], totalIndexed: 0, source: 'none' });
  }

  // Full path — builds the leaderboard index to enrich misses with fuzzy candidates.
  const anyMiss = direct.some((d) => !(d.prof && d.prof.found));
  let idx = null;
  if (anyMiss) { try { idx = await buildIndex(region); } catch (e) {} }
  const totalIndexed = idx ? idx.allPlayers.length : 0;

  return mapLimit(direct, 4, async ({ input, prof }) => {
    if (prof && prof.found) return { ...exact({ input, prof }), totalIndexed };
    if (!idx) return { input, match: null, confidence: 'none', distance: -1, candidates: [], totalIndexed, source: 'none' };
    const r = fuzzyOne(input, idx);
    const enriched = await mapLimit((r.candidates || []).slice(0, 3), 3, async (c) => {
      const p = await fetchProfile(c.name);
      return p.found ? { ...c, elo: p.elo, rank: p.rank, region: p.region, platform: p.platform } : c;
    });
    return { input, match: null, confidence: 'none', distance: r.distance, candidates: enriched, totalIndexed, source: 'leaderboard' };
  });
}

module.exports = { lookupPlayers, fetchProfile, buildIndex, invalidateCache, loadPersistedCache, dumpProfileCache, RANKS, REGION_LIST };
