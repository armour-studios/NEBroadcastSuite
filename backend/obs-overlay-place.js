'use strict';
// Putting overlays into the producer's OBS: one card's "Add to OBS", and "Build show scenes".
// Only sources and scene items are touched, never profiles, scene collections or settings.
// `obs` is anything with obs-websocket v5's `call(requestType, data)`.

// The scene a producer is working on: the preview scene in Studio Mode, else program.
async function workingScene(obs) {
  try {
    const sm = await obs.call('GetStudioModeEnabled');
    if (sm && sm.studioModeEnabled) {
      const p = (await obs.call('GetCurrentPreviewScene')).currentPreviewSceneName;
      if (p) return p;
    }
  } catch (e) {}
  return (await obs.call('GetCurrentProgramScene')).currentProgramSceneName;
}

// Put a browser-source overlay into `sceneName` as its TOP visible layer. One OBS input per name:
// an existing one gets its URL refreshed and is added to this scene if it only lives elsewhere.
// Overlays are designed at their native size (1920x1080, or 1080x1920 for vertical ones); on any
// other canvas the item is fitted inside it. Returns 'added' | 'moved'.
async function placeOverlay(obs, sceneName, name, url, nw, nh, inputNames) {
  const exists = inputNames ? inputNames.has(name)
    : ((await obs.call('GetInputList')).inputs || []).some((i) => i.inputName === name);
  let itemId = null, how = 'added';
  if (exists) {
    await obs.call('SetInputSettings', { inputName: name, inputSettings: { url, width: nw, height: nh } });
    try { itemId = (await obs.call('GetSceneItemId', { sceneName, sourceName: name })).sceneItemId; } catch (e) { itemId = null; }
    if (itemId == null) itemId = (await obs.call('CreateSceneItem', { sceneName, sourceName: name, sceneItemEnabled: true })).sceneItemId;
    else how = 'moved';
  } else {
    itemId = (await obs.call('CreateInput', {
      sceneName, inputName: name, inputKind: 'browser_source', sceneItemEnabled: true,
      inputSettings: { url, width: nw, height: nh, reroute_audio: false }
    })).sceneItemId;
    if (inputNames) inputNames.add(name);
  }
  const items = (await obs.call('GetSceneItemList', { sceneName })).sceneItems || [];
  await obs.call('SetSceneItemIndex', { sceneName, sceneItemId: itemId, sceneItemIndex: Math.max(0, items.length - 1) });
  await obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: itemId, sceneItemEnabled: true });
  try {
    const vs = await obs.call('GetVideoSettings');
    const cw = vs.baseWidth, ch = vs.baseHeight;
    // Fit when the canvas differs from the overlay's size, and also when it is unknown: Streamlabs'
    // API reports no canvas size (0x0), and there SCALE_INNER becomes its own fit-to-screen.
    if (!cw || !ch || cw !== nw || ch !== nh) {
      await obs.call('SetSceneItemTransform', { sceneName, sceneItemId: itemId, sceneItemTransform: {
        positionX: 0, positionY: 0, alignment: 5, rotation: 0,
        boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: cw || nw, boundsHeight: ch || nh
      } });
    }
  } catch (e) {}
  return how;
}

// The two sources every show is built on. live.html shows the HUD of whichever game and layout is
// active in the app; gfx.html is the Graphics panel's output and carries EVERY graphic (countdown,
// winner, intro, bracket, standings, veto, ticker...). Never add those graphics as separate
// sources next to gfx.html: they would show twice when pushed from the Graphics panel.
const CORE = {
  scoreboard: ['NE Scoreboard', '/live.html'],
  graphics:   ['NE Graphics', '/gfx.html'],
};
// "Build show scenes": a small, readable set of scenes created INSIDE the producer's current scene
// collection. Layers are listed bottom to top, and NE Graphics is always the top layer. `key` is the
// app's broadcast moment (state.obs.scenes) the scene is wired to. The replay player and the caster
// desk are full-screen scenes of their own, not gfx.html layers, so they get their own sources.
const SHOW_SCENES = [
  { scene: 'NE In Game',       key: 'inGame',  layers: [CORE.scoreboard, CORE.graphics] },
  { scene: 'NE Starting Soon', key: 'break',   layers: [CORE.graphics] },
  { scene: 'NE Casters',       key: 'casters', layers: [['NE Casters', '/duorow.html'], CORE.graphics] },
  { scene: 'NE Replay',        key: 'replay',  layers: [['NE Replay Player', '/replay-player.html'], CORE.graphics] },
  // The other moments the app cuts to: the HUD's post-game board, the bracket, an ad break.
  { scene: 'NE Post-Game',     key: 'postGame',   layers: [CORE.scoreboard, CORE.graphics] },
  { scene: 'NE Bracket',       key: 'bracket',    layers: [CORE.graphics] },   // the bracket is a gfx.html graphic: push it from Graphics
  { scene: 'NE Commercial',    key: 'commercial', layers: [CORE.graphics] },
];

// Returns { created, updated, mapping } where `mapping` is the broadcast moments to point at the
// new scenes: only those with nothing mapped, or mapped to a scene OBS no longer has. A
// producer's own choice is never overwritten.
async function buildShowScenes(obs, base, currentMapping) {
  const have = new Set(((await obs.call('GetSceneList')).scenes || []).map((s) => s.sceneName));
  const inputNames = new Set(((await obs.call('GetInputList')).inputs || []).map((i) => i.inputName));
  const created = [], updated = [], mapping = {};
  const cur = currentMapping || {};
  for (const def of SHOW_SCENES) {
    if (!have.has(def.scene)) { await obs.call('CreateScene', { sceneName: def.scene }); created.push(def.scene); }
    else updated.push(def.scene);
    for (const [name, p] of def.layers) await placeOverlay(obs, def.scene, name, base + p, 1920, 1080, inputNames);
    if (!cur[def.key] || !have.has(cur[def.key])) mapping[def.key] = def.scene;
  }
  return { created, updated, mapping };
}

module.exports = { workingScene, placeOverlay, buildShowScenes, SHOW_SCENES, CORE };
