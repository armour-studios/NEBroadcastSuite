/* ─── gfx-form-kit.js — one clean look for every Graphics editor ──────────────────────────────
   Applies the Map Pool card language to the per-graphic editors without rewriting each one's
   markup or wiring. The ORIGINAL controls stay in the DOM as the value stores (ids, listeners and
   app.js reads/writes are untouched); the kit only adds a friendlier face next to them:

   - A <select> with 2-4 short options becomes segmented buttons (the select is hidden). Options
     that change later (team names, a list that grows past 4) are followed: the buttons rebuild,
     or the plain select comes back.
   - A number input gets − / + steppers.
   - A row holding a text box, text area or long dropdown spans the full width, so text is never
     clipped; short controls flow two to a row.
   - A row whose control is an on/off switch becomes a tidy "label … switch" line.

   Programmatic value changes (app.js setting select.value) fire no event, so window._gfxFormSync()
   repaints the buttons; app.js calls it after every state update. Loads after app.js. */
(function () {
  const SEG_MAX = 4;
  const SEG_LABEL_MAX = 18;
  const ROOTS = '.gfx-scene-panel .gfx-scene-body, .gfx-front-panel';
  const clean = (t) => String(t || '').replace(/^[\s—–-]+/, '').replace(/[\s—–-]+$/, '').replace(/…$/, '…').trim();

  function segEligible(sel) {
    if (sel.multiple || sel.hasAttribute('data-gfk-noseg') || sel.closest('[data-gfk-noseg]')) return false;
    // Already hidden by its own code (another picker fronts it) — leave it alone.
    if (sel.hidden || sel.style.display === 'none') return false;
    // OBS scene pickers list whatever scenes exist; long names make poor buttons.
    if (/scene/i.test((sel.id || '') + ' ' + (sel.className || ''))) return false;
    const opts = Array.from(sel.options).filter((o) => !o.hidden);
    if (opts.length < 2 || opts.length > SEG_MAX) return false;
    // A "choose one…" placeholder means this is a picker over a list that grows (presets, leagues,
    // events, teams): buttons would show the placeholder as a choice. Keep it a dropdown.
    if (opts.some((o) => o.value === '' && /^[\s—–-]*(select|choose|pick|presets?|league|event|team)\b|(\.\.\.|…)[\s—–-]*$/i.test(o.textContent))) return false;
    return opts.every((o) => { const t = clean(o.textContent); return t.length > 0 && t.length <= SEG_LABEL_MAX; });
  }

  function paintSeg(sel) {
    const seg = sel._gfkSeg; if (!seg) return;
    const opts = Array.from(sel.options).filter((o) => !o.hidden);
    const sig = opts.map((o) => o.value + '\u0001' + o.textContent).join('\u0002');
    if (seg._sig !== sig) {
      seg._sig = sig;
      seg.innerHTML = '';
      opts.forEach((o) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'gfk-seg-btn';
        b.dataset.v = o.value; b.textContent = clean(o.textContent); b.title = clean(o.textContent);
        b.disabled = o.disabled;
        seg.appendChild(b);
      });
    }
    // Very short labels (Bo1, AM, 2v2) size to their text instead of sharing the width equally.
    seg.classList.toggle('is-compact', opts.every((o) => clean(o.textContent).length <= 5));
    seg.querySelectorAll('.gfk-seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.v === sel.value));
    seg.classList.toggle('is-disabled', !!sel.disabled);
  }

  function setupSelect(sel) {
    if (sel._gfkSetup) return;
    sel._gfkSetup = true;
    const apply = () => {
      const want = segEligible(sel);
      if (want && !sel._gfkSeg) {
        const seg = document.createElement('div'); seg.className = 'gfk-seg'; seg.setAttribute('role', 'group');
        if (sel.id) seg.dataset.for = sel.id;
        seg.addEventListener('click', (e) => {
          const b = e.target.closest('.gfk-seg-btn'); if (!b || b.disabled || sel.disabled) return;
          if (sel.value !== b.dataset.v) { sel.value = b.dataset.v; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
          paintSeg(sel);
        });
        sel.after(seg);
        sel._gfkSeg = seg;
      } else if (!want && sel._gfkSeg) {
        sel._gfkSeg.remove(); sel._gfkSeg = null;
      }
      sel.classList.toggle('gfk-store', !!sel._gfkSeg);
      if (sel._gfkSeg) paintSeg(sel);
      tagRow(sel.closest('.field-row'));
    };
    sel.addEventListener('change', () => { if (sel._gfkSeg) paintSeg(sel); });
    // Options rebuilt by app.js (team lists, scene lists) → re-decide buttons vs dropdown.
    new MutationObserver(apply).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
    apply();
  }

  function setupNumber(inp) {
    if (inp._gfkSetup || inp.closest('.gfk-step, .mp-step, [data-gfk-nostep]')) return;
    inp._gfkSetup = true;
    const wrap = document.createElement('div'); wrap.className = 'gfk-step';
    const mk = (txt, d, title) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'gfk-step-btn'; b.textContent = txt; b.title = title;
      b.addEventListener('click', () => {
        if (inp.disabled || inp.readOnly) return;
        const step = Number(inp.step) > 0 ? Number(inp.step) : 1;
        const cur = parseFloat(inp.value); let next = (isNaN(cur) ? 0 : cur) + d * step;
        if (inp.min !== '' && !isNaN(Number(inp.min))) next = Math.max(Number(inp.min), next);
        if (inp.max !== '' && !isNaN(Number(inp.max))) next = Math.min(Number(inp.max), next);
        inp.value = String(Math.round(next * 1000) / 1000);
        inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return b;
    };
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(mk('−', -1, 'Less')); wrap.appendChild(inp); wrap.appendChild(mk('+', 1, 'More'));
    inp.classList.add('gfk-step-input');
  }

  // Width + kind for one field row, from what it holds.
  function tagRow(row) {
    if (!row) return;
    const wideCtl = row.querySelector('textarea, input[type="text"]:not(.gfk-store), input[type="url"], input[type="search"], input:not([type])');
    const sel = row.querySelector('select');
    // A dropdown that stays a dropdown holds names (teams, scenes, events): give it the full width.
    const plainSel = sel && !sel._gfkSeg;
    // Buttons with longer labels (team names) need the full width or they get cut to "Rocke…".
    const bigSeg = sel && sel._gfkSeg && (sel._gfkSeg.children.length > 3
      || Array.from(sel._gfkSeg.children).some((b) => b.textContent.length > 9));
    const lbl = row.querySelector('.field-label');
    const longLabel = lbl && lbl.textContent.trim().length > 28;
    row.classList.toggle('gfk-wide', !!(wideCtl || plainSel || bigSeg || longLabel));
    const sw = row.querySelector('.switch, .qt-toggle');
    const onlySwitch = sw && !row.querySelector('select, textarea, input[type="text"], input[type="number"]');
    row.classList.toggle('gfk-toggle-row', !!onlySwitch);
  }

  function enhance(root) {
    if (!root) return;
    root.classList.add('gfk');
    root.querySelectorAll('select').forEach(setupSelect);
    root.querySelectorAll('input[type="number"]').forEach(setupNumber);
    root.querySelectorAll('.field-row').forEach(tagRow);
  }
  function enhanceAll() { document.querySelectorAll(ROOTS).forEach(enhance); }

  window._gfxFormSync = function () {
    document.querySelectorAll('.gfk select.gfk-store').forEach(paintSeg);
  };
  window._gfxFormEnhance = enhanceAll;

  // Editors that build parts of themselves later (Desk Show topics, Drop Map POIs, Pick / Ban) get
  // their new controls enhanced as they appear.
  const later = new MutationObserver((recs) => {
    for (const r of recs) for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      const root = n.closest && n.closest(ROOTS);
      if (!root) continue;
      if (n.matches('select')) setupSelect(n); else n.querySelectorAll && n.querySelectorAll('select').forEach(setupSelect);
      if (n.matches('input[type="number"]')) setupNumber(n); else n.querySelectorAll && n.querySelectorAll('input[type="number"]').forEach(setupNumber);
    }
  });
  function start() {
    enhanceAll();
    document.querySelectorAll(ROOTS).forEach((r) => later.observe(r, { childList: true, subtree: true }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
