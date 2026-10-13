'use strict';
// vMix "Add to vMix" / "Build show inputs" against a fake vMix that models inputs, titles and the
// four overlay channels, and adds inputs asynchronously like the real one.
const assert = require('assert');
const { ensureBrowserInput, buildShowInputs, GRAPHICS_CHANNEL } = require('../backend/vmix-place');

function fakeVmix(seed) {
  let n = 0;
  const inputs = [];
  const overlays = [1, 2, 3, 4].map((number) => ({ number, input: '' }));
  const layers = {};
  const calls = [];
  const add = (title) => { n++; inputs.push({ number: n, key: 'k' + n, title, url: '' }); return inputs[inputs.length - 1]; };
  (seed || []).forEach(add);
  const find = (ref) => inputs.find((i) => i.title === ref || i.key === ref || String(i.number) === String(ref));
  let pending = null;
  const api = {
    calls, inputs, overlays, layers,
    async call(fn, p = {}) {
      calls.push(fn);
      switch (fn) {
        case 'AddInput': {
          const [type, url] = String(p.Value).split('|');
          assert.strictEqual(type, 'Browser');
          pending = url;   // appears on the NEXT state read, like vMix's async add
          return { ok: true };
        }
        case 'SetInputName': find(p.Input).title = p.Value; return { ok: true };
        case 'BrowserNavigate': find(p.Input).url = p.Value; return { ok: true };
        case 'OverlayInput4In': overlays[3].input = String(find(p.Input).number); return { ok: true };
        case 'SetMultiViewOverlay': { const [layer, src] = String(p.Value).split(','); layers[find(p.Input).title] = { layer, src }; return { ok: true }; }
        default: return { ok: false, reason: 'unexpected ' + fn };
      }
    },
    async state() {
      if (pending) { const i = add(pending); i.url = pending; pending = null; }
      return { inputs: inputs.map((i) => ({ number: i.number, key: i.key, title: i.title })), overlays: overlays.map((o) => ({ ...o })) };
    },
  };
  return api;
}
const opts = { waitMs: 0 };

(async () => {
  // New browser input is added, then renamed to our title; a second call navigates, no duplicate.
  let v = fakeVmix(['Camera 1']);
  assert.strictEqual(await ensureBrowserInput(v, 'NE Graphics', 'http://localhost:3000/gfx.html', opts), 'added');
  assert.ok(v.inputs.some((i) => i.title === 'NE Graphics' && i.url === 'http://localhost:3000/gfx.html'));
  assert.strictEqual(await ensureBrowserInput(v, 'NE Graphics', 'http://localhost:3000/gfx.html?bg=000', opts), 'updated');
  assert.strictEqual(v.inputs.filter((i) => i.title === 'NE Graphics').length, 1);
  assert.strictEqual(v.inputs.find((i) => i.title === 'NE Graphics').url, 'http://localhost:3000/gfx.html?bg=000');
  assert.strictEqual(v.inputs.find((i) => i.title === 'Camera 1').title, 'Camera 1', 'producer input untouched');

  // Build: live.html + gfx.html are the core; graphics on the top overlay channel; scoreboard
  // layered onto the producer's game input; empty moments mapped, producer choices kept.
  v = fakeVmix(['Game Capture', 'My Desk']);
  let r = await buildShowInputs(v, 'http://localhost:3000', { inGame: 'Game Capture', casters: 'My Desk' }, opts);
  const byTitle = (t) => v.inputs.find((i) => i.title === t);
  assert.strictEqual(byTitle('NE Scoreboard').url, 'http://localhost:3000/live.html');
  assert.strictEqual(byTitle('NE Graphics').url, 'http://localhost:3000/gfx.html');
  assert.strictEqual(v.overlays[GRAPHICS_CHANNEL - 1].input, String(byTitle('NE Graphics').number));
  assert.deepStrictEqual(v.layers['Game Capture'], { layer: '1', src: 'NE Scoreboard' });
  assert.strictEqual(r.scoreboardLayeredOn, 'Game Capture');
  assert.ok(!r.mapping.casters, 'producer casters mapping kept');
  assert.strictEqual(r.mapping.replay, 'NE Replay Player');
  assert.ok(!('inGame' in r.mapping), 'never maps In Game to an overlay');
  // gfx.html layers are never separate inputs.
  assert.ok(!v.inputs.some((i) => /countdown|winner|bracket|intro|standings/.test(i.url)));

  // Second run: nothing duplicated, graphics already on top so not re-sent.
  const count = v.inputs.length;
  const sent = v.calls.filter((c) => c === 'OverlayInput4In').length;
  r = await buildShowInputs(v, 'http://localhost:3000', { inGame: 'Game Capture', casters: 'My Desk', replay: 'NE Replay Player' }, opts);
  assert.strictEqual(v.inputs.length, count);
  assert.strictEqual(r.added.length, 0);
  assert.deepStrictEqual(r.mapping, {});
  assert.strictEqual(v.calls.filter((c) => c === 'OverlayInput4In').length, sent);

  // No game input mapped: nothing layered, and a mapping to a deleted input is repaired.
  v = fakeVmix([]);
  r = await buildShowInputs(v, 'http://localhost:3000', { casters: 'Deleted Input' }, opts);
  assert.strictEqual(r.scoreboardLayeredOn, '');
  assert.strictEqual(r.mapping.casters, 'NE Casters');

  // A failing vMix call surfaces as an error instead of a silent success.
  v = fakeVmix([]);
  const bad = { ...v, call: async (fn, p) => (fn === 'AddInput' ? { ok: false, reason: 'vMix not reachable' } : v.call(fn, p)) };
  await assert.rejects(() => ensureBrowserInput(bad, 'NE Graphics', 'http://x/gfx.html', opts), /not reachable/);
  console.log('vmix-place: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
