// node_modules/electron/dist/electron scripts/make-icons.js
// Builds the app icon from the NE mark (assets/icon.png, white on transparent): the mark centred on
// a dark rounded tile with a blurple edge, so it reads on light and dark taskbars alike.
//   assets/app-icon.png         1024x1024 (windows, tray, docs)
//   assets/installer/app.ico    16-256 px, for the installer, uninstaller and shortcuts
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const MARK = path.join(ROOT, 'assets', 'icon.png');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas></canvas>');
  const mark = 'data:image/png;base64,' + fs.readFileSync(MARK).toString('base64');
  const pngs = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(mark)}; await img.decode();
    function tile(size) {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = c.getContext('2d');
      // Small sizes get a bigger mark and no edge: detail disappears below 32px.
      const small = size <= 24;
      const pad = small ? 0 : size * 0.04, r = size * (small ? 0.18 : 0.22), s = size - pad * 2;
      const rr = (x, y, w, h, rad) => { g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad); g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath(); };
      const bg = g.createLinearGradient(0, pad, 0, pad + s);
      bg.addColorStop(0, '#1b1e2b'); bg.addColorStop(1, '#0b0c0f');
      rr(pad, pad, s, s, r); g.fillStyle = bg; g.fill();
      if (!small) {
        // soft blurple glow from the top and a thin edge
        const glow = g.createRadialGradient(size / 2, pad, 0, size / 2, pad, s * 0.9);
        glow.addColorStop(0, 'rgba(88,101,242,0.35)'); glow.addColorStop(1, 'rgba(88,101,242,0)');
        rr(pad, pad, s, s, r); g.fillStyle = glow; g.fill();
        g.lineWidth = Math.max(1, size * 0.012); g.strokeStyle = 'rgba(106,118,244,0.85)';
        rr(pad + g.lineWidth / 2, pad + g.lineWidth / 2, s - g.lineWidth, s - g.lineWidth, r); g.stroke();
      }
      // mark: keep its aspect, fit inside the tile
      const box = s * (small ? 0.78 : 0.62);
      const k = Math.min(box / img.width, box / img.height);
      const w = img.width * k, h = img.height * k;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      return c.toDataURL('image/png').split(',')[1];
    }
    const out = {};
    for (const n of ${JSON.stringify([1024].concat(SIZES))}) out[n] = tile(n);
    return out;
  })()`);
  const buf = (n) => Buffer.from(pngs[n], 'base64');
  fs.writeFileSync(path.join(ROOT, 'assets', 'app-icon.png'), buf(1024));
  // ICO: header + directory + PNG-compressed images (supported since Windows Vista)
  const imgs = SIZES.map(buf);
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(SIZES.length, 4);
  const dir = Buffer.alloc(16 * SIZES.length);
  let off = 6 + dir.length;
  SIZES.forEach((sz, i) => {
    const e = i * 16;
    dir.writeUInt8(sz >= 256 ? 0 : sz, e); dir.writeUInt8(sz >= 256 ? 0 : sz, e + 1);
    dir.writeUInt8(0, e + 2); dir.writeUInt8(0, e + 3); dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(imgs[i].length, e + 8); dir.writeUInt32LE(off, e + 12);
    off += imgs[i].length;
  });
  fs.mkdirSync(path.join(ROOT, 'assets', 'installer'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'assets', 'installer', 'app.ico'), Buffer.concat([head, dir, ...imgs]));
  // preview sheet for review (not shipped: written to the OS temp folder)
  console.log('wrote assets/app-icon.png and assets/installer/app.ico (' + SIZES.join(', ') + ')');
  app.exit(0);
});
