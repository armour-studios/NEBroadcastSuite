'use strict';
const WebSocket = require('ws');

/**
 * Streamlabs Desktop (formerly Streamlabs OBS) client with the SAME interface as obs-client.js, so
 * every OBS feature in server.js (scene cuts, auto-switch, replay buffer, stream / record, add
 * overlay, build show scenes, mute / volume, source show / hide) runs on Streamlabs unchanged.
 *
 * Streamlabs has no obs-websocket. It has its own "Remote Control" API: JSON-RPC 2.0 over a SockJS
 * server (default port 59650, raw WebSocket at /api/websocket), authorised with the API token from
 * Settings > Remote Control. `call(request, params)` takes obs-websocket v5 request names and
 * translates the ones the app uses; anything Streamlabs cannot do is refused with a plain reason.
 *
 * Streamlabs rate-limits its API: "expensive" methods (ScenesService.getScenes) cost a point out of
 * 2 per second. The scene list is therefore cached and refreshed from Streamlabs' own events, never
 * polled.
 */
function createSlobsClient({
  onStatus,
  onSceneChange,
  onSceneListChange,
  onStreamStateChanged,
  onRecordStateChanged,
  onReplayBufferSaved,
  onReplayBufferStateChanged,
  onInputMuteChanged,
  onSourceVisibilityChanged,
} = {}) {
  // Same hard rule as obs-client.js: profiles, scene collections and settings are never touched.
  // Streamlabs' API can't reach output settings anyway; scene collections it can, so block them.
  const FORBIDDEN = new Set([
    'SetCurrentProfile', 'CreateProfile', 'RemoveProfile', 'SetProfileParameter',
    'SetCurrentSceneCollection', 'CreateSceneCollection',
    'SetVideoSettings', 'SetStreamServiceSettings', 'SetRecordDirectory', 'SetPersistentData',
  ]);

  let ws = null;
  let connected = false;
  let desired = false;
  let connecting = false;
  let cfg = { url: '', password: '' };
  let reconnectTimer = null;
  let reconnectDelay = 5000;
  let lastError = null;
  let currentScene = '';
  let nextId = 1;
  const pending = new Map();        // request id -> { resolve, reject, timer }
  const promiseWaits = new Map();   // PROMISE subscription id -> { resolve, reject }
  const streamHandlers = new Map(); // 'ScenesService.sceneSwitched' -> fn(data)

  // Cached model. Scenes come from the expensive getScenes, so they're refreshed on events only.
  let scenes = [];                  // [{ id, name }] in Streamlabs order
  let activeSceneId = '';
  const sourceTypes = new Map();    // sourceId -> type
  const lastMuted = new Map();      // source name -> muted
  const lastVisible = new Map();    // sceneId|sceneItemId -> visible
  let streamStatus = 'offline', recordStatus = 'offline', replayStatus = 'offline';
  let replayBufferAvailable = null;
  let studioMode = false;

  function emit() { if (onStatus) onStatus({ connected, lastError }); }
  function emitScene(name) {
    currentScene = name || '';
    if (onSceneChange) onSceneChange(currentScene);
  }
  const errMsg = (e) => (e && e.message) || String(e || '');

  function normalizeUrl(url) {
    let u = (url || '').trim();
    if (!u) u = 'ws://127.0.0.1:59650/api/websocket';
    if (/^https?:\/\//i.test(u)) u = u.replace(/^http/i, 'ws');
    if (!/^wss?:\/\//i.test(u)) u = 'ws://' + u;
    u = u.replace(/:\/\/localhost\b/i, '://127.0.0.1');
    if (!/:\/\/[^/]+:\d+/.test(u)) u = u.replace(/(:\/\/[^/]+)/, '$1:59650');
    // SockJS: the raw WebSocket endpoint sits under the /api prefix.
    if (!/\/api\/websocket\/?$/.test(u)) u = u.replace(/\/+$/, '').replace(/\/api$/, '') + '/api/websocket';
    return u;
  }

  // ── JSON-RPC transport ──────────────────────────────────────────────────────────────────────
  function rawRpc(resource, method, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('Not connected to Streamlabs')); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Streamlabs did not answer ' + resource + '.' + method)); }, timeoutMs || 8000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { resource, args: args || [] } }));
    });
  }
  // One retry past the per-second rate limit; Promise-returning methods resolve when they settle.
  async function rpc(resource, method, args) {
    let r;
    try { r = await rawRpc(resource, method, args); } catch (e) {
      if (!/limit of calls/i.test(errMsg(e))) throw e;
      await new Promise((ok) => setTimeout(ok, 1100));
      r = await rawRpc(resource, method, args);
    }
    if (r && r._type === 'SUBSCRIPTION' && r.emitter === 'PROMISE') {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { promiseWaits.delete(r.resourceId); reject(new Error('Streamlabs did not finish ' + resource + '.' + method)); }, 15000);
        promiseWaits.set(r.resourceId, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      });
    }
    return r;
  }

  function onMessage(buf) {
    String(buf).split('\n').forEach((line) => {
      line = line.trim(); if (!line) return;
      let msg; try { msg = JSON.parse(line); } catch (e) { return; }
      const res = msg.result;
      if (res && res._type === 'EVENT') {
        if (res.emitter === 'PROMISE') {
          const w = promiseWaits.get(res.resourceId);
          if (w) { promiseWaits.delete(res.resourceId); if (res.isRejected) w.reject(new Error(errMsg(res.data))); else w.resolve(res.data); }
          return;
        }
        const h = streamHandlers.get(res.resourceId);
        if (h) { try { h(res.data); } catch (e) { /* a bad event must not kill the socket */ } }
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'Streamlabs error'));
      else p.resolve(res);
    });
  }

  // ── model refresh ───────────────────────────────────────────────────────────────────────────
  async function refreshScenes() {
    const list = await rpc('ScenesService', 'getScenes');
    scenes = (Array.isArray(list) ? list : []).map((s) => ({ id: s.id, name: s.name })).filter((s) => s.id);
    try { activeSceneId = String(await rpc('ScenesService', 'activeSceneId') || ''); } catch (e) {}
    return scenes;
  }
  let sceneRefreshTimer = null;
  function scheduleSceneRefresh() {
    if (sceneRefreshTimer) clearTimeout(sceneRefreshTimer);
    // Debounced well past one rate-limit window: a scene-collection switch fires dozens of events.
    sceneRefreshTimer = setTimeout(async () => {
      sceneRefreshTimer = null;
      try {
        await refreshScenes();
        if (onSceneListChange) onSceneListChange(sceneNamesTopFirst());
        const act = scenes.find((s) => s.id === activeSceneId);
        if (act && act.name !== currentScene) emitScene(act.name);
      } catch (e) { lastError = errMsg(e); }
    }, 700);
  }
  const sceneNamesTopFirst = () => scenes.map((s) => s.name);
  const sceneByName = (name) => scenes.find((s) => s.name === name);
  async function sceneOrThrow(name) {
    let s = sceneByName(name);
    if (!s) { await refreshScenes(); s = sceneByName(name); }
    if (!s) throw new Error('Streamlabs has no scene named "' + name + '"');
    return s;
  }
  async function sources() {
    const list = await rpc('SourcesService', 'getSources');
    const out = (Array.isArray(list) ? list : []).map((s) => ({ id: s.sourceId || s.id, name: s.name, type: s.type, audio: !!s.audio, muted: !!s.muted }));
    out.forEach((s) => sourceTypes.set(s.id, s.type));
    return out;
  }
  async function sourceByName(name) {
    const hit = (await sources()).find((s) => s.name === name && s.type !== 'scene');
    if (!hit) throw new Error('Streamlabs has no source named "' + name + '"');
    return hit;
  }
  // Scene items, top layer FIRST (Streamlabs' own order; index 0 is the top of the scene).
  async function sceneItems(sceneName) {
    const sc = await sceneOrThrow(sceneName);
    const items = await rpc('Scene["' + sc.id + '"]', 'getItems');
    return { scene: sc, items: (Array.isArray(items) ? items : []).map((i) => ({
      sceneItemId: i.sceneItemId || i.id, sourceId: i.sourceId, name: i.name, visible: i.visible !== false,
      resourceId: i.resourceId || ('SceneItem["' + sc.id + '","' + (i.sceneItemId || i.id) + '","' + i.sourceId + '"]'),
    })) };
  }
  async function itemOrThrow(sceneName, sceneItemId) {
    const { scene, items } = await sceneItems(sceneName);
    const it = items.find((i) => String(i.sceneItemId) === String(sceneItemId));
    if (!it) throw new Error('Streamlabs has no item ' + sceneItemId + ' in "' + sceneName + '"');
    return { scene, items, it };
  }
  async function audioByName(name) {
    const list = await rpc('AudioService', 'getSources');
    const hit = (Array.isArray(list) ? list : []).find((a) => a.name === name);
    if (!hit) throw new Error('Streamlabs has no audio source named "' + name + '"');
    return hit;
  }
  async function refreshStreaming() {
    const m = await rpc('StreamingService', 'getModel');
    if (m) { streamStatus = m.streamingStatus || streamStatus; recordStatus = m.recordingStatus || recordStatus; replayStatus = m.replayBufferStatus || replayStatus; }
    return m || {};
  }
  // Streamlabs' fader is OBS's cubic one: mul = deflection^3, dB = 20*log10(mul).
  const dbToDeflection = (db) => Math.max(0, Math.min(1, Math.cbrt(Math.pow(10, (Number(db) || 0) / 20))));
  const mulToDeflection = (mul) => Math.max(0, Math.min(1, Math.cbrt(Math.max(0, Number(mul) || 0))));

  const isLive = (st) => st === 'live' || st === 'reconnecting';
  const isRecording = (st) => st === 'recording' || st === 'start' || st === 'writing' || st === 'wrote';
  const isBuffering = (st) => st === 'running' || st === 'saving' || st === 'writing' || st === 'wrote';
  const statusOf = (d) => (typeof d === 'string' ? d : (d && (d.status || d.streamingStatus || d.recordingStatus || d.replayBufferStatus)) || '');

  async function subscribe(resource, event, fn) {
    const key = resource + '.' + event;
    streamHandlers.set(key, fn);
    try { await rawRpc(resource, event, []); } catch (e) { console.warn('[Streamlabs] could not subscribe to ' + key + ':', errMsg(e)); }
  }
  async function subscribeAll() {
    await subscribe('ScenesService', 'sceneSwitched', (d) => {
      if (d && d.id) activeSceneId = d.id;
      const name = (d && d.name) || (scenes.find((s) => s.id === activeSceneId) || {}).name || '';
      emitScene(name);
    });
    ['sceneAdded', 'sceneRemoved'].forEach((ev) => subscribe('ScenesService', ev, scheduleSceneRefresh));
    await subscribe('ScenesService', 'itemUpdated', (d) => {
      if (!d || !onSourceVisibilityChanged) return;
      const key = d.sceneId + '|' + d.sceneItemId;
      const vis = d.visible !== false;
      if (lastVisible.has(key) && lastVisible.get(key) === vis) return;
      const known = lastVisible.has(key);
      lastVisible.set(key, vis);
      if (!known) return;   // first sighting is the baseline, not a change
      const sc = scenes.find((s) => s.id === d.sceneId);
      onSourceVisibilityChanged({ sceneName: sc ? sc.name : '', sourceName: d.name || '', enabled: vis });
    });
    await subscribe('SourcesService', 'sourceUpdated', (d) => {
      if (!d) return;
      if (d.type === 'scene') { scheduleSceneRefresh(); return; }   // a scene was renamed
      if (onInputMuteChanged && d.audio && lastMuted.has(d.name) && lastMuted.get(d.name) !== !!d.muted) {
        onInputMuteChanged({ inputName: d.name, muted: !!d.muted });
      }
      lastMuted.set(d.name, !!d.muted);
    });
    await subscribe('StreamingService', 'streamingStatusChange', (d) => {
      const was = streamStatus; streamStatus = statusOf(d) || streamStatus;
      if (!onStreamStateChanged || isLive(was) === isLive(streamStatus)) return;
      onStreamStateChanged({ active: isLive(streamStatus), state: isLive(streamStatus) ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    });
    await subscribe('StreamingService', 'recordingStatusChange', (d) => {
      const was = recordStatus; recordStatus = statusOf(d) || recordStatus;
      if (!onRecordStateChanged || isRecording(was) === isRecording(recordStatus)) return;
      onRecordStateChanged({ active: isRecording(recordStatus), state: isRecording(recordStatus) ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: '' });
    });
    await subscribe('StreamingService', 'replayBufferStatusChange', (d) => {
      const was = replayStatus; replayStatus = statusOf(d) || replayStatus;
      replayBufferAvailable = true;
      if (replayStatus === 'wrote' && was !== 'wrote') {
        // Streamlabs doesn't say which file it wrote; the app finds it in the replay folder.
        if (onReplayBufferSaved) onReplayBufferSaved({ path: '' });
        savedWaiters.splice(0).forEach((fn) => fn());
      }
      if (onReplayBufferStateChanged && isBuffering(was) !== isBuffering(replayStatus)) onReplayBufferStateChanged({ active: isBuffering(replayStatus) });
    });
    await subscribe('TransitionsService', 'studioModeChanged', (on) => { studioMode = !!on; });
  }
  const savedWaiters = [];

  // ── connection ──────────────────────────────────────────────────────────────────────────────
  function scheduleReconnect() {
    if (reconnectTimer || !desired || connecting) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (desired) connect(cfg).catch(() => {}); }, delay);
  }
  function dropSocket() {
    if (ws) { try { ws.removeAllListeners(); ws.terminate(); } catch (e) {} ws = null; }
    pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('Streamlabs connection closed')); });
    pending.clear();
    promiseWaits.forEach((w) => w.reject(new Error('Streamlabs connection closed')));
    promiseWaits.clear();
    streamHandlers.clear();
  }

  async function connect({ url, password } = {}) {
    desired = true;
    connecting = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (typeof url === 'string' && url) cfg.url = url;
    if (typeof password === 'string') cfg.password = password;
    lastError = null;
    dropSocket();
    try {
      await new Promise((resolve, reject) => {
        const sock = new WebSocket(normalizeUrl(cfg.url), { handshakeTimeout: 6000 });
        ws = sock;
        sock.once('open', resolve);
        sock.once('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error('Streamlabs Desktop is not reachable. Is it running, with Remote Control on (Settings > Remote Control)?') : e));
        sock.on('message', onMessage);
        sock.on('close', () => {
          if (ws !== sock) return;
          const was = connected;
          connected = false; ws = null;
          dropSocket();
          if (was) { emit(); emitScene(''); }
          scheduleReconnect();
        });
      });
      if (!cfg.password) throw new Error('Paste the API token from Streamlabs Desktop: Settings > Remote Control > Show details.');
      const ok = await rawRpc('TcpServerService', 'auth', [cfg.password]);
      if (ok !== true) throw new Error('Streamlabs refused the API token.');
      connecting = false;
      connected = true;
      lastError = null;
      reconnectDelay = 5000;
      replayBufferAvailable = null;
      await subscribeAll();
      try { await refreshScenes(); } catch (e) {}
      try { await refreshStreaming(); } catch (e) {}
      try { const t = await rpc('TransitionsService', 'getModel'); studioMode = !!(t && t.studioMode); } catch (e) {}
      try { (await sources()).forEach((s) => { if (s.audio) lastMuted.set(s.name, s.muted); }); } catch (e) {}
      emit();
      const act = scenes.find((s) => s.id === activeSceneId);
      emitScene(act ? act.name : '');
      if (onSceneListChange) onSceneListChange(sceneNamesTopFirst());
      return true;
    } catch (e) {
      connecting = false;
      connected = false;
      lastError = errMsg(e);
      dropSocket();
      emit();
      // A wrong token won't fix itself; only retry when Streamlabs wasn't there.
      if (!/token/i.test(lastError)) scheduleReconnect();
      throw e;
    }
  }

  async function disconnect() {
    desired = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    dropSocket();
    connected = false;
    emit();
  }

  // ── obs-websocket v5 requests, answered by Streamlabs ───────────────────────────────────────
  async function slobsCall(request, p) {
    p = p || {};
    if (FORBIDDEN.has(request)) {
      console.error('[Streamlabs] BLOCKED ' + request + ' — this app must never change the streaming app\'s settings.');
      throw new Error('Blocked: ' + request + ' would modify settings');
    }
    if (!/^Get/.test(String(request || ''))) console.log('[Streamlabs→]', request);
    switch (request) {
      case 'GetVersion': return { obsVersion: 'Streamlabs Desktop', platformDescription: 'Streamlabs Remote Control API' };
      case 'GetSceneList': {
        await refreshScenes();
        const cur = (scenes.find((s) => s.id === activeSceneId) || {}).name || '';
        // obs-websocket lists scenes bottom-first.
        return { currentProgramSceneName: cur, currentPreviewSceneName: null, scenes: scenes.slice().reverse().map((s, i) => ({ sceneName: s.name, sceneIndex: i })) };
      }
      case 'GetCurrentProgramScene': {
        try { activeSceneId = String(await rpc('ScenesService', 'activeSceneId') || activeSceneId); } catch (e) {}
        let s = scenes.find((x) => x.id === activeSceneId);
        if (!s) { await refreshScenes(); s = scenes.find((x) => x.id === activeSceneId); }
        const name = s ? s.name : '';
        return { currentProgramSceneName: name, sceneName: name };
      }
      case 'SetCurrentProgramScene': {
        const s = await sceneOrThrow(p.sceneName);
        await rpc('ScenesService', 'makeSceneActive', [s.id]);
        return {};
      }
      case 'GetStudioModeEnabled': return { studioModeEnabled: studioMode };
      case 'SetStudioModeEnabled': await rpc('TransitionsService', p.studioModeEnabled ? 'enableStudioMode' : 'disableStudioMode'); studioMode = !!p.studioModeEnabled; return {};
      case 'TriggerStudioModeTransition': await rpc('TransitionsService', 'executeStudioModeTransition'); return {};
      case 'GetCurrentPreviewScene': throw new Error('Streamlabs does not expose its preview scene');
      case 'GetSceneTransitionList': return { transitions: [] };
      // Streamlabs' API has no transition picker: the cut uses whatever transition Streamlabs has set.
      case 'SetCurrentSceneTransition':
      case 'SetCurrentSceneTransitionDuration': return {};
      case 'GetCurrentSceneTransition': return { transitionName: '', transitionDuration: 0 };
      case 'CreateScene': {
        const r = await rpc('ScenesService', 'createScene', [p.sceneName]);
        scheduleSceneRefresh();
        if (r && r.id && !sceneByName(p.sceneName)) scenes.push({ id: r.id, name: p.sceneName });
        return { sceneUuid: r && r.id };
      }
      case 'GetInputList': {
        const list = (await sources()).filter((s) => s.type !== 'scene');
        return { inputs: list.map((s) => ({ inputName: s.name, inputKind: s.type, unversionedInputKind: s.type })) };
      }
      case 'GetInputSettings': {
        const s = await sourceByName(p.inputName);
        return { inputSettings: (await rpc('Source["' + s.id + '"]', 'getSettings')) || {}, inputKind: s.type };
      }
      case 'SetInputSettings': {
        const s = await sourceByName(p.inputName);
        await rpc('Source["' + s.id + '"]', 'updateSettings', [p.inputSettings || {}]);
        return {};
      }
      case 'CreateInput': {
        const sc = await sceneOrThrow(p.sceneName);
        const it = await rpc('Scene["' + sc.id + '"]', 'createAndAddSource', [p.inputName, p.inputKind, p.inputSettings || {}]);
        if (!it) throw new Error('Streamlabs could not create "' + p.inputName + '"');
        if (p.sceneItemEnabled === false && it.resourceId) await rpc(it.resourceId, 'setVisibility', [false]);
        return { sceneItemId: it.sceneItemId || it.id, inputUuid: it.sourceId };
      }
      case 'GetSceneItemId': {
        const { items } = await sceneItems(p.sceneName);
        const it = items.find((i) => i.name === p.sourceName);
        if (!it) throw new Error('No "' + p.sourceName + '" in "' + p.sceneName + '"');
        return { sceneItemId: it.sceneItemId };
      }
      case 'CreateSceneItem': {
        const sc = await sceneOrThrow(p.sceneName);
        const src = await sourceByName(p.sourceName);
        const it = await rpc('Scene["' + sc.id + '"]', 'addSource', [src.id]);
        if (!it) throw new Error('Streamlabs could not add "' + p.sourceName + '" to "' + p.sceneName + '"');
        if (p.sceneItemEnabled === false && it.resourceId) await rpc(it.resourceId, 'setVisibility', [false]);
        return { sceneItemId: it.sceneItemId || it.id };
      }
      case 'GetSceneItemList': {
        const { items } = await sceneItems(p.sceneName);
        const n = items.length;
        // obs-websocket: index 0 is the BOTTOM layer; Streamlabs lists the top layer first.
        return { sceneItems: items.map((i, k) => ({
          sceneItemId: i.sceneItemId, sourceName: i.name, sceneItemEnabled: i.visible, sceneItemIndex: n - 1 - k,
          inputKind: sourceTypes.get(i.sourceId) || null, isGroup: false,
          sourceType: sourceTypes.get(i.sourceId) === 'scene' ? 'OBS_SOURCE_TYPE_SCENE' : 'OBS_SOURCE_TYPE_INPUT',
        })).reverse() };
      }
      case 'GetSceneItemEnabled': {
        const { it } = await itemOrThrow(p.sceneName, p.sceneItemId);
        return { sceneItemEnabled: it.visible };
      }
      case 'SetSceneItemEnabled': {
        const { it } = await itemOrThrow(p.sceneName, p.sceneItemId);
        await rpc(it.resourceId, 'setVisibility', [!!p.sceneItemEnabled]);
        return {};
      }
      case 'SetSceneItemIndex': {
        const { items, it } = await itemOrThrow(p.sceneName, p.sceneItemId);
        const n = items.length;
        const want = Math.max(0, Math.min(n - 1, n - 1 - Number(p.sceneItemIndex || 0)));   // Streamlabs position
        const cur = items.indexOf(it);
        if (cur === want) return {};
        const anchor = items[want];
        // A scene item is a scene node whose node id is its item id. placeBefore = above the
        // anchor, placeAfter = below it.
        await rpc(it.resourceId, want < cur ? 'placeBefore' : 'placeAfter', [anchor.sceneItemId]);
        return {};
      }
      case 'GetVideoSettings':
        // No canvas size in the external API; callers that fit to the canvas use the transform below.
        return { baseWidth: 0, baseHeight: 0, outputWidth: 0, outputHeight: 0 };
      case 'SetSceneItemTransform': {
        const { it } = await itemOrThrow(p.sceneName, p.sceneItemId);
        const t = p.sceneItemTransform || {};
        if (/SCALE_INNER/.test(t.boundsType || '')) await rpc(it.resourceId, 'fitToScreen');
        else if (/STRETCH/.test(t.boundsType || '')) await rpc(it.resourceId, 'stretchToScreen');
        else {
          const tr = {};
          if (t.positionX != null || t.positionY != null) tr.position = { x: Number(t.positionX) || 0, y: Number(t.positionY) || 0 };
          if (t.scaleX != null || t.scaleY != null) tr.scale = { x: Number(t.scaleX) || 1, y: Number(t.scaleY) || 1 };
          if (t.rotation != null) tr.rotation = Number(t.rotation) || 0;
          if (Object.keys(tr).length) await rpc(it.resourceId, 'setTransform', [tr]);
        }
        return {};
      }
      case 'GetInputMute': {
        const a = await audioByName(p.inputName);
        return { inputMuted: !!a.muted };
      }
      case 'SetInputMute': {
        const a = await audioByName(p.inputName);
        await rpc('AudioSource["' + a.sourceId + '"]', 'setMuted', [!!p.inputMuted]);
        lastMuted.set(p.inputName, !!p.inputMuted);
        return {};
      }
      case 'ToggleInputMute': {
        const a = await audioByName(p.inputName);
        await rpc('AudioSource["' + a.sourceId + '"]', 'setMuted', [!a.muted]);
        return { inputMuted: !a.muted };
      }
      case 'GetInputVolume': {
        const a = await audioByName(p.inputName);
        const f = a.fader || {};
        return { inputVolumeDb: typeof f.db === 'number' ? f.db : 0, inputVolumeMul: typeof f.mul === 'number' ? f.mul : 1 };
      }
      case 'SetInputVolume': {
        const a = await audioByName(p.inputName);
        const d = p.inputVolumeMul != null ? mulToDeflection(p.inputVolumeMul) : dbToDeflection(p.inputVolumeDb);
        await rpc('AudioSource["' + a.sourceId + '"]', 'setDeflection', [d]);
        return {};
      }
      case 'GetStreamStatus': { await refreshStreaming(); return { outputActive: isLive(streamStatus), outputReconnecting: streamStatus === 'reconnecting' }; }
      case 'GetRecordStatus': { await refreshStreaming(); return { outputActive: isRecording(recordStatus), outputPaused: false }; }
      case 'GetReplayBufferStatus': { await refreshStreaming(); replayBufferAvailable = true; return { outputActive: isBuffering(replayStatus) }; }
      case 'StartStream': { await refreshStreaming(); if (!isLive(streamStatus) && streamStatus !== 'starting') await rpc('StreamingService', 'toggleStreaming'); return {}; }
      case 'StopStream': { await refreshStreaming(); if (isLive(streamStatus) || streamStatus === 'starting') await rpc('StreamingService', 'toggleStreaming'); return {}; }
      case 'ToggleStream': await rpc('StreamingService', 'toggleStreaming'); return {};
      case 'StartRecord': { await refreshStreaming(); if (!isRecording(recordStatus) && recordStatus !== 'starting') await rpc('StreamingService', 'toggleRecording'); return {}; }
      case 'StopRecord': { await refreshStreaming(); if (isRecording(recordStatus) || recordStatus === 'starting') await rpc('StreamingService', 'toggleRecording'); return { outputPath: '' }; }
      case 'ToggleRecord': await rpc('StreamingService', 'toggleRecording'); return {};
      case 'StartReplayBuffer': await rpc('StreamingService', 'startReplayBuffer'); replayBufferAvailable = true; return {};
      case 'StopReplayBuffer': await rpc('StreamingService', 'stopReplayBuffer'); return {};
      case 'SaveReplayBuffer': await rpc('StreamingService', 'saveReplay'); return {};
      default:
        throw new Error('Streamlabs Desktop can\'t do ' + request + ' (its Remote Control API has no equivalent)');
    }
  }

  // Same contract as obs-client.js: null on failure, with the reason in getLastError().
  async function call(request, params) {
    if (!connected) return null;
    try { return await slobsCall(request, params); } catch (e) { lastError = errMsg(e); return null; }
  }

  async function getScenes() {
    if (!connected) return [];
    try { await refreshScenes(); return sceneNamesTopFirst(); } catch (e) { lastError = errMsg(e); return []; }
  }
  async function switchScene(sceneName) {
    if (!connected || !sceneName) return false;
    const r = await call('SetCurrentProgramScene', { sceneName });
    if (r === null) return false;
    emitScene(sceneName);
    return true;
  }
  // No transition picker over the API: the cut runs Streamlabs' own default transition.
  async function switchSceneWithTransition(sceneName) { return switchScene(sceneName); }
  async function getTransitions() { return []; }
  async function getInputList() {
    const r = await call('GetInputList');
    return (r && r.inputs) ? r.inputs.map((i) => ({ name: i.inputName, kind: i.inputKind || '' })) : [];
  }
  async function getSceneItemList(sceneName) {
    const r = await call('GetSceneItemList', { sceneName });
    return (r && r.sceneItems) ? r.sceneItems : [];
  }
  const setInputMute = (inputName, muted) => call('SetInputMute', { inputName, inputMuted: muted });
  const setInputVolume = (inputName, volumeDb) => call('SetInputVolume', { inputName, inputVolumeDb: volumeDb });
  async function setSceneItemEnabled(sceneName, sourceName, enabled) {
    const items = await getSceneItemList(sceneName);
    const item = items.find((i) => i.sourceName === sourceName);
    if (!item) return false;
    await call('SetSceneItemEnabled', { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: enabled });
    return true;
  }
  async function setSourceFilterEnabled() { lastError = 'Streamlabs Desktop can\'t toggle filters over its API'; return null; }
  async function saveReplayBuffer() { return (await call('SaveReplayBuffer')) !== null; }
  // Waits for Streamlabs to finish writing; it never says WHERE, so the result is always null and
  // the clip manager picks the newest file from the configured replay folder.
  async function saveReplayBufferAndGetPath(timeoutMs = 9000) {
    if (!connected) return null;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(null); } };
      savedWaiters.push(finish);
      call('SaveReplayBuffer').then((r) => { if (r === null) finish(); });
      setTimeout(finish, timeoutMs);
    });
  }
  async function startReplayBuffer() { return (await call('StartReplayBuffer')) !== null; }
  async function stopReplayBuffer() { return (await call('StopReplayBuffer')) !== null; }
  async function isReplayBufferActive() {
    const r = await call('GetReplayBufferStatus');
    return !!(r && r.outputActive);
  }

  return {
    kind: 'streamlabs',
    connect,
    disconnect,
    getScenes,
    switchScene,
    call,
    getInputList,
    getSceneItemList,
    setInputMute,
    setInputVolume,
    setSceneItemEnabled,
    setSourceFilterEnabled,
    saveReplayBuffer,
    saveReplayBufferAndGetPath,
    startReplayBuffer,
    stopReplayBuffer,
    isReplayBufferActive,
    getTransitions,
    switchSceneWithTransition,
    // The OBS settings watchdog reads OBS profile parameters; Streamlabs exposes none of them.
    readSettings: async () => null,
    diffSettings: () => [],
    isConnected: () => connected,
    getCurrentScene: () => currentScene,
    getLastError: () => lastError,
    isReplayBufferAvailable: () => replayBufferAvailable,
    _normalizeUrl: normalizeUrl,
    _dbToDeflection: dbToDeflection,
  };
}

module.exports = { createSlobsClient };
