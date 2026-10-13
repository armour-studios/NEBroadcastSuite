// node test/custom-overlays.test.js
// Custom overlay layouts (backend/custom-overlays.js): what a save keeps, what it refuses, and the
// file store round trip. The renderer field catalogue (overlay/custom-render.js) is checked too:
// every field resolves against an empty state without throwing.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const co = require('../backend/custom-overlays.js');

// 1. Sanitising
{
  const o = co.cleanOverlay({ name: '  My scorebug  ', elements: [
    { type: 'text', x: 10.4, y: 20, w: 300, h: 80, text: { content: 'Hi', bind: 'team.blue.name', size: 9999, weight: 750, color: 'red; background:url(x)', align: 'sideways' } },
    { type: 'image', x: 0, y: 0, w: 100, h: 100, image: { src: 'data:image/png;base64,AAAA', fit: 'cover' } },
    { type: 'image', x: 0, y: 0, w: 100, h: 100, image: { src: 'https://x.test/logo.png' } },
    { type: 'shape', x: 0, y: 0, w: 100, h: 100, shape: { fill: '#112233', fill2: 'rgba(0,0,0,0.5)', radius: 12 } },
    { type: 'script', x: 0, y: 0 },
    null,
  ] });
  assert.strictEqual(o.name, 'My scorebug');
  assert.ok(/^co[0-9a-f]+$/.test(o.id), 'an id is minted');
  assert.strictEqual(o.elements.length, 4, 'unknown types and junk are dropped');
  const t = o.elements[0];
  assert.strictEqual(t.x, 10, 'positions are whole pixels');
  assert.strictEqual(t.text.size, 600, 'size is clamped');
  assert.deepStrictEqual(Object.keys(t.fx).sort(), ['anim', 'animMs', 'blur', 'rot', 'shadow', 'skew'], 'effects are always present');
  assert.strictEqual(t.text.weight, 700, 'odd weights fall back');
  assert.strictEqual(t.text.color, '#ffffff', 'a colour that is not a colour is refused');
  assert.strictEqual(t.text.align, 'center');
  assert.strictEqual(o.elements[1].image.src, '', 'inline data: images are dropped');
  assert.strictEqual(o.elements[2].image.src, 'https://x.test/logo.png');
  assert.strictEqual(o.elements[3].shape.fill2, 'rgba(0,0,0,0.5)');
  assert.strictEqual(o.w, 1920); assert.strictEqual(o.h, 1080);
  console.log('PASS  saves keep a clean layout and refuse junk');
}

// 2. Store round trip
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-'));
  const s1 = co.createStore(dir);
  const a = s1.save({ name: 'A', elements: [{ type: 'shape', x: 1, y: 2, w: 3, h: 4 }] });
  s1.save({ id: a.id, name: 'A renamed', elements: a.elements });
  const b = s1.save({ name: 'B', elements: [] });
  await s1.flush();
  const s2 = co.createStore(dir);
  assert.deepStrictEqual(s2.summaries().map((x) => x.name).sort(), ['A renamed', 'B']);
  assert.strictEqual(s2.get(a.id).elements[0].w, 3);
  assert.ok(s2.remove(b.id));
  await s2.flush();
  assert.deepStrictEqual(co.createStore(dir).summaries().map((x) => x.name), ['A renamed']);
  console.log('PASS  store saves, renames in place, reloads and deletes');

  // 3. Every live field resolves on an empty state.
  const src = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'custom-render.js'), 'utf8');
  const win = {};
  vm.runInNewContext(src, { window: win, document: {} });
  const C = win.CustomOverlay;
  assert.ok(C && C.FIELDS.length > 20);
  C.FIELDS.forEach((f) => { const v = C.value(f.id, {}, Date.now()); assert.strictEqual(typeof v, f.kind === 'number' ? 'number' : 'string', f.id + ' returns a ' + (f.kind === 'number' ? 'number' : 'string')); });
  assert.strictEqual(C.fill('{team.blue.name} vs {team.orange.name}', { teams: { blue: { name: 'A' }, orange: { name: 'B' } } }), 'A vs B');
  assert.strictEqual(C.fill('{nope}', {}), '{nope}', 'unknown tokens are left alone');
  assert.strictEqual(C.value('break.timer', { breakScreen: { endsAt: 1000 + 125000 } }, 1000), '2:05');
  console.log('PASS  every field resolves; tokens fill; the countdown formats');

  // 4. Every builder template survives a save whole and binds only to fields the renderer knows.
  const ids = new Set(C.FIELDS.map((f) => f.id));
  const showIds = new Set(C.SHOW.map((x) => x[0]));
  const bsrc = fs.readFileSync(path.join(__dirname, '..', 'control-panel', 'overlay-builder.js'), 'utf8');
  const noop = () => {};
  const bwin = { CustomOverlay: C, addEventListener: noop };
  vm.runInNewContext(bsrc, { window: bwin, document: { addEventListener: noop, getElementById: () => null }, setInterval: noop, setTimeout: noop });
  const tpls = bwin.__ovb.templates;
  assert.ok(Object.keys(tpls).length >= 10, 'there are templates');
  for (const [key, t] of Object.entries(tpls)) {
    const els = t.els();
    const saved = co.cleanOverlay({ name: t.name, kind: t.kind, elements: els });
    assert.strictEqual(saved.elements.length, els.length, key + ': no piece dropped');
    assert.strictEqual(saved.kind, t.kind, key + ': kind kept');
    for (const e of els) {
      const part = e[e.type] || {};
      for (const k of ['bind', 'colorBind', 'fillBind', 'borderBind']) if (part[k]) assert.ok(ids.has(part[k]), key + ' / ' + e.name + ': unknown field ' + part[k]);
      assert.ok(showIds.has(e.show) || /^gfx:/.test(e.show), key + ' / ' + e.name + ': show ' + e.show);
      const txt = part.content || '';
      (txt.match(/\{([a-z0-9.]+)\}/gi) || []).forEach((tok) => assert.ok(ids.has(tok.slice(1, -1)), key + ': unknown token ' + tok));
    }
  }
  console.log('PASS  every template saves whole and uses known fields');
  console.log('\nAll custom overlay tests passed.');
})().catch((e) => { console.error('FAIL ', (e && e.stack) || e); process.exit(1); });
