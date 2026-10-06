'use strict';
// Preload for game overlay windows (backend/game-overlay-windows.js). Exposes NOTHING to the
// overlay page. It draws the edit-mode frame + toolbar into the DOM from this isolated world
// and talks to the main process directly, so the overlay HTML stays exactly what OBS loads.
const { ipcRenderer, webFrame, contextBridge } = require('electron');

// Overlays treat "not inside OBS" as a dev browser and show their test-trigger bars (rl-hud,
// csgo, valorant, lol-hud all check window.obsstudio). Over the game this IS the broadcast
// view, so present the same marker OBS injects. They only test for presence, never call it.
try { contextBridge.exposeInMainWorld('obsstudio', { pluginVersion: 'ne-game-overlay' }); } catch (_) { }

// Tell the overlay it is drawn over the producer's own game rather than into OBS, so it can drop
// broadcast-only layers that would cover the game's UI (rl-hud.html hides its post-game board).
const markOverGame = () => { try { document.documentElement.classList.add('ne-over-game'); } catch (_) { } };
markOverGame();
document.addEventListener('DOMContentLoaded', markOverGame);

// ── Player-safe: no full-screen takeovers over the game ─────────────────────────────────────────
// Every HUD carries broadcast takeovers that appear on cue: post-game boards, winner and line-up
// screens, breaks, replay wipes. In OBS they are the show; over the producer's own game they cover
// the game UI they need (the RL post-game board sat over Ready / Exit until the next kickoff).
// Rather than patch each of ~26 overlays (and every future one), hide any layer that PAINTS a
// background across >= 40% of the screen. HUD pieces (scorebars, player cards, minimaps) are never
// that big, and the transparent full-screen wrappers they live in paint nothing, so they stay.
const TAKEOVER_SHARE = 0.4;
const HIDE_ATTR = 'data-ne-og-hidden';
function paintsBackground(cs) {
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor || '');
  if (!m) return false;
  const p = m[1].split(',').map(Number);
  return (p.length > 3 ? p[3] : 1) >= 0.35;
}
function bigPseudo(n, which, screenArea) {
  const cs = getComputedStyle(n, which);
  if (cs.content === 'none' || cs.display === 'none' || !paintsBackground(cs)) return false;
  const w = parseFloat(cs.width), h = parseFloat(cs.height);   // 'auto' -> NaN -> not counted
  return w > 0 && h > 0 && (w * h) / screenArea >= TAKEOVER_SHARE;
}
// Share of the screen an element's box covers, clipped to the viewport.
function screenShare(n, screenArea) {
  const r = n.getBoundingClientRect();
  const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  return w > 0 && h > 0 ? (w * h) / screenArea : 0;
}
// Paints its own box: background, a ::before/::after background that is itself that big (wipes and
// vignettes are often drawn that way; a small underline on a big wrapper must NOT count, or the
// whole HUD goes), a mostly-solid image, or a video. Not IFRAME: live.html is a full-screen iframe
// around the real HUD. Not CANVAS: its pixels are often a transparent HUD layer.
function paintsSelf(n, screenArea) {
  return n.tagName === 'VIDEO'
    || (n.tagName === 'IMG' && imageMostlySolid(n))
    || paintsBackground(getComputedStyle(n))
    || bigPseudo(n, '::before', screenArea)
    || bigPseudo(n, '::after', screenArea);
}
// A large <img> is often a full-screen PNG FRAME that is mostly transparent (the image FGC
// templates draw their whole scoreboard plate that way), so size alone says nothing. Sample it at
// 48x27 and count solid pixels; only a mostly-solid image is a takeover. Cached per src; an image
// that can't be read (cross-origin, not loaded) is left alone.
const _solidCache = new Map();
function imageMostlySolid(img) {
  const src = img.currentSrc || img.src;
  if (!src || !img.complete || !img.naturalWidth) return false;
  if (_solidCache.has(src)) return _solidCache.get(src);
  let solid = false;
  try {
    const c = document.createElement('canvas'); c.width = 48; c.height = 27;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 48, 27);
    const px = g.getImageData(0, 0, 48, 27).data;
    let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 200) n++;
    solid = n / (48 * 27) > 0.5;
  } catch (_) { solid = false; }
  _solidCache.set(src, solid);
  return solid;
}
const PIECE_SHARE = 0.1;   // HUD pieces stay under this (largest seen: a CS2 player list, ~7%)
function sweepTakeovers() {
  if (!document.body) return;
  const screenArea = innerWidth * innerHeight;
  if (!screenArea) return;
  // Innermost first, so a takeover layer goes before the HUD wrapper that also contains it gets
  // looked at (by then the takeover's pieces are display:none and no longer count).
  const all = [...document.body.querySelectorAll('*')].reverse();
  for (const n of all) {
    if (n.closest('[' + HIDE_ATTR + ']')) continue;
    const share = screenShare(n, screenArea);
    if (share < TAKEOVER_SHARE) continue;
    // 1) The layer paints that area itself.
    if (paintsSelf(n, screenArea)) { n.setAttribute(HIDE_ATTR, ''); continue; }
    // 2) Or big painted pieces inside it add up to it (the RL replay cover is five skewed
    //    full-width bars, ~21% each, none of which crosses the line alone).
    let sum = 0;
    for (const d of n.querySelectorAll('*')) {
      if (d.closest('[' + HIDE_ATTR + ']')) continue;
      const ds = screenShare(d, screenArea);
      if (ds >= PIECE_SHARE && paintsSelf(d, screenArea)) sum += ds;
      if (sum >= TAKEOVER_SHARE) break;
    }
    if (sum >= TAKEOVER_SHARE) n.setAttribute(HIDE_ATTR, '');
  }
}
let sweepTimer = null;
const sweepSoon = () => { clearTimeout(sweepTimer); sweepTimer = setTimeout(sweepTakeovers, 150); };   // 1-4ms a sweep; HUDs like CS2 mutate many times a second
document.addEventListener('DOMContentLoaded', () => {
  const st = document.createElement('style');
  st.textContent = '[' + HIDE_ATTR + ']{display:none !important}';
  (document.head || document.documentElement).appendChild(st);
  sweepTakeovers();
  // Takeovers appear by class/style flips or inserted nodes; also sweep on a slow beat for
  // animation-driven ones that change neither.
  new MutationObserver(sweepSoon).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  setInterval(sweepTakeovers, 1000);
});

const ID = '__ne_game_overlay_edit';
let root = null;
let last = null;

const CSS = `
#${ID}{position:fixed;inset:0;z-index:2147483647;box-sizing:border-box;border:2px dashed #7C3AED;
  pointer-events:none;font:13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6e8ee}
#${ID} .bar{position:absolute;top:10px;left:50%;transform:translateX(-50%);transform-origin:top center;display:flex;align-items:center;gap:6px;
  padding:6px 8px;border-radius:8px;background:#0b0c0f;border:1px solid #2a2f3a;box-shadow:0 6px 24px rgba(0,0,0,.5);cursor:default;white-space:nowrap;pointer-events:auto}
#${ID} .grip{cursor:grab;padding:5px 9px;border-radius:6px;background:#1a1d24;border:1px solid #2a2f3a;user-select:none}
#${ID} .grip:hover{border-color:#7C3AED}
#${ID} .grip.on{cursor:grabbing;background:#7C3AED;border-color:#7C3AED;color:#fff}
#${ID} .nm{font-weight:600;padding:0 6px 0 2px;max-width:220px;overflow:hidden;text-overflow:ellipsis}
#${ID} .rd{color:#9aa1ad;min-width:40px;text-align:center;font-variant-numeric:tabular-nums}
#${ID} .sep{width:1px;height:18px;background:#2a2f3a;margin:0 2px}
#${ID} button{all:unset;cursor:pointer;padding:5px 9px;border-radius:6px;background:#1a1d24;border:1px solid #2a2f3a;color:#e6e8ee}
#${ID} button:hover{background:#7C3AED;border-color:#7C3AED;color:#fff}
#${ID} button.pri{background:#7C3AED;border-color:#7C3AED;color:#fff;font-weight:600}
#${ID} button.dng:hover{background:#ef4444;border-color:#ef4444;color:#fff}
#${ID} .hint{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);transform-origin:bottom center;padding:5px 10px;border-radius:6px;
  background:rgba(11,12,15,.85);color:#9aa1ad;font-size:12px;white-space:nowrap;pointer-events:none}
`;

function cmd(c, a) { ipcRenderer.send('game-overlay:toolbar', c, a); }

function build() {
  const el = document.createElement('div');
  el.id = ID;
  el.innerHTML = `<style>${CSS}</style>
    <div class="bar">
      <span class="grip" title="Drag to move the overlay">Move</span>
      <span class="nm"></span><span class="sep"></span>
      <button data-c="smaller" title="Smaller">&minus;</button><span class="rd sz"></span><button data-c="bigger" title="Bigger">+</button>
      <button data-c="fit" title="Fill the screen">Fit</button>
      <button data-c="next-screen" title="Move to the next monitor">Next screen</button><span class="sep"></span>
      <button data-c="op-down" title="More transparent">&minus;</button><span class="rd op"></span><button data-c="op-up" title="More opaque">+</button><span class="sep"></span>
      <button data-c="lock" class="pri" title="Lock: clicks pass through to the game">Lock</button>
      <button data-c="close" class="dng" title="Close this overlay window">Close</button>
    </div>
    <div class="hint"></div>`;

  el.querySelector('.bar').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-c]');
    if (!b) return;
    const c = b.dataset.c;
    const op = last ? last.opacity : 100;
    if (c === 'op-down') cmd('opacity', Math.max(10, op - 10));
    else if (c === 'op-up') cmd('opacity', Math.min(100, op + 10));
    else cmd(c);
  });
  // The window stays click-through everywhere except this toolbar, even in edit mode: the main
  // process forwards mouse moves (setIgnoreMouseEvents forward:true) and we take the mouse only
  // while the pointer is over the bar. A full-screen edit frame used to swallow every click meant
  // for the game until the producer found Lock.
  const bar = el.querySelector('.bar'), grip = el.querySelector('.grip');
  let over = false, drag = null;
  const interactive = (on) => ipcRenderer.send('game-overlay:interactive', !!on);
  bar.addEventListener('mouseenter', () => { over = true; interactive(true); });
  bar.addEventListener('mouseleave', () => { over = false; if (!drag) interactive(false); });

  // Drag the Move handle to move the window (by pointer delta, applied in the main process).
  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.screenX, y: ev.screenY };
    grip.classList.add('on');
    grip.setPointerCapture(ev.pointerId);
  });
  grip.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.screenX - drag.x, dy = ev.screenY - drag.y;
    if (!dx && !dy) return;
    drag = { x: ev.screenX, y: ev.screenY };
    ipcRenderer.send('game-overlay:drag', dx, dy);
  });
  const end = () => {
    if (!drag) return;
    drag = null; grip.classList.remove('on');
    ipcRenderer.send('game-overlay:drag-end');
    if (!over) interactive(false);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  return el;
}

// Overlay opacity. Done in the page, not with BrowserWindow.setOpacity(), which makes a transparent
// window invisible on Windows. Applied to <body> so the edit frame (a child of <html>) stays solid.
let fade = null;
function applyOpacity() {
  const pct = last && last.opacity ? last.opacity : 100;
  if (!fade) { fade = document.createElement('style'); fade.id = ID + '_fade'; }
  fade.textContent = pct >= 100 ? '' : 'body{opacity:' + (pct / 100) + ' !important}';
  if (!fade.isConnected) (document.head || document.documentElement).appendChild(fade);
}

function render() {
  applyOpacity();
  if (!last || !last.on) { if (root && root.isConnected) root.remove(); return; }
  if (!root) root = build();
  // Attached to <html>, not <body>: some overlays rebuild their body.
  if (!root.isConnected) document.documentElement.appendChild(root);
  root.querySelector('.nm').textContent = last.name || 'Overlay';
  root.querySelector('.sz').textContent = (last.scale || 100) + '%';
  root.querySelector('.op').textContent = (last.opacity || 100) + '%';
  root.querySelector('.hint').textContent =
    'Game stays clickable. Drag Move to reposition. ' + last.hotkeyEdit + ' locks / unlocks, ' + last.hotkeyHide + ' hides / shows all.';
  // The page is zoomed to fit the window; keep the controls at their real size.
  const z = webFrame.getZoomFactor() || 1;
  root.querySelector('.bar').style.zoom = String(1 / z);
  root.querySelector('.hint').style.zoom = String(1 / z);
}

ipcRenderer.on('game-overlay:edit', (_ev, data) => {
  last = data;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
  else render();
});
