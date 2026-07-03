'use strict';

const https = require('https');

function nxgenGet(apiKey, path) {
  return new Promise((resolve, reject) => {
    const url = new URL('https://www.nxgen.pro/api/v1' + path);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'BroadcastStudio/1.0'
      }
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Invalid NXGEN API key — check your key in Settings.'));
        if (res.statusCode === 404) return reject(new Error('Event not found — check the slug.'));
        if (res.statusCode === 429) return reject(new Error('NXGEN rate limit exceeded — retry in a moment.'));
        if (res.statusCode >= 400) {
          let msg = `HTTP ${res.statusCode}`;
          try { msg = JSON.parse(body).error || msg; } catch {}
          return reject(new Error(msg));
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON from NXGEN API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('NXGEN API request timed out')); });
    req.end();
  });
}

async function getNxgenEvents(apiKey, { limit = 30, status, includePast = false } = {}) {
  let path = `/events?limit=${limit}&includePast=${includePast}`;
  if (status) path += `&status=${encodeURIComponent(status)}`;
  return nxgenGet(apiKey, path);
}

async function getNxgenEvent(apiKey, slug) {
  return nxgenGet(apiKey, `/events/${encodeURIComponent(slug)}`);
}

async function getNxgenEventLive(apiKey, slug) {
  return nxgenGet(apiKey, `/events/${encodeURIComponent(slug)}/live`);
}

async function getNxgenLeaderboard(apiKey) {
  return nxgenGet(apiKey, '/leaderboard');
}

module.exports = { getNxgenEvents, getNxgenEvent, getNxgenEventLive, getNxgenLeaderboard };
