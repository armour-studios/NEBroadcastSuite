const axios = require('axios');

const CHALLONGE_API_BASE = 'https://api.challonge.com/v1';

function createChallongeClient(apiKey) {
  if (!apiKey) {
    const stub = async () => { throw new Error('Challonge API key not configured'); };
    return { get: stub, put: stub, post: stub, del: stub };
  }

  const baseHeaders = { 'User-Agent': 'NE-Broadcast-Suite/1.0', 'Accept': 'application/json' };

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
    let res;
    try {
      res = await axios.get(`${CHALLONGE_API_BASE}${path}`, {
        params: { api_key: apiKey, ...params },
        headers: baseHeaders,
        timeout: 20000,
        validateStatus: () => true
      });
    } catch (err) {
      throw new Error(`Challonge network error: ${err.message}`);
    }
    if (res.status !== 200) return handleResponse(res, path);
    return res.data;
  }

  async function post(path, body) {
    let res;
    try {
      res = await axios.post(`${CHALLONGE_API_BASE}${path}`, body, {
        params: { api_key: apiKey },
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        timeout: 30000,
        validateStatus: () => true
      });
    } catch (err) {
      throw new Error(`Challonge network error: ${err.message}`);
    }
    return handleResponse(res, path);
  }

  async function put(path, body) {
    let res;
    try {
      res = await axios.put(`${CHALLONGE_API_BASE}${path}`, body, {
        params: { api_key: apiKey },
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        timeout: 20000,
        validateStatus: () => true
      });
    } catch (err) {
      throw new Error(`Challonge network error: ${err.message}`);
    }
    return handleResponse(res, path);
  }

  async function del(path) {
    let res;
    try {
      res = await axios.delete(`${CHALLONGE_API_BASE}${path}`, {
        params: { api_key: apiKey },
        headers: baseHeaders,
        timeout: 20000,
        validateStatus: () => true
      });
    } catch (err) {
      throw new Error(`Challonge network error: ${err.message}`);
    }
    return handleResponse(res, path);
  }

  return { get, post, put, del };
}

module.exports = { createChallongeClient };
