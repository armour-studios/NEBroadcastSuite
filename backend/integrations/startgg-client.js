const axios = require('axios');

const STARTGG_API_URL = 'https://api.start.gg/gql/alpha';

function createStartGgClient(apiToken) {
  if (!apiToken) {
    return {
      request: async () => {
        throw new Error('Start.gg API token not configured');
      }
    };
  }

  const MAX_RETRIES = 4;
  // A big import is 40-60 sequential requests. ANY single transient failure used to end the whole
  // sweep, which is what "importing RLCS times out / errors out" looked like to a producer. Only
  // 429 was retried; a timeout, a dropped socket, or one of start.gg's routine 502/503/504s under
  // load threw straight out. These three helpers decide what is worth another go.
  const RETRY_STATUS = new Set([408, 425, 500, 502, 503, 504, 522, 524]);
  const isRetryableNetworkError = (err) => {
    const code = String((err && err.code) || '');
    if (/ECONNABORTED|ETIMEDOUT|ECONNRESET|EPIPE|ENETUNREACH|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH/.test(code)) return true;
    return /timeout|socket hang up|network|aborted/i.test(String((err && err.message) || ''));
  };
  // start.gg also throttles with HTTP 200 + a GraphQL error ("throttled", "rate limit exceeded"),
  // which no status check can catch. Deliberately NOT matching "complexity": that one is a
  // property of the query itself, so retrying only burns the budget and fails with the same text.
  const isThrottleMessage = (m) => /throttl|rate ?limit|too many requests/i.test(String(m || ''));
  const backoffMs = (attempt) => Math.min(20000, 1500 * Math.pow(2, attempt));

  return {
    async request(query, variables) {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await axios.post(
            STARTGG_API_URL,
            { query, variables },
            {
              headers: {
                Authorization: `Bearer ${apiToken}`,
                'User-Agent': 'NE-Broadcast-Suite/1.0',
                Accept: 'application/json',
                'Content-Type': 'application/json'
              },
              // Deep set queries on a major event genuinely take longer than 20s to come back.
              timeout: 45000,
              validateStatus: () => true  // handle all status codes ourselves
            }
          );
        } catch (err) {
          if (isRetryableNetworkError(err) && attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, backoffMs(attempt)));
            continue;
          }
          throw new Error(`Start.gg network error: ${err.message}`);
        }

        // start.gg rate-limits in short bursts (independent of the per-minute quota) — back off
        // and retry rather than failing the whole action on what's usually a transient 429.
        if (res.status === 429) {
          if (attempt >= MAX_RETRIES) throw new Error('Start.gg rate limit — too many requests, try again in a minute.');
          const retryAfterHeader = parseFloat(res.headers['retry-after']);
          const waitMs = Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : backoffMs(attempt);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        const body = res.data;

        // start.gg returns 400 for auth failures with { success: false, message: '...' }
        if (res.status === 400 || res.status === 401) {
          const msg = (typeof body === 'object' && body.message) || `HTTP ${res.status}`;
          throw new Error(msg);
        }
        // Transient server-side failures: retry rather than killing a 50-request import.
        if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
          continue;
        }
        if (res.status !== 200) {
          throw new Error(`Start.gg returned HTTP ${res.status}`);
        }

        if (body.errors && body.errors.length) {
          const msg = body.errors.map((e) => e.message).join('; ');
          // A 200-with-throttle-error is the same transient condition as a 429.
          if (isThrottleMessage(msg) && attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, backoffMs(attempt)));
            continue;
          }
          throw new Error(msg);
        }
        if (!body.data) {
          // An empty 200 body is how start.gg sheds load sometimes — treat it as transient.
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, backoffMs(attempt)));
            continue;
          }
          throw new Error('Start.gg API returned no data');
        }
        return body.data;
      }
    }
  };
}

module.exports = {
  createStartGgClient,
  STARTGG_API_URL
};
