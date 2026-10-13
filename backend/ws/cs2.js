'use strict';
// CS2 (setup, observer, radar, cinematic) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_csHudSpec).
let
  broadcastCsgo, broadcastFullState, cleanRadarLayout, cs2Cinematic, cs2Netcon, cs2Setup,
  csCinematicApply, electronApi, installGsiConfig, installSpectatorCfg, saveAppState, state;
let ctx;

const handlers = {
  // ── CS2 one-click setup ─────────────────────────────────────────────
  // Finds CS2 through Steam (or uses the folder given), writes the game-data config and the clean
  // observer config, and starts the console link. Never edits Steam settings or autoexec.cfg.
  csgo_setup(msg, ws) {
    (async () => {
      const reply = (data) => { try { ws.send(JSON.stringify({ type: 'csgo-result', data })); } catch (_) {} };
      try {
        let dir = cs2Setup.resolveCfgDir(msg.data?.path || '') || cs2Setup.resolveCfgDir(state.csgo.cfgPath || '');
        if (!dir) dir = (await cs2Setup.findCfgDir()).cfgDir;
        if (!dir) { reply({ ok: false, setup: true, message: 'CS2 was not found in your Steam libraries. Pick its folder under "Use a different folder".' }); return; }
        installGsiConfig(dir);
        installSpectatorCfg(dir);
        csCinematicApply();
        reply({ ok: true, setup: true, dir, message: 'CS2 is set up. Restart CS2 if it is open, then press Launch CS2 for observing.' });
      } catch (e) { reply({ ok: false, setup: true, message: e.message }); }
    })();
  },

  csgo_launch_observer(msg, ws) {
    (async () => {
      // The observer cfg must be in place before the game execs it at startup. No saved folder
      // yet (Set up CS2 never pressed): find CS2 through Steam, like Set up does.
      try {
        let dir = cs2Setup.resolveCfgDir(state.csgo.cfgPath || '');
        if (!dir) { dir = (await cs2Setup.findCfgDir()).cfgDir; if (dir) installGsiConfig(dir); }
        installSpectatorCfg(dir || '');
      } catch (e) { console.warn('[CS2] observer cfg:', e.message); }
      // Restart asked for (the panel confirmed it): close CS2 first, then wait for it to exit.
      if (msg.data && msg.data.restart && await cs2Setup.isCs2Running()) {
        await cs2Setup.closeCs2();
      }
      const r = await cs2Setup.launch(state.csgo.cinematic.port);
      if (r.url) { try { electronApi.shell.openExternal(r.url); } catch (e) { console.warn('[CS2] launch:', e.message); } }
      console.log('[CS2] launch for observing:', r.how || 'not started', r.message);
      csCinematicApply();
      try { ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: r.ok, message: r.message, running: !!r.running } })); } catch (_) {}
    })();
  },

  csgo_auto_hud(msg, ws) {
    state.csgo.autoHud = msg.data?.enabled !== false;
    ctx._csHudSpec = null;
    csCinematicApply();
    saveAppState();
    broadcastCsgo();
  },

  csgo_radar_layout(msg, ws) {
    state.csgo.radarLayout = cleanRadarLayout(msg.data && msg.data.layout);
    saveAppState();
    broadcastCsgo();
  },

  csgo_observer_assist(msg, ws) {
    state.csgo.observerAssist = msg.data?.enabled !== false;
    saveAppState();
    broadcastCsgo();
  },

  install_csgo_gsi(msg, ws) {
    try {
      const file = installGsiConfig(msg.data?.path || '');
      ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: true, message: `✓ Installed GSI config: ${file}. Restart CS2 if it was running.` } }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: false, message: e.message } }));
    }
  },

  install_spectator_cfg(msg, ws) {
    try {
      const file = installSpectatorCfg(msg.data?.path || '');
      ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: true, message: `✓ Installed spectator HUD config: ${file}. In CS2 console run:  exec cs2-spectator  (F9 toggles).` } }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: false, message: e.message } }));
    }
  },

  csgo_show_history(msg, ws) {
    state.csgo.showHistory = !!(msg.data && msg.data.visible);
    saveAppState();
    broadcastFullState();
    broadcastCsgo();
  },

  csgo_auto_winner(msg, ws) {
    state.csgo.autoWinner = !!(msg.data && msg.data.enabled);
    saveAppState();
    broadcastFullState();
  },

  csgo_pro_layout(msg, ws) {
    state.csgo.proLayout = (msg.data && msg.data.layout) === 'stacked' ? 'stacked' : 'wide';
    saveAppState();
    broadcastFullState();
    broadcastCsgo();
  },

  csgo_cinematic_set(msg, ws) {
    const d = msg.data || {};
    if (typeof d.enabled === 'boolean') state.csgo.cinematic.enabled = d.enabled;
    if (Number(d.port) > 0 && Number(d.port) < 65536) state.csgo.cinematic.port = Math.round(Number(d.port));
    csCinematicApply();
    saveAppState();
    broadcastCsgo();
  },

  // Capture CS2's current camera as the start ('from') or end ('to') pose of shot 0/1 on a map.
  csgo_cinematic_capture(msg, ws) {
    const d = msg.data || {};
    const map = String(d.map || (state.csgo.map && state.csgo.map.name) || '').slice(0, 40);
    const idx = Number(d.idx) === 1 ? 1 : 0;
    const which = d.which === 'to' ? 'to' : 'from';
    const reply = (ok, message) => { try { ws.send(JSON.stringify({ type: 'csgo-cinematic-result', data: { ok, message } })); } catch (e) {} };
    if (!map) { reply(false, 'No map loaded in CS2 yet.'); return; }
    if (!cs2Netcon.isConnected()) { reply(false, 'Not connected to the CS2 console. Add -netconport ' + state.csgo.cinematic.port + ' to CS2 launch options.'); return; }
    cs2Cinematic.capturePose().then((pose) => {
      if (!pose) return reply(false, 'CS2 did not answer getpos. Free-roam the spectator camera, then try again.');
      const shots = state.csgo.cinematic.shots;
      const list = Array.isArray(shots[map]) ? shots[map] : (shots[map] = []);
      const cur = list[idx] && list[idx].from ? list[idx] : { name: idx ? 'Shot 2' : 'Shot 1' };
      cur[which] = pose;
      if (!cur.from) cur.from = pose;
      list[idx] = cur;
      saveAppState();
      broadcastCsgo();
      reply(true, 'Saved ' + (which === 'from' ? 'start' : 'end') + ' of shot ' + (idx + 1) + ' on ' + map + '.');
    });
  },

  csgo_cinematic_preview(msg, ws) {
    const d = msg.data || {};
    const map = String(d.map || (state.csgo.map && state.csgo.map.name) || '');
    const idx = Number(d.idx) === 1 ? 1 : 0;
    const ok = cs2Cinematic.preview(map, idx);
    try { ws.send(JSON.stringify({ type: 'csgo-cinematic-result', data: { ok, message: ok ? 'Playing shot ' + (idx + 1) + ' in CS2.' : 'Cannot preview: not connected to CS2, or no shot for this map.' } })); } catch (e) {}
  },

  // Drop a captured shot so the map falls back to its starter shot.
  csgo_cinematic_reset(msg, ws) {
    const d = msg.data || {};
    const map = String(d.map || (state.csgo.map && state.csgo.map.name) || '');
    const list = state.csgo.cinematic.shots[map];
    if (Array.isArray(list)) { list[Number(d.idx) === 1 ? 1 : 0] = null; if (!list.some(Boolean)) delete state.csgo.cinematic.shots[map]; }
    saveAppState();
    broadcastCsgo();
  },

  csgo_radar_mode(msg, ws) {
    state.csgo.builtinRadar = !!(msg.data && msg.data.builtin);
    saveAppState();
    broadcastFullState();
    broadcastCsgo();
  },
};

module.exports = function createCs2Handlers(c) {
  ctx = c;
  ({
    broadcastCsgo, broadcastFullState, cleanRadarLayout, cs2Cinematic, cs2Netcon, cs2Setup,
    csCinematicApply, electronApi, installGsiConfig, installSpectatorCfg, saveAppState, state
  } = c);
  return handlers;
};
