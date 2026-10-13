'use strict';
// A fake Streamlabs Desktop Remote Control API: JSON-RPC over WebSocket at /api/websocket, scenes
// with the TOP layer first, helpers with resourceIds, STREAM subscriptions, PROMISE results and
// the 2-points-per-second rate limit on getScenes. Shared by test/slobs-client.test.js and
// scripts/e2e-server.js.
const { WebSocketServer } = require('ws');

const TOKEN = 'tok123';

function fakeStreamlabs(opts = {}) {
  let nid = 1;
  const sources = new Map();   // id -> { id, name, type, audio, muted, settings, deflection }
  const scenes = [];           // { id, name, items: [{ sceneItemId, sourceId, visible }] } items[0] = top
  const calls = [];
  const subs = new Set();
  let points = 2;
  const reset = setInterval(() => { points = 2; }, 1000);
  const streaming = { streamingStatus: 'offline', recordingStatus: 'offline', replayBufferStatus: 'offline' };
  let active = '';
  let studio = false;
  const addSource = (name, type, settings, audio) => { const id = 'src_' + nid++; sources.set(id, { id, name, type, audio: !!audio, muted: false, settings: { ...(settings || {}) }, deflection: 1 }); return id; };
  const addScene = (name) => { const id = 'scene_' + nid++; scenes.push({ id, name, items: [] }); sources.set(id, { id, name, type: 'scene' }); return id; };
  const sceneModel = (s) => ({ _type: 'HELPER', resourceId: 'Scene["' + s.id + '"]', id: s.id, name: s.name, nodes: [] });
  const itemModel = (s, it) => ({ _type: 'HELPER', resourceId: 'SceneItem["' + s.id + '","' + it.sceneItemId + '","' + it.sourceId + '"]',
    sceneId: s.id, sceneItemId: it.sceneItemId, sourceId: it.sourceId, name: sources.get(it.sourceId).name, visible: it.visible });
  const addItem = (s, sourceId) => { const it = { sceneItemId: 'item_' + nid++, sourceId, visible: true }; s.items.unshift(it); return it; };

  const first = addScene('Main');
  addScene('Break');
  active = first;
  const mic = addSource('Mic', 'wasapi_input_capture', {}, true);
  addItem(scenes[0], mic);

  const wss = new WebSocketServer({ port: opts.port || 0, path: '/api/websocket' });
  const clients = new Set();
  const emit = (resourceId, data) => clients.forEach((ws) => { if (subs.has(resourceId)) ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, result: { _type: 'EVENT', emitter: 'STREAM', resourceId, data } }) + '\n'); });

  function handle(ws, req) {
    const { resource, args = [] } = req.params || {};
    const m = req.method;
    calls.push(resource + '.' + m);
    const ok = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    const err = (message) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32600, message } }));
    if (!ws.authed && !(resource === 'TcpServerService' && m === 'auth')) return err('Authorization required. Use TcpServerService.auth(token) method');
    const sceneRes = /^Scene\["([^"]+)"\]$/.exec(resource);
    const itemRes = /^SceneItem\["([^"]+)","([^"]+)","([^"]+)"\]$/.exec(resource);
    const srcRes = /^Source\["([^"]+)"\]$/.exec(resource);
    const audRes = /^AudioSource\["([^"]+)"\]$/.exec(resource);
    if (resource === 'TcpServerService' && m === 'auth') { ws.authed = args[0] === TOKEN; return ok(ws.authed); }
    if (['sceneSwitched', 'sceneAdded', 'sceneRemoved', 'itemUpdated', 'sourceUpdated', 'streamingStatusChange', 'recordingStatusChange', 'replayBufferStatusChange', 'studioModeChanged'].includes(m)) {
      subs.add(resource + '.' + m);
      return ok({ _type: 'SUBSCRIPTION', resourceId: resource + '.' + m, emitter: 'STREAM' });
    }
    if (resource === 'ScenesService') {
      if (m === 'getScenes') { if (points < 1) return err('Reached the limit of calls for ScenesService.getScenes'); points -= 1; return ok(scenes.map(sceneModel)); }
      if (m === 'activeSceneId') return ok(active);
      if (m === 'makeSceneActive') {
        const s = scenes.find((x) => x.id === args[0]); if (!s) return ok(false);
        active = s.id; ok(true); emit('ScenesService.sceneSwitched', { id: s.id, name: s.name, nodes: [] }); return;
      }
      if (m === 'createScene') {
        // Returned as a PROMISE to exercise the async-result path.
        const id = addScene(args[0]);
        ok({ _type: 'SUBSCRIPTION', resourceId: 'promise_' + id, emitter: 'PROMISE' });
        setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, result: { _type: 'EVENT', emitter: 'PROMISE', resourceId: 'promise_' + id, data: sceneModel(scenes.find((x) => x.id === id)) } })), 20);
        return;
      }
    }
    if (resource === 'SourcesService' && m === 'getSources') return ok([...sources.values()].map((s) => ({ _type: 'HELPER', resourceId: 'Source["' + s.id + '"]', sourceId: s.id, id: s.id, name: s.name, type: s.type, audio: !!s.audio, muted: !!s.muted })));
    if (sceneRes) {
      const s = scenes.find((x) => x.id === sceneRes[1]); if (!s) return err('no scene');
      if (m === 'getItems') return ok(s.items.map((it) => itemModel(s, it)));
      if (m === 'createAndAddSource') { const id = addSource(args[0], args[1], args[2]); return ok(itemModel(s, addItem(s, id))); }
      if (m === 'addSource') { if (!sources.has(args[0])) return ok(null); return ok(itemModel(s, addItem(s, args[0]))); }
    }
    if (itemRes) {
      const s = scenes.find((x) => x.id === itemRes[1]); const it = s && s.items.find((x) => x.sceneItemId === itemRes[2]);
      if (!it) return err('no item');
      if (m === 'setVisibility') { it.visible = !!args[0]; emit('ScenesService.itemUpdated', itemModel(s, it)); return ok(null); }
      if (m === 'fitToScreen' || m === 'stretchToScreen') { it.fitted = m; return ok(null); }
      if (m === 'placeBefore' || m === 'placeAfter') {
        const from = s.items.indexOf(it); s.items.splice(from, 1);
        const at = s.items.findIndex((x) => x.sceneItemId === args[0]);
        s.items.splice(m === 'placeBefore' ? at : at + 1, 0, it);
        return ok(null);
      }
    }
    if (srcRes) {
      const src = sources.get(srcRes[1]); if (!src) return err('no source');
      if (m === 'getSettings') return ok(src.settings);
      if (m === 'updateSettings') { Object.assign(src.settings, args[0]); return ok(null); }
    }
    if (resource === 'AudioService' && m === 'getSources') return ok([...sources.values()].filter((s) => s.audio).map((s) => ({ _type: 'HELPER', resourceId: 'AudioSource["' + s.id + '"]', sourceId: s.id, name: s.name, muted: s.muted, fader: { deflection: s.deflection, mul: Math.pow(s.deflection, 3), db: 20 * Math.log10(Math.pow(s.deflection, 3) || 1e-9) } })));
    if (audRes) {
      const src = sources.get(audRes[1]);
      if (m === 'setMuted') { src.muted = !!args[0]; emit('SourcesService.sourceUpdated', { name: src.name, audio: true, muted: src.muted, type: src.type }); return ok(null); }
      if (m === 'setDeflection') { src.deflection = args[0]; return ok(null); }
    }
    if (resource === 'StreamingService') {
      if (m === 'getModel') return ok({ ...streaming });
      if (m === 'toggleStreaming') { streaming.streamingStatus = streaming.streamingStatus === 'live' ? 'offline' : 'live'; ok(null); emit('StreamingService.streamingStatusChange', streaming.streamingStatus); return; }
      if (m === 'toggleRecording') { streaming.recordingStatus = streaming.recordingStatus === 'recording' ? 'offline' : 'recording'; ok(null); emit('StreamingService.recordingStatusChange', streaming.recordingStatus); return; }
      if (m === 'startReplayBuffer') { streaming.replayBufferStatus = 'running'; ok(null); emit('StreamingService.replayBufferStatusChange', 'running'); return; }
      if (m === 'saveReplay') {
        ok(null);
        setTimeout(() => { emit('StreamingService.replayBufferStatusChange', 'saving'); emit('StreamingService.replayBufferStatusChange', 'wrote'); emit('StreamingService.replayBufferStatusChange', 'running'); }, 30);
        return;
      }
    }
    if (resource === 'TransitionsService' && m === 'getModel') return ok({ studioMode: studio });
    return err('METHOD_NOT_FOUND ' + resource + '.' + m);
  }
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => handle(ws, JSON.parse(String(raw))));
  });
  return {
    wss, calls, scenes, sources, streaming, emit,
    port: () => wss.address().port,
    activeName: () => (scenes.find((x) => x.id === active) || {}).name || '',
    order: (sceneName) => scenes.find((s) => s.name === sceneName).items.map((it) => sources.get(it.sourceId).name),   // top first
    close: () => { clearInterval(reset); clients.forEach((c) => c.terminate()); wss.close(); },
  };
}

module.exports = { fakeStreamlabs, TOKEN };
