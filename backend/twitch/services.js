// backend/twitch/services.js — Twitch EventSub, stream state (viewers, ads, stream info), chat
// (IRC + automations), the EventSub HTTP routes and Twitch clips. Moved out of server.js unchanged
// (refactor step 3); server.js creates it once with createTwitchServices(ctx).
//
// ctx: stable references (the state object, helpers, the flow bus) plus live getters for the
// handful of values server.js replaces at runtime (twitchClient, chatParser, clipSystem, …), read
// as ctx.<name> so a later replacement is always seen. setTwitchTokenInvalid(v) writes back the one
// flag this code sets.
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const axios = require('axios');

module.exports = function createTwitchServices(ctx) {
  const { state, cloud, questionStore, analytics, tryEnterMarbleRace, TWITCH_CLIENT_ID, questionsChanged, saveTwitchData, refreshTwitchToken, currentViewers, chatCommandReply, broadcast, buildLiveState, broadcastClipsUpdate, syncClipsState, flowBus, normalizePrediction, normalizePoll, _logActivity, announceGameResult, stopPredictionPolling, broadcastFullState, triggerClipCapture, replayBufferErrorMessage, switcherIsVmix, vmixMarkReplay } = ctx;

// ─── Twitch EventSub Service ─────────────────────────────────────────────────
// Recently seen EventSub message ids (socket and webhook share them). Twitch retries a delivery it
// thinks failed, and handling it twice doubled alerts, redemptions and prediction updates.
const _eventSubSeenIds = new Map();
function _eventSubSeen(id) {
  if (!id) return false;
  if (_eventSubSeenIds.has(id)) return true;
  _eventSubSeenIds.set(id, Date.now());
  if (_eventSubSeenIds.size > 500) { const first = _eventSubSeenIds.keys().next().value; _eventSubSeenIds.delete(first); }
  return false;
}
class EventSubService {
  constructor() {
    this.subscriptions = new Map(); // Map of subscription_type -> { id, status, cost, created_at }
    this.webhookSecret = null;
    this.totalCost = 0;
    this.maxTotalCost = 100; // WebSocket EventSub allows 300 subscriptions per session
    this.subscriptionIds = new Set(); // Track all subscription IDs for deduplication
    this.retryQueue = [];
    this.rateLimitResetTime = 0;
    this.rateLimitRemaining = 120;

    // EventSub WebSocket transport — works from localhost (no public URL / webhook needed).
    // Twitch delivers events down an outbound WS we open, so there's nothing to expose.
    this.ws = null;
    this.sessionId = null;
    this.wsUrl = 'wss://eventsub.wss.twitch.tv/ws';
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this._kaTimeout = 10; // seconds; Twitch tells us the real value in session_welcome
    this.shouldRun = false;
    this.connected = false;
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────────────
  // Open the EventSub WebSocket and (on welcome) subscribe to all event types.
  start() {
    this.shouldRun = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._connect();
  }

  stop() {
    this.shouldRun = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._clearKeepalive();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.on('error', () => {});  // absorb async error if socket was still CONNECTING
        this.ws.terminate();
      } catch (_) {}
      this.ws = null;
    }
    this.sessionId = null;
    this.connected = false;
  }

  _connect() {
    if (!this.shouldRun) return;
    if (!state.twitch.apiToken) { console.warn('[EventSub] No Twitch token — WS not started'); return; }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.on('error', () => {});  // absorb async error if socket was still CONNECTING
        this.ws.terminate();
      } catch (_) {}
      this.ws = null;
    }

    let ws;
    try { ws = new WebSocket(this.wsUrl); }
    catch (e) { console.error('[EventSub] WS connect error:', e.message); return this._scheduleReconnect(); }
    this.ws = ws;

    ws.on('open', () => console.log('[EventSub] WebSocket connecting…'));
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('error', (e) => console.error('[EventSub] WS error:', e.message));
    ws.on('close', (code) => {
      if (ws !== this.ws) return; // a stale socket we already replaced
      this._clearKeepalive();
      this.connected = false;
      console.warn('[EventSub] WS closed (' + code + ')');
      this.ws = null;
      if (this.shouldRun) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || !this.shouldRun) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, 3000);
  }

  async _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const type = msg.metadata && msg.metadata.message_type;

    if (type === 'session_welcome') {
      this.sessionId = msg.payload.session.id;
      this.connected = true;
      this._armKeepalive(msg.payload.session.keepalive_timeout_seconds);
      console.log('[EventSub] WebSocket session ready:', this.sessionId);
      // Fresh session has no subscriptions — (re)create them against this session id.
      this.subscriptions.clear();
      this.subscriptionIds.clear();
      this.totalCost = 0;
      try { await this.subscribeToAll(state.twitch.channelId); } catch (e) { console.error('[EventSub] subscribeToAll failed:', e.message); }
      broadcast(ctx.bridgeClients, { type: 'twitch_eventsub_status', data: this.getStatus() });
    } else if (type === 'session_keepalive') {
      this._armKeepalive();
    } else if (type === 'notification') {
      this._armKeepalive();
      // Twitch delivers at least once: a repeated message id is the same event (no second alert).
      if (_eventSubSeen(msg.metadata && msg.metadata.message_id)) return;
      const sub = msg.payload.subscription || {};
      this.handleEvent({ type: sub.type, data: msg.payload.event });
    } else if (type === 'session_reconnect') {
      // Twitch is asking us to move; simplest robust path is a fresh reconnect + re-subscribe.
      console.log('[EventSub] Reconnect requested — reconnecting');
      this._connect();
    } else if (type === 'revocation') {
      console.warn('[EventSub] Subscription revoked:', msg.payload.subscription && msg.payload.subscription.type);
    }
  }

  // If no keepalive/notification arrives within the timeout (+grace), the link is dead.
  _armKeepalive(sec) {
    if (sec) this._kaTimeout = sec;
    this._clearKeepalive();
    this.keepaliveTimer = setTimeout(() => {
      console.warn('[EventSub] Keepalive timeout — forcing reconnect');
      if (this.ws) { try { this.ws.terminate(); } catch (_) {} }
    }, ((this._kaTimeout || 10) + 5) * 1000);
  }

  _clearKeepalive() {
    if (this.keepaliveTimer) { clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null; }
  }

  // Set webhook configuration
  setWebhookConfig(webhookUrl, webhookSecret) {
    this.webhookUrl = webhookUrl;
    this.webhookSecret = webhookSecret;
    console.log('[EventSub] Webhook configured:', webhookUrl);
  }

  // Verify webhook signature (Twitch requirement)
  verifyWebhookSignature(req) {
    const signature = req.headers['twitch-eventsub-message-signature'];
    const timestamp = req.headers['twitch-eventsub-message-timestamp'];
    const id = req.headers['twitch-eventsub-message-id'];
    const body = req.rawBody || '';

    if (!signature || !timestamp || !id) return false;
    // Replay protection (Twitch's guidance): refuse messages older than 10 minutes.
    const ts = Date.parse(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60 * 1000) return false;

    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', this.webhookSecret);
    hmac.update(id + timestamp + body);
    const expected = Buffer.from('sha256=' + hmac.digest('hex'));
    const got = Buffer.from(String(signature));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }

  // Register for an EventSub subscription (over the WebSocket session)
  async subscribe(eventType, version = '1', condition = {}) {
    if (!state.twitch.apiToken) {
      console.error('[EventSub] Cannot subscribe: No Twitch token');
      return null;
    }
    if (!this.sessionId) {
      console.warn('[EventSub] Cannot subscribe: WebSocket session not ready');
      return null;
    }

    try {
      const costEstimate = this.getCost(eventType);
      if (this.totalCost + costEstimate > this.maxTotalCost) {
        console.warn('[EventSub] Subscription cost would exceed limit', { eventType, costEstimate, totalCost: this.totalCost });
        return null;
      }

      const body = {
        type: eventType,
        version: version,
        condition: condition,
        // WebSocket transport — events stream down the open socket; no callback/secret.
        transport: {
          method: 'websocket',
          session_id: this.sessionId
        }
      };

      const response = await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', body, {
        headers: {
          'Authorization': `Bearer ${state.twitch.apiToken}`,
          'Client-ID': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 202 && response.data.data && response.data.data.length > 0) {
        const sub = response.data.data[0];
        this.subscriptions.set(eventType, {
          id: sub.id,
          status: sub.status,
          cost: costEstimate,
          created_at: new Date().toISOString()
        });
        this.subscriptionIds.add(sub.id);
        this.totalCost += costEstimate;
        console.log('[EventSub] Subscribed to', eventType, '- Total cost:', this.totalCost);
        return sub;
      }
    } catch (err) {
      const status = err.response?.status;
      const twitchMsg = err.response?.data?.message || '';
      if (status === 401) {
        // Dead token — stop trying the remaining subscriptions (subscribeToAll breaks on this).
        this._authFailed = true;
        return null;
      }
      if (status === 409) {
        // Duplicate subscription — already active from a previous session that hasn't
        // been fully cleaned up yet. Not an error; events will still arrive.
        console.warn('[EventSub] Duplicate subscription (already active):', eventType);
      } else if (status === 403) {
        console.warn('[EventSub] Scope missing for', eventType, '— reconnect Twitch to grant updated permissions');
      } else if (status === 400 && twitchMsg.toLowerCase().includes('role')) {
        // Twitch: "The broadcaster does not have the required role" — Affiliate/Partner only
        console.warn('[EventSub] Skipping', eventType, '— channel not eligible (Affiliate/Partner required)');
      } else {
        console.error('[EventSub] Subscription failed:', eventType, 'status:', status, twitchMsg || err.message);
      }
      if (status === 429) {
        this.rateLimitRemaining = parseInt(err.response.headers['ratelimit-remaining']) || 0;
        this.rateLimitResetTime = parseInt(err.response.headers['ratelimit-reset']) * 1000;
      }
    }
    return null;
  }

  // Get cost for an event type
  getCost(eventType) {
    const costs = {
      'stream.online': 1,
      'stream.offline': 1,
      'channel.follow': 1,
      'channel.subscribe': 1,
      'channel.cheer': 1,
      'channel.raid': 1,
      'channel.channel_points_custom_reward_redemption.add': 1,
      'channel.hype_train.begin': 1,
      'channel.hype_train.progress': 1,
      'channel.hype_train.end': 1,
      'channel.poll.begin': 1,
      'channel.poll.progress': 1,
      'channel.poll.end': 1,
      'channel.prediction.begin': 1,
      'channel.prediction.progress': 1,
      'channel.prediction.lock': 1,
      'channel.prediction.end': 1,
      'channel.ad_break.begin': 1,
      'clip.create': 1
    };
    return costs[eventType] || 1;
  }

  // Subscribe to all recommended event types. Each type carries the version + condition
  // shape Twitch currently requires (follow=v2 + moderator_user_id, raid keys on
  // to_broadcaster_user_id, redemptions use the .add subtype). Types the token lacks scopes
  // for simply fail individually and are skipped — the rest still subscribe.
  async subscribeToAll(channelId) {
    if (!channelId) { console.warn('[EventSub] No channelId — cannot subscribe'); return []; }
    const specs = [
      { type: 'stream.online',  version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: channelId, moderator_user_id: channelId } },
      { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.cheer', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: channelId } },
      { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.hype_train.begin', version: '2', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.hype_train.progress', version: '2', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.hype_train.end', version: '2', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.poll.begin', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.poll.progress', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.poll.end', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.prediction.begin', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.prediction.progress', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.prediction.lock', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.prediction.end', version: '1', condition: { broadcaster_user_id: channelId } },
      { type: 'channel.ad_break.begin', version: '1', condition: { broadcaster_user_id: channelId } }
    ];

    this._authFailed = false;
    const results = [];
    for (const s of specs) {
      if (this._authFailed) break;   // token rejected — stop hammering Twitch with the rest
      const sub = await this.subscribe(s.type, s.version, s.condition);
      results.push({ eventType: s.type, success: !!sub });
      await new Promise(r => setTimeout(r, 150)); // Rate limit spacing
    }
    if (this._authFailed) { markTwitchTokenInvalid('EventSub token rejected (401)'); return results; }
    const ok = results.filter(r => r.success).length;
    console.log('[EventSub] Subscribed to ' + ok + '/' + results.length + ' event types');
    return results;
  }

  // Handle incoming webhook events
  handleEvent(event) {
    const { type, data } = event;
    console.log('[EventSub Event]', type);

    switch (type) {
      case 'stream.online':
        state.twitch.isLive = true;
        broadcast(ctx.bridgeClients, { type: 'twitch_stream_online', data });
        flowBus.emit('twitch_stream_online', {});
        break;

      case 'stream.offline':
        state.twitch.isLive = false;
        broadcast(ctx.bridgeClients, { type: 'twitch_stream_offline', data });
        flowBus.emit('twitch_stream_offline', {});
        break;

      case 'channel.follow':
        broadcast(ctx.bridgeClients, { type: 'twitch_follow', data: { user: data.user_name, timestamp: data.followed_at } });
        chatManager.onFollow(data.user_name);
        flowBus.emit('twitch_follow', { user: data.user_name });
        _logActivity({ type: 'follow', username: data.user_name });
        break;

      case 'channel.subscribe':
        broadcast(ctx.bridgeClients, { type: 'twitch_subscribe', data: { user: data.user_name, tier: data.tier } });
        chatManager.onSubscribe(data.user_name, data.tier);
        flowBus.emit('twitch_sub', { user: data.user_name, tier: data.tier });
        _logActivity({ type: 'sub', username: data.user_name, tier: data.tier });
        break;

      case 'channel.subscription.message':
        // Resub with message
        broadcast(ctx.bridgeClients, { type: 'twitch_subscribe', data: { user: data.user_name, tier: data.tier, resub: true, months: data.cumulative_months } });
        flowBus.emit('twitch_sub', { user: data.user_name, tier: data.tier, resub: true });
        _logActivity({ type: 'resub', username: data.user_name, tier: data.tier, months: data.cumulative_months || 1 });
        break;

      case 'channel.subscription.gift':
        broadcast(ctx.bridgeClients, { type: 'twitch_subscribe', data: { user: data.recipient_user_name, tier: data.tier, gift: true, gifter: data.user_name } });
        flowBus.emit('twitch_sub', { user: data.recipient_user_name, tier: data.tier, gift: true });
        _logActivity({ type: 'gift_sub', username: data.recipient_user_name, gifter: data.user_name || 'Anonymous', tier: data.tier });
        break;

      case 'channel.raid':
        broadcast(ctx.bridgeClients, { type: 'twitch_raid', data: { from: data.from_broadcaster_user_login, viewers: data.viewers } });
        chatManager.onRaid(data.from_broadcaster_user_login, data.viewers);
        flowBus.emit('twitch_raid', { from: data.from_broadcaster_user_login, viewers: data.viewers });
        _logActivity({ type: 'raid', from: data.from_broadcaster_user_login, viewers: data.viewers || 0 });
        break;

      case 'channel.channel_points_custom_reward_redemption.add':
        broadcast(ctx.bridgeClients, { type: 'twitch_channel_points', data: { user: data.user_name, reward: data.reward && data.reward.title, status: data.status } });
        flowBus.emit('twitch_channel_points', { user: data.user_name, reward: data.reward && data.reward.title });
        _logActivity({ type: 'channel_points', username: data.user_name, reward: data.reward && data.reward.title });
        break;

      case 'channel.cheer':
        broadcast(ctx.bridgeClients, { type: 'twitch_bits', data: { user: data.user_name, bits: data.bits } });
        flowBus.emit('twitch_bits', { user: data.user_name, bits: data.bits || 0 });
        _logActivity({ type: 'bits', username: data.user_name || 'Anonymous', amount: data.bits || 0 });
        break;

      case 'channel.hype_train.begin':
        broadcast(ctx.bridgeClients, { type: 'twitch_hype_train_begin', data });
        flowBus.emit('twitch_hype_train', { level: data.level || 1 });
        break;

      case 'channel.hype_train.progress':
        broadcast(ctx.bridgeClients, { type: 'twitch_hype_train_progress', data });
        break;

      case 'channel.hype_train.end':
        broadcast(ctx.bridgeClients, { type: 'twitch_hype_train_end', data });
        _logActivity({ type: 'hype_train', level: data.level || 1 });
        break;

      case 'channel.poll.begin':
      case 'channel.poll.progress': {
        const poll = normalizePoll(data);
        state.twitch.poll.current = poll;
        broadcast(ctx.bridgeClients, { type: 'twitch_poll_update', data: poll });
        broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
        break;
      }

      case 'channel.poll.end': {
        const poll = normalizePoll(data);
        state.twitch.poll.current = poll;
        broadcast(ctx.bridgeClients, { type: 'twitch_poll_end', data: poll });
        broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
        flowBus.emit('twitch_poll_end', { title: poll.title, total: poll.total });
        setTimeout(() => {
          if (state.twitch.poll.current?.id === poll.id) {
            state.twitch.poll.history.unshift(state.twitch.poll.current);
            if (state.twitch.poll.history.length > 20) state.twitch.poll.history.pop();
            state.twitch.poll.current = null;
            broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
          }
        }, 20000);
        break;
      }

      case 'channel.prediction.begin':
      case 'channel.prediction.progress':
      case 'channel.prediction.lock': {
        const pred = normalizePrediction(data, 0);
        if (type === 'channel.prediction.lock') pred.state = 'LOCKED';
        // Only overwrite if this is the same prediction or there's no current one
        if (!state.twitch.predictions.current || state.twitch.predictions.current.id === pred.id) {
          state.twitch.predictions.current = pred;
          broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
        }
        break;
      }

      case 'channel.prediction.end': {
        const pred = normalizePrediction(data, 0);
        if (state.twitch.predictions.current?.id === pred.id || !state.twitch.predictions.current) {
          state.twitch.predictions.current = pred;
          broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
          saveTwitchData();
          stopPredictionPolling();
          if (ctx.predictionManager) ctx.predictionManager.clearCooldown();
          const resolvedId = pred.id;
          setTimeout(() => {
            if (state.twitch.predictions.current?.id === resolvedId) {
              if (pred.state !== 'CANCELLED') {
                state.twitch.predictions.history.unshift(state.twitch.predictions.current);
                if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
              }
              state.twitch.predictions.current = null;
              broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
              saveTwitchData();
            }
          }, 18000);
        }
        break;
      }

      case 'channel.ad_break.begin': {
        const duration = data.duration_seconds || 0;
        const startedAt = data.started_at || new Date().toISOString();
        const endsAt = new Date(new Date(startedAt).getTime() + duration * 1000).toISOString();
        state.twitch.adBreak = { active: true, duration, startedAt, endsAt, isAutomatic: !!data.is_automatic };
        try { analytics.event('ad', { sec: duration }); } catch (e) {}
        broadcast(ctx.bridgeClients, { type: 'twitch_ad_break', data: { duration, isAutomatic: data.is_automatic, endsAt } });
        broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
        flowBus.emit('twitch_ad_break', { duration, isAutomatic: !!data.is_automatic });
        console.log(`[EventSub] Ad break: ${duration}s (${data.is_automatic ? 'automatic' : 'manual'})`);
        setTimeout(() => {
          if (state.twitch.adBreak.active) {
            state.twitch.adBreak.active = false;
            broadcast(ctx.bridgeClients, { type: 'twitch_ad_break_end', data: {} });
            broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
          }
        }, (duration + 3) * 1000);
        break;
      }

      default:
        console.log('[EventSub] Unknown event type:', type);
    }
  }

  // Get subscription status
  getStatus() {
    return {
      subscriptions: Object.fromEntries(this.subscriptions),
      totalCost: this.totalCost,
      maxCost: this.maxTotalCost,
      rateLimitRemaining: this.rateLimitRemaining,
      rateLimitReset: this.rateLimitResetTime
    };
  }
}

// Centralised handling of an expired/invalid Twitch token. The token is implicit-grant with no
// refresh, so once it 401s every transport (EventSub WS, IRC, stream poll) would retry forever and
// flood the console + hammer Twitch. Halt them all once and surface a reconnect prompt instead.
function markTwitchTokenInvalid(reason) {
  if (ctx._twitchTokenInvalid) return;
  ctx.setTwitchTokenInvalid(true);
  console.warn('[Twitch] OAuth token invalid/expired — halting EventSub/IRC/stream-poll. Reconnect Twitch under Apps > Twitch to resume. (' + (reason || 'auth failure') + ')');
  state.twitch.connected = false;
  try { eventSubService.stop(); } catch (e) {}
  try { chatManager.disconnect(); } catch (e) {}
  try { streamStateManager.stopPolling(); } catch (e) {}
  try { broadcast(ctx.bridgeClients, { type: 'twitch_auth_invalid', data: { needsReconnect: true } }); } catch (e) {}
  try { broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (e) {}
}

const eventSubService = new EventSubService();

// ─── Twitch Stream State Manager (viewer count, ads, stream info) ───────────
class TwitchStreamStateManager {
  constructor() {
    this.streamState = {
      isLive: false,
      viewerCount: 0,
      title: '',
      game: '',
      startedAt: null
    };
    this.adSchedule = {
      nextAdAt: null,
      lastAdAt: null,
      adDuration: 120, // 2 minutes default
      prerollFreeTime: 0,   // seconds of pre-roll free time remaining (from Twitch)
      prerollFreeUntil: 0,  // absolute ms when pre-roll free time runs out (0 = none)
      scheduleWindow: 30 * 60 * 1000 // 30 minute window
    };
    this.pollInterval = null;
    this.pollIntervalMs = 30 * 1000; // Poll every 30 seconds
    this.isPolling = false;
  }

  // Start polling for stream state
  startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;

    const poll = async () => {
      if (!state.twitch?.apiToken || !state.twitch?.channelId) return;

      try {
        // Fetch current stream info
        const streamRes = await axios.get('https://api.twitch.tv/helix/streams', {
          params: { user_id: state.twitch.channelId },
          headers: {
            'Authorization': `Bearer ${state.twitch.apiToken}`,
            'Client-ID': process.env.TWITCH_CLIENT_ID
          }
        });

        if (streamRes.data.data && streamRes.data.data.length > 0) {
          const stream = streamRes.data.data[0];
          this.streamState.isLive = true;
          this.streamState.viewerCount = stream.viewer_count;
          this.streamState.title = stream.title;
          this.streamState.game = stream.game_name;
          this.streamState.startedAt = stream.started_at;

          console.log('[Stream] Live:', this.streamState.viewerCount, 'viewers');
        } else {
          this.streamState.isLive = false;
          this.streamState.viewerCount = 0;
          this.streamState.startedAt = null;

          // Fetch channel info so title/category show even when offline
          try {
            const chanRes = await axios.get('https://api.twitch.tv/helix/channels', {
              params: { broadcaster_id: state.twitch.channelId },
              headers: {
                'Authorization': `Bearer ${state.twitch.apiToken}`,
                'Client-ID': process.env.TWITCH_CLIENT_ID
              }
            });
            const chan = chanRes.data.data && chanRes.data.data[0];
            if (chan) {
              this.streamState.title = chan.title || '';
              this.streamState.game  = chan.game_name || '';
            }
          } catch (e) {
            console.log('[Stream] Channel info unavailable:', e.response?.status || e.message);
          }

          console.log('[Stream] Offline');
        }

        // Fetch ad schedule (if supported)
        try {
          const adRes = await axios.get('https://api.twitch.tv/helix/channels/ads', {
            params: { broadcaster_id: state.twitch.channelId },
            headers: {
              'Authorization': `Bearer ${state.twitch.apiToken}`,
              'Client-ID': process.env.TWITCH_CLIENT_ID
            }
          });

          if (adRes.data.data && adRes.data.data.length > 0) {
            const ad = adRes.data.data[0];
            this.adSchedule.lastAdAt  = ad.last_ad_at  ? new Date(ad.last_ad_at)  : null;
            this.adSchedule.adDuration = ad.duration || 30;
            // Pre-roll free time: how long new viewers won't see a pre-roll ad (earned by ad breaks).
            const pf = Number(ad.preroll_free_time) || 0;
            this.adSchedule.prerollFreeTime  = pf;
            this.adSchedule.prerollFreeUntil = pf > 0 ? Date.now() + pf * 1000 : 0;
            // Use Twitch's authoritative next-ad timestamp when available.
            this.adSchedule.nextAdAt = ad.next_ad_at ? new Date(ad.next_ad_at) : null;
          }
        } catch (e) {
          // Ad schedule endpoint may not be available for all tokens
          console.log('[Ads] Schedule unavailable:', e.response?.status);
        }

        // Feed the broadcast-analytics recorder: viewer sample + auto start/stop on live transitions.
        try { analytics.recordStreamPoll(this.streamState.isLive, currentViewers()); } catch (e) {}

        // Broadcast state update
        broadcast(ctx.bridgeClients, {
          type: 'twitch_stream_state',
          data: {
            stream: this.streamState,
            ads: this.adSchedule
          }
        });

      } catch (err) {
        if (err.response && err.response.status === 401) { markTwitchTokenInvalid('stream poll 401'); return; }
        console.error('[Stream Poll]', err.message);
      }
    };

    // Poll immediately, then on interval
    poll();
    this.pollInterval = setInterval(poll, this.pollIntervalMs);
  }

  // Stop polling
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isPolling = false;
  }

  // Get current state
  getState() {
    return {
      stream: this.streamState,
      ads: this.adSchedule,
      nextAdCountdown: this.getAdCountdown()
    };
  }

  // Get seconds until next ad
  getAdCountdown() {
    if (!this.adSchedule.nextAdAt) return null;
    const now = new Date();
    const ms = this.adSchedule.nextAdAt.getTime() - now.getTime();
    if (ms <= 0) return 0;
    return Math.ceil(ms / 1000);
  }
}

const streamStateManager = new TwitchStreamStateManager();

// ─── Twitch Chat Manager (IRC + Automations) ────────────────────────────────
class TwitchChatManager {
  constructor() {
    this.ircSocket = null;
    this.isConnected = false;
    this.channelName = '';
    this.botName = 'nebroadcastbot';
    this.autoGreetings = {
      enabled: true,
      followMessage: 'Welcome {user}! Thanks for following!',
      subscribeMessage: 'Big thanks to {user} for subscribing! {tier}',
      raidMessage: 'Huge thanks to {user} for raiding with {viewers} viewers!'
    };
  }

  async connect(channelName, oauthToken) {
    // isConnected only flips at the JOIN ack, so a reconnect timer firing alongside an OAuth
    // reconnect (or a double click) opened a second socket: every chat line and command arrived
    // twice. One dial at a time, and any previous socket is torn down first.
    if (this.isConnected && this.channelName === String(channelName || '').toLowerCase()) return;
    if (this._connecting) return this._connecting;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ircSocket) { const old = this.ircSocket; this.ircSocket = null; this.isConnected = false; try { old.removeAllListeners(); old.on('error', () => {}); old.destroy(); } catch (e) {} }
    this._lineBuf = '';
    this._stopped = false;            // a fresh connect re-enables reconnects
    this.channelName  = channelName.toLowerCase();
    this._oauthToken  = oauthToken;   // keep for reconnect
    const tls = require('tls');

    this._connecting = new Promise((resolve, reject) => {
      try {
        const sock = this.ircSocket = tls.connect({
          host: 'irc.chat.twitch.tv',
          port: 6697,
          rejectUnauthorized: false
        }, () => {
          console.log('[IRC] TLS connected — authenticating as', this.channelName);
          // CAP REQ must come before PASS/NICK per Twitch docs
          this.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
          this.send(`PASS oauth:${oauthToken}`);
          this.send(`NICK ${this.channelName}`);
          this.send(`JOIN #${this.channelName}`);
        });

        this.ircSocket.on('data', (data) => { if (this.ircSocket === sock) this.handleData(data, resolve); });
        this.ircSocket.on('error', (err) => {
          if (this.ircSocket !== sock) return;
          console.error('[IRC] Socket error:', err.message);
          this.isConnected = false;
          state.twitch.chatConnected = false;
          broadcast(ctx.bridgeClients, { type: 'twitch_chat_disconnected' });
          this._scheduleReconnect();
        });
        this.ircSocket.on('close', () => {
          if (this.ircSocket !== sock) return;
          console.log('[IRC] Connection closed');
          this.isConnected = false;
          state.twitch.chatConnected = false;
          broadcast(ctx.bridgeClients, { type: 'twitch_chat_disconnected' });
          this._scheduleReconnect();
        });

        setTimeout(() => {
          if (this.isConnected || this.ircSocket !== sock) return;
          // A dial that never joined: close it (its 'close' schedules the retry) rather than leave it hanging.
          try { sock.destroy(); } catch (e) {}
          reject(new Error('IRC connection timeout'));
        }, 12000);
      } catch (err) {
        reject(err);
      }
    }).finally(() => { this._connecting = null; });
    return this._connecting;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._stopped || ctx._twitchTokenInvalid) return;   // don't loop on a dead token
    const delay = 8000;
    console.log(`[IRC] Reconnecting in ${delay / 1000}s…`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this.isConnected && this.channelName && this._oauthToken) {
        this.connect(this.channelName, this._oauthToken).catch(e => console.error('[IRC Reconnect]', e.message));
      }
    }, delay);
  }

  send(message) {
    if (!this.ircSocket) return;
    this.ircSocket.write(message + '\r\n');
  }

  sendMessage(message) {
    if (!this.isConnected) return;
    this.send(`PRIVMSG #${this.channelName} :${message}`);
  }

  handleData(data, _resolve) {
    // A line can be split across two TLS reads: keep the unfinished tail for the next chunk.
    const text = (this._lineBuf || '') + data.toString();
    const lines = text.split('\r\n');
    this._lineBuf = lines.pop();
    if (this._lineBuf.length > 65536) this._lineBuf = '';
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('PING')) {
        this.send('PONG :tmi.twitch.tv');
        continue;
      }
      // Detect successful JOIN ack — mark as connected here (not in the TLS callback)
      if (!this.isConnected && line.includes(`JOIN #${this.channelName}`)) {
        this.isConnected = true;
        state.twitch.chatConnected = true;
        state.twitch.chatChannel   = this.channelName;
        broadcast(ctx.bridgeClients, { type: 'twitch_chat_connected', data: { channel: this.channelName } });
        broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
        if (typeof _resolve === 'function') _resolve();
        console.log('[IRC] Authenticated and joined #' + this.channelName);
        continue;
      }
      // Login failed — Twitch sends various auth error messages
      if (line.includes('Login authentication failed') ||
          line.includes('NOTICE * :Error') ||
          line.includes(':Improperly formatted auth') ||
          line.includes('NOTICE * :Improperly') ||
          (line.includes(':tmi.twitch.tv NOTICE * :') && !line.includes('JOIN'))) {
        console.error('[IRC] Auth/login error:', line.trim());
        this.isConnected = false;
        state.twitch.chatConnected = false;
        broadcast(ctx.bridgeClients, { type: 'twitch_chat_disconnected' });
        markTwitchTokenInvalid('IRC login failed');   // bad token → halt, don't reconnect-loop
        this.ircSocket?.destroy();
        continue;
      }
      if (line.includes('PRIVMSG')) {
        this.handleChatMessage(line);
      } else if (line.includes('USERNOTICE')) {
        this.handleUserNotice(line);
      }
    }
  }

  handleUserNotice(line) {
    try {
      let tags = {};
      if (line.startsWith('@')) {
        const sp = line.indexOf(' ');
        line.slice(1, sp).split(';').forEach(t => {
          const eq = t.indexOf('=');
          if (eq !== -1) tags[t.slice(0, eq)] = t.slice(eq + 1);
        });
      }
      const msgId = tags['msg-id'];
      if (!msgId) return;
      const displayName = tags['display-name'] || tags['login'] || 'Someone';

      if (msgId === 'sub' || msgId === 'resub') {
        const plan = tags['msg-param-sub-plan'];
        const tier = plan === '2000' ? 2 : plan === '3000' ? 3 : 1;
        const months = parseInt(tags['msg-param-cumulative-months'] || '1', 10);
        broadcast(ctx.bridgeClients, {
          type: 'twitch_subscribe',
          data: { user: displayName, tier, months, resub: msgId === 'resub' }
        });
        this.onSubscribe(displayName, plan);
        console.log(`[IRC] ${msgId === 'resub' ? 'Resub' : 'Sub'}: ${displayName} (T${tier}, ${months}mo)`);
      } else if (msgId === 'subgift' || msgId === 'anonsubgift') {
        const plan = tags['msg-param-sub-plan'];
        const tier = plan === '2000' ? 2 : plan === '3000' ? 3 : 1;
        const recipient = tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'] || 'someone';
        broadcast(ctx.bridgeClients, {
          type: 'twitch_subscribe',
          data: { user: displayName, tier, gift: true, recipient }
        });
        console.log(`[IRC] Gift sub: ${displayName} → ${recipient}`);
      } else if (msgId === 'raid') {
        const viewers = parseInt(tags['msg-param-viewerCount'] || '0', 10);
        const raider = tags['msg-param-displayName'] || tags['msg-param-login'] || displayName;
        broadcast(ctx.bridgeClients, {
          type: 'twitch_raid',
          data: { from: raider, viewers }
        });
        this.onRaid(raider, viewers);
        console.log(`[IRC] Raid from ${raider} with ${viewers} viewers`);
      }
    } catch (err) {
      console.error('[USERNOTICE parse]', err.message);
    }
  }

  handleChatMessage(line) {
    try {
      // Parse IRCv3 tags (color, display-name) if present
      let tags = {};
      let rest = line;
      if (line.startsWith('@')) {
        const sp = line.indexOf(' ');
        line.slice(1, sp).split(';').forEach(t => { const [k, v] = t.split('='); tags[k] = v || ''; });
        rest = line.slice(sp + 1);
      }

      const match = rest.match(/:(\w+)!.*PRIVMSG #\w+ :(.*)/);
      if (!match) return;
      const username = tags['display-name'] || match[1];
      const message = match[2];
      const color = tags['color'] || '';

      broadcast(ctx.bridgeClients, {
        type: 'twitch_chat_message',
        data: { username, message, color, timestamp: new Date().toISOString() }
      });

      // Rolling multichat buffer so a freshly opened panel can backfill the feed
      // (request_chat_log) instead of starting empty. Platform-tagged for future
      // YouTube/Kick sources. NOT in full_state — history rides a one-shot reply.
      _chatLog.push({ platform: 'twitch', user: username, text: message, color, ts: Date.now() });
      if (_chatLog.length > 100) _chatLog.shift();

      captureQuestionFromChat('twitch', username, message);   // "!ask …" → Q&A queue

      // Route to active mini-game
      if (ctx.chatParser && ctx.miniGameManager?.currentGame?.state === 'active') {
        const userId = tags['user-id'] || match[1];
        const added = ctx.chatParser.parseMessage(userId, username, message);
        if (added) {
          broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
          // fastest_finger: auto-finalize the moment someone wins
          if (added === 'won') {
            const gameId = ctx.miniGameManager.currentGame?.id;
            if (gameId && ctx.gameTimers.has(gameId)) {
              clearTimeout(ctx.gameTimers.get(gameId)); ctx.gameTimers.delete(gameId);
            }
            const result = ctx.miniGameManager.finalize();
            broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
            saveTwitchData();
            announceGameResult(result);
            if (result) setTimeout(() => {
              if (state.twitch.minigame.current?.id === result.id) {
                state.twitch.minigame.current = null;
                broadcast(ctx.bridgeClients, { type: 'full_state', data: buildLiveState() });
              }
            }, 10000);
          }
        }
      }

      // Marble Race entry — parallel to the minigame block above, not routed through it (this is
      // a separate, cross-platform system; see backend/integrations/marble-race.js).
      tryEnterMarbleRace('twitch', tags['user-id'] || match[1], username, message);

      if (message.startsWith('!')) {
        this.handleCommand(match[1], message);
        // Emit for flow twitch_chat_command triggers
        const _cmdParts = message.trim().slice(1).split(/\s+/);
        flowBus.emit('twitch_chat_command', {
          user: username, command: _cmdParts[0].toLowerCase(),
          message: message.trim(), args: _cmdParts.slice(1).join(' ')
        });
      }
      console.log(`[Chat] ${username}: ${message}`);
    } catch (err) {
      console.error('[Chat Parse]', err.message);
    }
  }

  handleCommand(username, message) {
    const parts = message.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '!giveaway':
        broadcast(ctx.bridgeClients, { type: 'chat_command', data: { command: 'giveaway', user: username } });
        break;
      case '!game':
        if (parts[1]) {
          // Subcommand — forward to overlay bridge
          broadcast(ctx.bridgeClients, { type: 'chat_command', data: { command: 'game', user: username, gameType: parts[1] } });
        } else {
          // No subcommand — reply with active game
          const gameName = state.activeGame || 'Unknown';
          this.sendMessage(`Current game: ${gameName}`);
        }
        break;
      case '!clip':
        broadcast(ctx.bridgeClients, { type: 'chat_command', data: { command: 'clip', user: username } });
        this.sendMessage('Clip saved!');
        break;
      case '!score': {
        const blue   = state.teams?.blue?.name   || 'Blue';
        const orange = state.teams?.orange?.name || 'Orange';
        const bs = state.game?.blueScore   ?? state.game?.score?.blue   ?? 0;
        const os = state.game?.orangeScore ?? state.game?.score?.orange ?? 0;
        this.sendMessage(`${blue} ${bs} - ${os} ${orange}`);
        break;
      }
      case '!teams': {
        const blue   = state.teams?.blue?.name   || 'Blue';
        const orange = state.teams?.orange?.name || 'Orange';
        this.sendMessage(`${blue} vs ${orange}`);
        break;
      }
      case '!bracket': {
        if (state.chatCommands?.enabled === false) break;
        this.sendMessage(chatCommandReply('bracket'));
        break;
      }
      case '!discord': {
        if (state.chatCommands?.enabled === false) break;
        this.sendMessage(chatCommandReply('discord'));
        break;
      }
      case '!casters': {
        if (state.chatCommands?.enabled === false) break;
        this.sendMessage(chatCommandReply('casters'));
        break;
      }
    }
  }

  onFollow(username) {
    if (!this.autoGreetings.enabled) return;
    const msg = this.autoGreetings.followMessage.replace('{user}', username);
    this.sendMessage(msg);
  }

  onSubscribe(username, tier) {
    if (!this.autoGreetings.enabled) return;
    const tierName = tier === '1000' ? 'Tier 1' : tier === '2000' ? 'Tier 2' : 'Tier 3';
    const msg = this.autoGreetings.subscribeMessage.replace('{user}', username).replace('{tier}', tierName);
    this.sendMessage(msg);
  }

  onRaid(username, viewers) {
    if (!this.autoGreetings.enabled) return;
    const msg = this.autoGreetings.raidMessage.replace('{user}', username).replace('{viewers}', viewers);
    this.sendMessage(msg);
  }

  disconnect() {
    this._stopped = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ircSocket) {
      try { this.send(`PART #${this.channelName}`); } catch (e) {}
      this.ircSocket.destroy();
      this.ircSocket = null;
    }
    this.isConnected = false;
  }

  getStatus() {
    return { connected: this.isConnected, channel: this.channelName, autoGreetings: this.autoGreetings };
  }
}

const _chatLog = [];              // rolling multichat history (see handleChatMessage)
let _chatHighlightTimer = null;   // pending auto-hide for the featured chat message
const chatManager = new TwitchChatManager();

/**
 * Put a message on the chat lower third (overlay/chat-highlight.html), or take it down with
 * { visible:false }. Shared by set_chat_highlight (a chat row) and ask_question (the Q&A
 * queue) — the only difference on air is `kicker`, which replaces the "LIVE CHAT" label with
 * e.g. "QUESTION · INSTAGRAM". Caller broadcasts.
 */
function showChatHighlight(d) {
  if (_chatHighlightTimer) { clearTimeout(_chatHighlightTimer); _chatHighlightTimer = null; }
  if (d.visible === false) {
    state.chatHighlight = { ...state.chatHighlight, visible: false };
    return;
  }
  state.chatHighlight = {
    visible: true,
    platform: (d.platform || 'twitch').toString().slice(0, 20),
    user: (d.user || '').toString().slice(0, 60),
    color: /^#[0-9a-fA-F]{6}$/.test(d.color || '') ? d.color : '',
    text: (d.text || '').toString().slice(0, 400),
    kicker: (d.kicker || '').toString().slice(0, 40),   // '' = the overlay's own LIVE CHAT default
    ts: Date.now()
  };
  // Optional auto-hide; a newer highlight (different ts) cancels the pending one.
  const dur = Math.max(0, Math.min(300, Number(d.duration) || 0));
  if (dur > 0) {
    const shownTs = state.chatHighlight.ts;
    _chatHighlightTimer = setTimeout(() => {
      if (state.chatHighlight && state.chatHighlight.visible && state.chatHighlight.ts === shownTs) {
        state.chatHighlight = { ...state.chatHighlight, visible: false };
        broadcastFullState();
      }
    }, dur * 1000);
  }
}

/**
 * Keyword capture: any chat message that opens with the configured prefix ("!ask …") joins
 * the Q&A queue, tagged with the platform it came from. Called from all four chat pipelines
 * (Twitch IRC, YouTube, Kick, Discord); a no-op when the keyword is off or doesn't match.
 */
function captureQuestionFromChat(platform, user, text) {
  const s = state.questions && state.questions.settings;
  if (!s || !s.keywordEnabled) return;
  const body = questionStore.matchKeyword(text, s.keyword);
  if (!body) return;
  if (questionStore.addQuestion(state.questions.list, { source: platform, user, text: body, origin: 'keyword' })) {
    questionsChanged();
  }
}

// ─── EventSub Webhook Endpoints ──────────────────────────────────────────────
// Registered from inside startHttpServer() via registerTwitchEventSubRoutes(app) — the
// Express `app` only exists in that scope, so these can't be attached at module top-level.
function registerTwitchEventSubRoutes(app) {

// POST /api/twitch/eventsub/webhook - Receive EventSub events
app.post('/api/twitch/eventsub/webhook', (req, res) => {
  if (!eventSubService.verifyWebhookSignature(req)) {
    console.error('[EventSub] Invalid signature');
    return res.status(403).send('Forbidden');
  }

  const messageType = req.headers['twitch-eventsub-message-type'];
  const data = req.body;

  // Twitch requires the challenge echoed back as plain text with 200
  if (messageType === 'webhook_callback_verification') {
    console.log('[EventSub] Challenge received, responding');
    return res.status(200).type('text/plain').send(data.challenge);
  }

  // Acknowledge all other message types immediately
  res.status(204).send();

  if (messageType === 'notification_revocation') {
    console.warn('[EventSub] Subscription revoked:', data.subscription?.id, data.subscription?.status);
    return;
  }

  if (messageType === 'notification') {
    if (_eventSubSeen(req.headers['twitch-eventsub-message-id'])) return;   // at-least-once delivery
    try {
      eventSubService.handleEvent({
        type: data.subscription.type,
        data: data.event
      });
    } catch (err) {
      console.error('[EventSub] Event handling error:', err);
    }
  }
});

// POST /api/twitch/eventsub/subscribe - Register for events
app.post('/api/twitch/eventsub/subscribe', async (req, res) => {
  const { eventTypes, channelId } = req.body;

  if (!state.twitch.apiToken) {
    return res.status(400).json({ error: 'Not connected to Twitch' });
  }

  if (!channelId) {
    return res.status(400).json({ error: 'Channel ID required' });
  }

  try {
    let results = [];

    // EventSub now runs over a WebSocket session that's opened automatically on connect.
    // Make sure it's running so there's a session to attach subscriptions to.
    if (!eventSubService.sessionId) eventSubService.start();

    const V2_TYPES = new Set(['channel.follow', 'channel.hype_train.begin', 'channel.hype_train.progress', 'channel.hype_train.end']);
    if (eventTypes && Array.isArray(eventTypes)) {
      for (const eventType of eventTypes) {
        const version = V2_TYPES.has(eventType) ? '2' : '1';
        const sub = await eventSubService.subscribe(eventType, version, { broadcaster_user_id: channelId });
        results.push({ eventType, success: !!sub });
      }
    } else {
      results = await eventSubService.subscribeToAll(channelId);
    }

    res.json({ subscriptions: results, status: eventSubService.getStatus() });
  } catch (err) {
    console.error('[EventSub Subscribe]', err);
    res.status(500).json({ error: 'Subscription failed', details: err.message });
  }
});

// GET /api/twitch/eventsub/status - Get subscription status
app.get('/api/twitch/eventsub/status', (req, res) => {
  res.json(eventSubService.getStatus());
});

// GET /api/twitch/activity-log
app.get('/api/twitch/activity-log', (req, res) => {
  res.json({ log: (state.twitch && state.twitch.activityLog) || [] });
});

// POST /api/twitch/activity-log/clear
app.post('/api/twitch/activity-log/clear', (req, res) => {
  if (state.twitch) state.twitch.activityLog = [];
  broadcast(ctx.bridgeClients, { type: 'twitch_activity_log_cleared' });
  res.json({ ok: true });
});

// ─── Twitch Clips API ──────────────────────────────────────────────────────────
// GET /api/twitch/clips
app.get('/api/twitch/clips', async (req, res) => {
  if (!state.twitch || !state.twitch.channelId || !ctx.twitchClient) {
    return res.status(400).json({ error: 'Twitch not connected', clips: [], cursor: null });
  }
  try {
    // ?days=7 windows the pull to the last N days (Helix wants both ends of the range).
    const days = parseInt(req.query.days, 10);
    const win  = days > 0
      ? { startedAt: new Date(Date.now() - days * 86400000).toISOString(), endedAt: new Date().toISOString() }
      : {};
    const result = await ctx.twitchClient.getClips(state.twitch.channelId, {
      cursor: req.query.cursor,
      first:  req.query.first || 20,
      ...win
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, clips: [], cursor: null });
  }
});

// GET /api/twitch/games?ids=1,2,3 — resolve category ids to names for the clip auto-namer
app.get('/api/twitch/games', async (req, res) => {
  if (!ctx.twitchClient) return res.status(400).json({ error: 'Twitch not connected', games: {} });
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return res.json({ games: {} });
  try {
    res.json({ games: await ctx.twitchClient.getGamesByIds(ids) });
  } catch (e) {
    res.status(500).json({ error: e.message, games: {} });
  }
});

// ─── Social Publishing API ─────────────────────────────────────────────────────
const _socialGuard = (req, res) => {
  if (!ctx.socialPublisher) { res.status(503).json({ error: 'Social publisher not initialized yet' }); return false; }
  return true;
};

// Publishing pushes video onto the ORGANISATION's own channels, so the mutating half of this
// API is owner/admin-only — the same rule that reveals the sidebar tab. Read-only routes
// (connections, OAuth, schedule list) stay open: the YouTube token they mint is also what
// multichat and the Analytics page run on. Same fail-open convention as wsRoleAllows — no
// cloud session or a personal workspace means no org to answer to, so nothing is gated and a
// cloud outage can't lock the local-first app out of its own tools.
const _socialPublishGuard = (req, res) => {
  let s; try { s = cloud.getSession(); } catch (_) { return true; }
  if (!s || !s.authed) return true;
  if (!s.workspaceId || String(s.workspaceId).startsWith('user:')) return true;
  if (s.role === 'owner' || s.role === 'admin') return true;
  res.status(403).json({ error: 'Social publishing is restricted to organization owners and admins.' });
  return false;
};

// GET /api/social/connections — which platforms are connected/configured
app.get('/api/social/connections', (req, res) => {
  if (!_socialGuard(req, res)) return;
  res.json(ctx.socialPublisher.getConnections());
});

// GET /api/social/auth/youtube — start YouTube OAuth
app.get('/api/social/auth/youtube', (req, res) => {
  if (!_socialGuard(req, res)) return;
  try { res.json({ url: ctx.socialPublisher.getYouTubeAuthUrl() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/social/callback/youtube — YouTube OAuth callback
app.get('/api/social/callback/youtube', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(_oauthDonePage('YouTube', false, error));
  if (!code) return res.status(400).send('<h2>Missing code</h2>');
  try {
    await ctx.socialPublisher.handleYouTubeCallback(code);
    broadcast(ctx.bridgeClients, { type: 'social_connected', platform: 'youtube' });
    if (ctx.youtubeChat) ctx.youtubeChat.kick();   // start the multichat poller right away
    res.send(_oauthDonePage('YouTube', true));
  } catch (e) {
    res.send(_oauthDonePage('YouTube', false, e.message));
  }
});

// GET /api/social/auth/twitter — start Twitter/X OAuth
app.get('/api/social/auth/twitter', (req, res) => {
  if (!_socialGuard(req, res)) return;
  try {
    const { url, state: twState } = ctx.socialPublisher.getTwitterAuthUrl();
    res.json({ url });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/social/callback/twitter — Twitter OAuth callback
app.get('/api/social/callback/twitter', async (req, res) => {
  const { code, state: twState, error } = req.query;
  if (error) return res.send(_oauthDonePage('Twitter / X', false, error));
  if (!code) return res.status(400).send('<h2>Missing code</h2>');
  try {
    await ctx.socialPublisher.handleTwitterCallback(code, twState);
    broadcast(ctx.bridgeClients, { type: 'social_connected', platform: 'twitter' });
    res.send(_oauthDonePage('Twitter / X', true));
  } catch (e) {
    res.send(_oauthDonePage('Twitter / X', false, e.message));
  }
});

// POST /api/social/disconnect/:platform
app.post('/api/social/disconnect/:platform', (req, res) => {
  if (!_socialGuard(req, res)) return;
  ctx.socialPublisher.disconnect(req.params.platform);
  res.json({ ok: true });
});

// POST /api/social/clip/download — pull a Twitch clip down into the local clip library.
//
// This is NOT part of the removed Social page. It backs the quick rail's REPLAY ▸ Twitch ▸ Import
// button (control-panel/app.js, qrTwLoad), which is live and is the only caller. It was deleted as
// collateral damage when the Social feature came out, leaving that button failing on a 404 for
// every producer. The path stays as-is because it is what the panel already calls; the downloader
// itself lives on socialPublisher, which is retained for the YouTube/multichat OAuth.
app.post('/api/social/clip/download', async (req, res) => {
  if (!_socialGuard(req, res)) return;
  if (!_socialPublishGuard(req, res)) return;
  const { clipUrl, thumbnailUrl, title } = req.body || {};
  if (!clipUrl) return res.status(400).json({ error: 'clipUrl required' });
  try {
    const tmp = await ctx.socialPublisher.downloadTwitchClip(
      thumbnailUrl, clipUrl,
      state.twitch?.apiToken, TWITCH_CLIENT_ID
    );
    let clip = null;
    if (ctx.clipSystem) {
      clip = await ctx.clipSystem.manager.importReplayFile(tmp, { label: title || 'Twitch Clip', type: 'twitch-clip' });
      try { fs.unlinkSync(tmp); } catch {}
      syncClipsState();
      broadcastClipsUpdate();
    }
    res.json({ ok: true, clip });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function _oauthDonePage(platform, success, err) {
  const color = success ? '#48bb78' : '#ef4444';
  const msg   = success ? `${platform} connected successfully!` : `Error: ${err || 'Unknown error'}`;
  return `<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0d0d14;color:#fff">
    <div style="font-size:48px;margin-bottom:20px;">${success ? '✓' : '✗'}</div>
    <h2 style="color:${color};margin-bottom:12px;">${msg}</h2>
    <p style="color:rgba(255,255,255,0.5);">You can close this window and return to Broadcast Studio.</p>
    <script>setTimeout(()=>window.close(),2000)</script>
  </body></html>`;
}

// Set webhook URL for EventSub (using ngrok or public URL)
const EVENTSUB_WEBHOOK_URL = process.env.EVENTSUB_WEBHOOK_URL || 'http://localhost:3000/api/twitch/eventsub/webhook';
// Use a persisted secret so HMAC verification survives restarts.
// Priority: env var → saved twitch-data.json → generate-and-persist.
let EVENTSUB_WEBHOOK_SECRET = process.env.EVENTSUB_WEBHOOK_SECRET || state.twitch.webhookSecret;
if (!EVENTSUB_WEBHOOK_SECRET) {
  EVENTSUB_WEBHOOK_SECRET = 'broadcast-studio-secret-' + Math.random().toString(36).substring(7);
  state.twitch.webhookSecret = EVENTSUB_WEBHOOK_SECRET;
  saveTwitchData();
}
eventSubService.setWebhookConfig(EVENTSUB_WEBHOOK_URL, EVENTSUB_WEBHOOK_SECRET);

// ─── Stream State API Endpoints ──────────────────────────────────────────────

// GET /api/twitch/stream/state - Get current stream state (viewer count, live status, title, game)
// GET /twitch-embed?channel= — proxy page served at localhost so the Twitch player parent param is valid
// (Control panel loads as file:// so direct player.twitch.tv embeds are rejected by Twitch)
app.get('/twitch-embed', (req, res) => {
  const channel = (req.query.channel || '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
  if (!channel) return res.status(400).send('Missing channel');
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;overflow:hidden;}html,body,iframe{width:100%;height:100%;border:0;background:#0e0e10;}</style></head><body><iframe src="https://player.twitch.tv/?channel=${channel}&parent=localhost&muted=true&autoplay=false" allowfullscreen></iframe></body></html>`);
});

app.get('/api/twitch/stream/state', (req, res) => {
  res.json(streamStateManager.getState());
});

// GET /api/twitch/stream/viewers - Get just viewer count
app.get('/api/twitch/stream/viewers', (req, res) => {
  res.json({
    viewers: streamStateManager.streamState.viewerCount,
    isLive: streamStateManager.streamState.isLive,
    title: streamStateManager.streamState.title,
    game: streamStateManager.streamState.game
  });
});

// GET /api/twitch/ads/countdown - Get seconds until next ad
app.get('/api/twitch/ads/countdown', (req, res) => {
  const countdown = streamStateManager.getAdCountdown();
  res.json({
    secondsUntilAd: countdown,
    nextAdAt: streamStateManager.adSchedule.nextAdAt,
    lastAdAt: streamStateManager.adSchedule.lastAdAt,
    adDuration: streamStateManager.adSchedule.adDuration
  });
});

// GET /api/twitch/test - Validate token; auto-refresh if expired
app.get('/api/twitch/test', async (req, res) => {
  if (!state.twitch.apiToken) return res.json({ ok: false, error: 'No token stored — please connect first' });

  const validate = async (token) => {
    const r = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${token}` }
    });
    return r.data;
  };

  try {
    let d;
    try {
      d = await validate(state.twitch.apiToken);
    } catch (e) {
      if (e.response?.status === 401 && state.twitch.refreshToken) {
        const newToken = await refreshTwitchToken();
        d = await validate(newToken);
      } else throw e;
    }
    const expiresHours = d.expires_in ? Math.round(d.expires_in / 3600) : '?';
    res.json({ ok: true, displayName: d.login, scopes: d.scopes, expiresIn: `${expiresHours}h` });
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    if (status === 401) {
      res.json({ ok: false, error: `Token expired — reconnect to generate a new one (${msg})` });
    } else {
      res.json({ ok: false, error: `Twitch API error ${status || ''}: ${msg}` });
    }
  }
});

// ─── Dual Clip Endpoint (OBS replay buffer + Twitch clip) ────────────────────

app.post('/api/twitch/clip', async (req, res) => {
  const result = { obs: false, twitch: false, clipId: null, editUrl: null, errors: [] };

  // OBS replay — through the SAME capture path as Replays > Capture, so the saved file is imported
  // into the clip library (Replays page, To Air, montages). This used to call SaveReplayBuffer
  // directly: OBS wrote the file to its own folder, the button said "OBS ✓", and the clip never
  // appeared anywhere in the app — which reads as "it didn't clip".
  if (switcherIsVmix()) {
    const r = state.vmix.connected ? await vmixMarkReplay() : { ok: false, reason: 'not reachable' };
    result.obs = !!r.ok;
    if (!r.ok) result.errors.push('vMix: ' + r.reason);
  } else if (ctx.obsClient && ctx.obsClient.isConnected()) {
    try {
      if (ctx.clipSystem) {
        const clip = await triggerClipCapture({ type: 'manual', game: state.activeGame, label: 'Clip', reason: 'Bottom bar clip', force: true });
        result.obs = !!(clip && clip.path);
        if (result.obs) result.obsClipId = clip.id;   // clipId is the Twitch clip id below
        else result.errors.push('OBS: ' + ((ctx.clipSystem.getLastError && ctx.clipSystem.getLastError()) || replayBufferErrorMessage('save failed')));
      } else {
        const active = await ctx.obsClient.isReplayBufferActive();
        if (!active) {
          await ctx.obsClient.startReplayBuffer();
          await new Promise(r => setTimeout(r, 800)); // brief settle before saving
        }
        const ok = await ctx.obsClient.saveReplayBuffer();
        result.obs = !!ok;
        if (!ok) result.errors.push('OBS: ' + replayBufferErrorMessage('save failed'));
      }
    } catch (e) {
      result.errors.push('OBS: ' + e.message);
    }
  } else {
    result.errors.push('OBS: not connected');
  }

  // Twitch clip (channel must be live — API returns 422 if offline)
  if (ctx.twitchClient && state.twitch.connected && state.twitch.channelId) {
    try {
      const clip = await ctx.twitchClient.createClip(state.twitch.channelId);
      if (clip) {
        result.twitch = true;
        result.clipId = clip.id;
        result.editUrl = clip.edit_url || null;
        console.log(`[Clip] Twitch clip created: ${clip.id}`);
      } else {
        result.errors.push('Twitch: empty response');
      }
    } catch (e) {
      const msg = e.response?.data?.message || e.message;
      const status = e.response?.status;
      if (status === 404 || status === 422) {
        result.errors.push('Twitch: channel must be live to create clips');
      } else {
        result.errors.push('Twitch: ' + msg);
      }
      console.error('[Clip] Twitch clip failed:', msg);
    }
  } else {
    result.errors.push('Twitch: not connected');
  }

  res.json(result);
});

// ─── Chat Management API Endpoints ──────────────────────────────────────────

// GET /api/twitch/chat/status - Get chat connection status
app.get('/api/twitch/chat/status', (req, res) => {
  res.json(chatManager.getStatus());
});

// POST /api/twitch/chat/send - Send a message to chat
app.post('/api/twitch/chat/send', (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }
  if (!chatManager.isConnected) {
    return res.status(400).json({ error: 'Chat not connected' });
  }

  try {
    chatManager.sendMessage(message);
    res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/twitch/chat/automations - Update auto-greetings settings
app.post('/api/twitch/chat/automations', (req, res) => {
  const { enabled, followMessage, subscribeMessage, raidMessage } = req.body;

  if (typeof enabled === 'boolean') chatManager.autoGreetings.enabled = enabled;
  if (followMessage) chatManager.autoGreetings.followMessage = followMessage;
  if (subscribeMessage) chatManager.autoGreetings.subscribeMessage = subscribeMessage;
  if (raidMessage) chatManager.autoGreetings.raidMessage = raidMessage;

  res.json({ success: true, automations: chatManager.autoGreetings });
});

// POST /api/twitch/marker — drop a stream marker in the VOD
app.post('/api/twitch/marker', async (req, res) => {
  if (!ctx.twitchClient || !state.twitch.channelId) {
    return res.status(503).json({ error: 'Twitch not connected' });
  }
  try {
    const { description } = req.body;
    const result = await ctx.twitchClient.createStreamMarker(
      state.twitch.channelId,
      description || 'BroadcastStudio marker'
    );
    res.json({ ok: true, marker: result });
  } catch (err) {
    console.error('[Twitch] Marker error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

} // ── end registerTwitchEventSubRoutes ──

  return { eventSubService, streamStateManager, _chatLog, chatManager, showChatHighlight, captureQuestionFromChat, registerTwitchEventSubRoutes };
};
