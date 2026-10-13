'use strict';
// Ballchasing.com (replay upload, stats, replay renaming) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (ballchasingApiKey, leaguesVer).
let
  REPLAY_RENAME_TOLERANCE_MS, bcAggregateGroupIntoLeague, bcApplyMvpCounts, bcSyncMvps,
  bcUploadReplays, bcUploadReplaysDetailed, broadcastFullState, createBallchasingClient,
  dialog, logAuto, saveAppState, scanAndRenameReplays, state, stats, syncBallchasingAutoUpload;
let ctx;

const handlers = {
  // ── Ballchasing.com — per-league group creation (the producer never visits ballchasing.com;
  // this is the one and only step that talks to their site, and it's fully automatic). ──
  // Idempotent: a league that already has a groupId just gets a friendly "already enabled"
  // reply instead of creating an orphaned second group on double-click.
  ballchasing_enable_group(msg, ws) {
    (async () => {
      const leagueId = msg.data && msg.data.leagueId;
      const lg = (state.leagues || []).find((l) => l.id === leagueId);
      if (!lg) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: 'League not found.' } })); return; }
      if (lg.ballchasing.groupId) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: true, message: 'Ballchasing is already enabled for this league.' } })); return; }
      if (!ctx.ballchasingApiKey) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: 'Save your ballchasing.com API key in Settings first.' } })); return; }
      try {
        const client = createBallchasingClient(ctx.ballchasingApiKey);
        const name = `${lg.name || 'League'} — ${lg.season || 'Season'}`.slice(0, 100);
        // by-id: stable across in-game name changes. by-player-clusters: tolerant of a mid-season
        // roster substitute (by-distinct-players would silently start a "new team" the moment one
        // player changes, corrupting cumulative stats).
        const res = await client.createGroup(name, 'by-id', 'by-player-clusters');
        const groupId = res.data && res.data.id;
        if (!groupId) throw new Error('Ballchasing did not return a group id.');
        lg.ballchasing.groupId = groupId;
        lg.ballchasing.groupUrl = `https://ballchasing.com/group/${groupId}`;   // human-facing page — NOT res.data.link, which is the API endpoint
        lg.ballchasing.enabledAt = Date.now();
        ctx.leaguesVer++;
        saveAppState();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: true, message: `Ballchasing enabled for "${lg.name}".` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  // Upload one or more .replay files into a league's ballchasing group. The producer picks files
  // (the client opens a dialog and sends absolute paths) — nothing on ballchasing.com to touch.
  ballchasing_upload_replays(msg, ws) {
    (async () => {
      const leagueId = msg.data && msg.data.leagueId;
      const paths = Array.isArray(msg.data && msg.data.paths) ? msg.data.paths : [];
      const lg = (state.leagues || []).find((l) => l.id === leagueId);
      if (!lg) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: 'League not found.' } })); return; }
      if (!lg.ballchasing.groupId) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: 'Enable Ballchasing for this league first.' } })); return; }
      if (!ctx.ballchasingApiKey) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: 'Save your ballchasing.com API key in Settings first.' } })); return; }
      if (!paths.length) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: 'No replay files selected.' } })); return; }
      const { ok, dup, fail } = await bcUploadReplays(lg, paths);
      ctx.leaguesVer++;
      saveAppState();
      broadcastFullState();
      const parts = [];
      if (ok) parts.push(`${ok} uploaded`);
      if (dup) parts.push(`${dup} already there`);
      if (fail) parts.push(`${fail} failed`);
      ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: fail === 0, message: (parts.join(', ') || 'Nothing to upload') + '. Ballchasing is processing — hit Refresh Stats in a moment.' } }));
    })();
  },

  // Pull the group's cumulative stats and fold them into the league's ballchasing sink
  // (per-team + per-player leaderboard). Never touches lg.stats (manual entry).
  ballchasing_refresh_stats(msg, ws) {
    (async () => {
      const leagueId = msg.data && msg.data.leagueId;
      const lg = (state.leagues || []).find((l) => l.id === leagueId);
      if (!lg) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: 'League not found.' } })); return; }
      if (!lg.ballchasing.groupId) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: 'Enable Ballchasing for this league first.' } })); return; }
      if (!ctx.ballchasingApiKey) { ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: 'Save your ballchasing.com API key in Settings first.' } })); return; }
      try {
        const client = createBallchasingClient(ctx.ballchasingApiKey);
        const res = await client.getGroup(lg.ballchasing.groupId);
        const summary = bcAggregateGroupIntoLeague(lg, res.data || {});
        const mvpSync = await bcSyncMvps(lg, client);
        bcApplyMvpCounts(lg);
        lg.ballchasing.pendingReplays = [];   // a successful refresh means the group has processed them
        if (mvpSync.truncated) {
          lg.ballchasing.lastRefreshNote += ` · MVP sync checked ${mvpSync.fetched} new replays (more remain — click Refresh again)`;
        } else if (mvpSync.fetched > 0) {
          lg.ballchasing.lastRefreshNote += ` · MVP sync checked ${mvpSync.fetched} new replay${mvpSync.fetched === 1 ? '' : 's'}`;
        }
        ctx.leaguesVer++;
        saveAppState();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: true, message: lg.ballchasing.lastRefreshNote || `Refreshed ${summary.players} players.` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  // ── Ballchasing.com (Rocket League replay stats) ──────────────────────────
  // Same save/test/disconnect shape as start.gg above: an empty apiKey on save means "keep
  // current" (so re-saving other ballchasing settings never wipes it) — disconnect is the only
  // path that actually clears it.
  set_ballchasing_settings(msg, ws) {
    const payload = msg.data || {};
    if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      ctx.ballchasingApiKey = payload.apiKey.trim();
    }
    saveAppState();
    broadcastFullState();
  },

  ballchasing_disconnect(msg, ws) {
    ctx.ballchasingApiKey = '';
    state.ballchasing.connected = false;
    state.ballchasing.lastError = null;
    saveAppState();
    broadcastFullState();
  },

  ballchasing_test_connection(msg, ws) {
    (async () => {
      try {
        if (!ctx.ballchasingApiKey) throw new Error('No API key saved. Enter and save your key first.');
        const client = createBallchasingClient(ctx.ballchasingApiKey);
        await client.ping();
        state.ballchasing.connected = true;
        state.ballchasing.lastError = null;
        saveAppState();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: true, message: '✓ Connected to ballchasing.com' } }));
      } catch (e) {
        state.ballchasing.connected = false;
        state.ballchasing.lastError = e.message;
        saveAppState();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'ballchasing-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  // Opt-in local-folder auto-upload — off by default (see ballchasing-watcher.js). Starting/
  // stopping the actual watcher happens in syncBallchasingAutoUpload(), called here.
  set_ballchasing_autoupload(msg, ws) {
    const p = msg.data || {};
    state.ballchasing.autoUpload = {
      enabled: !!p.enabled,
      folder: typeof p.folder === 'string' ? p.folder.trim() : (state.ballchasing.autoUpload.folder || ''),
      activeLeagueId: typeof p.activeLeagueId === 'string' ? p.activeLeagueId : (state.ballchasing.autoUpload.activeLeagueId || '')
    };
    saveAppState();
    broadcastFullState();
    if (typeof syncBallchasingAutoUpload === 'function') syncBallchasingAutoUpload();
  },

  ballchasing_pick_autoupload_folder(msg, ws) {
    dialog.showOpenDialog({
      title: 'Select Rocket League Replay Folder',
      properties: ['openDirectory'],
      defaultPath: (state.ballchasing.autoUpload && state.ballchasing.autoUpload.folder) || undefined
    }).then(({ canceled, filePaths }) => {
      if (canceled || !filePaths || !filePaths[0]) return;
      state.ballchasing.autoUpload.folder = filePaths[0];
      saveAppState();
      broadcastFullState();
      if (typeof syncBallchasingAutoUpload === 'function') syncBallchasingAutoUpload();
    }).catch(() => {});
  },

  // Manual batch tool — no watcher lifecycle to sync, unlike set_ballchasing_autoupload above.
  set_ballchasing_replayrename(msg, ws) {
    const p = msg.data || {};
    state.ballchasing.replayRename = {
      enabled: !!p.enabled,
      folder: typeof p.folder === 'string' ? p.folder.trim() : (state.ballchasing.replayRename.folder || ''),
      activeLeagueId: typeof p.activeLeagueId === 'string' ? p.activeLeagueId : (state.ballchasing.replayRename.activeLeagueId || '')
    };
    saveAppState();
    broadcastFullState();
  },

  ballchasing_pick_replayrename_folder(msg, ws) {
    dialog.showOpenDialog({
      title: 'Select Rocket League Replay Folder',
      properties: ['openDirectory'],
      defaultPath: (state.ballchasing.replayRename && state.ballchasing.replayRename.folder) || undefined
    }).then(({ canceled, filePaths }) => {
      if (canceled || !filePaths || !filePaths[0]) return;
      state.ballchasing.replayRename.folder = filePaths[0];
      saveAppState();
      broadcastFullState();
    }).catch(() => {});
  },

  // Runs the full scan+rename+upload batch. Async/non-blocking: this app's convention for slow ops
  // (folder scan + N uploads against ballchasing's rate limit can take a while) is fire-and-push-
  // later — see startgg_sync_set below for the same ws.send(JSON.stringify(...)) pattern.
  ballchasing_run_replayrename(msg, ws) {
    (async () => {
      const rr = state.ballchasing.replayRename || {};
      const folder = (rr.folder || '').trim();
      const lg = (state.leagues || []).find((l) => l.id === rr.activeLeagueId);
      try {
        if (!folder) throw new Error('No replay folder configured.');
        if (!lg || !lg.ballchasing || !lg.ballchasing.groupId) throw new Error('No active league with a Ballchasing group. Pick one above.');
        if (!ctx.ballchasingApiKey) throw new Error('Save your ballchasing.com API key in Settings first.');
        ws.send(JSON.stringify({ type: 'ballchasing-replayrename-started', data: { folder } }));

        const { renamed, skipped } = await scanAndRenameReplays({
          folder,
          findNearestGame: (ts) => stats.findNearestRlGame(ts, REPLAY_RENAME_TOLERANCE_MS),
          log: (m) => logAuto('ballchasing', m)
        });

        const uploadByPath = new Map();
        if (renamed.length) {
          const detailed = await bcUploadReplaysDetailed(lg, renamed.map((r) => r.absPath));
          detailed.forEach((d) => uploadByPath.set(d.path, d));
          ctx.leaguesVer++;
          saveAppState();
          broadcastFullState();
        }

        const results = [
          ...renamed.map((r) => {
            const u = uploadByPath.get(r.absPath);
            return {
              originalName: r.originalName, newName: r.newName, matchedGame: r.matchedGame,
              uploaded: !!(u && u.ok), duplicate: !!(u && u.dup), error: u && !u.ok ? u.error : null
            };
          }),
          ...skipped.map((s) => ({ originalName: s.originalName, newName: null, matchedGame: null, uploaded: false, error: s.reason }))
        ];
        const uploadedCount = results.filter((r) => r.uploaded).length;
        ws.send(JSON.stringify({ type: 'ballchasing-replayrename-result', data: {
          ok: true, results,
          message: `${renamed.length} renamed, ${uploadedCount} uploaded, ${skipped.length} left untouched (no match).`
        }}));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ballchasing-replayrename-result', data: { ok: false, results: [], message: e.message } }));
      }
    })();
  },
};

module.exports = function createBallchasingHandlers(c) {
  ctx = c;
  ({
    REPLAY_RENAME_TOLERANCE_MS, bcAggregateGroupIntoLeague, bcApplyMvpCounts, bcSyncMvps,
    bcUploadReplays, bcUploadReplaysDetailed, broadcastFullState, createBallchasingClient,
    dialog, logAuto, saveAppState, scanAndRenameReplays, state, stats,
    syncBallchasingAutoUpload
  } = c);
  return handlers;
};
