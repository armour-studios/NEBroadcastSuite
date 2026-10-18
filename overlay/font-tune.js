/* font-tune.js — keep capitals the same height whatever font the producer picks.
 *
 * Some fonts (Industry is the one producers hit) hint certain sizes so round capitals (S, D, G, O)
 * land a pixel shorter than flat ones (E, K): "sEEK", "sEEd". Which sizes break depends on the font
 * and weight (Industry 700 breaks at 15.5-18px and 22.5-24px, 800 never does), so no fixed CSS size
 * is safe for every font. This measures it instead: for every px font-size in the page's own <style>
 * rules, it draws a few capitals on a canvas in the active font and, if their heights differ, moves
 * that rule to the nearest size within 1.5px that draws them evenly. Rules are changed in place
 * (same selector, same specificity) and remembered, so a later font change starts from the
 * original sizes.
 *
 *   FontTune.run()  re-check now (it also re-checks by itself when the page's font changes)
 *   ?fonttune=0     turn it off for one browser source
 */
(function () {
  'use strict';
  if (window.FontTune) return;   // served pages get it injected AND may load it themselves
  if (new URLSearchParams(location.search).get('fonttune') === '0') { window.FontTune = { run() {} }; return; }
  const SAMPLE = ['S', 'E', 'D', 'G', 'O', 'K', '0', '8'];
  const STEPS = [-0.5, 0.5, -1, 1, -1.5, 1.5];
  const cache = new Map();
  const orig = new Map();          // CSSStyleRule -> its authored font-size (px)
  let canvas = null, ctx = null, runSeq = 0;

  function inkHeights(font) {
    if (!canvas) { canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80; ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    return SAMPLE.map((ch) => {
      ctx.clearRect(0, 0, 80, 80); ctx.fillStyle = '#fff'; ctx.font = font; ctx.textBaseline = 'alphabetic';
      ctx.fillText(ch, 10, 56);
      const d = ctx.getImageData(0, 0, 80, 80).data;
      let top = 99, bot = -1;
      for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) if (d[(y * 80 + x) * 4 + 3] > 128) { if (y < top) top = y; if (y > bot) bot = y; }
      return bot - top;
    });
  }
  function even(fam, w, px) {
    const key = fam + '|' + w + '|' + px;
    if (!cache.has(key)) { const h = inkHeights(w + ' ' + px + 'px ' + fam); cache.set(key, Math.max(...h) - Math.min(...h) === 0); }
    return cache.get(key);
  }
  function rules() {
    const out = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let list; try { list = sheet.cssRules; } catch (e) { continue; }   // cross-origin sheet
      for (const r of Array.from(list || [])) {
        if (r.type !== 1 || !r.style) continue;
        if (!orig.has(r)) { const m = /^([\d.]+)px$/.exec(r.style.fontSize || ''); if (m) orig.set(r, parseFloat(m[1])); }
        if (orig.has(r)) out.push(r);
      }
    }
    return out;
  }
  async function run() {
    const seq = ++runSeq;
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    const fam = getComputedStyle(document.body).fontFamily;
    if (!fam) return;
    const list = rules();
    const want = new Set();
    list.forEach((r) => { const w = r.style.fontWeight || '700'; const px = orig.get(r); [0, ...STEPS].forEach((d) => want.add(w + ' ' + (px + d) + 'px ' + fam)); });
    try { await Promise.all(Array.from(want).map((f) => document.fonts.load(f))); } catch (e) {}
    if (seq !== runSeq) return;   // a newer run (font changed again) owns the result
    list.forEach((r) => {
      const w = r.style.fontWeight || '700';
      const px = orig.get(r);
      let use = px;
      if (!even(fam, w, px)) { const d = STEPS.find((s) => even(fam, w, px + s)); if (d != null) use = px + d; }
      const val = use + 'px';
      if (r.style.fontSize !== val) r.style.fontSize = val;
    });
  }
  window.FontTune = { run };
  // Overlays switch font at runtime (the producer's font, a brand kit's font) by setting --main-font
  // or a font-family on <html>/<body>. Re-check whenever the font that body text resolves to changes.
  let lastFam = null;
  function check() {
    if (!document.body) return;
    const fam = getComputedStyle(document.body).fontFamily;
    if (fam !== lastFam) { lastFam = fam; run(); }
  }
  function start() {
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => { cache.clear(); run(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.addEventListener('load', () => run());   // linked stylesheets can finish after DOMContentLoaded
})();
