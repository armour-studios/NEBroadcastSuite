'use strict';
// Streamlabs Desktop client: a fake Remote Control API server (JSON-RPC over WebSocket, scenes with
// the TOP layer first, helpers with resourceIds, STREAM subscriptions, PROMISE results, the
// 2-points-per-second rate limit on getScenes) driven through the same obs-websocket requests the
// app sends to OBS, including "Add to OBS" and "Build show scenes".
const assert = require('assert');
const { createSlobsClient } = require('../backend/integrations/slobs-client');
const { placeOverlay, buildShowScenes, SHOW_SCENES } = require('../backend/obs-overlay-place');

const { fakeStreamlabs, TOKEN } = require('./fixtures/fake-streamlabs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const fake = fakeStreamlabs();
  await new Promise((r) => fake.wss.once('listening', r));
  const seen = { status: [], scenes: [], lists: [], stream: [], record: [], saved: 0, mute: [], vis: [] };
  const cb = {
    onStatus: (s) => seen.status.push(s),
    onSceneChange: (n) => seen.scenes.push(n),
    onSceneListChange: (l) => seen.lists.push(l),
    onStreamStateChanged: (s) => seen.stream.push(s),
    onRecordStateChanged: (s) => seen.record.push(s),
    onReplayBufferSaved: () => { seen.saved++; },
    onInputMuteChanged: (m) => seen.mute.push(m),
    onSourceVisibilityChanged: (v) => seen.vis.push(v),
  };

  // URL handling: bare host, http, and an explicit path all land on the raw WebSocket endpoint.
  const probe = createSlobsClient();
  assert.strictEqual(probe._normalizeUrl(''), 'ws://127.0.0.1:59650/api/websocket');
  assert.strictEqual(probe._normalizeUrl('localhost'), 'ws://127.0.0.1:59650/api/websocket');
  assert.strictEqual(probe._normalizeUrl('ws://192.168.1.5:59650'), 'ws://192.168.1.5:59650/api/websocket');
  assert.strictEqual(probe._normalizeUrl('http://10.0.0.2:1234/api'), 'ws://10.0.0.2:1234/api/websocket');
  assert.ok(Math.abs(probe._dbToDeflection(0) - 1) < 1e-9);
  assert.ok(Math.abs(Math.pow(probe._dbToDeflection(-20), 3) - 0.1) < 1e-9, '-20 dB = mul 0.1 on the cubic fader');

  // Wrong token: refused, with a reason, and no reconnect loop.
  const bad = createSlobsClient({});
  await assert.rejects(bad.connect({ url: 'ws://127.0.0.1:' + fake.port(), password: 'nope' }), /refused the API token/);
  assert.strictEqual(bad.isConnected(), false);
  await bad.disconnect();
  // No token at all: says where to find it.
  const none = createSlobsClient({});
  await assert.rejects(none.connect({ url: 'ws://127.0.0.1:' + fake.port(), password: '' }), /Remote Control/);
  await none.disconnect();
  await wait(1100);   // let the fake's rate-limit window refill

  const c = createSlobsClient(cb);
  await c.connect({ url: 'ws://127.0.0.1:' + fake.port(), password: TOKEN });
  assert.strictEqual(c.isConnected(), true);
  assert.strictEqual(c.kind, 'streamlabs');
  assert.ok(seen.status.some((s) => s.connected));
  assert.strictEqual(c.getCurrentScene(), 'Main');
  assert.deepStrictEqual(seen.lists.slice(-1)[0], ['Main', 'Break']);

  // Scene cut by NAME (Streamlabs wants ids) + the switch event.
  assert.strictEqual(await c.switchScene('Break'), true);
  await wait(40);
  assert.strictEqual(c.getCurrentScene(), 'Break');
  assert.ok(fake.calls.includes('ScenesService.makeSceneActive'));
  assert.strictEqual(await c.switchScene('Nope'), false, 'unknown scene fails cleanly');
  assert.match(c.getLastError(), /no scene named "Nope"/);

  // obs-websocket reads, translated.
  const prog = await c.call('GetCurrentProgramScene');
  assert.strictEqual(prog.currentProgramSceneName, 'Break');
  await wait(1100);
  const list = await c.call('GetSceneList');
  assert.deepStrictEqual(list.scenes.map((s) => s.sceneName), ['Break', 'Main'], 'bottom-first like OBS');
  const inputs = await c.getInputList();
  assert.deepStrictEqual(inputs.map((i) => i.name), ['Mic'], 'scenes are not listed as inputs');

  // Audio: mute + volume, and Streamlabs' own mute event reaches the app.
  await c.setInputMute('Mic', true);
  await wait(30);
  assert.strictEqual(fake.sources.get([...fake.sources.keys()].find((k) => fake.sources.get(k).name === 'Mic')).muted, true);
  assert.deepStrictEqual(seen.mute.slice(-1)[0], { inputName: 'Mic', muted: true });
  assert.strictEqual((await c.call('GetInputMute', { inputName: 'Mic' })).inputMuted, true);
  await c.setInputVolume('Mic', -20);
  const vol = await c.call('GetInputVolume', { inputName: 'Mic' });
  assert.ok(Math.abs(vol.inputVolumeDb - -20) < 0.01, 'volume round-trips in dB: ' + vol.inputVolumeDb);

  // Add to OBS (works on Streamlabs): new source lands on TOP, refreshes URL when re-added.
  await wait(1100);
  const how = await placeOverlay(c, 'Main', 'NE Scoreboard', 'http://localhost:3000/live.html', 1920, 1080);
  assert.strictEqual(how, 'added');
  assert.strictEqual(fake.order('Main')[0], 'NE Scoreboard');
  const sb = [...fake.sources.values()].find((s) => s.name === 'NE Scoreboard');
  assert.strictEqual(sb.type, 'browser_source');
  assert.strictEqual(sb.settings.url, 'http://localhost:3000/live.html');
  // A user layer added above it is pushed under ours on the next add.
  const cam = [...fake.sources.values()].find((s) => s.name === 'Mic').id;
  fake.scenes.find((s) => s.name === 'Main').items.unshift({ sceneItemId: 'item_user', sourceId: cam, visible: true });
  assert.strictEqual(await placeOverlay(c, 'Main', 'NE Scoreboard', 'http://localhost:3000/live.html?v=2', 1920, 1080), 'moved');
  assert.strictEqual(fake.order('Main')[0], 'NE Scoreboard', 'moved back to the top');
  assert.strictEqual(sb.settings.url, 'http://localhost:3000/live.html?v=2');

  // Build show scenes on Streamlabs: scenes created (PROMISE result path), NE Graphics on top.
  await wait(1100);
  const r = await buildShowScenes(c, 'http://localhost:3000', {});
  assert.strictEqual(r.created.length, SHOW_SCENES.length);
  for (const def of SHOW_SCENES) assert.strictEqual(fake.order(def.scene)[0], 'NE Graphics', def.scene + ' has NE Graphics on top');
  assert.strictEqual(r.mapping.inGame, 'NE In Game');
  // One NE Graphics source shared by every scene, not one per scene.
  assert.strictEqual([...fake.sources.values()].filter((s) => s.name === 'NE Graphics').length, 1);

  // Source show / hide, and the visibility event.
  await wait(1100);
  assert.strictEqual(await c.setSceneItemEnabled('NE In Game', 'NE Scoreboard', false), true);
  await wait(30);
  const items = await c.getSceneItemList('NE In Game');
  assert.strictEqual(items.find((i) => i.sourceName === 'NE Scoreboard').sceneItemEnabled, false);
  assert.strictEqual(items.find((i) => i.sourceName === 'NE Graphics').sceneItemIndex, items.length - 1, 'top layer has the highest OBS index');

  // Go live / record: Start only toggles when off, Stop only when on.
  await c.call('StartStream');
  await c.call('StartStream');
  await wait(30);
  assert.strictEqual(fake.streaming.streamingStatus, 'live');
  assert.ok(seen.stream.some((s) => s.active && s.state === 'OBS_WEBSOCKET_OUTPUT_STARTED'));
  assert.strictEqual((await c.call('GetStreamStatus')).outputActive, true);
  await c.call('StopStream');
  await wait(30);
  assert.strictEqual(fake.streaming.streamingStatus, 'offline');
  await c.call('StartRecord');
  await wait(30);
  assert.ok(seen.record.some((s) => s.active));

  // Replay buffer: start, save waits for "wrote", path unknown (the clip manager uses the folder).
  assert.strictEqual(await c.startReplayBuffer(), true);
  assert.strictEqual(await c.isReplayBufferActive(), true);
  const t0 = Date.now();
  assert.strictEqual(await c.saveReplayBufferAndGetPath(3000), null);
  assert.ok(Date.now() - t0 < 2000, 'resolved on the wrote event, not the timeout');
  assert.strictEqual(seen.saved, 1);

  // What Streamlabs can't do is refused plainly, never sent as a raw obs-websocket call.
  assert.strictEqual(await c.call('TriggerMediaInputAction', { inputName: 'x' }), null);
  assert.match(c.getLastError(), /can't do TriggerMediaInputAction/);
  assert.strictEqual(await c.call('SetCurrentSceneCollection', { sceneCollectionName: 'x' }), null);
  assert.match(c.getLastError(), /Blocked/);
  assert.deepStrictEqual(await c.getTransitions(), []);
  assert.strictEqual(await c.readSettings(), null, 'the OBS settings watchdog is skipped');

  // Streamlabs closing the socket marks the link down.
  fake.close();
  await wait(100);
  assert.strictEqual(c.isConnected(), false);
  await c.disconnect();
  console.log('slobs-client: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
