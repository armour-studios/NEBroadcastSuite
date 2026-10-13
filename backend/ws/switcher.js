'use strict';
// Streaming software (OBS, Streamlabs, vMix): scenes, replay, commercials — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_manualCutSeq, _postGameTimer, _switcherWatching, clipSystem, obsClient, obsPassword, obsStingerFile, slobsToken).
let
  OBS_RB_OFF_MSG, VMIX_REPLAY_SECONDS, WS_HANDLERS, airPlayableUrl, bridgeClients, broadcast,
  broadcastFullState, clearBreakAutoSwitch, connectObs, disconnectObs, endCommercial,
  filterSwitchableScenes, fs, obsAppIsStreamlabs, obsAppName, obsClientFactory, obsPlace,
  pollObsPreview, pollVmix, probeVideoInfo, replayBufferErrorMessage, replayUrlToPath,
  saveAppState, setupObsClient, startCommercial, state, switcherAudioSet, switcherCut,
  switcherFtb, switcherIsVmix, switcherRecord, switcherReplay, switcherSetPreview,
  switcherStream, switcherTake, syncReplayBufferAvailability, tagObsSwitch, tl, vmix, vmixApi,
  vmixDo, vmixMarkReplay, vmixPlace, willAirPrep;
let ctx;

const handlers = {
  push_to_obs_source(msg, ws) {
    const d = msg.data || {};
    if (!d.url || !d.sourceName) return;
    if (ctx.obsClient && ctx.obsClient.isConnected()) {
      ctx.obsClient.call('SetInputSettings', { inputName: d.sourceName.trim(), inputSettings: { url: d.url.trim() } }).catch((e) => {
        console.warn('[OBS push] SetInputSettings failed:', e && e.message);
      });
    }
  },

  // Create a browser source in OBS if it doesn't exist yet (or retarget it if it does).
  // Used by LISTEN IN's "Add to OBS" so producers never hand-configure the source; audio is
  // rerouted (= "Control audio via OBS") and monitored so it reaches both stream and producer.
  // audio:false (overlays added from Modern's setup / Assets) skips both: a graphics layer has
  // no sound worth routing, and monitoring it would only echo stinger audio to the producer.
  obs_ensure_browser_source(msg, ws) {
    const d = msg.data || {};
    const audio = d.audio !== false;
    const name = (d.sourceName || '').toString().trim();
    const url = (d.url || '').toString().trim();
    if (!name || !url) return;
    (async () => {
      let ok = false, message = '';
      try {
        if (!ctx.obsClient || !ctx.obsClient.isConnected()) throw new Error(`Not connected to ${obsAppName()}. Connect it on the Apps page, then try again.`);
        const cur = await ctx.obsClient.call('GetCurrentProgramScene');
        const sceneName = (d.sceneName || '').toString().trim() || cur.currentProgramSceneName;
        const list = await ctx.obsClient.call('GetInputList');
        const exists = (list.inputs || []).some((i) => i.inputName === name);
        if (exists) {
          await ctx.obsClient.call('SetInputSettings', { inputName: name, inputSettings: { url } });
          message = `"${name}" already exists in OBS — URL updated.`;
        } else {
          await ctx.obsClient.call('CreateInput', {
            sceneName, inputName: name, inputKind: 'browser_source',
            inputSettings: { url, width: 1920, height: 1080, reroute_audio: audio }
          });
          if (audio) {
            await ctx.obsClient.call('SetInputAudioMonitorType', { inputName: name, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' }).catch(() => {});
            message = `Added "${name}" to scene "${sceneName}" — audio is monitored and on stream.`;
          } else {
            message = `Added "${name}" to your OBS scene "${sceneName}".`;
          }
        }
        ok = true;
      } catch (e) { message = (e && e.message) || 'OBS error'; }
      try { ws.send(JSON.stringify({ type: 'obs-ensure-result', data: { ok, message } })); } catch (e) {}
    })();
  },

  // "Add to OBS" from an overlay card: the overlay becomes the top layer of the scene the
  // producer is working on (see obsPlaceOverlay).
  obs_add_overlay(msg, ws) {
    const d = msg.data || {};
    const name = (d.sourceName || '').toString().trim().slice(0, 120);
    const url = (d.url || '').toString().trim();
    const nw = Math.max(16, Math.min(7680, parseInt(d.width, 10) || 1920));
    const nh = Math.max(16, Math.min(7680, parseInt(d.height, 10) || 1080));
    if (!name || !/^https?:\/\//i.test(url)) return;
    (async () => {
      let ok = false, message = '';
      try {
        if (switcherIsVmix()) {
          if (!state.vmix.enabled || !state.vmix.connected) throw new Error('vMix is not reachable. Check Apps > vMix (is vMix running with the Web API on?).');
          const how = await vmixPlace.ensureBrowserInput(vmixApi(), name, url);
          message = how === 'updated' ? `vMix input "${name}" now shows this overlay.` : `Added "${name}" to vMix as a Web Browser input.`;
          ok = true;
          return;
        }
        if (!ctx.obsClient || !ctx.obsClient.isConnected()) throw new Error(`Not connected to ${obsAppName()}. Connect it under Apps > Streaming software, then try again.`);
        const sceneName = await obsPlace.workingScene(ctx.obsClient);
        const how = await obsPlace.placeOverlay(ctx.obsClient, sceneName, name, url, nw, nh);
        message = how === 'moved'
          ? `"${name}" is now the top layer of "${sceneName}".`
          : `Added "${name}" to "${sceneName}" as the top layer.`;
        ok = true;
      } catch (e) { message = (e && e.message) || 'OBS error'; }
      finally {
        try { ws.send(JSON.stringify({ type: 'obs-ensure-result', data: { ok, message } })); } catch (e) {}
      }
    })();
  },

  // One click from a blank OBS to a working show: see obsBuildShowScenes.
  obs_build_show_scenes(msg, ws) {
    const base = ((msg.data && msg.data.base) || '').toString().replace(/\/+$/, '');
    (async () => {
      let ok = false, message = '';
      try {
        if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base)) throw new Error('Bad overlay address.');
        if (switcherIsVmix()) {
          if (!state.vmix.enabled || !state.vmix.connected) throw new Error('vMix is not reachable. Check Apps > vMix (is vMix running with the Web API on?).');
          const r = await vmixPlace.buildShowInputs(vmixApi(), base, state.obs.scenes);
          if (Object.keys(r.mapping).length) {
            state.obs.scenes = { ...(state.obs.scenes || {}), ...r.mapping };
            saveAppState();
          }
          pollVmix().catch(() => {});
          broadcastFullState();
          message = (r.added.length ? `Added ${r.added.length} vMix input${r.added.length === 1 ? '' : 's'}` : 'vMix inputs refreshed')
            + `; NE Graphics is on overlay channel ${vmixPlace.GRAPHICS_CHANNEL} so every graphic shows on top. `
            + (r.scoreboardLayeredOn
              ? `NE Scoreboard is layered onto "${r.scoreboardLayeredOn}".`
              : 'Map your game input to In Game, then run this again to layer NE Scoreboard onto it.');
          ok = true;
          return;
        }
        if (!ctx.obsClient || !ctx.obsClient.isConnected()) throw new Error(`Not connected to ${obsAppName()}. Connect it under Apps > Streaming software, then try again.`);
        const r = await obsPlace.buildShowScenes(ctx.obsClient, base, state.obs.scenes);
        const mappedKeys = Object.keys(r.mapping);
        if (mappedKeys.length) {
          state.obs.scenes = { ...(state.obs.scenes || {}), ...r.mapping };
          saveAppState();
          broadcastFullState();
        }
        const parts = [];
        if (r.created.length) parts.push(`Created ${r.created.length} scene${r.created.length === 1 ? '' : 's'}`);
        if (r.updated.length) parts.push(`${r.created.length ? 'refreshed' : 'Refreshed'} ${r.updated.length}`);
        message = parts.join(', ') + '. Put your game capture under "NE Scoreboard" in "NE In Game"'
          + (mappedKeys.length ? '; the app now cuts to these scenes automatically.' : '.');
        ok = true;
      } catch (e) { message = (e && e.message) || 'OBS error'; }
      finally {
        try { ws.send(JSON.stringify({ type: 'obs-ensure-result', data: { ok, message } })); } catch (e) {}
      }
    })();
  },

  // Inspect an OBS transition so the REPLAYS page can use it for real.
  // OBS only runs a transition on a SCENE CHANGE — playing the next clip inside one scene isn't
  // one, which is why "OBS transition" mode could only ever cut between clips. Fix: if the chosen
  // transition is a stinger, read its video file + transition point straight out of OBS and hand
  // them to the player, so clip-to-clip uses the SAME sting the scene cut does.
  // (obs-websocket can only report the settings of the CURRENT transition, so this makes it
  // current — which is what the mode does at air time anyway.)
  obs_transition_info(msg, ws) {
    const want = ((msg.data && msg.data.name) || '').toString().trim();
    (async () => {
      const out = { ok: false, name: want, kind: '', hasVideo: false, point: 0, duration: 0, stamp: '', message: '' };
      let restoreTrans = '';
      try {
        if (!ctx.obsClient || !ctx.obsClient.isConnected()) throw new Error(`Not connected to ${obsAppName()}`);
        const avail = state.obs.availableTransitions || [];
        const name = avail.find((t) => t === want) || avail.find((t) => t.toLowerCase() === want.toLowerCase());
        if (!name) throw new Error('That transition is not in this OBS scene collection');
        out.name = name;
        // Reading a transition's settings needs it CURRENT; put the producer's own one back right
        // after (nothing is cutting here, so there is no transition in progress to wait for).
        const before = await ctx.obsClient.call('GetCurrentSceneTransition');
        restoreTrans = before && before.transitionName && before.transitionName !== name ? before.transitionName : '';
        await ctx.obsClient.call('SetCurrentSceneTransition', { transitionName: name });
        const cur = await ctx.obsClient.call('GetCurrentSceneTransition');
        const st = (cur && cur.transitionSettings) || {};
        out.kind = (cur && cur.transitionKind) || '';
        out.duration = Number(cur && cur.transitionDuration) || 0;
        if (/stinger/i.test(out.kind)) {
          const p = (st.path || '').toString();
          if (p && fs.existsSync(p)) {
            ctx.obsStingerFile = p;                     // served by /api/obs/transition-stinger
            out.hasVideo = true;
            // Transition point, as OBS stores it. Two gotchas: obs-websocket only reports settings
            // that DIFFER from the defaults (so an untouched point comes back absent, and OBS's own
            // default is 300ms — not "unset"), and the point can be expressed in frames instead of
            // ms (tp_type 1), which we can't convert without the file's frame rate — that falls
            // back to the sting's midpoint.
            try { out.stamp = String(Math.round(fs.statSync(p).mtimeMs)); } catch (e) {}
            // True length + frame rate via ffprobe. OBS stingers are usually .webm, and those are
            // routinely written with no duration in the header — the browser then reports NaN and
            // can't time the transition itself, so we measure it here and hand the player real
            // numbers (the fps also converts a frames-based transition point into ms).
            const probe = await probeVideoInfo(p);
            out.lengthMs = probe.durationMs;
            const tpType = Number(st.tp_type) || 0;
            if (tpType === 1) {
              const frames = Number(st.transition_point_frame) || 0;
              out.pointFrames = frames;
              out.point = (frames && probe.fps) ? Math.round((frames / probe.fps) * 1000) : 0;
            } else {
              out.point = (st.transition_point != null) ? (Number(st.transition_point) || 0) : 300;
            }
            // Remember it across restarts. Without this the stinger URL only worked in the process
            // that happened to inspect the transition: after an app restart the route 404s until
            // the producer re-opens the picker, and the player shows black where the sting should
            // be. Tiny (a path + two numbers), so it rides in state.
            state.obsStinger = { name, path: p, point: out.point, lengthMs: out.lengthMs };
            saveAppState();
          } else {
            out.message = p
              ? 'OBS stinger video not found on disk: ' + p
              : 'This OBS stinger has no video file set (OBS ▸ Scene Transitions ▸ Properties).';
          }
        }
        out.ok = true;
      } catch (e) { out.message = (e && e.message) || 'OBS error'; }
      if (restoreTrans) { try { await ctx.obsClient.call('SetCurrentSceneTransition', { transitionName: restoreTrans }); } catch (e) {} }
      try { ws.send(JSON.stringify({ type: 'obs-transition-info', data: out })); } catch (e) {}
    })();
  },

  // Which OBS scenes actually contain the replay-player browser source?
  // "To Air" cuts OBS to the chosen scene and streams the clip to /replay-player.html — if no
  // scene holds that source, every step succeeds and the viewer still sees nothing. The REPLAYS
  // page asks for this so it can say so up front (and offer to add the source) instead of failing
  // silently. Note: GetSceneItemList doesn't recurse into groups, so a player buried inside a
  // group reads as "missing" — the panel's warning is dismissible for that case.
  obs_check_replay_source(msg, ws) {
    (async () => {
      const found = [];
      let ok = false, message = '';
      try {
        if (!ctx.obsClient || !ctx.obsClient.isConnected()) throw new Error(`Not connected to ${obsAppName()}`);
        const urlCache = {};
        for (const scene of (state.obs.availableScenes || [])) {
          let items = [];
          try { const r = await ctx.obsClient.call('GetSceneItemList', { sceneName: scene }); items = (r && r.sceneItems) || []; }
          catch (e) { continue; }
          for (const it of items) {
            if (it.inputKind !== 'browser_source' || !it.sourceName) continue;
            if (!(it.sourceName in urlCache)) {
              let u = '';
              try {
                const s = await ctx.obsClient.call('GetInputSettings', { inputName: it.sourceName });
                u = ((s && s.inputSettings && s.inputSettings.url) || '').toString();
              } catch (e) {}
              urlCache[it.sourceName] = u;
            }
            const url = urlCache[it.sourceName];
            // Only the plain program player counts: ?bus=preview is the staging monitor, and the
            // legacy ?playlist=<id> sources only receive their own playlist's bus.
            if (!/replay-player\.html/i.test(url)) continue;
            if (/[?&]bus=preview/i.test(url) || /[?&]playlist=/i.test(url)) continue;
            found.push({ scene, source: it.sourceName, enabled: !!it.sceneItemEnabled, url });
          }
        }
        ok = true;
      } catch (e) { message = (e && e.message) || 'OBS error'; }
      try { ws.send(JSON.stringify({ type: 'replay-source-scenes', data: { ok, message, scenes: found } })); } catch (e) {}
    })();
  },

  set_obs_autoswitch(msg, ws) {
    if (typeof msg.data?.autoSwitch === 'boolean') {
      state.obs.autoSwitch = msg.data.autoSwitch;
      saveAppState();
      broadcastFullState();
    }
  },

  // Stream-credits "credit sponsors" — the dedicated big call-out list in the end roll.
  // (set_credits is handled by the registry entry above — it shadows any case here.)

  // ── OBS WebSocket ────────────────────────────────────────────────────
  set_obs_settings(msg, ws) {
    const payload = msg.data || {};
    const wasEnabled = state.obs.enabled;

    const wasApp = state.obs.app;
    state.obs.enabled = !!payload.enabled;
    if (payload.app === 'obs' || payload.app === 'streamlabs') state.obs.app = payload.app;
    if (typeof payload.url === 'string' && payload.url.trim()) {
      state.obs.url = payload.url.trim();
    }
    if (typeof payload.slobsUrl === 'string' && payload.slobsUrl.trim()) state.obs.slobsUrl = payload.slobsUrl.trim();
    if (typeof payload.slobsToken === 'string' && payload.slobsToken.trim()) ctx.slobsToken = payload.slobsToken.trim();
    else if (payload.clearSlobsToken) ctx.slobsToken = '';
    // A different app means a different socket: setupObsClient() drops the old client below.
    if (wasApp !== state.obs.app) { state.obs.connected = false; state.obs.availableScenes = []; state.obs.audioInputs = []; state.obs.sources = []; state.obs.currentScene = ''; }
    if (typeof payload.autoSwitch === 'boolean') {
      state.obs.autoSwitch = payload.autoSwitch;
    }
    if (typeof payload.autoReplayOnGoal === 'boolean') {
      state.obs.autoReplayOnGoal = payload.autoReplayOnGoal;
    }
    if (typeof payload.postGameToCastersSec === 'number') {
      state.obs.postGameToCastersSec = Math.max(0, Math.min(120, Math.round(payload.postGameToCastersSec)));
    }
    // state.obs.kickoff is intentionally NOT settable from here — it's owned exclusively by
    // 'set_rl_scene_automation' (Match — Teams gear panel). This handler used to also accept a
    // `kickoff` field, which a hidden/unreachable duplicate control on this page sent on every
    // save with default (disabled) values, silently resetting the real setting each time.
    if (payload.scenes && typeof payload.scenes === 'object') {
      state.obs.scenes = { ...state.obs.scenes, ...payload.scenes };
    }
    if (typeof payload.password === 'string' && payload.password.trim()) {
      ctx.obsPassword = payload.password.trim();
    } else if (payload.clearPassword) {
      ctx.obsPassword = '';
    }

    saveAppState();
    broadcastFullState();

    // Apply connection state to match the new settings
    if (state.obs.enabled) {
      setupObsClient();
      connectObs();
    } else if (wasEnabled) {
      disconnectObs();
    }
  },

  // ── vMix (full alternative production backend) ──────────────────────────
  set_vmix_settings(msg, ws) {
    const p = msg.data || {};
    if (typeof p.enabled === 'boolean') state.vmix.enabled = p.enabled;
    if (typeof p.host === 'string' && p.host.trim()) state.vmix.host = p.host.trim();
    if (typeof p.port === 'number' && p.port > 0) state.vmix.port = Math.max(1, Math.min(65535, Math.round(p.port)));
    if (!state.vmix.enabled) { state.vmix.connected = false; state.vmix.lastError = null; }
    saveAppState();
    broadcastFullState();
    if (state.vmix.enabled) pollVmix().catch(() => {});   // immediate connect attempt
  },

  // Pick the live production backend (mutually exclusive — vMix is a full alternative to OBS).
  set_switcher_target(msg, ws) {
    state.switcher.target = (msg.data && msg.data.target) === 'vmix' ? 'vmix' : 'obs';
    saveAppState();
    broadcastFullState();
  },

  // ── Producer Switcher page (program/preview + take + audio, routed by backend) ──
  switcher_watch(msg, ws) {
    ctx._switcherWatching = !!(msg.data && msg.data.on);
    if (ctx._switcherWatching) { pollObsPreview().catch(() => {}); pollVmix().catch(() => {}); }
  },

  switcher_set_preview(msg, ws) {
    switcherSetPreview((msg.data && msg.data.name) || '').catch(() => {});
  },

  switcher_take(msg, ws) {
    switcherTake((msg.data && msg.data.transition) || 'Cut', Number(msg.data && msg.data.duration) || 0).catch(() => {});
  },

  switcher_stream(msg, ws) {
    switcherStream(!!(msg.data && msg.data.on), ws);
  },

  switcher_record(msg, ws) {
    switcherRecord(!!(msg.data && msg.data.on), ws);
  },

  switcher_ftb(msg, ws) {
    switcherFtb();
  },

  switcher_replay(msg, ws) {
    switcherReplay().catch(() => {});
  },

  switcher_studio_mode(msg, ws) {
    (async () => {
      if (ctx.obsClient && ctx.obsClient.isConnected()) {
        try { await ctx.obsClient.call('SetStudioModeEnabled', { studioModeEnabled: !!(msg.data && msg.data.on) }); state.obs.studioMode = !!(msg.data && msg.data.on); broadcastFullState(); } catch (e) {}
      }
    })();
  },

  switcher_audio_set(msg, ws) {
    switcherAudioSet((msg.data && msg.data.id), msg.data || {}).catch(() => {});
  },

  switcher_audio_list(msg, ws) {
    (async () => {
      // vMix audio already rides in state.vmix.inputs; this is the OBS side.
      if (state.switcher.target === 'vmix' || !ctx.obsClient || !ctx.obsClient.isConnected()) { ws.send(JSON.stringify({ type: 'switcher-audio', data: { backend: state.switcher.target, sources: [] } })); return; }
      try {
        const list = await ctx.obsClient.call('GetInputList');
        const inputs = (list && list.inputs) || [];
        const out = [];
        for (const inp of inputs) {
          const name = inp.inputName;
          try {
            const vol = await ctx.obsClient.call('GetInputVolume', { inputName: name });
            const mute = await ctx.obsClient.call('GetInputMute', { inputName: name });
            out.push({ name, volumeDb: vol && typeof vol.inputVolumeDb === 'number' ? vol.inputVolumeDb : 0, muted: !!(mute && mute.inputMuted) });
          } catch (e) { /* input without audio — skip */ }
        }
        ws.send(JSON.stringify({ type: 'switcher-audio', data: { backend: 'obs', sources: out } }));
      } catch (e) { ws.send(JSON.stringify({ type: 'switcher-audio', data: { backend: 'obs', sources: [], error: e.message } })); }
    })();
  },

  switcher_screenshot(msg, ws) {
    (async () => {
      const name = (msg.data && msg.data.name || '').trim();
      if (!ctx.obsClient || !ctx.obsClient.isConnected() || !name) { ws.send(JSON.stringify({ type: 'switcher-screenshot', data: { ok: false, name } })); return; }
      try {
        const r = await ctx.obsClient.call('GetSourceScreenshot', { sourceName: name, imageFormat: 'jpg', imageWidth: 320, imageHeight: 180, imageCompressionQuality: 40 });
        ws.send(JSON.stringify({ type: 'switcher-screenshot', data: { ok: !!(r && r.imageData), name, img: (r && r.imageData) || null } }));
      } catch (e) { ws.send(JSON.stringify({ type: 'switcher-screenshot', data: { ok: false, name } })); }
    })();
  },

  // Fire an arbitrary vMix function from the UI (test button / power actions).
  vmix_call(msg, ws) {
    const p = msg.data || {};
    if (p.function) (async () => { const r = await vmixDo(p.function, p.params || {}); if (!r.ok) broadcastFullState(); })();
  },

  // Quick connection test — used by the Settings "Test" button.
  vmix_test_connection(msg, ws) {
    (async () => {
      try {
        const s = await vmix.vmixState(state.vmix.host, state.vmix.port);
        state.vmix.connected = true; state.vmix.lastError = null;
        Object.assign(state.vmix, { version: s.version, edition: s.edition, inputs: s.inputs, overlays: s.overlays, active: s.active, preview: s.preview, streaming: s.streaming, recording: s.recording });
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'vmix-result', data: { ok: true, message: `Connected — vMix ${s.version} (${s.edition}), ${s.inputs.length} input(s).`, inputs: s.inputs } }));
      } catch (e) {
        state.vmix.connected = false;
        state.vmix.lastError = e.code === 'ECONNREFUSED' ? 'vMix not reachable (running with Web API on?)' : e.message;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'vmix-result', data: { ok: false, message: state.vmix.lastError } }));
      }
    })();
  },

  obs_test_connection(msg, ws) {
    (async () => {
      if (!obsClientFactory()) {
        ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: (obsAppIsStreamlabs() ? 'Streamlabs' : 'OBS') + ' integration not available in this build.' } }));
        return;
      }
      // Share any in-flight connect started by set_obs_settings; don't start a second concurrent one.
      const ok = await connectObs();
      const scenes = state.obs.availableScenes || [];
      ws.send(JSON.stringify({
        type: 'obs-result',
        data: ok
          ? { ok: true, message: `Connected — found ${scenes.length} scene(s).`, scenes }
          : { ok: false, message: state.obs.lastError || 'Connection failed.' }
      }));
    })();
  },

  obs_refresh_scenes(msg, ws) {
    (async () => {
      if (!ctx.obsClient || !ctx.obsClient.isConnected()) {
        ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: `Not connected to ${obsAppName()}.` } }));
        return;
      }
      const scenes = filterSwitchableScenes(await ctx.obsClient.getScenes());
      state.obs.availableScenes = scenes;
      broadcastFullState();
      ws.send(JSON.stringify({ type: 'obs-result', data: { ok: true, message: `Refreshed — ${scenes.length} scene(s).`, scenes } }));
    })();
  },

  obs_switch_scene(msg, ws) {
    const sceneName = (msg.data && msg.data.sceneName || '').trim();
    // A manual cut cancels any pending auto post-game→casters or countdown→scene switch.
    if (ctx._postGameTimer) { clearTimeout(ctx._postGameTimer); ctx._postGameTimer = null; }
    clearBreakAutoSwitch();
    if (!sceneName) return;
    // Optional: perform this cut with a specific OBS transition (the REPLAYS page's "OBS
    // transition" mode, incl. an OBS stinger). Armed and AWAITED before the cut — arming from a
    // separate message would race the switch and land on whatever transition was current.
    const wantTrans = (msg.data && msg.data.transitionName || '').toString().trim();
    const cutSeq = ++ctx._manualCutSeq;
    tl('scene.cut.request', { to: sceneName, transition: wantTrans || '', by: 'operator' });
    if (wantTrans && ctx.obsClient && ctx.obsClient.isConnected()) {
      (async () => {
        const avail = state.obs.availableTransitions || [];
        const name = avail.find((t) => t === wantTrans) || avail.find((t) => t.toLowerCase() === wantTrans.toLowerCase()) || '';
        const dur = Number(msg.data.transitionDurationMs);
        const doCut = async () => {
          // A newer cut was asked for while this one armed its transition: landing now would put the
          // stale scene on air last.
          if (cutSeq !== ctx._manualCutSeq) { console.log('[Scene] dropped superseded cut to "' + sceneName + '"'); tl('scene.cut.dropped', { to: sceneName, why: 'a newer cut' }); return false; }
          switcherCut(sceneName);
          return true;
        };
        // Borrow the transition for this one cut; obs-client puts the producer's own transition and
        // duration back once it has played (it used to stay set, so the next cut played the stinger).
        if (ctx.obsClient.kind !== 'streamlabs' && typeof ctx.obsClient.withBorrowedTransition === 'function') {
          try { await ctx.obsClient.withBorrowedTransition(name, Number.isFinite(dur) && dur > 0 ? dur : 0, doCut); }
          catch (e) { await doCut(); }
        } else {
          try { if (name) await ctx.obsClient.call('SetCurrentSceneTransition', { transitionName: name }); } catch (e) {}
          await doCut();
        }
      })();
      return;
    }
    // Route through the active backend (OBS scene name or vMix input) — one path, both switchers.
    switcherCut(sceneName);
  },

  // Commercial break — cut to the Commercial scene (auto-returns when the video ends).
  obs_start_commercial(msg, ws) {
    const r = startCommercial();
    ws.send(JSON.stringify({ type: 'obs-result', data: r }));
  },

  obs_end_commercial(msg, ws) {
    ws.send(JSON.stringify({ type: 'obs-result', data: endCommercial() }));
  },

  obs_toggle_commercial(msg, ws) {
    ws.send(JSON.stringify({ type: 'obs-result', data: state.commercial.active ? endCommercial() : startCommercial() }));
  },

  set_commercial_auto_return(msg, ws) {
    state.obs.commercialAutoReturn = !!(msg.data && msg.data.enabled);
    saveAppState();
    broadcastFullState();
  },

  // Floating OBS program preview — a JPEG screenshot of the live program scene.
  // (OBS WebSocket can't stream video; this polls a low-res still on request.)
  obs_screenshot(msg, ws) {
    (async () => {
      if (!ctx.obsClient || !ctx.obsClient.isConnected()) {
        ws.send(JSON.stringify({ type: 'obs-screenshot', data: { ok: false, reason: 'OBS not connected' } }));
        return;
      }
      const scene = ctx.obsClient.getCurrentScene();
      if (!scene) { ws.send(JSON.stringify({ type: 'obs-screenshot', data: { ok: false, reason: 'No program scene' } })); return; }
      const width = Math.min(960, Math.max(160, Number(msg.data?.width) || 480));
      const r = await ctx.obsClient.call('GetSourceScreenshot', {
        sourceName: scene, imageFormat: 'jpg', imageWidth: width, imageCompressionQuality: 40
      });
      ws.send(JSON.stringify({ type: 'obs-screenshot', data: { ok: !!(r && r.imageData), img: (r && r.imageData) || null, scene } }));
    })();
  },

  // Ensure OBS's Virtual Camera output is running (so the OBS Program preview can show a smooth
  // live feed). msg.data.on === false stops it; default is "start if not already active".
  obs_virtualcam(msg, ws) {
    (async () => {
      if (!ctx.obsClient || !ctx.obsClient.isConnected()) {
        ws.send(JSON.stringify({ type: 'obs-virtualcam', data: { ok: false, reason: obsAppName() + ' not connected' } }));
        return;
      }
      if (ctx.obsClient.kind === 'streamlabs') {
        ws.send(JSON.stringify({ type: 'obs-virtualcam', data: { ok: false, reason: 'Streamlabs can\'t start its virtual camera over its API. Turn it on in Streamlabs.' } }));
        return;
      }
      try {
        const want = !(msg.data && msg.data.on === false);
        let active = false;
        try { active = !!(await ctx.obsClient.call('GetVirtualCamStatus')).outputActive; } catch (e) {}
        if (want && !active) { await ctx.obsClient.call('StartVirtualCam'); active = true; }
        else if (!want && active) { await ctx.obsClient.call('StopVirtualCam'); active = false; }
        ws.send(JSON.stringify({ type: 'obs-virtualcam', data: { ok: true, active } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'obs-virtualcam', data: { ok: false, reason: (e && e.message) || 'Virtual camera unavailable' } }));
      }
    })();
  },

  obs_save_replay(msg, ws) {
    (async () => {
      if (switcherIsVmix()) {
        const r = state.vmix.connected ? await vmixMarkReplay() : { ok: false, reason: 'vMix is not reachable.' };
        ws.send(JSON.stringify({ type: 'obs-result', data: { toast: true, ok: r.ok,
          message: r.ok ? `Marked the last ${VMIX_REPLAY_SECONDS}s as a vMix replay event.` : 'vMix replay: ' + r.reason } }));
        return;
      }
      if (!ctx.obsClient || !ctx.obsClient.isConnected()) {
        ws.send(JSON.stringify({ type: 'obs-result', data: { toast: true, ok: false, message: `Not connected to ${obsAppName()}.` } }));
        return;
      }
      const active = await ctx.obsClient.isReplayBufferActive();
      if (syncReplayBufferAvailability()) broadcastFullState();
      if (!active) {
        const off = ctx.obsClient.isReplayBufferAvailable && ctx.obsClient.isReplayBufferAvailable() === false;
        ws.send(JSON.stringify({ type: 'obs-result', data: { toast: true, ok: false, message: off ? OBS_RB_OFF_MSG : 'Replay Buffer is not running — start it first (in OBS or the button here).' } }));
        return;
      }
      const ok = await ctx.obsClient.saveReplayBuffer();
      ws.send(JSON.stringify({
        type: 'obs-result',
        data: { toast: true, ok, message: ok ? '✓ Replay clip saved.' : replayBufferErrorMessage('Failed to save replay.') }
      }));
    })();
  },

  obs_toggle_replay_buffer(msg, ws) {
    (async () => {
      if (switcherIsVmix()) {
        const r = state.vmix.connected ? await vmixDo('ReplayStartStopRecording') : { ok: false, reason: 'vMix is not reachable.' };
        ws.send(JSON.stringify({ type: 'obs-result', data: { toast: true, ok: r.ok,
          message: r.ok ? 'vMix replay recording toggled.' : 'vMix replay: ' + r.reason } }));
        return;
      }
      if (!ctx.obsClient || !ctx.obsClient.isConnected()) {
        ws.send(JSON.stringify({ type: 'obs-result', data: { toast: true, ok: false, message: `Not connected to ${obsAppName()}.` } }));
        return;
      }
      const active = await ctx.obsClient.isReplayBufferActive();
      const ok = active ? await ctx.obsClient.stopReplayBuffer() : await ctx.obsClient.startReplayBuffer();
      if (syncReplayBufferAvailability()) broadcastFullState();
      ws.send(JSON.stringify({
        type: 'obs-result',
        data: { toast: true, ok, message: ok ? (active ? 'Replay Buffer stopped.' : 'Replay Buffer started.') : replayBufferErrorMessage('Failed to toggle Replay Buffer.') }
      }));
    })();
  },

  // ── Replay to screen (browser source) ───────────────────────────────
  // Arm a reel for instant go-live: warm (baseline-transcode) its FIRST clip and tell overlays to
  // pre-buffer that exact prepared URL, so the eventual Push Live hits air with no prep beat — the
  // stinger just covers the cut. No encode: live playout streams the reel clip-by-clip, so warming
  // the first frame is all it takes. The client passes the first clip's URL (same one it'd play).
  replay_arm(msg, ws) {
    const p = msg.data || {};
    const bus = (typeof p.bus === 'string' && p.bus.trim()) ? p.bus.trim() : 'program';
    const rawUrl = typeof p.url === 'string' ? p.url.trim() : '';
    if (!rawUrl || !ctx.clipSystem) return;
    (async () => {
      // Tell the panel if this one needs converting first, so its go-live hold can wait it out
      // instead of timing out and cutting to a player that has nothing yet.
      const r = replayUrlToPath(rawUrl);
      if (r && await willAirPrep(r) && !ctx.clipSystem.isAirPrepReady(r.file)) {
        try { ws.send(JSON.stringify({ type: 'replay_preparing', data: { bus } })); } catch (e) {}
      }
      broadcast(bridgeClients, { type: 'replay_preload', data: { bus, url: await airPlayableUrl(rawUrl), trimIn: typeof p.trimIn === 'number' ? p.trimIn : 0 } });
    })();
  },

  replay_play(msg, ws) {
    const p = msg.data || {};
    // 'preview'/'program' are the two fixed buses; a playlist given its OWN dedicated browser
    // source (replay-player.html?playlist=<id>) sends bus:'pl_<id>' — that must pass through
    // as-is, not collapse into 'program', or the dedicated source never receives anything (the
    // whole point of giving it its own bus is independence from the main program output).
    const bus = (typeof p.bus === 'string' && p.bus.trim()) ? p.bus.trim() : 'program';
    const rawUrl = typeof p.url === 'string' ? p.url.trim() : '';
    if (!rawUrl) {
      ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, message: 'No replay URL to play.' } }));
      return;
    }

    const playSeq = ctx._manualCutSeq, playAt = Date.now();
    const commit = (url) => {
      state.replay[bus] = {
        url,
        name: typeof p.name === 'string' ? p.name : '',
        loop: !!p.loop,
        playing: true,
        trimIn: typeof p.trimIn === 'number' ? p.trimIn : 0,
        trimOut: typeof p.trimOut === 'number' ? p.trimOut : null,
        // transition is a tiny string and safe to persist in full_state; the logo image is
        // forwarded only on this live message (never stored) so no blob enters the broadcast.
        transition: typeof p.transition === 'string' ? p.transition : 'cut'
      };
      broadcast(bridgeClients, { type: 'replay_play', data: { bus, ...state.replay[bus],
        transitionLogo: typeof p.transitionLogo === 'string' ? p.transitionLogo : '',
        stinger: typeof p.stinger === 'string' ? p.stinger : '',
        // Where in the stinger the clip underneath swaps (ms; 0 = its midpoint) — same convention
        // as OBS's own stinger transition point.
        stingerPoint: typeof p.stingerPoint === 'number' ? p.stingerPoint : 0,
        // Measured sting length — lets the player time the swap/lift on files whose own header
        // carries no duration (OBS .webm stingers usually don't).
        stingerDuration: typeof p.stingerDuration === 'number' ? p.stingerDuration : 0,
        nextIn: typeof p.nextIn === 'number' ? p.nextIn : 0 } });
      broadcastFullState();
      // Preload the NEXT playlist clip WHILE this one plays: pre-transcode it (warms prepareForAir's
      // cache so its own replay_play is instant) and tell overlays to buffer it — seamless advances.
      // nextIn rides along so the overlay can park the buffered clip on its in-point.
      if (typeof p.nextUrl === 'string' && p.nextUrl.trim()) {
        const nextRaw = p.nextUrl.trim();
        const nextIn = typeof p.nextIn === 'number' ? p.nextIn : 0;
        airPlayableUrl(nextRaw).then((u) => broadcast(bridgeClients,
          { type: 'replay_preload', data: { bus, url: u, trimIn: nextIn } }));
      }
      // User-triggered replay — switch OBS to the target scene.
      // p.scene comes from the "Program scene" dropdown on the Replays page (or per-playlist override).
      // Falls back to the globally-mapped 'replay' scene key in OBS settings.
      // Note: we bypass obsSwitch() here intentionally — this is a manual producer action,
      // not an automatic game-event switch, so OBS_AUTO_SWITCH_DISABLED must not block it.
      // A slow first clip (transcode) must not yank program to the replay scene after the producer
      // has cut somewhere else, or after the panel gave up waiting (90s).
      const stale = playSeq !== ctx._manualCutSeq || Date.now() - playAt > 90000;
      if (bus === 'program' && stale) { console.log('[Replay] clip ready late; not cutting program to the replay scene (the producer moved on)'); tl('scene.cut.dropped', { to: 'replay', why: 'clip ready late' }); }
      if (bus === 'program' && !stale) {
        ctx._manualCutSeq++;
        const sc = (typeof p.scene === 'string' ? p.scene.trim() : '')
          || (state.obs && state.obs.scenes && state.obs.scenes.replay || '').trim();
        if (sc && switcherIsVmix()) switcherCut(sc);
        else if (sc && ctx.obsClient && ctx.obsClient.isConnected()) { tagObsSwitch(sc, 'manual'); ctx.obsClient.switchScene(sc); }
      }
    };

    // Make sure what we hand the browser source is actually decodable there. Two cases:
    //  • a container/codec CEF can't play at all (OBS records HEVC/MKV by default) — used to reach
    //    air raw and show a black frame while the transition around it worked;
    //  • H.264 High-Profile with heavy B-frames — plays, but CEF chews on it (continuous lag).
    // Both are answered by the cached baseline transcode. Files the browser handles natively go
    // straight through, so a normal instant replay never waits on ffmpeg. See airPlayableUrl.
    const resolved = replayUrlToPath(rawUrl);
    if (resolved && ctx.clipSystem) {
      (async () => {
        // Only announce "preparing" when we're actually about to transcode and it isn't cached.
        if (await willAirPrep(resolved) && !ctx.clipSystem.isAirPrepReady(resolved.file)) {
          try { ws.send(JSON.stringify({ type: 'replay_preparing', data: { bus } })); } catch (e) {}
        }
        commit(await airPlayableUrl(rawUrl));
      })().catch(() => commit(rawUrl));
    } else {
      commit(rawUrl);
    }
  },

  replay_stop(msg, ws) {
    const p = msg.data || {};
    const bus = (typeof p.bus === 'string' && p.bus.trim()) ? p.bus.trim() : 'program';
    state.replay[bus] = { url: '', name: '', loop: false, playing: false };
    broadcast(bridgeClients, { type: 'replay_stop', data: { bus } });
    broadcastFullState();
  },

  // Promote whatever is in Preview to Program (the multiview "take" action).
  replay_take(msg, ws) {
    const p = msg.data || {};
    state.replay.program = { ...state.replay.preview };
    // Apply the transition the producer picked so the take eases to air (not a hard cut).
    if (typeof p.transition === 'string') state.replay.program.transition = p.transition;
    broadcast(bridgeClients, { type: 'replay_play', data: { bus: 'program', ...state.replay.program, transitionLogo: typeof p.transitionLogo === 'string' ? p.transitionLogo : '' } });
    broadcastFullState();
  },

  // The replay-player overlay reports its own playback so the producer panel can show
  // time-remaining and return to the prior scene when a replay ends. Pure relay — these
  // are transient and never touch persisted state or full_state.
  replay_progress(msg, ws) {
    broadcast(bridgeClients, { type: msg.type, data: msg.data || {} });
  },

  replay_armed(msg, ws) { return WS_HANDLERS.replay_progress(msg, ws); },

  replay_ended(msg, ws) { return WS_HANDLERS.replay_progress(msg, ws); },

  // ── Run of Show bridge ──────────────────────────────────────────────
  // The rundown runner lives in the CONTROL PANEL (localStorage), not here. The panel
  // publishes a tiny label snapshot so external controllers (Stream Deck plugin) can
  // display current/next on their keys...
  set_rundown_status(msg, ws) {
    const d = msg.data || {};
    state.rundownStatus = {
      running: !!d.running,
      pos: Math.max(0, parseInt(d.pos, 10) || 0),
      total: Math.max(0, parseInt(d.total, 10) || 0),
      current: (d.current || '').toString().slice(0, 60),
      next: (d.next || '').toString().slice(0, 60),
      prev: (d.prev || '').toString().slice(0, 60)
    };
    broadcastFullState();
  },

  // ...and controllers drive the runner with ops we relay straight back to the panel.
  rundown_control(msg, ws) {
    broadcast(bridgeClients, { type: 'rundown_control', data: msg.data || {} });
  },
};

module.exports = function createSwitcherHandlers(c) {
  ctx = c;
  ({
    OBS_RB_OFF_MSG, VMIX_REPLAY_SECONDS, WS_HANDLERS, airPlayableUrl, bridgeClients, broadcast,
    broadcastFullState, clearBreakAutoSwitch, connectObs, disconnectObs, endCommercial,
    filterSwitchableScenes, fs, obsAppIsStreamlabs, obsAppName, obsClientFactory, obsPlace,
    pollObsPreview, pollVmix, probeVideoInfo, replayBufferErrorMessage, replayUrlToPath,
    saveAppState, setupObsClient, startCommercial, state, switcherAudioSet, switcherCut,
    switcherFtb, switcherIsVmix, switcherRecord, switcherReplay, switcherSetPreview,
    switcherStream, switcherTake, syncReplayBufferAvailability, tagObsSwitch, tl, vmix,
    vmixApi, vmixDo, vmixMarkReplay, vmixPlace, willAirPrep
  } = c);
  return handlers;
};
