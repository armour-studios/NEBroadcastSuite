/*
  brawlhalla.js — the Brawlhalla data layer: name → player → ranked card, with the caches that
  keep us well inside the API's 2000-requests-per-5-minutes budget.

  WHAT THIS CAN AND CANNOT DO (read this before wiring anything new to it):

    CAN   look a player up by name, and return their ranked identity — ELO, tier, peak, global and
          regional rank, season W/L, and the legends they actually play, ordered by games.
    CAN   pull a region's ranked leaderboard (a standings/top-8 board with no bracket at all).
    CANNOT tell you what is happening in a live match. Brawlhalla ships no GSI, no spectator feed
          and no "currently playing" endpoint — the API is career statistics only. Stocks, the
          legend on screen and the set score are PRODUCER-DRIVEN on our overlay, exactly like Smash.

  THE NAME LOOKUP IS A LEADERBOARD SEARCH. v1 has no /search endpoint: you find a player by
  searching the ranked leaderboard they appear on. An unranked player therefore cannot be found by
  name at all — callers must present that as "not ranked this season", never as a failure. Once a
  producer has a brawlhalla_id (from the search, or typed from the player's profile URL) it is
  stored on the roster and the name search is never needed again.
*/

'use strict';

const { createBrawlhallaClient, BH_REGIONS, BH_MODES } = require('./integrations/brawlhalla-client');

// Cache lifetimes. A ranked card moves at the speed of someone finishing a ladder match, so
// minutes are fine and seconds would just burn budget on a board nobody is looking at.
const SEARCH_TTL_MS = 10 * 60 * 1000;
const CARD_TTL_MS = 5 * 60 * 1000;
const LEGENDS_TTL_MS = 24 * 60 * 60 * 1000;

function createBrawlhalla(opts = {}) {
  const client = opts.client || createBrawlhallaClient(opts);
  const searchCache = new Map();   // "mode|region|query" -> { at, hits }
  const cardCache = new Map();     // "id|mode"           -> { at, card }
  let legendsCache = { at: 0, rows: [] };

  const now = () => Date.now();
  const fresh = (entry, ttl) => entry && (now() - entry.at) < ttl;

  /*
    One leaderboard row -> the shape our overlays and panels speak. A 2v2/3v3 row carries several
    players, so `players` is always an array and `name` is the display line for the whole entry
    (the team name a 2v2 board wants).
  */
  function normalizeRankingRow(row) {
    const players = (row.players || []).map((p) => ({ id: p.id, name: p.username || '' }));
    return {
      brawlhallaId: players.length === 1 ? players[0].id : 0,
      name: players.map((p) => p.name).join(' + ') || '',
      players,
      rank: row.rank || 0,
      rating: row.rating || 0,
      peakRating: row.best_rating || 0,
      tier: row.tier || '',
      wins: row.wins || 0,
      losses: row.losses || 0,
      region: row.region || ''
    };
  }

  /*
    Find players by name. `region` 'ALL' searches every region's board at once, which is what a
    producer almost always wants — they know the gamertag, not the region.
  */
  async function searchPlayers(query, { mode = '1v1', region = 'ALL', limit = 10 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const key = `${mode}|${region}|${q.toLowerCase()}`;
    const hit = searchCache.get(key);
    if (fresh(hit, SEARCH_TTL_MS)) return hit.hits;
    const res = await client.rankings({ mode, region, search: q, maxResults: Math.min(50, limit) });
    const hits = res.rankings.map(normalizeRankingRow);
    searchCache.set(key, { at: now(), hits });
    return hits;
  }

  /*
    The on-air identity card for one player. `mode` picks which ladder's rating is shown:
    'ranked_1v1' for singles, 'ranked_3v3' for the 3v3 ladder. (The API has no ranked_2v2 stats
    mode — 2v2 ratings live on the TEAM, which is what playerTeams() returns.)

    Returns null for an unknown id rather than throwing: a typo'd id on one side of the scoreboard
    must not take the other side's card down with it.
  */
  async function playerCard(brawlhallaId, { mode = 'ranked_1v1', force = false } = {}) {
    const id = Number(brawlhallaId);
    if (!id) return null;
    const key = `${id}|${mode}`;
    const hit = cardCache.get(key);
    if (!force && fresh(hit, CARD_TTL_MS)) return hit.card;

    const data = await client.playerStats(id, mode);
    if (!data || !data.brawlhalla_id) {
      cardCache.set(key, { at: now(), card: null });
      return null;
    }
    const games = data.games || 0;
    const wins = data.wins || 0;
    const card = {
      brawlhallaId: data.brawlhalla_id,
      name: data.name || '',
      rating: data.rating || 0,
      peakRating: data.peak_rating || 0,
      tier: data.tier || '',
      games,
      wins,
      // The ranked payload reports games + wins; losses are the remainder. Deriving it here means
      // every consumer prints the same number instead of each doing its own subtraction.
      losses: Math.max(0, games - wins),
      winRate: games ? Math.round((wins / games) * 1000) / 10 : 0,
      region: data.region || '',
      globalRank: data.global_rank || 0,
      regionRank: (() => {
        const rr = (data.region_ranks || []).find((r) => r.region === data.region) || (data.region_ranks || [])[0];
        return rr ? rr.rank || 0 : 0;
      })(),
      // Legends the player has actually played this season, most-played first. The overlay shows
      // the top one or two as "their legend"; a legend row with 0 games is the game's default
      // placement entry and is dropped so it can't be mistaken for a main.
      legends: (data.legends || [])
        .filter((l) => (l.games || 0) > 0)
        .sort((a, b) => (b.games || 0) - (a.games || 0))
        .slice(0, 5)
        .map((l) => ({ id: l.legend_id, games: l.games || 0, wins: l.wins || 0, rating: l.rating || 0, tier: l.tier || '' })),
      fetchedAt: now()
    };
    cardCache.set(key, { at: now(), card });
    return card;
  }

  // A region's ranked leaderboard, ready to push at a standings board.
  async function leaderboard({ mode = '1v1', region = 'ALL', page = 1, limit = 25, orderBy = '' } = {}) {
    const res = await client.rankings({ mode, region, page, maxResults: Math.min(50, limit), orderBy });
    return {
      rows: res.rankings.map((r, i) => ({ ...normalizeRankingRow(r), placement: r.rank || ((page - 1) * limit + i + 1) })),
      totalPages: res.totalPages
    };
  }

  // The static legend table, cached for a day. Callers that only need id→name should use the
  // shipped overlay/brawlhalla-legends.js registry instead — this is for refreshing that file.
  async function legends({ force = false } = {}) {
    if (!force && fresh(legendsCache, LEGENDS_TTL_MS) && legendsCache.rows.length) return legendsCache.rows;
    const rows = await client.allLegends();
    legendsCache = { at: now(), rows };
    return rows;
  }

  function clearCaches() {
    searchCache.clear();
    cardCache.clear();
    legendsCache = { at: 0, rows: [] };
  }

  return { client, searchPlayers, playerCard, leaderboard, legends, clearCaches, regions: BH_REGIONS, modes: BH_MODES };
}

module.exports = { createBrawlhalla, BH_REGIONS, BH_MODES };
