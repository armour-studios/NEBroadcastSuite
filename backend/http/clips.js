'use strict';
// Clips API — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (clipSystem, obsStingerFile, wsAuthToken).
let
  app, broadcastClipsUpdate, fs, fsp, needsAirPrep, path, showTimeline, state;
let ctx;

module.exports = function registerClipRoutes(c) {
  ctx = c;
  ({
    app, broadcastClipsUpdate, fs, fsp, needsAirPrep, path, showTimeline, state
  } = c);

  // ─── Clips API ────────────────────────────────────────────────────────────
  // Scan the OBS replay/output folder for video files not yet imported.
  app.get('/api/clips/scan-folder', async (req, res) => {
    try {
      const folder = state.clips?.replayFolder || '';
      if (!folder) return res.json({ ok: true, files: [], reason: 'No folder configured' });
      if (!fs.existsSync(folder)) return res.json({ ok: true, files: [], reason: 'Folder not found' });

      const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.ts', '.flv', '.avi', '.wmv']);
      // Async walk — a big replay folder scanned with readdirSync/statSync stalls the window.
      const entries = await fsp.readdir(folder);
      const library = (ctx.clipSystem ? ctx.clipSystem.getState().library : []) || [];
      // Match by sourceFile (exact original path) so the staging area can show ✓ imported
      const importedSourceFiles = new Set(library.map(c => path.resolve(c.sourceFile || '')).filter(Boolean));
      const importedPaths = new Set(library.map(c => path.resolve(c.path || '')).filter(Boolean));

      const allFiles = [];
      for (const f of entries) {
        if (!VIDEO_EXT.has(path.extname(f).toLowerCase())) continue;
        const full = path.join(folder, f);
        try {
          const stat = await fsp.stat(full);
          const resolved = path.resolve(full);
          const imported = importedPaths.has(resolved) || importedSourceFiles.has(resolved);
          const importedClip = library.find(c =>
            path.resolve(c.sourceFile || '') === resolved ||
            path.resolve(c.path || '') === resolved
          );
          allFiles.push({ name: f, path: full, size: stat.size, mtimeMs: stat.mtimeMs, imported, importedId: importedClip?.id || null });
        } catch { /* unreadable file — skip */ }
      }
      allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

      // Cap the payload for safety on huge folders, but report the TRUE total so the count
      // stays accurate (the old 100 cap made the count pin at 100 and never drop on delete).
      const MAX_STAGING = 1000;
      res.json({ ok: true, files: allFiles.slice(0, MAX_STAGING), total: allFiles.length, folder });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Stream a video file from the replay folder (or clips dir) so the panel can
  // preview it and the overlay can play it. Path-restricted; sendFile supports Range.
  // The OBS stinger transition's own video, so the replay player can run the SAME sting between
  // clips that OBS runs on a scene cut. The path is never taken from the request — it's whatever
  // OBS reported for the transition the producer selected (see obs_transition_info), so this can't
  // be pointed at an arbitrary file.
  app.get('/api/obs/transition-stinger', (req, res) => {
    try {
      // Fall back to the remembered path so this keeps working after a restart (the in-memory
      // value is only set when the picker was used in THIS process).
      if (!ctx.obsStingerFile && state.obsStinger && state.obsStinger.path) ctx.obsStingerFile = state.obsStinger.path;
      if (!ctx.obsStingerFile || !fs.existsSync(ctx.obsStingerFile)) return res.status(404).end();
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.sendFile(ctx.obsStingerFile);
    } catch (e) { res.status(500).end(); }
  });

  // A URL the EDITOR can actually play. OBS records .mkv by default (and .mov/.avi/.ts turn up from
  // other capture tools) — Chromium can't decode those containers, so the editor's <video> mounted
  // the file, read its duration, and painted nothing but black. Push-to-air already dodges this by
  // transcoding through prepareForAir(); this exposes the same cached baseline .mp4 to the panel, so
  // a clip that plays on air also plays in the editor. Browser-friendly files come straight back.
  app.get('/api/clips/preview-src', async (req, res) => {
    try {
      const abs = path.resolve(String(req.query.path || ''));
      const folder = state.clips?.replayFolder ? path.resolve(state.clips.replayFolder) : '';
      const clipsDir = ctx.clipSystem ? path.resolve(ctx.clipSystem.manager.getClipsDir()) : '';
      const inside = (root) => root && (abs === root || abs.startsWith(root + path.sep));
      if (!inside(folder) && !inside(clipsDir)) return res.status(403).json({ ok: false, message: 'Path outside the clip folders' });
      if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, message: 'File not found' });
      const fileUrl = (p) => '/api/clips/file?path=' + encodeURIComponent(p);
      // Codec-aware, not just extension-aware: HEVC inside an .mp4 is just as unplayable as .mkv.
      if (!(await needsAirPrep(abs))) return res.json({ ok: true, url: fileUrl(abs), prepared: false });
      if (!ctx.clipSystem) return res.json({ ok: false, message: 'Clip system unavailable' });
      const prepared = await ctx.clipSystem.prepareForAir(abs);
      if (!prepared || prepared === abs) {
        return res.json({ ok: false, message: 'Could not convert this file for preview (' + path.extname(abs) + ')' });
      }
      res.json({ ok: true, url: fileUrl(prepared), prepared: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.get('/api/clips/file', (req, res) => {
    try {
      const abs = path.resolve(String(req.query.path || ''));
      const folder = state.clips?.replayFolder ? path.resolve(state.clips.replayFolder) : '';
      const clipsDir = ctx.clipSystem ? path.resolve(ctx.clipSystem.manager.getClipsDir()) : '';
      const inside = (root) => root && (abs === root || abs.startsWith(root + path.sep));
      if (!inside(folder) && !inside(clipsDir)) return res.status(403).end();
      if (!fs.existsSync(abs)) return res.status(404).end();
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.sendFile(abs);
    } catch (e) {
      res.status(500).end();
    }
  });

  // Server-generated poster thumbnail (a single frame via ffmpeg, cached on disk by path+mtime).
  // Far more reliable than decoding the video in the browser for the staging list.
  app.get('/api/clips/thumb', (req, res) => {
    try {
      const abs = path.resolve(String(req.query.path || ''));
      const folder = state.clips?.replayFolder ? path.resolve(state.clips.replayFolder) : '';
      const clipsDir = ctx.clipSystem ? path.resolve(ctx.clipSystem.manager.getClipsDir()) : '';
      const inside = (root) => root && (abs === root || abs.startsWith(root + path.sep));
      if (!inside(folder) && !inside(clipsDir)) return res.status(403).end();
      if (!fs.existsSync(abs)) return res.status(404).end();
      if (!clipsDir) return res.status(503).end();

      const stat = fs.statSync(abs);
      // 'v2' invalidates the earlier (often-black) cached thumbnails.
      const key = require('crypto').createHash('md5').update(abs + ':' + stat.mtimeMs + ':v2').digest('hex');
      const thumbDir = path.join(clipsDir, 'thumbs');
      fs.mkdirSync(thumbDir, { recursive: true });
      const thumbPath = path.join(thumbDir, key + '.jpg');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);

      const ff = (ctx.clipSystem && ctx.clipSystem.encoder && ctx.clipSystem.encoder.ffmpegPath && ctx.clipSystem.encoder.ffmpegPath()) || 'ffmpeg';
      const ffprobe = (ff !== 'ffmpeg') ? ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : 'ffprobe';
      const { spawn } = require('child_process');
      let done = false;
      const finish = (ok) => { if (done) return; done = true; if (ok && fs.existsSync(thumbPath)) res.sendFile(thumbPath); else res.status(404).end(); };

      // Replay clips often have a long black fade-in, so seek to ~45% (mid-clip) for a real frame.
      let probed = '';
      let probe;
      try { probe = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs], { windowsHide: true }); }
      catch (e) { probe = null; }
      const extract = () => {
        const dur = parseFloat(probed) || 0;
        const seek = dur > 4 ? (dur * 0.45).toFixed(1) : '0.5';
        const proc = spawn(ff, ['-y', '-ss', seek, '-i', abs, '-frames:v', '1', '-vf', 'scale=240:-1', '-q:v', '3', thumbPath], { windowsHide: true });
        proc.on('close', (code) => finish(code === 0));
        proc.on('error', () => finish(false));
      };
      if (probe) {
        probe.stdout.on('data', (d) => { probed += d.toString(); });
        probe.on('close', extract);
        probe.on('error', extract);
      } else { extract(); }
      setTimeout(() => finish(false), 15000);
    } catch (e) { res.status(500).end(); }
  });

  // Rename a file in the OBS replay/staging folder (path-restricted to that folder only).
  app.post('/api/clips/rename-staged', (req, res) => {
    try {
      const abs = path.resolve(String(req.body?.filePath || ''));
      const folder = state.clips?.replayFolder ? path.resolve(state.clips.replayFolder) : '';
      if (!folder || !(abs === folder || abs.startsWith(folder + path.sep))) return res.status(403).json({ ok: false, message: 'Path outside replay folder' });
      if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, message: 'File not found' });
      const ext = path.extname(abs);
      let safe = String(req.body?.newName || '').replace(/[\\/:*?"<>|]+/g, '').trim();
      if (!safe) return res.status(400).json({ ok: false, message: 'Enter a valid name' });
      if (!safe.toLowerCase().endsWith(ext.toLowerCase())) safe += ext;
      const dest = path.join(path.dirname(abs), safe);
      if (path.resolve(dest) === abs) return res.json({ ok: true, path: abs, name: safe });
      if (fs.existsSync(dest)) return res.status(409).json({ ok: false, message: 'A file with that name already exists' });
      fs.renameSync(abs, dest);
      res.json({ ok: true, path: dest, name: safe });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // Delete a file from the OBS replay/staging folder (path-restricted to that folder only).
  app.post('/api/clips/delete-staged', (req, res) => {
    try {
      const abs = path.resolve(String(req.body?.filePath || ''));
      const folder = state.clips?.replayFolder ? path.resolve(state.clips.replayFolder) : '';
      if (!folder || !abs.startsWith(folder + path.sep)) return res.status(403).json({ ok: false, message: 'Path outside replay folder' });
      if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, message: 'File not found' });
      fs.unlinkSync(abs);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Import a specific file from the replay folder into the clip library.
  app.post('/api/clips/import-file', (req, res) => {
    try {
      const { filePath, label } = req.body || {};
      if (!filePath) return res.status(400).json({ ok: false, message: 'filePath required' });
      // The import COPIES the file into data/clips, which is served over HTTP — so only video files,
      // never an arbitrary local file.
      if (typeof filePath !== 'string' || !/\.(mp4|mkv|mov|flv|webm|ts|m4v|avi)$/i.test(filePath)) return res.status(400).json({ ok: false, message: 'Not a video file' });
      if (!fs.existsSync(filePath)) return res.status(400).json({ ok: false, message: 'File not found' });
      if (!ctx.clipSystem) return res.status(503).json({ ok: false, message: 'Clip system not ready' });

      ctx.clipSystem.manager.importReplayFile(filePath, { label: label || path.basename(filePath, path.extname(filePath)) })
        .then((clip) => {
          broadcastClipsUpdate();
          res.json({ ok: true, clip });
        })
        .catch(e => res.status(500).json({ ok: false, message: e.message }));
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // GET /api/clips — return the local clip library for the Social page
  app.get('/api/clips', (req, res) => {
    if (!ctx.clipSystem) return res.json({ library: [], clips: [] });
    const { library } = ctx.clipSystem.getState();
    res.json({ library: library || [], clips: library || [] });
  });

  // POST /api/clips/social-encode — bake intro + clip + outro into a social-ready MP4
  app.post('/api/clips/social-encode', (req, res) => {
    if (!ctx.clipSystem) return res.status(503).json({ error: 'Clip system not ready' });
    const { introId, clipId, outroId, opts = {} } = req.body || {};
    if (!clipId) return res.status(400).json({ error: 'No clip selected' });
    const library = ctx.clipSystem.getState().library || [];
    const findClip = (id) => (id ? library.find((c) => c.id === id) : null);
    const mainClip = findClip(clipId);
    if (!mainClip || !mainClip.path) return res.status(400).json({ error: 'Clip not found or has no video file' });
    const segments = [];
    const intro = findClip(introId);
    if (intro && intro.path) segments.push({ path: intro.path, trimIn: 0, trimOut: null, name: 'Intro' });
    segments.push({ path: mainClip.path, trimIn: mainClip.trimIn || 0, trimOut: mainClip.trimOut || null, name: mainClip.name || 'Clip' });
    const outro = findClip(outroId);
    if (outro && outro.path) segments.push({ path: outro.path, trimIn: 0, trimOut: null, name: 'Outro' });
    const safeName = 'social_' + (mainClip.name || 'clip').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const jobId = ctx.clipSystem.encoder.enqueue({
      name: safeName,
      segments,
      opts: { quality: opts.quality || 'high', transition: opts.transition || 'fade', format: '.mp4' }
    });
    res.json({ ok: true, jobId });
  });

  // CORS for the file:// control panel (incl. DELETE in the preflight) is answered by the origin
  // guard registered first in startHttpServer — it covers every route, not just the ones below.

  // Hands the WS bridge auth token to same-host clients (control panel + overlay browser
  // sources) so they can open ws://…:3001/?token=… — see getOrCreateWsToken() / the
  // bridgeWss connection handler in startBridgeServer(). Same trust boundary as every
  // other route on this HTTP server; the point isn't to hide the token from this host,
  // it's to keep a bare port-scan of :3001 from getting in when WS_HOST=0.0.0.0 is set.
  // The show timeline (backend/show-timeline.js). ?since=<seq> for new events only; ?format=text for
  // readable lines. Names and short messages only, never secrets.
  app.get('/api/diagnostics/timeline', (req, res) => {
    if (req.query.format === 'text') return res.type('text/plain').send(showTimeline.text(Math.min(2000, Number(req.query.limit) || 500)));
    res.json({ ok: true, events: showTimeline.since(req.query.since, Math.min(2000, Number(req.query.limit) || 500)) });
  });
  app.get('/api/ws-token', (req, res) => {
    res.json({ token: ctx.wsAuthToken });
  });
};
