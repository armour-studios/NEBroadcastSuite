'use strict';

// ── Liquipedia DB (LPDB) API v3 client ───────────────────────────────────────
//
// Liquipedia is NOT like our other integrations, and the difference drives the whole design:
//
//   • 60 requests per HOUR, total. (https://liquipedia.net/api-terms-of-use) That is one request
//     a minute — polling is impossible. Everything here is cache-first: the overlay never causes
//     a request, only an explicit producer action does, and the budget is tracked so we refuse
//     rather than get the producer's key rate-limited mid-show.
//   • Caching is a REQUIREMENT of the terms, not an optimisation: "re-use / cache your API
//     results for as long as possible". The cache is therefore persisted, not just in-memory.
//   • The User-Agent must identify the project and carry contact info.
//   • Content is CC-BY-SA 3.0 and MUST be attributed wherever it is shown — including on air.
//     See LIQUIPEDIA_ATTRIBUTION, which the overlays render.
//   • Access is not self-service and the free tier is for non-commercial use. Producers bring
//     their OWN key, so the licensing relationship is theirs, not the suite's.
//
// The request shape (base URL, Apikey header, wiki/conditions/limit/offset/order) is corroborated
// across Liquipedia's public API page and third-party clients. The per-datapoint RESPONSE FIELDS
// are documented only to approved key holders, so response handling is deliberately tolerant —
// see normaliseStandings() and its notes.

const https = require('https');

const LP_HOST = 'api.liquipedia.net';
const LP_BASE = '/api/v3/';

// Shown on any overlay rendering Liquipedia data. Required by CC-BY-SA 3.0.
const LIQUIPEDIA_ATTRIBUTION = 'Data: Liquipedia (CC BY-SA 3.0)';

// The documented ceiling. Kept a little under so a producer's own manual refresh can never be
// the request that trips the limit.
const HOURLY_LIMIT = 60;
const SAFE_LIMIT = 55;

/** Rolling-hour request budget. Liquipedia's limit is per hour, not per minute, so a simple
 *  token bucket would let a burst empty the whole allowance in a minute and leave the producer
 *  with nothing for the rest of the show. Tracking real timestamps lets us report exactly when
 *  the next slot frees up, which is what the panel shows. */
class RateBudget {
  constructor(limit = SAFE_LIMIT, windowMs = 3600000, now = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this._now = now;
    this.hits = [];
  }
  _prune() {
    const cutoff = this._now() - this.windowMs;
    while (this.hits.length && this.hits[0] <= cutoff) this.hits.shift();
  }
  /** Requests still available this rolling hour. */
  remaining() { this._prune(); return Math.max(0, this.limit - this.hits.length); }
  /** ms until one more request is allowed; 0 when there is headroom now. */
  retryAfterMs() {
    this._prune();
    if (this.hits.length < this.limit) return 0;
    return Math.max(0, this.hits[0] + this.windowMs - this._now());
  }
  /** Record a request that actually went out (a cache hit must NOT be recorded). */
  take() { this._prune(); this.hits.push(this._now()); }
  /** Serialisable so the budget survives an app restart — the hour keeps running either way. */
  toJSON() { this._prune(); return { hits: this.hits.slice() }; }
  static fromJSON(o, limit, windowMs, now) {
    const b = new RateBudget(limit, windowMs, now);
    if (o && Array.isArray(o.hits)) b.hits = o.hits.filter((t) => typeof t === 'number');
    b._prune();
    return b;
  }
}

/** Cache entries are considered usable for a long time by design — the terms ask for it, and
 *  standings/rankings move slowly. `stale` only decides whether the panel offers a Refresh, not
 *  whether the data is served. */
const DEFAULT_TTL_MS = 6 * 3600000;   // 6h

class LiquipediaCache {
  constructor(entries) { this.entries = entries && typeof entries === 'object' ? entries : {}; }
  static key(datapoint, params) {
    const p = params || {};
    const ordered = Object.keys(p).sort().map((k) => k + '=' + String(p[k])).join('&');
    return datapoint + '?' + ordered;
  }
  get(k) { return this.entries[k] || null; }
  put(k, data, at) { this.entries[k] = { at: at || Date.now(), data }; }
  ageMs(k, now) { const e = this.entries[k]; return e ? Math.max(0, (now || Date.now()) - e.at) : Infinity; }
  isStale(k, ttl, now) { return this.ageMs(k, now) > (ttl || DEFAULT_TTL_MS); }
  toJSON() { return this.entries; }
}

function buildUserAgent(contact) {
  // The terms require the project AND a contact. A producer's own contact is used when set so
  // Liquipedia can reach the actual key holder rather than us.
  const who = String(contact || '').trim();
  return 'NE-Broadcast-Suite/1.0 (https://namelessesports.com/' + (who ? '; ' + who : '') + ')';
}

/** One raw LPDB request. Callers should go through queryCached() instead — this does not consult
 *  the cache or the budget, and exists so both can be tested independently of the network. */
function lpRequest(apiKey, datapoint, params, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error('No Liquipedia API key — add one in Settings ▸ Integrations.'));
    const qs = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
    });
    const path = LP_BASE + encodeURIComponent(datapoint) + (qs.toString() ? '?' + qs.toString() : '');
    const req = https.request({
      hostname: LP_HOST, path, method: 'GET',
      headers: {
        // Liquipedia's documented scheme for LPDB v3.
        'Authorization': 'Apikey ' + apiKey,
        'Accept': 'application/json',
        'User-Agent': buildUserAgent(o.contact)
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('Liquipedia rejected the key (HTTP ' + res.statusCode + '). Check it in Settings, and that your access covers this wiki.'));
        }
        if (res.statusCode === 429) {
          return reject(new Error('Liquipedia rate limit reached (60 requests/hour). Existing data stays on air; try again later.'));
        }
        if (res.statusCode >= 400) {
          let msg = 'Liquipedia HTTP ' + res.statusCode;
          try { const j = JSON.parse(body); msg = j.error || j.message || msg; } catch (e) {}
          return reject(new Error(msg));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Liquipedia returned a non-JSON response')); }
      });
    });
    req.on('error', (e) => reject(new Error('Liquipedia network error: ' + e.message)));
    req.setTimeout(20000, () => req.destroy(new Error('Liquipedia request timed out')));
    req.end();
  });
}

/** Cache-first query. Returns { data, fromCache, ageMs, remaining }.
 *  force=true still refuses when the budget is spent — the point of the budget is that the
 *  producer's key survives the show. */
async function queryCached(ctx, datapoint, params, opts) {
  const o = opts || {};
  const now = (ctx.now || Date.now);
  const key = LiquipediaCache.key(datapoint, params);
  const cached = ctx.cache.get(key);
  const stale = ctx.cache.isStale(key, o.ttlMs, now());

  if (cached && !o.force && !stale) {
    return { data: cached.data, fromCache: true, ageMs: ctx.cache.ageMs(key, now()), remaining: ctx.budget.remaining() };
  }
  if (ctx.budget.remaining() <= 0) {
    if (cached) {
      // Serve stale rather than blank the graphic — the show matters more than freshness.
      return { data: cached.data, fromCache: true, stale: true, ageMs: ctx.cache.ageMs(key, now()),
               remaining: 0, retryAfterMs: ctx.budget.retryAfterMs() };
    }
    const mins = Math.ceil(ctx.budget.retryAfterMs() / 60000);
    throw new Error('Liquipedia hourly request budget is spent (60/hour) and nothing is cached yet. Next slot in ~' + mins + ' min.');
  }

  ctx.budget.take();
  try {
    const data = await lpRequest(ctx.apiKey, datapoint, params, { contact: o.contact });
    ctx.cache.put(key, data, now());
    return { data, fromCache: false, ageMs: 0, remaining: ctx.budget.remaining() };
  } catch (e) {
    if (cached) {
      // A failed refresh must not take the on-air graphic down with it.
      return { data: cached.data, fromCache: true, stale: true, error: e.message,
               ageMs: ctx.cache.ageMs(key, now()), remaining: ctx.budget.remaining() };
    }
    throw e;
  }
}

/** LPDB returns rows under a result envelope. The exact field names per datapoint are documented
 *  only to approved key holders, so this reads the common shapes rather than asserting one:
 *  { result: [...] } / { data: [...] } / a bare array. Verified against a live key, this is the
 *  one function that may need adjusting. */
function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

/** Map LPDB rows onto the shape state.standings.rows already uses, so the existing standings
 *  overlay renders Liquipedia data with no changes beyond attribution. Field names are probed
 *  across the plausible spellings for the same reason as rowsOf(). */
function normaliseStandings(payload) {
  const pick = (row, names) => {
    for (const n of names) {
      if (row && row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
    }
    return undefined;
  };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return rowsOf(payload).map((r, i) => {
    const name = pick(r, ['opponentname', 'opponent', 'name', 'team', 'teamname', 'pagename']);
    const place = num(pick(r, ['placement', 'place', 'rank', 'position', 'slotnumber']));
    const wins = num(pick(r, ['wins', 'won', 'matchwins', 'scoreboard_wins']));
    const losses = num(pick(r, ['losses', 'lost', 'matchlosses', 'scoreboard_losses']));
    const points = num(pick(r, ['points', 'score', 'prizepoints', 'pointssum']));
    return {
      placement: place != null ? place : i + 1,
      name: name != null ? String(name) : '',
      wins: wins != null ? wins : 0,
      losses: losses != null ? losses : 0,
      points: points,
      played: (wins != null || losses != null) ? (wins || 0) + (losses || 0) > 0 : false
    };
  }).filter((r) => r.name);
}

module.exports = {
  LIQUIPEDIA_ATTRIBUTION,
  HOURLY_LIMIT,
  SAFE_LIMIT,
  DEFAULT_TTL_MS,
  RateBudget,
  LiquipediaCache,
  buildUserAgent,
  lpRequest,
  queryCached,
  rowsOf,
  normaliseStandings
};
