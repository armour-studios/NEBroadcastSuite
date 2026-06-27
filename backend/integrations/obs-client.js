const { OBSWebSocket } = require('obs-websocket-js');

/**
 * Thin wrapper around obs-websocket-js (v5 / OBS 28+ WebSocket 5 protocol).
 * Manages a single connection with auto-reconnect and exposes scene control.
 *
 * onStatus({ connected, lastError }) is called whenever the link state changes.
 */
function createObsClient({
  onStatus,
  onSceneChange,
  onSceneListChange,
  onMediaEnded,
  onMediaStarted,
  onStreamStateChanged,
  onRecordStateChanged,
  onReplayBufferSaved,
  onInputMuteChanged,
  onSourceVisibilityChanged,
} = {}) {
  const obs = new OBSWebSocket();

  let connected = false;
  let desired = false;             // whether we want to stay connected
  let connecting = false;          // true while a connect() call is in flight
  let cfg = { url: '', password: '' };
  let reconnectTimer = null;
  let reconnectDelay = 5000;       // starts at 5s, backs off to 60s max
  let lastError = null;
  let currentScene = '';           // OBS PROGRAM scene = what viewers actually see

  function emit() {
    if (onStatus) onStatus({ connected, lastError });
  }
  function emitScene(name) {
    currentScene = name || '';
    if (onSceneChange) onSceneChange(currentScene);
  }

  // The authoritative "what's on air" signal — the live OBS program scene.
  obs.on('CurrentProgramSceneChanged', (d) => emitScene(d && d.sceneName));

  // A media source finished playing (e.g. the commercial video) — used for auto-return.
  obs.on('MediaInputPlaybackEnded', (d) => { if (onMediaEnded) onMediaEnded(d && d.inputName); });

  // A media source started playing — useful for flow triggers.
  obs.on('MediaInputPlaybackStarted', (d) => { if (onMediaStarted) onMediaStarted(d && d.inputName); });

  obs.on('StreamStateChanged', (d) => {
    if (onStreamStateChanged) onStreamStateChanged({ active: !!d.outputActive, state: d.outputState || '' });
  });
  obs.on('RecordStateChanged', (d) => {
    if (onRecordStateChanged) onRecordStateChanged({ active: !!d.outputActive, state: d.outputState || '' });
  });
  obs.on('ReplayBufferSaved', (d) => {
    if (onReplayBufferSaved) onReplayBufferSaved({ path: (d && d.savedReplayPath) || '' });
  });

  // Audio input mute state changed — covers any input in the mixer.
  obs.on('InputMuteStateChanged', (d) => {
    if (onInputMuteChanged) onInputMuteChanged({ inputName: (d && d.inputName) || '', muted: !!(d && d.inputMuted) });
  });

  // Scene item (source) visibility toggled — resolve sceneItemId → sourceName via WS call.
  obs.on('SceneItemEnableStateChanged', async (d) => {
    if (!onSourceVisibilityChanged || !d) return;
    let sourceName = '';
    try {
      const r = await call('GetSceneItemList', { sceneName: d.sceneName });
      if (r && r.sceneItems) {
        const item = r.sceneItems.find((i) => i.sceneItemId === d.sceneItemId);
        if (item) sourceName = item.sourceName || '';
      }
    } catch (_) {}
    onSourceVisibilityChanged({ sceneName: d.sceneName || '', sourceName, enabled: !!d.sceneItemEnabled });
  });

  // Keep the producer's scene list in sync with OBS automatically: whenever scenes
  // are added/removed/renamed or the whole scene collection is swapped, re-fetch and
  // push the fresh list up so the control panel always mirrors the live OBS profile.
  let sceneRefreshTimer = null;
  async function pushSceneList() {
    if (!onSceneListChange) return;
    const scenes = await getScenes();
    onSceneListChange(scenes);
  }
  function scheduleSceneListRefresh() {
    if (sceneRefreshTimer) clearTimeout(sceneRefreshTimer);
    sceneRefreshTimer = setTimeout(() => { sceneRefreshTimer = null; pushSceneList().catch(() => {}); }, 250);
  }
  ['SceneListChanged', 'SceneCreated', 'SceneRemoved', 'SceneNameChanged', 'CurrentSceneCollectionChanged']
    .forEach((ev) => obs.on(ev, scheduleSceneListRefresh));

  function normalizeUrl(url) {
    let u = (url || '').trim();
    if (!u) u = 'ws://127.0.0.1:4455';
    if (!/^wss?:\/\//i.test(u)) u = 'ws://' + u;
    // Windows gotcha: `localhost` can resolve to IPv6 (::1) but OBS's WebSocket
    // server binds IPv4 (127.0.0.1) by default → silent connection failure.
    u = u.replace(/:\/\/localhost\b/i, '://127.0.0.1');
    // No port given → append OBS's default WebSocket port.
    if (!/:\d+(\/|$)/.test(u)) u = u.replace(/\/?$/, ':4455');
    return u;
  }

  function scheduleReconnect() {
    if (reconnectTimer || !desired || connecting) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 60000); // 5s → 10s → 20s → 40s → 60s cap
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (desired) connect(cfg).catch(() => { /* will reschedule on close */ });
    }, delay);
  }

  obs.on('ConnectionClosed', () => {
    if (connected) {
      connected = false;
      emit();
    }
    emitScene('');   // program unknown while disconnected
    scheduleReconnect();
  });

  // Surface socket-level errors instead of letting them go unhandled
  obs.on('ConnectionError', (err) => {
    lastError = err && err.message ? err.message : String(err);
    emit();
  });

  async function connect({ url, password } = {}) {
    desired = true;
    connecting = true;
    // Cancel any pending reconnect — we are connecting right now
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (typeof url === 'string' && url) cfg.url = url;
    if (typeof password === 'string') cfg.password = password;
    lastError = null;

    // Ensure a clean socket before reconnecting; ConnectionClosed will fire here
    // but the `connecting` flag prevents it from scheduling a spurious reconnect.
    try { await obs.disconnect(); } catch (e) { /* ignore */ }

    try {
      const auth = cfg.password ? cfg.password : undefined;
      await obs.connect(normalizeUrl(cfg.url), auth);
      connecting = false;
      connected = true;
      lastError = null;
      reconnectDelay = 5000; // reset backoff on successful connect
      emit();
      // Capture the current program scene immediately so "on air" is accurate.
      try {
        const r = await obs.call('GetCurrentProgramScene');
        emitScene(r && (r.currentProgramSceneName || r.sceneName));
      } catch (e) { /* ignore */ }
      // Publish the full scene list right away so the UI lists the live OBS profile.
      pushSceneList().catch(() => {});
      return true;
    } catch (e) {
      connecting = false;
      connected = false;
      lastError = e && e.message ? e.message : String(e);
      emit();
      scheduleReconnect();
      throw e;
    }
  }

  async function disconnect() {
    desired = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { await obs.disconnect(); } catch (e) { /* ignore */ }
    connected = false;
    emit();
  }

  async function getScenes() {
    if (!connected) return [];
    try {
      const res = await obs.call('GetSceneList');
      // OBS returns scenes bottom-first; reverse so the UI lists them top-first.
      return (res.scenes || []).map(s => s.sceneName).reverse();
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      return [];
    }
  }

  async function switchScene(sceneName) {
    if (!connected || !sceneName) return false;
    try {
      await obs.call('SetCurrentProgramScene', { sceneName });
      emitScene(sceneName);
      return true;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      return false;
    }
  }

  async function call(request, params) {
    if (!connected) return null;
    try {
      return await obs.call(request, params);
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      return null;
    }
  }

  // Returns list of all audio/video inputs known to OBS.
  async function getInputList() {
    const r = await call('GetInputList');
    if (!r || !r.inputs) return [];
    return r.inputs.map((i) => ({ name: i.inputName, kind: i.inputKind || '' }));
  }

  // Returns all scene items (sources) within a given scene.
  async function getSceneItemList(sceneName) {
    const r = await call('GetSceneItemList', { sceneName });
    return (r && r.sceneItems) ? r.sceneItems : [];
  }

  // Mute or unmute a named audio input.
  async function setInputMute(inputName, muted) {
    return call('SetInputMute', { inputName, inputMuted: muted });
  }

  // Set the volume of a named audio input in dB (-100 to +26).
  async function setInputVolume(inputName, volumeDb) {
    return call('SetInputVolume', { inputName, inputVolumeDb: volumeDb });
  }

  // Show or hide a named source within a scene.
  async function setSceneItemEnabled(sceneName, sourceName, enabled) {
    const items = await getSceneItemList(sceneName);
    const item = items.find((i) => i.sourceName === sourceName);
    if (!item) return false;
    await call('SetSceneItemEnabled', { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: enabled });
    return true;
  }

  // Enable or disable a named filter on a source.
  async function setSourceFilterEnabled(sourceName, filterName, enabled) {
    return call('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled: enabled });
  }

  // Replay buffer (instant replay / save highlight clip)
  async function saveReplayBuffer() {
    const r = await call('SaveReplayBuffer');
    return r !== null;
  }

  // Save the replay buffer AND return the exact file OBS wrote, via the
  // ReplayBufferSaved event — no need to know/configure OBS's output folder.
  async function saveReplayBufferAndGetPath(timeoutMs = 9000) {
    if (!connected) return null;
    return new Promise((resolve) => {
      let done = false;
      const finish = (path) => { if (done) return; done = true; try { obs.off('ReplayBufferSaved', onSaved); } catch (e) {} resolve(path || null); };
      const onSaved = (d) => finish(d && d.savedReplayPath);
      obs.on('ReplayBufferSaved', onSaved);
      obs.call('SaveReplayBuffer').catch((e) => { lastError = (e && e.message) || String(e); finish(null); });
      setTimeout(() => finish(null), timeoutMs);
    });
  }
  async function startReplayBuffer() {
    const r = await call('StartReplayBuffer');
    return r !== null;
  }
  async function stopReplayBuffer() {
    const r = await call('StopReplayBuffer');
    return r !== null;
  }
  async function isReplayBufferActive() {
    const r = await call('GetReplayBufferStatus');
    return !!(r && r.outputActive);
  }

  return {
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
    isConnected: () => connected,
    getCurrentScene: () => currentScene,
    getLastError: () => lastError,
  };
}

module.exports = { createObsClient };
