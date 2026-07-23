'use strict';

/* Discord chat — multichat source #4. Reads messages from ONE Discord text channel
 * via a bot connection to the Discord gateway. The app's existing Discord state is
 * cloud-login IDENTITY (OAuth), NOT a message-reading bot — so this needs its own bot
 * token, which the producer creates once (Discord Developer Portal → New Application →
 * Bot → copy token → enable "Message Content Intent" → invite to their server).
 *
 *   createDiscordChat({ getConfig, onMessage, onStatus })
 *     getConfig() -> { botToken, channelId }   (either empty = idle)
 *     onMessage({ platform:'discord', user, text, color, ts })
 *     onStatus(connected:boolean, detail:string)
 *
 * Raw gateway (no discord.js dep). Intents: GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT.
 * Close code 4014 = "disallowed intents" → the Message Content Intent isn't enabled;
 * we surface that clearly instead of reconnect-looping.
 */

let WebSocket;
try { WebSocket = require('ws'); } catch (e) { console.warn('[discord-chat] ws not installed'); }

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
    if (!token || !channelId) { status(false, 'not configured'); return; }   // idle until set
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
          if (d.channel_id !== (getConfig().channelId || '').trim()) return;   // only the watched channel
          if (d.author && d.author.bot) return;                                // skip bots (incl. ourselves)
          const text = (d.content || '').toString().trim();
          if (!text) return;                                                   // embeds/attachments-only
          const user = (d.member && d.member.nick) || (d.author && (d.author.global_name || d.author.username)) || 'Discord user';
          try { onMessage({ platform: 'discord', user, text, color: '', ts: Date.now() }); } catch (_) {}
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

module.exports = { createDiscordChat };
