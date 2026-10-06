#!/usr/bin/env node
/*
  make-mono-logo.js — turn a full-colour game logo into the mono mark the UI actually needs.

    unset ELECTRON_RUN_AS_NODE            # (bash) or run via npx electron
    npx electron scripts/make-mono-logo.js <source.png> <out.png> [threshold] [band]

  WHY THIS EXISTS
  The control panel draws every game logo through `filter: brightness(0) invert(1)`
  (control-panel/styles.css — .game-card img / .game-dd-logo / .game-logo-white / .gs-logo).
  That keeps ONLY the alpha channel, so a full-colour mark collapses to a featureless white
  blob: Brawlhalla's crest came through as a plain white shield shape with none of its armour
  or gem. The marks that work (cs2.svg, lol.svg, rainbow6.svg, dota2.svg) are mono line art
  whose SILHOUETTE is the logo.

  So: map luminance onto alpha. Dark outlines knock out into holes, lighter areas stay solid
  white, and the silhouette carries the internal structure. A smoothstep band rather than a hard
  cut keeps the edges anti-aliased at 22-42px, which is the whole size range these are drawn at.

    threshold  luminance at the 50% point (default 0.28)
    band       half-width of the soft edge (default 0.07)

  Lower the threshold for a heavier, more solid mark; raise it to knock out more interior detail.
  Always eyeball the result at 42/30/26/22px WITH the white filter applied before shipping it —
  a mark that reads at 192px can turn to mush at 22px.

  Source art is the publisher's. This only re-renders it for legibility in a dark UI, the same
  way the other bundled game marks are single-colour; swap in licensed art if an event requires it.
*/
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const [SRC, OUT] = process.argv.slice(2);
const THRESH = Number(process.argv[4] || 0.28);
const BAND = Number(process.argv[5] || 0.07);

if (!SRC || !OUT) {
  console.error('usage: electron scripts/make-mono-logo.js <source.png> <out.png> [threshold] [band]');
  process.exit(1);
}

app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 400, show: false });
  await win.loadURL('data:text/html,<body style="margin:0">');
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(SRC).toString('base64');

  const out = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(dataUrl)};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    const t0 = ${THRESH} - ${BAND}, t1 = ${THRESH} + ${BAND};
    for (let i = 0; i < p.length; i += 4) {
      const a = p[i + 3];
      if (!a) continue;
      const lum = (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255;
      let l;
      if (lum <= t0) l = 0;
      else if (lum >= t1) l = 1;
      else { const x = (lum - t0) / (t1 - t0); l = x * x * (3 - 2 * x); }
      p[i] = p[i + 1] = p[i + 2] = 255;   // white — the UI filter would force this anyway
      p[i + 3] = Math.round(a * l);       // luminance -> alpha
    }
    ctx.putImageData(d, 0, 0);
    return { url: c.toDataURL('image/png'), w: c.width, h: c.height };
  })()`);

  fs.writeFileSync(OUT, Buffer.from(out.url.split(',')[1], 'base64'));
  console.log(`wrote ${OUT} (${out.w}x${out.h}, threshold ${THRESH}, band ${BAND})`);
  app.quit();
});
