'use strict';
// Game State Integration receivers (Dota 2, CS2) — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged).
let
  DOTA_GSI_TOKEN, GSI_TOKEN, app, handleDotaGsi, handleGsi;
let ctx;

module.exports = function registerGsiRoutes(c) {
  ctx = c;
  ({
    DOTA_GSI_TOKEN, GSI_TOKEN, app, handleDotaGsi, handleGsi
  } = c);

  // ── Dota 2 Game State Integration receiver (cfg written by backend/dota-gsi.js) ──
  app.post('/api/dota-gsi', (req, res) => {
    try {
      const body = req.body || {};
      const token = body.auth && body.auth.token;
      if (token && token !== DOTA_GSI_TOKEN) return res.status(403).end();
      handleDotaGsi(body);
    } catch (e) {
      console.error('[Dota GSI] parse error:', e.message);
    }
    res.status(200).end();
  });

  // ── CS2 Game State Integration receiver ───────────────────────────────────
  app.post('/gsi', (req, res) => {
    try {
      const body = req.body || {};
      // Optional auth token check (set in the GSI cfg)
      const token = body.auth && body.auth.token;
      if (token && token !== GSI_TOKEN) {
        return res.status(403).end();
      }
      handleGsi(body);
    } catch (e) {
      console.error('[GSI] parse error:', e.message);
    }
    res.status(200).end();
  });
};
