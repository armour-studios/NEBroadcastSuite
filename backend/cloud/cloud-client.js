'use strict';
/**
 * cloud-client.js — client half of the Nameless cloud backend contract.
 * See docs/cloud-backend-contract.md.
 *
 * Holds NO third-party secrets. It talks to BROADCAST_REMOTE_URL (the Nameless
 * backend), which performs the secret-bearing OAuth code exchanges and stores
 * producer profiles. Entirely DORMANT until a base URL is configured — every
 * call short-circuits to a clear "not configured" error, so wiring it in can
 * never affect the local-first app.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let BASE = '';            // BROADCAST_REMOTE_URL (no trailing slash)
let APP_VERSION = '0.0.0';
let sessionFile = null;
let session = { token: '', refreshToken: '', user: null, workspaceId: null, role: null, orgName: null, expiresAt: 0 };

function init({ baseUrl, dataDir, appVersion } = {}) {
  BASE = (baseUrl || '').trim().replace(/\/+$/, '');
  if (appVersion) APP_VERSION = String(appVersion);
  if (dataDir) { sessionFile = path.join(dataDir, 'cloud-session.json'); _load(); }
}

function configured() { return !!BASE; }
function authed() { return configured() && !!session.token && (!session.expiresAt || session.expiresAt > Date.now()); }
function getSession() { return { user: session.user, workspaceId: session.workspaceId, role: session.role, orgName: session.orgName, authed: authed(), configured: configured() }; }

function _load() { try { if (sessionFile && fs.existsSync(sessionFile)) session = { ...session, ...JSON.parse(fs.readFileSync(sessionFile, 'utf8')) }; } catch (e) { /* ignore */ } }
function _save() { try { if (sessionFile) fs.writeFileSync(sessionFile, JSON.stringify(session)); } catch (e) { /* ignore */ } }
function clearSession() { session = { token: '', refreshToken: '', user: null, workspaceId: null, role: null, orgName: null, expiresAt: 0 }; _save(); }

function _require() { if (!configured()) throw new Error('Cloud backend not configured (set BROADCAST_REMOTE_URL).'); }
function _client(auth = true) {
  const headers = { 'Content-Type': 'application/json', 'x-app': 'NE-Broadcast-Suite', 'x-app-version': APP_VERSION };
  if (auth && session.token) headers.Authorization = `Bearer ${session.token}`;
  return axios.create({ baseURL: BASE, timeout: 12000, headers });
}
function _err(e) {
  const resp = e && e.response;
  const data = resp && resp.data;
  // Preserve the backend's ACTUAL error + HTTP status so callers can see WHY. A bare axios
  // "Request failed with status code 400" is useless for debugging the /api/auth/* routes; dig the
  // real message out of whatever shape the backend returned (nested error, OAuth-style, plain string).
  let msg = '';
  if (data) {
    if (typeof data === 'string') msg = data;
    else if (data.error && data.error.message) msg = data.error.message;
    else if (data.error_description) msg = data.error_description;
    else if (typeof data.error === 'string') msg = data.error;
    else if (data.message) msg = data.message;
    else { try { msg = JSON.stringify(data).slice(0, 220); } catch (_) {} }
  }
  if (!msg) msg = (e && e.message) || 'Cloud request failed';
  // The message is USER-FACING (login screens, toasts) — keep it clean. The HTTP
  // status stays on err.status for callers and goes to the terminal for debugging.
  const err = new Error(msg);
  if (resp) { err.status = resp.status; err.data = data; console.warn(`[Cloud] HTTP ${resp.status}:`, msg); }
  return err;
}
function _setSession(d) {
  session = {
    token: d.sessionToken || session.token,
    refreshToken: d.refreshToken || session.refreshToken,
    user: d.user || session.user,
    workspaceId: d.workspaceId != null ? d.workspaceId : session.workspaceId,
    role: d.role != null ? d.role : session.role,
    orgName: d.orgName != null ? d.orgName : session.orgName,
    expiresAt: d.expiresAt || 0
  };
  _save();
}

// ── Auth (the backend holds the Discord/Twitch secrets) ────────────────────
async function loginWithDiscord({ code, codeVerifier, redirectUri }) {
  _require();
  try { const { data } = await _client(false).post('/api/auth/discord', { code, codeVerifier, redirectUri }); _setSession(data); return data; }
  catch (e) { throw _err(e); }
}
async function loginWithEmail({ email, password }) {
  _require();
  try { const { data } = await _client(false).post('/api/auth/broadcast-login', { email, password }); _setSession(data); return data; }
  catch (e) { throw _err(e); }
}
// First sign-in after approval: the backend refused login with a contract token +
// license text; posting the typed legal-name signature completes the sign-in.
async function acceptContract({ token, signatureName }) {
  _require();
  try { const { data } = await _client(false).post('/api/auth/contract-accept', { token, signatureName }); _setSession(data); return data; }
  catch (e) { throw _err(e); }
}
async function refreshSession() {
  _require(); if (!session.refreshToken) throw new Error('No refresh token.');
  try { const { data } = await _client(false).post('/api/auth/session/refresh', { refreshToken: session.refreshToken }); _setSession(data); return data; }
  catch (e) { throw _err(e); }
}
async function linkTwitch({ code, codeVerifier, redirectUri }) {
  _require();
  try { const { data } = await _client().post('/api/auth/twitch', { code, codeVerifier, redirectUri }); return data; }
  catch (e) { throw _err(e); }
}
// Rotate the user-scoped Twitch tokens via the backend (it holds the client secret —
// confidential Twitch apps can't refresh without it, which is why implicit-grant tokens
// used to just die). Same response shape as linkTwitch.
async function refreshTwitch(refreshToken) {
  _require();
  try { const { data } = await _client().post('/api/auth/twitch/refresh', { refreshToken }); return data; }
  catch (e) { throw _err(e); }
}
async function me() { _require(); try { const { data } = await _client().get('/api/me'); return data; } catch (e) { throw _err(e); } }

// ── Profiles (store/share the secret-free bundle) ──────────────────────────
async function listProfiles() { _require(); try { const { data } = await _client().get('/api/profiles'); return data.profiles || []; } catch (e) { throw _err(e); } }
async function getProfile(id) { _require(); try { const { data } = await _client().get(`/api/profiles/${encodeURIComponent(id)}`); return data; } catch (e) { throw _err(e); } }
async function saveProfile(bundle, { id, name } = {}) {
  _require();
  try {
    if (id) { const { data } = await _client().put(`/api/profiles/${encodeURIComponent(id)}`, { name, bundle }); return data.profile || data; }
    const { data } = await _client().post('/api/profiles', { name, bundle }); return data.profile || data;
  } catch (e) { throw _err(e); }
}
async function deleteProfile(id) { _require(); try { await _client().delete(`/api/profiles/${encodeURIComponent(id)}`); return true; } catch (e) { throw _err(e); } }
async function shareProfile(id, scope, role) { _require(); try { const { data } = await _client().post(`/api/profiles/${encodeURIComponent(id)}/share`, { scope, role }); return data; } catch (e) { throw _err(e); } }

// ── Org broadcast seats (licensing — owner/admin only, gated server-side) ──
// orgId is session.workspaceId when it's a real org (not the synthetic "user:<id>"
// personal-workspace id a solo producer gets — callers should check for that prefix
// before showing any seat-management UI).
async function listOrgSeats(orgId) { _require(); try { const { data } = await _client().get(`/api/orgs/${encodeURIComponent(orgId)}/broadcast-seats`); return data; } catch (e) { throw _err(e); } }
async function addOrgSeat(orgId, { userId, role }) { _require(); try { const { data } = await _client().post(`/api/orgs/${encodeURIComponent(orgId)}/broadcast-seats`, { userId, role }); return data.seat || data; } catch (e) { throw _err(e); } }
async function removeOrgSeat(orgId, seatId) { _require(); try { await _client().delete(`/api/orgs/${encodeURIComponent(orgId)}/broadcast-seats/${encodeURIComponent(seatId)}`); return true; } catch (e) { throw _err(e); } }

// ── Camera sessions (website-hosted masked VDO links — see /cameras/[token]) ──
async function listCameraFeeds(orgId) { _require(); try { const { data } = await _client().get(`/api/orgs/${encodeURIComponent(orgId)}/camera-sessions/active-feeds`); return data.feeds || []; } catch (e) { throw _err(e); } }

// ── Pulse multiview (the org's live games — see overlay/pulse.html) ──────────
// getMultiview: the CORE producer pulls every observer's live game (scores + feed) for the Pulse scene.
// publishObservedGame: an OBSERVER's app heartbeats its own game so it shows on other producers' Pulse.
async function getMultiview(orgId) { _require(); try { const { data } = await _client().get(`/api/orgs/${encodeURIComponent(orgId)}/multiview`); return data.games || []; } catch (e) { throw _err(e); } }
async function publishObservedGame(orgId, payload) { _require(); try { const { data } = await _client().post(`/api/orgs/${encodeURIComponent(orgId)}/observed-games`, payload || {}); return data; } catch (e) { throw _err(e); } }
async function stopObservedGame(orgId, key) { _require(); try { const { data } = await _client().post(`/api/orgs/${encodeURIComponent(orgId)}/observed-games`, { stop: true, key }); return data; } catch (e) { throw _err(e); } }

// ── Station feeds (website-hosted caster/observer VDO rooms — see /studio/access/stations) ──
async function listStationFeeds(orgId) { _require(); try { const { data } = await _client().get(`/api/orgs/${encodeURIComponent(orgId)}/station-feeds`); return { feeds: data.feeds || [], shared: data.shared || [] }; } catch (e) { throw _err(e); } }
// Light station list for the app's station-binding picker (id/name/status only).
async function listStations(orgId) {
  _require();
  try {
    const { data } = await _client().get(`/api/orgs/${encodeURIComponent(orgId)}/stations`);
    return (data.stations || []).map((s) => ({ id: s.id, name: s.name, status: s.status }));
  } catch (e) { throw _err(e); }
}
// Full station cockpit payload (rooms + slots, team matches, player-camera sessions) — the
// app renders it with copyable invite links so producers never need the website open mid-show.
async function getStation(orgId, stationId) {
  _require();
  try {
    const { data } = await _client().get(`/api/orgs/${encodeURIComponent(orgId)}/stations/${encodeURIComponent(stationId)}`);
    return { station: data.station || null, matches: data.matches || [], cameraSessions: data.cameraSessions || [] };
  } catch (e) { throw _err(e); }
}

// ── Crew roster mirror (names only — no pay/contact fields) so the website's station join
// pages can offer "pick your crew profile" that auto-links back to this app's crew database. ──
async function pushCrewRoster(orgId, crew) { _require(); try { const { data } = await _client().put(`/api/orgs/${encodeURIComponent(orgId)}/crew-roster`, { crew }); return data; } catch (e) { throw _err(e); } }

// ── Show-state heartbeat: event/round, score, break countdown, on-air graphic — rendered as
// the casters' show bar on the website's station join pages. Small + secret-free. ──
async function pushShowState(orgId, data) { _require(); try { const { data: d } = await _client().put(`/api/orgs/${encodeURIComponent(orgId)}/show-state`, { data }); return d; } catch (e) { throw _err(e); } }

// ── Leagues (bidirectional sync with the website's CompeteLeague — opt-in, per league) ──
// pushLeague: create-or-update-by-externalId (the app's local league id). listCloudLeagues:
// discovery for the "pull a website league in" UI. pullLeague: full detail for one league.
async function pushLeague(orgId, league) { _require(); try { const { data } = await _client().post(`/api/orgs/${encodeURIComponent(orgId)}/leagues`, league); return data.league || data; } catch (e) { throw _err(e); } }
async function listCloudLeagues(orgId) { _require(); try { const { data } = await _client().get(`/api/orgs/${encodeURIComponent(orgId)}/leagues`); return data.leagues || []; } catch (e) { throw _err(e); } }
async function pullLeague(orgId, leagueId) { _require(); try { const { data } = await _client().get(`/api/orgs/${encodeURIComponent(orgId)}/leagues/${encodeURIComponent(leagueId)}`); return data.league || data; } catch (e) { throw _err(e); } }

// ── Invite-link minting (so producers never have to open the website) ─────────
// Every create route below authenticates via the website's resolveApiActor() Bearer path — the
// SAME token this client already sends — gated by canManageBroadcastTooling / checkStudioAccess.
// The website mints the tokens; we compose the public URL from BASE (namelessesports.com by default).
function publicUrl(p) { const rel = String(p || ''); return rel.startsWith('http') ? rel : `${BASE}${rel.startsWith('/') ? '' : '/'}${rel}`; }

// A station is the parent of caster/observer rooms. Producers usually have one desk; ensureStation
// reuses the first active station or creates one so the room-invite flow is a single click.
async function createStation(orgId, { name } = {}) { _require(); try { const { data } = await _client().post(`/api/orgs/${encodeURIComponent(orgId)}/stations`, { name }); return data.station || data; } catch (e) { throw _err(e); } }
async function ensureStation(orgId, name) {
  _require();
  const list = await listStations(orgId);
  const active = (list || []).find((s) => s.status === 'active') || (list || [])[0];
  if (active) return active;
  return createStation(orgId, { name: name || 'Main Station' });
}
// kind: 'caster' (talkback room, casters claim slots) | 'observer' (shared observer feeds). Returns
// the room incl. shareToken → the public join page is /station/<shareToken>.
async function createStationRoom(orgId, stationId, { kind = 'caster', name, slotCount } = {}) {
  _require();
  try {
    const { data } = await _client().post(`/api/orgs/${encodeURIComponent(orgId)}/stations/${encodeURIComponent(stationId)}/rooms`, { kind, name, slotCount });
    const room = data.room || data;
    return { ...room, url: room && room.shareToken ? publicUrl(`/station/${room.shareToken}`) : '' };
  } catch (e) { throw _err(e); }
}
// Camera-assignment session: 11 masked VDO slots. Returns shareToken → /cameras/<shareToken>.
async function createCameraSession(orgId, { name, startggSlug, stationId } = {}) {
  _require();
  try {
    const { data } = await _client().post(`/api/orgs/${encodeURIComponent(orgId)}/camera-sessions`, { name, startggSlug, stationId });
    const session = data.session || data;
    return { ...session, url: session && session.shareToken ? publicUrl(`/cameras/${session.shareToken}`) : '' };
  } catch (e) { throw _err(e); }
}
// One producer link both teams use: /join/<id> → team → player → in-game → team VDO room.
// teamA/teamB = { name, logo, color, players:[{name,...}] }.
async function createMatch({ teamA, teamB, game, password, roomBase, stationId } = {}) {
  _require();
  try {
    const { data } = await _client().post('/api/matches', { teamA, teamB, game, password, roomBase, stationId });
    return { ...data, url: data && data.joinUrl ? publicUrl(data.joinUrl) : '', matchUrl: data && data.matchUrl ? publicUrl(data.matchUrl) : '' };
  } catch (e) { throw _err(e); }
}
// A single branded talent/observer join link (/talent/<token>) — for a caster or guest you invite ad hoc.
async function createTalentInvite({ room, role, roomTitle, name, password, teamLabel, ttlHours } = {}) {
  _require();
  try {
    const { data } = await _client().post('/api/talent-invites', { room, role, roomTitle, name, password, teamLabel, ttlHours });
    return { ...data, url: data && data.url ? publicUrl(data.url) : '' };
  } catch (e) { throw _err(e); }
}

// ── Full station management (the in-app Stations manager) ─────────────────────
// listStationsFull returns the org's stations with rooms→slots nested (GET /stations already
// includes them), each room decorated with its public /station/<shareToken> join URL so the panel
// can render + copy links without a per-room round-trip. The patch/delete/slot methods below wrap
// the website's CRUD routes 1:1 — all Bearer-authed via resolveApiActor, gated by canManageBroadcastTooling.
function _decorateStation(s) {
  return {
    ...s,
    rooms: (s.rooms || []).map((r) => ({ ...r, url: r.shareToken ? publicUrl(`/station/${r.shareToken}`) : '' }))
  };
}
async function listStationsFull(orgId) {
  _require();
  try {
    const { data } = await _client().get(`/api/orgs/${encodeURIComponent(orgId)}/stations`);
    return { stations: (data.stations || []).map(_decorateStation), seatCap: data.seatCap ?? null, activeCount: data.activeCount ?? null };
  } catch (e) { throw _err(e); }
}
async function patchStation(orgId, stationId, patch) { _require(); try { const { data } = await _client().patch(`/api/orgs/${encodeURIComponent(orgId)}/stations/${encodeURIComponent(stationId)}`, patch || {}); return data.station || data; } catch (e) { throw _err(e); } }
async function deleteStation(orgId, stationId) { _require(); try { await _client().delete(`/api/orgs/${encodeURIComponent(orgId)}/stations/${encodeURIComponent(stationId)}`); return true; } catch (e) { throw _err(e); } }
async function patchRoom(orgId, stationId, roomId, patch) { _require(); try { const { data } = await _client().patch(`/api/orgs/${encodeURIComponent(orgId)}/stations/${encodeURIComponent(stationId)}/rooms/${encodeURIComponent(roomId)}`, patch || {}); return data.room || data; } catch (e) { throw _err(e); } }
async function deleteRoom(orgId, stationId, roomId) { _require(); try { await _client().delete(`/api/orgs/${encodeURIComponent(orgId)}/stations/${encodeURIComponent(stationId)}/rooms/${encodeURIComponent(roomId)}`); return true; } catch (e) { throw _err(e); } }
async function addRoomSlot(orgId, stationId, roomId) { _require(); try { const { data } = await _client().post(`/api/orgs/${encodeURIComponent(orgId)}/stations/${encodeURIComponent(stationId)}/rooms/${encodeURIComponent(roomId)}/slots`, {}); return data.slot || data; } catch (e) { throw _err(e); } }
async function patchRoomSlot(orgId, stationId, roomId, slotId, patch) { _require(); try { const { data } = await _client().patch(`/api/orgs/${encodeURIComponent(orgId)}/stations/${encodeURIComponent(stationId)}/rooms/${encodeURIComponent(roomId)}/slots/${encodeURIComponent(slotId)}`, patch || {}); return data.slot || data; } catch (e) { throw _err(e); } }
async function deleteRoomSlot(orgId, stationId, roomId, slotId) { _require(); try { await _client().delete(`/api/orgs/${encodeURIComponent(orgId)}/stations/${encodeURIComponent(stationId)}/rooms/${encodeURIComponent(roomId)}/slots/${encodeURIComponent(slotId)}`); return true; } catch (e) { throw _err(e); } }

// ── Bug reports ────────────────────────────────────────────────────────────────
// Files the in-app report on the producer's website account too (shows on /access/bugs
// with staff status/notes) — the Discord/GitHub copies are sent separately by server.js.
async function submitBugReport({ title, description, severity, area, appVersion, consoleLog } = {}) {
  _require();
  try { const { data } = await _client().post('/api/studio/bugs', { title, description, severity, area, appVersion, consoleLog }); return data.report || data; } catch (e) { throw _err(e); }
}

// ── AI Producer telemetry (Phase 2) ──────────────────────────────────────────
// Uploads a batch of already-recorded local Decision Records (backend/telemetry/recorder.js)
// to the shared training dataset. Opt-in — only called when the producer has explicitly
// enabled upload (see server.js's telemetryAutoSync).
async function uploadTelemetryBatch(records) {
  _require();
  try { const { data } = await _client().post('/api/telemetry/batch', { records }); return data; } catch (e) { throw _err(e); }
}

module.exports = {
  init, configured, authed, getSession, clearSession,
  submitBugReport,
  uploadTelemetryBatch,
  loginWithDiscord,
  loginWithEmail, acceptContract, refreshSession, linkTwitch, refreshTwitch, me,
  listProfiles, getProfile, saveProfile, deleteProfile, shareProfile,
  listOrgSeats, addOrgSeat, removeOrgSeat,
  listCameraFeeds,
  getMultiview, publishObservedGame, stopObservedGame,
  listStationFeeds,
  listStations,
  getStation,
  pushCrewRoster,
  pushShowState,
  pushLeague, listCloudLeagues, pullLeague,
  publicUrl,
  createStation, ensureStation, createStationRoom, createCameraSession, createMatch, createTalentInvite,
  listStationsFull, patchStation, deleteStation, patchRoom, deleteRoom, addRoomSlot, patchRoomSlot, deleteRoomSlot
};
