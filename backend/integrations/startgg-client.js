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

  return {
    async request(query, variables) {
      let res;
      try {
        res = await axios.post(
          STARTGG_API_URL,
          { query, variables },
          {
            headers: {
              Authorization: `Bearer ${apiToken}`,
              'User-Agent': 'NE-Broadcast-Suite/1.0 (+https://namelessesports.gg)',
              Accept: 'application/json',
              'Content-Type': 'application/json'
            },
            timeout: 20000,
            validateStatus: () => true  // handle all status codes ourselves
          }
        );
      } catch (err) {
        throw new Error(`Start.gg network error: ${err.message}`);
      }

      const body = res.data;

      // start.gg returns 400 for auth failures with { success: false, message: '...' }
      if (res.status === 400 || res.status === 401) {
        const msg = (typeof body === 'object' && body.message) || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      if (res.status !== 200) {
        throw new Error(`Start.gg returned HTTP ${res.status}`);
      }

      if (body.errors && body.errors.length) {
        const msg = body.errors.map((e) => e.message).join('; ');
        throw new Error(msg);
      }
      if (!body.data) {
        throw new Error('Start.gg API returned no data');
      }
      return body.data;
    }
  };
}

module.exports = {
  createStartGgClient,
  STARTGG_API_URL
};
