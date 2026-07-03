/* ─── League of Legends in-game data (Live Client Data API, port 2999) ─────────
 *
 * Drives the automated in-game LoL HUD overlay. Same local-API pattern as the
 * Valorant (2999) and CS2 (GSI) integrations: League exposes an HTTPS server on
 * 127.0.0.1:2999 (self-signed cert) while a game is running. In SPECTATOR mode
 * (the tournament observer client watching a custom/tournament game) the
 * `/liveclientdata/allgamedata` endpoint returns all 10 players with champion,
 * level, KDA, CS, items and summoner spells, plus the full event feed and the
 * game clock — everything a broadcast scoreboard needs.
 *
 * GOLD CAVEAT: the Live Client Data API does NOT expose per-player or team gold
 * for spectated players (only `activePlayer.currentGold`, which is the local
 * player and is absent in spectator mode). Pro broadcasts get gold from Riot's
 * private esports feed; community overlays ESTIMATE it. We compute an approximate
 * net worth per player (start + passive income + CS + kills + assists) so the
 * "collective gold" and gold-lead indicator are meaningful. It is clearly an
 * estimate, accurate enough for the gold-diff bar, not to-the-coin exact.
 *
 * server.js owns the poll timer, state.lol and the WS broadcast (mirroring the
 * Valorant integration); this module is the pure, testable parser + fetcher.
 */
const https = require('https');

const _agent = new https.Agent({ rejectUnauthorized: false });

// Champion display-name → local portrait path (same assets the draft board uses).
// Display name ≠ id for a few champs (Wukong→MonkeyKing, Nunu & Willump→Nunu, etc.),
// so we map through champions.json rather than lowercasing the name.
const CHAMP_PORTRAIT = {};
try {
  const champs = require('../assets/lol/champions.json');
  champs.forEach((c) => { if (c && c.name && c.id) CHAMP_PORTRAIT[c.name.toLowerCase()] = '/assets/heroes/league/' + c.id.toLowerCase() + '.png'; });
} catch (e) {}
function portraitFor(name) {
  return CHAMP_PORTRAIT[String(name || '').toLowerCase()] || '';
}

function fetchAllGameData() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata',
      method: 'GET', agent: _agent, timeout: 1500, headers: { Accept: 'application/json' }
    }, (res) => {
      let b = ''; res.on('data', (d) => b += d); res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// "game_character_displayname_Aatrox" / "Aatrox" → "Aatrox"
function cleanChampion(name, raw) {
  if (name) return name;
  const m = String(raw || '').match(/_([A-Za-z0-9']+)$/);
  return m ? m[1] : (raw || '');
}

// Passive gold income (approx): begins at 1:50 (110s) at ~2.04 gold/sec for every
// player. Returned as total accumulated passive gold for one player at gameTime.
function passiveGold(gameTime) {
  return gameTime > 110 ? (gameTime - 110) * 2.04 : 0;
}

// Estimated net worth (total gold EARNED) for a single player. This is what pro
// scoreboards display as "gold" — a gold LEAD, not unspent gold.
//   ~20 gold / CS (avg of melee/caster/cannon), 300 / kill, 150 / assist,
//   500 starting gold, plus passive income. Item value is implicitly covered by
//   the gold that bought them, so we do NOT also add item price (that would
//   double-count). Item value is surfaced separately for the loadout display.
const AVG_MINION_GOLD = 20.5;
function estimateNetWorth(p, gameTime) {
  const s = p.scores || {};
  return Math.round(
    500
    + passiveGold(gameTime)
    + (s.creepScore || 0) * AVG_MINION_GOLD
    + (s.kills || 0)   * 300
    + (s.assists || 0) * 150
  );
}

// Which side a turret belongs to from its object name.
//   "Turret_T1_C_05_A" → T1 = ORDER (blue) structure; a destroyed T1 turret is a
//   point for CHAOS (red). T2 = CHAOS (red) structure → point for ORDER (blue).
function turretOwner(name) {
  if (/_T1_/.test(name)) return 'ORDER';
  if (/_T2_/.test(name)) return 'CHAOS';
  return null;
}
function inhibOwner(name) {
  // "Barracks_T1_L1" belongs to ORDER; T2 to CHAOS.
  if (/_T1_/.test(name)) return 'ORDER';
  if (/_T2_/.test(name)) return 'CHAOS';
  return null;
}

// Build a fast name→team lookup so event killers can be attributed to a side.
function buildTeamIndex(players) {
  const idx = {};
  (players || []).forEach((p) => { if (p.name) idx[p.name] = p.team; });
  return idx;
}

// Parse the raw allgamedata payload into the normalised state our overlay reads.
function normalizeGameData(data) {
  const gd = data.gameData || {};
  const gameTime = Math.floor(gd.gameTime || 0);

  const players = (data.allPlayers || []).map((p) => {
    const s = p.scores || {};
    const items = (p.items || []).map((it) => ({
      id: it.itemID, name: it.displayName || '', price: it.price || 0,
      count: it.count || 1, slot: it.slot
    })).sort((a, b) => (a.slot || 0) - (b.slot || 0));
    const spells = p.summonerSpells || {};
    const champion = cleanChampion(p.championName, p.rawChampionName);
    return {
      name:      p.summonerName || '',
      champion,
      portrait:  portraitFor(champion),
      rawChampion: p.rawChampionName || '',
      team:      p.team || 'ORDER',           // ORDER = blue side, CHAOS = red side
      position:  p.position || '',            // TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY
      level:     p.level || 1,
      dead:      !!p.isDead,
      respawn:   Math.ceil(p.respawnTimer || 0),
      kills:     s.kills || 0,
      deaths:    s.deaths || 0,
      assists:   s.assists || 0,
      cs:        s.creepScore || 0,
      vision:    s.wardScore || 0,
      items,
      itemValue: items.reduce((g, it) => g + (it.price || 0) * (it.count || 1), 0),
      spells: [
        (spells.summonerSpellOne && spells.summonerSpellOne.displayName) || '',
        (spells.summonerSpellTwo && spells.summonerSpellTwo.displayName) || ''
      ],
      gold: 0  // filled below
    };
  });
  players.forEach((p) => { p.gold = estimateNetWorth({ scores: { creepScore: p.cs, kills: p.kills, assists: p.assists } }, gameTime); });

  const teamIdx = buildTeamIndex(players);
  const side = (t) => (t === 'CHAOS' ? 'red' : 'blue');

  // Objective + kill tallies derived from the event feed.
  const blue = { kills: 0, gold: 0, towers: 0, inhibs: 0, dragons: [], barons: 0, heralds: 0, grubs: 0, dragonSoul: '', firstBlood: false };
  const red  = { kills: 0, gold: 0, towers: 0, inhibs: 0, dragons: [], barons: 0, heralds: 0, grubs: 0, dragonSoul: '', firstBlood: false };
  const teamObj = { blue, red };

  // Kills + gold come straight from the per-player scores (reliable).
  players.forEach((p) => {
    const t = teamObj[side(p.team)];
    t.kills += p.kills;
    t.gold  += p.gold;
  });

  const events = (data.events && data.events.Events) || [];
  const notable = [];
  for (const ev of events) {
    const name = ev.EventName;
    if (name === 'TurretKilled') {
      const owner = turretOwner(ev.TurretKilled || '');
      if (owner === 'ORDER') red.towers++;        // ORDER's turret fell → red scored
      else if (owner === 'CHAOS') blue.towers++;
    } else if (name === 'InhibKilled') {
      const owner = inhibOwner(ev.InhibKilled || '');
      if (owner === 'ORDER') red.inhibs++;
      else if (owner === 'CHAOS') blue.inhibs++;
    } else if (name === 'DragonKill') {
      const killerSide = side(teamIdx[ev.KillerName] || 'ORDER');
      teamObj[killerSide].dragons.push(ev.DragonType || 'Unknown');
    } else if (name === 'BaronKill') {
      teamObj[side(teamIdx[ev.KillerName] || 'ORDER')].barons++;
    } else if (name === 'HeraldKill') {
      teamObj[side(teamIdx[ev.KillerName] || 'ORDER')].heralds++;
    } else if (name === 'HordeKill' || name === 'VoidgrubKill') {
      teamObj[side(teamIdx[ev.KillerName] || 'ORDER')].grubs++;
    } else if (name === 'FirstBlood') {
      // FirstBlood carries `Recipient` (the killer); some patches use KillerName.
      const fbName = ev.Recipient || ev.KillerName || '';
      teamObj[side(teamIdx[fbName] || 'ORDER')].firstBlood = true;
    }
    if (['ChampionKill','Multikill','Ace','FirstBlood','DragonKill','BaronKill','HeraldKill','TurretKilled','InhibKilled'].includes(name)) {
      notable.push({ name, time: Math.floor(ev.EventTime || 0), killer: ev.KillerName || '', victim: ev.VictimName || '', dragon: ev.DragonType || '', streak: ev.KillStreak || 0 });
    }
  }

  // Elemental soul: 4th dragon of a single element grants that team the soul.
  [['blue', blue], ['red', red]].forEach(([, t]) => {
    if (t.dragons.length >= 4) {
      const counts = {};
      t.dragons.forEach((d) => { if (d !== 'Elder') counts[d] = (counts[d] || 0) + 1; });
      const soul = Object.keys(counts).find((k) => counts[k] >= 2);
      if (soul) t.dragonSoul = soul;
    }
  });

  return {
    connected: true,
    gameTime,
    mapNumber: gd.mapNumber || 1,
    gameMode: gd.gameMode || '',
    blue, red,
    goldDiff: blue.gold - red.gold,     // + = blue ahead
    players,
    events: notable.slice(-12),
  };
}

module.exports = { fetchAllGameData, normalizeGameData, estimateNetWorth, cleanChampion, passiveGold };
