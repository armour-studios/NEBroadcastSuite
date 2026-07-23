// Google Sheets integration client — service-account auth (read + write), built on Node's crypto +
// https so there's no googleapis dependency. The producer creates a Google service account, enables
// the Sheets API, shares their spreadsheet with the service-account email, and pastes the SA JSON key
// into Settings ▸ Google Sheets. We sign a JWT with the SA private key, exchange it for an OAuth
// access token, and call the Sheets v4 REST API.
const crypto = require('crypto');
const https = require('https');

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Minimal JSON-over-HTTPS helper. Returns { status, json, text }.
function httpJson(method, urlStr, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const opts = { method, hostname: u.hostname, path: u.pathname + u.search, headers: { ...headers } };
    if (body != null && !opts.headers['Content-Length']) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const rq = https.request(opts, (rs) => {
      let data = '';
      rs.on('data', (c) => { data += c; });
      rs.on('end', () => {
        let json = null; try { json = data ? JSON.parse(data) : null; } catch (e) { /* non-JSON */ }
        resolve({ status: rs.statusCode, json, text: data });
      });
    });
    rq.on('error', reject);
    rq.setTimeout(20000, () => rq.destroy(new Error('Sheets request timed out')));
    if (body != null) rq.write(body);
    rq.end();
  });
}

// Parse a pasted service-account key (JSON string or already-parsed object). Throws a clear error if
// it's not a service-account key with the fields we need.
function parseServiceAccount(raw) {
  if (!raw) throw new Error('No service-account key provided.');
  let sa = raw;
  if (typeof raw === 'string') {
    try { sa = JSON.parse(raw); } catch (e) { throw new Error('Service-account key is not valid JSON.'); }
  }
  if (!sa || sa.type !== 'service_account' || !sa.client_email || !sa.private_key) {
    throw new Error('That JSON is not a Google service-account key (need type/client_email/private_key). Download it from the service account’s "Keys" tab.');
  }
  return { client_email: sa.client_email, private_key: sa.private_key };
}

// Extract the spreadsheet id from a full URL or a bare id.
function extractSheetId(input) {
  const s = (input || '').trim();
  if (!s) return '';
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;   // looks like a bare id
  return '';
}

// Sign a JWT with the SA private key and exchange it for a short-lived OAuth access token (scope:
// full spreadsheets read+write). Cached per client_email for ~55 min.
const _tokenCache = new Map();   // client_email -> { token, exp }
async function getAccessToken(sa) {
  const cached = _tokenCache.get(sa.client_email);
  const nowMs = Date.now();
  if (cached && cached.exp - 60000 > nowMs) return cached.token;

  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signingInput = header + '.' + claims;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput); signer.end();
  let signature;
  try { signature = b64url(signer.sign(sa.private_key)); }
  catch (e) { throw new Error('Could not sign with the service-account private key (is the key intact, with real newlines?).'); }
  const jwt = signingInput + '.' + signature;

  const res = await httpJson('POST', 'https://oauth2.googleapis.com/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(jwt)
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    const msg = (res.json && (res.json.error_description || res.json.error)) || ('HTTP ' + res.status);
    throw new Error('Google auth failed: ' + msg);
  }
  _tokenCache.set(sa.client_email, { token: res.json.access_token, exp: nowMs + (res.json.expires_in || 3600) * 1000 });
  return res.json.access_token;
}

// Spreadsheet title + tab (worksheet) names — used to populate the Tab pickers + confirm access.
async function getMeta(sa, sheetId) {
  const token = await getAccessToken(sa);
  const res = await httpJson('GET',
    'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '?fields=' + encodeURIComponent('properties.title,sheets.properties.title'),
    { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 403) throw new Error('Access denied — share the sheet with the service-account email (Editor) shown in Settings.');
  if (res.status === 404) throw new Error('Spreadsheet not found — check the URL/ID.');
  if (res.status !== 200 || !res.json) throw new Error('Sheets error: ' + ((res.json && res.json.error && res.json.error.message) || res.status));
  return {
    title: (res.json.properties && res.json.properties.title) || '',
    tabs: (res.json.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean)
  };
}

// Read a tab's values as a 2D array (rows of cells). `tab` is a worksheet name; we read a generous
// range so headers + all rows come back.
async function readTab(sa, sheetId, tab) {
  const token = await getAccessToken(sa);
  const range = "'" + String(tab).replace(/'/g, "''") + "'!A1:Z1000";
  const res = await httpJson('GET',
    'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(range),
    { headers: { Authorization: 'Bearer ' + token } });
  if (res.status !== 200) throw new Error('Read failed for "' + tab + '": ' + ((res.json && res.json.error && res.json.error.message) || res.status));
  return (res.json && res.json.values) || [];
}

// Overwrite a tab with a 2D array of values (clears the old range first so removed rows disappear).
async function writeTab(sa, sheetId, tab, values) {
  const token = await getAccessToken(sa);
  const q = "'" + String(tab).replace(/'/g, "''") + "'";
  // Clear a wide range, then write from A1.
  await httpJson('POST',
    'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(q + '!A1:Z1000') + ':clear',
    { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
  const res = await httpJson('PUT',
    'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(q + '!A1') + '?valueInputOption=USER_ENTERED',
    { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
  if (res.status !== 200) throw new Error('Write failed for "' + tab + '": ' + ((res.json && res.json.error && res.json.error.message) || res.status));
  return res.json;
}

// ── Header-row mapping ────────────────────────────────────────────────────────
// Rows use a HEADER ROW (first row) with human column names; we match known fields case-insensitively
// so the producer doesn't need a column-mapping UI. rowsToObjects turns a 2D array into [{header:val}].
function rowsToObjects(values) {
  if (!values || !values.length) return [];
  const headers = (values[0] || []).map((h) => String(h == null ? '' : h).trim().toLowerCase());
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    if (!row.some((c) => String(c == null ? '' : c).trim() !== '')) continue;   // skip blank rows
    const obj = {};
    headers.forEach((h, j) => { if (h) obj[h] = row[j] != null ? String(row[j]).trim() : ''; });
    out.push(obj);
  }
  return out;
}
// First non-empty value among candidate header names.
function pick(obj, names) {
  for (const n of names) { const k = n.toLowerCase(); if (obj[k] != null && obj[k] !== '') return obj[k]; }
  return '';
}

module.exports = { parseServiceAccount, extractSheetId, getAccessToken, getMeta, readTab, writeTab, rowsToObjects, pick };
