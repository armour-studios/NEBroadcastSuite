'use strict';
// Dota 2 — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_dotaFirstPick).
let
  DOTA_GSI_TOKEN, HTTP_PORT, broadcastFullState, cs2Setup, dotaGsi, electronApi, saveAppState,
  state;
let ctx;

const handlers = {
  // ── CS2 GSI install ──────────────────────────────────────────────────
  // Dota 2: one-click setup finds Dota through Steam and writes the GSI cfg; a typed path overrides.
  dota_setup(msg, ws) {
    (async () => {
      const reply = (ok, message, extra) => { try { ws.send(JSON.stringify({ type: 'dota-result', data: { ok, message, ...(extra || {}) } })); } catch (_) {} };
      try {
        const typed = String((msg.data && msg.data.path) || '').trim();
        const dir = typed ? dotaGsi.resolveGsiDir(typed) : await dotaGsi.findGsiDir(cs2Setup.steamRoots, cs2Setup.parseLibraryFolders);
        const file = dotaGsi.install(dir, HTTP_PORT, DOTA_GSI_TOKEN);
        state.dota.cfgPath = dir;
        saveAppState(); broadcastFullState();
        reply(true, 'Installed ' + file + '. Start Dota 2 with the -gamestateintegration launch option (Launch Dota 2 does it for you), then spectate or observe a match.');
      } catch (e) { reply(false, e.message); }
    })();
  },

  dota_launch(msg, ws) {
    try { electronApi.shell.openExternal(dotaGsi.launchUrl()); } catch (e) { console.warn('[Dota] launch:', e.message); }
  },

  dota_settings(msg, ws) {
    const d = msg.data || {};
    if (typeof d.autoDraft === 'boolean') state.dota.autoDraft = d.autoDraft;
    if (d.radiantSide === 'a' || d.radiantSide === 'b') { state.dota.radiantSide = d.radiantSide; ctx._dotaFirstPick = ''; }
    if (typeof d.showBoard === 'boolean') state.dota.showBoard = d.showBoard;
    saveAppState(); broadcastFullState();
  },
};

module.exports = function createDotaHandlers(c) {
  ctx = c;
  ({
    DOTA_GSI_TOKEN, HTTP_PORT, broadcastFullState, cs2Setup, dotaGsi, electronApi,
    saveAppState, state
  } = c);
  return handlers;
};
