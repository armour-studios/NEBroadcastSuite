'use strict';
// Twitch channel management — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (twitchClient).
let
  app, bridgeClients, broadcast, broadcastFullState, buildLiveState, chatManager,
  cloud, saveTwitchData, state;
let ctx;

module.exports = function registerTwitchChannelRoutes(c) {
  ctx = c;
  ({
    app, bridgeClients, broadcast, broadcastFullState, buildLiveState, chatManager,
    cloud, saveTwitchData, state
  } = c);

  // ── Twitch Channel Management ─────────────────────────────────────────────

  // PATCH /api/twitch/channel — update stream title and/or game
  app.patch('/api/twitch/channel', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { title, gameId, gameName } = req.body;
    try {
      let resolvedGameId = gameId;
      if (!resolvedGameId && gameName) {
        console.log('[Twitch] Searching for game:', gameName);
        const games = await ctx.twitchClient.searchGames(gameName);
        if (games && games.length > 0) resolvedGameId = games[0].id;
      }
      await ctx.twitchClient.updateChannel(state.twitch.channelId, { title, gameId: resolvedGameId });
      console.log('[Twitch] Channel updated — title:', title, 'gameId:', resolvedGameId);
      res.json({ success: true, title, gameId: resolvedGameId });
    } catch (e) {
      console.error('[Twitch] updateChannel error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // GET /api/twitch/games/search?q= — search for a game/category
  app.get('/api/twitch/games/search', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q param required' });
    try {
      const games = await ctx.twitchClient.searchGames(q);
      res.json((games || []).map(g => ({ id: g.id, name: g.name, boxArtUrl: g.box_art_url || '' })));
    } catch (e) {
      console.error('[Twitch] searchGames error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/announcement — send a chat announcement
  app.post('/api/twitch/announcement', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { message, color } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    try {
      console.log('[Twitch] Posting announcement:', message.slice(0, 60));
      await ctx.twitchClient.postAnnouncement(state.twitch.channelId, state.twitch.channelId, message, color || 'PRIMARY');
      res.json({ success: true });
    } catch (e) {
      console.error('[Twitch] postAnnouncement error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/shoutout — send a shoutout to a user by login
  // Tries the Helix API first (requires broadcaster to be live); falls back to IRC /shoutout command.
  app.post('/api/twitch/shoutout', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { login } = req.body;
    if (!login) return res.status(400).json({ error: 'login required' });
    try {
      const user = await ctx.twitchClient.getUserByLogin(login);
      if (!user) return res.status(404).json({ error: `User not found: ${login}` });
      console.log('[Twitch] Sending shoutout to:', login, user.id);
      try {
        await ctx.twitchClient.sendShoutout(state.twitch.channelId, user.id, state.twitch.channelId);
        return res.json({ success: true, userId: user.id, displayName: user.display_name });
      } catch (apiErr) {
        // API requires broadcaster to be live — fall back to IRC /shoutout chat command
        console.warn('[Twitch] API shoutout failed, using IRC fallback:', apiErr.message);
        if (chatManager?.isConnected) {
          chatManager.sendMessage(`/shoutout ${user.login || login}`);
          return res.json({ success: true, userId: user.id, displayName: user.display_name, method: 'irc' });
        }
        throw apiErr;
      }
    } catch (e) {
      console.error('[Twitch] sendShoutout error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/raid — start a raid to a user by login
  app.post('/api/twitch/raid', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { login } = req.body;
    if (!login) return res.status(400).json({ error: 'login required' });
    try {
      const user = await ctx.twitchClient.getUserByLogin(login);
      if (!user) return res.status(404).json({ error: `User not found: ${login}` });
      console.log('[Twitch] Starting raid to:', login, user.id);
      const result = await ctx.twitchClient.startRaid(state.twitch.channelId, user.id);
      res.json({ success: true, userId: user.id, displayName: user.display_name, raid: result });
    } catch (e) {
      console.error('[Twitch] startRaid error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // GET /api/twitch/raid/target?login= — fetch stream info for a raid target (viewer count + live status)
  app.get('/api/twitch/raid/target', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const login = (req.query.login || '').trim().toLowerCase();
    if (!login) return res.status(400).json({ error: 'login required' });
    try {
      const user = await ctx.twitchClient.getUserByLogin(login);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const info = await ctx.twitchClient.getStreamInfo(user.id);
      res.json({ displayName: user.display_name, isLive: info.live, viewers: info.viewerCount, game: info.gameName });
    } catch (e) {
      console.error('[Twitch] raid/target error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // DELETE /api/twitch/raid — cancel an active raid
  app.delete('/api/twitch/raid', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      console.log('[Twitch] Cancelling raid');
      await ctx.twitchClient.cancelRaid(state.twitch.channelId);
      res.json({ success: true });
    } catch (e) {
      console.error('[Twitch] cancelRaid error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // GET /api/twitch/chat/settings — get current chat moderation settings
  app.get('/api/twitch/chat/settings', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      const result = await ctx.twitchClient.getChatSettings(state.twitch.channelId, state.twitch.channelId);
      res.json(result);
    } catch (e) {
      console.error('[Twitch] getChatSettings error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // PATCH /api/twitch/chat/settings — update chat moderation settings
  app.patch('/api/twitch/chat/settings', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { subOnly, slowMode, slowModeSeconds, emoteOnly, followerOnly, followerOnlyMinutes, uniqueChat } = req.body;
    const settings = {};
    if (typeof subOnly === 'boolean')             settings.subscriber_mode = subOnly;
    if (typeof slowMode === 'boolean')            settings.slow_mode = slowMode;
    if (typeof slowModeSeconds === 'number')      settings.slow_mode_wait_time = slowModeSeconds;
    if (typeof emoteOnly === 'boolean')           settings.emote_mode = emoteOnly;
    if (typeof followerOnly === 'boolean')        settings.follower_mode = followerOnly;
    if (typeof followerOnlyMinutes === 'number')  settings.follower_mode_duration = followerOnlyMinutes;
    if (typeof uniqueChat === 'boolean')          settings.unique_chat_mode = uniqueChat;
    try {
      console.log('[Twitch] Updating chat settings:', settings);
      const result = await ctx.twitchClient.updateChatSettings(state.twitch.channelId, state.twitch.channelId, settings);
      Object.assign(state.twitch.chatSettings, result);
      saveTwitchData();
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      res.json({ success: true, chatSettings: state.twitch.chatSettings });
    } catch (e) {
      console.error('[Twitch] updateChatSettings error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // GET /api/twitch/chat/shield — get shield mode status
  app.get('/api/twitch/chat/shield', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      const result = await ctx.twitchClient.getShieldMode(state.twitch.channelId, state.twitch.channelId);
      res.json(result);
    } catch (e) {
      console.error('[Twitch] getShieldMode error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // PUT /api/twitch/chat/shield — set shield mode on or off
  app.put('/api/twitch/chat/shield', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { active } = req.body;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
    try {
      console.log('[Twitch] Setting shield mode:', active);
      const result = await ctx.twitchClient.setShieldMode(state.twitch.channelId, state.twitch.channelId, active);
      res.json({ success: true, shieldMode: result });
    } catch (e) {
      console.error('[Twitch] setShieldMode error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/ad/snooze — snooze the next scheduled ad
  app.post('/api/twitch/ad/snooze', async (req, res) => {
    if (req.body && req.body.target === 'org') {
      const orgId = orgIdForAds();
      if (!orgId) return res.status(400).json({ error: 'Sign in with your organization to snooze its ads' });
      try {
        const out = await cloud.orgAdSnooze(orgId);
        _orgAdsCache = null;
        return res.json({ success: true, snooze: out, channel: out.channel });
      } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    }
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      console.log('[Twitch] Snoozing next ad');
      const result = await ctx.twitchClient.snoozeNextAd(state.twitch.channelId);
      res.json({ success: true, snooze: result });
    } catch (e) {
      console.error('[Twitch] snoozeNextAd error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/ad/run — run a Twitch ad break (commercial) of the given length (seconds)
  app.post('/api/twitch/ad/run', async (req, res) => {
    // Ads are producer-action ONLY: reject anything originating from the flow engine.
    if (req.headers['x-ne-flow']) return res.status(403).json({ error: 'Ads cannot be triggered by automations' });
    if (state.twitch.adsEnabled === false) return res.status(409).json({ error: 'Ads are turned off' });
    const length = [30, 60, 90, 120, 150, 180].includes(Number(req.body && req.body.length)) ? Number(req.body.length) : 30;
    // The organization's channel: run through the website with the channel owner's token (Twitch
    // refuses an editor's own token for ads). Same gates as below: producer click only, ads on.
    if (req.body && req.body.target === 'org') {
      const orgId = orgIdForAds();
      if (!orgId) return res.status(400).json({ error: 'Sign in with your organization to run its ads' });
      try {
        console.log('[Twitch] Running', length + 's commercial on the organization channel');
        const out = await cloud.orgAdRun(orgId, length);
        _orgAdsCache = null;
        return res.json({ success: true, ad: out, channel: out.channel });
      } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    }
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      console.log('[Twitch] Running', length + 's commercial');
      const result = await ctx.twitchClient.runCommercial(state.twitch.channelId, length);
      res.json({ success: true, ad: result });
    } catch (e) {
      console.error('[Twitch] runCommercial error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // GET /api/twitch/ad/org-status — can this desk run ads on its organization's channel?
  // { available, channel:{login,displayName}|null, why, canSnooze, schedule, mine } where mine is the
  // login this app's Twitch connection uses, so the panel can tell "my channel" from "our channel".
  // Cached briefly: the panel asks when the ad menu opens and once a minute.
  app.get('/api/twitch/ad/org-status', async (req, res) => {
    const mine = String(state.twitch.displayName || '').toLowerCase();
    const orgId = orgIdForAds();
    if (!orgId) return res.json({ available: false, channel: null, why: 'Sign in with your organization to run ads on its channel.', mine });
    if (_orgAdsCache && _orgAdsCache.orgId === orgId && Date.now() - _orgAdsCache.at < 15000 && !req.query.fresh) return res.json({ ..._orgAdsCache.data, mine });
    try {
      const d = await cloud.orgAdsStatus(orgId);
      const data = { available: !!d.channel, channel: d.channel || null, why: d.why || '', canSnooze: !!d.canSnooze, schedule: d.schedule || null };
      _orgAdsCache = { orgId, at: Date.now(), data };
      res.json({ ...data, mine });
    } catch (e) {
      res.json({ available: false, channel: null, why: e.status === 403 ? e.message : 'Could not reach the website to check the channel.', mine });
    }
  });

  // POST /api/twitch/ad/enabled — producer toggle: enable/disable running Twitch ads
  app.post('/api/twitch/ad/enabled', (req, res) => {
    const enabled = !(req.body && req.body.enabled === false);
    state.twitch.adsEnabled = enabled;
    saveTwitchData();
    broadcastFullState();
    console.log('[Twitch] Ads', enabled ? 'enabled' : 'disabled', 'by producer');
    res.json({ success: true, adsEnabled: enabled });
  });
};

// The signed-in organization (not the personal "user:<id>" workspace), or ''.
let _orgAdsCache = null;
function orgIdForAds() {
  try {
    if (!cloud || !cloud.authed()) return '';
    const id = (cloud.getSession() || {}).workspaceId;
    return id && !String(id).startsWith('user:') ? String(id) : '';
  } catch (e) { return ''; }
}
