'use strict';
// "Add to OBS" + "Build show scenes" against a fake obs-websocket that models scenes, inputs,
// item order (index 0 = bottom), studio mode and the canvas size.
const assert = require('assert');
const { workingScene, placeOverlay, buildShowScenes, SHOW_SCENES } = require('../backend/obs-overlay-place');

function fakeObs(opts = {}) {
  const scenes = new Map();   // name -> [{id, source, enabled, transform}]
  const inputs = new Map();   // name -> settings
  let nextId = 1;
  (opts.scenes || ['Scene']).forEach((s) => scenes.set(s, []));
  const calls = [];
  const obs = {
    calls, scenes, inputs,
    async call(type, d = {}) {
      calls.push(type);
      const items = (n) => { if (!scenes.has(n)) throw new Error('no scene ' + n); return scenes.get(n); };
      switch (type) {
        case 'GetStudioModeEnabled': return { studioModeEnabled: !!opts.studio };
        case 'GetCurrentPreviewScene': return { currentPreviewSceneName: opts.preview };
        case 'GetCurrentProgramScene': return { currentProgramSceneName: opts.program || 'Scene' };
        case 'GetSceneList': return { scenes: [...scenes.keys()].map((sceneName) => ({ sceneName })) };
        case 'GetInputList': return { inputs: [...inputs.keys()].map((inputName) => ({ inputName })) };
        case 'CreateScene': scenes.set(d.sceneName, []); return {};
        case 'CreateInput': {
          if (inputs.has(d.inputName)) throw new Error('exists');
          inputs.set(d.inputName, { ...d.inputSettings });
          const it = { id: nextId++, source: d.inputName, enabled: true };
          items(d.sceneName).push(it);
          return { sceneItemId: it.id };
        }
        case 'SetInputSettings': Object.assign(inputs.get(d.inputName), d.inputSettings); return {};
        case 'GetSceneItemId': {
          const it = items(d.sceneName).find((x) => x.source === d.sourceName);
          if (!it) throw new Error('not found');
          return { sceneItemId: it.id };
        }
        case 'CreateSceneItem': {
          const it = { id: nextId++, source: d.sourceName, enabled: true };
          items(d.sceneName).push(it);
          return { sceneItemId: it.id };
        }
        case 'GetSceneItemList': return { sceneItems: items(d.sceneName).map((x) => ({ sceneItemId: x.id, sourceName: x.source })) };
        case 'SetSceneItemIndex': {
          const arr = items(d.sceneName);
          const i = arr.findIndex((x) => x.id === d.sceneItemId);
          const [it] = arr.splice(i, 1);
          arr.splice(d.sceneItemIndex, 0, it);
          return {};
        }
        case 'SetSceneItemEnabled': items(d.sceneName).find((x) => x.id === d.sceneItemId).enabled = d.sceneItemEnabled; return {};
        case 'GetVideoSettings': return { baseWidth: opts.cw || 1920, baseHeight: opts.ch || 1080 };
        case 'SetSceneItemTransform': items(d.sceneName).find((x) => x.id === d.sceneItemId).transform = d.sceneItemTransform; return {};
        default: throw new Error('unexpected ' + type);
      }
    }
  };
  return obs;
}
const order = (obs, s) => obs.scenes.get(s).map((x) => x.source);

(async () => {
  // Working scene: program normally, preview in Studio Mode.
  assert.strictEqual(await workingScene(fakeObs({ program: 'Live' , scenes: ['Live'] })), 'Live');
  assert.strictEqual(await workingScene(fakeObs({ program: 'Live', studio: true, preview: 'Next', scenes: ['Live', 'Next'] })), 'Next');

  // New overlay lands on top; adding a second puts that one on top.
  let obs = fakeObs({ scenes: ['Scene'] });
  obs.scenes.get('Scene').push({ id: 900, source: 'Game Capture', enabled: true });
  assert.strictEqual(await placeOverlay(obs, 'Scene', 'NE A', 'http://localhost:3000/a.html', 1920, 1080), 'added');
  await placeOverlay(obs, 'Scene', 'NE B', 'http://localhost:3000/b.html', 1920, 1080);
  assert.deepStrictEqual(order(obs, 'Scene'), ['Game Capture', 'NE A', 'NE B']);

  // Re-adding an overlay that is already in the scene raises it, re-enables it, refreshes the URL.
  obs.scenes.get('Scene').find((x) => x.source === 'NE A').enabled = false;
  assert.strictEqual(await placeOverlay(obs, 'Scene', 'NE A', 'http://localhost:3000/a.html?bg=000', 1920, 1080), 'moved');
  assert.deepStrictEqual(order(obs, 'Scene'), ['Game Capture', 'NE B', 'NE A']);
  assert.strictEqual(obs.scenes.get('Scene').find((x) => x.source === 'NE A').enabled, true);
  assert.strictEqual(obs.inputs.get('NE A').url, 'http://localhost:3000/a.html?bg=000');

  // An input that lives in another scene is added to this one (not just URL-updated).
  obs.scenes.set('Other', []);
  assert.strictEqual(await placeOverlay(obs, 'Other', 'NE A', 'http://localhost:3000/a.html', 1920, 1080), 'added');
  assert.deepStrictEqual(order(obs, 'Other'), ['NE A']);
  assert.strictEqual(obs.inputs.size, 2, 'no duplicate input');

  // Native canvas: no transform. 1440p canvas: fitted. Vertical overlay on 1080p: fitted.
  assert.strictEqual(obs.scenes.get('Other')[0].transform, undefined);
  obs = fakeObs({ scenes: ['S'], cw: 2560, ch: 1440 });
  await placeOverlay(obs, 'S', 'NE A', 'http://x/a', 1920, 1080);
  assert.deepStrictEqual([obs.scenes.get('S')[0].transform.boundsWidth, obs.scenes.get('S')[0].transform.boundsHeight], [2560, 1440]);
  obs = fakeObs({ scenes: ['S'] });
  await placeOverlay(obs, 'S', 'NE V', 'http://x/v', 1080, 1920);
  assert.strictEqual(obs.scenes.get('S')[0].transform.boundsType, 'OBS_BOUNDS_SCALE_INNER');

  // Build show scenes: creates five scenes with shared inputs, graphics on top, maps empty moments.
  obs = fakeObs({ scenes: ['My Scene'] });
  let r = await buildShowScenes(obs, 'http://localhost:3000', { inGame: 'My Scene' });
  assert.strictEqual(r.created.length, SHOW_SCENES.length);
  assert.deepStrictEqual(order(obs, 'NE In Game'), ['NE Scoreboard', 'NE Graphics']);
  assert.deepStrictEqual(order(obs, 'NE Starting Soon'), ['NE Graphics']);
  assert.deepStrictEqual(order(obs, 'NE Replay'), ['NE Replay Player', 'NE Graphics']);
  assert.strictEqual(obs.inputs.get('NE Scoreboard').url, 'http://localhost:3000/live.html');
  // Graphics that live inside gfx.html are never added as separate sources (they would show twice).
  const GFX_LAYERS = ['/countdown.html', '/winner.html', '/intro.html', '/bracket.html', '/standings.html', '/mapscreen.html', '/ticker.html'];
  for (const [, settings] of obs.inputs) assert.ok(!GFX_LAYERS.some((p) => settings.url.endsWith(p)), 'no gfx.html layer as its own source: ' + settings.url);
  // Every scene ends with NE Graphics on top.
  for (const def of SHOW_SCENES) assert.strictEqual(order(obs, def.scene).slice(-1)[0], 'NE Graphics');
  assert.ok(!r.mapping.inGame, 'a producer mapping to an existing scene is kept');
  assert.strictEqual(r.mapping.casters, 'NE Casters');
  assert.strictEqual(obs.inputs.get('NE Graphics').url, 'http://localhost:3000/gfx.html');
  const inputCount = obs.inputs.size;
  assert.ok(obs.scenes.has('My Scene') && order(obs, 'My Scene').length === 0, 'the producer scene is untouched');

  // Second run: nothing duplicated, nothing remapped; a user layer added on top is pushed under ours.
  obs.scenes.get('NE In Game').push({ id: 999, source: 'Game Capture', enabled: true });
  r = await buildShowScenes(obs, 'http://localhost:3000', { inGame: 'My Scene', casters: 'NE Casters', break: 'NE Starting Soon', replay: 'NE Replay' });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.updated.length, SHOW_SCENES.length);
  assert.deepStrictEqual(r.mapping, {});
  assert.strictEqual(obs.inputs.size, inputCount);
  assert.strictEqual(order(obs, 'NE In Game').slice(-1)[0], 'NE Graphics');
  assert.strictEqual(obs.scenes.get('NE In Game').length, 3);

  // A mapping that points at a scene OBS no longer has is repaired.
  r = await buildShowScenes(obs, 'http://localhost:3000', { inGame: 'Deleted Scene' });
  assert.strictEqual(r.mapping.inGame, 'NE In Game');

  // Never touches profiles, collections or settings.
  assert.ok(!obs.calls.some((c) => /Profile|SceneCollection|SetVideoSettings|SetStreamServiceSettings/.test(c)));
  console.log('obs-overlay-place: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
