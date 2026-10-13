'use strict';
// End-to-end: the running app with vMix as the switcher, against a FAKE vMix on :18088 that records
// every function call. Proves the automated paths (countdown "then" cut, commercial, replay) and
// the setup paths (Add to vMix, Build show inputs) reach vMix.
// Run:  node scripts/e2e-vmix.js   (the app must be running; every setting it changes is restored)
// It never talks to a real vMix or OBS.

const path = require('path');
const http = require('http');
const { URL } = require('url');
const WS = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const FAKE_PORT = 18088;
const TIMEOUT_MS = 4000;

// ── fake vMix ────────────────────────────────────────────────────────────────
const fake = {
  inputs: [
    { number: 1, key: 'k1', title: 'Game Capture' },
    { number: 2, key: 'k2', title: 'Casters Cam' },
    { number: 3, key: 'k3', title: 'Ad Slate' },
  ],
  overlays: { 1: '', 2: '', 3: '', 4: '' },
  active: 1, preview: 2,
  calls: [],
  pendingAdd: null,
};
function findInput(ref) { return fake.inputs.find((i) => i.title === ref || i.key === ref || String(i.number) === String(ref)); }
function xml() {
  if (fake.pendingAdd) {
    const n = fake.inputs.length + 1;
    fake.inputs.push({ number: n, key: 'k' + n, title: fake.pendingAdd });
    fake.pendingAdd = null;
  }
  const ins = fake.inputs.map((i) => `<input key="${i.key}" number="${i.number}" type="Browser" title="${i.title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" state="Running">${i.title}</input>`).join('');
  const ovs = [1, 2, 3, 4].map((c) => `<overlay number="${c}">${fake.overlays[c]}</overlay>`).join('');
  return `<vmix><version>27.0.0.49</version><edition>4K</edition><inputs>${ins}</inputs><overlays>${ovs}</overlays>`
    + `<preview>${fake.preview}</preview><active>${fake.active}</active><fadeToBlack>False</fadeToBlack>`
    + `<recording>False</recording><external>False</external><streaming>False</streaming></vmix>`;
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const fn = u.searchParams.get('Function');
  if (fn) {
    const call = { fn, Input: u.searchParams.get('Input'), Value: u.searchParams.get('Value') };
    fake.calls.push(call);
    if ((fn === 'Cut' || /^(Fade|Merge|Wipe|Slide)$/.test(fn)) && findInput(call.Input)) fake.active = findInput(call.Input).number;
    if (fn === 'AddInput') fake.pendingAdd = String(call.Value).split('|').slice(1).join('|');
    if (fn === 'SetInputName' && findInput(call.Input)) findInput(call.Input).title = call.Value;
    if (/^OverlayInput[1-4]In$/.test(fn) && findInput(call.Input)) fake.overlays[fn[12]] = findInput(call.Input).number;
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Function completed successfully.');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(xml());
});

// ── app socket ───────────────────────────────────────────────────────────────
let ws, latest = null;
const listeners = new Set();
function connect() {
  return new Promise((resolve, reject) => {
    ws = new WS('ws://localhost:3001');
    const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.type === 'full_state' && m.data) { latest = { ...(latest || {}), ...m.data }; if (t) { clearTimeout(t); resolve(); } }
      for (const fn of Array.from(listeners)) { try { fn(m); } catch (e) {} }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
const send = (type, data) => ws.send(JSON.stringify({ type, data }));
function waitFor(pred, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      let v; try { v = pred(); } catch (e) { v = null; }
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}
function waitType(type, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { listeners.delete(fn); resolve(null); }, timeout);
    const fn = (m) => { if (m.type === type) { clearTimeout(t); listeners.delete(fn); resolve(m); } };
    listeners.add(fn);
  });
}
const callSince = (i, pred) => waitFor(() => fake.calls.slice(i).find(pred));

const results = [];
function record(name, pass, observed) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  -> ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
}

(async () => {
  await new Promise((r) => server.listen(FAKE_PORT, '127.0.0.1', r));
  await connect();
  const orig = {
    target: (latest.switcher && latest.switcher.target) || 'obs',
    vmix: { enabled: !!latest.vmix.enabled, host: latest.vmix.host, port: latest.vmix.port },
    obs: { enabled: !!latest.obs.enabled, autoSwitch: !!latest.obs.autoSwitch, autoReplayOnGoal: !!latest.obs.autoReplayOnGoal, scenes: { ...(latest.obs.scenes || {}) } },
    brk: { ...(latest.breakScreen || {}) },
  };
  console.log('[vmix-e2e] originals:', JSON.stringify(orig));
  let exit = 0;
  try {
    send('set_vmix_settings', { enabled: true, host: '127.0.0.1', port: FAKE_PORT });
    send('set_switcher_target', { target: 'vmix' });
    const up = await waitFor(() => latest.vmix && latest.vmix.connected && latest.switcher.target === 'vmix', 6000);
    record('connects to (fake) vMix as the switcher', !!up, latest.vmix && { connected: latest.vmix.connected, lastError: latest.vmix.lastError });
    if (!up) throw new Error('vMix never connected');

    // Every scene picker follows the switcher.
    await waitFor(() => (latest.obs.availableScenes || []).includes('Ad Slate'));
    record('scene pickers list vMix inputs', (latest.obs.availableScenes || []).join(',') === 'Game Capture,Casters Cam,Ad Slate', latest.obs.availableScenes);
    record('program highlight = vMix active input', latest.obs.currentScene === 'Game Capture', latest.obs.currentScene);

    // Manual cut (deck / dock / bottom bar all send obs_switch_scene).
    let i = fake.calls.length;
    send('obs_switch_scene', { sceneName: 'Casters Cam' });
    let c = await callSince(i, (x) => x.fn === 'Cut');
    record('manual scene cut reaches vMix', !!c && c.Input === 'Casters Cam', c);
    await waitFor(() => latest.obs.currentScene === 'Casters Cam');
    record('program highlight follows vMix', latest.obs.currentScene === 'Casters Cam', latest.obs.currentScene);

    // Countdown "then" cut (automated).
    i = fake.calls.length;
    send('set_break', { seconds: 1, thenScene: 'Game Capture' });
    c = await callSince(i, (x) => x.fn === 'Cut', 6000);
    record('countdown end auto-cuts on vMix', !!c && c.Input === 'Game Capture', c);

    // A missing input is refused with a clear reason, not a silent success.
    const failP = waitType('rl-scene-result', 6000);
    send('set_break', { seconds: 1, thenScene: 'Deleted Input' });
    const fail = await failP;
    record('missing vMix input reported', !!fail && fail.data.ok === false && /vMix has no input/.test(fail.data.message), fail && fail.data.message);

    // Commercial break: cut to the mapped input and back.
    send('set_obs_settings', { enabled: orig.obs.enabled, autoSwitch: orig.obs.autoSwitch, scenes: { commercial: 'Ad Slate' } });
    await waitFor(() => latest.obs.scenes && latest.obs.scenes.commercial === 'Ad Slate');
    i = fake.calls.length;
    let rp = waitType('obs-result');
    send('obs_toggle_commercial', {});
    let r = await rp;
    c = await callSince(i, (x) => x.fn === 'Cut');
    record('commercial start cuts to the ad input', !!c && c.Input === 'Ad Slate' && r && r.data.ok, { cut: c, reply: r && r.data });
    i = fake.calls.length;
    rp = waitType('obs-result');
    send('obs_toggle_commercial', {});
    r = await rp;
    c = await callSince(i, (x) => x.fn === 'Cut');
    record('commercial end cuts back to program', !!c && c.Input === 'Game Capture', { cut: c, reply: r && r.data });

    // Save replay → vMix replay event.
    i = fake.calls.length;
    rp = waitType('obs-result');
    send('obs_save_replay', {});
    r = await rp;
    c = await callSince(i, (x) => x.fn === 'ReplayMarkLast');
    record('save replay marks a vMix replay event', !!c && c.Value === '10' && r && r.data.ok, { call: c, reply: r && r.data && r.data.message });

    // Card "+": Add to vMix.
    i = fake.calls.length;
    rp = waitType('obs-ensure-result', 8000);
    send('obs_add_overlay', { sourceName: 'NE E2E Probe', url: 'http://localhost:3000/countdown.html', width: 1920, height: 1080 });
    r = await rp;
    record('Add to vMix creates a named browser input', !!r && r.data.ok && fake.inputs.some((x) => x.title === 'NE E2E Probe'), r && r.data.message);

    // Build show inputs: live.html + gfx.html core, graphics on overlay 4, scoreboard on the game input.
    send('set_obs_settings', { enabled: orig.obs.enabled, autoSwitch: orig.obs.autoSwitch, scenes: { inGame: 'Game Capture' } });
    await waitFor(() => latest.obs.scenes && latest.obs.scenes.inGame === 'Game Capture');
    i = fake.calls.length;
    rp = waitType('obs-ensure-result', 20000);
    send('obs_build_show_scenes', { base: 'http://localhost:3000' });
    r = await rp;
    const adds = fake.calls.slice(i).filter((x) => x.fn === 'AddInput').map((x) => x.Value);
    const gfx = fake.inputs.find((x) => x.title === 'NE Graphics');
    const layer = fake.calls.slice(i).find((x) => x.fn === 'SetMultiViewOverlay');
    record('build adds live.html + gfx.html as inputs', adds.includes('Browser|http://localhost:3000/live.html') && adds.includes('Browser|http://localhost:3000/gfx.html'), adds);
    record('no gfx.html graphic added separately', !adds.some((a) => /countdown|winner|bracket|intro/.test(a)), adds);
    record('NE Graphics on overlay channel 4 (top)', !!gfx && String(fake.overlays[4]) === String(gfx.number), fake.overlays);
    record('NE Scoreboard layered onto the game input', !!layer && layer.Input === 'Game Capture' && layer.Value === '1,NE Scoreboard', layer);
    record('build reply ok', !!r && r.data.ok, r && r.data.message);
  } catch (e) {
    console.error('[vmix-e2e] fatal:', e && e.stack || e);
    exit = 1;
  } finally {
    // Restore everything changed above.
    const restoreScenes = { ...orig.obs.scenes };
    for (const k of ['commercial', 'inGame', 'casters', 'replay']) if (!(k in restoreScenes)) restoreScenes[k] = '';
    send('set_break', { visible: !!orig.brk.visible, thenScene: orig.brk.thenScene || '', endsAt: orig.brk.endsAt || null });
    send('set_obs_settings', { enabled: orig.obs.enabled, autoSwitch: orig.obs.autoSwitch, autoReplayOnGoal: orig.obs.autoReplayOnGoal, scenes: restoreScenes });
    send('set_switcher_target', { target: orig.target });
    send('set_vmix_settings', orig.vmix);
    await new Promise((r) => setTimeout(r, 1200));
    const back = latest;
    const ok = back.switcher.target === orig.target && !!back.vmix.enabled === orig.vmix.enabled
      && JSON.stringify(Object.fromEntries(Object.entries(back.obs.scenes || {}).filter(([, v]) => v))) === JSON.stringify(Object.fromEntries(Object.entries(orig.obs.scenes).filter(([, v]) => v)));
    console.log(`${ok ? 'ok   ' : 'WARN '} restore switcher/vMix/scene map -> ${JSON.stringify({ target: back.switcher.target, vmix: back.vmix.enabled })}`);
    const passed = results.filter(Boolean).length;
    console.log(`\n[vmix-e2e] ${passed}/${results.length} passed`);
    ws.close(); server.close();
    process.exit(exit || (passed === results.length ? 0 : 1));
  }
})();
