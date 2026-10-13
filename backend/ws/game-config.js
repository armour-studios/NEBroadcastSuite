'use strict';
// Custom game content (config, versions) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (gameConfigsVer).
let
  AdmZip, GAMES, GAME_CONFIG_VERSION_CAP, broadcastFullState, dialog, extractAssetsToZip, fsp,
  inflateAssetsFromZip, markGameConfigEdited, normalizeGameConfigFor, saveAppState,
  sendImportExportResult, state;
let ctx;

const handlers = {
  // ── Game Config Builder — one active config per game, extending an EXISTING built-in game
  // (maps/roles/characters). Bundle is built entirely client-side (like the League Editor holds
  // lgLeagues locally); these handlers only fire on Export/Import/Reset. ────────────────────────
  // Save & apply: the edited bundle becomes the active config for its game straight away — no
  // file round-trip (Export is only for sharing a bundle with someone else).
  save_game_config(msg, ws) {
    const d = msg.data || {};
    if (!d.bundle || typeof d.bundle !== 'object' || !GAMES[d.bundle.game]) {
      sendImportExportResult(ws, false, 'Nothing to save — pick a valid game first.', 'game-config');
      return;
    }
    const saved = normalizeGameConfigFor(d.bundle);
    // Drop-map POIs live in the same bundle but are edited elsewhere (set_br_pois); the builder's
    // copy may be stale, so the server's always wins.
    const prevCfg = (state.gameConfigs || {})[saved.game];
    if (prevCfg && prevCfg.pois) saved.pois = prevCfg.pois; else delete saved.pois;
    state.gameConfigs = { ...(state.gameConfigs || {}), [saved.game]: saved }; ctx.gameConfigsVer++;
    markGameConfigEdited(saved.game);
    saveAppState(); broadcastFullState();
    sendImportExportResult(ws, true,
      `Saved — ${saved.maps.length} map(s), ${saved.characters.length} character(s), ${saved.roles.length} role(s) now live for ${GAMES[saved.game].name}.`, 'game-config');
  },

  export_game_config(msg, ws) {
    const d = msg.data || {};
    if (!d.bundle || typeof d.bundle !== 'object' || !GAMES[d.bundle.game]) {
      sendImportExportResult(ws, false, 'Nothing to export — pick a valid game first.', 'game-config');
      return;
    }
    const bundle = normalizeGameConfigFor(d.bundle);
    const zip = new AdmZip();
    const manifest = extractAssetsToZip(bundle, zip);
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    dialog.showSaveDialog({
      title: 'Export Game Config',
      defaultPath: (bundle.configId || bundle.game || 'game-config') + '.zip',
      filters: [{ name: 'NE Game Config', extensions: ['zip'] }]
    }).then(({ canceled, filePath }) => {
      if (canceled || !filePath) { sendImportExportResult(ws, false, 'Export cancelled.', 'game-config'); return; }
      try { zip.writeZip(filePath); sendImportExportResult(ws, true, 'Game config exported.', 'game-config'); }
      catch (e) { sendImportExportResult(ws, false, 'Export failed: ' + e.message, 'game-config'); }
    });
  },

  import_game_config(msg, ws) {
    (async () => {
      try {
        const r = await dialog.showOpenDialog({
          title: 'Import Game Config',
          filters: [{ name: 'NE Game Config', extensions: ['zip'] }],
          properties: ['openFile']
        });
        if (r.canceled || !r.filePaths || !r.filePaths[0]) { sendImportExportResult(ws, false, 'Import cancelled.', 'game-config'); return; }
        const zip = new AdmZip(await fsp.readFile(r.filePaths[0]));
        const manifestEntry = zip.getEntry('manifest.json');
        if (!manifestEntry) throw new Error('Not a valid Game Config file (missing manifest.json).');
        const bundle = inflateAssetsFromZip(JSON.parse(manifestEntry.getData().toString('utf8')), zip);
        if (bundle.format !== 'ne-game-config') throw new Error('Not a valid Game Config file.');
        if (!GAMES[bundle.game]) throw new Error(`"${bundle.game}" isn't one of this app's built-in games — Game Configs can only extend an existing game.`);
        state.gameConfigs = { ...(state.gameConfigs || {}), [bundle.game]: normalizeGameConfigFor(bundle) }; ctx.gameConfigsVer++;
        markGameConfigEdited(bundle.game);
        saveAppState(); broadcastFullState();
        sendImportExportResult(ws, true, `Game config loaded for ${GAMES[bundle.game].name}.`, 'game-config');
      } catch (e) {
        sendImportExportResult(ws, false, 'Import failed: ' + e.message, 'game-config');
      }
    })();
  },

  clear_game_config(msg, ws) {
    const gameId = String((msg.data && msg.data.gameId) || '');
    if (!state.gameConfigs || !state.gameConfigs[gameId]) return;
    const keepPois = state.gameConfigs[gameId].pois;   // drop-map edits are not "custom content"
    state.gameConfigs = { ...state.gameConfigs }; ctx.gameConfigsVer++;
    if (keepPois) state.gameConfigs[gameId] = { format: 'ne-game-config', game: gameId, pois: keepPois };
    else delete state.gameConfigs[gameId];
    state.gameConfigFrom = { ...(state.gameConfigFrom || {}), [gameId]: { name: '', clean: true } };
    saveAppState(); broadcastFullState();
    sendImportExportResult(ws, true, `Reset ${(GAMES[gameId] && GAMES[gameId].name) || gameId} to built-in content.`, 'game-config');
  },

  // ── Custom content versions: snapshot the active content under a name, switch between
  // snapshots (or back to Original), delete one. The active content stays gameConfigs[game].
  game_config_version_save(msg, ws) {
    const gameId = String((msg.data && msg.data.gameId) || '');
    const name = String((msg.data && msg.data.name) || '').trim().slice(0, 60);
    if (!GAMES[gameId] || !name) { sendImportExportResult(ws, false, 'Give the version a name.', 'game-config'); return; }
    const active = (state.gameConfigs || {})[gameId] || normalizeGameConfigFor({ game: gameId });
    const list = ((state.gameConfigVersions || {})[gameId] || []).filter((v) => v.name.toLowerCase() !== name.toLowerCase());
    if (list.length >= GAME_CONFIG_VERSION_CAP) list.pop();
    list.unshift({ name, savedAt: Date.now(), bundle: JSON.parse(JSON.stringify(active)) });
    state.gameConfigVersions = { ...(state.gameConfigVersions || {}), [gameId]: list }; ctx.gameConfigsVer++;
    state.gameConfigFrom = { ...(state.gameConfigFrom || {}), [gameId]: { name, clean: true } };
    saveAppState(); broadcastFullState();
    sendImportExportResult(ws, true, `Saved version "${name}" for ${GAMES[gameId].name}.`, 'game-config');
  },

  game_config_version_load(msg, ws) {
    const gameId = String((msg.data && msg.data.gameId) || '');
    const name = String((msg.data && msg.data.name) || '');
    if (!GAMES[gameId]) return;
    const cfgs = { ...(state.gameConfigs || {}) };
    const keepPois = cfgs[gameId] && cfgs[gameId].pois;   // drop-map edits are not part of a version
    if (!name) {
      if (keepPois) cfgs[gameId] = { format: 'ne-game-config', game: gameId, pois: keepPois };
      else delete cfgs[gameId];
    } else {
      const v = ((state.gameConfigVersions || {})[gameId] || []).find((x) => x.name === name);
      if (!v) { sendImportExportResult(ws, false, `There is no version called "${name}".`, 'game-config'); return; }
      const { pois: _vPois, ...vb } = JSON.parse(JSON.stringify(v.bundle));
      cfgs[gameId] = normalizeGameConfigFor({ ...vb, game: gameId });
      if (keepPois) cfgs[gameId].pois = keepPois;
    }
    state.gameConfigs = cfgs; ctx.gameConfigsVer++;
    state.gameConfigFrom = { ...(state.gameConfigFrom || {}), [gameId]: { name, clean: true } };
    saveAppState(); broadcastFullState();
    sendImportExportResult(ws, true, name ? `Now using "${name}" for ${GAMES[gameId].name}.` : `Now using the original ${GAMES[gameId].name} content.`, 'game-config');
  },

  game_config_version_delete(msg, ws) {
    const gameId = String((msg.data && msg.data.gameId) || '');
    const name = String((msg.data && msg.data.name) || '');
    const list = (state.gameConfigVersions || {})[gameId];
    if (!list || !list.some((v) => v.name === name)) return;
    state.gameConfigVersions = { ...state.gameConfigVersions, [gameId]: list.filter((v) => v.name !== name) }; ctx.gameConfigsVer++;
    const from = (state.gameConfigFrom || {})[gameId];
    if (from && from.name === name) state.gameConfigFrom = { ...state.gameConfigFrom, [gameId]: { name: '', clean: false } };
    saveAppState(); broadcastFullState();
    sendImportExportResult(ws, true, `Deleted version "${name}". The content you are using now is unchanged.`, 'game-config');
  },
};

module.exports = function createGameConfigHandlers(c) {
  ctx = c;
  ({
    AdmZip, GAMES, GAME_CONFIG_VERSION_CAP, broadcastFullState, dialog, extractAssetsToZip,
    fsp, inflateAssetsFromZip, markGameConfigEdited, normalizeGameConfigFor, saveAppState,
    sendImportExportResult, state
  } = c);
  return handlers;
};
