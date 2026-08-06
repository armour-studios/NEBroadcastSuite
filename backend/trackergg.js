'use strict';
/**
 * tracker.gg rank lookup for Rocket League.
 *
 * Uses Electron's BrowserWindow to load the tracker.gg profile page in a real
 * Chromium instance. This passes Cloudflare's bot detection automatically —
 * no API key required.
 *
 * The first lookup per session solves the Cloudflare challenge (~2-4 s).
 * Subsequent lookups reuse the cf_clearance cookie stored in the
 * 'persist:trackergg' partition, so they're faster (~1-2 s).
 *
 * Up to MAX_CONCURRENT windows are open at once; extras queue.
 * Results are cached in-memory (6 h found, 5 min not-found).
 */

const CACHE_TTL      = 6 * 60 * 60 * 1000;  // 6 h for found profiles
const CACHE_TTL_MISS = 5 * 60 * 1000;        // 5 min for not-found
const CACHE_TTL_ERR  = 60 * 1000;            // 1 min for transient errors
const MAX_CONCURRENT = 2;                     // max simultaneous hidden windows
const PAGE_TIMEOUT   = 40000;                 // hard abort after 40 s

const _cache = new Map();
let _active = 0;
const _queue = [];

// ── RL competitive rank → 6mans tier ─────────────────────────────────────────
// The 6mans ladder is NOT a relabelling of the RL ladder — it starts at Diamond and only its bottom
// five letters correspond to an RL rank at all:
//   H  Diamond I – Diamond III        (the floor of 6mans)
//   E  Champion I – Champion II
//   D  Champion III – Grand Champion I
//   C  Grand Champion II – Grand Champion III
//   B  high Grand Champion III – SSL
//   B+ / A / X / S   earned by ELO promotion out of B / B+ / A (X is also near-pro / RLCS-bubble,
//                    S is top professional) — NO RL rank maps here.
// So a tracker.gg standard rank can never justify B+ or above; the ceiling this table can hand out is
// B, and anything above that has to come from a verified rl6mans ELO. Getting this wrong inflates a
// seed badly — the previous table put Champion II on A, four tiers too high.
const RL_TO_6MANS = {
  'Supersonic Legend':  'B',
  'Grand Champion III': 'C',   // "high GC3" is B, but tracker's tier alone can't tell high from low — stay conservative
  'Grand Champion II':  'C',
  'Grand Champion I':   'D',
  'Champion III':       'D',
  'Champion II':        'E',
  'Champion I':         'E',
  'Diamond III':        'H',
  'Diamond II':         'H',
  'Diamond I':          'H',
  // Below Diamond is beneath the 6mans floor. Pin to H rather than dropping the player: H is the lowest
  // bucket, so it can't inflate anyone, and it still sorts them under everyone with a real tier.
  'Platinum III':       'H',
  'Platinum II':        'H',
  'Platinum I':         'H',
  'Gold III':           'H',
  'Gold II':            'H',
  'Gold I':             'H',
  'Silver III':         'H',
  'Silver II':          'H',
  'Silver I':           'H',
  'Bronze III':         'H',
  'Bronze II':          'H',
  'Bronze I':           'H',
  'Unranked':           null,
};

function rlTo6mans(displayValue) {
  if (!displayValue) return null;
  const v = displayValue.toString().trim();
  if (RL_TO_6MANS[v] !== undefined) return RL_TO_6MANS[v];
  const stripped = v.replace(/\s+div(?:ision)?\s+\d+$/i, '').trim();
  if (RL_TO_6MANS[stripped] !== undefined) return RL_TO_6MANS[stripped];
  for (const [key, tier] of Object.entries(RL_TO_6MANS)) {
    if (key && v.startsWith(key)) return tier;
  }
  return null;
}

// Pick the highest-ranked playlist from tracker.gg segments JSON
function parseBestRank(segments) {
  if (!Array.isArray(segments)) return null;
  let best = null;
  for (const seg of segments) {
    if (seg.type !== 'playlist') continue;
    const tierDisplay = seg.stats?.tier?.displayValue;
    if (!tierDisplay || /unranked/i.test(tierDisplay)) continue;
    const rating = seg.stats?.rating?.value || 0;
    if (!best || rating > best.mmr) {
      best = {
        playlist: seg.metadata?.name || null,
        tier:     tierDisplay,
        division: seg.stats?.division?.displayValue || null,
        mmr:      rating,
      };
    }
  }
  if (!best) return null;
  best.rank       = best.division ? `${best.tier} ${best.division}` : best.tier;
  best.sixmansTier = rlTo6mans(best.rank) || rlTo6mans(best.tier);
  return best;
}

// ── Concurrency queue ─────────────────────────────────────────────────────────
function _drainQueue() {
  if (_active >= MAX_CONCURRENT || !_queue.length) return;
  const { platform, username, resolve } = _queue.shift();
  _active++;
  _doLookup(platform, username)
    .then(resolve)
    .catch(() => resolve({ found: false, error: 'internal', platform, username }))
    .finally(() => { _active--; _drainQueue(); });
}

// ── Public API ────────────────────────────────────────────────────────────────
async function lookup(platform, username) {
  if (!platform || !username) return { found: false, error: 'missing_params' };
  const key = `${platform.toLowerCase()}:${username.toLowerCase()}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < (hit.ttl || CACHE_TTL)) return hit.result;

  const result = await new Promise((resolve) => {
    _queue.push({ platform, username, resolve });
    _drainQueue();
  });

  const ttl = result.found    ? CACHE_TTL
            : result.error === 'not_found' ? CACHE_TTL_MISS
            : CACHE_TTL_ERR;
  _cache.set(key, { result, ts: Date.now(), ttl });
  return result;
}

// Try the SAME handle across several platforms, returning the first that resolves a rank. Used when
// we only have the tournament gamerTag (start.gg rarely exposes other players' connected accounts) and
// don't know which platform it belongs to. Stops at the first hit; otherwise returns the last miss.
const DEFAULT_PLATFORM_ORDER = ['epic', 'psn', 'steam', 'xbl', 'switch'];
async function lookupAny(username, platforms) {
  if (!username) return { found: false, error: 'missing_params' };
  const order = (Array.isArray(platforms) && platforms.length) ? platforms : DEFAULT_PLATFORM_ORDER;
  let last = null;
  for (const plt of order) {
    const r = await lookup(plt, username);
    if (r && r.found) return r;   // r carries the resolved `platform` so the caller can remember it
    last = r;
  }
  return last || { found: false, error: 'not_found', username };
}

function invalidate(platform, username) {
  if (platform && username) _cache.delete(`${platform.toLowerCase()}:${username.toLowerCase()}`);
}

// ── BrowserWindow scrape ──────────────────────────────────────────────────────
async function _doLookup(platform, username) {
  let BrowserWindow;
  try { BrowserWindow = require('electron').BrowserWindow; }
  catch (_) { return { found: false, error: 'not_in_electron', platform, username }; }

  const profileUrl =
    `https://tracker.gg/rocket-league/profile/${encodeURIComponent(platform)}/${encodeURIComponent(username)}/overview`;

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      try { win.destroy(); } catch (_) {}
      resolve(result);
    };

    const hard = setTimeout(
      () => done({ found: false, error: 'timeout', platform, username }),
      PAGE_TIMEOUT
    );

    const win = new BrowserWindow({
      show:         false,
      skipTaskbar:  true,
      width:        1280,
      height:       900,
      webPreferences: {
        nodeIntegration:  false,
        contextIsolation: true,
        partition:        'persist:trackergg',   // reuse CF clearance cookie
        javascript:       true,
      },
    });

    // Block heavy assets to speed up load
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ['*://*/*'] },
      (details, callback) => {
        const url = details.url;
        const block = /\.(woff2?|ttf|eot|mp4|webm|gif)(\?|$)/.test(url)
                   || /ads\.|doubleclick\.|googletagmanager\./.test(url);
        callback({ cancel: block });
      }
    );

    win.webContents.on('did-finish-load', () => {
      let attempts = 0;
      const poll = async () => {
        if (settled) return;
        if (attempts++ > 30) {
          done({ found: false, error: 'render_timeout', platform, username });
          return;
        }
        try {
          const raw = await win.webContents.executeJavaScript(EXTRACT_JS);
          if (!raw) { setTimeout(poll, 600); return; }
          const data = JSON.parse(raw);

          if (data.loading)  { setTimeout(poll, 600); return; }
          if (data.notFound) { done({ found: false, error: 'not_found', platform, username }); return; }

          if (data.segments) {
            const best = parseBestRank(data.segments);
            if (!best) { done({ found: false, error: 'no_rank', platform, username }); return; }
            done({ found: true, platform, username, source: 'trackergg', ...best });
            return;
          }

          if (data.rankText) {
            const rankText = data.rankText.trim();
            done({
              found: true, platform, username, source: 'trackergg',
              tier: rankText, division: null, rank: rankText,
              mmr: data.mmr || null,
              sixmansTier: rlTo6mans(rankText),
            });
            return;
          }

          setTimeout(poll, 600);
        } catch (_) { setTimeout(poll, 600); }
      };
      setTimeout(poll, 2500);   // Initial pause for CF challenge + React render
    });

    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (code === -3) return;            // Aborted navigation (e.g. our own asset cancels) — ignore
      if (isMainFrame === false) return;  // A SUBRESOURCE failed (blocked ad/font/beacon), not the page
      // itself — ignore, else a single failed sub-request killed the whole lookup ("Page failed to load"
      // for everyone) even though the profile page rendered fine.
      done({ found: false, error: 'load_failed', platform, username, code, desc });
    });

    win.loadURL(profileUrl);
  });
}

// JavaScript executed inside the tracker.gg page to extract rank data
const EXTRACT_JS = `(function(){
  try {
    if (!document.body) return null;
    const title = document.title || '';
    const text  = document.body.innerText || '';
    // Still on Cloudflare challenge page
    if (/checking your browser|just a moment|attention required/i.test(title)) {
      return JSON.stringify({ loading: true });
    }
    // Player not found
    if (/we could not find this player|player not found|no account found|this player does not exist/i.test(text)) {
      return JSON.stringify({ notFound: true });
    }
    // ── Strategy 1: __NEXT_DATA__ (Next.js SSR) ──────────────────────────
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl && ndEl.textContent) {
      try {
        const nd = JSON.parse(ndEl.textContent);
        const segs = nd?.props?.pageProps?.data?.segments
                  || nd?.props?.pageProps?.trn?.data?.segments
                  || nd?.props?.pageProps?.initialData?.data?.segments;
        if (Array.isArray(segs) && segs.length > 0) {
          return JSON.stringify({ segments: segs });
        }
      } catch(_) {}
    }
    // ── Strategy 2: DOM — rank image alts ────────────────────────────────
    const RANKS = ['Supersonic Legend','Grand Champion III','Grand Champion II','Grand Champion I',
      'Champion III','Champion II','Champion I','Diamond III','Diamond II','Diamond I',
      'Platinum III','Platinum II','Platinum I','Gold III','Gold II','Gold I',
      'Silver III','Silver II','Silver I','Bronze III','Bronze II','Bronze I'];
    const imgs = document.querySelectorAll('img');
    const ranked = [];
    imgs.forEach(img => {
      const alt = (img.alt || '').trim();
      if (RANKS.some(r => alt.startsWith(r))) ranked.push(alt);
    });
    if (ranked.length > 0) {
      return JSON.stringify({ rankText: ranked[0], mmr: null });
    }
    // ── Strategy 3: DOM — tier name text nodes ────────────────────────────
    const tierEls = document.querySelectorAll(
      '[class*="tier"] span, [class*="rank"] span, .tierLabel, [data-value]'
    );
    for (const el of tierEls) {
      const t = el.textContent.trim();
      if (RANKS.some(r => t.startsWith(r))) {
        return JSON.stringify({ rankText: t, mmr: null });
      }
    }
    // Page loaded but data not rendered yet — retry
    if (text.length < 400) return JSON.stringify({ loading: true });
    return JSON.stringify({ loading: true });
  } catch(e) {
    return JSON.stringify({ loading: true });
  }
})()`;

module.exports = { lookup, lookupAny, invalidate, rlTo6mans };
