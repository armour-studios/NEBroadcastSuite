const axios = require('axios');

const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

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
      console.error('[Twitch] createPrediction error:', err.message);
      return null;
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
      console.error('[Twitch] resolvePrediction error:', err.message);
      return null;
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

  async cancelPrediction(broadcasterId, predictionId) {
    try {
      const res = await axios.patch(
        `${TWITCH_API_BASE}/predictions`,
        { broadcaster_id: broadcasterId, id: predictionId, status: 'CANCELLED' },
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] cancelPrediction error:', err.message);
      return null;
    }
  }

  updateToken(newAccessToken) {
    this.accessToken = newAccessToken;
    this.headers['Authorization'] = `Bearer ${newAccessToken}`;
  }

  async giveChannelPoints(broadcasterId, userId, amount) {
    try {
      const res = await axios.post(
        `${TWITCH_API_BASE}/channel_points/custom_rewards/redemptions`,
        {
          broadcaster_id: broadcasterId,
          user_id: userId,
          reward_id: 'builtin-points',
          amount
        },
        { headers: this.headers }
      );
      return true;
    } catch (err) {
      console.error('[Twitch] giveChannelPoints error:', err.message);
      return false;
    }
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
