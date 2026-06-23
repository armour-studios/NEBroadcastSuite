const crypto = require('crypto');

// Webhook signature validation (Twitch requirement)
function verifyWebhookSignature(req, webhookSecret) {
  const headers = req.headers;
  const messageId = headers['twitch-eventsub-message-id'];
  const timestamp = headers['twitch-eventsub-message-timestamp'];
  const signature = headers['twitch-eventsub-message-signature'];

  if (!messageId || !timestamp || !signature) {
    return false;
  }

  // Reject if timestamp > 10 minutes old
  const messageTime = Math.floor(new Date(timestamp).getTime() / 1000);
  const currentTime = Math.floor(Date.now() / 1000);
  if (currentTime - messageTime > 600) {
    return false;
  }

  // Use raw body bytes so HMAC matches exactly what Twitch signed
  const rawBody = req.rawBody || JSON.stringify(req.body);
  const hmacMessage = messageId + timestamp + rawBody;
  const computedSignature = 'sha256=' + crypto
    .createHmac('sha256', webhookSecret)
    .update(hmacMessage)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(computedSignature)
    );
  } catch (_) {
    return false;
  }
}

// Register webhook handlers
function registerTwitchWebhooks(app, state, broadcast, wheelManager, miniGameManager, chatParser) {
  // Handle all Twitch webhook events
  app.post('/api/twitch/webhooks/*', (req, res) => {
    if (!verifyWebhookSignature(req, state.twitch.webhookSecret)) {
      console.warn('[Twitch] Invalid webhook signature');
      return res.status(403).send('Forbidden');
    }

    const messageType = req.headers['twitch-eventsub-message-type'];
    const { subscription, event } = req.body;

    // Twitch requires the challenge echoed back as plain text with 200
    if (messageType === 'webhook_callback_verification') {
      console.log('[Twitch] Challenge received, responding');
      return res.status(200).type('text/plain').send(req.body.challenge);
    }

    // Acknowledge all other messages immediately
    res.status(204).send();

    if (messageType !== 'notification') return;

    // Handle the actual event asynchronously
    handleTwitchEvent(subscription.type, event, state, broadcast, wheelManager, miniGameManager, chatParser);
  });

  console.log('[Twitch] Webhooks registered');
}

function handleTwitchEvent(eventType, event, state, broadcast, wheelManager, miniGameManager, chatParser) {
  console.log(`[Twitch] Event: ${eventType}`);

  switch (eventType) {
    case 'channel.prediction.begin':
      state.twitch.predictions.current = {
        id: event.id,
        title: event.title,
        outcomes: event.outcomes.map(o => ({
          id: o.id,
          title: o.title,
          votes: 0,
          totalPoints: 0
        })),
        state: 'active',
        createdAt: event.created_at,
        endsAt: event.locks_at
      };
      console.log('[Twitch] Prediction started:', event.title);
      broadcast('full_state', state);
      break;

    case 'channel.prediction.progress':
      if (state.twitch.predictions.current?.id === event.id) {
        state.twitch.predictions.current.outcomes = event.outcomes.map(o => ({
          id: o.id,
          title: o.title,
          votes: o.channel_points || 0,
          users: o.users || 0
        }));
        broadcast('full_state', state);
      }
      break;

    case 'channel.prediction.end': {
      const ending = state.twitch.predictions.current;
      if (ending) {
        const resolved = {
          ...ending,
          state: event.status === 'RESOLVED' ? 'RESOLVED' : 'CANCELLED',
          winningOutcomeId: event.winning_outcome_id || null,
          outcomes: (event.outcomes || ending.outcomes || []).map(o => ({
            id: o.id,
            title: o.title,
            votes: o.channel_points || 0,
            users: o.users || 0
          }))
        };
        state.twitch.predictions.current = resolved;
        console.log('[Twitch] Prediction ended, status:', resolved.state);
        broadcast('full_state', state);
        // Keep the resolved card visible for 18s so the overlay can show the winner splash
        setTimeout(() => {
          if (state.twitch.predictions.current?.id === ending.id) {
            state.twitch.predictions.history.unshift(state.twitch.predictions.current);
            if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
            state.twitch.predictions.current = null;
            broadcast('full_state', state);
          }
        }, 18000);
      }
      break;
    }

    case 'channel.follow':
      console.log('[Twitch] Follow:', event.user_login);
      broadcast('twitch_follow', { user: event.user_name || event.user_login, timestamp: event.followed_at });
      if (wheelManager) { wheelManager.addParticipant(event.user_id, event.user_login, 'follow', 1); broadcast('full_state', state); }
      break;

    case 'channel.subscribe':
      console.log('[Twitch] Subscribe:', event.user_login);
      broadcast('twitch_subscribe', { user: event.user_name || event.user_login, tier: event.tier });
      if (wheelManager) { wheelManager.addParticipant(event.user_id, event.user_login, 'sub', 2); broadcast('full_state', state); }
      break;

    case 'channel.raid':
      console.log('[Twitch] Raid from:', event.from_broadcaster_user_login);
      broadcast('twitch_raid', { from: event.from_broadcaster_user_login, viewers: event.viewers });
      break;

    case 'channel.channel_points_custom_reward_redemption.add':
      broadcast('twitch_channel_points', { user: event.user_name || event.user_login, reward: event.reward?.title });
      break;

    case 'channel.hype_train.begin':
      broadcast('twitch_hype_train_begin', event);
      break;

    case 'channel.hype_train.progress':
      broadcast('twitch_hype_train_progress', { level: event.level });
      break;

    case 'channel.hype_train.end':
      broadcast('twitch_hype_train_end', { level: event.level });
      break;

    case 'channel.chat.message':
      if (chatParser && miniGameManager?.currentGame) {
        const userId = event.chatter_user_id;
        const username = event.chatter_user_login;
        const message = event.message?.text || '';

        const added = chatParser.parseMessage(userId, username, message);
        if (added) {
          console.log(`[Twitch Chat] ${username}: parsed for game response`);
          broadcast('full_state', state);
        }
      }
      break;

    default:
      console.log(`[Twitch] Unhandled event type: ${eventType}`);
  }
}

module.exports = { registerTwitchWebhooks, verifyWebhookSignature };
