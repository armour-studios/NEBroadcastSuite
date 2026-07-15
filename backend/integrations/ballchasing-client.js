const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const BALLCHASING_API_URL = 'https://ballchasing.com/api';

// createBallchasingClient(apiKey) -> { request(method, path, opts) } — mirrors startgg-client.js's
// shape (a single generic request() plus thin convenience wrappers), adapted for a REST+API-key
// service instead of GraphQL+Bearer-token. Auth header is the RAW key, not "Bearer <key>" — verified
// against ballchasing's own docs, a common trip-up since every other integration in this app uses Bearer.
function createBallchasingClient(apiKey) {
  if (!apiKey) {
    return {
      request: async () => {
        throw new Error('Ballchasing API key not configured');
      }
    };
  }

  // Free tier is 2 req/s — far tighter than start.gg's burst-only limiting, so 429s are an expected
  // part of normal use here (e.g. uploading several replays back to back), not just a rare edge case.
  const MAX_RETRIES = 6;

  async function request(method, path, opts) {
    opts = opts || {};
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await axios({
          method,
          url: BALLCHASING_API_URL + path,
          params: opts.params,
          data: opts.data,
          headers: {
            Authorization: apiKey,
            ...(opts.isMultipart && opts.data && typeof opts.data.getHeaders === 'function' ? opts.data.getHeaders() : {})
          },
          timeout: opts.isMultipart ? 60000 : 20000,
          validateStatus: () => true   // handle all status codes ourselves
        });
      } catch (err) {
        throw new Error(`Ballchasing network error: ${err.message}`);
      }

      if (res.status === 429) {
        if (attempt >= MAX_RETRIES) throw new Error('Ballchasing rate limit — too many requests, try again in a minute.');
        const retryAfterHeader = parseFloat(res.headers['retry-after']);
        const waitMs = Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : Math.min(15000, 1000 * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error('Ballchasing rejected the API key — check it in Settings.');
      }
      // 409 (duplicate replay on upload) carries useful data (the existing replay's id) — let the
      // caller see it rather than throwing, since "already uploaded" is a success case for us.
      if (res.status === 409) return { status: 409, data: res.data };
      if (res.status < 200 || res.status >= 300) {
        const msg = (res.data && (res.data.error || res.data.message)) || `HTTP ${res.status}`;
        throw new Error(`Ballchasing: ${msg}`);
      }
      return { status: res.status, data: res.data };
    }
  }

  return {
    request,
    // GET / — ping, verifies the key is valid. Used for the Settings "Test connection" button.
    ping: () => request('GET', '/'),
    createGroup: (name, playerIdentification, teamIdentification, parent) =>
      request('POST', '/groups', { data: { name, player_identification: playerIdentification, team_identification: teamIdentification, ...(parent ? { parent } : {}) } }),
    getGroup: (id) => request('GET', `/groups/${encodeURIComponent(id)}`),
    listGroupReplays: (groupId) => request('GET', '/replays', { params: { group: groupId, count: 200 } }),
    getReplay: (id) => request('GET', `/replays/${encodeURIComponent(id)}`),
    // Multipart upload — field name MUST be "file" per ballchasing's docs. 409 (duplicate) is
    // surfaced as a normal {status:409, data:{id,...}} result, not thrown — see request() above.
    uploadReplay: (filePath, groupId, visibility) => {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath));
      return request('POST', '/v2/upload', {
        params: { visibility: visibility || 'unlisted', ...(groupId ? { group: groupId } : {}) },
        data: form,
        isMultipart: true
      });
    }
  };
}

module.exports = {
  createBallchasingClient,
  BALLCHASING_API_URL
};
