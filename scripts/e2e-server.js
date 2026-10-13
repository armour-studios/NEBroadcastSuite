'use strict';
// End-to-end against a REAL server.js, isolated from the producer's running app: its own ports
// (NE_HTTP_PORT / NE_WS_PORT), its own throwaway userData folder, and a fake Streamlabs Desktop.
// Drives it over the same WebSocket the control panel uses and checks state, disk and HTTP.
//   Run:  node_modules/electron/dist/electron scripts/e2e-server.js
//   NE_E2E_SERVER_PROCESS=1 runs the server in its own utility process (backend/server-host.js),
//   the way the app does, and adds checks for that process: secrets, crash restart, clean stop.
// Never talks to a real OBS, Streamlabs, Twitch or start.gg.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.NE_HTTP_PORT = process.env.NE_HTTP_PORT || '3170';
process.env.NE_WS_PORT = process.env.NE_WS_PORT || '3171';
// Seat-helper listener: loopback only in tests (no firewall prompt), on its own spare port.
process.env.NE_LAN_AGENT_HOST = '127.0.0.1';
process.env.NE_LAN_AGENT_PORT = process.env.NE_LAN_AGENT_PORT || '3175';
const HTTP = Number(process.env.NE_HTTP_PORT), WSP = Number(process.env.NE_WS_PORT);
const SERVER_PROCESS = process.env.NE_E2E_SERVER_PROCESS === '1';
let host = null;
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-e2e-'));
app.setPath('userData', TMP);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const WS = require(path.join(ROOT, 'node_modules', 'ws'));
const { fakeStreamlabs, TOKEN } = require(path.join(ROOT, 'test', 'fixtures', 'fake-streamlabs'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

// ── panel-side socket: keeps a merged view of state + every reply ───────────
let sock, state = {}, clips = null;
const replies = [];
function connect() {
  return new Promise((resolve, reject) => {
    sock = new WS('ws://127.0.0.1:' + WSP);
    sock.on('open', resolve);
    sock.on('error', reject);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
      if (m.type === 'full_state' && m.data) Object.assign(state, m.data);
      else if (m.type === 'clips_update') clips = m.data;
      else replies.push(m);
    });
  });
}
const send = (type, data) => sock.send(JSON.stringify({ type, data }));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await wait(100); }
  return false;
}
function request(method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: HTTP, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, text: b }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

app.whenReady().then(async () => {
  console.log('e2e-server: userData ' + TMP + ', ports ' + HTTP + '/' + WSP + (SERVER_PROCESS ? ', server in its own process' : ''));
  if (SERVER_PROCESS) host = require(path.join(ROOT, 'backend', 'server-host')).startServerProcess(ROOT);
  else require(path.join(ROOT, 'server.js')).start(ROOT);
  await wait(4500);
  try {
    await connect();
  } catch (e) { console.log('FAIL could not connect to the bridge: ' + e.message); app.exit(1); return; }

  console.log('\nboot');
  check('full_state arrives', await until(() => state.teams && state.obs));
  check('streaming app defaults to OBS', state.obs && state.obs.app === 'obs', state.obs && state.obs.app);

  console.log('\nmatch');
  send('set_team_abbr', { side: 'blue', abbr: 'FRT' });
  send('set_team_abbr', { side: 'orange', abbr: 'EMB' });
  check('team tags saved', await until(() => state.teams.blue.abbr === 'FRT' && state.teams.orange.abbr === 'EMB'));
  const g0 = state.series ? state.series.blue : 0;
  send('adjust_series', { side: 'blue', delta: 1 });
  check('series +1 advances the game number', await until(() => state.series.blue === g0 + 1 && state.game.number === g0 + 2), JSON.stringify([state.series, state.game]));

  console.log('\nmap pool');
  send('reset_series', {});
  await until(() => state.series.blue === 0 && state.series.orange === 0 && state.game.number === 1);
  send('set_veto', { visible: false, title: 'Map Pool', maps: [
    { name: "King's Row", mode: 'hybrid', winner: 'a', score: { a: 3, b: 2 } },
    { name: 'Colosseo', mode: 'push', winner: 'draw', score: { a: 1, b: 1 } },
    { name: 'Ilios', mode: 'control' },
  ] });
  check('a draw is stored on the map', await until(() => state.veto && state.veto.maps[1] && state.veto.maps[1].winner === 'draw'));
  send('adjust_series', { side: 'blue', delta: 1 });
  check('after a win and a draw the next map is game 3', await until(() => state.series.blue === 1 && state.game.number === 3), JSON.stringify([state.series, state.game]));
  send('adjust_series', { side: 'orange', delta: 1 });
  check('the next win moves to game 4, not back to 3', await until(() => state.series.orange === 1 && state.game.number === 4), JSON.stringify([state.series, state.game]));
  send('ow_ban_hero', { mapIdx: 0, side: 'a', slot: 0, hero: 'Sombra' });
  send('ow_ban_hero', { mapIdx: 1, side: 'b', slot: 0, hero: 'Doctrine' });
  const ban = (i, side) => (((state.owMatch && state.owMatch.bansByMap) || [])[i] || {})[side];
  check('hero ban roles come from the game data (Sombra = support)', await until(() => ban(0, 'a') && ban(0, 'a')[0].role.toLowerCase() === 'support'), JSON.stringify(ban(0, 'a')));
  check('Doctrine is a known support', await until(() => ban(1, 'b') && ban(1, 'b')[0].role.toLowerCase() === 'support'), JSON.stringify(ban(1, 'b')));
  send('ow_move_map', { from: 0, to: 1 });
  check('moving a map card carries its bans', await until(() => ban(1, 'a') && ban(1, 'a')[0].hero === 'Sombra' && ban(0, 'b') && ban(0, 'b')[0].hero === 'Doctrine'), JSON.stringify(state.owMatch && state.owMatch.bansByMap));
  send('ow_remove_map', { idx: 0 });
  check('removing a map drops its bans and shifts the rest up', await until(() => ban(0, 'a') && ban(0, 'a')[0].hero === 'Sombra' && !(ban(0, 'b') && ban(0, 'b')[0] && ban(0, 'b')[0].hero)), JSON.stringify(state.owMatch && state.owMatch.bansByMap));
  send('reset_series', {});
  check('a new series clears results, draws and bans but keeps the maps', await until(() => state.game.number === 1 && state.veto.maps.length === 3 && state.veto.maps.every((m) => !m.winner) && !(ban(0, 'a') && ban(0, 'a')[0] && ban(0, 'a')[0].hero)), JSON.stringify([state.game, state.veto.maps.map((m) => m.winner)]));

  console.log('\nplayer cams');
  send('save_facecam', { name: 'Beast', platformId: 'Unknown|0|0', link: 'https://vdo.ninja/?view=beast' });
  send('save_facecam', { name: 'Zen', platformId: 'Steam|76561198000000001|0', link: 'https://vdo.ninja/?view=zen' });
  send('save_facecam', { name: 'Rise', platformId: '0', link: 'https://vdo.ninja/?view=rise' });
  const fc = (n) => (state.facecams || []).find((f) => f.name === n);
  check('a placeholder id (bot / hidden account) is not saved', await until(() => fc('Beast') && fc('Beast').platformId === '' && fc('Rise') && fc('Rise').platformId === ''), JSON.stringify(state.facecams));
  check('a full RL PrimaryId is saved as the bare account id', fc('Zen') && fc('Zen').platformId === '76561198000000001', fc('Zen') && fc('Zen').platformId);
  send('set_facecams_enabled', { enabled: false });
  check('the Show on HUD switch reaches state', await until(() => state.facecamsEnabled === false));
  send('set_facecams_enabled', { enabled: true });
  await until(() => state.facecamsEnabled === true);

  console.log('\nLAN seats');
  send('lan_seats_set', { enabled: true, perSide: 3 });
  const seat = (id) => ((state.lanSeats && state.lanSeats.seats) || []).find((x) => x.id === id);
  check('turning seats on makes 6 seats with their own links', await until(() => state.lanSeats && state.lanSeats.seats.length === 6 && seat('a1').joinUrl.includes('push=seat_a1') && seat('b1').viewUrl.includes('view=seat_b1')), JSON.stringify(state.lanSeats && state.lanSeats.seats && state.lanSeats.seats[0]));
  const a1Link = seat('a1').viewUrl;
  send('lan_seats_set', { names: { a1: 'PC 1' } });
  check('seat links stay the same between changes', await until(() => seat('a1').label === 'PC 1' && seat('a1').viewUrl === a1Link));
  send('lan_seat_assign', { seatId: 'a2', name: 'Zen' });
  check('seating a player gives them the seat camera', await until(() => fc('Zen') && fc('Zen').link === seat('a2').viewUrl && fc('Zen').seatId === 'a2'), JSON.stringify(fc('Zen')));
  send('lan_seat_assign', { seatId: 'b1', name: 'Zen' });
  check('moving seats frees the old seat and follows the new one', await until(() => !state.lanSeats.assign.a2 && state.lanSeats.assign.b1 === 'Zen' && fc('Zen').link === seat('b1').viewUrl));
  send('lan_seat_link', { seatId: 'b1', link: 'https://capture.example/seat-b1' });
  check('a custom seat link carries to whoever sits there', await until(() => fc('Zen') && fc('Zen').link === 'https://capture.example/seat-b1'));
  const stateFile = path.join(TMP, 'data', 'state.json');
  let diskLan = {};
  await until(() => { diskLan = (JSON.parse(fs.readFileSync(stateFile, 'utf8')).lanSeats) || {}; return diskLan.links && diskLan.links.b1; }, 6000);
  check('seats are saved without the derived seat list', diskLan.enabled === true && diskLan.rooms && diskLan.rooms.a && !diskLan.seats, JSON.stringify(Object.keys(diskLan)));
  send('lan_seats_clear', {});
  check('clearing seats for the next match removes the seat cameras', await until(() => Object.keys(state.lanSeats.assign).length === 0 && !(state.facecams || []).some((f) => f.seatId)));

  // Seat helper, for real: a fake Rocket League Stats API (the seat PC's own game) reports "Zen" as
  // the local player; the downloaded helper runs in PowerShell and the server seats Zen at A1.
  send('lan_seats_agent', { enabled: true, port: Number(process.env.NE_LAN_AGENT_PORT) });
  check('seat helpers start the LAN listener', await until(() => state.lanSeats.agent.enabled && state.lanSeats.agent.token && !state.lanSeats.agentError), state.lanSeats.agentError);
  const bad = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: Number(process.env.NE_LAN_AGENT_PORT), path: '/seat', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve(0)); r.end(JSON.stringify({ token: 'wrong'.padEnd(32, '0'), seat: 'a1', name: 'Hacker' }));
  });
  check('a check-in without the token is refused', bad === 403 && !state.lanSeats.assign.a1, 'status ' + bad);
  const helper = await request('GET', '/api/lan-seats/helper?seat=a1');
  const enc = (helper.text.match(/-EncodedCommand (\S+)/) || [])[1];
  check('each seat gets a double-click helper', helper.status === 200 && !!enc && helper.text.startsWith('@echo off') && helper.text.length < 8000, 'status ' + helper.status + ', length ' + (helper.text || '').length);
  if (enc) {
    const net = require('net');
    const fakeRL = net.createServer((sock) => {
      const tick = (name, replay) => sock.write(JSON.stringify({ Event: 'UpdateState', Data: JSON.stringify({ Players: [{ Name: 'Zen', TeamNum: 0 }, { Name: 'Vatira', TeamNum: 1 }], Game: { bReplay: !!replay, bHasTarget: true, Target: { Name: name, TeamNum: 0 } } }) }) + '\n');
      let n = 0; const iv = setInterval(() => { n++; tick(n < 4 ? 'Vatira' : 'Zen', n < 4); if (n > 40) clearInterval(iv); }, 200);
      sock.on('error', () => clearInterval(iv)); sock.on('close', () => clearInterval(iv));
    });
    await new Promise((r) => fakeRL.listen(0, '127.0.0.1', r));
    const script = Buffer.from(enc, 'base64').toString('utf16le').replace(/\$StatsPort = \d+/, '$StatsPort = ' + fakeRL.address().port);
    const ps1 = path.join(TMP, 'helper-test.ps1');
    fs.writeFileSync(ps1, script);
    const child = require('child_process').spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'ignore', windowsHide: true });
    check('the helper seats the player its own game reports (and ignores goal replays)', await until(() => state.lanSeats.assign.a1 === 'Zen' && state.lanSeats.seen.a1 && state.lanSeats.seen.a1.name === 'Zen', 20000), JSON.stringify({ assign: state.lanSeats.assign, seen: state.lanSeats.seen }));
    check('the seated player gets the seat camera', fc('Zen') && fc('Zen').link === seat('a1').viewUrl);
    try { child.kill(); } catch (e) {}
    fakeRL.close();
  }
  send('lan_seats_agent', { enabled: false });
  send('lan_seats_set', { enabled: false });
  await until(() => state.lanSeats.enabled === false);

  console.log('\nbreak timer');
  send('set_break', { visible: true, seconds: 300 });
  check('break goes on air with a 5 minute countdown', await until(() => state.breakScreen && state.breakScreen.visible && Math.abs(state.breakScreen.endsAt - Date.now() - 300000) < 5000));
  send('set_break', { seconds: 240 });
  check('the dock\'s -1 min keeps it on air', await until(() => state.breakScreen.visible && Math.abs(state.breakScreen.endsAt - Date.now() - 240000) < 5000));
  send('set_break', { visible: false });
  check('break comes off air', await until(() => !state.breakScreen.visible));

  console.log('\nsecurity');
  const evil = await request('GET', '/api/time', null, { Origin: 'https://evil.example' });
  check('foreign web origin is refused', evil.status === 403, 'status ' + evil.status);
  const own = await request('GET', '/api/time');
  check('local caller is served', own.status === 200, 'status ' + own.status);

  console.log('\nstreamlabs');
  const sl = fakeStreamlabs({ port: 3159 });
  await new Promise((r) => sl.wss.once('listening', r));
  send('set_obs_settings', { enabled: true, app: 'streamlabs', slobsUrl: 'ws://127.0.0.1:3159', slobsToken: TOKEN });
  check('connects to Streamlabs', await until(() => state.obs.connected && state.obs.app === 'streamlabs', 8000), JSON.stringify({ c: state.obs.connected, e: state.obs.lastError }));
  check('scene list comes from Streamlabs', await until(() => (state.obs.availableScenes || []).includes('Break')), JSON.stringify(state.obs.availableScenes));
  check('program scene reported', state.obs.currentScene === 'Main', state.obs.currentScene);
  check('token is not broadcast', !JSON.stringify(state).includes(TOKEN) && state.obs.hasSlobsToken === true);
  send('obs_switch_scene', { sceneName: 'Break' });
  check('scene cut reaches Streamlabs', await until(() => sl.activeName() === 'Break' && state.obs.currentScene === 'Break'), JSON.stringify({ slobs: sl.activeName(), app: state.obs.currentScene }));
  replies.length = 0;
  send('obs_add_overlay', { sourceName: 'NE Graphics', url: 'http://localhost:' + HTTP + '/gfx.html', width: 1920, height: 1080 });
  const addOk = await until(() => replies.some((m) => m.type === 'obs-ensure-result'), 8000);
  const addMsg = (replies.find((m) => m.type === 'obs-ensure-result') || {}).data || {};
  check('Add to OBS works on Streamlabs', addOk && addMsg.ok, addMsg.message);
  check('overlay is the top layer', sl.order('Break')[0] === 'NE Graphics', JSON.stringify(sl.order('Break')));
  await wait(600);
  const disk = fs.readFileSync(path.join(TMP, 'data', 'state.json'), 'utf8');
  check('app choice saved to disk', /"app":\s*"streamlabs"/.test(disk));
  check('token is encrypted on disk', disk.includes('slobsToken') && !disk.includes('"' + TOKEN + '"'));
  send('set_obs_settings', { enabled: false, app: 'obs' });
  check('switching back to OBS drops Streamlabs', await until(() => !state.obs.connected && state.obs.app === 'obs'));
  sl.close();

  console.log('\nreplays');
  const src = path.join(TMP, 'replay-test.mp4');
  fs.writeFileSync(src, Buffer.alloc(2048, 1));
  const imp = await request('POST', '/api/clips/import-file', { filePath: src, label: 'Goal' });
  const clip = imp.json && imp.json.clip;
  check('import puts a moment in the library', imp.status === 200 && clip && clip.folder === 'replays', imp.text && imp.text.slice(0, 160));
  if (clip) {
    send('clip_copy_folder', { id: clip.id, folder: 'highlights' });
    check('star copies it to Highlights with copiedFrom', await until(() => clips && clips.library.some((c) => c.folder === 'highlights' && c.copiedFrom === clip.id)));
    const copy = clips.library.find((c) => c.copiedFrom === clip.id);
    send('clip_remove', { id: copy.id });
    check('unstar removes only the copy', await until(() => !clips.library.some((c) => c.id === copy.id) && clips.library.some((c) => c.id === clip.id)));
  }

  console.log('\ncontrol API (/api/v1)');
  send('competition_api_key', {});
  check('panel gets an API key', await until(() => replies.some((m) => m.type === 'competition_result' && m.data && m.data.key), 4000));
  const key = ((replies.find((m) => m.type === 'competition_result' && m.data && m.data.key) || {}).data || {}).key;
  const auth = { Authorization: 'Bearer ' + key };
  const noKey = await request('POST', '/api/v1/control/score', { side: 'blue', delta: 1 });
  check('control without a key is refused', noKey.status === 401, String(noKey.status));
  const list = await request('GET', '/api/v1/control', null, auth);
  check('action list is self-describing', list.status === 200 && list.json && list.json.actions.some((a) => a.action === 'score' && a.body), list.text && list.text.slice(0, 160));
  await request('POST', '/api/v1/control/series-reset', {}, auth);
  await request('POST', '/api/v1/control/best-of', { value: 5 }, auth);
  const sc = await request('POST', '/api/v1/control/score', { side: 'orange', delta: 1 }, auth);
  check('score adds a game win', sc.status === 200 && sc.json.state.teams.orange.score === 1 && sc.json.state.gameNumber === 2, sc.text && sc.text.slice(0, 200));
  const tm = await request('POST', '/api/v1/control/team', { side: 'blue', name: 'Api Testers', color: '#112233' }, auth);
  check('team goes on a side', tm.status === 200 && tm.json.state.teams.blue.name.toUpperCase() === 'API TESTERS', tm.text && tm.text.slice(0, 200));
  const badTeam = await request('POST', '/api/v1/control/team', { side: 'left' }, auth);
  check('a bad body is a 400 that says what it wants', badTeam.status === 400 && /side/.test(badTeam.json.error), badTeam.text);
  const gx = await request('POST', '/api/v1/control/graphic', { key: 'standings' }, auth);
  check('graphic goes on air', gx.status === 200 && gx.json.state.graphic === 'standings', gx.text && gx.text.slice(0, 200));
  const br = await request('POST', '/api/v1/control/break', { visible: true, title: 'BACK SOON', seconds: 300 }, auth);
  check('break screen with a countdown', br.status === 200 && br.json.state.break.visible && br.json.state.break.endsAt > Date.now(), br.text && br.text.slice(0, 200));
  const st = await request('GET', '/api/v1/state', null, auth);
  check('state lists graphics and brand kits', st.status === 200 && Array.isArray(st.json.state.graphics) && st.json.state.graphics.includes('standings') && Array.isArray(st.json.state.brandKits));
  const unk = await request('POST', '/api/v1/control/nuke', {}, auth);
  check('unknown action is a 404', unk.status === 404);
  await request('POST', '/api/v1/control/break', { visible: false }, auth);
  await request('POST', '/api/v1/control/graphic', { key: null }, auth);

  console.log('\ndesk camera links');
  send('desk_cam_link', { slot: 4 });
  check('an empty seat says so', await until(() => replies.some((m) => m.type === 'desk-cam-link' && m.data && m.data.ok === false && /Nobody/.test(m.data.error))));
  send('save_caster_to_library', { name: 'E2E Caster', kind: 'caster', deskSlot: 1 });
  await until(() => ((state.casters && state.casters.lineup) || []).some((e) => Number(e.slot) === 1 && e.libraryId), 4000);
  send('desk_cam_link', { slot: 1 });
  const camOk = await until(() => replies.some((m) => m.type === 'desk-cam-link' && m.data && m.data.slot === 1), 4000);
  const cam = ((replies.filter((m) => m.type === 'desk-cam-link' && m.data && m.data.slot === 1).pop()) || {}).data || {};
  check('a filled seat gets a join link into the desk room', camOk && /push=/.test(cam.joinUrl || '') && /view=/.test(cam.viewUrl || ''), JSON.stringify(cam).slice(0, 200) + ' lineup=' + JSON.stringify((state.casters || {}).lineup).slice(0, 200));
  check('the join link never rides the state broadcast', !JSON.stringify(state.casters || {}).includes(cam.joinUrl || '@@none@@'));

  console.log('\ncustom overlays');
  send('custom_overlay_save', { reqId: 'r1', overlay: { name: 'E2E bug', elements: [{ type: 'text', x: 10, y: 10, w: 400, h: 80, text: { bind: 'team.blue.name' } }] } });
  const coOk = await until(() => replies.some((m) => m.type === 'custom-overlay-saved' && m.data && m.data.reqId === 'r1'), 4000);
  const coSaved = ((replies.find((m) => m.type === 'custom-overlay-saved' && m.data && m.data.reqId === 'r1') || {}).data || {});
  check('a layout saves over the WS', coOk && coSaved.ok && coSaved.overlay && coSaved.overlay.id, JSON.stringify(coSaved).slice(0, 160));
  const coId = coSaved.overlay && coSaved.overlay.id;
  check('the list rides the library tier', await until(() => (state.customOverlays || []).some((o) => o.id === coId && o.name === 'E2E bug')));
  check('its change counter rides the live tier', !!(state.customOverlayRevs && state.customOverlayRevs[coId]));
  const coGet = await request('GET', '/api/custom-overlays/' + coId);
  check('OBS can fetch the layout', coGet.status === 200 && coGet.json.overlay.elements.length === 1);
  const coPage = await request('GET', '/custom.html?id=' + coId);
  check('the OBS page is served', coPage.status === 200 && /custom-render\.js/.test(coPage.text));
  const coRender = await request('GET', '/custom-render.js');
  check('the shared renderer is served', coRender.status === 200 && /CustomOverlay/.test(coRender.text));
  send('custom_overlay_delete', { id: coId });
  check('delete removes it everywhere', await until(() => !(state.customOverlays || []).some((o) => o.id === coId) && /^deleted-/.test(String((state.customOverlayRevs || {})[coId] || ''))));   // a tombstone rev so open OBS sources clear themselves
  const coGone = await request('GET', '/api/custom-overlays/' + coId);
  check('a deleted overlay 404s', coGone.status === 404);

  // Work only the main process can do, asked for by the server (directly, or over the process link).
  console.log('\nmain-process services');
  const thumb = await request('GET', '/api/overlay-thumb?file=scorebar.html');
  check('an overlay thumbnail renders offscreen', thumb.status === 200 && String(thumb.text || '').slice(1, 4) === 'PNG', thumb.status);
  send('lol_ocr_displays');
  check('screen capture lists the displays', await until(() => replies.some((m) => m.type === 'lol_ocr_displays' && Array.isArray(m.displays) && m.displays.length > 0)));

  if (SERVER_PROCESS && host.inMainProcess) {
    console.log('\nserver process');
    check('the server runs in its own process (it could not start, so the host fell back to main)', false);
  } else if (SERVER_PROCESS) {
    console.log('\nserver process');
    check('the server runs in its own process', host.pid > 0 && host.pid !== process.pid, host.pid);
    // A new secret is written straight away (enc2:), then in the keychain format once main answers.
    send('set_ballchasing_settings', { apiKey: 'e2e-secret-123' });
    check('a new secret is accepted', await until(() => state.ballchasing && state.ballchasing.hasKey));
    await wait(2500);
    // Crash: the host restarts the server and the bridge comes back.
    const oldPid = host.pid;
    try { process.kill(oldPid); } catch (e) {}
    await wait(5000);
    check('a crashed server process is restarted', host.pid > 0 && host.pid !== oldPid, oldPid + ' -> ' + host.pid);
    state = {};
    let back = false;
    try { await connect(); back = await until(() => state.teams && state.ballchasing); } catch (e) {}
    check('the panel can reconnect after the restart', back);
    check('the secret was saved before the crash', !!(state.ballchasing && state.ballchasing.hasKey));
    try { sock.close(); } catch (e) {}
    await host.shutdown();
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'state.json'), 'utf8')); } catch (e) {}
    check('secrets end up in the keychain format', /^enc:/.test(saved.ballchasingApiKey || ''), String(saved.ballchasingApiKey || '').slice(0, 6));
    check('a clean stop ends the process', host.pid === 0);
    // A fresh start reads the keychain secret back (main decrypts it before the server loads).
    host = require(path.join(ROOT, 'backend', 'server-host')).startServerProcess(ROOT);
    await wait(4500);
    state = {};
    try { await connect(); } catch (e) {}
    check('the secret survives a restart', await until(() => state.ballchasing && state.ballchasing.hasKey));
    try { sock.close(); } catch (e) {}
    await host.shutdown();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { sock.close(); } catch (e) {}
  setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} app.exit(fail ? 1 : 0); }, 300);
});
