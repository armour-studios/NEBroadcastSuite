'use strict';

/* Kick chat — multichat source #3. Kick has no official chat API, but its site chat
 * rides a PUBLIC Pusher websocket (no auth): resolve the channel's chatroom id from
 * the public channel endpoint, connect to Kick's Pusher cluster, and subscribe to
 * `chatrooms.<id>.v2`. Read-only; nothing is sent to Kick.
 *
 *   createKickChat({ getChannel, onMessage, onStatus })
 *     getChannel() -> string   (channel slug, e.g. "xqc"; '' = disabled/idle)
 *     onMessage({ platform:'kick', user, text, color, ts })
 *     onStatus(connected:boolean, detail:string)
 *
 * Unofficial: Kick can change the Pusher key/cluster or add Cloudflare gating at any
 * time. All failures degrade to a status message + retry, never a crash.
 */

let WebSocket;
try { WebSocket = require('ws'); } catch (e) { console.warn('[kick-chat] ws not installed'); }
const https = require('https');

// Public Kick Pusher app key + cluster (same values the kick.com web client uses).
const PUSHER_KEY = '32cbd69e4b950bf97679';
const PUSHER_URL = `wss://ws-us2.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;
const RECONNECT_MS = 6000;
const RESOLVE_RETRY_MS = 30000;

// Browser-like headers — Kick's channel API sits behind Cloudflare and rejects bare clients.
function resolveChatroomId(slug) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`channel lookup HTTP ${res.statusCode}`));
        try {
          const j = JSON.parse(body);
          const id = j && j.chatroom && j.chatroom.id;
          if (!id) return reject(new Error('no chatroom id in response'));
          resolve(id);
        } catch (e) { reject(new Error('bad channel JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('channel lookup timeout')));
  });
}

function createKickChat({ getChannel, onMessage, onStatus }) {
  let running = false;
  let ws = null;
  let reconnectTimer = null;
  let connected = false;
  let curSlug = '';       // slug we're currently subscribed for
  let chatroomId = null;

  const status = (c, detail) => { connected = c; try { onStatus(c, detail || ''); } catch (_) {} };
  const clearTimer = () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } };
  const retry = (ms) => { clearTimer(); if (running) reconnectTimer = setTimeout(open, ms); };

  async function open() {
    clearTimer();
    if (!running || !WebSocket) return;
    const slug = (getChannel() || '').trim().toLowerCase().replace(/^@/, '');
    if (!slug) { status(false, 'no channel set'); return; }   // idle until a channel is configured

    // Resolve the chatroom id when the channel changes (or first connect).
    if (slug !== curSlug || !chatroomId) {
      try {
        chatroomId = await resolveChatroomId(slug);
        curSlug = slug;
      } catch (e) {
        status(false, `can't reach Kick channel "${slug}": ${e.message}`);
        return retry(RESOLVE_RETRY_MS);
      }
    }

    let sock;
    try { sock = new WebSocket(PUSHER_URL); } catch (e) { return retry(RECONNECT_MS); }
    ws = sock;

    sock.on('open', () => { /* wait for pusher:connection_established before subscribing */ });

    sock.on('message', (buf) => {
      if (ws !== sock) return;
      let frame;
      try { frame = JSON.parse(buf.toString()); } catch { return; }
      const ev = frame.event;

      if (ev === 'pusher:connection_established') {
        sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatroomId}.v2` } }));
        status(true, `#${curSlug}`);
        return;
      }
      if (ev === 'pusher:ping') { sock.send(JSON.stringify({ event: 'pusher:pong', data: {} })); return; }
      if (ev === 'pusher:error') { status(false, 'Kick Pusher error'); try { sock.close(); } catch {} return; }

      if (ev === 'App\\Events\\ChatMessageEvent') {
        let d = frame.data;
        try { if (typeof d === 'string') d = JSON.parse(d); } catch { return; }
        if (!d) return;
        const user = (d.sender && d.sender.username) || 'Kick user';
        const text = (d.content || '').toString().trim();
        if (!text) return;
        const color = (d.sender && d.sender.identity && d.sender.identity.color) || '';
        try { onMessage({ platform: 'kick', user, text, color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '', ts: Date.now() }); } catch (_) {}
      }
    });

    const drop = () => {
      if (ws !== sock) return;
      ws = null;
      if (connected) status(false, 'disconnected');
      retry(RECONNECT_MS);
    };
    sock.on('close', drop);
    sock.on('error', () => { try { sock.close(); } catch {} });
  }

  function close() {
    clearTimer();
    if (ws) { try { ws.terminate(); } catch {} ws = null; }
  }

  return {
    start() { if (running || !WebSocket) return; running = true; open(); },
    stop() { running = false; close(); status(false, 'stopped'); },
    /** Re-resolve + reconnect now — call when the producer changes the channel. */
    kick() { chatroomId = null; curSlug = ''; if (!running) return this.start(); close(); open(); },
    get connected() { return connected; },
  };
}

module.exports = { createKickChat };
