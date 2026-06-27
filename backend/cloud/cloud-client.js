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
let session = { token: '', refreshToken: '', user: null, workspaceId: null, role: null, expiresAt: 0 };

function init({ baseUrl, dataDir, appVersion } = {}) {
  BASE = (baseUrl || '').trim().replace(/\/+$/, '');
  if (appVersion) APP_VERSION = String(appVersion);
  if (dataDir) { sessionFile = path.join(dataDir, 'cloud-session.json'); _load(); }
}

function configured() { return !!BASE; }
function authed() { return configured() && !!session.token && (!session.expiresAt || session.expiresAt > Date.now()); }
function getSession() { return { user: session.user, workspaceId: session.workspaceId, role: session.role, authed: authed(), configured: configured() }; }

function _load() { try { if (sessionFile && fs.existsSync(sessionFile)) session = { ...session, ...JSON.parse(fs.readFileSync(sessionFile, 'utf8')) }; } catch (e) { /* ignore */ } }
function _save() { try { if (sessionFile) fs.writeFileSync(sessionFile, JSON.stringify(session)); } catch (e) { /* ignore */ } }
function clearSession() { session = { token: '', refreshToken: '', user: null, workspaceId: null, role: null, expiresAt: 0 }; _save(); }

function _require() { if (!configured()) throw new Error('Cloud backend not configured (set BROADCAST_REMOTE_URL).'); }
function _client(auth = true) {
  const headers = { 'Content-Type': 'application/json', 'x-app': 'NE-Broadcast-Suite', 'x-app-version': APP_VERSION };
  if (auth && session.token) headers.Authorization = `Bearer ${session.token}`;
  return axios.create({ baseURL: BASE, timeout: 12000, headers });
}
function _err(e) {
  const data = e && e.response && e.response.data;
  if (data && data.error && data.error.message) return new Error(data.error.message);
  return new Error((e && e.message) || 'Cloud request failed');
}
function _setSession(d) {
  session = {
    token: d.sessionToken || session.token,
    refreshToken: d.refreshToken || session.refreshToken,
    user: d.user || session.user,
    workspaceId: d.workspaceId != null ? d.workspaceId : session.workspaceId,
    role: d.role != null ? d.role : session.role,
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

module.exports = {
  init, configured, authed, getSession, clearSession,
  loginWithDiscord, refreshSession, linkTwitch, me,
  listProfiles, getProfile, saveProfile, deleteProfile, shareProfile
};
