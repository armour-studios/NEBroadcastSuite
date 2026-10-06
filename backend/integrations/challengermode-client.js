/*
  challengermode-client.js — Challengermode (challengermode.com) Client API.

  NOT Challonge. Different company, different platform, completely different API shape:

    Challonge        REST, v1 API key on every request, 500 requests/month on the free plan
    Challengermode   GraphQL, short-lived bot token exchanged from a long-lived refresh key

  ── Auth ───────────────────────────────────────────────────────────────────
  Two steps, and the first one is the part that is easy to get wrong:

    1. POST {BASE}/v1/auth/access_keys   { "refreshKey": "<long-lived key>" }
       → 200 { "value": "<access token>", "expiresAt": "<UTC ISO>" }
    2. POST {BASE}/graphql  with  Authorization: Bearer <value>

  The REFRESH key is created once in the Application Dashboard (challengermode.com/developers) and
  shown only once. The ACCESS token it buys is short-lived — the docs say ~20 minutes — so it must
  be re-exchanged, not stored. This client does that transparently: it caches the token, refreshes
  a minute before expiry, and re-exchanges once on a 401 in case the server expired it early.

  A "Bot" is how an application identifies itself. By default a bot can read PUBLIC data, which is
  all a broadcast overlay needs. Linking the bot to a Space (in the dashboard) is only required to
  read that Space's private tournaments or to write results back.

  ── Cost, not rate ─────────────────────────────────────────────────────────
  Challengermode publishes no requests-per-minute number. Instead every field in the schema carries
  an @cost weight, so a request is budgeted by how much data it asks for. The practical consequence
  is the opposite of Challonge: ask for fewer FIELDS, not fewer requests. Queries here are
  deliberately narrow, and the bracket walk pages rounds rather than pulling a whole tournament
  graph in one shot.
*/

'use strict';

const axios = require('axios');

const CM_BASE = 'https://publicapi.challengermode.com/mk1';
const CM_GRAPHQL = 'https://publicapi.challengermode.com/graphql';
// Re-exchange this long before the stated expiry, so a request can't be issued with a token that
// dies in flight.
const TOKEN_SKEW_MS = 60 * 1000;

/*
  Pull a Challengermode tournament id out of whatever the producer pasted.

  They will paste a full URL far more often than a bare id, and Challengermode URLs carry the id as
  a UUID somewhere in the path. Taking the LAST uuid in the string handles every form we've seen
  (/tournaments/<id>, /s/<space>/tournaments/<id>, with or without a query string) without having
  to enumerate their routes.
*/
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function parseTournamentId(input) {
  const str = String(input || '').trim();
  if (!str) return '';
  const hits = str.match(UUID_RE);
  return hits && hits.length ? hits[hits.length - 1].toLowerCase() : '';
}

function createChallengermodeClient(refreshKey, opts = {}) {
  const key = (refreshKey || '').trim();
  const timeout = Number(opts.timeout) || 30000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let token = '';
  let tokenExpiresAt = 0;
  let inflight = null;        // single-flight: a burst of queries must not each mint a token
  let spend = 0;              // requests issued, for the caller's meter

  function notConfigured() {
    return new Error('Challengermode refresh key not configured. Create one in the Challengermode Application Dashboard (challengermode.com/developers) and paste it in Settings.');
  }

  async function exchangeToken() {
    if (!key) throw notConfigured();
    spend++;
    const res = await axios.post(`${CM_BASE}/v1/auth/access_keys`, { refreshKey: key }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'NE-Broadcast-Suite/1.0' },
      timeout,
      validateStatus: () => true
    });
    if (res.status === 401 || res.status === 403) {
      // The single most likely misconfiguration, and the message has to say which key is wrong —
      // "unauthorized" on its own sends people looking at the tournament id instead.
      throw new Error('Challengermode rejected the refresh key. Check it was copied whole, and that it has not been revoked in the Application Dashboard.');
    }
    if (res.status >= 400 || !res.data || !res.data.value) {
      throw new Error(`Challengermode auth failed (HTTP ${res.status}).`);
    }
    token = res.data.value;
    const exp = Date.parse(res.data.expiresAt || '');
    // Fall back to a conservative 15 minutes if the server sends no/odd expiry — better to
    // re-exchange too often than to run on a dead token mid-show.
    tokenExpiresAt = Number.isFinite(exp) ? exp : (Date.now() + 15 * 60 * 1000);
    return token;
  }

  async function accessToken(force = false) {
    if (!force && token && Date.now() < tokenExpiresAt - TOKEN_SKEW_MS) return token;
    if (inflight) return inflight;
    inflight = exchangeToken().finally(() => { inflight = null; });
    return inflight;
  }

  /*
    Run a GraphQL query. `retryAuth` lets exactly one 401 trigger a token re-exchange and a single
    replay — enough to survive a token the server expired early, without turning a genuinely bad
    key into an endless exchange loop.
  */
  async function query(document, variables = {}, { retryAuth = true, attempts = 3 } = {}) {
    if (!key) throw notConfigured();
    let lastErr;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await sleep(600 * attempt);
      const bearer = await accessToken(attempt === 0 ? false : true);
      spend++;
      let res;
      try {
        res = await axios.post(CM_GRAPHQL, { query: document, variables }, {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'NE-Broadcast-Suite/1.0',
            Authorization: `Bearer ${bearer}`
          },
          timeout,
          validateStatus: () => true
        });
      } catch (err) {
        lastErr = err;                      // network / timeout — worth another go
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        if (retryAuth && attempt < attempts - 1) { token = ''; lastErr = new Error('HTTP ' + res.status); continue; }
        throw new Error('Challengermode refused the request (not authorised). A bot can read public tournaments; a private one needs the bot linked to that Space in the Application Dashboard.');
      }
      if (res.status === 429) {
        lastErr = new Error('rate limited');
        continue;
      }
      if (res.status >= 500) { lastErr = new Error('HTTP ' + res.status); continue; }
      if (res.status >= 400) throw new Error(`Challengermode API error (HTTP ${res.status}).`);

      const body = res.data || {};
      // GraphQL reports failures with HTTP 200 and an `errors` array — checking the status alone
      // reads a failed query as an empty result, which is how this class of bug goes unnoticed.
      if (Array.isArray(body.errors) && body.errors.length) {
        const first = body.errors[0] || {};
        const code = (first.extensions && (first.extensions.code || first.extensions.errorCode)) || '';
        throw new Error(`Challengermode: ${first.message || 'query failed'}${code ? ` (${code})` : ''}`);
      }
      if (!body.data) throw new Error('Challengermode returned no data.');
      return body.data;
    }
    throw new Error(`Challengermode network error: ${lastErr ? lastErr.message : 'request failed'}`);
  }

  return {
    query,
    parseTournamentId,
    // Verify the key without asking for any tournament data.
    async testConnection() {
      await accessToken(true);
      const d = await query('query { me { __typename } }', {}, { retryAuth: false });
      return !!d;
    },
    get requestCount() { return spend; },
    clearToken() { token = ''; tokenExpiresAt = 0; }
  };
}

module.exports = { createChallengermodeClient, parseTournamentId, CM_BASE, CM_GRAPHQL };
