'use strict';

/* Discord chat — multichat source #4. Reads messages from Discord text channels via a bot
 * connection to the Discord gateway. The app's existing Discord state is cloud-login
 * IDENTITY (OAuth), NOT a message-reading bot — so this needs its own bot token, which the
 * producer creates once (Discord Developer Portal → New Application → Bot → copy token →
 * enable "Message Content Intent" → invite to their server).
 *
 *   createDiscordChat({ getConfig, onMessage, onStatus })
 *     getConfig() -> { botToken, channelId, questionChannelId }   (token/both channels empty = idle)
 *     onMessage({ platform:'discord', kind:'chat'|'question', user, text, color, ts, ref })
 *     onStatus(connected:boolean, detail:string)
 *
 * TWO channels ride ONE gateway connection: the multichat feed channel and (optionally) a
 * dedicated questions/mailbag channel, tagged apart by `kind`. Discord rate-limits IDENTIFY
 * hard, so a second socket for the second channel would be the wrong shape.
 *
 * Raw gateway (no discord.js dep). Intents: GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT.
 * Close code 4014 = "disallowed intents" → the Message Content Intent isn't enabled;
 * we surface that clearly instead of reconnect-looping.
 */

let WebSocket;
try { WebSocket = require('ws'); } catch (e) { console.warn('[discord-chat] ws not installed'); }
const https = require('https');

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);   // GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT
const RECONNECT_MS = 6000;

function createDiscordChat({ getConfig, onMessage, onStatus }) {
  let running = false;
  let ws = null;
  let hbTimer = null, reconnectTimer = null;
  let seq = null, acked = true, connected = false;
  let curToken = '';

  const status = (c, detail) => { connected = c; try { onStatus(c, detail || ''); } catch (_) {} };
  const clearReconnect = () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } };
  const stopHeartbeat = () => { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } };
  const retry = (ms) => { clearReconnect(); if (running) reconnectTimer = setTimeout(open, ms); };

  function open() {
    clearReconnect();
    stopHeartbeat();
    if (!running || !WebSocket) return;
    const cfg = getConfig() || {};
    const token = (cfg.botToken || '').trim();
    const channelId = (cfg.channelId || '').trim();
    const questionChannelId = (cfg.questionChannelId || '').trim();
    if (!token || (!channelId && !questionChannelId)) { status(false, 'not configured'); return; }   // idle until set
    curToken = token;

    let sock;
    try { sock = new WebSocket(GATEWAY_URL); } catch (e) { return retry(RECONNECT_MS); }
    ws = sock;
    seq = null; acked = true;

    sock.on('message', (buf) => {
      if (ws !== sock) return;
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.s != null) seq = m.s;

      switch (m.op) {
        case 10: {   // Hello — begin heartbeat + identify
          const interval = m.d.heartbeat_interval;
          stopHeartbeat();
          hbTimer = setInterval(() => {
            if (ws !== sock) return;
            if (!acked) { try { sock.close(4000); } catch {} return; }   // zombied — force reconnect
            acked = false;
            sock.send(JSON.stringify({ op: 1, d: seq }));
          }, interval);
          sock.send(JSON.stringify({
            op: 2,
            d: {
              token: curToken,
              intents: INTENTS,
              properties: { os: 'windows', browser: 'ne-broadcast-suite', device: 'ne-broadcast-suite' },
            },
          }));
          break;
        }
        case 11: acked = true; break;   // heartbeat ACK
        case 1: sock.send(JSON.stringify({ op: 1, d: seq })); break;   // gateway asked us to beat
        case 7: try { sock.close(4001); } catch {} break;   // reconnect requested
        case 9: retry(RECONNECT_MS); try { sock.close(); } catch {} break;   // invalid session → fresh identify
        case 0: {   // dispatch
          if (m.t === 'READY') { status(true, 'connected'); return; }
          if (m.t !== 'MESSAGE_CREATE') return;
          const d = m.d || {};
          const live = getConfig() || {};
          // Only the watched channels; the questions channel is tagged so the server can route it.
          let kind = '';
          if (d.channel_id === (live.channelId || '').trim()) kind = 'chat';
          else if (d.channel_id === (live.questionChannelId || '').trim()) kind = 'question';
          else return;
          if (d.author && d.author.bot) return;                                // skip bots (incl. ourselves)
          const text = (d.content || '').toString().trim();
          if (!text) return;                                                   // embeds/attachments-only
          const user = (d.member && d.member.nick) || (d.author && (d.author.global_name || d.author.username)) || 'Discord user';
          try { onMessage({ platform: 'discord', kind, user, text, color: '', ts: Date.now(), ref: d.id || '' }); } catch (_) {}
          break;
        }
      }
    });

    const drop = (code) => {
      if (ws !== sock) return;
      ws = null;
      stopHeartbeat();
      // 4014 = disallowed intents (Message Content Intent off); 4004 = bad token. Don't hammer.
      if (code === 4014) { status(false, 'enable the Message Content Intent for your bot'); return; }
      if (code === 4004) { status(false, 'invalid bot token'); return; }
      if (connected) status(false, 'disconnected');
      retry(RECONNECT_MS);
    };
    sock.on('close', (code) => drop(code));
    sock.on('error', () => { try { sock.close(); } catch {} });
  }

  function close() {
    clearReconnect();
    stopHeartbeat();
    if (ws) { try { ws.terminate(); } catch {} ws = null; }
  }

  return {
    start() { if (running || !WebSocket) return; running = true; open(); },
    stop() { running = false; close(); status(false, 'stopped'); },
    /** Reconnect now with the latest config — call when token/channel changes. */
    kick() { if (!running) return this.start(); close(); open(); },
    get connected() { return connected; },
  };
}

/**
 * One-shot REST read of a channel's recent messages — the gateway only ever delivers what
 * arrives AFTER we connect, so the backlog a community posted overnight needs this. Returns
 * oldest-first [{ ref, user, text, ts }]; rejects with a producer-readable message.
 */
function fetchChannelMessages({ botToken, channelId, limit = 50 }) {
  return new Promise((resolve, reject) => {
    const token = (botToken || '').trim();
    const id = (channelId || '').trim();
    if (!token) return reject(new Error('No Discord bot token saved.'));
    if (!/^\d{5,25}$/.test(id)) return reject(new Error('Channel ID must be the numeric ID (right-click the channel → Copy Channel ID).'));
    const req = https.request({
      host: 'discord.com',
      path: `/api/v10/channels/${id}/messages?limit=${Math.max(1, Math.min(100, Number(limit) || 50))}`,
      method: 'GET',
      headers: { Authorization: 'Bot ' + token, 'User-Agent': 'ne-broadcast-suite (questions, 1.0)' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Discord rejected the bot token.'));
        if (res.statusCode === 403) return reject(new Error('The bot cannot read that channel — check its permissions (View Channel + Read Message History).'));
        if (res.statusCode === 404) return reject(new Error('No such channel — double-check the channel ID.'));
        if (res.statusCode === 429) return reject(new Error('Discord rate-limited the pull; try again in a moment.'));
        if (res.statusCode !== 200) return reject(new Error('Discord returned HTTP ' + res.statusCode));
        let arr;
        try { arr = JSON.parse(body); } catch { return reject(new Error('Unreadable response from Discord.')); }
        if (!Array.isArray(arr)) return reject(new Error('Unexpected response from Discord.'));
        resolve(arr
          .filter(d => d && !(d.author && d.author.bot) && (d.content || '').trim())
          .map(d => ({
            ref: d.id || '',
            user: (d.member && d.member.nick) || (d.author && (d.author.global_name || d.author.username)) || 'Discord user',
            text: (d.content || '').toString().trim(),
            ts: d.timestamp ? Date.parse(d.timestamp) || Date.now() : Date.now(),
          }))
          .reverse());   // Discord returns newest-first; queue order should read oldest-first
      });
    });
    req.on('error', (e) => reject(new Error('Could not reach Discord: ' + e.message)));
    req.setTimeout(10000, () => { req.destroy(new Error('Discord request timed out')); });
    req.end();
  });
}

module.exports = { createDiscordChat, fetchChannelMessages };
