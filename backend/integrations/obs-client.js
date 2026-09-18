const { OBSWebSocket, EventSubscription } = require('obs-websocket-js');

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
  onReplayBufferStateChanged,
  onInputMuteChanged,
  onInputVolumeChanged,
  onSourceVisibilityChanged,
  onVolumeMeters,
  onSettingsSnapshot,
} = {}) {
  const obs = new OBSWebSocket();

  // ── HARD RULE: this app never changes the producer's OBS configuration ──────
  // We drive scenes, sources, audio and outputs. We do NOT touch profiles, scene
  // collections, or anything behind OBS's Settings dialog (Output/Video/Audio/
  // Stream/Record paths). Enforced HERE, at the single socket choke point, rather
  // than by convention — so no future code path, flow action or plugin can send
  // one by accident. A blocked request is logged loudly and rejected.
  const FORBIDDEN = new Set([
    'SetCurrentProfile', 'CreateProfile', 'RemoveProfile', 'SetProfileParameter',
    'SetCurrentSceneCollection', 'CreateSceneCollection',
    'SetVideoSettings', 'SetStreamServiceSettings', 'SetRecordDirectory',
    'SetPersistentData',
  ]);

  // Audit trail: every WRITE we send to OBS is printed, so "the app changed my
  // OBS" is answerable from the log instead of from argument. Reads (Get*) stay
  // silent — they run continuously and would drown the log.
  const rawCall = obs.call.bind(obs);
  obs.call = function guardedCall(request, params) {
    if (FORBIDDEN.has(request)) {
      console.error('[OBS] BLOCKED ' + request + ' — this app must never change OBS settings/profiles.');
      return Promise.reject(new Error('Blocked: ' + request + ' would modify OBS settings'));
    }
    if (!/^Get/.test(String(request || ''))) console.log('[OBS→]', request);
    return rawCall(request, params);
  };
  if (typeof obs.callBatch === 'function') {
    const rawBatch = obs.callBatch.bind(obs);
    obs.callBatch = function guardedBatch(requests, options) {
      const bad = (requests || []).find((r) => FORBIDDEN.has(r && r.requestType));
      if (bad) {
        console.error('[OBS] BLOCKED batch containing ' + bad.requestType + ' — this app must never change OBS settings/profiles.');
        return Promise.reject(new Error('Blocked: ' + bad.requestType + ' would modify OBS settings'));
      }
      console.log('[OBS→] batch:', (requests || []).map((r) => r && r.requestType).join(','));
      return rawBatch(requests, options);
    };
  }

  let connected = false;
  let desired = false;             // whether we want to stay connected
  let connecting = false;          // true while a connect() call is in flight
  let cfg = { url: '', password: '' };
  let reconnectTimer = null;
  let reconnectDelay = 5000;       // starts at 5s, backs off to 60s max
  let lastError = null;
  // OBS answers every replay-buffer request with "Replay buffer is not available." when Replay Buffer
  // is switched off in OBS's own Settings > Output. That is a setting only the producer can change
  // (we never touch OBS settings), so it is tracked as a STATE, not surfaced as a raw error that
  // repeats on every capture attempt. null = not checked yet, true/false = what OBS last told us.
  let replayBufferAvailable = null;
  const RB_UNAVAILABLE = /replay buffer is not available/i;
  const noteReplayBufferError = (e) => {
    const msg = (e && e.message) || String(e || '');
    if (RB_UNAVAILABLE.test(msg)) replayBufferAvailable = false;
    return msg;
  };
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
  obs.on('ReplayBufferStateChanged', (d) => {
    replayBufferAvailable = true;   // OBS only emits this for a buffer that exists
    if (onReplayBufferStateChanged) onReplayBufferStateChanged({ active: !!(d && d.outputActive) });
  });

  // Audio input mute state changed — covers any input in the mixer.
  obs.on('InputMuteStateChanged', (d) => {
    if (onInputMuteChanged) onInputMuteChanged({ inputName: (d && d.inputName) || '', muted: !!(d && d.inputMuted) });
  });

  // Audio input volume changed (someone rode a fader in OBS, or we set it) — keep the pills in sync.
  obs.on('InputVolumeChanged', (d) => {
    if (onInputVolumeChanged) onInputVolumeChanged({ inputName: (d && d.inputName) || '', volumeDb: (d && typeof d.inputVolumeDb === 'number') ? d.inputVolumeDb : 0 });
  });

  // Real-time audio meter levels — a high-volume event category (~10/sec per active input), only
  // delivered when explicitly OR'd into eventSubscriptions on connect() below. Feeds the
  // audio_level_above/audio_level_below flow conditions.
  obs.on('InputVolumeMeters', (d) => {
    if (onVolumeMeters) onVolumeMeters((d && d.inputs) || []);
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
    stopSettingsWatch();
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
      // EventSubscription.All doesn't include the high-volume InputVolumeMeters category —
      // OR it in explicitly or audio-level flow conditions silently never see any data.
      await obs.connect(normalizeUrl(cfg.url), auth, {
        eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters
      });
      connecting = false;
      connected = true;
      lastError = null;
      replayBufferAvailable = null;   // the producer may have enabled it in OBS while we were away
      reconnectDelay = 5000; // reset backoff on successful connect
      emit();
      // Capture the current program scene immediately so "on air" is accurate.
      try {
        const r = await obs.call('GetCurrentProgramScene');
        emitScene(r && (r.currentProgramSceneName || r.sceneName));
      } catch (e) { /* ignore */ }
      // Publish the full scene list right away so the UI lists the live OBS profile.
      pushSceneList().catch(() => {});
      // Baseline OBS's settings now, then watch them for the rest of the session.
      pollSettings('connect').catch(() => {});
      startSettingsWatch();
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

  async function switchSceneWithTransition(sceneName, transitionName) {
    if (!connected || !sceneName) return false;
    try {
      if (transitionName) {
        await obs.call('SetCurrentSceneTransition', { transitionName });
      }
      await obs.call('SetCurrentProgramScene', { sceneName });
      emitScene(sceneName);
      return true;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      return false;
    }
  }

  async function getTransitions() {
    if (!connected) return [];
    try {
      const res = await obs.call('GetSceneTransitionList');
      return (res.transitions || []).map(t => t.transitionName).filter(Boolean);
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      return [];
    }
  }

  // ── OBS settings watchdog ───────────────────────────────────────────────────
  // "OBS reset my settings again" is unanswerable without evidence, and asking a
  // producer for their OBS log is intrusive. Since we hold a live socket anyway,
  // read the handful of values that live behind Settings > Output/Video and report
  // whenever one moves. We never write any of them (see FORBIDDEN above), so a
  // change here is always something else on that machine.
  //
  // Deliberately does NOT call GetStreamServiceSettings: that response carries the
  // stream KEY, and these snapshots get written to a file a producer may hand over.
  // All reads, no writes.
  const SETTINGS_PROBE = [
    ['outputMode',      'Output',       'Mode'],
    ['advEncoder',      'AdvOut',       'Encoder'],
    ['advRescale',      'AdvOut',       'Rescale'],
    ['advRescaleRes',   'AdvOut',       'RescaleRes'],
    ['advTrack',        'AdvOut',       'TrackIndex'],
    ['simpleEncoder',   'SimpleOutput', 'StreamEncoder'],
    ['simpleVBitrate',  'SimpleOutput', 'VBitrate'],
    ['simpleABitrate',  'SimpleOutput', 'ABitrate'],
    ['simplePreset',    'SimpleOutput', 'Preset'],
  ];

  let settingsTimer = null;
  let lastSnapshot = null;

  async function readSettings() {
    if (!connected) return null;
    const snap = {};
    const errors = {};                 // probe -> why it could not be read
    const unreadable = [];             // snapshot fields that probe was meant to fill
    // `fills` is what this probe is responsible for. On failure those fields are
    // marked unreadable rather than left missing — otherwise the next diff reports
    // them as "changed to (unset)", which is a false alarm about the producer's OBS.
    const probe = async (key, fills, fn) => {
      try { await fn(); } catch (e) {
        errors[key] = (e && e.message) || String(e);
        fills.forEach((f) => unreadable.push(f));
      }
    };

    await probe('version', ['obsVersion', 'platform'], async () => {
      const v = await obs.call('GetVersion');
      snap.obsVersion = (v && v.obsVersion) || null;
      snap.platform = (v && v.platformDescription) || null;
    });
    await probe('profile', ['profile', 'profileCount'], async () => {
      const p = await obs.call('GetProfileList');
      snap.profile = (p && p.currentProfileName) || null;
      snap.profileCount = (p && p.profiles) ? p.profiles.length : null;
    });
    await probe('sceneCollection', ['sceneCollection'], async () => {
      const c = await obs.call('GetSceneCollectionList');
      snap.sceneCollection = (c && c.currentSceneCollectionName) || null;
    });
    await probe('video', ['baseRes', 'outputRes', 'fps'], async () => {
      const vs = await obs.call('GetVideoSettings');
      snap.baseRes = vs ? `${vs.baseWidth}x${vs.baseHeight}` : null;
      snap.outputRes = vs ? `${vs.outputWidth}x${vs.outputHeight}` : null;
      snap.fps = vs ? ((vs.fpsDenominator ? (vs.fpsNumerator / vs.fpsDenominator) : vs.fpsNumerator) || null) : null;
    });
    for (const [key, category, name] of SETTINGS_PROBE) {
      await probe(key, [key], async () => {
        const r = await obs.call('GetProfileParameter', { parameterCategory: category, parameterName: name });
        // Report exactly what the profile holds, nothing more. A parameter OBS says
        // is unset stays unset: substituting the default OBS reports would invent a
        // value the producer never chose, and would hide a real change behind it.
        snap[key] = (r && r.parameterValue != null) ? String(r.parameterValue) : null;
      });
    }

    // A read that FAILED is not the same as a value that did not change, so it is
    // recorded rather than skipped. Kept off the value diff on purpose: a transient
    // read error must never be reported to the producer as "OBS changed".
    if (Object.keys(errors).length) snap._errors = errors;
    if (unreadable.length) snap._unreadable = unreadable;
    return snap;
  }

  // Returns [{ key, from, to }] for everything that moved between two snapshots.
  function diffSettings(a, b) {
    if (!a || !b) return [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.delete('_errors');
    keys.delete('_unreadable');
    // Anything either side could not read is dropped from the comparison entirely:
    // "we failed to ask" must never be presented to a producer as "OBS changed".
    [].concat(a._unreadable || [], b._unreadable || []).forEach((k) => keys.delete(k));
    const out = [];
    keys.forEach((k) => {
      if (String(a[k] == null ? '' : a[k]) !== String(b[k] == null ? '' : b[k])) {
        out.push({ key: k, from: a[k] == null ? '(unset)' : String(a[k]), to: b[k] == null ? '(unset)' : String(b[k]) });
      }
    });
    return out;
  }

  async function pollSettings(reason) {
    const snap = await readSettings();
    if (!snap) return;
    const changes = diffSettings(lastSnapshot, snap);
    const first = !lastSnapshot;
    lastSnapshot = snap;
    if (onSettingsSnapshot) onSettingsSnapshot({ snapshot: snap, changes, first, reason: reason || 'poll' });
  }

  function startSettingsWatch() {
    if (settingsTimer) return;
    // 30s: these values change on a human timescale (a dialog, a profile switch, an
    // encoder falling back at launch), and each pass is ~14 tiny reads.
    settingsTimer = setInterval(() => { pollSettings('poll').catch(() => {}); }, 30000);
    if (settingsTimer.unref) settingsTimer.unref();
  }
  function stopSettingsWatch() {
    if (settingsTimer) { clearInterval(settingsTimer); settingsTimer = null; }
    lastSnapshot = null;   // next connect re-baselines
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
    if (r === null) noteReplayBufferError({ message: lastError });
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
      obs.call('SaveReplayBuffer').catch((e) => { lastError = noteReplayBufferError(e); finish(null); });
      setTimeout(() => finish(null), timeoutMs);
    });
  }
  async function startReplayBuffer() {
    const r = await call('StartReplayBuffer');
    if (r === null) noteReplayBufferError({ message: lastError });
    return r !== null;
  }
  async function stopReplayBuffer() {
    const r = await call('StopReplayBuffer');
    return r !== null;
  }
  async function isReplayBufferActive() {
    const r = await call('GetReplayBufferStatus');
    if (r === null) { noteReplayBufferError({ message: lastError }); return false; }
    replayBufferAvailable = true;
    return !!r.outputActive;
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
    getTransitions,
    switchSceneWithTransition,
    readSettings,
    diffSettings,
    isConnected: () => connected,
    getCurrentScene: () => currentScene,
    getLastError: () => lastError,
    isReplayBufferAvailable: () => replayBufferAvailable,
  };
}

module.exports = { createObsClient };
