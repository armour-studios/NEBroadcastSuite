/* ─── Apex Legends LiveAPI ingestion ───────────────────────────────────────────
 *
 * Drives the automated Apex Legends broadcast HUD (overlay/apex.html). UNLIKE the
 * League (poll :2999) and Overwatch (Overwolf pushes HTTP) integrations, Apex's
 * LiveAPI makes the GAME a WebSocket *client*: it dials OUT to a server we host and
 * streams match events over that socket. So this module stands up a small WS server
 * (default ws://127.0.0.1:7777) and Apex connects into it.
 *
 * ENABLING IT (producer side, per spectator/observer PC running Apex):
 *   Launch options:  +cl_liveapi_enabled 1 +cl_liveapi_ws_servers "ws://127.0.0.1:7777"
 *                    +cl_liveapi_use_protobuf 0
 *   ...or drop the config.json this module generates (buildConfig/writeConfig) into
 *      %USERPROFILE%/Saved Games/Respawn/Apex/assets/temp/live_api/config.json
 *
 * WIRE FORMAT: LiveAPI defaults to protobuf. We force JSON (cl_liveapi_use_protobuf 0)
 * so no .proto tooling is needed. Every frame is a protobuf-JSON-mapped `LiveAPIEvent`
 * wrapping one `gameMessage` (an Any typed `rtech.liveapi.<EventName>`). Depending on
 * game version the frame is either:
 *     { timestamp, gameMessage: { "@type": ".../rtech.liveapi.ObserverSwitched", ... } }
 * or a flattened form with "@type" (or a `category`/`type` string) at the top level.
 * eventType()/eventBody() below normalise ALL of these, and the runner logs the first
 * few raw frames so the exact shape can be confirmed against a live capture.
 *
 * server.js owns the WS-server lifecycle, state.apex and the broadcast to overlays;
 * this module is the pure, testable server factory + parser + reducer.
 */
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Config.json ──────────────────────────────────────────────────────────────
// Sample config the game reads. Mirrors the CVars; `cl_liveapi_ws_servers` is the
// list of servers the game connects OUT to (i.e. us). JSON, not protobuf, so we can
// parse natively. See https://apexliveapi.com / EA LiveAPI docs for the full field set.
function buildConfig(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port || 7777;
  return {
    cl_liveapi_enabled: true,
    cl_liveapi_use_v2: true,           // LiveAPI 2.0 (websockets + protobuf-capable transport)
    cl_liveapi_use_websocket: true,    // act as a websocket client and connect to the servers below
    cl_liveapi_use_protobuf: false,    // send JSON frames (no .proto tooling needed on our side)
    cl_liveapi_ws_servers: `ws://${host}:${port}`,
    cl_liveapi_allow_requests: true,   // let us send requests back (change camera, etc.) later
    cl_liveapi_sessionName: opts.sessionName || 'ne_broadcast_suite',
    // Sensible reconnect/keepalive defaults so a mid-match relaunch of the studio recovers.
    cl_liveapi_ws_retry_count: 30,
    cl_liveapi_ws_retry_time: 5,
    cl_liveapi_ws_timeout: 10000,
    cl_liveapi_ws_keepalive: 60,
  };
}

// Default install path for the LiveAPI config on Windows.
function defaultConfigDir() {
  return path.join(os.homedir(), 'Saved Games', 'Respawn', 'Apex', 'assets', 'temp', 'live_api');
}

// Write config.json to the Apex Saved-Games location (creating the folder tree).
// Returns { ok, file } or { ok:false, error }. Best-effort; the launch-option route
// is always available as a fallback if the Saved Games folder isn't present yet.
function writeConfig(opts = {}) {
  try {
    const dir = opts.dir || defaultConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(buildConfig(opts), null, 2), 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function launchOptions(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port || 7777;
  return `+cl_liveapi_enabled 1 +cl_liveapi_ws_servers "ws://${host}:${port}" +cl_liveapi_use_protobuf 0`;
}

// ── Event envelope normalisation ─────────────────────────────────────────────
// Returns the bare event name ("ObserverSwitched", "PlayerKilled", ...) from any of
// the envelope shapes Apex has shipped, or '' if unrecognised.
function eventType(frame) {
  if (!frame || typeof frame !== 'object') return '';
  const strip = (t) => String(t || '').split(/[./]/).pop();   // ".../rtech.liveapi.PlayerKilled" -> "PlayerKilled"
  if (frame.gameMessage && typeof frame.gameMessage === 'object') {
    if (frame.gameMessage['@type']) return strip(frame.gameMessage['@type']);
    // Some builds put a single {EventName:{...}} under gameMessage.
    const keys = Object.keys(frame.gameMessage).filter((k) => k !== '@type');
    if (keys.length === 1) return strip(keys[0]);
  }
  if (frame['@type']) return strip(frame['@type']);
  if (frame.category) return strip(frame.category);
  if (frame.type) return strip(frame.type);
  if (frame.t) return strip(frame.t);
  return '';
}

// Returns the event's payload object regardless of nesting.
function eventBody(frame) {
  if (!frame || typeof frame !== 'object') return {};
  if (frame.gameMessage && typeof frame.gameMessage === 'object') {
    const gm = frame.gameMessage;
    const keys = Object.keys(gm).filter((k) => k !== '@type');
    if (keys.length === 1 && gm[keys[0]] && typeof gm[keys[0]] === 'object') return gm[keys[0]];
    return gm;
  }
  return frame;
}

// ── Player normalisation ─────────────────────────────────────────────────────
// A LiveAPI Player carries name, teamId, character (legend), and health/shield split
// into current/max fields. Field names drift slightly across versions, so read each
// through a small alias list.
function pick(o, keys, dflt) {
  for (const k of keys) { if (o && o[k] != null) return o[k]; }
  return dflt;
}
function normPlayer(p) {
  if (!p || typeof p !== 'object') return null;
  const name = pick(p, ['name', 'playerName', 'nick'], '');
  if (!name && p.teamId == null) return null;
  return {
    name,
    teamId:     Number(pick(p, ['teamId', 'team', 'squadIndex'], 0)) || 0,
    teamName:   pick(p, ['teamName', 'squadName'], ''),
    legend:     pick(p, ['character', 'legend', 'legendName'], ''),
    skin:       pick(p, ['skin'], ''),
    hp:         Number(pick(p, ['currentHealth', 'health', 'hp'], 0)) || 0,
    maxHp:      Number(pick(p, ['maxHealth', 'maxHp'], 100)) || 100,
    shield:     Number(pick(p, ['shieldHealth', 'shield'], 0)) || 0,
    maxShield:  Number(pick(p, ['shieldMaxHealth', 'maxShield'], 0)) || 0,
    nucleusHash: pick(p, ['nucleusHash'], ''),
    hardware:   pick(p, ['hardwareName'], ''),
    pos:        pick(p, ['pos', 'position'], null),
  };
}

// Stable identity for a player across events (nucleusHash is best; fall back to name).
function playerKey(p) {
  return (p && (p.nucleusHash || p.name)) || '';
}

// ── ALGS scoring ─────────────────────────────────────────────────────────────
// Points = placement points (by finishing position) + kill points. Accumulated across
// every game in a series/day. This is the current official ALGS table (1st..20th) + 1/kill.
const DEFAULT_SCORING = {
  placementPoints: [12, 9, 7, 5, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  killPoints: 1,
};
// Points a squad earns in ONE game from a finishing placement (1-based) + kill count.
function gamePoints(placement, kills, scoring) {
  const s = scoring || DEFAULT_SCORING;
  const pp = (placement >= 1 && placement <= s.placementPoints.length) ? (s.placementPoints[placement - 1] || 0) : 0;
  return pp + (kills || 0) * (s.killPoints || 0);
}

// Stable per-team identity key across games (the org, not the lobby slot). teamName is
// the org name in custom/ALGS lobbies; fall back to the lobby teamId.
function teamKeyOf(nameOrSquad, teamId) {
  const name = typeof nameOrSquad === 'string' ? nameOrSquad : (nameOrSquad && nameOrSquad.name);
  const norm = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (norm && !/^squad \d+$/.test(norm)) return norm;
  return 'team' + (teamId != null ? teamId : (nameOrSquad && nameOrSquad.teamId) || 0);
}

// ── Match-state reducer ──────────────────────────────────────────────────────
// Pure: given the current state and one parsed frame, returns the next state. server.js
// keeps a live copy and broadcasts it. Everything the overlay needs lives here.
function initialState() {
  return {
    connected: false,
    lastUpdate: 0,
    matchState: 'lobby',          // lobby | live | postmatch
    map: '',
    playlist: '',
    gameNumber: 1,                // which game of the series is live (1-based)
    ring: { stage: 0, current: 0, end: 0, shrinking: false },
    // The player the observer is currently spectating + their squad (the caster-follow card).
    observed: null,               // normPlayer + { squad: [normPlayer], kills, damage }
    squads: {},                   // teamId -> { teamId, key, name, players:{key:normPlayer}, alive, kills, placement }
    killfeed: [],                 // [{ attacker, victim, weapon, legend, ts }] newest last
    winners: [],                  // squad names / player names of the winning team (postmatch)
    games: [],                    // completed games: [{ n, map, results:[{ key, name, teamId, kills, placement }] }]
  };
}

// Clear per-game live state for the next game of the series; KEEP the games history.
function resetForNewGame(state) {
  state.squads = {};
  state.observed = null;
  state.killfeed = [];
  state.winners = [];
  state.ring = { stage: 0, current: 0, end: 0, shrinking: false };
  state.matchState = 'lobby';
  state.gameNumber = (state.games ? state.games.length : 0) + 1;
}

// Finalise the current game: assign placements to squads still alive (winner = 1), then
// snapshot every squad's kills + placement into games[]. Idempotent per game boundary.
function finalizeGame(state) {
  const squads = Object.values(state.squads || {});
  const aliveByKills = squads.filter((s) => s.alive).sort((a, b) => (b.kills || 0) - (a.kills || 0));
  // Squads still alive take the top placements (1..N); eliminated squads already have theirs.
  aliveByKills.forEach((sq, i) => { sq.alive = false; sq.placement = i + 1; });
  const results = squads.map((sq) => ({ key: sq.key, name: sq.name, teamId: sq.teamId, kills: sq.kills || 0, placement: sq.placement || 0 }));
  state.games.push({ n: (state.games.length + 1), map: state.map, results });
  return results;
}

function ensureSquad(state, p) {
  if (!p || !p.teamId) return null;
  let sq = state.squads[p.teamId];
  if (!sq) sq = state.squads[p.teamId] = { teamId: p.teamId, key: '', name: p.teamName || ('Squad ' + p.teamId), players: {}, alive: true, kills: 0, placement: 0, downs: 0 };
  if (p.teamName && sq.name.startsWith('Squad ')) sq.name = p.teamName;   // upgrade placeholder once a real name arrives
  sq.key = teamKeyOf(sq.name, sq.teamId);
  return sq;
}
function upsertPlayer(state, p) {
  const sq = ensureSquad(state, p);
  if (!sq) return null;
  const key = playerKey(p);
  const existing = sq.players[key] || {};
  sq.players[key] = { ...existing, ...p, kills: existing.kills || 0 };
  return sq.players[key];
}

function applyEvent(stateIn, frame, now) {
  const state = stateIn || initialState();
  const type = eventType(frame);
  const body = eventBody(frame);
  state.connected = true;
  state.lastUpdate = now || 0;
  if (!type) return state;

  switch (type) {
    case 'Init':
    case 'MatchSetup': {
      // A MatchSetup after a completed game means the NEXT game of the series is starting.
      if (state.matchState === 'postmatch' && Object.keys(state.squads).length) resetForNewGame(state);
      state.map = pick(body, ['map', 'mapName'], state.map);
      state.playlist = pick(body, ['playlistName', 'playlistDesc', 'playlist'], state.playlist);
      break;
    }
    case 'GameStateChanged': {
      const s = String(pick(body, ['state', 'newState'], '')).toLowerCase();
      if (/prematch|waitingforplayers|lobby|selection|picking/.test(s)) {
        if (state.matchState === 'postmatch' && Object.keys(state.squads).length) resetForNewGame(state);
        else state.matchState = 'lobby';
      } else if (/postmatch|resolution|epilogue|complete/.test(s)) {
        if (state.matchState !== 'postmatch') finalizeGame(state);
        state.matchState = 'postmatch';
      } else if (s) state.matchState = 'live';
      break;
    }
    case 'MatchStateEnd': {
      const winners = (body.winners || body.winnerPlayers || []).map(normPlayer).filter(Boolean);
      if (winners.length) state.winners = winners.map((w) => w.teamName || w.name);
      // Finalise this game exactly once (GameStateChanged->postmatch may have already done it).
      if (state.matchState !== 'postmatch') finalizeGame(state);
      state.matchState = 'postmatch';
      break;
    }
    case 'RingStartClosing':
    case 'RingFinishedClosing': {
      state.ring = {
        stage: Number(pick(body, ['stage'], state.ring.stage)) || state.ring.stage,
        current: Number(pick(body, ['currentRadius', 'current'], 0)) || 0,
        end: Number(pick(body, ['endRadius', 'end'], 0)) || 0,
        shrinking: type === 'RingStartClosing',
      };
      if (state.matchState === 'lobby') state.matchState = 'live';
      break;
    }
    case 'PlayerConnected': {
      upsertPlayer(state, normPlayer(body.player || body));
      break;
    }
    case 'ObserverSwitched': {
      const target = normPlayer(body.target || body.player);
      const squad = (body.targetTeam || body.team || []).map(normPlayer).filter(Boolean);
      if (target) {
        upsertPlayer(state, target);
        squad.forEach((sp) => upsertPlayer(state, sp));
        const sq = state.squads[target.teamId];
        const stored = sq && sq.players[playerKey(target)];
        state.observed = {
          ...target,
          kills: (stored && stored.kills) || 0,
          squad: squad.length ? squad : (sq ? Object.values(sq.players) : [target]),
          squadName: (sq && sq.name) || target.teamName || '',
        };
        if (state.matchState === 'lobby') state.matchState = 'live';
      }
      break;
    }
    case 'PlayerStatChanged': {
      // Kill attribution moved here in S20 (PlayerKilled.awardedTo was deprecated).
      const p = normPlayer(body.player);
      const stat = String(pick(body, ['statName', 'stat'], '')).toLowerCase();
      const val = Number(pick(body, ['newValue', 'intValue', 'floatValue', 'value'], 0)) || 0;
      const stored = p && upsertPlayer(state, p);
      if (stored && stat === 'kills') {
        stored.kills = val;
        const sq = state.squads[p.teamId];
        if (sq) sq.kills = Object.values(sq.players).reduce((s, pl) => s + (pl.kills || 0), 0);
        if (state.observed && playerKey(state.observed) === playerKey(p)) state.observed.kills = val;
      }
      break;
    }
    case 'PlayerDowned': {
      const attacker = normPlayer(body.attacker);
      const victim = normPlayer(body.victim);
      if (victim && victim.teamId && state.squads[victim.teamId]) state.squads[victim.teamId].downs++;
      pushKill(state, attacker, victim, pick(body, ['weapon', 'weaponName'], ''), now, true);
      break;
    }
    case 'PlayerKilled': {
      const attacker = normPlayer(body.attacker || body.awardedTo);
      const victim = normPlayer(body.victim);
      pushKill(state, attacker, victim, pick(body, ['weapon', 'weaponName'], ''), now, false);
      break;
    }
    case 'SquadEliminated': {
      const players = (body.players || []).map(normPlayer).filter(Boolean);
      players.forEach((p) => upsertPlayer(state, p));   // ensure the squad exists even if we missed its connect
      const teamId = players.length ? players[0].teamId : Number(pick(body, ['teamId'], 0));
      const sq = state.squads[teamId];
      if (sq && sq.alive) {
        sq.alive = false;
        const aliveCount = Object.values(state.squads).filter((s) => s.alive).length;
        sq.placement = aliveCount + 1;   // eliminated now -> placed just below those still alive
      }
      break;
    }
    default:
      break;
  }
  return state;
}

function pushKill(state, attacker, victim, weapon, now, isDown) {
  if (!victim) return;
  // Make sure both squads exist in standings even if we never saw their connect frames.
  if (attacker) upsertPlayer(state, attacker);
  upsertPlayer(state, victim);
  state.killfeed.push({
    attacker: attacker ? attacker.name : '',
    attackerLegend: attacker ? attacker.legend : '',
    attackerTeam: attacker ? attacker.teamId : 0,
    victim: victim.name,
    victimLegend: victim.legend,
    victimTeam: victim.teamId,
    weapon: weapon || '',
    down: !!isDown,
    ts: now || 0,
  });
  if (state.killfeed.length > 30) state.killfeed = state.killfeed.slice(-30);
}

// The ALGS leaderboard: every team seen across the series, with SERIES points (completed
// games + live current-game points), ranked. This is what the observer side-panels show.
// Team identity (logo/abbrev/colour) is resolved CLIENT-SIDE from the team library so the
// live payload stays tiny — here we only carry names/keys + lightweight per-team numbers.
function computeStandings(state, scoring) {
  const rows = {};   // key -> row
  const row = (key, name, teamId) => {
    if (!rows[key]) rows[key] = { key, name: name || key, teamId: teamId ?? 0, seriesPoints: 0, seriesKills: 0, gamesPlayed: 0,
      liveKills: 0, alive: false, gamePlacement: 0, inGame: false, players: [] };
    return rows[key];
  };

  // Completed games → cumulative points/kills.
  (state.games || []).forEach((g) => {
    (g.results || []).forEach((r) => {
      const key = r.key || teamKeyOf(r.name, r.teamId);
      const rr = row(key, r.name, r.teamId);
      rr.seriesPoints += gamePoints(r.placement, r.kills, scoring);
      rr.seriesKills += r.kills || 0;
      rr.gamesPlayed += 1;
      if (r.name && (!rr.name || /^team\d+$/.test(rr.name))) rr.name = r.name;
    });
  });

  // Current live game → add live points and the per-player legend/hp for the PLAYERS column.
  // Once a game is finalised (postmatch) it already lives in games[], so DON'T double-count the
  // lingering squads — but still surface their legends/hp for the result screen.
  const countLive = state.matchState !== 'postmatch';
  Object.values(state.squads || {}).forEach((sq) => {
    const rr = row(sq.key || teamKeyOf(sq.name, sq.teamId), sq.name, sq.teamId);
    rr.inGame = true;
    rr.alive = !!sq.alive;
    rr.liveKills = sq.kills || 0;
    rr.gamePlacement = sq.placement || 0;
    rr.teamId = sq.teamId;
    if (countLive) rr.seriesPoints += gamePoints(sq.placement || 0, sq.kills || 0, scoring);  // placement=0 → kills only until locked
    rr.players = Object.values(sq.players || {}).slice(0, 4).map((p) => ({
      name: p.name, legend: p.legend, hp: p.hp || 0, maxHp: p.maxHp || 100, down: (p.hp || 0) <= 0,
    }));
  });

  const list = Object.values(rows);
  // Rank by series points desc; ties keep a stable seed order (lobby slot / teamId asc).
  list.sort((a, b) => (b.seriesPoints - a.seriesPoints) || (b.seriesKills - a.seriesKills) || ((a.teamId || 99) - (b.teamId || 99)));
  list.forEach((r, i) => { r.rank = i + 1; });
  return list;
}

// A view of state trimmed for broadcast. opts.scoring drives the points table.
function toBroadcast(state, opts = {}) {
  const alivePlayers = Object.values(state.squads || {})
    .reduce((n, s) => n + Object.values(s.players || {}).filter((p) => (p.hp || 0) > 0).length, 0);
  return {
    connected: !!state.connected,
    lastUpdate: state.lastUpdate,
    matchState: state.matchState,
    map: state.map,
    playlist: state.playlist,
    gameNumber: state.gameNumber || 1,
    gamesPlayed: (state.games || []).length,
    ring: state.ring,
    observed: state.observed,
    standings: computeStandings(state, opts.scoring),
    squadsAlive: Object.values(state.squads || {}).filter((s) => s.alive).length,
    squadsTotal: Object.keys(state.squads || {}).length,
    playersAlive: alivePlayers,
    killfeed: state.killfeed.slice(-8),
    winners: state.winners,
  };
}

// ── WebSocket server (Apex connects in) ──────────────────────────────────────
// Returns { server, close() }. onFrame(parsedFrame) fires per message; onStatus fires
// on connect/disconnect so server.js can flip state.apex.connected and log analytics.
function createServer({ port = 7777, host = '127.0.0.1', onFrame, onStatus, onRaw } = {}) {
  const wss = new WebSocket.Server({ host, port });
  let rawLogged = 0;
  wss.on('connection', (ws) => {
    if (onStatus) onStatus('connected');
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Producer left protobuf on. We can't parse it without .proto bindings — surface once.
        if (onRaw && rawLogged < 3) { rawLogged++; onRaw({ binary: true, bytes: data.length }); }
        return;
      }
      let frame;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (onRaw && rawLogged < 5) { rawLogged++; onRaw({ binary: false, frame }); }
      if (onFrame) onFrame(frame);
    });
    ws.on('close', () => { if (onStatus) onStatus('disconnected'); });
    ws.on('error', () => {});
  });
  wss.on('error', (e) => { if (onStatus) onStatus('error', e); });
  return {
    server: wss,
    close: () => new Promise((res) => { try { wss.close(() => res()); } catch { res(); } }),
  };
}

module.exports = {
  buildConfig, writeConfig, launchOptions, defaultConfigDir,
  eventType, eventBody, normPlayer, playerKey, teamKeyOf,
  DEFAULT_SCORING, gamePoints, computeStandings,
  initialState, applyEvent, resetForNewGame, finalizeGame, toBroadcast,
  createServer,
};
