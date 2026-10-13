// Control panel, part 4 of 17: Applying server state; team dropdowns, searchable picker, series editor.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Apply full state from server ──────────────────────────────────────────
function applyState(data) {
  // The server keeps live broadcasts tiny by OMITTING big control-panel-only blobs
  // (savedTeams, brandKits — base64 logos — and the static draftChampions list); it only
  // ships them on connect and when they change. Backfill them from cache so the rest of the
  // UI always sees a complete state. Mutating `data` in place also feeds the render functions
  // that run after applyState() in the message handler.
  if (data && currentState) {
    for (const k of ['savedTeams', 'playerProfiles', 'brandKits', 'brandKitsVer', 'draftRosters', 'brand', 'banner', 'mainBanner', 'playouts', 'bracket', 'replay', 'crew', 'leagues', 'clips', 'eventOps', 'myEvents', 'questions', 'questionSources', 'cloudCompetitions', 'gameConfigVersions']) {
      if (data[k] === undefined && currentState[k] !== undefined) data[k] = currentState[k];
    }
  }
  // Don't let a state payload that omits colorMode (older server / partial state) reset the
  // selected colour mode back to 'team'.
  if (data && data.colorMode == null && currentState && currentState.colorMode) data.colorMode = currentState.colorMode;
  currentState = data;

  // Collections the render path iterates without checking. A payload that carries one of these as
  // an object instead of an array (corrupted state.json, a partial or legacy payload, a bad sync)
  // made every renderer that touches it throw — 7 of them, measured. Coerce once, here, and say so
  // in the console rather than failing silently panel by panel.
  //
  // ONLY genuine arrays belong in this list. `questions` ({ list, settings }) and `playerProfiles`
  // (a map keyed by gamertag) are objects BY DESIGN on the server, so listing them here fired the
  // coercion on every single state apply and blanked them: Object.keys(playerProfiles) went empty
  // and questions.list went undefined, which silently killed the profile registry across
  // seeding/spotlight/team-editor/match and left the Q&A mailbag permanently empty. Worse, both
  // keys are in the backfill list above, so the [] was then carried forward onto every later
  // payload for the rest of the session.
  if (data) {
    ['savedTeams', 'crew', 'players', 'leagues', 'myEvents', 'facecams', 'presets',
     'brandKits'].forEach((k) => {
      if (data[k] != null && !Array.isArray(data[k])) {
        console.warn('[applyState] ' + k + ' arrived as ' + (typeof data[k]) + ', expected an array — coerced to []');
        data[k] = [];
      }
    });
    // The two keyed objects get the same protection in the shape they actually have: an ARRAY here
    // is the corrupt case, and would break `questions.list` / `playerProfiles[tag]` the same way.
    ['questions', 'playerProfiles'].forEach((k) => {
      if (data[k] != null && (Array.isArray(data[k]) || typeof data[k] !== 'object')) {
        console.warn('[applyState] ' + k + ' arrived as ' + (Array.isArray(data[k]) ? 'an array' : typeof data[k]) + ', expected an object — coerced to {}');
        data[k] = {};
      }
    });
  }

  // Event name
  const evEl = el('input-event');
  if (evEl && document.activeElement !== evEl) evEl.value = data.eventName || '';
  // Each secondary panel is isolated: a throw in one (e.g. AI page, talent rail, customize bar)
  // must not abort applyState and blank the teams/scores/game panels that render below it.
  const _ap = (label, fn) => { try { fn(); } catch (e) { console.error('[applyState:' + label + ']', e); } };
  // Talent / listen-in indicator
  if (typeof cfUpdateListenPill === 'function') _ap('cfUpdateListenPill', () => cfUpdateListenPill(data));
  // Scenes tab — light up ON AIR pills
  if (typeof refreshSceneOnAir === 'function') _ap('refreshSceneOnAir', () => refreshSceneOnAir(data));
  // Battle-royale series panel (Fortnite/PUBG/Warzone scoring + standings preview)
  if (typeof renderBrPanel === 'function') _ap('renderBrPanel', () => renderBrPanel(data));
  // Match — Lobby: swaps the blue/orange team cards for the BR field table on lobby games, and
  // (critically) swaps them BACK on every other game. Isolated like the rest — a throw here must
  // not blank the panels below it.
  if (typeof brLobbyApply === 'function') _ap('brLobbyApply', () => brLobbyApply(data));
  // Graphics rail: reveal the Battle Royale scene group only while a BR game is active.
  if (typeof window.gfxSyncBrNav === 'function') _ap('gfxSyncBrNav', () => window.gfxSyncBrNav(data));
  // Graphics rail + Match — Teams gear: the RL-only Series Stats controls.
  if (typeof window.gfxSyncSeriesStats === 'function') _ap('gfxSyncSeriesStats', () => window.gfxSyncSeriesStats(data));
  // Fortnite drop-map POI editor (Settings ▸ Games ▸ Fortnite) — season-editable landing spots.
  if (typeof brPoiApply === 'function') _ap('brPoiApply', () => brPoiApply(data));
  // ESPORTS sub-nav — show/hide the platform-import tab as credentials come and go
  if (typeof evSyncPlatformTab === 'function') _ap('evSyncPlatformTab', () => evSyncPlatformTab());
  // Live-data panels (R6 relay / Bedwars server push) — connection dots + readouts
  if (typeof renderLiveDataPanels === 'function') _ap('renderLiveDataPanels', () => renderLiveDataPanels(data));
  // AI page — shield + quick toggles
  if (typeof renderAiPage === 'function') _ap('renderAiPage', () => renderAiPage(data));
  // Talent/VDO surfaces read a cached /api/vdo/links — re-pull it when teams/sides/casters change.
  if (typeof cfMaybeRefreshTalent === 'function') _ap('cfMaybeRefreshTalent', () => cfMaybeRefreshTalent(data));
  // Social preset — hydrate controls when brand changes (bgImage / presentedBy), or the state-level
  // fallback used when no brand kit is active.
  // Crew page — re-render when crew list changes
  if (data.crew && typeof renderCrewList === 'function' && el('talent-panel-crew') && el('talent-panel-crew').style.display !== 'none') _ap('renderCrewList', () => renderCrewList());
  // Sync slot label inputs whenever casters state arrives
  if (data.casters && data.casters.slotLabels) {
    const sl = data.casters.slotLabels;
    [1, 2, 3, 4].forEach((i) => {
      const inp = el(`dcc-slot-lbl-${i}`);
      if (inp && document.activeElement !== inp) inp.value = sl[i] || `Caster ${i}`;
      // also keep cdlg-slot options current
      const opt = document.querySelector(`#cdlg-slot [data-slot-opt="${i}"]`);
      if (opt) opt.textContent = sl[i] || `Caster ${i}`;
    });
  }
  if (data.casters) {
    if (typeof window.renderTalentDeck === 'function') _ap('renderTalentDeck', () => window.renderTalentDeck(data));
    const nmCb = el('crew-name-gamertag');
    if (nmCb && document.activeElement !== nmCb) nmCb.checked = (data.casters.nameMode || 'gamertag') === 'gamertag';
    [el('dcc-show-country'), el('crew-show-country')].forEach((scc) => {
      if (scc && document.activeElement !== scc) scc.checked = !!data.casters.showCountry;
    });
    if (typeof tdOptSync === 'function') tdOptSync();
  }
  // DCC database sections — re-render when visible (any non-monitor tab is open)
  if ((data.showRoster || data.crew || data.teams || data.casters) && typeof renderDccAll === 'function' && el('dcc-database-view') && el('dcc-database-view').style.display !== 'none') {
    _ap('renderDccAll', () => renderDccAll());
  }
  // Update monitor status dot on any state change that might affect rooms
  _ap('_dccUpdateMonDot', () => { if ((data.casters || data.teams) && typeof window._dccUpdateMonDot === 'function') window._dccUpdateMonDot(); });
  // DCC Teams pane — re-render when savedTeams or active teams change
  if ((data.savedTeams || data.teams) && typeof renderDccTeamsPane === 'function' && el('dcc-teams-list')) {
    _ap('renderDccTeamsPane', () => renderDccTeamsPane());
  }
  // DCC Hosts grid — re-render when caster library changes
  if (data.casters && typeof renderDccHostsGrid === 'function' && el('dcc-db-hosts') && el('dcc-db-hosts').style.display !== 'none') {
    _ap('renderDccHostsGrid', () => renderDccHostsGrid());
  }
  // Keep the open Customize panel current as OBS scenes / overlay live-states change.
  if (_bbCzOpen && typeof bbRenderCustomizeList === 'function') _ap('bbRenderCustomizeList', () => bbRenderCustomizeList());
  if (typeof renderAdSched === 'function') _ap('renderAdSched', () => renderAdSched(data));
  if (typeof renderRdAddTarget === 'function') _ap('renderRdAddTarget', () => renderRdAddTarget());
  if (typeof renderRundown === 'function') _ap('renderRundown', () => renderRundown());
  if (typeof renderFlows === 'function' && !_flowDraft) _ap('renderFlows', () => renderFlows());
  if (typeof flowGameWatch === 'function') _ap('flowGameWatch', () => flowGameWatch(data));
  if (typeof renderProdShow === 'function') _ap('renderProdShow', () => renderProdShow());
  if (typeof renderQrailLive === 'function') _ap('renderQrailLive', () => renderQrailLive());
  if (typeof evLiveRefreshOpen === 'function') _ap('evLiveRefreshOpen', () => evLiveRefreshOpen());
  if (typeof renderSpotlight === 'function') _ap('renderSpotlight', () => {
    const sp = el('ev-spotlight-panel'), front = el('gfx-front-spotlight');
    _ap('renderSpotlight', () => { if ((sp && sp.offsetParent !== null) || (front && front.offsetParent !== null)) renderSpotlight(); });
  });
  // Keep the Quick Map Pool front panel current if maps get picked elsewhere (e.g. the Guided
  // Veto tab in the same scene's Settings pop-out) while the front panel itself stays visible.
  if (typeof window._gfxSyncVetoFront === 'function') _ap('mpSyncFromState-front', () => {
    const front = el('gfx-front-veto'); if (front && front.offsetParent !== null) window._gfxSyncVetoFront(data);
  });

  // Overtime ad slot
  const ot = data.overtime || {};
  const otl = el('input-ot-label');
  if (otl && document.activeElement !== otl) otl.value = ot.label ?? 'OVERTIME';
  const otBg = el('input-ot-bg'); if (otBg) otBg.value = ot.bg || '#e0202a';
  const otCol = el('input-ot-color'); if (otCol) otCol.value = ot.color || '#ffffff';
  const otPrev = el('preview-ot-logo');
  if (otPrev) { otPrev.src = ot.logo || ''; otPrev.style.display = ot.logo ? 'block' : 'none'; }
  const dfSel = el('select-date-format');
  if (dfSel && document.activeElement !== dfSel) dfSel.value = data.dateFormat === 'intl' ? 'intl' : 'us';
  const suSel = el('select-speed-unit');
  if (suSel && document.activeElement !== suSel) suSel.value = (data.speedUnit === 'kmh') ? 'kmh' : 'mph';

  // Replay ad slot
  const rp = data.replay || {};
  const rpl = el('input-replay-label');
  if (rpl && document.activeElement !== rpl) rpl.value = rp.label ?? 'REPLAY';
  const rpColor = el('select-replay-color');
  if (rpColor && document.activeElement !== rpColor) rpColor.value = rp.colorMode || 'team';
  const rpPrev = el('preview-replay-logo');
  if (rpPrev) { rpPrev.src = rp.logo || ''; rpPrev.style.display = rp.logo ? 'block' : 'none'; }
  const rpOutroPrev = el('preview-replay-outro');
  if (rpOutroPrev) { rpOutroPrev.src = rp.outroLogo || ''; rpOutroPrev.style.display = rp.outroLogo ? 'block' : 'none'; }
  const rpSkinPrev = el('preview-replay-skin');
  if (rpSkinPrev) { rpSkinPrev.src = rp.skin || ''; rpSkinPrev.style.display = rp.skin ? 'block' : 'none'; }

  // Scoreboard ad slot
  const sbad = data.scoreboardAd || {};
  const sbadl = el('input-sbad-label');
  if (sbadl && document.activeElement !== sbadl) sbadl.value = sbad.label ?? 'PRESENTED BY';
  const sbadPrev = el('preview-sbad-logo');
  if (sbadPrev) { sbadPrev.src = sbad.logo || ''; sbadPrev.style.display = sbad.logo ? 'block' : 'none'; }
  const sbadBgPrev = el('preview-sbad-bg');
  if (sbadBgPrev) { sbadBgPrev.src = sbad.background || ''; sbadBgPrev.style.display = sbad.background ? 'block' : 'none'; }

  // Teams
  const teams = data.teams || {};
  _ap('syncTeamCard', () => { syncTeamCard('blue',   teams.blue); });
  _ap('syncTeamCard', () => { syncTeamCard('orange', teams.orange); });
  try {
    _ap('syncTeamSideSelects', () => { if (typeof syncTeamSideSelects === 'function') syncTeamSideSelects(teams); });
    _ap('renderGraphicsBoard', () => { if (typeof renderGraphicsBoard === 'function') renderGraphicsBoard(); });
  } catch (_) {}

  _ap('renderVetoManager', () => { renderVetoManager(data); });
  _ap('renderDraftManager', () => { renderDraftManager(data); });
  _ap('renderOwBanManager', () => { renderOwBanManager(data); });
  _ap('renderMrBanManager', () => { renderMrBanManager(data); });
  _ap('renderMatchPlayers', () => { renderMatchPlayers('blue',   teams.blue && teams.blue.players); });
  _ap('renderMatchPlayers', () => { renderMatchPlayers('orange', teams.orange && teams.orange.players); });
  _ap('syncTeamsAlign', () => { if (typeof syncTeamsAlign === 'function') syncTeamsAlign(); });
  _ap('renderSeriesPanel', () => { renderSeriesPanel(data.match, teams); });
  _ap('_gfxRefreshSeriesControls', () => { if (typeof window._gfxRefreshSeriesControls === 'function') window._gfxRefreshSeriesControls(data); });
  _ap('_gfxRefreshVetoSeriesLink', () => { if (typeof window._gfxRefreshVetoSeriesLink === 'function') window._gfxRefreshVetoSeriesLink(data); });
  _ap('_gfxRefreshPopoutSummary', () => { if (typeof window._gfxRefreshPopoutSummary === 'function') window._gfxRefreshPopoutSummary(); });
  _ap('_gfxRefreshMatchupPickers', () => { if (typeof window._gfxRefreshMatchupPickers === 'function') window._gfxRefreshMatchupPickers(data); });
  _ap('_gfxRefreshWinnerPicker', () => { if (typeof window._gfxRefreshWinnerPicker === 'function') window._gfxRefreshWinnerPicker(data); });
  _ap('_gfxRefreshStandingsLeagues', () => { if (typeof window._gfxRefreshStandingsLeagues === 'function') window._gfxRefreshStandingsLeagues(data); });
  _ap('_gfxRefreshStandingsBracketPhases', () => { if (typeof window._gfxRefreshStandingsBracketPhases === 'function') window._gfxRefreshStandingsBracketPhases(data); });
  _ap('_gfxRefreshBracketLeagues', () => { if (typeof window._gfxRefreshBracketLeagues === 'function') window._gfxRefreshBracketLeagues(data); });
  _ap('_gfxRefreshBracketOrgStatus', () => { if (typeof window._gfxRefreshBracketOrgStatus === 'function') window._gfxRefreshBracketOrgStatus(data); });
  _ap('_gfxRefreshScheduleQueue', () => { if (typeof window._gfxRefreshScheduleQueue === 'function') window._gfxRefreshScheduleQueue(data); });
  _ap('_gcRefresh', () => { if (typeof window._gcRefresh === 'function') window._gcRefresh(data); });
  _ap('_promoRefresh', () => { if (typeof window._promoRefresh === 'function') window._promoRefresh(data); });
  _ap('updateFacecamTeamHeaders', () => { updateFacecamTeamHeaders(teams, data); });
  _ap('applyCommercialState', () => { if (typeof applyCommercialState === 'function') applyCommercialState(data); });
  _ap('lgHydrate', () => { if (typeof lgHydrate === 'function') lgHydrate(data.leagues); });
  _ap('cmpApplyState', () => { if (typeof window.evLeagueRender === 'function') window.evLeagueRender(false); if (typeof window.cmpApplyState === 'function') window.cmpApplyState(); if (typeof lgUpdateGoLive === 'function') lgUpdateGoLive(); });
  _ap('lgRenderCaptureBar', () => { if (typeof lgRenderCaptureBar === 'function') lgRenderCaptureBar(); });   // live spectated-capture status
  _ap('renderMyEvents', () => { if (typeof renderMyEvents === 'function') renderMyEvents(); });
  // Reflect central team-library changes (new/renamed teams, logos) in the open leagues view.
  if (typeof lgRenderMatchup === 'function') {
    const _lp = el('ev-leagues-panel');
    _ap('lgRenderMatchup', () => { if (_lp && _lp.style.display !== 'none' && !_lp.contains(document.activeElement) && lgActive()) lgRenderMatchup(); });
  }

  // Confirm an "Auto-fill from stream" once the resulting teams arrive.
  if (_autofillPending) {
    _autofillPending = false;
    const stEl = el('autofill-stream-status');
    if (stEl) {
      const err = data.startgg && data.startgg.lastError;
      if (err && /stream|queue|match/i.test(err)) { stEl.textContent = err; stEl.className = 'ev-status ev-err'; }
      else {
        const rosters = (teams.blue?.players?.length || 0) + (teams.orange?.players?.length || 0);
        stEl.textContent = `Filled from stream: ${teams.blue?.name || '?'} vs ${teams.orange?.name || '?'}`
          + (rosters ? ` — ${rosters} players loaded for facecams.` : '.');
        stEl.className = 'ev-status ev-ok';
      }
    }
  }

  // Series (Caster Desk scorecard)
  _ap('syncSeriesDeskUI', () => { syncSeriesDeskUI(data); });

  // Multi-game side labels (Blue/Orange → CT/T, A/B, …) + team-colour headers
  _ap('relabelTeamSides', () => { relabelTeamSides(data); });
  // Re-apply actual team names after relabelTeamSides so the trigger sidebar shows real names.
  _ap('syncTeamSideSelects', () => { if (typeof syncTeamSideSelects === 'function') syncTeamSideSelects(teams); });

  // Colour mode (Team / Brand / Game) — reflect the active segment + lock the pickers.
  // The server computes the effective side colours; the client just mirrors the mode.
  _ap('renderColorMode', () => { if (typeof renderColorMode === 'function') renderColorMode(); });

  // Camera count: limit facecam modes to the active game's roster size
  _ap('syncFacecamModeOptions', () => { syncFacecamModeOptions(); });

  // Saved teams dropdowns + list (picker = saved library + seeded start.gg event teams)
  _ap('populateSavedTeamsDropdowns', () => { populateSavedTeamsDropdowns(); });
  _ap('renderTeamsList', () => { renderTeamsList(data.savedTeams || []); });
  // The vault itself isn't in state (too big to broadcast) — `ver` is the change signal. Only
  // re-fetch while its tab is actually on screen; an event import bumps this once per entrant.
  if (data.teamVault && el('teams-panel-vault') && el('teams-panel-vault').style.display !== 'none') {
    _ap('tvRenderAuto', () => { tvRenderAuto(data); });   // sweep progress ticks without re-fetching the whole record list
    _ap('tvFetch', () => { if (data.teamVault.ver !== _tvVer) tvFetch(true); });
  }
  _ap('renderOrgLibraryStatus', () => { if (typeof renderOrgLibraryStatus === 'function' && el('org-library-block') && el('org-library-block').style.display !== 'none') renderOrgLibraryStatus(); });

  // start.gg event teams (transient — inside Import modal). Isolated: these render straight from
  // imported entrant names, the least trustworthy strings in the whole state.
  _ap('renderStartggTeams', () => renderStartggTeams(data.startgg?.eventTeams || [], data.startgg?.selectedEvent || null));
  // Event teams panel — all platforms, visible on Teams page
  _ap('renderEventTeamsPanel', () => renderEventTeamsPanel(data));

  // Unified active event card
  const ae = data.activeEvent;
  const activeCard = el('dash-active-event');
  if (activeCard) {
    if (ae && ae.platform && ae.name) {
      const nameEl = el('ev-active-name');
      const metaEl = el('ev-active-meta');
      const badge = el('ev-active-plat-badge');
      if (nameEl) nameEl.textContent = ae.name;
      if (metaEl) metaEl.textContent = [ae.gameName, ae.numEntrants ? `${ae.numEntrants} teams` : '', ae.format].filter(Boolean).join(' · ');
      if (badge) { badge.textContent = ae.platform === 'startgg' ? 'start.gg' : ae.platform === 'challonge' ? 'Challonge' : ae.platform === 'nxgen' ? 'NXGEN' : ae.platform === 'faceit' ? 'FACEIT' : ae.platform; badge.dataset.plat = ae.platform; }
      activeCard.style.display = 'flex';
      // Sync platform tab to active event's platform — once per newly-active event, not on every
      // broadcast (that pulled the producer off whichever tab they had open, every state tick).
      const aeKey = ae.platform + '|' + ae.name;
      const aeChanged = aeKey !== window._evLastActiveKey;
      window._evLastActiveKey = aeKey;
      if (aeChanged && ae.platform !== _evActivePlatform) {
        const tab = document.querySelector(`.ev-plat-tab[data-plat="${ae.platform}"]`);
        if (tab) tab.click();
      }
    } else {
      activeCard.style.display = 'none';
    }
  }
  // Challonge dashboard queue visibility
  const chalQBlock   = el('ev-challonge-queue-block');
  const nxgenQBlock  = el('ev-nxgen-queue-block');
  const faceitQBlock = el('ev-faceit-queue-block');
  const cmQBlock     = el('ev-cm-queue-block');
  const sggQBlock    = el('ev-queue-block');
  const isChalActive   = ae && ae.platform === 'challonge';
  const isNxgenActive  = ae && ae.platform === 'nxgen';
  const isFaceitActive = ae && ae.platform === 'faceit';
  const isCmActive     = ae && ae.platform === 'challengermode';
  if (chalQBlock)   chalQBlock.style.display   = isChalActive ? '' : 'none';
  if (nxgenQBlock)  nxgenQBlock.style.display  = isNxgenActive ? '' : 'none';
  if (faceitQBlock) faceitQBlock.style.display = isFaceitActive ? '' : 'none';
  if (cmQBlock)     cmQBlock.style.display     = isCmActive ? '' : 'none';
  // The start.gg queue is the DEFAULT block, so every other platform has to be excluded here or
  // two queues show at once.
  if (sggQBlock)    sggQBlock.style.display    = (isChalActive || isNxgenActive || isFaceitActive || isCmActive) ? 'none' : '';
  _ap('renderDashChallongeQueue', () => { if (isChalActive)   renderDashChallongeQueue(data.challonge?.queue || [], data.challonge?.queueFetchedAt); });
  _ap('renderDashNxgenQueue', () => { if (isNxgenActive)  renderDashNxgenQueue(data.nxgen?.queue || [], data.nxgen?.queueFetchedAt); });
  _ap('renderDashFaceitQueue', () => { if (isFaceitActive) renderDashFaceitQueue(data.faceit?.queue || [], data.faceit?.queueFetchedAt); });
  _ap('renderDashChallengermodeQueue', () => { if (isCmActive) renderDashChallengermodeQueue(data.challengermode?.queue || [], data.challengermode?.queueFetchedAt); });
  // Auto-follow toggles
  const chalAF  = el('challonge-autofollow');
  if (chalAF) chalAF.checked = !!data.challonge?.autoFollow;
  const nxgenAF = el('nxgen-autofollow');
  if (nxgenAF) nxgenAF.checked = !!data.nxgen?.autoFollow;
  const faceitAF = el('faceit-autofollow');
  if (faceitAF) faceitAF.checked = !!data.faceit?.autoFollow;
  const cmAF = el('cm-autofollow-queue');
  if (cmAF && document.activeElement !== cmAF) cmAF.checked = !!data.challengermode?.autoFollow;
  // token badge
  _ap('updateEvTokenBadge', () => { updateEvTokenBadge(); });

  _ap('syncFacecamRows', () => { syncFacecamRows(data.players || [], data.facecams || [], true); });
  _ap('renderSavedFacecams', () => { renderSavedFacecams(data.facecams || []); });

  // RL status (legacy top-bar element — kept null-safe; new pills via renderCockpitStatus)
  const rlStatusEl = el('rl-status');
  if (rlStatusEl) rlStatusEl.textContent = data.rlConnected ? 'RL: Connected' : 'RL: Disconnected';

  // Facecams enabled (Settings + the mirrored Camera Feeds toggle)
  const cbFacecams = el('check-facecams-enabled');
  if (cbFacecams) cbFacecams.checked = data.facecamsEnabled !== false;
  const cbFacecamsCf = el('cf-facecams-enabled');
  if (cbFacecamsCf) cbFacecamsCf.checked = data.facecamsEnabled !== false;
  const cbReplayCams = el('check-replay-cams');
  if (cbReplayCams) cbReplayCams.checked = data.replayCams !== false;

  const facecamsWarning = el('facecams-disabled-warning');
  if (facecamsWarning) {
    facecamsWarning.style.display = (data.facecamsEnabled === false) ? 'flex' : 'none';
  }
  // Player-cam mapping only matters if facecams are actually on — hide the whole section
  // rather than showing controls for a feature that's currently switched off.
  const mspPlayerCams = el('msp-playercams');
  if (mspPlayerCams) mspPlayerCams.style.display = (data.facecamsEnabled === false) ? 'none' : '';

  // Font family
  if (data.fontFamily) {
    const fontSelect = el('select-font');
    if (fontSelect && document.activeElement !== fontSelect) {
      let exists = false;
      for (let i = 0; i < fontSelect.options.length; i++) {
        if (fontSelect.options[i].value === data.fontFamily) { exists = true; break; }
      }
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = data.fontFamily;
        opt.textContent = data.fontFamily;
        fontSelect.appendChild(opt);
      }
      fontSelect.value = data.fontFamily;
      _ap('applyFontPreview', () => { applyFontPreview(data.fontFamily); });
    }
  }
  _ap('syncSettingsFromState', () => { syncSettingsFromState(); });

  // Main Banner (global fallback — uses data.mainBanner, not the kit-aware data.banner)
  const mainBanner = data.mainBanner || data.banner;
  if (mainBanner) {
    const cbVisible = el('check-banner-visible');
    if (cbVisible && document.activeElement !== cbVisible) cbVisible.checked = !!mainBanner.visible;

    const intervalInput = el('input-banner-interval');
    if (intervalInput && document.activeElement !== intervalInput) {
      intervalInput.value = mainBanner.interval || 10;
    }

    const slantSel = el('select-banner-slant');
    if (slantSel && document.activeElement !== slantSel) slantSel.value = mainBanner.slant || 'right';

    const headerInput = el('input-banner-header');
    if (headerInput && document.activeElement !== headerInput) headerInput.value = mainBanner.header || '';

    const imagesList = el('banner-images-list');
    // Only skip the rebuild while a caption INPUT is being typed — not when a delete button is
    // focused (that would block the post-delete re-render and make deletes look like they fail).
    const ae = document.activeElement;
    const typingCaption = ae && ae.tagName === 'INPUT' && imagesList && imagesList.contains(ae);
    if (imagesList && !typingCaption) {
      imagesList.innerHTML = '';
      const own = Array.isArray(mainBanner.images) ? mainBanner.images : [];   // not _ap-wrapped: a throw here blanks every panel below
      own.forEach((src, idx) => {
        const item = document.createElement('div');
        item.style = 'position: relative; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; align-items: center; gap: 10px; transition: transform 0.2s, background 0.2s;';
        
        item.onmouseenter = () => { item.style.background = 'rgba(0,0,0,0.5)'; item.style.borderColor = 'rgba(255,255,255,0.3)'; };
        item.onmouseleave = () => { item.style.background = 'rgba(0,0,0,0.3)'; item.style.borderColor = 'rgba(255,255,255,0.1)'; };

        const img = document.createElement('img');
        img.src = src;
        img.style = 'height: 60px; width: 100%; object-fit: contain; border-radius: 4px;';

        const cap = document.createElement('input');
        cap.type = 'text'; cap.className = 'input-text';
        cap.placeholder = 'Optional text — e.g. USE CODE *PROMO*';
        cap.title = 'Text shown beside this banner. Wrap a word in *asterisks* for italic; use new lines for multiple lines.';
        cap.style = 'width: 100%; padding: 5px 8px; font-size: 11px;';
        cap.value = (mainBanner.captions && mainBanner.captions[idx]) || '';
        if (document.activeElement !== cap) cap.value = (mainBanner.captions && mainBanner.captions[idx]) || '';
        cap.addEventListener('change', () => send('set_banner_caption', { index: idx, text: cap.value }));
        cap.addEventListener('keydown', (e) => { if (e.key === 'Enter') cap.blur(); });

        const btn = document.createElement('button');
        btn.className = 'btn btn-danger btn-sm';
        btn.style = 'width: 100%; padding: 4px; font-size: 12px; margin-top: auto; display: flex; align-items: center; justify-content: center; gap: 4px; border-radius: 4px; cursor: pointer; border: none; font-weight: 600; color: white; background: #c53030;';
        btn.innerHTML = 'Remove';
        btn.onmouseenter = () => { btn.style.background = '#e53e3e'; };
        btn.onmouseleave = () => { btn.style.background = '#c53030'; };
        btn.addEventListener('click', async () => {
          if (!await customConfirm('Remove image', 'Remove this banner image? The uploaded file is deleted.', 'Remove')) return;
          send('remove_banner_image', { index: idx });
        });

        item.appendChild(img);
        item.appendChild(cap);
        item.appendChild(btn);
        imagesList.appendChild(item);
      });
    }
  }
  // Live-scene panels. Isolated one by one, like the secondary panels above: these are the
  // controls a producer drives ON AIR, and they must not be collateral damage when an unrelated
  // renderer above throws on a single bad name in an 800-entrant import. (That is not
  // hypothetical — a lone-surrogate team name in teePlaceholder() aborted applyState() here on
  // every broadcast, so the bracket panel showed no phases while the data sat in state.)
  // Production tab (casters + break)
  _ap('applyProductionState', () => applyProductionState(data));

  // Ticker
  _ap('applyTickerState', () => applyTickerState(data));

  // Player spotlight + live status
  _ap('applySpotlightState', () => applySpotlightState(data));
  _ap('applyProdStatus', () => applyProdStatus(data));

  // Bracket
  _ap('applyBracketState', () => applyBracketState(data));

  // Upcoming + Standings overlays
  _ap('applyUpcomingState', () => applyUpcomingState(data));
  _ap('applyStandingsState', () => applyStandingsState(data));

  // Game / design / presets / custom overlays
  _ap('applyGameDesignState', () => { applyGameDesignState(data); });
  _ap('renderPresets', () => { renderPresets(data.presets); });
  _ap('renderCustomOverlayManager', () => { renderCustomOverlayManager(data); });
  _ap('renderBrands', () => { renderBrands(data); });
  _ap('renderDashBrandKit', () => { renderDashBrandKit(data); });
  _ap('renderCasterDeskSponsors', () => { renderCasterDeskSponsors(data); });
  _ap('renderPreshowGfxPanel', () => { renderPreshowGfxPanel(data); });
  _ap('renderAdSponsorPickers', () => { renderAdSponsorPickers(data); });
  _ap('applyCsgoState', () => { applyCsgoState(data); });
  _ap('applyValorantState', () => { applyValorantState(data); });
  _ap('applyLolState', () => { applyLolState(data); });
  _ap('applyApexState', () => { applyApexState(data); });

  // OBS settings
  _ap('applyObsState', () => { applyObsState(data); });
  _ap('applyLiquipediaState', () => { if (typeof applyLiquipediaState === 'function') applyLiquipediaState(data); });
  _ap('applyRiotState', () => { if (typeof applyRiotState === 'function') applyRiotState(data); });
  _ap('applyVmixState', () => { if (typeof applyVmixState === 'function') applyVmixState(data); });

  // Background overlay
  _ap('_bgApplyState', () => { if (typeof window._bgApplyState === 'function') window._bgApplyState(data); });

  // Version
  if (data.version) {
    const verEl = el('app-version');
    if (verEl) verEl.textContent = data.version;
  }

  // Start.gg settings
  const startgg = data.startgg || {};
  const cbStartgg = el('check-startgg-enabled');
  if (cbStartgg) cbStartgg.checked = !!startgg.enabled;

  const tournamentEl = el('input-startgg-tournament');
  if (tournamentEl && document.activeElement !== tournamentEl) tournamentEl.value = startgg.tournamentSlug || '';

  const eventEl = el('input-startgg-event');
  if (eventEl && document.activeElement !== eventEl) eventEl.value = startgg.eventSlug || '';

  const setIdEl = el('input-startgg-setid');
  if (setIdEl && document.activeElement !== setIdEl) setIdEl.value = startgg.setId || '';

  const tokenEl = el('input-startgg-token');
  const tokenIndicator = el('startgg-token-indicator');
  const tokenChangeBtn = el('btn-startgg-change-token');
  const tokenDisconnectBtn = el('btn-startgg-disconnect');
  if (tokenEl && !tokenEl._lockListenerAdded) {
    tokenEl._lockListenerAdded = true;
    // Nothing extra needed — Change button handles unlock
  }
  if (tokenEl) {
    if (startgg.hasToken && !tokenEl.value) {
      // Token is saved — lock the field
      tokenEl.readOnly = true;
      tokenEl.value = '';
      tokenEl.placeholder = '••••••••••••••••••••';
      tokenEl.style.opacity = '0.5';
      tokenEl.style.cursor = 'default';
      if (tokenChangeBtn) tokenChangeBtn.style.display = '';
      if (tokenDisconnectBtn) tokenDisconnectBtn.style.display = '';
      if (tokenIndicator) {
        tokenIndicator.style.display = 'block';
        if (startgg.connected) {
          tokenIndicator.textContent = '✓ Connected';
          tokenIndicator.style.background = 'rgba(74, 222, 128, 0.2)';
          tokenIndicator.style.borderColor = '#4ade80';
          tokenIndicator.style.color = '#86efac';
        } else {
          tokenIndicator.textContent = '✓ Saved';
          tokenIndicator.style.background = 'rgba(107, 114, 128, 0.2)';
          tokenIndicator.style.borderColor = 'rgba(107,114,128,0.5)';
          tokenIndicator.style.color = '#d1d5db';
        }
      }
    } else if (!startgg.hasToken) {
      // No token — show empty unlocked field
      tokenEl.readOnly = false;
      tokenEl.style.opacity = '';
      tokenEl.style.cursor = '';
      if (tokenChangeBtn) tokenChangeBtn.style.display = 'none';
      if (tokenDisconnectBtn) tokenDisconnectBtn.style.display = 'none';
      if (tokenIndicator) tokenIndicator.style.display = 'none';
      tokenEl.placeholder = 'Paste your start.gg API token';
    }
    // If user is actively editing (tokenEl.value has content), leave field as-is
  }

  const startggResult = el('startgg-result');
  if (startggResult) {
    if (startgg.lastError) {
      startggResult.textContent = `Last error: ${startgg.lastError}`;
      startggResult.style.color = '#f56565';
    } else if (startgg.lastSyncAt) {
      startggResult.textContent = `Last sync: ${new Date(startgg.lastSyncAt).toLocaleString()}`;
      startggResult.style.color = '#9ae6b4';
    } else {
      startggResult.textContent = '';
    }
  }

  // Update start.gg status in header
  const startggStatusEl = el('startgg-status');
  if (startggStatusEl) {
    if (startgg.enabled && startgg.hasToken) {
      startggStatusEl.style.display = 'flex';
      const icon = startggStatusEl.querySelector('.status-icon');
      if (icon) {
        icon.classList.toggle('connected', startgg.connected);
      }
    } else {
      startggStatusEl.style.display = 'none';
    }
  }

  _ap('renderStreamQueue', () => { renderStreamQueue(data); });

  // Challonge settings
  _ap('renderChallongeSettings', () => { if (typeof renderChallongeSettings === 'function') renderChallongeSettings(data); });
  // Challengermode settings (a different platform from Challonge — see the module header).
  // Wrapped in _ap like every other renderer: one throw in applyState() silently blanks every
  // panel below it (see [[applystate-abort-class]]).
  _ap('renderChallengermodeSettings', () => { if (typeof renderChallengermodeSettings === 'function') renderChallengermodeSettings(data); });
  // NXGEN settings
  _ap('renderNxgenSettings', () => { if (typeof renderNxgenSettings === 'function') renderNxgenSettings(data); });
  _ap('renderFaceitSettings', () => { if (typeof renderFaceitSettings === 'function') renderFaceitSettings(data); });
  // Ballchasing settings
  _ap('renderBallchasingSettings', () => { if (typeof renderBallchasingSettings === 'function') renderBallchasingSettings(data); });
  // Marble Race launcher status
  _ap('renderMarbleRaceStatus', () => { if (typeof renderMarbleRaceStatus === 'function') renderMarbleRaceStatus(data.marbleRace); });
}

function getStartggPayload() {
  const tokenInput = el('input-startgg-token');
  const token = tokenInput ? tokenInput.value.trim() : '';
  const payload = {
    enabled: !!el('check-startgg-enabled')?.checked,
    tournamentSlug: el('input-startgg-tournament')?.value.trim() || '',
    eventSlug: el('input-startgg-event')?.value.trim() || '',
    setId: el('input-startgg-setid')?.value.trim() || ''
  };
  // Only include apiToken if it's non-empty (empty means "keep current token")
  if (token) {
    payload.apiToken = token;
  }
  return payload;
}

// Readable text on a team-coloured chip. The panel paints a team's colour behind white label
// text in several places; a white kit made every one of them read white-on-white (the team card
// headers looked simply empty). Chosen by CONTRAST RATIO, not brightness: flip to near-black only
// when white would fall under ~3:1, so ordinary team colours keep the white they always had and
// only genuinely pale ones switch. Mirrors the overlay rule in overlay/fgc/fgc-adapter.js.
function teamInk(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (1.05 / (L + 0.05)) < 3 ? '#0b0e17' : '#fff';
}

// Relabel the two team "sides" per the active game (RL Blue/Orange, CS2 CT/T, …)
// and tint the card headers + series labels with each team's own colour.
function relabelTeamSides(data) {
  const g = (data.games && data.games[data.activeGame]) || null;
  const labels = (g && g.teamLabels) || { a: 'Blue', b: 'Orange' };
  const teams = data.teams || {};
  const blueColor = (teams.blue && teams.blue.color) || '#055fdb';
  const orangeColor = (teams.orange && teams.orange.color) || '#e97139';
  const setHdr = (id, label, color) => {
    const e = el(id); if (!e) return;
    e.textContent = (label || '').toUpperCase();
    e.style.background = color;
    e.style.color = teamInk(color);
  };
  setHdr('team-header-blue', labels.a, blueColor);
  setHdr('team-header-orange', labels.b, orangeColor);
  const sb = el('series-label-blue-desk'); if (sb) sb.textContent = (labels.a || 'A').toUpperCase();
  const so = el('series-label-orange-desk'); if (so) so.textContent = (labels.b || 'B').toUpperCase();
  // Apply buttons: label + tint to the team's own colour (not hardcoded blue/orange)
  const ab = el('btn-apply-blue');
  if (ab) { ab.textContent = `Apply ${labels.a}`; ab.style.background = blueColor; ab.style.borderColor = blueColor; ab.style.color = teamInk(blueColor); }
  const ao = el('btn-apply-orange');
  if (ao) { ao.textContent = `Apply ${labels.b}`; ao.style.background = orangeColor; ao.style.borderColor = orangeColor; ao.style.color = teamInk(orangeColor); }
  // Cockpit side selectors (Winner / Line-up) follow the same labels.
  [el('ck-winner-side'), el('ck-intro-side')].forEach((sel) => {
    if (!sel || sel.options.length < 2) return;
    sel.options[0].textContent = labels.a + ' team';
    sel.options[1].textContent = labels.b + ' team';
  });
}

let _lastSyncedTeamName = { blue: undefined, orange: undefined };
// Set only by the logo controls (upload / media library / Default): marks a crest the producer
// actually changed on a side, so Apply and Save can tell the server to make it the team's crest in
// the library and vault. Every other path that fills pendingLogo* is just reading a stored crest.
let _logoDirty = { blue: false, orange: false };
function syncTeamCard(side, teamData) {
  if (!teamData) return;
  const nameEl  = el(`input-name-${side}`);
  const logoImg = el(`preview-logo-${side}`);
  const colorEl = el(`input-color-${side}`);
  if (nameEl && document.activeElement !== nameEl) nameEl.value = teamData.name || '';
  // Abbreviation mirrors the live side too (server resolves blank -> library tag), unless the
  // producer is mid-edit in the field.
  const abbrEl = el(`input-abbr-${side}`);
  if (abbrEl && document.activeElement !== abbrEl) abbrEl.value = teamData.abbr || '';
  if (colorEl && document.activeElement !== colorEl) {
    const displayColor = teamData.ownColor || teamData.color;
    if (displayColor) colorEl.value = displayColor;
  }
  // Logo preview: on a genuine team switch follow server state and reset the pending
  // override; on routine broadcasts (score/clock) keep the user's in-progress logo so an
  // uploaded-but-not-yet-applied logo isn't wiped between upload and Apply.
  const nameChanged = _lastSyncedTeamName[side] !== (teamData.name || '');
  _lastSyncedTeamName[side] = teamData.name || '';
  if (nameChanged) {
    if (side === 'blue') pendingLogoBlue = teamData.logo; else pendingLogoOrange = teamData.logo;
    _logoDirty[side] = false;   // a different team is on this side - the edit was for the last one
    if (logoImg) setSideLogo(side, teamData.logo);
  } else if (logoImg) {
    const pending = side === 'blue' ? pendingLogoBlue : pendingLogoOrange;
    setSideLogo(side, pending != null ? pending : teamData.logo);
  }
}

// ── Saved teams dropdowns ─────────────────────────────────────────────────
// Every team the Match picker can choose: saved library + seeded start.gg event teams,
// deduped by name (saved wins). Used for the dropdown, the type-to-search datalist, and badges.
function allMatchTeams() {
  const saved = (currentState.savedTeams || []).map(t => ({ name: t.name, logo: t.logo, color: t.color || null, abbr: t.abbr || '', players: t.players || [], source: 'saved' }));
  const seen = new Set(saved.map(t => (t.name || '').toLowerCase()));
  const event = ((currentState.startgg && currentState.startgg.eventTeams) || [])
    .filter(t => t && t.name && !seen.has(t.name.toLowerCase()))
    .map(t => ({ name: t.name, logo: t.logo, color: t.color || null, abbr: t.abbr || '', players: t.players || [], source: 'event' }));
  return saved.concat(event).sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
}
function findTeam(name) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  return allMatchTeams().find(t => (t.name || '').toLowerCase() === n) || null;
}
// TBD / TBA is a first-class PLACEHOLDER, not a team: it never has to exist in the library, and
// applying it wipes the side clean (no inherited logo, roster or colour from whoever was there).
// Producers type it constantly while a bracket is still resolving.
function isTbdName(name) { return /^(tbd|tba)$/i.test((name || '').trim()); }

let _savedTeamsSig = null;
function populateSavedTeamsDropdowns() {
  const teams = allMatchTeams();
  // Rebuilding two selects + the datalist for every saved/event team on EVERY state broadcast was
  // one of the heaviest parts of applyState (~40ms each with a big library). Only rebuild when the
  // list itself changed; the badges and stream-queue picker below still refresh every time.
  const sig = teams.map(t => t.name + '|' + t.source).join('\n');
  if (sig === _savedTeamsSig && el('select-saved-blue') && el('select-saved-blue').options.length > 1) {
    updateTeamSavedBadge('blue');
    updateTeamSavedBadge('orange');
    if (typeof refreshSggTeamPicker === 'function') refreshSggTeamPicker();
    return;
  }
  _savedTeamsSig = sig;
  ['blue', 'orange'].forEach(side => {
    const sel = el(`select-saved-${side}`);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Manual —</option>';
    teams.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name.toUpperCase() + (t.source === 'event' ? '  · event' : '');
      sel.appendChild(opt);
    });
    sel.value = cur;
  });
  // Type-to-search source for the Name fields (native combobox — handles hundreds of teams).
  const dl = el('saved-teams-datalist');
  if (dl) {
    dl.innerHTML = '';
    teams.forEach(t => { const o = document.createElement('option'); o.value = t.name; dl.appendChild(o); });
  }
  updateTeamSavedBadge('blue');
  updateTeamSavedBadge('orange');
  // Keep the Stream Queue team picker in sync (no-op unless the team list actually changed).
  if (typeof refreshSggTeamPicker === 'function') refreshSggTeamPicker();
}

// Common player roles per game (dropdown options). Games without a fixed role set fall back
// to a free-text field. A "Custom…" entry lets producers type anything not listed.
const ROLES_BY_GAME = {
  valorant:        ['Duelist', 'Initiator', 'Controller', 'Sentinel', 'Flex', 'IGL'],
  overwatch:       ['Tank', 'DPS', 'Support', 'Flex'],
  league:          ['Top', 'Jungle', 'Mid', 'Bot (ADC)', 'Support'],
  dota2:           ['Carry', 'Mid', 'Offlane', 'Soft Support', 'Hard Support'],
  csgo:            ['IGL', 'Entry', 'AWPer', 'Lurker', 'Support', 'Rifler'],
  rainbow6:        ['Entry', 'Support', 'Flex', 'Anchor', 'IGL'],
  'rocket-league': ['Striker', 'Midfield', 'Defender', 'Flex'],
  'marvel-rivals': ['Vanguard', 'Duelist', 'Strategist', 'Flex'],
  'mobile-legends':['Gold', 'EXP', 'Mid', 'Jungle', 'Roam'],
  'honor-of-kings':['Clear', 'Mid', 'Farm', 'Roam', 'Support'],
  cod:             ['Slayer', 'Objective', 'Anchor', 'Flex', 'IGL'],
  'the-finals':    ['Light', 'Medium', 'Heavy', 'Flex']
};
// Official role icons (white SVGs in assets/<game>/roles/). Same table as SceneBase.roleIcon in
// overlay/scene-base.js — keep the two in step. Games/roles without an icon return ''.
const ROLE_ICONS_BY_GAME = {
  overwatch: { tank: 'tank', dps: 'damage', damage: 'damage', support: 'support' }
};
function roleIconUrl(game, role) {
  // A producer-uploaded icon (Game Settings > Custom content > Roles) wins over the bundled one.
  const cfg = ((typeof currentState !== 'undefined' && currentState.gameConfigs) || {})[game];
  const own = cfg && cfg.roleIcons && cfg.roleIcons[String(role || '').trim().toLowerCase()];
  if (own) return own;
  const file = (ROLE_ICONS_BY_GAME[game] || {})[String(role || '').trim().toLowerCase()];
  return file ? 'http://localhost:3000/assets/' + game + '/roles/' + file + '.svg' : '';
}
// Extends (never replaces) the built-in role list with any roles added via an active Game Config
// for this game (currentState.gameConfigs, keyed by gameId) — dedupe-append, same "extend the
// built-in baseline" spirit as the server-side map/character merges.
function rolesForActiveGame() {
  const built = ROLES_BY_GAME[currentState.activeGame] || [];
  const cfg = (currentState.gameConfigs || {})[currentState.activeGame];
  const extra = (cfg && Array.isArray(cfg.roles)) ? cfg.roles : [];
  if (!extra.length) return built;
  const seen = new Set(built.map((r) => r.toLowerCase()));
  return built.concat(extra.filter((r) => r && !seen.has(String(r).toLowerCase())));
}

// A role control: a dropdown of the game's preset roles (+ a Custom… → free-text), or a plain
// text field for games with no fixed roles. onPick(value) fires when the role changes.
function buildRoleControl(role, presets, onPick) {
  if (!presets || !presets.length) {
    const inp = document.createElement('input');
    inp.className = 'input-text tp-role'; inp.value = role || ''; inp.placeholder = 'Role';
    inp.addEventListener('change', () => onPick(inp.value.trim()));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    return inp;
  }
  // Games with role icons (bundled, or uploaded via Custom content) get an icon picker instead of a bare <select>.
  if (presets.some((r) => roleIconUrl(currentState.activeGame, r))) return buildRoleIconPicker(role, presets, onPick);
  const wrap = document.createElement('div'); wrap.className = 'tp-role-wrap';
  const sel = document.createElement('select'); sel.className = 'input-select tp-role';
  const isCustom = role && !presets.includes(role);
  sel.innerHTML = '<option value="">Role</option>'
    + presets.map((r) => `<option value="${r}">${r}</option>`).join('')
    + (isCustom ? `<option value="${role.replace(/"/g, '&quot;')}">${role.replace(/</g, '&lt;')}</option>` : '')
    + '<option value="__custom__">Custom…</option>';
  sel.value = role || '';
  const toCustom = (preset) => {
    const inp = document.createElement('input');
    inp.className = 'input-text tp-role'; inp.placeholder = 'Custom role'; inp.value = preset || '';
    inp.addEventListener('change', () => onPick(inp.value.trim()));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    wrap.replaceChild(inp, sel); inp.focus();
  };
  sel.addEventListener('change', () => { if (sel.value === '__custom__') toCustom(''); else onPick(sel.value); });
  wrap.appendChild(sel);
  return wrap;
}

function buildRoleIconPicker(role, presets, onPick) {
  const game = currentState.activeGame;
  const wrap = document.createElement('div'); wrap.className = 'tp-role-wrap';
  const items = presets.map((r) => ({ value: r, label: r, img: roleIconUrl(game, r) }));
  if (role && !presets.includes(role)) items.push({ value: role, label: role, img: roleIconUrl(game, role) });
  items.push({ value: '__custom__', label: 'Custom…' });
  const picker = buildSearchPicker({
    items, value: role || '', placeholder: 'Role', className: 'tp-role tp-role-icons',
    onPick: (v) => {
      if (v !== '__custom__') return onPick(v);
      const inp = document.createElement('input');
      inp.className = 'input-text tp-role'; inp.placeholder = 'Custom role';
      inp.addEventListener('change', () => onPick(inp.value.trim()));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      wrap.replaceChild(inp, picker); inp.focus();
    }
  });
  wrap.appendChild(picker);
  return wrap;
}

// ── Generic searchable picker (type to filter, optional thumbnail per item) ────────
// Used for both the country picker (flag + name) and the hero picker (portrait + name).
// One global handler closes whichever picker is open (no per-row listener leaks).
let _spOpen = null;
function _spInstallGlobal() {
  if (_spInstallGlobal._done) return; _spInstallGlobal._done = true;
  document.addEventListener('mousedown', (e) => { if (_spOpen && !_spOpen.wrap.contains(e.target)) _spOpen.close(); });
  // Close on PAGE scroll only. The dropdown is position:fixed, so it has to close when the page
  // moves under it — but this listener is on window in the CAPTURE phase, which means it also saw
  // scroll events bubbling out of the dropdown's OWN list. Result: trying to scroll a long list
  // (brand kits, teams, any picker) closed it on the first wheel notch. Ignore scrolls that
  // originate inside the open picker.
  window.addEventListener('scroll', (e) => {
    if (!_spOpen) return;
    const t = e.target;
    if (t && t.nodeType === 1 && _spOpen.wrap.contains(t)) return;   // scrolling our own list
    _spOpen.close();
  }, true);
  window.addEventListener('resize', () => { if (_spOpen) _spOpen.close(); });
}
function _spEsc(s) { return esc(s); }   // legacy alias — canonical esc() lives at the top of the file
// opts: { items:[{value,label,img}], value, placeholder, emptyLabel, className, onPick }
function buildSearchPicker(opts) {
  _spInstallGlobal();
  const items = opts.items || [];
  const wrap = document.createElement('div'); wrap.className = 'sp-wrap ' + (opts.className || '');
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'sp-btn';
  const dd = document.createElement('div'); dd.className = 'sp-dd';
  const search = document.createElement('input'); search.className = 'sp-search'; search.placeholder = 'Search…';
  const list = document.createElement('div'); list.className = 'sp-list';
  dd.append(search, list); wrap.append(btn, dd);

  let cur = opts.value || '';
  let filtered = items.slice();
  let active = -1;
  let open = false;
  const find = (v) => items.find((it) => it.value === v);

  const paintBtn = () => {
    const it = find(cur);
    if (it) btn.innerHTML = `${it.img ? `<img class="sp-img" src="${_spEsc(it.img)}" onerror="this.style.visibility='hidden'">` : ''}<span class="sp-label">${_spEsc(it.label)}</span><span class="sp-caret">▾</span>`;
    else btn.innerHTML = `<span class="sp-label sp-ph">${_spEsc(opts.placeholder || 'Select…')}</span><span class="sp-caret">▾</span>`;
  };
  const renderList = () => {
    const rows = [`<div class="sp-item sp-clear" data-v="">${_spEsc(opts.emptyLabel || '— None —')}</div>`];
    filtered.forEach((it, i) => {
      rows.push(`<div class="sp-item${i === active ? ' active' : ''}" data-v="${_spEsc(it.value)}">${it.img ? `<img class="sp-img" loading="lazy" src="${_spEsc(it.img)}" onerror="this.style.visibility='hidden'">` : ''}<span class="sp-label">${_spEsc(it.label)}</span></div>`);
    });
    list.innerHTML = rows.join('') + (filtered.length ? '' : '<div class="sp-none">No matches</div>');
    const act = list.querySelector('.sp-item.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  };
  const position = () => {
    const r = btn.getBoundingClientRect();
    dd.style.left = r.left + 'px';
    dd.style.width = Math.max(r.width, 190) + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 260 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
  };
  const close = () => { dd.classList.remove('show'); open = false; if (_spOpen && _spOpen.wrap === wrap) _spOpen = null; };
  const show = () => {
    if (_spOpen && _spOpen.wrap !== wrap) _spOpen.close();
    filtered = items.slice(); active = -1; search.value = ''; renderList(); position();
    dd.classList.add('show'); open = true; _spOpen = { wrap, close };
    setTimeout(() => search.focus(), 0);
  };
  const choose = (v) => { cur = v; paintBtn(); close(); opts.onPick(v); };

  btn.addEventListener('click', (e) => { e.preventDefault(); if (open) close(); else show(); });
  search.addEventListener('input', () => {
    const q = search.value.trim();
    filtered = NESearch.filter(items, q, (it) => [it.label]);
    active = -1; renderList(); position();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(filtered.length - 1, active + 1); renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderList(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && filtered[active]) choose(filtered[active].value); else if (filtered.length === 1) choose(filtered[0].value); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
  });
  list.addEventListener('mousedown', (e) => { const it = e.target.closest('.sp-item'); if (!it) return; e.preventDefault(); choose(it.dataset.v); });

  paintBtn();
  return wrap;
}

// Country picker — searchable, flag thumbnails. Stores the lowercase ISO alpha-2 code.
function buildCountryControl(code, onPick) {
  const list = (typeof COUNTRIES !== 'undefined' ? COUNTRIES : []).map((c) => ({
    value: c.c, label: c.n, img: typeof flagSrc === 'function' ? flagSrc(c.c) : ''
  }));
  return buildSearchPicker({
    items: list, value: (code || '').toLowerCase(), placeholder: 'Country', emptyLabel: '— No country —',
    className: 'tp-country', onPick
  });
}

// Per-game hero list for the active game (from the generated heroes-data.js).
// Built-in list plus the active Game Config's characters (matched by name: a custom entry with a
// built-in's name replaces its portrait, anything else is appended). Custom rows carry .src.
function heroesForActiveGame() {
  const game = currentState.activeGame;
  const built = (typeof HEROES_BY_GAME !== 'undefined' && HEROES_BY_GAME[game]) || [];
  const custom = customCharactersFor(game);
  if (!custom.length) return built;
  const byName = {};
  custom.forEach((c) => { byName[c.name.toLowerCase()] = c; });
  const out = built.map((h) => { const c = byName[h.n.toLowerCase()]; if (c) delete byName[h.n.toLowerCase()]; return (c && c.image) ? { n: h.n, src: c.image } : h; });
  Object.keys(byName).forEach((k) => out.push({ n: byName[k].name, src: byName[k].image || '' }));
  return out.sort((a, b) => a.n.localeCompare(b.n));
}
function customCharactersFor(game) {
  const cfg = (currentState.gameConfigs || {})[game];
  return ((cfg && Array.isArray(cfg.characters)) ? cfg.characters : []).filter((c) => c && c.name);
}
function heroImgSrc(game, imgSlug) { return imgSlug ? `../assets/heroes/${game}/${imgSlug}.png` : ''; }
// Hero/agent/operator picker — autocompletes from the game's roster, with portraits where we have them.
function buildHeroControl(hero, onPick) {
  const game = currentState.activeGame;
  const list = heroesForActiveGame().map((h) => ({ value: h.n, label: h.n, img: h.src || heroImgSrc(game, h.img) }));
  return buildSearchPicker({
    items: list, value: hero || '', placeholder: 'Hero / agent', emptyLabel: '— No hero —',
    className: 'tp-hero-pick', onPick
  });
}

// Live in-game names on one side (RL: team 0=blue/1=orange; CS2: CT=blue/T=orange — same
// convention as the server's show-state builder).
function _liveIngameNames(side) {
  const rl = Array.isArray(currentState.players) ? currentState.players : [];
  const cs = (currentState.csgo && Array.isArray(currentState.csgo.players)) ? currentState.csgo.players : [];
  const list = rl.length
    ? rl.filter((p) => p && (side === 'blue' ? Number(p.team) === 0 : Number(p.team) === 1))
    : cs.filter((p) => p && (side === 'blue' ? p.team === 'CT' : p.team === 'T'));
  return list.map((p) => (p.name ? String(p.name) : '').trim()).filter(Boolean);
}
// Options for a roster player's Camera picker. The IN-GAME players on that side lead the list —
// picking one keys the player's cam by their in-game name, which is exactly how the HUD overlays
// resolve facecams — followed by the saved facecam library for everything else. assignedCamera
// stores the facecam NAME either way; an in-game pick with no cam linked yet says so and gets its
// feed via In-Game Player Cams (or the website join page's auto-mapping) without re-assigning here.
function playerCameraOptions(side, current) {
  const cams = currentState.facecams || currentState.savedFacecams || [];
  const live = _liveIngameNames(side);
  const camByName = new Map(cams.map((c) => [c.name, c]));
  const opts = ['<option value="">No camera</option>'];
  if (live.length) {
    opts.push('<optgroup label="In-game — this team">' + live.map((n) => {
      const fc = camByName.get(n);
      return `<option value="${tlEsc(n)}"${n === current ? ' selected' : ''}>${tlEsc(n)}${fc ? '' : ' — no cam linked yet'}</option>`;
    }).join('') + '</optgroup>');
  }
  const rest = cams.filter((c) => !live.includes(c.name));
  if (rest.length) {
    opts.push(`<optgroup label="${live.length ? 'Saved cameras' : 'Cameras'}">` + rest.map((c) =>
      `<option value="${tlEsc(c.name)}"${c.name === current ? ' selected' : ''}>${tlEsc(c.nickname || c.name)}</option>`).join('') + '</optgroup>');
  }
  // An assignment pointing at a deleted cam stays visible/selectable instead of silently clearing.
  if (current && !live.includes(current) && !camByName.has(current)) {
    opts.push(`<option value="${tlEsc(current)}" selected>${tlEsc(current)} (cam deleted)</option>`);
  }
  return opts.join('');
}

// Inline roster on the Match team card — view + rename + add/remove. Renaming here flows
// to the overlay players and the facecam rows (server edit_player keeps savedTeams in sync).
// (Named distinctly from the Teams-page `renderTeamPlayers` to avoid the hoisting collision.)
function renderMatchPlayers(side, players) {
  const wrap = el(`team-players-${side}`);
  if (!wrap) return;
  players = Array.isArray(players) ? players : [];
  const cams = currentState.facecams || currentState.savedFacecams || [];
  const camKey = cams.map(c => c.name).join(',') + '|' + _liveIngameNames(side).join(',');
  const gameId = currentState.activeGame;
  const gameCfg = (currentState.games && currentState.games[gameId]) || null;
  const heroFeatures = ['heroes', 'agents', 'operators', 'legends', 'draft'];
  const usesHeroes = !!(gameCfg && (gameCfg.features || []).some(f => heroFeatures.includes(f)));
  const _profiles = currentState.playerProfiles || {};
  const sig = JSON.stringify(players.map(p => {
    const r = _profiles[(p.name || '').trim().toLowerCase()] || {};
    return [p.id, p.name, p.realName || '', p.assignedCamera || '', p.hero || '', p.role || '', p.country || '', p.info || '', p.startgg || '', p.sixmans || '', r.startggSlug || '', (r.sixmans && r.sixmans.name) || '', p.status || '', p.photo ? '1' : '0', r.image ? '1' : '0', p.twitter || '', p.twitch || '', p.discord || '', p.instagram || '', p.tiktok || '', p.youtube || '', r.twitter || '', r.twitch || ''];
  })) + '|' + camKey + '|' + usesHeroes + '|' + currentState.activeGame
      + '|active:' + ((currentState.activePlayer && currentState.activePlayer[side]) || '')
      + '|obs:' + JSON.stringify(currentState.observedPlayer || null);
  if (wrap.dataset.sig === sig) return;
  if (wrap.classList.contains('tp-removing')) return;
  if (wrap.contains(document.activeElement)) return;
  if (wrap.querySelector('.tp-player-card.tp-editing')) return;
  wrap.dataset.sig = sig;
  wrap.innerHTML = '';
  if (!players.length) {
    wrap.innerHTML = '<div class="tp-empty">No players yet — pick a team or add one.</div>';
    return;
  }

  // FGC / 1v1: let the producer pick which roster member is the one shown on the scoreboard.
  // Only meaningful for head-to-head games with more than one player on the side.
  const isFgc = !!(gameCfg && (gameCfg.format === '1v1' || (gameCfg.features || []).includes('fgc')));
  const showOnAir = isFgc && players.length > 1;
  const _activeId = (currentState.activePlayer && currentState.activePlayer[side]) || '';
  // Effective active = explicit selection, else the first player (what the overlay defaults to).
  const effectiveActiveId = _activeId || (players[0] && String(players[0].id)) || '';

  players.forEach((p) => {
    const r = _profiles[(p.name || '').trim().toLowerCase()] || {};
    const avatarSrc = p.photo || r.image || '';

    const card = document.createElement('div'); card.className = 'tp-player-card';
    const avatarFile = document.createElement('input');
    avatarFile.type = 'file'; avatarFile.accept = 'image/*'; avatarFile.style.display = 'none';
    card.appendChild(avatarFile);

    // ── COMPACT BAR ──────────────────────────────────────────────────────
    const bar = document.createElement('div'); bar.className = 'tp-row';

    const barAvatar = document.createElement('img'); barAvatar.className = 'tp-player-avatar'; barAvatar.title = p.name || 'Player';
    if (avatarSrc) barAvatar.src = avatarSrc;
    bar.appendChild(barAvatar);

    const nameInp = document.createElement('input'); nameInp.className = 'input-text tp-name'; nameInp.value = p.name || ''; nameInp.placeholder = 'Player name';
    nameInp.addEventListener('change', () => { if (p.id) send('edit_player', { side, playerId: p.id, playerData: { name: nameInp.value.trim() } }); });
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInp.blur(); });
    bar.appendChild(nameInp);

    const statusBtn = document.createElement('button');
    statusBtn.className = `btn tp-status ${p.status === 'sub' ? 'sub' : 'starter'}`;
    statusBtn.textContent = p.status === 'sub' ? 'Sub' : 'Starter'; statusBtn.title = 'Toggle Starter / Sub';
    statusBtn.addEventListener('click', () => {
      const next = p.status === 'sub' ? 'starter' : 'sub';
      p.status = next;
      statusBtn.textContent = next === 'sub' ? 'Sub' : 'Starter'; statusBtn.className = `btn tp-status ${next}`;
      if (p.id) send('edit_player', { side, playerId: p.id, playerData: { status: next } });
    });
    bar.appendChild(statusBtn);

    // On-Air selector — which roster member is the active competitor on the FGC scoreboard.
    if (showOnAir) {
      const isActive = String(p.id) === String(effectiveActiveId);
      const onAir = document.createElement('button');
      onAir.className = 'tp-onair' + (isActive ? ' active' : '');
      onAir.textContent = isActive ? 'On Air' : 'Set Live';
      onAir.title = isActive ? 'This player is shown on the scoreboard' : 'Show this player on the scoreboard';
      onAir.addEventListener('click', () => {
        if (!p.id || String(p.id) === String(effectiveActiveId)) return;
        send('set_active_player', { side, playerId: p.id });
      });
      bar.appendChild(onAir);
    }

    // Observe — the one player the in-game spectator is following (games with the 'observer'
    // feature, e.g. THE FINALS). One across BOTH sides; clicking the observed player clears it.
    if (gameCfg && (gameCfg.features || []).includes('observer')) {
      const obs = currentState.observedPlayer || {};
      const isObs = obs.side === side && String(obs.playerId) === String(p.id);
      const obsBtn = document.createElement('button');
      obsBtn.className = 'tp-onair' + (isObs ? ' active' : '');
      obsBtn.textContent = isObs ? 'Observed' : 'Observe';
      obsBtn.title = isObs ? 'Shown on the broadcast bar as the spectated player (click to clear)' : 'Show this player on the broadcast bar as the spectated player';
      obsBtn.addEventListener('click', () => {
        if (!p.id) return;
        send('set_observed_player', isObs ? {} : { side, playerId: p.id });
      });
      bar.appendChild(obsBtn);
    }

    // Social icons — player fields + registry fallbacks
    const socWrap = document.createElement('div'); socWrap.className = 'tp-bar-socials';
    const sggVal = p.startgg || r.startggSlug || '';
    const sixVal = p.sixmans || (r.sixmans && r.sixmans.name) || '';
    if (sggVal) {
      const a = document.createElement('a'); a.className = 'tp-bar-soc-icon'; a.href = teStartggLink(sggVal); a.target = '_blank'; a.rel = 'noopener'; a.title = `start.gg: ${sggVal}`;
      a.innerHTML = `<img src="../assets/images/start.png" style="height:13px;filter:brightness(0)invert(1);opacity:.75;display:block">`;
      socWrap.appendChild(a);
    }
    if (sixVal) {
      const a = document.createElement('a'); a.className = 'tp-bar-soc-icon'; a.href = teSixmansLink(sixVal); a.target = '_blank'; a.rel = 'noopener'; a.title = `6mans: ${sixVal}`;
      a.innerHTML = `<img src="../assets/images/sixmanlogo.webp" style="height:13px;filter:brightness(0)invert(1);opacity:.75;display:block">`;
      socWrap.appendChild(a);
    }
    const socVals = { twitter: p.twitter || r.twitter || '', twitch: p.twitch || r.twitch || '', discord: p.discord || '', instagram: p.instagram || '', tiktok: p.tiktok || '', youtube: p.youtube || '' };
    TE_SOCIALS.forEach(soc => {
      const val = socVals[soc.key]; if (!val) return;
      const url = soc.urlFn ? soc.urlFn(val) : null;
      const icon = url ? document.createElement('a') : document.createElement('span');
      icon.className = 'tp-bar-soc-icon'; icon.style.color = soc.color; icon.title = `${soc.label}: ${val}`;
      if (url) { icon.href = url; icon.target = '_blank'; icon.rel = 'noopener'; }
      icon.innerHTML = teSocIconHtml(soc, 13);
      socWrap.appendChild(icon);
    });
    bar.appendChild(socWrap);

    const cbx = document.createElement('input'); cbx.type = 'checkbox'; cbx.className = 'tp-remove-check'; cbx.dataset.playerId = p.id || '';
    cbx.addEventListener('change', () => card.classList.toggle('tp-selected', cbx.checked));
    bar.prepend(cbx);

    const editBtn = document.createElement('button'); editBtn.className = 'btn btn-ghost btn-sm tp-edit-btn-sm'; editBtn.textContent = 'Edit';
    const del = document.createElement('button'); del.className = 'tp-del'; del.textContent = '×'; del.title = 'Remove player';
    del.addEventListener('click', () => {
      if (!p.id) return;
      appConfirm(`Remove ${p.name || 'this player'} from the roster? This can't be undone.`, 'Remove', true).then((ok) => {
        if (!ok) return;
        send('delete_player', { side, playerId: p.id }); card.remove(); wrap.dataset.sig = '';
      });
    });
    bar.append(editBtn, del);
    card.appendChild(bar);

    // ── EDIT POPUP ────────────────────────────────────────────────────────
    const popup = document.createElement('div'); popup.className = 'te-edit-popup';
    const hdr = document.createElement('div'); hdr.className = 'te-popup-header';
    const hdrTitle = document.createElement('span'); hdrTitle.className = 'te-popup-title'; hdrTitle.textContent = 'Edit Player';
    const hdrClose = document.createElement('button'); hdrClose.className = 'te-popup-close'; hdrClose.title = 'Close'; hdrClose.textContent = '×';
    hdr.append(hdrTitle, hdrClose); popup.appendChild(hdr);

    const body = document.createElement('div'); body.className = 'te-popup-body';

    // Left col: big avatar + status toggle
    const leftCol = document.createElement('div'); leftCol.className = 'te-popup-left';
    const popAvatar = document.createElement('img'); popAvatar.className = 'tp-player-avatar'; popAvatar.title = 'Click to change photo';
    if (avatarSrc) popAvatar.src = avatarSrc;
    popAvatar.addEventListener('click', () => avatarFile.click());
    const popStatus = document.createElement('button');
    popStatus.className = `btn tp-status ${p.status === 'sub' ? 'sub' : 'starter'}`;
    popStatus.style.cssText = 'width:100%;margin-top:6px;font-size:10px;';
    popStatus.textContent = p.status === 'sub' ? 'Sub' : 'Starter';
    popStatus.addEventListener('click', () => {
      const next = p.status === 'sub' ? 'starter' : 'sub';
      p.status = next;
      popStatus.textContent = next === 'sub' ? 'Sub' : 'Starter'; popStatus.className = `btn tp-status ${next}`; popStatus.style.cssText = 'width:100%;margin-top:6px;font-size:10px;';
      statusBtn.textContent = next === 'sub' ? 'Sub' : 'Starter'; statusBtn.className = `btn tp-status ${next}`;
      if (p.id) send('edit_player', { side, playerId: p.id, playerData: { status: next } });
    });
    leftCol.append(popAvatar, popStatus); body.appendChild(leftCol);

    // Right col: fields
    const rightCol = document.createElement('div'); rightCol.className = 'te-popup-right';
    const mkField = (label, ctrl) => {
      const row = document.createElement('div'); row.className = 'te-popup-field';
      const lbl = document.createElement('span'); lbl.className = 'te-popup-label'; lbl.textContent = label;
      row.append(lbl, ctrl); return row;
    };

    const cam = document.createElement('select'); cam.className = 'input-select';
    cam.innerHTML = playerCameraOptions(side, p.assignedCamera || '');
    cam.value = p.assignedCamera || '';
    cam.addEventListener('change', () => { if (p.id) send('edit_player', { side, playerId: p.id, playerData: { assignedCamera: cam.value || null } }); });
    rightCol.appendChild(mkField('Camera', cam));

    if (_vdoLinks) {
      const vt = _vdoLinks.teams && _vdoLinks.teams[side];
      const vp = vt && (vt.players || []).find(vpl => vpl.name === p.name);
      if (vp && vp.obsUrl) {
        const feedBtn = document.createElement('button'); feedBtn.className = 'btn btn-ghost btn-sm'; feedBtn.textContent = 'Copy Feed URL'; feedBtn.style.marginLeft = '60px';
        feedBtn.addEventListener('click', () => tlCopy(vp.obsUrl, feedBtn));
        rightCol.appendChild(feedBtn);
      }
    }

    if (usesHeroes) {
      const hero = buildHeroControl(p.hero || '', (val) => { if (p.id) send('edit_player', { side, playerId: p.id, playerData: { hero: val } }); });
      rightCol.appendChild(mkField('Hero', hero));
    }

    const roleCtrl = buildRoleControl(p.role || '', rolesForActiveGame(), (val) => { if (p.id) send('edit_player', { side, playerId: p.id, playerData: { role: val } }); });
    const countryCtrl = buildCountryControl(p.country || '', (code) => { if (p.id) send('edit_player', { side, playerId: p.id, playerData: { country: code } }); });
    const infoInp = document.createElement('input'); infoInp.className = 'input-text'; infoInp.value = p.info || ''; infoInp.placeholder = 'IGN / info';
    infoInp.addEventListener('change', () => { if (p.id) send('edit_player', { side, playerId: p.id, playerData: { info: infoInp.value.trim() } }); });
    infoInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') infoInp.blur(); });
    rightCol.append(mkField('Role', roleCtrl), mkField('Country', countryCtrl), mkField('IGN', infoInp));

    // Socials
    const sHead = document.createElement('div'); sHead.className = 'te-popup-section-head'; sHead.textContent = 'Socials';
    rightCol.appendChild(sHead);
    const socGrid = document.createElement('div'); socGrid.className = 'te-popup-links-grid';

    // start.gg row
    const sggRow2 = document.createElement('div'); sggRow2.className = 'te-popup-link-row';
    const sggIco = document.createElement('span'); sggIco.className = 'te-popup-link-icon'; sggIco.innerHTML = `<img src="../assets/images/start.png" style="height:14px;filter:brightness(0)invert(1);opacity:.7">`;
    const sggInp = document.createElement('input'); sggInp.className = 'input-text'; sggInp.placeholder = 'start.gg slug or link'; sggInp.value = p.startgg || r.startggSlug || '';
    sggInp.addEventListener('change', () => { if (p.id) send('edit_player', { side, playerId: p.id, playerData: { startgg: sggInp.value.trim() } }); });
    const sggA = document.createElement('a'); sggA.className = `te-plink-open${sggInp.value ? '' : ' is-off'}`; sggA.target = '_blank'; sggA.textContent = '↗'; sggA.href = teStartggLink(sggInp.value);
    sggInp.addEventListener('input', () => { sggA.href = teStartggLink(sggInp.value); sggA.classList.toggle('is-off', !sggInp.value); });
    sggRow2.append(sggIco, sggInp, sggA); socGrid.appendChild(sggRow2);

    TE_SOCIALS.forEach(soc => {
      const socRow = document.createElement('div'); socRow.className = 'te-popup-link-row';
      const ico = document.createElement('span'); ico.className = 'te-popup-link-icon';
      ico.innerHTML = teSocIconHtml(soc, 14).replace('<svg', `<svg style="color:${soc.color}"`);
      const inp2 = document.createElement('input'); inp2.className = 'input-text'; inp2.placeholder = soc.ph;
      inp2.value = p[soc.key] || (soc.key === 'twitter' ? r.twitter : soc.key === 'twitch' ? r.twitch : '') || '';
      inp2.addEventListener('change', () => { if (p.id) send('edit_player', { side, playerId: p.id, playerData: { [soc.key]: inp2.value.trim() } }); });
      socRow.append(ico, inp2); socGrid.appendChild(socRow);
    });

    rightCol.appendChild(socGrid); body.appendChild(rightCol); popup.appendChild(body); card.appendChild(popup);

    avatarFile.addEventListener('change', async () => {
      const f = avatarFile.files[0]; if (!f) return;
      const b64 = await fileToBase64(f);
      barAvatar.src = b64; popAvatar.src = b64; avatarFile.value = '';
      if (p.id) send('edit_player', { side, playerId: p.id, playerData: { photo: b64 } });
    });

    const openPopup = () => {
      // Close any other open match-panel popups
      wrap.querySelectorAll('.tp-player-card.tp-editing').forEach(c => {
        if (c !== card) {
          c.classList.remove('tp-editing');
          const eb = c.querySelector('.tp-edit-btn-sm'); if (eb) eb.textContent = 'Edit';
          const op = c.querySelector('.te-edit-popup'); if (op) op.removeAttribute('style');
        }
      });
      // Position as fixed overlay so it escapes any overflow:auto scroll container.
      const rect = card.getBoundingClientRect();
      const popW = Math.max(rect.width, 440);
      const leftPx = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
      // Show it (hidden) first so we can measure its real height, then place it BELOW the card by
      // default but flip ABOVE when it would run off the bottom of the screen — and clamp on-screen
      // if it fits neither. The old code always opened downward, so cards near the bottom lost it.
      popup.style.cssText = `display:block;position:fixed;left:${leftPx}px;width:${popW}px;z-index:9999;visibility:hidden;top:0;`;
      card.classList.add('tp-editing'); editBtn.textContent = 'Done';
      const margin = 8, vh = window.innerHeight, popH = popup.offsetHeight || 360;
      const below = rect.bottom + 4, above = rect.top - popH - 4;
      const topPx = (below + popH + margin <= vh) ? below
        : (above >= margin) ? above
        : Math.max(margin, vh - popH - margin);
      popup.style.top = topPx + 'px';
      popup.style.visibility = '';
    };
    const closePopup = () => {
      card.classList.remove('tp-editing');
      popup.removeAttribute('style');
      editBtn.textContent = 'Edit';
    };
    editBtn.addEventListener('click', () => card.classList.contains('tp-editing') ? closePopup() : openPopup());
    hdrClose.addEventListener('click', closePopup);

    const popFooter = document.createElement('div'); popFooter.className = 'te-popup-footer';
    const savePopBtn = document.createElement('button'); savePopBtn.className = 'btn te-popup-save'; savePopBtn.textContent = 'Save';
    savePopBtn.addEventListener('click', closePopup);
    popFooter.appendChild(savePopBtn); popup.appendChild(popFooter);

    wrap.appendChild(card);
  });

  if (!wrap._tpOutsideHandler) {
    const closeAll = () => {
      wrap.querySelectorAll('.tp-player-card.tp-editing').forEach(c => {
        c.classList.remove('tp-editing');
        const eb = c.querySelector('.tp-edit-btn-sm'); if (eb) eb.textContent = 'Edit';
        const op = c.querySelector('.te-edit-popup'); if (op) op.removeAttribute('style');
      });
    };
    wrap._tpOutsideHandler = (e) => {
      wrap.querySelectorAll('.tp-player-card.tp-editing').forEach(c => {
        if (!c.contains(e.target)) closeAll();
      });
    };
    document.addEventListener('click', wrap._tpOutsideHandler);
    // Close popup when the panel scrolls (fixed popup would drift from the card)
    wrap.closest('.tab-content, [data-scroll]')?.addEventListener('scroll', closeAll, { passive: true });
  }
}
['blue', 'orange'].forEach((side) => {
  el(`btn-add-player-${side}`)?.addEventListener('click', () => {
    send('add_player', { side, player: { name: '' } });
  });

  const rmBtn  = el(`btn-rm-player-${side}`);
  const addBtn = el(`btn-add-player-${side}`);
  if (!rmBtn) return;

  let _rmConfirmBtn      = null;
  let _rmChangeHandler   = null;

  const exitRemove = () => {
    const wrap = el(`team-players-${side}`);
    if (wrap) {
      wrap.classList.remove('tp-removing');
      if (_rmChangeHandler) { wrap.removeEventListener('change', _rmChangeHandler); _rmChangeHandler = null; }
      wrap.querySelectorAll('.tp-remove-check').forEach(c => { c.checked = false; });
      wrap.querySelectorAll('.tp-player-card.tp-selected').forEach(c => c.classList.remove('tp-selected'));
    }
    rmBtn.textContent = '- Remove';
    rmBtn.classList.remove('is-active');
    if (addBtn) addBtn.style.display = '';
    _rmConfirmBtn?.remove(); _rmConfirmBtn = null;
  };

  const enterRemove = () => {
    const wrap = el(`team-players-${side}`);
    if (!wrap) return;
    wrap.classList.add('tp-removing');
    rmBtn.textContent = 'Cancel';
    rmBtn.classList.add('is-active');
    if (addBtn) addBtn.style.display = 'none';

    _rmConfirmBtn = document.createElement('button');
    _rmConfirmBtn.className = 'tp-rm-confirm';
    _rmConfirmBtn.textContent = 'Delete (0)';
    _rmConfirmBtn.style.display = 'none';
    rmBtn.insertAdjacentElement('beforebegin', _rmConfirmBtn);

    _rmChangeHandler = () => {
      const n = wrap.querySelectorAll('.tp-remove-check:checked').length;
      _rmConfirmBtn.textContent = `Delete (${n})`;
      _rmConfirmBtn.style.display = n > 0 ? '' : 'none';
    };
    wrap.addEventListener('change', _rmChangeHandler);

    _rmConfirmBtn.addEventListener('click', () => {
      const checked = [...wrap.querySelectorAll('.tp-remove-check:checked')];
      const ids = checked.map(cb => cb.dataset.playerId).filter(Boolean);
      ids.forEach(pId => send('delete_player', { side, playerId: pId }));
      checked.forEach(cb => cb.closest('.tp-player-card')?.remove());
      wrap.dataset.sig = '';
      exitRemove();
    });
  };

  rmBtn.addEventListener('click', () => {
    const wrap = el(`team-players-${side}`);
    if (!wrap) return;
    if (wrap.classList.contains('tp-removing')) exitRemove();
    else enterRemove();
  });
});

// ── Series / match editor (format · division · per-map results) ────────────
let _seriesMaps = [];   // local working copy of the per-map results
const FORMAT_MAPS = { bo1: 1, bo3: 3, bo5: 5, bo7: 7 };

function collectSeriesMaps() {
  const wrap = el('series-maps'); if (!wrap) return _seriesMaps;
  return [...wrap.querySelectorAll('.sr-map')].map((row) => ({
    name: row.querySelector('.sr-map-name')?.value || '',
    scoreA: Number(row.querySelector('.sr-map-a')?.value) || 0,
    scoreB: Number(row.querySelector('.sr-map-b')?.value) || 0,
    played: !!row.querySelector('.sr-map-played')?.checked
  }));
}
function pushSeriesMaps() { send('set_match', { maps: collectSeriesMaps() }); }

function renderSeriesPanel(match, teams) {
  match = match || { format: '', division: '', maps: [] };
  teams = teams || {};
  const fmtEl = el('sel-series-format');
  const numEl = el('num-series-maps');
  const divEl = el('input-series-division');
  const wrap = el('series-maps');
  if (!wrap) return;

  // Don't clobber fields the producer is actively editing.
  const editing = document.activeElement;
  const focusedInPanel = editing && (editing === fmtEl || editing === numEl || editing === divEl || wrap.contains(editing));

  if (fmtEl && editing !== fmtEl) fmtEl.value = match.format || '';
  const mapCount = (match.maps && match.maps.length) || FORMAT_MAPS[match.format] || 5;
  if (numEl && editing !== numEl) numEl.value = mapCount;
  if (divEl && editing !== divEl) divEl.value = match.division || '';
  const visEl = el('check-series-visible');
  if (visEl) visEl.checked = match.seriesVisible !== false;

  _seriesMaps = match.maps || [];
  const aLabel = (teams.blue && teams.blue.name) || 'Team A';
  const bLabel = (teams.orange && teams.orange.name) || 'Team B';
  const aColor = (teams.blue && teams.blue.color) || '#055fdb';
  const bColor = (teams.orange && teams.orange.color) || '#e97139';

  const sig = JSON.stringify({ m: _seriesMaps, a: aLabel, b: bLabel, aColor, bColor });
  if (!focusedInPanel && wrap.dataset.sig !== sig) {
    wrap.dataset.sig = sig;
    const count = Math.max(1, Math.min(9, Number(numEl?.value) || mapCount));
    let rows = '';
    for (let i = 0; i < count; i++) {
      const m = _seriesMaps[i] || { name: '', scoreA: 0, scoreB: 0, played: false };
      rows += `<div class="sr-map${m.played ? ' is-played' : ''}">
        <span class="sr-map-num">M${i + 1}</span>
        <input type="text" class="input-text sr-map-name" placeholder="Map / TBA" value="${(m.name || '').replace(/"/g, '&quot;')}">
        <span class="sr-map-team" style="color:${aColor}" title="${aLabel.replace(/"/g, '&quot;')}">${aLabel.slice(0, 3).toUpperCase()}</span>
        <input type="number" class="input-text sr-map-a" min="0" value="${m.scoreA || 0}">
        <span class="sr-map-dash">–</span>
        <input type="number" class="input-text sr-map-b" min="0" value="${m.scoreB || 0}">
        <span class="sr-map-team" style="color:${bColor}" title="${bLabel.replace(/"/g, '&quot;')}">${bLabel.slice(0, 3).toUpperCase()}</span>
        <label class="qt-toggle sr-map-toggle" title="Mark this map as played"><span>Played</span><span class="switch"><input type="checkbox" class="sr-map-played" ${m.played ? 'checked' : ''}><span class="slider"></span></span></label>
      </div>`;
    }
    wrap.innerHTML = rows;
    wrap.querySelectorAll('.sr-map-name, .sr-map-a, .sr-map-b').forEach((inp) => {
      inp.addEventListener('change', pushSeriesMaps);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    });
    wrap.querySelectorAll('.sr-map-played').forEach((cb) => cb.addEventListener('change', pushSeriesMaps));
  }

  // Summary: maps played + map wins per team.
  const summary = el('series-summary');
  if (summary) {
    const played = (_seriesMaps || []).filter((m) => m.played);
    let aw = 0, bw = 0;
    played.forEach((m) => { if (m.scoreA > m.scoreB) aw++; else if (m.scoreB > m.scoreA) bw++; });
    summary.textContent = played.length ? `${aLabel} ${aw} — ${bw} ${bLabel} · ${played.length}/${count2(match)} maps` : '';
  }
}
function count2(match) { return (match.maps && match.maps.length) || FORMAT_MAPS[match.format] || 5; }

// Format / maps-count / division controls.
el('sel-series-format')?.addEventListener('change', function () {
  const bo = FORMAT_MAPS[this.value];
  // Resize the working map list to the format's map count, preserving existing results.
  const maps = collectSeriesMaps();
  if (bo) { while (maps.length < bo) maps.push({ name: '', scoreA: 0, scoreB: 0, played: false }); maps.length = bo; }
  send('set_match', { format: this.value, maps });
});
el('num-series-maps')?.addEventListener('change', function () {
  const n = Math.max(1, Math.min(9, Number(this.value) || 5));
  this.value = n;
  const maps = collectSeriesMaps();
  while (maps.length < n) maps.push({ name: '', scoreA: 0, scoreB: 0, played: false });
  maps.length = n;
  send('set_match', { maps });
});
el('input-series-division')?.addEventListener('change', function () { send('set_match', { division: this.value.trim() }); });
el('input-series-division')?.addEventListener('keydown', function (e) { if (e.key === 'Enter') this.blur(); });
el('check-series-visible')?.addEventListener('change', function () { send('set_match', { seriesVisible: this.checked }); });
