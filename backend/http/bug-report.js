'use strict';
// In-app bug report — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through _ctx (appVersion, dataDir).
let
  FormData, app, axios, baseDir, bridgeClients, broadcast, cloud, express, fs, path,
  showTimeline;
let _ctx;

module.exports = function registerBugReportRoutes(c) {
  _ctx = c;
  ({
    FormData, app, axios, baseDir, bridgeClients, broadcast, cloud, express, fs, path,
    showTimeline
  } = c);

  // ── In-app bug report → Discord webhook + GitHub Issues + website ticket ─────
  // This route is registered before the global express.json() below, so it needs
  // its own body parser — otherwise req.body is empty and reports look blank.
  // GITHUB_TOKEN is a dev-only secret (like BUG_REPORT_WEBHOOK) — NOT in gen-prod-env.js's
  // PUBLIC_KEYS, so it's stripped from distributed builds; only Armour's own dev environment
  // files real GitHub issues. Discord and GitHub are attempted independently — either one
  // succeeding counts as an overall success, so a misconfigured/down one doesn't block the other.
  app.post('/api/bug-report', express.json({ limit: '12mb' }), async (req, res) => {
    const hook = process.env.BUG_REPORT_WEBHOOK || '';
    const ghToken = process.env.GITHUB_TOKEN || '';
    const ghRepo = process.env.GITHUB_REPO || 'armour-studios/NEBroadcastSuite';
    if (!hook && !ghToken && !cloud.authed()) return res.status(503).json({ ok: false, message: 'No bug-report destination configured (set BUG_REPORT_WEBHOOK and/or GITHUB_TOKEN in .env.local, or sign in to the cloud).' });
    const b = req.body || {};
    const isFeature = b.type === 'feature';
    const title = String(b.title || '').trim().slice(0, 256);
    const description = String(b.description || '').trim().slice(0, 3800);
    if (!title && !description) return res.status(400).json({ ok: false, message: 'Add a title or description.' });

    const ctx = b.context || {};
    const fields = [];

    if (isFeature) {
      const PRI = {
        'nice-to-have':  { emoji: '🔵', label: 'Nice to have' },
        'would-help':    { emoji: '🟡', label: 'Would help a lot' },
        'essential':     { emoji: '🔴', label: 'Essential to workflow' },
      };
      const pri = PRI[b.priority] || PRI['would-help'];
      fields.push({ name: 'Priority', value: `${pri.emoji} ${pri.label}`, inline: true });
      if (b.category) fields.push({ name: '📂 Area', value: String(b.category).slice(0, 100), inline: true });
      if (ctx.page)   fields.push({ name: '📄 Page', value: String(ctx.page).slice(0, 100), inline: true });
      if (b.reporter) fields.push({ name: '🧑 Requested by', value: String(b.reporter).slice(0, 100), inline: true });
    } else {
      const SEV = {
        low:      { color: 0x4ade80, emoji: '🟢' },
        medium:   { color: 0xfbbf24, emoji: '🟡' },
        high:     { color: 0xf97316, emoji: '🟠' },
        critical: { color: 0xdc2626, emoji: '🔴' }
      };
      const severity = ['low', 'medium', 'high', 'critical'].includes(b.severity) ? b.severity : 'medium';
      const sev = SEV[severity];
      fields.push({ name: 'Severity', value: `${sev.emoji} ${severity.toUpperCase()}`, inline: true });
      if (b.category) fields.push({ name: '📂 Area',     value: String(b.category).slice(0, 100), inline: true });
      if (ctx.page)   fields.push({ name: '📄 Page',     value: String(ctx.page).slice(0, 100),   inline: true });
      if (ctx.game)   fields.push({ name: '🎮 Game',     value: String(ctx.game).slice(0, 100),   inline: true });
      if (b.reporter) fields.push({ name: '🧑 Reporter', value: String(b.reporter).slice(0, 100), inline: true });
    }

    // Optional screenshot (data URL). Decode → attach to the embed via attachment:// .
    let imgBuf = null, imgName = null;
    if (!isFeature && typeof b.image === 'string' && b.image.startsWith('data:image/')) {
      const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.image);
      if (m) {
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 0 && buf.length <= 8 * 1024 * 1024) {
          imgBuf = buf;
          imgName = 'screenshot.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
        }
      }
    }

    // Optional browser console log (recent output + any uncaught errors, captured client-side).
    // Kept as a plain-text FILE attachment rather than jammed into the embed — Discord embed
    // fields/descriptions have small character limits a console dump blows through instantly.
    let logBuf = null;
    const LOG_NAME = 'console.log';
    const LOG_CAP = 60000;   // defense in depth — cap regardless of what the client already trimmed
    if (typeof b.consoleLog === 'string' && b.consoleLog.trim()) {
      const raw = b.consoleLog;
      const capped = raw.length > LOG_CAP ? `…(truncated, showing the most recent output)…\n${raw.slice(-LOG_CAP)}` : raw;
      logBuf = Buffer.from(capped, 'utf8');
    }
    // What the show was doing leading up to the report (scene cuts, game feed, dropped replies...).
    if (!isFeature && showTimeline.size()) {
      // Each part capped on its own, so a long timeline never pushes the console errors out of a
      // destination that keeps only the tail (GitHub issues keep ~15k chars).
      const tlText = '\n\n===== Show timeline (most recent 120 events) =====\n' + showTimeline.text(120).slice(-6000);
      const con = logBuf ? logBuf.toString('utf8') : '(no console log)';
      logBuf = Buffer.from(tlText + '\n\n===== Console =====\n' + con.slice(-Math.max(4000, LOG_CAP - tlText.length)), 'utf8');
    }

    const severity = ['low', 'medium', 'high', 'critical'].includes(b.severity) ? b.severity : 'medium';
    const embedColor = isFeature ? 0x7c3aed : { low: 0x4ade80, medium: 0xfbbf24, high: 0xf97316, critical: 0xdc2626 }[severity];
    const embed = {
      author: { name: isFeature ? 'Broadcast Studio · Feature Request' : 'Broadcast Studio · Bug Report' },
      title: (title || (isFeature ? 'Feature request' : 'Bug report')).slice(0, 256),
      description: description || '_(no details provided)_',
      color: embedColor,
      fields,
      footer: { text: `${(ctx.app || 'Broadcast Studio')} · v${_ctx.appVersion}` },
      timestamp: new Date().toISOString()
    };
    if (imgBuf) embed.image = { url: `attachment://${imgName}` };

    // Discord supports multiple files per message (files[0], files[1], …) each needing a matching
    // {id, filename} entry in `attachments` — build both lists together so ids always line up.
    const discordFiles = [];
    if (imgBuf) {
      const ext = imgName.split('.').pop();
      discordFiles.push({ id: discordFiles.length, filename: imgName, buf: imgBuf, mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` });
    }
    if (logBuf) discordFiles.push({ id: discordFiles.length, filename: LOG_NAME, buf: logBuf, mime: 'text/plain' });

    const payload = {
      username: isFeature ? 'NE Feature Requests' : 'NE Bug Reports',
      embeds: [embed],
      ...(discordFiles.length ? { attachments: discordFiles.map((f) => ({ id: f.id, filename: f.filename })) } : {})
    };

    const result = { discordOk: false, githubOk: false, websiteOk: false, githubUrl: null, errors: [] };

    // Use axios (Node 16 in Electron has no global fetch). 8s timeout so a slow/unreachable
    // Discord can't hang the request. Discord returns 204 on success → axios resolves on 2xx.
    if (hook) {
      try {
        if (discordFiles.length) {
          const form = new FormData();
          form.append('payload_json', JSON.stringify(payload), { contentType: 'application/json' });
          discordFiles.forEach((f) => form.append(`files[${f.id}]`, f.buf, { filename: f.filename, contentType: f.mime }));
          await axios.post(hook, form, { headers: form.getHeaders(), timeout: 12000, maxContentLength: Infinity, maxBodyLength: Infinity });
        } else {
          await axios.post(hook, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
        }
        result.discordOk = true;
      } catch (e) {
        if (e.response) {
          const txt = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data || {});
          result.errors.push(`Discord rejected the report (${e.response.status}). ${String(txt).slice(0, 160)}`);
        } else {
          result.errors.push((e.code === 'ECONNABORTED') ? 'Discord did not respond in time (timed out).' : e.message);
        }
      }
    }

    if (ghToken) {
      try {
        const labels = [isFeature ? 'enhancement' : 'bug'];
        if (!isFeature) labels.push('severity:' + severity);
        if (b.category) labels.push('area:' + String(b.category).slice(0, 40));
        let bodyLines = [
          description || '_(no details provided)_',
          '',
          '---',
          b.reporter ? `**Reporter:** ${b.reporter}` : '',
          ctx.page ? `**Page:** ${ctx.page}` : '',
          ctx.game ? `**Game:** ${ctx.game}` : '',
          imgBuf ? '_A screenshot was attached to the Discord report._' : '',
          `_Submitted from ${(ctx.app || 'Broadcast Studio')} v${_ctx.appVersion}_`
        ].filter(Boolean).join('\n');
        // GitHub issue bodies have plenty of headroom (65536 chars) but a raw dump is unwieldy —
        // wrap it in a collapsed <details> block so it's there without overwhelming the issue.
        if (logBuf) {
          const GH_LOG_CAP = 15000;
          const logText = logBuf.toString('utf8');
          const ghLog = logText.length > GH_LOG_CAP ? logText.slice(-GH_LOG_CAP) : logText;
          bodyLines += `\n\n<details>\n<summary>Console log${ghLog.length < logText.length ? ' (truncated, most recent output)' : ''}</summary>\n\n\`\`\`\n${ghLog}\n\`\`\`\n\n</details>`;
        }
        const ghRes = await axios.post(`https://api.github.com/repos/${ghRepo}/issues`, {
          title: (title || (isFeature ? 'Feature request' : 'Bug report')).slice(0, 256),
          body: bodyLines,
          labels
        }, {
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          timeout: 10000
        });
        result.githubOk = true;
        result.githubUrl = (ghRes.data && ghRes.data.html_url) || null;
      } catch (e) {
        if (e.response) {
          const txt = typeof e.response.data === 'string' ? e.response.data : JSON.stringify((e.response.data && e.response.data.message) || e.response.data || {});
          result.errors.push(`GitHub rejected the issue (${e.response.status}). ${String(txt).slice(0, 160)}`);
        } else {
          result.errors.push((e.code === 'ECONNABORTED') ? 'GitHub did not respond in time (timed out).' : e.message);
        }
      }
    }

    // Website ticket — files the report on the producer's own website account (visible on
    // /access/bugs with staff status/notes), Bearer-authed through the cloud session. The
    // website enforces minimum title/description lengths for its own form; pad here so a
    // terse-but-valid in-app report is never bounced. Skipped (with a note) when the
    // producer isn't signed in to the cloud — Discord/GitHub still get their copies.
    if (cloud.authed()) {
      try {
        const AREA_MAP = {
          'Overlays / HUD': 'overlays', 'OBS / Scenes': 'obs-integration', 'Video Editor': 'editor',
          'Camera Feeds': 'talent', 'Bracket / Events': 'esports', 'Teams / Players': 'esports',
          'Stats': 'esports', 'start.gg': 'esports', 'Dashboard': 'editor', 'UI / Layout': 'editor'
        };
        let webTitle = ((isFeature ? '[Feature request] ' : '') + (title || (isFeature ? 'Feature request' : 'Bug report'))).slice(0, 200);
        if (webTitle.trim().length < 5) webTitle = (isFeature ? 'Feature request: ' : 'Bug report: ') + webTitle;
        const webDesc = [
          description || '(no details provided)',
          '',
          '---',
          b.reporter ? `Reporter: ${b.reporter}` : '',
          ctx.page ? `Page: ${ctx.page}` : '',
          ctx.game ? `Game: ${ctx.game}` : '',
          imgBuf ? 'A screenshot was attached to the Discord copy of this report.' : '',
          `Submitted from ${(ctx.app || 'Broadcast Studio')} v${_ctx.appVersion}`
        ].filter(Boolean).join('\n').slice(0, 5000);
        await cloud.submitBugReport({
          title: webTitle,
          description: webDesc,
          severity: isFeature ? 'low' : severity,
          area: AREA_MAP[b.category] || (b.category ? 'other' : null),
          appVersion: String(_ctx.appVersion || ''),
          // The console log carries the stack trace (the actual bug). Distributed builds have no
          // Discord/GitHub channel, so the website ticket is the ONLY place it can land — send it.
          consoleLog: logBuf ? logBuf.toString('utf8') : undefined
        });
        result.websiteOk = true;
      } catch (e) {
        result.errors.push(`Website: ${e.message || 'could not file the report'}.`);
      }
    } else {
      result.errors.push('Website: not signed in to the cloud, so no ticket was filed on your site account.');
    }

    if (result.discordOk || result.githubOk || result.websiteOk) {
      res.json({ ok: true, discordOk: result.discordOk, githubOk: result.githubOk, websiteOk: result.websiteOk, githubUrl: result.githubUrl, message: result.errors.join(' ') || undefined });
    } else {
      res.status(502).json({ ok: false, message: result.errors.join(' ') || 'Failed to send report.' });
    }
  });

  // Middleware to strip Range headers (prevents Range Not Satisfiable errors)
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      delete req.headers['range'];
    }
    next();
  });

  // Overlay HTML/JS/CSS must never be cached — OBS's embedded browser (CEF) caches
  // hard and would keep showing a stale overlay after edits. Force revalidation.
  app.use(express.static(path.join(baseDir, 'overlay'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }));

  // Auto-reload overlays when their files change on disk (app update, overlay editor save,
  // manual edit). Headers are already no-store, but a page LOADED in OBS's CEF stays in
  // memory until reloaded — this pushes the reload so producers never touch OBS's cache.
  //
  // CRITICAL: only reload when a watched file's CONTENT actually changes. fs.watch fires on
  // metadata-only touches too — and when the project lives under OneDrive (or an AV scanner is
  // active), those touches are near-constant, which used to reload every overlay browser source
  // on a loop ("lots of full-frame refreshes"). We dedupe by SHA-1 of the bytes and pre-hash on
  // startup so the first spurious touch after boot doesn't reload either.
  try {
    const _crypto = require('crypto');
    const overlayDir = path.join(baseDir, 'overlay');
    const _ovHashes = new Map();
    const _ovPending = new Set();
    let _ovReloadTimer = null;
    const _hashFile = (rel) => {
      try { return _crypto.createHash('sha1').update(fs.readFileSync(path.join(overlayDir, rel))).digest('hex'); }
      catch (_) { return null; }
    };
    // Seed hashes for the files present at boot so a metadata-only touch is a no-op.
    try { fs.readdirSync(overlayDir).forEach((f) => { if (/\.(html|css|js)$/i.test(f)) { const h = _hashFile(f); if (h) _ovHashes.set(f, h); } }); } catch (_) {}

    fs.watch(overlayDir, { recursive: true }, (evt, file) => {
      if (!file || !/\.(html|css|js)$/i.test(file)) return;
      if (/(^|[\\/])~\$|\.tmp$|\.crdownload$|\.swp$/i.test(file)) return;   // editor / OneDrive / download temp files
      _ovPending.add(file);
      clearTimeout(_ovReloadTimer);
      _ovReloadTimer = setTimeout(() => {
        const pending = [..._ovPending]; _ovPending.clear();
        const changed = [];
        for (const rel of pending) {
          const h = _hashFile(rel);
          if (h && _ovHashes.get(rel) !== h) { _ovHashes.set(rel, h); changed.push(rel); }
        }
        if (changed.length) {
          console.log(`[Overlay] content changed (${changed.join(', ')}) — reloading affected overlay sources`);
          // Pass the changed files so each overlay reloads ONLY if it's affected (and can hot-swap
          // a pure CSS change without blanking). Editing standings.html won't touch the bracket source.
          broadcast(bridgeClients, { type: 'reload_overlays', files: changed });
        }
      }, 1000);
    });
  } catch (e) { console.warn('[Overlay] file watcher unavailable:', e.message); }

  // Serve assets
  app.use('/assets', express.static(path.join(baseDir, 'assets')));

  // Serve userData (clips, logos, exports) — with CORS so the control-panel can
  // draw clip frames to canvas for thumbnails (file:// → localhost cross-origin).
  // /data exists to serve MEDIA (clips, the media library). The folder also holds state.json, the
  // cloud session and the WS token — never hand those out: no root-level files, no data files.
  app.use('/data', (req, res, next) => {
    let p = '';
    try { p = decodeURIComponent(req.path || ''); } catch (_) { return res.status(400).end(); }
    if (p.indexOf('/', 1) < 0 || /\.(json|bak|tmp|log|db|sqlite|env)$/i.test(p)) return res.status(404).end();
    next();
  });
  app.use('/data', express.static(_ctx.dataDir, {
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  }));

  // Parse JSON bodies (GSI payloads can be a bit large)
  // Capture raw body for Twitch webhook signature verification using verify callback
  app.use(express.json({
    limit: '2mb',
    verify: (req, res, buf, encoding) => {
      // Store raw body for webhook signature verification
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  }));
};
