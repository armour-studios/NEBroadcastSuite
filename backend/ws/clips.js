'use strict';
// Replays library: clips, folders, montages, encoding — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (clipSystem, telemetry).
let
  _electronApp, broadcastClipsUpdate, dialog, fs, fsp, maybeAutoMontage, os, path,
  saveAppState, state, syncClipsState, triggerClipCapture;
let ctx;

const handlers = {
  // ── Clips & montages ─────────────────────────────────────────────────
  set_clips(msg, ws) {
    const c = msg.data || {};
    if (state.clips) {
      if ('captureMode' in c && ['auto', 'prompt', 'manual'].includes(c.captureMode)) {
        state.clips.captureMode = c.captureMode;
        state.clips.autoCapture = c.captureMode === 'auto';   // keep manager in sync
      }
      if ('autoMontage' in c) state.clips.autoMontage = !!c.autoMontage;
      if ('autoCapture' in c) state.clips.autoCapture = !!c.autoCapture;
      if ('replayFolder' in c) state.clips.replayFolder = c.replayFolder || '';
      if (c.captureRules) state.clips.captureRules = { ...state.clips.captureRules, ...c.captureRules };
    }
    if (ctx.clipSystem) ctx.clipSystem.setSettings({
      autoCapture: state.clips.autoCapture,
      replayFolder: state.clips.replayFolder,
      captureRules: state.clips.captureRules
    });
    saveAppState();
    if (ctx.clipSystem) syncClipsState();
    broadcastClipsUpdate();
  },

  // Native folder picker for the OBS replay/output folder (Electron dialog in the main process).
  pick_replay_folder(msg, ws) {
    dialog.showOpenDialog({
      title: 'Select OBS Replay / Output Folder',
      properties: ['openDirectory'],
      defaultPath: (state.clips && state.clips.replayFolder) || undefined
    }).then(({ canceled, filePaths }) => {
      if (canceled || !filePaths || !filePaths[0]) return;
      if (!state.clips) state.clips = {};
      state.clips.replayFolder = filePaths[0];
      if (ctx.clipSystem) ctx.clipSystem.setSettings({
        autoCapture: state.clips.autoCapture,
        replayFolder: state.clips.replayFolder,
        captureRules: state.clips.captureRules
      });
      saveAppState();
      if (ctx.clipSystem) syncClipsState();
      broadcastClipsUpdate();
    }).catch(() => {});
  },

  // Producer clicked "Clip it" on a prompt-mode pop-up → capture now.
  clip_prompt_accept(msg, ws) {
    (async () => {
      const meta = { ...(msg.data?.meta || {}), force: true };
      const clip = await triggerClipCapture(meta);
      if (clip) maybeAutoMontage(clip);
      ws.send(JSON.stringify({ type: 'clips-result', data: {
        ok: !!(clip && clip.path),
        message: (clip && clip.path) ? '✓ Clipped.' : ((ctx.clipSystem && ctx.clipSystem.getLastError()) || 'Clip failed.')
      } }));
    })();
  },

  clip_capture_manual(msg, ws) {
    (async () => {
      const meta = {
        type: 'manual',
        game: state.activeGame,
        player: msg.data?.player || '',
        reason: msg.data?.reason || 'Manual capture',
        label: msg.data?.label || 'Manual clip',
        force: true
      };
      const clip = await triggerClipCapture(meta);
      let ok = false, message;
      if (clip && clip.path) { ok = true; message = '✓ Replay captured — ' + (clip.name || 'clip') + '.'; }
      else { message = (ctx.clipSystem && ctx.clipSystem.getLastError()) || 'Capture failed — is the OBS Replay Buffer enabled and running?'; }
      // clipId + source let the Replays page open the new clip straight into Trim.
      ws.send(JSON.stringify({ type: 'clips-result', data: { ok, message, clipId: (clip && clip.path) ? clip.id : null, source: msg.data?.source || null } }));
    })();
  },

  clip_remove(msg, ws) {
    if (ctx.clipSystem && msg.data?.id) {
      ctx.clipSystem.manager.removeClip(msg.data.id);
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  clip_update(msg, ws) {
    if (ctx.clipSystem && msg.data?.id) {
      ctx.clipSystem.manager.updateClip(msg.data.id, msg.data);
      syncClipsState();
      broadcastClipsUpdate();
      // Telemetry: a producer edit on a clip (trim/tags/notes) is a training signal.
      if (ctx.telemetry) {
        const d = msg.data;
        const trim = ('trimIn' in d || 'trimOut' in d) ? { in: d.trimIn ?? null, out: d.trimOut ?? null, editedByHuman: true } : null;
        ctx.telemetry.clipDecision({ clipId: d.id, decision: 'edit', trim, tags: d.tags || null, note: d.description || d.note || null });
      }
    }
  },

  // Move a clip between the Replays capture pool and the Highlights shelf (the promote action).
  // The clip keeps its file + membership in any reel it's already on; only its home list changes.
  clip_set_folder(msg, ws) {
    if (ctx.clipSystem && msg.data?.id && typeof msg.data?.folder === 'string') {
      ctx.clipSystem.manager.setClipFolder(msg.data.id, msg.data.folder);
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  // Copy a clip onto the OTHER shelf (non-destructive — unlike clip_set_folder, the clip stays on
  // its current shelf too). The clip pool grid's per-row and bulk "→ Highlights"/"→ Replays" actions.
  clip_copy_folder(msg, ws) {
    if (ctx.clipSystem && msg.data?.id && typeof msg.data?.folder === 'string') {
      ctx.clipSystem.manager.copyClip(msg.data.id, msg.data.folder);
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  // Drag-set running order for one clip pool shelf (Replays or Highlights). The pool grid IS the
  // order "Play all" and reel-building use, so it's producer-arrangeable, not capture-time-fixed.
  clip_reorder(msg, ws) {
    if (ctx.clipSystem && msg.data?.folder && Array.isArray(msg.data.ids)) {
      ctx.clipSystem.manager.reorderClips(msg.data.folder, msg.data.ids);
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  // Empty a clip pool shelf — remove every library clip on it. Distinct from montage_clear_shelf
  // (which clears playlists); this clears the raw clip pool grid itself.
  clip_clear_folder(msg, ws) {
    if (ctx.clipSystem && msg.data?.folder) {
      const n = ctx.clipSystem.manager.clearClipsFolder(msg.data.folder);
      syncClipsState();
      broadcastClipsUpdate();
      ws.send(JSON.stringify({ type: 'obs-result', data: { ok: true, notify: true, message: n ? `Cleared ${n} clip${n === 1 ? '' : 's'} from ${msg.data.folder === 'highlights' ? 'Highlights' : 'Replays'}.` : 'Pool already empty.' } }));
    }
  },

  // Bulk-copy every reel on one shelf onto the other (non-destructive). Clips are shared, so only
  // the playlist entries clone — no video files are duplicated.
  montage_copy_shelf(msg, ws) {
    if (ctx.clipSystem && msg.data?.from && msg.data?.to) {
      const n = ctx.clipSystem.manager.copyMontagesToFolder(msg.data.from, msg.data.to);
      syncClipsState();
      broadcastClipsUpdate();
      ws.send(JSON.stringify({ type: 'obs-result', data: { ok: true, notify: true, message: n ? `Copied ${n} reel${n === 1 ? '' : 's'} to ${msg.data.to === 'highlights' ? 'Highlights' : 'Replays'}.` : 'Nothing to copy on this shelf.' } }));
    }
  },

  // Clear a shelf — remove all its reels (and encoded exports). Clips stay in the library.
  montage_clear_shelf(msg, ws) {
    if (ctx.clipSystem && msg.data?.folder) {
      const n = ctx.clipSystem.manager.clearFolder(msg.data.folder);
      syncClipsState();
      broadcastClipsUpdate();
      ws.send(JSON.stringify({ type: 'obs-result', data: { ok: true, notify: true, message: n ? `Cleared ${n} reel${n === 1 ? '' : 's'} from ${msg.data.folder === 'highlights' ? 'Highlights' : 'Replays'}.` : 'Shelf already empty.' } }));
    }
  },

  montage_create(msg, ws) {
    if (ctx.clipSystem && Array.isArray(msg.data?.clipIds)) {
      ctx.clipSystem.manager.createMontage({
        name: msg.data.name || 'Highlight Reel',
        clipIds: msg.data.clipIds,
        template: msg.data.template || 'highlights',
        folder: msg.data.folder
      });
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  // Build a playlist/montage from a FOLDER of clips: pick a folder, import every video in it (sorted
  // by name), and drop them into a new playlist in order. Streamlines "make a highlight reel from a
  // folder of clips" (producer feedback) instead of importing files one at a time.
  montage_from_folder(msg, ws) {
    if (!ctx.clipSystem) { ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, notify: true, message: 'Clip system not ready.' } })); return; }
    (async () => {
      try {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Pick a folder of clips to build a playlist',
          properties: ['openDirectory']
        });
        if (canceled || !filePaths || !filePaths[0]) return;
        const dir = filePaths[0];
        const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;
        let files = [];
        try { files = (await fsp.readdir(dir)).filter((f) => VIDEO_RE.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); } catch (e) {}
        if (!files.length) { ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, notify: true, message: 'No video files (.mp4/.mov/.webm/.mkv…) found in that folder.' } })); return; }
        ws.send(JSON.stringify({ type: 'obs-result', data: { ok: true, message: `Importing ${files.length} clip${files.length > 1 ? 's' : ''} from the folder…` } }));
        const clipIds = [];
        for (const f of files) {
          try {
            const clip = await ctx.clipSystem.manager.importReplayFile(path.join(dir, f), { label: path.basename(f, path.extname(f)) });
            if (clip && clip.id) clipIds.push(clip.id);
          } catch (e) { /* skip an unreadable file, keep going */ }
        }
        if (!clipIds.length) { ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, notify: true, message: 'Could not import any clips from that folder.' } })); return; }
        const name = (typeof msg.data?.name === 'string' && msg.data.name.trim()) ? msg.data.name.trim() : (path.basename(dir) || 'Folder Playlist');
        const m = ctx.clipSystem.manager.createMontage({ name, clipIds, template: (typeof msg.data?.template === 'string' && msg.data.template) || 'highlights', folder: msg.data?.folder });
        syncClipsState();
        broadcastClipsUpdate();
        ws.send(JSON.stringify({ type: 'montage_from_folder_done', data: { ok: true, montageId: (m && m.id) || null, count: clipIds.length, name } }));
        ws.send(JSON.stringify({ type: 'obs-result', data: { ok: true, notify: true, message: `Built "${name}" — ${clipIds.length} clip${clipIds.length > 1 ? 's' : ''} imported into a new playlist.` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, notify: true, message: 'Folder import failed: ' + (e && e.message || e) } }));
      }
    })();
  },

  montage_reorder(msg, ws) {
    if (ctx.clipSystem && msg.data?.montageId && Array.isArray(msg.data?.clipIds)) {
      ctx.clipSystem.manager.reorderMontage(msg.data.montageId, msg.data.clipIds);
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  montage_rename(msg, ws) {
    if (ctx.clipSystem && msg.data?.montageId && typeof msg.data?.name === 'string') {
      ctx.clipSystem.manager.renameMontage(msg.data.montageId, msg.data.name);
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  // Live-playout settings for a playlist: which OBS scene it plays in + the between-clip transition.
  montage_settings(msg, ws) {
    if (ctx.clipSystem && msg.data?.montageId) {
      ctx.clipSystem.manager.setMontageSettings(msg.data.montageId, {
        programScene: msg.data.programScene,
        folder: msg.data.folder,
        kind: msg.data.kind,
        loop: msg.data.loop,
        returnEnabled: msg.data.returnEnabled,
        transition: msg.data.transition
      });
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  montage_delete(msg, ws) {
    if (ctx.clipSystem && msg.data?.montageId) {
      ctx.clipSystem.manager.deleteMontage(msg.data.montageId);
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  montage_delete_export(msg, ws) {
    if (ctx.clipSystem && msg.data?.montageId) {
      ctx.clipSystem.manager.deleteMontageExport(msg.data.montageId);
      syncClipsState();
      broadcastClipsUpdate();
    }
  },

  montage_save_export(msg, ws) {
    if (!ctx.clipSystem || !msg.data?.montageId) return;
    const _saveMontage = (ctx.clipSystem.getState().montages || []).find((x) => x.id === msg.data.montageId);
    const _savePath = _saveMontage && _saveMontage.outputPath;
    const _saveReply = (ok, message) => { try { ws.send(JSON.stringify({ type: 'montage_save_result', data: { ok, message } })); } catch {} };
    if (!_savePath) { _saveReply(false, 'No encoded file found — encode the playlist first.'); return; }
    if (!fs.existsSync(_savePath)) { _saveReply(false, 'Encoded file not found on disk.'); return; }
    const _saveExt = path.extname(_savePath) || '.mp4';
    const _saveName = (_saveMontage.name || 'playlist').replace(/[<>:"/\\|?*]/g, '_') + _saveExt;
    const _saveDesktop = (() => { try { return _electronApp.getPath('desktop'); } catch { return os.homedir(); } })();
    dialog.showSaveDialog({
      title: 'Save Encoded Playlist',
      defaultPath: path.join(_saveDesktop, _saveName),
      filters: [{ name: 'Video', extensions: [_saveExt.replace('.', '')] }]
    }).then(({ canceled, filePath }) => {
      if (canceled || !filePath) return;
      fs.copyFile(_savePath, filePath, (err) => {
        if (err) _saveReply(false, 'Save failed: ' + err.message);
        else _saveReply(true, 'Saved to ' + filePath);
      });
    }).catch((e) => _saveReply(false, 'Dialog error: ' + e.message));
  },

  montage_encode(msg, ws) {
    if (ctx.clipSystem && msg.data?.montageId) {
      (async () => {
        const m = ctx.clipSystem.getState().montages.find((x) => x.id === msg.data.montageId);
        const opts = msg.data.opts || {};
        // 'logo' transition: persist the picked logo (data URL) to a file ffmpeg can read.
        // Async write — a multi-MB logo written synchronously stalls the main-process window.
        if (opts.transition === 'logo' && typeof opts.transitionLogo === 'string' && opts.transitionLogo.startsWith('data:image/')) {
          try {
            const mm = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(opts.transitionLogo);
            if (mm) {
              const dir = path.join(ctx.clipSystem.manager.getClipsDir(), 'work');
              await fsp.mkdir(dir, { recursive: true });
              const lp = path.join(dir, `translogo_${msg.data.montageId}.${mm[1] === 'jpeg' ? 'jpg' : mm[1]}`);
              await fsp.writeFile(lp, Buffer.from(mm[2], 'base64'));
              opts.transitionLogoPath = lp;
            }
          } catch (e) { /* falls back to a black dip */ }
        }
        delete opts.transitionLogo;   // don't carry the big data URL further
        const res = ctx.clipSystem.enqueueMontage(msg.data.montageId, m?.name || 'Montage', opts);
        syncClipsState();
        broadcastClipsUpdate();
        ws.send(JSON.stringify({
          type: 'clips-result',
          data: res && res.error
            ? { ok: false, message: res.error }
            : { ok: true, message: 'Encoding started — progress shows in the toolbar.' }
        }));
      })().catch((e) => { try { ws.send(JSON.stringify({ type: 'clips-result', data: { ok: false, message: 'Encode failed to start: ' + e.message } })); } catch {} });
    }
  },

  encode_cancel(msg, ws) {
    if (ctx.clipSystem && msg.data?.jobId) {
      ctx.clipSystem.encoder.cancel(msg.data.jobId);
      state.encode = ctx.clipSystem.encoder.getQueue();
      broadcastClipsUpdate();
    }
  },
};

module.exports = function createClipHandlers(c) {
  ctx = c;
  ({
    _electronApp, broadcastClipsUpdate, dialog, fs, fsp, maybeAutoMontage, os, path,
    saveAppState, state, syncClipsState, triggerClipCapture
  } = c);
  return handlers;
};
