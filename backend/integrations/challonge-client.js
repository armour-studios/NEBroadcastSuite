const axios = require('axios');

const CHALLONGE_API_BASE = 'https://api.challonge.com/v1';
const CHALLONGE_API_V2_BASE = 'https://api.challonge.com/v2.1';

function createChallongeClient(apiKey) {
  if (!apiKey) {
    const stub = async () => { throw new Error('Challonge API key not configured'); };
    return { get: stub, getV2: stub, put: stub, post: stub, del: stub };
  }

  const baseHeaders = { 'User-Agent': 'NE-Broadcast-Suite/1.0', 'Accept': 'application/json' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Challonge occasionally times out or returns 5xx/429 mid-import (a large bracket makes dozens
  // of calls). Retry transient failures with backoff so one slow response doesn't abort the run.
  async function withRetry(fn, label) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(600 * attempt);   // 0, 600, 1200, 1800ms
      try {
        const res = await fn();
        const transient = res && (res.status === 429 || res.status === 420 || res.status >= 500);
        if (transient && attempt < 3) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        return res;
      } catch (err) {
        // axios network/timeout errors (ECONNABORTED, ETIMEDOUT, socket hang up) land here
        lastErr = err;
      }
    }
    throw new Error(`Challonge network error: ${lastErr ? lastErr.message : 'request failed'} (${label})`);
  }

  function handleResponse(res, path) {
    if (res.status === 401 || res.status === 403) throw new Error('Invalid Challonge API key');
    if (res.status === 404) throw new Error(`Not found: ${path}`);
    if (res.status === 422) {
      const msg = Array.isArray(res.data?.errors) ? res.data.errors.join(', ') : (res.data?.errors || `HTTP 422`);
      throw new Error(`Challonge validation error: ${msg}`);
    }
    if (res.status >= 400) {
      const msg = Array.isArray(res.data?.errors) ? res.data.errors.join(', ') : `HTTP ${res.status}`;
      throw new Error(`Challonge API error: ${msg}`);
    }
    return res.data;
  }

  async function get(path, params = {}) {
    const res = await withRetry(() => axios.get(`${CHALLONGE_API_BASE}${path}`, {
      params: { api_key: apiKey, ...params },
      headers: baseHeaders,
      timeout: 30000,
      validateStatus: () => true
    }), `GET ${path}`);
    if (res.status !== 200) return handleResponse(res, path);
    return res.data;
  }

  async function post(path, body) {
    const res = await withRetry(() => axios.post(`${CHALLONGE_API_BASE}${path}`, body, {
      params: { api_key: apiKey },
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      timeout: 30000,
      validateStatus: () => true
    }), `POST ${path}`);
    return handleResponse(res, path);
  }

  async function put(path, body) {
    const res = await withRetry(() => axios.put(`${CHALLONGE_API_BASE}${path}`, body, {
      params: { api_key: apiKey },
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      timeout: 30000,
      validateStatus: () => true
    }), `PUT ${path}`);
    return handleResponse(res, path);
  }

  async function del(path) {
    const res = await withRetry(() => axios.delete(`${CHALLONGE_API_BASE}${path}`, {
      params: { api_key: apiKey },
      headers: baseHeaders,
      timeout: 30000,
      validateStatus: () => true
    }), `DELETE ${path}`);
    return handleResponse(res, path);
  }

  // APIv2.1 read with the same v1 key (Authorization-Type: v1). Only used where v2.1 exposes
  // something v1 can't — e.g. affiliates' community tournaments (include_community_tournaments=1).
  async function getV2(path, params = {}) {
    const res = await withRetry(() => axios.get(`${CHALLONGE_API_V2_BASE}${path}`, {
      params,
      headers: { ...baseHeaders, 'Authorization-Type': 'v1', 'Authorization': apiKey, 'Content-Type': 'application/vnd.api+json' },
      timeout: 30000,
      validateStatus: () => true
    }), `GET v2.1 ${path}`);
    if (res.status !== 200) return handleResponse(res, path);
    return res.data;
  }

  return { get, getV2, post, put, del };
}

module.exports = { createChallongeClient };
