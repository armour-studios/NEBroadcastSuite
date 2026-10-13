'use strict';
// Overlay thumbnails — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (dataDir).
let
  HTTP_PORT, app, electronApi, fs, fsp, overlayDir, path;
let ctx;

module.exports = function registerOverlayThumbRoutes(c) {
  ctx = c;
  ({
    HTTP_PORT, app, electronApi, fs, fsp, overlayDir, path
  } = c);

  // ── Overlay thumbnails ───────────────────────────────────────────────────────
  // Every card on the Overlays page used to run its overlay LIVE in an iframe (own WebSocket,
  // animation loops, three.js on some), torn down and rebuilt on every visit: that is what made the
  // page slow every time. Now each overlay is captured ONCE in a hidden window, cached on disk keyed
  // by the file's mtime, and served as a small PNG; the live iframe only loads while a card is
  // hovered. Captures run one at a time so a cold cache never stalls the app.
  const thumbDir = path.join(ctx.dataDir, 'thumbs');
  const THUMB_W = 480, THUMB_WAIT_MS = 2800, THUMB_REQ_WAIT_MS = 20000;
  const thumbJobs = new Map();   // file -> Promise<void>
  const thumbQueue = [];
  let thumbRunning = false;
  function thumbFileFor(file) { return path.join(thumbDir, file.replace(/[^A-Za-z0-9._-]/g, '_') + '.png'); }
  async function thumbFresh(file) {
    try {
      const [src, out] = await Promise.all([fsp.stat(path.join(overlayDir, file)), fsp.stat(thumbFileFor(file))]);
      return out.mtimeMs >= src.mtimeMs && out.size > 0;
    } catch (e) { return false; }
  }
  async function captureThumb(file) {
    // Rendered offscreen by the main process (backend/host-services.js renderThumb).
    const png = await electronApi.renderThumb({ url: `http://localhost:${HTTP_PORT}/${file}?preview=1&thumb=1`, width: THUMB_W, waitMs: THUMB_WAIT_MS });
    await fsp.mkdir(thumbDir, { recursive: true });
    await fsp.writeFile(thumbFileFor(file), png);
  }
  function pumpThumbs() {
    if (thumbRunning) return;
    const job = thumbQueue.shift();
    if (!job) return;
    thumbRunning = true;
    captureThumb(job.file).then(job.resolve, job.reject).finally(() => { thumbRunning = false; thumbJobs.delete(job.file); pumpThumbs(); });
  }
  function requestThumb(file) {
    if (thumbJobs.has(file)) return thumbJobs.get(file);
    const pr = new Promise((resolve, reject) => { thumbQueue.push({ file, resolve, reject }); });
    thumbJobs.set(file, pr);
    pr.catch(() => {});
    pumpThumbs();
    return pr;
  }
  app.get('/api/overlay-thumb', async (req, res) => {
    const file = String(req.query.file || '');
    if (!/^[A-Za-z0-9._-]+\.html$/.test(file) || !fs.existsSync(path.join(overlayDir, file))) return res.status(404).end();
    res.setHeader('Access-Control-Allow-Origin', '*');
    const send = () => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(thumbFileFor(file)); };
    if (await thumbFresh(file)) return send();
    // Wait a bounded time for this capture (they are queued one at a time). Past that, 202: the
    // card keeps its placeholder and asks again in a few seconds.
    const done = await Promise.race([requestThumb(file).then(() => true, () => false), new Promise((r) => setTimeout(() => r(null), THUMB_REQ_WAIT_MS))]);
    if (done === true) return send();
    if (done === false) return res.status(500).end();
    res.status(202).end();
  });
};
