'use strict';
// Twitch connection and sign-in: OAuth sessions, Discord OAuth, licence acceptance — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (_launcherLaunchCb, _launcherResizeCb, _panelReady, _pendingContract, _siteHomePulledAt, _tokenRefreshGen, _tokenRefreshTimer, _twitchStatsCache, _twitchTokenInvalid, chatParser, miniGameManager, predictionManager, twitchClient, wheelManager).
let
  BROADCAST_API_KEY, BROADCAST_REMOTE_URL, ChatParser, DISCORD_CLIENT_ID, DISCORD_REDIRECT_URI,
  MiniGameManager, PredictionManager, TWITCH_CLIENT_ID, TwitchClient, WebSocket, WheelManager,
  app, appPromos, axios, bridgeClients, broadcast, broadcastFullState, buildLiveState,
  chatManager, cloud, coStore, eventSubService, express, registerTwitchWebhooks,
  saveDiscordUser, saveTwitchData, scheduleTokenRefresh, siteHome, state,
  stopPredictionPolling, streamStateManager;
let ctx;

module.exports = function registerAuthRoutes(c) {
  ctx = c;
  ({
    BROADCAST_API_KEY, BROADCAST_REMOTE_URL, ChatParser, DISCORD_CLIENT_ID,
    DISCORD_REDIRECT_URI, MiniGameManager, PredictionManager, TWITCH_CLIENT_ID, TwitchClient,
    WebSocket, WheelManager, app, appPromos, axios, bridgeClients, broadcast,
    broadcastFullState, buildLiveState, chatManager, cloud, coStore, eventSubService, express,
    registerTwitchWebhooks, saveDiscordUser, saveTwitchData, scheduleTokenRefresh, siteHome,
    state, stopPredictionPolling, streamStateManager
  } = c);

  // ── Twitch Integration ────────────────────────────────────────────────────
  registerTwitchWebhooks(app, state, (type, data) => {
    bridgeClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, data }));
      }
    });
  }, ctx.wheelManager, ctx.miniGameManager, ctx.chatParser);

  // Set Twitch API token manually
  app.post('/api/twitch/set-token', async (req, res) => {
    const { apiToken } = req.body;
    if (!apiToken) {
      return res.status(400).json({ error: 'API token required' });
    }

    try {
      // Derive identity from the token itself (don't trust client-supplied displayName/
      // channelId — a bare manual paste has neither). applyTwitchAccessToken validates the
      // token via Helix, wires up the clients, and broadcasts the connected state.
      const user = await applyTwitchAccessToken(String(apiToken), '');
      console.log('[Twitch] Token saved, connected as:', user.login);
      res.json({ success: true, message: 'Token saved', displayName: user.login });
    } catch (err) {
      console.error('[Twitch] Token error:', err.response?.data || err.message);
      res.status(400).json({ error: 'Token validation failed' });
    }
  });

  // Disconnect from Twitch
  app.post('/api/twitch/disconnect', (req, res) => {
    console.log('[Twitch] Disconnecting');
    state.twitch.connected = false;
    state.twitch.apiToken = '';
    // Without these the scheduled refresh restored the token minutes later and Twitch came back.
    state.twitch.refreshToken = '';
    if (ctx._tokenRefreshTimer) { clearTimeout(ctx._tokenRefreshTimer); ctx._tokenRefreshTimer = null; }
    ctx._tokenRefreshGen++;
    try { stopPredictionPolling(); } catch (e) {}
    state.twitch.displayName = '';
    state.twitch.userId = '';
    state.twitch.channelId = '';
    state.twitch.profilePicture = '';
    ctx.twitchClient = null;
    ctx.predictionManager = null;
    ctx.wheelManager = null;

    // Stop polling stream state
    streamStateManager.stopPolling();

    // Disconnect from IRC chat
    chatManager.disconnect();

    // Close the EventSub WebSocket
    try { eventSubService.stop(); } catch (e) { console.error('[EventSub] stop failed:', e.message); }

    saveTwitchData();
    broadcastFullState();

    res.json({ success: true, message: 'Disconnected' });
  });

  // ─── OAuth Session Management ───────────────────────────────────────────
  // Store OAuth sessions in memory (expires after 15 minutes)
  const oauthSessions = new Map();

  // POST /api/oauth/twitch/init - Create a new OAuth session and build the authorize URL.
  // Cloud signed-in → authorization-CODE flow (the backend holds the client secret and hands
  // back tokens WITH a refresh token — no more implicit-grant tokens dying mid-show).
  // No cloud → the legacy implicit-grant URL, exactly as before (local-first, additive).
  app.post('/api/oauth/twitch/init', express.json({ limit: '16kb' }), (req, res) => {
    try {
      const sessionId = Math.random().toString(36).substring(2, 15);
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
      const scopes = (Array.isArray(req.body && req.body.scopes) ? req.body.scopes : [])
        .filter((s) => typeof s === 'string' && /^[a-z_:.]+$/.test(s)).slice(0, 64);
      const useCodeFlow = !!(cloud && typeof cloud.authed === 'function' && cloud.authed());

      oauthSessions.set(sessionId, {
        state: sessionId,
        accessToken: null,
        mode: useCodeFlow ? 'code' : 'token',
        expiresAt
      });

      const redirectUri = 'http://localhost:3000/api/oauth/twitch/callback';
      const authUrl = 'https://id.twitch.tv/oauth2/authorize'
        + `?client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}`
        + `&redirect_uri=${encodeURIComponent(redirectUri)}`
        + `&response_type=${useCodeFlow ? 'code' : 'token'}`
        + (scopes.length ? `&scope=${scopes.map(encodeURIComponent).join('%20')}` : '')
        + `&state=${encodeURIComponent(sessionId)}`
        + '&force_verify=true';

      console.log('[OAuth] Session created:', sessionId, '· flow:', useCodeFlow ? 'code (backend exchange)' : 'implicit');
      res.json({ sessionId, authUrl, mode: useCodeFlow ? 'code' : 'token' });
    } catch (err) {
      console.error('[OAuth Init]', err);
      res.status(500).json({ error: 'Failed to create OAuth session' });
    }
  });

  // Validate an access token (from the Implicit-grant fragment) and wire up the Twitch
  // clients. Shared by the OAuth callback page below. Throws if the token is invalid.
  async function applyTwitchAccessToken(accessToken, refreshToken) {
    const userRes = await axios.get('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-ID': TWITCH_CLIENT_ID }
    });
    const user = userRes.data?.data?.[0];
    if (!user) throw new Error('No user data');

    state.twitch.apiToken = accessToken;
    state.twitch.refreshToken = refreshToken || '';
    state.twitch.displayName = user.login;
    state.twitch.channelId = user.id;
    state.twitch.profilePicture = user.profile_image_url || '';
    state.twitch.connected = true;
    ctx._twitchTokenInvalid = false;   // fresh token → re-enable EventSub/IRC/poll retries
    ctx._twitchStatsCache = null;
    ctx.twitchClient = new TwitchClient(TWITCH_CLIENT_ID, null, accessToken);
    ctx.predictionManager = new PredictionManager(ctx.twitchClient, user.id);
    ctx.wheelManager = new WheelManager(state);
    ctx.miniGameManager = new MiniGameManager(state);
    ctx.chatParser = new ChatParser(ctx.miniGameManager);
    if (streamStateManager && typeof streamStateManager.startPolling === 'function') streamStateManager.startPolling();
    chatManager.connect(user.login, accessToken).catch(err => console.error('[IRC Connect]', err.message));
    saveTwitchData();
    // Implicit-grant tokens have no refresh token; only schedule a refresh if we got one.
    if (refreshToken) scheduleTokenRefresh();
    // Open the EventSub WebSocket so live events (subs/raids/redemptions/etc.) flow in.
    try { eventSubService.start(); } catch (e) { console.error('[EventSub] start failed:', e.message); }
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
    console.log('[OAuth] State applied for:', user.login);
    return user;
  }

  // POST /api/oauth/twitch/apply-token - Apply a token captured from the callback fragment.
  app.post('/api/oauth/twitch/apply-token', express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const accessToken = req.body && req.body.accessToken;
      if (!accessToken) return res.status(400).json({ error: 'Missing access token' });
      const user = await applyTwitchAccessToken(String(accessToken), '');
      res.json({ ok: true, login: user.login, channelId: user.id });
    } catch (err) {
      console.error('[OAuth ApplyToken]', err.response?.data || err.message);
      res.status(400).json({ error: 'Token validation failed' });
    }
  });

  // Minimal result page for the CODE-flow callback (exchange already done server-side —
  // no fragment dance needed). Same look as the implicit page below.
  function twitchResultPage(ok, loginOrMsg) {
    const badge = ok ? '✓' : '✕';
    const cls = ok ? 'ok' : 'err';
    const title = ok ? 'Twitch Connected!' : 'Connection failed';
    const body = ok
      ? `<div class="username">${String(loginOrMsg || '').replace(/[<>&"]/g, '')}</div><div class="message">You can close this window — the app is connected.</div>`
      : `<div class="message">${String(loginOrMsg || 'Could not connect to Twitch. Close this window and try again.').replace(/[<>&"]/g, '')}</div>`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title><style>
      *{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;justify-content:center;align-items:center;min-height:100vh}
      .container{background:#fff;border-radius:16px;padding:48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:420px}
      .badge{width:80px;height:80px;margin:0 auto 24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:44px;color:#fff}
      .badge.ok{background:#10b981}.badge.err{background:#ef4444}
      h1{color:#1f2937;font-size:26px;margin-bottom:12px}.username{color:#9146FF;font-size:20px;font-weight:600;margin-bottom:20px}.message{color:#6b7280;font-size:15px;line-height:1.5}
    </style></head><body><div class="container"><div class="badge ${cls}">${badge}</div><h1>${title}</h1>${body}</div>
    ${ok ? '<script>setTimeout(function(){ try { window.close(); } catch(e){} }, 2500);</script>' : ''}</body></html>`;
  }

  // GET /api/oauth/twitch/callback - OAuth redirect target.
  // CODE flow (?code= present, cloud signed-in): exchange the code via the backend — the
  // secret lives there, and the tokens come back WITH a refresh token.
  // IMPLICIT flow (legacy, no cloud): Twitch returns the token in the URL fragment, which the
  // page below reads and POSTs to /api/oauth/twitch/apply-token.
  app.get('/api/oauth/twitch/callback', async (req, res) => {
    const { error, error_description } = req.query;
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const cbState = typeof req.query.state === 'string' ? req.query.state : '';
    if (code) {
      res.set('Content-Type', 'text/html');
      try {
        // State must match a session we minted (CSRF guard); temp- prefixed panel fallbacks pass too.
        const sess = oauthSessions.get(cbState);
        if (!sess && !cbState.startsWith('temp-')) throw new Error('Unknown or expired sign-in session — start the connect again.');
        const d = await cloud.linkTwitch({ code, redirectUri: 'http://localhost:3000/api/oauth/twitch/callback' });
        const user = await applyTwitchAccessToken(d.accessToken, d.refreshToken || '');
        if (sess) sess.accessToken = d.accessToken;   // existing pollers resolve
        res.send(twitchResultPage(true, user.login));
      } catch (e) {
        console.error('[OAuth Callback] code exchange failed:', e.message);
        res.send(twitchResultPage(false, e.message));
      }
      return;
    }
    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connecting to Twitch…</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .container { background: #fff; border-radius: 16px; padding: 48px; text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 420px; }
    .badge { width: 80px; height: 80px; margin: 0 auto 24px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; font-size: 44px;
      background: #9146FF; color: #fff; }
    .badge.ok { background: #10b981; } .badge.err { background: #ef4444; }
    h1 { color: #1f2937; font-size: 26px; margin-bottom: 12px; }
    .username { color: #9146FF; font-size: 20px; font-weight: 600; margin-bottom: 20px; }
    .message { color: #6b7280; font-size: 15px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge" id="badge">⟳</div>
    <h1 id="title">Connecting to Twitch…</h1>
    <div class="username" id="user" style="display:none"></div>
    <div class="message" id="msg">Finishing sign-in, one moment…</div>
  </div>
  <script>
    var qErr = ${JSON.stringify(String(error || ''))};
    var qErrDesc = ${JSON.stringify(String(error_description || ''))};
    function fail(text){
      document.getElementById('badge').textContent = '✕';
      document.getElementById('badge').className = 'badge err';
      document.getElementById('title').textContent = 'Connection failed';
      document.getElementById('msg').textContent = text || 'Could not connect to Twitch. Close this window and try again.';
    }
    function ok(login){
      document.getElementById('badge').textContent = '✓';
      document.getElementById('badge').className = 'badge ok';
      document.getElementById('title').textContent = 'Connected to Twitch!';
      var u = document.getElementById('user'); u.textContent = '@' + login; u.style.display = 'block';
      document.getElementById('msg').textContent = 'Your account is linked. Closing this window…';
      setTimeout(function(){ window.close(); }, 1800);
    }
    if (qErr) { fail(qErrDesc || qErr); }
    else {
      var params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
      var token = params.get('access_token');
      if (!token) { fail('No access token was returned by Twitch.'); }
      else {
        fetch('/api/oauth/twitch/apply-token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: token })
        }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
          .then(function(o){ if (o.ok && o.j && o.j.ok) ok(o.j.login); else fail((o.j && o.j.error) || 'Token validation failed.'); })
          .catch(function(){ fail('Could not reach Broadcast Studio. Is the app still running?'); });
      }
    }
  </script>
</body>
</html>`);
  });

  // GET /api/oauth/twitch/token/:sessionId - Poll for token
  app.get('/api/oauth/twitch/token/:sessionId', (req, res) => {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({ error: 'Missing sessionId' });
      }

      const session = oauthSessions.get(sessionId);

      if (!session) {
        return res.status(401).json({ error: 'Session not found' });
      }

      if (Date.now() > session.expiresAt) {
        oauthSessions.delete(sessionId);
        return res.status(401).json({ error: 'Session expired' });
      }

      if (!session.accessToken) {
        // Still waiting for callback
        return res.status(202).json({ status: 'pending' });
      }

      // Token is ready!
      res.json({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        displayName: session.displayName,
        channelId: session.channelId,
        profilePicture: session.profilePicture
      });
    } catch (err) {
      console.error('[OAuth Token]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Discord OAuth ───────────────────────────────────────────────────────────

  // GET /api/oauth/discord/status - Returns current Discord user (no token)
  // Server clock, for overlays to correct their own against. The break countdown is an ABSOLUTE
  // epoch (endsAt) authored by this process but evaluated by every browser source against ITS OWN
  // Date.now() — so any machine whose clock is off shows a countdown that is off by exactly that
  // much. scene-base.js samples this and offsets. Deliberately not in full_state: a value that
  // changes every tick would churn the broadcast payload for something only clients need on connect.
  app.get('/api/time', (req, res) => res.json({ now: Date.now() }));
  // Promo strip campaigns (control panel only; see backend/promos.js).
  app.get('/api/promos', (req, res) => res.json({ promos: appPromos.list() }));
  // Home page content from namelessesports.com (cached; see backend/site-home.js). ?refresh=1 pulls
  // now (the Home page's Refresh button and its first open after sign-in).
  // Custom overlay layouts for overlay/custom.html. Read-only; loopback like the rest of the server.
  app.get('/api/custom-overlays', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, overlays: coStore() ? coStore().summaries() : [] });
  });
  app.get('/api/custom-overlays/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const o = coStore() && coStore().get(String(req.params.id || ''));
    if (!o) return res.status(404).json({ ok: false, error: 'No such overlay.' });
    res.json({ ok: true, overlay: o });
  });
  app.get('/api/site-home', async (req, res) => {
    if (req.query.refresh && Date.now() - ctx._siteHomePulledAt > 30000 && !cloud.retryInMs()) {
      ctx._siteHomePulledAt = Date.now();
      await Promise.allSettled([siteHome.refreshHome(), siteHome.refreshMe()]);
    }
    res.set('Cache-Control', 'no-store').json(siteHome.snapshot());
  });

  app.get('/api/oauth/discord/status', (req, res) => {
    res.json({
      connected: state.discord.connected,
      panelReady: ctx._panelReady,          // launcher holds its animation until the studio is painted
      userId: state.discord.userId,
      username: state.discord.username,
      discriminator: state.discord.discriminator,
      globalName: state.discord.globalName,
      avatarUrl: state.discord.avatarUrl,
      needsContract: !!ctx._pendingContract,   // approved but license unsigned — accept in-app
      lastError: state.discord.lastError || ''
    });
  });

  // ── In-app license acceptance (first sign-in after approval) ────────────────
  // GET returns the license text the backend sent with the refused login;
  // POST forwards the typed legal-name signature and completes the sign-in.
  app.get('/api/cloud/contract', (req, res) => {
    if (!ctx._pendingContract) return res.json({ pending: false });
    res.json({ pending: true, license: ctx._pendingContract.license || null });
  });

  app.post('/api/cloud/contract/accept', async (req, res) => {
    if (!ctx._pendingContract) return res.status(400).json({ ok: false, message: 'No agreement is waiting — sign in first.' });
    const signatureName = String((req.body && req.body.signatureName) || '').trim();
    if (signatureName.length < 3) return res.status(400).json({ ok: false, message: 'Type your full legal name to sign the agreement.' });
    try {
      const data = await cloud.acceptContract({ token: ctx._pendingContract.token, signatureName });
      const cu = (data && data.user) || {};
      state.discord.connected     = true;
      state.discord.userId        = cu.discordId || '';
      state.discord.username      = cu.username || '';
      state.discord.discriminator = cu.discriminator || '0';
      state.discord.globalName    = cu.globalName || cu.username || '';
      state.discord.avatarUrl     = cu.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
      state.discord.lastError     = '';
      ctx._pendingContract = null;
      saveDiscordUser();
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      console.log('[Cloud] License accepted, signed in as', state.discord.username);
      res.json({ ok: true });
    } catch (e) {
      // Expired token → make them sign in again (which issues a fresh one).
      if (e && e.status === 401) ctx._pendingContract = null;
      res.status(400).json({ ok: false, message: (e && e.message) || 'Could not record the signature.' });
    }
  });

  // POST /api/launcher/resize - the launcher asks for more room (license view)
  app.post('/api/launcher/resize', (req, res) => {
    const w = Math.max(360, Math.min(900, Number(req.body && req.body.width) || 0));
    const h = Math.max(240, Math.min(800, Number(req.body && req.body.height) || 0));
    try {
      if (typeof ctx._launcherResizeCb === 'function' && w && h) ctx._launcherResizeCb(w, h);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // POST /api/launcher/launch - the launcher window finished auth + its load animation;
  // main.js swaps it for the studio window via the registered callback.
  app.post('/api/launcher/launch', (req, res) => {
    try {
      if (typeof ctx._launcherLaunchCb === 'function') ctx._launcherLaunchCb();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'launch failed' });
    }
  });

  // POST /api/oauth/discord/init - Returns the Discord OAuth URL for the client to open
  app.post('/api/oauth/discord/init', (req, res) => {
    if (!DISCORD_CLIENT_ID) {
      return res.status(500).json({ error: 'DISCORD_CLIENT_ID not configured — add it to .env.local' });
    }
    // The callback can only exchange the code if it has a secret (local mode) or a backend to do it.
    // Fail HERE with a clear message instead of opening an OAuth flow that dead-ends at the callback.
    if (!cloud.configured() && !(process.env.DISCORD_CLIENT_SECRET || '')) {
      return res.status(500).json({ error: 'Discord login can\'t finish: add DISCORD_CLIENT_SECRET to .env.local (Discord Developer Portal → your app → OAuth2 → Client Secret), or set BROADCAST_REMOTE_URL to use the Nameless backend. Then relaunch.' });
    }
    const stateParam = Math.random().toString(36).substring(2, 18);
    const _crypto = require('crypto');
    const codeVerifier = _crypto.randomBytes(48).toString('base64url');
    const codeChallenge = _crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    oauthSessions.set(stateParam, { state: stateParam, expiresAt: Date.now() + 15 * 60 * 1000, type: 'discord', codeVerifier });
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify email',   // email lets the Nameless backend link the same site account
      state: stateParam,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
    res.json({ url: `https://discord.com/oauth2/authorize?${params}` });
  });

  // GET /api/oauth/discord/callback - Discord redirects here after auth
  app.get('/api/oauth/discord/callback', async (req, res) => {
    const { code, state: stateParam, error, error_description } = req.query;
    if (error) {
      return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Broadcast Studio</title><style>*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#111318;color:#e8eaf0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center}.card{background:#1a1d24;border:1px solid #2a2e3a;border-radius:16px;padding:40px 36px;text-align:center;width:320px;animation:fadeIn .3s ease-out}.logo{width:36px;height:36px;object-fit:contain;margin-bottom:20px;opacity:.85}.ring{width:64px;height:64px;border-radius:50%;background:rgba(245,101,101,.1);border:2px solid rgba(245,101,101,.3);display:flex;align-items:center;justify-content:center;margin:0 auto 20px}.title{font-size:17px;font-weight:600;margin-bottom:8px}.msg{font-size:13px;color:#6b7280;margin-bottom:24px;line-height:1.5}.btn{background:#2a2e3a;border:none;color:#e8eaf0;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer}.btn:hover{background:#333740}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}</style></head><body><div class="card"><img src="/assets/images/small.png" class="logo" alt=""><div class="ring"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#f56565" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div><div class="title">Discord Error</div><div class="msg">${String(error_description || error || '').replace(/[<>&"']/g, '')}</div><button class="btn" onclick="window.close()">Close Window</button></div></body></html>`);
    }
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }

    const _sess = stateParam ? oauthSessions.get(stateParam) : null;
    const codeVerifier = _sess && _sess.codeVerifier;
    const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
    // Prefer the LOCAL direct exchange whenever a client secret is present (dev machines): it's
    // registered for the localhost redirect and doesn't depend on the Nameless backend being
    // deployed/ready. BROADCAST_REMOTE_URL DEFAULTS to namelessesports.com (so cloud.configured() is
    // always true), which was silently routing local dev logins through a backend still being built —
    // that's where the 400 came from. Only use the backend when there's no local secret (production).
    // Set DISCORD_USE_BACKEND=1 to FORCE the backend path with a secret still present — this exercises
    // the exact production flow (POST namelessesports.com/api/auth/discord) so you can verify it.
    const forceBackend = process.env.DISCORD_USE_BACKEND === '1';
    const useBackend = cloud.configured() && (forceBackend || !DISCORD_CLIENT_SECRET);
    if (!useBackend && !DISCORD_CLIENT_SECRET) {
      return res.status(500).send('Discord login is not configured — no backend (BROADCAST_REMOTE_URL) and no DISCORD_CLIENT_SECRET.');
    }
    // The login used PKCE (code_challenge), so the token exchange REQUIRES the matching code_verifier
    // we stashed at init. It lives in memory, so it's gone if the server restarted (or nodemon reloaded
    // it) between clicking Sign in and returning here → Discord replies 400 invalid_grant. Detect that
    // and say so plainly instead of a cryptic 400.
    if (!codeVerifier) {
      state.discord.connected = false;
      state.discord.lastError = 'Login session expired (the app restarted mid-login) — just click Sign in with Discord again.';
      try { broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (e) {}
      return res.status(400).send(state.discord.lastError);
    }

    try {
      let u, avatarUrl, accessToken = '', refreshToken = '';

      if (useBackend) {
        // Nameless backend holds DISCORD_CLIENT_SECRET and performs the PKCE code exchange.
        const data = await cloud.loginWithDiscord({ code, codeVerifier, redirectUri: DISCORD_REDIRECT_URI });
        const cu = (data && data.user) || {};
        u = {
          id: cu.discordId || '',
          username: cu.username || '',
          global_name: cu.globalName || cu.username || '',
          discriminator: cu.discriminator || '0'
        };
        avatarUrl = cu.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
      } else {
        // Local dev fallback — direct exchange with the bundled secret.
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
          new URLSearchParams(Object.assign({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: DISCORD_REDIRECT_URI
          }, codeVerifier ? { code_verifier: codeVerifier } : {})),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        accessToken = tokenRes.data.access_token;
        refreshToken = tokenRes.data.refresh_token || '';
        const userRes = await axios.get('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        u = userRes.data;
        avatarUrl = u.avatar
          ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
          : `https://cdn.discordapp.com/embed/avatars/${(BigInt(u.id) >> 22n) % 6n}.png`;
      }

      state.discord.connected    = true;
      state.discord.userId       = u.id;
      state.discord.username     = u.username;
      state.discord.discriminator = u.discriminator || '0';
      state.discord.globalName   = u.global_name || u.username;
      state.discord.avatarUrl    = avatarUrl;
      state.discord.accessToken  = accessToken;
      state.discord.refreshToken = refreshToken;
      state.discord.lastError    = '';
      ctx._pendingContract = null;

      saveDiscordUser();

      // In local-secret mode, record the user in the namelessesports DB. In backend mode the
      // /api/auth/discord exchange already upserts the user, so we skip the extra sync.
      if (!useBackend && BROADCAST_REMOTE_URL && BROADCAST_API_KEY) {
        axios.post(`${BROADCAST_REMOTE_URL}/api/broadcast-users/sync`, {
          discordId:     u.id,
          username:      u.username,
          globalName:    u.global_name || u.username,
          discriminator: u.discriminator || '0',
          avatarUrl:     avatarUrl,
        }, {
          headers: { 'x-api-key': BROADCAST_API_KEY, 'Content-Type': 'application/json' },
          timeout: 5000
        }).catch(err => console.warn('[Discord] Remote user sync failed (non-fatal):', err.message));
      }

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      console.log('[Discord] Logged in as', u.username, useBackend ? '(via Nameless backend)' : '(local)');

      if (stateParam) oauthSessions.delete(stateParam);

      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Broadcast Studio</title><style>*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#111318;color:#e8eaf0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center}.card{background:#1a1d24;border:1px solid #2a2e3a;border-radius:16px;padding:40px 36px;text-align:center;width:320px;animation:fadeIn .3s ease-out}.logo{width:36px;height:36px;object-fit:contain;margin-bottom:20px;opacity:.85}.check-ring{width:64px;height:64px;border-radius:50%;background:rgba(88,101,242,.12);border:2px solid rgba(88,101,242,.35);display:flex;align-items:center;justify-content:center;margin:0 auto 20px}.avatar{width:56px;height:56px;border-radius:50%;border:2px solid #5865f2;margin-bottom:12px}.name{font-size:18px;font-weight:600;margin-bottom:4px}.handle{font-size:13px;color:#6b7280;}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}</style></head><body><div class="card"><img src="/assets/images/small.png" class="logo" alt="Broadcast Studio"><div class="check-ring"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#5865f2" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><img src="${avatarUrl}" class="avatar" alt=""><div class="name">${u.global_name || u.username}</div><div class="handle">@${u.username}</div></div></body></html>`);
    } catch (err) {
      // Approved but the license isn't signed yet — the backend sent the agreement
      // (token + text). Stash it; the launcher / auth gate shows it for acceptance.
      const cd = err && err.data;
      if (err && err.status === 403 && cd && cd.error && cd.error.code === 'unsigned' && cd.contract) {
        ctx._pendingContract = cd.contract;
        state.discord.connected = false;
        state.discord.lastError = '';
        try { broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (e) {}
        if (stateParam) oauthSessions.delete(stateParam);
        console.log('[Discord] Signed in but license unsigned — awaiting in-app acceptance.');
        return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Broadcast Studio</title><style>*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#111318;color:#e8eaf0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center}.card{background:#1a1d24;border:1px solid #2a2e3a;border-radius:16px;padding:40px 36px;text-align:center;width:340px}.t{font-size:16px;font-weight:700;margin-bottom:8px}.s{font-size:13px;color:#9aa0ae;line-height:1.5}</style></head><body><div class="card"><div class="t">One more step</div><div class="s">You're approved — return to the Broadcast Studio app to review and sign the license agreement.</div></div></body></html>`);
      }
      // Surface the ACTUAL Discord error (redirect_uri_mismatch / invalid_client / invalid_grant …)
      // both to the terminal AND into state so the panel/login-poll can show why it failed.
      const d = err.response && err.response.data;
      // Surface the REAL Discord error: prefer error_description/error, else the raw body, else message.
      const reason = (d && (d.error_description || d.error))
        || (d && typeof d === 'object' ? JSON.stringify(d).slice(0, 180) : (typeof d === 'string' ? d : ''))
        || err.message || 'Discord authentication failed';
      console.error('[Discord OAuth] token exchange failed:', err.response ? err.response.status : '', d || err.message);
      state.discord.connected = false;
      state.discord.lastError = String(reason).slice(0, 220);
      try { broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (e) {}
      res.status(500).send(`Discord authentication failed: ${reason} — check the terminal for details.`);
    }
  });

  // POST /api/oauth/discord/logout - Clear Discord session
  app.post('/api/oauth/discord/logout', (req, res) => {
    // Also drop the cloud session — otherwise a logout leaves a live 30-day
    // refresh token sitting in cloud-session.json on disk.
    try { cloud.clearSession(); } catch (_) {}
    state.discord.connected    = false;
    state.discord.userId       = '';
    state.discord.username     = '';
    state.discord.discriminator = '';
    state.discord.globalName   = '';
    state.discord.avatarUrl    = '';
    state.discord.accessToken  = '';
    state.discord.refreshToken = '';
    ctx._pendingContract = null;
    saveDiscordUser();
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
    console.log('[Discord] Logged out');
    res.json({ ok: true });
  });
};
