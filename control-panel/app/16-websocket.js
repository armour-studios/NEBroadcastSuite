// Control panel, part 16 of 17: WebSocket connection and message handling.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── WebSocket ─────────────────────────────────────────────────────────────
// The bridge (:3001) now requires a token on every connection (see server.js
// getOrCreateWsToken/verifyClient) — fetched once from the HTTP API (same trust boundary
// as the rest of the control panel's localhost:3000 calls) and cached for reconnects.
let _wsToken = null;
async function connect() {
  if (!_wsToken) {
    try {
      const r = await fetch('http://127.0.0.1:3000/api/ws-token');
      const j = await r.json();
      _wsToken = j.token || '';
    } catch (e) { _wsToken = ''; }
  }
  ws = new WebSocket(WS_URL + (_wsToken ? ('?token=' + encodeURIComponent(_wsToken)) : ''));

  ws.onopen = () => {
    setStatus(true);
    // Identify as the control panel so it isn't counted as a live overlay browser source.
    try { ws.send(JSON.stringify({ type: 'register', role: 'control' })); } catch (e) {}
    send('request_state');
    // Heartbeat: prove the RECEIVE direction is alive. A half-open socket can still send
    // (so overlays/commands appear to work) while broadcasts silently stop arriving — which
    // froze the panel. Any inbound message refreshes _lastRx; if none for 25s, force-reconnect.
    _lastRx = Date.now();
    clearInterval(_hbTimer);
    _hbTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - _lastRx > 25000) { try { ws.close(); } catch {} return; }
      send('ping');
    }, 10000);
  };

  ws.onmessage = ({ data }) => {
    _lastRx = Date.now();   // any inbound traffic proves we're still receiving
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'pong') return;   // heartbeat reply — nothing else to do

    if (msg.type === 'full_state') {
      // Resilient render: a throw in ANY one renderer must NOT blank the rest of the cockpit
      // (one buggy overlay/integration panel used to take down the whole UI + quick menu). Each
      // is isolated; the failing function is logged so the culprit is obvious in DevTools.
      const _r = (label, fn) => { try { fn(); } catch (e) { console.error('[render:' + label + ']', e); } };
      _r('applyState',         () => applyState(msg.data));
      _r('applyRlSpectatorUi', () => applyRlSpectatorUi(msg.data));
      _r('renderCreditSponsors', () => renderCreditSponsors(msg.data));
      _r('renderCreditsCountryStat', () => renderCreditsCountryStat());
      _r('applyScenesCockpit', () => applyScenesCockpit(msg.data));
      _r('renderScenePresets', () => renderScenePresets(msg.data));
      _r('renderWhatsArmed',   () => renderWhatsArmed(msg.data));
      _r('renderQuickToolbar',   () => renderQuickToolbar(msg.data));
      _r('refreshDeckLive',      () => { if (typeof refreshDeckLive === 'function') refreshDeckLive(); });
      _r('renderDashMiniPanels', () => renderDashMiniPanels(msg.data));
      _r('renderQrailScenes',    () => renderQrailScenes(msg.data));
      _r('renderQuickPanel',     () => renderQuickPanel(msg.data));
      _r('renderIntegrationStore', () => renderIntegrationStore(msg.data));
      _r('schSync',              () => { if (typeof window._schSyncFromState === 'function') window._schSyncFromState(msg.data); });
      _r('bbSyncTriggerPop',     () => bbSyncTriggerPop());
      _r('renderQrailStartgg',  () => renderQrailStartgg(msg.data));
      _r('renderGoLive',       () => renderGoLive(msg.data));
      _r('renderUpNext',       () => renderUpNext(msg.data));
      _r('renderPlayerCams',   () => renderPlayerCams(msg.data));
      _r('renderStreamQueue',  () => renderStreamQueue(msg.data));
      _r('siteEvents',         () => { if (window.__siteEvents) window.__siteEvents.render(currentState); });
      // Settings > Software Updates: the version is in every state; do not wait for an update event to show it.
      _r('updVersion',         () => { const c = el('upd-current'); if (c && currentState && currentState.version && c.textContent === '—') c.textContent = 'v' + currentState.version; });
      _r('renderStreamArchive', () => { if (el('sgg-tab-archive')?.classList.contains('is-on')) renderStreamArchive(msg.data); });
      _r('dockControls',         () => { if (typeof window._dockControlsRender === 'function') window._dockControlsRender(); });
      _r('dockShow',             () => { if (typeof window._dockShowRender === 'function') window._dockShowRender(); });
      _r('gfxFormSync',          () => { if (typeof window._gfxFormSync === 'function') window._gfxFormSync(); });
      _r('renderCfStations',   () => renderCfStations());
      _r('renderQrailBufferStatus', () => { if (typeof renderQrailBufferStatus === 'function') renderQrailBufferStatus(msg.data); });
      _r('applyDirectorState', () => applyDirectorState(msg.data.director));
      _r('applyClipsState',    () => applyClipsState(msg.data.clips));
      _r('applyEncodeProgress',() => applyEncodeProgress(msg.data.encode));
      _r('applyTwitchState',   () => applyTwitchState(msg.data.twitch));
      _r('applyReplayMonitors',() => applyReplayMonitors(msg.data.replay));
      _r('applyDiscordState',  () => applyDiscordState(msg.data.discord));
      _r('eventOps',           () => { if (typeof window.eventOpsOnState === 'function') window.eventOpsOnState(); });
      _r('perfMode',           () => applyPerfMode(msg.data));
      _r('cloudRole',          () => applyCloudRole(msg.data.cloudRole));
      _r('chatHighlight',      () => renderChatHighlight(msg.data));
      _r('multichatConfig',    () => renderMultichatConfig(msg.data));
      _r('questions',          () => renderQuestions(msg.data));
      // Backfill the multichat feed once per session, after the first snapshot lands.
      if (!window._chatLogRequested) { window._chatLogRequested = true; send('request_chat_log'); }
    } else if (msg.type === 'rundown_control') {
      // External Run of Show control (Stream Deck plugin) — the server relays these
      // to us because the rundown runner lives in this panel, not on the server.
      const op = msg.data && msg.data.op;
      if (op === 'next') rdNext();
      else if (op === 'prev') rdPrev();
      else if (op === 'run') { if (_rdRunning) rdRunCurrent(); else rdStart(); }
      else if (op === 'stop') rdStop();
    } else if (msg.type === 'twitch_stream_state') {
      onTwitchStreamState(msg);
    } else if (msg.type === 'client_log') {
      // Main-process diagnostics (e.g. a state-serialization stack-overflow — see server.js's
      // _logSerializeFailure) relayed into the renderer's own console so core.js's console
      // capture picks it up automatically — otherwise a producer's bug report would never carry
      // the one piece of information (the repeating stack frame) that actually explains it.
      const d = msg.data || {};
      const level = ['log', 'warn', 'error', 'info', 'debug'].includes(d.level) ? d.level : 'error';
      console[level]('[main]', d.text || '');
    } else if (msg.type === 'director_update') {
      if (!currentState.director) currentState.director = {};
      Object.assign(currentState.director, msg.data);
      applyDirectorState(currentState.director);
    } else if (msg.type === 'clips_update') {
      currentState.clips = msg.data;
      applyClipsState(msg.data);
      if (_rpCaptureOpenId) rpOpenCapturedClip();
      if (typeof renderQrailReplay === 'function') { try { renderQrailReplay(currentState); } catch (e) { console.error('[render:renderQrailReplay]', e); } }
      if (typeof renderQrailPlaylists === 'function') { try { renderQrailPlaylists(currentState); } catch (e) { console.error('[render:renderQrailPlaylists]', e); } }
    } else if (msg.type === 'replay_progress') {
      // The on-air player reports its position → drive the time-remaining readout, but ONLY while
      // the control panel has actually sent something to air. Otherwise a player source still loaded
      // in OBS keeps reporting and the countdown flashes/updates with nothing live. Everything now
      // shares the program bus, so match against _plBus ('program', or 'preview' for the staging monitor).
      if ((msg.data?.bus || 'program') === (_plBus || 'program') && (_replayActive || _plLiveActive)) {
        _lastProgressRx = Date.now(); showReplayCountdown(msg.data?.remaining || 0);
      }
    } else if (msg.type === 'replay_ended') {
      if ((msg.data?.bus || 'program') === (_plBus || 'program')) {
        if (_plLiveActive && _plEncodedMode) {
          // One already-encoded file (transitions baked in) — there's no next clip to advance to,
          // just finish. advancePlaylist()'s _plLiveItems/_plLiveIdx are only populated by the
          // per-clip automation paths and would be stale/wrong here.
          _plLiveActive = false;
          finishPlayout();
        } else if (_plLiveActive) {
          // Per-clip playlist: the overlay confirmed the clip finished — advance immediately
          // instead of waiting for the safety-net timer.
          advancePlaylist();
        } else {
          endReplayProgram();
        }
      }
      stopReplayCountdown();
    } else if (msg.type === 'adproof_update') {
      _adProofReport = msg.data;
      const panel = el('stats-panel-sponsors');
      if (panel && panel.style.display !== 'none' && el('tab-stats-content')?.classList.contains('active')) renderAdProof(msg.data);
    } else if (msg.type === 'lol_draft_status') {
      const s = el('draft-auto-status');
      if (s && el('draft-game')?.value === 'league') { const d = msg.data || {}; s.textContent = d.status === 'off' ? '' : draftAutoStatusText(d.status, d.detail); }
    } else if (msg.type === 'lol_update') {
      applyLolState({ lol: msg.data });    // keep the League connection chip live at the poll rate
    } else if (msg.type === 'apex_update') {
      applyApexState({ apex: msg.data, activeGame: 'apex' });    // keep the Apex chip live between full_states
    } else if (msg.type === 'lol_ocr_status') {
      lolOcrStatus(msg.status, msg.detail, msg.lastBlue, msg.lastRed, msg);
    } else if (msg.type === 'lol_ocr_displays') {
      onLolOcrDisplays(msg);
    } else if (msg.type === 'lol_ocr_snapshot') {
      onLolOcrSnapshot(msg);
    } else if (msg.type === 'lol_ocr_autolocate') {
      onLolOcrAutolocate(msg);
    } else if (msg.type === 'startgg_import') {
      onStartggImport(msg.data || {});
    } else if (msg.type === 'analytics_update') {
      _anLive = msg.data;
      if (el('tab-stats-content')?.classList.contains('active')) {
        const bp = el('stats-panel-broadcasts'), op = el('stats-panel-overview');
        if (bp && bp.style.display !== 'none') renderLiveCard(msg.data);
        else if (op && op.style.display !== 'none') {
          const banner = el('an-live-banner');
          if (banner) banner.innerHTML = (msg.data && msg.data.active)
            ? `<div class="an-livebar"><span class="app-live-dot"></span> Recording <b>${escapeHtml(msg.data.label || '')}</b> · ${anDur(msg.data.durationSec)} · ${anNum(msg.data.viewers)} viewers (peak ${anNum(msg.data.peakViewers)})</div>` : '';
        }
      }
    } else if (msg.type === 'clip_prompt') {
      showClipPrompt(msg.data);
    } else if (msg.type === 'encode_progress') {
      currentState.encode = msg.data;
      applyEncodeProgress(msg.data);
      if (typeof window._socHandleEncodeProgress === 'function') window._socHandleEncodeProgress(msg.data);
    } else if (msg.type === 'montage_save_result') {
      const d = msg.data || {};
      showToast(d.message || 'Done', d.ok ? '#48bb78' : '#f87171');
    } else if (msg.type === 'clips-result') {
      const st = el('clips-status');
      if (st) { st.textContent = msg.data.message || ''; st.style.color = msg.data.ok ? '#9ae6b4' : '#f56565'; }
      if (msg.data.source) rpOnCaptureResult(msg.data);
    } else if (msg.type === 'state_update') {
      // Sync facecam grid live as players join — skip when between matches (empty array)
      if (msg.data.players && msg.data.players.length > 0) {
        syncFacecamRows(msg.data.players, msg.data.facecams || []);
        applySpotlightState({ players: msg.data.players, spotlight: currentState.spotlight || {} });
        // Series-stats readout tracks the game being played. Throttled — these packets land many
        // times a second and this is one sentence, not a scoreboard.
        if (typeof window.gfxSeriesStatsStatus === 'function' && currentState
            && Date.now() - (window._ssStatusAt || 0) > 400) {
          window._ssStatusAt = Date.now();
          try { window.gfxSeriesStatsStatus({ ...currentState, players: msg.data.players }); } catch (e) {}
        }
      }
    } else if (msg.type === 'rl_status') {
      const rlIcon = el('rl-status')?.querySelector('.status-icon');
      if (rlIcon) {
        rlIcon.classList.toggle('connected', msg.data.connected);
      }
    } else if (msg.type === 'import-export-result') {
      // Game Config uses the same generic result channel as Producer Profile (sendImportExportResult
      // server-side) — route by the context field so each feature's own status line updates, not both.
      if (msg.data.context === 'game-config' && typeof window._gcHandleImportExportResult === 'function') {
        window._gcHandleImportExportResult(msg.data.message, msg.data.result);
      } else if (msg.data.context === 'org-seats') {
        const r = el('org-seats-result');
        if (r) { r.textContent = msg.data.message || ''; r.style.color = msg.data.result ? 'green' : 'red'; }
        if (msg.data.result && window._cloudWorkspaceId) send('cloud_list_org_seats', { orgId: window._cloudWorkspaceId });
      } else if (msg.data.context === 'league') {
        if (typeof lgStatus === 'function') lgStatus(msg.data.message || '', msg.data.result);
        if (typeof lgRenderCloudSyncStatus === 'function') lgRenderCloudSyncStatus();
        if (msg.data.result && window._cloudWorkspaceId) send('cloud_list_leagues', { orgId: window._cloudWorkspaceId });
      } else if (msg.data.context === 'profile-share') {
        if (typeof showToast === 'function') showToast(msg.data.message || '', msg.data.result ? '#22c55e' : '#c53030', msg.data.result ? 2800 : 6000);
      } else if (msg.data.context === 'invite') {
        if (typeof showToast === 'function') showToast(msg.data.message || '', msg.data.result ? '#22c55e' : '#c53030', msg.data.result ? 2800 : 6000);
      } else if (msg.data.context === 'org-library') {
        if (typeof showToast === 'function') showToast(msg.data.message || '', msg.data.result ? '#22c55e' : '#c53030', msg.data.result ? 3000 : 6000);
        if (typeof renderOrgLibraryStatus === 'function') renderOrgLibraryStatus();
      } else if (msg.data.context === 'station') {
        if (typeof showToast === 'function') showToast(msg.data.message || '', msg.data.result ? '#22c55e' : '#c53030', msg.data.result ? 2600 : 6000);
      } else if (el('import-export-result')) {
        el('import-export-result').textContent = msg.data.message;
        el('import-export-result').style.color = msg.data.result ? 'green' : 'red';
      }
    } else if (msg.type === 'cloud-email-login') {
      // Email sign-in result — show it under the form (linkified: denials point at the
      // studio site to apply/sign) and toast it.
      const st = el('cloud-login-status');
      if (st) {
        st.style.display = '';
        st.style.color = msg.data.ok ? '#9ae6b4' : '#f87171';
        st.innerHTML = linkifyAuthMsg(msg.data.message || (msg.data.ok ? 'Signed in.' : 'Login failed.'));
      }
      showToast(msg.data.message || (msg.data.ok ? 'Signed in.' : 'Login failed.'), msg.data.ok ? '#22c55e' : '#c53030', msg.data.ok ? 3500 : 8000);
      if (msg.data.ok) { const p = el('cloud-login-pass'); if (p) p.value = ''; }
    } else if (msg.type === 'perm-denied') {
      const r = (msg.data && msg.data.role) || 'your seat role';
      showToast('Not allowed: ' + ((msg.data && msg.data.type) || 'action') + ' — ' + r + ' seats are ' + (r === 'operator' ? 'blocked from credential changes' : 'view-only') + '. Ask your org\'s producer/admin.', '#c53030', 6000);
    } else if (msg.type === 'competition_result') {
      if (typeof window.cmpOnResult === 'function') window.cmpOnResult(msg.data);
    } else if (msg.type === 'eventops-result') {
      if (typeof window.eventOpsResult === 'function') window.eventOpsResult(msg.data);
    } else if (msg.type === 'cloud_status') {
      applyCloudStatus(msg.data);
    } else if (msg.type === 'cloud_profiles') {
      renderCloudProfiles(msg.data);
    } else if (msg.type === 'cloud_profile_saved') {
      send('cloud_list_profiles');   // refresh the list after a push
    } else if (msg.type === 'cloud_invite_created') {
      renderInviteResult(msg.data);
    } else if (msg.type === 'cloud_org_seats') {
      renderOrgSeats(msg.data);
    } else if (msg.type === 'cloud_camera_feeds') {
      _pcamCloudFeedsCache = (msg.data && msg.data.ok && Array.isArray(msg.data.feeds)) ? msg.data.feeds : [];
      renderPlayerCamMounts();
    } else if (msg.type === 'cloud_station_feeds') {
      _cfStationsCache = (msg.data && msg.data.ok && Array.isArray(msg.data.feeds)) ? msg.data.feeds : [];
      renderCfStations();
    } else if (msg.type === 'cloud_stations') {
      window._cfStationsIndex = (msg.data && msg.data.ok && Array.isArray(msg.data.stations)) ? msg.data.stations : [];
      window._cfStationDetail = (msg.data && msg.data.ok && msg.data.detail) ? msg.data.detail : null;
      renderCfStations();
      // The Show Deck renders the bound station's rooms (monitor/invite/talkback) — refresh it.
      if (typeof window.renderTalentDeck === 'function' && typeof currentState !== 'undefined' && currentState) window.renderTalentDeck(currentState);
      // Website rooms are console tabs in the DCC Monitor — mount any that just appeared.
      if (typeof cfSyncDirectorConsoles === 'function') cfSyncDirectorConsoles();
    } else if (msg.type === 'cloud_stations_full') {
      if (typeof cfApplyStationsFull === 'function') cfApplyStationsFull(msg.data);
    } else if (msg.type === 'cloud_leagues') {
      if (typeof lgRenderCloudList === 'function') lgRenderCloudList((msg.data && msg.data.ok && Array.isArray(msg.data.leagues)) ? msg.data.leagues : []);
    } else if (msg.type === 'shift-result') {
      // Show Deck handover feedback. `uncredited` matters: a desk name with no matching Crew
      // record can't be credited, and silently dropping them is exactly how someone goes missing
      // from the end-of-stream credits.
      const d = msg.data || {};
      if (!d.ok) { showToast(d.message || 'Shift change failed.', '#fbbf24'); }
      else if (d.restored) { showToast('Previous shift restored to the desk.', '#22c55e'); }
      else {
        const bits = [];
        if ((d.moved || []).length) bits.push(d.moved.length + ' moved to off-air staff');
        if (d.seated) bits.push('desk loaded with "' + d.seated + '"');
        showToast(bits.length ? 'Shift handed over — ' + bits.join(', ') + '.' : 'Shift handed over.', '#22c55e');
        if ((d.uncredited || []).length) {
          showToast('Not on the credits screen (no Crew profile): ' + d.uncredited.join(', ') + ' — add them via + Add Crew.', '#fbbf24', 6000);
        }
      }
    } else if (msg.type === 'startgg-result') {
      ['startgg-result', 'sgg-status'].forEach((id) => {
        const r = el(id);
        if (r) { r.textContent = msg.data.message || ''; r.style.color = msg.data.ok ? '#9ae6b4' : '#f56565'; }
      });
    } else if (msg.type === 'startgg-team-result') {
      // Update status in both the dashboard stream queue panel and the schedule overlay panel
      const st = el('sgg-status');
      if (st) { st.textContent = msg.data.message || ''; st.style.color = msg.data.ok ? '#9ae6b4' : '#f56565'; }
      const gst = el('gfx-sch-team-status');
      if (gst) { gst.textContent = msg.data.message || ''; gst.style.color = msg.data.ok ? '#9ae6b4' : '#f56565'; }
      if (msg.data.ok) {
        const tq = (currentState && currentState.startgg && currentState.startgg.teamQueue) || [];
        // 1. Auto-populate the schedule graphics queue so the overlay updates immediately
        if (typeof window._schSetMatches === 'function' && tq.length) {
          window._schSetMatches(tq.map(q => ({ setId: q.setId || '', round: q.round || '', teamA: q.teamA || 'TBD', teamB: q.teamB || 'TBD', logoA: q.logoA || '', logoB: q.logoB || '', date: '', time: '', stream: !!q.live })));
        }
        // 2. Auto-push live match (or first upcoming) to scoreboard — confirmed if a series is running
        const pushSet = tq.find(q => q.live) || tq[0];
        if (pushSet && pushSet.setId) confirmQueuePush().then((ok) => { if (ok) send('startgg_push_set', { setId: pushSet.setId }); });
        // 3. Render dashboard team queue rows with per-match Push buttons
        const dashList = el('sgg-team-queue');
        if (dashList) {
          dashList.innerHTML = '';
          if (!tq.length) {
            dashList.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:4px 0;">No upcoming matches found.</div>';
          } else {
            tq.forEach((q) => {
              const row = document.createElement('div');
              row.className = 'sgg-row' + (q.live ? ' live' : '');
              row.innerHTML = `<span class="sgg-badge">${q.live ? 'LIVE' : 'NEXT'}</span><span class="sgg-match"><span class="sgg-team"><b></b></span><span class="sgg-vs">vs</span><span class="sgg-team"><b></b></span><span class="sgg-round"></span></span><button class="btn btn-secondary btn-sm sgg-push">Push</button>`;
              const bolds = row.querySelectorAll('.sgg-team b');
              if (bolds[0]) bolds[0].textContent = q.teamA || 'TBD';
              if (bolds[1]) bolds[1].textContent = q.teamB || 'TBD';
              row.querySelector('.sgg-round').textContent = q.round || '';
              row.querySelector('.sgg-push').addEventListener('click', async () => { if (await confirmQueuePush()) send('startgg_push_set', { setId: q.setId }); });
              dashList.appendChild(row);
            });
          }
        }
        // 4. Render schedule overlay panel team list
        const list = el('gfx-sch-team-list');
        const res = el('gfx-sch-team-results');
        if (list) list.innerHTML = tq.map(q => `<div class="gfx-sch-next-row">${q.live ? '<span class="gnr-live">LIVE</span>' : ''}<span class="gnr-round">${q.round || ''}</span><span class="gnr-teams">${q.teamA || 'TBD'} vs ${q.teamB || 'TBD'}</span></div>`).join('') || '<div style="color:var(--muted);font-size:11px;padding:4px 0;">No upcoming matches found.</div>';
        if (res) res.style.display = tq.length ? '' : 'none';
      }
    } else if (msg.type === 'challonge-result') {
      if (typeof window._handleChallongeResult === 'function') window._handleChallongeResult(msg.data);
    } else if (msg.type === 'challengermode-result') {
      if (typeof window._handleChallengermodeResult === 'function') window._handleChallengermodeResult(msg.data);
    } else if (msg.type === 'nxgen-result') {
      if (typeof window._handleNxgenResult === 'function') window._handleNxgenResult(msg.data);
    } else if (msg.type === 'faceit-result') {
      if (typeof window._handleFaceitResult === 'function') window._handleFaceitResult(msg.data);
    } else if (msg.type === 'ballchasing-result') {
      // Two independent result boxes can show this — the Settings panel's connection test, and a
      // specific league's Ballchasing tab (Enable/Upload/Refresh) — update whichever is present.
      if (typeof window._handleBallchasingResult === 'function') window._handleBallchasingResult(msg.data);
    } else if (msg.type === 'ballchasing-replayrename-started') {
      const status = el('ballchasing-replayrename-status');
      if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Scanning ' + (msg.data && msg.data.folder ? msg.data.folder : '') + '…'; }
    } else if (msg.type === 'ballchasing-replayrename-result') {
      if (typeof window._handleReplayRenameResult === 'function') window._handleReplayRenameResult(msg.data);
      if (typeof window._handleBallchasingLeagueResult === 'function') window._handleBallchasingLeagueResult(msg.data);
    } else if (msg.type === 'link-result') {
      const d = msg.data || {};
      const logEl = el('ev-sync-log');
      if (logEl) { logEl.textContent = d.message || ''; logEl.style.color = d.ok ? (d.linked ? '#86efac' : 'var(--muted)') : '#f87171'; }
    } else if (msg.type === 'flow_dry_run_result') {
      _showDryRunModal(msg.data);
    } else if (msg.type === 'obs-screenshot') {
      applyObsScreenshot(msg.data);
    } else if (msg.type === 'replay_armed') {
      // The overlay has a real frame of the armed clip — release the go-live hold and cut.
      if (typeof rpOnArmed === 'function') rpOnArmed((msg.data && msg.data.url) || '');
    } else if (msg.type === 'replay_preparing') {
      // Server is running a quick decode-friendly transcode before this clip actually goes to air
      // (only fires when it isn't already cached from a prior push) — let the producer know why
      // there's a brief pause instead of it looking stuck.
      // A format the browser source can't decode (OBS's default HEVC/MKV recording, say) is
      // converted once and cached — worth saying so, since on a long clip it's tens of seconds.
      showToast('Converting this clip for air — first push only…', '#fbbf24', 9000);
      // If a go-live is holding for this clip, wait for the conversion rather than cutting to black.
      if (typeof rpOnArmPreparing === 'function') rpOnArmPreparing();
    } else if (msg.type === 'brand-result') {
      if (msg.data && msg.data.message) showToast(msg.data.message, msg.data.ok ? '#22c55e' : '#f56565', msg.data.ok ? 3000 : 7000);
    } else if (msg.type === 'obs-virtualcam') {
      // Say WHY the live OBS preview has no feed instead of the generic "no virtual camera" path.
      if (msg.data && msg.data.ok === false) { const m = el('pv-obs-msg'); if (m) { m.textContent = 'OBS preview unavailable: ' + (msg.data.reason || 'virtual camera unavailable'); m.style.display = ''; } }
    } else if (msg.type === 'obs-result') {
      const color = msg.data.ok ? '#9ae6b4' : '#f56565';
      // Replay-buffer replies used to land only in Settings ▸ OBS, so a refused Start looked like
      // a dead button. Those are flagged toast:true server-side.
      if (msg.data.toast && msg.data.message) showToast(msg.data.message, msg.data.ok ? '#22c55e' : '#f56565', msg.data.ok ? 3000 : 8000);
      ['obs-result', 'replay-status'].forEach((id) => {
        const elx = el(id);
        if (elx) { elx.textContent = msg.data.message || ''; elx.style.color = color; }
      });
    } else if (msg.type === 'sheets-result') {
      const r = el('sheets-result');
      if (r) { r.textContent = msg.data.message || ''; r.style.color = msg.data.ok ? '#9ae6b4' : '#f56565'; }
      if (msg.data.notify && typeof showToast === 'function') showToast(msg.data.message || '', msg.data.ok ? '#22c55e' : '#f56565');
    } else if (msg.type === 'vmix-result') {
      const elx = el('vmix-result');
      if (elx) { elx.textContent = msg.data.message || ''; elx.style.color = msg.data.ok ? '#9ae6b4' : '#f56565'; }
    } else if (msg.type === 'autofollow-pushed') {
      showToast(msg.data.message || 'Auto-follow updated the match.', '#8b5cf6', 6000);
    } else if (msg.type === 'obs-ensure-result') {
      showToast(msg.data.message || (msg.data.ok ? 'Added to OBS.' : 'OBS error'), msg.data.ok ? '#22c55e' : '#c53030', 6000);
      // The BR overlay pack shows the outcome inline too — a toast disappears, and "did the
      // scene build work" is something a producer re-checks while setting up.
      const packSt = el('mlb-pack-status');
      if (packSt && packSt.textContent) {
        packSt.textContent = msg.data.message || '';
        packSt.style.color = msg.data.ok ? 'var(--good,#48bb78)' : 'var(--danger-2,#f56565)';
      }
    } else if (msg.type === 'obs-transition-info') {
      // The selected OBS transition, as OBS describes it. A stinger's own video is served back to
      // the player (see /api/obs/transition-stinger) so clip-to-clip runs the same sting.
      const d = msg.data || {};
      _rpObsTrans = {
        name: d.name || '', kind: d.kind || '', hasVideo: !!d.hasVideo, point: Number(d.point) || 0,
        lengthMs: Number(d.lengthMs) || 0, duration: Number(d.duration) || 0,
        // ?v= stamp busts the browser cache when the producer repoints the stinger in OBS.
        url: d.hasVideo ? ('http://127.0.0.1:3000/api/obs/transition-stinger?v=' + encodeURIComponent(d.stamp || '1')) : '',
        message: d.message || ''
      };
      // Show OBS's own numbers in the row instead of a made-up default — the producer set them there.
      const durIn = el('rp-pool-obstrans-dur');
      const obsMs = _rpObsTrans.lengthMs || _rpObsTrans.duration;
      if (durIn && obsMs && document.activeElement !== durIn) durIn.value = String(obsMs);
      rpRenderObsTransHint();
    } else if (msg.type === 'replay-source-scenes') {
      // Which OBS scenes actually hold the replay player (see obs_check_replay_source).
      _rpPlayerScenes = Array.isArray(msg.data && msg.data.scenes) ? msg.data.scenes : [];
      _rpPlayerChecked = !!(msg.data && msg.data.ok);
      _rpPlayerCheckErr = (msg.data && msg.data.message) || '';
      const _sel = el('rp-program-scene'); if (_sel) _sel.dataset.sig = '';   // re-mark the ✓ ready options
      if (currentState && currentState.obs) syncReplayProgramScene(currentState.obs);
      rpRenderPlayoutReady();
    } else if (msg.type === 'draft-result' && !msg.data.ok) {
      showToast(msg.data.message || 'Draft error', '#c53030', 5000);
    } else if (msg.type === 'twitch_auth_invalid') {
      // Server halted EventSub/chat/stream-poll because the OAuth token expired
      // (implicit grant = no refresh). Without this toast the producer is silently
      // logged out mid-show and only notices when alerts/stats stop.
      showToast('Twitch session expired — reconnect it under Apps > Twitch to resume alerts, chat and stream stats.', '#c53030', 12000);
      const tw = el('twitch-test-result');
      if (tw) { tw.textContent = 'Token expired — sign in with Twitch again to reconnect.'; tw.style.color = '#f56565'; }
    } else if (msg.type === 'rl-scene-result') {
      const st = el('rl-scene-auto-status');
      if (st) {
        st.textContent = msg.data.message || '';
        st.style.color = msg.data.ok ? '#9ae6b4' : '#f56565';
      }
      // Actionable failures (wrong scene name, OBS off, no scene picked) go to the bell so they're
      // not missed with the Match ▸ Teams gear panel closed — this is where "it silently broke" hid.
      if (msg.data.notify && msg.data.message && typeof addNotification === 'function') {
        try { addNotification(msg.data.message, '#f56565', { title: 'RL scene automation' }); } catch (_) {}
      }
    } else if (msg.type === 'bracket-progress') {
      // Phase-by-phase feedback during a big import (RLCS-scale events run for minutes). Written
      // to every status line the producer might be watching; total 0 means finished/idle.
      const p = msg.data || {};
      const line = p.total ? `Importing bracket — phase ${p.done}/${p.total}${p.phase ? ': ' + p.phase : ''}…` : '';
      [el('bracket-status'), el('ev-load-status'), el('ev-status')].forEach((s) => {
        if (!s) return;
        if (line) { s.textContent = line; s.style.color = 'var(--muted)'; s.dataset.bkProgress = '1'; }
        else if (s.dataset.bkProgress) { delete s.dataset.bkProgress; }   // leave the final result in place
      });
    } else if (msg.type === 'custom-overlay' || msg.type === 'custom-overlay-saved') {
      if (window.__ovb) window.__ovb.onMsg(msg.type, msg.data || {});
    } else if (msg.type === 'desk-cam-link') {
      const d = msg.data || {};
      if (!d.ok) showToast(d.error || 'No camera link for that seat yet.', '#fbbf24', 5000);
      else if (window._tdCamWant === 'watch') { if (d.viewUrl) window.open(d.viewUrl, '_blank', 'noopener,width=960,height=560'); }
      else {
        const done = () => showToast('Copied. Send it to ' + (d.name || 'them') + ': it opens their camera and mic straight into desk seat ' + d.slot + '.', '#22c55e', 6000);
        try { navigator.clipboard.writeText(d.joinUrl).then(done, () => { customPrompt('Camera link', 'Copy this link', d.joinUrl, 'Close'); }); }
        catch (er) { customPrompt('Camera link', 'Copy this link', d.joinUrl, 'Close'); }
      }
    } else if (msg.type === 'site-event-result') {
      if (window.__siteEvents) window.__siteEvents.onResult(msg.data || {});
    } else if (msg.type === 'site-event-action-result') {
      if (window.__siteEvents && window.__siteEvents.onAction) window.__siteEvents.onAction(msg.data || {});
    } else if (msg.type === 'bracket-result' || msg.type === 'event-result') {
      const resultEl = el('bracket-status');
      if (resultEl) {
        resultEl.textContent = msg.data.message || '';
        resultEl.style.color = msg.data.ok ? '#9ae6b4' : '#f56565';
      }
      // Surface the same message on the Events + Teams status lines if present.
      [el('ev-status'), el('teams-startgg-status'), el('lg-status')].forEach((s) => {
        if (s) { s.textContent = msg.data.message || ''; s.style.color = msg.data.ok ? 'var(--good,#48bb78)' : '#f56565'; }
      });
      // A league was just created from start.gg → adopt the broadcasted list and open it (the
      // leagues view guards against clobbering in-progress edits, so force the refresh here).
      if (msg.data.ok && msg.data.leagueId && typeof lgRender === 'function') {
        if (Array.isArray(currentState.leagues)) lgLeagues = currentState.leagues;
        lgActiveId = msg.data.leagueId;
        const slugInp = el('lg-startgg-slug'); if (slugInp) slugInp.value = '';
        lgRender();
      }
      // Dashboard "Load Event" flow: show a picker, success, or error inline.
      // `pending` is the server's immediate ack — the import is running, not finished. It only
      // disarms the watchdog and swaps the status line to "working"; the real result follows.
      if (_evLoadTimer) { clearTimeout(_evLoadTimer); _evLoadTimer = null; }
      if (typeof evLoadStatus === 'function') {
        evLoadStatus(msg.data.message || '', msg.data.pending ? '' : (msg.data.ok ? '#9ae6b4' : '#f56565'));
      }
      if (msg.data.pending) return;   // don't touch the pickers yet — nothing has resolved
      if (msg.data.needsEventPick) {
        // Render the picker BOTH on the Dashboard and inline in the Brackets tab, so it's visible
        // wherever you started the load — no tab-hop required.
        if (typeof renderSggEventPicker === 'function') renderSggEventPicker(msg.data);
        if (typeof renderBracketEventPicker === 'function') renderBracketEventPicker(msg.data);
      } else {
        const picker = el('dash-sgg-event-picker'); if (picker) picker.style.display = 'none';
        const bkPicker = el('bracket-event-picker');
        if (bkPicker) {
          if (!msg.data.ok && msg.data.message) {
            // Surface the exact start.gg error inline so it's impossible to miss.
            bkPicker.innerHTML = `<div class="bk-ev-hdr" style="color:#f56565;">Couldn't load this link</div><div style="font-size:12px;color:var(--text);">${(msg.data.message || '').replace(/</g, '&lt;')}</div>`;
            bkPicker.style.display = 'block';
          } else {
            bkPicker.style.display = 'none'; bkPicker.innerHTML = '';
          }
        }
      }
    } else if (msg.type === 'liquipedia-result') {
      const r = el('liquipedia-result');
      if (r) {
        r.textContent = msg.data.message || '';
        r.style.color = msg.data.ok ? '#9ae6b4' : '#f56565';
        // Mark as fresh so a state broadcast's lastError doesn't immediately overwrite the reply.
        r.dataset.fresh = '1';
        setTimeout(() => { delete r.dataset.fresh; }, 6000);
      }
    } else if (msg.type === 'riot-result') {
      const r = el('riot-result');
      if (r) {
        r.textContent = msg.data.message || '';
        r.style.color = msg.data.ok ? '#9ae6b4' : '#f56565';
        // Mark fresh so the next state broadcast's lastError doesn't wipe the reply.
        r.dataset.fresh = '1';
        setTimeout(() => { delete r.dataset.fresh; }, 8000);
      }
    } else if (msg.type === 'dota-result') {
      const r = el('dota-result');
      if (r) { r.textContent = msg.data.message || ''; r.style.color = msg.data.ok ? '#9ae6b4' : '#f56565'; }
    } else if (msg.type === 'csgo-result') {
      const resultEl = el('csgo-result');
      if (resultEl) {
        resultEl.textContent = msg.data.message || '';
        resultEl.style.color = msg.data.ok ? '#9ae6b4' : '#f56565';
      }
      // CS2 was already open: options only apply when Steam starts it, so offer the restart.
      if (msg.data.running) {
        customConfirm('Restart CS2 for observing?', 'CS2 is open. It has to start again for the observer view to apply. Close CS2 now and start it again? Anything unsaved in CS2 is lost.', 'Restart CS2')
          .then((ok) => { if (ok) { if (resultEl) { resultEl.textContent = 'Closing CS2...'; resultEl.style.color = ''; } send('csgo_launch_observer', { restart: true }); } });
      }
    } else if (msg.type === 'questions_pull_result') {
      // Discord backlog pull finished (server → the panel that asked).
      const fb = el('q-settings-fb');
      if (fb) { fb.textContent = msg.data.text || ''; fb.style.color = msg.data.ok ? '#4ade80' : '#f87171'; }
      if (!msg.data.ok) showToast(msg.data.text || 'Discord pull failed.', '#7b2020', 8000);
      const btn = el('q-pull-btn'); if (btn) btn.disabled = false;
    } else if (msg.type === 'csgo-cinematic-result') {
      const m = el('csgo-cinematic-msg');
      if (m) { m.textContent = (msg.data && msg.data.message) || ''; m.style.color = msg.data && msg.data.ok ? '#9ae6b4' : '#f56565'; }
    } else if (msg.type === 'csgo_update') {
      const conn = el('csgo-conn');
      if (conn) {
        conn.textContent = msg.data && msg.data.connected ? 'CS2: connected' : 'CS2: waiting';
        conn.className = 'prod-chip' + (msg.data && msg.data.connected ? ' ok' : '');
      }
      if (msg.data) renderCsgoCinematic(msg.data);
    } else if (msg.type === 'resource_warning') {
      showToast(`High resource usage — CPU ${msg.data.cpu}% · RAM ${msg.data.ramMb} MB`, '#c53030', 30000);
    } else if (msg.type === 'crash_alert') {
      showToast(`App error: ${msg.data.message}`, '#7b2020', 0);
    } else if (msg.type === 'update_status') {
      if (typeof renderUpdateStatus === 'function') renderUpdateStatus(msg.data);
      if (msg.data && msg.data.state === 'downloaded') showToast(`Update v${msg.data.version} ready — install it in Settings → Software Updates.`, '#7c3aed', 0);
    } else if (msg.type === 'twitch_chat_message') {
      addChatMessage(msg.data.username, msg.data.message, msg.data.color || '', 'twitch');
    } else if (msg.type === 'youtube_chat_message') {
      addChatMessage(msg.data.username, msg.data.message, msg.data.color || '', 'youtube');
    } else if (msg.type === 'kick_chat_message') {
      addChatMessage(msg.data.username, msg.data.message, msg.data.color || '', 'kick');
    } else if (msg.type === 'discord_chat_message') {
      addChatMessage(msg.data.username, msg.data.message, msg.data.color || '', 'discord');
    } else if (msg.type === 'chat_log') {
      // One-shot backfill after (re)connect — seeds the multichat feed with recent history.
      (msg.data && msg.data.messages || []).forEach((m) => addChatMessage(m.user, m.text, m.color || '', m.platform || 'twitch'));
    } else if (msg.type === 'twitch_chat_connected') {
      const st = el('chat-connection-status');
      const ld = el('chat-loading');
      if (st) { st.style.display = 'inline'; st.innerHTML = '<span class="live-dot" style="background:#4ade80"></span> #' + (msg.data?.channel || 'connected'); }
      if (ld) ld.style.display = 'none';
    } else if (msg.type === 'twitch_chat_disconnected') {
      const st = el('chat-connection-status');
      const ld = el('chat-loading');
      if (st) st.style.display = 'none';
      if (ld) { ld.style.display = 'inline'; ld.textContent = 'Disconnected'; }
    } else if (msg.type === 'twitch_follow') {
      addActivityItem('follow', msg.data.user, 'Followed the channel', svgIcon('userplus'));
    } else if (msg.type === 'twitch_subscribe') {
      const sd = msg.data;
      let subDetail;
      if (sd.gift) subDetail = `Gifted Tier ${sd.tier || 1} to ${sd.recipient || 'someone'}`;
      else if (sd.resub) subDetail = `Resubscribed · ${sd.months}mo · Tier ${sd.tier || 1}`;
      else subDetail = `Subscribed · Tier ${sd.tier || 1}`;
      addActivityItem('subscribe', sd.user, subDetail, svgIcon('star'));
    } else if (msg.type === 'twitch_raid') {
      addActivityItem('raid', msg.data.from, `Raided with ${msg.data.viewers} viewers`, svgIcon('users'));
    } else if (msg.type === 'twitch_channel_points') {
      addActivityItem('channel_points', msg.data.user, `Redeemed: ${msg.data.reward}`, svgIcon('gem'));
    } else if (msg.type === 'twitch_hype_train_begin') {
      addActivityItem('hype_train', 'Hype Train', 'Started!', svgIcon('train'));
    } else if (msg.type === 'twitch_hype_train_progress') {
      addActivityItem('hype_train', 'Hype Train', `Level ${msg.data.level}`, svgIcon('trending'));
    } else if (msg.type === 'twitch_hype_train_end') {
      addActivityItem('hype_train', 'Hype Train', `Ended at level ${msg.data.level}`, svgIcon('flag'));
    } else if (msg.type === 'twitch_poll_update') {
      if (currentState) { if (!currentState.twitch) currentState.twitch = {}; if (!currentState.twitch.poll) currentState.twitch.poll = {}; currentState.twitch.poll.current = msg.data; }
      renderProdPolls();
    } else if (msg.type === 'twitch_poll_end') {
      if (currentState) { if (!currentState.twitch) currentState.twitch = {}; if (!currentState.twitch.poll) currentState.twitch.poll = {}; currentState.twitch.poll.current = msg.data; }
      renderProdPolls();
      addActivityItem('poll', 'Poll ended', msg.data && msg.data.title ? '"' + msg.data.title.slice(0,32) + '"' : '', svgIcon('star'));
    } else if (msg.type === 'twitch_ad_break') {
      const ab = msg.data || {};
      if (currentState) { if (!currentState.twitch) currentState.twitch = {}; currentState.twitch.adBreak = { active: true, duration: ab.duration, startedAt: ab.startedAt, endsAt: ab.endsAt, isAutomatic: ab.isAutomatic }; }
      renderProdAdBreak();
      // top-bar chip shows the live ad break with countdown
      _adState.adBreak = true; _adState.adBreakEndsAt = ab.endsAt ? new Date(ab.endsAt).getTime() : 0; renderAdChip();
      addActivityItem('ad_break', 'Ad Break', `${ab.duration || '?'}s ${ab.isAutomatic ? '(automatic)' : '(manual)'}`, svgIcon('film'));
    } else if (msg.type === 'twitch_ad_break_end') {
      if (currentState && currentState.twitch) currentState.twitch.adBreak = { active: false, duration: 0, startedAt: null, endsAt: null, isAutomatic: false };
      renderProdAdBreak();
      _adState.adBreak = false; _adState.adBreakEndsAt = 0; renderAdChip();
    } else if (msg.type === 'twitch_activity') {
      if (renderProdCredits._log) renderProdCredits._log.push(msg.data);
      renderProdCredits();
    } else if (msg.type === 'twitch_activity_log_cleared') {
      renderProdCredits([]);
    }
  };

  ws.onclose = () => {
    setStatus(false);
    clearInterval(_hbTimer);
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();
}

// Game-data section switching lives in games-hub.js (picker + standard tabs).
wireApexSetup();
wireApexScoring();

// League in-game HUD — teamfight transition mode (full | auto | minimal).
document.querySelectorAll('#lol-hud-mode .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    document.querySelectorAll('#lol-hud-mode .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    send('lol_hud_mode', { mode });
  });
});

// Twitch OAuth Configuration
const TWITCH_CLIENT_ID = 't4vpvwcxaxk4vil453fmf3kuahbs5e';

// In Electron app, always use localhost (broadcast app server)
const OAUTH_BASE_URL = 'http://127.0.0.1:3000';
const TWITCH_REDIRECT_URI = `${OAUTH_BASE_URL}/api/oauth/twitch/callback`;

const TWITCH_SCOPES = [
  // Channel management
  'channel:manage:broadcast',       // update stream title, game, tags
  'channel:manage:polls',           // create & end polls
  'channel:manage:predictions',     // create, resolve, cancel predictions
  'channel:manage:redemptions',     // manage channel point rewards
  'channel:manage:raids',           // trigger raids to other channels
  'channel:manage:moderators',      // add/remove moderators
  'channel:manage:vips',            // add/remove VIPs
  'channel:manage:ads',             // snooze/trigger mid-roll ads
  'channel:manage:schedule',        // manage stream schedule
  // Channel reading
  'channel:read:subscriptions',     // subscriber list & events
  'channel:read:stream_key',        // stream key
  'channel:read:polls',             // poll results
  'channel:read:predictions',       // prediction results
  'channel:read:redemptions',       // channel point redemption queue
  'channel:read:hype_train',        // hype train progress & events
  'channel:read:goals',             // creator goals
  'channel:read:ads',               // ad schedule & snooze info
  'channel:read:editors',           // editors list
  // Clips
  'clips:edit',                     // create & edit clips
  // Moderation
  'moderator:read:followers',       // follower count & list (modern API)
  'moderator:manage:announcements', // post announcements to chat
  'moderator:manage:banned_users',  // ban/unban/timeout users
  'moderator:manage:chat_messages', // delete chat messages
  'moderator:manage:chat_settings', // slow/sub-only/emote-only/R9K mode
  'moderator:manage:shoutouts',     // send shoutouts via API
  'moderator:manage:shield_mode',   // activate/deactivate shield mode
  'moderator:read:chatters',        // who is currently in chat
  'moderator:read:shield_mode',     // read shield mode status
  // Chat (IRC + new Chat API)
  'chat:edit',                      // send messages via IRC
  'chat:read',                      // read messages via IRC
  'user:write:chat',                // send messages via new Chat API
  // Bits & economy
  'bits:read',                      // bits events & leaderboard
];

// "Continue with Twitch". The server builds the authorize URL (code flow with a refresh token when
// signed in to the cloud, implicit otherwise) and its callback page finishes the sign-in on its own
// — it applies the token and broadcasts state — so all the panel has to do is open Twitch's page
// somewhere that isn't blocked. In the app that's a managed login window from the main process
// (window.open of a blank popup is denied by the control panel's window-open handler, which is why
// this button used to do nothing); in a plain browser, a normal popup.
let _twitchLoginWatch = null;
el('btn-twitch-login')?.addEventListener('click', async () => {
  const btn = el('btn-twitch-login');
  const label = btn ? btn.textContent : '';
  const legacyUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=token`
    + `&scope=${TWITCH_SCOPES.join('%20')}&state=temp-${Math.random().toString(36).slice(2, 9)}&force_verify=true`;
  const inApp = !!(window.electronAPI && window.electronAPI.openTwitchOAuth);
  // Outside Electron a popup must open synchronously inside the click or the browser blocks it.
  const popup = inApp ? null : window.open('about:blank', 'twitch_oauth', 'width=600,height=760');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening Twitch…'; }
  let authUrl = legacyUrl;
  try {
    const r = await fetch(`${OAUTH_BASE_URL}/api/oauth/twitch/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: TWITCH_SCOPES })
    });
    const d = await r.json();
    if (d && d.authUrl) authUrl = d.authUrl;
  } catch (err) {
    console.warn('[OAuth] Init failed, using the legacy implicit URL:', err.message);
  }
  let opened = false;
  try {
    if (inApp) opened = await window.electronAPI.openTwitchOAuth(authUrl);
    else if (popup) { popup.location = authUrl; opened = true; }
  } catch (err) { console.error('[OAuth] Could not open the Twitch login window:', err); }
  if (btn) { btn.disabled = false; btn.textContent = label; }
  if (!opened) {
    showToast('Could not open the Twitch login window. Try again, or restart the app if this keeps happening.', '#c53030', 7000);
    return;
  }
  showToast('Finish signing in to Twitch in the window that just opened.', '#9146ff', 5000);
  // The panel flips to "connected" on its own when the server broadcasts; this just confirms it.
  clearInterval(_twitchLoginWatch);
  const startedAt = Date.now();
  _twitchLoginWatch = setInterval(() => {
    if (currentState && currentState.twitch && currentState.twitch.connected) {
      clearInterval(_twitchLoginWatch);
      showToast('Twitch connected.', '#22c55e', 4000);
    } else if (Date.now() - startedAt > 10 * 60 * 1000) {
      clearInterval(_twitchLoginWatch);
    }
  }, 1000);
});

el('btn-twitch-token-manual')?.addEventListener('click', async () => {
  const token = await customPrompt('Twitch token', 'Paste your Twitch OAuth token. You can get one at twitchtokengenerator.com with the Channel Points scopes.', '', 'Save token');
  if (!token) return;

  fetch('http://127.0.0.1:3000/api/twitch/set-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiToken: token })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) {
      showToast('Error: ' + data.error, '#ef4444');
    } else {
      showToast('Token saved! Reconnecting...', '#22c55e');
      send('request_state');
    }
  })
  .catch(e => showToast(friendlyError(e), '#ef4444'));
});

el('btn-twitch-test')?.addEventListener('click', () => {
  const resultEl = el('twitch-test-result');
  const btn = el('btn-twitch-test');
  if (!btn || !resultEl) return;
  btn.disabled = true;
  btn.textContent = 'Testing…';
  resultEl.style.display = 'none';
  fetch('http://127.0.0.1:3000/api/twitch/test')
    .then(r => r.json())
    .then(data => {
      resultEl.style.display = 'block';
      if (data.ok) {
        resultEl.style.background = 'rgba(74,222,128,0.1)';
        resultEl.style.color = '#4ade80';
        resultEl.style.border = '1px solid rgba(74,222,128,0.3)';
        resultEl.textContent = `✓ Token valid — ${data.displayName} · expires in ${data.expiresIn} · scopes: ${(data.scopes || []).length}`;
      } else {
        resultEl.style.background = 'rgba(239,68,68,0.1)';
        resultEl.style.color = '#f87171';
        resultEl.style.border = '1px solid rgba(239,68,68,0.3)';
        resultEl.textContent = `✗ ${data.error || 'Connection failed'}`;
      }
    })
    .catch(() => {
      resultEl.style.display = 'block';
      resultEl.style.background = 'rgba(239,68,68,0.1)';
      resultEl.style.color = '#f87171';
      resultEl.style.border = '1px solid rgba(239,68,68,0.3)';
      resultEl.textContent = '✗ Could not reach server';
    })
    .finally(() => { btn.disabled = false; btn.textContent = 'Test Connection'; });
});

el('btn-twitch-logout')?.addEventListener('click', async () => {
  const ok = await appConfirm('Disconnect Twitch? Chat, predictions, and EventSub alerts stop working immediately — reconnecting mid-broadcast means re-authorizing from scratch.', 'Disconnect');
  if (!ok) return;
  fetch('http://127.0.0.1:3000/api/twitch/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  .then(r => r.json())
  .then(data => {
    send('request_state');
  })
  .catch(e => console.error('Error disconnecting:', e.message));
});

function parseMmss(str) {
  str = (str || '').trim();
  if (!str) return 300;
  if (str.includes(':')) {
    const [m, s] = str.split(':').map(Number);
    return ((isNaN(m) ? 0 : m) * 60) + (isNaN(s) ? 0 : s);
  }
  const n = parseInt(str, 10);
  return isNaN(n) ? 300 : n;
}

function formatMmss(totalSecs) {
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

el('btn-create-prediction')?.addEventListener('click', () => {
  const title    = (el('pred-title')?.value    || '').trim();
  const outcome1 = (el('pred-outcome1')?.value || '').trim();
  const outcome2 = (el('pred-outcome2')?.value || '').trim();
  const duration = parseMmss(el('pred-duration')?.value);

  if (!title)    { el('pred-title')?.focus();    return; }
  if (!outcome1) { el('pred-outcome1')?.focus(); return; }
  if (!outcome2) { el('pred-outcome2')?.focus(); return; }

  const btn = el('btn-create-prediction');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Creating…';

  fetch('http://127.0.0.1:3000/api/twitch/prediction/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, outcomes: [outcome1, outcome2], duration })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) {
      btn.textContent = '✗ ' + data.error;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
    } else {
      btn.textContent = '✓ Created!';
      if (el('pred-title'))    el('pred-title').value    = '';
      if (el('pred-outcome1')) el('pred-outcome1').value = '';
      if (el('pred-outcome2')) el('pred-outcome2').value = '';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
  })
  .catch(e => {
    btn.textContent = '✗ ' + e.message;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
  });
});
