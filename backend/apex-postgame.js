'use strict';
// Apex Legends post-game results for tournament (private match) lobbies.
//
// EA's Custom Match / Tournament setup guide (S30) documents the endpoint: every tournament code
// set comes with a stats token (in the .csv EA sends the organiser), and
//   https://r5-crossplay.r5prod.stryder.respawn.com/privatematch/?token=<statsToken>
// returns the post-game summary of the matches played with those codes. The guide says the
// in-match kill counter is not reliable and to use this (or the match summary) for results.
// A token only returns data once EA has approved it (organisers register it, e.g. through
// apex.seatlon.eu/add, EA's partner tool); until then it returns nothing useful.
//
// The response format is not published. Parsing is deliberately tolerant (several field names per
// value, per-player rows grouped into teams), and the last raw response is kept on disk so the
// first real pull can be checked: see server.js apexPullResults.
const https = require('https');

const ENDPOINT = 'https://r5-crossplay.r5prod.stryder.respawn.com/privatematch/';

function fetchPostGame(token, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const t = String(token || '').trim();
    if (!/^[A-Za-z0-9_\-.]{6,200}$/.test(t)) { reject(new Error('That does not look like a stats token. Copy it from the token .csv EA sent you.')); return; }
    const req = https.get(ENDPOINT + '?token=' + encodeURIComponent(t), { headers: { 'User-Agent': 'BroadcastStudio/1.0', Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 20e6) { req.destroy(new Error('Response too large')); } });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) { reject(new Error('EA refused this stats token. It may not be approved yet, or it has expired.')); return; }
        if (res.statusCode >= 400) { reject(new Error('EA stats server answered HTTP ' + res.statusCode + '.')); return; }
        let json = null;
        try { json = JSON.parse(body); } catch (e) { reject(Object.assign(new Error('EA stats server did not send JSON.'), { raw: body.slice(0, 2000) })); return; }
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('EA stats server did not answer in time.')));
    req.on('error', reject);
  });
}

const pick = (o, names, d) => { for (const n of names) if (o && o[n] != null && o[n] !== '') return o[n]; return d; };
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// One match -> { id, startedAt, map, mode, teams:[{ teamNum, name, placement, kills, damage, players:[...] }] }
function parseMatch(m, i) {
  const rows = pick(m, ['player_results', 'playerResults', 'players', 'player_stats', 'results'], []) || [];
  const byTeam = new Map();
  (Array.isArray(rows) ? rows : []).forEach((p) => {
    const teamNum = num(pick(p, ['teamNum', 'team_num', 'teamId', 'team_id', 'squadId', 'team'], 0));
    const tname = String(pick(p, ['teamName', 'team_name', 'squadName'], '') || ('Team ' + (teamNum || '?')));
    const key = teamNum || tname;
    if (!byTeam.has(key)) byTeam.set(key, { teamNum, name: tname, placement: 0, kills: 0, damage: 0, players: [] });
    const t = byTeam.get(key);
    const placement = num(pick(p, ['teamPlacement', 'team_placement', 'placement', 'rank'], 0));
    if (placement && (!t.placement || placement < t.placement)) t.placement = placement;
    const player = {
      name: String(pick(p, ['playerName', 'player_name', 'name', 'nucleusName'], '') || ''),
      id: String(pick(p, ['nidHash', 'nid_hash', 'nucleusHash', 'hardwareId', 'platformId', 'uid'], '') || ''),
      legend: String(pick(p, ['characterName', 'character', 'legend'], '') || ''),
      kills: num(pick(p, ['kills', 'eliminations'], 0)),
      assists: num(pick(p, ['assists'], 0)),
      knocks: num(pick(p, ['knockdowns', 'knocks', 'downs'], 0)),
      damage: num(pick(p, ['damageDealt', 'damage_dealt', 'damage'], 0)),
      survival: num(pick(p, ['survivalTime', 'survival_time'], 0)),
      revives: num(pick(p, ['revivesGiven', 'revives'], 0)),
      respawns: num(pick(p, ['respawnsGiven', 'respawns'], 0)),
    };
    t.kills += player.kills; t.damage += player.damage;
    t.players.push(player);
  });
  const teams = [...byTeam.values()].sort((a, b) => (a.placement || 99) - (b.placement || 99));
  const started = pick(m, ['match_start', 'matchStart', 'start', 'startTime', 'timestamp'], 0);
  return {
    id: String(pick(m, ['mid', 'match_id', 'matchId', 'id'], '') || ('m' + i)),
    startedAt: started ? (num(started) > 1e12 ? num(started) : num(started) * 1000) : 0,
    map: String(pick(m, ['map_name', 'mapName', 'map'], '') || ''),
    mode: String(pick(m, ['game_mode', 'gameMode', 'mode', 'playlist'], '') || ''),
    teams,
  };
}

// The whole response -> matches, oldest first. Accepts { matches: [...] }, a bare array, or one match.
function parsePostGame(json) {
  let list = [];
  if (Array.isArray(json)) list = json;
  else if (json && typeof json === 'object') {
    list = pick(json, ['matches', 'data', 'results', 'games'], null);
    if (!Array.isArray(list)) list = (json.player_results || json.playerResults) ? [json] : [];
  }
  return list.map(parseMatch).filter((m) => m.teams.length).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// Matches -> the app's series games ({ n, map, results:[{ key, name, teamId, kills, placement }] },
// see backend/apex-live.js finalizeGame), marked official so the producer can tell them apart.
function toSeriesGames(matches, teamKeyOf) {
  return matches.map((m, i) => ({
    n: i + 1, map: m.map, official: true, matchId: m.id, startedAt: m.startedAt,
    results: m.teams.map((t) => ({ key: teamKeyOf ? teamKeyOf(t.name, t.teamNum) : t.name, name: t.name, teamId: t.teamNum, kills: t.kills, placement: t.placement, damage: t.damage })),
  }));
}

module.exports = { ENDPOINT, fetchPostGame, parsePostGame, parseMatch, toSeriesGames };
