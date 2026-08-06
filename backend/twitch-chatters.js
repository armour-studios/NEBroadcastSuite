/* ─── Twitch live chatter list (read-through Helix) ─────────────────────────────
 * Powers Marble Race's "auto-enter every viewer" option — pulls everyone currently
 * sitting in Twitch chat via GET /helix/chat/chatters. Mirrors twitch-stats.js's
 * fetch-and-flag-ok idiom (each call degrades gracefully on a missing scope/expired
 * token rather than throwing). Requires the moderator:read:chatters scope, already
 * requested by this app's existing Twitch OAuth consent (control-panel/app.js
 * TWITCH_SCOPES) — no re-authentication needed. The connected account authenticates
 * as the broadcaster, who is inherently their own moderator, so moderator_id ==
 * broadcaster_id here.
 *
 * Twitch caps a single page at 1000 chatters (`first`); Marble Race's own
 * participant cap (well under that) means a second page is never worth fetching.
 */
const axios = require('axios');
const BASE = 'https://api.twitch.tv/helix';

async function fetchTwitchChatters({ clientId, accessToken, broadcasterId }) {
  if (!clientId || !accessToken || !broadcasterId) return { ok: false, error: 'Missing Twitch credentials' };
  const headers = { 'Client-Id': clientId, 'Authorization': 'Bearer ' + accessToken };
  try {
    const r = await axios.get(BASE + '/chat/chatters', {
      headers,
      params: { broadcaster_id: broadcasterId, moderator_id: broadcasterId, first: 1000 },
      timeout: 12000,
      validateStatus: () => true
    });
    if (r.status !== 200) {
      return { ok: false, status: r.status, error: (r.data && r.data.message) || ('HTTP ' + r.status) };
    }
    const chatters = (r.data.data || []).map((c) => ({ userId: c.user_id, username: c.user_login || c.user_name }));
    return { ok: true, chatters };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchTwitchChatters };
