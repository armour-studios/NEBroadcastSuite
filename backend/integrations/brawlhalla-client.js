/*
  brawlhalla-client.js — Brawlhalla official API (https://api.brawlhalla.com), v1.

  WHY v1 AND NOT v0: v1 needs NO API KEY ("you no longer need an API key to use the API"), where
  v0 required one and Blue Mammoth stopped issuing new ones. v0 is deprecated. So this integration
  is the rare one a producer can just turn on — nothing to apply for, nothing to paste in.

  RATE LIMIT: 2000 requests / 5 minutes, and the docs say it will NOT be raised on request. That
  is generous for our use (a handful of lookups per match) but not infinite, so every lookup here
  goes through the caches in backend/brawlhalla.js rather than straight to the wire.

  WHAT IT IS NOT: there is no live match feed. Brawlhalla has no GSI, no spectator API and no
  "currently playing" endpoint — the API is career statistics only. Stocks, legends and the set
  score on our overlay are producer-driven (exactly like Smash); this client supplies the player
  IDENTITY layer around them: rank, tier, ELO, region rank, W/L and legend history.

  Endpoints used:
    GET /v1/leaderboard/ranked  ?game_mode=1v1|2v2|3v3 &region=US-E|EU|...|ALL
                                &search= &page= &max_results= (<=50) &order_by=
    GET /v1/player/stats        ?brawlhalla_id= &mode=all|ranked_1v1|ranked_3v3
    GET /v1/player/teams        ?brawlhalla_id=
    GET /v1/static/legends      ?page= &max_results= (<=100) &filter_by_id= &filter_by_name=
*/

'use strict';

const axios = require('axios');

const BH_API_BASE = 'https://api.brawlhalla.com/v1';

// The regions the ranked leaderboard accepts. 'ALL' is the cross-region board.
const BH_REGIONS = ['ALL', 'US-E', 'US-W', 'EU', 'SEA', 'BRZ', 'AUS', 'JPS', 'SA', 'ME'];
const BH_MODES = ['1v1', '2v2', '3v3'];

function createBrawlhallaClient(opts = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const timeout = Number(opts.timeout) || 15000;
  // v1 takes no key, but the field is kept so a v0 key (or a future one) can be passed through
  // without changing every call site.
  const apiKey = (opts.apiKey || '').trim();

  async function withRetry(fn, label) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(500 * attempt);
      try {
        const res = await fn();
        // 429 = we blew the 2000/5min budget. Backing off is the only correct response; the
        // caller's cache is what stops us getting here in the first place.
        if (res && (res.status === 429 || res.status >= 500) && attempt < 2) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Brawlhalla network error: ${lastErr ? lastErr.message : 'request failed'} (${label})`);
  }

  function handle(res, path) {
    if (res.status === 404) return null;                  // "no such player" is an answer, not a fault
    if (res.status === 429) throw new Error('Brawlhalla API rate limit reached (2000 requests / 5 min) — try again shortly.');
    if (res.status === 403) throw new Error('Brawlhalla API refused the request (403).');
    if (res.status >= 400) {
      const msg = (res.data && (res.data.error || res.data.message)) || `HTTP ${res.status}`;
      throw new Error(`Brawlhalla API error: ${msg}`);
    }
    return res.data;
  }

  async function get(path, params = {}) {
    const query = { ...params };
    if (apiKey) query.api_key = apiKey;
    const res = await withRetry(() => axios.get(`${BH_API_BASE}${path}`, {
      params: query,
      // The API 403s a request with no User-Agent, so this is load-bearing, not decoration.
      headers: { 'User-Agent': 'NE-Broadcast-Suite/1.0', Accept: 'application/json' },
      timeout,
      validateStatus: () => true
    }), `GET ${path}`);
    return handle(res, path);
  }

  return {
    /*
      Ranked leaderboard, and — via `search` — the only name→id lookup the API has. There is no
      /search endpoint in v1: you find a player by searching the leaderboard they appear on, which
      means an UNRANKED player is genuinely unfindable by name. Callers must handle an empty hit
      list as "not ranked this season", not as an error.
    */
    async rankings({ mode = '1v1', region = 'ALL', search = '', page = 1, maxResults = 10, orderBy = '' } = {}) {
      const params = {
        game_mode: BH_MODES.includes(mode) ? mode : '1v1',
        region: BH_REGIONS.includes(String(region).toUpperCase()) ? String(region).toUpperCase() : 'ALL',
        page: Math.max(1, Number(page) || 1),
        max_results: Math.min(50, Math.max(1, Number(maxResults) || 10))
      };
      if (search) params.search = String(search).slice(0, 64);
      if (orderBy) params.order_by = orderBy;
      const data = await get('/leaderboard/ranked', params);
      return { rankings: (data && data.rankings) || [], totalPages: (data && data.total_pages) || 0 };
    },

    // mode: 'all' (lifetime/legend stats) | 'ranked_1v1' | 'ranked_3v3'
    async playerStats(brawlhallaId, mode = 'all') {
      const id = Number(brawlhallaId);
      if (!id) throw new Error('brawlhalla_id required');
      return get('/player/stats', { brawlhalla_id: id, mode });
    },

    async playerTeams(brawlhallaId) {
      const id = Number(brawlhallaId);
      if (!id) throw new Error('brawlhalla_id required');
      return get('/player/teams', { brawlhalla_id: id });
    },

    // Every legend, paged. Used once to warm the registry cache; the shipped
    // overlay/brawlhalla-legends.js is the offline fallback so the overlay never waits on a fetch.
    async legends({ page = 1, maxResults = 100, name = '', id = 0 } = {}) {
      const params = { page: Math.max(1, Number(page) || 1), max_results: Math.min(100, Math.max(1, Number(maxResults) || 100)) };
      if (name) params.filter_by_name = String(name);
      if (id) params.filter_by_id = Number(id);
      const data = await get('/static/legends', params);
      return { legends: (data && data.legends) || [], totalPages: (data && data.total_pages) || 0 };
    },

    async allLegends() {
      const out = [];
      let page = 1;
      let total = 1;
      // Hard cap the walk: a paging bug on their side must not turn into an unbounded request loop.
      while (page <= total && page <= 10) {
        const r = await this.legends({ page, maxResults: 100 });
        out.push(...r.legends);
        total = r.totalPages || 1;
        page++;
      }
      return out;
    }
  };
}

module.exports = { createBrawlhallaClient, BH_REGIONS, BH_MODES, BH_API_BASE };
