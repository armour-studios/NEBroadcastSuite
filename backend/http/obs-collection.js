'use strict';
// OBS scene collection — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (obsClient, obsSettingsAudit, obsSettingsCurrent).
let
  OBS_AUDIT_LABELS, _electronApp, app, broadcastFullState, dialog, express, fs, fsp,
  generateSceneCollection, obsAuditFile, os, path, saveAppState, state;
let ctx;

module.exports = function registerObsCollectionRoutes(c) {
  ctx = c;
  ({
    OBS_AUDIT_LABELS, _electronApp, app, broadcastFullState, dialog, express, fs, fsp,
    generateSceneCollection, obsAuditFile, os, path, saveAppState, state
  } = c);

  // ─── OBS Scene Collection ────────────────────────────────────────────────────
  // Shared helper: build the collection JSON from current caster state.
  const OBS_COLLECTION_NAME = 'NE Broadcast Suite';   // the OBS collection's identity: never rename (a new name would create a second collection)

  function buildSceneCollection() {
    return generateSceneCollection({ name: OBS_COLLECTION_NAME });
  }

  // Best guess at OBS's scene-collection folder (used only to DEFAULT the save dialog there —
  // the user can browse anywhere, so portable / custom installs still work).
  function guessObsScenesDir() {
    const candidates = process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio', 'basic', 'scenes')]
      : process.platform === 'win32'
        ? [path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obs-studio', 'basic', 'scenes')]
        : [ // linux: native + flatpak + snap
            path.join(os.homedir(), '.config', 'obs-studio', 'basic', 'scenes'),
            path.join(os.homedir(), '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio', 'basic', 'scenes'),
            path.join(os.homedir(), 'snap', 'obs-studio', 'current', '.config', 'obs-studio', 'basic', 'scenes'),
          ];
    return candidates.find(d => { try { return fs.existsSync(d); } catch { return false; } }) || '';
  }

  // OBS scene collections and profiles — used by brand kit editor to populate picker dropdowns.
  app.get('/api/obs/scene-collections', async (req, res) => {
    if (!ctx.obsClient || !ctx.obsClient.isConnected()) return res.json({ ok: true, collections: [], current: '' });
    const r = await ctx.obsClient.call('GetSceneCollectionList').catch(() => null);
    res.json({ ok: true, collections: (r && r.sceneCollections) || [], current: (r && r.currentSceneCollectionName) || '' });
  });
  app.get('/api/obs/profiles', async (req, res) => {
    if (!ctx.obsClient || !ctx.obsClient.isConnected()) return res.json({ ok: true, profiles: [], current: '' });
    const r = await ctx.obsClient.call('GetProfileList').catch(() => null);
    res.json({ ok: true, profiles: (r && r.profiles) || [], current: (r && r.currentProfileName) || '' });
  });

  // What OBS's Settings > Output/Video actually hold right now, plus every change the
  // audit has caught. This is the answer to "OBS reset itself again" that does NOT
  // require the producer to dig out or hand over their OBS log.
  app.get('/api/obs/settings-audit', async (req, res) => {
    let snapshot = ctx.obsSettingsCurrent;
    if (req.query.refresh && ctx.obsClient && ctx.obsClient.isConnected()) {
      const fresh = await ctx.obsClient.readSettings().catch(() => null);
      if (fresh) snapshot = ctx.obsSettingsCurrent = fresh;
    }
    res.json({
      ok: true,
      connected: !!(ctx.obsClient && ctx.obsClient.isConnected()),
      snapshot: snapshot || null,
      labels: OBS_AUDIT_LABELS,
      entries: ctx.obsSettingsAudit.slice().reverse(),   // newest first for display
      logFile: obsAuditFile(),
    });
  });

  // Returns all audio/video inputs currently known to OBS — used to populate flow action dropdowns.
  app.get('/api/obs/inputs', async (req, res) => {
    if (!ctx.obsClient || !ctx.obsClient.isConnected()) return res.json({ inputs: [] });
    const inputs = await ctx.obsClient.getInputList().catch(() => []);
    res.json({ inputs });
  });

  // Screenshot the current OBS program output — used by the in-app preview panel.
  // GetVideoMixFrame (OBS WS 5.3+ / OBS 30+) only. There used to be a fallback to
  // GetSourceScreenshot on the program scene, but that captures the SCENE, not the
  // program mix — so it silently disagreed with what viewers saw during transitions
  // and in studio mode. A preview that is quietly wrong is worse than one that says
  // it is unavailable, so the fallback is gone.
  app.get('/api/obs/screenshot', async (req, res) => {
    if (!ctx.obsClient || !ctx.obsClient.isConnected()) {
      return res.status(503).json({ error: 'OBS not connected' });
    }
    const w = Math.min(Math.max(parseInt(req.query.w) || 960, 160), 1920);
    const h = Math.round(w * 9 / 16);
    const imgOpts = { imageFormat: 'jpg', imageWidth: w, imageHeight: h, imageCompressionQuality: 72 };

    // GetVideoMixFrame — directly captures what viewers actually see (OBS WS >= 5.3)
    const r = await ctx.obsClient.call('GetVideoMixFrame', {
      videoMixType: 'OBS_WEBSOCKET_VIDEO_MIX_TYPE_PROGRAM',
      ...imgOpts,
    });

    if (!r || !r.imageData) {
      const err = ctx.obsClient.getLastError() || 'Screenshot unavailable';
      console.warn('[OBS Preview] Screenshot failed:', err);
      return res.status(503).json({ error: err });
    }
    const buf = Buffer.from(r.imageData.replace(/^data:[^;]+;base64,/, ''), 'base64');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.end(buf);
  });

  // GET  → download as file (manual import fallback).
  app.get('/api/obs/scene-collection', (req, res) => {
    try {
      const collection = buildSceneCollection();
      res.setHeader('Content-Disposition', `attachment; filename="${OBS_COLLECTION_NAME}.json"`);
      res.json(collection);
    } catch (e) {
      console.error('[OBS] Scene collection generation failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST → save the collection to a folder the USER picks (native dialog), defaulting to the
  // detected OBS scenes folder. We don't assume a fixed OBS install path; the user imports the
  // saved .json via OBS → Scene Collection → Import (or it appears automatically if saved into
  // the OBS scenes folder). (own express.json — registered before the global body parser.)
  app.post('/api/obs/install-collection', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const collection = buildSceneCollection();
      const json = JSON.stringify(collection, null, 2);

      const obsDir = guessObsScenesDir();
      const defaultDir = obsDir || (() => { try { return _electronApp.getPath('desktop'); } catch { return os.homedir(); } })();

      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save OBS Scene Collection',
        defaultPath: path.join(defaultDir, `${OBS_COLLECTION_NAME}.json`),
        filters: [{ name: 'OBS Scene Collection', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (canceled || !filePath) {
        return res.json({ ok: false, canceled: true, message: 'Save cancelled.' });
      }

      await fsp.writeFile(filePath, json, 'utf8');
      console.log(`[OBS] Saved scene collection to ${filePath}`);

      // We save the file and stop. The app used to hot-switch OBS to the new collection over the
      // WebSocket when the file landed in the OBS scenes folder — that is exactly the "the suite
      // changed my OBS on me" behaviour we do not do. Your OBS is yours: pick the collection
      // yourself from OBS's Scene Collection menu when you actually want it on air.
      const savedInObsDir = obsDir && path.dirname(filePath) === obsDir;
      const switched = false;

      // Post-install glue: auto-map EMPTY broadcast moments to the collection's known scene
      // names so hotkeys/quick-bar work immediately (never overwrites a producer's own mapping).
      const AUTO_MAP = { inGame: 'In Game', replay: 'Replay', postGame: 'Post-Game (Winner)',
        break: 'Break (Countdown)', casters: 'DuoCam Row', bracket: 'Bracket' };
      let mapped = false;
      Object.entries(AUTO_MAP).forEach(([key, sceneName]) => {
        if (!state.obs.scenes[key]) { state.obs.scenes[key] = sceneName; mapped = true; }
      });
      if (mapped) { saveAppState(); broadcastFullState(); }

      res.json({
        ok: true,
        path: filePath,
        name: OBS_COLLECTION_NAME,
        savedInObsDir: !!savedInObsDir,
        switched,
        message: savedInObsDir
          ? `Saved into your OBS folder. Restart OBS (or use its Scene Collection menu) and pick "${OBS_COLLECTION_NAME}" when you want it.`
          : `Saved "${OBS_COLLECTION_NAME}.json". In OBS: Scene Collection → Import → choose that file.`,
      });
    } catch (e) {
      console.error('[OBS] install-collection failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
