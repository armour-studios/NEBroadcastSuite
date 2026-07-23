'use strict';

/* YouTube Live Chat poller — the second multichat source (Twitch IRC is the first).
 *
 * Rides the Settings ▸ Social YouTube OAuth connection (SocialPublisher tokens with
 * youtube.readonly). The YouTube chat API is poll-based: find the channel's ACTIVE
 * live broadcast, grab its liveChatId, then page liveChatMessages on the interval
 * the API asks for (floored — see QUOTA below).
 *
 * QUOTA: liveChatMessages.list costs ~5 units per call against the default 10k/day
 * project quota. Polling every 5s would burn it in a few hours of show, so we floor
 * the interval at MIN_POLL_MS (8s). Messages arrive in small batches — fine for a
 * click-to-feature feed, not a scrolling wall.
 *
 * createYouTubeChat({ getAuthClient, google, onMessage, onStatus })
 *   getAuthClient() -> Promise<OAuth2|null>  (null = not connected; poller idles)
 *   onMessage({ platform:'youtube', user, text, color, ts })
 *   onStatus(connected:boolean, detail:string)
 */

const MIN_POLL_MS = 8000;          // quota floor (see above)
const FIND_LIVE_MS = 60 * 1000;    // how often to look for a live broadcast while idle
const NO_AUTH_MS = 5 * 60 * 1000;  // re-check for a connected account this often

// Stable pseudo-color per author (YouTube has no chat colors like Twitch IRC).
function nameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 62%, 62%)`;
}

function createYouTubeChat({ getAuthClient, google, onMessage, onStatus }) {
  let running = false;
  let timer = null;
  let liveChatId = null;
  let pageToken = null;
  let seeded = false;       // first page is history — seed it, then only stream new items
  let connected = false;

  const status = (c, detail) => {
    if (c !== connected) { connected = c; try { onStatus(c, detail || ''); } catch (_) {} }
  };
  const schedule = (ms) => { if (running) timer = setTimeout(tick, ms); };

  async function findLiveChat(auth) {
    const yt = google.youtube({ version: 'v3', auth });
    const res = await yt.liveBroadcasts.list({
      part: ['snippet'], broadcastStatus: 'active', broadcastType: 'all', maxResults: 1
    });
    const item = (res.data.items || [])[0];
    return (item && item.snippet && item.snippet.liveChatId) || null;
  }

  async function tick() {
    timer = null;
    if (!running || !google) return;
    let auth;
    try { auth = await getAuthClient(); } catch (_) { auth = null; }
    if (!auth) { status(false, 'YouTube not connected'); liveChatId = null; return schedule(NO_AUTH_MS); }

    try {
      if (!liveChatId) {
        liveChatId = await findLiveChat(auth);
        pageToken = null;
        seeded = false;
        if (!liveChatId) { status(false, 'no active live broadcast'); return schedule(FIND_LIVE_MS); }
      }

      const yt = google.youtube({ version: 'v3', auth });
      const res = await yt.liveChatMessages.list({
        liveChatId, part: ['snippet', 'authorDetails'], maxResults: 200,
        ...(pageToken ? { pageToken } : {})
      });
      status(true, 'live');

      const items = res.data.items || [];
      // First page is chat HISTORY — emit it so the feed backfills, same as Twitch's log.
      const emit = seeded ? items : items.slice(-25);
      for (const it of emit) {
        const sn = it.snippet || {};
        if (sn.type && sn.type !== 'textMessageEvent' && sn.type !== 'superChatEvent') continue;
        const user = (it.authorDetails && it.authorDetails.displayName) || 'YouTube user';
        const text = (sn.displayMessage || '').trim();
        if (!text) continue;
        try { onMessage({ platform: 'youtube', user, text, color: nameColor(user), ts: Date.now() }); } catch (_) {}
      }
      seeded = true;
      pageToken = res.data.nextPageToken || pageToken;

      // Chat ended (offlineAt) or stream over → go back to looking for a broadcast.
      if (res.data.offlineAt) { liveChatId = null; return schedule(FIND_LIVE_MS); }
      schedule(Math.max(MIN_POLL_MS, Number(res.data.pollingIntervalMillis) || 0));
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // 403 forbidden/ended chat or 404 → broadcast gone; quota → back off hard.
      liveChatId = null;
      const quota = /quota/i.test(msg);
      status(false, quota ? 'YouTube API quota exceeded' : msg);
      console.warn('[yt-chat]', msg);
      schedule(quota ? 30 * 60 * 1000 : FIND_LIVE_MS);
    }
  }

  return {
    start() { if (running || !google) return; running = true; tick(); },
    stop() { running = false; if (timer) { clearTimeout(timer); timer = null; } liveChatId = null; status(false, 'stopped'); },
    /** Retry immediately (e.g. right after the producer connects YouTube). */
    kick() { if (!running) return this.start(); if (timer) { clearTimeout(timer); timer = null; } liveChatId = null; tick(); },
    get connected() { return connected; }
  };
}

module.exports = { createYouTubeChat };
