// node test/twitch-connect.test.js
// "Connecting to Twitch is not working": a producer signed in to the cloud was always sent through
// the authorization-CODE flow, but the website answers every code exchange with 503 until its
// Twitch client secret is configured, so the sign-in window only ever said "Connection failed".
// Boots the REAL server in plain node against a fake website (no request reaches Twitch or the real
// site) and checks: the code flow is used only when the website can exchange codes, a 503 at the
// callback sends the same window round again through the implicit flow, and the next Connect goes
// straight to the implicit flow.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-twitch-connect-'));
const SITE_PORT = 3338;
process.env.NE_USERDATA = TMP;
process.env.NE_HTTP_PORT = '3330';
process.env.NE_WS_PORT = '3331';
process.env.NE_LAN_AGENT_HOST = '127.0.0.1';
process.env.NE_LAN_AGENT_PORT = '3335';
process.env.BROADCAST_REMOTE_URL = 'http://127.0.0.1:' + SITE_PORT;
const HTTP = 3330;
const ROOT = path.join(__dirname, '..');

// A signed-in cloud session, as the launcher leaves it.
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'data', 'cloud-session.json'), JSON.stringify({
  token: 'test-session', refreshToken: '', user: { username: 'tester' }, expiresAt: Date.now() + 3600e3
}));

// Fake website. siteConfigured=false is the live site today: 503 for every /api/auth/twitch call.
let siteConfigured = true;
const siteHits = [];
const site = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/api/auth/twitch' && req.method === 'POST') {
      siteHits.push({ auth: req.headers.authorization || '', body });
      res.setHeader('Content-Type', 'application/json');
      if (!siteConfigured) { res.statusCode = 503; return res.end(JSON.stringify({ error: { code: 'server_error', message: 'Twitch linking is not configured on the backend yet.' } })); }
      let b = {}; try { b = JSON.parse(body || '{}'); } catch (e) {}
      if (!b.code) { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 'validation', message: 'code and redirectUri are required' } })); }
      res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 'validation', message: 'Invalid authorization code' } }));
    }
    res.setHeader('Content-Type', 'application/json'); res.end('{}');
  });
});

function request(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: HTTP, path: p, method,
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 Chrome/130 Electron/44.0.0' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
    }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); });
    r.on('error', (e) => resolve({ status: 0, headers: {}, text: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (url) => new URL(url).searchParams;

const quiet = [console.log, console.warn, console.error];
console.log = () => {}; console.warn = () => {}; console.error = () => {};
const restore = () => { [console.log, console.warn, console.error] = quiet; };

site.listen(SITE_PORT, '127.0.0.1', async () => {
  let pass = 0;
  const ok = (cond, name, detail) => { assert.ok(cond, name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); pass++; };
  try {
    require(path.join(ROOT, 'server.js')).start(ROOT);
    let up = false;
    for (let i = 0; i < 150 && !up; i++) { up = (await request('GET', '/api/time')).status === 200; if (!up) await wait(100); }
    restore();
    ok(up, 'server starts in plain node');
    const SCOPES = ['chat:read', 'chat:edit', 'channel:manage:predictions'];

    // 1. Website configured: signed-in -> code flow (unchanged behaviour).
    let r = await request('POST', '/api/oauth/twitch/init', { scopes: SCOPES });
    let j = JSON.parse(r.text);
    ok(r.status === 200 && j.mode === 'code', 'website able to exchange codes -> code flow', j);
    ok(q(j.authUrl).get('response_type') === 'code', 'authorize URL asks for a code', j.authUrl);
    ok(siteHits.length === 1 && siteHits[0].auth === 'Bearer test-session' && siteHits[0].body === '{}',
      'the capability check is one empty, signed-in POST (no code, nothing reaches Twitch)', siteHits);

    // 2. The website stops being able to exchange (the live site today) while that window is open:
    // the callback must not strand the producer on "Connection failed".
    siteConfigured = false;
    r = await request('GET', '/api/oauth/twitch/callback?code=abc&scope=chat%3Aread&state=' + encodeURIComponent(j.sessionId));
    ok(r.status === 302, 'a 503 from the code exchange redirects instead of failing', { status: r.status, body: r.text.slice(0, 200) });
    const loc = r.headers.location || '';
    ok(loc.startsWith('https://id.twitch.tv/oauth2/authorize?'), 'the redirect goes back to Twitch', loc);
    ok(q(loc).get('response_type') === 'token', 'the retry uses the implicit flow', loc);
    ok(q(loc).get('state') === j.sessionId, 'the retry keeps the same sign-in session', loc);
    ok(q(loc).get('scope') === SCOPES.join(' '), 'the retry asks for the same scopes', loc);
    ok(q(loc).get('redirect_uri') === 'http://localhost:3000/api/oauth/twitch/callback', 'the retry returns to the app callback', loc);

    // 3. The next Connect goes straight to the implicit flow (the 503 was remembered).
    const hitsBefore = siteHits.length;
    r = await request('POST', '/api/oauth/twitch/init', { scopes: SCOPES });
    j = JSON.parse(r.text);
    ok(r.status === 200 && j.mode === 'token' && q(j.authUrl).get('response_type') === 'token',
      'website unable to exchange codes -> implicit flow', j);
    ok(siteHits.length === hitsBefore, 'the remembered answer is reused, not re-asked on every click', siteHits.length - hitsBefore);

    // 4. The implicit callback page is served and posts the fragment token back to the app.
    r = await request('GET', '/api/oauth/twitch/callback');
    ok(r.status === 200 && /\/api\/oauth\/twitch\/apply-token/.test(r.text), 'implicit callback page is served', r.status);

    // 5. Any other code-exchange failure still shows the failure page (no redirect loop).
    siteConfigured = true;
    r = await request('GET', '/api/oauth/twitch/callback?code=bad&state=' + encodeURIComponent(j.sessionId));
    ok(r.status === 200 && /Connection failed/.test(r.text) && /Invalid authorization code/.test(r.text),
      'a rejected code shows why, without looping', { status: r.status });

    console.log(`twitch-connect: all ${pass} checks passed`);
    process.exit(0);
  } catch (e) {
    restore();
    console.error('twitch-connect: FAIL ' + e.message);
    process.exit(1);
  }
});
