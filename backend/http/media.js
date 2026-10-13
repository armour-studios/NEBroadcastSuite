'use strict';
// Stream Deck plugin download, Pulse multiview, media library — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (dataDir).
let
  GAMES, app, cloud, cloudLoop, express, fs, fsp, path, serverDir, state;
let ctx;

module.exports = function registerMediaRoutes(c) {
  ctx = c;
  ({
    GAMES, app, cloud, cloudLoop, express, fs, fsp, path, serverDir, state
  } = c);

  // ── Elgato Stream Deck plugin download (Integrations page) ────────────────
  // The packed .streamDeckPlugin ships inside the app (streamdeck-plugin/dist);
  // producers download it here and double-click to install into the Stream Deck app.
  app.get('/api/integrations/streamdeck-plugin', (req, res) => {
    const file = 'nebroadcaststudio.streamDeckPlugin';
    const p = path.join(serverDir, 'streamdeck-plugin', 'dist', file);
    fs.readFile(p, (err, buf) => {
      if (err) { res.status(404).json({ error: 'Stream Deck plugin package not found in this build.' }); return; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
      res.send(buf);
    });
  });

  // ── Pulse multiview ───────────────────────────────────────────────────────
  // overlay/pulse.html (a same-origin browser source) fetches this; we proxy the org's live games
  // from the cloud using THIS app's stored session, so no credentials ever ride the browser source.
  // Any failure / unlinked app returns an empty list → pulse.html falls back to its demo slate.
  function pulseOrgId() {
    const s = cloud.getSession();
    if (!cloud.authed() || !s.workspaceId || String(s.workspaceId).startsWith('user:')) return null;
    return s.workspaceId;
  }
  app.get('/api/multiview', async (req, res) => {
    const orgId = pulseOrgId();
    if (!orgId) return res.json({ games: [] });
    try { res.json({ games: await cloud.getMultiview(orgId) }); }
    catch (e) { res.json({ games: [] }); }
  });

  // Heartbeat: publish THIS app's live game so it shows on other producers' Pulse. Opt-in
  // (state.pulse.publish) + only when the cloud is linked — otherwise a no-op. Stops publishing (and
  // clears the row) when disabled. The teams come from the shared library, the score/clock from live
  // state, so an observer keys in nothing beyond flipping the toggle.
  const PULSE_UNIT = { 'rocket-league': 'g', 'csgo': 'rd', 'valorant': 'rd', 'rainbow6': 'rd', 'cod': 'rd', 'overwatch': 'pt', 'marvel-rivals': 'pt', 'league': 'pt', 'dota2': 'pt', 'mobile-legends': 'pt', 'honor-of-kings': 'pt', 'bedwars': 'pt', 'the-finals': 'pt', 'brawlhalla': 'st' };
  // Short crest label for grid tiles: an acronym for multi-word names ("Team BDS" -> TBD is wrong,
  // so drop filler words), otherwise the first 3 letters.
  const PULSE_FILLER = new Set(['team', 'the', 'esports', 'esport', 'gaming', 'gg', 'club', 'academy']);
  function pulseAbbr(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const words = raw.split(/[\s._-]+/).filter(Boolean);
    const core = words.filter(w => !PULSE_FILLER.has(w.toLowerCase()));
    const use = core.length ? core : words;
    if (use.length >= 2) return use.map(w => w[0]).join('').slice(0, 4).toUpperCase();
    return use[0].slice(0, 3).toUpperCase();
  }
  let _pulseWasPublishing = false;
  // 3s live heartbeat for the multiview tiles. Small jitter (not the default 20%) keeps the tiles
  // responsive; the breaker is what stops this becoming 20 failed requests a minute per desk
  // during an outage.
  cloudLoop('pulse', async () => {
    const orgId = pulseOrgId();
    const on = !!(state.pulse && state.pulse.publish) && !!orgId;
    if (!on) {
      if (_pulseWasPublishing && orgId) { try { await cloud.stopObservedGame(orgId); } catch (e) { /* ignore */ } }
      _pulseWasPublishing = false;
      return;
    }
    try {
      const g = GAMES[state.activeGame] || {};
      const blue = (state.teams && state.teams.blue) || {}, orange = (state.teams && state.teams.orange) || {};
      const live = state.game || {};
      const feedUrl = (state.pulse.feedViewUrl || '').trim();
      const channel = (state.pulse.channel || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/.*$/, '');
      const ser = state.series || { blue: 0, orange: 0 };
      await cloud.publishObservedGame(orgId, {
        game: g.name || state.activeGame,
        teams: {
          // score = the LIVE map/game score (each producer's own HUD shows it too); series = maps won,
          // which is what a GRID-style tile bar puts next to the crests.
          a: { name: blue.name || 'Team A', abbr: blue.abbr || pulseAbbr(blue.name), logo: blue.logo || null, color: blue.color || null, score: Number(live.blueScore || 0), series: Number(ser.blue || 0) },
          b: { name: orange.name || 'Team B', abbr: orange.abbr || pulseAbbr(orange.name), logo: orange.logo || null, color: orange.color || null, score: Number(live.orangeScore || 0), series: Number(ser.orange || 0) }
        },
        clock: Number(live.time || 0),
        status: (state.roundLabel || (state.match && state.match.format) || '').toString().slice(0, 60),
        unit: PULSE_UNIT[state.activeGame] || 'score',
        bestOf: Number(state.bestOf || 0) || undefined,
        // channel/label ride the feed blob (it's already a free-form Json column — no schema change).
        feed: (feedUrl || channel || state.pulse.label)
          ? { viewUrl: feedUrl || undefined, channel: channel || undefined, label: (state.pulse.label || '').trim() || undefined }
          : undefined
      });
      _pulseWasPublishing = true;
    } catch (e) { /* transient — try again next tick */ }
  }, 3000, { jitter: 0.1 });

  // ── Media library ─────────────────────────────────────────────────────────
  // Browsable image store under <dataDir>/media, served at /data/media/<...>.
  // Reusable picker source for Brands, Teams, Scenes. Local album = filesystem;
  // Web album = paste-a-URL (stored as a small .url pointer); Cloud is reserved.
  const mediaRoot = path.join(ctx.dataDir, 'media');
  try { fs.mkdirSync(mediaRoot, { recursive: true }); } catch (e) { /* ignore */ }
  const mediaJson = express.json({ limit: '40mb' });   // images can exceed the global 2mb cap
  const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

  // Resolve a client-supplied relative path safely inside mediaRoot (no traversal).
  function safeMediaPath(rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.normalize(path.join(mediaRoot, clean));
    if (abs !== mediaRoot && !abs.startsWith(mediaRoot + path.sep)) return null;
    return abs;
  }

  app.get('/api/media/list', async (req, res) => {
    const rel = req.query.path || '';
    const abs = safeMediaPath(rel);
    if (!abs) return res.status(400).json({ ok: false, error: 'Bad path' });
    try {
      const entries = fs.existsSync(abs) ? await fsp.readdir(abs, { withFileTypes: true }) : [];
      const folders = [], files = [];
      // Stats run in parallel: one await per file made a big folder (or a OneDrive-synced one) crawl.
      await Promise.all(entries.map(async (e) => {
        if (e.name.startsWith('.')) return;
        const childRel = (rel ? rel.replace(/\/+$/, '') + '/' : '') + e.name;
        if (e.isDirectory()) {
          folders.push({ name: e.name, path: childRel });
        } else if (IMG_RE.test(e.name)) {
          let size = 0; try { size = (await fsp.stat(path.join(abs, e.name))).size; } catch (x) {}
          files.push({ name: e.name, path: childRel, url: '/data/media/' + childRel.split('/').map(encodeURIComponent).join('/'), size });
        }
      }));
      folders.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ ok: true, path: rel, folders, files });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/media/folder', mediaJson, async (req, res) => {
    const { path: rel, name } = req.body || {};
    const safeName = String(name || '').replace(/[^\w\-. ]+/g, '').trim();
    if (!safeName) return res.status(400).json({ ok: false, error: 'Bad folder name' });
    const abs = safeMediaPath((rel ? rel + '/' : '') + safeName);
    if (!abs) return res.status(400).json({ ok: false, error: 'Bad path' });
    try { await fsp.mkdir(abs, { recursive: true }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/media/upload', mediaJson, async (req, res) => {
    const { path: rel, name, dataUrl, url } = req.body || {};
    const safeName = String(name || '').replace(/[^\w\-. ]+/g, '_').trim();
    if (!safeName) return res.status(400).json({ ok: false, error: 'Missing file name' });
    const dir = safeMediaPath(rel || '');
    if (!dir) return res.status(400).json({ ok: false, error: 'Bad path' });
    try {
      await fsp.mkdir(dir, { recursive: true });
      // Web album: store a tiny .url pointer instead of binary data.
      if (url && !dataUrl) {
        await fsp.writeFile(path.join(dir, safeName.replace(IMG_RE, '') + '.url'), String(url));
        return res.json({ ok: true, web: true });
      }
      const m = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl || '');
      if (!m) return res.status(400).json({ ok: false, error: 'Expected a base64 data URL' });
      const fname = IMG_RE.test(safeName) ? safeName : safeName + '.png';
      // Async — uploads run up to the 40MB body cap; a sync write that size freezes the window.
      await fsp.writeFile(path.join(dir, fname), Buffer.from(m[1], 'base64'));
      res.json({ ok: true, name: fname, url: '/data/media/' + ((rel ? rel + '/' : '') + fname).split('/').map(encodeURIComponent).join('/') });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/media/delete', mediaJson, async (req, res) => {
    const abs = safeMediaPath((req.body || {}).path);
    if (!abs || abs === mediaRoot) return res.status(400).json({ ok: false, error: 'Bad path' });
    try {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) await fsp.rm(abs, { recursive: true, force: true });
      else await fsp.unlink(abs);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
