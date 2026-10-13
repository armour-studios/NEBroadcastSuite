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

// The Host header names who the browser THINKS it is talking to. DNS rebinding (evil.com re-resolved
// to 127.0.0.1) makes a public page same-origin with this server: its fetches carry Host: evil.com and,
// being same-origin GETs, often no Origin at all, so the Origin check alone let it read /api/ws-token
// and drive the show. Real callers use loopback, an IP literal (LAN), or a LAN machine name; a public
// DNS name never reaches this server legitimately. NE_ALLOW_HOSTS adds names (comma-separated).
function isAllowedHost(hostHeader) {
  const h = hostOnly(hostHeader);
  if (!h) return true;                                         // HTTP/1.0 and non-browser clients
  if (LOOPBACK.has(h)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[')) return true;   // IPv4 / IPv6 literal
  if (!h.includes('.')) return true;                           // single-label LAN name (STUDIO-PC)
  if (/\.(local|lan|home|internal|home\.arpa|localhost)$/.test(h)) return true;
  const extra = String(process.env.NE_ALLOW_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // A Twitch EventSub webhook arrives through a tunnel (ngrok, cloudflared) with the tunnel's
  // public name as Host: the one configured in EVENTSUB_WEBHOOK_URL is allowed (and HMAC-checked).
  try { if (process.env.EVENTSUB_WEBHOOK_URL) extra.push(new URL(process.env.EVENTSUB_WEBHOOK_URL).hostname.toLowerCase()); } catch (_) {}
  return extra.includes(h);
}

// "null" / file:// is how the control panel (Electron loadFile) shows up, but it is ALSO what any
// website can produce with a sandboxed iframe or a data: page. Those only count when the caller is
// the desktop app or OBS's browser (their User-Agent carries Electron/ or OBS/, which a web page
// cannot forge: User-Agent is a forbidden header for fetch and WebSocket). `ua` undefined = the
// caller did not supply one to check (kept permissive for that call shape).
function trustedOpaqueCaller(ua) {
  if (ua === undefined) return true;
  return /\b(Electron|OBS)\//.test(String(ua || ''));
}

function isAllowedOrigin(origin, hostHeader, ua) {
  if (!isAllowedHost(hostHeader)) return false;
  if (origin === undefined || origin === null || origin === '') return true;
  const o = String(origin).trim().toLowerCase();
  if (o === 'null' || o.startsWith('file://')) return trustedOpaqueCaller(ua);
  if (o.startsWith('overwolf-extension://')) return true;
  if (extraOrigins().includes(o)) return true;
  let u;
  try { u = new URL(o); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (LOOPBACK.has(host) || LOOPBACK.has('[' + host + ']')) return true;
  const reqHost = hostOnly(hostHeader);
  // Same-host (an overlay opened by LAN address talks back to that address). The Host check above
  // already refused public names, so this can no longer be satisfied by a rebinding domain.
  return !!reqHost && (host === reqHost || '[' + host + ']' === reqHost);
}

// Express middleware: refuse foreign origins before any route runs, and answer CORS for the rest
// (reflecting the caller's origin instead of '*').
function originGuardMiddleware(log) {
  return function originGuard(req, res, next) {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, req.headers.host, req.headers['user-agent'] || '')) {
      if (typeof log === 'function') log(`[security] refused ${req.method} ${req.path} from origin ${origin} host ${req.headers.host}`);
      return res.status(403).json({ ok: false, error: 'origin-not-allowed' });
    }
    // Reflect the caller's origin ("null" included) instead of '*', so a permitted opaque caller can
    // read the response and nothing broader is advertised.
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

module.exports = { isAllowedOrigin, isAllowedHost, originGuardMiddleware };
