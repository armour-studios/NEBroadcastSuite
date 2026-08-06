const axios = require('axios');

const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

// Build an error carrying Twitch's OWN explanation (missing scope, channel not eligible,
// bad title length…). The old catch-log-return-null pattern reduced every failure to a
// generic "Failed to create prediction on Twitch API" with the real cause only in stdout.
function twitchApiError(err, what) {
  const res = err.response;
  const d = res && res.data;
  const detail = (d && (d.message || d.error)) ? `${d.message || d.error} (HTTP ${res.status})` : err.message;
  const e = new Error(`${what} failed: ${detail}`);
  if (res && res.status) e.status = res.status;   // server's explainTwitchApiError keys off this (401 reconnect / 403 affiliate / 429)
  return e;
}

class TwitchClient {
  constructor(clientId, clientSecret, accessToken) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.headers = {
      'Client-ID': clientId,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  async getUser(userId) {
    try {
      const res = await axios.get(`${TWITCH_API_BASE}/users?id=${userId}`, {
        headers: this.headers
      });
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] getUser error:', err.message);
      return null;
    }
  }

  async getChannelInfo(broadcasterId) {
    try {
      const res = await axios.get(
        `${TWITCH_API_BASE}/channels?broadcaster_id=${broadcasterId}`,
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] getChannelInfo error:', err.message);
      return null;
    }
  }

  async createPrediction(broadcasterId, title, outcomes, duration) {
    try {
      const res = await axios.post(
        `${TWITCH_API_BASE}/predictions`,
        {
          broadcaster_id: broadcasterId,
          title,
          outcomes: outcomes.map(o => ({
            title: typeof o === 'string' ? o : o.title
          })),
          prediction_window: duration
        },
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] createPrediction error:', err.response?.data?.message || err.message);
      throw twitchApiError(err, 'Create prediction');
    }
  }

  async resolvePrediction(broadcasterId, predictionId, outcomeId) {
    try {
      const res = await axios.patch(
        `${TWITCH_API_BASE}/predictions`,
        {
          broadcaster_id: broadcasterId,
          id: predictionId,
          status: 'RESOLVED',
          winning_outcome_id: outcomeId
        },
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] resolvePrediction error:', err.response?.data?.message || err.message);
      throw twitchApiError(err, 'Resolve prediction');
    }
  }

  async createClip(broadcasterId) {
    const res = await axios.post(
      `${TWITCH_API_BASE}/clips`,
      null,
      { params: { broadcaster_id: broadcasterId, has_delay: false }, headers: this.headers }
    );
    return res.data.data?.[0] || null;
  }

  // startedAt/endedAt are RFC3339 strings — Helix requires BOTH ends of the window (given only
  // started_at it returns the following week, which is not what "last 7 days" means to anyone).
  async getClips(broadcasterId, { cursor, first = 100, startedAt, endedAt } = {}) {
    try {
      const params = { broadcaster_id: broadcasterId, first: Math.min(Number(first) || 100, 100) };
      if (cursor) params.after = cursor;
      if (startedAt) {
        params.started_at = startedAt;
        params.ended_at   = endedAt || new Date().toISOString();
      }
      const res = await axios.get(`${TWITCH_API_BASE}/clips`, { params, headers: this.headers });
      const clips = (res.data.data || []).map(clip => ({
        ...clip,
        // Derive MP4 download URL from thumbnail URL
        _videoUrl: (clip.thumbnail_url || '').replace(/-preview-\d+x\d+\.jpg$/, '.mp4')
      }));
      return { clips, cursor: res.data.pagination?.cursor || null };
    } catch (err) {
      console.error('[Twitch] getClips error:', err.message);
      return { clips: [], cursor: null };
    }
  }

  // Resolve Twitch category ids → names. Clips carry only game_id, but the auto-namer wants the
  // readable category ("Rocket League") for the {game} token. Helix takes up to 100 ids per call.
  async getGamesByIds(ids = []) {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    const out = {};
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      try {
        const params = new URLSearchParams();
        batch.forEach(id => params.append('id', id));
        const res = await axios.get(`${TWITCH_API_BASE}/games?${params.toString()}`, { headers: this.headers });
        (res.data.data || []).forEach(g => { out[g.id] = g.name; });
      } catch (err) {
        console.error('[Twitch] getGamesByIds error:', err.message);
      }
    }
    return out;
  }

  async getPrediction(broadcasterId, predictionId) {
    try {
      const res = await axios.get(`${TWITCH_API_BASE}/predictions`, {
        params: { broadcaster_id: broadcasterId, id: predictionId },
        headers: this.headers
      });
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] getPrediction error:', err.message);
      return null;
    }
  }

  // Latest predictions on the channel, newest first — lets the app ADOPT a prediction it
  // didn't create (Twitch dashboard, another tool) so resolve/lock/cancel still work on it.
  async getLatestPredictions(broadcasterId, first = 5) {
    try {
      const res = await axios.get(`${TWITCH_API_BASE}/predictions`, {
        params: { broadcaster_id: broadcasterId, first },
        headers: this.headers
      });
      return res.data.data || [];
    } catch (err) {
      console.error('[Twitch] getLatestPredictions error:', err.response?.data?.message || err.message);
      return [];
    }
  }

  async lockPrediction(broadcasterId, predictionId) {
    try {
      const res = await axios.patch(
        `${TWITCH_API_BASE}/predictions`,
        { broadcaster_id: broadcasterId, id: predictionId, status: 'LOCKED' },
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] lockPrediction error:', err.response?.data?.message || err.message);
      throw twitchApiError(err, 'Lock prediction');
    }
  }

  async cancelPrediction(broadcasterId, predictionId) {
    try {
      const res = await axios.patch(
        `${TWITCH_API_BASE}/predictions`,
        { broadcaster_id: broadcasterId, id: predictionId, status: 'CANCELLED' },
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] cancelPrediction error:', err.response?.data?.message || err.message);
      throw twitchApiError(err, 'Cancel prediction');
    }
  }

  updateToken(newAccessToken) {
    this.accessToken = newAccessToken;
    this.headers['Authorization'] = `Bearer ${newAccessToken}`;
  }

  async giveChannelPoints(_broadcasterId, _userId, _amount) {
    // Twitch API does not support granting channel points programmatically.
    // The /channel_points/custom_rewards/redemptions endpoint only fulfills/cancels
    // existing user-initiated redemptions — it cannot create arbitrary point grants.
    console.warn('[Twitch] giveChannelPoints: not supported by Twitch API — no-op');
    return false;
  }

  async updateChannel(broadcasterId, { title, gameId } = {}) {
    const body = {};
    if (title !== undefined) body.title = title;
    if (gameId !== undefined) body.game_id = gameId;
    const res = await axios.patch(
      `${TWITCH_API_BASE}/channels?broadcaster_id=${broadcasterId}`,
      body,
      { headers: this.headers }
    );
    return res.data;
  }

  async searchGames(query) {
    // Try exact match first via /games?name=
    try {
      const exact = await axios.get(`${TWITCH_API_BASE}/games`, {
        params: { name: query },
        headers: this.headers
      });
      if (exact.data.data && exact.data.data.length > 0) return exact.data.data;
    } catch (err) {
      // fall through to fuzzy search
    }
    // Fuzzy search via /search/categories
    const res = await axios.get(`${TWITCH_API_BASE}/search/categories`, {
      params: { query },
      headers: this.headers
    });
    return (res.data.data || []).map(g => ({
      id: g.id,
      name: g.name,
      box_art_url: g.box_art_url
    }));
  }

  async postAnnouncement(broadcasterId, moderatorId, message, color = 'PRIMARY') {
    const res = await axios.post(
      `${TWITCH_API_BASE}/chat/announcements`,
      { message, color },
      {
        params: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
        headers: this.headers
      }
    );
    return res.data;
  }

  async sendShoutout(fromId, toId, moderatorId) {
    const res = await axios.post(
      `${TWITCH_API_BASE}/chat/shoutouts`,
      null,
      {
        params: { from_broadcaster_id: fromId, to_broadcaster_id: toId, moderator_id: moderatorId },
        headers: this.headers
      }
    );
    return res.data;
  }

  async startRaid(fromId, toId) {
    const res = await axios.post(
      `${TWITCH_API_BASE}/raids`,
      null,
      {
        params: { from_broadcaster_id: fromId, to_broadcaster_id: toId },
        headers: this.headers
      }
    );
    return res.data.data?.[0] || res.data;
  }

  async cancelRaid(broadcasterId) {
    const res = await axios.delete(`${TWITCH_API_BASE}/raids`, {
      params: { broadcaster_id: broadcasterId },
      headers: this.headers
    });
    return res.data;
  }

  async getChatSettings(broadcasterId, moderatorId) {
    const res = await axios.get(
      `${TWITCH_API_BASE}/chat/settings`,
      {
        params: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
        headers: this.headers
      }
    );
    return res.data.data?.[0] || res.data;
  }

  async updateChatSettings(broadcasterId, moderatorId, settings = {}) {
    const body = {};
    if (typeof settings.slow_mode === 'boolean')           body.slow_mode = settings.slow_mode;
    if (typeof settings.slow_mode_wait_time === 'number')  body.slow_mode_wait_time = settings.slow_mode_wait_time;
    if (typeof settings.subscriber_mode === 'boolean')     body.subscriber_mode = settings.subscriber_mode;
    if (typeof settings.emote_mode === 'boolean')          body.emote_mode = settings.emote_mode;
    if (typeof settings.follower_mode === 'boolean')       body.follower_mode = settings.follower_mode;
    if (typeof settings.follower_mode_duration === 'number') body.follower_mode_duration = settings.follower_mode_duration;
    if (typeof settings.unique_chat_mode === 'boolean')    body.unique_chat_mode = settings.unique_chat_mode;
    const res = await axios.patch(
      `${TWITCH_API_BASE}/chat/settings`,
      body,
      {
        params: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
        headers: this.headers
      }
    );
    return res.data.data?.[0] || res.data;
  }

  async getShieldMode(broadcasterId, moderatorId) {
    const res = await axios.get(`${TWITCH_API_BASE}/moderation/shield_mode`, {
      params: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
      headers: this.headers
    });
    return res.data.data?.[0] || res.data;
  }

  async setShieldMode(broadcasterId, moderatorId, active) {
    const res = await axios.put(
      `${TWITCH_API_BASE}/moderation/shield_mode`,
      { is_active: !!active },
      {
        params: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
        headers: this.headers
      }
    );
    return res.data.data?.[0] || res.data;
  }

  async snoozeNextAd(broadcasterId) {
    const res = await axios.post(
      `${TWITCH_API_BASE}/channels/ads/schedule/snooze`,
      null,
      {
        params: { broadcaster_id: broadcasterId },
        headers: this.headers
      }
    );
    return res.data.data?.[0] || res.data;
  }

  // Run a Twitch ad break (commercial). length in seconds: 30/60/90/120/150/180.
  async runCommercial(broadcasterId, length = 30) {
    const res = await axios.post(
      `${TWITCH_API_BASE}/channels/commercial`,
      { broadcaster_id: broadcasterId, length: Number(length) || 30 },
      { headers: this.headers }
    );
    return res.data.data?.[0] || res.data;
  }

  async getStreamInfo(broadcasterId) {
    const res = await axios.get(`${TWITCH_API_BASE}/streams`, {
      params: { user_id: broadcasterId },
      headers: this.headers
    });
    const stream = res.data.data?.[0];
    if (!stream) return { title: '', gameName: '', viewerCount: 0, live: false };
    return {
      title: stream.title,
      gameName: stream.game_name,
      viewerCount: stream.viewer_count,
      live: stream.type === 'live'
    };
  }

  async getUserByLogin(login) {
    const res = await axios.get(`${TWITCH_API_BASE}/users`, {
      params: { login },
      headers: this.headers
    });
    return res.data.data?.[0] || null;
  }

  async createStreamMarker(broadcasterId, description) {
    try {
      const res = await axios.post(
        `${TWITCH_API_BASE}/streams/markers`,
        { user_id: broadcasterId, description: description || 'BroadcastStudio' },
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] createStreamMarker error:', err.message);
      return null;
    }
  }

  async createPoll(broadcasterId, title, choices, durationSeconds) {
    const res = await axios.post(
      `${TWITCH_API_BASE}/polls`,
      {
        broadcaster_id: broadcasterId,
        title,
        choices: choices.map(c => ({ title: typeof c === 'string' ? c : c.title })),
        duration: durationSeconds
      },
      { headers: this.headers }
    );
    return res.data.data?.[0] || null;
  }
}

module.exports = { TwitchClient };
