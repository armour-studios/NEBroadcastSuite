'use strict';

// ── Riot Games API client ────────────────────────────────────────────────────
//
// The producer brings their OWN key (developer or production) from
// https://developer.riotgames.com — the licensing relationship is theirs, not the suite's.
//
// Two things about Riot's API shape everything here:
//
//   • TWO routing families. Account and match endpoints live on a REGIONAL host
//     (americas / europe / asia / sea); summoner, league, spectator and status live on a
//     PLATFORM host (na1 / euw1 / kr / …). A key works on both, but the wrong host is a 404
//     that looks exactly like "player not found", so both are stored and both are labelled.
//   • A DEVELOPMENT key expires every 24 hours. That is the single most common "it broke
//     overnight" cause, and a dead key answers 403 — not 401 — so the error text says so
//     rather than leaving a producer hunting a typo mid-show.
//
// Nothing here polls. Every call is producer-initiated (Test / Look up), so a rate-limited
// dev key (20 req/s, 100 per 2 min) is never spent by the app on its own.

const https = require('https');

// Regional routes — account-v1, match-v5.
const REGIONS = ['americas', 'europe', 'asia', 'sea'];

// Platform routes — summoner-v4, league-v4, spectator-v5, lol-status-v4.
const PLATFORMS = {
  na1: 'North America', br1: 'Brazil', la1: 'LAN', la2: 'LAS', oc1: 'Oceania',
  euw1: 'EU West', eun1: 'EU Nordic & East', tr1: 'Türkiye', ru: 'Russia', me1: 'Middle East',
  kr: 'Korea', jp1: 'Japan', sg2: 'Singapore', tw2: 'Taiwan', vn2: 'Vietnam', th2: 'Thailand', ph2: 'Philippines'
};

// Which regional route a platform belongs to — used to keep the two selectors in step so a
// producer can't pick "kr" + "americas" and get an unexplainable 404.
const PLATFORM_REGION = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea', th2: 'sea', ph2: 'sea'
};

const RANKED_QUEUES = {
  RANKED_SOLO_5x5: 'Solo/Duo',
  RANKED_FLEX_SR: 'Flex',
  RANKED_TFT: 'TFT',
  RANKED_TFT_DOUBLE_UP: 'TFT Double Up'
};

/** A dev key looks like RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx; a production key does not
 *  carry that prefix. Worth knowing because only the dev one expires daily. */
function keyKind(key) {
  const k = String(key || '').trim();
  if (!k) return 'none';
  return /^RGAPI-/i.test(k) ? 'development' : 'production';
}

function hostFor(routeOrPlatform) {
  return String(routeOrPlatform || '').trim().toLowerCase() + '.api.riotgames.com';
}

/** Riot answers errors as JSON ({status:{status_code,message}}), but a gateway 503 can be HTML.
 *  Map to a sentence a producer can act on rather than echoing a status number. */
function explain(code, key, body) {
  const kind = keyKind(key);
  if (code === 401) return 'Riot rejected the request with no key attached (401). Save your API key first.';
  if (code === 403) {
    return kind === 'development'
      ? 'Riot rejected the key (403). Development keys expire every 24 hours — regenerate yours at developer.riotgames.com and paste the new one.'
      : 'Riot rejected the key (403). Check the key is correct and that your product is approved for this endpoint.';
  }
  if (code === 404) return 'Riot returned "not found" (404) — check the Riot ID spelling and that the region matches the account.';
  if (code === 429) return 'Riot rate-limited the key (429). Wait a moment and try again.';
  if (code === 415) return 'Riot refused the request format (415).';
  if (code >= 500) return 'Riot\'s API is having trouble right now (' + code + '). Try again shortly.';
  const msg = body && body.status && body.status.message;
  return 'Riot API error ' + code + (msg ? ': ' + msg : '');
}

/** One GET against a Riot host. Resolves { ok, status, data, error }; never throws for an
 *  HTTP status, so callers handle a dead key the same way as a bad name. */
function riotGet(key, host, pathname, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const k = String(key || '').trim();
    if (!k) return resolve({ ok: false, status: 0, error: 'No Riot API key saved.' });

    const req = https.request({
      host, path: pathname, method: 'GET',
      headers: { 'X-Riot-Token': k, 'Accept': 'application/json' }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, data });
        } else {
          resolve({ ok: false, status: res.statusCode, data, error: explain(res.statusCode, k, data) });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: 'Could not reach Riot: ' + e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, status: 0, error: 'Riot did not answer in time.' }); });
    req.end();
  });
}

/** Cheapest call that proves a key works: LoL platform status needs no player and no extra
 *  product approval. */
async function checkKey(key, platform = 'na1') {
  const res = await riotGet(key, hostFor(platform), '/lol/status/v4/platform-data');
  if (!res.ok) return { ok: false, error: res.error, status: res.status };
  const d = res.data || {};
  const incidents = [].concat(d.incidents || [], d.maintenances || []).length;
  return {
    ok: true,
    keyKind: keyKind(key),
    platformName: d.name || PLATFORMS[platform] || platform,
    locales: (d.locales || []).slice(0, 3),
    incidents
  };
}

/** Riot ID ("Name#TAG") → account. The only identity lookup that works across LoL, Valorant
 *  and TFT, and the one that replaced summoner names. */
async function accountByRiotId(key, region, gameName, tagLine) {
  const p = '/riot/account/v1/accounts/by-riot-id/' +
    encodeURIComponent(String(gameName || '').trim()) + '/' +
    encodeURIComponent(String(tagLine || '').trim());
  const res = await riotGet(key, hostFor(region), p);
  if (!res.ok) return { ok: false, error: res.error, status: res.status };
  return { ok: true, account: res.data || null };
}

/** LoL summoner record for a puuid (level, profile icon). Platform-routed. */
async function summonerByPuuid(key, platform, puuid) {
  const res = await riotGet(key, hostFor(platform), '/lol/summoner/v4/summoners/by-puuid/' + encodeURIComponent(puuid));
  if (!res.ok) return { ok: false, error: res.error, status: res.status };
  return { ok: true, summoner: res.data || null };
}

/** Ranked entries. by-puuid is the current route; older keys/regions still answer the
 *  by-summoner one, so fall back rather than showing "unranked" for a ranked player. */
async function leagueEntries(key, platform, puuid, summonerId) {
  let res = await riotGet(key, hostFor(platform), '/lol/league/v4/entries/by-puuid/' + encodeURIComponent(puuid));
  if (!res.ok && res.status === 404 && summonerId) {
    res = await riotGet(key, hostFor(platform), '/lol/league/v4/entries/by-summoner/' + encodeURIComponent(summonerId));
  }
  if (!res.ok) return { ok: false, error: res.error, status: res.status };
  const rows = Array.isArray(res.data) ? res.data : [];
  return {
    ok: true,
    entries: rows.map((e) => ({
      queue: RANKED_QUEUES[e.queueType] || e.queueType,
      tier: e.tier || '', rank: e.rank || '', lp: e.leaguePoints || 0,
      wins: e.wins || 0, losses: e.losses || 0
    }))
  };
}

/** Full player card for a Riot ID: identity (regional) + level and rank (platform).
 *  The rank half is best-effort — a Valorant/TFT-only account has no LoL summoner, and that
 *  must read as "no LoL data", not as a broken key. */
async function lookupPlayer(key, { region, platform, riotId }) {
  const raw = String(riotId || '').trim().replace(/^@/, '');
  const hash = raw.lastIndexOf('#');
  if (hash < 1 || hash === raw.length - 1) {
    return { ok: false, error: 'Enter a full Riot ID including the tag, e.g. Faker#KR1.' };
  }
  const gameName = raw.slice(0, hash);
  const tagLine = raw.slice(hash + 1);

  const acc = await accountByRiotId(key, region, gameName, tagLine);
  if (!acc.ok) return acc;
  const account = acc.account || {};

  const out = {
    ok: true,
    riotId: (account.gameName || gameName) + '#' + (account.tagLine || tagLine),
    puuid: account.puuid || '',
    region, platform,
    summonerLevel: null,
    entries: [],
    note: ''
  };
  if (!out.puuid) return out;

  const sum = await summonerByPuuid(key, platform, out.puuid);
  if (sum.ok && sum.summoner) {
    out.summonerLevel = sum.summoner.summonerLevel != null ? sum.summoner.summonerLevel : null;
    const lg = await leagueEntries(key, platform, out.puuid, sum.summoner.id);
    if (lg.ok) out.entries = lg.entries;
  } else if (sum.status === 404) {
    out.note = 'No League of Legends account on ' + (PLATFORMS[platform] || platform) + ' — the Riot ID resolved, so the key is fine.';
  } else if (sum.error) {
    out.note = sum.error;
  }
  return out;
}

module.exports = {
  REGIONS, PLATFORMS, PLATFORM_REGION, RANKED_QUEUES,
  keyKind, riotGet, checkKey, accountByRiotId, summonerByPuuid, leagueEntries, lookupPlayer
};
