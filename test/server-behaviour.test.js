// node test/server-behaviour.test.js
// Behaviour, not source text: boots the REAL server in plain node (backend/electron-api.js node
// mode, NE_USERDATA = a temp folder) on spare ports, sends real panel messages handled by each
// backend/ws/ module and checks the state the server broadcasts back, then calls routes served by
// the backend/http/ modules. This is what proves the split modules are wired to live server state
// (their bindings, getters and setters), which no text check can.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-behaviour-'));
process.env.NE_USERDATA = TMP;
process.env.NE_HTTP_PORT = '3320';
process.env.NE_WS_PORT = '3321';
process.env.NE_LAN_AGENT_HOST = '127.0.0.1';
process.env.NE_LAN_AGENT_PORT = '3325';
const HTTP = 3320, WSP = 3321;
const ROOT = path.join(__dirname, '..');
const WS = require('ws');

let pass = 0, fail = 0;
const check = (name, okay, detail) => { if (okay) pass++; else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await wait(50); } return false; }
function get(p) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: HTTP, path: p }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); })
      .on('error', (e) => resolve({ status: 0, text: e.message }));
  });
}

const quiet = [console.log, console.warn, console.error];
const serverErrors = [];
console.log = () => {}; console.warn = () => {};
console.error = (...a) => serverErrors.push(a.map(String).join(' '));
const server = require(path.join(ROOT, 'server.js'));
server.start(ROOT);
const restoreConsole = () => { [console.log, console.warn] = quiet; console.error = quiet[2]; };

(async () => {
  try {
    const up = await until(async () => false, 10) || await (async () => { for (let i = 0; i < 100; i++) { const r = await get('/api/time'); if (r.status === 200) return true; await wait(100); } return false; })();
    restoreConsole();
    check('server starts in plain node and answers /api/time', up);

    // panel socket
    const state = {}; const replies = [];
    const sock = new WS('ws://127.0.0.1:' + WSP);
    await new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej); });
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
      if (m.type === 'full_state' && m.data) Object.assign(state, m.data);
      else if (m.type === 'state_update' && m.data) Object.assign(state, m.data);
      else replies.push(m);
    });
    const send = (type, data) => sock.send(JSON.stringify({ type, data }));
    check('the bridge sends the full state on connect', await until(() => state.teams && state.casters));

    // One message per feature module (module in brackets), checked against the broadcast state.
    const CASES = [
      ['show', 'set_event_name', { name: 'Behaviour Cup' }, () => state.eventName === 'Behaviour Cup'],
      ['match', 'set_best_of', { value: 7 }, () => state.bestOf === 7],
      ['teams', 'set_team_abbr', { side: 'blue', abbr: 'BHV' }, () => state.teams.blue.abbr === 'BHV'],
      ['brand', 'set_color_mode', { mode: 'game' }, () => state.colorMode === 'game'],
      ['fgc', 'set_smash_stocks', { side: 'blue', value: 2 }, () => state.smash.blue.stocks === 2],
      ['dota', 'dota_settings', { radiantSide: 'b' }, () => state.dota.radiantSide === 'b'],
      ['cs2', 'csgo_radar_mode', { builtin: true }, () => state.csgo.builtinRadar === true],
      // broadcasts its own lol_hud_mode message (no full-state broadcast)
      ['lol', 'lol_hud_mode', { mode: 'minimal' }, () => replies.some((m) => m.type === 'lol_hud_mode' && m.mode === 'minimal')],
      ['talent', 'add_crew_member', { name: 'Behaviour Ann' }, () => (state.crew || []).some((c) => c.name === 'Behaviour Ann')],
      ['other-games', 'set_r6_settings', { autoScore: true }, () => state.r6 && state.r6.autoScore === true],
      ['cloud', 'cloud_set_autosync', { on: false }, () => state.orgLibrary.autoSync === false],
      ['startgg', 'startgg_set_upcoming_mode', { mode: 'manual' }, () => state.upcoming.source === 'manual'],
      ['chat', 'set_chat_commands', { enabled: false }, () => state.chatCommands.enabled === false],
      ['switcher', 'set_commercial_auto_return', { enabled: true }, () => state.obs.commercialAutoReturn === true],
      ['rocket-league', 'set_worlds_ticker', { on: true }, () => state.worldsTicker === true],
      ['rocket-league (live setter)', 'set_overtime', { label: 'EXTRA TIME' }, () => state.overtime && state.overtime.label === 'EXTRA TIME'],
      ['ballchasing (live getter/setter)', 'set_ballchasing_settings', { apiKey: 'behaviour-key' }, () => state.ballchasing && state.ballchasing.hasKey === true],
      ['flows', 'save_flow', { id: 'behaviour-flow', name: 'Behaviour', enabled: false, trigger: { type: 'manual' }, actions: [] }, () => (state.flows || []).some((f) => f.id === 'behaviour-flow')],
    ];
    for (const [mod, type, data, ok] of CASES) {
      send(type, data);
      check(`${type} (${mod}) changes the broadcast state`, await until(ok), mod);
    }
    // Replies: a handler that answers the sender.
    send('save_game_config', {});
    check('save_game_config (game-config) answers the panel', await until(() => replies.some((m) => /import-export|result/.test(m.type))));
    // Unknown types are logged, never thrown.
    send('no_such_message_type', {});
    await wait(200);
    check('an unknown message type does not break the bridge', sock.readyState === WS.OPEN);

    // Routes from the backend/http/ modules.
    const ROUTES = ['/api/time', '/api/custom-overlays', '/api/brawlhalla/legends', '/api/multiview', '/api/media/list',
      '/api/playerdb', '/api/teamdb', '/api/v1/schema', '/api/roles', '/api/adproof/summary', '/api/stats/matches', '/api/vdo/links'];
    for (const r of ROUTES) {
      const res = await get(r);
      check(`GET ${r} answers 200`, res.status === 200, res.status + ' ' + res.text.slice(0, 120));
    }

    const crashes = serverErrors.filter((e) => /TypeError|ReferenceError|is not a function|is not defined|Cannot read prop/.test(e));
    check('no TypeError / ReferenceError logged by the server', !crashes.length, crashes.slice(0, 3));

    sock.close();
  } catch (e) {
    restoreConsole();
    fail++; console.log('  FAIL ' + (e && e.stack || e));
  }
  console.log = () => {};
  try { server.shutdown(); } catch (e) {}
  restoreConsole();
  console.log(fail ? `server-behaviour: ${fail} failed, ${pass} passed` : `server-behaviour: all ${pass} checks passed`);
  setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} process.exit(fail ? 1 : 0); }, 200);
})();
