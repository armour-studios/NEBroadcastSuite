'use strict';
// Plain-node end-to-end harness for the running NE Broadcast Suite server.
// Run:  node scripts/e2e-workflows.js   (the app must be running; it restores every value it changes)
// Protocol (server.js):
//   WS  ws://localhost:3001  — client sends {type, data}; server broadcasts {type:'full_state', data:{...state}}
//       (the first frame on connect is the full snapshot: live + static + library tiers).
//       Per-socket replies: {type:'obs-result', data:{ok,message,...}}, {type:'pong'}, {type:'perm-denied'}.
//       No Origin header => allowed by backend/origin-guard.js; no token needed on loopback bind.
//   HTTP http://localhost:3000  — /api/time, /api/overlays, /api/overlay-thumb?file=, /api/media/list?path=
// Never touches OBS profiles/collections, ads, or any delete/clear/reset message.

const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');
let WS;
try { WS = require(path.join(REPO, 'node_modules', 'ws')); }
catch (e) { WS = global.WebSocket; }
if (!WS) { console.error('No WebSocket implementation available'); process.exit(2); }

const WS_URL = 'ws://localhost:3001';
const HTTP_BASE = 'http://localhost:3000';
const TIMEOUT_MS = 3000;

const results = [];
function record(name, pass, observed, note) {
  results.push({ name, pass, observed, note });
  const obs = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  -> ${obs}${note ? '   (' + note + ')' : ''}`);
}

// ── socket plumbing ─────────────────────────────────────────────────────────
let ws = null;
let latestState = null;
const listeners = new Set();   // fn(msg) — every parsed frame

function onFrame(raw) {
  let msg;
  try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); }
  catch (e) { console.warn('[harness] unparseable frame (' + (raw && raw.length) + ' bytes)'); return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'full_state' && msg.data) latestState = msg.data;
  for (const fn of Array.from(listeners)) { try { fn(msg); } catch (e) {} }
}

function connect() {
  return new Promise((resolve, reject) => {
    const sock = new WS(WS_URL);
    const timer = setTimeout(() => reject(new Error('connect timeout')), 5000);
    const first = (msg) => {
      if (msg.type === 'full_state') { clearTimeout(timer); listeners.delete(first); resolve(msg.data); }
    };
    listeners.add(first);
    sock.addEventListener ? sock.addEventListener('message', (ev) => onFrame(ev.data)) : sock.on('message', onFrame);
    sock.on && sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.onerror = (e) => { clearTimeout(timer); reject(e && e.error || new Error('ws error')); };
    ws = sock;
  });
}

function send(type, data) {
  const s = JSON.stringify(data === undefined ? { type } : { type, data });
  ws.send(s);
}

// Wait for the next full_state (after sending) that satisfies pred; resolves {ok, value, state}.
function waitState(pred, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (done) return; done = true; listeners.delete(fn); resolve({ ok: false, timeout: true, state: latestState }); }, timeout);
    const fn = (msg) => {
      if (msg.type !== 'full_state' || done) return;
      let v;
      try { v = pred(msg.data); } catch (e) { v = undefined; }
      if (v) { done = true; clearTimeout(t); listeners.delete(fn); resolve({ ok: true, state: msg.data }); }
    };
    listeners.add(fn);
  });
}

// Wait for any frame of a given type.
function waitType(type, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (done) return; done = true; listeners.delete(fn); resolve(null); }, timeout);
    const fn = (msg) => { if (msg.type === type && !done) { done = true; clearTimeout(t); listeners.delete(fn); resolve(msg); } };
    listeners.add(fn);
  });
}

// Send a control message and assert a predicate on the next matching full_state.
async function step(name, type, data, getter, expected) {
  const p = waitState((s) => deepEq(getter(s), expected));
  send(type, data);
  const r = await p;
  const observed = r.timeout ? safeGet(getter, latestState) : getter(r.state);
  record(name, !r.timeout, observed, r.timeout ? `timed out waiting for ${JSON.stringify(expected)}` : '');
  return r;
}
function safeGet(getter, s) { try { return getter(s); } catch (e) { return '<' + e.message + '>'; } }
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ── HTTP helper ─────────────────────────────────────────────────────────────
function httpGet(p, timeout = 15000) {
  return new Promise((resolve) => {
    const req = http.get(HTTP_BASE + p, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('http timeout')); });
    req.on('error', (e) => resolve({ status: 0, error: e.message, body: Buffer.alloc(0) }));
  });
}
function parseJson(buf) { try { return JSON.parse(buf.toString()); } catch (e) { return null; } }

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  let exitCode = 0;
  let orig = null;
  try {
    const first = await connect();
    console.log('[harness] connected; first full_state keys=' + Object.keys(first).length);

    // 2. Record current values to restore later.
    orig = {
      teams: {
        blue: { ...(first.teams && first.teams.blue || {}) },
        orange: { ...(first.teams && first.teams.orange || {}) }
      },
      bestOf: first.bestOf,
      series: { ...(first.series || {}) },
      gameNumber: first.game && first.game.number,
      roundLabel: first.roundLabel,
      gfxActive: first.gfxActive,
      breakScreen: { ...(first.breakScreen || {}) },
      activeBrandKitId: first.activeBrandKitId,
      ticker: { visible: first.ticker && first.ticker.visible },
      casters: { visible: first.casters && first.casters.visible },
      banner: { visible: first.mainBanner && first.mainBanner.visible }
    };
    const logoLen = (t) => (t && typeof t.logo === 'string') ? t.logo.length : 0;
    console.log('[harness] recorded originals: ' + JSON.stringify({
      blue: orig.teams.blue.name, blueLogoLen: logoLen(orig.teams.blue),
      orange: orig.teams.orange.name, orangeLogoLen: logoLen(orig.teams.orange),
      bestOf: orig.bestOf, series: orig.series, gameNumber: orig.gameNumber,
      roundLabel: orig.roundLabel, gfxActive: orig.gfxActive,
      breakVisible: orig.breakScreen.visible, activeBrandKitId: orig.activeBrandKitId,
      tickerVisible: orig.ticker.visible, castersVisible: orig.casters.visible, bannerVisible: orig.banner.visible
    }));

    // ── 3. cases ──
    // set_team (handler: server.js case 'set_team' — keys side/name/logo/players[/abbr/color/org])
    await step('set_team blue -> E2E BLUE', 'set_team', { side: 'blue', name: 'E2E BLUE', logo: null, players: [] },
      (s) => s.teams.blue.name, 'E2E BLUE');

    // set_best_of (handler reads msg.data.value)
    await step('set_best_of 5', 'set_best_of', { value: 5 }, (s) => s.bestOf, 5);
    // Ensure a known baseline where series +1 is representable: cap is ceil(bestOf/2)=3.
    const sBefore = (latestState.series && latestState.series.blue) || 0;
    if (sBefore >= 3) record('adjust_series precondition', false, sBefore, 'series.blue already at cap');
    await step('adjust_series blue +1', 'adjust_series', { side: 'blue', delta: 1 }, (s) => s.series.blue, Math.min(3, sBefore + 1));
    await step('adjust_series blue -1', 'adjust_series', { side: 'blue', delta: -1 }, (s) => s.series.blue, sBefore);

    // adjust_game_number: clamped to [1, bestOf]; after adjust_series, game.number = played+1.
    const gBefore = latestState.game.number;
    await step('adjust_game_number +1', 'adjust_game_number', { delta: 1 }, (s) => s.game.number, Math.min(5, gBefore + 1));
    await step('adjust_game_number -1', 'adjust_game_number', { delta: -1 }, (s) => s.game.number, Math.max(1, Math.min(5, gBefore + 1) - 1));

    await step('set_round_label', 'set_round_label', { text: 'E2E ROUND' }, (s) => s.roundLabel, 'E2E ROUND');

    // set_break: {visible,title,seconds}
    const rb = await step('set_break visible:true', 'set_break', { visible: true, title: 'E2E', seconds: 60 },
      (s) => [s.breakScreen.visible, s.breakScreen.title], [true, 'E2E']);
    if (rb.ok) {
      const ea = rb.state.breakScreen.endsAt;
      record('set_break seconds -> endsAt set', typeof ea === 'number' && ea > Date.now() + 30000, ea);
    }
    await step('set_break visible:false', 'set_break', { visible: false },
      (s) => [s.breakScreen.visible, s.breakScreen.endsAt], [false, null]);

    // set_gfx_active {scene}
    await step('set_gfx_active break', 'set_gfx_active', { scene: 'break' }, (s) => s.gfxActive, 'break');
    await step('set_gfx_active null', 'set_gfx_active', { scene: null }, (s) => s.gfxActive, null);

    // set_ticker {visible}
    const tv = !!(latestState.ticker && latestState.ticker.visible);
    await step('set_ticker visible toggle', 'set_ticker', { visible: !tv }, (s) => s.ticker.visible, !tv);
    await step('set_ticker visible restore', 'set_ticker', { visible: tv }, (s) => s.ticker.visible, tv);

    // set_casters_visibility {visible} — NOTE: handler also calls obsSwitch('casters'|'inGame');
    // that is a scene CUT (read-only wrt OBS settings), gated by state.obs flags. Toggle and restore.
    const cv = !!(latestState.casters && latestState.casters.visible);
    const obsArmed = !!(latestState.obs && latestState.obs.enabled && latestState.obs.autoSwitch && latestState.obs.connected);
    if (obsArmed) {
      console.log('SKIP  set_casters_visibility (OBS auto-switch is armed; the handler would cut program)');
    } else {
      await step('set_casters_visibility toggle', 'set_casters_visibility', { visible: !cv }, (s) => s.casters.visible, !cv);
      await step('set_casters_visibility restore', 'set_casters_visibility', { visible: cv }, (s) => s.casters.visible, cv);
    }

    // set_banner_visibility {visible} — state.banner.visible rides as mainBanner.visible and banner.visible
    const bv = !!(latestState.mainBanner && latestState.mainBanner.visible);
    await step('set_banner_visibility toggle', 'set_banner_visibility', { visible: !bv }, (s) => s.mainBanner.visible, !bv);
    await step('set_banner_visibility restore', 'set_banner_visibility', { visible: bv }, (s) => s.mainBanner.visible, bv);

    // ── HTTP ──
    {
      const r = await httpGet('/api/time');
      const j = parseJson(r.body);
      record('GET /api/time', r.status === 200 && j && typeof j.now === 'number' && Math.abs(j.now - Date.now()) < 60000, j || r.status);
    }
    {
      const r = await httpGet('/api/overlays');
      const j = parseJson(r.body);
      const n = j && Array.isArray(j.overlays) ? j.overlays.length : -1;
      record('GET /api/overlays (>50)', r.status === 200 && j && j.ok === true && n > 50, { status: r.status, ok: j && j.ok, count: n });
    }
    {
      const r = await httpGet('/api/overlay-thumb?file=rl-hud.html', 30000);
      const ct = r.headers && r.headers['content-type'] || '';
      const okPng = r.status === 200 && (/png/i.test(ct) || (r.body.length > 8 && r.body[1] === 0x50 && r.body[2] === 0x4e && r.body[3] === 0x47));
      record('GET /api/overlay-thumb?file=rl-hud.html (200 png | 202)', okPng || r.status === 202, { status: r.status, contentType: ct, bytes: r.body.length });
    }
    {
      const r = await httpGet('/api/media/list?path=');
      const j = parseJson(r.body);
      record('GET /api/media/list?path=', r.status === 200 && j && j.ok === true && Array.isArray(j.files) && Array.isArray(j.folders),
        j ? { ok: j.ok, folders: j.folders && j.folders.length, files: j.files && j.files.length } : r.status);
    }

    // ── WS reply: obs_save_replay → obs-result on this socket ──
    {
      const p = waitType('obs-result');
      send('obs_save_replay', {});
      const m = await p;
      record('obs_save_replay -> obs-result reply', !!m, m ? m.data : 'no reply within 3s');
    }

    // ── "Add to OBS" / "Build show scenes" → obs-ensure-result on this socket ──
    // With OBS connected these really change OBS (sources + NE scenes only); without it they must
    // still answer, so the producer is never left waiting on a silent button.
    {
      const p = waitType('obs-ensure-result');
      send('obs_add_overlay', { sourceName: 'NE E2E Probe', url: 'http://localhost:3000/countdown.html', width: 1920, height: 1080 });
      const m = await p;
      record('obs_add_overlay -> obs-ensure-result reply', !!m, m ? m.data : 'no reply within 3s');
    }
    {
      const p = waitType('obs-ensure-result');
      send('obs_build_show_scenes', { base: 'https://evil.example' });
      const m = await p;
      record('obs_build_show_scenes rejects a non-local base', !!m && m.data && m.data.ok === false, m ? m.data : 'no reply within 3s');
    }

    // ── ping/pong sanity ──
    {
      const p = waitType('pong');
      send('ping');
      const m = await p;
      record('ping -> pong', !!m, m ? 'pong' : 'no pong within 3s');
    }
  } catch (e) {
    console.error('[harness] fatal: ' + (e && e.stack || e));
    exitCode = 1;
  }

  // ── 4. restore ──
  if (orig && ws) {
    console.log('[harness] restoring original values...');
    const restore = async (label, type, data, getter, expected) => {
      const p = waitState((s) => deepEq(getter(s), expected));
      send(type, data);
      const r = await p;
      const got = r.timeout ? safeGet(getter, latestState) : getter(r.state);
      // A write that leaves the payload byte-identical is deduped by the server (no broadcast), so
      // judge by the latest state when the broadcast never comes.
      const fine = !r.timeout || deepEq(got, expected);
      console.log(`${fine ? 'ok  ' : 'WARN'}  restore ${label} -> ${JSON.stringify(got)}`);
      if (!fine) exitCode = 1;
    };
    const teamMsg = (side, t) => ({
      side, name: t.name || '', logo: t.logo || null,
      players: Array.isArray(t.players) ? t.players : [],
      abbr: t.abbr || '', org: typeof t.org === 'string' ? t.org : undefined,
      color: (typeof t.ownColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.ownColor)) ? t.ownColor : undefined
    });
    try {
      await restore('teams.blue', 'set_team', teamMsg('blue', orig.teams.blue), (s) => s.teams.blue.name, orig.teams.blue.name || '');
      await restore('bestOf', 'set_best_of', { value: orig.bestOf }, (s) => s.bestOf, orig.bestOf);
      // series: re-apply via deltas (adjust_series clamps to the cap; after bestOf restore the cap is right)
      for (const side of ['blue', 'orange']) {
        const want = orig.series[side] || 0;
        const have = (latestState.series && latestState.series[side]) || 0;
        if (want !== have) await restore('series.' + side, 'adjust_series', { side, delta: want - have }, (s) => s.series[side], want);
      }
      if (typeof orig.gameNumber === 'number') {
        const have = latestState.game.number;
        if (have !== orig.gameNumber) await restore('game.number', 'adjust_game_number', { delta: orig.gameNumber - have }, (s) => s.game.number, orig.gameNumber);
      }
      await restore('roundLabel', 'set_round_label', { text: orig.roundLabel || '' }, (s) => s.roundLabel, orig.roundLabel || '');
      await restore('gfxActive', 'set_gfx_active', { scene: orig.gfxActive || null }, (s) => s.gfxActive, orig.gfxActive || null);
      const ob = orig.breakScreen;
      const breakMsg = { visible: !!ob.visible, title: ob.title || 'STARTING SOON', message: ob.message || '', finalMessage: ob.finalMessage || "WE'RE LIVE!", titleOnly: !!ob.titleOnly, thenScene: ob.thenScene || '' };
      if (ob.frozenSeconds != null) breakMsg.frozenSeconds = ob.frozenSeconds;
      else breakMsg.endsAt = ob.endsAt || null;
      await restore('breakScreen', 'set_break', breakMsg, (s) => [s.breakScreen.visible, s.breakScreen.title], [!!ob.visible, breakMsg.title]);
    } catch (e) {
      console.error('[harness] restore error: ' + (e && e.message || e));
      exitCode = 1;
    }
  }

  const fails = results.filter((r) => !r.pass);
  console.log(`\n[harness] ${results.length - fails.length}/${results.length} passed${fails.length ? '; FAILED: ' + fails.map((f) => f.name).join(', ') : ''}`);
  if (fails.length) exitCode = 1;
  try { ws && ws.close(); } catch (e) {}
  setTimeout(() => process.exit(exitCode), 200);
})();
