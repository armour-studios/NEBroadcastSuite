'use strict';
// Which browser origins may talk to the local API (:3000) and the WS bridge (:3001).
//
// Browsers attach an Origin header to cross-site fetches and to EVERY WebSocket handshake, and they
// happily let any web page open ws://127.0.0.1:3001 or fetch http://localhost:3000. With a global
// `Access-Control-Allow-Origin: *` and a token handed out by GET /api/ws-token, any site the producer
// had open could read state and drive the show (scenes, scores, graphics, Twitch predictions).
//
// Allowed:
//   - no Origin header        OBS browser sources, the Stream Deck plugin (Node fetch/ws), curl,
//                             direct page loads and GET navigations (OAuth callbacks)
//   - "null" / file://        the control panel and its pop-outs (Electron loadFile)
//   - overwolf-extension://   the Overwolf GEP relay (companion-overwolf/)
//   - localhost / 127.0.0.1 / [::1], any port   overlays, local dev servers
//   - same host as the request  an overlay opened by LAN IP from another PC talks back to that IP
//   - NE_ALLOW_ORIGINS        comma-separated extra origins, an escape hatch for a custom tool
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function extraOrigins() {
  return String(process.env.NE_ALLOW_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function hostOnly(hostHeader) {
  const h = String(hostHeader || '').toLowerCase().trim();
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);   // [::1]:3000 -> [::1]
  return h.split(':')[0];
}

function isAllowedOrigin(origin, hostHeader) {
  if (origin === undefined || origin === null || origin === '') return true;
  const o = String(origin).trim().toLowerCase();
  if (o === 'null' || o.startsWith('file://')) return true;
  if (o.startsWith('overwolf-extension://')) return true;
  if (extraOrigins().includes(o)) return true;
  let u;
  try { u = new URL(o); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (LOOPBACK.has(host) || LOOPBACK.has('[' + host + ']')) return true;
  const reqHost = hostOnly(hostHeader);
  return !!reqHost && (host === reqHost || '[' + host + ']' === reqHost);
}

// Express middleware: refuse foreign origins before any route runs, and answer CORS for the rest
// (reflecting the caller's origin instead of '*').
function originGuardMiddleware(log) {
  return function originGuard(req, res, next) {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, req.headers.host)) {
      if (typeof log === 'function') log(`[security] refused ${req.method} ${req.path} from origin ${origin}`);
      return res.status(403).json({ ok: false, error: 'origin-not-allowed' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin && origin !== 'null' ? origin : '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

module.exports = { isAllowedOrigin, originGuardMiddleware };
