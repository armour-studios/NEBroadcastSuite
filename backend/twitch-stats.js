/* ─── Twitch channel stats (read-through Helix) ────────────────────────────────
 *
 * Pulls channel-level + historical stats the broadcaster token can see: follower
 * total, subscriber total + sub points, bits leaderboard, past broadcasts (VOD
 * view counts + durations) and top clips. Each section is fetched independently
 * and flagged ok/false, so a missing scope or an offline channel degrades that
 * one card instead of failing the whole report. No persistence — Twitch is the
 * source of truth; the endpoint caches briefly.
 */
const axios = require('axios');
const BASE = 'https://api.twitch.tv/helix';

// Twitch durations look like "1h2m3s" / "21m4s" / "45s".
function parseDuration(s) {
  if (!s) return 0;
  let t = 0, m; const re = /(\d+)h|(\d+)m|(\d+)s/g;
  while ((m = re.exec(s))) { if (m[1]) t += +m[1] * 3600; else if (m[2]) t += +m[2] * 60; else if (m[3]) t += +m[3]; }
  return t;
}

async function fetchTwitchStats({ clientId, accessToken, userId }) {
  if (!clientId || !accessToken || !userId) throw new Error('Missing Twitch credentials');
  const headers = { 'Client-Id': clientId, 'Authorization': 'Bearer ' + accessToken };
  const g = (path) => axios.get(BASE + path, { headers, timeout: 12000, validateStatus: () => true });
  const out = { fetchedAt: Date.now(), userId };
  const errMsg = (r) => (r && r.data && r.data.message) || ('HTTP ' + (r && r.status));

  try { const r = await g('/channels/followers?broadcaster_id=' + userId + '&first=1');
    out.followers = r.status === 200 ? { ok: true, total: r.data.total || 0 } : { ok: false, status: r.status, error: errMsg(r) };
  } catch (e) { out.followers = { ok: false, error: e.message }; }

  try { const r = await g('/subscriptions?broadcaster_id=' + userId + '&first=1');
    out.subscriptions = r.status === 200 ? { ok: true, total: r.data.total || 0, points: r.data.points || 0 } : { ok: false, status: r.status, error: errMsg(r) };
  } catch (e) { out.subscriptions = { ok: false, error: e.message }; }

  try { const r = await g('/bits/leaderboard?count=5&period=all');
    out.bits = r.status === 200 ? { ok: true, total: r.data.total || 0, leaders: (r.data.data || []).map((b) => ({ name: b.user_name, score: b.score })) } : { ok: false, status: r.status, error: errMsg(r) };
  } catch (e) { out.bits = { ok: false, error: e.message }; }

  try { const r = await g('/videos?user_id=' + userId + '&type=archive&first=20&sort=time');
    out.pastBroadcasts = r.status === 200 ? { ok: true, items: (r.data.data || []).map((v) => ({ id: v.id, title: v.title, createdAt: v.created_at, durationSec: parseDuration(v.duration), viewCount: v.view_count || 0, url: v.url })) } : { ok: false, status: r.status, error: errMsg(r) };
  } catch (e) { out.pastBroadcasts = { ok: false, error: e.message }; }

  try { const r = await g('/clips?broadcaster_id=' + userId + '&first=12');
    out.topClips = r.status === 200 ? { ok: true, items: (r.data.data || []).map((c) => ({ id: c.id, title: c.title, viewCount: c.view_count || 0, createdAt: c.created_at, creator: c.creator_name, url: c.url })).sort((a, b) => b.viewCount - a.viewCount) } : { ok: false, status: r.status, error: errMsg(r) };
  } catch (e) { out.topClips = { ok: false, error: e.message }; }

  try { const r = await g('/channels?broadcaster_id=' + userId);
    if (r.status === 200 && r.data.data && r.data.data[0]) out.channel = { ok: true, title: r.data.data[0].title, game: r.data.data[0].game_name };
  } catch (e) {}
  try { const r = await g('/streams?user_id=' + userId);
    if (r.status === 200) out.stream = { ok: true, isLive: (r.data.data || []).length > 0, viewers: (r.data.data[0] && r.data.data[0].viewer_count) || 0 };
  } catch (e) {}

  // A 401 anywhere ⇒ the token is dead (no refresh on implicit grant) → reconnect needed.
  out.needsReconnect = [out.followers, out.subscriptions, out.pastBroadcasts, out.bits].some((x) => x && x.status === 401);
  return out;
}

module.exports = { fetchTwitchStats, parseDuration };
